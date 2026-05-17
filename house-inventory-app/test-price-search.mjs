/**
 * End-to-end test for priceSearch Walmart logic (JS port).
 * Tests filtering of null-name/null-price items.
 * Run: node test-price-search.mjs
 */

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function fetchPageWithProxy(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html' } });
    if (r.ok) { const t = await r.text(); if (t.includes('__NEXT_DATA__')) return t; }
  } catch {}
  const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
    headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function cleanProductName(name) {
  return name.split(',')[0].replace(/\s+/g, ' ').trim().slice(0, 60);
}

function parseWalmartSearchPage(html, itemSearched) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  let data;
  try { data = JSON.parse(match[1]); } catch { return []; }

  const pp = data?.props?.pageProps;
  const searchResult = pp?.initialData?.searchResult ?? pp?.searchResult;
  if (!searchResult) return [];

  const stacks = Array.isArray(searchResult?.itemStacks) ? searchResult.itemStacks : [];
  const results = [];
  const now = new Date().toISOString();

  for (const stack of stacks) {
    const items = Array.isArray(stack?.items) ? stack.items : [];
    for (const item of items) {
      const name = item?.name ?? item?.title ?? '';
      if (!name || typeof name !== 'string' || !name.trim()) continue;

      const price =
        typeof item?.price === 'number' ? item.price :
        typeof item?.priceInfo?.currentPrice?.price === 'number' ? item.priceInfo.currentPrice.price :
        typeof item?.priceInfo?.priceRange?.minPrice === 'number' ? item.priceInfo.priceRange.minPrice :
        NaN;

      if (!Number.isFinite(price) || price <= 0) continue;

      const canonicalUrl = item?.canonicalUrl ?? '';
      results.push({
        id: `walmart_${Date.now()}_${results.length}`,
        itemSearched,
        storeName: 'Walmart',
        productName: cleanProductName(name),
        price,
        inStock: item?.availabilityStatus !== 'OUT_OF_STOCK',
        productUrl: canonicalUrl ? `https://www.walmart.com${canonicalUrl.split('?')[0]}` : null,
        searchedAt: now,
      });
      if (results.length >= 5) return results;
    }
  }
  return results;
}

const QUERIES = [
  'organic milk',
  'chicken breast',
  'green bell pepper',
  'coconut',
  'bread',
];

let totalResults = 0;
for (const q of QUERIES) {
  console.log(`\n--- "${q}" ---`);
  try {
    const html = await fetchPageWithProxy(`https://www.walmart.com/search?q=${encodeURIComponent(q)}&cat_id=0`);
    const results = parseWalmartSearchPage(html, q);
    totalResults += results.length;
    for (const r of results) {
      console.log(`  $${r.price.toFixed(2)}  ${r.productName}`);
    }
    if (results.length === 0) console.log('  WARNING: 0 results!');
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }
}
console.log(`\nTotal results across all queries: ${totalResults}`);
