// ===========================================
// Compliance Guard — Content safety checker
// ===========================================

export type ComplianceStatus = 'safe' | 'needs_review' | 'blocked';

export interface ComplianceResult {
  status: ComplianceStatus;
  flags: ComplianceFlag[];
  suggestions: string[];
  score: number; // 0-100, higher = safer
}

export interface ComplianceFlag {
  type: 'dangerous_claim' | 'fake_experience' | 'exaggeration' | 'missing_disclosure' | 'medical_financial';
  text: string;
  severity: 'warning' | 'error';
  suggestion: string;
}

// Patterns that should be flagged
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; type: ComplianceFlag['type']; severity: ComplianceFlag['severity']; suggestion: string }> = [
  // Fake personal experience claims
  { pattern: /tôi đã dùng/gi, type: 'fake_experience', severity: 'warning', suggestion: 'Thay bằng "theo thông tin sản phẩm" hoặc "nhiều người dùng phản hồi"' },
  { pattern: /tôi đã sử dụng/gi, type: 'fake_experience', severity: 'warning', suggestion: 'Thay bằng "theo đánh giá của người mua"' },
  { pattern: /mình đã thử/gi, type: 'fake_experience', severity: 'warning', suggestion: 'Thay bằng "theo mô tả sản phẩm"' },

  // Exaggerated claims
  { pattern: /tốt nhất/gi, type: 'exaggeration', severity: 'warning', suggestion: 'Thay bằng "được đánh giá cao" hoặc "phổ biến"' },
  { pattern: /chắc chắn/gi, type: 'exaggeration', severity: 'warning', suggestion: 'Thay bằng "có thể" hoặc "theo nhiều đánh giá"' },
  { pattern: /cam kết/gi, type: 'exaggeration', severity: 'warning', suggestion: 'Thay bằng "theo chính sách nhà bán"' },
  { pattern: /100%/gi, type: 'exaggeration', severity: 'warning', suggestion: 'Tránh dùng số % tuyệt đối, thay bằng "phần lớn" hoặc "nhiều người"' },
  { pattern: /số 1/gi, type: 'exaggeration', severity: 'warning', suggestion: 'Cần dẫn nguồn nếu dùng "số 1"' },

  // Medical / financial claims
  { pattern: /trị khỏi/gi, type: 'medical_financial', severity: 'error', suggestion: 'Không được khẳng định trị khỏi bệnh. Thay bằng "có thể hỗ trợ"' },
  { pattern: /giảm cân thần tốc/gi, type: 'medical_financial', severity: 'error', suggestion: 'Tránh quảng cáo giảm cân quá mức. Thay bằng "hỗ trợ kiểm soát cân nặng"' },
  { pattern: /chữa bệnh/gi, type: 'medical_financial', severity: 'error', suggestion: 'Không được khẳng định chữa bệnh. Thay bằng "hỗ trợ sức khỏe"' },
  { pattern: /kiếm tiền nhanh/gi, type: 'medical_financial', severity: 'error', suggestion: 'Tránh hứa hẹn tài chính. Thay bằng "có tiềm năng thu nhập"' },
  { pattern: /làm giàu/gi, type: 'medical_financial', severity: 'error', suggestion: 'Tránh hứa hẹn tài chính quá mức' },
];

// Safe phrases that should be included
const REQUIRED_SAFE_PHRASES = [
  'theo thông tin sản phẩm',
  'có thể phù hợp',
  'giá có thể thay đổi',
  'nên kiểm tra lại trước khi mua',
];

/**
 * Analyze content for compliance issues.
 * Returns flags, suggestions, and overall status.
 */
export function checkCompliance(content: string): ComplianceResult {
  const flags: ComplianceFlag[] = [];

  // Check for dangerous patterns
  for (const { pattern, type, severity, suggestion } of DANGEROUS_PATTERNS) {
    const matches = content.match(pattern);
    if (matches) {
      for (const match of matches) {
        flags.push({
          type,
          text: match,
          severity,
          suggestion,
        });
      }
    }
  }

  // Check for missing safe phrases — suggest but don't block
  const hasSafePhrase = REQUIRED_SAFE_PHRASES.some(phrase =>
    content.toLowerCase().includes(phrase.toLowerCase())
  );

  const suggestions: string[] = [];
  if (!hasSafePhrase) {
    suggestions.push(
      'Nên thêm cụm từ an toàn: "theo thông tin sản phẩm", "giá có thể thay đổi", "nên kiểm tra lại trước khi mua"'
    );
  }

  // Calculate safety score
  const errorCount = flags.filter(f => f.severity === 'error').length;
  const warningCount = flags.filter(f => f.severity === 'warning').length;
  const score = Math.max(0, 100 - errorCount * 30 - warningCount * 10 - (hasSafePhrase ? 0 : 5));

  // Determine status
  let status: ComplianceStatus = 'safe';
  if (errorCount > 0) {
    status = 'blocked';
  } else if (warningCount > 0 || !hasSafePhrase) {
    status = 'needs_review';
  }

  return { status, flags, suggestions, score };
}

/** Get Vietnamese label for compliance status */
export function getComplianceLabel(status: ComplianceStatus): string {
  switch (status) {
    case 'safe': return 'An toàn';
    case 'needs_review': return 'Cần xem xét';
    case 'blocked': return 'Bị chặn — vi phạm nội dung';
  }
}
