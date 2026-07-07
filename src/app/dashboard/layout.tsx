'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useState } from 'react';

/* ---- SVG Icon components (inline, no library) ---- */
const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

const ICONS: Record<string, string> = {
  command: 'M4 4h16v16H4zM9 9h6v6H9z',
  bot: 'M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4M9 14h.01M15 14h.01',
  source: 'M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9zM3.6 9h16.8M3.6 15h16.8',
  product: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  content: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6',
  vault: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM12 8v4M12 16h.01',
  health: 'M22 12h-4l-3 9L9 3l-3 9H2',
  settings: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zM12 6v6l4 2',
  tools: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
};

const NAV_GROUPS = [
  {
    label: 'TỔNG QUAN',
    items: [
      { label: 'AI Command Center', href: '/dashboard', icon: 'command' },
      { label: 'Đội Bot AI', href: '/dashboard/ai-bots', icon: 'bot' },
    ],
  },
  {
    label: 'TỰ ĐỘNG HÓA',
    items: [
      { label: 'Nguồn dữ liệu', href: '/dashboard/product-sources', icon: 'source' },
      { label: 'Kết quả bot', href: '/dashboard/products', icon: 'product' },
      { label: 'Bài review AI', href: '/dashboard/content', icon: 'content' },
    ],
  },
  {
    label: 'BẢO MẬT & HỆ THỐNG',
    items: [
      { label: 'Token Vault', href: '/dashboard/token-vault', icon: 'vault' },
      { label: 'Sức khỏe hệ thống', href: '/dashboard/app-health', icon: 'health' },
      { label: 'Cài đặt an toàn', href: '/dashboard/settings', icon: 'settings' },
    ],
  },
];

const LEGACY_ITEMS = [
  { label: 'Media', href: '/dashboard/media' },
  { label: 'Kênh kết nối', href: '/dashboard/channels' },
  { label: 'Lịch đăng', href: '/dashboard/schedule' },
  { label: 'Hàng đợi', href: '/dashboard/queue' },
  { label: 'Compliance Guard', href: '/dashboard/compliance' },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [legacyOpen, setLegacyOpen] = useState(false);

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="dashboard-sidebar-brand">
          <h2>SanDeal</h2>
          <p>REVIEWPILOT AI COMMAND CENTER</p>
        </div>

        <div className="dashboard-sidebar-nav">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="dashboard-sidebar-group">
              <div className="dashboard-sidebar-group-label">{group.label}</div>
              {group.items.map((item) => {
                const hrefBase = item.href.split('?')[0];
                const isActive =
                  item.href === '/dashboard'
                    ? pathname === '/dashboard'
                    : pathname.startsWith(hrefBase) && hrefBase !== '/dashboard';
                return (
                  <Link key={item.href} href={item.href} className={`dashboard-sidebar-link${isActive ? ' active' : ''}`}>
                    <span className="dashboard-sidebar-link-icon">
                      <Icon d={ICONS[item.icon] || ICONS.command} size={16} />
                    </span>
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}

          {/* Legacy tools - collapsed */}
          <div className="dashboard-sidebar-group">
            <button
              className="dashboard-sidebar-collapse-toggle"
              onClick={() => setLegacyOpen(!legacyOpen)}
            >
              <Icon d={ICONS.tools} size={12} />
              <span>{legacyOpen ? '▾' : '▸'} Công cụ cũ</span>
            </button>
            {legacyOpen && LEGACY_ITEMS.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href} className={`dashboard-sidebar-link${isActive ? ' active' : ''}`}
                  style={{ fontSize: '12px', paddingLeft: '24px', opacity: 0.7 }}>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>

        <div className="dashboard-sidebar-footer">
          <div className="dashboard-sidebar-footer-card">
            <div className="dashboard-sidebar-footer-row">
              <span className="dashboard-sidebar-footer-dot on" />
              <span>Safe Mode ON</span>
            </div>
            <div className="dashboard-sidebar-footer-row">
              <span className="dashboard-sidebar-footer-dot off" />
              <span>Auto Publish OFF</span>
            </div>
            <Link href="/deals" className="dashboard-sidebar-link" target="_blank"
              style={{ padding: '4px 0', fontSize: '11px', color: '#22d3ee', marginTop: '4px' }}>
              <Icon d={ICONS.external} size={12} />
              <span>View public site</span>
            </Link>
          </div>
        </div>
      </aside>

      <main className="dashboard-main">
        {children}
      </main>
    </div>
  );
}
