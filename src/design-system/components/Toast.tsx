import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, Info, X, XCircle } from 'lucide-react';
import { cn } from '../utils';

/**
 * Toast — the single transient-feedback standard, with first-class undo
 * support for destructive actions.
 *
 *   const toast = useToast();
 *   toast({ tone: 'success', title: 'Tenant added' });
 *   toast({ title: 'Sensor deleted', action: { label: 'Undo', onClick: restore } });
 */
export type ToastTone = 'neutral' | 'success' | 'warn' | 'danger';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** Action button (e.g. Undo). Clicking it dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss delay in ms. Defaults to 5000; pass 0 to persist. */
  duration?: number;
}

interface ToastRecord extends ToastOptions {
  id: number;
}

type ToastFn = (options: ToastOptions) => void;

const ToastContext = createContext<ToastFn | null>(null);

const TONE_ICON: Record<ToastTone, ReactNode> = {
  neutral: <Info size={17} className="text-slate-400" />,
  success: <CheckCircle2 size={17} className="text-emerald-500" />,
  warn: <AlertTriangle size={17} className="text-amber-500" />,
  danger: <XCircle size={17} className="text-rose-500" />,
};

export function useToast(): ToastFn {
  const fn = useContext(ToastContext);
  if (!fn) {
    throw new Error('useToast must be used within <ToastProvider>');
  }
  return fn;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback<ToastFn>((options) => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-3), { ...options, id }]);
    const duration = options.duration ?? 5000;
    if (duration > 0) {
      window.setTimeout(() => dismiss(id), duration);
    }
  }, [dismiss]);

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0
        ? createPortal(
            <div className="pointer-events-none fixed bottom-5 right-5 z-[110] flex w-full max-w-sm flex-col gap-2">
              {toasts.map((record) => (
                <div
                  key={record.id}
                  role="status"
                  className="pointer-events-auto flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-[0_12px_32px_rgba(15,23,42,0.16)]"
                >
                  <span className="mt-0.5 shrink-0">{TONE_ICON[record.tone ?? 'neutral']}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-slate-900">{record.title}</div>
                    {record.description ? (
                      <div className="mt-0.5 text-xs leading-relaxed text-slate-500">{record.description}</div>
                    ) : null}
                  </div>
                  {record.action ? (
                    <button
                      type="button"
                      onClick={() => {
                        record.action?.onClick();
                        dismiss(record.id);
                      }}
                      className={cn(
                        'ds-focus-ring shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900',
                      )}
                    >
                      {record.action.label}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => dismiss(record.id)}
                    className="ds-focus-ring -mr-1 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}
