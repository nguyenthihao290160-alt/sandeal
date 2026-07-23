export type ProductBlockerCategory =
  | 'DATA'
  | 'PROVENANCE_LINK'
  | 'AFFILIATE'
  | 'IMAGE'
  | 'PRICE'
  | 'DUPLICATE'
  | 'MERCHANT_POLICY'
  | 'CONTENT_POLICY';

export interface ProductBlockerGroup {
  category: ProductBlockerCategory;
  label: string;
  blockers: Array<{ code: string; label: string; critical: boolean }>;
}

const CATEGORY_LABELS: Record<ProductBlockerCategory, string> = {
  DATA: 'Dữ liệu',
  PROVENANCE_LINK: 'Liên kết & nguồn gốc',
  AFFILIATE: 'Affiliate',
  IMAGE: 'Hình ảnh',
  PRICE: 'Giá',
  DUPLICATE: 'Trùng lặp',
  MERCHANT_POLICY: 'Merchant & chính sách',
  CONTENT_POLICY: 'Nội dung & kiểm duyệt',
};

const BLOCKER_LABELS: Record<string, string> = {
  not_product: 'Bản ghi chưa được xác nhận là sản phẩm cụ thể.',
  archived: 'Sản phẩm đang được lưu trữ.',
  invalid_title: 'Tên sản phẩm chưa đủ rõ ràng.',
  invalid_slug: 'Định danh URL của sản phẩm chưa hợp lệ.',
  source_unverified: 'Nguồn sản phẩm chưa được xác minh.',
  missing_product_url: 'Thiếu URL sản phẩm gốc.',
  product_url_unhealthy: 'URL sản phẩm gốc chưa đạt kiểm tra sức khỏe.',
  product_health_stale: 'Kết quả kiểm tra URL sản phẩm đã cũ.',
  product_final_domain_missing: 'Chưa xác minh tên miền đích của sản phẩm.',
  missing_affiliate_url: 'Thiếu URL affiliate.',
  affiliate_url_unhealthy: 'URL affiliate chưa đạt kiểm tra sức khỏe.',
  affiliate_health_stale: 'Kết quả kiểm tra URL affiliate đã cũ.',
  affiliate_final_domain_missing: 'Chưa xác minh tên miền đích của URL affiliate.',
  affiliate_provenance_missing: 'Thiếu bằng chứng provenance của URL affiliate từ provider.',
  missing_image: 'Thiếu ảnh sản phẩm hợp lệ.',
  image_unhealthy: 'Ảnh sản phẩm chưa đạt kiểm tra sức khỏe.',
  image_health_stale: 'Kết quả kiểm tra ảnh đã cũ.',
  missing_price: 'Thiếu giá VND hợp lệ.',
  price_unverified: 'Giá chưa có mốc xác minh.',
  price_stale: 'Giá đã cũ, xung đột hoặc bất thường.',
  price_aging: 'Giá sắp hết hạn freshness.',
  duplicate_unresolved: 'Bằng chứng trùng lặp chưa được giải quyết.',
  merchant_quarantined_30shinestore: 'Merchant 30ShineStore đang bị quarantine theo chính sách.',
  cooldown: 'Nguồn đang trong thời gian chờ kiểm tra lại.',
  review_quality_unready: 'Review chưa vượt cổng chất lượng.',
  claims_unverified: 'Các claim chưa có đủ bằng chứng xác minh.',
  auto_publish_ineligible: 'Candidate chưa đủ điều kiện đi qua Safe Publish.',
  human_review_required: 'Mức rủi ro yêu cầu người vận hành xem xét.',
  prohibited_product: 'Sản phẩm bị chặn bởi chính sách nội dung.',
  medium_risk: 'Sản phẩm có mức rủi ro trung bình.',
  public_blocked: 'Sản phẩm đang bị chặn khỏi public.',
};

const ACTION_LABELS: Record<string, string> = {
  MANUAL_CLASSIFICATION_DECISION: 'Xác nhận đây là sản phẩm cụ thể.',
  FIX_CRITICAL_BLOCKERS: 'Xử lý các blocker nghiêm trọng trước.',
  KEEP_QUARANTINED: 'Giữ quarantine và xử lý blocker merchant/chính sách.',
  CLASSIFY_PRODUCT: 'Phân loại lại sản phẩm.',
  RECHECK_LINKS: 'Kiểm tra lại liên kết và provenance.',
  RECHECK_IMAGE: 'Kiểm tra lại ảnh sản phẩm.',
  VERIFY_PRICE: 'Xác minh lại giá nguồn.',
  VERIFY_SOURCE: 'Xác minh nguồn sản phẩm.',
  VERIFY_REVIEW_EVIDENCE: 'Bổ sung bằng chứng cho nội dung review.',
  HUMAN_REVIEW: 'Yêu cầu người vận hành xem xét.',
  MARK_PUBLISH_CANDIDATE: 'Xác nhận candidate đủ điều kiện đăng.',
  SAFE_PUBLISH_REVIEW: 'Chạy kiểm tra Safe Publish.',
  MARK_REVIEWED: 'Đánh dấu đã xem.',
  VERIFY_DATA: 'Xác nhận dữ liệu.',
  MARK_CANARY_READY: 'Đưa vào danh sách xét CANARY.',
  REQUEST_SAFE_PUBLISH_CHECK: 'Yêu cầu kiểm tra Safe Publish.',
  PUBLISH_APPROVAL_REQUIRED: 'Chờ phê duyệt đăng.',
  READY: 'Không còn hành động bắt buộc.',
};

export function localizeProductBlocker(codeValue: string): string {
  const code = String(codeValue || '').trim();
  if (!code) return 'Blocker chưa xác định.';
  const normalized = code.replace(/^stored:/, '');
  if (BLOCKER_LABELS[normalized]) return BLOCKER_LABELS[normalized];
  if (normalized.startsWith('review:')) {
    const detail = normalized.slice('review:'.length).replace(/_/g, ' ').trim();
    return detail ? `Review cần xử lý: ${detail}.` : 'Review cần được kiểm tra lại.';
  }
  if (/quarantin/i.test(normalized)) return 'Merchant hoặc sản phẩm đang bị quarantine theo chính sách.';
  return normalized.replace(/[_:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function categorizeProductBlocker(codeValue: string): ProductBlockerCategory {
  const code = String(codeValue || '').toLowerCase();
  if (/merchant|quarant|prohibited|policy/.test(code)) return 'MERCHANT_POLICY';
  if (/duplicate|trùng/.test(code)) return 'DUPLICATE';
  if (/affiliate/.test(code)) return 'AFFILIATE';
  if (/image|ảnh/.test(code)) return 'IMAGE';
  if (/price|giá/.test(code)) return 'PRICE';
  if (/product_url|link|domain|provenance|source_health/.test(code)) return 'PROVENANCE_LINK';
  if (/review|claim|content|publish|risk|human/.test(code)) return 'CONTENT_POLICY';
  return 'DATA';
}

export function localizeProductRequiredAction(action: string | null | undefined): string {
  if (!action) return 'Không có hành động bắt buộc.';
  return ACTION_LABELS[action] || action.replace(/_/g, ' ').toLowerCase();
}

export function deriveProductRemediationSummary(
  blockers: string[],
  criticalBlockers: string[],
  requiredAction?: string | null,
): {
  total: number;
  critical: number;
  groups: ProductBlockerGroup[];
  nextAction: string;
  merchantQuarantined: boolean;
} {
  const uniqueBlockers = [...new Set(blockers.map(String).filter(Boolean))];
  const critical = new Set(criticalBlockers.map(String).filter(Boolean));
  const groupMap = new Map<ProductBlockerCategory, ProductBlockerGroup>();
  for (const code of uniqueBlockers) {
    const category = categorizeProductBlocker(code);
    const group = groupMap.get(category) || { category, label: CATEGORY_LABELS[category], blockers: [] };
    group.blockers.push({ code, label: localizeProductBlocker(code), critical: critical.has(code) });
    groupMap.set(category, group);
  }
  const order: ProductBlockerCategory[] = ['MERCHANT_POLICY', 'PROVENANCE_LINK', 'AFFILIATE', 'IMAGE', 'PRICE', 'DUPLICATE', 'DATA', 'CONTENT_POLICY'];
  return {
    total: uniqueBlockers.length,
    critical: uniqueBlockers.filter((code) => critical.has(code)).length,
    groups: order.map((category) => groupMap.get(category)).filter((group): group is ProductBlockerGroup => Boolean(group)),
    nextAction: localizeProductRequiredAction(requiredAction),
    merchantQuarantined: uniqueBlockers.some((code) => /merchant|quarant/i.test(code)),
  };
}

const SECRET_KEY_PATTERN = /(?:api.?key|secret|password|authorization|cookie|encrypted|credential|access.?token|refresh.?token|basic.?auth)/i;
const SECRET_QUERY_PATTERN = /^(?:key|api_?key|token|access_?token|auth|authorization|cookie|secret)$/i;

function sanitizeTechnicalString(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_PATTERN.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeProductTechnicalDetails(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitizeProductTechnicalDetails(entry, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? sanitizeTechnicalString(value) : value;
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      safe[key] = '[REDACTED]';
      continue;
    }
    safe[key] = sanitizeProductTechnicalDetails(entry, depth + 1);
  }
  return safe;
}
