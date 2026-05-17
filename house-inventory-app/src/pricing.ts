import { AppSettings, PriceComparisonResult, RestockItem, StoreCandidate } from './types';

export function buildPriceComparison(
  restock: RestockItem[],
  stores: StoreCandidate[],
  settings: AppSettings,
): PriceComparisonResult[] {
  const activeItems = restock.filter((item) => !item.cancelledForNextTrip);
  const visibleStores = stores.filter((store) => !store.hidden);
  const expandedRadius = getEffectiveRadius(visibleStores, settings.searchRadiusMiles, settings.maxRadiusMiles);

  const results = activeItems.flatMap((item) =>
    visibleStores
      .filter((store) => store.source === 'online' || store.distanceMiles === undefined || store.distanceMiles <= expandedRadius)
      .map((store) => {
        const fulfillment = store.source === 'online' ? 'online_delivery' : 'in_store';
        const distanceMiles = store.source === 'online' ? undefined : store.distanceMiles;
        const score = scoreResult(distanceMiles, settings.optimizationMode, fulfillment);

        return {
          id: `${item.id}_${store.id}`,
          itemName: item.canonicalName,
          storeName: store.name,
          fulfillment,
          distanceMiles,
          availability: 'search_required',
          searchUrl: buildStoreSearchUrl(store.name, item.canonicalName),
          score,
        } satisfies PriceComparisonResult;
      }),
  );

  return results.sort((a, b) => a.score - b.score || a.itemName.localeCompare(b.itemName));
}

export function getEffectiveRadius(stores: StoreCandidate[], requestedRadius: number, maxRadius: number) {
  const inRadius = stores.some((store) => store.source !== 'online' && store.distanceMiles !== undefined && store.distanceMiles <= requestedRadius);
  if (inRadius) {
    return requestedRadius;
  }

  const nearestStore = stores
    .filter((store) => store.source !== 'online' && store.distanceMiles !== undefined)
    .sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity))[0];

  if (!nearestStore?.distanceMiles) {
    return requestedRadius;
  }

  return Math.min(Math.ceil(nearestStore.distanceMiles), maxRadius);
}

function scoreResult(distanceMiles: number | undefined, mode: AppSettings['optimizationMode'], fulfillment: PriceComparisonResult['fulfillment']) {
  const onlinePenalty = fulfillment === 'online_delivery' ? 15 : 0;
  const distance = distanceMiles ?? 20;

  if (mode === 'distance') {
    return distance + onlinePenalty;
  }

  if (mode === 'cost') {
    return onlinePenalty * 0.25;
  }

  return distance * 0.6 + onlinePenalty * 0.6;
}

function buildStoreSearchUrl(storeName: string, itemName: string) {
  const query = encodeURIComponent(itemName);
  const store = storeName.toLowerCase();

  if (store.includes('amazon')) return `https://www.amazon.com/s?k=${query}`;
  if (store.includes('walmart')) return `https://www.walmart.com/search?q=${query}`;
  if (store.includes('target')) return `https://www.target.com/s?searchTerm=${query}`;
  if (store.includes('costco')) return `https://www.costco.com/CatalogSearch?keyword=${query}`;
  if (store.includes('safeway')) return `https://www.safeway.com/shop/search-results.html?q=${query}`;
  if (store.includes('fred meyer')) return `https://www.fredmeyer.com/search?query=${query}&searchType=default_search`;

  return `https://www.google.com/search?q=${encodeURIComponent(`${itemName} ${storeName} grocery price`)}`;
}
