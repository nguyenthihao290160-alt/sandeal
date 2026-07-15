'use client';

import { useEffect } from 'react';

import { trackPublicEvent, type PublicClientEventType } from './PublicAnalytics';

export function PublicViewTracker({
  productId,
  contentPageId,
  contextKey,
  resultCount,
  eventType = 'PRODUCT_DETAIL_VIEW',
}: {
  productId?: string;
  contentPageId: string;
  contextKey?: string;
  resultCount?: number;
  eventType?: PublicClientEventType;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      trackPublicEvent(
        { eventType, productId, contentPageId, contextKey, resultCount },
        `${eventType}:${productId || contextKey || contentPageId}`,
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [contentPageId, contextKey, eventType, productId, resultCount]);

  return null;
}
