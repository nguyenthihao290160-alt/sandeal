import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PublicFooter, PublicHeader } from '@/components/public';
import styles from '@/components/public/public.module.css';

const PAGES = {
  'chinh-sach-bao-mat': {
    title: 'Chính sách bảo mật',
    description: 'Dữ liệu SanDeal xử lý khi bạn tìm kiếm, xem sản phẩm và mở liên kết nhà bán.',
    sections: [
      ['Dữ liệu được ghi nhận', 'SanDeal có thể ghi nhận trang nguồn, lượt xem sản phẩm, truy vấn tìm kiếm, lượt nhấp affiliate, thời điểm và một mã phiên ẩn danh. Hệ thống không cần họ tên, số điện thoại hay thông tin thanh toán để cung cấp các chức năng công khai này.'],
      ['Mục đích sử dụng', 'Dữ liệu vận hành được dùng để đo chất lượng tìm kiếm, phát hiện liên kết hỏng, chống lạm dụng và cải thiện nội dung. Token, credential và header xác thực không được đưa vào sự kiện analytics công khai.'],
      ['Cookie và lưu trữ trình duyệt', 'SanDeal có thể dùng cookie hoặc session storage cần thiết cho phiên ẩn danh, tùy chọn giao diện và bảo vệ khi website vừa cập nhật. Không có số liệu conversion hoặc commission nếu provider chưa cung cấp dữ liệu thật.'],
      ['Lưu giữ và yêu cầu', 'Dữ liệu được giữ theo chính sách vận hành hiện hành và giới hạn kỹ thuật. Bạn có thể dùng trang Liên hệ để yêu cầu làm rõ, sửa hoặc gỡ dữ liệu liên quan đến nội dung công khai.'],
    ],
  },
  'dieu-khoan-su-dung': {
    title: 'Điều khoản sử dụng',
    description: 'Giới hạn và trách nhiệm khi dùng dữ liệu giá, ưu đãi và liên kết trên SanDeal.',
    sections: [
      ['Thông tin tham khảo', 'SanDeal tổng hợp dữ liệu để hỗ trợ kiểm tra deal. Giá, tồn kho, vận chuyển và điều kiện ưu đãi có thể thay đổi; nhà bán quyết định thông tin cuối cùng tại thời điểm giao dịch.'],
      ['Không phải nhà bán', 'SanDeal không trực tiếp bán hàng, thu tiền hoặc quyết định việc thực hiện đơn hàng. Hãy kiểm tra lại sản phẩm, nhà bán và điều kiện trên trang đích trước khi mua.'],
      ['Sử dụng hợp lý', 'Không được cố ý vượt kiểm soát truy cập, gây quá tải, thu thập credential hoặc dùng SanDeal để phát tán dữ liệu sai lệch. Nội dung có thể được sửa hoặc gỡ khi nguồn không còn đáng tin.'],
      ['Giới hạn minh bạch', 'Trạng thái xác minh phản ánh bằng chứng SanDeal có tại thời điểm ghi nhận, không phải chứng nhận tuyệt đối về nhà bán hoặc sản phẩm.'],
    ],
  },
  'minh-bach-affiliate': {
    title: 'Minh bạch affiliate',
    description: 'Cách liên kết tiếp thị liên kết hoạt động trên SanDeal.',
    sections: [
      ['Hoa hồng có thể phát sinh', 'Một số nút dẫn tới nhà bán là liên kết affiliate. SanDeal có thể nhận hoa hồng nếu giao dịch đủ điều kiện; người dùng không phải trả thêm phí chỉ vì đi qua liên kết đó.'],
      ['Không thay đổi tiêu chuẩn dữ liệu', 'Quan hệ affiliate không biến voucher, campaign hoặc ưu đãi cửa hàng thành sản phẩm. Chỉ sản phẩm canonical đã vượt các kiểm tra public mới xuất hiện như product card.'],
      ['Giá tại nhà bán là quyết định cuối', 'Giá và điều kiện hiển thị tại SanDeal là dữ liệu đã ghi nhận. Hãy kiểm tra lại trang nhà bán trước khi quyết định.'],
    ],
  },
  'lien-he': {
    title: 'Liên hệ và yêu cầu sửa/gỡ dữ liệu',
    description: 'Kênh báo dữ liệu sai, link hỏng hoặc yêu cầu sửa và gỡ nội dung SanDeal.',
    sections: [
      ['Nội dung cần cung cấp', 'Hãy gửi URL SanDeal liên quan, mô tả điểm chưa chính xác, URL nguồn nếu có và yêu cầu mong muốn. Không gửi mật khẩu, token, thông tin thanh toán hoặc dữ liệu cá nhân không cần thiết.'],
      ['Quy trình xử lý', 'SanDeal sẽ đối chiếu nguồn, thời điểm kiểm tra và bằng chứng hiện có. Nội dung có thể bị ẩn trong khi xác minh; việc sửa hoặc gỡ không đồng nghĩa thừa nhận trách nhiệm pháp lý.'],
      ['Kênh liên hệ hiện có', 'Trong giai đoạn vận hành hiện tại, hãy mở issue tại repository SanDeal và không đính kèm secret hay dữ liệu cá nhân. Kênh hỗ trợ riêng sẽ được công bố khi được owner xác minh.'],
    ],
    contact: true,
  },
} as const;

type Slug = keyof typeof PAGES;

export function generateStaticParams() {
  return Object.keys(PAGES).map(slug => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = PAGES[slug as Slug];
  if (!page) return {};
  return { title: page.title, description: page.description, alternates: { canonical: `/thong-tin/${slug}` } };
}

export default async function InformationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = PAGES[slug as Slug];
  if (!page) notFound();
  return <div className={styles.shell}>
    <PublicHeader />
    <main><section className={styles.section}><div className={`${styles.container} ${styles.methodologyContent}`}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb"><Link href="/">Trang chủ</Link><span aria-hidden="true">/</span><span aria-current="page">{page.title}</span></nav>
      <h1>{page.title}</h1><p>{page.description}</p>
      {page.sections.map(([heading, body]) => <section key={heading}><h2>{heading}</h2><p>{body}</p></section>)}
      {'contact' in page && page.contact && <p><a className={styles.textButton} href="https://github.com/nguyenthihao290160-alt/sandeal/issues" rel="noreferrer noopener">Mở kênh liên hệ công khai</a></p>}
    </div></section></main>
    <PublicFooter />
  </div>;
}
