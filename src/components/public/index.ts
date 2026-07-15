export type {
  PublicCategoryItem,
  PublicComparisonData,
  PublicDealCardData,
  PublicEvidenceData,
  PublicPricePoint,
} from './contracts';
export { DealCard, DealCardSkeleton, DealEmptyState, DealScoreBadge, PriceDisplay, VerifiedSourceBadge } from './DealCard';
export { DealFilterBar, type PublicFilterValues } from './DealFilterBar';
export { DealPagination } from './DealPagination';
export { CategoryNavigation, DealTabs, HeroSection, TrustHighlights } from './HomepageSections';
export { AffiliateDisclosure, PriceHistory, ProductEvidence, RelatedDeals, SourceSummary } from './ProductSections';
export { ProductComparison } from './ProductComparison';
export { ComparisonToggle, ProductComparisonTray } from './ProductComparisonTray';
export { ProductGallery } from './ProductGallery';
export { PublicFooter } from './PublicFooter';
export { PublicHeader } from './PublicHeader';
export { PublicIcon } from './PublicIcon';
export { PublicSearch } from './PublicSearch';
export { PublicProductCardTracker, PublicVisibilityTracker, trackPublicEvent } from './PublicAnalytics';
export { PublicViewTracker } from './PublicViewTracker';
