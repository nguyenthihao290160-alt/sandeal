'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { PublicIcon } from './PublicIcon';
import { trackPublicEvent } from './PublicAnalytics';
import styles from './public.module.css';

const MAX_COMPARISON = 4;

function normalizedIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, MAX_COMPARISON);
}

export function ComparisonToggle({ productId, selectedIds }: { productId: string; selectedIds: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const selected = normalizedIds(selectedIds);
  const isSelected = selected.includes(productId);
  const isFull = selected.length >= MAX_COMPARISON && !isSelected;

  function toggle() {
    const params = new URLSearchParams(window.location.search);
    const next = isSelected ? selected.filter((id) => id !== productId) : [...selected, productId];
    if (next.length > 0) params.set('compare', next.join(','));
    else params.delete('compare');
    if (!isSelected) trackPublicEvent({ eventType: 'COMPARE_ADD', productId });
    router.push(`${pathname}${params.size ? `?${params.toString()}` : ''}`);
  }

  return (
    <button
      type="button"
      className={styles.compareButton}
      onClick={toggle}
      disabled={isFull}
      aria-pressed={isSelected}
      title={isFull ? 'Chỉ có thể so sánh tối đa 4 sản phẩm' : undefined}
    >
      <PublicIcon name="compare" size={15} />
      {isSelected ? 'Bỏ so sánh' : 'So sánh'}
    </button>
  );
}

export function ProductComparisonTray({ selectedIds }: { selectedIds: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const selected = normalizedIds(selectedIds);

  if (selected.length === 0) return null;

  function clear() {
    const params = new URLSearchParams(window.location.search);
    params.delete('compare');
    router.push(`${pathname}${params.size ? `?${params.toString()}` : ''}`);
  }

  return (
    <aside className={styles.compareTray} aria-live="polite" aria-label="Sản phẩm đã chọn để so sánh">
      <p>
        <strong>Đã chọn {selected.length}/{MAX_COMPARISON} sản phẩm</strong>
        Chọn từ 2 sản phẩm để xem bảng so sánh.
      </p>
      <div className={styles.compareActions}>
        <button type="button" className={styles.secondaryButton} onClick={clear}>Xóa lựa chọn</button>
        {selected.length >= 2 ? (
          <Link
            className={styles.primaryButton}
            href={`/compare?ids=${encodeURIComponent(selected.join(','))}`}
            onClick={() => trackPublicEvent({ eventType: 'COMPARE_OPEN', resultCount: selected.length })}
          >
            Mở so sánh <PublicIcon name="arrowRight" size={15} />
          </Link>
        ) : <span className={styles.pageDisabled}>Chọn thêm 1 sản phẩm</span>}
      </div>
    </aside>
  );
}
