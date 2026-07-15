'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DashboardIcon } from './dashboard-icon';
import type { SavedView } from '@/lib/product-intelligence/types';
import styles from './saved-views-toolbar.module.css';

type SafeFilterValue = string | number | boolean;

type Props = {
  page: SavedView['page'];
  filters: Record<string, SafeFilterValue>;
  sort?: string;
  columns?: string[];
  viewMode?: SavedView['viewMode'];
  onApply: (view: Pick<SavedView, 'filters' | 'sort' | 'columns' | 'viewMode'>) => void;
};

type Envelope<T> = { ok: boolean; code?: string; data?: T };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => null) as Envelope<T> | null;
  if (!response.ok || !body?.ok || body.data === undefined) throw new Error(body?.code || 'SAVED_VIEW_UNAVAILABLE');
  return body.data;
}

export function SavedViewsToolbar({ page, filters, sort, columns = [], viewMode = 'table', onApply }: Props) {
  const [items, setItems] = useState<SavedView[]>([]);
  const [name, setName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [renamingId, setRenamingId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await request<SavedView[]>(`/api/dashboard/saved-views?page=${encodeURIComponent(page)}`));
      setMessage('');
    } catch {
      setMessage('Không thể tải chế độ xem đã lưu.');
    }
  }, [page]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const defaultView = useMemo(() => items.find((item) => item.isDefault), [items]);

  const create = async (source?: SavedView) => {
    const nextName = source ? `${source.name} - bản sao`.slice(0, 80) : name.trim();
    if (nextName.length < 2) return;
    setBusy(source ? `duplicate:${source.id}` : 'create');
    try {
      await request<SavedView>('/api/dashboard/saved-views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: nextName,
          page,
          filters: source?.filters || filters,
          sort: source?.sort ?? sort,
          columns: source?.columns || columns,
          viewMode: source?.viewMode || viewMode,
          isDefault: source ? false : makeDefault,
        }),
      });
      setName('');
      setMakeDefault(false);
      setMessage(source ? 'Đã nhân bản chế độ xem.' : 'Đã lưu chế độ xem.');
      await load();
    } catch {
      setMessage('Không thể lưu chế độ xem.');
    } finally { setBusy(''); }
  };

  const update = async (item: SavedView, changes: Partial<SavedView>) => {
    setBusy(`update:${item.id}`);
    try {
      await request<SavedView>('/api/dashboard/saved-views', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, page, ...changes }),
      });
      setRenamingId('');
      setRenameValue('');
      setMessage(changes.isDefault ? 'Đã đặt làm mặc định.' : 'Đã đổi tên chế độ xem.');
      await load();
    } catch { setMessage('Không thể cập nhật chế độ xem.'); }
    finally { setBusy(''); }
  };

  const remove = async (item: SavedView) => {
    setBusy(`delete:${item.id}`);
    try {
      const response = await fetch(`/api/dashboard/saved-views?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('DELETE_FAILED');
      setMessage('Đã xóa chế độ xem.');
      await load();
    } catch { setMessage('Không thể xóa chế độ xem.'); }
    finally { setBusy(''); }
  };

  return (
    <details className={styles.container}>
      <summary><DashboardIcon name="filter" size={16} />Chế độ xem đã lưu{defaultView ? ` · Mặc định: ${defaultView.name}` : ''}</summary>
      <div className={styles.body}>
        <form className={styles.createRow} onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label><span>Tên chế độ xem</span><input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Ví dụ: Cần bổ sung giá" /></label>
          <label className={styles.checkbox}><input type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} /><span>Đặt mặc định</span></label>
          <button type="submit" disabled={busy !== '' || name.trim().length < 2}>Lưu bộ lọc hiện tại</button>
        </form>

        {items.length === 0 ? <p className={styles.empty}>Chưa có chế độ xem nào cho trang này.</p> : (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.id}>
                <div className={styles.viewTitle}>
                  {renamingId === item.id ? <input aria-label={`Tên mới cho ${item.name}`} value={renameValue} maxLength={80} onChange={(event) => setRenameValue(event.target.value)} /> : <strong>{item.name}</strong>}
                  {item.isDefault && <span>Mặc định</span>}
                </div>
                <div className={styles.actions}>
                  <button type="button" onClick={() => onApply(item)}>Áp dụng</button>
                  {renamingId === item.id ? (
                    <button type="button" disabled={renameValue.trim().length < 2 || busy !== ''} onClick={() => void update(item, { name: renameValue.trim() })}>Lưu tên</button>
                  ) : <button type="button" disabled={busy !== ''} onClick={() => { setRenamingId(item.id); setRenameValue(item.name); }}>Đổi tên</button>}
                  {!item.isDefault && <button type="button" disabled={busy !== ''} onClick={() => void update(item, { isDefault: true })}>Đặt mặc định</button>}
                  <button type="button" disabled={busy !== ''} onClick={() => void create(item)}>Nhân bản</button>
                  <button type="button" className={styles.danger} disabled={busy !== ''} onClick={() => void remove(item)}>Xóa</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {message && <p className={styles.message} role="status">{message}</p>}
      </div>
    </details>
  );
}
