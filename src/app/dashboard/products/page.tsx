"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Product, ProductKind } from "@/lib/types";
import {
  classifyProductKind,
  looksLikeVoucherOrCampaign,
} from "@/lib/sourceItemClassifier";
import {
  getPublicProductBlockReason,
  isPublicSafeProduct,
} from "@/lib/publicProductFilter";

type Toast = {
  type: "success" | "error" | "info";
  message: string;
};

type ApiEnvelope<T> = {
  ok?: boolean;
  success?: boolean;
  message?: string;
  error?: string;
  data?: T;
};

type ProductRecord = Product &
    Record<string, unknown> & {
  source?: string;
  dataSource?: string;
  importedFrom?: string;
  sourceType?: string;
  sourceItemKind?: ProductKind;
  kind?: ProductKind;
  rawSourceKind?: string;

  verifiedSource?: boolean;
  sourceVerified?: boolean;
  needsVerification?: boolean;

  publicHidden?: boolean;
  archived?: boolean;
  hidden?: boolean;
  deleted?: boolean;

  isDemo?: boolean;
  isSample?: boolean;
  isTest?: boolean;
  isInternal?: boolean;

  originalUrl?: string;
  affiliateUrl?: string;
  url?: string;
  productUrl?: string;
  landingUrl?: string;
  landingPage?: string;

  linkHealthStatus?: string;
  linkHealth?: string;
  imageHealthStatus?: string;
  imageHealth?: string;

  currentPrice?: number | string;
  originalPrice?: number | string;
  priceValue?: number | string;

  publicDecision?: string;
  publicBlockReason?: string;
  nonProductReason?: string;
  autoPublishBlockedReason?: string;
  unpublishedReason?: string;

  autoPublished?: boolean;
  autoPublishEligible?: boolean;
  aiApproved?: boolean;
  approvalMode?: string;

  qualityScore?: number | string;
  sourceQualityScore?: number | string;
};

type PublicDecision = {
  label: string;
  badge: string;
  reason: string;
};

const PLATFORM_LABELS: Record<string, string> = {
  shopee: "Shopee",
  tiktok_shop: "TikTok Shop",
  lazada: "Lazada",
  accesstrade: "AccessTrade",
  website: "Website",
  tiki: "Tiki",
  sendo: "Sendo",
  fahasa: "Fahasa",
  other: "Khác",
};

const STATUS_LABELS: Record<string, { label: string; badge: string }> = {
  draft: { label: "Nháp", badge: "badge-neutral" },
  needs_review: { label: "Cần xem xét", badge: "badge-warning" },
  approved: { label: "Đã duyệt", badge: "badge-success" },
  published: { label: "Đã xuất bản", badge: "badge-info" },
  archived: { label: "Lưu trữ", badge: "badge-neutral" },
};

const KIND_LABELS: Record<string, string> = {
  product: "Sản phẩm",
  voucher: "Voucher",
  campaign: "Campaign",
  deal: "Deal",
  store_offer: "Ưu đãi shop",
  unknown: "Chưa rõ",
};

const KIND_BADGES: Record<string, string> = {
  product: "badge-success",
  deal: "badge-success",
  voucher: "badge-warning",
  campaign: "badge-warning",
  store_offer: "badge-warning",
  unknown: "badge-neutral",
};

const RISK_LABELS: Record<string, { label: string; badge: string }> = {
  low: { label: "Thấp", badge: "badge-success" },
  medium: { label: "Trung bình", badge: "badge-warning" },
  high: { label: "Cao", badge: "badge-danger" },
  unknown: { label: "Chưa rõ", badge: "badge-neutral" },
};

const BROKEN_LINK_STATUSES = new Set([
  "broken",
  "broken_link",
  "not_found",
  "not_allowed",
  "forbidden",
  "timeout",
  "affiliate_error",
  "image_broken",
  "product_unavailable",
  "server_error",
  "error",
  "failed",
  "dead",
  "redirect_error",
  "unavailable",
  "out_of_stock",
  "missing",
  "invalid",
  "blocked",
]);

const BROKEN_IMAGE_STATUSES = new Set([
  "image_broken",
  "invalid_image",
  "forbidden",
  "timeout",
  "error",
  "failed",
  "broken",
  "not_found",
  "missing",
  "invalid",
  "blocked",
]);

const SAFE_HEALTH_STATUSES = new Set([
  "ok",
  "healthy",
  "valid",
  "available",
  "pass",
  "passed",
]);

function normalizeText(value?: unknown): string {
  if (value === null || value === undefined) return "";

  return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "d")
      .toLowerCase()
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
}

function getProductRecord(product: Product): ProductRecord {
  return product as ProductRecord;
}

function parsePriceNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 1000 ? value : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  if (!trimmed || /%/.test(trimmed)) {
    return undefined;
  }

  const normalizedText = normalizeText(trimmed);

  if (
      normalizedText.includes("mien phi") ||
      normalizedText.includes("free") ||
      normalizedText.includes("lien he") ||
      normalizedText.includes("contact")
  ) {
    return undefined;
  }

  const millionMatch = normalizedText.match(
      /(\d+(?:[.,]\d+)?)\s*(trieu|million)\b/i,
  );

  if (millionMatch) {
    const parsedMillion = Number(millionMatch[1].replace(",", ".")) * 1_000_000;

    return Number.isFinite(parsedMillion) && parsedMillion >= 1000
        ? Math.round(parsedMillion)
        : undefined;
  }

  const thousandMatch = normalizedText.match(
      /(\d+(?:[.,]\d+)?)\s*(k|nghin|ngan)\b/i,
  );

  if (thousandMatch) {
    const parsedThousand = Number(thousandMatch[1].replace(",", ".")) * 1000;

    return Number.isFinite(parsedThousand) && parsedThousand >= 1000
        ? Math.round(parsedThousand)
        : undefined;
  }

  const groupedNumberMatch = trimmed.match(/\d{1,3}(?:[.,]\d{3})+/);

  if (groupedNumberMatch) {
    const groupedValue = Number(groupedNumberMatch[0].replace(/[^\d]/g, ""));

    return Number.isFinite(groupedValue) && groupedValue >= 1000
        ? groupedValue
        : undefined;
  }

  const plainNumberMatch = trimmed.match(/\d{4,}/);

  if (plainNumberMatch) {
    const plainValue = Number(plainNumberMatch[0]);

    return Number.isFinite(plainValue) && plainValue >= 1000
        ? plainValue
        : undefined;
  }

  return undefined;
}

function isValidHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;

  const url = value.trim();

  if (!/^https?:\/\//i.test(url)) {
    return false;
  }

  try {
    const parsed = new URL(url);

    return Boolean(
        parsed.hostname &&
        (parsed.protocol === "http:" || parsed.protocol === "https:"),
    );
  } catch {
    return false;
  }
}

function getEffectiveKind(product: Product): ProductKind {
  const p = getProductRecord(product);
  const explicitKind = p.sourceItemKind || p.kind;

  if (explicitKind && explicitKind !== "unknown") {
    const looksUnsafe =
        looksLikeVoucherOrCampaign({
          title: product.title,
          description: product.description,
          rawSourceKind: p.rawSourceKind,
          source: p.source,
          raw: product,
        }) || looksLikeVoucherOrCampaign(product.title);

    if (
        (explicitKind === "product" || explicitKind === "deal") &&
        looksUnsafe
    ) {
      return classifyProductKind({
        ...product,
        kind: undefined,
        sourceItemKind: undefined,
      } as Partial<Product>);
    }

    return explicitKind;
  }

  return classifyProductKind({
    ...product,
    kind: undefined,
    sourceItemKind: undefined,
  } as Partial<Product>);
}

function getKindLabel(kind: ProductKind): string {
  return KIND_LABELS[kind] || "Chưa rõ";
}

function getKindBadge(kind: ProductKind): string {
  return KIND_BADGES[kind] || "badge-neutral";
}

function isRealProductKind(kind: ProductKind | string | undefined): boolean {
  return kind === "product" || kind === "deal";
}

function isNonProductKind(kind: ProductKind | string | undefined): boolean {
  return (
      kind === "voucher" ||
      kind === "campaign" ||
      kind === "store_offer" ||
      kind === "unknown"
  );
}

function getSourceLabel(product: Product): string {
  const p = getProductRecord(product);
  return p.source || p.dataSource || p.importedFrom || "unknown";
}

function getPlatformLabel(product: Product): string {
  const platform = String(
      product.platform || getProductRecord(product).platform || "other",
  );
  return PLATFORM_LABELS[platform] || platform || "Khác";
}

function isVerifiedSource(product: Product): boolean {
  const p = getProductRecord(product);
  return Boolean(p.verifiedSource === true || p.sourceVerified === true);
}

function isDemoOrTest(product: Product): boolean {
  const p = getProductRecord(product);
  const source = normalizeText(getSourceLabel(product));
  const title = normalizeText(product.title);

  return Boolean(
      p.isDemo === true ||
      p.isSample === true ||
      p.isTest === true ||
      p.isInternal === true ||
      source === "demo" ||
      source === "sample" ||
      source === "test" ||
      source === "internal" ||
      title.includes("demo") ||
      title.includes("sample") ||
      title.includes("test product") ||
      title.includes("san pham test") ||
      title.includes("placeholder") ||
      title.includes("fake"),
  );
}

function hasExternalUrl(product: Product): boolean {
  const p = getProductRecord(product);

  return [
    p.affiliateUrl,
    p.originalUrl,
    p.url,
    p.productUrl,
    p.landingUrl,
    p.landingPage,
  ].some((url) => isValidHttpUrl(url));
}

function hasAffiliateUrl(product: Product): boolean {
  const p = getProductRecord(product);

  return isValidHttpUrl(p.affiliateUrl);
}

function hasRealImage(product: Product): boolean {
  if (!product.imageUrl) return false;

  const imageUrl = String(product.imageUrl).trim();

  if (!imageUrl) return false;

  const normalizedImageUrl = normalizeText(imageUrl);

  if (
      normalizedImageUrl.includes("placeholder") ||
      normalizedImageUrl.includes("sample") ||
      normalizedImageUrl.includes("demo") ||
      normalizedImageUrl.includes("fake")
  ) {
    return false;
  }

  return isValidHttpUrl(imageUrl) || imageUrl.startsWith("/");
}

function hasRealPrice(product: Product): boolean {
  const p = getProductRecord(product);

  return [
    product.salePrice,
    product.price,
    p.currentPrice,
    p.originalPrice,
    p.priceValue,
  ].some((value) => Boolean(parsePriceNumber(value)));
}

function getLinkHealthStatus(product: Product): string {
  const p = getProductRecord(product);
  return normalizeText(p.linkHealthStatus || p.linkHealth);
}

function getImageHealthStatus(product: Product): string {
  const p = getProductRecord(product);
  return normalizeText(p.imageHealthStatus || p.imageHealth);
}

function hasBrokenLink(product: Product): boolean {
  const status = getLinkHealthStatus(product);
  return Boolean(status && BROKEN_LINK_STATUSES.has(status));
}

function hasBrokenImage(product: Product): boolean {
  const status = getImageHealthStatus(product);
  return Boolean(status && BROKEN_IMAGE_STATUSES.has(status));
}

function hasOkLink(product: Product): boolean {
  const status = getLinkHealthStatus(product);
  return Boolean(status && SAFE_HEALTH_STATUSES.has(status));
}

function hasOkImage(product: Product): boolean {
  const status = getImageHealthStatus(product);
  return Boolean(status && SAFE_HEALTH_STATUSES.has(status));
}

function isImportedAffiliateProduct(product: Product): boolean {
  const p = getProductRecord(product);

  const haystack = normalizeText(
      [
        p.source,
        p.dataSource,
        p.importedFrom,
        p.sourceType,
        product.platform,
      ].join(" "),
  );

  return (
      haystack.includes("accesstrade") ||
      haystack.includes("access trade") ||
      p.autoPublished === true
  );
}

function getSourceQualityScore(product: Product): number | undefined {
  const p = getProductRecord(product);
  const rawScore = p.sourceQualityScore ?? p.qualityScore;

  if (typeof rawScore === "number" && Number.isFinite(rawScore)) {
    return rawScore;
  }

  if (typeof rawScore === "string" && rawScore.trim()) {
    const parsed = Number(rawScore);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function hasLowQualityScore(product: Product): boolean {
  const score = getSourceQualityScore(product);

  if (score === undefined || !Number.isFinite(score)) return false;

  return score > 0 && score < 70;
}

function isRequiredQualityScoreMissing(product: Product): boolean {
  if (!isImportedAffiliateProduct(product)) return false;

  const score = getSourceQualityScore(product);

  return score === undefined || score <= 0;
}

function getQualityScore(product: Product): number | null {
  const sourceScore = getSourceQualityScore(product);

  if (sourceScore !== undefined && Number.isFinite(sourceScore)) {
    return Math.round(sourceScore);
  }

  const score =
      typeof product.score === "number"
          ? product.score
          : typeof product.score === "string"
              ? Number(product.score)
              : undefined;

  if (score === undefined || !Number.isFinite(score)) return null;

  return Math.round(score);
}

function translateInternalBlockReason(value: string): string {
  const normalized = normalizeText(value);

  if (!normalized) return "";

  const exactReasonMap: Record<string, string> = {
    auto_mode_disabled: "AutoPilot đang tắt hoặc chưa cho phép tự public.",
    free_only_guard_failed: "Free Only Guard chưa đạt yêu cầu.",
    missing_or_too_short_title: "Thiếu tên sản phẩm hoặc tên quá ngắn.",
    title_not_specific_enough: "Tên chưa đủ cụ thể để xác định sản phẩm thật.",
    title_looks_like_voucher_campaign_or_store_offer:
        "Tên giống voucher/campaign/ưu đãi shop.",
    classifier_detected_voucher_or_campaign:
        "Bộ phân loại phát hiện dữ liệu giống voucher hoặc campaign.",
    source_not_verified_for_auto_publish: "Nguồn sản phẩm chưa được xác minh.",
    source_not_verified: "Nguồn sản phẩm chưa được xác minh.",
    missing_platform: "Thiếu nền tảng hoặc nguồn sản phẩm.",
    missing_affiliate_url: "Thiếu affiliate link hợp lệ.",
    missing_product_url: "Thiếu link sản phẩm hợp lệ.",
    missing_image: "Thiếu ảnh sản phẩm.",
    missing_image_before_health_check: "Thiếu ảnh sản phẩm.",
    missing_real_price: "Thiếu giá sản phẩm thật.",
    needs_verification: "Sản phẩm đang cần xác minh thêm.",
    source_quality_score_too_low: "Điểm chất lượng nguồn thấp.",
    missing_link_before_health_check:
        "Thiếu link trước khi kiểm tra sức khoẻ sản phẩm.",
  };

  if (exactReasonMap[normalized]) {
    return exactReasonMap[normalized];
  }

  if (
      normalized.startsWith("blocked_non_product_kind_") ||
      normalized.startsWith("blocked_kind_")
  ) {
    return "Loại dữ liệu này không phải sản phẩm cụ thể.";
  }

  if (normalized.startsWith("public_decision_")) {
    return "Quyết định Safe Publish hiện đang chặn sản phẩm.";
  }

  if (normalized.startsWith("health_check_error")) {
    return "Lỗi khi kiểm tra link hoặc ảnh, cần xem xét lại.";
  }

  return value;
}

function getStoredBlockReason(product: Product): string {
  const p = getProductRecord(product);

  const rawReason =
      p.publicBlockReason ||
      p.nonProductReason ||
      p.unpublishedReason ||
      p.autoPublishBlockedReason ||
      "";

  return translateInternalBlockReason(rawReason);
}

function getMainBlockReason(product: Product): string {
  const storedReason = getStoredBlockReason(product);
  if (storedReason) return storedReason;

  const publicFilterReason = getPublicProductBlockReason(product);
  if (publicFilterReason) return publicFilterReason;

  return getApproveBlockedReason(product);
}

function getPublicDecision(product: Product): PublicDecision {
  const p = getProductRecord(product);
  const status = normalizeText(product.status);
  const publicDecision = normalizeText(p.publicDecision);
  const kind = getEffectiveKind(product);
  const reason = getMainBlockReason(product);

  if (isPublicSafeProduct(product)) {
    return {
      label: "Đã public",
      badge: "badge-success",
      reason: "Đủ chuẩn Safe Publish.",
    };
  }

  if (status === "archived" || publicDecision === "archived") {
    return {
      label: "Lưu trữ",
      badge: "badge-neutral",
      reason: reason || "Đang được lưu nội bộ, không hiển thị public.",
    };
  }

  if (isNonProductKind(kind)) {
    return {
      label: "Không public tự động",
      badge: "badge-warning",
      reason:
          reason ||
          (kind === "store_offer"
              ? "Chưa phải sản phẩm cụ thể."
              : kind === "voucher"
                  ? "Voucher không public như sản phẩm."
                  : kind === "campaign"
                      ? "Campaign không public như sản phẩm."
                      : "Chưa xác định được là sản phẩm thật."),
    };
  }

  if (status === "published" && reason) {
    return {
      label: "Đã chặn public",
      badge: "badge-danger",
      reason,
    };
  }

  return {
    label: "Cần xem xét",
    badge: "badge-warning",
    reason: reason || "Cần kiểm tra thêm trước khi public.",
  };
}

function canApproveProduct(product: Product): boolean {
  const p = getProductRecord(product);
  const kind = getEffectiveKind(product);
  const status = normalizeText(product.status);
  const source = normalizeText(getSourceLabel(product));

  if (!isRealProductKind(kind)) return false;
  if (status === "approved" || status === "published" || status === "archived")
    return false;
  if (!product.title || !String(product.title).trim()) return false;
  if (
      looksLikeVoucherOrCampaign(product) ||
      looksLikeVoucherOrCampaign(product.title)
  )
    return false;
  if (isDemoOrTest(product)) return false;
  if (!hasExternalUrl(product)) return false;
  if (!hasRealImage(product)) return false;
  if (!hasRealPrice(product)) return false;
  if (
      source === "manual" &&
      p.verifiedSource !== true &&
      p.sourceVerified !== true
  )
    return false;
  if (p.needsVerification === true) return false;
  if (p.verifiedSource === false || p.sourceVerified === false) return false;
  if (hasBrokenLink(product) || hasBrokenImage(product)) return false;
  if (isRequiredQualityScoreMissing(product)) return false;
  if (hasLowQualityScore(product)) return false;

  const publicDecision = normalizeText(p.publicDecision);

  if (
      publicDecision === "archived" ||
      publicDecision === "blocked" ||
      publicDecision === "internal_only" ||
      publicDecision === "not_public"
  ) {
    return false;
  }

  if (isImportedAffiliateProduct(product)) {
    if (!hasAffiliateUrl(product)) return false;
    if (!hasOkLink(product)) return false;
    if (!hasOkImage(product)) return false;
  }

  return true;
}

function getApproveBlockedReason(product: Product): string {
  const p = getProductRecord(product);
  const kind = getEffectiveKind(product);
  const source = normalizeText(getSourceLabel(product));

  const storedReason = getStoredBlockReason(product);
  if (storedReason) return storedReason;

  if (kind === "voucher") {
    return "Mục này là voucher, không thể duyệt public như sản phẩm.";
  }

  if (kind === "campaign") {
    return "Mục này là campaign, không thể duyệt public như sản phẩm.";
  }

  if (kind === "store_offer") {
    return "Mục này là ưu đãi shop, chưa phải sản phẩm cụ thể.";
  }

  if (kind === "unknown") {
    return "Mục này chưa rõ loại dữ liệu, cần phân loại trước khi duyệt.";
  }

  if (
      looksLikeVoucherOrCampaign(product) ||
      looksLikeVoucherOrCampaign(product.title)
  ) {
    return "Tiêu đề giống voucher/campaign/store offer, không thể duyệt public.";
  }

  if (!product.title || !String(product.title).trim()) {
    return "Thiếu tên sản phẩm.";
  }

  if (!hasExternalUrl(product)) {
    return "Thiếu link sản phẩm hoặc affiliate link hợp lệ.";
  }

  if (isImportedAffiliateProduct(product) && !hasAffiliateUrl(product)) {
    return "Sản phẩm AccessTrade thiếu affiliate link hợp lệ.";
  }

  if (!hasRealImage(product)) {
    return "Thiếu ảnh sản phẩm hợp lệ.";
  }

  if (!hasRealPrice(product)) {
    return "Thiếu giá sản phẩm thật.";
  }

  if (
      source === "manual" &&
      p.verifiedSource !== true &&
      p.sourceVerified !== true
  ) {
    return "Sản phẩm thủ công chưa được xác minh nguồn.";
  }

  if (p.needsVerification === true) {
    return "Sản phẩm đang cần xác minh thêm.";
  }

  if (p.verifiedSource === false || p.sourceVerified === false) {
    return "Nguồn sản phẩm chưa được xác minh.";
  }

  if (hasBrokenLink(product)) {
    return "Link sản phẩm đang lỗi hoặc không khả dụng.";
  }

  if (hasBrokenImage(product)) {
    return "Ảnh sản phẩm đang lỗi hoặc không khả dụng.";
  }

  if (isImportedAffiliateProduct(product) && !hasOkLink(product)) {
    return "Link sản phẩm chưa được kiểm tra OK.";
  }

  if (isImportedAffiliateProduct(product) && !hasOkImage(product)) {
    return "Ảnh sản phẩm chưa được kiểm tra OK.";
  }

  if (isRequiredQualityScoreMissing(product)) {
    return "Sản phẩm tự động chưa có điểm chất lượng nguồn hợp lệ.";
  }

  if (hasLowQualityScore(product)) {
    return "Điểm chất lượng nguồn thấp.";
  }

  const publicDecision = normalizeText(p.publicDecision);

  if (
      publicDecision === "archived" ||
      publicDecision === "blocked" ||
      publicDecision === "internal_only" ||
      publicDecision === "not_public"
  ) {
    return "Quyết định Safe Publish hiện đang chặn sản phẩm.";
  }

  if (isDemoOrTest(product)) {
    return "Dữ liệu demo/test không thể public.";
  }

  return "Mục này chưa đủ điều kiện duyệt.";
}

function formatPrice(price?: number | string) {
  const parsed = parsePriceNumber(price);
  if (!parsed) return "—";

  return `${parsed.toLocaleString("vi-VN")}₫`;
}

function getStatusLabel(status?: string) {
  return STATUS_LABELS[status || ""]?.label || status || "Không rõ";
}

function getStatusBadge(status?: string) {
  return STATUS_LABELS[status || ""]?.badge || "badge-neutral";
}

function getRiskLabel(riskLevel?: string) {
  return RISK_LABELS[riskLevel || "unknown"]?.label || riskLevel || "Chưa rõ";
}

function getRiskBadge(riskLevel?: string) {
  return RISK_LABELS[riskLevel || "unknown"]?.badge || "badge-neutral";
}

function getHealthBadge(status: string, type: "link" | "image") {
  if (!status) return { label: "Chưa check", badge: "badge-neutral" };

  if (SAFE_HEALTH_STATUSES.has(status)) {
    return { label: "OK", badge: "badge-success" };
  }

  const brokenSet =
      type === "link" ? BROKEN_LINK_STATUSES : BROKEN_IMAGE_STATUSES;

  if (brokenSet.has(status)) {
    return { label: status, badge: "badge-danger" };
  }

  return { label: status, badge: "badge-warning" };
}

function SafeThumb({
                     src,
                     label = "SP",
                     size = 40,
                     rounded = "var(--radius-sm)",
                   }: {
  src?: string;
  label?: string;
  size?: number;
  rounded?: string;
}) {
  const [failed, setFailed] = useState(false);
  const cleanSrc = src?.trim() || "";

  useEffect(() => {
    setFailed(false);
  }, [cleanSrc]);

  if (!cleanSrc || failed) {
    return (
        <div
            style={{
              width: size,
              height: size,
              borderRadius: rounded,
              background:
                  "radial-gradient(circle at 50% 20%, rgba(34,211,238,0.16), transparent 36%), linear-gradient(135deg, #1a2237, #111827)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: size > 80 ? "18px" : "12px",
              fontWeight: 900,
              color: "#22d3ee",
              flexShrink: 0,
            }}
        >
          {label}
        </div>
    );
  }

  return (
      <div
          style={{
            width: size,
            height: size,
            borderRadius: rounded,
            overflow: "hidden",
            background: "var(--bg-tertiary)",
            flexShrink: 0,
          }}
      >
        <img
            src={cleanSrc}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
        />
      </div>
  );
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"card" | "table">("table");
  const [toast, setToast] = useState<Toast | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [botRunning, setBotRunning] = useState(false);
  const [actionRunning, setActionRunning] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filterPlatform, setFilterPlatform] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterKind, setFilterKind] = useState("");
  const [filterRisk, setFilterRisk] = useState("");
  const [filterPublic, setFilterPublic] = useState("");

  const showToast = useCallback((type: Toast["type"], message: string) => {
    setToast({ type, message });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    setSearch(params.get("q") || "");
    setFilterPlatform(params.get("platform") || "");
    setFilterStatus(params.get("status") || "");
    setFilterKind(params.get("kind") || "");
    setFilterRisk(params.get("riskLevel") || "");
    setFilterPublic(params.get("public") || "");
  }, []);

  const loadProducts = useCallback(async () => {
    setLoading(true);

    try {
      const params = new URLSearchParams();

      if (search.trim()) params.set("q", search.trim());
      if (filterPlatform) params.set("platform", filterPlatform);
      if (filterStatus) params.set("status", filterStatus);
      if (filterRisk) params.set("riskLevel", filterRisk);

      const query = params.toString();
      const res = await fetch(`/api/products${query ? `?${query}` : ""}`, {
        cache: "no-store",
      });

      const data = (await res.json().catch(() => null)) as ApiEnvelope<
          Product[]
      > | null;

      if ((data?.ok || data?.success) && Array.isArray(data.data)) {
        setProducts(data.data);
      } else {
        setProducts([]);
      }
    } catch {
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, [search, filterPlatform, filterStatus, filterRisk]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const visibleProducts = useMemo(() => {
    return products.filter((product) => {
      const inferredKind = getEffectiveKind(product);

      if (filterKind) {
        if (filterKind === "product" && inferredKind !== "product")
          return false;
        if (filterKind === "deal" && inferredKind !== "deal") return false;

        if (
            filterKind !== "product" &&
            filterKind !== "deal" &&
            inferredKind !== filterKind
        ) {
          return false;
        }
      }

      if (filterPublic === "safe" && !isPublicSafeProduct(product)) {
        return false;
      }

      if (
          filterPublic === "blocked" &&
          (isPublicSafeProduct(product) || isNonProductKind(inferredKind))
      ) {
        return false;
      }

      if (filterPublic === "non_product" && !isNonProductKind(inferredKind)) {
        return false;
      }

      if (
          filterPublic === "review" &&
          normalizeText(product.status) !== "needs_review"
      ) {
        return false;
      }

      return true;
    });
  }, [products, filterKind, filterPublic]);

  const stats = useMemo(() => {
    const realProducts = products.filter((product) =>
        isRealProductKind(getEffectiveKind(product)),
    ).length;
    const storeOffers = products.filter(
        (product) => getEffectiveKind(product) === "store_offer",
    ).length;
    const vouchers = products.filter(
        (product) => getEffectiveKind(product) === "voucher",
    ).length;
    const campaigns = products.filter(
        (product) => getEffectiveKind(product) === "campaign",
    ).length;
    const unknown = products.filter(
        (product) => getEffectiveKind(product) === "unknown",
    ).length;

    const publicSafe = products.filter((product) =>
        isPublicSafeProduct(product),
    ).length;
    const publishedStatus = products.filter(
        (product) => normalizeText(product.status) === "published",
    ).length;
    const publishedButBlocked = products.filter(
        (product) =>
            normalizeText(product.status) === "published" &&
            !isPublicSafeProduct(product),
    ).length;
    const publicCandidates = products.filter((product) => {
      const p = getProductRecord(product);

      return (
          normalizeText(p.publicDecision) === "public_candidate" ||
          p.autoPublishEligible === true
      );
    }).length;
    const needsReview = products.filter(
        (product) => normalizeText(product.status) === "needs_review",
    ).length;
    const archived = products.filter(
        (product) => normalizeText(product.status) === "archived",
    ).length;

    const brokenLinks = products.filter((product) =>
        hasBrokenLink(product),
    ).length;
    const brokenImages = products.filter((product) =>
        hasBrokenImage(product),
    ).length;
    const missingPrice = products.filter(
        (product) => !hasRealPrice(product),
    ).length;
    const missingImage = products.filter(
        (product) => !hasRealImage(product),
    ).length;
    const missingLink = products.filter(
        (product) => !hasExternalUrl(product),
    ).length;

    const hidden = products.filter((product) => {
      const p = getProductRecord(product);
      return (
          p.publicHidden === true || p.hidden === true || p.archived === true
      );
    }).length;

    return {
      total: products.length,
      realProducts,
      storeOffers,
      vouchers,
      campaigns,
      unknown,
      publicSafe,
      publishedStatus,
      publishedButBlocked,
      publicCandidates,
      needsReview,
      archived,
      brokenLinks,
      brokenImages,
      missingPrice,
      missingImage,
      missingLink,
      hidden,
      nonProducts: storeOffers + vouchers + campaigns + unknown,
    };
  }, [products]);

  const clearFilters = () => {
    setSearch("");
    setFilterPlatform("");
    setFilterStatus("");
    setFilterKind("");
    setFilterRisk("");
    setFilterPublic("");
  };

  const handleRunBot = async (mode: "source_scan" | "full_safe_run") => {
    setBotRunning(true);

    try {
      const res = await fetch("/api/ai-bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          source: "all",
          limit: 10,
          costMode: "safe_free",
          safeMode: true,
          freeOnly: true,
          autoMode: true,
          autoApprove: true,
          autoPublish: true,
          allowPaidAi: false,
        }),
      });

      const data = (await res
          .json()
          .catch(() => null)) as ApiEnvelope<unknown> | null;

      if (!res.ok || (!data?.ok && !data?.success)) {
        throw new Error(
            data?.message ||
            data?.error ||
            `Không chạy được bot. HTTP ${res.status}`,
        );
      }

      showToast(
          "success",
          mode === "full_safe_run"
              ? "Đã chạy AutoPilot toàn bộ. Chỉ sản phẩm thật đạt chuẩn mới được public."
              : "Đã chạy quét nguồn. Bot sẽ lưu nội bộ và chỉ public sản phẩm thật đạt chuẩn.",
      );

      await loadProducts();
    } catch (err) {
      showToast(
          "error",
          err instanceof Error ? err.message : "Không chạy được bot.",
      );
    } finally {
      setBotRunning(false);
    }
  };

  const handleScore = async (id: string) => {
    setActionRunning(`score:${id}`);

    try {
      const res = await fetch(`/api/products/${id}/score`, { method: "POST" });
      const data = (await res
          .json()
          .catch(() => null)) as ApiEnvelope<unknown> | null;

      if (!res.ok || (!data?.ok && !data?.success)) {
        throw new Error(
            data?.message ||
            data?.error ||
            `Không thể chấm điểm sản phẩm. HTTP ${res.status}`,
        );
      }

      showToast("success", "Đã chấm điểm sản phẩm.");
      await loadProducts();
    } catch (error) {
      showToast(
          "error",
          error instanceof Error
              ? error.message
              : "Không thể chấm điểm sản phẩm.",
      );
    } finally {
      setActionRunning(null);
    }
  };

  const handleApprove = async (id: string) => {
    const product = products.find((item) => item.id === id);

    if (product && !canApproveProduct(product)) {
      showToast("error", getApproveBlockedReason(product));
      return;
    }

    setActionRunning(`approve:${id}`);

    try {
      const res = await fetch(`/api/products/${id}/approve`, {
        method: "POST",
      });
      const data = (await res
          .json()
          .catch(() => null)) as ApiEnvelope<unknown> | null;

      if (!res.ok || (!data?.ok && !data?.success)) {
        throw new Error(
            data?.message ||
            data?.error ||
            `Không thể duyệt sản phẩm. HTTP ${res.status}`,
        );
      }

      showToast(
          "success",
          "Đã duyệt sản phẩm. Safe Publish vẫn kiểm tra lại trước khi hiển thị public.",
      );
      await loadProducts();
    } catch (error) {
      showToast(
          "error",
          error instanceof Error ? error.message : "Không thể duyệt sản phẩm.",
      );
    } finally {
      setActionRunning(null);
    }
  };

  const handleArchive = async (id: string) => {
    setActionRunning(`archive:${id}`);

    try {
      const res = await fetch(`/api/products/${id}/archive`, {
        method: "POST",
      });
      const data = (await res
          .json()
          .catch(() => null)) as ApiEnvelope<unknown> | null;

      if (!res.ok || (!data?.ok && !data?.success)) {
        throw new Error(
            data?.message ||
            data?.error ||
            `Không thể lưu trữ sản phẩm. HTTP ${res.status}`,
        );
      }

      showToast("success", "Đã lưu trữ sản phẩm.");
      await loadProducts();
    } catch (error) {
      showToast(
          "error",
          error instanceof Error ? error.message : "Không thể lưu trữ sản phẩm.",
      );
    } finally {
      setActionRunning(null);
    }
  };

  const handleDelete = async (id: string) => {
    setActionRunning(`delete:${id}`);

    try {
      const res = await fetch(`/api/products/${id}`, { method: "DELETE" });
      const data = (await res
          .json()
          .catch(() => null)) as ApiEnvelope<unknown> | null;

      if (!res.ok || (!data?.ok && !data?.success)) {
        throw new Error(
            data?.message ||
            data?.error ||
            `Không thể xoá sản phẩm. HTTP ${res.status}`,
        );
      }

      showToast("success", "Đã xoá sản phẩm.");
      setDeleteConfirm(null);
      await loadProducts();
    } catch (error) {
      showToast(
          "error",
          error instanceof Error ? error.message : "Không thể xoá sản phẩm.",
      );
    } finally {
      setActionRunning(null);
    }
  };

  const renderKindBadge = (product: Product) => {
    const kind = getEffectiveKind(product);
    const warningText = isNonProductKind(kind)
        ? getApproveBlockedReason(product)
        : null;

    return (
        <div>
        <span className={`badge ${getKindBadge(kind)}`}>
          {getKindLabel(kind)}
        </span>
          {warningText && (
              <div
                  style={{
                    fontSize: 11,
                    color: "#f59e0b",
                    marginTop: 4,
                    maxWidth: 220,
                  }}
              >
                {warningText}
              </div>
          )}
        </div>
    );
  };

  const renderDecisionBadge = (product: Product) => {
    const decision = getPublicDecision(product);

    return (
        <div style={{ maxWidth: 260 }}>
          <span className={`badge ${decision.badge}`}>{decision.label}</span>
          <div
              style={{
                fontSize: 11,
                color: "var(--text-tertiary)",
                marginTop: 6,
                lineHeight: 1.45,
              }}
          >
            {decision.reason}
          </div>
        </div>
    );
  };

  const renderHealthBadges = (product: Product) => {
    const link = getHealthBadge(getLinkHealthStatus(product), "link");
    const image = getHealthBadge(getImageHealthStatus(product), "image");

    return (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className={`badge ${link.badge}`} style={{ fontSize: 10 }}>
          Link: {link.label}
        </span>
          <span className={`badge ${image.badge}`} style={{ fontSize: 10 }}>
          Ảnh: {image.label}
        </span>
        </div>
    );
  };

  const renderApproveButton = (product: Product, sizeClass = "btn-sm") => {
    const status = normalizeText(product.status);

    if (status === "approved" || status === "published") {
      return null;
    }

    if (!canApproveProduct(product)) {
      return (
          <button
              type="button"
              className={`btn btn-ghost ${sizeClass}`}
              disabled
              title={getApproveBlockedReason(product)}
          >
            Duyệt
          </button>
      );
    }

    return (
        <button
            type="button"
            className={`btn btn-ghost ${sizeClass}`}
            disabled={actionRunning !== null}
            onClick={() => void handleApprove(product.id)}
            title="Duyệt sản phẩm"
        >
          {actionRunning === `approve:${product.id}` ? "Đang duyệt..." : "Duyệt"}
        </button>
    );
  };

  const renderSourceBadges = (product: Product) => {
    const source = getSourceLabel(product);
    const kind = getEffectiveKind(product);
    const p = getProductRecord(product);

    return (
        <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              display: "flex",
              gap: "8px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
        >
          <span>{source}</span>

          {isDemoOrTest(product) && (
              <span
                  style={{
                    fontSize: 10,
                    background: "rgba(245,158,11,0.1)",
                    color: "#f59e0b",
                    padding: "2px 8px",
                    borderRadius: 6,
                  }}
              >
            Dữ liệu test
          </span>
          )}

          {isVerifiedSource(product) && (
              <span
                  style={{
                    fontSize: 10,
                    background: "rgba(34,211,238,0.08)",
                    color: "#22d3ee",
                    padding: "2px 8px",
                    borderRadius: 6,
                  }}
              >
            Nguồn xác minh
          </span>
          )}

          {p.autoPublished === true && (
              <span
                  style={{
                    fontSize: 10,
                    background: "rgba(34,197,94,0.1)",
                    color: "#22c55e",
                    padding: "2px 8px",
                    borderRadius: 6,
                  }}
              >
            Auto publish
          </span>
          )}

          {isNonProductKind(kind) && (
              <span
                  style={{
                    fontSize: 10,
                    background: "rgba(245,158,11,0.1)",
                    color: "#f59e0b",
                    padding: "2px 8px",
                    borderRadius: 6,
                  }}
              >
            Không public tự động
          </span>
          )}
        </div>
    );
  };

  return (
      <>
        <section
            className="command-hero"
            style={{ marginBottom: "var(--space-xl)" }}
        >
          <div className="command-hero-content">
            <div
                className="badge badge-purple"
                style={{ marginBottom: "var(--space-md)" }}
            >
              Bot Results & Safe Publish Queue
            </div>

            <h1 className="page-title">Kết quả bot & hàng chờ duyệt</h1>

            <p className="page-subtitle" style={{ maxWidth: 760 }}>
              Theo dõi sản phẩm do bot AI quét được. AutoPilot chỉ public sản phẩm
              thật đạt chuẩn; voucher, campaign, ưu đãi shop, dữ liệu thiếu
              link/ảnh/giá hoặc link lỗi sẽ bị giữ nội bộ.
            </p>

            <div
                className="flex gap-sm"
                style={{ flexWrap: "wrap", marginTop: "var(--space-md)" }}
            >
              <span className="badge badge-success">Safe Mode ON</span>
              <span className="badge badge-success">Free Only ON</span>
              <span className="badge badge-info">AutoPilot ON</span>
              <span className="badge badge-success">Safe Publish ON</span>
            </div>

            <div
                className="flex gap-sm"
                style={{ flexWrap: "wrap", marginTop: "var(--space-lg)" }}
            >
              <button
                  type="button"
                  className="primary-button"
                  disabled={botRunning}
                  onClick={() => void handleRunBot("source_scan")}
              >
                {botRunning
                    ? "Đang chạy..."
                    : "Quét sản phẩm thật & tự public an toàn"}
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  disabled={botRunning}
                  onClick={() => void handleRunBot("full_safe_run")}
              >
                Chạy AutoPilot toàn bộ
              </button>

              <Link
                  href="/dashboard/product-sources"
                  className="secondary-button"
              >
                + Thêm nguồn sản phẩm
              </Link>

              <Link
                  href="/deals"
                  target="_blank"
                  rel="noreferrer"
                  className="secondary-button"
              >
                Xem public site
              </Link>
            </div>
          </div>

          <div className="command-hero-panel">
            <div className="grid grid-2" style={{ minWidth: 320 }}>
              <div className="metric-card">
                <span className="badge badge-info">Tổng item</span>
                <div className="stat-card-value">{stats.total}</div>
              </div>

              <div className="metric-card">
                <span className="badge badge-success">Đủ chuẩn public</span>
                <div className="stat-card-value">{stats.publicSafe}</div>
              </div>

              <div className="metric-card">
                <span className="badge badge-warning">Cần xem xét</span>
                <div className="stat-card-value">{stats.needsReview}</div>
              </div>

              <div className="metric-card">
                <span className="badge badge-neutral">Không phải SP</span>
                <div className="stat-card-value">{stats.nonProducts}</div>
              </div>
            </div>
          </div>
        </section>

        {toast && (
            <div className="toast-container">
              <div className={`toast toast-${toast.type}`}>{toast.message}</div>
            </div>
        )}

        {deleteConfirm && (
            <div className="dialog-overlay" onClick={() => setDeleteConfirm(null)}>
              <div className="dialog" onClick={(event) => event.stopPropagation()}>
                <div className="dialog-title">Xác nhận xoá</div>
                <div className="dialog-message">
                  Bạn chắc chắn muốn xoá sản phẩm này? Hành động không thể hoàn tác.
                </div>
                <div className="dialog-actions">
                  <button
                      className="btn btn-secondary"
                      onClick={() => setDeleteConfirm(null)}
                  >
                    Huỷ
                  </button>
                  <button
                      className="btn btn-danger"
                      disabled={actionRunning !== null}
                      onClick={() => void handleDelete(deleteConfirm)}
                  >
                    {actionRunning === `delete:${deleteConfirm}`
                        ? "Đang xoá..."
                        : "Xoá sản phẩm"}
                  </button>
                </div>
              </div>
            </div>
        )}

        {!loading && stats.total > 0 && (
            <div
                className="card"
                style={{
                  marginBottom: "var(--space-lg)",
                  padding: "var(--space-lg)",
                }}
            >
              <h3
                  style={{
                    fontWeight: 800,
                    fontSize: "var(--text-base)",
                    marginBottom: "var(--space-md)",
                    color: "var(--text-primary)",
                  }}
              >
                Safe Publish — Tổng hợp trạng thái
              </h3>

              <div
                  className="grid"
                  style={{
                    gridTemplateColumns: "repeat(auto-fill, minmax(138px, 1fr))",
                    gap: "var(--space-sm)",
                    marginBottom: "var(--space-md)",
                  }}
              >
                <div className="metric-card">
              <span
                  className="badge badge-success"
                  style={{ alignSelf: "flex-start" }}
              >
                Sản phẩm thật
              </span>
                  <div className="stat-card-value">{stats.realProducts}</div>
                </div>

                <div className="metric-card">
              <span
                  className="badge badge-warning"
                  style={{ alignSelf: "flex-start" }}
              >
                Ưu đãi shop
              </span>
                  <div className="stat-card-value">{stats.storeOffers}</div>
                </div>

                <div className="metric-card">
              <span
                  className="badge badge-warning"
                  style={{ alignSelf: "flex-start" }}
              >
                Voucher
              </span>
                  <div className="stat-card-value">{stats.vouchers}</div>
                </div>

                <div className="metric-card">
              <span
                  className="badge badge-warning"
                  style={{ alignSelf: "flex-start" }}
              >
                Campaign
              </span>
                  <div className="stat-card-value">{stats.campaigns}</div>
                </div>

                <div className="metric-card">
              <span
                  className="badge badge-success"
                  style={{ alignSelf: "flex-start" }}
              >
                Đang public
              </span>
                  <div className="stat-card-value">{stats.publicSafe}</div>
                </div>

                <div className="metric-card">
              <span
                  className="badge badge-info"
                  style={{ alignSelf: "flex-start" }}
              >
                Ứng viên public
              </span>
                  <div className="stat-card-value">{stats.publicCandidates}</div>
                </div>

                <div className="metric-card">
              <span
                  className="badge badge-danger"
                  style={{ alignSelf: "flex-start" }}
              >
                Published bị chặn
              </span>
                  <div className="stat-card-value">{stats.publishedButBlocked}</div>
                </div>

                <div className="metric-card">
              <span
                  className="badge badge-danger"
                  style={{ alignSelf: "flex-start" }}
              >
                Link lỗi
              </span>
                  <div className="stat-card-value">{stats.brokenLinks}</div>
                </div>

                <div className="metric-card">
              <span
                  className="badge badge-danger"
                  style={{ alignSelf: "flex-start" }}
              >
                Ảnh lỗi
              </span>
                  <div className="stat-card-value">{stats.brokenImages}</div>
                </div>

                <div className="metric-card">
              <span
                  className="badge badge-neutral"
                  style={{ alignSelf: "flex-start" }}
              >
                Đã ẩn/lưu
              </span>
                  <div className="stat-card-value">{stats.hidden}</div>
                </div>
              </div>

              {(stats.missingLink > 0 ||
                  stats.missingImage > 0 ||
                  stats.missingPrice > 0 ||
                  stats.publicSafe === 0) && (
                  <div
                      style={{
                        padding: "12px 16px",
                        borderRadius: "var(--radius-md)",
                        background: "rgba(251,191,36,0.08)",
                        border: "1px solid rgba(251,191,36,0.2)",
                        fontSize: "var(--text-sm)",
                        color: "var(--text-secondary)",
                        lineHeight: 1.6,
                      }}
                  >
                    Public site có thể tạm không có deal nếu Safe Publish chặn hết. Lý
                    do thường gặp: thiếu link ({stats.missingLink}), thiếu ảnh (
                    {stats.missingImage}), thiếu giá ({stats.missingPrice}), link/ảnh
                    lỗi, thiếu điểm nguồn hoặc dữ liệu là voucher/campaign/ưu đãi
                    shop. Hiện có {stats.publishedButBlocked} item mang trạng thái
                    published nhưng vẫn bị cổng public chặn.
                  </div>
              )}
            </div>
        )}

        <div className="filter-bar">
          <input
              className="input"
              style={{ maxWidth: "280px" }}
              placeholder="Tìm sản phẩm..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
          />

          <select
              className="select"
              style={{ maxWidth: "140px" }}
              value={filterPlatform}
              onChange={(event) => setFilterPlatform(event.target.value)}
          >
            <option value="">Nền tảng</option>
            <option value="shopee">Shopee</option>
            <option value="tiktok_shop">TikTok Shop</option>
            <option value="lazada">Lazada</option>
            <option value="accesstrade">AccessTrade</option>
            <option value="website">Website</option>
            <option value="tiki">Tiki</option>
            <option value="sendo">Sendo</option>
          </select>

          <select
              className="select"
              style={{ maxWidth: "140px" }}
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value)}
          >
            <option value="">Trạng thái</option>
            <option value="draft">Nháp</option>
            <option value="needs_review">Cần xem xét</option>
            <option value="approved">Đã duyệt</option>
            <option value="published">Đã xuất bản</option>
            <option value="archived">Lưu trữ</option>
          </select>

          <select
              className="select"
              style={{ maxWidth: "150px" }}
              value={filterKind}
              onChange={(event) => setFilterKind(event.target.value)}
          >
            <option value="">Loại dữ liệu</option>
            <option value="product">Sản phẩm</option>
            <option value="deal">Deal</option>
            <option value="store_offer">Ưu đãi shop</option>
            <option value="voucher">Voucher</option>
            <option value="campaign">Campaign</option>
            <option value="unknown">Chưa rõ</option>
          </select>

          <select
              className="select"
              style={{ maxWidth: "165px" }}
              value={filterPublic}
              onChange={(event) => setFilterPublic(event.target.value)}
          >
            <option value="">Safe Publish</option>
            <option value="safe">Đủ chuẩn public</option>
            <option value="blocked">Sản phẩm bị chặn</option>
            <option value="review">Cần xem xét</option>
            <option value="non_product">Không phải sản phẩm</option>
          </select>

          <select
              className="select"
              style={{ maxWidth: "120px" }}
              value={filterRisk}
              onChange={(event) => setFilterRisk(event.target.value)}
          >
            <option value="">Rủi ro</option>
            <option value="low">Thấp</option>
            <option value="medium">Trung bình</option>
            <option value="high">Cao</option>
          </select>

          <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={clearFilters}
          >
            Xóa lọc
          </button>

          <div className="view-toggle">
            <button
                type="button"
                className={`view-toggle-btn${viewMode === "table" ? " active" : ""}`}
                onClick={() => setViewMode("table")}
            >
              List
            </button>
            <button
                type="button"
                className={`view-toggle-btn${viewMode === "card" ? " active" : ""}`}
                onClick={() => setViewMode("card")}
            >
              Grid
            </button>
          </div>
        </div>

        {!loading && (
            <div
                style={{
                  margin: "0 0 var(--space-md)",
                  fontSize: "var(--text-xs)",
                  color: "var(--text-tertiary)",
                }}
            >
              Đang hiển thị {visibleProducts.length}/{products.length} item
              {" • "}Status published: {stats.publishedStatus}
              {" • "}Safe Public thực tế: {stats.publicSafe}
              {" • "}Đã lưu trữ: {stats.archived}
            </div>
        )}

        {loading && (
            <div className="loading-state">
              <div className="spinner" />
            </div>
        )}

        {!loading && visibleProducts.length === 0 && (
            <div className="empty-state">
              <div
                  className="empty-state-icon"
                  style={{ fontSize: "32px", opacity: 0.3 }}
              >
                P
              </div>
              <div className="empty-state-title">Chưa có sản phẩm nào</div>
              <div className="empty-state-desc">
                {filterKind
                    ? "Không có mục nào khớp với bộ lọc hiện tại."
                    : "Hãy chạy AutoPilot hoặc thêm nguồn affiliate. Nếu public site đang 0 deal, có thể Safe Publish đang chặn các item chưa đạt chuẩn."}
              </div>
              <div
                  className="flex gap-sm"
                  style={{ marginTop: "var(--space-lg)", justifyContent: "center" }}
              >
                <button
                    type="button"
                    className="btn btn-primary"
                    disabled={botRunning}
                    onClick={() => void handleRunBot("source_scan")}
                >
                  Quét nguồn
                </button>
                <Link
                    href="/dashboard/product-sources"
                    className="btn btn-secondary"
                >
                  + Thêm nguồn
                </Link>
              </div>
            </div>
        )}

        {!loading && visibleProducts.length > 0 && viewMode === "table" && (
            <div className="table-container">
              <table>
                <thead>
                <tr>
                  <th>Sản phẩm</th>
                  <th>Loại</th>
                  <th>Quyết định public</th>
                  <th>Nền tảng</th>
                  <th>Giá</th>
                  <th>Link / Ảnh</th>
                  <th>Điểm</th>
                  <th>Rủi ro</th>
                  <th>Hành động</th>
                </tr>
                </thead>

                <tbody>
                {visibleProducts.map((product) => {
                  const qualityScore = getQualityScore(product);

                  return (
                      <tr key={product.id}>
                        <td>
                          <div className="flex items-center gap-sm">
                            <SafeThumb
                                src={product.imageUrl}
                                label="SP"
                                size={40}
                            />

                            <div>
                              <Link
                                  href={`/dashboard/products/${product.id}`}
                                  style={{
                                    fontWeight: 700,
                                    fontSize: "var(--text-sm)",
                                  }}
                              >
                                {product.title}
                              </Link>

                              {renderSourceBadges(product)}
                            </div>
                          </div>
                        </td>

                        <td>{renderKindBadge(product)}</td>

                        <td>{renderDecisionBadge(product)}</td>

                        <td>
                      <span className="badge badge-neutral">
                        {getPlatformLabel(product)}
                      </span>
                        </td>

                        <td>
                          <div>
                            {product.salePrice ? (
                                <>
                            <span
                                style={{
                                  fontWeight: 700,
                                  color: "var(--color-accent-light)",
                                }}
                            >
                              {formatPrice(product.salePrice)}
                            </span>
                                  {product.price &&
                                      product.price !== product.salePrice && (
                                          <span
                                              style={{
                                                fontSize: "var(--text-xs)",
                                                color: "var(--text-tertiary)",
                                                textDecoration: "line-through",
                                                marginLeft: "6px",
                                              }}
                                          >
                                  {formatPrice(product.price)}
                                </span>
                                      )}
                                </>
                            ) : (
                                <span>{formatPrice(product.price)}</span>
                            )}
                          </div>
                        </td>

                        <td>{renderHealthBadges(product)}</td>

                        <td>
                          {qualityScore != null ? (
                              <span
                                  className={`score-badge ${
                                      qualityScore >= 75
                                          ? "score-badge-green"
                                          : qualityScore >= 45
                                              ? "score-badge-yellow"
                                              : "score-badge-red"
                                  }`}
                                  style={{ fontSize: "12px", padding: "4px 10px" }}
                              >
                          {qualityScore}
                        </span>
                          ) : (
                              "—"
                          )}
                        </td>

                        <td>
                      <span
                          className={`badge ${getRiskBadge(product.riskLevel)}`}
                      >
                        {getRiskLabel(product.riskLevel)}
                      </span>
                        </td>

                        <td>
                          <div className="flex gap-xs" style={{ flexWrap: "wrap" }}>
                            <Link
                                href={`/dashboard/products/${product.id}`}
                                className="btn btn-ghost btn-sm"
                                title="Xem"
                            >
                              Xem
                            </Link>

                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={actionRunning !== null}
                                onClick={() => void handleScore(product.id)}
                                title="Chấm điểm"
                            >
                              {actionRunning === `score:${product.id}`
                                  ? "Đang chấm..."
                                  : "Chấm điểm"}
                            </button>

                            {renderApproveButton(product)}

                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={actionRunning !== null}
                                onClick={() => void handleArchive(product.id)}
                                title="Lưu trữ"
                            >
                              {actionRunning === `archive:${product.id}`
                                  ? "Đang lưu..."
                                  : "Lưu trữ"}
                            </button>

                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={actionRunning !== null}
                                onClick={() => setDeleteConfirm(product.id)}
                                title="Xoá"
                                style={{ color: "var(--color-danger)" }}
                            >
                              Xoá
                            </button>
                          </div>
                        </td>
                      </tr>
                  );
                })}
                </tbody>
              </table>
            </div>
        )}

        {!loading && visibleProducts.length > 0 && viewMode === "card" && (
            <div className="grid grid-3">
              {visibleProducts.map((product) => {
                const kind = getEffectiveKind(product);
                const decision = getPublicDecision(product);
                const qualityScore = getQualityScore(product);

                return (
                    <div key={product.id} className="card product-card">
                      <div className="product-card-image">
                        <SafeThumb
                            src={product.imageUrl}
                            label="SP"
                            size={220}
                            rounded="var(--radius-lg)"
                        />

                        <div className="deal-card-platform">
                    <span className="badge badge-neutral">
                      {getPlatformLabel(product)}
                    </span>
                        </div>
                      </div>

                      <div style={{ padding: "var(--space-md)" }}>
                        <Link href={`/dashboard/products/${product.id}`}>
                          <h4 className="deal-card-title">{product.title}</h4>
                        </Link>

                        <div
                            className="flex items-center gap-sm"
                            style={{ margin: "var(--space-xs) 0", flexWrap: "wrap" }}
                        >
                    <span
                        className={`badge ${getStatusBadge(product.status)}`}
                        style={{ fontSize: "10px" }}
                    >
                      {getStatusLabel(product.status)}
                    </span>

                          <span
                              className={`badge ${getKindBadge(kind)}`}
                              style={{ fontSize: "10px" }}
                          >
                      {getKindLabel(kind)}
                    </span>

                          <span
                              className={`badge ${decision.badge}`}
                              style={{ fontSize: "10px" }}
                          >
                      {decision.label}
                    </span>

                          <span
                              className={`badge ${getRiskBadge(product.riskLevel)}`}
                              style={{ fontSize: "10px" }}
                          >
                      {getRiskLabel(product.riskLevel)}
                    </span>
                        </div>

                        <div
                            style={{
                              fontSize: 12,
                              color: isPublicSafeProduct(product)
                                  ? "#22c55e"
                                  : "#f59e0b",
                              marginBottom: "var(--space-xs)",
                              lineHeight: 1.45,
                            }}
                        >
                          {decision.reason}
                        </div>

                        <div style={{ marginBottom: "var(--space-xs)" }}>
                          {renderHealthBadges(product)}
                        </div>

                        <div
                            className="deal-card-price"
                            style={{ fontSize: "var(--text-lg)" }}
                        >
                          {product.salePrice
                              ? formatPrice(product.salePrice)
                              : formatPrice(product.price)}
                        </div>

                        {qualityScore != null && (
                            <div style={{ margin: "var(--space-xs) 0" }}>
                      <span
                          className={`score-badge ${
                              qualityScore >= 75
                                  ? "score-badge-green"
                                  : qualityScore >= 45
                                      ? "score-badge-yellow"
                                      : "score-badge-red"
                          }`}
                          style={{ fontSize: "11px" }}
                      >
                        {product.scoreLabel || `${qualityScore} điểm`}
                      </span>
                            </div>
                        )}

                        <div
                            className="flex gap-xs"
                            style={{ marginTop: "var(--space-sm)", flexWrap: "wrap" }}
                        >
                          <Link
                              href={`/dashboard/products/${product.id}`}
                              className="btn btn-sm btn-ghost"
                          >
                            Xem
                          </Link>

                          <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              disabled={actionRunning !== null}
                              onClick={() => void handleScore(product.id)}
                              title="Chấm điểm"
                          >
                            {actionRunning === `score:${product.id}`
                                ? "Đang chấm..."
                                : "Chấm điểm"}
                          </button>

                          {renderApproveButton(product)}

                          <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              disabled={actionRunning !== null}
                              onClick={() => void handleArchive(product.id)}
                              title="Lưu trữ"
                          >
                            {actionRunning === `archive:${product.id}`
                                ? "Đang lưu..."
                                : "Lưu trữ"}
                          </button>

                          <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              disabled={actionRunning !== null}
                              onClick={() => setDeleteConfirm(product.id)}
                              title="Xoá"
                              style={{ color: "var(--color-danger)" }}
                          >
                            Xoá
                          </button>
                        </div>
                      </div>
                    </div>
                );
              })}
            </div>
        )}
      </>
  );
}
