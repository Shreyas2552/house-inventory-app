# House Inventory & Grocery Price Tracker

A React Native (Expo) app that tracks your household inventory, manages restocking lists, and compares grocery prices across 20+ stores in real time.

---

## Features

- **Inventory tracking** — add items manually, via receipt scan (photo/PDF/URL), or voice
- **Smart restock list** — mark items as finished and they move automatically to the restock queue
- **Live price comparison** — searches Kroger/QFC/Fred Meyer via official API, Target via RedSky API, and 20+ regional chains via Flipp weekly circulars
- **Brand matching** — flags whether results match your preferred brand or are store-brand alternatives
- **Quantity coverage** — calculates how many units you need to buy based on your restock quantity
- **Backend proxy server** — Node.js/Express server that handles all store requests server-side (bypasses browser CORS restrictions)
- **Instacart API ready** — when you get an Instacart Developer API key, all stores unlock with live prices

---

## How Price Search Works

When you tap **Search prices** on the Restock tab, the app sends your items to the backend proxy server. The server queries three data sources in parallel:

### 1. Kroger Official API
**Stores covered:** Kroger, QFC, Fred Meyer, Ralphs, King Soopers, Harris Teeter, Dillons

- Uses your Kroger Client ID + Secret (configured in Settings) to get an OAuth token
- Looks up the nearest Kroger-family store to your home ZIP code
- Searches that store's live product catalog with real shelf prices
- Returns up to 5 results per item with regular and promo prices

### 2. Flipp Weekly Circulars
**Stores covered:** Safeway, Albertsons, QFC, Fred Meyer, Haggen, Grocery Outlet, ALDI, Stop & Shop, Wegmans, Acme Markets, Weis Markets, Kings Food Markets, C Town, Bravo, H Mart, Lidl, Dollar General, and 20+ more regional chains

- Queries the Flipp/Wishabi aggregator API (`backflipp.wishabi.com`) — the same service that powers the Flipp circular app
- Returns items currently **on sale** in weekly store circulars near your ZIP code
- Each result shows the sale price and the date the sale ends
- Prices are real (from the store's printed weekly ad), not estimated
- Relevance-filtered: only items where the search term appears as a standalone word in the product name are shown
- Commercial wholesale stores (e.g. Restaurant Depot) are excluded automatically

### 3. Target RedSky API
**Stores covered:** Target

- Queries Target's internal product search API (the same endpoint Target's own website uses)
- Returns live shelf prices for up to 5 products per item
- Uses a randomized visitor ID per request to stay within rate limits
- Falls back to a link-only card automatically if Target's API is temporarily rate-limited

### Link-only fallback
Stores that cannot return live prices show a **branded clickable card** instead:
- **Walmart** — bot protection (PerimeterX) blocks automated price lookups
- **Target** — shown as link-only when the RedSky API is rate-limited
- **Costco** — bot protection (Imperva) blocks automated lookups
- **Whole Foods** — owned by Amazon, fully blocked

Tapping a card opens that store's search page directly. An **"Open all"** button opens every link-only store at once.

### Caching
All results are cached for **30 minutes** per item + ZIP code combination. The cache resets automatically when the set of items changes.

---

## Project Structure

```
house-inventory-app/          React Native / Expo app (runs in browser or on device)
  src/
    App.tsx                   Main app — all screens and UI
    priceSearch.ts            Price search logic (tries backend first, falls back to browser)
    db.ts                     SQLite database (inventory, settings, receipts)
    types.ts                  Shared TypeScript types

server/                       Node.js/Express backend proxy
  src/
    index.ts                  Express app — routes, orchestration, result caching
    scrapers/
      kroger.ts               Kroger official API (OAuth + product search)
      target.ts               Target RedSky API (live prices)
      flipp.ts                Flipp weekly circular API (20+ regional chains)
      walmart.ts              Walmart (fast fail — bot protected; falls back to link-only)
      safeway.ts              Safeway/Albertsons API (deprecated endpoints — link-only fallback)
      instacart.ts            Instacart Developer Platform (add your key when approved)
    cache.ts                  30-min price cache, 24-hr location cache
    types.ts                  Shared server types
```

---

## Setup

### 1. Frontend (Expo app)

```bash
cd house-inventory-app
npm install
npx expo start --web --port 8090
```

Open http://localhost:8090 in your browser.

### 2. Backend proxy server (required for live prices)

```bash
cd server
npm install
npm run dev
```

The server runs on http://localhost:3001. The app automatically routes price searches through it. Without the server running, only browser-side Kroger lookups work (via a CORS proxy).

### 3. API Keys (optional — all have free tiers)

Add these in the app under **Settings**:

| Key | Where to get | What it unlocks |
|-----|-------------|-----------------|
| **Kroger API** | [developer.kroger.com](https://developer.kroger.com) | Live prices from Kroger, Fred Meyer, QFC, Ralphs, King Soopers, Harris Teeter |
| **Instacart API** | [instacart.com/developer](https://www.instacart.com/developer) | Live prices from Walmart, Costco, Safeway, Whole Foods, Target (all in one) |
| Gemini | [aistudio.google.com](https://aistudio.google.com) | AI-powered receipt parsing |
| OCR Space | [ocr.space](https://ocr.space) | Receipt image scanning |

> **Note:** Flipp and Target work without any API key. Walmart, Costco, and Whole Foods block automated lookups — the app shows clickable links for those stores until you add the Instacart key.

---

## Store Coverage Summary

| Store | Live Prices | How |
|-------|------------|-----|
| Kroger / Fred Meyer / QFC / Ralphs | Yes | Official Kroger API |
| Target | Yes (with fallback) | Target RedSky API |
| Safeway / Albertsons | Yes (sale items) | Flipp weekly circulars |
| ALDI / Grocery Outlet / Haggen | Yes (sale items) | Flipp weekly circulars |
| Stop & Shop / Wegmans / Acme | Yes (sale items) | Flipp weekly circulars |
| 15+ other regional chains | Yes (sale items) | Flipp weekly circulars |
| Walmart | Link only | Bot-protected |
| Costco | Link only | Bot-protected |
| Whole Foods | Link only | Amazon-protected |
| All stores | Yes (when approved) | Instacart Developer API |

---

## Tech Stack

- **React Native + Expo** — cross-platform (web, iOS, Android)
- **expo-sqlite** — local database, no account required
- **Node.js + Express + TypeScript** — backend proxy server
- **Kroger Developer API** — official product search API
- **Target RedSky API** — Target's internal product search (same endpoint their website uses)
- **Flipp/Wishabi API** — weekly circular aggregator covering 100+ grocery chains
- **Instacart Developer Platform** — multi-store price API (when approved)
