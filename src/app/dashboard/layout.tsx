'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

/* ---- SVG Icon components: inline, no external library ---- */
const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
      <path d={d} />
    </svg>
);

const ICONS: Record<string, string> = {
  command: 'M4 4h16v16H4zM9 9h6v6H9z',
  bot: 'M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4M9 14h.01M15 14h.01',
  source: 'M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9zM3.6 9h16.8M3.6 15h16.8',
  product: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  content: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6',
  media: 'M4 4h16v16H4zM8 12l2.5 2.5L15 9l5 6',
  compliance: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  channel: 'M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 4M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 20',
  schedule: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2',
  queue: 'M4 6h16M4 12h16M4 18h10',
  vault: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM12 8v4M12 16h.01',
  health: 'M22 12h-4l-3 9L9 3l-3 9H2',
  settings: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zM12 6v6l4 2',
  tools: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
  menu: 'M4 6h16M4 12h16M4 18h16',
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
      { label: 'Automation', href: '/dashboard/automation', icon: 'schedule' },
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
  { label: 'Media', href: '/dashboard/media', icon: 'media' },
  { label: 'Kênh kết nối', href: '/dashboard/channels', icon: 'channel' },
  { label: 'Lịch đăng', href: '/dashboard/schedule', icon: 'schedule' },
  { label: 'Hàng đợi', href: '/dashboard/queue', icon: 'queue' },
  { label: 'Compliance Guard', href: '/dashboard/compliance', icon: 'compliance' },
];

const AUTOPILOT_BADGES = [
  'Safe Mode ON',
  'Free Only ON',
  'AutoPilot ON',
  'Safe Publish ON',
];

function isRouteActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function getPageTitle(pathname: string) {
  const allItems = [...NAV_GROUPS.flatMap((group) => group.items), ...LEGACY_ITEMS];

  const exact = allItems.find((item) => pathname === item.href);
  if (exact) return exact.label;

  if (pathname.startsWith('/dashboard/products/')) return 'Chi tiết sản phẩm';
  if (pathname.startsWith('/dashboard')) return 'ReviewPilot AI Command Center';

  return 'AI Command Center';
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  const [legacyOpen, setLegacyOpen] = useState(
      LEGACY_ITEMS.some((item) => isRouteActive(pathname, item.href)),
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const pageTitle = useMemo(() => getPageTitle(pathname), [pathname]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (LEGACY_ITEMS.some((item) => isRouteActive(pathname, item.href))) setLegacyOpen(true);
      setSidebarOpen(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  const closeSidebar = () => setSidebarOpen(false);

  return (
      <div className="app-shell dashboard-shell">
        <aside className={`sidebar dashboard-sidebar${sidebarOpen ? ' open' : ''}`}>
          <div className="sidebar-brand dashboard-sidebar-brand">
            <Link href="/dashboard" onClick={closeSidebar} aria-label="Về AI Command Center">
              <h2>SanDeal</h2>
              <p>ReviewPilot AI Command Center</p>
            </Link>
          </div>

          <nav className="sidebar-nav dashboard-sidebar-nav" aria-label="Dashboard navigation">
            {NAV_GROUPS.map((group) => (
                <div key={group.label} className="sidebar-group dashboard-sidebar-group">
                  <div className="sidebar-group-label dashboard-sidebar-group-label">
                    {group.label}
                  </div>

                  {group.items.map((item) => {
                    const isActive = isRouteActive(pathname, item.href);

                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            onClick={closeSidebar}
                            className={`sidebar-link dashboard-sidebar-link${isActive ? ' active' : ''}`}
                            aria-current={isActive ? 'page' : undefined}
                        >
                    <span className="dashboard-sidebar-link-icon">
                      <Icon d={ICONS[item.icon] || ICONS.command} size={16} />
                    </span>
                          <span>{item.label}</span>
                        </Link>
                    );
                  })}
                </div>
            ))}

            <div className="sidebar-group dashboard-sidebar-group">
              <button
                  type="button"
                  className="sidebar-link dashboard-sidebar-link dashboard-sidebar-collapse-toggle"
                  onClick={() => setLegacyOpen((value) => !value)}
                  aria-expanded={legacyOpen}
              >
              <span className="dashboard-sidebar-link-icon">
                <Icon d={ICONS.tools} size={15} />
              </span>
                <span>{legacyOpen ? '▾' : '▸'} Công cụ cũ</span>
              </button>

              {legacyOpen &&
                  LEGACY_ITEMS.map((item) => {
                    const isActive = isRouteActive(pathname, item.href);

                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            onClick={closeSidebar}
                            className={`sidebar-link dashboard-sidebar-link dashboard-sidebar-link-legacy${
                                isActive ? ' active' : ''
                            }`}
                            aria-current={isActive ? 'page' : undefined}
                        >
                    <span className="dashboard-sidebar-link-icon">
                      <Icon d={ICONS[item.icon] || ICONS.tools} size={14} />
                    </span>
                          <span>{item.label}</span>
                        </Link>
                    );
                  })}
            </div>
          </nav>

          <div className="sidebar-footer dashboard-sidebar-footer">
            <div className="sidebar-footer-card dashboard-sidebar-footer-card">
              <div className="dashboard-sidebar-footer-row">
                <span className="dashboard-sidebar-footer-dot on" />
                <span>Safe Mode ON</span>
              </div>

              <div className="dashboard-sidebar-footer-row">
                <span className="dashboard-sidebar-footer-dot on" />
                <span>Free Only ON</span>
              </div>

              <div className="dashboard-sidebar-footer-row">
                <span className="dashboard-sidebar-footer-dot on" />
                <span>AutoPilot ON</span>
              </div>

              <div className="dashboard-sidebar-footer-row">
                <span className="dashboard-sidebar-footer-dot on" />
                <span>Safe Publish ON</span>
              </div>

              <Link
                  href="/deals"
                  className="sidebar-link sidebar-link-external dashboard-sidebar-link dashboard-sidebar-public-link"
                  target="_blank"
                  rel="noreferrer"
              >
              <span className="dashboard-sidebar-link-icon">
                <Icon d={ICONS.external} size={13} />
              </span>
                <span>Xem public site</span>
              </Link>
            </div>
          </div>
        </aside>

        {sidebarOpen && (
            <button
                type="button"
                className="dashboard-sidebar-backdrop"
                aria-label="Đóng menu"
                onClick={closeSidebar}
            />
        )}

        <main className="main-content dashboard-main">
          <header className="topbar dashboard-topbar">
            <div className="flex items-center gap-sm">
              <button
                  type="button"
                  className="secondary-button btn-sm dashboard-mobile-menu"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Mở menu dashboard"
              >
                <Icon d={ICONS.menu} size={16} />
              </button>

              <div className="topbar-title dashboard-topbar-title">{pageTitle}</div>
            </div>

            <div className="safe-mode-badges dashboard-safe-badges" aria-label="AutoPilot status">
              {AUTOPILOT_BADGES.map((label) => (
                  <span key={label} className="safe-badge safe-badge-on">
                {label}
              </span>
              ))}
            </div>
          </header>

          <div className="page-content dashboard-page-content">{children}</div>
        </main>
      </div>
  );
}
