'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';

const NAV_GROUPS = [
  {
    label: 'TỔNG QUAN',
    items: [
      { label: 'AI Command Center', href: '/dashboard/ai-bots' },
      { label: 'Dashboard', href: '/dashboard' },
    ],
  },
  {
    label: 'DỮ LIỆU',
    items: [
      { label: 'Token Vault', href: '/dashboard/token-vault' },
      { label: 'Nguồn sản phẩm', href: '/dashboard/product-sources' },
      { label: 'Kho sản phẩm', href: '/dashboard/products' },
    ],
  },
  {
    label: 'NỘI DUNG',
    items: [
      { label: 'Content Studio', href: '/dashboard/content' },
      { label: 'Kênh kết nối', href: '/dashboard/channels' },
    ],
  },
  {
    label: 'AN TOÀN',
    items: [
      { label: 'Compliance Guard', href: '/dashboard/compliance' },
      { label: 'Sức khỏe hệ thống', href: '/dashboard/app-health' },
      { label: 'Cài đặt', href: '/dashboard/settings' },
    ],
  },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h2>SanDeal</h2>
          <p>ReviewPilot AI Command Center</p>
        </div>

        <div className="sidebar-nav">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="sidebar-group">
              <div className="sidebar-group-label">{group.label}</div>
              {group.items.map((item) => {
                const hrefBase = item.href.split('?')[0];
                const isActive =
                  item.href === '/dashboard'
                    ? pathname === '/dashboard'
                    : pathname.startsWith(hrefBase) && hrefBase !== '/dashboard';
                return (
                  <Link key={item.href} href={item.href} className={`sidebar-link${isActive ? ' active' : ''}`}>
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-footer-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <span className="status-dot status-dot-ok">Safe Mode: ON</span>
            </div>
            <Link href="/deals" className="sidebar-link sidebar-link-external" target="_blank" style={{ padding: '4px 0', fontSize: '11px' }}>
              View public site →
            </Link>
          </div>
        </div>
      </aside>

      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
