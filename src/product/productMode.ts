/**
 * Product packaging for the full property-management system vs the slim
 * Maintenance Orchestration experience. Full PMS code stays in the repo;
 * this module only controls what the active product surface exposes.
 */

export type ProductMode = 'full' | 'maintenance';

export type SidebarNavItemId =
  | 'dashboard'
  | 'market-insights'
  | 'properties'
  | 'management'
  | 'bookkeeping'
  | 'predictive-maintenance';

export type PropertyWorkspaceTabId =
  | 'overview'
  | 'analytics'
  | 'rentalPricingPower'
  /**
   * Retired from the tab lists below — flood, surge and drainage now live on the
   * Predictive Maintenance twin. The member stays so the dormant panel in
   * PortfolioPage still typechecks and can be brought back by re-adding it to the
   * arrays, without reviving ~4k lines of map code in the meantime.
   */
  | 'environmentalRisk'
  | 'propertyHealth';

export type ManagementTabId =
  | 'documents'
  | 'tenants'
  | 'maintenance'
  | 'tax';

const FULL_SIDEBAR_NAV: readonly SidebarNavItemId[] = [
  'dashboard',
  'market-insights',
  'properties',
  'management',
  'bookkeeping',
  'predictive-maintenance',
] as const;

const MAINTENANCE_SIDEBAR_NAV: readonly SidebarNavItemId[] = [
  'properties',
  'management',
  'bookkeeping',
  'predictive-maintenance',
] as const;

const FULL_PROPERTY_WORKSPACE_TABS: readonly PropertyWorkspaceTabId[] = [
  'overview',
  'analytics',
  'rentalPricingPower',
  'propertyHealth',
] as const;

const MAINTENANCE_PROPERTY_WORKSPACE_TABS: readonly PropertyWorkspaceTabId[] = [
  'overview',
  'analytics',
  'propertyHealth',
] as const;

const FULL_MANAGEMENT_TABS: readonly ManagementTabId[] = [
  'documents',
  'tenants',
  'maintenance',
  'tax',
] as const;

const MAINTENANCE_MANAGEMENT_TABS: readonly ManagementTabId[] = [
  'maintenance',
] as const;

/** Owner routes that exist in the full PMS but are not part of Maintenance Orchestration. */
export const MAINTENANCE_HIDDEN_OWNER_ROUTES = [
  '/dashboard',
  '/documents',
  '/market-data',
  '/search',
  '/search-legacy',
  '/net-worth',
  '/income-projections',
  '/financial-independence',
  '/renovations',
  '/absentee-search',
  '/saved',
] as const;

function normalizeProductMode(value: unknown): ProductMode {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'maintenance' ? 'maintenance' : 'full';
}

export function getProductMode(): ProductMode {
  return normalizeProductMode(import.meta.env.VITE_PRODUCT_MODE);
}

export function isMaintenanceProduct(): boolean {
  return getProductMode() === 'maintenance';
}

export function isFullPmsProduct(): boolean {
  return getProductMode() === 'full';
}

export function getSidebarNavItems(): readonly SidebarNavItemId[] {
  return isMaintenanceProduct() ? MAINTENANCE_SIDEBAR_NAV : FULL_SIDEBAR_NAV;
}

export function isSidebarNavItemEnabled(id: SidebarNavItemId): boolean {
  return getSidebarNavItems().includes(id);
}

export function getManagementNavLabel(): string {
  return isMaintenanceProduct() ? 'Maintenance' : 'Management';
}

export function getPropertyWorkspaceTabs(): readonly PropertyWorkspaceTabId[] {
  return isMaintenanceProduct()
    ? MAINTENANCE_PROPERTY_WORKSPACE_TABS
    : FULL_PROPERTY_WORKSPACE_TABS;
}

export function isPropertyWorkspaceTabEnabled(id: PropertyWorkspaceTabId): boolean {
  return getPropertyWorkspaceTabs().includes(id);
}

export function normalizePropertyWorkspaceTab(
  value: string | null | undefined,
  fallback: PropertyWorkspaceTabId = 'overview',
): PropertyWorkspaceTabId {
  const candidate = String(value || '').trim();
  const mapped = candidate === 'rentalpricingpower'
    ? 'rentalPricingPower'
    : candidate === 'environmentalrisk'
      ? 'environmentalRisk'
      : candidate === 'propertyhealth' || candidate === 'property_health' || candidate === 'health'
        ? 'propertyHealth'
        : candidate;
  if (isPropertyWorkspaceTabEnabled(mapped as PropertyWorkspaceTabId)) {
    return mapped as PropertyWorkspaceTabId;
  }
  return fallback;
}

export function getManagementTabs(): readonly ManagementTabId[] {
  return isMaintenanceProduct() ? MAINTENANCE_MANAGEMENT_TABS : FULL_MANAGEMENT_TABS;
}

export function isManagementTabEnabled(id: ManagementTabId): boolean {
  return getManagementTabs().includes(id);
}

export function getDefaultManagementTab(): ManagementTabId {
  return getManagementTabs()[0] || 'maintenance';
}

/** Post-login / fallback home for the active product surface. */
export function getDefaultOwnerHomePath(): string {
  return isMaintenanceProduct() ? '/portfolio' : '/dashboard';
}

export function normalizeManagementTab(
  value: string | null | undefined,
  fallback?: ManagementTabId,
): ManagementTabId | null {
  const resolvedFallback =
    fallback && isManagementTabEnabled(fallback) ? fallback : getDefaultManagementTab();
  // Bookkeeping is a top-level sidebar page now — old ?tab=bookkeeping links should redirect.
  if (value === 'bookkeeping') {
    return null;
  }
  if (value === 'tax-center') {
    return isManagementTabEnabled('tax') ? 'tax' : resolvedFallback;
  }
  if (!value) return null;
  if (isManagementTabEnabled(value as ManagementTabId)) {
    return value as ManagementTabId;
  }
  if (['tenants', 'tax', 'documents', 'maintenance'].includes(value)) {
    return resolvedFallback;
  }
  return null;
}

export function isOwnerRouteAllowed(pathname: string): boolean {
  if (!isMaintenanceProduct()) return true;
  const path = String(pathname || '').split('?')[0];
  return !MAINTENANCE_HIDDEN_OWNER_ROUTES.some(
    (hidden) => path === hidden || path.startsWith(`${hidden}/`),
  );
}
