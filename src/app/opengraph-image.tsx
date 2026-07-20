import { ImageResponse } from 'next/og';

export const alt = 'SanDeal — Kiểm tra giá và độ tin cậy trước khi mua';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', padding: 72, color: '#172033', background: 'linear-gradient(135deg, #f6f8fc 0%, #e8efff 62%, #dff6f2 100%)', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 980 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, color: '#3157c8', fontSize: 42, fontWeight: 850 }}>
          <div style={{ display: 'flex', width: 72, height: 72, alignItems: 'center', justifyContent: 'center', color: 'white', background: 'linear-gradient(145deg, #3157c8, #0f7b8d)', borderRadius: 18, fontSize: 50, fontWeight: 900 }}>S</div>
          SanDeal
        </div>
        <div style={{ display: 'flex', fontSize: 66, lineHeight: 1.08, fontWeight: 900, letterSpacing: -2 }}>Kiểm tra giá và độ tin cậy trước khi mua</div>
        <div style={{ display: 'flex', color: '#526074', fontSize: 28 }}>Nguồn rõ ràng · Link được kiểm tra · Không lấp dữ liệu còn thiếu</div>
      </div>
    </div>,
    size,
  );
}
