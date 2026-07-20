import { createHash } from 'crypto';
import type { EditorialClaim, Product, ReviewContent, VerifiedProductFact } from './types';

export const REVIEW_DISCLOSURE = 'Bài viết được SanDeal tổng hợp và đánh giá tự động dựa trên dữ liệu sản phẩm, giá, liên kết và hình ảnh tại thời điểm kiểm tra. SanDeal chưa trực tiếp thử nghiệm sản phẩm này, trừ khi bài viết ghi rõ có thử nghiệm thực tế. SanDeal có thể nhận hoa hồng affiliate qua một số liên kết; việc này không làm thay đổi giá người mua thanh toán.';
export const REVIEW_THRESHOLDS = { contentQualityScore: 75, originalityScore: 70, seoReadinessScore: 80 } as const;

// V2: reviewVersion constant
export const CURRENT_REVIEW_VERSION = 2;

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

function makeClaim(id: string, text: string, claimType: EditorialClaim['claimType'], evidenceFactIds: string[], confidence: EditorialClaim['confidence']): EditorialClaim {
  return { id, text, claimType, evidenceFactIds, confidence };
}

// ============================================================
// V2: Deterministic hash-based variant selection
// ============================================================

/**
 * Stable hash of a string, returns a number for variant selection.
 * Same input always produces same output — NO Math.random.
 */
function stableHash(input: string): number {
  const hash = createHash('sha256').update(input).digest();
  return (hash[0] << 24 | hash[1] << 16 | hash[2] << 8 | hash[3]) >>> 0;
}

/**
 * Pick an item from an array based on a deterministic hash.
 */
function pickVariant<T>(variants: T[], seed: string): T {
  const index = stableHash(seed) % variants.length;
  return variants[index];
}

// ============================================================
// V2: Category detection and category-specific templates
// ============================================================

type ProductCategory = 'electronics' | 'home_appliance' | 'beauty' | 'fashion' | 'food' | 'baby' | 'accessories' | 'general';

const CATEGORY_KEYWORDS: Record<ProductCategory, RegExp> = {
  electronics: /\b(điện thoại|laptop|máy tính|tablet|tai nghe|loa|tivi|camera|smartwatch|đồng hồ thông minh|pin sạc|sạc|cáp|ổ cứng|usb|ram|cpu|gpu|mainboard|monitor|màn hình|bàn phím|chuột|router|modem)\b/i,
  home_appliance: /\b(máy giặt|tủ lạnh|máy lạnh|điều hòa|nồi|bếp|máy xay|máy hút|quạt|đèn|bóng đèn|ấm đun|máy lọc|robot hút|máy sấy|lò vi sóng|máy rửa|nồi chiên|máy ép)\b/i,
  beauty: /\b(kem|serum|sữa rửa|toner|mặt nạ|son|phấn|mascara|eyeliner|dầu gội|sữa tắm|nước hoa|chống nắng|dưỡng|tẩy trang|collagen|mỹ phẩm|make ?up|skincare|chăm sóc da)\b/i,
  fashion: /\b(áo|quần|váy|đầm|giày|dép|sandal|túi xách|balo|mũ|nón|thắt lưng|kính mát|đồng hồ|nhẫn|vòng|dây chuyền|khẩu trang|jacket|hoodie|polo|jean)\b/i,
  food: /\b(thực phẩm|bánh|kẹo|trà|cà phê|sữa|nước|thức uống|hạt|ngũ cốc|mì|phở|gia vị|vitamin|thực phẩm chức năng|protein|whey)\b/i,
  baby: /\b(bỉm|tã|sữa bột|bình sữa|xe đẩy|ghế ăn|đồ chơi trẻ em|trẻ em|em bé|baby|kid|infant|toddler|mẹ và bé)\b/i,
  accessories: /\b(phụ kiện|ốp lưng|miếng dán|cường lực|đế sạc|giá đỡ|hub|adapter|túi đựng|bao da|ví|gậy selfie|tripod|gimbal)\b/i,
  general: /./,
};

function detectCategory(product: Product): ProductCategory {
  const text = `${product.title || ''} ${product.category || ''} ${product.description || ''}`.toLowerCase();
  for (const [cat, regex] of Object.entries(CATEGORY_KEYWORDS) as [ProductCategory, RegExp][]) {
    if (cat === 'general') continue;
    if (regex.test(text)) return cat;
  }
  return 'general';
}

// ============================================================
// V2: Category-specific content templates
// ============================================================

interface CategoryTemplate {
  titleFormats: string[];
  summaryIntros: string[];
  verdictFormats: string[];
  buyingConsiderations: string[];
  suitableForFormats: string[];
  notSuitableForFormats: string[];
}

const CATEGORY_TEMPLATES: Record<ProductCategory, CategoryTemplate> = {
  electronics: {
    titleFormats: [
      'Đánh giá {title}: thông số, giá và những điều nên biết trước khi mua',
      '{title} — dữ liệu kỹ thuật, giá tham khảo và gợi ý đối chiếu',
      'Tổng hợp dữ liệu {title}: giá, thông số và lưu ý khi chọn mua',
    ],
    summaryIntros: [
      '{title} là sản phẩm công nghệ thuộc {category}, hiện được ghi nhận với giá tham khảo {price}.',
      'Theo dữ liệu tại thời điểm kiểm tra, {title} thuộc nhóm {category} có giá niêm yết {price}.',
      '{title} — một sản phẩm trong nhóm {category} — đang có giá tham khảo {price} từ nguồn đã xác minh.',
    ],
    verdictFormats: [
      '{title} có thể là lựa chọn đáng cân nhắc nếu thông số kỹ thuật phù hợp với nhu cầu sử dụng của bạn. Nên đối chiếu cấu hình và bảo hành trước khi quyết định.',
      'Dựa trên dữ liệu hiện có, {title} phù hợp để đưa vào danh sách so sánh trong phân khúc giá này. Kiểm tra thêm đánh giá người dùng và chính sách bảo hành.',
      '{title} đáng để xem xét nếu bạn đang tìm sản phẩm trong nhóm {category} ở mức giá này. Chưa có dữ liệu trải nghiệm thực tế.',
    ],
    buyingConsiderations: [
      'Đối chiếu thông số kỹ thuật chi tiết với nhu cầu sử dụng.',
      'Kiểm tra chính sách bảo hành và hỗ trợ kỹ thuật.',
      'So sánh giá với các kênh bán hàng khác.',
      'Xem xét khả năng nâng cấp và phụ kiện tương thích.',
    ],
    suitableForFormats: [
      'Người đang tìm sản phẩm {category} trong phân khúc giá {price}.',
      'Người muốn đối chiếu dữ liệu kỹ thuật trước khi quyết định mua.',
    ],
    notSuitableForFormats: [
      'Người cần đánh giá dựa trên trải nghiệm sử dụng thực tế hoặc benchmark.',
      'Người cần tư vấn chuyên sâu về khả năng tương thích phần cứng.',
    ],
  },
  home_appliance: {
    titleFormats: [
      'Đánh giá {title}: công suất, giá và điều cần cân nhắc',
      '{title} — thông tin kỹ thuật, giá tham khảo và gợi ý cho gia đình',
      'Tổng hợp dữ liệu {title}: đặc điểm, giá và lưu ý khi chọn mua',
    ],
    summaryIntros: [
      '{title} là sản phẩm gia dụng thuộc nhóm {category}, hiện có giá tham khảo {price} theo nguồn đã ghi nhận.',
      'Theo dữ liệu đã kiểm tra, {title} — nhóm {category} — đang có giá niêm yết {price}.',
      '{title} thuộc nhóm sản phẩm {category}, có giá tham khảo {price} từ nguồn đã xác minh.',
    ],
    verdictFormats: [
      '{title} phù hợp để cân nhắc nếu công suất và kích thước đáp ứng nhu cầu hộ gia đình. Kiểm tra kỹ điện năng tiêu thụ và bảo hành.',
      'Dựa trên dữ liệu hiện có, {title} có thể là lựa chọn trong nhóm {category} ở tầm giá này. Nên tham khảo thêm đánh giá sau thời gian sử dụng.',
      '{title} đáng xem xét cho nhu cầu gia đình nếu thông số phù hợp. Chưa có dữ liệu về độ bền sau thời gian dài.',
    ],
    buyingConsiderations: [
      'Kiểm tra công suất và mức tiêu thụ điện.',
      'Đảm bảo kích thước phù hợp với không gian lắp đặt.',
      'Kiểm tra chế độ bảo hành và hỗ trợ kỹ thuật tại địa phương.',
      'Đối chiếu giá với các chuỗi điện máy khác.',
    ],
    suitableForFormats: [
      'Hộ gia đình đang tìm sản phẩm {category} ở mức giá {price}.',
      'Người muốn so sánh thông số kỹ thuật giữa các mẫu gia dụng.',
    ],
    notSuitableForFormats: [
      'Người cần đánh giá độ bền và hiệu quả sau thời gian dài sử dụng.',
      'Người cần tư vấn lắp đặt chuyên nghiệp.',
    ],
  },
  beauty: {
    titleFormats: [
      'Đánh giá {title}: thành phần, giá và lưu ý khi sử dụng',
      '{title} — thông tin sản phẩm, giá tham khảo và gợi ý đối chiếu',
      'Tổng hợp dữ liệu {title}: nguồn gốc, giá và điều cần biết',
    ],
    summaryIntros: [
      '{title} là sản phẩm chăm sóc cá nhân thuộc nhóm {category}, hiện có giá tham khảo {price}.',
      'Theo nguồn đã ghi nhận, {title} thuộc nhóm {category} với giá niêm yết {price}.',
      '{title} — sản phẩm trong nhóm {category} — đang có giá {price} từ nguồn đã xác minh.',
    ],
    verdictFormats: [
      '{title} có thể phù hợp nếu thành phần đáp ứng yêu cầu da/tóc của bạn. Kiểm tra bảng thành phần kỹ trước khi sử dụng, đặc biệt nếu da nhạy cảm.',
      'Dựa trên dữ liệu sản phẩm, {title} đáng cân nhắc trong nhóm {category} ở tầm giá này. Nên thử trước trên vùng da nhỏ.',
      '{title} phù hợp để đưa vào danh sách so sánh nếu bạn đang tìm sản phẩm nhóm {category}. Hiệu quả thực tế cần xác minh qua trải nghiệm cá nhân.',
    ],
    buyingConsiderations: [
      'Kiểm tra bảng thành phần và hạn sử dụng.',
      'Thử trước trên vùng da nhỏ nếu da nhạy cảm.',
      'Đối chiếu giá với các kênh phân phối chính hãng.',
      'Xem xét dung tích/trọng lượng so với giá.',
    ],
    suitableForFormats: [
      'Người đang tìm sản phẩm {category} trong tầm giá {price}.',
      'Người muốn tham khảo thông tin sản phẩm trước khi thử.',
    ],
    notSuitableForFormats: [
      'Người cần đánh giá hiệu quả sau thời gian dài sử dụng.',
      'Người cần tư vấn từ chuyên gia da liễu cho tình trạng da đặc biệt.',
    ],
  },
  fashion: {
    titleFormats: [
      'Đánh giá {title}: chất liệu, giá và gợi ý phối đồ',
      '{title} — thông tin sản phẩm, giá tham khảo và lưu ý khi chọn',
      'Tổng hợp dữ liệu {title}: thiết kế, giá và điều nên biết',
    ],
    summaryIntros: [
      '{title} là sản phẩm thời trang thuộc nhóm {category}, hiện có giá tham khảo {price}.',
      'Theo nguồn đã ghi nhận, {title} — nhóm {category} — đang có giá niêm yết {price}.',
      '{title} thuộc nhóm {category}, giá tham khảo {price} từ nguồn đã xác minh.',
    ],
    verdictFormats: [
      '{title} đáng cân nhắc nếu kiểu dáng và chất liệu phù hợp với phong cách của bạn. Kiểm tra kỹ bảng size trước khi đặt hàng.',
      'Dựa trên dữ liệu hiện có, {title} có thể là lựa chọn trong nhóm {category} ở tầm giá này. Nên kiểm tra chính sách đổi trả.',
      '{title} phù hợp để xem xét nếu bạn đang tìm sản phẩm nhóm {category}. Chất liệu và độ bền cần xác minh qua sử dụng thực tế.',
    ],
    buyingConsiderations: [
      'Kiểm tra kỹ bảng size và hướng dẫn chọn cỡ.',
      'Xem chính sách đổi trả và hoàn tiền.',
      'Đối chiếu giá với các cửa hàng khác.',
      'Kiểm tra chất liệu và hướng dẫn bảo quản.',
    ],
    suitableForFormats: [
      'Người đang tìm sản phẩm {category} trong tầm giá {price}.',
      'Người muốn so sánh kiểu dáng và giá giữa các lựa chọn.',
    ],
    notSuitableForFormats: [
      'Người cần thử trực tiếp để xác nhận form dáng và chất liệu.',
      'Người cần sản phẩm có chứng nhận chất lượng cụ thể.',
    ],
  },
  food: {
    titleFormats: [
      'Đánh giá {title}: thành phần, giá và lưu ý sử dụng',
      '{title} — thông tin dinh dưỡng, giá tham khảo và gợi ý',
      'Tổng hợp dữ liệu {title}: nguồn gốc, giá và điều cần biết',
    ],
    summaryIntros: [
      '{title} là sản phẩm thực phẩm thuộc nhóm {category}, hiện có giá tham khảo {price}.',
      'Theo nguồn đã ghi nhận, {title} — nhóm {category} — đang có giá niêm yết {price}.',
      '{title} thuộc nhóm {category}, giá tham khảo {price} từ nguồn đã xác minh.',
    ],
    verdictFormats: [
      '{title} có thể phù hợp nếu thành phần dinh dưỡng đáp ứng nhu cầu của bạn. Kiểm tra hạn sử dụng và điều kiện bảo quản.',
      'Dựa trên dữ liệu sản phẩm, {title} đáng cân nhắc trong nhóm {category}. Nên đối chiếu thành phần với yêu cầu dinh dưỡng cá nhân.',
      '{title} phù hợp để đưa vào danh sách so sánh trong nhóm {category}. Hương vị và chất lượng cần xác minh trực tiếp.',
    ],
    buyingConsiderations: [
      'Kiểm tra hạn sử dụng và điều kiện bảo quản.',
      'Đọc kỹ bảng thành phần dinh dưỡng.',
      'Đối chiếu giá với các kênh phân phối khác.',
      'Kiểm tra chứng nhận an toàn thực phẩm.',
    ],
    suitableForFormats: [
      'Người đang tìm sản phẩm {category} trong tầm giá {price}.',
      'Người muốn đối chiếu thông tin dinh dưỡng trước khi mua.',
    ],
    notSuitableForFormats: [
      'Người cần đánh giá hương vị và chất lượng thực tế.',
      'Người có chế độ ăn đặc biệt cần tư vấn từ chuyên gia dinh dưỡng.',
    ],
  },
  baby: {
    titleFormats: [
      'Đánh giá {title}: an toàn, giá và lưu ý cho bé',
      '{title} — thông tin sản phẩm, giá tham khảo và gợi ý cho phụ huynh',
      'Tổng hợp dữ liệu {title}: chất lượng, giá và điều cần biết',
    ],
    summaryIntros: [
      '{title} là sản phẩm mẹ và bé thuộc nhóm {category}, hiện có giá tham khảo {price}.',
      'Theo nguồn đã ghi nhận, {title} — nhóm {category} — đang có giá niêm yết {price}.',
      '{title} thuộc nhóm sản phẩm {category}, giá tham khảo {price} từ nguồn đã xác minh.',
    ],
    verdictFormats: [
      '{title} có thể phù hợp nếu tiêu chuẩn an toàn đáp ứng yêu cầu cho bé. Kiểm tra kỹ chứng nhận an toàn và độ tuổi phù hợp.',
      'Dựa trên dữ liệu sản phẩm, {title} đáng cân nhắc trong nhóm {category}. Phụ huynh nên tham khảo ý kiến chuyên gia nếu cần.',
      '{title} phù hợp để xem xét nếu đang tìm sản phẩm {category}. An toàn và chất lượng thực tế cần xác minh trước khi sử dụng.',
    ],
    buyingConsiderations: [
      'Kiểm tra chứng nhận an toàn và độ tuổi phù hợp.',
      'Đọc kỹ thành phần và cảnh báo dị ứng.',
      'Tham khảo ý kiến bác sĩ nhi nếu cần.',
      'So sánh giá với các kênh phân phối chính hãng.',
    ],
    suitableForFormats: [
      'Phụ huynh đang tìm sản phẩm {category} trong tầm giá {price}.',
      'Người muốn đối chiếu thông tin sản phẩm trước khi mua cho bé.',
    ],
    notSuitableForFormats: [
      'Người cần tư vấn y tế chuyên sâu cho trẻ có tình trạng sức khỏe đặc biệt.',
      'Người cần đánh giá an toàn dựa trên thử nghiệm thực tế.',
    ],
  },
  accessories: {
    titleFormats: [
      'Đánh giá {title}: tương thích, giá và lưu ý chọn mua',
      '{title} — thông tin sản phẩm, giá tham khảo và gợi ý đối chiếu',
      'Tổng hợp dữ liệu {title}: tính năng, giá và điều nên biết',
    ],
    summaryIntros: [
      '{title} là phụ kiện thuộc nhóm {category}, hiện có giá tham khảo {price}.',
      'Theo nguồn đã ghi nhận, {title} — nhóm {category} — đang có giá niêm yết {price}.',
      '{title} thuộc nhóm {category}, giá tham khảo {price} từ nguồn đã xác minh.',
    ],
    verdictFormats: [
      '{title} đáng cân nhắc nếu tương thích với thiết bị bạn đang dùng. Kiểm tra kỹ phiên bản và kích thước trước khi mua.',
      'Dựa trên dữ liệu hiện có, {title} có thể phù hợp trong nhóm {category} ở tầm giá này. Nên kiểm tra độ tương thích thiết bị.',
      '{title} phù hợp để đưa vào danh sách so sánh nếu đang tìm phụ kiện nhóm {category}. Chất lượng cần xác minh qua sử dụng.',
    ],
    buyingConsiderations: [
      'Kiểm tra độ tương thích với thiết bị hiện có.',
      'Đối chiếu phiên bản và kích thước phù hợp.',
      'So sánh giá với các sản phẩm cùng loại.',
      'Kiểm tra chính sách đổi trả của người bán.',
    ],
    suitableForFormats: [
      'Người đang tìm phụ kiện {category} trong tầm giá {price}.',
      'Người muốn so sánh tính năng giữa các lựa chọn.',
    ],
    notSuitableForFormats: [
      'Người cần đánh giá độ bền và chất lượng sau thời gian dài sử dụng.',
      'Người cần phụ kiện chuyên dụng cho mục đích đặc thù.',
    ],
  },
  general: {
    titleFormats: [
      'Đánh giá {title}: dữ kiện, giá và điều cần cân nhắc',
      '{title} — thông tin sản phẩm, giá tham khảo và gợi ý',
      'Tổng hợp dữ liệu {title}: giá, thông số và lưu ý khi mua',
    ],
    summaryIntros: [
      '{title} là sản phẩm thuộc {category}, hiện có giá tham khảo {price} theo nguồn đã ghi nhận.',
      'Theo dữ liệu tại thời điểm kiểm tra, {title} thuộc nhóm {category} có giá niêm yết {price}.',
      '{title} — sản phẩm trong nhóm {category} — đang có giá tham khảo {price} từ nguồn đã xác minh.',
    ],
    verdictFormats: [
      '{title} đáng để đưa vào danh sách so sánh nếu các dữ kiện hiện có phù hợp với nhu cầu của bạn. Chưa có cơ sở để kết luận về trải nghiệm hoặc độ bền thực tế.',
      'Dựa trên dữ liệu hiện có, {title} có thể phù hợp nếu thông số đáp ứng yêu cầu. Nên kiểm tra thêm tại nguồn bán hàng.',
      '{title} phù hợp để cân nhắc trong nhóm {category} ở tầm giá này. Đối chiếu thêm đánh giá từ người dùng khác.',
    ],
    buyingConsiderations: [
      'Kiểm tra lại giá và tồn kho tại trang đối tác.',
      'Đọc chính sách đổi trả và bảo hành do nhà bán hàng công bố.',
      'Đối chiếu thông số cần thiết trước khi đặt hàng.',
    ],
    suitableForFormats: [
      'Người đang tìm sản phẩm {category} trong tầm giá {price}.',
      'Người muốn đối chiếu dữ liệu trước khi quyết định mua.',
    ],
    notSuitableForFormats: [
      'Người cần kết luận dựa trên thử nghiệm sử dụng thực tế hoặc dữ liệu độ bền dài hạn.',
    ],
  },
};

/**
 * Fill template placeholders with product data.
 */
function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || key);
}

/**
 * Build specification summary text from product specs.
 */
function buildSpecSummary(product: Product): string {
  const specs = product.specifications || {};
  const entries = Object.entries(specs).slice(0, 6);
  if (entries.length === 0) return '';
  const parts = entries.map(([key, value]) => `${cleanText(key, 40)}: ${typeof value === 'number' ? value : cleanText(value, 60)}`);
  return `Thông số ghi nhận: ${parts.join('; ')}.`;
}

/**
 * Build brand/source attribution text.
 */
function buildBrandAttribution(product: Product): string {
  const parts: string[] = [];
  const brand = cleanText(product.brand, 80);
  if (brand) parts.push(`Thương hiệu: ${brand}.`);
  if (product.sku) parts.push(`Mã SKU: ${cleanText(product.sku, 100)}.`);
  return parts.join(' ');
}

// ============================================================
// V2: Main editorial review generator
// ============================================================

export function generateEditorialReview(product: Product, otherProducts: Product[] = [], now = new Date().toISOString()): ReviewContent {
  const existingReview = product.reviewContent;
  // V2: Also regenerate if reviewVersion < CURRENT_REVIEW_VERSION
  if (existingReview && existingReview.sourceHash === product.sourceHash && existingReview.reviewContentHash && existingReview.reviewVersion >= CURRENT_REVIEW_VERSION) return existingReview;

  const facts = extractVerifiedProductFacts(product);
  const byId = new Map(facts.map((item) => [item.id, item]));
  const title = String(byId.get('title')?.value || product.title || 'Sản phẩm cần xem xét');
  const category = String(byId.get('category')?.value || 'nhóm sản phẩm này');
  const price = Number(byId.get('current_price')?.value || 0);
  const priceStr = price > 0 ? formatMoney(price) : 'chưa có giá tham khảo';

  // V2: Deterministic seed for variant selection
  const seed = product.id || product.sourceHash || product.slug || title;

  // V2: Category-aware template
  const detectedCategory = detectCategory(product);
  const template = CATEGORY_TEMPLATES[detectedCategory];

  // V2: Template variables
  const vars: Record<string, string> = { title, category, price: priceStr };

  // V2: Build product-specific content sections
  const specSummary = buildSpecSummary(product);
  const brandAttribution = buildBrandAttribution(product);
  const discount = byId.has('discount') ? `Mức giảm ghi nhận: ${byId.get('discount')?.value}% so với giá gốc ${formatMoney(Number(byId.get('original_price')?.value || 0))}.` : '';
  const healthNote = buildHealthNote(product);

  // V2: Select category-specific templates deterministically
  const reviewTitle = fillTemplate(pickVariant(template.titleFormats, `title-${seed}`), vars);

  let summary: string;
  if (facts.length >= 8) {
    const intro = fillTemplate(pickVariant(template.summaryIntros, `summary-${seed}`), vars);
    const additionalParts = [specSummary, brandAttribution, discount, healthNote].filter(Boolean);
    const dataSuffix = 'Dữ liệu liên kết và hình ảnh đã được kiểm tra kỹ thuật, nhưng SanDeal chưa trực tiếp sử dụng sản phẩm. Người mua nên đối chiếu giá, thông số và chính sách của nhà bán hàng trước khi quyết định.';
    summary = [intro, ...additionalParts, dataSuffix].join(' ');
  } else {
    summary = `${title} hiện chưa có đủ dữ kiện đã xác minh để tạo một bài đánh giá đầy đủ. SanDeal chỉ hiển thị thông tin ngắn và đề nghị kiểm tra thêm tại nguồn.`;
  }

  // V2: Category-specific factual claims with product-specific data
  const factualClaims = facts.filter((item) => ['current_price', 'original_price', 'discount', 'brand', 'category', 'product_health', 'affiliate_health', 'image_health'].includes(item.id))
    .map((item) => makeClaim(`fact_${item.id}`, `${item.label}: ${typeof item.value === 'number' && item.id.includes('price') ? formatMoney(item.value) : item.value}${item.id === 'discount' ? '%' : ''}.`, 'factual', [item.id], 'high'));

  // V2: Add specification-based claims for more unique content
  const specClaims = facts.filter((item) => item.id.startsWith('spec_')).slice(0, 4)
    .map((item) => makeClaim(`fact_${item.id}`, `${item.label}: ${item.value}.`, 'factual', [item.id], 'high'));
  factualClaims.push(...specClaims);

  // V2: Category-specific inferred claims
  const inferredClaims: EditorialClaim[] = [];
  if (byId.has('category')) {
    const audienceText = fillTemplate(
      pickVariant(template.suitableForFormats, `audience-${seed}`),
      vars,
    );
    inferredClaims.push(makeClaim('inference_audience', `Theo dữ liệu phân loại, sản phẩm có thể phù hợp để cân nhắc với ${audienceText.toLowerCase()}`, 'inferred', ['category'], 'medium'));
  }
  if (byId.has('discount')) {
    inferredClaims.push(makeClaim('inference_price', 'Theo dữ liệu giá hiện tại và giá gốc, mức giá đang thấp hơn giá tham chiếu; người mua vẫn nên kiểm tra lại tại thời điểm đặt hàng.', 'inferred', ['current_price', 'original_price', 'discount'], 'medium'));
  }

  const unknownClaims = [
    makeClaim('unknown_experience', 'SanDeal chưa có dữ liệu để xác minh trải nghiệm sử dụng thực tế.', 'unknown', [], 'unknown'),
    makeClaim('unknown_durability', 'Độ bền sau thời gian dài chưa được nguồn cung cấp hoặc SanDeal chưa có dữ liệu để xác minh.', 'unknown', [], 'unknown'),
    makeClaim('unknown_returns', 'Chính sách đổi trả và tốc độ giao hàng cần được kiểm tra trực tiếp với nhà bán hàng.', 'unknown', [], 'unknown'),
  ];

  // V2: Category-specific strengths with product data
  const strengths = [
    byId.has('current_price') ? makeClaim('strength_price', `Có giá tham khảo ${priceStr} bằng VND để người mua đối chiếu.`, 'factual', ['current_price', 'currency'], 'high') : null,
    byId.has('product_health') && byId.get('product_health')?.value === 'ok' ? makeClaim('strength_link', 'Liên kết sản phẩm đã vượt kiểm tra kỹ thuật gần nhất.', 'factual', ['product_health', 'checked_at'], 'high') : null,
    byId.has('image_health') && byId.get('image_health')?.value === 'ok' ? makeClaim('strength_image', 'Ảnh sản phẩm đã vượt kiểm tra định dạng và khả dụng.', 'factual', ['image_health', 'image'], 'high') : null,
    byId.has('brand') ? makeClaim('strength_brand', `Thương hiệu ${byId.get('brand')?.value} được ghi nhận từ nguồn dữ liệu.`, 'factual', ['brand'], 'high') : null,
    byId.has('discount') ? makeClaim('strength_discount', `Đang giảm ${byId.get('discount')?.value}% so với giá gốc theo dữ liệu ghi nhận.`, 'factual', ['discount', 'original_price', 'current_price'], 'high') : null,
  ].filter((item): item is EditorialClaim => Boolean(item));

  const limitations = unknownClaims.slice(0, 2);

  // V2: Category-specific buying considerations
  const buyingConsiderations = template.buyingConsiderations.slice(0, 4);

  // V2: Category-specific verdict
  const reviewVerdict = facts.length >= 8
    ? fillTemplate(pickVariant(template.verdictFormats, `verdict-${seed}`), vars)
    : 'Dữ liệu hiện tại chưa đủ để đưa ra kết luận biên tập đầy đủ.';

  // V2: Category-specific suitable/notSuitable
  const suitableFor = inferredClaims.length > 0
    ? [fillTemplate(pickVariant(template.suitableForFormats, `suitable-${seed}`), vars)]
    : [];
  const notSuitableFor = [fillTemplate(pickVariant(template.notSuitableForFormats, `notsuitable-${seed}`), vars)];

  const sourceConfidence = product.verifiedSource === true && facts.length >= 10 ? 'high' : facts.length >= 7 ? 'medium' : 'low';
  const dataQualityScore = Math.min(100, facts.length * 7 + (product.verifiedSource ? 15 : 0));
  const healthyStatuses = [product.linkHealthStatus, product.affiliateHealthStatus, product.imageHealthStatus]
    .filter((status) => status === 'ok' || status === 'redirect_ok').length;
  const productSafetyScore = Math.min(100, healthyStatuses * 25 + (product.verifiedSource ? 25 : 0));

  // V2: Enhanced content quality score with spec and brand bonuses
  const specCount = Object.keys(product.specifications || {}).length;
  const brandBonus = byId.has('brand') ? 4 : 0;
  const specBonus = Math.min(10, specCount * 2);
  const contentQualityScore = facts.length < 8
    ? Math.min(60, dataQualityScore)
    : Math.min(100, 58 + facts.length * 2 + strengths.length * 4 + inferredClaims.length * 3 + brandBonus + specBonus);

  const provisional: ReviewContent = {
    reviewStatus: 'generated', reviewVersion: CURRENT_REVIEW_VERSION, reviewMethod: 'source_data_analysis', reviewerType: 'automated_editorial',
    reviewDisclosure: REVIEW_DISCLOSURE, reviewTitle, reviewSummary: summary, reviewVerdict,
    suitableFor,
    notSuitableFor,
    keyFacts: facts, strengths, limitations,
    buyingConsiderations,
    factualClaims, inferredClaims, unknownClaims,
    evidenceSources: [{ name: String(product.source || 'canonical_product'), fields: [...new Set(facts.flatMap((item) => item.sourceField.split(',')))], checkedAt: product.linkLastCheckedAt || product.updatedAt }],
    sourceConfidence, dataQualityScore, productSafetyScore, contentQualityScore,
    originalityScore: 0, seoReadinessScore: 0, editorialConfidence: Math.round((dataQualityScore + productSafetyScore) / 2),
    reviewBlockReasons: [] as string[], reviewedAt: now, contentUpdatedAt: now,
    sourceHash: String(product.sourceHash || ''), reviewContentHash: '',
  };

  // V2: Originality — compare only distinctive text, exclude legal disclosures
  const comparisonTexts = [cleanText(product.description, 2000), ...otherProducts.map((item) => item.reviewContent ? reviewDistinctiveText(item.reviewContent) : '')].filter(Boolean);
  const maxSimilarity = comparisonTexts.reduce((max, text) => Math.max(max, textSimilarity(reviewDistinctiveText(provisional), text)), 0);
  provisional.originalityScore = Math.max(0, Math.round(100 - maxSimilarity * 100));

  // V2: Enhanced SEO readiness score
  provisional.seoReadinessScore = Math.min(100,
    (reviewTitle.length >= 25 ? 12 : 0)
    + (summary.length >= 160 ? 15 : 0)
    + (product.slug ? 10 : 0)
    + (product.imageHealthStatus === 'ok' ? 10 : 0)
    + (facts.length >= 8 ? 15 : 0)
    + (contentQualityScore >= 75 ? 15 : 0)
    + (provisional.originalityScore >= 70 ? 13 : 0)
    + (product.affiliateUrl ? 10 : 0)
  );

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

/**
 * Build a health note based on product link/image/affiliate status.
 */
function buildHealthNote(product: Product): string {
  const parts: string[] = [];
  if (product.linkHealthStatus === 'ok') parts.push('Liên kết sản phẩm đã vượt kiểm tra kỹ thuật');
  if (product.affiliateHealthStatus === 'ok') parts.push('liên kết affiliate hoạt động');
  if (product.imageHealthStatus === 'ok') parts.push('ảnh sản phẩm hợp lệ');
  if (parts.length === 0) return '';
  if (product.linkLastCheckedAt) {
    const checkedDate = new Date(product.linkLastCheckedAt);
    const dateStr = checkedDate.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `Tại thời điểm kiểm tra (${dateStr}): ${parts.join(', ')}.`;
  }
  return `Kiểm tra kỹ thuật: ${parts.join(', ')}.`;
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
  return !product.reviewContent
    || product.reviewContent.sourceHash !== product.sourceHash
    || product.reviewContent.reviewStatus === 'stale'
    || product.reviewContent.reviewVersion < CURRENT_REVIEW_VERSION; // V2: Force regeneration for V1 reviews
}
