import Link from 'next/link';

export function UnavailableModule({ title, description, href = '/dashboard', action = 'Về Bảng điều khiển' }: { title: string; description: string; href?: string; action?: string }) {
  return <main className="page-content">
    <header className="page-header"><div><h1 className="page-header-title">{title}</h1><p className="page-header-desc">{description}</p></div></header>
    <section className="card" style={{ maxWidth: 760 }}>
      <span className="badge badge-warning">Tạm thời chưa khả dụng</span>
      <h2 className="card-title" style={{ marginTop: 14 }}>Chức năng chưa được nối với bộ xử lý nền</h2>
      <p className="page-subtitle" style={{ marginTop: 8, marginBottom: 18 }}>Hệ thống chưa thực hiện thao tác và dữ liệu hiện tại không bị thay đổi. Vui lòng dùng các chức năng đã được xác minh trong Bảng điều khiển.</p>
      <Link href={href} className="btn btn-primary">{action}</Link>
    </section>
  </main>;
}
