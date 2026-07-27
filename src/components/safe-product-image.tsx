'use client';

import { useMemo, useState } from 'react';

const FALLBACK = '/product-placeholder.svg';

export interface SafeProductImageProps {
  originalUrl?: string | null;
  candidates?: Array<string | null | undefined>;
  alt: string;
  healthStatus?: string | null;
  className?: string;
  sizes?: string;
  showFailureStatus?: boolean;
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (parsed.protocol === 'https:') {
      if (parsed.username || parsed.password || !host) return null;
      if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
      if (
        /^(?:0|10|127|169\.254|192\.168)\./.test(host)
        || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
        || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
        || /^192\.0\./.test(host)
        || /^198\.(?:18|19)\./.test(host)
      ) return null;
      if (/^(?:::|::1|::ffff:|f[cd]|fe[89ab]|ff)/i.test(host)) return null;
      return parsed.toString();
    }
    return null;
  } catch { return value.startsWith('/') && !value.startsWith('//') ? value : null; }
}

export function SafeProductImage({ originalUrl, candidates = [], alt, healthStatus, className, showFailureStatus = false }: SafeProductImageProps) {
  const sourceInputKey = [originalUrl, ...candidates].map(value => String(value || '')).join('\u001f');
  const sources = useMemo(
    () => [...new Set([originalUrl, ...candidates].map(safeHttpUrl).filter((value): value is string => Boolean(value)))],
    // sourceInputKey intentionally normalizes caller arrays that may be recreated on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceInputKey],
  );
  const [storedState, setStoredState] = useState({ sourceInputKey, index: 0, loading: true });
  const activeState = storedState.sourceInputKey === sourceInputKey
    ? storedState
    : { sourceInputKey, index: 0, loading: true };
  const index = activeState.index;
  const loading = activeState.loading;
  const selected = sources[index] || FALLBACK;
  const fallback = selected === FALLBACK;
  const hadInput = Boolean(originalUrl || candidates.some(Boolean));
  const failureCategory = !fallback
    ? 'none'
    : sources.length
      ? 'remote_load_failed'
      : hadInput
        ? 'unsafe_or_invalid_url'
        : 'missing_source';

  return (
    <figure
      className={`safe-product-image ${className || ''}`}
      data-image-source={fallback ? 'fallback' : index === 0 ? 'original' : 'candidate'}
      data-image-health={healthStatus || 'unknown'}
      data-image-failure-category={failureCategory}
    >
      {loading && <span className="safe-product-image-loading" aria-hidden="true" />}
      {/* img is intentional: product sources are dynamic and the fallback must remain client-safe even when a host is not in Next Image config. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={selected}
        alt={fallback ? `${alt} — chưa có ảnh đã xác minh` : alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={event => {
          if (event.currentTarget.getAttribute('src') !== selected) return;
          setStoredState({ sourceInputKey, index, loading: false });
        }}
        onError={event => {
          if (event.currentTarget.getAttribute('src') !== selected) return;
          setStoredState({
            sourceInputKey,
            index: index < sources.length ? index + 1 : index,
            loading: index < sources.length,
          });
        }}
      />
      {showFailureStatus && fallback && (
        <span className="safe-product-image-status" role="status">
          {failureCategory === 'remote_load_failed'
            ? 'Không tải được ảnh nguồn · đang dùng ảnh thay thế'
            : failureCategory === 'unsafe_or_invalid_url'
              ? 'URL ảnh không an toàn hoặc không hợp lệ'
              : 'Chưa có ảnh nguồn'}
        </span>
      )}
      <figcaption className="sr-only">{fallback ? 'Ảnh fallback giao diện, không được ghi làm ảnh nguồn.' : index === 0 ? 'Ảnh nguồn ban đầu.' : 'Ảnh candidate đã có trong dữ liệu.'}</figcaption>
    </figure>
  );
}
