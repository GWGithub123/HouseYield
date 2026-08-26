import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialogFocusTrap(
  open: boolean,
  panelRef: RefObject<HTMLElement>,
) {
  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const panel = panelRef.current;
    if (!panel) return;

    const focusInitialElement = () => {
      const autofocusTarget = panel.querySelector<HTMLElement>('[data-autofocus]');
      const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (autofocusTarget || firstFocusable || panel).focus();
    };

    const animationFrame = window.requestAnimationFrame(focusInitialElement);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => (
          !element.hasAttribute('disabled')
          && !element.hidden
          && element.getAttribute('aria-hidden') !== 'true'
        ));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [open, panelRef]);
}

export default useDialogFocusTrap;
