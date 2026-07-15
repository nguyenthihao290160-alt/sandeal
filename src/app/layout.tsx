import type { Metadata, Viewport } from "next";
import "./globals.css";
import { config } from '@/lib/config';
import { buildSiteJsonLd } from '@/lib/seo/siteSeo';

export const viewport: Viewport = {
  themeColor: "#0f6ef6",
};

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl),
  title: "SanDeal — Kiểm tra deal, giá và nguồn sản phẩm",
  description: "Khám phá deal, so sánh giá và đọc phân tích dựa trên dữ liệu có nguồn, thời điểm cập nhật và bằng chứng hiện có.",
  applicationName: 'SanDeal',
  keywords: ["deal", "so sánh giá", "sản phẩm", "lịch sử giá", "SanDeal"],
  openGraph: {
    title: 'SanDeal — Kiểm tra deal trước khi quyết định',
    description: 'Xem giá, nguồn, thời điểm cập nhật và phân tích dựa trên dữ liệu hiện có.',
    url: '/',
    type: 'website',
    locale: 'vi_VN',
    siteName: 'SanDeal',
  },
  twitter: {
    card: 'summary',
    title: 'SanDeal — Kiểm tra deal trước khi quyết định',
    description: 'Xem giá, nguồn, thời điểm cập nhật và phân tích dựa trên dữ liệu hiện có.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const structuredData = buildSiteJsonLd();
  return (
    <html lang="vi">
      <body>
        {structuredData.map((value, index) => (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(value).replace(/</g, '\\u003c') }}
            key={index}
          />
        ))}
        {children}
      </body>
    </html>
  );
}
