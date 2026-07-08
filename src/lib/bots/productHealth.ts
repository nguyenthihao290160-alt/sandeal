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
import { checkLinkHealth, checkImageHealth } from './productHealthCheck';
import type { Product } from '../types';

type ProductRecord = Product & Record<string, unknown>;

export interface HealthCleanupSummary {
  checked: number;
  healthy: number;
  hidden: number;
  linkBroken: number;
  imageBroken: number;
  errors: number;
}

function getText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

/**
 * Chạy health check cho tất cả sản phẩm đang published/approved.
 * Nếu phát hiện link hoặc ảnh lỗi:
 *  - publicHidden = true
 *  - status = "needs_review"
 *  - aiApproved = false
 *  - autoPublished = false
 *  - Ghi linkHealthStatus / imageHealthStatus
 *
 * Không xóa sản phẩm. Không mất dữ liệu gốc.
 * Mỗi item wrap try/catch — một lỗi không crash cả batch.
 */
export async function runProductHealthCleanup(): Promise<HealthCleanupSummary> {
  const summary: HealthCleanupSummary = {
    checked: 0,
    healthy: 0,
    hidden: 0,
    linkBroken: 0,
    imageBroken: 0,
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
      const updates: Record<string, unknown> = {};

      // Check link health
      if (linkUrl) {
        const linkResult = await checkLinkHealth(linkUrl);

        updates.linkHealthStatus = linkResult.status;
        updates.linkLastCheckedAt = new Date().toISOString();

        if (!linkResult.ok) {
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

      // Check image health (chỉ nếu link vẫn ok — tránh double-hide)
      if (imageUrl) {
        const imageResult = await checkImageHealth(imageUrl);

        updates.imageHealthStatus = imageResult.status;

        if (!imageResult.ok) {
          if (isHealthy) {
            // Chỉ count nếu link ok mà ảnh lỗi (tránh count trùng)
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
        summary.healthy++;
        // Cập nhật health status mới nhất ngay cả khi healthy
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
