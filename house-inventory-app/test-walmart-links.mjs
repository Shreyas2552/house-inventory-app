/**
 * Validates Walmart receipt parsing against the 3 real links.
 * Run: node test-walmart-links.mjs
 */

const LINKS = [
  'https://w-mt.co/g/m126QP',
  'https://w-mt.co/g/lGW3GY',
  'https://w-mt.co/g/ltOsV5',
];

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function fetchWithCorsProxy(url) {
  // Try direct first
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text.includes('__NEXT_DATA__')) {
        console.log('  [direct fetch succeeded]');
        return text;
      }
    }
  } catch (e) {
    console.log(`  [direct fetch failed: ${e.message}]`);
  }

  // CORS proxy fallback
  const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  console.log(`  [trying corsproxy.io...]`);
  const resp = await fetch(proxyUrl, {
    headers: {
      'User-Agent': MOBILE_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from corsproxy.io`);
  return resp.text();
}

function cleanWalmartName(name) {
  let clean = name.split(',')[0].trim();
  clean = clean.replace(/^Fresh\s+/i, '');
  clean = clean.replace(/\s+(Each|Single|Bunch|Pack|Bag|Ct|Count)$/i, '');
  return clean;
}

function parseWalmartOrderHtml(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No __NEXT_DATA__ script tag found');

  const data = JSON.parse(match[1]);
  const order = data?.props?.pageProps?.initialData?.data?.order;
  if (!order) throw new Error('No order object in pageProps');

  const items = [];
  for (const key of Object.keys(order)) {
    if (!key.startsWith('groups_')) continue;
    const groups = Array.isArray(order[key]) ? order[key] : [];
    for (const group of groups) {
      const groupItems = Array.isArray(group?.items) ? group.items : [];
      for (const item of groupItems) {
        const rawName = item?.productInfo?.name ?? '';
        if (!rawName.trim()) continue;
        const qty = Number(item?.quantity) || 1;
        const totalPrice = item?.priceInfo?.linePrice?.value ?? null;
        items.push({
          name: cleanWalmartName(rawName),
          rawName,
          qty,
          totalPrice,
        });
      }
    }
  }

  const storeName =
    order?.fulfillmentStore?.name ??
    order?.storeInfo?.name ??
    order?.store?.name ??
    'Walmart';

  const rawDate =
    order?.orderPlacedDate ??
    order?.orderDate ??
    order?.placedDate ??
    order?.createdDate ??
    null;

  const purchaseDate = rawDate ? new Date(rawDate).toISOString().slice(0, 10) : null;

  return { items, storeName, purchaseDate };
}

async function testLink(url, index) {
  console.log(`\n=== Link ${index + 1}: ${url} ===`);
  try {
    const html = await fetchWithCorsProxy(url);
    console.log(`  HTML size: ${html.length} bytes`);

    const { items, storeName, purchaseDate } = parseWalmartOrderHtml(html);
    console.log(`  Store: ${storeName}`);
    console.log(`  Date:  ${purchaseDate ?? '(not found)'}`);
    console.log(`  Items (${items.length}):`);
    for (const item of items) {
      const price = item.totalPrice != null ? ` — $${item.totalPrice.toFixed(2)}` : '';
      console.log(`    x${item.qty}  ${item.name}${price}`);
    }
    if (items.length === 0) console.log('  WARNING: 0 items parsed!');
    return true;
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    return false;
  }
}

let passed = 0;
for (let i = 0; i < LINKS.length; i++) {
  if (await testLink(LINKS[i], i)) passed++;
}

console.log(`\n--- Result: ${passed}/${LINKS.length} links parsed successfully ---`);
