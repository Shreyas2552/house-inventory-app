/**
 * Probe Walmart search page structure and Kroger API shape.
 * Run: node test-walmart-search.mjs
 */

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function fetchHtml(url) {
  // try direct
  try {
    const r = await fetch(url, { headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html' } });
    if (r.ok) { const t = await r.text(); if (t.includes('__NEXT_DATA__')) return t; }
  } catch {}
  // proxy
  const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
    headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__');
  return JSON.parse(m[1]);
}

function dig(obj, ...path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

async function probeWalmartSearch(query) {
  console.log(`\n=== Walmart search: "${query}" ===`);
  const html = await fetchHtml(`https://www.walmart.com/search?q=${encodeURIComponent(query)}`);
  const data = extractNextData(html);
  console.log('  HTML size:', html.length);

  // Try several known paths
  const searchResult =
    dig(data, 'props', 'pageProps', 'initialData', 'searchResult') ||
    dig(data, 'props', 'pageProps', 'searchResult');

  if (!searchResult) {
    console.log('  Known path not found. Top-level keys:', Object.keys(data?.props?.pageProps ?? {}));
    return;
  }

  const stacks = searchResult?.itemStacks ?? [];
  console.log('  itemStacks count:', stacks.length);

  let itemCount = 0;
  for (const stack of stacks) {
    const items = stack?.items ?? [];
    for (const item of items.slice(0, 3)) {
      itemCount++;
      const price =
        item?.price ??
        item?.priceInfo?.currentPrice?.price ??
        item?.priceInfo?.priceRange?.minPrice;
      const name = item?.name ?? item?.title ?? '?';
      const avail = item?.availabilityStatus ?? item?.fulfillmentStatus ?? '?';
      const url = item?.canonicalUrl ?? '';
      console.log(`  [${itemCount}] ${String(name).slice(0, 60)}`);
      console.log(`       price=$${price}  avail=${avail}  url=${String(url).slice(0, 50)}`);
    }
    if (items.length > 3) console.log(`  ...and ${items.length - 3} more in this stack`);
  }
  if (itemCount === 0) console.log('  WARNING: 0 items found. Dump itemStacks[0] sample:', JSON.stringify(stacks[0])?.slice(0, 400));
}

async function probeKrogerToken(clientId, clientSecret) {
  if (!clientId || !clientSecret) { console.log('\n=== Kroger: skipped (no keys) ==='); return; }
  console.log('\n=== Kroger OAuth token ===');
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch('https://api.kroger.com/v1/connect/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=product.compact',
  });
  console.log('  Status:', r.status);
  if (!r.ok) { console.log('  Body:', (await r.text()).slice(0, 300)); return; }
  const d = await r.json();
  console.log('  token_type:', d.token_type, '  expires_in:', d.expires_in);
  return d.access_token;
}

// run
await probeWalmartSearch('organic milk');
await probeWalmartSearch('chicken breast');

const KROGER_ID = process.env.KROGER_ID ?? '';
const KROGER_SECRET = process.env.KROGER_SECRET ?? '';
await probeKrogerToken(KROGER_ID, KROGER_SECRET);

console.log('\nDone.');
