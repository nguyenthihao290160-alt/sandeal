// ===========================================
// POST /api/products/content-package
// Generates content package for a product
// ===========================================

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getProductById } from '@/lib/storage/products';
import { createContentReview } from '@/lib/bots/contentReview';
import { createComplianceGuard } from '@/lib/bots/complianceGuard';
import { createContentPackage } from '@/lib/storage/contentPackages';

interface ContentPackageRequest {
  productId: string;
}

export async function POST(req: NextRequest) {
  try {
    // Check auth
    const authError = await requireAuth(req);
    if (authError) return authError;

    const body = await req.json() as ContentPackageRequest;

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

    // Create temp run ID for logging
    const runId = `content-pkg-${Date.now()}`;

    // Generate content
    const contentBot = await createContentReview(runId);
    const content = await contentBot.generateContent(product);

    // Check compliance
    const complianceBot = await createComplianceGuard(runId);
    const complianceResult = await complianceBot.checkContent(content);

    // Update content with compliance status
    content.complianceStatus = complianceResult.status;
    content.complianceIssues = complianceResult.issues;

    // Save package
    const savedPackage = await createContentPackage(product.id, content);

    return NextResponse.json({
      success: true,
      data: savedPackage,
    });
  } catch (error) {
    console.error('[content-package] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
