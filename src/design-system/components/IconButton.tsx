import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, children, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn('ds-icon-button', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export default IconButton;
