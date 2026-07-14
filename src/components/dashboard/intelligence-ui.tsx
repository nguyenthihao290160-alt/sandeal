'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DashboardIcon, type DashboardIconName } from './dashboard-icon';
import styles from './intelligence-ui.module.css';

type ApiEnvelope<T> = {
  ok?: boolean;
  code?: string;
  message?: string;
  data?: T;
};

export async function dashboardRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => null) as ApiEnvelope<T> | T | null;
  const envelope = body && typeof body === 'object' ? body as ApiEnvelope<T> : null;

  if (!response.ok || envelope?.ok === false) {
    throw new Error(envelope?.message || 'Không thể tải dữ liệu. Vui lòng thử lại.');
  }

  if (envelope && Object.prototype.hasOwnProperty.call(envelope, 'data')) {
    return envelope.data as T;
  }

  return body as T;
}

export function useDashboardResource<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!url) {
      setData(null);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await dashboardRequest<T>(url, { signal });
      if (!signal?.aborted) setData(next);
    } catch (issue) {
      if (!signal?.aborted) {
        setError(issue instanceof Error ? issue.message : 'Không thể tải dữ liệu. Vui lòng thử lại.');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, refreshKey]);

  return {
    data,
    loading,
    error,
    reload: () => setRefreshKey((value) => value + 1),
    setData,
  };
}

export function DashboardPageHeader({
  icon,
  eyebrow,
  title,
  description,
  actions,
  meta,
}: {
  icon: DashboardIconName;
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.headerLead}>
        <span className={styles.headerIcon}><DashboardIcon name={icon} size={24} /></span>
        <div>
          {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
          <h1>{title}</h1>
          <p>{description}</p>
          {meta && <div className={styles.headerMeta}>{meta}</div>}
        </div>
      </div>
      {actions && <div className={styles.headerActions}>{actions}</div>}
    </header>
  );
}

export function DashboardState({
  kind,
  title,
  description,
  onRetry,
  actionHref,
  actionLabel,
}: {
  kind: 'loading' | 'error' | 'empty';
  title?: string;
  description?: string;
  onRetry?: () => void;
  actionHref?: string;
  actionLabel?: string;
}) {
  if (kind === 'loading') {
    return (
      <div className={styles.skeleton} aria-label={title || 'Đang tải dữ liệu'} aria-busy="true">
        <span /><span /><span />
      </div>
    );
  }

  const icon: DashboardIconName = kind === 'error' ? 'warning' : 'search';
  return (
    <section className={`${styles.state} ${kind === 'error' ? styles.stateError : ''}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className={styles.stateIcon}><DashboardIcon name={icon} size={23} /></span>
      <h2>{title || (kind === 'error' ? 'Không thể tải dữ liệu' : 'Chưa có dữ liệu')}</h2>
      {description && <p>{description}</p>}
      <div className={styles.stateActions}>
        {onRetry && <button type="button" className={styles.secondaryButton} onClick={onRetry}>Thử lại</button>}
        {actionHref && actionLabel && <Link className={styles.primaryButton} href={actionHref}>{actionLabel}</Link>}
      </div>
    </section>
  );
}

export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`]}`}>{children}</span>;
}

export function MetricCard({
  icon,
  label,
  value,
  help,
  tone = 'primary',
}: {
  icon: DashboardIconName;
  label: string;
  value: ReactNode;
  help?: string;
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'accent' | 'neutral';
}) {
  return (
    <article className={styles.metric} data-tone={tone}>
      <div className={styles.metricLabel}><span><DashboardIcon name={icon} size={19} /></span>{label}</div>
      <strong>{value}</strong>
      {help && <small>{help}</small>}
    </article>
  );
}

export function Panel({ title, icon, description, actions, children, className = '' }: {
  title: string;
  icon?: DashboardIconName;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${styles.panel} ${className}`}>
      <div className={styles.panelHeader}>
        <div>
          <h2>{icon && <DashboardIcon name={icon} size={19} />}{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className={styles.panelActions}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function DashboardDialog({
  open,
  title,
  description,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);

  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || []);
    const timer = window.setTimeout(() => (dialog?.querySelector<HTMLElement>('[data-autofocus]') || focusable()[0] || dialog)?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
      window.setTimeout(() => returnFocusRef.current?.focus(), 0);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className={styles.dialogBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="dashboard-dialog-title" tabIndex={-1}>
        <h2 id="dashboard-dialog-title">{title}</h2>
        {description && <p>{description}</p>}
        {children}
        {actions && <div className={styles.dialogActions}>{actions}</div>}
      </div>
    </div>
  );
}

export function formatDateTime(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Chưa có';
  return new Date(value).toLocaleString('vi-VN');
}

export function formatDate(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Chưa có';
  return new Date(value).toLocaleDateString('vi-VN');
}

export function formatNumber(value?: number | null): string {
  return Number.isFinite(value) ? Number(value).toLocaleString('vi-VN') : 'Chưa có';
}

export function formatMoney(value?: number | null, currency = 'VND'): string {
  if (!Number.isFinite(value)) return 'Chưa có';
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(value));
}

export function formatPercent(value?: number | null): string {
  return Number.isFinite(value) ? `${Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%` : 'Chưa đủ dữ liệu';
}

export { styles as intelligenceStyles };
