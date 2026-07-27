import { createHash } from 'crypto';

import { getFeatureRolloutState, type FeatureRolloutMode } from '@/lib/automation/featureRollout';
import type { Product } from '@/lib/types';

export const SMART_CATEGORY_SCHEMA_VERSION = 1;
export const SMART_CATEGORY_RULE_VERSION = 'vi-taxonomy-evidence-v1';

const MAX_FIELD_LENGTH = 8_192;
const MAX_TAGS = 32;
const MIN_SCORE = 2.5;
const ACTIVE_MIN_CONFIDENCE = 0.72;
const ACTIVE_MIN_MARGIN = 0.2;

export interface SmartCategoryInput {
  title?: string;
  description?: string;
  tags?: string[];
  brand?: string;
  merchant?: string;
}

export interface SmartCategoryEvidence {
  field: 'title' | 'description' | 'tags' | 'brand' | 'merchant';
  term: string;
  weight: number;
  valueHash: string;
}

export interface SmartCategoryResult {
  schemaVersion: number;
  ruleVersion: string;
  category: string;
  label: string;
  confidence: number;
  margin: number;
  score: number;
  evaluatedAt: string;
  inputHash: string;
  evidence: SmartCategoryEvidence[];
}

interface CategoryRule {
  category: string;
  label: string;
  terms: string[];
}

const TAXONOMY: readonly CategoryRule[] = [
  {
    category: 'dien-tu-cong-nghe',
    label: 'Điện tử & Công nghệ',
    terms: ['dien thoai', 'laptop', 'may tinh', 'tai nghe', 'smartphone', 'tablet', 'camera', 'ban phim', 'chuot gaming', 'sac du phong'],
  },
  {
    category: 'gia-dung-doi-song',
    label: 'Gia dụng & Đời sống',
    terms: ['noi chien', 'may hut bui', 'may loc khong khi', 'tu lanh', 'may giat', 'bep dien', 'noi com', 'gia dung', 'dieu hoa', 'quat dieu hoa'],
  },
  {
    category: 'thoi-trang',
    label: 'Thời trang',
    terms: ['ao so mi', 'ao khoac', 'quan jean', 'dam nu', 'vay nu', 'giay sneaker', 'tui xach', 'thoi trang', 'dong ho', 'dep nu'],
  },
  {
    category: 'lam-dep',
    label: 'Làm đẹp',
    terms: ['son moi', 'kem chong nang', 'serum', 'sua rua mat', 'duong da', 'my pham', 'nuoc hoa', 'mat na', 'trang diem', 'cham soc toc'],
  },
  {
    category: 'suc-khoe',
    label: 'Sức khỏe',
    terms: ['vitamin', 'thuc pham chuc nang', 'may do huyet ap', 'khau trang', 'cham soc suc khoe', 'dau ca', 'can dien tu', 'dung cu y te'],
  },
  {
    category: 'me-va-be',
    label: 'Mẹ & Bé',
    terms: ['bim ta', 'sua bot', 'xe day', 'do choi tre em', 'me va be', 'binh sua', 'ghe an dam', 'quan ao be', 'tre so sinh'],
  },
  {
    category: 'the-thao-da-ngoai',
    label: 'Thể thao & Dã ngoại',
    terms: ['giay chay bo', 'quan vot', 'bong da', 'yoga', 'leu cam trai', 'the thao', 'xe dap', 'tap gym', 'da ngoai'],
  },
  {
    category: 'thuc-pham-do-uong',
    label: 'Thực phẩm & Đồ uống',
    terms: ['ca phe', 'tra sua', 'banh keo', 'gao', 'nuoc ep', 'do uong', 'thuc pham', 'hat dinh duong', 'mi an lien'],
  },
  {
    category: 'sach-giao-duc',
    label: 'Sách & Giáo dục',
    terms: ['sach giao khoa', 'sach tieng anh', 'khoa hoc', 'giao trinh', 'van phong pham', 'but may', 'sach ky nang', 'hoc truc tuyen'],
  },
  {
    category: 'du-lich-dich-vu',
    label: 'Du lịch & Dịch vụ',
    terms: ['ve may bay', 'khach san', 'tour du lich', 'bao hiem du lich', 'dat phong', 'resort', 'combo du lich', 'visa du lich'],
  },
] as const;

const FIELD_WEIGHTS: Readonly<Record<SmartCategoryEvidence['field'], number>> = {
  title: 3,
  description: 1,
  tags: 2.5,
  brand: 1.25,
  merchant: 1,
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeVietnameseCategoryText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, MAX_FIELD_LENGTH)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedFields(input: SmartCategoryInput): Record<SmartCategoryEvidence['field'], string> {
  return {
    title: normalizeVietnameseCategoryText(input.title),
    description: normalizeVietnameseCategoryText(input.description),
    tags: normalizeVietnameseCategoryText((input.tags || []).slice(0, MAX_TAGS).join(' ')),
    brand: normalizeVietnameseCategoryText(input.brand),
    merchant: normalizeVietnameseCategoryText(input.merchant),
  };
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function categorizeVietnameseProduct(
  input: SmartCategoryInput,
  now = Date.now(),
): SmartCategoryResult | null {
  const fields = normalizedFields(input);
  const inputHash = hash(JSON.stringify(fields));
  const ranked = TAXONOMY.map(rule => {
    const evidence: SmartCategoryEvidence[] = [];
    for (const [field, text] of Object.entries(fields) as Array<[SmartCategoryEvidence['field'], string]>) {
      if (!text) continue;
      for (const rawTerm of rule.terms) {
        const term = normalizeVietnameseCategoryText(rawTerm);
        if (!term || !text.includes(term)) continue;
        evidence.push({
          field,
          term,
          weight: FIELD_WEIGHTS[field],
          valueHash: hash(text),
        });
      }
    }
    const score = evidence.reduce((total, item) => total + item.weight, 0);
    return { ...rule, evidence, score };
  }).sort((left, right) => (
    right.score - left.score
    || left.category.localeCompare(right.category)
  ));

  const winner = ranked[0];
  if (!winner || winner.score < MIN_SCORE) return null;
  const runnerUp = ranked[1]?.score || 0;
  const confidence = winner.score / (winner.score + 2);
  const margin = (winner.score - runnerUp) / Math.max(winner.score, 1);

  return {
    schemaVersion: SMART_CATEGORY_SCHEMA_VERSION,
    ruleVersion: SMART_CATEGORY_RULE_VERSION,
    category: winner.category,
    label: winner.label,
    confidence: rounded(confidence),
    margin: rounded(margin),
    score: rounded(winner.score),
    evaluatedAt: new Date(now).toISOString(),
    inputHash,
    evidence: winner.evidence
      .sort((left, right) => right.weight - left.weight || left.term.localeCompare(right.term))
      .slice(0, 16),
  };
}

export interface SmartCategoryEvaluation {
  total: number;
  classified: number;
  correct: number;
  accuracy: number;
  coverage: number;
  failures: Array<{ id: string; expected: string; actual: string | null }>;
}

export interface SmartCategoryGoldenCase extends SmartCategoryInput {
  id: string;
  expectedCategory: string;
}

export function evaluateSmartCategoryGoldenDataset(
  cases: readonly SmartCategoryGoldenCase[],
): SmartCategoryEvaluation {
  if (cases.length < 20 || cases.length > 1_000) {
    throw new Error('SMART_CATEGORY_GOLDEN_DATASET_SIZE_INVALID');
  }
  let classified = 0;
  let correct = 0;
  const failures: SmartCategoryEvaluation['failures'] = [];
  cases.forEach((item, index) => {
    const result = categorizeVietnameseProduct(item, Date.UTC(2026, 0, 1) + index);
    if (result) classified += 1;
    if (result?.category === item.expectedCategory) {
      correct += 1;
    } else {
      failures.push({
        id: String(item.id).slice(0, 80),
        expected: String(item.expectedCategory).slice(0, 80),
        actual: result?.category || null,
      });
    }
  });
  return {
    total: cases.length,
    classified,
    correct,
    accuracy: rounded(correct / cases.length),
    coverage: rounded(classified / cases.length),
    failures,
  };
}

export interface SmartCategoryApplication {
  product: Product;
  result: SmartCategoryResult | null;
  mode: FeatureRolloutMode;
  applied: boolean;
  reason: 'NO_SUGGESTION' | 'ROLLOUT_NOT_ACTIVE' | 'BELOW_ACTIVE_THRESHOLD' | 'APPLIED';
}

export function applySmartCategoryPolicy(
  product: Product,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now = Date.now(),
): SmartCategoryApplication {
  const rollout = getFeatureRolloutState('SMART_CATEGORIZATION_V2', environment);
  const result = categorizeVietnameseProduct({
    title: product.title,
    description: product.description,
    tags: product.tags,
    merchant: product.merchant,
  }, now);
  if (!result) {
    return { product, result, mode: rollout.mode, applied: false, reason: 'NO_SUGGESTION' };
  }
  const eligible = result.confidence >= ACTIVE_MIN_CONFIDENCE && result.margin >= ACTIVE_MIN_MARGIN;
  const applied = rollout.valid && rollout.mode === 'ACTIVE' && eligible;
  const suggestion: NonNullable<Product['categorySuggestion']> = {
    schemaVersion: result.schemaVersion,
    ruleVersion: result.ruleVersion,
    category: result.category,
    label: result.label,
    confidence: result.confidence,
    margin: result.margin,
    evaluatedAt: result.evaluatedAt,
    inputHash: result.inputHash,
    evidence: result.evidence,
    rolloutMode: rollout.mode,
    applied,
  };
  return {
    product: {
      ...product,
      ...(applied ? { category: result.category } : {}),
      categorySuggestion: suggestion,
    },
    result,
    mode: rollout.mode,
    applied,
    reason: applied
      ? 'APPLIED'
      : rollout.mode !== 'ACTIVE'
        ? 'ROLLOUT_NOT_ACTIVE'
        : 'BELOW_ACTIVE_THRESHOLD',
  };
}
