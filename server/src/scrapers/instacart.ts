import { StorePriceResult } from '../types';

/**
 * Instacart Developer Platform API integration.
 *
 * To enable:
 * 1. Apply at https://www.instacart.com/developer
 * 2. Once approved, add your API key to the request body as instacartApiKey
 * 3. This covers: Walmart, Costco, Safeway, Whole Foods, Target, Kroger, Aldi and more
 *
 * API docs: https://docs.instacart.com/developer_platform_api/
 */

const INSTACART_BASE = 'https://connect.instacart.com';

export async function searchInstacart(
  itemName: string,
  zip: string,
  apiKey: string,
): Promise<StorePriceResult[]> {
  if (!apiKey) return [];

  try {
    // Step 1: Get nearby retailers
    const retailersResp = await fetch(`${INSTACART_BASE}/idp/v1/products/products_link`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: itemName,
        image_url: '',
        link_type: 'dynamic',
        instructions: `Find ${itemName}`,
        landing_page_configuration: {
          partner_linkback_url: 'https://example.com',
          enable_pantry_items: false,
        },
      }),
    });

    if (!retailersResp.ok) {
      console.error(`Instacart API error: ${retailersResp.status}`);
      return [];
    }

    const data = await retailersResp.json() as any;
    const now = new Date().toISOString();
    const results: StorePriceResult[] = [];

    // Parse Instacart product results across retailers
    const retailers: any[] = data?.retailers ?? data?.products ?? [];
    for (const retailer of retailers.slice(0, 5)) {
      const products: any[] = retailer?.items ?? retailer?.products ?? [];
      for (const p of products.slice(0, 2)) {
        const price = parseFloat(p?.price ?? p?.price_amount ?? '0');
        if (!price) continue;

        results.push({
          id: `instacart_${Date.now()}_${results.length}`,
          itemSearched: itemName,
          storeName: retailer?.name ?? 'Instacart Store',
          storeChain: (retailer?.name ?? '').toLowerCase().replace(/\s+/g, ''),
          productName: (p?.name ?? p?.product_name ?? itemName).slice(0, 80),
          price,
          inStock: p?.available !== false,
          productUrl: p?.product_page_url ?? `https://www.instacart.com/store/s?k=${encodeURIComponent(itemName)}`,
          searchedAt: now,
          dataSource: 'api',
        });
      }
    }

    return results;
  } catch (err) {
    console.error('Instacart search error:', err);
    return [];
  }
}
