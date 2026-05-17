import { inferCategory } from './parser';
import { Category, ReceiptLineCandidate } from './types';

// Includes speech-recognition homophones: "for"=4, "to/too"=2, "ate"=8, "won"=1, "free/tree"=3
const WORD_TO_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, won: 1,
  two: 2, to: 2, too: 2,
  three: 3, free: 3, tree: 3,
  four: 4, for: 4, fore: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8, ate: 8,
  nine: 9,
  ten: 10, eleven: 11,
  twelve: 12, dozen: 12, couple: 2, few: 3, half: 1,
};

// Words too ambiguous to strip as a LEADING quantity (they appear in item names)
// They ARE still valid as trailing quantities where context is unambiguous
const LEADING_BLACKLIST = new Set(['a', 'an', 'to', 'too', 'for', 'free', 'tree', 'won', 'half']);

// Words never useful as trailing quantities either
const TRAILING_EXCLUSIONS = new Set(['a', 'an']);

const UNIT_RE = /^(gallons?|gal|bottles?|cans?|boxes?|bags?|packs?|packages?|pkgs?|lbs?|pounds?|ounces?|oz|kgs?|grams?|gm?|quarts?|qt|liters?|litres?|lt?|cups?|bunches?|heads?|rolls?|tubes?|bars?|jars?|loaves?|loaf|cartons?|containers?|pieces?|pcs?|items?)$/i;

let _idCounter = 0;
function nextId(): string {
  return `voice_${Date.now()}_${_idCounter++}`;
}

export function parseSpeechToItems(transcript: string): ReceiptLineCandidate[] {
  const rawSegments = transcript
    .split(/[,;]|\band\b|\bthen\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const segments: Array<{ text: string; impliedQty?: number }> = [];

  for (const seg of rawSegments) {
    // "<name> <N> x <M>" → two merged items: name×N + x×M
    // e.g. "cilantro 3 x 20" → ["cilantro"(implied qty 3), "x 20"]
    // Fires only when both sides of "x" are digits, ruling out "3 x large eggs"
    const xMergeMatch = seg.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s+x\s+(\d+(?:\.\d+)?)$/i);
    if (xMergeMatch) {
      const beforeName = xMergeMatch[1].trim();
      const beforeQty = parseFloat(xMergeMatch[2]);
      const afterQty = parseFloat(xMergeMatch[3]);
      if (beforeName && beforeQty > 0 && afterQty > 0) {
        segments.push({ text: beforeName, impliedQty: beforeQty });
        segments.push({ text: 'x', impliedQty: afterQty });
        continue;
      }
    }

    // "for" mid-phrase where after-part contains a digit → "for" = misheard "4"
    // e.g. "banana for cilantro 5" → ["banana"(implied qty 4), "cilantro 5"]
    const forMatch = seg.match(/^(.+?)\bfor\b(.+)$/i);
    if (forMatch) {
      const before = forMatch[1].trim();
      const after = forMatch[2].trim();
      if (before && after && /\d/.test(after)) {
        segments.push({ text: before, impliedQty: 4 });
        segments.push({ text: after });
        continue;
      }
    }
    segments.push({ text: seg });
  }

  return segments
    .map(({ text, impliedQty }) => parseSingleItem(text, impliedQty))
    .filter((c): c is ReceiptLineCandidate => c !== null);
}

function parseSingleItem(raw: string, impliedQty?: number): ReceiptLineCandidate | null {
  const tokens = raw.trim().split(/\s+/);
  if (tokens.length === 0) return null;

  let quantity = 1;
  let quantityFound = false;
  let rest = [...tokens];

  // Handle fused alphanumeric tokens: "X5" → qty=5, name="X"
  // Happens when SR merges item name and qty without space
  if (rest.length === 1) {
    const fused = rest[0].match(/^([a-zA-Z]{1,5})(\d{1,3})$/);
    if (fused && parseInt(fused[2]) > 0) {
      quantity = parseInt(fused[2]);
      quantityFound = true;
      rest = [fused[1]];
    }
  }

  if (!quantityFound) {
    // Leading digit or word-number (blacklisted homophones not allowed here)
    const first = rest[0].toLowerCase().replace(/[^a-z0-9.]/g, '');
    const numericVal = parseFloat(first);
    if (!isNaN(numericVal) && numericVal > 0) {
      quantity = numericVal;
      quantityFound = true;
      rest = rest.slice(1);
    } else if (WORD_TO_NUM[first] !== undefined && !LEADING_BLACKLIST.has(first)) {
      quantity = WORD_TO_NUM[first];
      quantityFound = true;
      rest = rest.slice(1);
    }
  }

  // Optional unit word (e.g. "gallons", "bottles")
  if (rest.length > 1 && UNIT_RE.test(rest[0])) {
    rest = rest.slice(1);
  }

  // Optional "of" after unit
  if (rest[0]?.toLowerCase() === 'of') {
    rest = rest.slice(1);
  }

  // Trailing token = quantity when no leading qty found
  // Handles digits ("cilantro 5") AND word-numbers ("peanut oil one" → qty 1)
  if (!quantityFound && rest.length > 1) {
    const lastToken = rest[rest.length - 1].toLowerCase();
    const trailingNum = parseFloat(lastToken);
    if (!isNaN(trailingNum) && trailingNum > 0) {
      quantity = trailingNum;
      quantityFound = true;
      rest = rest.slice(0, -1);
    } else if (WORD_TO_NUM[lastToken] !== undefined && !TRAILING_EXCLUSIONS.has(lastToken)) {
      quantity = WORD_TO_NUM[lastToken];
      quantityFound = true;
      rest = rest.slice(0, -1);
    }
  }

  // Implied qty from "for"-split (e.g. before-segment of "banana for cilantro 5")
  if (!quantityFound && impliedQty !== undefined) {
    quantity = impliedQty;
  }

  const name = rest.join(' ').trim();
  if (!name) return null;

  const suggestedName = titleCase(name);
  const category = inferCategory(suggestedName) as Category;

  return {
    id: nextId(),
    rawLine: raw,
    suggestedName,
    category,
    quantity,
    reviewStatus: 'needs_review',
    trackItem: true,
  };
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
