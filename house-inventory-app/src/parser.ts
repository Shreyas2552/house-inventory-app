import { Category, ReceiptLineCandidate } from './types';

// ── Store detection ──────────────────────────────────────────────────────────

type StoreFormat = 'walmart' | 'costco' | 'target' | 'generic';

function detectStore(rawText: string): StoreFormat {
  if (/WAL[\*\-]?MART|WALMART/i.test(rawText)) return 'walmart';
  if (/COSTCO\s+WHOLESALE/i.test(rawText)) return 'costco';
  if (/TARGET\s+STORE|TARGET\s+#/i.test(rawText)) return 'target';
  return 'generic';
}

// ── Non-product line filters ─────────────────────────────────────────────────

const NON_PRODUCT_PATTERNS = [
  // Totals / payment
  /\bsubtotal\b/i,
  /^\s*\btax\b/i,
  /^\s*\btotal\b/i,
  /\bchange\s+due\b/i,
  /\btender\b/i,
  /\bbalance\b/i,
  /\bpaid\b/i,
  /\bref\s*#/i,
  // Payment methods
  /\bvisa\b|\bmastercard\b|\bamex\b|\bdiscover\b|\bdebit\b|\bcredit\b|\bebt\b/i,
  /\bcash\b/i,
  // Store names / header
  /^(?!.*\$?\d+\.\d{2}).*(?:wal[\*\-]?mart|whole\s*foods?|costco|target|kroger|aldi|heb|publix|safeway|trader\s*joe)\b/i,
  /\breceipt\b|\bthank\s+you\b|\bplease\s+come\b/i,
  /\bstore\s*#|\bstore\s+id\b|\bregister\b|\bcashier\b|\bassociate\b|\bmanager\b/i,
  /\btc\s*#|\btransaction\s*#|\bauth\s*#|\bapp\s*#|\bref\s*#/i,
  /\bemail\b|\bwww\./i,
  // Phone numbers (various formats including "(214) 555-0123", "214-555-0123", "214.555.0123")
  /\(?\d{3}\)?\s*[-.\s]\d{3}[-.\s]\d{4}/,
  // Street addresses: starts with number(s) then a known street-type word
  /^\d+\s+[A-Za-z][\w\s]*(street|avenue|boulevard|drive|highway|parkway|suite)\b/i,
  // City, State ZIP — require comma to avoid matching "TOMATOES RD  02113…" (barcode)
  /[A-Za-z]{3,},\s*[A-Z]{2}\s+\d{5}/,
  // Bare ZIP code alone on a line
  /^\d{5}(-\d{4})?$/,
  // Rewards / coupons
  /\bcoupon\b|\bdiscount\b|\bsavings?\b|\breward\b|\bmember\b|\bpoints?\b|\bfuel\b/i,
  // Date + time combined
  /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s+\d{1,2}:\d{2}/,
  // Item count line
  /\bitems?\s+sold\b|\bitems?\s+purchased\b/i,
  // Divider lines
  /^[*\-=# ]+$/,
  // Membership/rewards numbers
  /\bmember\s*#|\bmember\s+id\b|\bmember\s+number\b/i,
  // Multi-buy continuation lines (safety net in case merge didn't consume them)
  /^\d+\s+AT\s+\d+\s+FOR\b/i,       // "2 AT 1 FOR 0.93"
  /^\d+\s+FOR\s+\$?[\d.]+\s*$/,     // "3 FOR 5.00"
  // Standalone price-only line (e.g. split "CHANGE DUE" → "0.00" from poor OCR)
  /^\$?\d+\.\d{2}\s*$/,
  // Barcode-first format metadata lines (safety net when not in barcode-first path)
  /\byou\s+saved\b/i,                // "You saved $0.40!"
  /\bless\s+\w{2,}\b/i,             // "$3.99 less MFV_CC"
  /^[\d.]+\s*\*\s*\$?[\d.]+\s*$/,  // "4.52 * $1.99" weight × unit-price
];

// Multi-buy continuation lines — second price is OPTIONAL (OCR may omit it)
const MULTI_BUY_RE = /^(\d+)\s+AT\s+\d+\s+FOR\s+[\d.]+/i;
const N_FOR_RE = /^(\d+)\s+FOR\s+[\d.]+/i;

// 12-digit UPC barcode
const BARCODE_RE = /\b\d{12}\b/;

// ── Barcode-first POS format (Indian grocery / specialty stores) ──────────────
// PLU codes (4–6 digits) or EAN/UPC barcodes (8–13 digits) on their own line
const PLU_LINE_RE = /^\d{4,13}$/;
// PLU/barcode embedded at the start of a line followed by item text
// e.g. "8901777055663Vadilal Amla..." or "102591 Taro Root - LB ..."
const PLU_EMBEDDED_RE = /^(\d{4,13})\s*([A-Za-z].*)$/;
// Dotted column separator common in these receipts: "Item Name ......... $X.XX"
const DOTTED_PRICE_LINE_RE = /\.{2,}\s*\$?(\d+\.\d{2})\s*[^\d]*$/;
// Weight × unit-price: "4.52 * $1.99" or "* $1.99" (leading digits optional when OCR drops them)
const WEIGHT_LINE_RE = /^[\d.]*\s*\*\s*\$?[\d.]+\s*$/;
// Discount metadata — fuzzy match for OCR typos ("saued"/"savved") and member-card labels
const DISCOUNT_META_RE = /you\s+sa\w+|\bless\s+\w|\bMFV\b/i;
// End-of-items sentinel — fuzzy on "saved/saued" for OCR consistency
const RECEIPT_END_RE = /you\s+sa\w+\s+\$[\d.]+\s+in\s+total|^\s*subtotal\s*$|^\s*total\s*[:$]/i;

// Walmart food-exempt / tax flag — single capital letter standing alone
const FLAG_RE = /(?<!\w)[FNOX](?!\w)/g;

// Price at end of line (optional flag before/after)
const PRICE_RE = /\$?(\d+\.\d{2})\s*[FNOX]?\s*$/;

// Thermal POS column-separated format: ALL-CAPS name block at top, prices in separate block
const POS_NAME_RE = /^[A-Z][A-Z0-9\s]{2,24}$/;

// A line that is ONLY a price value (no name, no barcode)
const STANDALONE_PRICE_RE = /^\$?\d+\.\d{2}$/;

// ── POS compound-word lookup (known Walmart/Target truncations) ──────────────

// Maps full all-caps token (or common abbreviation) to readable name
const PRODUCT_EXPANSIONS: Record<string, string> = {
  // Cleaning
  cleanbrushe: 'Cleaning Brush',
  cleanbrush: 'Cleaning Brush',
  dustpanbrus: 'Dustpan Brush',
  dustpanbrush: 'Dustpan Brush',
  dustpanbrushe: 'Dustpan Brush',
  toiletplung: 'Toilet Plunger',
  toiletplunger: 'Toilet Plunger',
  drainopene: 'Drain Opener',
  drainopener: 'Drain Opener',
  trashbag: 'Trash Bag',
  trashbags: 'Trash Bags',
  garbgebag: 'Garbage Bag',
  paprtowel: 'Paper Towel',
  papertowel: 'Paper Towel',
  papertowels: 'Paper Towels',
  // Bath/personal care
  bathsoap: 'Bath Soap',
  bodysoap: 'Body Soap',
  bodywash: 'Body Wash',
  dishsoap: 'Dish Soap',
  handsoap: 'Hand Soap',
  handlotn: 'Hand Lotion',
  handlotion: 'Hand Lotion',
  facewash: 'Face Wash',
  // Home
  airfreshner: 'Air Freshener',
  airfreshnr: 'Air Freshener',
  airfresh: 'Air Freshener',
  lghbulb: 'Light Bulb',
  lightbulb: 'Light Bulb',
  // Food
  organicmilk: 'Organic Milk',
  wholmilk: 'Whole Milk',
};

// ── Suffix expansions: replace whole word when it matches truncated ending ───

// Only expand clearly TRUNCATED tokens (incomplete words).
// Full English words (ORANGE, CHICKEN, TOMATOES) are handled by titleCase — don't expand them.
const SUFFIX_EXPANSIONS: Array<[RegExp, string]> = [
  [/^BRUSHE$/i, 'Brushes'],          // BRUSHE  → Brushes (missing trailing S)
  [/^BRUS$/i, 'Brush'],              // BRUS    → Brush   (missing HE)
  [/^PLUNG$/i, 'Plunger'],           // PLUNG   → Plunger (missing ER)
  [/^OPENE$/i, 'Opener'],            // OPENE   → Opener  (missing R)
  [/^NOOD(LE)?$/i, 'Noodles'],       // NOOD / NOODLE → Noodles
  [/^CHICK$/i, 'Chicken'],           // CHICK   → Chicken (missing EN)
  [/^TOMAT$/i, 'Tomatoes'],          // TOMAT   → Tomatoes (missing OES)
  [/^ORANG$/i, 'Oranges'],           // ORANG   → Oranges (missing E)
  [/^DETERG$/i, 'Detergent'],        // DETERG  → Detergent (missing ENT)
  [/^CONDIT$/i, 'Conditioner'],      // CONDIT  → Conditioner (missing IONER)
  [/^FRESHN?E?R?$/i, 'Freshener'],   // FRESH / FRESHNER → Freshener
  [/^LETTU(C|CE)?$/i, 'Lettuce'],    // LETTU / LETTUC → Lettuce
  [/^BROCCOL?$/i, 'Broccoli'],       // BROCCOL → Broccoli (missing I)
  [/^CUCUMB(ER)?$/i, 'Cucumbers'],   // CUCUMB / CUCUMBER → Cucumbers
  [/^AVOCAD$/i, 'Avocados'],         // AVOCAD  → Avocados (missing O)
];

// ── Common POS abbreviations → readable word ─────────────────────────────────

const COMMON_ALIASES: Record<string, string> = {
  // Sizes / units
  lg: 'Large',
  sm: 'Small',
  xl: 'XL',
  oz: 'Oz',
  lb: 'Lb',
  lbs: 'Lbs',
  ct: 'Count',
  pk: 'Pack',
  pkg: 'Package',
  gal: 'Gallon',
  qt: 'Quart',
  // Foods / ingredients
  mlk: 'Milk',
  org: 'Organic',
  whl: 'Whole',
  gr: 'Green',
  grn: 'Green',
  rd: 'Red',
  yel: 'Yellow',
  chkn: 'Chicken',
  brst: 'Breast',
  bnls: 'Boneless',
  bnna: 'Bananas',
  banana: 'Bananas',
  egg: 'Eggs',
  bns: 'Beans',
  tomato: 'Tomatoes',
  cilantro: 'Cilantro',
  broc: 'Broccoli',
  spnch: 'Spinach',
  // Common brands (abbreviated)
  krkld: 'Kirkland',
  // Misc
  vel: 'Velveeta',
  cb: 'Cheese Block',
};

// ── Category rules ───────────────────────────────────────────────────────────

const CATEGORY_RULES: Array<[Category, RegExp]> = [
  ['Baby', /diaper|wipe|formula|baby|infant|pampers|huggies|enfamil/i],
  [
    'Medicine',
    /tylenol|advil|ibuprofen|acetaminophen|medicine|vitamin|cough|cold|allergy|bandage|pain relief|antacid|pepto|tums|nyquil|dayquil/i,
  ],
  [
    'Cleaning',
    /detergent|laundry|bleach|windex|lysol|clorox|dishwasher|clean|brush|plunger|drain opener|scrub|sponge|mop|broom|dustpan|tide|gain|\bfinish\b|febreze|fabuloso/i,
  ],
  [
    'Personal Care',
    /toothpaste|toothbrush|shampoo|conditioner|deodorant|lotion|body wash|razor|soap|floss|mouthwash|feminine|hygiene|moisturizer|sunscreen/i,
  ],
  [
    'Household',
    /paper towel|toilet paper|trash bag|garbage bag|foil|aluminum|battery|batteries|tissue|napkin|ziploc|plastic bag|food storage|light bulb|air freshener/i,
  ],
];

// ── Name extraction ──────────────────────────────────────────────────────────

function extractProductName(line: string): string {
  // Name is everything before the 12-digit UPC barcode
  const barcodeIdx = line.search(BARCODE_RE);
  if (barcodeIdx > 0) {
    return line.slice(0, barcodeIdx).trim();
  }
  // Fallback: strip price, flag, and any long numeric codes from the end
  return line
    .replace(PRICE_RE, '')
    .replace(/(?<!\w)[FNOX](?!\w)/g, '')
    .replace(/\b\d{5,}\b/g, ' ')
    .trim();
}

export function normalizeRawName(raw: string): string {
  let cleaned = raw
    .replace(/\$?\d+\.\d{2}/g, ' ')
    .replace(/\b\d{12,}\b/g, ' ')
    .replace(/(?<!\w)[FNOX](?!\w)/g, ' ')
    .replace(/[^a-zA-Z0-9% ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip leading Costco/line item numbers ("001 ", "12 ", etc.)
  cleaned = cleaned.replace(/^\d{1,3}\s+/, '');

  const words = cleaned.split(' ').filter(Boolean);

  const expanded = words.map((word) => {
    const key = word.toLowerCase();

    // 1. Direct compound-word product lookup
    if (PRODUCT_EXPANSIONS[key]) return PRODUCT_EXPANSIONS[key];

    // 2. Common abbreviation aliases
    if (COMMON_ALIASES[key]) return COMMON_ALIASES[key];

    // 3. Suffix expansion (replace the entire token)
    for (const [suffix, full] of SUFFIX_EXPANSIONS) {
      if (suffix.test(word)) return full;
    }

    // 4. Default: title-case
    return titleCase(word);
  });

  const result = expanded.join(' ').trim();
  return result || raw.trim();
}

export function inferCategory(name: string): Category {
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(name)) return category;
  }
  return 'Grocery';
}

// ── Abbreviation heuristic ───────────────────────────────────────────────────

function isLikelyAbbreviated(name: string): boolean {
  const words = name.split(' ').filter(Boolean);
  for (const w of words) {
    // Single uppercase char (like "C" in "Cheese Block Rd Vel C")
    if (w.length === 1 && /^[A-Z]$/.test(w)) return true;
    // 2–3 char token with no vowels (abbreviation after title-case)
    if (w.length >= 2 && w.length <= 3 && !/[aeiou]/i.test(w)) return true;
  }
  return false;
}

// ── Multi-buy line merging ───────────────────────────────────────────────────

function mergeMultiBuyLines(lines: string[]): Array<{ text: string; qty: number }> {
  const result: Array<{ text: string; qty: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';

    const multiBuyMatch = next.match(MULTI_BUY_RE) ?? next.match(N_FOR_RE);

    if (multiBuyMatch) {
      const qty = parseInt(multiBuyMatch[1], 10);
      result.push({ text: line, qty });
      i++; // consume the continuation line
    } else {
      result.push({ text: line, qty: 1 });
    }
  }

  return result;
}

// ── Column-separated OCR detection & reassembly ──────────────────────────────

/** Finds the longest contiguous run of ALL-CAPS product-name lines. */
function findNameBlock(lines: string[]): { start: number; end: number } | null {
  let bestStart = -1,
    bestEnd = -1,
    bestLen = 0;
  let curStart = -1,
    curLen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (POS_NAME_RE.test(lines[i])) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
        bestEnd = i + 1;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  return bestLen >= 3 ? { start: bestStart, end: bestEnd } : null;
}

/**
 * Detects the thermal POS column-separated format produced by OCR.space Engine 2:
 * product names appear as a contiguous all-caps block, barcodes+flags in the middle,
 * and prices as a separate block — each receipt column read independently.
 */
function isColumnSeparatedOCR(lines: string[]): boolean {
  const nameBlock = findNameBlock(lines);
  if (!nameBlock) return false;

  const subtotalIdx = lines.findIndex((l) => /\bsubtotal\b/i.test(l));
  const bound = subtotalIdx !== -1 ? subtotalIdx : lines.length;

  let standalonePrices = 0;
  for (let j = nameBlock.end; j < bound; j++) {
    if (STANDALONE_PRICE_RE.test(lines[j])) standalonePrices++;
  }
  return standalonePrices >= 3;
}

/**
 * Reassembles column-separated OCR output into "NAME  PRICE" lines that the
 * standard parser pipeline can handle. Zips name[i] with price[i] and applies
 * any multi-buy continuation qty found in the barcode section.
 */
function reassembleFromColumns(lines: string[]): Array<{ text: string; qty: number }> {
  const nameBlock = findNameBlock(lines);
  if (!nameBlock) return mergeMultiBuyLines(lines);

  const nameLines = lines.slice(nameBlock.start, nameBlock.end);
  const N = nameLines.length;

  const subtotalIdx = lines.findIndex((l) => /\bsubtotal\b/i.test(l));
  const bound = subtotalIdx !== -1 ? subtotalIdx : lines.length;

  // Scan from after name block to SUBTOTAL: count barcodes, find multi-buy
  let multiBuyNameIdx = -1;
  let multiBuyQty = 1;
  let barcodeCount = 0;
  for (let j = nameBlock.end; j < bound; j++) {
    if (BARCODE_RE.test(lines[j])) barcodeCount++;
    const mMatch = lines[j].match(MULTI_BUY_RE) ?? lines[j].match(N_FOR_RE);
    if (mMatch) {
      multiBuyQty = parseInt(mMatch[1], 10);
      multiBuyNameIdx = Math.min(barcodeCount - 1, N - 1);
    }
  }

  // Collect the first N standalone price lines after name block, before SUBTOTAL
  const itemPrices: string[] = [];
  for (let j = nameBlock.end; j < bound && itemPrices.length < N; j++) {
    if (STANDALONE_PRICE_RE.test(lines[j])) itemPrices.push(lines[j]);
  }

  // Zip names + prices into assembled lines
  return nameLines.map((name, k) => {
    const price = itemPrices[k] ?? '';
    const text = price ? `${name}  ${price}` : name;
    const qty = k === multiBuyNameIdx ? multiBuyQty : 1;
    return { text, qty };
  });
}

// ── Barcode-first format detection & parsing ─────────────────────────────────

/**
 * Pre-processes OCR lines so that PLU/barcodes are always on their own line.
 * OCR engines sometimes merge the barcode with the item name on the same line:
 *   "8901777055663Vadilal Amla 312g .... $11.37"  →  "8901777055663" + "Vadilal Amla..."
 *   "102591 Taro Root - LB ......... $7.21"       →  "102591" + "Taro Root..."
 * This lets the state machine reliably detect item block starts.
 */
function normalizeBarcodeLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    // Already a pure PLU line — keep as is
    if (PLU_LINE_RE.test(line)) {
      result.push(line);
      continue;
    }
    // Embedded PLU: 4–13 digits immediately followed by a letter-starting name
    const m = line.match(PLU_EMBEDDED_RE);
    if (m) {
      result.push(m[1]);         // PLU on its own line
      result.push(m[2].trim()); // rest of line (name ± price)
    } else {
      result.push(line);
    }
  }
  return result;
}

/**
 * Returns true when the normalized receipt has 3+ standalone PLU/barcode lines.
 * Detection runs after normalizeBarcodeLines so embedded barcodes are counted.
 */
function isBarcodeFirstFormat(lines: string[]): boolean {
  let count = 0;
  for (const line of lines) {
    if (PLU_LINE_RE.test(line)) count++;
    if (count >= 3) return true;
  }
  return false;
}

/**
 * Parses barcode-first POS receipts using a state machine.
 *
 * State transitions:
 *   idle  →[PLU line]→  in_name  →[price line]→  after_price  →[PLU line]→  in_name
 *                        in_name  →[name cont.]→  in_name (accumulate)
 *                       after_price →[discount/weight]→ after_price (skip)
 *
 * Each item block:
 *   PLU/barcode line (own line, pure digits)
 *   Zero or more name-continuation lines
 *   Name + dotted price line  ← emits candidate
 *   Optional: "You saved $X!" / "$X less MFV_CC" / "X.XX * $Y.YY" (skipped)
 */
function parseBarcodeFirstFormat(lines: string[]): ReceiptLineCandidate[] {
  // v2-fix: orphan handler uses hasPriceAtEnd (not DOTTED_PRICE_LINE_RE only)
  type State = 'idle' | 'in_name' | 'after_price';
  let state: State = 'idle';
  const candidates: ReceiptLineCandidate[] = [];
  let nameBuffer: string[] = [];

  const emitItem = (priceLine: string) => {
    // Strip trailing OCR garbage chars (e.g. "l" mis-read from "!" after price)
    const cleanPriceLine = priceLine.replace(/(\d{2})\s*[^\d\s.]+\s*$/, '$1').trimEnd();
    // Extract price — try dotted separator first, then price at end, then any price in line
    const priceMatch =
      cleanPriceLine.match(DOTTED_PRICE_LINE_RE) ??
      cleanPriceLine.match(/\$?(\d+\.\d{2})\s*$/) ??
      cleanPriceLine.match(/\$?(\d+\.\d{2})/);
    const totalPrice = priceMatch ? Number(priceMatch[1]) : undefined;

    // Extract name portion: strip dotted separator + price
    const nameFromPriceLine = cleanPriceLine
      .replace(/\.{2,}.*$/, '')
      .replace(/\$?\d+\.\d{2}\s*[^\d]*$/, '')
      .replace(/-\s*$/, '')
      .trim();

    const parts = [...nameBuffer];
    if (nameFromPriceLine.length > 1) parts.push(nameFromPriceLine);
    const rawName = parts.join(' ').replace(/\s*-\s*$/, '').trim();

    if (!rawName || rawName.length < 2) return;
    const suggestedName = normalizeRawName(rawName);
    if (!suggestedName || suggestedName.length < 2) return;

    candidates.push({
      id: `candidate_${Date.now()}_${candidates.length}`,
      rawLine: [...nameBuffer, priceLine].join(' | '),
      suggestedName,
      category: inferCategory(suggestedName),
      quantity: 1,
      unitPrice: undefined,
      totalPrice,
      reviewStatus: suggestedName.length < 4 ? 'needs_review' : 'auto_matched',
      trackItem: true,
    });
  };

  for (const line of lines) {
    // End of items section
    if (RECEIPT_END_RE.test(line)) break;

    const isPlu = PLU_LINE_RE.test(line);
    const isDiscount = DISCOUNT_META_RE.test(line);
    const isWeight = WEIGHT_LINE_RE.test(line);
    // Strip trailing OCR artifacts (single non-digit char after price, e.g. "l" → "!")
    const lineClean = line.replace(/(\d{2})\s*[^\d\s.,$]+\s*$/, '$1').trimEnd();
    // A price line has a dollar amount at the end and is not a discount/weight line
    const hasPriceAtEnd =
      (DOTTED_PRICE_LINE_RE.test(line) || PRICE_RE.test(line) ||
       DOTTED_PRICE_LINE_RE.test(lineClean) || PRICE_RE.test(lineClean)) &&
      !isDiscount && !isWeight;

    if (isPlu) {
      nameBuffer = [];
      state = 'in_name';
      continue;
    }

    if (state === 'in_name') {
      if (isDiscount || isWeight) continue;
      if (hasPriceAtEnd) {
        emitItem(line);
        state = 'after_price';
        continue;
      }
      // Name continuation — strip trailing dash (split name across lines)
      const part = line.replace(/-\s*$/, '').trim();
      if (part.length > 1) nameBuffer.push(part);
      continue;
    }

    // in after_price or idle: skip noise, but rescue items whose PLU was missed
    // (e.g. a 2-digit PLU like "20" before Curry Leaves that PLU_LINE_RE can't detect).
    // A dotted-separator price line always means a real item — emit it directly.
    if (isDiscount || isWeight || /^\d{1,3}$/.test(line)) continue;
    if (hasPriceAtEnd) {
      nameBuffer = [];
      emitItem(line);
      state = 'after_price';
    }
  }

  return combineCandidates(candidates);
}

// ── Main parse function ──────────────────────────────────────────────────────

export function parseReceiptText(rawText: string): ReceiptLineCandidate[] {
  const store = detectStore(rawText);

  // 1. Split and trim — keep lines longer than 1 char
  const rawLines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1);

  // 1b. Normalize: split any PLU/barcode embedded at the start of an item line so
  //     that the state machine always sees PLU on its own line.
  const allLines = normalizeBarcodeLines(rawLines);

  // 2a. Barcode-first format: PLU/barcode on its own line, name on next line(s),
  //     price on a dotted separator line. Common in Indian grocery / specialty stores.
  if (isBarcodeFirstFormat(allLines)) {
    return parseBarcodeFirstFormat(allLines);
  }

  // 2b. Detect column-separated thermal POS format (OCR.space Engine 2 reads names,
  //     barcodes, and prices as separate column blocks). Reassemble into "NAME PRICE"
  //     lines; otherwise use normal multi-buy merge.
  const mergedLines = isColumnSeparatedOCR(allLines)
    ? reassembleFromColumns(allLines)
    : mergeMultiBuyLines(allLines);

  // 3. Filter obvious non-product lines (headers, totals, payment, etc.)
  //    Multi-buy patterns are also in NON_PRODUCT_PATTERNS as a safety net
  //    in case a continuation line was not consumed by the merge step.
  const productLines = mergedLines.filter(
    ({ text }) => !NON_PRODUCT_PATTERNS.some((pattern) => pattern.test(text)),
  );

  // 4. For structured store formats require a price or barcode per line;
  //    for generic receipts require at least a price.
  const validLines = productLines.filter(({ text }) => {
    if (store === 'walmart' || store === 'costco') {
      return PRICE_RE.test(text) || BARCODE_RE.test(text);
    }
    return PRICE_RE.test(text);
  });

  // 5. Build candidates — skip anything that normalises to an empty name
  const candidates: ReceiptLineCandidate[] = validLines.flatMap(({ text, qty }, index) => {
    const rawName =
      store === 'walmart' || store === 'costco' ? extractProductName(text) : text;

    const suggestedName = normalizeRawName(rawName);

    // Drop lines that produce no readable name (pure price, barcode-only, etc.)
    if (!suggestedName || suggestedName.length < 2) return [];

    const prices = extractPrices(text);
    const explicitQty = extractQuantity(text);
    const quantity = qty > 1 ? qty : explicitQty;

    const needsReview =
      suggestedName.length < 4 ||
      isLikelyAbbreviated(suggestedName) ||
      words(suggestedName).every((w) => w.length <= 2);

    return [
      {
        id: `candidate_${Date.now()}_${index}`,
        rawLine: text,
        suggestedName,
        category: inferCategory(suggestedName),
        quantity,
        unitPrice: prices.length > 1 ? prices[0] : undefined,
        totalPrice: prices.length > 0 ? prices[prices.length - 1] : undefined,
        reviewStatus: needsReview ? 'needs_review' : 'auto_matched',
        trackItem: true,
      } satisfies ReceiptLineCandidate,
    ];
  });

  return combineCandidates(candidates);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function words(s: string): string[] {
  return s.split(' ').filter(Boolean);
}

function extractQuantity(line: string): number {
  const explicit = line.match(/\b(?:qty|quantity)\s*[:x]?\s*(\d+)/i);
  if (explicit) return Number(explicit[1]);
  const multiplier = line.match(/\b(\d+)\s*x\b/i) ?? line.match(/\bx\s*(\d+)\b/i);
  if (multiplier) return Number(multiplier[1]);
  return 1;
}

function extractPrices(line: string): number[] {
  return Array.from(line.matchAll(/\$?(\d+\.\d{2})/g)).map((m) => Number(m[1]));
}

function combineCandidates(candidates: ReceiptLineCandidate[]): ReceiptLineCandidate[] {
  const combined = new Map<string, ReceiptLineCandidate>();

  for (const candidate of candidates) {
    const key = candidate.suggestedName.toLowerCase();
    const existing = combined.get(key);
    if (!existing) {
      combined.set(key, candidate);
      continue;
    }
    combined.set(key, {
      ...existing,
      quantity: existing.quantity + candidate.quantity,
      rawLine: `${existing.rawLine}\n${candidate.rawLine}`,
      totalPrice:
        existing.totalPrice !== undefined || candidate.totalPrice !== undefined
          ? (existing.totalPrice ?? 0) + (candidate.totalPrice ?? 0)
          : undefined,
    });
  }

  return Array.from(combined.values());
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
