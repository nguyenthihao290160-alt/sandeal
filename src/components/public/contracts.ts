export interface PublicCategoryItem {
  name: string;
  slug: string;
  count: number;
  lastModified?: string;
}

export interface PublicDealCardData {
  id: string;
  slug: string;
  title: string;
  imageUrl?: string | null;
  platform: string;
  category?: string | null;
  brand?: string | null;
  currentPrice?: number | null;
  originalPrice?: number | null;
  currency?: string | null;
  discountPercent?: number | null;
  dealScore?: number | null;
  dealBand?: string | null;
  qualityScore?: number | null;
  opportunityScore?: number | null;
  verifiedSource?: boolean;
  verifiedAt?: string | null;
  priceUpdatedAt?: string | null;
  priceMovement?: { direction: 'down' | 'up'; amount: number; percent: number; capturedAt: string } | null;
  warnings?: string[];
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
