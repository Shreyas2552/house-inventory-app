import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  addManualItem,
  cancelRestock,
  getAppSettings,
  exportBackup,
  getInventory,
  getRestockItems,
  getStores,
  hideStore,
  importBackup,
  initDatabase,
  markFinished,
  restoreToPresent,
  saveReceiptImport,
  setAppSetting,
  upsertDiscoveredStores,
} from './src/db';
import { parseWithAI, parseSpeechWithAI } from './src/aiParser';
import { extractTextFromImageUri } from './src/ocr';
import { inferCategory, parseReceiptText } from './src/parser';
import { parseSpeechToItems } from './src/speechParser';
import { fetchReceiptFromUrl } from './src/urlScraper';
import { searchAllStores, storeSearchUrl } from './src/priceSearch';
import {
  AppSettings,
  Category,
  InventoryItem,
  OptimizationMode,
  ReceiptLineCandidate,
  RestockItem,
  StoreCandidate,
  StorePriceResult,
} from './src/types';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

type Screen = 'inventory' | 'receipt' | 'checkin' | 'restock' | 'prices' | 'stores' | 'settings';

const categories: Category[] = ['Grocery', 'Baby', 'Medicine', 'Cleaning', 'Personal Care', 'Household'];

export default function App() {
  const [screen, setScreen] = useState<Screen>('inventory');
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [restock, setRestock] = useState<RestockItem[]>([]);
  const [stores, setStores] = useState<StoreCandidate[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    searchRadiusMiles: 8,
    maxRadiusMiles: 30,
    optimizationMode: 'balanced',
    homeLocationText: '',
    ocrSpaceKey: 'helloworld',
    geminiKey: '',
    groqKey: '',
    firecrawlKey: '',
    krogerClientId: 'inventorymang-bbcfnbdp',
    krogerClientSecret: 'V3pZenFiwzX9zKIqt3EUf98aCHWzVuYwRjZbY4w3',
    instacartApiKey: '',
    activeOcrService: 'ocrspace',
    activeAiParser: 'none',
    activeUrlScraper: 'jina',
  });
  const [manualName, setManualName] = useState('');
  const [manualQuantity, setManualQuantity] = useState('1');
  const [manualCategory, setManualCategory] = useState<Category>('Grocery');
  const [receiptText, setReceiptText] = useState('');
  const [receiptUrl, setReceiptUrl] = useState('');
  const [receiptUrlLoading, setReceiptUrlLoading] = useState(false);
  const [storeName, setStoreName] = useState('');
  const [receiptDate, setReceiptDate] = useState(new Date().toISOString().slice(0, 10));
  const [candidates, setCandidates] = useState<ReceiptLineCandidate[]>([]);
  const [priceResults, setPriceResults] = useState<StorePriceResult[]>([]);
  const [priceSearching, setPriceSearching] = useState(false);
  const [priceProgress, setPriceProgress] = useState({ done: 0, total: 0 });
  const [priceSortMode, setPriceSortMode] = useState<'price' | 'distance'>('price');
  const [selectedCategory, setSelectedCategory] = useState<Category | 'All'>('All');
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [voiceCandidates, setVoiceCandidates] = useState<ReceiptLineCandidate[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [voiceTranscriptLog, setVoiceTranscriptLog] = useState<string[]>([]);
  const [isAiCorrecting, setIsAiCorrecting] = useState(false);
  const recognizerRef = useRef<SpeechRecognition | null>(null);
  const segmentsRef = useRef<string[]>([]);

  useEffect(() => {
    (async () => {
      await initDatabase();
      await refresh();
    })();
  }, []);

  const filteredInventory = useMemo(() => {
    return inventory.filter((item) => {
      const matchesCategory = selectedCategory === 'All' || item.category === selectedCategory;
      const matchesSearch = item.canonicalName.toLowerCase().includes(search.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [inventory, search, selectedCategory]);

  async function refresh() {
    setInventory(await getInventory());
    setRestock(await getRestockItems());
    setStores(await getStores());
    setSettings(await getAppSettings());
  }

  async function addItem() {
    const quantity = Number(manualQuantity);
    if (!manualName.trim() || Number.isNaN(quantity) || quantity <= 0) {
      Alert.alert('Missing details', 'Enter an item name and valid quantity.');
      return;
    }

    await addManualItem(manualName.trim(), manualCategory, quantity);
    setManualName('');
    setManualQuantity('1');
    setManualCategory('Grocery');
    setShowAddModal(false);
    void refresh();
  }

  function startVoiceInput() {
    // Second click — stop listening
    if (isListening && recognizerRef.current) {
      recognizerRef.current.stop();
      return;
    }

    const SR: typeof SpeechRecognition | undefined =
      (typeof window !== 'undefined' &&
        ((window as unknown as Record<string, unknown>).SpeechRecognition ||
          (window as unknown as Record<string, unknown>).webkitSpeechRecognition)) as typeof SpeechRecognition | undefined;

    if (!SR) {
      Alert.alert('Not supported', 'Voice input requires a browser with Web Speech API (Chrome or Edge on desktop).');
      return;
    }

    const recognizer = new SR();
    recognizer.continuous = true;
    recognizer.interimResults = false;
    recognizer.lang = 'en-US';
    recognizerRef.current = recognizer;

    let lastResultIndex = 0;

    setIsListening(true);
    setIsAiCorrecting(false);
    setVoiceTranscriptLog([]);
    segmentsRef.current = [];

    recognizer.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = lastResultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const chunk = event.results[i][0].transcript.trim();
          if (!chunk) continue;
          setVoiceTranscriptLog((prev) => [...prev, chunk]);
          segmentsRef.current = [...segmentsRef.current, chunk];
          const newItems = parseSpeechToItems(chunk);
          if (newItems.length > 0) {
            setVoiceCandidates((prev) => [...prev, ...newItems]);
          }
          lastResultIndex = i + 1;
        }
      }
    };

    recognizer.onerror = () => {
      Alert.alert('Mic error', 'Could not access the microphone. Check browser permissions.');
      setIsListening(false);
      recognizerRef.current = null;
    };

    recognizer.onend = () => {
      setIsListening(false);
      recognizerRef.current = null;
      const captured = [...segmentsRef.current];
      if (captured.length > 0 && settings.activeAiParser !== 'none') {
        setIsAiCorrecting(true);
        parseSpeechWithAI(captured, settings)
          .then((aiResults) => {
            if (aiResults && aiResults.length > 0) {
              setVoiceCandidates(aiResults);
            }
          })
          .catch(() => {})
          .finally(() => setIsAiCorrecting(false));
      }
    };

    recognizer.start();
  }

  function saveVoiceRecording() {
    if (voiceTranscriptLog.length === 0 && voiceCandidates.length === 0) return;
    const data = {
      timestamp: new Date().toISOString(),
      segments: voiceTranscriptLog,
      parsedItems: voiceCandidates.map((c) => ({
        rawLine: c.rawLine,
        suggestedName: c.suggestedName,
        quantity: c.quantity,
        category: c.category,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voice_test_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveVoice() {
    if (voiceCandidates.length === 0) return;
    await saveReceiptImport('', 'Voice input', new Date().toISOString().slice(0, 10), voiceCandidates, 'pasted_text');
    setVoiceCandidates([]);
    void refresh();
  }

  async function parseReceipt() {
    if (!receiptText.trim()) {
      Alert.alert('Receipt text needed', 'Paste receipt text, fetch a receipt link, or OCR a receipt image first.');
      return;
    }
    const aiResult = await parseWithAI(receiptText, settings);
    setCandidates(aiResult ?? parseReceiptText(receiptText));
  }

  async function searchPrices() {
    const active = restock.filter((r) => !r.cancelledForNextTrip);
    if (active.length === 0) {
      Alert.alert('No items to search', 'Mark items as finished from Inventory or Check-in to add them to the restock list first.');
      return;
    }
    setPriceSearching(true);
    setPriceResults([]);
    setPriceProgress({ done: 0, total: active.length });
    try {
      const results = await searchAllStores(restock, settings, (done, total) =>
        setPriceProgress({ done, total }),
      );
      setPriceResults(results);
      if (results.length === 0) {
        Alert.alert('No prices found', 'Could not retrieve prices. Check your network connection or try again.');
      }
    } catch (err) {
      Alert.alert('Search failed', err instanceof Error ? err.message : 'Price search could not complete.');
    } finally {
      setPriceSearching(false);
    }
  }

  async function fetchReceiptLink() {
    if (!receiptUrl.trim()) {
      Alert.alert('URL needed', 'Paste the full receipt link (e.g. a Walmart, Amazon, or store online receipt URL).');
      return;
    }
    setReceiptUrlLoading(true);
    try {
      const result = await fetchReceiptFromUrl(receiptUrl, settings);
      setReceiptText(result.text);
      if (result.storeName) setStoreName(result.storeName);
      if (result.purchaseDate) setReceiptDate(result.purchaseDate);

      let parsed: ReceiptLineCandidate[];
      if (result.candidates && result.candidates.length > 0) {
        parsed = result.candidates;
      } else {
        const aiResult = await parseWithAI(result.text, settings);
        parsed = aiResult ?? parseReceiptText(result.text);
      }
      setCandidates(parsed);
      Alert.alert('Receipt fetched', `${parsed.length} item(s) detected — review before saving.`);
    } catch (error) {
      Alert.alert('Fetch failed', error instanceof Error ? error.message : 'Could not retrieve receipt from this URL.');
    } finally {
      setReceiptUrlLoading(false);
    }
  }

  async function saveReceipt() {
    if (candidates.length === 0) {
      Alert.alert('Review first', 'Parse the receipt and review items before saving.');
      return;
    }

    const sourceType = receiptUrl.trim() ? 'receipt_link' : 'pasted_text';
    await saveReceiptImport(receiptText, storeName, receiptDate, candidates, sourceType);
    setReceiptText('');
    setReceiptUrl('');
    setStoreName('');
    setReceiptDate(new Date().toISOString().slice(0, 10));
    setCandidates([]);
    void refresh();
    setScreen('inventory');
  }

  async function pickReceiptImage() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
    });

    if (!result.canceled) {
      try {
        const text = await extractTextFromImageUri(result.assets[0].uri, settings);
        setReceiptText(text);
        const aiResult = await parseWithAI(text, settings);
        setCandidates(aiResult ?? parseReceiptText(text));
        Alert.alert('OCR complete', 'Receipt text was extracted. Review the detected items before saving.');
      } catch (error) {
        Alert.alert('OCR unavailable', error instanceof Error ? error.message : 'Paste receipt text manually.');
      }
    }
  }

  async function pickReceiptDocument() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['text/plain', 'application/json', 'application/pdf'],
      copyToCacheDirectory: true,
    });

    if (result.canceled || !result.assets?.[0]?.uri) {
      return;
    }

    const asset = result.assets[0];
    if (asset.mimeType === 'application/pdf' || asset.name.toLowerCase().endsWith('.pdf')) {
      Alert.alert('PDF selected', 'PDF files are recognized. For this prototype, copy receipt text or upload a receipt screenshot for OCR.');
      return;
    }

    try {
      const text = await FileSystem.readAsStringAsync(asset.uri);
      setReceiptText(text);
      setCandidates(parseReceiptText(text));
      Alert.alert('Document imported', 'Receipt text was imported. Review the detected items before saving.');
    } catch (error) {
      Alert.alert('Import failed', 'The selected document could not be read as text.');
    }
  }

  async function scheduleDailyReminder() {
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Notifications disabled', 'Enable notifications to use the daily 8 PM check-in.');
      return;
    }

    await Notifications.cancelAllScheduledNotificationsAsync();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'House inventory check-in',
        body: 'Anything finished today?',
        data: { screen: 'checkin' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: 20,
        minute: 0,
      } as Notifications.NotificationTriggerInput,
    });

    Alert.alert('Reminder set', 'Daily inventory check-in is scheduled for 8 PM.');
  }

  async function shareBackup() {
    const payload = await exportBackup();
    const fileUri = `${FileSystem.cacheDirectory}house-inventory-backup-${Date.now()}.json`;
    await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(payload, null, 2));

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(fileUri, {
        dialogTitle: 'Save house inventory backup',
        mimeType: 'application/json',
      });
    } else {
      Alert.alert('Backup created', fileUri);
    }
  }

  async function restoreBackup() {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'application/json',
      copyToCacheDirectory: true,
    });

    if (result.canceled || !result.assets?.[0]?.uri) {
      return;
    }

    try {
      const text = await FileSystem.readAsStringAsync(result.assets[0].uri);
      const payload = JSON.parse(text);
      await importBackup(payload);
      void refresh();
      Alert.alert('Restore complete', 'Inventory backup was restored.');
    } catch (error) {
      Alert.alert('Restore failed', 'The selected backup could not be read. Current data was not overwritten.');
    }
  }

  async function discoverNearbyStores() {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Location disabled', 'Allow location permission or add store discovery later using a zip/address lookup.');
      return;
    }

    try {
      const { latitude, longitude } = await getDiscoveryCoordinates(settings.homeLocationText);
      const radiusMeters = Math.max(1, settings.searchRadiusMiles) * 1609.34;
      const query = `
        [out:json][timeout:25];
        (
          node["shop"~"supermarket|grocery|convenience"](around:${radiusMeters},${latitude},${longitude});
          way["shop"~"supermarket|grocery|convenience"](around:${radiusMeters},${latitude},${longitude});
          relation["shop"~"supermarket|grocery|convenience"](around:${radiusMeters},${latitude},${longitude});
        );
        out center tags 30;
      `;

      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });

      if (!response.ok) {
        throw new Error(`Overpass failed with ${response.status}`);
      }

      const data = await response.json();
      const discovered = (data.elements ?? [])
        .map((element: any) => {
          const tags = element.tags ?? {};
          const name = tags.name;
          if (!name) return null;

          const lat = element.lat ?? element.center?.lat;
          const lon = element.lon ?? element.center?.lon;
          const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']]
            .filter(Boolean)
            .join(' ') || 'Discovered by current location';

          return {
            name,
            address,
            distanceMiles: lat && lon ? distanceInMiles(latitude, longitude, lat, lon) : undefined,
          };
        })
        .filter(Boolean)
        .slice(0, 30);

      if (discovered.length === 0) {
        Alert.alert('No stores found', 'No nearby grocery stores were found in the current radius.');
        return;
      }

      await upsertDiscoveredStores(discovered);
      void refresh();
      Alert.alert('Stores discovered', `${discovered.length} nearby grocery stores were added or refreshed.`);
    } catch (error) {
      Alert.alert('Discovery failed', 'Store lookup could not complete. Try again later or check network access.');
    }
  }

  async function saveSettings(nextSettings: AppSettings) {
    await setAppSetting('searchRadiusMiles', nextSettings.searchRadiusMiles);
    await setAppSetting('maxRadiusMiles', nextSettings.maxRadiusMiles);
    await setAppSetting('optimizationMode', nextSettings.optimizationMode);
    await setAppSetting('homeLocationText', nextSettings.homeLocationText);
    await setAppSetting('ocrSpaceKey', nextSettings.ocrSpaceKey);
    await setAppSetting('geminiKey', nextSettings.geminiKey);
    await setAppSetting('groqKey', nextSettings.groqKey);
    await setAppSetting('firecrawlKey', nextSettings.firecrawlKey);
    await setAppSetting('krogerClientId', nextSettings.krogerClientId);
    await setAppSetting('krogerClientSecret', nextSettings.krogerClientSecret);
    await setAppSetting('instacartApiKey', nextSettings.instacartApiKey);
    await setAppSetting('activeOcrService', nextSettings.activeOcrService);
    await setAppSetting('activeAiParser', nextSettings.activeAiParser);
    await setAppSetting('activeUrlScraper', nextSettings.activeUrlScraper);
    void refresh();
    Alert.alert('Settings saved', 'All settings and API keys were saved locally.');
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.appTitle}>House Inventory</Text>
        <Text style={styles.appSubtitle}>Local groceries and daily essentials tracker</Text>
      </View>

      <View style={styles.tabs}>
        {[
          ['inventory', 'Inventory'],
          ['receipt', 'Receipt'],
          ['checkin', 'Check-in'],
          ['restock', 'Restock'],
          ['prices', 'Prices'],
          ['stores', 'Stores'],
          ['settings', 'Settings'],
        ].map(([key, label]) => (
          <Pressable key={key} style={[styles.tab, screen === key && styles.tabActive]} onPress={() => setScreen(key as Screen)}>
            <Text style={[styles.tabText, screen === key && styles.tabTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {screen === 'inventory' && (
          <InventoryScreen
            inventory={filteredInventory}
            allCount={inventory.length}
            search={search}
            selectedCategory={selectedCategory}
            setSearch={setSearch}
            setSelectedCategory={setSelectedCategory}
            onAdd={() => setShowAddModal(true)}
            onFinished={async (productId) => {
              await markFinished(productId);
              void refresh();
            }}
            voiceCandidates={voiceCandidates}
            isListening={isListening}
            voiceTranscriptLog={voiceTranscriptLog}
            onStartVoice={startVoiceInput}
            onSaveVoice={saveVoice}
            onSaveRecording={saveVoiceRecording}
            setVoiceCandidates={setVoiceCandidates}
            isAiCorrecting={isAiCorrecting}
          />
        )}

        {screen === 'receipt' && (
          <ReceiptScreen
            receiptText={receiptText}
            receiptUrl={receiptUrl}
            receiptUrlLoading={receiptUrlLoading}
            storeName={storeName}
            receiptDate={receiptDate}
            candidates={candidates}
            settings={settings}
            setReceiptText={setReceiptText}
            setReceiptUrl={setReceiptUrl}
            setStoreName={setStoreName}
            setReceiptDate={setReceiptDate}
            setCandidates={setCandidates}
            onPickImage={pickReceiptImage}
            onPickDocument={pickReceiptDocument}
            onFetchLink={fetchReceiptLink}
            onParse={parseReceipt}
            onSave={saveReceipt}
          />
        )}

        {screen === 'checkin' && (
          <CheckInScreen
            inventory={inventory}
            onFinished={async (productId) => {
              await markFinished(productId);
              void refresh();
            }}
            onStillHave={async (productId) => {
              await restoreToPresent(productId);
              void refresh();
            }}
          />
        )}

        {screen === 'restock' && (
          <RestockScreen
            restock={restock}
            onCancel={async (productId) => {
              await cancelRestock(productId);
              void refresh();
            }}
            onRestored={async (productId) => {
              await restoreToPresent(productId);
              void refresh();
            }}
          />
        )}

        {screen === 'prices' && (
          <PricesScreen
            restock={restock}
            results={priceResults}
            searching={priceSearching}
            progress={priceProgress}
            sortMode={priceSortMode}
            settings={settings}
            onSearch={searchPrices}
            onSortChange={setPriceSortMode}
          />
        )}

        {screen === 'stores' && (
          <StoresScreen
            stores={stores}
            onDiscover={discoverNearbyStores}
            onHide={async (storeId) => {
              await hideStore(storeId);
              void refresh();
            }}
          />
        )}

        {screen === 'settings' && (
          <SettingsScreen
            settings={settings}
            onSaveSettings={saveSettings}
            onSchedule={scheduleDailyReminder}
            onExport={shareBackup}
            onRestore={restoreBackup}
          />
        )}
      </ScrollView>

      <AddItemModal
        visible={showAddModal}
        name={manualName}
        quantity={manualQuantity}
        category={manualCategory}
        setName={setManualName}
        setQuantity={setManualQuantity}
        setCategory={setManualCategory}
        onClose={() => setShowAddModal(false)}
        onSave={addItem}
      />
    </SafeAreaView>
  );
}

function InventoryScreen({
  inventory,
  allCount,
  search,
  selectedCategory,
  setSearch,
  setSelectedCategory,
  onAdd,
  onFinished,
  voiceCandidates,
  isListening,
  voiceTranscriptLog,
  onStartVoice,
  onSaveVoice,
  onSaveRecording,
  setVoiceCandidates,
  isAiCorrecting,
}: {
  inventory: InventoryItem[];
  allCount: number;
  search: string;
  selectedCategory: Category | 'All';
  setSearch: (value: string) => void;
  setSelectedCategory: (value: Category | 'All') => void;
  onAdd: () => void;
  onFinished: (productId: string) => void;
  voiceCandidates: ReceiptLineCandidate[];
  isListening: boolean;
  voiceTranscriptLog: string[];
  onStartVoice: () => void;
  onSaveVoice: () => void;
  onSaveRecording: () => void;
  setVoiceCandidates: (items: ReceiptLineCandidate[]) => void;
  isAiCorrecting: boolean;
}) {
  const hasVoiceSession = voiceCandidates.length > 0 || voiceTranscriptLog.length > 0;

  return (
    <View>
      <SectionTitle title="Present inventory" subtitle={`${allCount} tracked items`} />
      <View style={styles.row}>
        <Pressable style={[styles.primaryButton, styles.flex]} onPress={onAdd}>
          <Text style={styles.primaryButtonText}>Add item manually</Text>
        </Pressable>
        <Pressable
          style={[isListening ? styles.listeningButton : styles.voiceButton, styles.flex]}
          onPress={onStartVoice}
        >
          <Text style={styles.voiceButtonText}>{isListening ? '⏹ Stop listening' : '🎤 Voice add'}</Text>
        </Pressable>
      </View>

      {hasVoiceSession && (
        <View style={styles.sectionGap}>
          <SectionTitle
            title={isListening ? 'Listening…' : isAiCorrecting ? '🤖 AI improving results…' : 'Review voice items'}
            subtitle={
              isListening
                ? `${voiceCandidates.length} item(s) captured so far — click Stop when done.`
                : isAiCorrecting
                ? 'AI is correcting speech-recognition errors. Cards will update shortly.'
                : 'Edit names, quantities, categories, or ignore before saving.'
            }
          />
          {voiceCandidates.map((candidate, index) => (
            <View key={candidate.id} style={styles.card}>
              <Text style={styles.caption}>Heard</Text>
              <Text style={styles.rawLine}>{candidate.rawLine}</Text>
              <TextInput
                style={styles.input}
                value={candidate.suggestedName}
                onChangeText={(value) => {
                  const next = [...voiceCandidates];
                  next[index] = { ...candidate, suggestedName: value, reviewStatus: 'user_corrected' };
                  setVoiceCandidates(next);
                }}
              />
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={String(candidate.quantity)}
                onChangeText={(value) => {
                  const next = [...voiceCandidates];
                  next[index] = { ...candidate, quantity: Number(value) || 1, reviewStatus: 'user_corrected' };
                  setVoiceCandidates(next);
                }}
              />
              <CategoryPicker
                selected={candidate.category}
                onSelect={(value) => {
                  if (value === 'All') return;
                  const next = [...voiceCandidates];
                  next[index] = { ...candidate, category: value, reviewStatus: 'user_corrected' };
                  setVoiceCandidates(next);
                }}
              />
              <Pressable
                style={candidate.trackItem ? styles.secondaryButton : styles.warningButton}
                onPress={() => {
                  const next = [...voiceCandidates];
                  next[index] = {
                    ...candidate,
                    trackItem: !candidate.trackItem,
                    reviewStatus: candidate.trackItem ? 'ignored' : 'user_corrected',
                  };
                  setVoiceCandidates(next);
                }}
              >
                <Text style={candidate.trackItem ? styles.secondaryButtonText : styles.warningButtonText}>
                  {candidate.trackItem ? 'Tracking this item' : 'Ignored'}
                </Text>
              </Pressable>
            </View>
          ))}
          {!isListening && (
            <View style={styles.row}>
              <Pressable style={[styles.warningButton, styles.flex]} onPress={() => setVoiceCandidates([])}>
                <Text style={styles.warningButtonText}>Discard all</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, styles.flex]} onPress={onSaveRecording}>
                <Text style={styles.secondaryButtonText}>💾 Save test recording</Text>
              </Pressable>
              <Pressable style={[styles.primaryButton, styles.flex]} onPress={onSaveVoice}>
                <Text style={styles.primaryButtonText}>Save to inventory</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      <TextInput style={styles.input} placeholder="Search inventory" value={search} onChangeText={setSearch} />
      <CategoryPicker selected={selectedCategory} onSelect={setSelectedCategory} includeAll />
      {inventory.length === 0 ? (
        <EmptyState title="No items yet" body="Add an item manually or import a receipt." />
      ) : (
        inventory.map((item) => <InventoryCard key={item.id} item={item} actionLabel="Finished" onAction={() => onFinished(item.productId)} />)
      )}
    </View>
  );
}

function ReceiptScreen({
  receiptText,
  receiptUrl,
  receiptUrlLoading,
  storeName,
  receiptDate,
  candidates,
  settings,
  setReceiptText,
  setReceiptUrl,
  setStoreName,
  setReceiptDate,
  setCandidates,
  onPickImage,
  onPickDocument,
  onFetchLink,
  onParse,
  onSave,
}: {
  receiptText: string;
  receiptUrl: string;
  receiptUrlLoading: boolean;
  storeName: string;
  receiptDate: string;
  candidates: ReceiptLineCandidate[];
  settings: AppSettings;
  setReceiptText: (value: string) => void;
  setReceiptUrl: (value: string) => void;
  setStoreName: (value: string) => void;
  setReceiptDate: (value: string) => void;
  setCandidates: (value: ReceiptLineCandidate[]) => void;
  onPickImage: () => void;
  onPickDocument: () => void;
  onFetchLink: () => void;
  onParse: () => void;
  onSave: () => void;
}) {
  const aiLabel = settings.activeAiParser !== 'none'
    ? ` · AI: ${settings.activeAiParser}`
    : ' · Regex parser';
  return (
    <View>
      <SectionTitle
        title="Import receipt"
        subtitle={`OCR an image, paste a link, or paste text manually.${aiLabel}`}
      />

      {/* ── Online receipt link ── */}
      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>Online receipt link</Text>
        <Text style={styles.noticeBody}>
          Paste a Walmart, Amazon, Target, or any store online-receipt URL. The page content will be fetched and parsed automatically.
        </Text>
      </View>
      <TextInput
        style={styles.input}
        placeholder="https://www.walmart.com/orders/… or any receipt URL"
        value={receiptUrl}
        onChangeText={setReceiptUrl}
        autoCapitalize="none"
        keyboardType="url"
      />
      <Pressable style={receiptUrlLoading ? styles.disabledButton : styles.primaryButton} onPress={onFetchLink} disabled={receiptUrlLoading}>
        <Text style={styles.primaryButtonText}>{receiptUrlLoading ? 'Fetching…' : 'Fetch & parse receipt link'}</Text>
      </Pressable>

      {/* ── Image / text import ── */}
      <View style={[styles.notice, { marginTop: 8 }]}>
        <Text style={styles.noticeTitle}>From image or file</Text>
      </View>
      <View style={styles.row}>
        <Pressable style={[styles.secondaryButton, styles.flex]} onPress={onPickImage}>
          <Text style={styles.secondaryButtonText}>OCR receipt image</Text>
        </Pressable>
        <Pressable style={[styles.secondaryButton, styles.flex]} onPress={onPickDocument}>
          <Text style={styles.secondaryButtonText}>Import text/PDF</Text>
        </Pressable>
      </View>

      <TextInput style={styles.input} placeholder="Store name" value={storeName} onChangeText={setStoreName} />
      <TextInput style={styles.input} placeholder="Purchase date YYYY-MM-DD" value={receiptDate} onChangeText={setReceiptDate} />
      <TextInput
        style={[styles.input, styles.textArea]}
        placeholder="Or paste receipt text here"
        multiline
        value={receiptText}
        onChangeText={setReceiptText}
      />
      <Pressable style={styles.primaryButton} onPress={onParse}>
        <Text style={styles.primaryButtonText}>Parse receipt</Text>
      </Pressable>

      {candidates.length > 0 && (
        <View style={styles.sectionGap}>
          <SectionTitle title="Review extracted items" subtitle="Edit names, quantities, categories, or ignore lines before saving." />
          {candidates.map((candidate, index) => (
            <View key={candidate.id} style={styles.card}>
              <Text style={styles.caption}>Raw line</Text>
              <Text style={styles.rawLine}>{candidate.rawLine}</Text>
              <TextInput
                style={styles.input}
                value={candidate.suggestedName}
                onChangeText={(value) => {
                  const next = [...candidates];
                  next[index] = { ...candidate, suggestedName: value, reviewStatus: 'user_corrected' };
                  setCandidates(next);
                }}
              />
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={String(candidate.quantity)}
                onChangeText={(value) => {
                  const next = [...candidates];
                  next[index] = { ...candidate, quantity: Number(value) || 1, reviewStatus: 'user_corrected' };
                  setCandidates(next);
                }}
              />
              <CategoryPicker
                selected={candidate.category}
                onSelect={(value) => {
                  if (value === 'All') return;
                  const next = [...candidates];
                  next[index] = { ...candidate, category: value, reviewStatus: 'user_corrected' };
                  setCandidates(next);
                }}
              />
              <Pressable
                style={candidate.trackItem ? styles.secondaryButton : styles.warningButton}
                onPress={() => {
                  const next = [...candidates];
                  next[index] = { ...candidate, trackItem: !candidate.trackItem, reviewStatus: candidate.trackItem ? 'ignored' : 'user_corrected' };
                  setCandidates(next);
                }}
              >
                <Text style={candidate.trackItem ? styles.secondaryButtonText : styles.warningButtonText}>
                  {candidate.trackItem ? 'Tracking this item' : 'Ignored'}
                </Text>
              </Pressable>
            </View>
          ))}
          <Pressable style={styles.primaryButton} onPress={onSave}>
            <Text style={styles.primaryButtonText}>Save to inventory</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function CheckInScreen({
  inventory,
  onFinished,
  onStillHave,
}: {
  inventory: InventoryItem[];
  onFinished: (productId: string) => void;
  onStillHave: (productId: string) => void;
}) {
  return (
    <View>
      <SectionTitle title="Daily 8 PM check-in" subtitle="All inventory items appear here. Mark what got finished today." />
      {inventory.length === 0 ? (
        <EmptyState title="No inventory to check" body="Import a receipt or add items manually first." />
      ) : (
        inventory.map((item) => (
          <View key={item.id} style={styles.card}>
            <Text style={styles.cardTitle}>{item.canonicalName}</Text>
            <Text style={styles.cardMeta}>
              {item.category} · Qty {item.quantityPresent} · {item.status === 'present' ? 'Present' : 'Not present'}
            </Text>
            <View style={styles.row}>
              <Pressable style={[styles.warningButton, styles.flex]} onPress={() => onFinished(item.productId)}>
                <Text style={styles.warningButtonText}>Finished</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, styles.flex]} onPress={() => onStillHave(item.productId)}>
                <Text style={styles.secondaryButtonText}>Still have</Text>
              </Pressable>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

function RestockScreen({
  restock,
  onCancel,
  onRestored,
}: {
  restock: RestockItem[];
  onCancel: (productId: string) => void;
  onRestored: (productId: string) => void;
}) {
  return (
    <View>
      <SectionTitle title="Not present / restock" subtitle="Cancel items you do not want to buy next time." />
      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>Price comparison placeholder</Text>
        <Text style={styles.noticeBody}>
          The next module will compare Costco, Walmart, Target, Safeway, Fred Meyer, location-discovered local grocery stores, and Amazon separately.
        </Text>
      </View>
      {restock.length === 0 ? (
        <EmptyState title="Restock list is empty" body="Mark items finished from Inventory or Check-in." />
      ) : (
        restock.map((item) => (
          <View key={item.id} style={[styles.card, item.cancelledForNextTrip && styles.dimmedCard]}>
            <Text style={styles.cardTitle}>{item.canonicalName}</Text>
            <Text style={styles.cardMeta}>
              {item.category} · Need {item.quantityNeeded} {item.cancelledForNextTrip ? '· Cancelled for next trip' : ''}
            </Text>
            <View style={styles.row}>
              <Pressable style={[styles.secondaryButton, styles.flex]} onPress={() => onRestored(item.productId)}>
                <Text style={styles.secondaryButtonText}>I have it</Text>
              </Pressable>
              <Pressable style={[styles.warningButton, styles.flex]} onPress={() => onCancel(item.productId)}>
                <Text style={styles.warningButtonText}>Do not buy next</Text>
              </Pressable>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

function PricesScreen({
  restock,
  results,
  searching,
  progress,
  sortMode,
  settings,
  onSearch,
  onSortChange,
}: {
  restock: RestockItem[];
  results: StorePriceResult[];
  searching: boolean;
  progress: { done: number; total: number };
  sortMode: 'price' | 'distance';
  settings: AppSettings;
  onSearch: () => void;
  onSortChange: (mode: 'price' | 'distance') => void;
}) {
  const activeCount = restock.filter((r) => !r.cancelledForNextTrip).length;
  const hasKroger = Boolean(settings.krogerClientId && settings.krogerClientSecret);

  const STORE_COLORS: Record<string, string> = {
    walmart: '#0071CE',
    target: '#CC0000',
    costco: '#005DAA',
    wholeFoods: '#00674B',
    safeway: '#E31837',
    albertsons: '#E31837',
    fredMeyer: '#E31837',
    qfc: '#286DB5',
    kroger: '#286DB5',
    haggen: '#2E7D32',
    groceryOutlet: '#F57F17',
    aldi: '#00558C',
    stopAndShop: '#E50000',
    wegmans: '#006F3C',
    acmeMarkets: '#E31837',
    wholeFoods: '#00674B',
  };

  // Real results only (not link-only) for sorting + basket total
  const realResults = results.filter((r) => r.dataSource !== 'link_only');
  const linkOnlyResults = results.filter((r) => r.dataSource === 'link_only');

  const sortedReal = [...realResults].sort((a, b) => {
    if (sortMode === 'distance') {
      const da = a.distanceMiles ?? 9999;
      const db = b.distanceMiles ?? 9999;
      return da !== db ? da - db : (a.totalCost ?? a.price) - (b.totalCost ?? b.price);
    }
    return (a.totalCost ?? a.price) - (b.totalCost ?? b.price);
  });

  // Group real results by item
  const grouped = new Map<string, StorePriceResult[]>();
  for (const r of sortedReal) {
    const existing = grouped.get(r.itemSearched) ?? [];
    grouped.set(r.itemSearched, [...existing, r]);
  }

  // Group link-only by item
  const groupedLinks = new Map<string, StorePriceResult[]>();
  for (const r of linkOnlyResults) {
    const existing = groupedLinks.get(r.itemSearched) ?? [];
    groupedLinks.set(r.itemSearched, [...existing, r]);
  }

  // Best-basket summary: cheapest total across all items by store
  const basketByStore = new Map<string, number>();
  for (const r of sortedReal) {
    const prev = basketByStore.get(r.storeName) ?? 0;
    basketByStore.set(r.storeName, prev + (r.totalCost ?? r.price));
  }
  const basketEntries = Array.from(basketByStore.entries())
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3);

  const progressPct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const allItems = Array.from(new Set([...grouped.keys(), ...groupedLinks.keys()]));

  return (
    <View>
      <SectionTitle
        title="Price comparison"
        subtitle={`${activeCount} item${activeCount === 1 ? '' : 's'} · Live prices from Kroger, Safeway, Target & 20+ stores · Links: Walmart, Costco, Whole Foods`}
      />

      {!hasKroger && (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Add Kroger API key for more live prices</Text>
          <Text style={styles.noticeBody}>
            A free Kroger Developer key in Settings adds Fred Meyer, Ralphs, King Soopers and other Kroger-family stores with real prices.
          </Text>
        </View>
      )}

      <Pressable style={searching ? styles.disabledButton : styles.primaryButton} onPress={onSearch} disabled={searching}>
        <Text style={styles.primaryButtonText}>
          {searching
            ? `Searching ${progress.done} / ${progress.total} items (${progressPct}%)…`
            : results.length > 0
              ? `Re-search prices (${activeCount} items)`
              : `Search prices for ${activeCount} item${activeCount === 1 ? '' : 's'}`}
        </Text>
      </Pressable>

      {realResults.length > 0 && (
        <View style={styles.sortRow}>
          <Text style={styles.sortLabel}>Sort by</Text>
          {(['price', 'distance'] as const).map((mode) => (
            <Pressable
              key={mode}
              style={[styles.sortChip, sortMode === mode && styles.sortChipActive]}
              onPress={() => onSortChange(mode)}
            >
              <Text style={[styles.sortChipText, sortMode === mode && styles.sortChipTextActive]}>
                {mode === 'price' ? 'Cheapest total' : 'Nearest first'}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {basketEntries.length > 1 && (
        <View style={styles.basketSummary}>
          <Text style={styles.basketSummaryTitle}>Estimated basket cost</Text>
          {basketEntries.map(([store, total], i) => (
            <View key={store} style={styles.basketRow}>
              {i === 0 && <Text style={styles.basketBestBadge}>BEST</Text>}
              <Text style={[styles.basketStoreName, i === 0 && styles.basketBestStoreName]}>{store}</Text>
              <Text style={[styles.basketTotal, i === 0 && styles.basketBestTotal]}>${total.toFixed(2)}</Text>
            </View>
          ))}
          <Text style={styles.basketNote}>Based on unit prices × quantities needed. Verify before shopping.</Text>
        </View>
      )}

      {results.length === 0 && !searching && (
        <EmptyState
          title="No prices yet"
          body={activeCount === 0
            ? 'Mark items as finished from Inventory to add them to the restock list.'
            : 'Tap search to fetch live prices from Walmart, Safeway, Kroger, and more.'}
        />
      )}

      {allItems.map((item) => {
        const itemReal = grouped.get(item) ?? [];
        const itemLinks = groupedLinks.get(item) ?? [];

        return (
          <View key={item} style={styles.priceGroup}>
            <Text style={styles.priceGroupHeader}>{item}</Text>

            {itemReal.map((r, idx) => {
              const isBest = idx === 0 && itemReal.length > 1;
              const brandColor =
                r.brandMatch === 'exact' ? '#1A7A3C'
                : r.brandMatch === 'store_brand' ? '#1565C0'
                : r.brandMatch === 'different' ? '#666'
                : '#999';
              const brandLabel =
                r.brandMatch === 'exact' ? '✓ Same brand'
                : r.brandMatch === 'store_brand' ? '⬡ Store brand'
                : r.brandMatch === 'different' ? '↻ Alt brand'
                : null;

              return (
                <View key={r.id} style={[styles.priceCard, isBest && styles.bestDealCard]}>
                  {isBest && (
                    <View style={styles.bestDealBanner}>
                      <Text style={styles.bestDealBannerText}>BEST DEAL</Text>
                    </View>
                  )}
                  <View style={styles.priceCardTop}>
                    <View style={styles.priceCardLeft}>
                      <View style={styles.storeRow}>
                        <Text style={styles.storeBadge}>{r.storeName}</Text>
                        {brandLabel && (
                          <Text style={[styles.brandBadge, { color: brandColor, borderColor: brandColor }]}>
                            {brandLabel}
                          </Text>
                        )}
                        {(r.dataSource === 'api' || r.dataSource === 'scrape') && (
                          <Text style={styles.sourceApiTag}>Live</Text>
                        )}
                      </View>
                      <Text style={styles.priceProductName}>{r.productName}</Text>
                      {r.coverageNote ? (
                        <Text style={styles.coverageNote}>{r.coverageNote}</Text>
                      ) : null}
                      {r.storeAddress ? (
                        <Text style={styles.priceDistanceText}>
                          {r.storeAddress}
                          {r.distanceMiles !== undefined ? ` · ${r.distanceMiles} mi` : ''}
                        </Text>
                      ) : null}
                    </View>
                    <View style={styles.priceCardRight}>
                      {r.totalCost !== undefined && r.unitsNeeded !== undefined && r.unitsNeeded > 1 ? (
                        <>
                          <Text style={styles.totalCostLabel}>Total</Text>
                          <Text style={isBest ? styles.priceSale : styles.priceMain}>
                            ${r.totalCost.toFixed(2)}
                          </Text>
                          <Text style={styles.priceUnit}>
                            {r.unitsNeeded} × ${(r.promoPrice ?? r.price).toFixed(2)}
                          </Text>
                        </>
                      ) : r.promoPrice !== undefined ? (
                        <>
                          <Text style={styles.priceRegularStrike}>${r.price.toFixed(2)}</Text>
                          <Text style={isBest ? styles.priceSale : styles.priceMain}>
                            ${r.promoPrice.toFixed(2)}
                          </Text>
                        </>
                      ) : (
                        <Text style={isBest ? styles.priceSale : styles.priceMain}>
                          ${r.price.toFixed(2)}
                        </Text>
                      )}
                      {r.priceUnit ? <Text style={styles.priceUnit}>{r.priceUnit}</Text> : null}
                    </View>
                  </View>
                  <Pressable
                    style={styles.openStoreButton}
                    onPress={() => Linking.openURL(r.productUrl ?? storeSearchUrl(r.storeName, r.itemSearched))}
                  >
                    <Text style={styles.openStoreButtonText}>View on {r.storeName} →</Text>
                  </Pressable>
                </View>
              );
            })}

            {itemLinks.length > 0 && (
              <View style={styles.linkOnlySection}>
                <View style={styles.linkOnlyHeader}>
                  <Text style={styles.linkOnlyTitle}>Check at these stores</Text>
                  {itemLinks.length > 1 && (
                    <Pressable
                      onPress={() => itemLinks.forEach((r) =>
                        Linking.openURL(r.productUrl ?? storeSearchUrl(r.storeName, r.itemSearched))
                      )}
                    >
                      <Text style={styles.linkOnlyOpenAll}>Open all →</Text>
                    </Pressable>
                  )}
                </View>
                {itemLinks.map((r) => {
                  const accent = STORE_COLORS[r.storeChain] ?? '#555';
                  return (
                    <Pressable
                      key={r.id}
                      style={[styles.linkOnlyCard, { borderLeftColor: accent }]}
                      onPress={() => Linking.openURL(r.productUrl ?? storeSearchUrl(r.storeName, r.itemSearched))}
                    >
                      <View style={styles.linkOnlyCardBody}>
                        <Text style={[styles.linkOnlyStoreName, { color: accent }]}>{r.storeName}</Text>
                        <Text style={styles.linkOnlyCardHint}>Tap to search for "{r.itemSearched}"</Text>
                      </View>
                      <Text style={[styles.linkOnlyArrow, { color: accent }]}>→</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

function StoresScreen({
  stores,
  onDiscover,
  onHide,
}: {
  stores: StoreCandidate[];
  onDiscover: () => void;
  onHide: (storeId: string) => void;
}) {
  return (
    <View>
      <SectionTitle title="Store discovery" subtitle="Discover nearby grocery stores automatically by current location." />
      <Pressable style={styles.primaryButton} onPress={onDiscover}>
        <Text style={styles.primaryButtonText}>Discover nearby grocery stores</Text>
      </Pressable>
      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>Automatic location discovery</Text>
        <Text style={styles.noticeBody}>
          This uses your current GPS location and OpenStreetMap data to find nearby supermarkets and grocery stores. You can hide stores you do not want to use.
        </Text>
      </View>
      {stores.map((store) => (
        <View key={store.id} style={[styles.card, store.hidden && styles.dimmedCard]}>
          <Text style={styles.cardTitle}>{store.name}</Text>
          <Text style={styles.cardMeta}>
            {store.address} · {store.source.replace('_', ' ')}
          </Text>
          {!store.hidden && (
            <Pressable style={styles.secondaryButton} onPress={() => onHide(store.id)}>
              <Text style={styles.secondaryButtonText}>Hide this store</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

async function getDiscoveryCoordinates(locationText: string) {
  if (locationText.trim()) {
    const matches = await Location.geocodeAsync(locationText.trim());
    if (matches[0]) {
      return { latitude: matches[0].latitude, longitude: matches[0].longitude };
    }
  }

  const position = await Location.getCurrentPositionAsync({});
  return { latitude: position.coords.latitude, longitude: position.coords.longitude };
}

function distanceInMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radiusMiles = 3958.8;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(radiusMiles * c * 10) / 10;
}

function SettingsScreen({
  settings,
  onSaveSettings,
  onSchedule,
  onExport,
  onRestore,
}: {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
  onSchedule: () => void;
  onExport: () => void;
  onRestore: () => void;
}) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  return (
    <View>
      {/* ── Search / store settings ── */}
      <SectionTitle title="Settings" subtitle="Local-only controls for reminders, backups, and API keys." />
      <TextInput
        style={styles.input}
        placeholder="Home zip code or address for store discovery"
        value={draft.homeLocationText}
        onChangeText={(value) => setDraft({ ...draft, homeLocationText: value })}
      />
      <TextInput
        style={styles.input}
        placeholder="Search radius miles"
        keyboardType="numeric"
        value={String(draft.searchRadiusMiles)}
        onChangeText={(value) => setDraft({ ...draft, searchRadiusMiles: Number(value) || 8 })}
      />
      <TextInput
        style={styles.input}
        placeholder="Max auto-expand radius miles"
        keyboardType="numeric"
        value={String(draft.maxRadiusMiles)}
        onChangeText={(value) => setDraft({ ...draft, maxRadiusMiles: Number(value) || 30 })}
      />
      <ModePicker selected={draft.optimizationMode} onSelect={(optimizationMode) => setDraft({ ...draft, optimizationMode })} />
      <Pressable style={styles.primaryButton} onPress={onSchedule}>
        <Text style={styles.primaryButtonText}>Enable daily 8 PM reminder</Text>
      </Pressable>
      <Pressable style={styles.secondaryButton} onPress={onExport}>
        <Text style={styles.secondaryButtonText}>Export local backup</Text>
      </Pressable>
      <Pressable style={styles.secondaryButton} onPress={onRestore}>
        <Text style={styles.secondaryButtonText}>Restore from backup</Text>
      </Pressable>

      {/* ── API Keys ── */}
      <View style={styles.apiSection}>
        <Text style={styles.apiSectionTitle}>API Keys</Text>
        <Text style={styles.apiSectionSubtitle}>
          All keys are stored locally on this device. Configure free-tier services to enable OCR, AI parsing, and receipt URL fetching.
        </Text>

        {/* OCR Service */}
        <Text style={styles.apiGroupLabel}>Receipt Image OCR</Text>
        <ServicePicker
          options={[
            { value: 'ocrspace', label: 'OCR.space', hint: 'Free · 25k req/month · demo key works' },
            { value: 'gemini', label: 'Gemini Vision', hint: 'Free · 1M tokens/day · better quality' },
          ]}
          selected={draft.activeOcrService}
          onSelect={(v) => setDraft({ ...draft, activeOcrService: v as AppSettings['activeOcrService'] })}
        />
        <TextInput
          style={styles.input}
          placeholder="OCR.space API key (leave blank for demo key)"
          value={draft.ocrSpaceKey === 'helloworld' ? '' : draft.ocrSpaceKey}
          onChangeText={(v) => setDraft({ ...draft, ocrSpaceKey: v || 'helloworld' })}
          autoCapitalize="none"
          secureTextEntry
        />
        <ApiHint
          label="OCR.space"
          description="Free tier: 25,000 requests/month. Get a key at ocr.space/OCRAPI — leave blank to use the shared demo key."
          signupUrl="https://ocr.space/OCRAPI"
        />

        {/* AI Parser */}
        <Text style={styles.apiGroupLabel}>AI Receipt Parser</Text>
        <ServicePicker
          options={[
            { value: 'none', label: 'None (regex)', hint: 'Built-in, no key needed' },
            { value: 'gemini', label: 'Gemini Flash', hint: 'Free · 15 RPM · very accurate' },
            { value: 'groq', label: 'Groq Llama', hint: 'Free · very fast · 14.4k RPM' },
          ]}
          selected={draft.activeAiParser}
          onSelect={(v) => setDraft({ ...draft, activeAiParser: v as AppSettings['activeAiParser'] })}
        />
        <TextInput
          style={styles.input}
          placeholder="Google Gemini API key"
          value={draft.geminiKey}
          onChangeText={(v) => setDraft({ ...draft, geminiKey: v })}
          autoCapitalize="none"
          secureTextEntry
        />
        <ApiHint
          label="Google Gemini"
          description="Free tier: 15 req/min, 1M tokens/day. Used for both OCR (Vision) and AI parsing. Get a key at aistudio.google.com."
          signupUrl="https://aistudio.google.com/app/apikey"
        />
        <TextInput
          style={styles.input}
          placeholder="Groq API key"
          value={draft.groqKey}
          onChangeText={(v) => setDraft({ ...draft, groqKey: v })}
          autoCapitalize="none"
          secureTextEntry
        />
        <ApiHint
          label="Groq"
          description="Free tier: 14,400 req/min with llama-3.1-8b-instant. Fastest free LLM. Get a key at console.groq.com."
          signupUrl="https://console.groq.com/keys"
        />

        {/* Kroger price search */}
        <Text style={styles.apiGroupLabel}>Grocery Price Search</Text>
        <TextInput
          style={styles.input}
          placeholder="Kroger API Client ID (optional)"
          value={draft.krogerClientId}
          onChangeText={(v) => setDraft({ ...draft, krogerClientId: v })}
          autoCapitalize="none"
          secureTextEntry
        />
        <TextInput
          style={styles.input}
          placeholder="Kroger API Client Secret (optional)"
          value={draft.krogerClientSecret}
          onChangeText={(v) => setDraft({ ...draft, krogerClientSecret: v })}
          autoCapitalize="none"
          secureTextEntry
        />
        <ApiHint
          label="Kroger"
          description="Free forever. Covers Kroger, Fred Meyer, Ralphs, King Soopers, Harris Teeter, Smith's, and more. Register at developer.kroger.com — create an app, copy Client ID + Secret."
          signupUrl="https://developer.kroger.com"
        />

        <TextInput
          style={styles.input}
          placeholder="Instacart API Key (optional — coming soon)"
          value={draft.instacartApiKey}
          onChangeText={(v) => setDraft({ ...draft, instacartApiKey: v })}
          autoCapitalize="none"
          secureTextEntry
        />
        <ApiHint
          label="Instacart"
          description="Covers Walmart, Costco, Safeway, Whole Foods, Target, Kroger, Aldi and more in one API. Apply at instacart.com/developer — approval takes a few days."
          signupUrl="https://www.instacart.com/developer"
        />

        {/* URL Scraper */}
        <Text style={styles.apiGroupLabel}>Receipt URL Scraper</Text>
        <ServicePicker
          options={[
            { value: 'jina', label: 'Jina Reader', hint: 'Free · no key · unlimited' },
            { value: 'firecrawl', label: 'Firecrawl', hint: 'Free · 500/month · more reliable' },
          ]}
          selected={draft.activeUrlScraper}
          onSelect={(v) => setDraft({ ...draft, activeUrlScraper: v as AppSettings['activeUrlScraper'] })}
        />
        <TextInput
          style={styles.input}
          placeholder="Firecrawl API key (optional)"
          value={draft.firecrawlKey}
          onChangeText={(v) => setDraft({ ...draft, firecrawlKey: v })}
          autoCapitalize="none"
          secureTextEntry
        />
        <ApiHint
          label="Firecrawl"
          description="Free tier: 500 scrapes/month. Better for login-required pages. Get a key at firecrawl.dev."
          signupUrl="https://www.firecrawl.dev"
        />

        <Pressable style={styles.primaryButton} onPress={() => onSaveSettings(draft)}>
          <Text style={styles.primaryButtonText}>Save all settings</Text>
        </Pressable>
      </View>

      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>Local-only storage</Text>
        <Text style={styles.noticeBody}>
          Inventory, receipts, and API keys are stored in SQLite on this device only. API keys are never sent anywhere except the respective API service. Export a backup before changing phones.
        </Text>
      </View>
    </View>
  );
}

function ServicePicker({
  options,
  selected,
  onSelect,
}: {
  options: Array<{ value: string; label: string; hint: string }>;
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroller}>
      {options.map((opt) => (
        <Pressable
          key={opt.value}
          style={[styles.serviceChip, selected === opt.value && styles.serviceChipActive]}
          onPress={() => onSelect(opt.value)}
        >
          <Text style={[styles.serviceChipLabel, selected === opt.value && styles.serviceChipLabelActive]}>{opt.label}</Text>
          <Text style={[styles.serviceChipHint, selected === opt.value && styles.serviceChipHintActive]}>{opt.hint}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function ApiHint({ label, description, signupUrl }: { label: string; description: string; signupUrl: string }) {
  return (
    <View style={styles.apiHint}>
      <Text style={styles.apiHintText}>{description}</Text>
      <Pressable onPress={() => Linking.openURL(signupUrl)}>
        <Text style={styles.apiHintLink}>Get {label} key →</Text>
      </Pressable>
    </View>
  );
}

function ModePicker({ selected, onSelect }: { selected: OptimizationMode; onSelect: (mode: OptimizationMode) => void }) {
  const options: OptimizationMode[] = ['distance', 'cost', 'balanced'];

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroller}>
      {options.map((mode) => (
        <Pressable key={mode} style={[styles.categoryChip, selected === mode && styles.categoryChipActive]} onPress={() => onSelect(mode)}>
          <Text style={[styles.categoryChipText, selected === mode && styles.categoryChipTextActive]}>
            {mode === 'distance' ? 'Distance' : mode === 'cost' ? 'Cost' : 'Balanced'}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function InventoryCard({ item, actionLabel, onAction }: { item: InventoryItem; actionLabel: string; onAction: () => void }) {
  return (
    <View style={[styles.card, item.status !== 'present' && styles.dimmedCard]}>
      <Text style={styles.cardTitle}>{item.canonicalName}</Text>
      <Text style={styles.cardMeta}>
        {item.category} · Qty {item.quantityPresent} · {item.status === 'present' ? 'Present' : 'Not present'}
      </Text>
      <Pressable style={styles.secondaryButton} onPress={onAction}>
        <Text style={styles.secondaryButtonText}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

function AddItemModal({
  visible,
  name,
  quantity,
  category,
  setName,
  setQuantity,
  setCategory,
  onClose,
  onSave,
}: {
  visible: boolean;
  name: string;
  quantity: string;
  category: Category;
  setName: (value: string) => void;
  setQuantity: (value: string) => void;
  setCategory: (value: Category) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.modalBackdrop}>
        <View style={styles.modal}>
          <SectionTitle title="Add item" subtitle="Manual entry keeps the app useful before receipt import." />
          <TextInput style={styles.input} placeholder="Item name" value={name} onChangeText={setName} />
          <TextInput style={styles.input} placeholder="Quantity" keyboardType="numeric" value={quantity} onChangeText={setQuantity} />
          <CategoryPicker selected={category} onSelect={(value) => value !== 'All' && setCategory(value)} />
          <View style={styles.row}>
            <Pressable style={[styles.secondaryButton, styles.flex]} onPress={onClose}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.primaryButton, styles.flex]} onPress={onSave}>
              <Text style={styles.primaryButtonText}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function CategoryPicker({
  selected,
  onSelect,
  includeAll = false,
}: {
  selected: Category | 'All';
  onSelect: (value: Category | 'All') => void;
  includeAll?: boolean;
}) {
  const options = includeAll ? (['All', ...categories] as Array<Category | 'All'>) : categories;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroller}>
      {options.map((category) => (
        <Pressable key={category} style={[styles.categoryChip, selected === category && styles.categoryChipActive]} onPress={() => onSelect(category)}>
          <Text style={[styles.categoryChipText, selected === category && styles.categoryChipTextActive]}>{category}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={styles.sectionHeading}>{title}</Text>
      <Text style={styles.sectionSubtitle}>{subtitle}</Text>
    </View>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const colors = {
  background: '#F7F6F2',
  surface: '#F9F8F5',
  surfaceAlt: '#FBFBF9',
  border: '#D4D1CA',
  text: '#28251D',
  muted: '#7A7974',
  primary: '#01696F',
  primaryDark: '#0C4E54',
  warning: '#964219',
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  appTitle: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
  },
  appSubtitle: {
    color: colors.muted,
    fontSize: 14,
    marginTop: 4,
  },
  tabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  tabText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: 16,
    paddingBottom: 48,
  },
  sectionTitle: {
    marginBottom: 14,
  },
  sectionHeading: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
  },
  sectionSubtitle: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  sectionGap: {
    marginTop: 24,
  },
  card: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
  },
  dimmedCard: {
    opacity: 0.55,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  cardMeta: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 6,
    marginBottom: 12,
  },
  caption: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  rawLine: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 10,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  textArea: {
    minHeight: 160,
    textAlignVertical: 'top',
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 15,
  },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  secondaryButtonText: {
    color: colors.primaryDark,
    fontWeight: '800',
    fontSize: 14,
  },
  warningButton: {
    backgroundColor: '#FFF4EC',
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  warningButtonText: {
    color: colors.warning,
    fontWeight: '800',
    fontSize: 14,
  },
  voiceButton: {
    backgroundColor: '#1A3A6B',
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  listeningButton: {
    backgroundColor: '#C0392B',
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  voiceButtonText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  flex: {
    flex: 1,
  },
  categoryScroller: {
    marginBottom: 12,
  },
  categoryChip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
  },
  categoryChipActive: {
    borderColor: colors.primary,
    backgroundColor: '#E9F4F4',
  },
  categoryChipText: {
    color: colors.muted,
    fontWeight: '700',
    fontSize: 13,
  },
  categoryChipTextActive: {
    color: colors.primaryDark,
  },
  emptyState: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: 18,
    padding: 20,
    backgroundColor: colors.surface,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
  },
  emptyBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
  },
  notice: {
    backgroundColor: '#EAF3F3',
    borderWidth: 1,
    borderColor: '#B9D8DA',
    borderRadius: 18,
    padding: 14,
    marginBottom: 14,
  },
  noticeTitle: {
    color: colors.primaryDark,
    fontSize: 15,
    fontWeight: '800',
  },
  noticeBody: {
    color: colors.primaryDark,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  modal: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  disabledButton: {
    backgroundColor: colors.muted,
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  // API Keys section
  apiSection: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 16,
    marginTop: 8,
    marginBottom: 16,
  },
  apiSectionTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 4,
  },
  apiSectionSubtitle: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 16,
  },
  apiGroupLabel: {
    color: colors.primaryDark,
    fontSize: 14,
    fontWeight: '800',
    marginTop: 12,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  serviceChip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginRight: 8,
    alignItems: 'center',
    minWidth: 110,
  },
  serviceChipActive: {
    backgroundColor: '#E9F4F4',
    borderColor: colors.primary,
  },
  serviceChipLabel: {
    color: colors.text,
    fontWeight: '700',
    fontSize: 13,
  },
  serviceChipLabelActive: {
    color: colors.primaryDark,
  },
  serviceChipHint: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 3,
    textAlign: 'center',
  },
  serviceChipHintActive: {
    color: colors.primary,
  },
  apiHint: {
    backgroundColor: '#F3F7F7',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  apiHintText: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  apiHintLink: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  // Price search
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  sortLabel: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
    marginRight: 4,
  },
  sortChip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  sortChipActive: {
    backgroundColor: '#E9F4F4',
    borderColor: colors.primary,
  },
  sortChipText: {
    color: colors.muted,
    fontWeight: '700',
    fontSize: 12,
  },
  sortChipTextActive: {
    color: colors.primaryDark,
  },
  priceGroup: {
    marginBottom: 16,
  },
  priceGroupHeader: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 8,
    paddingLeft: 2,
  },
  priceCard: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 12,
    marginBottom: 8,
  },
  priceCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  priceCardLeft: {
    flex: 1,
    marginRight: 12,
  },
  priceCardRight: {
    alignItems: 'flex-end',
  },
  storeBadge: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  priceProductName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 19,
  },
  priceDistanceText: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 3,
  },
  priceMain: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
  },
  priceSale: {
    color: '#1A7A3C',
    fontSize: 22,
    fontWeight: '800',
  },
  priceRegularStrike: {
    color: colors.muted,
    fontSize: 13,
    textDecorationLine: 'line-through',
    textAlign: 'right',
  },
  priceUnit: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 2,
  },
  openStoreButton: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
    alignItems: 'flex-end',
  },
  openStoreButtonText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  // Price screen — new styles
  bestDealCard: {
    borderColor: '#1A7A3C',
    borderWidth: 2,
  },
  bestDealBanner: {
    backgroundColor: '#1A7A3C',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginBottom: 8,
  },
  bestDealBannerText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 2,
  },
  brandBadge: {
    fontSize: 10,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  sourceApiTag: {
    fontSize: 9,
    fontWeight: '800',
    color: '#1565C0',
    backgroundColor: '#E3F2FD',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    letterSpacing: 0.5,
  },
  coverageNote: {
    color: colors.muted,
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 2,
    marginBottom: 2,
  },
  totalCostLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'right',
    letterSpacing: 0.5,
  },
  basketSummary: {
    backgroundColor: '#F0F7F4',
    borderWidth: 1,
    borderColor: '#A5D6C0',
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
  },
  basketSummaryTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 8,
  },
  basketRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 8,
  },
  basketBestBadge: {
    backgroundColor: '#1A7A3C',
    color: '#fff',
    fontSize: 9,
    fontWeight: '800',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    letterSpacing: 0.5,
  },
  basketStoreName: {
    flex: 1,
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  basketBestStoreName: {
    color: colors.text,
    fontWeight: '800',
  },
  basketTotal: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '700',
  },
  basketBestTotal: {
    color: '#1A7A3C',
    fontSize: 16,
    fontWeight: '800',
  },
  basketNote: {
    color: colors.muted,
    fontSize: 10,
    marginTop: 6,
    fontStyle: 'italic',
  },
  linkOnlySection: {
    marginTop: 8,
    marginBottom: 4,
  },
  linkOnlyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  linkOnlyTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  linkOnlyOpenAll: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  linkOnlyCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  linkOnlyCardBody: {
    flex: 1,
  },
  linkOnlyStoreName: {
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 2,
  },
  linkOnlyCardHint: {
    fontSize: 12,
    color: colors.muted,
  },
  linkOnlyArrow: {
    fontSize: 20,
    fontWeight: '700',
    marginLeft: 12,
  },
});
