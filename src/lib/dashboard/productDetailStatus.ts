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

export type ProductRootCauseId =
  | 'MERCHANT_POLICY'
  | 'PRODUCT_URL'
  | 'AFFILIATE_URL'
  | 'IMAGE'
  | 'PRICE'
  | 'EVIDENCE'
  | 'CONTENT_REVIEW'
  | 'PUBLISHING'
  | 'DUPLICATE'
  | 'DATA';

export interface ProductRootCause {
  id: ProductRootCauseId;
  label: string;
  explanation: string;
  downstreamEffect: string;
  blockers: Array<{ code: string; label: string; critical: boolean }>;
  criticalCount: number;
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
  invalid_product_url_source: 'URL sản phẩm do nguồn cung cấp không hợp lệ.',
  product_url_unhealthy: 'URL sản phẩm gốc chưa đạt kiểm tra sức khỏe.',
  product_health_stale: 'Kết quả kiểm tra URL sản phẩm đã cũ.',
  product_final_domain_missing: 'Chưa xác minh tên miền đích của sản phẩm.',
  canonical_url_unverified: 'URL chuẩn của sản phẩm chưa được xác minh.',
  canonical_provenance_missing: 'Thiếu bằng chứng nguồn gốc hợp lệ cho URL sản phẩm.',
  missing_affiliate_url: 'Thiếu URL affiliate.',
  invalid_affiliate_url_source: 'URL affiliate do nguồn cung cấp không hợp lệ.',
  affiliate_url_unhealthy: 'URL affiliate chưa đạt kiểm tra sức khỏe.',
  affiliate_health_stale: 'Kết quả kiểm tra URL affiliate đã cũ.',
  affiliate_final_domain_missing: 'Chưa xác minh tên miền đích của URL affiliate.',
  affiliate_provenance_missing: 'Thiếu bằng chứng provenance của URL affiliate từ provider.',
  affiliate_url_unverified: 'URL affiliate chưa được xác minh.',
  missing_image: 'Thiếu ảnh sản phẩm hợp lệ.',
  invalid_image_url_source: 'URL ảnh do nguồn cung cấp không hợp lệ.',
  image_https_required: 'Ảnh nguồn chưa sử dụng HTTPS.',
  image_unhealthy: 'Ảnh sản phẩm chưa đạt kiểm tra sức khỏe.',
  image_health_stale: 'Kết quả kiểm tra ảnh đã cũ.',
  image_http_not_200: 'Máy chủ ảnh không trả về HTTP 200.',
  image_content_type_invalid: 'Phản hồi ảnh không có định dạng nội dung ảnh hợp lệ.',
  image_unverified: 'Ảnh sản phẩm chưa được xác minh.',
  missing_price: 'Thiếu giá VND hợp lệ.',
  invalid_price_source: 'Giá do nguồn cung cấp không hợp lệ.',
  price_unverified: 'Giá chưa có mốc xác minh.',
  price_stale: 'Giá đã cũ, xung đột hoặc bất thường.',
  price_stale_or_unverified: 'Giá chưa được xác minh hoặc đã quá hạn.',
  price_aging: 'Giá sắp hết hạn freshness.',
  duplicate_unresolved: 'Bằng chứng trùng lặp chưa được giải quyết.',
  merchant_quarantined_30shinestore: 'Merchant 30ShineStore đang bị quarantine theo chính sách.',
  cooldown: 'Nguồn đang trong thời gian chờ kiểm tra lại.',
  review_quality_unready: 'Review chưa vượt cổng chất lượng.',
  claims_unverified: 'Các claim chưa có đủ bằng chứng xác minh.',
  review_missing: 'Chưa có nội dung review.',
  review_not_approved: 'Review chưa được phê duyệt.',
  review_source_stale: 'Nguồn dùng cho review đã cũ.',
  review_thin_content: 'Nội dung review chưa đủ chiều sâu.',
  unsupported_claims: 'Review có nhận định chưa được bằng chứng hỗ trợ.',
  affiliate_disclosure_missing: 'Review thiếu công bố tiếp thị liên kết.',
  hands_on_evidence_unavailable: 'Không có bằng chứng cho tuyên bố đã trực tiếp trải nghiệm.',
  review_unbalanced: 'Review chưa nêu đủ giới hạn hoặc đối tượng không phù hợp.',
  unsupported_promotional_claim: 'Có tuyên bố quảng bá chưa được bằng chứng hỗ trợ.',
  duplicate_source_copy: 'Nội dung review trùng với mô tả nguồn.',
  low_content_quality: 'Chất lượng nội dung chưa đạt ngưỡng.',
  low_originality: 'Mức độ nguyên bản của nội dung chưa đạt ngưỡng.',
  low_seo_readiness: 'Mức sẵn sàng SEO chưa đạt ngưỡng.',
  review_quality_below_threshold: 'Điểm chất lượng review dưới ngưỡng cho phép.',
  unknown_claims_disclosed: 'Review có claim chưa xác minh nhưng đã được công bố.',
  source_coverage_low: 'Mức bao phủ bằng chứng nguồn còn thấp.',
  review_aging: 'Review sắp quá hạn.',
  health_verification_aging: 'Kết quả xác minh liên kết sắp quá hạn.',
  auto_publish_ineligible: 'Candidate chưa đủ điều kiện đi qua Safe Publish.',
  human_review_required: 'Mức rủi ro yêu cầu người vận hành xem xét.',
  prohibited_product: 'Sản phẩm bị chặn bởi chính sách nội dung.',
  medium_risk: 'Sản phẩm có mức rủi ro trung bình.',
  public_hidden: 'Sản phẩm đang bị ẩn khỏi public.',
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

const ROOT_CAUSE_ORDER: ProductRootCauseId[] = [
  'MERCHANT_POLICY',
  'PRODUCT_URL',
  'AFFILIATE_URL',
  'IMAGE',
  'PRICE',
  'EVIDENCE',
  'CONTENT_REVIEW',
  'PUBLISHING',
  'DUPLICATE',
  'DATA',
];

const ROOT_CAUSE_META: Record<ProductRootCauseId, Pick<ProductRootCause, 'label' | 'explanation' | 'downstreamEffect'>> = {
  MERCHANT_POLICY: {
    label: 'Merchant hoặc chính sách',
    explanation: 'Quarantine và các quyết định chính sách phải được xử lý trước các bước xuất bản.',
    downstreamEffect: 'Sau khi chính sách được xử lý hợp lệ, các cổng review, CANARY và Safe Publish mới có thể được đánh giá lại.',
  },
  PRODUCT_URL: {
    label: 'URL sản phẩm',
    explanation: 'Đích sản phẩm hoặc bằng chứng nguồn gốc của URL chưa được xác minh an toàn.',
    downstreamEffect: 'Kiểm tra thành công có thể gỡ các lỗi sức khỏe, độ mới, tên miền đích và trạng thái xác minh URL sản phẩm.',
  },
  AFFILIATE_URL: {
    label: 'URL affiliate',
    explanation: 'Liên kết affiliate, đích chuyển hướng hoặc provenance chưa đủ bằng chứng.',
    downstreamEffect: 'Kiểm tra hoặc tạo lại liên kết hợp lệ có thể gỡ các lỗi sức khỏe, độ mới, tên miền đích và xác minh affiliate.',
  },
  IMAGE: {
    label: 'Hình ảnh',
    explanation: 'Ảnh chưa vượt kiểm tra HTTP, định dạng nội dung hoặc độ mới.',
    downstreamEffect: 'Một lần kiểm tra ảnh thành công có thể gỡ các lỗi HTTP, Content-Type, sức khỏe và trạng thái xác minh ảnh.',
  },
  PRICE: {
    label: 'Giá',
    explanation: 'Giá chưa có bằng chứng xác minh đủ mới hoặc đang có xung đột.',
    downstreamEffect: 'Xác minh giá nguồn có thể gỡ trạng thái chưa xác minh, quá hạn và các blocker review phụ thuộc giá.',
  },
  EVIDENCE: {
    label: 'Bằng chứng và claim',
    explanation: 'Một hoặc nhiều nhận định chưa liên kết với bằng chứng đủ mạnh.',
    downstreamEffect: 'Bổ sung hoặc loại bỏ claim không có căn cứ có thể cải thiện chất lượng review và điều kiện xuất bản.',
  },
  CONTENT_REVIEW: {
    label: 'Nội dung và review',
    explanation: 'Review chưa đạt yêu cầu phê duyệt, độ mới, chất lượng hoặc tính nguyên bản.',
    downstreamEffect: 'Review đạt chuẩn sẽ gỡ các blocker chất lượng nội dung; không tự sửa lỗi URL, ảnh, giá hoặc chính sách.',
  },
  PUBLISHING: {
    label: 'Điều kiện xuất bản',
    explanation: 'Cổng xuất bản vẫn đóng do các điều kiện đầu vào chưa hoàn tất.',
    downstreamEffect: 'Blocker tổng hợp này chỉ được đánh giá lại sau khi các nguyên nhân gốc phía trên đã được xử lý.',
  },
  DUPLICATE: {
    label: 'Trùng lặp',
    explanation: 'Bằng chứng trùng lặp chưa có quyết định hợp nhất hoặc loại trừ.',
    downstreamEffect: 'Giải quyết cụm trùng sẽ ngăn tạo bản ghi cạnh tranh và cho phép đánh giá lại điều kiện xuất bản.',
  },
  DATA: {
    label: 'Dữ liệu nền',
    explanation: 'Bản ghi còn thiếu hoặc có dữ liệu nền chưa hợp lệ.',
    downstreamEffect: 'Hoàn thiện dữ liệu nền cho phép hệ thống chạy lại các bước xác minh và chấm điểm liên quan.',
  },
};

export function localizeProductBlocker(codeValue: string): string {
  const code = String(codeValue || '').trim();
  if (!code) return 'Blocker chưa xác định.';
  const normalized = code.replace(/^(?:stored:)+/, '');
  if (BLOCKER_LABELS[normalized]) return BLOCKER_LABELS[normalized];
  if (normalized.startsWith('review:')) {
    const detail = normalized.slice('review:'.length).trim();
    if (BLOCKER_LABELS[detail]) return BLOCKER_LABELS[detail];
    return 'Review có một blocker kỹ thuật chưa được gắn nhãn; mở chi tiết kỹ thuật để xem mã.';
  }
  if (/quarantin/i.test(normalized)) return 'Merchant hoặc sản phẩm đang bị quarantine theo chính sách.';
  return 'Blocker kỹ thuật chưa được gắn nhãn; mở chi tiết kỹ thuật để xem mã.';
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
  return ACTION_LABELS[action] || 'Mở chi tiết kỹ thuật để xem hành động được hệ thống yêu cầu.';
}

function rootCauseForBlocker(codeValue: string): ProductRootCauseId {
  const code = String(codeValue || '').replace(/^(?:stored:)+/, '').replace(/^review:/, '').toLowerCase();
  if (/merchant|quarant|prohibited|policy/.test(code)) return 'MERCHANT_POLICY';
  if (/affiliate_disclosure/.test(code)) return 'CONTENT_REVIEW';
  if (/affiliate/.test(code)) return 'AFFILIATE_URL';
  if (/product_url|canonical_url|canonical_provenance|product_health|product_final_domain/.test(code)) return 'PRODUCT_URL';
  if (/image/.test(code)) return 'IMAGE';
  if (/price/.test(code)) return 'PRICE';
  if (/claim|evidence|hands_on/.test(code)) return 'EVIDENCE';
  if (/auto_publish|public_(?:hidden|blocked)|publish_candidate/.test(code)) return 'PUBLISHING';
  if (/review|content|seo|originality|source_copy|disclosure/.test(code)) return 'CONTENT_REVIEW';
  if (/duplicate/.test(code)) return 'DUPLICATE';
  return 'DATA';
}

export function deriveProductRemediationSummary(
  blockers: string[],
  criticalBlockers: string[],
  requiredAction?: string | null,
): {
  total: number;
  critical: number;
  groups: ProductBlockerGroup[];
  rootCauses: ProductRootCause[];
  nextAction: string;
  merchantQuarantined: boolean;
} {
  const normalizeCode = (value: unknown) => String(value || '').replace(/^(?:stored:)+/, '').trim();
  const uniqueBlockers = [...new Set(blockers.map(normalizeCode).filter(Boolean))];
  const critical = new Set(criticalBlockers.map(normalizeCode).filter(Boolean));
  const groupMap = new Map<ProductBlockerCategory, ProductBlockerGroup>();
  for (const code of uniqueBlockers) {
    const category = categorizeProductBlocker(code);
    const group = groupMap.get(category) || { category, label: CATEGORY_LABELS[category], blockers: [] };
    group.blockers.push({ code, label: localizeProductBlocker(code), critical: critical.has(code) });
    groupMap.set(category, group);
  }
  const order: ProductBlockerCategory[] = ['MERCHANT_POLICY', 'PROVENANCE_LINK', 'AFFILIATE', 'IMAGE', 'PRICE', 'DUPLICATE', 'DATA', 'CONTENT_POLICY'];
  const groups = order.map((category) => groupMap.get(category)).filter((group): group is ProductBlockerGroup => Boolean(group));
  for (const group of groups) {
    group.blockers.sort((left, right) => Number(right.critical) - Number(left.critical) || left.code.localeCompare(right.code));
  }
  const rootCauseMap = new Map<ProductRootCauseId, ProductRootCause>();
  for (const code of uniqueBlockers) {
    const id = rootCauseForBlocker(code);
    const meta = ROOT_CAUSE_META[id];
    const current = rootCauseMap.get(id) || {
      id,
      ...meta,
      blockers: [],
      criticalCount: 0,
    };
    const isCritical = critical.has(code);
    current.blockers.push({ code, label: localizeProductBlocker(code), critical: isCritical });
    if (isCritical) current.criticalCount += 1;
    rootCauseMap.set(id, current);
  }
  const rootCauses = ROOT_CAUSE_ORDER
    .map((id) => rootCauseMap.get(id))
    .filter((rootCause): rootCause is ProductRootCause => Boolean(rootCause));
  for (const rootCause of rootCauses) {
    rootCause.blockers.sort((left, right) => Number(right.critical) - Number(left.critical) || left.code.localeCompare(right.code));
  }
  return {
    total: uniqueBlockers.length,
    critical: uniqueBlockers.filter((code) => critical.has(code)).length,
    groups,
    rootCauses,
    nextAction: localizeProductRequiredAction(requiredAction),
    merchantQuarantined: uniqueBlockers.some((code) => /merchant|quarant/i.test(code)),
  };
}

const SECRET_KEY_PATTERN = /(?:api.?key|secret|password|authorization|cookie|encrypted|credential|access.?token|refresh.?token|basic.?auth)/i;
const SECRET_QUERY_PATTERN = /^(?:key|api_?key|token|access_?token|auth|authorization|cookie|secret|password|signature|sig|credential|policy|expires|x-amz-.+)$/i;

function sanitizeTechnicalString(value: string): string {
  const withoutBearer = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  if (!/^https?:\/\//i.test(withoutBearer)) return withoutBearer.slice(0, 2_000);
  try {
    const url = new URL(withoutBearer);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_PATTERN.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    url.hash = '';
    return url.toString().slice(0, 2_000);
  } catch {
    return withoutBearer.slice(0, 2_000);
  }
}

export function sanitizeProductTechnicalDetails(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeProductTechnicalDetails(entry, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? sanitizeTechnicalString(value) : value;
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      safe[key] = '[REDACTED]';
      continue;
    }
    safe[key] = sanitizeProductTechnicalDetails(entry, depth + 1);
  }
  return safe;
}
