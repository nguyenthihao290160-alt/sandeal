import type { Metadata } from 'next';
import '@/app/globals.css';
export const metadata: Metadata = { title: 'SanDeal — Kiểm tra trước khi mua', description: 'Giá và thông tin sản phẩm từ nguồn đã kiểm tra.', robots: { index: false, follow: false } };
export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="vi"><body>{children}</body></html>; }
