import type { Metadata, Viewport } from "next";
import "./globals.css";
import { config } from '@/lib/config';
import { buildSiteJsonLd } from '@/lib/seo/siteSeo';
import { BuildMismatchGuard } from '@/components/public/BuildMismatchGuard';
import { getReleaseIdentity } from '@/lib/releaseIdentity';

export const viewport: Viewport = {
  themeColor: "#3157c8",
  colorScheme: 'light',
};

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl),
  title: {
    default: 'SanDeal — Kiểm tra giá và độ tin cậy trước khi mua',
    template: '%s | SanDeal',
  },
  description: 'Kiểm tra giá, nguồn, link và bằng chứng sản phẩm trước khi truy cập nhà bán.',
  applicationName: 'SanDeal',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon', type: 'image/png', sizes: '32x32' },
      { url: '/icons/192.png', type: 'image/png', sizes: '192x192' },
      { url: '/icons/512.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: [{ url: '/apple-icon', type: 'image/png', sizes: '180x180' }],
  },
  keywords: ["deal", "so sánh giá", "sản phẩm", "lịch sử giá", "SanDeal"],
  openGraph: {
    title: 'SanDeal — Kiểm tra giá và độ tin cậy trước khi mua',
    description: 'Kiểm tra giá, nguồn, link và bằng chứng sản phẩm trước khi truy cập nhà bán.',
    url: '/',
    type: 'website',
    locale: 'vi_VN',
    siteName: 'SanDeal',
    images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'SanDeal — Kiểm tra giá và độ tin cậy trước khi mua' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SanDeal — Kiểm tra giá và độ tin cậy trước khi mua',
    description: 'Kiểm tra giá, nguồn, link và bằng chứng sản phẩm trước khi truy cập nhà bán.',
    images: ['/opengraph-image'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const structuredData = buildSiteJsonLd();
  const release = getReleaseIdentity();
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
        <BuildMismatchGuard buildId={release.buildId} />
      </body>
    </html>
  );
}
