// ===========================================
// Image Resolver Bot
// Finds real product images with priority fallback
// ===========================================

import { BotContext } from './context';

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
        await this.ctx.info('Using API image', { url: apiImage });
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
            await this.ctx.info('Using source image field', { field, url });
            return url;
          }
        }
      }
    }

    // Priority 3: OpenGraph image from product URL
    if (productUrl) {
      const ogImage = await this.extractOGImage(productUrl);
      if (ogImage) {
        await this.ctx.info('Using OpenGraph image', { url: ogImage });
        return ogImage;
      }
    }

    // Priority 4: JSON-LD Product image
    if (productUrl) {
      const jsonldImage = await this.extractJsonLDImage(productUrl);
      if (jsonldImage) {
        await this.ctx.info('Using JSON-LD image', { url: jsonldImage });
        return jsonldImage;
      }
    }

    // Priority 5: Professional placeholder
    await this.ctx.info('Using placeholder image - no real image found');
    return PLACEHOLDER_IMAGE;
  }

  private async validateImageUrl(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  private async extractOGImage(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8000),
      });
      const html = await response.text();
      const match = html.match(/<meta property=["']og:image["']\s+content=["']([^"']+)["']/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private async extractJsonLDImage(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8000),
      });
      const html = await response.text();
      const jsonMatch = html.match(/<script type=["']application\/ld\+json["'][^>]*>([^<]+)<\/script>/i);
      if (!jsonMatch) return null;

      const json = JSON.parse(jsonMatch[1]);
      if (json.image) {
        const img = Array.isArray(json.image) ? json.image[0] : json.image;
        return typeof img === 'string' ? img : img.url;
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
