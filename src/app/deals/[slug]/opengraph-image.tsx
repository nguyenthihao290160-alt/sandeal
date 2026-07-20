import { ImageResponse } from 'next/og';
import { getPublicProductBySlugSafe } from '@/lib/product-intelligence/publicProducts';

export const alt = 'Thông tin sản phẩm trên SanDeal';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function ProductOpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getPublicProductBySlugSafe(slug);
  const title = result?.product.title || 'Kiểm tra giá và độ tin cậy trước khi mua';
  const updatedAt = result?.product.priceObservedAt || result?.product.updatedAt;
  const updateLabel = updatedAt && Number.isFinite(Date.parse(updatedAt))
    ? `Dữ liệu cập nhật ${new Date(updatedAt).toLocaleDateString('vi-VN')}`
    : 'Nguồn và thời điểm kiểm tra được ghi rõ';
  return new ImageResponse(
    <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', padding: 72, color: '#172033', background: 'linear-gradient(135deg, #f6f8fc 0%, #e8efff 62%, #dff6f2 100%)', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 1000 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, color: '#3157c8', fontSize: 38, fontWeight: 850 }}>
          <div style={{ display: 'flex', width: 68, height: 68, alignItems: 'center', justifyContent: 'center', color: 'white', background: 'linear-gradient(145deg, #3157c8, #0f7b8d)', borderRadius: 17, fontSize: 47, fontWeight: 900 }}>S</div>
          SanDeal
        </div>
        <div style={{ display: 'flex', fontSize: title.length > 80 ? 48 : 60, lineHeight: 1.08, fontWeight: 900, letterSpacing: -1.5 }}>{title}</div>
        <div style={{ display: 'flex', color: '#526074', fontSize: 26 }}>{updateLabel} · Giá cuối cùng do nhà bán xác nhận</div>
      </div>
    </div>,
    size,
  );
}
