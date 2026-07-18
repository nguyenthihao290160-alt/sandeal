'use client';

import { useEffect, useRef, useState } from 'react';
import { isBuildMismatchMessage, isComparableBuildId } from '@/lib/buildMismatch';

const RELOAD_PREFIX = 'sandeal:build-mismatch-reload:';
const LOG_PREFIX = 'sandeal:build-mismatch-log:';

export function BuildMismatchGuard({ buildId }: { buildId: string }) {
  const [notice, setNotice] = useState(false);
  const dirtyForm = useRef(false);
  const handling = useRef(false);

  useEffect(() => {
    const markDirty = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) dirtyForm.current = true;
    };
    const markClean = () => { dirtyForm.current = false; };
    const handleMismatch = () => {
      if (handling.current) return;
      handling.current = true;
      const reloadKey = `${RELOAD_PREFIX}${buildId}`;
      const logKey = `${LOG_PREFIX}${buildId}`;
      if (!sessionStorage.getItem(logKey)) {
        sessionStorage.setItem(logKey, '1');
        console.warn('BUILD_MISMATCH_DETECTED');
      }
      if (!dirtyForm.current && !sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, '1');
        window.location.reload();
        return;
      }
      setNotice(true);
    };
    const onError = (event: ErrorEvent) => { if (isBuildMismatchMessage(event.error || event.message)) handleMismatch(); };
    const onRejection = (event: PromiseRejectionEvent) => { if (isBuildMismatchMessage(event.reason)) handleMismatch(); };
    const verifyBuild = async () => {
      try {
        const response = await fetch('/api/health/live', { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return;
        const live = await response.json() as { buildId?: unknown };
        if (isComparableBuildId(buildId) && isComparableBuildId(live.buildId) && live.buildId !== buildId) handleMismatch();
      } catch { /* Liveness polling is advisory; navigation remains available. */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void verifyBuild(); };
    document.addEventListener('input', markDirty, true);
    document.addEventListener('change', markDirty, true);
    document.addEventListener('submit', markClean, true);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    void verifyBuild();
    return () => {
      document.removeEventListener('input', markDirty, true);
      document.removeEventListener('change', markDirty, true);
      document.removeEventListener('submit', markClean, true);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [buildId]);

  if (!notice) return null;
  return (
    <aside role="status" style={{ position: 'fixed', zIndex: 1000, inset: 'auto 16px 16px', maxWidth: 560, marginInline: 'auto', padding: '14px 16px', border: '1px solid #bfdbfe', borderRadius: 14, background: '#eff6ff', color: '#172554', boxShadow: '0 12px 30px rgb(15 23 42 / 18%)', display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
      <span>Website vừa được cập nhật. Dữ liệu bạn đang nhập được giữ nguyên; vui lòng tải lại khi sẵn sàng.</span>
      <button type="button" onClick={() => window.location.reload()} style={{ flex: '0 0 auto', border: 0, borderRadius: 10, padding: '9px 12px', background: '#0f6ef6', color: 'white', fontWeight: 700, cursor: 'pointer' }}>Tải lại</button>
    </aside>
  );
}
