import * as SQLite from 'expo-sqlite';
import {
  BackupPayload,
  Category,
  InventoryItem,
  AppSettings,
  OptimizationMode,
  Product,
  ProductAlias,
  Receipt,
  ReceiptLineCandidate,
  RestockItem,
  StoreCandidate,
} from './types';

let _db: SQLite.SQLiteDatabase | null = null;

function db(): SQLite.SQLiteDatabase {
  if (!_db) throw new Error('Database not initialized');
  return _db;
}

export async function initDatabase(): Promise<void> {
  _db = await SQLite.openDatabaseAsync('house_inventory.db');

  await _db.execAsync('PRAGMA journal_mode = WAL;');

  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY NOT NULL,
      canonical_name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      default_unit TEXT NOT NULL DEFAULT 'count',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_aliases (
      id TEXT PRIMARY KEY NOT NULL,
      raw_text TEXT NOT NULL,
      product_id TEXT NOT NULL,
      store_name TEXT,
      confidence REAL NOT NULL,
      created_by_user INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(raw_text, store_name)
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY NOT NULL,
      product_id TEXT NOT NULL UNIQUE,
      quantity_present REAL NOT NULL,
      status TEXT NOT NULL,
      last_purchased_at TEXT,
      last_finished_at TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY NOT NULL,
      source_type TEXT NOT NULL,
      store_name TEXT,
      purchase_date TEXT,
      raw_text TEXT NOT NULL,
      total_amount REAL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS restock_items (
      id TEXT PRIMARY KEY NOT NULL,
      product_id TEXT NOT NULL UNIQUE,
      quantity_needed REAL NOT NULL,
      active INTEGER NOT NULL,
      cancelled_for_next_trip INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      distance_miles REAL,
      source TEXT NOT NULL,
      hidden INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  await seedStores();
  await seedSettings();
}

export async function getInventory(): Promise<InventoryItem[]> {
  const rows = await db().getAllAsync(`
    SELECT
      inventory_items.id,
      inventory_items.product_id as productId,
      products.canonical_name as canonicalName,
      products.category,
      inventory_items.quantity_present as quantityPresent,
      inventory_items.status,
      inventory_items.last_purchased_at as lastPurchasedAt,
      inventory_items.last_finished_at as lastFinishedAt,
      inventory_items.notes
    FROM inventory_items
    JOIN products ON products.id = inventory_items.product_id
    ORDER BY products.category, products.canonical_name
  `);
  return rows as InventoryItem[];
}

export async function getRestockItems(): Promise<RestockItem[]> {
  const rows = await db().getAllAsync(`
    SELECT
      restock_items.id,
      restock_items.product_id as productId,
      products.canonical_name as canonicalName,
      products.category,
      restock_items.quantity_needed as quantityNeeded,
      restock_items.active,
      restock_items.cancelled_for_next_trip as cancelledForNextTrip,
      restock_items.created_at as createdAt
    FROM restock_items
    JOIN products ON products.id = restock_items.product_id
    WHERE restock_items.active = 1
    ORDER BY restock_items.cancelled_for_next_trip, products.category, products.canonical_name
  `);
  return rows.map((item: any) => ({
    ...item,
    active: Boolean(item.active),
    cancelledForNextTrip: Boolean(item.cancelledForNextTrip),
  })) as RestockItem[];
}

export async function getStores(): Promise<StoreCandidate[]> {
  const rows = await db().getAllAsync(`
    SELECT
      id,
      name,
      address,
      distance_miles as distanceMiles,
      source,
      hidden
    FROM stores
    ORDER BY hidden, source, name
  `);
  return rows.map((item: any) => ({ ...item, hidden: Boolean(item.hidden) })) as StoreCandidate[];
}

export async function getAppSettings(): Promise<AppSettings> {
  const rows = (await db().getAllAsync(`SELECT key, value FROM app_settings`)) as Array<{ key: string; value: string }>;
  const s = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    searchRadiusMiles: Number(s.searchRadiusMiles ?? 8),
    maxRadiusMiles: Number(s.maxRadiusMiles ?? 30),
    optimizationMode: ((s.optimizationMode as OptimizationMode | undefined) ?? 'balanced'),
    homeLocationText: s.homeLocationText ?? '',
    ocrSpaceKey: s.ocrSpaceKey ?? 'helloworld',
    geminiKey: s.geminiKey ?? '',
    groqKey: s.groqKey ?? '',
    firecrawlKey: s.firecrawlKey ?? '',
    krogerClientId: s.krogerClientId ?? 'inventorymang-bbcfnbdp',
    krogerClientSecret: s.krogerClientSecret ?? 'V3pZenFiwzX9zKIqt3EUf98aCHWzVuYwRjZbY4w3',
    instacartApiKey: s.instacartApiKey ?? '',
    activeOcrService: (s.activeOcrService as 'ocrspace' | 'gemini' | undefined) ?? 'ocrspace',
    activeAiParser: (s.activeAiParser as 'none' | 'gemini' | 'groq' | undefined) ?? 'none',
    activeUrlScraper: (s.activeUrlScraper as 'jina' | 'firecrawl' | undefined) ?? 'jina',
  };
}

export async function setAppSetting(key: keyof AppSettings, value: string | number): Promise<void> {
  await db().runAsync(
    `INSERT INTO app_settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)],
  );
}

export async function addManualItem(name: string, category: Category, quantity: number): Promise<void> {
  const now = new Date().toISOString();
  const productId = await upsertProduct(name, category, now);
  await addQuantityToInventory(productId, quantity, now);
}

export async function saveReceiptImport(
  rawText: string,
  storeName: string,
  purchaseDate: string,
  candidates: ReceiptLineCandidate[],
  sourceType: Receipt['sourceType'] = 'pasted_text',
): Promise<void> {
  const now = new Date().toISOString();
  const receiptId = createId('receipt');

  await db().runAsync(
    `INSERT INTO receipts (id, source_type, store_name, purchase_date, raw_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [receiptId, sourceType, storeName || null, purchaseDate || null, rawText, now],
  );

  const tracked = candidates.filter((c) => c.trackItem && c.suggestedName.trim().length > 0);
  for (const candidate of tracked) {
    const productId = await upsertProduct(candidate.suggestedName.trim(), candidate.category, now);
    await saveAlias(candidate.rawLine, productId, storeName, candidate.reviewStatus === 'user_corrected');
    await addQuantityToInventory(productId, candidate.quantity || 1, purchaseDate || now);
  }
}

export async function markFinished(productId: string): Promise<void> {
  const now = new Date().toISOString();
  await db().runAsync(
    `UPDATE inventory_items
     SET status = 'not_present', quantity_present = 0, last_finished_at = ?
     WHERE product_id = ?`,
    [now, productId],
  );
  await db().runAsync(
    `INSERT INTO restock_items (id, product_id, quantity_needed, active, cancelled_for_next_trip, created_at)
     VALUES (?, ?, 1, 1, 0, ?)
     ON CONFLICT(product_id) DO UPDATE SET
      active = 1,
      cancelled_for_next_trip = 0,
      quantity_needed = excluded.quantity_needed`,
    [createId('restock'), productId, now],
  );
}

export async function restoreToPresent(productId: string): Promise<void> {
  await db().runAsync(
    `UPDATE inventory_items
     SET status = 'present', quantity_present = CASE WHEN quantity_present <= 0 THEN 1 ELSE quantity_present END
     WHERE product_id = ?`,
    [productId],
  );
  await db().runAsync(`UPDATE restock_items SET active = 0 WHERE product_id = ?`, [productId]);
}

export async function cancelRestock(productId: string): Promise<void> {
  await db().runAsync(`UPDATE restock_items SET cancelled_for_next_trip = 1 WHERE product_id = ?`, [productId]);
}

export async function hideStore(storeId: string): Promise<void> {
  await db().runAsync(`UPDATE stores SET hidden = 1 WHERE id = ?`, [storeId]);
}

export async function upsertDiscoveredStores(
  stores: Array<Omit<StoreCandidate, 'id' | 'source' | 'hidden'>>,
): Promise<void> {
  for (const store of stores) {
    const id = `store_discovered_${slugify(store.name)}_${slugify(store.address)}`;
    await db().runAsync(
      `INSERT INTO stores (id, name, address, distance_miles, source, hidden)
       VALUES (?, ?, ?, ?, 'location_discovered', 0)
       ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        address = excluded.address,
        distance_miles = excluded.distance_miles`,
      [id, store.name, store.address, store.distanceMiles || null],
    );
  }
}

export async function exportBackup(): Promise<BackupPayload> {
  const products = (await db().getAllAsync(`
    SELECT id, canonical_name as canonicalName, category, default_unit as defaultUnit, created_at as createdAt, updated_at as updatedAt
    FROM products
  `)) as Product[];

  const aliases = (
    await db().getAllAsync(`
    SELECT id, raw_text as rawText, product_id as productId, store_name as storeName, confidence, created_by_user as createdByUser, created_at as createdAt
    FROM product_aliases
  `)
  ).map((item: any) => ({ ...item, createdByUser: Boolean(item.createdByUser) })) as ProductAlias[];

  const receipts = (await db().getAllAsync(`
    SELECT id, source_type as sourceType, store_name as storeName, purchase_date as purchaseDate, raw_text as rawText, total_amount as totalAmount, created_at as createdAt
    FROM receipts
  `)) as Receipt[];

  return {
    exportedAt: new Date().toISOString(),
    appVersion: '0.1.0',
    products,
    aliases,
    inventory: await getInventory(),
    receipts,
    restock: await getRestockItems(),
    stores: await getStores(),
    settings: await getAppSettings(),
  };
}

export async function importBackup(payload: BackupPayload): Promise<void> {
  await db().withExclusiveTransactionAsync(async () => {
    await db().execAsync(`
      DELETE FROM restock_items;
      DELETE FROM inventory_items;
      DELETE FROM product_aliases;
      DELETE FROM receipts;
      DELETE FROM stores;
      DELETE FROM products;
    `);

    for (const product of payload.products ?? []) {
      await db().runAsync(
        `INSERT INTO products (id, canonical_name, category, default_unit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [product.id, product.canonicalName, product.category, product.defaultUnit || 'count', product.createdAt, product.updatedAt],
      );
    }

    for (const alias of payload.aliases ?? []) {
      await db().runAsync(
        `INSERT INTO product_aliases (id, raw_text, product_id, store_name, confidence, created_by_user, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [alias.id, alias.rawText, alias.productId, alias.storeName || null, alias.confidence, alias.createdByUser ? 1 : 0, alias.createdAt],
      );
    }

    for (const item of payload.inventory ?? []) {
      await db().runAsync(
        `INSERT INTO inventory_items (id, product_id, quantity_present, status, last_purchased_at, last_finished_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [item.id, item.productId, item.quantityPresent, item.status, item.lastPurchasedAt || null, item.lastFinishedAt || null, item.notes || null],
      );
    }

    for (const receipt of payload.receipts ?? []) {
      await db().runAsync(
        `INSERT INTO receipts (id, source_type, store_name, purchase_date, raw_text, total_amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          receipt.id,
          receipt.sourceType,
          receipt.storeName || null,
          receipt.purchaseDate || null,
          receipt.rawText,
          receipt.totalAmount || null,
          receipt.createdAt,
        ],
      );
    }

    for (const restock of payload.restock ?? []) {
      await db().runAsync(
        `INSERT INTO restock_items (id, product_id, quantity_needed, active, cancelled_for_next_trip, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [restock.id, restock.productId, restock.quantityNeeded, restock.active ? 1 : 0, restock.cancelledForNextTrip ? 1 : 0, restock.createdAt],
      );
    }

    for (const store of payload.stores ?? []) {
      await db().runAsync(
        `INSERT INTO stores (id, name, address, distance_miles, source, hidden)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [store.id, store.name, store.address, store.distanceMiles || null, store.source, store.hidden ? 1 : 0],
      );
    }

    if (payload.settings) {
      await setAppSetting('searchRadiusMiles', payload.settings.searchRadiusMiles);
      await setAppSetting('maxRadiusMiles', payload.settings.maxRadiusMiles);
      await setAppSetting('optimizationMode', payload.settings.optimizationMode);
      await setAppSetting('homeLocationText', payload.settings.homeLocationText);
    }
  });
}

async function upsertProduct(name: string, category: Category, now: string): Promise<string> {
  const existing = (await db().getFirstAsync(`SELECT id FROM products WHERE lower(canonical_name) = lower(?)`, [name])) as {
    id: string;
  } | null;
  if (existing) return existing.id;

  const productId = createId('product');
  await db().runAsync(
    `INSERT INTO products (id, canonical_name, category, default_unit, created_at, updated_at)
     VALUES (?, ?, ?, 'count', ?, ?)`,
    [productId, name, category, now, now],
  );
  return productId;
}

async function addQuantityToInventory(productId: string, quantity: number, purchasedAt: string): Promise<void> {
  await db().runAsync(
    `INSERT INTO inventory_items (id, product_id, quantity_present, status, last_purchased_at)
     VALUES (?, ?, ?, 'present', ?)
     ON CONFLICT(product_id) DO UPDATE SET
      quantity_present = inventory_items.quantity_present + excluded.quantity_present,
      status = 'present',
      last_purchased_at = excluded.last_purchased_at`,
    [createId('inventory'), productId, quantity, purchasedAt],
  );
  await db().runAsync(`UPDATE restock_items SET active = 0 WHERE product_id = ?`, [productId]);
}

async function saveAlias(rawText: string, productId: string, storeName: string, createdByUser: boolean): Promise<void> {
  await db().runAsync(
    `INSERT INTO product_aliases (id, raw_text, product_id, store_name, confidence, created_by_user, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(raw_text, store_name) DO UPDATE SET
      product_id = excluded.product_id,
      confidence = excluded.confidence,
      created_by_user = excluded.created_by_user`,
    [createId('alias'), rawText, productId, storeName || null, createdByUser ? 0.99 : 0.75, createdByUser ? 1 : 0, new Date().toISOString()],
  );
}

async function seedStores(): Promise<void> {
  const count = (await db().getFirstAsync(`SELECT COUNT(*) as count FROM stores`)) as { count: number };
  if (count.count > 0) return;

  const seed: StoreCandidate[] = [
    { id: 'store_costco', name: 'Costco', address: 'Auto-discover nearest Costco', source: 'preferred_chain', hidden: false },
    { id: 'store_walmart', name: 'Walmart', address: 'Auto-discover nearest Walmart', source: 'preferred_chain', hidden: false },
    { id: 'store_target', name: 'Target', address: 'Auto-discover nearest Target', source: 'preferred_chain', hidden: false },
    { id: 'store_safeway', name: 'Safeway', address: 'Auto-discover nearest Safeway', source: 'preferred_chain', hidden: false },
    { id: 'store_fred_meyer', name: 'Fred Meyer', address: 'Auto-discover nearest Fred Meyer', source: 'preferred_chain', hidden: false },
    { id: 'store_amazon', name: 'Amazon', address: 'Online / delivery option', source: 'online', hidden: false },
  ];

  for (const store of seed) {
    await db().runAsync(
      `INSERT INTO stores (id, name, address, distance_miles, source, hidden) VALUES (?, ?, ?, ?, ?, ?)`,
      [store.id, store.name, store.address, store.distanceMiles || null, store.source, 0],
    );
  }
}

async function seedSettings(): Promise<void> {
  const count = (await db().getFirstAsync(`SELECT COUNT(*) as count FROM app_settings`)) as { count: number };
  if (count.count > 0) return;

  await setAppSetting('searchRadiusMiles', 8);
  await setAppSetting('maxRadiusMiles', 30);
  await setAppSetting('optimizationMode', 'balanced');
  await setAppSetting('homeLocationText', '');
}

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}
