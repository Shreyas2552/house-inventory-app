import axios from 'axios';
import { locationCache } from '../cache';
import { StorePriceResult } from '../types';

// Albertsons/Safeway internal API — discovered from network traffic
const SAFEWAY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://www.safeway.com',
  Referer: 'https://www.safeway.com/',
};

async function getNearestSafewayStore(zip: string): Promise<string> {
  const cacheKey = `safeway_store_${zip}`;
  const cached = locationCache.get(cacheKey);
  if (cached) return cached;

  try {
    // Albertsons store locator API (server-side, no CORS issue)
    const resp = await axios.get(
      `https://www.safeway.com/abs/pub/xapi/pgm/mapcenter/podstoredata/v1/en/details?storeId=0&latitude=37.77&longitude=-122.41&radius=25&pageSize=3&q=${zip}`,
      { headers: SAFEWAY_HEADERS, timeout: 8000 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stores: any[] = resp.data?.data?.stores ?? resp.data?.stores ?? [];
    if (stores.length > 0) {
      const id = String(stores[0].storeId ?? stores[0].id ?? '3132');
      locationCache.set(cacheKey, id);
      return id;
    }
  } catch {
    // fall through to default
  }

  return '3132'; // national fallback
}

export async function searchSafeway(itemName: string, zip: string): Promise<StorePriceResult[]> {
  const storeId = await getNearestSafewayStore(zip);
  const query = cleanSearchTerm(itemName);

  // Try multiple Safeway/Albertsons API endpoints (they change periodically)
  const endpoints = [
    `https://www.safeway.com/abs/pub/xapi/productsearch/v1?q=${encodeURIComponent(query)}&rows=5&start=0&search-type=keyword&storeid=${storeId}&featured=false&url=https%3A%2F%2Fwww.safeway.com&pageurl=https%3A%2F%2Fwww.safeway.com%2Fshop%2Fsearch-results.html&banner=safeway&channel=instore&experience=grocery&userId=anonymous`,
    `https://www.albertsons.com/abs/pub/xapi/productsearch/v2?q=${encodeURIComponent(query)}&rows=5&start=0&storeid=${storeId}`,
  ];

  for (const url of endpoints) {
    try {
      const resp = await axios.get(url, {
        headers: {
          ...SAFEWAY_HEADERS,
          'ocp-apim-subscription-key': '5e790ef3f6614e19b701d65c29da63cc',
        },
        timeout: 8000,
      });

      if (resp.status !== 200) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const products: any[] =
        resp.data?.results?.[0]?.products ??
        resp.data?.catalog?.response?.docs ??
        resp.data?.response?.docs ?? [];

      if (!products.length) continue;

      const now = new Date().toISOString();
      const results: StorePriceResult[] = [];

      for (const p of products.slice(0, 5)) {
        const name: string = p?.name ?? p?.description ?? '';
        if (!name.trim()) continue;

        const price: number =
          typeof p?.currentPrice === 'number' ? p.currentPrice
            : typeof p?.priceAmount === 'number' ? p.priceAmount
            : NaN;

        if (!Number.isFinite(price) || price <= 0) continue;

        results.push({
          id: `safeway_${Date.now()}_${results.length}`,
          itemSearched: itemName,
          storeName: 'Safeway',
          storeChain: 'safeway',
          productName: name.trim().slice(0, 80),
          price,
          inStock: p?.inStock !== false,
          productUrl: `https://www.safeway.com/shop/search-results.html?q=${encodeURIComponent(query)}`,
          searchedAt: now,
          dataSource: 'scrape',
        });
      }

      if (results.length > 0) return results;
    } catch {
      continue;
    }
  }

  return [];
}

function cleanSearchTerm(name: string): string {
  return name
    .replace(/\s+\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .trim();
}
