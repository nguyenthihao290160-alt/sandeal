// ===========================================
// POST /api/products/link-health/check
// Checks product and affiliate URLs
// ===========================================

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getProductById } from '@/lib/storage/products';
import { createLinkHealthChecker } from '@/lib/bots/linkHealth';

interface LinkHealthCheckRequest {
  productId: string;
}

export async function POST(req: NextRequest) {
  try {
    // Check auth
    const authError = await requireAuth(req);
    if (authError) return authError;

    const body = await req.json() as LinkHealthCheckRequest;

    if (!body.productId) {
      return NextResponse.json(
        { success: false, error: 'productId is required' },
        { status: 400 }
      );
    }

    // Get product
    const product = await getProductById(body.productId);
    if (!product) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 }
      );
    }

    // Check links
    const runId = `link-check-${Date.now()}`;
    const healthBot = await createLinkHealthChecker(runId);
    const linkCheck = await healthBot.checkProductLink(
      product.id,
      product.originalUrl,
      product.affiliateUrl,
      product.imageUrl
    );

    if (!linkCheck) {
      return NextResponse.json(
        { success: false, error: 'Link check failed' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: linkCheck,
    });
  } catch (error) {
    console.error('[link-health/check] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
