import { createHash } from 'node:crypto';
import { classifyProductKind } from '@/lib/sourceItemClassifier';
import type { ClassifiedProductRecordType } from '@/lib/types';

export const CLASSIFICATION_SCHEMA_VERSION = 3;
export const CLASSIFICATION_RULE_VERSION = 'record-classifier-v3';

export interface RecordClassification {
  schemaVersion: number;
  decisionId: string;
  recordType: ClassifiedProductRecordType;
  sourceType: string;
  confidence: number;
  reasons: string[];
  signals: string[];
  action: 'ACCEPT' | 'CROSS_CHECK' | 'QUARANTINE';
  ruleVersion: string;
}

const VOUCHER_PATTERN = /\b(voucher|coupon|promo\s*code|ma giam|ma uu dai|freeship|free ship|cashback|hoan tien|don hang tu|don toi thieu|toi da)\b/;
const CAMPAIGN_PATTERN = /\b(campaign|chien dich|mega sale|super sale|brand campaign|landing page|bo suu tap|collection)\b/;
const STORE_PATTERN = /\b(official store|official shop|flagship|store offer|shop offer|gian hang)\b/;
const CONTENT_PATTERN = /\b(article|blog|guide|review|news|content|bai viet|tin tuc|huong dan|cam nang|danh gia)\b/;
const DISCOUNT_PATTERN = /\b(giam|uu dai|khuyen mai)\b.*(?:\d+\s*%|\d+\s*(?:k|vnd|d)|don hang|toi da)/;
const LANDING_PATH_PATTERN = /\/(?:category|categories|collection|collections|campaign|campaigns|sale|deals?)(?:\/|$)/;

function normalize(value: unknown): string {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function first(input: Record<string, unknown>, keys: string[]): unknown {
  const raw = record(input.raw);
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && String(input[key]).trim()) return input[key];
    if (raw?.[key] !== undefined && raw[key] !== null && String(raw[key]).trim()) return raw[key];
  }
  return undefined;
}

function positiveNumber(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value !== 'string') return false;
  const parsed = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0;
}

function validUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizedSourceType(input: Record<string, unknown>): string {
  const endpoint = normalize(first(input, ['sourceEndpointType', 'endpointType', 'providerEndpoint', 'rawSourceKind', 'rawSourceType', 'sourceType']));
  const provider = normalize(first(input, ['provider', 'source', 'platform']));
  return [provider, endpoint].filter(Boolean).join(':').slice(0, 120) || 'unknown';
}

function stableDecisionId(input: Record<string, unknown>, result: Omit<RecordClassification, 'schemaVersion' | 'decisionId' | 'ruleVersion'>): string {
  const fingerprint = {
    claimedKind: normalize(first(input, ['sourceItemKind', 'kind'])),
    rawType: normalize(first(input, ['rawSourceKind', 'rawSourceType', 'sourceType', 'itemType', 'type', 'objectType'])),
    title: normalize(first(input, ['title', 'name'])),
    description: normalize(first(input, ['description', 'summary'])),
    price: first(input, ['salePrice', 'finalPrice', 'price', 'originalPrice']) ?? null,
    url: String(first(input, ['originalUrl', 'productUrl', 'url', 'landingUrl']) || ''),
    result,
    ruleVersion: CLASSIFICATION_RULE_VERSION,
  };
  return `classification-${createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 24)}`;
}

export function classifyRecord(input: Record<string, unknown>): RecordClassification {
  const claimedKind = normalize(first(input, ['sourceItemKind', 'kind']));
  const rawType = normalize(first(input, ['rawSourceKind', 'rawSourceType', 'sourceType', 'itemType', 'type', 'objectType']));
  const title = normalize(first(input, ['title', 'name']));
  const description = normalize(first(input, ['description', 'summary']));
  const text = `${title} ${description}`.trim();
  const sourceUrl = normalize(first(input, ['originalUrl', 'productUrl', 'url', 'landingUrl']));
  const sourceType = normalizedSourceType(input);
  const hasImage = validUrl(first(input, ['imageUrl', 'image', 'thumbnail']));
  const hasMerchant = Boolean(first(input, ['merchant', 'merchantName', 'shopName', 'storeName']));
  const hasIdentity = Boolean(first(input, ['sku', 'skuId', 'gtin', 'ean', 'upc', 'productId', 'itemId']));
  const hasVoucherField = Boolean(first(input, ['voucherCode', 'couponCode', 'promoCode', 'voucherId']));
  const hasCampaignField = Boolean(first(input, ['campaignId', 'campaignType'])) && !hasIdentity;
  const signals: string[] = [];

  const explicitVoucher = /\b(voucher|coupon|promo code)\b/.test(rawType);
  const explicitCampaign = /\b(campaign|collection|landing page)\b/.test(rawType);
  const explicitStore = /\b(store offer|shop offer|store promotion)\b/.test(rawType);
  const explicitContent = /\b(article|blog|guide|review|news|content|post)\b/.test(rawType);
  const voucherText = VOUCHER_PATTERN.test(text) || DISCOUNT_PATTERN.test(text);
  const campaignText = CAMPAIGN_PATTERN.test(text);
  const storeText = STORE_PATTERN.test(text) && (voucherText || /\d+\s*%/.test(text));
  const contentText = CONTENT_PATTERN.test(text);
  const landingShape = LANDING_PATH_PATTERN.test(sourceUrl) && !hasIdentity;
  const strongContentText = /^(?:article|blog|guide|review|news|bai viet|tin tuc|huong dan|cam nang|danh gia)\b/.test(title)
    || /\/(?:article|articles|blog|news|guide|review|content)(?:\/|$)/.test(sourceUrl);

  let recordType: ClassifiedProductRecordType;
  let confidence: number;
  let reasons: string[];

  // Negative source and semantic signals always outrank a client/source claim of kind=product.
  if (explicitVoucher || hasVoucherField) {
    recordType = 'VOUCHER'; confidence = 0.99;
    reasons = ['non_product_voucher']; signals.push(explicitVoucher ? 'raw_type_voucher' : 'voucher_field');
  } else if (explicitCampaign || hasCampaignField) {
    recordType = 'CAMPAIGN'; confidence = 0.99;
    reasons = ['non_product_campaign']; signals.push(explicitCampaign ? 'raw_type_campaign' : 'campaign_field');
  } else if (explicitStore) {
    recordType = 'STORE_OFFER'; confidence = 0.99;
    reasons = ['non_product_store_offer']; signals.push('raw_type_store_offer');
  } else if (explicitContent) {
    recordType = 'CATEGORY_OR_LANDING_PAGE'; confidence = 0.99;
    reasons = ['non_product_category_or_landing_page']; signals.push('raw_type_content');
  } else if (storeText || (/^\[[^\]]+\]\s*-/.test(title) && voucherText)) {
    recordType = 'STORE_OFFER'; confidence = 0.96;
    reasons = ['non_product_store_offer']; signals.push('store_discount_language');
  } else if (landingShape && !voucherText) {
    recordType = 'CATEGORY_OR_LANDING_PAGE'; confidence = 0.98;
    reasons = ['non_product_category_or_landing_page']; signals.push('landing_url_shape');
  } else if (campaignText) {
    recordType = 'CAMPAIGN'; confidence = 0.95;
    reasons = ['non_product_campaign']; signals.push('campaign_language');
  } else if (voucherText) {
    recordType = 'VOUCHER'; confidence = 0.96;
    reasons = ['non_product_voucher']; signals.push('voucher_language');
  } else if (strongContentText || (contentText && !positiveNumber(first(input, ['salePrice', 'finalPrice', 'price'])))) {
    recordType = 'CATEGORY_OR_LANDING_PAGE'; confidence = landingShape ? 0.96 : 0.93;
    reasons = ['non_product_category_or_landing_page']; signals.push(landingShape ? 'landing_url_shape' : strongContentText ? 'strong_content_shape' : 'content_without_offer');
  } else {
    const inferredKind = classifyProductKind(input);
    const hasTitle = Boolean(title);
    const hasPrice = positiveNumber(first(input, ['salePrice', 'finalPrice', 'price', 'originalPrice']));
    const hasUrl = validUrl(first(input, ['originalUrl', 'productUrl', 'url']));
    if ((inferredKind === 'product' || inferredKind === 'deal') && hasTitle && hasPrice && hasUrl) {
      recordType = 'PRODUCT'; confidence = hasIdentity ? 0.98 : 0.91;
      reasons = ['verified_product_shape'];
      signals.push('title', 'positive_price', 'product_url', hasIdentity ? 'product_identifier' : 'shape_without_identifier');
      if (hasImage) signals.push('image_url');
      if (hasMerchant) signals.push('merchant');
    } else if (inferredKind === 'product' || inferredKind === 'deal' || claimedKind === 'product' || claimedKind === 'deal') {
      recordType = 'UNKNOWN'; confidence = 0.45;
      reasons = ['incomplete_product_shape', 'insufficient_verified_product_fields']; signals.push('claimed_or_inferred_product');
    } else {
      recordType = 'UNKNOWN'; confidence = 0.2;
      reasons = ['insufficient_signals']; signals.push('no_decisive_signal');
    }
  }

  const action = recordType !== 'PRODUCT'
    ? 'QUARANTINE' as const
    : confidence >= 0.85
      ? 'ACCEPT' as const
      : confidence >= 0.55
        ? 'CROSS_CHECK' as const
        : 'QUARANTINE' as const;
  const decision = { recordType, sourceType, confidence, reasons, signals, action };
  return {
    schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    decisionId: stableDecisionId(input, decision),
    ...decision,
    ruleVersion: CLASSIFICATION_RULE_VERSION,
  };
}
