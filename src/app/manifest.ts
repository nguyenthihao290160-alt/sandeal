import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SanDeal',
    short_name: 'SanDeal',
    description: 'Kiểm tra giá, nguồn, link và bằng chứng sản phẩm trước khi truy cập nhà bán.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f6f8fc',
    theme_color: '#3157c8',
    lang: 'vi-VN',
    icons: [
      { src: '/icons/192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
