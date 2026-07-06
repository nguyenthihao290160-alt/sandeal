'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';

const NAV_GROUPS = [
  {
    label: 'Kiếm tiền',
    items: [
      { label: 'Tổng quan', href: '/dashboard', icon: '📊' },
      { label: 'Trung tâm nguồn SP', href: '/dashboard/product-sources', icon: '🔗' },
      { label: 'Danh sách sản phẩm', href: '/dashboard/products', icon: '📦' },
      { label: 'Sản phẩm nên làm', href: '/dashboard/products?minScore=75', icon: '⭐' },
    ],
  },
  {
    label: 'Tạo nội dung',
    items: [
      { label: 'AI Content', href: '/dashboard/content', icon: '🤖' },
      { label: 'Media / Video', href: '/dashboard/media', icon: '🎬' },
      { label: 'Kiểm duyệt nội dung', href: '/dashboard/compliance', icon: '🛡️' },
    ],
  },
  {
    label: 'Đăng & lịch',
    items: [
      { label: 'Kênh kết nối', href: '/dashboard/channels', icon: '📡' },
      { label: 'Lịch đăng', href: '/dashboard/schedule', icon: '📅' },
      { label: 'Hàng đợi', href: '/dashboard/queue', icon: '⏳' },
    ],
  },
  {
    label: 'Hệ thống',
    items: [
      { label: 'API / Token Vault', href: '/dashboard/token-vault', icon: '🔐' },
      { label: 'Sức khỏe hệ thống', href: '/dashboard/app-health', icon: '💚' },
      { label: 'Cài đặt', href: '/dashboard/settings', icon: '⚙️' },
    ],
  },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h2>SanDeal</h2>
          <p>ReviewPilot AI Dashboard</p>
        </div>
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="sidebar-group">
            <div className="sidebar-group-label">{group.label}</div>
            {group.items.map((item) => {
              const isActive =
                item.href === '/dashboard'
                  ? pathname === '/dashboard'
                  : pathname.startsWith(item.href.split('?')[0]) && item.href !== '/dashboard';
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`sidebar-link${isActive ? ' active' : ''}`}
                >
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
        <div className="sidebar-group" style={{ marginTop: 'auto', borderTop: '1px solid var(--border-primary)', paddingTop: 'var(--space-md)' }}>
          <Link href="/deals" className="sidebar-link" target="_blank">
            <span>🌐</span>
            <span>Xem trang public</span>
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
