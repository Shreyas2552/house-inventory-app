# Changelog — House Inventory & Grocery Price Tracker

All notable changes are documented here in reverse chronological order.

---

## v2.0 — 2026-05-16 · Multi-store live price coverage

### Added
- **Target scraper** — live prices via Target RedSky API; randomized visitor ID to avoid rate limits; falls back to link-only card when API is temporarily blocked
- **Flipp weekly circular scraper** — real sale prices from 20+ regional grocery chains (Safeway, Albertsons, QFC, Fred Meyer, Haggen, Grocery Outlet, ALDI, Stop & Shop, Wegmans, Acme Markets, Weis Markets, and more) via the Flipp/Wishabi aggregator API
- **Store brand colors** — Albertsons, QFC, Haggen, Grocery Outlet, ALDI, Stop & Shop, Wegmans now have branded accent colors in the link-only card UI

### Changed
- **Kroger location lookup** — fixed parameter from `filter.zipCode` to `filter.zipCode.near` so it correctly finds the nearest Kroger-family store (QFC, Fred Meyer, Ralphs, King Soopers, etc.)
- **"Live" badge** — now shown for both `api` and `scrape` data sources (previously only `api`; Target uses `scrape`)
- **Link-only fallback** — Target added back as link-only safety net for when the API is rate-limited; Safeway removed (now covered by Flipp live data)
- **Price search subtitle** — updated from "Live: Kroger/Fred Meyer" to "Live prices from Kroger, Safeway, Target & 20+ stores"

### Fixed
- **Flipp relevance filter** — irrelevant items excluded when the search term does not appear as a standalone word in the product name (e.g. "Breaded Flounder" no longer matches "bread"; "Milky Way" no longer matches "milk")
- **Flipp deduplication** — whitespace normalized before comparing merchant+name pairs; duplicate ads from the same store no longer shown
- **Flipp merchant filter** — commercial wholesale stores (Restaurant Depot) excluded from consumer-facing results
- **Annotator coverage note** — Flipp "Sale ends" dates now preserved; previously the annotator overwrote them with `undefined` when no quantity math applied

### Coverage after v2.0 (validated)
| ZIP tested | Live stores | Live results (7 items) |
|---|---|---|
| 10001 (NYC) | Acme, Stop & Shop, ALDI, Weis, Bravo, H Mart, C Town, Kings Food, Lidl, Grocery Outlet + more | 84 |
| 98101 (Seattle) | QFC, Fred Meyer, Safeway, Albertsons, Haggen, Grocery Outlet, Metropolitan Market, Dollar General | 97 |

---

## v1.0 — 2026-05-16 · Initial release

### Added
- **Inventory tracker** — add items manually, via receipt scan (photo/PDF/URL), or by voice
- **Smart restock list** — mark items as finished; they automatically move to the restock queue
- **Kroger/Fred Meyer live prices** — official Kroger Developer API with OAuth client_credentials; searches QFC, Fred Meyer, Ralphs, King Soopers, Harris Teeter by nearest store to user's ZIP
- **Walmart scraper** — fast axios-based HTML scraper; fails gracefully in <8 s when Walmart's PerimeterX bot protection blocks the request
- **Backend proxy server** — Node.js/Express server (`server/`) that routes price searches server-side, bypassing browser CORS restrictions
- **Backend-first with browser fallback** — frontend tries `localhost:3001` (6 s timeout) then falls back to browser-side Kroger via corsproxy.io
- **Link-only store cards** — stores without live prices (Walmart, Costco, Whole Foods) shown as branded clickable cards with "Tap to search" hint
- **"Open all" button** — opens all link-only store search pages at once
- **Brand matching** — flags whether a search result matches your preferred brand, is a store brand, or is a different brand
- **Quantity coverage** — calculates how many units you need based on restock quantity (e.g. "2 × 1gal covers 2gal")
- **30-minute price cache** — results cached per item+ZIP; cleared on ticker set change
- **Instacart API ready** — placeholder scraper wired up; unlocks all stores when an Instacart Developer key is added in Settings
- **Settings screen** — Kroger API key, Instacart API key, home ZIP code all configurable in-app
- **SQLite local database** — inventory, settings, and receipts stored locally via expo-sqlite; no account required
