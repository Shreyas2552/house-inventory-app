/**
 * Live OCR test: reads the actual Walmart receipt PNG, calls OCR.space,
 * then runs the parser logic on the real OCR output so we can see exactly
 * what the app will produce.
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import FormData from 'form-data';
import fetch from 'node-fetch';

const globalNpmRoot = 'C:/Users/accor/AppData/Roaming/npm/node_modules';
const require = createRequire(import.meta.url);

// ── 1. Read PNG as base64 ─────────────────────────────────────────────────────
const PNG_PATH = 'C:/Users/accor/Downloads/image (1).png';
const base64 = readFileSync(PNG_PATH).toString('base64');
const mimeType = 'image/png';
const API_KEY = 'helloworld';

console.log('PNG loaded:', PNG_PATH);
console.log('Calling OCR.space API (Engine 2)...\n');

// ── 2. Call OCR.space ─────────────────────────────────────────────────────────
let ocrText = '';
try {
  const body = new FormData();
  body.append('apikey', API_KEY);
  body.append('language', 'eng');
  body.append('isOverlayRequired', 'false');
  body.append('scale', 'true');
  body.append('OCREngine', '2');
  body.append('base64Image', `data:${mimeType};base64,${base64}`);

  const resp = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body });
  const data = await resp.json();

  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(', ') : data.ErrorMessage;
    console.error('OCR API error:', msg);
    process.exit(1);
  }

  ocrText = (data.ParsedResults ?? []).map(r => r.ParsedText ?? '').join('\n').trim();
} catch (err) {
  console.error('Network/parse error:', err.message);
  process.exit(1);
}

console.log('═'.repeat(60));
console.log('RAW OCR OUTPUT:');
console.log('═'.repeat(60));
console.log(ocrText);
console.log('═'.repeat(60));
console.log(`\nLine count from OCR: ${ocrText.split(/\r?\n/).filter(l => l.trim().length > 0).length}`);

// ── 3. Run through parser logic (JS port of key parts) ───────────────────────

const BARCODE_RE = /\b\d{12}\b/;
const PRICE_RE = /\$?(\d+\.\d{2})\s*[FNOX]?\s*$/;
const MULTI_BUY_RE = /^(\d+)\s+AT\s+\d+\s+FOR\s+[\d.]+/i;
const N_FOR_RE = /^(\d+)\s+FOR\s+[\d.]+/i;
const POS_NAME_RE = /^[A-Z][A-Z0-9\s]{2,24}$/;
const STANDALONE_PRICE_RE = /^\$?\d+\.\d{2}$/;

const NON_PRODUCT_PATTERNS = [
  /\bsubtotal\b/i, /\btax\b/i, /\btotal\b/i, /\bchange\s+due\b/i, /\btender\b/i,
  /\bbalance\b/i, /\bpaid\b/i, /\bref\s*#/i,
  /\bvisa\b|\bmastercard\b|\bamex\b|\bdiscover\b|\bdebit\b|\bcredit\b|\bebt\b/i,
  /\bcash\b/i,
  /\bwal[\*\-]?mart\b|\bwhole\s*foods?\b|\bcostco\b|\btarget\b|\bkroger\b|\baldi\b|\bheb\b|\bpublix\b|\bsafeway\b|\btrader\s*joe/i,
  /\breceipt\b|\bthank\s+you\b|\bplease\s+come\b/i,
  /\bstore\s*#|\bstore\s+id\b|\bregister\b|\bcashier\b|\bassociate\b|\bmanager\b/i,
  /\btc\s*#|\btransaction\s*#|\bauth\s*#|\bapp\s*#|\bref\s*#/i,
  /\bemail\b|\bwww\./i,
  /\(?\d{3}\)?\s*[-.\s]\d{3}[-.\s]\d{4}/,
  /^\d+\s+[A-Za-z][\w\s]*(street|avenue|boulevard|drive|highway|parkway|suite)\b/i,
  /[A-Za-z]{3,},\s*[A-Z]{2}\s+\d{5}/,
  /^\d{5}(-\d{4})?$/,
  /\bcoupon\b|\bdiscount\b|\bsavings?\b|\breward\b|\bmember\b|\bpoints?\b|\bfuel\b/i,
  /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s+\d{1,2}:\d{2}/,
  /\bitems?\s+sold\b|\bitems?\s+purchased\b/i,
  /^[*\-=# ]+$/,
  /\bmember\s*#|\bmember\s+id\b|\bmember\s+number\b/i,
  /^\d+\s+AT\s+\d+\s+FOR\b/i,
  /^\d+\s+FOR\s+\$?[\d.]+\s*$/,
  /^\$?\d+\.\d{2}\s*$/,
  // Walmart-specific header fields
  /\bop#|\bte#|\btr#|\bst#\b/i,
  /save\s+money/i,
];

function mergeMultiBuyLines(lines) {
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    const m = next.match(MULTI_BUY_RE) ?? next.match(N_FOR_RE);
    if (m) {
      result.push({ text: line, qty: parseInt(m[1]) });
      i++;
    } else {
      result.push({ text: line, qty: 1 });
    }
  }
  return result;
}

function findNameBlock(lines) {
  let bestStart = -1, bestEnd = -1, bestLen = 0;
  let curStart = -1, curLen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (POS_NAME_RE.test(lines[i])) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; bestEnd = i + 1; }
    } else { curStart = -1; curLen = 0; }
  }
  return bestLen >= 3 ? { start: bestStart, end: bestEnd } : null;
}

function isColumnSeparatedOCR(lines) {
  const nb = findNameBlock(lines);
  if (!nb) return false;
  const subtotalIdx = lines.findIndex(l => /\bsubtotal\b/i.test(l));
  const bound = subtotalIdx !== -1 ? subtotalIdx : lines.length;
  let standalonePrices = 0;
  for (let j = nb.end; j < bound; j++) {
    if (STANDALONE_PRICE_RE.test(lines[j])) standalonePrices++;
  }
  return standalonePrices >= 3;
}

function reassembleFromColumns(lines) {
  const nb = findNameBlock(lines);
  if (!nb) return mergeMultiBuyLines(lines);
  const nameLines = lines.slice(nb.start, nb.end);
  const N = nameLines.length;

  const subtotalIdx = lines.findIndex(l => /\bsubtotal\b/i.test(l));
  const bound = subtotalIdx !== -1 ? subtotalIdx : lines.length;

  let multiBuyNameIdx = -1, multiBuyQty = 1, barcodeCount = 0;
  for (let j = nb.end; j < bound; j++) {
    if (BARCODE_RE.test(lines[j])) barcodeCount++;
    const mMatch = lines[j].match(MULTI_BUY_RE) ?? lines[j].match(N_FOR_RE);
    if (mMatch) {
      multiBuyQty = parseInt(mMatch[1]);
      multiBuyNameIdx = Math.min(barcodeCount - 1, N - 1);
    }
  }

  const itemPrices = [];
  for (let j = nb.end; j < bound && itemPrices.length < N; j++) {
    if (STANDALONE_PRICE_RE.test(lines[j])) itemPrices.push(lines[j]);
  }

  return nameLines.map((name, k) => {
    const price = itemPrices[k] ?? '';
    const text = price ? `${name}  ${price}` : name;
    const qty = k === multiBuyNameIdx ? multiBuyQty : 1;
    return { text, qty };
  });
}

function extractProductName(line) {
  const idx = line.search(BARCODE_RE);
  if (idx > 0) return line.slice(0, idx).trim();
  return line.replace(PRICE_RE, '').replace(/(?<!\w)[FNOX](?!\w)/g, '').replace(/\b\d{5,}\b/g, ' ').trim();
}

function extractPrices(line) {
  return Array.from(line.matchAll(/\$?(\d+\.\d{2})/g)).map(m => Number(m[1]));
}

function extractQuantity(line) {
  const e = line.match(/\b(?:qty|quantity)\s*[:x]?\s*(\d+)/i);
  if (e) return Number(e[1]);
  const m = line.match(/\b(\d+)\s*x\b/i) ?? line.match(/\bx\s*(\d+)\b/i);
  if (m) return Number(m[1]);
  return 1;
}

// ── Parse ─────────────────────────────────────────────────────────────────────
const allLines = ocrText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 2);

const columnSeparated = isColumnSeparatedOCR(allLines);
console.log(`\nColumn-separated OCR detected: ${columnSeparated}`);
const merged = columnSeparated ? reassembleFromColumns(allLines) : mergeMultiBuyLines(allLines);
const filtered = merged.filter(({ text }) => !NON_PRODUCT_PATTERNS.some(p => p.test(text)));
const valid = filtered.filter(({ text }) => PRICE_RE.test(text) || BARCODE_RE.test(text));

const dropped = merged.filter(({ text }) => NON_PRODUCT_PATTERNS.some(p => p.test(text)));
const noPriceLine = filtered.filter(({ text }) => !PRICE_RE.test(text) && !BARCODE_RE.test(text));

console.log('\n' + '─'.repeat(60));
console.log('ITEMS THAT PASSED ALL FILTERS:');
console.log('─'.repeat(60));
valid.forEach(({ text, qty }, i) => {
  const name = extractProductName(text);
  const prices = extractPrices(text);
  const explicitQty = extractQuantity(text);
  const quantity = qty > 1 ? qty : explicitQty;
  console.log(`  ${i + 1}. [qty=${quantity}] name="${name}" price=${prices.at(-1) ?? 'N/A'}`);
  if (text !== name) console.log(`       raw: "${text}"`);
});

console.log('\n' + '─'.repeat(60));
console.log(`LINES FILTERED OUT (${dropped.length}):`);
console.log('─'.repeat(60));
dropped.slice(0, 20).forEach(({ text }) => console.log(`  - "${text}"`));

if (noPriceLine.length > 0) {
  console.log('\n' + '─'.repeat(60));
  console.log(`PASSED KEYWORD FILTER BUT DROPPED (no price/barcode) (${noPriceLine.length}):`);
  console.log('─'.repeat(60));
  noPriceLine.forEach(({ text }) => console.log(`  ? "${text}"`));
}

console.log('\n' + '─'.repeat(60));
console.log(`SUMMARY: ${valid.length} items parsed from real OCR output`);
console.log('─'.repeat(60));
