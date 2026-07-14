'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { dashboardStrings } from '@/lib/dashboard/strings';
import { DashboardIcon, type DashboardIconName } from '@/components/dashboard/dashboard-icon';

type NavigationItem = { label: string; href: string; icon: DashboardIconName; badge?: string };
type NavigationGroup = { id: string; label: string; items: NavigationItem[] };

const NAV_GROUPS: NavigationGroup[] = [
  {
    id: 'overview',
    label: 'Tổng quan',
    items: [
      { label: dashboardStrings.navigation.commandCenter, href: '/dashboard', icon: 'dashboard' },
      { label: 'Việc nên làm', href: '/dashboard/today', icon: 'today' },
      { label: 'Hiệu quả tăng trưởng', href: '/dashboard/growth', icon: 'analytics' },
    ],
  },
  {
    id: 'products',
    label: 'Sản phẩm',
    items: [
      { label: dashboardStrings.navigation.results, href: '/dashboard/products', icon: 'product' },
      { label: 'Nhập sản phẩm', href: '/dashboard/import', icon: 'import' },
      { label: 'Chất lượng và trùng lặp', href: '/dashboard/quality', icon: 'duplicate' },
      { label: 'Lịch sử giá', href: '/dashboard/price-history', icon: 'price' },
    ],
  },
  {
    id: 'content',
    label: 'Nội dung',
    items: [
      { label: 'Content Studio', href: '/dashboard/content', icon: 'content' },
      { label: 'Hàng chờ phê duyệt', href: '/dashboard/queue', icon: 'approval' },
    ],
  },
  {
    id: 'operations',
    label: 'Vận hành',
    items: [
      { label: dashboardStrings.navigation.bots, href: '/dashboard/ai-bots', icon: 'task' },
      { label: dashboardStrings.navigation.automation, href: '/dashboard/automation', icon: 'scheduler' },
      { label: 'Cảnh báo', href: '/dashboard/alerts', icon: 'alert' },
    ],
  },
  {
    id: 'system',
    label: 'Hệ thống',
    items: [
      { label: dashboardStrings.navigation.sources, href: '/dashboard/product-sources', icon: 'source' },
      { label: dashboardStrings.navigation.vault, href: '/dashboard/token-vault', icon: 'security' },
      { label: dashboardStrings.navigation.health, href: '/dashboard/app-health', icon: 'health' },
      { label: dashboardStrings.navigation.safety, href: '/dashboard/settings', icon: 'settings' },
    ],
  },
];

const LEGACY_ITEMS: NavigationItem[] = [
  { label: 'Thư viện nội dung', href: '/dashboard/media', icon: 'content' },
  { label: 'Kênh kết nối', href: '/dashboard/channels', icon: 'external' },
  { label: 'Lịch đăng tự động', href: '/dashboard/schedule', icon: 'scheduler' },
  { label: 'Kiểm soát tuân thủ', href: '/dashboard/compliance', icon: 'approval' },
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
  if (pathname.startsWith('/dashboard')) return dashboardStrings.navigation.commandCenter;

  return dashboardStrings.navigation.commandCenter;
}

function getPageGroup(pathname: string) {
  const group = NAV_GROUPS.find((item) => item.items.some((entry) => isRouteActive(pathname, entry.href)));
  return group?.label || (LEGACY_ITEMS.some((item) => isRouteActive(pathname, item.href)) ? 'Khác' : 'Tổng quan');
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(NAV_GROUPS.map((group) => [group.id, true])),
  );
  const [legacyOpen, setLegacyOpen] = useState(
      LEGACY_ITEMS.some((item) => isRouteActive(pathname, item.href)),
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const pageTitle = useMemo(() => getPageTitle(pathname), [pathname]);
  const pageGroup = useMemo(() => getPageGroup(pathname), [pathname]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const activeGroup = NAV_GROUPS.find((group) => group.items.some((item) => isRouteActive(pathname, item.href)));
      if (activeGroup) {
        setOpenGroups((current) => current[activeGroup.id] ? current : { ...current, [activeGroup.id]: true });
      }
      if (LEGACY_ITEMS.some((item) => isRouteActive(pathname, item.href))) setLegacyOpen(true);
      setSidebarOpen(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const sidebar = sidebarRef.current;
    const initialFocusable = Array.from(sidebar?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') || []);
    const initialFocus = sidebar?.querySelector<HTMLElement>('.dashboard-sidebar-close') || initialFocusable[0];
    window.setTimeout(() => initialFocus?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        window.setTimeout(() => menuButtonRef.current?.focus(), 0);
        return;
      }
      const focusable = Array.from(sidebar?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') || []);
      if (event.key === 'Tab' && focusable.length > 0) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen]);

  const closeSidebar = () => setSidebarOpen(false);
  const dismissSidebar = () => {
    setSidebarOpen(false);
    window.setTimeout(() => menuButtonRef.current?.focus(), 0);
  };

  return (
      <div className="app-shell dashboard-shell">
        <aside ref={sidebarRef} className={`sidebar dashboard-sidebar${sidebarOpen ? ' open' : ''}`}>
          <div className="sidebar-brand dashboard-sidebar-brand">
            <Link href="/dashboard" onClick={closeSidebar} aria-label="Về Bảng điều khiển SanDeal">
              <h2>SanDeal</h2>
              <p>Product Intelligence</p>
            </Link>
            <button type="button" className="dashboard-sidebar-close" onClick={dismissSidebar} aria-label="Đóng menu bảng điều khiển">
              <DashboardIcon name="close" size={18} />
            </button>
          </div>

          <nav className="sidebar-nav dashboard-sidebar-nav" aria-label="Điều hướng bảng điều khiển">
            {NAV_GROUPS.map((group) => (
                <div key={group.label} className="sidebar-group dashboard-sidebar-group">
                  <button
                      type="button"
                      className="dashboard-sidebar-group-toggle"
                      onClick={() => setOpenGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}
                      aria-expanded={openGroups[group.id]}
                      aria-controls={`dashboard-nav-${group.id}`}
                  >
                    <span>{group.label}</span>
                    <DashboardIcon name={openGroups[group.id] ? 'chevronDown' : 'chevronRight'} size={14} />
                  </button>

                  {openGroups[group.id] && <div id={`dashboard-nav-${group.id}`}>
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
                      <DashboardIcon name={item.icon} size={18} />
                    </span>
                          <span>{item.label}</span>
                          {item.badge && <small className="dashboard-sidebar-item-badge">{item.badge}</small>}
                        </Link>
                    );
                  })}
                  </div>}
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
                <DashboardIcon name="tools" size={18} />
              </span>
                <DashboardIcon name={legacyOpen ? 'chevronDown' : 'chevronRight'} size={15} />
                <span>{dashboardStrings.navigation.legacy}</span>
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
                      <DashboardIcon name={item.icon} size={17} />
                    </span>
                          <span>{item.label}</span>
                        </Link>
                    );
                  })}
            </div>
          </nav>

          <div className="sidebar-footer dashboard-sidebar-footer">
            <div className="sidebar-footer-card dashboard-sidebar-footer-card">
              <Link
                  href="/dashboard/token-vault"
                  className="sidebar-link sidebar-link-external dashboard-sidebar-link dashboard-sidebar-public-link"
              >
              <span className="dashboard-sidebar-link-icon">
                <DashboardIcon name="security" size={16} />
              </span>
                <span>Quản lý khóa kết nối và dịch vụ bên ngoài</span>
              </Link>
            </div>
          </div>
        </aside>

        {sidebarOpen && (
            <button
                type="button"
                className="dashboard-sidebar-backdrop"
                aria-label="Đóng menu"
                onClick={dismissSidebar}
            />
        )}

        <main className="main-content dashboard-main">
          <header className="topbar dashboard-topbar">
            <div className="flex items-center gap-sm">
              <button
                  ref={menuButtonRef}
                  type="button"
                  className="secondary-button btn-sm dashboard-mobile-menu"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Mở menu bảng điều khiển"
              >
                <DashboardIcon name="menu" size={18} />
              </button>

              <div className="topbar-title dashboard-topbar-title"><span>{pageGroup}</span><span aria-hidden="true">/</span><strong>{pageTitle}</strong></div>
            </div>

            <span className="dashboard-topbar-status">Hệ thống quản trị SanDeal</span>
          </header>

          <div className="page-content dashboard-page-content">{children}</div>
        </main>
      </div>
  );
}
