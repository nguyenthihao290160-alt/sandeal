import type { Metadata } from 'next';
import '@/app/globals.css';
export const metadata: Metadata = { title: 'SanDeal — Kiểm tra trước khi mua', description: 'Giá và thông tin sản phẩm từ nguồn đã kiểm tra.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:8787'), robots: { index: false, follow: false },
  other: { 'sandeal-environment': process.env.NEXT_PUBLIC_SANDEAL_ENVIRONMENT || 'LOCAL' } };
export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="vi"><body>{children}</body></html>; }
