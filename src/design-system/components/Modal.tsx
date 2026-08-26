import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../utils';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';

/**
 * Modal — the single overlay standard.
 *
 * Escape closes, overlay click closes (unless dismissible={false}), body
 * scroll locks while open, focus moves into the dialog. Header carries the
 * title + close button; content scrolls inside the panel.
 */
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

const SIZES: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  full: 'max-w-[calc(100vw-4rem)]',
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  size?: ModalSize;
  /** Footer action row (Buttons). Rendered with a top hairline. */
  footer?: ReactNode;
  /** Set false to require an explicit action (no overlay/escape close). */
  dismissible?: boolean;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  footer,
  dismissible = true,
  children,
  className,
  bodyClassName,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  useDialogFocusTrap(open, panelRef);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, dismissible, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-8"
      role="presentation"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div aria-hidden className="absolute inset-0 bg-slate-900/45 backdrop-blur-[2px]" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.25)] outline-none',
          SIZES[size],
          className,
        )}
      >
        {(title || dismissible) && (
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
            <div className="min-w-0">
              {title ? <h2 id={titleId} className="text-lg font-semibold tracking-tight text-slate-900">{title}</h2> : null}
              {subtitle ? <p id={subtitleId} className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
            </div>
            {dismissible ? (
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="ds-focus-ring -mr-1 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                <X size={18} />
              </button>
            ) : null}
          </div>
        )}
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-5', bodyClassName)}>{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-6 py-4">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export default Modal;
