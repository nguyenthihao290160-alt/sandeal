export interface PublicCategoryItem {
  name: string;
  count: number;
}

export interface PublicDealCardData {
  id: string;
  slug: string;
  title: string;
  imageUrl?: string | null;
  platform: string;
  category?: string | null;
  currentPrice?: number | null;
  originalPrice?: number | null;
  currency?: string | null;
  discountPercent?: number | null;
  dealScore?: number | null;
  dealBand?: string | null;
  qualityScore?: number | null;
  verifiedSource?: boolean;
  priceUpdatedAt?: string | null;
  sourceLabel?: string | null;
  outboundHref?: string | null;
}

export interface PublicPricePoint {
  capturedAt: string;
  price: number;
}

export interface PublicComparisonData extends PublicDealCardData {
  brand?: string | null;
  specifications?: Record<string, string | number>;
  strengths?: string[];
  limitations?: string[];
  updatedAt?: string | null;
}

export interface PublicEvidenceData {
  sources: Array<{ name: string; fields?: string[]; checkedAt?: string | null }>;
  facts: Array<{ id: string; label: string; value: string | number }>;
  warnings?: string[];
}
