import { forwardRef } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../utils';

/**
 * Form controls — the single input standard. Larger touch targets and 14px+
 * text for readability. Always wrap controls in <Field> so every input has a
 * visible label.
 */

const CONTROL_BASE =
  'ds-focus-ring w-full rounded-xl border border-slate-300 bg-white px-3.5 text-sm text-slate-900 placeholder:text-slate-400 transition hover:border-slate-400 focus:border-slate-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

export interface FieldProps {
  label: ReactNode;
  /** Plain-English helper line below the control. */
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, required, htmlFor, className, children }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-semibold text-slate-700">
        {label}
        {required ? <span className="ml-0.5 text-rose-500">*</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-rose-600">{error}</p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(CONTROL_BASE, 'h-10', invalid && 'border-rose-400 focus:border-rose-500', className)}
      {...rest}
    />
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { invalid, className, rows = 4, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(CONTROL_BASE, 'py-2.5', invalid && 'border-rose-400 focus:border-rose-500', className)}
      {...rest}
    />
  );
});

export interface SelectInputProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const SelectInput = forwardRef<HTMLSelectElement, SelectInputProps>(function SelectInput(
  { invalid, className, children, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(CONTROL_BASE, 'h-10 appearance-none pr-9', invalid && 'border-rose-400 focus:border-rose-500', className)}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
      />
    </div>
  );
});

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Toggle({ checked, onChange, label, disabled, id, className }: ToggleProps) {
  return (
    <label className={cn('inline-flex cursor-pointer select-none items-center gap-2.5', disabled && 'cursor-not-allowed opacity-50', className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'ds-focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-slate-900' : 'bg-slate-300',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-0.5',
          )}
        />
      </button>
      {label ? <span className="text-sm font-medium text-slate-700">{label}</span> : null}
    </label>
  );
}
