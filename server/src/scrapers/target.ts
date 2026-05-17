import axios from 'axios';
import { StorePriceResult } from '../types';

const REDSKY_KEY = '9f36aeafbe60771e321a7cc95a78140772ab3e96';

function randomVisitorId(): string {
  // 19-digit numeric visitor ID like Target generates
  return Array.from({ length: 19 }, () => Math.floor(Math.random() * 10)).join('');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = any;

function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function cleanSearchTerm(name: string): string {
  return name
    .replace(/\s+\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .trim();
}

export async function searchTarget(itemName: string, zip: string): Promise<StorePriceResult[]> {
  const query = cleanSearchTerm(itemName);

  const resp = await axios.get(
    'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2',
    {
      params: {
        key: REDSKY_KEY,
        channel: 'WEB',
        count: 8,
        default_purchasability_filter: true,
        include_sponsored: false,
        keyword: query,
        offset: 0,
        page: `/s/${query}`,
        platform: 'desktop',
        pricing_store_id: '1404',
        store_ids: '1404',
        visitor_id: randomVisitorId(),
        zip,
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Origin: 'https://www.target.com',
        Referer: 'https://www.target.com/',
      },
      timeout: 10000,
      // 206 = partial (sponsored ads failed, main data present) — still valid
      validateStatus: (s) => s < 500,
    },
  );

  const products: AnyObj[] = resp.data?.data?.search?.products ?? [];
  const now = new Date().toISOString();
  const results: StorePriceResult[] = [];
  const q = encodeURIComponent(itemName);

  for (const prod of products) {
    const title = decodeHtml(
      prod?.item?.product_description?.title ??
      prod?.parent?.item?.product_description?.title ??
      prod?.item?.primary_brand?.name ?? '',
    );
    if (!title.trim()) continue;

    const price: number =
      prod?.price?.current_retail ??
      prod?.price?.reg_retail ??
      prod?.parent?.price?.current_retail ??
      NaN;

    if (!Number.isFinite(price) || price <= 0) continue;

    const tcin: string = prod?.item?.tcin ?? prod?.parent?.item?.tcin ?? '';
    const productUrl = tcin
      ? `https://www.target.com/p/-/A-${tcin}`
      : `https://www.target.com/s?searchTerm=${q}`;

    results.push({
      id: `target_${Date.now()}_${results.length}`,
      itemSearched: itemName,
      storeName: 'Target',
      storeChain: 'target',
      productName: title.trim().slice(0, 80),
      price,
      inStock: true,
      productUrl,
      searchedAt: now,
      dataSource: 'scrape',
    });

    if (results.length >= 5) break;
  }

  return results;
}
