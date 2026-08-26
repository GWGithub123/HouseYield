/**
 * Single typed registry for assistant navigation aliases → routes.
 * VoiceCommandContext and VoiceAISupportLiveKit both resolve through this helper.
 */

import { isMaintenanceProduct, isOwnerRouteAllowed } from '../product/productMode';

export const ASSISTANT_PAGE_ROUTES = [
  '/dashboard',
  '/portfolio',
  '/property-management',
  '/bookkeeping',
  '/search',
  '/net-worth',
  '/market-data',
  '/renovations',
  '/sensors',
  '/saved',
  '/absentee-search',
  '/profile',
  '/room-scanner',
  '/photogrammetry-scan',
  '/flood-sensors',
  '/flood-sensors/setup',
  '/insurance-discount',
  '/insurance-discount/select-insurer',
  '/insurance-discount/generate-request',
  '/insurance-discount/certificate',
  '/insurance-discount/system-overview',
  '/tenant/dashboard',
  '/contractor/marketplace',
  '/documents',
] as const;

export type AssistantPageRoute = (typeof ASSISTANT_PAGE_ROUTES)[number];

/** Tool-facing page keys accepted by navigate_to_page. */
export const ASSISTANT_NAVIGABLE_PAGE_KEYS = [
  'dashboard',
  'portfolio',
  'properties',
  'search',
  'net-worth',
  'market-data',
  'renovations',
  'sensors',
  'profile',
  'saved',
  'room-scanner',
  'absentee-search',
  'flood-sensors',
  'insurance-discount',
  'documents',
  'property-management',
  'bookkeeping',
] as const;

export type AssistantNavigablePageKey = (typeof ASSISTANT_NAVIGABLE_PAGE_KEYS)[number];

type PageCapability = {
  route: AssistantPageRoute;
  /** Natural-language and tool aliases (lowercase, no leading slash). */
  aliases: readonly string[];
  title: string;
};

const PAGE_CAPABILITIES: readonly PageCapability[] = [
  {
    route: '/dashboard',
    title: 'Dashboard',
    aliases: ['dashboard', 'owner dashboard', 'owner-dashboard', 'command center', 'command-center', 'overview'],
  },
  {
    route: '/portfolio',
    title: 'Properties',
    aliases: ['portfolio', 'properties', 'my properties', 'portfolio management', 'my portfolio'],
  },
  {
    route: '/property-management',
    title: 'Management',
    aliases: [
      'property management',
      'property-management',
      'management',
      'property manager',
      'property operations',
      'tenant workspace',
      'tenants',
      'maintenance',
      'repairs',
      'tax center',
    ],
  },
  {
    route: '/bookkeeping',
    title: 'Bookkeeping',
    aliases: [
      'bookkeeping',
      'bookkeeping center',
      'ledger',
      'finance ledger',
      'expenses',
      'transactions',
    ],
  },
  {
    route: '/search',
    title: 'Property Search & Analysis',
    aliases: [
      'search',
      'property search',
      'find property',
      'property analysis',
      'property-analysis',
      'analyze property',
      'individual property',
      'houseyield',
    ],
  },
  {
    route: '/net-worth',
    title: 'Portfolio',
    aliases: ['net-worth', 'networth', 'net worth', 'assets', 'my net worth'],
  },
  {
    route: '/market-data',
    title: 'Market Insights',
    aliases: [
      'market',
      'market-data',
      'market data',
      'market analysis',
      'mortgage rates',
      'interest rates',
      'treasury',
      'fed meeting',
    ],
  },
  {
    route: '/renovations',
    title: 'AI Renovation Suggestions',
    aliases: ['renovations', 'renovation', 'improvements', 'remodel'],
  },
  {
    route: '/sensors',
    title: 'Predictive Maintenance',
    aliases: [
      'sensors',
      'iot',
      'smart home',
      'devices',
      'predictive maintenance',
      'predictive-maintenance',
      'home protection',
      'sensor analytics',
      'mold risk',
      'freeze risk',
    ],
  },
  {
    route: '/saved',
    title: 'Saved Properties',
    aliases: ['saved', 'saved properties', 'favorites', 'bookmarks', 'watchlist'],
  },
  {
    route: '/absentee-search',
    title: 'Off-Market Leads',
    aliases: [
      'absentee',
      'absentee-search',
      'absentee search',
      'off market',
      'off-market',
      'leads',
    ],
  },
  {
    route: '/profile',
    title: 'User Profile',
    aliases: ['profile', 'settings', 'account', 'my account'],
  },
  {
    route: '/room-scanner',
    title: '3D Room Scanner',
    aliases: ['scanner', 'room scanner', 'room-scanner', '3d scan'],
  },
  {
    route: '/photogrammetry-scan',
    title: 'Photogrammetry Scan',
    aliases: ['photogrammetry', 'photogrammetry scan', 'photogrammetry-scan', 'new scan'],
  },
  {
    route: '/flood-sensors',
    title: 'Flood Sensors',
    aliases: ['flood sensors', 'flood-sensors', 'shelly', 'water sensors', 'leak detection'],
  },
  {
    route: '/flood-sensors/setup',
    title: 'Flood Sensor Setup',
    aliases: ['flood sensor setup', 'shelly setup'],
  },
  {
    route: '/insurance-discount',
    title: 'Insurance Discount Program',
    aliases: ['insurance', 'insurance discount', 'insurance-discount', 'iot discount', 'smart home discount'],
  },
  {
    route: '/insurance-discount/select-insurer',
    title: 'Select Insurance Provider',
    aliases: ['select insurer', 'insurer selection'],
  },
  {
    route: '/insurance-discount/generate-request',
    title: 'Insurance Email Request',
    aliases: ['insurance email'],
  },
  {
    route: '/insurance-discount/certificate',
    title: 'IoT Protection Certificate',
    aliases: ['certificate', 'iot certificate'],
  },
  {
    route: '/insurance-discount/system-overview',
    title: 'System Overview',
    aliases: ['system overview'],
  },
  {
    route: '/tenant/dashboard',
    title: 'Tenant Dashboard',
    aliases: ['tenant dashboard', 'tenant/dashboard', 'tenant-dashboard', 'tenant portal', 'my rental'],
  },
  {
    route: '/contractor/marketplace',
    title: 'Contractor Marketplace',
    aliases: [
      'contractor marketplace',
      'contractor/marketplace',
      'contractor-marketplace',
      'job marketplace',
      'renovation jobs',
      'find jobs',
    ],
  },
  {
    route: '/documents',
    title: 'Documents',
    aliases: ['documents', 'document center', 'document library'],
  },
] as const;

const ALIAS_TO_ROUTE = new Map<string, AssistantPageRoute>();
const ROUTE_TO_TITLE = new Map<string, string>();

for (const capability of PAGE_CAPABILITIES) {
  ROUTE_TO_TITLE.set(capability.route, capability.title);
  for (const alias of capability.aliases) {
    ALIAS_TO_ROUTE.set(alias.toLowerCase().trim(), capability.route);
  }
  // Also accept the route path without leading slash as an alias.
  ALIAS_TO_ROUTE.set(capability.route.replace(/^\//, '').toLowerCase(), capability.route);
}

function normalizePageKey(pageName: string): string {
  return pageName.toLowerCase().trim().replace(/^\/+/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ');
}

function isAssistantRouteEnabled(route: string): boolean {
  if (!isMaintenanceProduct()) return true;
  return isOwnerRouteAllowed(route);
}

/** Resolve a natural-language or tool page name to a React Router path. */
export function resolveAssistantPageRoute(pageName: string): string | null {
  if (!pageName || typeof pageName !== 'string') return null;

  const trimmed = pageName.trim();
  if (trimmed.startsWith('/') && ROUTE_TO_TITLE.has(trimmed)) {
    return isAssistantRouteEnabled(trimmed) ? trimmed : null;
  }

  const normalized = normalizePageKey(trimmed);
  const hyphenated = normalized.replace(/\s+/g, '-');
  const spaced = normalized.replace(/-/g, ' ');

  const exact =
    ALIAS_TO_ROUTE.get(normalized)
    || ALIAS_TO_ROUTE.get(hyphenated)
    || ALIAS_TO_ROUTE.get(spaced);

  if (exact) return isAssistantRouteEnabled(exact) ? exact : null;

  // Partial alias match (e.g. "take me to flood sensors page")
  for (const [alias, route] of ALIAS_TO_ROUTE.entries()) {
    if (normalized.includes(alias) || alias.includes(normalized)) {
      return isAssistantRouteEnabled(route) ? route : null;
    }
  }

  if (trimmed.startsWith('/')) {
    return isAssistantRouteEnabled(trimmed) ? trimmed : null;
  }

  return null;
}

export function getAssistantPageTitle(pathname: string): string {
  if (pathname === '/property-management' && isMaintenanceProduct()) {
    return 'Maintenance';
  }
  return ROUTE_TO_TITLE.get(pathname) || 'Unknown Page';
}

export function getAssistantPageTitles(): Record<string, string> {
  const titles = Object.fromEntries(ROUTE_TO_TITLE.entries());
  if (isMaintenanceProduct()) {
    titles['/property-management'] = 'Maintenance';
    for (const route of Object.keys(titles)) {
      if (!isAssistantRouteEnabled(route)) {
        delete titles[route];
      }
    }
  }
  return titles;
}

const MAINTENANCE_NAVIGABLE_PAGE_KEYS = [
  'portfolio',
  'properties',
  'sensors',
  'profile',
  'flood-sensors',
  'insurance-discount',
  'property-management',
  'bookkeeping',
] as const;

export function listAssistantNavigablePageKeys(): readonly string[] {
  return isMaintenanceProduct() ? MAINTENANCE_NAVIGABLE_PAGE_KEYS : ASSISTANT_NAVIGABLE_PAGE_KEYS;
}
