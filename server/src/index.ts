import express from 'express';
import cors from 'cors';
import { searchKroger } from './scrapers/kroger';
import { searchWalmart } from './scrapers/walmart';
import { searchSafeway } from './scrapers/safeway';
import { searchInstacart } from './scrapers/instacart';
import { priceCache } from './cache';
import { PriceSearchRequest, StorePriceResult } from './types';

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// ─── Price search ─────────────────────────────────────────────────────────────
app.post('/api/prices', async (req, res) => {
  const body = req.body as PriceSearchRequest;
  const { items, zip, krogerClientId, krogerClientSecret, instacartApiKey } = body;

  if (!items?.length) {
    res.status(400).json({ error: 'items array is required' });
    return;
  }

  const effectiveZip = zip || '10001';
  const allResults: StorePriceResult[] = [];

  // Process items in batches of 3 for parallelism
  for (let i = 0; i < items.length; i += 3) {
    const batch = items.slice(i, i + 3);
    const batchResults = await Promise.allSettled(
      batch.map((item) => searchOneItem(item.canonicalName, effectiveZip, {
        krogerClientId, krogerClientSecret, instacartApiKey,
      })),
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled') allResults.push(...r.value);
    }
  }

  // Annotate with quantity coverage and brand matching
  const annotated = annotateResults(allResults, items);
  res.json({ results: annotated, count: annotated.length });
});

// ─── Individual store endpoints (for testing) ─────────────────────────────────
app.get('/api/kroger', async (req, res) => {
  const { q, zip, clientId, clientSecret } = req.query as Record<string, string>;
  if (!q || !clientId || !clientSecret) {
    res.status(400).json({ error: 'q, clientId, clientSecret required' }); return;
  }
  try {
    const results = await searchKroger(q, zip || '10001', clientId, clientSecret);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/walmart', async (req, res) => {
  const { q } = req.query as Record<string, string>;
  if (!q) { res.status(400).json({ error: 'q required' }); return; }
  try {
    const results = await searchWalmart(q);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/safeway', async (req, res) => {
  const { q, zip } = req.query as Record<string, string>;
  if (!q) { res.status(400).json({ error: 'q required' }); return; }
  try {
    const results = await searchSafeway(q, zip || '10001');
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Search orchestration ─────────────────────────────────────────────────────
async function searchOneItem(
  itemName: string,
  zip: string,
  keys: { krogerClientId?: string; krogerClientSecret?: string; instacartApiKey?: string },
): Promise<StorePriceResult[]> {
  const cacheKey = `${itemName.toLowerCase()}_${zip}`;
  const cached = priceCache.get(cacheKey);
  if (cached) return cached;

  const searches: Promise<StorePriceResult[]>[] = [
    searchWalmart(itemName).catch((e) => { console.error('Walmart error:', e.message); return []; }),
    searchSafeway(itemName, zip).catch((e) => { console.error('Safeway error:', e.message); return []; }),
  ];

  if (keys.krogerClientId && keys.krogerClientSecret) {
    searches.push(
      searchKroger(itemName, zip, keys.krogerClientId, keys.krogerClientSecret)
        .catch((e) => { console.error('Kroger error:', e.message); return []; }),
    );
  }

  if (keys.instacartApiKey) {
    searches.push(
      searchInstacart(itemName, zip, keys.instacartApiKey)
        .catch((e) => { console.error('Instacart error:', e.message); return []; }),
    );
  }

  const results = (await Promise.all(searches)).flat();

  // Add link-only chips for stores with no live data
  const storesCovered = new Set(results.map((r) => r.storeChain));
  const linkOnly = getLinkOnlyResults(itemName, storesCovered);
  const all = [...results, ...linkOnly];

  priceCache.set(cacheKey, all);
  return all;
}

function getLinkOnlyResults(itemName: string, covered: Set<string>): StorePriceResult[] {
  const q = encodeURIComponent(itemName);
  const now = new Date().toISOString();
  const linkStores = [
    { chain: 'walmart', name: 'Walmart', url: `https://www.walmart.com/search?q=${q}` },
    { chain: 'safeway', name: 'Safeway', url: `https://www.safeway.com/shop/search-results.html?q=${q}` },
    { chain: 'costco', name: 'Costco', url: `https://www.costco.com/CatalogSearch?keyword=${q}` },
    { chain: 'wholeFoods', name: 'Whole Foods', url: `https://www.wholefoodsmarket.com/search?text=${q}` },
    { chain: 'target', name: 'Target', url: `https://www.target.com/s?searchTerm=${q}` },
  ];

  return linkStores
    .filter((s) => !covered.has(s.chain))
    .map((s, i) => ({
      id: `link_${s.chain}_${Date.now()}_${i}`,
      itemSearched: itemName,
      storeName: s.name,
      storeChain: s.chain,
      productName: `Search "${itemName}" on ${s.name}`,
      price: 0,
      inStock: true,
      productUrl: s.url,
      searchedAt: now,
      dataSource: 'link_only' as const,
    }));
}

// ─── Annotation (quantity coverage + brand matching) ─────────────────────────
const LIQUID_ML: Record<string, number> = {
  ml: 1, l: 1000, liter: 1000, litre: 1000, liters: 1000,
  floz: 29.5735, 'fl oz': 29.5735, gal: 3785.41, gallon: 3785.41,
  qt: 946.353, pt: 473.176, cup: 236.588,
};
const WEIGHT_G: Record<string, number> = {
  g: 1, gram: 1, grams: 1, kg: 1000, oz: 28.3495, lb: 453.592, lbs: 453.592,
};
const GENERIC_WORDS = new Set([
  'vegetable', 'whole', 'skim', 'fresh', 'organic', 'natural', 'original', 'classic',
  'premium', 'select', 'pure', 'light', 'dark', 'extra', 'large', 'medium', 'small',
  'jumbo', 'regular', 'ultra', 'super', 'mega', 'mini', 'new', 'best', 'great', 'good',
  'milk', 'eggs', 'butter', 'cream', 'juice', 'water', 'bread', 'rice', 'oil', 'salt',
  'sugar', 'flour', 'pasta', 'sauce', 'soup', 'beans', 'corn', 'peas', 'beef', 'chicken',
  'pork', 'fish', 'tuna', 'salmon', 'cheese', 'yogurt', 'frozen', 'canned', 'dried', 'olive',
]);
const STORE_BRANDS: Record<string, string[]> = {
  walmart: ['great value', 'equate', 'sam\'s choice', 'marketside'],
  kroger: ['kroger', 'simple truth', 'private selection'],
  safeway: ['signature select', 'open nature', 'lucerne'],
  costco: ['kirkland'],
  wholeFoods: ['365'],
  target: ['good & gather', 'market pantry'],
};

function parseQtyFromText(text: string): { baseML?: number; baseG?: number; baseCount?: number } | null {
  const t = text.toLowerCase();
  for (const [unit, factor] of Object.entries(LIQUID_ML)) {
    const m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit.replace(' ', '\\s*')}\\b`));
    if (m) return { baseML: parseFloat(m[1]) * factor };
  }
  for (const [unit, factor] of Object.entries(WEIGHT_G)) {
    const m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}\\b`));
    if (m) return { baseG: parseFloat(m[1]) * factor };
  }
  const countM = t.match(/(\d+(?:\.\d+)?)\s*(?:ct|count|pack|pk|pcs?)\b/);
  if (countM) return { baseCount: parseFloat(countM[1]) };
  return null;
}

function annotateResults(
  results: StorePriceResult[],
  items: Array<{ canonicalName: string; quantityNeeded: number }>,
): StorePriceResult[] {
  const restockMap = new Map(items.map((i) => [i.canonicalName.toLowerCase(), i]));

  return results.map((r) => {
    if (r.dataSource === 'link_only') return r;

    const restock = restockMap.get(r.itemSearched.toLowerCase());
    const qty = restock?.quantityNeeded ?? 1;
    const restockParsed = parseQtyFromText(r.itemSearched);
    const productParsed = parseQtyFromText(r.productName);
    const price = r.promoPrice ?? r.price;

    let unitsNeeded = qty;
    let totalCost = price * qty;
    let coverageNote: string | undefined;

    if (restockParsed?.baseML && productParsed?.baseML) {
      const needed = restockParsed.baseML * qty;
      unitsNeeded = Math.ceil(needed / productParsed.baseML);
      totalCost = price * unitsNeeded;
      const display = needed >= 1000 ? `${(needed / 1000).toFixed(1)}L` : `${Math.round(needed)}ml`;
      coverageNote = `${unitsNeeded} × ${productParsed.baseML >= 1000 ? (productParsed.baseML / 1000).toFixed(1) + 'L' : Math.round(productParsed.baseML) + 'ml'} covers ${display}`;
    } else if (restockParsed?.baseG && productParsed?.baseG) {
      const needed = restockParsed.baseG * qty;
      unitsNeeded = Math.ceil(needed / productParsed.baseG);
      totalCost = price * unitsNeeded;
      const display = needed >= 453 ? `${(needed / 453.592).toFixed(1)}lb` : `${Math.round(needed)}g`;
      coverageNote = `${unitsNeeded} × ${productParsed.baseG >= 453 ? (productParsed.baseG / 453.592).toFixed(1) + 'lb' : Math.round(productParsed.baseG) + 'g'} covers ${display}`;
    } else if (productParsed?.baseCount && productParsed.baseCount > 1) {
      unitsNeeded = Math.ceil(qty / productParsed.baseCount);
      totalCost = price * unitsNeeded;
      coverageNote = `${unitsNeeded} × ${productParsed.baseCount} ct covers ${qty} units`;
    }

    // Brand matching
    const rLower = r.itemSearched.toLowerCase();
    const pLower = r.productName.toLowerCase();
    const brandWord = rLower.split(/\s+/).find(
      (w) => w.length > 2 && !/^\d/.test(w) && !GENERIC_WORDS.has(w),
    ) ?? '';

    let brandMatch: StorePriceResult['brandMatch'] = 'unknown';
    if (brandWord && pLower.includes(brandWord)) brandMatch = 'exact';
    else if ((STORE_BRANDS[r.storeChain] ?? []).some((b) => pLower.includes(b))) brandMatch = 'store_brand';
    else if (brandWord) brandMatch = 'different';

    return { ...r, unitsNeeded, totalCost, coverageNote, brandMatch };
  });
}

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛒  House Inventory Price Server running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Prices: POST http://localhost:${PORT}/api/prices`);
  console.log(`   Kroger: GET  http://localhost:${PORT}/api/kroger?q=eggs&zip=97401&clientId=...`);
  console.log(`   Walmart: GET http://localhost:${PORT}/api/walmart?q=eggs`);
  console.log(`   Safeway: GET http://localhost:${PORT}/api/safeway?q=eggs&zip=97401\n`);
});
