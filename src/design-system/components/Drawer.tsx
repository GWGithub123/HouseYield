import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../utils';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';

/**
 * Drawer — right-side detail panel for row/record detail views (the standard
 * alternative to giant expandable rows and full modals).
 */
export type DrawerWidth = 'sm' | 'md' | 'lg';

const WIDTHS: Record<DrawerWidth, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
};

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  width?: DrawerWidth;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  width = 'md',
  footer,
  children,
  className,
  bodyClassName,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  useDialogFocusTrap(open, panelRef);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div aria-hidden className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        className={cn(
          'absolute bottom-0 right-0 top-0 flex w-full flex-col border-l border-slate-200 bg-white shadow-[-24px_0_60px_rgba(15,23,42,0.18)] outline-none',
          WIDTHS[width],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            {title ? <h2 id={titleId} className="text-base font-semibold tracking-tight text-slate-900">{title}</h2> : null}
            {subtitle ? <p id={subtitleId} className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="ds-focus-ring -mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export default Drawer;
