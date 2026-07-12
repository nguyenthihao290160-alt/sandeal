import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'SanDeal đánh giá sản phẩm như thế nào?',
  description: 'Phương pháp SanDeal kiểm tra dữ liệu, liên kết, hình ảnh và tạo nhận định biên tập minh bạch.',
  alternates: { canonical: '/review-methodology' },
};

export default function ReviewMethodologyPage() {
  return <main className="market-container" style={{ maxWidth: 840, padding: '48px 20px 80px', lineHeight: 1.75 }}>
    <nav aria-label="Breadcrumb"><Link href="/">Trang chủ</Link> {' / '} Phương pháp đánh giá</nav>
    <h1>SanDeal đánh giá sản phẩm như thế nào?</h1>
    <p>SanDeal tổng hợp dữ liệu sản phẩm từ nguồn đối tác, sau đó kiểm tra các trường bắt buộc, giá, liên kết sản phẩm, liên kết affiliate và hình ảnh. Chỉ dữ kiện có thể truy về field canonical mới được trình bày như sự thật.</p>
    <h2>Ba lớp thông tin</h2>
    <p>Dữ kiện đã xác minh được tách khỏi nhận định biên tập. Nhận định luôn nêu căn cứ và mức tin cậy. Những nội dung như trải nghiệm thực tế, độ bền hoặc hiệu quả dài hạn được ghi là chưa xác minh nếu không có bằng chứng.</p>
    <h2>Tự động hóa và kiểm soát chất lượng</h2>
    <p>Hệ thống dùng quy tắc miễn phí, không gọi mô hình trả phí. Claim thiếu evidence, nội dung gần trùng, trang mỏng hoặc sản phẩm không vượt Safe Publish đều bị chặn lập chỉ mục.</p>
    <h2>Giá, liên kết và affiliate</h2>
    <p>Giá có thể thay đổi tại website đối tác. SanDeal có thể nhận hoa hồng khi người đọc mua qua liên kết affiliate, nhưng không trực tiếp bán hàng và không thay đổi giá người mua phải trả.</p>
    <h2>Báo lỗi</h2>
    <p>Nếu phát hiện giá, ảnh hoặc liên kết không còn chính xác, vui lòng liên hệ support@sandeal.tech và gửi URL trang sản phẩm.</p>
    <p><Link href="/deals">Xem danh sách sản phẩm đã vượt kiểm tra</Link></p>
  </main>;
}
