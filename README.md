# House Inventory & Grocery Price Tracker

A React Native (Expo) app that tracks your household inventory, manages restocking lists, and compares grocery prices across multiple stores in real time.

## Features

- **Inventory tracking** — add items manually, via receipt scan (photo/PDF/URL), or voice
- **Smart restock list** — mark items as finished and they move automatically to the restock queue
- **Live price comparison** — searches Kroger/Fred Meyer via official API; links to Walmart, Target, Costco, Whole Foods, and Safeway
- **Brand matching** — flags whether results match your preferred brand or are store-brand alternatives
- **Quantity coverage** — calculates how many units you need to buy based on your restock quantity
- **Backend proxy server** — Node.js/Express server that enables server-side store scraping (bypasses browser CORS restrictions)
- **Instacart API ready** — when you get an Instacart Developer API key, all stores unlock with live prices

## Project Structure

```
house-inventory-app/     React Native / Expo app (runs in browser or on device)
  src/
    App.tsx              Main app — all screens and UI
    priceSearch.ts       Price search logic (tries backend first, falls back to browser)
    db.ts                SQLite database (inventory, settings, receipts)
    types.ts             Shared TypeScript types
    ...

server/                  Node.js/Express backend proxy
  src/
    index.ts             Express app — routes, orchestration, result caching
    scrapers/
      kroger.ts          Kroger official API
      walmart.ts         Walmart (falls back to link-only — PerimeterX blocked)
      safeway.ts         Safeway/Albertsons API attempts
      instacart.ts       Instacart Developer Platform (add your key when approved)
    cache.ts             30-min price cache, 24-hr location cache
    types.ts             Shared server types
```

## Setup

### 1. Frontend (Expo app)

```bash
cd house-inventory-app
npm install
npx expo start --web --port 8090
```

Open http://localhost:8090 in your browser.

### 2. Backend proxy server (optional but recommended)

```bash
cd server
npm install
npm run dev
```

The server runs on http://localhost:3001. When running, the app automatically routes price searches through it for better store coverage.

### 3. API Keys (optional — all have free tiers)

Add these in the app under **Settings**:

| Key | Where to get | What it unlocks |
|-----|-------------|-----------------|
| **Kroger API** | [developer.kroger.com](https://developer.kroger.com) | Live prices from Kroger, Fred Meyer, Ralphs, King Soopers, Harris Teeter |
| **Instacart API** | [instacart.com/developer](https://www.instacart.com/developer) | Live prices from Walmart, Costco, Safeway, Whole Foods, Target (all in one) |
| Gemini | [aistudio.google.com](https://aistudio.google.com) | AI-powered receipt parsing |
| OCR Space | [ocr.space](https://ocr.space) | Receipt image scanning |

> **Note:** Walmart, Target, Costco, Whole Foods, and Safeway block automated price lookups without their API. The app shows clickable links for those stores until you add the Instacart key.

## Tech Stack

- **React Native + Expo** — cross-platform (web, iOS, Android)
- **expo-sqlite** — local database, no account required
- **Node.js + Express + TypeScript** — backend proxy server
- **Kroger Developer API** — official product search API
- **Instacart Developer Platform** — multi-store price API (when approved)
