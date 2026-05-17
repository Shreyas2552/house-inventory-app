export type Category =
  | 'Grocery'
  | 'Baby'
  | 'Medicine'
  | 'Cleaning'
  | 'Personal Care'
  | 'Household';

export type InventoryStatus = 'present' | 'not_present' | 'ignored';

export type ReviewStatus = 'auto_matched' | 'needs_review' | 'user_corrected' | 'ignored';

export type Product = {
  id: string;
  canonicalName: string;
  category: Category;
  defaultUnit: string;
  createdAt: string;
  updatedAt: string;
};

export type ProductAlias = {
  id: string;
  rawText: string;
  productId: string;
  storeName?: string;
  confidence: number;
  createdByUser: boolean;
  createdAt: string;
};

export type InventoryItem = {
  id: string;
  productId: string;
  canonicalName: string;
  category: Category;
  quantityPresent: number;
  status: InventoryStatus;
  lastPurchasedAt?: string;
  lastFinishedAt?: string;
  notes?: string;
};

export type ReceiptLineCandidate = {
  id: string;
  rawLine: string;
  suggestedName: string;
  category: Category;
  quantity: number;
  unitPrice?: number;
  totalPrice?: number;
  reviewStatus: ReviewStatus;
  trackItem: boolean;
};

export type Receipt = {
  id: string;
  sourceType: 'camera_scan' | 'image_upload' | 'pdf_upload' | 'pasted_text' | 'receipt_link';
  storeName?: string;
  purchaseDate?: string;
  rawText: string;
  totalAmount?: number;
  createdAt: string;
};

export type RestockItem = {
  id: string;
  productId: string;
  canonicalName: string;
  category: Category;
  quantityNeeded: number;
  active: boolean;
  cancelledForNextTrip: boolean;
  createdAt: string;
};

export type StoreCandidate = {
  id: string;
  name: string;
  address: string;
  distanceMiles?: number;
  source: 'preferred_chain' | 'location_discovered' | 'online';
  hidden: boolean;
};

export type OptimizationMode = 'distance' | 'cost' | 'balanced';

export type AppSettings = {
  searchRadiusMiles: number;
  maxRadiusMiles: number;
  optimizationMode: OptimizationMode;
  homeLocationText: string;
  // API keys (stored locally in SQLite, not included in backup exports)
  ocrSpaceKey: string;
  geminiKey: string;
  groqKey: string;
  firecrawlKey: string;
  krogerClientId: string;
  krogerClientSecret: string;
  instacartApiKey: string;
  // Active service selections
  activeOcrService: 'ocrspace' | 'gemini';
  activeAiParser: 'none' | 'gemini' | 'groq';
  activeUrlScraper: 'jina' | 'firecrawl';
};

export type ParsedQty = {
  amount: number;
  unit: string;
  displayStr: string;
  baseML?: number;    // liquid volume in ml
  baseG?: number;     // weight in grams
  baseCount?: number; // unit count
};

export type BrandMatch = 'exact' | 'store_brand' | 'different' | 'unknown';
export type DataSource = 'api' | 'scrape' | 'link_only';

export type StorePriceResult = {
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
  // Quantity matching
  quantityParsed?: ParsedQty;
  unitsNeeded?: number;       // how many of this product covers restock qty
  totalCost?: number;         // price × unitsNeeded
  coverageNote?: string;      // e.g. "2 × 48 fl oz covers 3L"
  // Brand matching
  brandMatch?: BrandMatch;
  // Source quality
  dataSource?: DataSource;
};

export type PriceComparisonResult = {
  id: string;
  itemName: string;
  storeName: string;
  fulfillment: 'in_store' | 'online_delivery';
  distanceMiles?: number;
  price?: number;
  availability: 'unknown' | 'search_required';
  searchUrl: string;
  score: number;
};

export type BackupPayload = {
  exportedAt: string;
  appVersion: string;
  products: Product[];
  aliases: ProductAlias[];
  inventory: InventoryItem[];
  receipts: Receipt[];
  restock: RestockItem[];
  stores: StoreCandidate[];
  settings?: AppSettings;
};
