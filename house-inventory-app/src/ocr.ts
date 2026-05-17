import { AppSettings } from './types';

type OcrSpaceParsedResult = {
  ParsedText?: string;
  ErrorMessage?: string;
};

type OcrSpaceResponse = {
  ParsedResults?: OcrSpaceParsedResult[];
  IsErroredOnProcessing?: boolean;
  ErrorMessage?: string | string[];
};

/**
 * Extracts text from a receipt image URI.
 * Routes to Gemini Vision or OCR.space based on the active OCR service in settings.
 */
export async function extractTextFromImageUri(uri: string, settings?: AppSettings): Promise<string> {
  if (settings?.activeOcrService === 'gemini' && settings.geminiKey) {
    return extractTextWithGemini(uri, settings.geminiKey);
  }

  const apiKey =
    settings?.ocrSpaceKey ||
    process.env.EXPO_PUBLIC_OCR_SPACE_API_KEY ||
    'helloworld';

  return extractTextWithOcrSpace(uri, apiKey);
}

async function extractTextWithOcrSpace(uri: string, apiKey: string): Promise<string> {
  const { base64, mimeType } = await uriToBase64(uri);

  const body = new FormData();
  body.append('apikey', apiKey);
  body.append('language', 'eng');
  body.append('isOverlayRequired', 'false');
  body.append('scale', 'true');
  body.append('OCREngine', '2');
  body.append('base64Image', `data:${mimeType};base64,${base64}`);

  const response = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    body,
  });

  if (!response.ok) {
    throw new Error(`OCR request failed with status ${response.status}`);
  }

  const data = (await response.json()) as OcrSpaceResponse;

  if (data.IsErroredOnProcessing) {
    const message = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(', ') : data.ErrorMessage;
    throw new Error(message || 'OCR processing failed.');
  }

  const parsedText = data.ParsedResults?.map((r) => r.ParsedText ?? '')
    .join('\n')
    .trim();

  if (!parsedText) {
    throw new Error('OCR did not find readable text in the image.');
  }

  return parsedText;
}

/**
 * Uses Gemini Vision (gemini-1.5-flash) to extract text from a receipt image.
 * Free tier: 15 RPM, 1M tokens/day — much higher quality than OCR.space for complex receipts.
 */
async function extractTextWithGemini(uri: string, apiKey: string): Promise<string> {
  const { base64, mimeType } = await uriToBase64(uri);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inlineData: { mimeType, data: base64 } },
              {
                text: 'Extract all text from this receipt image exactly as it appears. Preserve line breaks and the original layout — do not summarise, translate, or add commentary. Return only the raw receipt text.',
              },
            ],
          },
        ],
        generationConfig: { temperature: 0.1 },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini Vision error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  if (!text.trim()) {
    throw new Error('Gemini Vision did not extract any text from the image.');
  }

  return text;
}

// On web, the image picker returns a blob: URL that FileSystem cannot read.
// Use fetch + FileReader instead, which works for both blob: and data: URLs.
// On native, the URI is a file:// path — read it with expo-file-system.
async function uriToBase64(uri: string): Promise<{ base64: string; mimeType: string }> {
  if (uri.startsWith('blob:') || uri.startsWith('data:')) {
    const resp = await fetch(uri);
    const blob = await resp.blob();
    const mimeType = blob.type || guessTypeFromUri(uri);
    const base64 = await blobToBase64(blob);
    return { base64, mimeType };
  }

  // Native path
  const { readAsStringAsync, EncodingType } = await import('expo-file-system/legacy');
  const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  return { base64, mimeType: guessTypeFromUri(uri) };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1] ?? '');
    };
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(blob);
  });
}

function guessTypeFromUri(uri: string): string {
  const path = uri.toLowerCase().split('?')[0];
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}
