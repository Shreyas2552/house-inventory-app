# House Inventory App: Software Status and Roadmap

## Current Software Summary

This project is an Android-first Expo React Native prototype for a local-only house inventory management app. It is designed for groceries and daily essentials, including baby products, medicine, cleaning, personal care, and household supplies. Automotive supplies are intentionally out of scope.

The app is not production-ready yet, but it has the main local inventory workflow implemented and can be used as a foundation for an APK build.

## Implemented Features

### App Platform

- Android-first Expo React Native app.
- Configured for personal APK builds through EAS.
- TypeScript-based codebase.
- Local-only architecture with no required cloud account.

### Local Database

- SQLite database using `expo-sqlite`.
- Stores products, aliases, inventory items, receipts, restock items, stores, and app settings.
- Supports local JSON backup and restore.

### Inventory Management

- Manual item creation.
- **Voice add** — "🎤 Voice add" button on Inventory tab triggers Web Speech API (Chrome/Edge on web). Speech is parsed by `src/speechParser.ts` into `ReceiptLineCandidate[]` with number-word handling (one/two/dozen/couple), unit stripping (gallons/cans/boxes/lbs/oz etc.), and comma/"and" splitting. Parsed items appear inline as editable review cards before saving. Requires no extra dependencies.
- Product categories:
  - Grocery
  - Baby
  - Medicine
  - Cleaning
  - Personal Care
  - Household
- Inventory search.
- Category filtering.
- Present and not-present inventory states.
- Mark item as finished.
- Restore item back to present.

### Receipt Import

- Paste receipt text manually.
- Import text documents.
- Receipt image OCR using OCR.Space API (`EXPO_PUBLIC_OCR_SPACE_API_KEY`). End-to-end loop validated across 8 store formats (see Receipt Parsing below).
- Online receipt URL fetch via Jina Reader or Firecrawl.
- AI-assisted parsing via Gemini or Groq (optional, configurable in Settings).
- PDF files are recognized, but direct PDF text extraction is not fully implemented yet.

### Receipt Parsing

Two-path architecture in `src/parser.ts`:

**Barcode-first path** (`isBarcodeFirstFormat()` — fires when ≥ 3 lines are pure digits 4–13 chars): used by Walmart, Costco, Indian grocery, Asian grocery. State machine reads barcode → name buffer → price. Never touches `NON_PRODUCT_PATTERNS`.

**Standard path**: used by Safeway, Kroger, Fred Meyer, Whole Foods. Merges continuation lines, filters `NON_PRODUCT_PATTERNS` (headers/footers), then extracts lines containing a price with `PRICE_RE`.

Both paths:
- Infer category via keyword rules (`inferCategory`).
- Infer quantity from multiplier lines (e.g. `2 @ $3.49`).
- Combine duplicate detected items into one summed quantity.
- Let the user review, edit, and ignore items before saving.
- Save user corrections as product aliases.

**Store-brand fix (NON_PRODUCT_PATTERNS):** the store-name pattern uses a negative lookahead `^(?!.*\$?\d+\.\d{2})` so that lines like `KROGER BREAD WHEAT $2.49` pass through (product) while bare header lines like `KROGER` are dropped. Validated: Kroger 7/7, Safeway 7/7, Walmart 6/6, Costco 4/4, Indian 4/4.

### Daily Check-In

- Daily check-in screen shows all inventory items.
- User can mark items as finished.
- User can mark items as still available.
- Local notification scheduling for daily 8 PM reminder.

### Restock List

- Finished items move to Not Present / Restock list.
- User can mark item as “I have it.”
- User can cancel an item for the next shopping trip using “Do not buy next.”

### Store Discovery

- Seeded preferred stores:
  - Costco
  - Walmart
  - Target
  - Safeway
  - Fred Meyer
  - Amazon
- Amazon is treated separately as online/delivery.
- GPS-based nearby grocery store discovery using OpenStreetMap Overpass.
- Home zip/address fallback for store discovery through geocoding.
- User can hide stores they do not want to use.

### Price Comparison Foundation

- Price comparison tab exists.
- Supports optimization mode setting:
  - Distance
  - Cost
  - Balanced
- Supports search radius and max auto-expand radius settings.
- Generates store-specific search links for active restock items.
- Opens searches for supported stores and local grocery search.

### Backup and Restore

- Export local data to JSON backup.
- Restore from JSON backup.
- Backup includes products, aliases, inventory, receipts, restock items, stores, and settings.

### Validation

- TypeScript validation passes.
- Expo Doctor passes 17/17 checks.
- `npm audit` passes with zero vulnerabilities after dependency overrides.

## Known Limitations

### OCR

- OCR uses OCR.Space via `EXPO_PUBLIC_OCR_SPACE_API_KEY`. The free demo key (`helloworld`) works but is rate-limited and shared.
- OCR is not on-device. Phone photos produce variable quality; synthetic/printed receipts OCR more reliably.
- OCR.space splits wide-gap receipts (name left, price right) into two column blocks. The fix: format receipt content as `NAME $PRICE` on a single line with no gap.
- If no OCR key is configured, users must paste receipt text manually.

### PDF Receipts

- PDF import is recognized.
- Direct PDF text extraction is not implemented yet.
- Current workaround is to copy text from the PDF or use a receipt screenshot OCR path.

### Digital Receipt Scraping

- The app does not automatically log into Amazon, Walmart, Target, Costco, Safeway, Fred Meyer, Gmail, or other accounts.
- Digital receipts currently need copied text, imported text, screenshots, or manual entry.

### Price Comparison

- The app does not yet fetch guaranteed live prices or availability inside the app.
- Current price comparison opens store-specific searches.
- Exact prices need store APIs, partner feeds, or careful web scraping.
- Pickup and delivery availability are not fully integrated.

### Multi-Device Sync

- No cloud sync.
- No family sharing.
- No cross-device real-time updates.
- Backup/export is the current migration path.

### APK Build

- The source is configured for APK builds through EAS.
- The APK itself was not generated in the workspace because Expo/EAS login or local Android SDK access is required.

## Needs To Be Implemented Next

### High Priority

1. **Generate and test APK**
   - Build through EAS using `npm run build:apk`.
   - Install APK on Android phone.
   - Test notification, SQLite persistence, backup/restore, and store discovery on real device.
   - Note: Web Speech API (`window.SpeechRecognition`) is a browser API — voice add will need `@react-native-voice/voice` for the native Android build.

2. **Improve OCR**
   - Decide between OCR.Space cloud OCR and on-device Google ML Kit.
   - Add camera capture flow instead of only image picker.
   - Improve image preprocessing if OCR accuracy is poor.

3. **Improve receipt parsing**
   - Improve quantity parsing for weights, packs, and multi-buy lines.
   - Better detect coupons, returns, and non-product receipt rows.
   - Store-specific parsing for major formats is now covered by the two-path architecture.

4. **PDF receipt text extraction**
   - Add true PDF text extraction.
   - Add fallback OCR for scanned PDF pages.

### Medium Priority

5. **Voice add — native Android support**
   - Current voice add uses `window.SpeechRecognition` (web only).
   - For native APK: integrate `@react-native-voice/voice` and route through the same `parseSpeechToItems()` in `src/speechParser.ts`.

6. **Digital receipt import**
   - Add structured parsers for copied Amazon, Walmart, Target, Costco, Safeway, and Fred Meyer receipt text.
   - Consider email-forwarding or manual `.eml` import later.

6. **Real price comparison**
   - Investigate available APIs or stable sources for store prices.
   - Add price, availability, last checked time, and confidence.
   - Separate in-store results from online/delivery results.

7. **Trip-level optimization**
   - Group restock items by store.
   - Estimate total item cost per store.
   - Estimate distance tradeoff.
   - Show best option by distance, cost, or balanced score.

8. **Store radius auto-expansion**
   - Expand radius when no nearby store results are found.
   - Show the radius used in the result.

### Lower Priority

9. **Household sharing**
   - Add optional cloud sync.
   - Add shared household inventory.
   - Add conflict handling.

10. **Barcode scanning**
   - Scan barcode to add product.
   - Save barcode-to-product mapping.

11. **Usage prediction**
   - Estimate when recurring items may run low.
   - Keep this optional to avoid noisy reminders.

12. **UI polish**
   - Add icons.
   - Add dark mode.
   - Improve navigation with a proper router.
   - Improve empty states and onboarding.

## Build and Run Commands

Install dependencies:

```bash
npm install
```

Run in Expo:

```bash
npm run start
```

Run type-check:

```bash
npm run typecheck
```

Run Expo diagnostics:

```bash
npm run doctor
```

Run security audit:

```bash
npm audit
```

Build Android APK with EAS:

```bash
npm install -g eas-cli
eas login
npm run build:apk
```

## Environment Variables

For OCR support:

```bash
EXPO_PUBLIC_OCR_SPACE_API_KEY=your-api-key
```

If this key is missing, the app still works, but receipt images cannot be OCR-scanned.

## Recommended Immediate Next Step

The best next step is to build and install the APK on a real Android phone, then test the core loop:

1. Add a few items manually.
2. Paste a receipt text sample.
3. Review and save parsed items.
4. Mark items finished.
5. Confirm they appear in the restock list.
6. Export a backup.
7. Enable the 8 PM reminder.
8. Discover nearby stores.
9. Try the price search tab.

After that real-device test, the next engineering focus should be OCR quality and real receipt parsing accuracy.
