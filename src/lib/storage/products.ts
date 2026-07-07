// ===========================================
// Product Storage
// ===========================================

import type { Product, CreateProductInput, ProductFilters } from '../types';
import { readCollection, writeCollection, findById, insertOne, updateOne, deleteOne, generateId } from './adapter';
import { normalizeProductForPublic } from '../productNormalizer';

const COLLECTION = 'products';

/** List products with optional filters */
export async function listProducts(filters?: ProductFilters): Promise<Product[]> {
  let products = await readCollection<Product>(COLLECTION);

  if (!filters) return products;

  if (filters.q) {
    const q = filters.q.toLowerCase();
    products = products.filter(p =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.description?.toLowerCase().includes(q)) ||
      ((Array.isArray(p.tags) ? p.tags : []).some(t => t.toLowerCase().includes(q)))
    );
  }
  if (filters.platform) {
    products = products.filter(p => p.platform === filters.platform);
  }
  if (filters.source) {
    products = products.filter(p => p.source === filters.source);
  }
  if (filters.status) {
    products = products.filter(p => p.status === filters.status);
  }
  if (filters.kind) {
    products = products.filter(p => p.kind === filters.kind);
  }
  if (filters.riskLevel) {
    products = products.filter(p => p.riskLevel === filters.riskLevel);
  }
  if (filters.minScore !== undefined) {
    products = products.filter(p => (p.score ?? 0) >= filters.minScore!);
  }

  return products;
}

export async function getAllProducts(): Promise<Product[]> {
  return readCollection<Product>(COLLECTION);
}

export async function getProductById(id: string): Promise<Product | null> {
  return findById<Product>(COLLECTION, id);
}

export async function getProductBySlug(slug: string): Promise<Product | null> {
  const products = await readCollection<Product>(COLLECTION);
  return products.find(p => p.slug === slug) ?? null;
}

export function isPublicSafeProduct(p: Product): boolean {
  const status = p.status;
  // Disallowed explicit states
  if (status === 'archived' || status === 'draft' || status === 'needs_review') return false;
  // Only allow approved or published
  if (status !== 'published' && status !== 'approved') return false;

  // Link health — treat certain statuses as broken
  const brokenStatuses = ['not_found', 'affiliate_error', 'image_broken', 'product_unavailable', 'server_error'];
  if (p.linkHealthStatus && brokenStatuses.includes(p.linkHealthStatus)) return false;

  return true;
}

export async function getPublishedProducts(): Promise<Product[]> {
  const products = await readCollection<Product>(COLLECTION);
  const filtered = products.filter(isPublicSafeProduct);
  // Normalize to ensure consistent public schema
  return filtered.map(p => normalizeProductForPublic(p));
}

export async function getPublicProducts(filters?: ProductFilters): Promise<Product[]> {
  let products = await readCollection<Product>(COLLECTION);
  if (filters) {
    // reuse existing listProducts filtering by delegating
    products = await listProducts(filters);
  }
  const filtered = products.filter(isPublicSafeProduct);
  return filtered.map(p => normalizeProductForPublic(p));
}

export async function createProduct(data: CreateProductInput): Promise<Product> {
  const product: Product = {
    ...data,
    id: generateId(),
    slug: generateSlug(data.title),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return insertOne<Product>(COLLECTION, product);
}

export async function updateProduct(id: string, updates: Partial<Product>): Promise<Product | null> {
  return updateOne<Product>(COLLECTION, id, updates);
}

export async function deleteProduct(id: string): Promise<boolean> {
  return deleteOne<Product>(COLLECTION, id);
}

export async function approveProduct(id: string): Promise<Product | null> {
  return updateOne<Product>(COLLECTION, id, { status: 'approved' } as Partial<Product>);
}

export async function archiveProduct(id: string): Promise<Product | null> {
  return updateOne<Product>(COLLECTION, id, { status: 'archived' } as Partial<Product>);
}

export async function getProductStats(): Promise<{
  total: number;
  draft: number;
  needsReview: number;
  approved: number;
  published: number;
  archived: number;
}> {
  const products = await readCollection<Product>(COLLECTION);
  return {
    total: products.length,
    draft: products.filter(p => p.status === 'draft').length,
    needsReview: products.filter(p => p.status === 'needs_review').length,
    approved: products.filter(p => p.status === 'approved').length,
    published: products.filter(p => p.status === 'published').length,
    archived: products.filter(p => p.status === 'archived').length,
  };
}

/** Generate URL-safe slug from title */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) + '-' + Date.now().toString(36);
}

/** Seed some sample products for development */
export async function seedSampleProducts(): Promise<void> {
  const existing = await readCollection<Product>(COLLECTION);
  if (existing.length > 0) return;

  const now = new Date().toISOString();
  const samples: Product[] = [
    {
      id: generateId(),
      title: 'Tai nghe Bluetooth TWS Pro Max',
      slug: 'tai-nghe-bluetooth-tws-pro-max-' + Date.now().toString(36),
      description: 'Tai nghe không dây chống ồn, pin 30 giờ, phù hợp nghe nhạc và họp online.',
      kind: 'product',
      platform: 'shopee',
      source: 'manual',
      originalUrl: 'https://shopee.vn/product/example1',
      affiliateUrl: '',
      imageUrl: '',
      gallery: [],
      price: 299000,
      salePrice: 179000,
      currency: 'VND',
      priceNote: 'Giá có thể thay đổi theo thời gian',
      category: 'Công nghệ',
      tags: ['tai nghe', 'bluetooth', 'giảm giá'],
      benefits: ['Chống ồn chủ động', 'Pin 30 giờ', 'Kết nối Bluetooth 5.3'],
      painPoints: ['Muốn nghe nhạc không dây', 'Cần tai nghe cho họp online'],
      targetAudience: ['Dân văn phòng', 'Sinh viên'],
      warnings: [],
      contentAngles: ['Review trung thực', 'So sánh giá'],
      complianceNotes: [],
      affiliateSource: 'shopee',
      score: 72,
      scoreLabel: 'Ưu tiên cao',
      scoreReasons: ['Có hình ảnh', 'Có link affiliate', 'Giá hấp dẫn'],
      scoreWarnings: [],
      riskLevel: 'low',
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: generateId(),
      title: 'Bộ dưỡng da Vitamin C serum',
      slug: 'bo-duong-da-vitamin-c-serum-' + Date.now().toString(36),
      description: 'Serum dưỡng sáng da, giúp da đều màu theo thông tin nhà sản xuất.',
      kind: 'product',
      platform: 'tiktok_shop',
      source: 'manual',
      originalUrl: 'https://tiktok.com/shop/example2',
      affiliateUrl: '',
      imageUrl: '',
      gallery: [],
      price: 189000,
      salePrice: 142000,
      currency: 'VND',
      category: 'Làm đẹp',
      tags: ['skincare', 'vitamin c', 'serum'],
      benefits: ['Dưỡng sáng da', 'Giúp da đều màu'],
      warnings: [],
      riskLevel: 'medium',
      status: 'needs_review',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: generateId(),
      title: 'Balo laptop chống nước 15.6 inch',
      slug: 'balo-laptop-chong-nuoc-' + Date.now().toString(36),
      description: 'Balo đựng laptop chống nước, nhiều ngăn tiện dụng cho dân văn phòng.',
      kind: 'product',
      platform: 'lazada',
      source: 'manual',
      originalUrl: 'https://lazada.vn/products/example3',
      affiliateUrl: '',
      imageUrl: '',
      gallery: [],
      price: 450000,
      salePrice: 380000,
      currency: 'VND',
      category: 'Phụ kiện',
      tags: ['balo', 'laptop', 'chống nước'],
      benefits: ['Chống nước', 'Nhiều ngăn tiện dụng', 'Phù hợp laptop 15.6 inch'],
      warnings: [],
      riskLevel: 'low',
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    },
  ];

  await writeCollection(COLLECTION, samples);
}
