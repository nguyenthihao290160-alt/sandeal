'use client';

import Image, { type ImageLoaderProps } from 'next/image';
import { useState } from 'react';

import styles from '@/components/public/public.module.css';

const passthroughLoader = ({ src }: ImageLoaderProps) => src;

export default function ProductImage({
  src,
  alt,
  compact = false,
  eager = false,
  sizes,
}: {
  src?: string | null;
  alt: string;
  compact?: boolean;
  eager?: boolean;
  sizes?: string;
}) {
  const cleanSrc = typeof src === 'string' ? src.trim() : '';
  const [failedSrc, setFailedSrc] = useState('');

  if (!cleanSrc || failedSrc === cleanSrc) {
    return (
      <div role="img" aria-label={alt} className={styles.imageFallback}>
        <span>{compact ? 'Ảnh chưa khả dụng' : `Ảnh của ${alt} đang được cập nhật`}</span>
      </div>
    );
  }

  return (
    <Image
      loader={passthroughLoader}
      unoptimized
      src={cleanSrc}
      alt={alt}
      width={compact ? 160 : 800}
      height={compact ? 160 : 800}
      sizes={sizes || (compact ? '160px' : '(max-width: 800px) 100vw, 520px')}
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : 'auto'}
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(cleanSrc)}
      className={styles.productImage}
    />
  );
}
