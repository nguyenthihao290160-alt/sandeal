import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SanDeal',
    short_name: 'SanDeal',
    description: 'Kiểm tra giá, nguồn, link và bằng chứng sản phẩm trước khi truy cập nhà bán.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f8fc',
    theme_color: '#3157c8',
    lang: 'vi-VN',
    icons: [
      { src: '/icon', sizes: '32x32', type: 'image/png', purpose: 'any' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png', purpose: 'any' },
    ],
  };
}
