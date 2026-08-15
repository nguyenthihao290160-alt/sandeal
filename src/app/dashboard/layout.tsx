'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { CommandCenterProvider, useCommandCenter } from '@/components/dashboard/command-center-provider';
import { DashboardIcon, type DashboardIconName } from '@/components/dashboard/dashboard-icon';
import { requestClientJson } from '@/lib/dashboard/clientRequest';
import { isDashboardRouteActive } from '@/lib/dashboard/navigation';
import type { DashboardStatusStrip } from '@/lib/dashboard/statusStrip';

type NavigationItem = { label: string; href: string; icon: DashboardIconName; technicalLabel?: string };

const PRIMARY_NAV: NavigationItem[] = [
  { label: 'Tổng quan', technicalLabel: 'Command Center', href: '/dashboard', icon: 'dashboard' },
  { label: 'Sản phẩm', technicalLabel: 'Product Studio', href: '/dashboard/products', icon: 'product' },
  { label: 'Nguồn hàng', technicalLabel: 'Source Center', href: '/dashboard/product-sources', icon: 'source' },
  { label: 'Tự động hóa', technicalLabel: 'Automation Center', href: '/dashboard/automation', icon: 'scheduler' },
  { label: 'Hệ thống', technicalLabel: 'System Center', href: '/dashboard/app-health', icon: 'health' },
  { label: 'Cài đặt', technicalLabel: 'Settings', href: '/dashboard/settings', icon: 'settings' },
];

// Existing specialist routes stay available without competing with the six
// operator-first destinations above.
const ADVANCED_NAV: NavigationItem[] = [
  { label: 'Việc nên làm', href: '/dashboard/today', icon: 'today' },
  { label: 'Hiệu quả tăng trưởng', href: '/dashboard/growth', icon: 'analytics' },
  { label: 'Content Studio', href: '/dashboard/content', icon: 'content' },
  { label: 'Hàng chờ phê duyệt', href: '/dashboard/queue', icon: 'approval' },
  { label: 'Tác vụ và tiến độ', href: '/dashboard/ai-bots', icon: 'task' },
  { label: 'Nhập sản phẩm', href: '/dashboard/import', icon: 'import' },
  { label: 'Chất lượng và trùng lặp', href: '/dashboard/quality', icon: 'duplicate' },
  { label: 'Lịch sử giá', href: '/dashboard/price-history', icon: 'price' },
  { label: 'Cảnh báo', href: '/dashboard/alerts', icon: 'alert' },
  { label: 'Kết nối bảo mật', href: '/dashboard/token-vault', icon: 'security' },
  { label: 'Thư viện nội dung', href: '/dashboard/media', icon: 'content' },
  { label: 'Kênh kết nối', href: '/dashboard/channels', icon: 'external' },
  { label: 'Lịch đăng tự động', href: '/dashboard/schedule', icon: 'calendar' },
  { label: 'Kiểm soát tuân thủ', href: '/dashboard/compliance', icon: 'approval' },
];

const PAGE_META: Array<{ prefix: string; title: string; technicalTitle: string; subtitle: string; workspace?: string }> = [
  { prefix: '/dashboard/products', title: 'Sản phẩm', technicalTitle: 'Product Studio', subtitle: 'Quản lý sản phẩm, review và cơ hội affiliate', workspace: 'PRODUCT STUDIO PRO' },
  { prefix: '/dashboard/product-sources', title: 'Nguồn hàng', technicalTitle: 'Source Center', subtitle: 'Theo dõi tích hợp và chất lượng inventory' },
  { prefix: '/dashboard/automation', title: 'Tự động hóa', technicalTitle: 'Automation Center', subtitle: 'Workflow, lịch chạy và hàng chờ bền vững' },
  { prefix: '/dashboard/app-health', title: 'Hệ thống', technicalTitle: 'System Center', subtitle: 'Runtime Guardian, process health và Release Identity' },
  { prefix: '/dashboard/settings', title: 'Cài đặt', technicalTitle: 'Settings', subtitle: 'Chính sách vận hành và cấu hình an toàn' },
  { prefix: '/dashboard', title: 'Bảng điều khiển', technicalTitle: 'Command Center', subtitle: 'Tổng quan hoạt động hệ thống theo thời gian thực' },
];

const COMMANDS: NavigationItem[] = [
  { label: 'Tìm sản phẩm', href: '/dashboard/products?focus=search', icon: 'search' },
  { label: 'Mở Tổng quan', href: '/dashboard', icon: 'dashboard' },
  { label: 'Mở sản phẩm cần review', href: '/dashboard/products?safePublishStatus=needs_review', icon: 'approval' },
  { label: 'Mở Health Center', href: '/dashboard/app-health', icon: 'health' },
  { label: 'Mở AUTO_PILOT gần nhất', href: '/dashboard/automation', icon: 'scheduler' },
  { label: 'Mở TikTok source', href: '/dashboard/product-sources?source=accesstrade_tiktok_shop', icon: 'source' },
];

const UNKNOWN_STATUS: DashboardStatusStrip = {
  items: [
    { id: 'web', label: 'Web', value: 'Không xác định', technicalValue: 'WEB_UNVERIFIED', tone: 'unknown' },
    { id: 'worker', label: 'Worker', value: 'Không xác định', technicalValue: 'WORKER_UNVERIFIED', tone: 'unknown' },
    { id: 'scheduler', label: 'Scheduler', value: 'Không xác định', technicalValue: 'SCHEDULER_UNVERIFIED', tone: 'unknown' },
    { id: 'publish', label: 'Publish', value: 'Không xác định', technicalValue: 'SAFE_PUBLISH_UNVERIFIED', tone: 'unknown' },
  ],
  runtimeGuardian: { tone: 'unknown', value: 'Không xác định', technicalValue: 'RUNTIME_GUARDIAN_UNVERIFIED', checkedAt: null, fresh: false, reasons: [] },
  updatedAt: '',
};

function currentPage(pathname: string) {
  return PAGE_META.find(meta => meta.prefix === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(meta.prefix)) || PAGE_META.at(-1)!;
}

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { technicalMode, setTechnicalMode } = useCommandCenter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() => ADVANCED_NAV.some(item => isDashboardRouteActive(pathname, item.href)));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [status, setStatus] = useState<DashboardStatusStrip>(UNKNOWN_STATUS);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const statusAbortRef = useRef<AbortController | null>(null);
  const page = useMemo(() => currentPage(pathname), [pathname]);
  const filteredCommands = useMemo(() => COMMANDS.filter(command => command.label.toLocaleLowerCase('vi').includes(commandQuery.toLocaleLowerCase('vi'))), [commandQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSidebarOpen(false);
      if (ADVANCED_NAV.some(item => isDashboardRouteActive(pathname, item.href))) setAdvancedOpen(true);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.key === 'Escape') {
        setPaletteOpen(false);
        setCommandQuery('');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!paletteOpen) return;
    const timer = window.setTimeout(() => paletteInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [paletteOpen]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      statusAbortRef.current?.abort();
      const controller = new AbortController();
      statusAbortRef.current = controller;
      try {
        const response = await requestClientJson<{ ok: true; data: DashboardStatusStrip }>('/api/dashboard/status-strip', {
          signal: controller.signal,
          timeoutMs: 8_000,
          maximumResponseBytes: 128 * 1024,
        });
        if (mounted) setStatus(response.data);
      } catch {
        if (mounted && !controller.signal.aborted) setStatus(UNKNOWN_STATUS);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 60_000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
      statusAbortRef.current?.abort();
    };
  }, []);

  const closeSidebar = () => setSidebarOpen(false);
  const dismissSidebar = () => {
    setSidebarOpen(false);
    window.setTimeout(() => menuButtonRef.current?.focus(), 0);
  };

  return (
    <div className="app-shell dashboard-shell command-center-shell">
      <aside ref={sidebarRef} className={`sidebar dashboard-sidebar command-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-brand dashboard-sidebar-brand command-brand">
          <Link href="/dashboard" onClick={closeSidebar} aria-label="Về Bảng điều khiển SanDeal">
            <span className="command-brand-mark" aria-hidden="true">S</span>
            <span><h2>SanDeal</h2><p>COMMAND CENTER PRO</p></span>
          </Link>
          <button type="button" className="dashboard-sidebar-close" onClick={dismissSidebar} aria-label="Đóng menu bảng điều khiển">
            <DashboardIcon name="close" size={18} />
          </button>
        </div>

        <nav className="sidebar-nav dashboard-sidebar-nav command-primary-nav" aria-label="Điều hướng chính">
          <span className="command-nav-kicker">Không gian vận hành</span>
          {PRIMARY_NAV.map(item => {
            const isActive = isDashboardRouteActive(pathname, item.href);
            return (
              <Link key={item.href} href={item.href} onClick={closeSidebar} className={`sidebar-link dashboard-sidebar-link command-nav-link${isActive ? ' active' : ''}`} aria-current={isActive ? 'page' : undefined}>
                <span className="dashboard-sidebar-link-icon"><DashboardIcon name={item.icon} size={18} /></span>
                <span>{technicalMode ? item.technicalLabel || item.label : item.label}</span>
              </Link>
            );
          })}

          <div className="sidebar-group dashboard-sidebar-group command-advanced-nav">
            <button type="button" className="sidebar-link dashboard-sidebar-link dashboard-sidebar-collapse-toggle" onClick={() => setAdvancedOpen(value => !value)} aria-expanded={advancedOpen}>
              <span className="dashboard-sidebar-link-icon"><DashboardIcon name="tools" size={18} /></span>
              <span>{technicalMode ? 'Advanced tools' : 'Công cụ nâng cao'}</span>
              <DashboardIcon name={advancedOpen ? 'chevronDown' : 'chevronRight'} size={14} />
            </button>
            {advancedOpen && <div className="command-advanced-list">
              {ADVANCED_NAV.map(item => {
                const isActive = isDashboardRouteActive(pathname, item.href);
                return <Link key={item.href} href={item.href} onClick={closeSidebar} className={`sidebar-link dashboard-sidebar-link dashboard-sidebar-link-legacy${isActive ? ' active' : ''}`} aria-current={isActive ? 'page' : undefined}>
                  <span className="dashboard-sidebar-link-icon"><DashboardIcon name={item.icon} size={16} /></span>
                  <span>{item.label}</span>
                </Link>;
              })}
            </div>}
          </div>
        </nav>

        <div className="sidebar-footer dashboard-sidebar-footer command-sidebar-footer">
          <button type="button" className="command-language-switch" onClick={() => setTechnicalMode(!technicalMode)} aria-pressed={technicalMode}>
            <span>{technicalMode ? 'Technical English' : 'Giao diện vận hành'}</span>
            <span className={`command-switch-track${technicalMode ? ' on' : ''}`} aria-hidden="true"><span /></span>
          </button>
          <button type="button" className="command-palette-trigger" onClick={() => setPaletteOpen(true)}>
            <DashboardIcon name="search" size={16} /><span>{technicalMode ? 'Command palette' : 'Đi tới nhanh'}</span><kbd>Ctrl K</kbd>
          </button>
          <div className="command-operator-card" aria-label="Tài khoản vận hành hiện tại">
            <span className="command-operator-avatar" aria-hidden="true">SD</span>
            <span><strong>SanDeal Team</strong><small>Dashboard Admin</small></span>
          </div>
        </div>
      </aside>

      {sidebarOpen && <button type="button" className="dashboard-sidebar-backdrop" aria-label="Đóng menu" onClick={dismissSidebar} />}

      <main className="main-content dashboard-main command-main">
        <header className="topbar dashboard-topbar command-topbar">
          <div className="command-topbar-heading">
            <button ref={menuButtonRef} type="button" className="secondary-button btn-sm dashboard-mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Mở menu bảng điều khiển">
              <DashboardIcon name="menu" size={18} />
            </button>
            <div>
              <span className="command-page-eyebrow">{page.workspace || 'COMMAND CENTER PRO'}</span>
              <div className="topbar-title dashboard-topbar-title"><strong>{technicalMode ? page.technicalTitle : page.title}</strong><span>{page.subtitle}</span></div>
            </div>
          </div>

          <div className="command-topbar-actions">
            <div className="command-health-strip" aria-label="Trạng thái hệ thống">
              {status.items.map(item => <span key={item.id} className={`command-health-pill tone-${item.tone}`} title={item.technicalValue}>
                <i aria-hidden="true" /><b>{item.label}</b><span>{technicalMode ? item.technicalValue : item.value}</span>
              </span>)}
            </div>
            <Link href="/dashboard/alerts" className="command-icon-button" aria-label="Mở thông báo"><DashboardIcon name="alert" size={18} /></Link>
            <span className="command-avatar" aria-label="Operator SanDeal">SD</span>
          </div>
        </header>
        <div className="page-content dashboard-page-content command-page-content">{children}</div>
      </main>

      {paletteOpen && <div className="command-palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) { setPaletteOpen(false); setCommandQuery(''); } }}>
        <section className="command-palette" role="dialog" aria-modal="true" aria-label="Đi tới nhanh">
          <div className="command-palette-search"><DashboardIcon name="search" size={18} /><input ref={paletteInputRef} value={commandQuery} onChange={event => setCommandQuery(event.target.value)} placeholder="Tìm trang hoặc tác vụ an toàn..." aria-label="Tìm lệnh" /><kbd>Esc</kbd></div>
          <div className="command-palette-results">
            {filteredCommands.map(command => <Link key={command.href} href={command.href} onClick={() => { setPaletteOpen(false); setCommandQuery(''); }}><DashboardIcon name={command.icon} size={17} /><span>{command.label}</span><DashboardIcon name="chevronRight" size={15} /></Link>)}
            {!filteredCommands.length && <p>Không có lệnh phù hợp.</p>}
          </div>
          <footer>Chỉ bao gồm điều hướng và thao tác an toàn.</footer>
        </section>
      </div>}
    </div>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <CommandCenterProvider><Shell>{children}</Shell></CommandCenterProvider>;
}
