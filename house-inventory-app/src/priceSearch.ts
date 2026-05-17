import { AppSettings, BrandMatch, DataSource, ParsedQty, RestockItem, StorePriceResult } from './types';

// Backend proxy server URL — run `npm run dev` in server/ to enable real Walmart/Safeway scraping
const BACKEND_URL = 'http://localhost:3001';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// Module-level caches
let _krogerToken: { value: string; expiresAt: number } | null = null;
const _krogerLocationCache = new Map<string, KrogerLocation>();
const _safewayStoreCache = new Map<string, string>();

type KrogerLocation = {
  locationId: string;
  name: string;
  address: string;
  distanceMiles?: number;
};

// ─────────────────────────── Quantity parsing ────────────────────────────────

// Volume conversions to ml
const LIQUID_ML: Record<string, number> = {
  ml: 1, milliliter: 1, milliliters: 1, millilitre: 1, millilitres: 1,
  l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
  floz: 29.5735, 'fl oz': 29.5735,
  gal: 3785.41, gallon: 3785.41, gallons: 3785.41,
  qt: 946.353, quart: 946.353, quarts: 946.353,
  pt: 473.176, pint: 473.176, pints: 473.176,
  cup: 236.588, cups: 236.588,
};

// Weight conversions to grams
const WEIGHT_G: Record<string, number> = {
  g: 1, gram: 1, grams: 1,
  kg: 1000, kilogram: 1000, kilograms: 1000,
  mg: 0.001, milligram: 0.001, milligrams: 0.001,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
  lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
};

/**
 * Parses a product quantity string from a product name.
 * Handles: "48 fl oz", "2L", "6 pack", "32 oz", "5 lb", "12 ct"
 * Also handles multiplied formats: "4 x 1L", "6 x 16.9 fl oz"
 */
export function parseProductQty(text: string): ParsedQty | null {
  const t = text.trim();

  // Multiplied format: "N x M unit" or "N × M unit"
  const multiMatch = t.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z\s.]+)/i);
  if (multiMatch) {
    const count = parseInt(multiMatch[1]);
    const subAmount = parseFloat(multiMatch[2]);
    const rawUnit = multiMatch[3].trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
    const sub = parseSingleQty(subAmount, rawUnit);
    if (sub) {
      return {
        amount: count * subAmount,
        unit: sub.unit,
        displayStr: `${count} × ${subAmount} ${sub.unit}`,
        baseML: sub.baseML !== undefined ? sub.baseML * count : undefined,
        baseG: sub.baseG !== undefined ? sub.baseG * count : undefined,
        baseCount: sub.baseCount !== undefined ? sub.baseCount * count : count,
      };
    }
  }

  // Standard: number + unit  — try from end of string working backwards
  const patterns: Array<[RegExp, string]> = [
    [/(\d+(?:\.\d+)?)\s*fl\.?\s*oz\b/i, 'fl oz'],
    [/(\d+(?:\.\d+)?)\s*(?:milliliters?|millilitres?|ml)\b/i, 'ml'],
    [/(\d+(?:\.\d+)?)\s*(?:liters?|litres?)\b/i, 'L'],
    [/(\d+(?:\.\d+)?)\s*L\b/, 'L'],
    [/(\d+(?:\.\d+)?)\s*(?:gallons?|gal)\b/i, 'gal'],
    [/(\d+(?:\.\d+)?)\s*(?:quarts?|qt)\b/i, 'qt'],
    [/(\d+(?:\.\d+)?)\s*(?:pints?|pt)\b/i, 'pt'],
    [/(\d+(?:\.\d+)?)\s*(?:kilograms?|kg)\b/i, 'kg'],
    [/(\d+(?:\.\d+)?)\s*(?:pounds?|lbs?)\b/i, 'lb'],
    [/(\d+(?:\.\d+)?)\s*(?:ounces?|oz)\b/i, 'oz'],
    [/(\d+(?:\.\d+)?)\s*(?:grams?|g)\b/i, 'g'],
    [/(\d+(?:\.\d+)?)\s*(?:count|ct|pack|pk|pcs?|pieces?|items?)\b/i, 'ct'],
  ];

  for (const [re, unit] of patterns) {
    const m = t.match(re);
    if (m) {
      const amount = parseFloat(m[1]);
      if (amount > 0) {
        return parseSingleQty(amount, unit.toLowerCase());
      }
    }
  }

  return null;
}

function parseSingleQty(amount: number, rawUnit: string): ParsedQty | null {
  const u = rawUnit.trim().toLowerCase().replace(/\.$/, '');

  if (LIQUID_ML[u] !== undefined) {
    const ml = amount * LIQUID_ML[u];
    const displayUnit = amount >= 0.95 && u === 'l' ? 'L'
      : u === 'fl oz' || u === 'floz' ? 'fl oz'
      : u.includes('gal') ? 'gal'
      : u;
    return { amount, unit: displayUnit, displayStr: `${amount} ${displayUnit}`, baseML: ml };
  }

  if (WEIGHT_G[u] !== undefined) {
    const g = amount * WEIGHT_G[u];
    const displayUnit = u === 'lb' || u === 'lbs' ? 'lb'
      : u === 'oz' || u === 'ounce' || u === 'ounces' ? 'oz'
      : u === 'kg' ? 'kg'
      : 'g';
    return { amount, unit: displayUnit, displayStr: `${amount} ${displayUnit}`, baseG: g };
  }

  if (['ct', 'count', 'pack', 'pk', 'pcs', 'pc', 'pieces', 'piece', 'items', 'item'].includes(u)) {
    return { amount, unit: 'ct', displayStr: `${amount} ct`, baseCount: amount };
  }

  return null;
}

/** Computes how many units of a product are needed and total cost. */
function computeCoverage(
  restockQty: number,
  restockParsed: ParsedQty | null,
  productParsed: ParsedQty | null,
  unitPrice: number,
): { unitsNeeded: number; totalCost: number; coverageNote: string } {
  const fallback = { unitsNeeded: restockQty, totalCost: unitPrice * restockQty, coverageNote: '' };

  if (!productParsed) return fallback;

  // Both liquid
  if (restockParsed?.baseML && productParsed.baseML) {
    const totalNeededML = restockParsed.baseML * restockQty;
    const unitsNeeded = Math.ceil(totalNeededML / productParsed.baseML);
    const totalCost = unitPrice * unitsNeeded;
    const restockDisplay = totalNeededML >= 1000
      ? `${(totalNeededML / 1000).toFixed(1)}L`
      : `${Math.round(totalNeededML)}ml`;
    return {
      unitsNeeded,
      totalCost,
      coverageNote: `${unitsNeeded} × ${productParsed.displayStr} covers ${restockDisplay}`,
    };
  }

  // Both weight
  if (restockParsed?.baseG && productParsed.baseG) {
    const totalNeededG = restockParsed.baseG * restockQty;
    const unitsNeeded = Math.ceil(totalNeededG / productParsed.baseG);
    const totalCost = unitPrice * unitsNeeded;
    const restockDisplay = totalNeededG >= 453 ? `${(totalNeededG / 453.592).toFixed(1)}lb` : `${Math.round(totalNeededG)}g`;
    return {
      unitsNeeded,
      totalCost,
      coverageNote: `${unitsNeeded} × ${productParsed.displayStr} covers ${restockDisplay}`,
    };
  }

  // Both count (or no unit info)
  const unitsNeeded = Math.ceil(restockQty / (productParsed.baseCount ?? 1));
  return {
    unitsNeeded,
    totalCost: unitPrice * unitsNeeded,
    coverageNote: productParsed.baseCount && productParsed.baseCount > 1
      ? `${unitsNeeded} × ${productParsed.displayStr} covers ${restockQty} units`
      : '',
  };
}

// ─────────────────────────── Brand matching ──────────────────────────────────

const STORE_BRANDS: Record<string, string[]> = {
  walmart: ['great value', 'equate', 'mainstays', 'parent\'s choice', 'sam\'s choice', 'marketside'],
  kroger: ['kroger', 'simple truth', 'private selection', 'comforts'],
  safeway: ['signature select', 'signature care', 'open nature', 'lucerne', 'waterfront bistro'],
  costco: ['kirkland', 'kirkland signature'],
  wholeFoods: ['365', '365 by whole foods', '365 everyday value'],
  target: ['good & gather', 'market pantry', 'up & up', 'favorite day'],
};

// Common generic food/product words that are not brand names
const GENERIC_WORDS = new Set([
  'vegetable', 'whole', 'skim', 'fresh', 'organic', 'natural', 'original', 'classic',
  'premium', 'select', 'pure', 'light', 'dark', 'extra', 'large', 'medium', 'small',
  'jumbo', 'regular', 'ultra', 'super', 'mega', 'mini', 'new', 'best', 'great', 'good',
  'milk', 'eggs', 'butter', 'cream', 'juice', 'water', 'bread', 'rice', 'oil', 'salt',
  'sugar', 'flour', 'pasta', 'sauce', 'soup', 'beans', 'corn', 'peas', 'beef', 'chicken',
  'pork', 'fish', 'tuna', 'salmon', 'cheese', 'yogurt', 'frozen', 'canned', 'dried', 'olive',
]);

function matchBrand(restockName: string, productName: string, storeChain: string): BrandMatch {
  const rLower = restockName.toLowerCase();
  const pLower = productName.toLowerCase();

  // Extract the brand: first word that looks like a proper brand (not a generic food word, not a number/unit)
  const brandWord = rLower.split(/\s+/).find(
    (w) => w.length > 2 && !/^\d/.test(w) && !GENERIC_WORDS.has(w) && !/^(fl|oz|ml|gal|qt|pt|lb|kg|ct|pk)$/.test(w),
  ) ?? '';

  if (brandWord && pLower.includes(brandWord)) return 'exact';

  const chainBrands = STORE_BRANDS[storeChain] ?? [];
  if (chainBrands.some((b) => pLower.includes(b))) return 'store_brand';

  if (brandWord && !pLower.includes(brandWord)) return 'different';

  return 'unknown';
}

/**
 * Annotates raw search results with quantity coverage, brand match, and total cost.
 * Called after all stores return results.
 */
export function annotateResults(
  results: StorePriceResult[],
  restockItems: RestockItem[],
): StorePriceResult[] {
  const restockMap = new Map(restockItems.map((r) => [r.canonicalName.toLowerCase(), r]));

  return results.map((r) => {
    const restock = restockMap.get(r.itemSearched.toLowerCase());
    const qty = restock?.quantityNeeded ?? 1;
    const restockParsed = parseProductQty(r.itemSearched);
    const productParsed = parseProductQty(r.productName);
    const effectivePrice = r.promoPrice ?? r.price;

    const { unitsNeeded, totalCost, coverageNote } = computeCoverage(
      qty,
      restockParsed,
      productParsed,
      effectivePrice,
    );

    const brandMatch = matchBrand(r.itemSearched, r.productName, r.storeChain);

    return {
      ...r,
      quantityParsed: productParsed ?? undefined,
      unitsNeeded,
      totalCost,
      coverageNote: coverageNote || undefined,
      brandMatch,
    };
  });
}

// ─────────────────────────── Main entry point ────────────────────────────────

/**
 * Searches Walmart, Kroger/Fred Meyer, Safeway, and generates links for
 * Costco and Whole Foods. Results are annotated with quantity coverage and brand data.
 *
 * Tries the backend proxy server first (enables real Walmart/Safeway scraping via Puppeteer).
 * Falls back to browser-side direct calls when the backend is not running.
 */
export async function searchAllStores(
  items: RestockItem[],
  settings: AppSettings,
  onProgress?: (done: number, total: number) => void,
): Promise<StorePriceResult[]> {
  const active = items.filter((i) => !i.cancelledForNextTrip);
  if (active.length === 0) return [];

  // Try backend proxy server (real Walmart/Safeway scraping, no CORS restrictions)
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(`${BACKEND_URL}/api/prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: active.map((i) => ({ canonicalName: i.canonicalName, quantityNeeded: i.quantityNeeded })),
        zip: extractZip(settings.homeLocationText),
        krogerClientId: settings.krogerClientId,
        krogerClientSecret: settings.krogerClientSecret,
        instacartApiKey: settings.instacartApiKey || undefined,
      }),
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (resp.ok) {
      const data = await resp.json() as { results: StorePriceResult[] };
      onProgress?.(active.length, active.length);
      return data.results;
    }
  } catch {
    // Backend not running — fall through to browser-side search
  }

  // Fallback: browser-side search (Kroger via corsproxy.io; Walmart/Safeway → link-only)
  const allResults: StorePriceResult[] = [];
  let done = 0;

  for (let i = 0; i < active.length; i += 3) {
    const batch = active.slice(i, i + 3);
    const batchResults = await Promise.allSettled(
      batch.map((item) => searchOneItem(item, settings)),
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled') allResults.push(...r.value);
      done++;
      onProgress?.(done, active.length);
    }
  }

  return annotateResults(allResults, active);
}

async function searchOneItem(item: RestockItem, settings: AppSettings): Promise<StorePriceResult[]> {
  const name = item.canonicalName;

  const [walmartResults, safewayResults, krogerResults] = await Promise.all([
    searchWalmart(name).catch(() => [] as StorePriceResult[]),
    searchSafeway(name, settings).catch(() => [] as StorePriceResult[]),
    settings.krogerClientId && settings.krogerClientSecret
      ? searchKroger(name, settings).catch(() => [] as StorePriceResult[])
      : Promise.resolve([] as StorePriceResult[]),
  ]);

  // Stores whose live search failed fall back to link-only chips
  const fallbackLinks: string[] = [];
  if (walmartResults.length === 0) fallbackLinks.push('walmart');
  if (safewayResults.length === 0) fallbackLinks.push('safeway');
  if (krogerResults.length === 0 && !settings.krogerClientId) fallbackLinks.push('fredMeyer');

  const linkOnly = getLinkOnlyResults(name, fallbackLinks);

  return [...walmartResults, ...safewayResults, ...krogerResults, ...linkOnly];
}

// ─────────────────────────── Walmart ────────────────────────────────────────

async function searchWalmart(itemName: string): Promise<StorePriceResult[]> {
  const url = `https://www.walmart.com/search?q=${encodeURIComponent(cleanSearchTerm(itemName))}&cat_id=0`;
  const html = await fetchPageWithProxy(url);
  return parseWalmartSearchPage(html, itemName);
}

async function fetchPageWithProxy(url: string): Promise<string> {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (r.ok) {
      const text = await r.text();
      if (text.includes('__NEXT_DATA__')) return text;
    }
  } catch {
    // fall through
  }
  const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
    headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from proxy`);
  return r.text();
}

function parseWalmartSearchPage(html: string, itemSearched: string): StorePriceResult[] {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pp = (data as any)?.props?.pageProps;
  const searchResult = pp?.initialData?.searchResult ?? pp?.searchResult;
  if (!searchResult) return [];

  const stacks: unknown[] = Array.isArray(searchResult?.itemStacks) ? searchResult.itemStacks : [];
  const results: StorePriceResult[] = [];
  const now = new Date().toISOString();

  for (const stack of stacks) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: unknown[] = Array.isArray((stack as any)?.items) ? (stack as any).items : [];

    for (const raw of items) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item = raw as any;
      const name: string = item?.name ?? item?.title ?? '';
      if (!name || typeof name !== 'string' || !name.trim()) continue;

      const price: number =
        typeof item?.price === 'number'
          ? item.price
          : typeof item?.priceInfo?.currentPrice?.price === 'number'
            ? item.priceInfo.currentPrice.price
            : typeof item?.priceInfo?.priceRange?.minPrice === 'number'
              ? item.priceInfo.priceRange.minPrice
              : NaN;

      if (!Number.isFinite(price) || price <= 0) continue;

      const canonicalUrl: string = item?.canonicalUrl ?? '';
      const productUrl = canonicalUrl
        ? `https://www.walmart.com${canonicalUrl.split('?')[0]}`
        : `https://www.walmart.com/search?q=${encodeURIComponent(itemSearched)}`;

      results.push({
        id: `walmart_${Date.now()}_${results.length}`,
        itemSearched,
        storeName: 'Walmart',
        storeChain: 'walmart',
        productName: cleanProductName(name),
        price,
        inStock: item?.availabilityStatus !== 'OUT_OF_STOCK',
        productUrl,
        searchedAt: now,
        dataSource: 'scrape',
      });

      if (results.length >= 5) return results;
    }
  }

  return results;
}

// ─────────────────────────── Safeway ────────────────────────────────────────

// Subscription key embedded in Safeway's public JavaScript bundle
const SAFEWAY_KEY = '5e790ef3f6614e19b701d65c29da63cc';

async function getNearestSafewayStore(zip: string): Promise<string> {
  const cached = _safewayStoreCache.get(zip);
  if (cached) return cached;

  try {
    const resp = await fetch(
      `https://corsproxy.io/?${encodeURIComponent(
        `https://storeeapi.safeway.com/api/v1/locations?distance=20&pageSize=1&postalCode=${zip}`,
      )}`,
      { headers: { Accept: 'application/json', 'User-Agent': MOBILE_UA } },
    );
    if (resp.ok) {
      const d = await resp.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = d?.response?.docs ?? d?.stores ?? d?.data ?? [];
      if (stores.length > 0) {
        const id = String(stores[0].storeId ?? stores[0].id ?? stores[0].storeNumber ?? '3132');
        _safewayStoreCache.set(zip, id);
        return id;
      }
    }
  } catch {
    // fall through
  }
  return '3132'; // national fallback store ID
}

async function searchSafeway(itemName: string, settings: AppSettings): Promise<StorePriceResult[]> {
  const zip = extractZip(settings.homeLocationText);
  const storeId = await getNearestSafewayStore(zip);

  const url = `https://www.safeway.com/abs/pub/xapi/productsearch/v2?q=${encodeURIComponent(cleanSearchTerm(itemName))}&rows=5&start=0&storeid=${storeId}`;

  const resp = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
    headers: {
      'ocp-apim-subscription-key': SAFEWAY_KEY,
      Accept: 'application/json',
      'User-Agent': MOBILE_UA,
    },
  });

  if (!resp.ok) throw new Error(`Safeway ${resp.status}`);

  const data = await resp.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const products: any[] = data?.results?.[0]?.products ?? data?.catalog?.response?.docs ?? [];
  if (!products.length) return [];

  const now = new Date().toISOString();
  const results: StorePriceResult[] = [];

  for (const p of products.slice(0, 5)) {
    const name: string = p?.name ?? p?.description ?? '';
    if (!name.trim()) continue;

    const price: number =
      typeof p?.currentPrice === 'number'
        ? p.currentPrice
        : typeof p?.priceAmount === 'number'
          ? p.priceAmount
          : NaN;

    if (!Number.isFinite(price) || price <= 0) continue;

    results.push({
      id: `safeway_${Date.now()}_${results.length}`,
      itemSearched: itemName,
      storeName: 'Safeway',
      storeChain: 'safeway',
      productName: cleanProductName(name),
      price,
      inStock: p?.inStock !== false,
      productUrl: `https://www.safeway.com/shop/search-results.html?q=${encodeURIComponent(itemName)}`,
      searchedAt: now,
      dataSource: 'api',
    });
  }

  return results;
}

// ─────────────────────────── Kroger / Fred Meyer ─────────────────────────────

async function searchKroger(itemName: string, settings: AppSettings): Promise<StorePriceResult[]> {
  const { krogerClientId, krogerClientSecret } = settings;
  if (!krogerClientId || !krogerClientSecret) return [];

  const token = await getKrogerToken(krogerClientId, krogerClientSecret);
  const location = await getNearestKrogerStore(token, extractZip(settings.homeLocationText));

  const resp = await fetch(
    KROGER_PROXY(
      `https://api.kroger.com/v1/products?` +
      `filter.term=${encodeURIComponent(cleanSearchTerm(itemName))}` +
      `&filter.locationId=${encodeURIComponent(location.locationId)}` +
      `&filter.limit=5`,
    ),
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  if (!resp.ok) return [];

  const data = await resp.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const products: unknown[] = Array.isArray((data as any)?.data) ? (data as any).data : [];
  const now = new Date().toISOString();
  const results: StorePriceResult[] = [];

  for (const raw of products) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = raw as any;
    const desc: string = p?.description ?? '';
    if (!desc.trim()) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstItem = (Array.isArray(p?.items) ? p.items[0] : null) as any;
    const regularPrice: number = firstItem?.price?.regular ?? NaN;
    const promoPrice: number | undefined =
      typeof firstItem?.price?.promo === 'number' && firstItem.price.promo < regularPrice
        ? firstItem.price.promo
        : undefined;

    const price = promoPrice ?? regularPrice;
    if (!Number.isFinite(price) || price <= 0) continue;

    const size: string = firstItem?.size ?? '';
    const productId: string = p?.productId ?? '';

    results.push({
      id: `kroger_${Date.now()}_${results.length}`,
      itemSearched: itemName,
      storeName: location.name,
      storeChain: 'kroger',
      productName: cleanProductName(`${desc}${size ? ' ' + size : ''}`),
      price,
      promoPrice,
      priceUnit: firstItem?.soldBy === 'WEIGHT' ? 'per lb' : 'each',
      inStock: true,
      distanceMiles: location.distanceMiles,
      storeAddress: location.address,
      productUrl: `https://www.kroger.com/p/${slugify(desc)}/${productId}`,
      searchedAt: now,
      dataSource: 'api',
    });
  }

  return results;
}

const KROGER_PROXY = (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`;

async function getKrogerToken(clientId: string, clientSecret: string): Promise<string> {
  if (_krogerToken && _krogerToken.expiresAt > Date.now()) return _krogerToken.value;

  const creds = btoa(`${clientId}:${clientSecret}`);
  const resp = await fetch(KROGER_PROXY('https://api.kroger.com/v1/connect/oauth2/token'), {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=product.compact',
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Kroger auth failed (${resp.status}): ${body.slice(0, 120)}`);
  }

  const d = await resp.json();
  const token: string = d.access_token;
  const expiresIn: number = Number(d.expires_in) || 1800;
  _krogerToken = { value: token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
  return token;
}

async function getNearestKrogerStore(token: string, zip: string): Promise<KrogerLocation> {
  const cached = _krogerLocationCache.get(zip);
  if (cached) return cached;

  const resp = await fetch(
    KROGER_PROXY(`https://api.kroger.com/v1/locations?filter.zipCode=${zip}&filter.radiusInMiles=50&filter.limit=1`),
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  if (!resp.ok) throw new Error(`Kroger location lookup failed (${resp.status})`);

  const d = await resp.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc = (d as any)?.data?.[0];
  if (!loc) throw new Error('No Kroger/Fred Meyer stores found near your home location. Add a zip code in Settings.');

  const addr = loc.address ?? {};
  const result: KrogerLocation = {
    locationId: String(loc.locationId),
    name: loc.name ?? 'Kroger',
    address: [addr.addressLine1, addr.city, addr.state].filter(Boolean).join(', '),
    distanceMiles: undefined,
  };

  _krogerLocationCache.set(zip, result);
  return result;
}

// ─────────────────────────── Link-only stores ────────────────────────────────

function getLinkOnlyResults(itemName: string, extra: string[] = []): StorePriceResult[] {
  const now = new Date().toISOString();
  const q = encodeURIComponent(itemName);

  const allStores: Record<string, { name: string; chain: string; url: string }> = {
    walmart: { name: 'Walmart', chain: 'walmart', url: `https://www.walmart.com/search?q=${q}` },
    safeway: { name: 'Safeway', chain: 'safeway', url: `https://www.safeway.com/shop/search-results.html?q=${q}` },
    costco: { name: 'Costco', chain: 'costco', url: `https://www.costco.com/CatalogSearch?keyword=${q}` },
    wholeFoods: { name: 'Whole Foods', chain: 'wholeFoods', url: `https://www.wholefoodsmarket.com/search?text=${q}` },
    target: { name: 'Target', chain: 'target', url: `https://www.target.com/s?searchTerm=${q}` },
    fredMeyer: { name: 'Fred Meyer', chain: 'fredMeyer', url: `https://www.fredmeyer.com/search?query=${q}` },
  };

  // Default stores always shown as link-only + any extras (fallback for failed live searches)
  const defaultKeys = ['costco', 'wholeFoods', 'target'];
  const keys = Array.from(new Set([...defaultKeys, ...extra]));
  const stores = keys.map((k) => allStores[k]).filter(Boolean);

  return stores.map((s, i) => ({
    id: `${s.chain}_link_${Date.now()}_${i}`,
    itemSearched: itemName,
    storeName: s.name,
    storeChain: s.chain,
    productName: `Search "${itemName}" on ${s.name}`,
    price: 0,
    inStock: true,
    productUrl: s.url,
    searchedAt: now,
    dataSource: 'link_only' as DataSource,
  }));
}

// ─────────────────────────── Helpers ────────────────────────────────────────

function extractZip(locationText: string): string {
  const match = (locationText ?? '').match(/\b\d{5}\b/);
  return match ? match[0] : '10001';
}

function cleanProductName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Strip trailing quantity/unit suffixes before sending to a store search API. */
function cleanSearchTerm(itemName: string): string {
  return itemName
    .replace(/\s+\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .trim();
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function storeSearchUrl(storeName: string, itemName: string): string {
  const q = encodeURIComponent(itemName);
  const s = storeName.toLowerCase();
  if (s.includes('walmart')) return `https://www.walmart.com/search?q=${q}`;
  if (s.includes('kroger')) return `https://www.kroger.com/search?query=${q}`;
  if (s.includes('fred meyer')) return `https://www.fredmeyer.com/search?query=${q}`;
  if (s.includes('ralphs')) return `https://www.ralphs.com/search?query=${q}`;
  if (s.includes('target')) return `https://www.target.com/s?searchTerm=${q}`;
  if (s.includes('safeway')) return `https://www.safeway.com/shop/search-results.html?q=${q}`;
  if (s.includes('costco')) return `https://www.costco.com/CatalogSearch?keyword=${q}`;
  if (s.includes('whole foods')) return `https://www.wholefoodsmarket.com/search?text=${q}`;
  if (s.includes('amazon')) return `https://www.amazon.com/s?k=${q}`;
  return `https://www.google.com/search?q=${encodeURIComponent(itemName + ' ' + storeName + ' grocery price')}`;
}
