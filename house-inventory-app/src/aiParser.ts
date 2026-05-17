import { AppSettings, Category, ReceiptLineCandidate } from './types';
import { inferCategory } from './parser';

const SYSTEM_PROMPT =
  'You are a grocery receipt parser. Always return valid JSON arrays only, no markdown fences, no explanation.';

const VOICE_SYSTEM_PROMPT =
  'You are a grocery list speech-recognition corrector. Always return valid JSON arrays only, no markdown fences, no explanation.';

const VOICE_USER_PROMPT = (segments: string[]) =>
  `These are speech-to-text transcriptions of spoken grocery items. The recognizer often makes errors:
- "x" or "X" alone usually means "eggs"
- "for" often means the number 4
- "one" at the end may mean the number 1 OR may be part of "onion"
- "pistol" / "bottle" / "boddle" / "bodal" are likely mishearings of "bottle"
- "stand" after a food word is usually "sauce" (e.g. "tomato stand" → Tomato Sauce)
- "free" = 3, "to"/"too" = 2, "ate" = 8
- A letter fused with digits like "X5" means the letter word (eggs) qty 5
- A single color word with a number like "red 5" likely has a missing noun — guess the most common item (e.g. Red Onion, Red Pepper)
- Two items sometimes merge into one segment: "<name> <N> x <M>" means item1=name qty=N AND item2=eggs qty=M (e.g. "cilantro 3 x 20" → Cilantro qty 3, Eggs qty 20). In this case return TWO objects.

For each segment correct any SR errors and return the most likely grocery item(s).
If a segment contains two merged items, return two objects for that segment.
Return ONLY a JSON array where each object has:
  "name": string (clean title-case grocery item, SR-corrected),
  "quantity": number (default 1),
  "category": one of "Grocery","Baby","Medicine","Cleaning","Personal Care","Household"

Segments (one per spoken phrase):
${segments.map((s, i) => `${i + 1}. "${s}"`).join('\n')}`;

const USER_PROMPT = (text: string) => `Extract all purchased items from this receipt.
Return ONLY a JSON array where each object has:
  "name": string (clean title-case product name),
  "quantity": number (default 1),
  "unitPrice": number or null,
  "totalPrice": number or null,
  "category": one of "Grocery","Baby","Medicine","Cleaning","Personal Care","Household"

Exclude: taxes, subtotals, totals, store headers, payment lines, discounts, coupons.

Receipt:
${text}`;

/**
 * Attempts AI-assisted receipt parsing via the configured service.
 * Returns null if no AI service is configured, so callers can fall back to regex.
 */
export async function parseWithAI(
  text: string,
  settings: AppSettings,
): Promise<ReceiptLineCandidate[] | null> {
  try {
    if (settings.activeAiParser === 'gemini' && settings.geminiKey) {
      return await parseWithGemini(text, settings.geminiKey);
    }
    if (settings.activeAiParser === 'groq' && settings.groqKey) {
      return await parseWithGroq(text, settings.groqKey);
    }
  } catch (err) {
    console.warn('[aiParser] AI parse failed, will fall back to regex:', err);
  }
  return null;
}

/**
 * AI-assisted voice transcript correction. Sends raw SR segments to the configured
 * AI service to fix homophones, garbled words, and merged items.
 * Returns null if no AI service configured, so caller keeps regex results.
 */
export async function parseSpeechWithAI(
  segments: string[],
  settings: AppSettings,
): Promise<ReceiptLineCandidate[] | null> {
  if (segments.length === 0) return null;
  try {
    if (settings.activeAiParser === 'gemini' && settings.geminiKey) {
      return await parseSpeechWithGemini(segments, settings.geminiKey);
    }
    if (settings.activeAiParser === 'groq' && settings.groqKey) {
      return await parseSpeechWithGroq(segments, settings.groqKey);
    }
  } catch (err) {
    console.warn('[aiParser] AI voice correction failed:', err);
  }
  return null;
}

async function parseSpeechWithGemini(segments: string[], apiKey: string): Promise<ReceiptLineCandidate[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: VOICE_USER_PROMPT(segments) }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
        systemInstruction: { parts: [{ text: VOICE_SYSTEM_PROMPT }] },
      }),
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Gemini API error ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return jsonToVoiceCandidate(raw, segments);
}

async function parseSpeechWithGroq(segments: string[], apiKey: string): Promise<ReceiptLineCandidate[]> {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: VOICE_SYSTEM_PROMPT },
        { role: 'user', content: VOICE_USER_PROMPT(segments) },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Groq API error ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  const raw: string = data.choices?.[0]?.message?.content ?? '';
  return jsonToVoiceCandidate(raw, segments);
}

function jsonToVoiceCandidate(raw: string, originalSegments: string[]): ReceiptLineCandidate[] {
  const clean = raw.replace(/```json?\n?/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array in AI response');

  const items: unknown[] = JSON.parse(clean.slice(start, end + 1));

  return items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .filter((item) => typeof item.name === 'string' && item.name.trim().length > 0)
    .map((item, index): ReceiptLineCandidate => ({
      id: `ai_voice_${Date.now()}_${index}`,
      rawLine: originalSegments[index] ?? String(item.name),
      suggestedName: String(item.name).trim(),
      category: isValidCategory(item.category) ? item.category : inferCategory(String(item.name)),
      quantity: Number(item.quantity) || 1,
      reviewStatus: 'auto_matched',
      trackItem: true,
    }));
}

async function parseWithGemini(text: string, apiKey: string): Promise<ReceiptLineCandidate[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: USER_PROMPT(text) }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      }),
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Gemini API error ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return jsonToCandidate(raw);
}

async function parseWithGroq(text: string, apiKey: string): Promise<ReceiptLineCandidate[]> {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT(text) },
      ],
      temperature: 0.1,
      max_tokens: 2048,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Groq API error ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  const raw: string = data.choices?.[0]?.message?.content ?? '';
  return jsonToCandidate(raw);
}

function jsonToCandidate(raw: string): ReceiptLineCandidate[] {
  const clean = raw.replace(/```json?\n?/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array in AI response');

  const items: unknown[] = JSON.parse(clean.slice(start, end + 1));

  return items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .filter((item) => typeof item.name === 'string' && item.name.trim().length > 0)
    .map(
      (item, index): ReceiptLineCandidate => ({
        id: `ai_candidate_${Date.now()}_${index}`,
        rawLine: String(item.name),
        suggestedName: String(item.name).trim(),
        category: isValidCategory(item.category) ? item.category : inferCategory(String(item.name)),
        quantity: Number(item.quantity) || 1,
        unitPrice: typeof item.unitPrice === 'number' ? item.unitPrice : undefined,
        totalPrice: typeof item.totalPrice === 'number' ? item.totalPrice : undefined,
        reviewStatus: 'auto_matched',
        trackItem: true,
      }),
    );
}

const VALID_CATEGORIES: Category[] = ['Grocery', 'Baby', 'Medicine', 'Cleaning', 'Personal Care', 'Household'];

function isValidCategory(value: unknown): value is Category {
  return VALID_CATEGORIES.includes(value as Category);
}
