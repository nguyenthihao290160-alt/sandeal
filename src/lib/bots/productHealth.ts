// ===========================================
// Product Health Guard — Cleanup Module
// Recheck link + image cho sản phẩm đã published/approved
// Ẩn sản phẩm có link/ảnh hỏng, không xóa dữ liệu
//
// Có thể gọi mỗi 30–60 phút qua cron hoặc endpoint thủ công.
// Hiện tại ưu tiên chạy thủ công qua:
//   POST /api/products/health-check
// ===========================================

import { getAllProducts, updateProduct } from '../storage/products';
import { checkLinkHealth, isRetryableLinkStatus, isRetryableImageStatus, resolveHealthyImageCandidate } from './productHealthCheck';
import type { LinkCheckStatus, ImageCheckStatus } from './productHealthCheck';
import type { Product } from '../types';
import { getDomainCircuitDecision, recordDomainHealth } from './domainCircuitBreaker';

type ProductRecord = Product & Record<string, unknown>;

export interface HealthCleanupSummary {
  checked: number;
  healthy: number;
  hidden: number;
  linkBroken: number;
  imageBroken: number;
  retryable: number;
  errors: number;
}

export interface ProductHealthCleanupOptions {
  fetchImpl?: typeof fetch;
  resolveDns?: boolean;
  now?: () => number;
  random?: () => number;
}

function getText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

/**
 * V2: Only hide products for PERMANENT failures (broken/image_broken).
 * Retryable failures (timeout, rate_limited, server_error, etc.)
 * update the status field but do NOT hide or unpublish.
 */
export async function runProductHealthCleanup(options: ProductHealthCleanupOptions = {}): Promise<HealthCleanupSummary> {
  const summary: HealthCleanupSummary = {
    checked: 0,
    healthy: 0,
    hidden: 0,
    linkBroken: 0,
    imageBroken: 0,
    retryable: 0,
    errors: 0,
  };

  let allProducts: Product[];

  try {
    allProducts = await getAllProducts();
  } catch (err) {
    console.error('[ProductHealthGuard] Không đọc được danh sách sản phẩm:', err);
    summary.errors = 1;
    return summary;
  }

  // Chỉ check sản phẩm đang public (published hoặc approved)
  const publicProducts = allProducts.filter(
    (p) => p.status === 'published' || p.status === 'approved',
  );

  for (const product of publicProducts) {
    try {
      summary.checked++;
      const p = product as ProductRecord;

      // Tìm URL để check
      const linkUrl =
        getText(p.affiliateUrl) ||
        getText(p.originalUrl) ||
        getText(p.url) ||
        getText(p.productUrl);

      const imageUrl = getText(p.imageUrl);

      let isHealthy = true;
      let hasRetryableIssue = false;
      const updates: Record<string, unknown> = {};
      const nowMs = (options.now || Date.now)();
      const checkedAt = new Date(nowMs).toISOString();

      // Check link health
      if (linkUrl) {
        const circuit = await getDomainCircuitDecision(linkUrl, nowMs);
        const linkResult = circuit.allowed
          ? await checkLinkHealth(linkUrl, { fetchImpl: options.fetchImpl, resolveDns: options.resolveDns })
          : { status: 'timeout' as const, ok: false, retryable: true, reason: 'Domain circuit open', retryAfter: circuit.retryAt };
        const circuitState = circuit.allowed
          ? await recordDomainHealth(linkUrl, linkResult.status, nowMs, { retryAfter: linkResult.retryAfter, random: options.random })
          : null;

        updates.linkHealthStatus = linkResult.status;
        updates.linkLastCheckedAt = checkedAt;
        updates.sourceHealthCooldownUntil = linkResult.ok ? undefined : circuit.retryAt || circuitState?.nextRetryAt;
        updates.sourceHealthReason = linkResult.ok ? undefined : linkResult.status;

        if (!linkResult.ok) {
          const linkRetryable = isRetryableLinkStatus(linkResult.status as LinkCheckStatus);

          if (linkRetryable) {
            // Retryable failure: record status but do NOT hide/unpublish
            hasRetryableIssue = true;
            console.log(
              `[ProductHealthGuard] Link retryable: ${product.id} — ${linkResult.status}: ${linkResult.reason}`,
            );
          } else {
            // Permanent failure: hide product
            isHealthy = false;
            summary.linkBroken++;
            updates.publicHidden = true;
            updates.status = 'needs_review';
            updates.aiApproved = false;
            updates.autoPublished = false;
            updates.unpublishedReason = `Link lỗi: ${linkResult.reason}`;
            console.log(
              `[ProductHealthGuard] Link broken: ${product.id} — ${linkResult.status}: ${linkResult.reason}`,
            );
          }
        }
      } else {
        // Không có link mua → ẩn
        isHealthy = false;
        summary.linkBroken++;
        updates.linkHealthStatus = 'broken';
        updates.publicHidden = true;
        updates.status = 'needs_review';
        updates.aiApproved = false;
        updates.autoPublished = false;
        updates.unpublishedReason = 'Không có link mua hàng';
      }

      // Check image health
      if (imageUrl) {
        const rawCandidates = Array.isArray(p.imageCandidates) ? p.imageCandidates.map(getText) : [];
        const gallery = Array.isArray(product.gallery) ? product.gallery : [];
        const imageResolution = await resolveHealthyImageCandidate(
          [imageUrl, ...rawCandidates, ...gallery],
          { fetchImpl: options.fetchImpl, resolveDns: options.resolveDns },
        );
        const imageResult = imageResolution.result;
        for (const checked of imageResolution.checked) {
          await recordDomainHealth(checked.url, checked.result.status, nowMs, { random: options.random });
        }

        updates.imageHealthStatus = imageResult.status;
        updates.imageLastCheckedAt = checkedAt;
        if (imageResolution.selectedUrl && imageResolution.selectedUrl !== imageUrl) updates.imageUrl = imageResolution.selectedUrl;

        if (!imageResult.ok) {
          const imageRetryable = isRetryableImageStatus(imageResult.status as ImageCheckStatus);

          if (imageRetryable) {
            // Retryable failure: record but do NOT count as image_broken
            hasRetryableIssue = true;
            console.log(
              `[ProductHealthGuard] Image retryable: ${product.id} — ${imageResult.status}: ${imageResult.reason}`,
            );
          } else {
            // Permanent failure
            if (isHealthy) {
              summary.imageBroken++;
            }
            isHealthy = false;
            updates.publicHidden = true;
            updates.status = 'needs_review';
            updates.aiApproved = false;
            updates.autoPublished = false;
            updates.unpublishedReason = updates.unpublishedReason
              ? `${updates.unpublishedReason}; Ảnh lỗi: ${imageResult.reason}`
              : `Ảnh lỗi: ${imageResult.reason}`;
            console.log(
              `[ProductHealthGuard] Image broken: ${product.id} — ${imageResult.status}: ${imageResult.reason}`,
            );
          }
        }
      } else {
        // Không có ảnh → ẩn
        if (isHealthy) {
          summary.imageBroken++;
        }
        isHealthy = false;
        updates.imageHealthStatus = 'image_broken';
        updates.publicHidden = true;
        updates.status = 'needs_review';
        updates.aiApproved = false;
        updates.autoPublished = false;
        updates.unpublishedReason = updates.unpublishedReason
          ? `${updates.unpublishedReason}; Không có ảnh sản phẩm`
          : 'Không có ảnh sản phẩm';
      }

      if (isHealthy) {
        if (hasRetryableIssue) {
          summary.retryable++;
        } else {
          summary.healthy++;
        }
        // Update health status but keep product published
        updates.linkHealthStatus = updates.linkHealthStatus || 'ok';
        updates.imageHealthStatus = updates.imageHealthStatus || 'ok';
      } else {
        summary.hidden++;
      }

      // Persist updates
      await updateProduct(product.id, updates as Partial<Product>);
    } catch (itemError) {
      summary.errors++;
      console.error(
        `[ProductHealthGuard] Lỗi khi check sản phẩm ${product.id}:`,
        itemError instanceof Error ? itemError.message : String(itemError),
      );
      // Tiếp tục item khác — không crash cả batch
    }
  }

  console.log('[ProductHealthGuard] Cleanup xong:', JSON.stringify(summary));
  return summary;
}
