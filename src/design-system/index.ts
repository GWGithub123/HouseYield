import './design-system.css';

export { chartColor, designTokens, CHART_PALETTE } from './tokens';
export { cn } from './utils';

export {
  formatCurrency,
  formatCurrencyExact,
  formatCurrencyCompact,
  formatNumber,
  formatPercent,
  formatDelta,
  formatDate,
  formatDateTime,
  formatRelativeTime,
} from './formatters';

// Layout
export { PageShell, type PageShellProps } from './components/PageShell';

// Surfaces & structure
export { Badge, type BadgeProps, type BadgeTone } from './components/Badge';
export { Card, type CardProps, type CardSurface } from './components/Card';
export { CardHeader, type CardHeaderProps } from './components/CardHeader';
export { ShowcaseSurface, type ShowcaseSurfaceProps } from './components/ShowcaseSurface';
export { SectionDivider, type SectionDividerProps } from './components/SectionDivider';
export { SectionHeader, type SectionHeaderProps } from './components/SectionHeader';
export {
  SectionGroupHeader,
  type SectionGroupHeaderProps,
  type SectionGroupAccent,
} from './components/SectionGroupHeader';
export { SubTabs, type SubTabsProps, type SubTabDef, type SubTabAccent } from './components/SubTabs';
export { TileGrid, type TileGridProps } from './components/TileGrid';

// Metrics
export { KpiStrip, type KpiStripProps, type KpiStripItem, type KpiStripTone } from './components/KpiStrip';
export { Stat, type StatProps } from './components/Stat';
export {
  KpiTile,
  type KpiTileProps,
  type KpiTileSurface,
  type KpiTileDelta,
  type KpiDeltaDirection,
} from './components/KpiTile';

// Actions & inputs
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './components/Button';
export { ExpandIcon, type ExpandIconProps } from './components/ExpandIcon';
export { IconButton, type IconButtonProps } from './components/IconButton';
export {
  Field,
  TextInput,
  TextArea,
  SelectInput,
  Toggle,
  type FieldProps,
  type TextInputProps,
  type TextAreaProps,
  type SelectInputProps,
  type ToggleProps,
} from './components/FormControls';

// Overlays & feedback
export { Modal, type ModalProps, type ModalSize } from './components/Modal';
export { Drawer, type DrawerProps, type DrawerWidth } from './components/Drawer';
export { ToastProvider, useToast, type ToastOptions, type ToastTone } from './components/Toast';
export { Skeleton, SkeletonCard, SkeletonKpiStrip, type SkeletonProps } from './components/Skeleton';
export { GlossaryTip, type GlossaryTipProps } from './components/GlossaryTip';

export { default as DesignSystemShowcase } from './showcase/DesignSystemShowcase';
