import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastTone = 'success' | 'error' | 'info';
interface ToastItem { id: number; tone: ToastTone; text: string }
interface ToastApi { push(tone: ToastTone, text: string): void }

const ToastContext = createContext<ToastApi>({ push: () => undefined });
export const useToast = (): ToastApi => useContext(ToastContext);

const ICON = { success: CheckCircle2, error: AlertTriangle, info: Info } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback((tone: ToastTone, text: string) => {
    const id = ++seq.current;
    setItems((l) => [...l.slice(-2), { id, tone, text }]);
    window.setTimeout(() => dismiss(id), tone === 'error' ? 6000 : 3200);
  }, [dismiss]);
  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Bildirimler">
        {items.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
              <Icon size={18} aria-hidden="true" />
              <span>{t.text}</span>
              <button type="button" className="icon-btn toast-x" onClick={() => dismiss(t.id)} aria-label="Bildirimi kapat">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
