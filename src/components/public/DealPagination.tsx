import Link from 'next/link';

import { PublicIcon } from './PublicIcon';
import styles from './public.module.css';

function pageHref(query: Record<string, string>, page: number, basePath: string) {
  const params = new URLSearchParams(query);
  if (page <= 1) params.delete('page');
  else params.set('page', String(page));
  const serialized = params.toString();
  return serialized ? `${basePath}?${serialized}` : basePath;
}

function visiblePages(page: number, totalPages: number) {
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  const end = Math.min(totalPages, start + 4);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}

export function DealPagination({
  page,
  totalPages,
  query,
  basePath = '/deals',
}: {
  page: number;
  totalPages: number;
  query: Record<string, string>;
  basePath?: string;
}) {
  if (totalPages <= 1) return null;
  const pages = visiblePages(page, totalPages);

  return (
    <nav className={styles.pagination} aria-label="Phân trang deal">
      {page > 1 ? (
        <Link className={styles.pageLink} href={pageHref(query, page - 1, basePath)} aria-label="Trang trước">
          <PublicIcon name="chevronLeft" size={17} />
        </Link>
      ) : <span className={styles.pageDisabled} aria-hidden="true"><PublicIcon name="chevronLeft" size={17} /></span>}
      {pages.map((item) => item === page ? (
        <span className={styles.pageCurrent} aria-current="page" key={item}>{item}</span>
      ) : (
        <Link className={styles.pageLink} href={pageHref(query, item, basePath)} key={item}>{item}</Link>
      ))}
      {page < totalPages ? (
        <Link className={styles.pageLink} href={pageHref(query, page + 1, basePath)} aria-label="Trang sau">
          <PublicIcon name="chevronRight" size={17} />
        </Link>
      ) : <span className={styles.pageDisabled} aria-hidden="true"><PublicIcon name="chevronRight" size={17} /></span>}
    </nav>
  );
}
