/**
 * COMPREHENSIVE VOICE AI SITE MAP
 * This file defines the complete structure of the website for voice AI control.
 * The AI uses this map to navigate, click elements, and understand the site hierarchy.
 */

import { getManagementNavLabel, isMaintenanceProduct, isOwnerRouteAllowed } from '../product/productMode';

// ============================================================================
// PAGES - All routes in the application
// ============================================================================
type VoicePageDefinition = {
  path: string;
  title: string;
  description: string;
  aliases: string[];
  elements: string[];
  tabs?: Record<string, { voiceId: string; description: string }>;
};

export const PAGES = {
  // Main Landlord/Owner Pages
  'dashboard': {
    path: '/dashboard',
    title: 'Dashboard',
    description: 'Owner command center with a fluid portfolio pulse, leasing tempo, and risk signals',
    aliases: ['dashboard', 'owner dashboard', 'command center', 'overview'],
    elements: [],
  },
  'search': {
    path: '/search',
    title: 'Property Search',
    description: 'Search and analyze any property address for investment analysis',
    aliases: ['property search', 'find property', 'analyze property', 'property analysis', 'search properties'],
    elements: ['property-search-box', 'analyze-button', 'advanced-analysis-btn', 'map-container', 'search-results', 'street-view-btn'],
  },
  'portfolio': {
    path: '/portfolio',
    title: 'Properties',
    description: 'Manage your properties, tenants, maintenance requests, and leases',
    aliases: ['properties', 'my properties', 'manage properties', 'portfolio management'],
    tabs: {
      'personal': { voiceId: 'filter-personal-btn', description: 'Personal/primary residence properties' },
      'investment': { voiceId: 'filter-investment-btn', description: 'Investment/rental properties' },
      'combined': { voiceId: 'filter-combined-btn', description: 'All properties combined' },
    },
    elements: ['add-property-btn', 'add-tenant-btn', 'tenant-section', 'maintenance-section', 'property-list', 'export-tenants-btn', 'screen-applicant-btn', 'create-listing-btn', 'collect-payment-btn'],
  },
  'property-management': {
    path: '/property-management',
    title: 'Management',
    description: 'Management workspace with documents, tenants, maintenance, and tax controls',
    aliases: ['management', 'property management', 'property operations', 'tenant workspace', 'maintenance workspace', 'tax center', 'documents workspace'],
    tabs: {
      'documents': { voiceId: 'property-management-documents-tab', description: 'Leases, records, uploads, and documents' },
      'tenants': { voiceId: 'property-management-tenants-tab', description: 'Tenant onboarding, screening, payments, and listing workflows' },
      'maintenance': { voiceId: 'property-management-maintenance-tab', description: 'Maintenance requests, providers, and call workflows' },
      'tax': { voiceId: 'property-management-tax-tab', description: 'Tax planning and filing workspace' },
    },
    elements: ['property-management-property-select', 'property-management-tabs', 'property-management-finance-snapshot', 'property-management-tenants-panel', 'property-management-screening', 'property-management-payments', 'property-management-discovery', 'property-management-maintenance-panel', 'property-management-add-tenant-btn', 'property-management-screen-applicant-btn', 'property-management-send-payment-request-btn', 'property-management-create-listing-btn'],
  },
  'bookkeeping': {
    path: '/bookkeeping',
    title: 'Bookkeeping',
    description: 'Bookkeeping, ledger, reconciliation, and finance reports',
    aliases: ['bookkeeping', 'bookkeeping center', 'ledger', 'finance ledger', 'expenses', 'transactions'],
    elements: ['bookkeeping-property-select', 'bookkeeping-page', 'nav-bookkeeping'],
  },
  'renovations': {
    path: '/renovations',
    title: 'Suggested Renovations',
    description: 'AI-suggested renovations with ROI calculations for your properties',
    aliases: ['renovations', 'improvements', 'remodel', 'upgrades', 'renovation suggestions'],
    elements: ['renovation-suggestions', 'renovation-planner-btn', 'renovation-list', 'renovation-roi', 'rerun-analysis-btn', 'export-renovations-btn'],
  },
  'market-data': {
    path: '/market-data',
    title: 'Live Market Data',
    description: 'Real-time mortgage rates, treasury yields, and Fed meeting summaries',
    aliases: ['market data', 'mortgage rates', 'interest rates', 'housing market', 'fed meeting', 'treasury yields'],
    elements: ['mortgage-rate-detail', 'treasury-yields', 'fed-meeting-summary', 'market-overview'],
  },
  'saved': {
    path: '/saved',
    title: 'Saved Properties',
    description: 'Properties you have saved for future reference',
    aliases: ['saved properties', 'favorites', 'bookmarks', 'saved'],
    elements: ['saved-properties-list'],
  },
  'documents': {
    path: '/documents',
    title: 'Document Center',
    description: 'Manage leases, agreements, and e-signatures for your properties',
    aliases: ['documents', 'leases', 'agreements', 'contracts', 'e-sign', 'signatures', 'document center'],
    elements: ['create-document-btn', 'create-lease-btn', 'document-list', 'signature-requests'],
  },
  'lease-builder': {
    path: '/lease-builder',
    title: 'AI Lease Builder',
    description: 'Create professional lease agreements with AI customization',
    aliases: ['lease builder', 'create lease', 'new lease', 'rental agreement', 'lease agreement'],
    elements: ['generate-lease-btn', 'edit-lease-btn', 'copy-lease-btn', 'download-lease-btn'],
  },
  'absentee-search': {
    path: '/absentee-search',
    title: 'Off-Market Leads',
    description: 'Find absentee owners and off-market property leads',
    aliases: ['absentee', 'off market', 'leads', 'absentee owners', 'off-market leads'],
    elements: ['search-absentee-btn', 'save-leads-btn', 'export-leads-btn'],
  },
  'sensors': {
    path: '/sensors',
    title: 'Predictive Maintenance',
    description: 'Predictive maintenance dashboard for sensor health, alerts, and upkeep planning',
    aliases: ['predictive maintenance', 'sensors', 'iot', 'smart home', 'home protection', 'monitoring'],
    elements: ['sensor-dashboard', 'add-sensor-btn', 'sensor-readings'],
  },
  'flood-sensors': {
    path: '/flood-sensors',
    title: 'Flood Sensors',
    description: 'Shelly flood sensor management',
    aliases: ['flood sensors', 'water sensors', 'leak detection', 'shelly'],
    elements: [],
  },
  'flood-sensors-setup': {
    path: '/flood-sensors/setup',
    title: 'Flood Sensor Setup',
    description: 'Set up and configure Shelly flood sensors',
    aliases: ['flood sensor setup', 'shelly setup', 'add flood sensor'],
    elements: [],
  },
  'insurance-discount': {
    path: '/insurance-discount',
    title: 'IoT Insurance Discount',
    description: 'Get insurance discounts for your smart home devices',
    aliases: ['insurance discount', 'iot discount', 'smart home discount'],
    elements: [],
  },
  'insurance-select-insurer': {
    path: '/insurance-discount/select-insurer',
    title: 'Select Insurer',
    description: 'Choose your insurance provider for discount',
    aliases: ['select insurer', 'choose insurance'],
    elements: [],
  },
  'insurance-certificate': {
    path: '/insurance-discount/certificate',
    title: 'Protection Certificate',
    description: 'Download your IoT protection certificate',
    aliases: ['protection certificate', 'iot certificate', 'download certificate'],
    elements: ['download-certificate-btn', 'send-email-btn'],
  },
  'room-scanner': {
    path: '/room-scanner',
    title: '3D Room Scanner',
    description: 'Scan rooms to create 3D models',
    aliases: ['room scanner', '3d scan', 'scan room', '3d model'],
    elements: [],
  },
  'photogrammetry-scan': {
    path: '/photogrammetry-scan',
    title: 'Photogrammetry Scanner',
    description: 'Professional photogrammetry 3D scanning',
    aliases: ['photogrammetry', 'professional scan', '3d photogrammetry'],
    elements: [],
  },
  'profile': {
    path: '/profile',
    title: 'Profile Settings',
    description: 'Your account settings and preferences',
    aliases: ['profile', 'settings', 'account', 'preferences'],
    elements: [],
  },

  // Tenant Pages
  'tenant-dashboard': {
    path: '/tenant/dashboard',
    title: 'Tenant Dashboard',
    description: 'Tenant portal for rent payments and maintenance requests',
    aliases: ['tenant dashboard', 'my rental', 'tenant portal'],
    elements: ['pay-rent-btn', 'submit-maintenance-btn', 'logout-btn'],
  },

  // Contractor Pages
  'contractor-marketplace': {
    path: '/contractor/marketplace',
    title: 'Contractor Marketplace',
    description: 'Browse and bid on renovation jobs',
    aliases: ['contractor marketplace', 'job marketplace', 'renovation jobs', 'find work'],
    elements: ['view-3d-btn', 'place-bid-btn', 'submit-bid-btn', 'contractor-logout-btn'],
  },
  'contractor-payments': {
    path: '/contractor/payments',
    title: 'Contractor Payments',
    description: 'Connect payout accounts and review maintenance payment receipts',
    aliases: ['contractor payments', 'payouts', 'maintenance receipts', 'payment receipts'],
    elements: ['contractor-logout-btn'],
  },
} satisfies Record<string, VoicePageDefinition>;

// ============================================================================
// UI ELEMENTS - All clickable/interactive elements with voice IDs
// ============================================================================
export const UI_ELEMENTS = {
  // Navigation
  'sidebar': { type: 'navigation', description: 'Main sidebar navigation' },
  'main-nav': { type: 'navigation', description: 'Navigation menu links' },
  'nav-dashboard': { type: 'nav-link', page: '/dashboard', description: 'Dashboard navigation link' },
  'nav-search': { type: 'nav-link', page: '/search', description: 'Property Search navigation link' },
  'nav-portfolio': { type: 'nav-link', page: '/portfolio', description: 'Properties navigation link' },
  'nav-property-management': { type: 'nav-link', page: '/property-management', description: 'Management navigation link' },
  'nav-renovations': { type: 'nav-link', page: '/renovations', description: 'Suggested Renovations navigation link' },

  'nav-saved': { type: 'nav-link', page: '/saved', description: 'Saved Properties navigation link' },
  'nav-absentee': { type: 'nav-link', page: '/absentee-search', description: 'Off-Market Leads navigation link' },
  'nav-market-data': { type: 'nav-link', page: '/market-data', description: 'Market Data navigation link' },
  'nav-sensors': { type: 'nav-link', page: '/sensors', description: 'Predictive Maintenance navigation link' },
  'nav-bookkeeping': { type: 'nav-link', page: '/bookkeeping', description: 'Bookkeeping navigation link' },

  // Bookkeeping Page
  'bookkeeping-property-select': { type: 'input', page: '/bookkeeping', description: 'Choose the active property scope for bookkeeping' },
  'bookkeeping-page': { type: 'section', page: '/bookkeeping', description: 'Bookkeeping workspace root' },

  // Property Management Page
  'property-management-property-select': { type: 'input', page: '/property-management', description: 'Choose the active property scope' },
  'property-management-tabs': { type: 'section', page: '/property-management', description: 'Workspace tabs for documents, tenants, maintenance, and tax' },
  'property-management-documents-tab': { type: 'tab', page: '/property-management', description: 'Documents workspace tab' },
  'property-management-tenants-tab': { type: 'tab', page: '/property-management', description: 'Tenants workspace tab' },
  'property-management-maintenance-tab': { type: 'tab', page: '/property-management', description: 'Maintenance workspace tab' },
  'property-management-bookkeeping-tab': { type: 'nav-link', page: '/bookkeeping', description: 'Bookkeeping sidebar page (legacy voice id)' },
  'property-management-tax-tab': { type: 'tab', page: '/property-management', description: 'Tax workspace tab' },
  'property-management-finance-snapshot': { type: 'section', page: '/property-management', description: 'Finance snapshot for the active property scope' },
  'property-management-tenants-panel': { type: 'section', page: '/property-management', description: 'Tenant management workspace' },
  'property-management-add-tenant-btn': { type: 'button', page: '/property-management', description: 'Open tenant onboarding' },
  'property-management-screening': { type: 'section', page: '/property-management', description: 'Tenant screening workspace' },
  'property-management-screen-applicant-btn': { type: 'button', page: '/property-management', description: 'Open the screening form for a new applicant' },
  'property-management-payments': { type: 'section', page: '/property-management', description: 'Payments workspace' },
  'property-management-send-payment-request-btn': { type: 'button', page: '/property-management', description: 'Open the payment request dialog' },
  'property-management-discovery': { type: 'section', page: '/property-management', description: 'Tenant discovery workspace' },
  'property-management-create-listing-btn': { type: 'button', page: '/property-management', description: 'Open the vacancy listing form' },
  'property-management-maintenance-panel': { type: 'section', page: '/property-management', description: 'Maintenance workspace' },
  'property-management-maintenance-log': { type: 'section', page: '/property-management', description: 'Maintenance request log' },
  'property-management-trusted-providers': { type: 'section', page: '/property-management', description: 'Trusted providers section' },

  // Net Worth Page - Tabs


  // Portfolio Page - Tabs/Filters
  'filter-personal-btn': { type: 'tab', page: '/portfolio', description: 'Filter to show personal/primary residence properties' },
  'filter-investment-btn': { type: 'tab', page: '/portfolio', description: 'Filter to show investment/rental properties' },
  'filter-combined-btn': { type: 'tab', page: '/portfolio', description: 'Show all properties combined' },
  'add-property-btn': { type: 'button', page: '/portfolio', description: 'Add a new property to portfolio' },
  'add-tenant-btn': { type: 'button', page: '/portfolio', description: 'Add a new tenant' },
  'tenant-section': { type: 'section', page: '/portfolio', description: 'Tenant management section' },
  'maintenance-section': { type: 'section', page: '/portfolio', description: 'Maintenance requests section' },
  'property-list': { type: 'list', page: '/portfolio', description: 'List of properties' },
  'export-tenants-btn': { type: 'button', page: '/portfolio', description: 'Export tenant data' },
  'screen-applicant-btn': { type: 'button', page: '/portfolio', description: 'Run credit/background check on applicant' },
  'create-listing-btn': { type: 'button', page: '/portfolio', description: 'Create a rental listing' },
  'collect-payment-btn': { type: 'button', page: '/portfolio', description: 'Send payment request to tenant' },

  // Search Page
  'property-search-box': { type: 'input', page: '/search', description: 'Property address search input' },
  'analyze-button': { type: 'button', page: '/search', description: 'Analyze the property' },
  'advanced-analysis-btn': { type: 'button', page: '/search', description: 'Run advanced/comprehensive analysis' },
  'map-container': { type: 'display', page: '/search', description: 'Property location map' },
  'search-results': { type: 'section', page: '/search', description: 'Search results section' },
  'street-view-btn': { type: 'button', page: '/search', description: 'Open Google Street View' },
  'analyze-ai-btn': { type: 'button', page: '/search', description: 'Analyze with AI overlay' },
  'save-property-btn': { type: 'button', page: '/search', description: 'Save property to favorites' },

  // Market Data Page
  'mortgage-rate-detail': { type: 'display', page: '/market-data', description: 'Current mortgage rate details' },
  'treasury-yields': { type: 'display', page: '/market-data', description: 'Treasury yield information' },
  'fed-meeting-summary': { type: 'display', page: '/market-data', description: 'Federal Reserve meeting summary' },
  'market-overview': { type: 'section', page: '/market-data', description: 'Housing market overview' },

  // Renovations Page
  'renovation-suggestions': { type: 'section', page: '/renovations', description: 'AI-suggested renovations' },
  'renovation-planner-btn': { type: 'button', page: '/renovations', description: 'Open 3D renovation planner' },
  'renovation-list': { type: 'list', page: '/renovations', description: 'List of renovation suggestions' },
  'renovation-roi': { type: 'display', page: '/renovations', description: 'Return on investment calculations' },
  'rerun-analysis-btn': { type: 'button', page: '/renovations', description: 'Re-run renovation analysis' },
  'export-renovations-btn': { type: 'button', page: '/renovations', description: 'Export renovation report' },

  // Absentee Search Page
  'search-absentee-btn': { type: 'button', page: '/absentee-search', description: 'Search for absentee owners' },
  'save-leads-btn': { type: 'button', page: '/absentee-search', description: 'Save leads to database' },
  'export-leads-btn': { type: 'button', page: '/absentee-search', description: 'Export leads as CSV' },

  // Sensor Pages
  'sensor-dashboard': { type: 'section', page: '/sensors', description: 'IoT sensor dashboard' },
  'add-sensor-btn': { type: 'button', page: '/sensors', description: 'Add a new sensor' },
  'sensor-readings': { type: 'display', page: '/sensors', description: 'Current sensor readings' },

  // Insurance Pages
  'download-certificate-btn': { type: 'button', page: '/insurance-discount/certificate', description: 'Download IoT protection certificate' },
  'send-email-btn': { type: 'button', page: '/insurance-discount/certificate', description: 'Send certificate to insurance company' },

  // Tenant Dashboard
  'pay-rent-btn': { type: 'button', page: '/tenant/dashboard', description: 'Pay rent online' },
  'submit-maintenance-btn': { type: 'button', page: '/tenant/dashboard', description: 'Submit maintenance request' },
  'logout-btn': { type: 'button', description: 'Log out of the application' },

  // Contractor Marketplace
  'view-3d-btn': { type: 'button', page: '/contractor/marketplace', description: 'View 3D scan of the property' },
  'place-bid-btn': { type: 'button', page: '/contractor/marketplace', description: 'Place a bid on a job' },
  'submit-bid-btn': { type: 'button', page: '/contractor/marketplace', description: 'Submit bid form' },
  'contractor-logout-btn': { type: 'button', page: '/contractor/marketplace', description: 'Contractor logout' },

  // Lease Builder
  'generate-lease-btn': { type: 'button', description: 'Generate AI lease agreement' },
  'edit-lease-btn': { type: 'button', description: 'Edit generated lease' },
  'copy-lease-btn': { type: 'button', description: 'Copy lease to clipboard' },
  'download-lease-btn': { type: 'button', description: 'Download lease document' },
} as const;

// ============================================================================
// ACTIONS - Complex actions that may require navigation + clicks
// ============================================================================
export const VOICE_ACTIONS = {
  // Portfolio Actions
  'show-personal-properties': {
    description: 'Show personal/primary residence properties',
    steps: [
      { type: 'navigate', target: '/portfolio' },
      { type: 'click', target: 'filter-personal-btn' },
    ],
  },
  'show-investment-properties': {
    description: 'Show investment/rental properties',
    steps: [
      { type: 'navigate', target: '/portfolio' },
      { type: 'click', target: 'filter-investment-btn' },
    ],
  },
  'show-all-properties': {
    description: 'Show all properties',
    steps: [
      { type: 'navigate', target: '/portfolio' },
      { type: 'click', target: 'filter-combined-btn' },
    ],
  },
  'add-property': {
    description: 'Add a new property',
    steps: [
      { type: 'navigate', target: '/portfolio' },
      { type: 'click', target: 'add-property-btn' },
    ],
  },
  'add-tenant': {
    description: 'Add a new tenant',
    steps: [
      { type: 'navigate', target: '/portfolio' },
      { type: 'click', target: 'add-tenant-btn' },
    ],
  },

  // Search Actions
  'search-property': {
    description: 'Search for a property',
    steps: [
      { type: 'navigate', target: '/search' },
      { type: 'focus', target: 'property-search-box' },
    ],
  },
} as const;

// ============================================================================
// GENERATE SYSTEM PROMPT - Creates a comprehensive prompt for the AI
// ============================================================================
export function generateVoiceSystemPrompt(): string {
  const pageEntries = Object.entries(getVoicePages()) as Array<[string, VoicePageDefinition]>;

  const pageDescriptions = pageEntries
    .map(([key, page]) => `- **${page.title}** (${page.path}): ${page.description}. Aliases: ${page.aliases.join(', ')}`)
    .join('\n');

  const tabDescriptions = pageEntries
    .filter(([_, page]) => Boolean(page.tabs))
    .map(([key, page]) => {
      const tabs = Object.entries(page.tabs ?? {})
        .map(([tabKey, tab]) => `  - "${tabKey}" tab (${tab.voiceId}): ${tab.description}`)
        .join('\n');
      return `**${page.title}** tabs:\n${tabs}`;
    })
    .join('\n\n');

  const productLabel = isMaintenanceProduct()
    ? 'maintenance orchestration platform for property upkeep and predictive maintenance'
    : 'real estate property management platform';

  return `You are a voice assistant for a ${productLabel}. You can navigate anywhere on the website and control any functionality.

## AVAILABLE PAGES:
${pageDescriptions}

## PAGE TABS/SECTIONS:
${tabDescriptions}

## VOICE COMMANDS:
When the user asks to go somewhere or do something, respond with the appropriate command in your response. The system will detect and execute these commands automatically.

### To navigate to a page:
Just acknowledge and the navigation will happen. Example: "Taking you to the Net Worth page now."

### To switch tabs or click buttons:
Acknowledge the action. Example: "Switching to the Allocation view" or "Opening the Add Property form"

### To show/view something:
If showing personal properties: navigate to /portfolio AND click filter-personal-btn
If showing investment properties: navigate to /portfolio AND click filter-investment-btn

## IMPORTANT RULES:
1. When user asks to "show" or "see" something, you must both navigate AND activate the correct tab/filter
2. Always confirm what you're doing: "Switching to the investment properties view now" 
3. If user asks about their properties, take them to /portfolio
4. ${isMaintenanceProduct()
    ? 'If user asks about sensors or predictive maintenance, take them to /sensors'
    : 'If user asks about market rates, take them to /market-data'}`;
}

export type PageKey = keyof typeof PAGES;
export type ElementKey = keyof typeof UI_ELEMENTS;
export type ActionKey = keyof typeof VOICE_ACTIONS;

/** Product-aware page map for the active surface (full PMS vs Maintenance Orchestration). */
export function getVoicePages(): Record<string, VoicePageDefinition> {
  const pages: Record<string, VoicePageDefinition> = {};

  for (const [key, page] of Object.entries(PAGES)) {
    if (!isOwnerRouteAllowed(page.path)) continue;

    if (key === 'property-management' && isMaintenanceProduct()) {
      pages[key] = {
        ...page,
        title: getManagementNavLabel(),
        description: 'Maintenance workspace with documents, maintenance requests, and bookkeeping',
        aliases: [
          'maintenance',
          'management',
          'property management',
          'property operations',
          'maintenance workspace',
          'bookkeeping center',
          'documents workspace',
          'repairs',
        ],
        tabs: {
          documents: page.tabs!.documents,
          maintenance: page.tabs!.maintenance,
          bookkeeping: page.tabs!.bookkeeping,
        },
        elements: [
          'property-management-property-select',
          'property-management-tabs',
          'property-management-finance-snapshot',
          'property-management-maintenance-panel',
        ],
      };
      continue;
    }

    if (key === 'portfolio' && isMaintenanceProduct()) {
      pages[key] = {
        ...page,
        description: 'Manage your properties, analytics, and environmental risk',
        elements: ['add-property-btn', 'property-list'],
      };
      continue;
    }

    pages[key] = page;
  }

  return pages;
}
