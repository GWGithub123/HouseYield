import React from 'react';

export const SIDEBAR_GLASS_BACKGROUND = 'linear-gradient(180deg, rgba(50, 90, 160, 0.7) 0%, rgba(30, 60, 110, 0.85) 100%)';
export const SIDEBAR_GLASS_BUTTON_CLASS = 'rounded-lg border border-white/15 bg-[#1a3a5c]/50 text-white/85 transition-colors backdrop-blur-sm hover:bg-[#2a5080]/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40';

type SidebarLiquidGlassShellProps = {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  roundedClassName?: string;
};

export default function SidebarLiquidGlassShell({
  children,
  className = '',
  contentClassName = '',
  roundedClassName = 'rounded-2xl',
}: SidebarLiquidGlassShellProps) {
  return (
    <div
      className={`relative overflow-hidden ${roundedClassName} ${className}`}
      style={{
        backgroundColor: '#0d1f33',
        backgroundImage: SIDEBAR_GLASS_BACKGROUND,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 ${roundedClassName}`}
        style={{
          background: 'linear-gradient(135deg, rgba(130, 200, 255, 0.5) 0%, rgba(90, 160, 240, 0.3) 25%, rgba(60, 130, 210, 0.15) 50%, rgba(90, 160, 240, 0.3) 75%, rgba(130, 200, 255, 0.4) 100%)',
          padding: '1.5px',
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          maskComposite: 'exclude',
          WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          WebkitMaskComposite: 'xor',
        }}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-[1px] ${roundedClassName}`}
        style={{
          boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.2), inset 0 -1px 1px rgba(0,0,0,0.15)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-4 right-4 top-0 h-[1px]"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(160, 210, 255, 0.6) 20%, rgba(200, 230, 255, 0.7) 50%, rgba(160, 210, 255, 0.6) 80%, transparent)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-4 left-0 top-4 w-[1px]"
        style={{
          background: 'linear-gradient(180deg, transparent, rgba(130, 190, 255, 0.5) 20%, rgba(110, 170, 250, 0.4) 50%, rgba(130, 190, 255, 0.5) 80%, transparent)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-4 right-0 top-4 w-[1px]"
        style={{
          background: 'linear-gradient(180deg, transparent, rgba(130, 190, 255, 0.4) 20%, rgba(110, 170, 250, 0.3) 50%, rgba(130, 190, 255, 0.4) 80%, transparent)',
        }}
      />
      <div className={`relative ${contentClassName}`}>{children}</div>
    </div>
  );
}