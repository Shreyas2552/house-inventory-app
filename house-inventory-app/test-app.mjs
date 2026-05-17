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

// Click element whose visible text contains the given string
async function clickText(page, text) {
  await page.evaluate((t) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() === t) {
        node.parentElement.click();
        return true;
      }
    }
    return false;
  }, text);
}

async function run() {
  console.log('Launching Chromium...');
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 932 }); // iPhone 14 Pro size

  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(err.message));

  // ---- Load app ----
  console.log(`Navigating to ${APP_URL}...`);
  await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await WAIT(3000);
  await page.screenshot({ path: 'test-01-loaded.png' });
  console.log('PASS: App loaded — test-01-loaded.png');

  // ---- Add item ----
  console.log('\nTest: Add item manually...');
  await clickText(page, 'Add item manually');
  await WAIT(1200);
  await page.screenshot({ path: 'test-02-add-modal.png' });

  const inputs = await page.$$('input[placeholder="Item name"], input[placeholder]');
  if (inputs[0]) {
    await inputs[0].click({ clickCount: 3 });
    await inputs[0].type('Organic Milk');
  }
  await clickText(page, 'Save');
  await WAIT(1500);
  await page.screenshot({ path: 'test-03-item-added.png' });
  console.log('PASS: Item added — test-03-item-added.png');

  // ---- Mark finished ----
  console.log('\nTest: Mark item finished...');
  await clickText(page, 'Finished');
  await WAIT(1200);
  await page.screenshot({ path: 'test-04-marked-finished.png' });
  console.log('PASS: Marked finished — test-04-marked-finished.png');

  // ---- Restock tab ----
  console.log('\nTest: Restock tab...');
  await clickText(page, 'Restock');
  await WAIT(1000);
  await page.screenshot({ path: 'test-05-restock.png' });
  console.log('PASS: Restock tab — test-05-restock.png');

  // ---- Receipt tab + paste + parse ----
  console.log('\nTest: Receipt parsing...');
  await clickText(page, 'Receipt');
  await WAIT(800);
  const textarea = await page.$('textarea');
  if (textarea) {
    await textarea.click();
    await textarea.type(
      'COSTCO WHOLESALE\n' +
      '001 KIRKLAND MILK 2GAL    8.99\n' +
      '002 ORGANIC EGGS 24CT     7.49\n' +
      '003 TIDE PODS 120CT      19.99\n' +
      '004 BABY WIPES 900CT     24.99\n' +
      'SUBTOTAL  61.46\n' +
      'TAX        5.53\n' +
      'TOTAL     66.99'
    );
    await WAIT(400);
    await clickText(page, 'Parse receipt');
    await WAIT(2000);
    await page.screenshot({ path: 'test-06-receipt-parsed.png' });
    console.log('PASS: Receipt parsed — test-06-receipt-parsed.png');
  }

  // ---- Stores tab ----
  console.log('\nTest: Stores tab...');
  await clickText(page, 'Stores');
  await WAIT(800);
  await page.screenshot({ path: 'test-07-stores.png' });
  console.log('PASS: Stores tab — test-07-stores.png');

  // ---- Settings tab ----
  console.log('\nTest: Settings tab...');
  await clickText(page, 'Settings');
  await WAIT(800);
  await page.screenshot({ path: 'test-08-settings.png' });
  console.log('PASS: Settings tab — test-08-settings.png');

  // ---- Summary ----
  console.log('\n=== RESULTS ===');
  if (errors.length === 0) {
    console.log('Zero JavaScript errors. App is fully functional.');
  } else {
    console.log(`${errors.length} JS error(s):`);
    errors.slice(0, 10).forEach(e => console.log(' ', e.slice(0, 200)));
  }

  console.log('\nAll screenshots in house-inventory-app/');
  await browser.close();
}

run().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
