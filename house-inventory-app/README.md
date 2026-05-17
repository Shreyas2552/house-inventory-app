# House Inventory

Android-first personal inventory app for groceries and daily essentials. This is a local-only MVP prototype intended to be built as a personal APK.

## What is implemented

- Local SQLite storage for products, aliases, inventory, receipts, restock items, and stores.
- Manual item entry with categories for Grocery, Baby, Medicine, Cleaning, Personal Care, and Household.
- **Voice add** — tap “🎤 Voice add” on the Inventory tab, speak item names and quantities (“3 gallons of milk, two boxes of Cheerios”), review and edit before saving. Uses Web Speech API (Chrome/Edge on desktop).
- Receipt image OCR using a configurable OCR.space API key.
- Receipt text import with multi-format parsing, quantity summing, category inference, review, correction, ignore, and alias saving.
- Multi-store receipt parser validated across Walmart, Costco, Safeway, Kroger, Fred Meyer, Whole Foods, Indian grocery, and Asian grocery formats.
- Text receipt document import. PDF files are recognized, with screenshot OCR or copied text recommended for the current prototype.
- Inventory view with search and category filtering.
- Daily check-in screen that shows all inventory items.
- Not Present / Restock list with “do not buy next” cancellation.
- Daily 8 PM local notification scheduling.
- Local JSON backup export and restore.
- Store preference list with Costco, Walmart, Target, Safeway, Fred Meyer, and Amazon.
- Automatic nearby grocery store discovery using GPS or a configured home zip/address and OpenStreetMap Overpass data.
- Amazon is represented separately as an online/delivery option.
- Search settings for radius, max auto-expand radius, and optimization mode: distance, cost, or balanced.
- First price-comparison screen that opens store-specific searches for active restock items.

## Current limitations

- OCR requires an `EXPO_PUBLIC_OCR_SPACE_API_KEY` environment variable before running or building. Without it, paste receipt text manually.
- Price comparison opens store-specific searches, but exact prices and availability still require store APIs or scraping access.
- This is local-only. Use Settings → Export local backup before changing phones.

## Run locally

```bash
npm install
npm run start
```

Then scan the Expo QR code with Expo Go, or connect an Android device and run:

```bash
npm run android
```

## Type-check and diagnostics

```bash
npm run typecheck
npm run doctor
```

## Build an APK

If you want receipt image OCR, set the OCR API key before running or building:

```bash
export EXPO_PUBLIC_OCR_SPACE_API_KEY="your-api-key"
```

Install and log into EAS:

```bash
npm install -g eas-cli
eas login
```

Build the preview APK:

```bash
npm run build:apk
```

EAS will return a download link for the APK. Install that APK on your Android phone.

## Recommended next implementation steps

1. Replace cloud OCR with on-device Google ML Kit if you want offline OCR.
2. Add real price and availability integrations for priority stores.
3. Add receipt PDF text extraction.
4. Add trip-level optimization that groups items by store.
5. Build and test APK on a real Android device.
