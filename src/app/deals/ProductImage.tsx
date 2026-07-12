'use client';

import Image, { type ImageLoaderProps } from 'next/image';
import { useState } from 'react';

const passthroughLoader = ({ src }: ImageLoaderProps) => src;

export default function ProductImage({ src, alt, compact = false }: { src: string; alt: string; compact?: boolean }) {
  const [failedSrc, setFailedSrc] = useState('');
  if (!src || failedSrc === src) {
    return <div role="img" aria-label={alt} style={{ width: '100%', height: '100%', minHeight: compact ? 68 : 260, display: 'grid', placeItems: 'center', background: '#f1f5f9', color: '#64748b', padding: 12, textAlign: 'center' }}>
      <span>{compact ? 'Ảnh chưa khả dụng' : `Ảnh của ${alt} đang được cập nhật`}</span>
    </div>;
  }
  return <Image loader={passthroughLoader} unoptimized src={src} alt={alt} width={compact ? 160 : 800} height={compact ? 160 : 800}
    sizes={compact ? '160px' : '(max-width: 768px) 100vw, 520px'} loading={compact ? 'lazy' : 'eager'} referrerPolicy="no-referrer"
    onError={() => setFailedSrc(src)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', background: '#f8fafc' }} />;
}
