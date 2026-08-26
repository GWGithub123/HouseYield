import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils';

/**
 * Button — the single button hierarchy platform-wide.
 *
 * - primary:     one per view; the main action (dark slate fill)
 * - secondary:   bordered white; supporting actions
 * - tertiary:    text-only; low-emphasis actions
 * - destructive: red fill; irreversible actions — always pair with confirm
 *
 * Never introduce ad-hoc colored buttons; color carries meaning, not variety.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon rendered before the label (16–20px Lucide icon). */
  icon?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-slate-900 text-white border border-transparent hover:bg-slate-800 disabled:hover:bg-slate-900',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:border-slate-400 hover:text-slate-900 disabled:hover:border-slate-300',
  tertiary: 'bg-transparent text-slate-600 border border-transparent hover:bg-slate-100 hover:text-slate-900',
  destructive: 'bg-rose-600 text-white border border-transparent hover:bg-rose-700 disabled:hover:bg-rose-600',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-[15px] gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading = false, fullWidth = false, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      className={cn(
        'ds-focus-ring inline-flex items-center justify-center rounded-xl font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        icon ?? null
      )}
      {children}
    </button>
  );
});

export default Button;
