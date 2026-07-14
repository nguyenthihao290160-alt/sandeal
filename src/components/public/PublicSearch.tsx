import { PublicIcon } from './PublicIcon';
import styles from './public.module.css';

export function PublicSearch({ defaultValue = '' }: { defaultValue?: string }) {
  return (
    <form className={styles.searchForm} action="/deals" method="get" role="search">
      <span className={styles.searchIcon}><PublicIcon name="search" size={17} /></span>
      <label className={styles.visuallyHidden} htmlFor="public-search">Tìm kiếm sản phẩm</label>
      <input
        id="public-search"
        className={styles.searchInput}
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder="Tìm sản phẩm, thương hiệu hoặc danh mục"
        maxLength={120}
      />
      <button className={styles.searchSubmit} type="submit" aria-label="Tìm kiếm">
        <PublicIcon name="arrowRight" size={16} />
      </button>
    </form>
  );
}
