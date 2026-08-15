'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

type AdminToastTone = 'success' | 'info' | 'warning' | 'error';

interface AdminToast {
  id: number;
  message: string;
  tone: AdminToastTone;
}

interface CommandCenterContextValue {
  technicalMode: boolean;
  setTechnicalMode: (enabled: boolean) => void;
  showAdminToast: (message: string, tone?: AdminToastTone) => void;
}

const CommandCenterContext = createContext<CommandCenterContextValue | null>(null);
const TECHNICAL_MODE_KEY = 'sandeal:technical-language';

export function CommandCenterProvider({ children }: { children: ReactNode }) {
  const [technicalMode, setTechnicalModeState] = useState(false);
  const [toasts, setToasts] = useState<AdminToast[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTechnicalModeState(window.localStorage.getItem(TECHNICAL_MODE_KEY) === 'true');
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const setTechnicalMode = useCallback((enabled: boolean) => {
    setTechnicalModeState(enabled);
    window.localStorage.setItem(TECHNICAL_MODE_KEY, String(enabled));
  }, []);

  const showAdminToast = useCallback((message: string, tone: AdminToastTone = 'success') => {
    const safeMessage = String(message || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 220);
    if (!safeMessage) return;
    const id = Date.now() + Math.floor(Math.random() * 1_000);
    setToasts(current => [...current.slice(-2), { id, message: safeMessage, tone }]);
    window.setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), 4_200);
  }, []);

  const value = useMemo(() => ({ technicalMode, setTechnicalMode, showAdminToast }), [showAdminToast, technicalMode, setTechnicalMode]);

  return (
    <CommandCenterContext.Provider value={value}>
      <div data-technical-mode={technicalMode ? 'true' : 'false'}>{children}</div>
      <div className="admin-toast-region" role="region" aria-label="Thông báo quản trị" aria-live="polite">
        {toasts.map(toast => (
          <div key={toast.id} className={`admin-toast admin-toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
            <span className="admin-toast-dot" aria-hidden="true" />
            <span>{toast.message}</span>
            <button
              type="button"
              onClick={() => setToasts(current => current.filter(item => item.id !== toast.id))}
              aria-label="Đóng thông báo"
            >×</button>
          </div>
        ))}
      </div>
    </CommandCenterContext.Provider>
  );
}

export function useCommandCenter(): CommandCenterContextValue {
  const context = useContext(CommandCenterContext);
  if (!context) throw new Error('useCommandCenter must be used within CommandCenterProvider');
  return context;
}
