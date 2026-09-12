'use client';

import { useEffect, useState } from 'react';
import { PublicHeader } from './PublicHeader';
import { PublicFooter } from './PublicFooter';
import { PriceDisplay, VerifiedSourceBadge } from './DealCard';
import { AffiliateDisclosure, PriceHistory } from './ProductSections';
import ProductImage from '@/app/deals/ProductImage';
import styles from './public.module.css';

interface Card { id: string; slug: string; title: string; imageUrl?: string; currentPrice?: number; brand?: string;
  verifiedSource: boolean; outboundHref: string; description?: string; priceHistory?: Array<{ capturedAt: string; price: number }> }

export function CloudflareStorefront({ detail = false }: { detail?: boolean }) {
  const [items, setItems] = useState<Card[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [requestCursor, setRequestCursor] = useState(''), [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const slug = location.pathname.startsWith('/deals/') ? location.pathname.split('/')[2] : new URLSearchParams(location.search).get('slug');
    const endpoint = detail ? `/api/public/products/${encodeURIComponent(slug || '')}` : `/api/public/products?limit=20${requestCursor ? `&after=${encodeURIComponent(requestCursor)}` : ''}`;
    fetch(endpoint, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('CATALOGUE_UNAVAILABLE');
      const result = await response.json();
      if (!active) return;
      setItems(detail ? [result.data] : result.data.items); setCursor(detail ? null : result.data.nextCursor); setState('ready');
    }).catch(error => { if (active && error.name !== 'AbortError') { setItems([]); setState('error'); } });
    return () => { active = false; controller.abort(); };
  }, [detail, requestCursor]);
  return <div className={styles.shell}>
    <PublicHeader />
    <main className={styles.section}><div className={styles.container}>
      <div className={styles.sectionHeader}><div><h1>{detail ? 'Thông tin sản phẩm' : 'Khám phá sản phẩm đã kiểm tra'}</h1>
        <p>Kiểm tra giá, nguồn và thông tin trước khi truy cập nhà bán.</p></div></div>
      {state === 'loading' ? <p role="status">Đang tải sản phẩm…</p> : null}
      {state === 'error' ? <p role="alert">Sản phẩm chưa sẵn sàng hoặc hiện không đủ điều kiện công khai. Vui lòng thử lại sau.</p> : null}
      {state === 'ready' && items.length === 0 ? <p>Chưa có sản phẩm phù hợp trong trang này.</p> : null}
      <div className={styles.dealGrid}>{items.map(item => <article className={styles.dealCard} key={item.id}>
        <a href={`/deals/${encodeURIComponent(item.slug)}`} className={styles.dealImageLink}>
          <div className={styles.imageFrame}><ProductImage src={item.imageUrl} alt={item.title} fallbackLabel={item.brand} /></div>
        </a>
        <div className={styles.dealBody}><h2><a href={`/deals/${encodeURIComponent(item.slug)}`}>{item.title}</a></h2>
          <PriceDisplay currentPrice={item.currentPrice} currency="VND" /><VerifiedSourceBadge verified={item.verifiedSource} />
          {detail && item.description ? <p>{item.description}</p> : null}
          <p className={styles.cardDisclosure}>Giá và ưu đãi có thể thay đổi tại nhà bán.</p>
          <a className={styles.primaryButton} href={item.outboundHref} rel="sponsored noopener noreferrer" target="_blank">Xem tại nhà bán</a>
        </div>
      </article>)}</div>
      {detail && items[0]?.priceHistory?.length ? <PriceHistory points={items[0].priceHistory} /> : null}
      {cursor ? <button className={styles.secondaryButton} onClick={() => { setState('loading'); setItems([]); setRequestCursor(cursor); }}>Trang tiếp</button> : null}
      <AffiliateDisclosure />
    </div></main><PublicFooter />
  </div>;
}
