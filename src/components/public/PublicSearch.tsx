'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import { PublicIcon } from './PublicIcon';
import { trackPublicEvent } from './PublicAnalytics';
import styles from './public.module.css';

type SearchSuggestion = {
  id: string;
  slug: string;
  title: string;
  brand?: string;
  category?: string;
  currentPrice?: number;
  sourceLabel: string;
};

function price(value?: number) {
  return typeof value === 'number' && value > 0
    ? new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(value)
    : 'Chưa có giá';
}

export function PublicSearch({ defaultValue = '' }: { defaultValue?: string }) {
  const router = useRouter();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const lastNoResultTerm = useRef('');
  const [query, setQuery] = useState(defaultValue);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: term, pageSize: '6', sort: 'updated_desc' });
        const response = await fetch(`/api/public/products?${params.toString()}`, { cache: 'no-store', signal: controller.signal });
        const body = await response.json() as { ok?: boolean; data?: { items?: SearchSuggestion[] } };
        if (!response.ok || !body.ok) throw new Error('SEARCH_UNAVAILABLE');
        const nextSuggestions = (body.data?.items || []).slice(0, 6);
        setSuggestions(nextSuggestions);
        if (nextSuggestions.length === 0 && lastNoResultTerm.current !== term) {
          lastNoResultTerm.current = term;
          trackPublicEvent({ eventType: 'SEARCH_NO_RESULT', contentPageId: 'search:header', resultCount: 0 });
        }
        setActiveIndex(-1);
        setOpen(true);
      } catch {
        if (!controller.signal.aborted) {
          setSuggestions([]);
          setOpen(false);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 240);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (!open || suggestions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(index => (index + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(index => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      setOpen(false);
      router.push(`/deals/${encodeURIComponent(suggestions[activeIndex].slug)}`);
    }
  }

  return (
    <div
      className={styles.searchShell}
      ref={rootRef}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <form
        className={styles.searchForm}
        action="/deals"
        method="get"
        role="search"
        onSubmit={() => {
          setOpen(false);
          trackPublicEvent({ eventType: 'PUBLIC_SEARCH', contentPageId: 'search:header', resultCount: suggestions.length });
        }}
      >
        <span className={styles.searchIcon}><PublicIcon name="search" size={17} /></span>
        <label className={styles.visuallyHidden} htmlFor="public-search">Tìm kiếm sản phẩm</label>
        <input
          id="public-search"
          className={styles.searchInput}
          type="search"
          name="q"
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            if (nextQuery.trim().length < 2) {
              setSuggestions([]);
              setOpen(false);
              setLoading(false);
              setActiveIndex(-1);
            }
          }}
          onFocus={() => { if (query.trim().length >= 2) setOpen(true); }}
          onKeyDown={onKeyDown}
          placeholder="Tìm sản phẩm, thương hiệu hoặc danh mục"
          maxLength={120}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${suggestions[activeIndex]?.id}` : undefined}
        />
        <button className={styles.searchSubmit} type="submit" aria-label="Tìm kiếm">
          <PublicIcon name="arrowRight" size={16} />
        </button>
      </form>
      {open ? (
        <div className={styles.searchSuggestions} id={listId} role="listbox" aria-label="Gợi ý sản phẩm">
          {loading ? <p className={styles.searchState}>Đang tìm trong dữ liệu công khai...</p> : null}
          {!loading && suggestions.length === 0 ? (
            <div className={styles.searchState}>
              <strong>Không có kết quả phù hợp</strong>
              <Link href={`/deals?q=${encodeURIComponent(query.trim())}`}>Xem trang tìm kiếm</Link>
            </div>
          ) : null}
          {!loading ? suggestions.map((item, index) => (
            <Link
              id={`${listId}-${item.id}`}
              className={index === activeIndex ? styles.searchSuggestionActive : styles.searchSuggestion}
              href={`/deals/${encodeURIComponent(item.slug)}`}
              role="option"
              aria-selected={index === activeIndex}
              key={item.id}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => setOpen(false)}
            >
              <span><strong>{item.title}</strong><small>{[item.brand, item.category, item.sourceLabel].filter(Boolean).join(' · ')}</small></span>
              <span>{price(item.currentPrice)}</span>
            </Link>
          )) : null}
          {!loading && suggestions.length > 0 ? (
            <Link className={styles.searchAll} href={`/deals?q=${encodeURIComponent(query.trim())}`}>Xem tất cả kết quả</Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
