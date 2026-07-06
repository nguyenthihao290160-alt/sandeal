import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "vietnamese"],
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: "#0a0e1a",
};

export const metadata: Metadata = {
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
    <html lang="vi" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
