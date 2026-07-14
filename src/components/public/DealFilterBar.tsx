'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { PublicIcon } from './PublicIcon';
import styles from './public.module.css';

export type PublicFilterValues = {
  q?: string;
  platform?: string;
  category?: string;
  priceMin?: string;
  priceMax?: string;
  qualityBand?: string;
  opportunityBand?: string;
  dealBand?: string;
  hasImage?: string;
  verifiedSource?: string;
  updatedWithin?: string;
  sort?: string;
  pageSize?: string;
  compare?: string;
};

const PLATFORM_OPTIONS = [
  ['', 'Tất cả nền tảng'],
  ['shopee', 'Shopee'],
  ['tiktok_shop', 'TikTok Shop'],
  ['lazada', 'Lazada'],
  ['accesstrade', 'AccessTrade'],
  ['website', 'Website'],
  ['other', 'Nguồn khác'],
] as const;

function FilterFields({ values }: { values: PublicFilterValues }) {
  return (
    <>
      {values.compare ? <input type="hidden" name="compare" value={values.compare} /> : null}
      <label className={styles.filterWide}>
        <span>Từ khóa</span>
        <input name="q" type="search" maxLength={120} defaultValue={values.q} placeholder="Tên, thương hiệu, danh mục" />
      </label>
      <label className={styles.filterField}>
        <span>Nền tảng</span>
        <select name="platform" defaultValue={values.platform || ''}>
          {PLATFORM_OPTIONS.map(([value, label]) => <option value={value} key={value || 'all'}>{label}</option>)}
        </select>
      </label>
      <label className={styles.filterField}>
        <span>Danh mục</span>
        <input name="category" maxLength={80} defaultValue={values.category} placeholder="Ví dụ: Gia dụng" />
      </label>
      <details
        className={styles.advancedFilters}
        open={Boolean(values.priceMin || values.priceMax || values.qualityBand || values.opportunityBand || values.dealBand || values.updatedWithin || values.hasImage || values.verifiedSource || (values.sort && values.sort !== 'updated_desc') || (values.pageSize && values.pageSize !== '12'))}
      >
        <summary><PublicIcon name="filter" size={15} /> Bộ lọc nâng cao và sắp xếp</summary>
        <div className={styles.advancedGrid}>
      <label className={styles.filterField}>
        <span>Giá từ</span>
        <input name="priceMin" inputMode="numeric" pattern="[0-9]*" defaultValue={values.priceMin} placeholder="0" />
      </label>
      <label className={styles.filterField}>
        <span>Giá đến</span>
        <input name="priceMax" inputMode="numeric" pattern="[0-9]*" defaultValue={values.priceMax} placeholder="Không giới hạn" />
      </label>
      <label className={styles.filterField}>
        <span>Chất lượng dữ liệu</span>
        <select name="qualityBand" defaultValue={values.qualityBand || ''}>
          <option value="">Tất cả</option>
          <option value="good">Tốt</option>
          <option value="fair">Khá</option>
          <option value="needs_data">Cần bổ sung</option>
          <option value="poor">Kém</option>
          <option value="blocked">Bị chặn</option>
        </select>
      </label>
      <label className={styles.filterField}>
        <span>Ưu tiên nội dung</span>
        <select name="opportunityBand" defaultValue={values.opportunityBand || ''}>
          <option value="">Tất cả</option>
          <option value="priority">Ưu tiên</option>
          <option value="recommended">Nên xử lý</option>
          <option value="consider">Cân nhắc</option>
          <option value="low">Ưu tiên thấp</option>
          <option value="blocked">Bị chặn</option>
        </select>
      </label>
      <label className={styles.filterField}>
        <span>Mức Deal Score</span>
        <select name="dealBand" defaultValue={values.dealBand || ''}>
          <option value="">Tất cả</option>
          <option value="featured">Nổi bật</option>
          <option value="consider">Đáng cân nhắc</option>
          <option value="normal">Bình thường</option>
          <option value="verify">Cần xác minh</option>
          <option value="ineligible">Không đủ điều kiện</option>
        </select>
      </label>
      <label className={styles.filterField}>
        <span>Cập nhật trong</span>
        <select name="updatedWithin" defaultValue={values.updatedWithin || ''}>
          <option value="">Mọi thời điểm</option>
          <option value="1">24 giờ</option>
          <option value="7">7 ngày</option>
          <option value="30">30 ngày</option>
          <option value="90">90 ngày</option>
        </select>
      </label>
      <label className={styles.filterField}>
        <span>Sắp xếp</span>
        <select name="sort" defaultValue={values.sort || 'updated_desc'}>
          <option value="updated_desc">Mới cập nhật</option>
          <option value="deal_desc">Điểm deal cao</option>
          <option value="quality_desc">Điểm chất lượng cao</option>
          <option value="price_asc">Giá thấp đến cao</option>
          <option value="price_desc">Giá cao đến thấp</option>
          <option value="discount_desc">Mức giảm cao</option>
        </select>
      </label>
      <label className={styles.filterField}>
        <span>Số kết quả</span>
        <select name="pageSize" defaultValue={values.pageSize || '12'}>
          <option value="12">12 / trang</option>
          <option value="20">20 / trang</option>
          <option value="36">36 / trang</option>
          <option value="50">50 / trang</option>
        </select>
      </label>
          <label className={styles.filterField}>
            <span>Trạng thái ảnh</span>
            <select name="hasImage" defaultValue={values.hasImage || ''}>
              <option value="">Tất cả</option>
              <option value="true">Có ảnh</option>
              <option value="false">Chưa có ảnh</option>
            </select>
          </label>
          <label className={styles.filterField}>
            <span>Xác minh nguồn</span>
            <select name="verifiedSource" defaultValue={values.verifiedSource || ''}>
              <option value="">Tất cả</option>
              <option value="true">Đã xác minh</option>
              <option value="false">Chưa xác minh</option>
            </select>
          </label>
        </div>
      </details>
    </>
  );
}

export function DealFilterBar({ values, hasActiveFilters }: { values: PublicFilterValues; hasActiveFilters: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const drawer = drawerRef.current;
    const trigger = triggerRef.current;
    const focusable = drawer?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])');
    focusable?.[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !focusable || focusable.length === 0) return;
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

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      trigger?.focus();
    };
  }, [open]);

  return (
    <div className={styles.filterPanel}>
      <div className={styles.desktopFilters}>
        <form className={styles.filterForm} action="/deals" method="get">
          <FilterFields values={values} />
          <div className={styles.filterActions}>
            {hasActiveFilters ? <Link className={styles.secondaryButton} href="/deals">Xóa bộ lọc</Link> : null}
            <button className={styles.primaryButton} type="submit"><PublicIcon name="filter" size={15} /> Áp dụng</button>
          </div>
        </form>
      </div>

      <div className={styles.mobileFilterTrigger}>
        <div>
          <strong>Bộ lọc deal</strong>
          <p className={styles.timeNote}>{hasActiveFilters ? 'Đang áp dụng điều kiện lọc' : 'Chưa áp dụng bộ lọc nâng cao'}</p>
        </div>
        <button
          ref={triggerRef}
          className={styles.filterButton}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="mobile-deal-filter"
        >
          <PublicIcon name="filter" size={16} /> Mở bộ lọc
        </button>
      </div>

      <div className={`${styles.drawerLayer} ${open ? styles.drawerLayerOpen : ''}`} aria-hidden={!open}>
        <button className={styles.drawerBackdrop} type="button" onClick={() => setOpen(false)} tabIndex={open ? 0 : -1} aria-label="Đóng bộ lọc" />
        <div id="mobile-deal-filter" className={styles.drawer} ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="mobile-filter-title">
          <div className={styles.drawerHeader}>
            <h2 id="mobile-filter-title">Bộ lọc deal</h2>
            <button className={styles.iconButton} type="button" onClick={() => setOpen(false)} aria-label="Đóng bộ lọc">
              <PublicIcon name="close" size={18} />
            </button>
          </div>
          <form className={styles.filterForm} action="/deals" method="get" onSubmit={() => setOpen(false)}>
            <FilterFields values={values} />
            <div className={styles.filterActions}>
              {hasActiveFilters ? <Link className={styles.secondaryButton} href="/deals">Xóa bộ lọc</Link> : null}
              <button className={styles.primaryButton} type="submit">Xem kết quả</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
