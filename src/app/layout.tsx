import type { Metadata, Viewport } from "next";
import "./globals.css";
import { config } from '@/lib/config';

export const viewport: Viewport = {
  themeColor: "#0a0e1a",
};

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl),
  title: "SanDeal — Săn deal thông minh bằng AI | Powered by ReviewPilot AI",
  description: "Hệ thống quản lý sản phẩm affiliate, tìm deal thông minh, chấm điểm cơ hội và tạo nội dung an toàn, minh bạch.",
  keywords: ["affiliate", "deal", "sản phẩm", "AI", "ReviewPilot", "SanDeal"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
