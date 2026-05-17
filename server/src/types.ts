export type DataSource = 'api' | 'scrape' | 'link_only';
export type BrandMatch = 'exact' | 'store_brand' | 'different' | 'unknown';

export interface StorePriceResult {
  id: string;
  itemSearched: string;
  storeName: string;
  storeChain: string;
  productName: string;
  price: number;
  promoPrice?: number;
  priceUnit?: string;
  inStock: boolean;
  distanceMiles?: number;
  storeAddress?: string;
  productUrl?: string;
  searchedAt: string;
  dataSource: DataSource;
  // annotated fields
  unitsNeeded?: number;
  totalCost?: number;
  coverageNote?: string;
  brandMatch?: BrandMatch;
}

export interface PriceSearchRequest {
  items: Array<{
    canonicalName: string;
    quantityNeeded: number;
  }>;
  zip: string;
  krogerClientId?: string;
  krogerClientSecret?: string;
  instacartApiKey?: string;
}
