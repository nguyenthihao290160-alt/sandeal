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
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch { return value.startsWith('/') && !value.startsWith('//') ? value : null; }
}

export function SafeProductImage({ originalUrl, candidates = [], alt, healthStatus, className }: SafeProductImageProps) {
  const sources = useMemo(() => [...new Set([originalUrl, ...candidates].map(safeHttpUrl).filter((value): value is string => Boolean(value)))], [originalUrl, candidates]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const selected = sources[index] || FALLBACK;
  const fallback = selected === FALLBACK;
  return (
    <figure className={`safe-product-image ${className || ''}`} data-image-source={fallback ? 'fallback' : index === 0 ? 'original' : 'candidate'} data-image-health={healthStatus || 'unknown'}>
      {loading && <span className="safe-product-image-loading" aria-hidden="true" />}
      {/* img is intentional: product sources are dynamic and the fallback must remain client-safe even when a host is not in Next Image config. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={selected}
        alt={fallback ? `${alt} — chưa có ảnh đã xác minh` : alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoading(false)}
        onError={() => {
          setLoading(true);
          if (index < sources.length) setIndex(current => current + 1);
          else setLoading(false);
        }}
      />
      <figcaption className="sr-only">{fallback ? 'Ảnh fallback giao diện, không được ghi làm ảnh nguồn.' : index === 0 ? 'Ảnh nguồn ban đầu.' : 'Ảnh candidate đã có trong dữ liệu.'}</figcaption>
    </figure>
  );
}
