import Link from 'next/link';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import styles from '../operations.module.css';

export default function ContentPage() {
  return <main className={styles.page}>
    <header className={styles.header}><div><h1>Sản phẩm và bài đánh giá</h1><p>Route được giữ để không làm hỏng liên kết cũ; phần tạo bài đánh giá chưa có backend hoàn chỉnh nên được hạ mức ưu tiên.</p></div><span className={`${styles.badge} ${styles.warning}`}>Đang hoàn thiện</span></header>
    <section className={`${styles.panel} ${styles.warningPanel}`}><div className={styles.panelHeader}><h2><DashboardIcon name="content" size={19} />Phạm vi hiện tại</h2></div><div className={styles.notice}><strong>Chưa khả dụng:</strong> tạo, kiểm duyệt và xuất bản bài đánh giá. Hệ thống chưa thực hiện thao tác và dữ liệu hiện tại không bị thay đổi.</div></section>
    <div className={styles.grid}>
      <section className={`${styles.panel} ${styles.successPanel}`}><div className={styles.panelHeader}><h2><DashboardIcon name="product" size={19} />Chức năng đã dùng được</h2></div><div className={styles.healthList}><div className={styles.healthRow}><span>Danh sách sản phẩm</span><strong>Dữ liệu backend thật</strong></div><div className={styles.healthRow}><span>Tìm kiếm và bộ lọc</span><strong>Đã hoạt động</strong></div><div className={styles.healthRow}><span>Kiểm tra đăng an toàn</span><strong>Đã kết nối</strong></div></div><div className={styles.emptyActions} style={{ padding: 16, justifyContent: 'flex-start' }}><Link href="/dashboard/products" className={styles.primary}>Mở Kết quả bot</Link></div></section>
      <section className={`${styles.panel} ${styles.infoPanel}`}><div className={styles.panelHeader}><h2><DashboardIcon name="source" size={19} />Bước chuẩn bị</h2></div><div className={styles.healthList}><div className={styles.healthRow}><span>Thêm nguồn sản phẩm</span><strong>Có thể thực hiện</strong></div><div className={styles.healthRow}><span>Kết nối Gemini</span><strong>Chỉ cần khi backend bài đánh giá hoàn tất</strong></div><div className={styles.healthRow}><span>Gọi dịch vụ tính phí</span><strong>Đang bị chặn</strong></div></div><div className={styles.emptyActions} style={{ padding: 16, justifyContent: 'flex-start' }}><Link href="/dashboard/product-sources" className={styles.button}>Quản lý nguồn sản phẩm</Link></div></section>
    </div>
  </main>;
}
