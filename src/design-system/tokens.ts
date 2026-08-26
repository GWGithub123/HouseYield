export const CHART_PALETTE = [
  '#2563eb',
  '#059669',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4f46e5',
] as const;

export function chartColor(index: number) {
  return CHART_PALETTE[Math.abs(index) % CHART_PALETTE.length];
}

export const designTokens = {
  text: {
    primary: 'var(--ds-text-primary)',
    secondary: 'var(--ds-text-secondary)',
    muted: 'var(--ds-text-muted)',
    label: 'var(--ds-text-label)',
  },
  accent: 'var(--ds-accent)',
  success: 'var(--ds-success)',
  warn: 'var(--ds-warn)',
  danger: 'var(--ds-danger)',
  info: 'var(--ds-info)',
  radius: {
    card: 'var(--ds-radius-card)',
    tile: 'var(--ds-radius-tile)',
  },
} as const;
