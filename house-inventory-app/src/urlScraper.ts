import { AppSettings, ReceiptLineCandidate } from './types';
import { inferCategory } from './parser';

export type FetchReceiptResult = {
  text: string;
  candidates?: ReceiptLineCandidate[];
  storeName?: string;
  purchaseDate?: string;
};

export async function fetchReceiptFromUrl(url: string, settings: AppSettings): Promise<FetchReceiptResult> {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('No URL provided.');

  if (isWalmartReceiptUrl(trimmed)) {
    return fetchWalmartReceipt(trimmed);
  }

  if (settings.activeUrlScraper === 'firecrawl' && settings.firecrawlKey) {
    const text = await fetchWithFirecrawl(trimmed, settings.firecrawlKey);
    return { text };
  }
  const text = await fetchWithJina(trimmed);
  return { text };
}

function isWalmartReceiptUrl(url: string): boolean {
  return url.includes('w-mt.co/g/') || url.includes('walmart.com/orders/');
}

async function fetchWalmartReceipt(url: string): Promise<FetchReceiptResult> {
  const html = await fetchWithCorsProxy(url);
  return parseWalmartOrderHtml(html);
}

async function fetchWithCorsProxy(url: string): Promise<string> {
  // Try direct fetch first — works in native app contexts
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text.includes('__NEXT_DATA__')) return text;
    }
  } catch {
    // fall through to CORS proxy
  }

  // CORS proxy — required in browser (Expo web) environment
  const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  const resp = await fetch(proxyUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!resp.ok) {
    throw new Error(
      `Could not fetch Walmart receipt (HTTP ${resp.status}). The link may have expired or require login.`,
    );
  }
  return resp.text();
}

function parseWalmartOrderHtml(html: string): FetchReceiptResult {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error('Could not find order data in Walmart page. The link may have expired.');
  }

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('Could not parse Walmart order data. The page format may have changed.');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const order = (data as any)?.props?.pageProps?.initialData?.data?.order;
  if (!order) {
    throw new Error('No order data found. The Walmart receipt link may have expired or require login.');
  }

  const candidates: ReceiptLineCandidate[] = [];
  for (const key of Object.keys(order)) {
    if (!key.startsWith('groups_')) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groups: unknown[] = Array.isArray(order[key]) ? (order[key] as any[]) : [];
    for (const group of groups) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: unknown[] = Array.isArray((group as any)?.items) ? (group as any).items : [];
      for (const item of items) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawName: string = (item as any)?.productInfo?.name ?? '';
        if (!rawName.trim()) continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const qty = Number((item as any)?.quantity) || 1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const linePriceValue = (item as any)?.priceInfo?.linePrice?.value;
        const totalPrice = typeof linePriceValue === 'number' ? linePriceValue : undefined;
        const unitPrice = totalPrice !== undefined && qty > 0 ? Math.round((totalPrice / qty) * 100) / 100 : undefined;
        const name = cleanWalmartName(rawName);

        candidates.push({
          id: `walmart_${Date.now()}_${candidates.length}`,
          rawLine: rawName,
          suggestedName: name,
          category: inferCategory(name),
          quantity: qty,
          unitPrice,
          totalPrice,
          reviewStatus: 'auto_matched',
          trackItem: true,
        });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error('No items found in this Walmart order. The link may have expired.');
  }

  // Extract optional metadata
  const storeName: string =
    order?.fulfillmentStore?.name ??
    order?.storeInfo?.name ??
    order?.store?.name ??
    'Walmart';

  const rawDate: string | undefined =
    order?.orderPlacedDate ??
    order?.orderDate ??
    order?.placedDate ??
    order?.createdDate ??
    undefined;

  let purchaseDate: string | undefined;
  if (rawDate) {
    try {
      purchaseDate = new Date(rawDate).toISOString().slice(0, 10);
    } catch {
      purchaseDate = undefined;
    }
  }

  const text = candidates.map((c) => `${c.suggestedName} x${c.quantity}`).join('\n');
  return { text, candidates, storeName, purchaseDate };
}

function cleanWalmartName(name: string): string {
  // Take only the part before the first comma — cuts verbose Walmart descriptions
  // e.g. "Great Value Large White Eggs, 18 Count" → "Great Value Large White Eggs"
  let clean = name.split(',')[0].trim();
  // Strip leading "Fresh" qualifier
  clean = clean.replace(/^Fresh\s+/i, '');
  // Strip trailing unit/pack descriptors that are not part of the product name
  clean = clean.replace(/\s+(Each|Single|Bunch|Pack|Bag|Ct|Count)$/i, '');
  return clean;
}

async function fetchWithJina(url: string): Promise<string> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const resp = await fetch(jinaUrl, {
    headers: {
      Accept: 'text/plain',
      'X-Return-Format': 'text',
    },
  });
  if (!resp.ok) {
    throw new Error(`Jina Reader returned HTTP ${resp.status}. Try a different URL or paste text manually.`);
  }
  const text = await resp.text();
  if (!text.trim()) throw new Error('No content could be extracted from this URL.');
  return text;
}

async function fetchWithFirecrawl(url: string, apiKey: string): Promise<string> {
  const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, formats: ['markdown'] }),
  });
  if (!resp.ok) throw new Error(`Firecrawl returned HTTP ${resp.status}. Check your API key.`);
  const data = await resp.json();
  const markdown: string = data.data?.markdown ?? data.markdown ?? '';
  if (!markdown.trim()) throw new Error('Firecrawl returned no content for this URL.');
  return markdown;
}
