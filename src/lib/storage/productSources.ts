import { generateId, insertOne, readCollection } from './adapter';
import type { ProductKind, ProductPlatform } from '@/lib/types';

const COLLECTION = 'product-sources';

export interface ProductSourceConfig {
  id: string;
  name: string;
  url: string;
  platform: ProductPlatform;
  kind: ProductKind;
  enabled: boolean;
  scanSchedule?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateProductSourceInput = Omit<ProductSourceConfig, 'id' | 'createdAt' | 'updatedAt'>;

export async function listProductSources(): Promise<ProductSourceConfig[]> {
  return readCollection<ProductSourceConfig>(COLLECTION);
}

export async function createProductSource(input: CreateProductSourceInput): Promise<ProductSourceConfig> {
  const sources = await listProductSources();
  if (sources.some((source) => source.url.toLowerCase() === input.url.toLowerCase())) {
    throw new Error('DUPLICATE_SOURCE');
  }
  const now = new Date().toISOString();
  return insertOne(COLLECTION, { id: generateId(), ...input, createdAt: now, updatedAt: now });
}
