'use client';

import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';

export type PublicClientEventType =
  | 'PUBLIC_SEARCH'
  | 'SEARCH_NO_RESULT'
  | 'CATEGORY_VIEW'
  | 'PRODUCT_CARD_VIEW'
  | 'PRODUCT_CARD_CLICK'
  | 'PRODUCT_DETAIL_VIEW'
  | 'PRICE_HISTORY_OPEN'
  | 'COMPARE_ADD'
  | 'COMPARE_OPEN'
  | 'GUIDE_VIEW';

export interface PublicClientEvent {
  eventType: PublicClientEventType;
  productId?: string;
  contentPageId?: string;
  contextKey?: string;
  resultCount?: number;
}

function randomEventId() {
  return globalThis.crypto?.randomUUID?.() || `event-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function eventId(dedupeKey?: string) {
  if (!dedupeKey) return randomEventId();
  const key = `sandeal:event:${dedupeKey}`;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = randomEventId();
    window.sessionStorage.setItem(key, created);
    return created;
  } catch {
    return randomEventId();
  }
}

function anonymousSessionId() {
  const key = 'sandeal:anonymous-session';
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = randomEventId();
    window.sessionStorage.setItem(key, created);
    return created;
  } catch { return randomEventId(); }
}

export function trackPublicEvent(event: PublicClientEvent, dedupeKey?: string) {
  void fetch('/api/public/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...event, eventId: eventId(dedupeKey), anonymousSessionId: anonymousSessionId() }),
    cache: 'no-store',
    keepalive: true,
  }).catch(() => undefined);
}

export function PublicVisibilityTracker({
  event,
  dedupeKey,
  children,
  className,
}: {
  event: PublicClientEvent;
  dedupeKey: string;
  children: ReactNode;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sent = useRef(false);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || sent.current) return;
    if (!('IntersectionObserver' in window)) {
      sent.current = true;
      trackPublicEvent(event, dedupeKey);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting) || sent.current) return;
      sent.current = true;
      trackPublicEvent(event, dedupeKey);
      observer.disconnect();
    }, { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [dedupeKey, event]);

  return <div className={className} ref={rootRef}>{children}</div>;
}

export function PublicProductCardTracker({
  productId,
  children,
  className,
}: {
  productId: string;
  children: ReactNode;
  className: string;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const viewed = useRef(false);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || viewed.current) return;
    if (!('IntersectionObserver' in window)) {
      viewed.current = true;
      trackPublicEvent({ eventType: 'PRODUCT_CARD_VIEW', productId }, `card-view:${productId}`);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting) || viewed.current) return;
      viewed.current = true;
      trackPublicEvent({ eventType: 'PRODUCT_CARD_VIEW', productId }, `card-view:${productId}`);
      observer.disconnect();
    }, { threshold: 0.35 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [productId]);

  function onClickCapture(event: MouseEvent<HTMLElement>) {
    const target = event.target instanceof Element ? event.target.closest('[data-product-detail-link="true"]') : null;
    if (target) trackPublicEvent({ eventType: 'PRODUCT_CARD_CLICK', productId });
  }

  return <article className={className} ref={rootRef} onClickCapture={onClickCapture}>{children}</article>;
}
