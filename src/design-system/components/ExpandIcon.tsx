import { cn } from '../utils';

export interface ExpandIconProps {
  className?: string;
}

export function ExpandIcon({ className }: ExpandIconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('h-4 w-4 text-slate-500', className)}
      aria-hidden
    >
      <path
        d="M7 4h9v9M16 4 4 16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default ExpandIcon;
