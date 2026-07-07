// ===========================================
// POST /api/products/cleanup-broken-links
// Archives broken products safely
// ===========================================

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listProducts } from '@/lib/storage/products';
import { createProductCleanup } from '@/lib/bots/productCleanup';

export async function POST(req: NextRequest) {
  try {
    // Check auth
    const authError = await requireAuth(req);
    if (authError) return authError;

    // Get published/approved products
    const products = await listProducts({ status: 'approved' });
    const productIds = products.map(p => p.id);

    // Cleanup
    const runId = `cleanup-${Date.now()}`;
    const cleanupBot = await createProductCleanup(runId);
    const cleaned = await cleanupBot.bulkCleanup(productIds);

    return NextResponse.json({
      success: true,
      data: {
        checked: productIds.length,
        archived: cleaned,
      },
    });
  } catch (error) {
    console.error('[cleanup-broken-links] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
