import type { PublicDealCardData, PublicEvidenceData, PublicPricePoint } from './contracts';
import { DealCard } from './DealCard';
import { PublicIcon } from './PublicIcon';
import styles from './public.module.css';

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Không xác định';
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

function formatPrice(value: number) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(value);
}

export function AffiliateDisclosure() {
  return (
    <aside className={styles.disclosure} id="affiliate-disclosure">
      <strong>Minh bạch tiếp thị liên kết:</strong>{' '}
      SanDeal có thể nhận hoa hồng khi bạn truy cập nhà bán qua một số liên kết.
      Giá và điều kiện cuối cùng do nhà bán xác nhận; SanDeal không kiểm soát thay đổi tại trang đích.
    </aside>
  );
}

export function ProductEvidence({ evidence }: { evidence: PublicEvidenceData }) {
  return (
    <section className={styles.section} aria-labelledby="product-evidence-title">
      <div className={styles.container}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 id="product-evidence-title">Nguồn và dữ kiện đã xác minh</h2>
            <p>Chỉ các trường có dữ liệu được trình bày. Phần còn thiếu không được tự động suy đoán.</p>
          </div>
        </div>
        {evidence.warnings && evidence.warnings.length > 0 ? (
          <div className={styles.warningBox} role="note">
            <strong>Cảnh báo dữ liệu:</strong> {evidence.warnings.join(' · ')}
          </div>
        ) : null}
        <div className={styles.evidenceGrid}>
          <article className={styles.evidenceCard}>
            <h3>Dữ kiện sản phẩm</h3>
            {evidence.facts.length > 0 ? (
              <dl className={styles.factList}>
                {evidence.facts.map((fact) => (
                  <div key={fact.id}>
                    <dt>{fact.label}</dt>
                    <dd>
                      {typeof fact.value === 'number' && fact.id.toLocaleLowerCase('vi').includes('price')
                        ? formatPrice(fact.value)
                        : `${fact.value}${fact.id.toLocaleLowerCase('vi').includes('discount') ? '%' : ''}`}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : <p>Chưa có thông số được xác minh để hiển thị.</p>}
          </article>
          <article className={styles.evidenceCard}>
            <h3>Nguồn kiểm tra</h3>
            {evidence.sources.length > 0 ? (
              <ul className={styles.evidenceList}>
                {evidence.sources.map((source, index) => (
                  <li key={`${source.name}-${index}`}>
                    <strong>{source.name}</strong>
                    {source.fields && source.fields.length > 0 ? ` — ${source.fields.join(', ')}` : ''}
                    {source.checkedAt ? ` · kiểm tra ${formatDate(source.checkedAt)}` : ''}
                  </li>
                ))}
              </ul>
            ) : <p>Chưa có nguồn bằng chứng chi tiết để hiển thị.</p>}
          </article>
        </div>
      </div>
    </section>
  );
}

export function PriceHistory({ points }: { points: PublicPricePoint[] }) {
  const clean = points
    .filter((point) => Number.isFinite(point.price) && point.price > 0 && !Number.isNaN(Date.parse(point.capturedAt)))
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  if (clean.length === 0) {
    return (
      <section className={styles.priceHistoryCard}>
        <h2>Lịch sử giá</h2>
        <p className={styles.timeNote}>SanDeal chưa ghi nhận đủ snapshot giá cho sản phẩm này.</p>
      </section>
    );
  }

  const width = 720;
  const height = 210;
  const padding = 24;
  const min = Math.min(...clean.map((point) => point.price));
  const max = Math.max(...clean.map((point) => point.price));
  const average = clean.reduce((sum, point) => sum + point.price, 0) / clean.length;
  const changeCount = clean.slice(1).filter((point, index) => point.price !== clean[index].price).length;
  const trackingDays = Math.max(1, Math.ceil((Date.parse(clean[clean.length - 1].capturedAt) - Date.parse(clean[0].capturedAt)) / 86_400_000));
  const range = Math.max(1, max - min);
  const coordinates = clean.map((point, index) => ({
    ...point,
    x: clean.length === 1 ? width / 2 : padding + (index / (clean.length - 1)) * (width - padding * 2),
    y: height - padding - ((point.price - min) / range) * (height - padding * 2),
  }));
  const path = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');

  return (
    <section className={styles.priceHistoryCard} aria-labelledby="price-history-title">
      <h2 id="price-history-title">Lịch sử giá do SanDeal ghi nhận</h2>
      <dl className={styles.historyStats}>
        <div className={styles.historyStat}><dt>Giá hiện tại</dt><dd>{formatPrice(clean[clean.length - 1].price)}</dd></div>
        <div className={styles.historyStat}><dt>Thấp nhất SanDeal ghi nhận</dt><dd>{formatPrice(min)}</dd></div>
        <div className={styles.historyStat}><dt>Cao nhất SanDeal ghi nhận</dt><dd>{formatPrice(max)}</dd></div>
        <div className={styles.historyStat}><dt>Giá trung bình</dt><dd>{formatPrice(Math.round(average))}</dd></div>
        <div className={styles.historyStat}><dt>Thay đổi / theo dõi</dt><dd>{changeCount} lần · {trackingDays} ngày</dd></div>
      </dl>
      <svg className={styles.historyChart} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="price-chart-title price-chart-desc">
        <title id="price-chart-title">Biểu đồ lịch sử giá</title>
        <desc id="price-chart-desc">Giá được ghi nhận từ {formatDate(clean[0].capturedAt)} đến {formatDate(clean[clean.length - 1].capturedAt)}.</desc>
        <path d={path} />
        {coordinates.map((point) => (
          <circle cx={point.x} cy={point.y} r="5" key={`${point.capturedAt}-${point.price}`}>
            <title>{formatDate(point.capturedAt)}: {formatPrice(point.price)}</title>
          </circle>
        ))}
      </svg>
      <div className={styles.historyTableWrap}>
        <table className={styles.historyTable}>
          <caption className={styles.visuallyHidden}>Bảng lịch sử giá do SanDeal ghi nhận</caption>
          <thead><tr><th>Thời điểm</th><th>Giá ghi nhận</th></tr></thead>
          <tbody>
            {clean.slice().reverse().map((point) => (
              <tr key={`${point.capturedAt}-${point.price}`}><td>{formatDate(point.capturedAt)}</td><td>{formatPrice(point.price)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function RelatedDeals({
  products,
  selectedComparisonIds = [],
}: {
  products: PublicDealCardData[];
  selectedComparisonIds?: string[];
}) {
  if (products.length === 0) return null;
  return (
    <section className={styles.section} aria-labelledby="related-deals-title">
      <div className={styles.container}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 id="related-deals-title">Sản phẩm liên quan</h2>
            <p>Các sản phẩm công khai có dữ liệu tương đồng để bạn tham khảo thêm.</p>
          </div>
        </div>
        <div className={styles.dealGrid}>
          {products.map((product) => (
            <DealCard
              product={product}
              selectedComparisonIds={selectedComparisonIds}
              comparisonEnabled
              key={product.id}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export function SourceSummary({ source, checkedAt }: { source?: string | null; checkedAt?: string | null }) {
  return (
    <div className={styles.metaRow}>
      <span className={styles.verifiedBadge}><PublicIcon name="source" size={13} /> {source || 'Nguồn sản phẩm'}</span>
      {checkedAt ? <span className={styles.affiliateBadge}>Cập nhật {formatDate(checkedAt)}</span> : null}
    </div>
  );
}
