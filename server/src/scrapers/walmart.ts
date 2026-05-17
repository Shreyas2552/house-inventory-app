import axios from 'axios';
import { StorePriceResult } from '../types';

export async function searchWalmart(itemName: string): Promise<StorePriceResult[]> {
  const query = cleanSearchTerm(itemName);

  // Walmart blocks all automated requests (PerimeterX/DataDome).
  // Try a quick fetch — if blocked, we fail fast so the caller falls back to link-only.
  const url = `https://www.walmart.com/search?q=${encodeURIComponent(query)}&cat_id=0`;

  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 8000,
      validateStatus: (s) => s < 500,
    });

    if (resp.status !== 200) return [];
    const html: string = typeof resp.data === 'string' ? resp.data : '';
    return parseWalmartHtml(html, itemName);
  } catch {
    return [];
  }
}

function parseWalmartHtml(html: string, itemSearched: string): StorePriceResult[] {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];

  let data: unknown;
  try { data = JSON.parse(match[1]); } catch { return []; }

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
      if (!name.trim()) continue;

      const price: number =
        typeof item?.price === 'number' ? item.price
          : typeof item?.priceInfo?.currentPrice?.price === 'number' ? item.priceInfo.currentPrice.price
          : typeof item?.priceInfo?.priceRange?.minPrice === 'number' ? item.priceInfo.priceRange.minPrice
          : NaN;

      if (!Number.isFinite(price) || price <= 0) continue;

      const canonicalUrl: string = item?.canonicalUrl ?? '';
      results.push({
        id: `walmart_${Date.now()}_${results.length}`,
        itemSearched,
        storeName: 'Walmart',
        storeChain: 'walmart',
        productName: name.trim().slice(0, 80),
        price,
        inStock: item?.availabilityStatus !== 'OUT_OF_STOCK',
        productUrl: canonicalUrl
          ? `https://www.walmart.com${canonicalUrl.split('?')[0]}`
          : `https://www.walmart.com/search?q=${encodeURIComponent(itemSearched)}`,
        searchedAt: now,
        dataSource: 'scrape',
      });

      if (results.length >= 5) return results;
    }
  }
  return results;
}

function cleanSearchTerm(name: string): string {
  return name
    .replace(/\s+\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .trim();
}
