'use client';

import { useState } from 'react';

import ProductImage from '@/app/deals/ProductImage';

import styles from './public.module.css';

export function ProductGallery({ images, title }: { images: string[]; title: string }) {
  const available = [...new Set(images.filter(Boolean))].slice(0, 8);
  const [activeImage, setActiveImage] = useState(available[0] || '');

  return (
    <div className={styles.productGallery}>
      <div className={styles.galleryMain}>
        <div className={styles.imageFrame}>
          <ProductImage
            key={activeImage || 'fallback'}
            src={activeImage}
            alt={title}
            eager
            sizes="(max-width: 800px) calc(100vw - 28px), 520px"
          />
        </div>
      </div>
      {available.length > 1 ? (
        <div className={styles.galleryThumbnails} aria-label="Ảnh sản phẩm">
          {available.map((image, index) => (
            <button
              type="button"
              className={image === activeImage ? styles.galleryThumbnailActive : styles.galleryThumbnail}
              aria-label={`Xem ảnh ${index + 1} của ${title}`}
              aria-pressed={image === activeImage}
              onClick={() => setActiveImage(image)}
              key={image}
            >
              <ProductImage src={image} alt="" compact sizes="72px" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
