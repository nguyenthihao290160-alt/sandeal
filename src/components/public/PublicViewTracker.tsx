'use client';

import { useEffect } from 'react';

function eventId(productId: string): string {
  const key = `sandeal:view:${productId}`;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = globalThis.crypto?.randomUUID?.() || `view-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(key, created);
    return created;
  } catch {
    return globalThis.crypto?.randomUUID?.() || `view-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function PublicViewTracker({ productId, contentPageId }: { productId: string; contentPageId: string }) {
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch('/api/public/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, contentPageId, eventId: eventId(productId) }),
        cache: 'no-store',
        keepalive: true,
        signal: controller.signal,
      }).catch(() => undefined);
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [contentPageId, productId]);

  return null;
}
