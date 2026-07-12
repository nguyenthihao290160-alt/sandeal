import { createHash } from 'crypto';
import type { EditorialClaim, Product, ReviewContent, VerifiedProductFact } from './types';

export const REVIEW_DISCLOSURE = 'Bài viết được SanDeal tổng hợp và đánh giá tự động dựa trên dữ liệu sản phẩm, giá, liên kết và hình ảnh tại thời điểm kiểm tra. SanDeal chưa trực tiếp thử nghiệm sản phẩm này, trừ khi bài viết ghi rõ có thử nghiệm thực tế.';
export const REVIEW_THRESHOLDS = { contentQualityScore: 75, originalityScore: 70, seoReadinessScore: 80 } as const;

const RISKY_CLAIMS = /\b(chắc chắn|tuyệt đối|cam kết|tốt nhất|số một|hiệu quả ngay|chữa|điều trị|an toàn hoàn toàn|không tác dụng phụ|bền nhất|rẻ nhất thị trường)\b/i;
const MARKETING_SENTENCES = /(tốt nhất|số một|chữa khỏi|cam kết hiệu quả|an toàn tuyệt đối)/i;

function cleanText(value: unknown, max = 240): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeReviewContent(value: unknown, sourceHash = ''): ReviewContent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const review = value as Partial<ReviewContent>;
  const approved = review.reviewStatus === 'approved'
    && Number(review.contentQualityScore || 0) >= REVIEW_THRESHOLDS.contentQualityScore
    && Number(review.originalityScore || 0) >= REVIEW_THRESHOLDS.originalityScore
    && Number(review.seoReadinessScore || 0) >= REVIEW_THRESHOLDS.seoReadinessScore
    && Array.isArray(review.reviewBlockReasons) && review.reviewBlockReasons.length === 0
    && review.reviewMethod !== 'hands_on_test';
  return {
    reviewStatus: approved ? 'approved' : (review.reviewStatus === 'stale' ? 'stale' : 'needs_review'),
    reviewVersion: Number(review.reviewVersion || 1), reviewMethod: review.reviewMethod === 'hands_on_test' ? 'source_data_analysis' : (review.reviewMethod || 'source_data_analysis'),
    reviewerType: review.reviewerType || 'automated_editorial', reviewDisclosure: cleanText(review.reviewDisclosure, 600) || REVIEW_DISCLOSURE,
    reviewTitle: cleanText(review.reviewTitle, 220), reviewSummary: cleanText(review.reviewSummary, 1600), reviewVerdict: cleanText(review.reviewVerdict, 1000),
    suitableFor: Array.isArray(review.suitableFor) ? review.suitableFor.map((item) => cleanText(item, 300)).filter(Boolean) : [],
    notSuitableFor: Array.isArray(review.notSuitableFor) ? review.notSuitableFor.map((item) => cleanText(item, 300)).filter(Boolean) : [],
    keyFacts: Array.isArray(review.keyFacts) ? review.keyFacts : [], strengths: Array.isArray(review.strengths) ? review.strengths : [],
    limitations: Array.isArray(review.limitations) ? review.limitations : [], buyingConsiderations: Array.isArray(review.buyingConsiderations) ? review.buyingConsiderations.map((item) => cleanText(item, 300)).filter(Boolean) : [],
    factualClaims: Array.isArray(review.factualClaims) ? review.factualClaims : [], inferredClaims: Array.isArray(review.inferredClaims) ? review.inferredClaims : [], unknownClaims: Array.isArray(review.unknownClaims) ? review.unknownClaims : [],
    evidenceSources: Array.isArray(review.evidenceSources) ? review.evidenceSources : [], sourceConfidence: review.sourceConfidence || 'low',
    dataQualityScore: Number(review.dataQualityScore || 0), productSafetyScore: Number(review.productSafetyScore || 0), contentQualityScore: Number(review.contentQualityScore || 0),
    originalityScore: Number(review.originalityScore || 0), seoReadinessScore: Number(review.seoReadinessScore || 0), editorialConfidence: Number(review.editorialConfidence || 0),
    reviewBlockReasons: Array.isArray(review.reviewBlockReasons) ? review.reviewBlockReasons.map(String) : ['legacy_review_incomplete'],
    reviewedAt: review.reviewedAt || '', contentUpdatedAt: review.contentUpdatedAt || '', sourceHash: review.sourceHash || sourceHash, reviewContentHash: review.reviewContentHash || '',
  };
}

function formatMoney(value: number): string { return `${value.toLocaleString('vi-VN')} ₫`; }
function fact(id: string, label: string, value: string | number, sourceField: string, product: Product): VerifiedProductFact {
  return { id, label, value, sourceField, sourceName: product.source || 'canonical_product', verifiedAt: product.linkLastCheckedAt || product.updatedAt };
}

export function extractVerifiedProductFacts(product: Product): VerifiedProductFact[] {
  const facts: VerifiedProductFact[] = [];
  const title = cleanText(product.title, 180);
  if (title && !MARKETING_SENTENCES.test(title)) facts.push(fact('title', 'Tên sản phẩm', title, 'title', product));
  const currentPrice = Number(product.salePrice || product.price || 0);
  if (currentPrice > 0) facts.push(fact('current_price', 'Giá hiện tại', currentPrice, product.salePrice ? 'salePrice' : 'price', product));
  if (product.price && product.salePrice && product.price > product.salePrice) {
    facts.push(fact('original_price', 'Giá gốc', product.price, 'price', product));
    facts.push(fact('discount', 'Mức giảm tính từ dữ liệu giá', Math.round((1 - product.salePrice / product.price) * 100), 'price,salePrice', product));
  }
  const brand = cleanText(product.brand, 80);
  if (brand) facts.push(fact('brand', 'Thương hiệu', brand, 'brand', product));
  const category = cleanText(product.category, 100);
  if (category) facts.push(fact('category', 'Nhóm sản phẩm', category, 'category', product));
  if (product.currency === 'VND') facts.push(fact('currency', 'Tiền tệ', 'VND', 'currency', product));
  if (product.originalUrl) facts.push(fact('product_url', 'Liên kết sản phẩm', product.originalUrl, 'originalUrl', product));
  if (product.affiliateUrl) facts.push(fact('affiliate_url', 'Liên kết affiliate', product.affiliateUrl, 'affiliateUrl', product));
  if (product.imageUrl) facts.push(fact('image', 'Ảnh sản phẩm', product.imageUrl, 'imageUrl', product));
  if (product.linkHealthStatus) facts.push(fact('product_health', 'Tình trạng liên kết sản phẩm', product.linkHealthStatus, 'linkHealthStatus', product));
  if (product.affiliateHealthStatus) facts.push(fact('affiliate_health', 'Tình trạng liên kết affiliate', product.affiliateHealthStatus, 'affiliateHealthStatus', product));
  if (product.imageHealthStatus) facts.push(fact('image_health', 'Tình trạng ảnh', product.imageHealthStatus, 'imageHealthStatus', product));
  if (product.linkLastCheckedAt) facts.push(fact('checked_at', 'Thời điểm kiểm tra', product.linkLastCheckedAt, 'linkLastCheckedAt', product));
  if (product.sku) facts.push(fact('sku', 'Mã SKU', cleanText(product.sku, 100), 'sku', product));
  for (const [key, value] of Object.entries(product.specifications || {}).slice(0, 12)) {
    const label = cleanText(key, 80); const normalized = typeof value === 'number' ? value : cleanText(value, 140);
    if (label && normalized !== '') facts.push(fact(`spec_${createHash('sha1').update(label).digest('hex').slice(0, 8)}`, label, normalized, `specifications.${key}`, product));
  }
  return facts.filter((item) => item.value !== '');
}

function tokens(text: string): Set<string> {
  return new Set(text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((item) => item.length > 2));
}

export function textSimilarity(a: string, b: string): number {
  const left = tokens(a); const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0; for (const item of left) if (right.has(item)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function reviewDistinctiveText(review: Pick<ReviewContent, 'reviewTitle' | 'reviewSummary' | 'reviewVerdict' | 'strengths' | 'limitations'>): string {
  return [review.reviewTitle, review.reviewSummary, review.reviewVerdict, ...review.strengths.map((item) => item.text), ...review.limitations.map((item) => item.text)].join(' ');
}

export function validateReviewClaims(review: ReviewContent, product: Product): { valid: boolean; severeErrors: string[]; removedClaimIds: string[] } {
  const facts = new Map(review.keyFacts.map((item) => [item.id, item]));
  const severeErrors: string[] = [];
  const removedClaimIds: string[] = [];
  if (review.reviewMethod === 'hands_on_test') severeErrors.push('unsupported_hands_on_test');
  for (const claim of [...review.factualClaims, ...review.inferredClaims]) {
    if (RISKY_CLAIMS.test(claim.text)) severeErrors.push(`unsafe_claim:${claim.id}`);
    if (!claim.evidenceFactIds.length || claim.evidenceFactIds.some((id) => !facts.has(id))) removedClaimIds.push(claim.id);
    if (claim.claimType === 'inferred' && !/(có thể|phù hợp để cân nhắc|theo dữ liệu|nên kiểm tra)/i.test(claim.text)) severeErrors.push(`inference_stated_as_fact:${claim.id}`);
  }
  const sourceFields = new Set(review.keyFacts.map((item) => item.sourceField.split(',')).flat());
  if (!sourceFields.has('title') || cleanText(product.title) === '') severeErrors.push('missing_title_evidence');
  return { valid: severeErrors.length === 0 && removedClaimIds.length === 0, severeErrors: [...new Set(severeErrors)], removedClaimIds: [...new Set(removedClaimIds)] };
}

function claim(id: string, text: string, claimType: EditorialClaim['claimType'], evidenceFactIds: string[], confidence: EditorialClaim['confidence']): EditorialClaim {
  return { id, text, claimType, evidenceFactIds, confidence };
}

export function generateEditorialReview(product: Product, otherProducts: Product[] = [], now = new Date().toISOString()): ReviewContent {
  const existingReview = product.reviewContent;
  if (existingReview && existingReview.sourceHash === product.sourceHash && existingReview.reviewContentHash) return existingReview;
  const facts = extractVerifiedProductFacts(product);
  const byId = new Map(facts.map((item) => [item.id, item]));
  const title = String(byId.get('title')?.value || product.title || 'Sản phẩm cần xem xét');
  const category = String(byId.get('category')?.value || 'nhóm sản phẩm này');
  const price = Number(byId.get('current_price')?.value || 0);
  const summary = facts.length >= 8
    ? `${title} là sản phẩm thuộc ${category}, hiện có giá tham khảo ${formatMoney(price)} theo nguồn đã ghi nhận. Dữ liệu liên kết và hình ảnh đã được kiểm tra kỹ thuật, nhưng SanDeal chưa trực tiếp sử dụng sản phẩm. Người mua nên đối chiếu giá, thông số và chính sách của nhà bán hàng trước khi quyết định.`
    : `${title} hiện chưa có đủ dữ kiện đã xác minh để tạo một bài đánh giá đầy đủ. SanDeal chỉ hiển thị thông tin ngắn và đề nghị kiểm tra thêm tại nguồn.`;
  const factualClaims = facts.filter((item) => ['current_price', 'original_price', 'discount', 'brand', 'category', 'product_health', 'affiliate_health', 'image_health'].includes(item.id))
    .map((item) => claim(`fact_${item.id}`, `${item.label}: ${typeof item.value === 'number' && item.id.includes('price') ? formatMoney(item.value) : item.value}${item.id === 'discount' ? '%' : ''}.`, 'factual', [item.id], 'high'));
  const inferredClaims: EditorialClaim[] = [];
  if (byId.has('category')) inferredClaims.push(claim('inference_audience', `Theo dữ liệu phân loại, sản phẩm có thể phù hợp để cân nhắc với người đang tìm sản phẩm trong nhóm ${category}.`, 'inferred', ['category'], 'medium'));
  if (byId.has('discount')) inferredClaims.push(claim('inference_price', 'Theo dữ liệu giá hiện tại và giá gốc, mức giá đang thấp hơn giá tham chiếu; người mua vẫn nên kiểm tra lại tại thời điểm đặt hàng.', 'inferred', ['current_price', 'original_price', 'discount'], 'medium'));
  const unknownClaims = [
    claim('unknown_experience', 'SanDeal chưa có dữ liệu để xác minh trải nghiệm sử dụng thực tế.', 'unknown', [], 'unknown'),
    claim('unknown_durability', 'Độ bền sau thời gian dài chưa được nguồn cung cấp hoặc SanDeal chưa có dữ liệu để xác minh.', 'unknown', [], 'unknown'),
    claim('unknown_returns', 'Chính sách đổi trả và tốc độ giao hàng cần được kiểm tra trực tiếp với nhà bán hàng.', 'unknown', [], 'unknown'),
  ];
  const strengths = [
    byId.has('current_price') ? claim('strength_price', 'Có giá tham khảo bằng VND để người mua đối chiếu.', 'factual', ['current_price', 'currency'], 'high') : null,
    byId.has('product_health') && byId.get('product_health')?.value === 'ok' ? claim('strength_link', 'Liên kết sản phẩm đã vượt kiểm tra kỹ thuật gần nhất.', 'factual', ['product_health', 'checked_at'], 'high') : null,
    byId.has('image_health') && byId.get('image_health')?.value === 'ok' ? claim('strength_image', 'Ảnh sản phẩm đã vượt kiểm tra định dạng và khả dụng.', 'factual', ['image_health', 'image'], 'high') : null,
  ].filter((item): item is EditorialClaim => Boolean(item));
  const limitations = unknownClaims.slice(0, 2);
  const sourceConfidence = product.verifiedSource === true && facts.length >= 10 ? 'high' : facts.length >= 7 ? 'medium' : 'low';
  const dataQualityScore = Math.min(100, facts.length * 7 + (product.verifiedSource ? 15 : 0));
  const healthyStatuses = [product.linkHealthStatus, product.affiliateHealthStatus, product.imageHealthStatus]
    .filter((status) => status === 'ok' || status === 'redirect_ok').length;
  const productSafetyScore = Math.min(100, healthyStatuses * 25 + (product.verifiedSource ? 25 : 0));
  const contentQualityScore = facts.length < 8 ? Math.min(60, dataQualityScore) : Math.min(100, 58 + facts.length * 2 + strengths.length * 4 + inferredClaims.length * 3);
  const reviewTitle = `Đánh giá ${title}: dữ kiện, giá và điều cần cân nhắc`;
  const reviewVerdict = facts.length >= 8
    ? `${title} đáng để đưa vào danh sách so sánh nếu các dữ kiện hiện có phù hợp với nhu cầu của bạn. Chưa có cơ sở để kết luận về trải nghiệm hoặc độ bền thực tế.`
    : 'Dữ liệu hiện tại chưa đủ để đưa ra kết luận biên tập đầy đủ.';
  const provisional: ReviewContent = {
    reviewStatus: 'generated', reviewVersion: 1, reviewMethod: 'source_data_analysis', reviewerType: 'automated_editorial',
    reviewDisclosure: REVIEW_DISCLOSURE, reviewTitle, reviewSummary: summary, reviewVerdict,
    suitableFor: inferredClaims.map((item) => item.text),
    notSuitableFor: ['Người cần kết luận dựa trên thử nghiệm sử dụng thực tế hoặc dữ liệu độ bền dài hạn.'],
    keyFacts: facts, strengths, limitations,
    buyingConsiderations: ['Kiểm tra lại giá và tồn kho tại trang đối tác.', 'Đọc chính sách đổi trả và bảo hành do nhà bán hàng công bố.', 'Đối chiếu thông số cần thiết trước khi đặt hàng.'],
    factualClaims, inferredClaims, unknownClaims,
    evidenceSources: [{ name: String(product.source || 'canonical_product'), fields: [...new Set(facts.flatMap((item) => item.sourceField.split(',')))], checkedAt: product.linkLastCheckedAt || product.updatedAt }],
    sourceConfidence, dataQualityScore, productSafetyScore, contentQualityScore,
    originalityScore: 0, seoReadinessScore: 0, editorialConfidence: Math.round((dataQualityScore + productSafetyScore) / 2),
    reviewBlockReasons: [] as string[], reviewedAt: now, contentUpdatedAt: now,
    sourceHash: String(product.sourceHash || ''), reviewContentHash: '',
  };
  const comparisonTexts = [cleanText(product.description, 2000), ...otherProducts.map((item) => item.reviewContent ? reviewDistinctiveText(item.reviewContent) : '')].filter(Boolean);
  const maxSimilarity = comparisonTexts.reduce((max, text) => Math.max(max, textSimilarity(reviewDistinctiveText(provisional), text)), 0);
  provisional.originalityScore = Math.max(0, Math.round(100 - maxSimilarity * 100));
  provisional.seoReadinessScore = Math.min(100, (reviewTitle.length >= 25 ? 12 : 0) + (summary.length >= 160 ? 15 : 0) + (product.slug ? 10 : 0) + (product.imageHealthStatus === 'ok' ? 10 : 0) + (facts.length >= 8 ? 15 : 0) + (contentQualityScore >= 75 ? 15 : 0) + (provisional.originalityScore >= 70 ? 13 : 0) + (product.affiliateUrl ? 10 : 0));
  const validation = validateReviewClaims(provisional, product);
  if (facts.length < 8) provisional.reviewBlockReasons.push('insufficient_facts');
  if (validation.severeErrors.length) provisional.reviewBlockReasons.push('unsafe_claim');
  if (validation.removedClaimIds.length) provisional.reviewBlockReasons.push('claim_validation_failed');
  if (provisional.originalityScore < REVIEW_THRESHOLDS.originalityScore) provisional.reviewBlockReasons.push('low_originality');
  if (contentQualityScore < REVIEW_THRESHOLDS.contentQualityScore) provisional.reviewBlockReasons.push('low_content_quality');
  if (provisional.seoReadinessScore < REVIEW_THRESHOLDS.seoReadinessScore) provisional.reviewBlockReasons.push('low_seo_readiness');
  if (!product.verifiedSource) provisional.reviewBlockReasons.push('unverified_source');
  provisional.reviewBlockReasons = [...new Set(provisional.reviewBlockReasons)];
  provisional.reviewStatus = provisional.reviewBlockReasons.length ? 'needs_review' : 'approved';
  provisional.reviewContentHash = createHash('sha256').update(JSON.stringify({ ...provisional, reviewedAt: undefined, contentUpdatedAt: undefined, reviewContentHash: undefined })).digest('hex');
  return provisional;
}

export function isReviewIndexable(product: Partial<Product>): boolean {
  const review = product.reviewContent;
  return Boolean(review && review.reviewStatus === 'approved'
    && review.contentQualityScore >= REVIEW_THRESHOLDS.contentQualityScore
    && review.originalityScore >= REVIEW_THRESHOLDS.originalityScore
    && review.seoReadinessScore >= REVIEW_THRESHOLDS.seoReadinessScore
    && review.reviewBlockReasons.length === 0);
}

export function shouldRegenerateReview(product: Product): boolean {
  return !product.reviewContent || product.reviewContent.sourceHash !== product.sourceHash || product.reviewContent.reviewStatus === 'stale';
}
