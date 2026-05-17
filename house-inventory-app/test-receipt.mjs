/**
 * Comprehensive receipt parser test — simulates real OCR output for
 * Walmart, Costco, and generic (Kroger) receipts.
 */
import { createRequire } from 'module';
import path from 'path';

const globalNpmRoot = 'C:/Users/accor/AppData/Roaming/npm/node_modules';
const require = createRequire(import.meta.url);

let puppeteer;
try {
  puppeteer = require(path.join(globalNpmRoot, '@modelcontextprotocol/server-puppeteer/node_modules/puppeteer'));
} catch {
  puppeteer = require(path.join(globalNpmRoot, 'puppeteer'));
}

const APP_URL = 'http://localhost:8082';
const WAIT = (ms) => new Promise(r => setTimeout(r, ms));

async function clickText(page, text) {
  await page.evaluate((t) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() === t) { node.parentElement.click(); return true; }
    }
    return false;
  }, text);
}

async function clearAndType(page, selector, text) {
  const el = await page.$(selector);
  if (!el) return false;
  await el.click({ clickCount: 3 });
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await WAIT(100);
  await el.type(text, { delay: 0 });
  return true;
}

// Get the suggestedName values from receipt candidates.
// Each candidate card has two TextInputs: the name field (non-numeric value)
// and the quantity field (numeric value "1", "2", etc.)
// We identify name fields as inputs whose value is NOT a pure integer.
async function getCardNames(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[value]'))
      .map(el => el.value.trim())
      .filter(v => v.length > 0 && !/^\d+$/.test(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v))
      // also skip store/date inputs at top of receipt form
      .filter(v => !['Walmart', 'Costco', 'Kroger'].some(s => v.startsWith(s)));
  });
}

// Count how many "Tracking this item" text nodes exist (one per tracked candidate)
async function getTrackingCount(page) {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let count = 0, node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() === 'Tracking this item') count++;
    }
    return count;
  });
}

async function testReceipt(page, label, storeValue, receiptText, prefix) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log('─'.repeat(60));

  // Go to Receipt tab
  await clickText(page, 'Receipt');
  await WAIT(600);

  // Fill store name
  await clearAndType(page, 'input[placeholder="Store name"]', storeValue);
  await WAIT(100);

  // Fill receipt text
  const ok = await clearAndType(page, 'textarea', receiptText);
  if (!ok) { console.log('  [WARN] No textarea found'); return []; }
  await WAIT(400);

  // Parse
  await clickText(page, 'Parse receipt');
  await WAIT(1800);
  await page.screenshot({ path: `${prefix}-parsed.png` });

  const names = await getCardNames(page);
  const tracking = await getTrackingCount(page);

  console.log(`  Candidates: ${names.length}  |  Tracking: ${tracking}`);
  names.forEach((n, i) => console.log(`    ${i + 1}. "${n}"`));

  return names;
}

// ─── Receipt samples (realistic OCR.space output) ────────────────────────────

const WALMART = `WAL*MART #5284
1800 MARKET BLVD
DALLAS TX 75201
MANAGER: JOHN SMITH
(214) 555-0123

OKRA PKG         003338312234 F   1.47
CB RD VEL C      004101000000 F   3.48
CILANTRO         073296060000 F   0.93
 2 AT 1 FOR 0.93   1.86
GR BEANS         028800000001 F   1.17
TOMATOES RD      021130000001 F   1.98
LIMES 5CT        033383000001 F   0.98
ORG SPINACH      025000000001 F   4.48
CHICKEN BRST     026000000001    8.47
EGGS LG 12CT     007874200000 F   3.98
CLEANBRUSHE      071452000001     3.97
TOILETPLUNG      071452000002     8.97
DUSTPANBRUS      071452000003     5.97
DRAIN OPENE      034449000001     6.97
TIDE PODS        037000000001    19.97

SUBTOTAL                        72.66
TAX 1  7.5000%                   4.49
****   TOTAL   ****             77.15
DEBIT TEND                      77.15
CHANGE DUE                       0.00

TC# 1234 5678 9012 3456 7890
ITEMS SOLD   15
THANK YOU FOR SHOPPING AT WAL*MART`;

const COSTCO = `COSTCO WHOLESALE #0117
3900 WESTHEIMER RD
HOUSTON TX 77027
(713) 555-0199
MEMBER: JOHN DOE  123456789012

001 KIRKLAND MILK 2GAL   8.99
002 ORGANIC EGGS 24CT    7.49
003 TIDE PODS 120CT     19.99
004 BABY WIPES 900CT    24.99
005 PAPER TOWELS 12PK   21.99
006 CHICKEN THIGHS 6LB  14.97
007 KIRKLAND BUTTER 2LB  9.79
008 GREEK YOGURT 3LB     8.49

SUBTOTAL  116.70
TAX         5.83
****TOTAL  122.53
VISA     122.53

ITEMS SOLD: 8
THANK YOU`;

const KROGER = `KROGER #0547
1234 MAIN STREET
AUSTIN TX 78701
(512) 555-0100

P ORGANICS BANANA      0.67 F
WHOLE MILK GAL         4.29 F
BREAD WHEAT            2.99 F
ORANGE JUICE 64OZ      4.49 F
CHEDDAR CHEESE 2LB     7.99 F
PASTA PENNE            1.49 F
MARINARA SAUCE         3.99 F
GROUND BEEF 93%        6.99
SHAMPOO PANTENE        5.99
DISH SOAP DAWN         3.49

SUBTOTAL      42.38
TAX            1.27
TOTAL         43.65
VISA DEBIT    43.65

FUEL POINTS EARNED: 43
THANK YOU FOR SHOPPING KROGER`;

// ─── Run ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 932 });

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));

  console.log(`Navigating to ${APP_URL}...`);
  await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await WAIT(2000);

  const walmart = await testReceipt(page, 'Walmart grocery + household', 'Walmart', WALMART, 'rt-walmart');
  const costco  = await testReceipt(page, 'Costco receipt', 'Costco', COSTCO, 'rt-costco');
  const kroger  = await testReceipt(page, 'Kroger (generic)', 'Kroger', KROGER, 'rt-kroger');

  // ── Validation ─────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('VALIDATION');
  console.log('='.repeat(60));

  const expectedWalmart = [
    { name: 'Okra', in: walmart },
    { name: 'Cilantro', in: walmart },
    { name: 'Green Beans', in: walmart },
    { name: 'Tomatoes', in: walmart },
    { name: 'Limes', in: walmart },
    { name: 'Spinach', in: walmart },
    { name: 'Chicken', in: walmart },
    { name: 'Eggs', in: walmart },
    { name: 'Cleaning Brush', in: walmart },
    { name: 'Toilet Plunger', in: walmart },
    { name: 'Dustpan Brush', in: walmart },
    { name: 'Drain Opener', in: walmart },
    { name: 'Tide Pods', in: walmart },
  ];

  const expectedCostco = [
    { name: 'Kirkland Milk', in: costco },
    { name: 'Organic Eggs', in: costco },
    { name: 'Tide Pods', in: costco },
    { name: 'Baby Wipes', in: costco },
    { name: 'Paper Towels', in: costco },
    { name: 'Chicken Thighs', in: costco },
  ];

  const expectedKroger = [
    { name: 'Banana', in: kroger },
    { name: 'Milk', in: kroger },
    { name: 'Bread', in: kroger },
    { name: 'Orange Juice', in: kroger },
    { name: 'Cheese', in: kroger },
    { name: 'Pasta', in: kroger },
    { name: 'Beef', in: kroger },
    { name: 'Shampoo', in: kroger },
    { name: 'Dish Soap', in: kroger },
  ];

  // Ensure no junk lines appear in Kroger result
  const junkInKroger = ['Main Street', '78701', '555-0100', 'Austin', 'Fuel Points'];

  console.log('\nWalmart expected items:');
  let pass = 0, fail = 0;
  for (const { name, in: list } of expectedWalmart) {
    const found = list.some(p => p.toLowerCase().includes(name.toLowerCase()));
    console.log(`  ${found ? '✓' : '✗'} ${name}`);
    found ? pass++ : fail++;
  }

  console.log('\nCostco expected items:');
  for (const { name, in: list } of expectedCostco) {
    const found = list.some(p => p.toLowerCase().includes(name.toLowerCase()));
    console.log(`  ${found ? '✓' : '✗'} ${name}`);
    found ? pass++ : fail++;
  }

  console.log('\nKroger expected items:');
  for (const { name, in: list } of expectedKroger) {
    const found = list.some(p => p.toLowerCase().includes(name.toLowerCase()));
    console.log(`  ${found ? '✓' : '✗'} ${name}`);
    found ? pass++ : fail++;
  }

  console.log('\nKroger junk lines (should NOT appear):');
  for (const junk of junkInKroger) {
    const found = kroger.some(p => p.toLowerCase().includes(junk.toLowerCase()));
    console.log(`  ${found ? '✗ FOUND (bug)' : '✓ absent'}: "${junk}"`);
    found ? fail++ : pass++;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SCORE: ${pass} pass / ${fail} fail / ${pass + fail} total`);
  if (errors.length) {
    console.log(`JS errors (${errors.length}):`);
    errors.slice(0, 5).forEach(e => console.log(' ', e.slice(0, 200)));
  } else {
    console.log('Zero JS errors.');
  }

  await browser.close();
}

run().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
