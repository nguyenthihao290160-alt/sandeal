// ===========================================
// Image Resolver Bot
// Finds real product images with priority fallback
// ===========================================

import { BotContext } from './context';
import { checkImageHealth } from './productHealthCheck';
import { extractDeterministicProductData } from '@/lib/product-intelligence/deterministicExtraction';
import { fetchExternalSafely } from '@/lib/product-intelligence/urlSafety';

const PLACEHOLDER_IMAGE = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22300%22%3E%3Crect fill=%22%23f0f0f0%22 width=%22300%22 height=%22300%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 font-size=%2216%22 fill=%22%23999%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22%3EImage Not Available%3C/text%3E%3C/svg%3E';

export class ImageResolverBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async resolveImage(
    productUrl?: string,
    apiImage?: string,
    rawData?: Record<string, unknown>
  ): Promise<string> {
    // Priority 1: API image field
    if (apiImage && apiImage.trim()) {
      const isValid = await this.validateImageUrl(apiImage);
      if (isValid) {
        await this.ctx.info('Using verified API image', { source: 'api_image' });
        return apiImage;
      }
    }

    // Priority 2: Source API image field
    if (rawData) {
      const apiImageFields = ['image', 'imageUrl', 'image_url', 'thumbnail', 'thumbnail_url'];
      for (const field of apiImageFields) {
        if (rawData[field]) {
          const url = String(rawData[field]);
          const isValid = await this.validateImageUrl(url);
          if (isValid) {
            await this.ctx.info('Using verified source image field', { field });
            return url;
          }
        }
      }
    }

    // Priority 3: bounded deterministic JSON-LD/OpenGraph extraction.
    if (productUrl) {
      const extracted = await this.extractPageImage(productUrl);
      if (extracted) {
        await this.ctx.info('Using verified deterministic page image', {
          source: extracted.source,
          ruleVersion: extracted.ruleVersion,
        });
        return extracted.url;
      }
    }

    // Priority 4: Professional placeholder
    await this.ctx.info('Using placeholder image - no real image found');
    return PLACEHOLDER_IMAGE;
  }

  private async validateImageUrl(url: string): Promise<boolean> {
    try {
      const result = await checkImageHealth(url);
      return result.ok && result.statusCode === 200 && String(result.contentType || '').toLowerCase().startsWith('image/');
    } catch {
      return false;
    }
  }

  private async extractPageImage(url: string): Promise<{
    url: string;
    source: string;
    ruleVersion: string;
  } | null> {
    try {
      const fetched = await fetchExternalSafely(url, {
        timeoutMs: 8_000,
        maxBytes: 512 * 1024,
        maxRedirects: 4,
      });
      const contentType = String(fetched.response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/html')) return null;
      const html = new TextDecoder().decode(fetched.body);
      const extraction = extractDeterministicProductData(html, fetched.finalUrl);
      for (const candidate of extraction.images) {
        if (await this.validateImageUrl(candidate.value)) {
          return {
            url: candidate.value,
            source: candidate.provenance.source,
            ruleVersion: extraction.ruleVersion,
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

export async function createImageResolver(runId: string): Promise<ImageResolverBot> {
  return new ImageResolverBot(new BotContext(runId, 'image_resolver'));
}
