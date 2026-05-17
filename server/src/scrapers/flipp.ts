import axios from 'axios';
import { StorePriceResult } from '../types';

const FLIPP_URL = 'https://backflipp.wishabi.com/flipp/items/search';

// Known Flipp merchant_id → storeChain mapping
const MERCHANT_CHAIN: Record<number, string> = {
  2175: 'walmart',
  2040: 'target',
  2519: 'costco',
  5667: 'safeway',    // Safeway
  5661: 'albertsons', // Albertsons
  2392: 'fredMeyer',  // Fred Meyer (Kroger family)
  2807: 'qfc',        // QFC (Kroger family)
  2424: 'haggen',
  2906: 'groceryOutlet',
  2353: 'aldi',
  2365: 'acmeMarkets',
  2388: 'stopAndShop',
  2399: 'weisMarkets',
  2404: 'wegmans',
  3106: 'uwajimaya',
};

function storeUrlFor(chain: string, merchantName: string, itemName: string): string {
  const q = encodeURIComponent(itemName);
  switch (chain) {
    case 'walmart':       return `https://www.walmart.com/search?q=${q}`;
    case 'target':        return `https://www.target.com/s?searchTerm=${q}`;
    case 'costco':        return `https://www.costco.com/CatalogSearch?keyword=${q}`;
    case 'safeway':       return `https://www.safeway.com/shop/search-results.html?q=${q}`;
    case 'albertsons':    return `https://www.albertsons.com/shop/search-results.html?q=${q}`;
    case 'fredMeyer':     return `https://www.fredmeyer.com/search?query=${q}`;
    case 'qfc':           return `https://www.qfc.com/search?query=${q}`;
    case 'aldi':          return `https://www.aldi.us/en/products/search/?q=${q}`;
    case 'wegmans':       return `https://www.wegmans.com/search/?q=${q}`;
    case 'stopAndShop':   return `https://stopandshop.com/pages/search-results?query=${q}`;
    default:              return `https://www.google.com/search?q=${encodeURIComponent(merchantName + ' ' + itemName)}`;
  }
}

function cleanSearchTerm(name: string): string {
  return name
    .replace(/\s+\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .trim();
}

// At least one key term must appear as a standalone word in the product name.
// Allows plural/possessive suffix but not "breaded" matching "bread" or "milky" matching "milk".
function isRelevant(productName: string, searchTerm: string): boolean {
  const name = productName.toLowerCase();
  const terms = searchTerm.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  return terms.some((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}(s|'s)?\\b`, 'i').test(name);
  });
}

// Commercial wholesale/non-consumer stores — exclude from results
const EXCLUDED_MERCHANTS = new Set([
  'restaurant depot',
  'sam\'s club',
  'restaurant', // catch-all for restaurant supply names
]);

function isConsumerStore(merchantName: string): boolean {
  const lower = merchantName.toLowerCase();
  return !Array.from(EXCLUDED_MERCHANTS).some((ex) => lower.includes(ex));
}

export async function searchFlipp(itemName: string, zip: string): Promise<StorePriceResult[]> {
  const query = cleanSearchTerm(itemName);

  const resp = await axios.get(FLIPP_URL, {
    params: { locale: 'en-us', q: query, postal_code: zip },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json',
    },
    timeout: 10000,
    decompress: true,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = resp.data?.items ?? (Array.isArray(resp.data) ? resp.data : []);
  const now = new Date().toISOString();
  const results: StorePriceResult[] = [];

  // deduplicate by merchant+name to avoid Flipp showing the same ad multiple times
  const seen = new Set<string>();

  for (const item of items) {
    const price: number = item?.current_price;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;

    const merchantName: string = (item?.merchant_name ?? 'Unknown Store').replace(/\s+/g, ' ').trim();
    if (!isConsumerStore(merchantName)) continue;
    const name: string = (item?.name ?? '').trim();
    if (!name) continue;
    if (!isRelevant(name, itemName)) continue;

    const dedupeKey = `${merchantName}:${name.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const merchantId: number = item?.merchant_id ?? 0;
    const chain = MERCHANT_CHAIN[merchantId] ?? merchantName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const promoPrice: number | undefined = item?.original_price && item.original_price > price ? price : undefined;
    const regularPrice = item?.original_price && item.original_price > price ? item.original_price : price;

    const validTo: string | undefined = item?.valid_to
      ? new Date(item.valid_to).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : undefined;

    results.push({
      id: `flipp_${merchantId}_${Date.now()}_${results.length}`,
      itemSearched: itemName,
      storeName: merchantName,
      storeChain: chain,
      productName: name.slice(0, 80),
      price: regularPrice,
      promoPrice,
      priceUnit: item?.post_price_text ?? undefined,
      inStock: true,
      productUrl: item?.flyer_url ?? storeUrlFor(chain, merchantName, itemName),
      searchedAt: now,
      dataSource: 'api',
      // Embed sale expiry in coverageNote (will be overwritten by annotator if quantity logic kicks in)
      coverageNote: validTo ? `Sale ends ${validTo}` : undefined,
    });

    if (results.length >= 12) break;
  }

  return results;
}
