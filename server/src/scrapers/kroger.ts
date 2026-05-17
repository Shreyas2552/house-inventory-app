import axios from 'axios';
import { locationCache } from '../cache';
import { StorePriceResult } from '../types';

let _token: { value: string; expiresAt: number } | null = null;

const BASE = 'https://api.kroger.com/v1';

export async function getKrogerToken(clientId: string, clientSecret: string): Promise<string> {
  if (_token && _token.expiresAt > Date.now()) return _token.value;

  const resp = await axios.post(
    `${BASE}/connect/oauth2/token`,
    'grant_type=client_credentials&scope=product.compact',
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );

  const token: string = resp.data.access_token;
  const expiresIn: number = Number(resp.data.expires_in) || 1800;
  _token = { value: token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
  return token;
}

async function getNearestKrogerStore(
  token: string,
  zip: string,
): Promise<{ locationId: string; name: string; address: string }> {
  const cacheKey = `kroger_loc_${zip}`;
  const cached = locationCache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const resp = await axios.get(
    `${BASE}/locations?filter.zipCode.near=${zip}&filter.radiusInMiles=50&filter.limit=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc = (resp.data as any)?.data?.[0];
  if (!loc) throw new Error('No Kroger store found near zip ' + zip);

  const addr = loc.address ?? {};
  const result = {
    locationId: String(loc.locationId),
    name: loc.name ?? 'Kroger',
    address: [addr.addressLine1, addr.city, addr.state].filter(Boolean).join(', '),
  };

  locationCache.set(cacheKey, JSON.stringify(result));
  return result;
}

export async function searchKroger(
  itemName: string,
  zip: string,
  clientId: string,
  clientSecret: string,
): Promise<StorePriceResult[]> {
  const token = await getKrogerToken(clientId, clientSecret);
  const location = await getNearestKrogerStore(token, zip);
  const query = cleanSearchTerm(itemName);

  const resp = await axios.get(
    `${BASE}/products?filter.term=${encodeURIComponent(query)}&filter.locationId=${location.locationId}&filter.limit=5`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const products: any[] = Array.isArray((resp.data as any)?.data) ? (resp.data as any).data : [];
  const now = new Date().toISOString();
  const results: StorePriceResult[] = [];

  for (const p of products) {
    const desc: string = p?.description ?? '';
    if (!desc.trim()) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstItem = (Array.isArray(p?.items) ? p.items[0] : null) as any;
    const regularPrice: number = firstItem?.price?.regular ?? NaN;
    const promoPrice: number | undefined =
      typeof firstItem?.price?.promo === 'number' && firstItem.price.promo < regularPrice
        ? firstItem.price.promo
        : undefined;

    if (!Number.isFinite(regularPrice) || regularPrice <= 0) continue;

    const size: string = firstItem?.size ?? '';
    const productId: string = p?.productId ?? '';

    results.push({
      id: `kroger_${Date.now()}_${results.length}`,
      itemSearched: itemName,
      storeName: location.name,
      storeChain: 'kroger',
      productName: `${desc}${size ? ' ' + size : ''}`.trim().slice(0, 80),
      price: regularPrice,
      promoPrice,
      priceUnit: firstItem?.soldBy === 'WEIGHT' ? 'per lb' : 'each',
      inStock: true,
      storeAddress: location.address,
      productUrl: `https://www.kroger.com/p/${slugify(desc)}/${productId}`,
      searchedAt: now,
      dataSource: 'api',
    });
  }

  return results;
}

function cleanSearchTerm(name: string): string {
  return name
    .replace(/\s+\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:ml|l|fl\.?\s*oz|gal|qt|pt|lb|oz|g|kg|ct|pk|pack)\b/gi, '')
    .trim();
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
