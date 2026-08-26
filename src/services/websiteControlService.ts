/**
 * Website Control Service
 * 
 * Centralized service for AI voice control of the entire website.
 * Enables navigation, UI manipulation, form filling, highlighting,
 * and step-by-step guided interactions.
 */

import { requestAssistantActionExecute } from './assistantActionClient';
import type {
  AssistantActionArtifact,
  AssistantActionResultPayload,
  AssistantPadAction,
  AssistantReuseMeta,
} from './assistantActionResultTypes';

export type AssistantExecutionMode = 'backend' | 'backend_with_confirm' | 'analysis' | 'ui_assist';

export interface ControlAction {
  id: string;
  name: string;
  description: string;
  category: 'navigation' | 'modal' | 'form' | 'button' | 'toggle' | 'input' | 'analysis' | 'data';
  keywords: string[];
  voiceId?: string; // data-voice-id attribute
  route?: string; // for navigation actions
  execute?: (params?: Record<string, any>) => Promise<void> | void;
  requiresNavigation?: string; // route that must be active first
  tab?: string; // property-management tab or similar
  steps?: ControlStep[]; // for multi-step workflows
  progressSteps?: string[]; // human-readable checklist shown in the AI task pad
  executionMode?: AssistantExecutionMode;
  backendActionId?: string; // defaults to action id when executionMode is backend*
}

export type WebsiteActionProgressStatus = 'start' | 'step' | 'complete' | 'error';

export interface WebsiteActionProgressEvent {
  status: WebsiteActionProgressStatus;
  runId?: string;
  actionId: string;
  title: string;
  summary: string;
  steps: string[];
  currentStep: number;
  error?: string;
  detailMessage?: string;
  result?: AssistantActionResultPayload;
  actions?: AssistantPadAction[];
  artifacts?: AssistantActionArtifact[];
  reuseMeta?: AssistantReuseMeta;
}

export const CREATE_LEASE_PROGRESS_STEPS = [
  'Review your request',
  'Open documents workspace',
  'Load property and tenant details',
  'Prepare document draft',
  'Draft ready for your review',
];

export const BACKEND_ACTION_PROGRESS_STEPS = [
  'Review your request',
  'Open the right workspace',
  'Run the work',
  'Prepare your result',
  'Ready for your review',
];

function isDocumentCreateAction(action: ControlAction) {
  const id = String(action.backendActionId || action.id || '').toLowerCase();
  return id === 'create-document'
    || id === 'create-lease-agreement'
    || id === 'edit-document';
}

export function emitAssistantActionProgress(
  event: Pick<WebsiteActionProgressEvent, 'actionId' | 'status' | 'currentStep'> &
    Partial<Omit<WebsiteActionProgressEvent, 'actionId' | 'status' | 'currentStep'>>,
) {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent<WebsiteActionProgressEvent>('houseyield:action-progress', {
    detail: {
      title: event.title || 'Working on your request',
      summary: event.summary || 'HouseYield AI is running this task for you.',
      steps: event.steps || CREATE_LEASE_PROGRESS_STEPS,
      ...event,
    },
  }));
}

export interface ControlStep {
  id: string;
  description: string;
  voiceId: string;
  action: 'highlight' | 'click' | 'input' | 'wait' | 'scroll' | 'explain';
  value?: string;
  delay?: number; // ms to wait before next step
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  steps: ControlStep[];
  requiredRoute?: string;
}

// Comprehensive action registry for all website functionality
export const WEBSITE_ACTIONS: ControlAction[] = [
  // ==================== NAVIGATION ====================
  {
    id: 'nav-dashboard',
    name: 'Dashboard',
    description: 'View the owner command center dashboard',
    category: 'navigation',
    keywords: ['dashboard', 'owner dashboard', 'command center', 'overview'],
    route: '/dashboard',
    voiceId: 'nav-dashboard'
  },
  {
    id: 'nav-portfolio',
    name: 'Properties Page',
    description: 'View and manage your properties',
    category: 'navigation',
    keywords: ['properties', 'my properties', 'manage properties', 'rental properties', 'portfolio management'],
    route: '/portfolio',
    voiceId: 'nav-portfolio'
  },
  {
    id: 'nav-property-management',
    name: 'Management',
    description: 'Open the management workspace for documents, tenants, maintenance, bookkeeping, and tax',
    category: 'navigation',
    keywords: ['management', 'property management', 'property operations', 'tenant workspace', 'maintenance workspace', 'bookkeeping center', 'tax center', 'documents workspace'],
    route: '/property-management',
    voiceId: 'nav-property-management'
  },
  {
    id: 'nav-search',
    name: 'Property Search',
    description: 'Search and analyze properties',
    category: 'navigation',
    keywords: ['search', 'property search', 'find property', 'analyze property', 'property analysis', 'individual property', 'look up property'],
    route: '/search',
    voiceId: 'nav-search'
  },
  {
    id: 'nav-market-data',
    name: 'Market Data',
    description: 'View mortgage rates, treasury yields, and housing market data',
    category: 'navigation',
    keywords: ['market', 'market data', 'mortgage rates', 'interest rates', 'housing market', 'treasury', 'fed', 'rates'],
    route: '/market-data',
    voiceId: 'nav-market-data'
  },
  {
    id: 'nav-renovations',
    name: 'Renovations',
    description: 'View suggested renovations and ROI analysis',
    category: 'navigation',
    keywords: ['renovations', 'renovation', 'improvements', 'upgrades', 'remodel', 'roi'],
    route: '/renovations',
    voiceId: 'nav-renovations'
  },
  {
    id: 'nav-sensors',
    name: 'Sensors & IoT',
    description: 'Manage smart home sensors and IoT devices',
    category: 'navigation',
    keywords: ['sensors', 'iot', 'smart home', 'devices', 'flood sensor', 'shelly', 'home protection', 'predictive maintenance'],
    route: '/sensors',
    voiceId: 'nav-sensors'
  },
  {
    id: 'nav-profile',
    name: 'Profile',
    description: 'View and edit your profile settings',
    category: 'navigation',
    keywords: ['profile', 'settings', 'account', 'my profile', 'preferences'],
    route: '/profile',
    voiceId: 'nav-profile'
  },
  {
    id: 'nav-saved',
    name: 'Saved Properties',
    description: 'View your saved and favorite properties',
    category: 'navigation',
    keywords: ['saved', 'favorites', 'saved properties', 'bookmarked', 'watchlist'],
    route: '/saved',
    voiceId: 'nav-saved'
  },
  {
    id: 'nav-room-scanner',
    name: 'Room Scanner',
    description: 'Scan rooms in 3D for renovation planning',
    category: 'navigation',
    keywords: ['room scanner', 'scanner', '3d scan', 'photogrammetry', 'scan room'],
    route: '/room-scanner',
    voiceId: 'nav-room-scanner'
  },
  {
    id: 'nav-absentee',
    name: 'Absentee Owner Search',
    description: 'Find off-market properties from absentee owners',
    category: 'navigation',
    keywords: ['absentee', 'off market', 'absentee owners', 'off-market'],
    route: '/absentee-search',
    voiceId: 'nav-absentee'
  },
  {
    id: 'nav-flood-sensors',
    name: 'Flood Sensors',
    description: 'View and manage Shelly flood sensors',
    category: 'navigation',
    keywords: ['flood sensors', 'shelly', 'water sensors', 'flood detection', 'leak detection'],
    route: '/flood-sensors',
    voiceId: 'nav-flood-sensors'
  },
  {
    id: 'nav-flood-sensor-setup',
    name: 'Flood Sensor Setup',
    description: 'Set up new Shelly flood sensors',
    category: 'navigation',
    keywords: ['setup sensor', 'configure sensor', 'add sensor', 'sensor setup', 'shelly setup'],
    route: '/flood-sensors/setup',
    voiceId: 'nav-flood-sensor-setup'
  },
  {
    id: 'nav-insurance-discount',
    name: 'Insurance Discount',
    description: 'Learn about IoT insurance discounts',
    category: 'navigation',
    keywords: ['insurance', 'insurance discount', 'iot discount', 'smart home discount'],
    route: '/insurance-discount',
    voiceId: 'nav-insurance-discount'
  },
  {
    id: 'nav-insurer-selection',
    name: 'Insurer Selection',
    description: 'Select your insurance provider for discount',
    category: 'navigation',
    keywords: ['select insurer', 'choose insurance', 'insurance provider', 'insurer'],
    route: '/insurance-discount/select-insurer',
    voiceId: 'nav-insurer-selection'
  },
  {
    id: 'nav-insurance-email',
    name: 'Insurance Email Generator',
    description: 'Generate email to request insurance discount',
    category: 'navigation',
    keywords: ['insurance email', 'discount email', 'generate email', 'request discount'],
    route: '/insurance-discount/generate-request',
    voiceId: 'nav-insurance-email'
  },
  {
    id: 'nav-insurance-confirmation',
    name: 'Insurance Confirmation',
    description: 'View insurance discount confirmation',
    category: 'navigation',
    keywords: ['insurance confirmation', 'discount confirmation'],
    route: '/insurance-discount/confirmation',
    voiceId: 'nav-insurance-confirmation'
  },
  {
    id: 'nav-certificate',
    name: 'IoT Certificate',
    description: 'View and download IoT protection certificate',
    category: 'navigation',
    keywords: ['certificate', 'iot certificate', 'protection certificate', 'download certificate'],
    route: '/insurance-discount/certificate',
    voiceId: 'nav-certificate'
  },
  {
    id: 'nav-system-overview',
    name: 'System Overview',
    description: 'View system overview and documentation',
    category: 'navigation',
    keywords: ['system overview', 'documentation', 'system docs', 'overview'],
    route: '/insurance-discount/system-overview',
    voiceId: 'nav-system-overview'
  },
  {
    id: 'nav-photogrammetry-scan',
    name: 'Photogrammetry Scan',
    description: 'Start a new photogrammetry 3D scan',
    category: 'navigation',
    keywords: ['photogrammetry', 'new scan', 'start scan', '3d capture', 'photo scan'],
    route: '/photogrammetry-scan',
    voiceId: 'nav-photogrammetry-scan'
  },
  {
    id: 'nav-tenant-dashboard',
    name: 'Tenant Dashboard',
    description: 'View tenant dashboard and portal',
    category: 'navigation',
    keywords: ['tenant dashboard', 'tenant portal', 'my rental', 'tenant home'],
    route: '/tenant/dashboard',
    voiceId: 'nav-tenant-dashboard'
  },
  {
    id: 'nav-contractor-marketplace',
    name: 'Contractor Marketplace',
    description: 'View renovation jobs marketplace for contractors',
    category: 'navigation',
    keywords: ['contractor marketplace', 'job marketplace', 'renovation jobs', 'find jobs', 'contractor jobs'],
    route: '/contractor/marketplace',
    voiceId: 'nav-contractor-marketplace'
  },

  // ==================== PORTFOLIO ACTIONS ====================
  {
    id: 'add-property',
    name: 'Add Property',
    description: 'Add a new property to your portfolio',
    category: 'modal',
    keywords: ['add property', 'new property', 'add a property', 'create property'],
    voiceId: 'add-property-btn',
    requiresNavigation: '/portfolio'
  },
  {
    id: 'add-tenant',
    name: 'Add Tenant',
    description: 'Add a new tenant to a property',
    category: 'modal',
    keywords: ['add tenant', 'new tenant', 'add a tenant', 'create tenant'],
    voiceId: 'property-management-add-tenant-btn',
    requiresNavigation: '/property-management'
  },
  {
    id: 'view-tenants',
    name: 'View Tenants',
    description: 'View tenant section with all tenants',
    category: 'button',
    keywords: ['view portfolio tenants', 'tenant list', 'tenant section'],
    voiceId: 'property-management-tenants-tab',
    requiresNavigation: '/property-management'
  },
  {
    id: 'view-maintenance',
    name: 'View Maintenance',
    description: 'View maintenance requests and schedule repairs',
    category: 'button',
    keywords: ['view portfolio maintenance', 'maintenance requests', 'repair log', 'fix issue'],
    voiceId: 'property-management-maintenance-tab',
    requiresNavigation: '/property-management'
  },

  // ==================== PROPERTY MANAGEMENT ACTIONS ====================
  {
    id: 'property-management-documents-tab',
    name: 'Property Management Documents',
    description: 'Open the documents workspace in Property Management',
    category: 'button',
    keywords: ['documents tab', 'property management documents', 'open documents workspace'],
    voiceId: 'property-management-documents-tab',
    requiresNavigation: '/property-management'
  },
  {
    id: 'property-management-tenants-tab',
    name: 'Property Management Tenants',
    description: 'Open the tenants workspace in Property Management',
    category: 'button',
    keywords: ['tenants workspace', 'tenants tab', 'open tenants workspace', 'tenant management workspace'],
    voiceId: 'property-management-tenants-tab',
    requiresNavigation: '/property-management'
  },
  {
    id: 'property-management-maintenance-tab',
    name: 'Property Management Maintenance',
    description: 'Open the maintenance workspace in Property Management',
    category: 'button',
    keywords: ['maintenance workspace tab', 'maintenance tab', 'open maintenance workspace'],
    voiceId: 'property-management-maintenance-tab',
    requiresNavigation: '/property-management'
  },
  {
    id: 'property-management-bookkeeping-tab',
    name: 'Bookkeeping',
    description: 'Open the bookkeeping workspace',
    category: 'button',
    keywords: ['bookkeeping workspace', 'bookkeeping tab', 'open bookkeeping workspace', 'bookkeeping'],
    voiceId: 'nav-bookkeeping',
    requiresNavigation: '/bookkeeping'
  },
  {
    id: 'property-management-tax-tab',
    name: 'Property Management Tax',
    description: 'Open the tax workspace in Property Management',
    category: 'button',
    keywords: ['tax workspace', 'tax tab', 'open tax workspace'],
    voiceId: 'property-management-tax-tab',
    requiresNavigation: '/property-management'
  },
  {
    id: 'property-management-add-tenant',
    name: 'Add Tenant In Property Management',
    description: 'Open tenant onboarding in Property Management',
    category: 'button',
    keywords: ['property management add tenant', 'open tenant onboarding'],
    voiceId: 'property-management-add-tenant-btn',
    requiresNavigation: '/property-management'
  },
  {
    id: 'property-management-screen-applicant',
    name: 'Screen Applicant In Property Management',
    description: 'Open the screening form for a new applicant',
    category: 'button',
    keywords: ['property management screen applicant', 'open screening form'],
    voiceId: 'property-management-screen-applicant-btn',
    requiresNavigation: '/property-management'
  },
  {
    id: 'property-management-send-payment-request',
    name: 'Send Payment Request In Property Management',
    description: 'Open the rent payment request dialog',
    category: 'button',
    keywords: ['property management send payment request', 'open payment request dialog'],
    voiceId: 'property-management-send-payment-request-btn',
    requiresNavigation: '/property-management'
  },
  {
    id: 'property-management-create-listing',
    name: 'Create Listing In Property Management',
    description: 'Open the vacancy listing form in Property Management',
    category: 'button',
    keywords: ['property management create listing', 'open vacancy listing form'],
    voiceId: 'property-management-create-listing-btn',
    requiresNavigation: '/property-management'
  },

  // ==================== PROPERTY SEARCH ACTIONS ====================
  {
    id: 'open-property-analysis',
    name: 'Property Analysis',
    description: 'Open the property analysis modal to analyze a specific address',
    category: 'modal',
    keywords: ['analyze property', 'property analysis', 'analyze address', 'houseyield', 'run analysis'],
    voiceId: 'property-search-box',
    requiresNavigation: '/search'
  },
  {
    id: 'open-advanced-analysis',
    name: 'Advanced Property Analysis',
    description: 'Open advanced analysis with environmental and market data',
    category: 'modal',
    keywords: ['advanced analysis', 'deep analysis', 'full analysis', 'comprehensive analysis'],
    voiceId: 'advanced-analysis-btn',
    requiresNavigation: '/search'
  },

  // ==================== NET WORTH ACTIONS ====================
  {
    id: 'add-asset',
    name: 'Add Asset',
    description: 'Add a new asset like stocks, crypto, or other investments',
    category: 'modal',
    keywords: ['add asset', 'add stock', 'add investment', 'new asset', 'add to net worth'],
    voiceId: 'add-asset-btn',
    requiresNavigation: '/net-worth'
  },
  {
    id: 'update-prices',
    name: 'Update Stock Prices',
    description: 'Refresh all stock prices with live market data',
    category: 'button',
    keywords: ['update prices', 'refresh prices', 'refresh stocks', 'live prices', 'update stocks'],
    voiceId: 'update-prices-btn',
    requiresNavigation: '/net-worth'
  },
  {
    id: 'view-portfolio-chart',
    name: 'Portfolio Chart',
    description: 'View your portfolio value chart over time',
    category: 'data',
    keywords: ['portfolio chart', 'value chart', 'net worth chart', 'portfolio graph'],
    voiceId: 'portfolio-chart',
    requiresNavigation: '/net-worth'
  },
  {
    id: 'view-allocation',
    name: 'Asset Allocation',
    description: 'View your asset allocation pie chart',
    category: 'data',
    keywords: ['allocation', 'pie chart', 'distribution', 'asset allocation', 'breakdown'],
    voiceId: 'allocation-chart',
    requiresNavigation: '/net-worth'
  },

  // ==================== MARKET DATA ACTIONS ====================
  {
    id: 'view-mortgage-rate',
    name: 'Mortgage Rate',
    description: 'View the current 30-year mortgage rate and trends',
    category: 'data',
    keywords: ['mortgage rate', '30 year mortgage', 'interest rate', 'mortgage', 'home loan rate'],
    voiceId: 'mortgage-rate-detail',
    requiresNavigation: '/market-data'
  },
  {
    id: 'view-treasury-yields',
    name: 'Treasury Yields',
    description: 'View 10-year treasury yields that influence mortgage rates',
    category: 'data',
    keywords: ['treasury', 'treasury yield', '10 year treasury', 'bonds', 'yield curve'],
    voiceId: 'treasury-yields',
    requiresNavigation: '/market-data'
  },
  {
    id: 'view-fed-meeting',
    name: 'Fed Meeting Summary',
    description: 'View the latest Federal Reserve meeting summary and rate decisions',
    category: 'data',
    keywords: ['fed meeting', 'federal reserve', 'fed decision', 'rate decision', 'fomc'],
    voiceId: 'fed-meeting-summary',
    requiresNavigation: '/market-data'
  },

  // ==================== SENSORS & IOT ACTIONS ====================
  {
    id: 'add-sensor',
    name: 'Add Sensor',
    description: 'Connect a new smart sensor or IoT device',
    category: 'modal',
    keywords: ['add sensor', 'connect sensor', 'new sensor', 'add device'],
    voiceId: 'add-sensor-btn',
    requiresNavigation: '/sensors'
  },
  {
    id: 'view-sensor-data',
    name: 'Sensor Data',
    description: 'View real-time data from your connected sensors',
    category: 'data',
    keywords: ['sensor data', 'readings', 'temperature', 'humidity', 'flood detection'],
    voiceId: 'sensor-dashboard',
    requiresNavigation: '/sensors'
  },

  // ==================== RENOVATION ACTIONS ====================
  {
    id: 'view-renovation-suggestions',
    name: 'Renovation Suggestions',
    description: 'View AI-suggested renovations with ROI analysis',
    category: 'data',
    keywords: ['renovation suggestions', 'suggested renovations', 'renovation ideas', 'improvement ideas'],
    voiceId: 'renovation-suggestions',
    requiresNavigation: '/renovations'
  },
  {
    id: 'open-renovation-planner',
    name: 'Renovation Planner',
    description: 'Open the 3D renovation planning tool',
    category: 'modal',
    keywords: ['renovation planner', 'plan renovation', '3d planner', 'design renovation'],
    voiceId: 'renovation-planner-btn',
    requiresNavigation: '/renovations'
  },

  // ==================== PORTFOLIO MODALS ====================
  {
    id: 'open-messaging-modal',
    name: 'Open Messages Activity',
    description: 'Open the tenants messages activity panel (UI only — prefer draft-tenant-message for sending)',
    category: 'modal',
    keywords: ['open messages panel', 'messages activity', 'open tenant inbox'],
    voiceId: 'property-management-messages-activity',
    requiresNavigation: '/property-management?tab=tenants',
    tab: 'tenants',
  },
  {
    id: 'open-edit-tenant-modal',
    name: 'Edit Tenant',
    description: 'Open modal to edit tenant details',
    category: 'modal',
    keywords: ['edit tenant', 'update tenant', 'modify tenant', 'change tenant'],
    voiceId: 'edit-tenant-btn',
    requiresNavigation: '/portfolio'
  },
  {
    id: 'open-attom-modal',
    name: 'Property Data',
    description: 'Open ATTOM property data modal with detailed information',
    category: 'modal',
    keywords: ['property data', 'attom data', 'property details', 'lot size', 'square footage'],
    voiceId: 'attom-data-btn',
    requiresNavigation: '/portfolio'
  },
  {
    id: 'open-create-listing-modal',
    name: 'Create Listing',
    description: 'Open modal to create a rental listing',
    category: 'modal',
    keywords: ['create listing', 'new listing', 'post listing', 'rent property', 'list for rent'],
    voiceId: 'create-listing-btn',
    requiresNavigation: '/portfolio'
  },
  {
    id: 'open-payment-modal',
    name: 'Collect Payment',
    description: 'Open payment modal to collect rent via Stripe',
    category: 'modal',
    keywords: ['collect payment', 'collect rent', 'payment', 'stripe', 'charge tenant'],
    voiceId: 'property-management-send-payment-request-btn',
    requiresNavigation: '/property-management'
  },
  {
    id: 'open-maintenance-modal',
    name: 'Add Maintenance Request',
    description: 'Open modal to create a new maintenance request',
    category: 'modal',
    keywords: ['maintenance request', 'repair request', 'schedule repair', 'report issue', 'maintenance ticket'],
    voiceId: 'property-management-maintenance-log',
    requiresNavigation: '/property-management'
  },
  {
    id: 'upload-document',
    name: 'Upload Document',
    description: 'Open the documents workspace and start a document upload',
    category: 'modal',
    keywords: ['upload document', 'add document', 'upload lease', 'upload file', 'add file'],
    voiceId: 'property-management-documents-tab',
    requiresNavigation: '/property-management'
  },
  {
    id: 'create-lease-agreement',
    name: 'Create Document',
    description: 'Create any landlord document (lease, pet addendum, amendment, notice, etc.), save it to Documents, and optionally request e-signature',
    category: 'modal',
    keywords: [
      'create lease agreement',
      'make lease agreement',
      'make me a lease agreement',
      'draft lease agreement',
      'generate lease agreement',
      'create lease',
      'draft lease',
      'make me a document',
      'create document',
      'generate document',
      'create pet addendum',
      'make a pet addendum',
      'draft pet addendum',
      'new pet addendum',
      'create lease amendment',
      'create addendum',
      'notice to vacate',
      'rent increase notice',
      'move-in checklist',
      'move-out checklist',
    ],
    voiceId: 'property-management-create-lease-agreement-btn',
    requiresNavigation: '/property-management?tab=documents',
    tab: 'documents',
    progressSteps: CREATE_LEASE_PROGRESS_STEPS,
    executionMode: 'backend',
    backendActionId: 'create-document',
  },
  {
    id: 'create-document',
    name: 'Create Document',
    description: 'Create any document type and save it to Documents',
    category: 'modal',
    keywords: ['create document', 'generate document', 'draft document'],
    requiresNavigation: '/property-management?tab=documents',
    tab: 'documents',
    progressSteps: CREATE_LEASE_PROGRESS_STEPS,
    executionMode: 'backend',
    backendActionId: 'create-document',
  },
  {
    id: 'list-documents',
    name: 'Find Documents',
    description: 'Find and open existing documents such as pet addendums or leases for a property',
    category: 'analysis',
    keywords: [
      'open pet addendum',
      'find pet addendum',
      'show pet addendum',
      'pet addendum',
      'list documents',
      'open lease',
      'find lease',
      'existing documents',
      'my pet addendum',
      'open document',
    ],
    requiresNavigation: '/property-management?tab=documents',
    tab: 'documents',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'analysis',
    backendActionId: 'list-documents',
  },
  {
    id: 'request-document-esignature',
    name: 'Request Document E-Signature',
    description: 'Request e-signature on an existing document from the tenant',
    category: 'form',
    keywords: [
      'request signature',
      'request e-signature',
      'send for signature',
      'esign document',
      'e-sign document',
      'get tenant to sign',
      'send document for signature',
    ],
    requiresNavigation: '/property-management?tab=documents',
    tab: 'documents',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend',
  },
  {
    id: 'set-tenant-rent-rate',
    name: 'Set Tenant Rent Rate',
    description: 'Update a tenant monthly rent rate on the backend and open the tenants workspace',
    category: 'form',
    keywords: ['set rent', 'change rent', 'update rent', 'new rent rate', 'raise rent', 'lower rent'],
    requiresNavigation: '/property-management?tab=tenants',
    tab: 'tenants',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend',
  },
  {
    id: 'send-late-payment-alert',
    name: 'Late Payment Alert',
    description: 'Draft a late-payment reminder for a tenant to review and send via the tenant portal',
    category: 'form',
    keywords: ['late payment', 'rent reminder', 'past due rent', 'overdue rent', 'late rent alert'],
    requiresNavigation: '/property-management?tab=tenants',
    tab: 'tenants',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend_with_confirm',
  },
  {
    id: 'draft-tenant-message',
    name: 'Message Tenant',
    description: 'Draft a tenant portal message for review and send',
    category: 'form',
    keywords: ['message tenant', 'text tenant', 'tell the tenant', 'send tenant message', 'write tenant a message'],
    requiresNavigation: '/property-management?tab=tenants',
    tab: 'tenants',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend_with_confirm',
  },
  {
    id: 'draft-contractor-payment-receipt',
    name: 'Contractor Payment Receipt',
    description: 'Draft a contractor payment receipt for your records',
    category: 'modal',
    keywords: ['contractor receipt', 'payment receipt', 'vendor receipt', 'draft receipt'],
    requiresNavigation: '/property-management?tab=documents',
    tab: 'documents',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend',
  },
  {
    id: 'follow-up-esignature-request',
    name: 'E-Signature Follow-up',
    description: 'Draft a follow-up reminder for a pending e-signature request',
    category: 'form',
    keywords: [
      'signature reminder',
      'esignature follow up',
      'follow up signature',
      'remind tenant to sign',
      'follow up on signature',
    ],
    requiresNavigation: '/property-management?tab=documents',
    tab: 'documents',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend_with_confirm',
  },
  {
    id: 'edit-document',
    name: 'Edit Document',
    description: 'Edit an existing document using voice/text instructions and save the changes',
    category: 'form',
    keywords: ['edit document', 'edit lease', 'change the lease', 'update document', 'revise lease', 'modify document'],
    requiresNavigation: '/property-management?tab=documents',
    tab: 'documents',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend',
  },
  {
    id: 'download-irs-tax-file',
    name: 'Download IRS Tax File',
    description: 'Prepare an IRS Schedule E PDF from Tax Center for viewing or download',
    category: 'data',
    keywords: ['irs file', 'schedule e', 'tax pdf', 'download tax form', 'irs tax download'],
    requiresNavigation: '/property-management?tab=tax',
    tab: 'tax',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend',
  },
  {
    id: 'add-bookkeeping-transaction',
    name: 'Add Bookkeeping Transaction',
    description: 'Post a bookkeeping income or expense transaction on the backend',
    category: 'form',
    keywords: ['add transaction', 'bookkeeping transaction', 'post expense', 'add expense', 'record income'],
    requiresNavigation: '/bookkeeping',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend',
  },
  {
    id: 'show-bookkeeping-expenses',
    name: 'Show Bookkeeping Expenses',
    description: 'Show specific bookkeeping expenses in the task pad',
    category: 'analysis',
    keywords: [
      'show expenses',
      'expense breakdown',
      'bookkeeping expenses',
      'what did i spend',
      'go over bookkeeping',
      'review bookkeeping',
      'bookkeeping data',
      '2025 bookkeeping',
      'show my expenses',
      'mortgage interest',
      'management fees',
      'property management fees',
      'how much interest',
      'category totals',
      'ledger breakdown',
    ],
    requiresNavigation: '/bookkeeping',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'analysis',
  },
  {
    id: 'follow-up-maintenance-request',
    name: 'Maintenance Follow-up',
    description: 'Summarize a maintenance request and recommended next steps',
    category: 'analysis',
    keywords: ['maintenance follow up', 'maintenance status', 'repair status', 'maintenance details'],
    requiresNavigation: '/property-management?tab=maintenance',
    tab: 'maintenance',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'analysis',
  },
  {
    id: 'book-maintenance-provider',
    name: 'Book Maintenance Provider',
    description: 'Start a maintenance provider search/booking for an issue like plumbing',
    category: 'form',
    keywords: ['book plumber', 'find maintenance provider', 'book maintenance', 'plumbing provider', 'hire contractor'],
    requiresNavigation: '/property-management?tab=maintenance',
    tab: 'maintenance',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend',
  },
  {
    id: 'analyze-property',
    name: 'Analyze Property',
    description: 'Analyze any property surface — overview, analytics, cash-out refinance, rental pricing power, or environmental risk — opens the matching Properties workspace and renders numbers in the task pad',
    category: 'analysis',
    keywords: [
      'analyze property',
      'property analysis',
      'property overview',
      'property analytics',
      'cash out refinance',
      'cash-out refinance',
      'cashout refinance',
      'refinance analysis',
      'refi analysis',
      'is this a good refinance',
      'good candidate to refinance',
      'pull out equity',
      'analyze prestwick',
      'property finance analysis',
      'rental pricing power',
      'pricing power',
      'rent reset',
      'reset the rent',
      'market rent',
      'under market',
      'raise rent',
      'environmental risk',
      'flood risk',
      'wildfire risk',
      'full property review',
    ],
    requiresNavigation: '/portfolio?tab=properties',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'analysis',
  },
  {
    id: 'analyze-property-finance',
    name: 'Analyze Property Finance',
    description: 'Alias for analyze-property (refinance / analytics). Prefer analyze-property with analysisType.',
    category: 'analysis',
    keywords: [
      'cash out refinance',
      'refinance analysis',
      'property finance analysis',
    ],
    requiresNavigation: '/portfolio?tab=properties',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'analysis',
    backendActionId: 'analyze-property',
  },
  {
    id: 'open-platform-workspace',
    name: 'Open Platform Workspace',
    description: 'Open any HouseYield management area (documents, tenants, maintenance, bookkeeping, tax, predictive maintenance / sensors, market, renovations) so the owner can continue with the AI',
    category: 'navigation',
    keywords: [
      'open documents',
      'open tenants',
      'open maintenance',
      'open bookkeeping',
      'open tax center',
      'open sensors',
      'open predictive maintenance',
      'predictive maintenance analytics',
      'go to renovations',
    ],
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'analysis',
  },
  {
    id: 'open-sensor-analytics',
    name: 'Open Sensor Analytics',
    description: 'Open Predictive Maintenance Analytics (Conditions / Mold / Freeze / Insulation)',
    category: 'navigation',
    keywords: [
      'sensor analytics',
      'predictive maintenance analytics',
      'analytics tab',
      'mold chart',
      'freeze chart',
      'insulation grades',
    ],
    voiceId: 'sensor-tab-analytics',
    requiresNavigation: '/sensors?tab=analytics',
    progressSteps: [
      'Open Predictive Maintenance',
      'Switch to Analytics',
      'Ready for your review',
    ],
  },
  {
    id: 'analyze-market-insight',
    name: 'Market Insight Analysis',
    description: 'Analyze market insights using cached HouseYield market context first',
    category: 'analysis',
    keywords: ['market analysis', 'market insight', 'mortgage rates analysis', 'housing market analysis'],
    requiresNavigation: '/market-data',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'analysis',
  },
  {
    id: 'analyze-sensor-data',
    name: 'Sensor Data Analysis',
    description: 'Analyze sensor health and open the matching Predictive Maintenance tab (Overview, Alerts, or Analytics)',
    category: 'analysis',
    keywords: [
      'sensor analysis',
      'sensor recommendations',
      'flood sensor status',
      'iot analysis',
      'predictive maintenance',
      'mold risk',
      'freeze risk',
      'explain analytics',
    ],
    requiresNavigation: '/sensors',
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'analysis',
  },
  {
    id: 'schedule-ai-task',
    name: 'Schedule AI Task',
    description: 'Schedule the AI to do something later, or add a dated reminder to the upcoming task list',
    category: 'form',
    keywords: [
      'schedule ai task',
      'schedule a task',
      'remind me later',
      'monday at',
      'friday at',
      'schedule for',
      'put on my schedule',
      'upcoming task',
      'schedule reminder',
    ],
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'backend',
  },
  {
    id: 'list-scheduled-ai-tasks',
    name: 'List Scheduled AI Tasks',
    description: 'Show upcoming calendar-dated AI tasks and reminders',
    category: 'analysis',
    keywords: ['upcoming ai tasks', 'scheduled tasks', 'ai schedule', 'what is scheduled', 'task list'],
    progressSteps: BACKEND_ACTION_PROGRESS_STEPS,
    executionMode: 'analysis',
  },
  {
    id: 'open-quickbooks-modal',
    name: 'QuickBooks Sync',
    description: 'Open QuickBooks sync modal',
    category: 'modal',
    keywords: ['quickbooks', 'sync quickbooks', 'accounting', 'bookkeeping', 'qb sync'],
    voiceId: 'quickbooks-sync-btn',
    requiresNavigation: '/portfolio'
  },

  // ==================== SEARCH PAGE MODALS ====================
  {
    id: 'open-ai-analysis-modal',
    name: 'AI Analysis',
    description: 'Open AI-powered property analysis overlay',
    category: 'modal',
    keywords: ['ai analysis', 'ai overlay', 'smart analysis', 'ai insights'],
    voiceId: 'ai-analysis-btn',
    requiresNavigation: '/search'
  },
  {
    id: 'open-street-view-modal',
    name: 'Street View',
    description: 'Open full-screen Google Street View',
    category: 'modal',
    keywords: ['street view', 'google street view', 'view property', 'see property'],
    voiceId: 'street-view-btn',
    requiresNavigation: '/search'
  },

  // ==================== RENOVATIONS MODALS ====================
  {
    id: 'open-renovation-detail-modal',
    name: 'Renovation Details',
    description: 'View detailed breakdown of a renovation item',
    category: 'modal',
    keywords: ['renovation detail', 'renovation breakdown', 'cost breakdown', 'renovation info'],
    voiceId: 'renovation-detail-btn',
    requiresNavigation: '/renovations'
  },
  {
    id: 'open-ai-preview-modal',
    name: 'AI Renovation Preview',
    description: 'View AI-generated renovation preview',
    category: 'modal',
    keywords: ['ai preview', 'renovation preview', 'see renovation', 'preview changes'],
    voiceId: 'ai-preview-btn',
    requiresNavigation: '/renovations'
  },
  {
    id: 'open-marketplace-post-modal',
    name: 'Post to Marketplace',
    description: 'Post 3D scan to contractor marketplace',
    category: 'modal',
    keywords: ['post marketplace', 'post scan', 'find contractor', 'get bids'],
    voiceId: 'marketplace-post-btn',
    requiresNavigation: '/renovations'
  },

  // ==================== TENANT ACTIONS ====================
  {
    id: 'submit-maintenance-request',
    name: 'Submit Maintenance',
    description: 'Submit a maintenance request as tenant',
    category: 'form',
    keywords: ['submit maintenance', 'report problem', 'request repair', 'maintenance issue'],
    voiceId: 'submit-maintenance-btn',
    requiresNavigation: '/tenant/dashboard'
  },
  {
    id: 'contact-landlord',
    name: 'Contact Landlord',
    description: 'Send a message to your landlord',
    category: 'form',
    keywords: ['contact landlord', 'message landlord', 'email landlord'],
    voiceId: 'contact-landlord-btn',
    requiresNavigation: '/tenant/dashboard'
  },
  {
    id: 'pay-rent',
    name: 'Pay Rent',
    description: 'Make a rent payment',
    category: 'button',
    keywords: ['pay rent', 'make payment', 'rent payment', 'pay now'],
    voiceId: 'pay-rent-btn',
    requiresNavigation: '/tenant/dashboard'
  },

  // ==================== CONTRACTOR ACTIONS ====================
  {
    id: 'view-3d-model',
    name: 'View 3D Model',
    description: 'View 3D scan model for a listing',
    category: 'button',
    keywords: ['view 3d', 'view model', 'see scan', '3d model'],
    voiceId: 'view-3d-btn',
    requiresNavigation: '/contractor/marketplace'
  },
  {
    id: 'submit-bid',
    name: 'Submit Bid',
    description: 'Submit a bid on a renovation job',
    category: 'modal',
    keywords: ['submit bid', 'place bid', 'make offer', 'bid on job'],
    voiceId: 'submit-bid-btn',
    requiresNavigation: '/contractor/marketplace'
  },
  {
    id: 'view-my-bids',
    name: 'My Bids',
    description: 'View all submitted bids',
    category: 'modal',
    keywords: ['my bids', 'view bids', 'submitted bids', 'bid history'],
    voiceId: 'my-bids-btn',
    requiresNavigation: '/contractor/marketplace'
  },

  // ==================== CREDIT/BACKGROUND CHECKS ====================
  {
    id: 'run-credit-check',
    name: 'Credit Check',
    description: 'Run Equifax credit check on applicant',
    category: 'button',
    keywords: ['credit check', 'check credit', 'equifax', 'credit score', 'credit report'],
    voiceId: 'credit-check-btn',
    requiresNavigation: '/portfolio'
  },
  {
    id: 'run-background-check',
    name: 'Background Check',
    description: 'Run Equifax background check on applicant',
    category: 'button',
    keywords: ['background check', 'criminal check', 'screen tenant', 'background report'],
    voiceId: 'background-check-btn',
    requiresNavigation: '/portfolio'
  },

  // ==================== AI SERVICE ACTIONS ====================
  {
    id: 'find-service-provider',
    name: 'Find Provider',
    description: 'AI search for service providers',
    category: 'button',
    keywords: ['find provider', 'search provider', 'find contractor', 'find handyman', 'ai search'],
    voiceId: 'find-provider-btn',
    requiresNavigation: '/portfolio'
  },
  {
    id: 'initiate-ai-call',
    name: 'AI Voice Call',
    description: 'Initiate AI voice call to contractor',
    category: 'button',
    keywords: ['ai call', 'voice call', 'call contractor', 'auto call'],
    voiceId: 'ai-call-btn',
    requiresNavigation: '/portfolio'
  }
];

// Complex multi-step workflows
export const WORKFLOWS: WorkflowDefinition[] = [
  {
    id: 'environmental-analysis',
    name: 'Environmental Analysis',
    description: 'Analyze environmental risks for a property including flood, fire, earthquake, and air quality',
    keywords: ['environmental analysis', 'environmental risk', 'flood risk', 'fire risk', 'disaster risk', 'hazard analysis', 'environmental report'],
    requiredRoute: '/search',
    steps: [
      {
        id: 'step-1',
        description: "First, I'll open the Individual Property Analysis tool where you can enter an address.",
        voiceId: 'property-search-box',
        action: 'highlight',
        delay: 2000
      },
      {
        id: 'step-2',
        description: "Click on 'Individual Property Analysis' to open the analysis modal.",
        voiceId: 'property-search-box',
        action: 'click',
        delay: 1500
      },
      {
        id: 'step-3',
        description: "Now enter the property address you want to analyze in this search box.",
        voiceId: 'analysis-address-input',
        action: 'highlight',
        delay: 2500
      },
      {
        id: 'step-4',
        description: "After entering the address, click Analyze to run the HouseYield analysis which includes environmental data.",
        voiceId: 'analyze-button',
        action: 'highlight',
        delay: 2000
      },
      {
        id: 'step-5',
        description: "The results will show flood zones, wildfire risk, earthquake risk, air quality, and other environmental factors.",
        voiceId: 'environmental-results',
        action: 'explain',
        delay: 3000
      }
    ]
  },
  {
    id: 'add-property-workflow',
    name: 'Add Property to Portfolio',
    description: 'Walk through adding a new property to your portfolio',
    keywords: ['add property step by step', 'walk me through adding property', 'help me add property'],
    requiredRoute: '/portfolio',
    steps: [
      {
        id: 'step-1',
        description: "I'll help you add a property. First, look for the Add Property button in the top right.",
        voiceId: 'add-property-btn',
        action: 'highlight',
        delay: 2000
      },
      {
        id: 'step-2',
        description: "Click the Add Property button to open the form.",
        voiceId: 'add-property-btn',
        action: 'click',
        delay: 1500
      },
      {
        id: 'step-3',
        description: "Now fill in the property address in this field.",
        voiceId: 'property-address-input',
        action: 'highlight',
        delay: 2000
      },
      {
        id: 'step-4',
        description: "Enter the purchase price and current estimated value.",
        voiceId: 'property-value-input',
        action: 'highlight',
        delay: 2000
      },
      {
        id: 'step-5',
        description: "Finally, click Save to add the property to your portfolio.",
        voiceId: 'save-property-btn',
        action: 'highlight',
        delay: 2000
      }
    ]
  },
  {
    id: 'check-mortgage-rates',
    name: 'Check Mortgage Rates',
    description: 'View current mortgage rates and understand what affects them',
    keywords: ['check mortgage rates', 'current mortgage rate', 'what are mortgage rates', 'show me rates'],
    requiredRoute: '/market-data',
    steps: [
      {
        id: 'step-1',
        description: "Here on the Market Data page, you can see the current 30-year fixed mortgage rate.",
        voiceId: 'mortgage-rate-detail',
        action: 'highlight',
        delay: 3000
      },
      {
        id: 'step-2',
        description: "The rate is influenced by Treasury yields, which you can see here.",
        voiceId: 'treasury-yields',
        action: 'highlight',
        delay: 2500
      },
      {
        id: 'step-3',
        description: "Federal Reserve decisions also impact rates. Check the Fed Meeting Summary for the latest.",
        voiceId: 'fed-meeting-summary',
        action: 'highlight',
        delay: 2500
      }
    ]
  },
  {
    id: 'analyze-investment',
    name: 'Analyze Investment Property',
    description: 'Complete analysis workflow for an investment property',
    keywords: ['analyze investment', 'investment analysis', 'is this a good investment', 'should i buy'],
    requiredRoute: '/search',
    steps: [
      {
        id: 'step-1',
        description: "Let's analyze this as an investment. First, open the Advanced Property Analysis.",
        voiceId: 'advanced-analysis-btn',
        action: 'highlight',
        delay: 2000
      },
      {
        id: 'step-2',
        description: "Click here to open the comprehensive analysis tool.",
        voiceId: 'advanced-analysis-btn',
        action: 'click',
        delay: 1500
      },
      {
        id: 'step-3',
        description: "Enter the property address to get detailed investment metrics.",
        voiceId: 'advanced-address-input',
        action: 'highlight',
        delay: 2000
      },
      {
        id: 'step-4',
        description: "The analysis will show cash flow projections, cap rate, ROI, and comparable sales.",
        voiceId: 'investment-metrics',
        action: 'explain',
        delay: 3000
      }
    ]
  }
];

// UI Element registry for highlighting
export const UI_ELEMENTS: Record<string, { selector: string; description: string; page?: string }> = {
  // Sidebar & Navigation
  'sidebar': { selector: '[data-voice-id="sidebar"]', description: 'The main navigation sidebar' },
  'main-nav': { selector: '[data-voice-id="main-nav"]', description: 'Navigation menu with all sections' },
  'nav-dashboard': { selector: '[data-voice-id="nav-dashboard"]', description: 'Dashboard navigation link' },
  'nav-portfolio': { selector: '[data-voice-id="nav-portfolio"]', description: 'Properties navigation link' },
  'nav-property-management': { selector: '[data-voice-id="nav-property-management"]', description: 'Management navigation link' },
  'nav-search': { selector: '[data-voice-id="nav-search"]', description: 'Property Search navigation link' },
  'nav-net-worth': { selector: '[data-voice-id="nav-net-worth"]', description: 'Portfolio navigation link' },
  'nav-market-data': { selector: '[data-voice-id="nav-market-data"]', description: 'Market Data navigation link' },
  'nav-renovations': { selector: '[data-voice-id="nav-renovations"]', description: 'Renovations navigation link' },
  'nav-sensors': { selector: '[data-voice-id="nav-sensors"]', description: 'Sensors navigation link' },
  'nav-saved': { selector: '[data-voice-id="nav-saved"]', description: 'Saved Properties navigation link' },
  'nav-absentee': { selector: '[data-voice-id="nav-absentee"]', description: 'Off-Market Leads navigation link' },

  // Property Management Page Elements
  'property-management-page': { selector: '[data-voice-id="property-management-page"]', description: 'Property Management root workspace', page: '/property-management' },
  'property-management-header': { selector: '[data-voice-id="property-management-header"]', description: 'Header with property scope and workspace tabs', page: '/property-management' },
  'property-management-property-select': { selector: '[data-voice-id="property-management-property-select"]', description: 'Property scope selector', page: '/property-management' },
  'property-management-tabs': { selector: '[data-voice-id="property-management-tabs"]', description: 'Workspace tabs for documents, tenants, maintenance, bookkeeping, and tax', page: '/property-management' },
  'property-management-documents-tab': { selector: '[data-voice-id="property-management-documents-tab"]', description: 'Documents workspace tab', page: '/property-management' },
  'property-management-create-lease-agreement-btn': { selector: '[data-voice-id="property-management-create-lease-agreement-btn"]', description: 'Create lease agreement from document templates', page: '/property-management' },
  'create-document-modal': { selector: '[data-voice-id="create-document-modal"]', description: 'Create document dialog', page: '/property-management' },
  'document-type-select': { selector: '[data-voice-id="document-type-select"]', description: 'Document type selector', page: '/property-management' },
  'document-property-select': { selector: '[data-voice-id="document-property-select"]', description: 'Document property selector', page: '/property-management' },
  'document-tenant-select': { selector: '[data-voice-id="document-tenant-select"]', description: 'Document tenant selector', page: '/property-management' },
  'document-custom-instructions': { selector: '[data-voice-id="document-custom-instructions"]', description: 'Custom document instructions input', page: '/property-management' },
  'generate-document-btn': { selector: '[data-voice-id="generate-document-btn"]', description: 'Generate document with AI button', page: '/property-management' },
  'save-document-btn': { selector: '[data-voice-id="save-document-btn"]', description: 'Save generated document button', page: '/property-management' },
  'property-management-tenants-tab': { selector: '[data-voice-id="property-management-tenants-tab"]', description: 'Tenants workspace tab', page: '/property-management' },
  'property-management-maintenance-tab': { selector: '[data-voice-id="property-management-maintenance-tab"]', description: 'Maintenance workspace tab', page: '/property-management' },
  'property-management-bookkeeping-tab': { selector: '[data-voice-id="nav-bookkeeping"]', description: 'Bookkeeping sidebar page', page: '/bookkeeping' },
  'nav-bookkeeping': { selector: '[data-voice-id="nav-bookkeeping"]', description: 'Bookkeeping sidebar page', page: '/bookkeeping' },
  'bookkeeping-property-select': { selector: '[data-voice-id="bookkeeping-property-select"]', description: 'Bookkeeping property selector', page: '/bookkeeping' },
  'property-management-tax-tab': { selector: '[data-voice-id="property-management-tax-tab"]', description: 'Tax workspace tab', page: '/property-management' },
  'property-management-finance-snapshot': { selector: '[data-voice-id="property-management-finance-snapshot"]', description: 'Finance snapshot for the active property', page: '/property-management' },
  'property-management-tenants-panel': { selector: '[data-voice-id="property-management-tenants-panel"]', description: 'Tenant management workspace', page: '/property-management' },
  'property-management-tenants-overview': { selector: '[data-voice-id="property-management-tenants-overview"]', description: 'Tenant overview and onboarding section', page: '/property-management' },
  'property-management-add-tenant-btn': { selector: '[data-voice-id="property-management-add-tenant-btn"]', description: 'Add tenant button', page: '/property-management' },
  'property-management-export-tenants-btn': { selector: '[data-voice-id="property-management-export-tenants-btn"]', description: 'Export tenants button', page: '/property-management' },
  'property-management-messages-activity': { selector: '[data-voice-id="property-management-messages-activity"]', description: 'Messages and activity section', page: '/property-management' },
  'property-management-analyze-messages-btn': { selector: '[data-voice-id="property-management-analyze-messages-btn"]', description: 'AI analyze messages button', page: '/property-management' },
  'property-management-screening': { selector: '[data-voice-id="property-management-screening"]', description: 'Tenant screening section', page: '/property-management' },
  'property-management-copy-application-link-btn': { selector: '[data-voice-id="property-management-copy-application-link-btn"]', description: 'Copy application link button', page: '/property-management' },
  'property-management-screen-applicant-btn': { selector: '[data-voice-id="property-management-screen-applicant-btn"]', description: 'Screen applicant button', page: '/property-management' },
  'property-management-copy-inline-application-link-btn': { selector: '[data-voice-id="property-management-copy-inline-application-link-btn"]', description: 'Copy inline application link button', page: '/property-management' },
  'property-management-screening-name-input': { selector: '[data-voice-id="property-management-screening-name-input"]', description: 'Applicant name input', page: '/property-management' },
  'property-management-screening-email-input': { selector: '[data-voice-id="property-management-screening-email-input"]', description: 'Applicant email input', page: '/property-management' },
  'property-management-send-screening-invite-btn': { selector: '[data-voice-id="property-management-send-screening-invite-btn"]', description: 'Send screening invite button', page: '/property-management' },
  'property-management-payments': { selector: '[data-voice-id="property-management-payments"]', description: 'Payments section', page: '/property-management' },
  'property-management-send-payment-request-btn': { selector: '[data-voice-id="property-management-send-payment-request-btn"]', description: 'Send payment request button', page: '/property-management' },
  'property-management-discovery': { selector: '[data-voice-id="property-management-discovery"]', description: 'Tenant discovery and vacancy listing section', page: '/property-management' },
  'property-management-create-listing-btn': { selector: '[data-voice-id="property-management-create-listing-btn"]', description: 'Create listing button', page: '/property-management' },
  'property-management-listing-title-input': { selector: '[data-voice-id="property-management-listing-title-input"]', description: 'Listing title input', page: '/property-management' },
  'property-management-listing-description-input': { selector: '[data-voice-id="property-management-listing-description-input"]', description: 'Listing description input', page: '/property-management' },
  'property-management-listing-rent-input': { selector: '[data-voice-id="property-management-listing-rent-input"]', description: 'Listing monthly rent input', page: '/property-management' },
  'property-management-listing-sqft-input': { selector: '[data-voice-id="property-management-listing-sqft-input"]', description: 'Listing square footage input', page: '/property-management' },
  'property-management-listing-bedrooms-input': { selector: '[data-voice-id="property-management-listing-bedrooms-input"]', description: 'Listing bedrooms input', page: '/property-management' },
  'property-management-listing-bathrooms-input': { selector: '[data-voice-id="property-management-listing-bathrooms-input"]', description: 'Listing bathrooms input', page: '/property-management' },
  'property-management-publish-listing-btn': { selector: '[data-voice-id="property-management-publish-listing-btn"]', description: 'Create and publish listing button', page: '/property-management' },
  'property-management-create-first-listing-btn': { selector: '[data-voice-id="property-management-create-first-listing-btn"]', description: 'Create first listing button', page: '/property-management' },
  'property-management-payment-request-modal-overlay': { selector: '[data-voice-id="property-management-payment-request-modal-overlay"]', description: 'Payment request dialog overlay', page: '/property-management' },
  'property-management-payment-request-modal': { selector: '[data-voice-id="property-management-payment-request-modal"]', description: 'Payment request dialog', page: '/property-management' },
  'property-management-close-payment-request-btn': { selector: '[data-voice-id="property-management-close-payment-request-btn"]', description: 'Close payment request dialog button', page: '/property-management' },
  'property-management-payment-tenant-name-input': { selector: '[data-voice-id="property-management-payment-tenant-name-input"]', description: 'Payment request tenant name input', page: '/property-management' },
  'property-management-payment-tenant-email-input': { selector: '[data-voice-id="property-management-payment-tenant-email-input"]', description: 'Payment request tenant email input', page: '/property-management' },
  'property-management-maintenance-panel': { selector: '[data-voice-id="property-management-maintenance-panel"]', description: 'Maintenance workspace', page: '/property-management' },
  'property-management-maintenance-overview': { selector: '[data-voice-id="property-management-maintenance-overview"]', description: 'Maintenance overview section', page: '/property-management' },
  'property-management-maintenance-log': { selector: '[data-voice-id="property-management-maintenance-log"]', description: 'Maintenance request log', page: '/property-management' },
  'property-management-trusted-providers': { selector: '[data-voice-id="property-management-trusted-providers"]', description: 'Trusted providers section', page: '/property-management' },
  'property-management-maintenance-calls': { selector: '[data-voice-id="property-management-maintenance-calls"]', description: 'Maintenance call workflow section', page: '/property-management' },
  
  // Portfolio Page Elements
  'add-property-btn': { selector: '[data-voice-id="add-property-btn"]', description: 'Button to add a new property', page: '/portfolio' },
  'property-list': { selector: '[data-voice-id="property-list"]', description: 'List of your properties', page: '/portfolio' },
  'tenant-section': { selector: '[data-voice-id="tenant-section"]', description: 'Section showing tenant information', page: '/portfolio' },
  'maintenance-section': { selector: '[data-voice-id="maintenance-section"]', description: 'Maintenance requests and history', page: '/portfolio' },
  'maintenance-log': { selector: '[data-voice-id="maintenance-log"]', description: 'Maintenance history log', page: '/portfolio' },
  'add-tenant-btn': { selector: '[data-voice-id="add-tenant-btn"]', description: 'Button to add a new tenant', page: '/portfolio' },
  'edit-tenant-btn': { selector: '[data-voice-id="edit-tenant-btn"]', description: 'Button to edit tenant details', page: '/portfolio' },
  'messaging-modal-btn': { selector: '[data-voice-id="messaging-modal-btn"]', description: 'Button to open messaging', page: '/portfolio' },
  'create-listing-btn': { selector: '[data-voice-id="create-listing-btn"]', description: 'Button to create rental listing', page: '/portfolio' },
  'collect-payment-btn': { selector: '[data-voice-id="collect-payment-btn"]', description: 'Button to collect rent payment', page: '/portfolio' },
  'add-maintenance-btn': { selector: '[data-voice-id="add-maintenance-btn"]', description: 'Button to add maintenance request', page: '/portfolio' },
  'quickbooks-sync-btn': { selector: '[data-voice-id="quickbooks-sync-btn"]', description: 'Button to sync with QuickBooks', page: '/portfolio' },
  'credit-check-btn': { selector: '[data-voice-id="credit-check-btn"]', description: 'Button to run credit check', page: '/portfolio' },
  'background-check-btn': { selector: '[data-voice-id="background-check-btn"]', description: 'Button to run background check', page: '/portfolio' },
  'find-provider-btn': { selector: '[data-voice-id="find-provider-btn"]', description: 'Button to find service provider', page: '/portfolio' },
  'ai-call-btn': { selector: '[data-voice-id="ai-call-btn"]', description: 'Button to initiate AI call', page: '/portfolio' },
  'attom-data-btn': { selector: '[data-voice-id="attom-data-btn"]', description: 'Button to view ATTOM property data', page: '/portfolio' },
  'property-card': { selector: '[data-voice-id="property-card"]', description: 'Property card with details', page: '/portfolio' },
  'tenant-card': { selector: '[data-voice-id="tenant-card"]', description: 'Tenant card with details', page: '/portfolio' },
  'lease-info': { selector: '[data-voice-id="lease-info"]', description: 'Lease information section', page: '/portfolio' },
  'rent-roll': { selector: '[data-voice-id="rent-roll"]', description: 'Rent roll summary', page: '/portfolio' },
  
  // Portfolio Form Inputs
  'property-address-input': { selector: '[data-voice-id="property-address-input"]', description: 'Property address input field', page: '/portfolio' },
  'property-value-input': { selector: '[data-voice-id="property-value-input"]', description: 'Property value input field', page: '/portfolio' },
  'property-rent-input': { selector: '[data-voice-id="property-rent-input"]', description: 'Monthly rent input field', page: '/portfolio' },
  'tenant-name-input': { selector: '[data-voice-id="tenant-name-input"]', description: 'Tenant name input field', page: '/portfolio' },
  'tenant-email-input': { selector: '[data-voice-id="tenant-email-input"]', description: 'Tenant email input field', page: '/portfolio' },
  'tenant-phone-input': { selector: '[data-voice-id="tenant-phone-input"]', description: 'Tenant phone input field', page: '/portfolio' },
  'lease-start-input': { selector: '[data-voice-id="lease-start-input"]', description: 'Lease start date input', page: '/portfolio' },
  'lease-end-input': { selector: '[data-voice-id="lease-end-input"]', description: 'Lease end date input', page: '/portfolio' },
  'save-property-btn': { selector: '[data-voice-id="save-property-btn"]', description: 'Save property button', page: '/portfolio' },
  'save-tenant-btn': { selector: '[data-voice-id="save-tenant-btn"]', description: 'Save tenant button', page: '/portfolio' },
  
  // Search Page Elements
  'property-search-box': { selector: '[data-voice-id="property-search-box"]', description: 'Individual Property Analysis button', page: '/search' },
  'advanced-analysis-btn': { selector: '[data-voice-id="advanced-analysis-btn"]', description: 'Advanced Individual Property Analysis button', page: '/search' },
  'analysis-address-input': { selector: '[data-voice-id="analysis-address-input"]', description: 'Address input field for property analysis', page: '/search' },
  'analyze-button': { selector: '[data-voice-id="analyze-button"]', description: 'Button to run the property analysis', page: '/search' },
  'ai-analysis-btn': { selector: '[data-voice-id="ai-analysis-btn"]', description: 'AI analysis overlay button', page: '/search' },
  'street-view-btn': { selector: '[data-voice-id="street-view-btn"]', description: 'Google Street View button', page: '/search' },
  'map-container': { selector: '[data-voice-id="map-container"]', description: 'Interactive property map', page: '/search' },
  'search-results': { selector: '[data-voice-id="search-results"]', description: 'Property search results list', page: '/search' },
  'property-details-panel': { selector: '[data-voice-id="property-details-panel"]', description: 'Property details panel', page: '/search' },
  'environmental-results': { selector: '[data-voice-id="environmental-results"]', description: 'Environmental risk analysis results', page: '/search' },
  'comparable-sales': { selector: '[data-voice-id="comparable-sales"]', description: 'Comparable sales section', page: '/search' },
  'investment-metrics': { selector: '[data-voice-id="investment-metrics"]', description: 'Investment metrics and analysis', page: '/search' },
  
  // Net Worth Page Elements
  'add-asset-btn': { selector: '[data-voice-id="add-asset-btn"]', description: 'Button to add stocks, crypto, or other assets', page: '/net-worth' },
  'update-prices-btn': { selector: '[data-voice-id="update-prices-btn"]', description: 'Button to refresh stock prices', page: '/net-worth' },
  'portfolio-chart': { selector: '[data-voice-id="portfolio-chart"]', description: 'Chart showing portfolio value over time', page: '/net-worth' },
  'allocation-chart': { selector: '[data-voice-id="allocation-chart"]', description: 'Pie chart showing asset allocation', page: '/net-worth' },
  'total-net-worth': { selector: '[data-voice-id="total-net-worth"]', description: 'Total net worth display', page: '/net-worth' },
  'stock-list': { selector: '[data-voice-id="stock-list"]', description: 'List of stocks and investments', page: '/net-worth' },
  'property-equity': { selector: '[data-voice-id="property-equity"]', description: 'Property equity breakdown', page: '/net-worth' },
  'asset-ticker-input': { selector: '[data-voice-id="asset-ticker-input"]', description: 'Stock ticker input field', page: '/net-worth' },
  'asset-shares-input': { selector: '[data-voice-id="asset-shares-input"]', description: 'Number of shares input', page: '/net-worth' },
  'asset-cost-input': { selector: '[data-voice-id="asset-cost-input"]', description: 'Cost basis input field', page: '/net-worth' },
  
  // Market Data Page Elements
  'mortgage-rate-detail': { selector: '[data-voice-id="mortgage-rate-detail"]', description: 'Current 30-year fixed mortgage rate', page: '/market-data' },
  'treasury-yields': { selector: '[data-voice-id="treasury-yields"]', description: 'Treasury yield data', page: '/market-data' },
  'fed-meeting-summary': { selector: '[data-voice-id="fed-meeting-summary"]', description: 'Latest Federal Reserve meeting summary', page: '/market-data' },
  'market-overview': { selector: '[data-voice-id="market-overview"]', description: 'Housing market overview', page: '/market-data' },
  'rate-history-chart': { selector: '[data-voice-id="rate-history-chart"]', description: 'Mortgage rate history chart', page: '/market-data' },
  'economic-indicators': { selector: '[data-voice-id="economic-indicators"]', description: 'Economic indicators section', page: '/market-data' },
  
  // Sensors Page Elements
  'sensor-dashboard': { selector: '[data-voice-id="sensor-dashboard"]', description: 'Dashboard with all connected sensors', page: '/sensors' },
  'add-sensor-btn': { selector: '[data-voice-id="add-sensor-btn"]', description: 'Button to add a new sensor', page: '/sensors' },
  'sensor-list': { selector: '[data-voice-id="sensor-list"]', description: 'List of connected sensors', page: '/sensors' },
  'sensor-readings': { selector: '[data-voice-id="sensor-readings"]', description: 'Current sensor readings', page: '/sensors' },
  'alert-history': { selector: '[data-voice-id="alert-history"]', description: 'Sensor alert history', page: '/sensors' },
  'sensor-tab-overview': { selector: '[data-voice-id="sensor-tab-overview"]', description: 'Predictive Maintenance Overview tab', page: '/sensors' },
  'sensor-tab-alerts': { selector: '[data-voice-id="sensor-tab-alerts"]', description: 'Predictive Maintenance Alerts tab', page: '/sensors' },
  'sensor-tab-analytics': { selector: '[data-voice-id="sensor-tab-analytics"]', description: 'Predictive Maintenance Analytics tab', page: '/sensors' },
  'sensor-analytics-content': { selector: '[data-voice-id="sensor-analytics-content"]', description: 'Analytics charts and risk layers', page: '/sensors' },
  'sensor-layer-conditions': { selector: '[data-voice-id="sensor-layer-conditions"]', description: 'Conditions analytics layer', page: '/sensors' },
  'sensor-layer-mold': { selector: '[data-voice-id="sensor-layer-mold"]', description: 'Mold analytics layer', page: '/sensors' },
  'sensor-layer-freeze': { selector: '[data-voice-id="sensor-layer-freeze"]', description: 'Freeze analytics layer', page: '/sensors' },
  'sensor-layer-insulation': { selector: '[data-voice-id="sensor-layer-insulation"]', description: 'Insulation analytics layer', page: '/sensors' },
  
  // Flood Sensors Page Elements
  'flood-sensor-list': { selector: '[data-voice-id="flood-sensor-list"]', description: 'List of Shelly flood sensors', page: '/flood-sensors' },
  'flood-alert-settings': { selector: '[data-voice-id="flood-alert-settings"]', description: 'Flood alert settings', page: '/flood-sensors' },
  'connect-shelly-btn': { selector: '[data-voice-id="connect-shelly-btn"]', description: 'Connect Shelly sensor button', page: '/flood-sensors' },
  
  // Renovations Page Elements
  'renovation-suggestions': { selector: '[data-voice-id="renovation-suggestions"]', description: 'AI-suggested renovations', page: '/renovations' },
  'renovation-planner-btn': { selector: '[data-voice-id="renovation-planner-btn"]', description: '3D renovation planning tool', page: '/renovations' },
  'renovation-list': { selector: '[data-voice-id="renovation-list"]', description: 'List of renovation items', page: '/renovations' },
  'renovation-detail-btn': { selector: '[data-voice-id="renovation-detail-btn"]', description: 'View renovation details', page: '/renovations' },
  'ai-preview-btn': { selector: '[data-voice-id="ai-preview-btn"]', description: 'AI renovation preview button', page: '/renovations' },
  'marketplace-post-btn': { selector: '[data-voice-id="marketplace-post-btn"]', description: 'Post to contractor marketplace', page: '/renovations' },
  'renovation-roi': { selector: '[data-voice-id="renovation-roi"]', description: 'Renovation ROI analysis', page: '/renovations' },
  '3d-scan-viewer': { selector: '[data-voice-id="3d-scan-viewer"]', description: '3D scan viewer', page: '/renovations' },
  
  // Room Scanner Page Elements
  'start-scan-btn': { selector: '[data-voice-id="start-scan-btn"]', description: 'Start new room scan button', page: '/room-scanner' },
  'scan-preview': { selector: '[data-voice-id="scan-preview"]', description: 'Scan preview window', page: '/room-scanner' },
  'process-scan-btn': { selector: '[data-voice-id="process-scan-btn"]', description: 'Process depth maps button', page: '/room-scanner' },
  'scan-list': { selector: '[data-voice-id="scan-list"]', description: 'List of saved scans', page: '/room-scanner' },
  
  // Absentee Search Page Elements
  'absentee-search-input': { selector: '[data-voice-id="absentee-search-input"]', description: 'Absentee owner search input', page: '/absentee-search' },
  'absentee-results': { selector: '[data-voice-id="absentee-results"]', description: 'Absentee owner search results', page: '/absentee-search' },
  'generate-letter-btn': { selector: '[data-voice-id="generate-letter-btn"]', description: 'Generate outreach letter button', page: '/absentee-search' },
  
  // Tenant Dashboard Elements
  'submit-maintenance-btn': { selector: '[data-voice-id="submit-maintenance-btn"]', description: 'Submit maintenance request button', page: '/tenant/dashboard' },
  'contact-landlord-btn': { selector: '[data-voice-id="contact-landlord-btn"]', description: 'Contact landlord button', page: '/tenant/dashboard' },
  'pay-rent-btn': { selector: '[data-voice-id="pay-rent-btn"]', description: 'Pay rent button', page: '/tenant/dashboard' },
  'lease-details': { selector: '[data-voice-id="lease-details"]', description: 'Lease details section', page: '/tenant/dashboard' },
  'payment-history': { selector: '[data-voice-id="payment-history"]', description: 'Payment history section', page: '/tenant/dashboard' },
  'maintenance-status': { selector: '[data-voice-id="maintenance-status"]', description: 'Maintenance request status', page: '/tenant/dashboard' },
  
  // Contractor Marketplace Elements
  'view-3d-btn': { selector: '[data-voice-id="view-3d-btn"]', description: 'View 3D model button', page: '/contractor/marketplace' },
  'submit-bid-btn': { selector: '[data-voice-id="submit-bid-btn"]', description: 'Submit bid button', page: '/contractor/marketplace' },
  'my-bids-btn': { selector: '[data-voice-id="my-bids-btn"]', description: 'View my bids button', page: '/contractor/marketplace' },
  'job-list': { selector: '[data-voice-id="job-list"]', description: 'List of available jobs', page: '/contractor/marketplace' },
  'bid-amount-input': { selector: '[data-voice-id="bid-amount-input"]', description: 'Bid amount input field', page: '/contractor/marketplace' },
  'bid-timeline-input': { selector: '[data-voice-id="bid-timeline-input"]', description: 'Project timeline input', page: '/contractor/marketplace' },
  
  // Insurance Discount Page Elements
  'insurance-info': { selector: '[data-voice-id="insurance-info"]', description: 'Insurance discount information', page: '/insurance-discount' },
  'continue-insurer-btn': { selector: '[data-voice-id="continue-insurer-btn"]', description: 'Continue to insurer selection', page: '/insurance-discount' },
  'insurer-list': { selector: '[data-voice-id="insurer-list"]', description: 'List of insurance providers', page: '/insurance-discount/select-insurer' },
  'send-email-btn': { selector: '[data-voice-id="send-email-btn"]', description: 'Send insurance email button', page: '/insurance-discount/generate-request' },
  'download-certificate-btn': { selector: '[data-voice-id="download-certificate-btn"]', description: 'Download IoT certificate', page: '/insurance-discount/certificate' },
  
  // Profile Page Elements
  'profile-form': { selector: '[data-voice-id="profile-form"]', description: 'Profile settings form', page: '/profile' },
  'profile-name-input': { selector: '[data-voice-id="profile-name-input"]', description: 'Profile name input', page: '/profile' },
  'profile-email-input': { selector: '[data-voice-id="profile-email-input"]', description: 'Profile email input', page: '/profile' },
  'save-profile-btn': { selector: '[data-voice-id="save-profile-btn"]', description: 'Save profile button', page: '/profile' },
  'notification-settings': { selector: '[data-voice-id="notification-settings"]', description: 'Notification settings', page: '/profile' },
  
  // Voice AI Elements
  'voice-ai-btn': { selector: '[data-voice-id="voice-ai-btn"]', description: 'Voice AI assistant button' },
  'voice-ai-panel': { selector: '[data-voice-id="voice-ai-panel"]', description: 'Voice AI assistant panel' },
  
  // Portfolio Filter Buttons
  'filter-personal-btn': { selector: '[data-voice-id="filter-personal-btn"]', description: 'Filter for personal properties', page: '/portfolio' },
  'filter-investment-btn': { selector: '[data-voice-id="filter-investment-btn"]', description: 'Filter for investment properties', page: '/portfolio' },
  'filter-combined-btn': { selector: '[data-voice-id="filter-combined-btn"]', description: 'Filter for combined holdings', page: '/portfolio' },
  
  // Tenant Form Buttons
  'cancel-add-tenant-btn': { selector: '[data-voice-id="cancel-add-tenant-btn"]', description: 'Cancel adding tenant', page: '/portfolio' },
  'submit-add-tenant-btn': { selector: '[data-voice-id="submit-add-tenant-btn"]', description: 'Submit add tenant form', page: '/portfolio' },
  'cancel-edit-tenant-btn': { selector: '[data-voice-id="cancel-edit-tenant-btn"]', description: 'Cancel editing tenant', page: '/portfolio' },
  'export-tenants-btn': { selector: '[data-voice-id="export-tenants-btn"]', description: 'Export tenant list', page: '/portfolio' },
  
  // Net Worth Tab Buttons
  'tab-portfolio-btn': { selector: '[data-voice-id="tab-portfolio-btn"]', description: 'Portfolio value tab', page: '/net-worth' },
  'tab-allocation-btn': { selector: '[data-voice-id="tab-allocation-btn"]', description: 'Allocation tab', page: '/net-worth' },
  
  // Chart Expand Buttons
  'expand-price-history-btn': { selector: '[data-voice-id="expand-price-history-btn"]', description: 'Expand price history chart', page: '/portfolio' },
  
  // Absentee Search Buttons
  'search-absentee-btn': { selector: '[data-voice-id="search-absentee-btn"]', description: 'Search absentee owners', page: '/absentee-search' },
  'save-leads-btn': { selector: '[data-voice-id="save-leads-btn"]', description: 'Save leads to database', page: '/absentee-search' },
  'export-leads-btn': { selector: '[data-voice-id="export-leads-btn"]', description: 'Export leads to CSV', page: '/absentee-search' },
  
  // Logout Buttons
  'logout-btn': { selector: '[data-voice-id="logout-btn"]', description: 'Logout from tenant dashboard', page: '/tenant/dashboard' },
  'contractor-logout-btn': { selector: '[data-voice-id="contractor-logout-btn"]', description: 'Logout from contractor marketplace', page: '/contractor/marketplace' },
  
  // Lease Builder Buttons
  'generate-lease-btn': { selector: '[data-voice-id="generate-lease-btn"]', description: 'Generate lease agreement', page: '/portfolio' },
  'edit-lease-btn': { selector: '[data-voice-id="edit-lease-btn"]', description: 'Edit lease details', page: '/portfolio' },
  'copy-lease-btn': { selector: '[data-voice-id="copy-lease-btn"]', description: 'Copy lease to clipboard', page: '/portfolio' },
  'download-lease-btn': { selector: '[data-voice-id="download-lease-btn"]', description: 'Download lease file', page: '/portfolio' },
  
  // Contractor Marketplace Buttons  
  'place-bid-btn': { selector: '[data-voice-id="place-bid-btn"]', description: 'Open place bid modal', page: '/contractor/marketplace' },
  
  // Renovation Buttons
  'analyze-ai-btn': { selector: '[data-voice-id="analyze-ai-btn"]', description: 'Analyze with AI', page: '/portfolio' },
  'rerun-analysis-btn': { selector: '[data-voice-id="rerun-analysis-btn"]', description: 'Re-run AI analysis', page: '/portfolio' },
  'export-renovations-btn': { selector: '[data-voice-id="export-renovations-btn"]', description: 'Export renovation data', page: '/portfolio' },
  
  // Property Analysis
  'analyze-property-btn': { selector: '[data-voice-id="analyze-property-btn"]', description: 'Analyze property button', page: '/search' },
};
class WebsiteControlService {
  private actionHandlers: Map<string, (params?: Record<string, any>) => void> = new Map();
  private activeWorkflow: WorkflowDefinition | null = null;
  private currentStepIndex: number = 0;
  private onNavigate: ((route: string) => void) | null = null;
  private onHighlight: ((voiceId: string, description: string, duration?: number) => void) | null = null;
  private onSpeak: ((text: string) => void) | null = null;

  private emitActionProgress(event: WebsiteActionProgressEvent) {
    if (typeof window === 'undefined') {
      return;
    }

    window.dispatchEvent(new CustomEvent<WebsiteActionProgressEvent>('houseyield:action-progress', {
      detail: event,
    }));
  }

  private buildActionProgressSteps(action: ControlAction) {
    if (action.progressSteps?.length) {
      return action.progressSteps;
    }

    const steps = ['Review your request'];
    if (action.requiresNavigation || action.route) {
      const destination = (action.requiresNavigation || action.route || '')
        .replace(/^\//, '')
        .split('?')[0]
        .replace(/-/g, ' ');
      steps.push(`Open ${destination || 'the right workspace'}`);
    }
    steps.push(`Complete ${action.name.toLowerCase()}`);
    steps.push('Ready for your review');
    return steps;
  }

  private async pauseBetweenSteps(ms = 550) {
    // Short, readable beat between checklist milestones. Long enough that each
    // step is visibly checked off, short enough to never feel like stalling.
    // Real work (backend calls) provides its own natural duration.
    await new Promise(resolve => setTimeout(resolve, Math.min(ms, 700)));
  }

  /**
   * Build a property-aware management route when the backend did not return one
   * (or when falling back to the on-page handler).
   */
  private buildNavigationRoute(action: ControlAction, params?: Record<string, any>): string | null {
    const base = action.requiresNavigation || action.route || null;
    if (!base) return null;

    const propertyId = params?.propertyId ? String(params.propertyId) : '';
    const propertyAddress = params?.propertyAddress || params?.address || params?.location
      ? String(params?.propertyAddress || params?.address || params?.location)
      : '';
    const documentId = params?.documentId ? String(params.documentId) : '';
    const workspace = params?.workspace ? String(params.workspace) : '';
    if (!propertyId && !propertyAddress && !documentId && !action.tab && !workspace) {
      return base;
    }

    try {
      const url = new URL(base, typeof window !== 'undefined' ? window.location.origin : 'https://houseyield.local');
      if (action.tab && !url.searchParams.get('tab')) {
        url.searchParams.set('tab', action.tab);
      }
      if (propertyId) url.searchParams.set('property', propertyId);
      if (propertyAddress) url.searchParams.set('address', propertyAddress);
      if (documentId) url.searchParams.set('documentId', documentId);
      if (workspace) url.searchParams.set('workspace', workspace);
      return `${url.pathname}${url.search}`;
    } catch {
      return base;
    }
  }

  private async waitForActionHandler(actionId: string, timeoutMs = 6000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const handler = this.actionHandlers.get(actionId);
      if (handler) {
        return handler;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return null;
  }

  private async waitForVoiceElement(voiceId: string, timeoutMs = 6000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const el = document.querySelector(`[data-voice-id="${voiceId}"]`);
      if (el instanceof HTMLElement) {
        return el;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return null;
  }

  /**
   * Initialize the service with navigation and highlight handlers
   */
  initialize(handlers: {
    navigate: (route: string) => void;
    highlight: (voiceId: string, description: string, duration?: number) => void;
    speak?: (text: string) => void;
  }) {
    this.onNavigate = handlers.navigate;
    this.onHighlight = handlers.highlight;
    this.onSpeak = handlers.speak || null;
  }

  /**
   * Register a custom action handler
   */
  registerAction(actionId: string, handler: (params?: Record<string, any>) => void) {
    this.actionHandlers.set(actionId, handler);
  }

  /**
   * Unregister an action handler
   */
  unregisterAction(actionId: string) {
    this.actionHandlers.delete(actionId);
  }

  /**
   * Find a registered action by its canonical id (e.g. add-property, create-lease-agreement).
   */
  findActionById(actionId: string): ControlAction | null {
    const normalized = actionId.toLowerCase().trim();
    const slug = normalized.replace(/\s+/g, '-');
    const spaced = normalized.replace(/[-_]+/g, ' ');

    for (const action of WEBSITE_ACTIONS) {
      const actionIdNorm = action.id.toLowerCase();
      if (
        actionIdNorm === normalized
        || actionIdNorm === slug
        || actionIdNorm.replace(/[-_]+/g, ' ') === spaced
      ) {
        return action;
      }
    }

    return null;
  }

  /**
   * Find matching action from user input
   */
  findAction(input: string): ControlAction | null {
    const byId = this.findActionById(input);
    if (byId) {
      return byId;
    }

    const normalizedInput = input.toLowerCase().trim();
    const matches: Array<{ action: ControlAction; keywordLength: number }> = [];

    for (const action of WEBSITE_ACTIONS) {
      for (const keyword of action.keywords) {
        const needle = keyword.toLowerCase();
        if (normalizedInput.includes(needle) || needle.includes(normalizedInput)) {
          matches.push({ action, keywordLength: needle.length });
          break;
        }
      }
    }

    if (!matches.length) return null;

    matches.sort((left, right) => {
      const leftBackend = left.action.executionMode ? 1 : 0;
      const rightBackend = right.action.executionMode ? 1 : 0;
      if (leftBackend !== rightBackend) return rightBackend - leftBackend;
      return right.keywordLength - left.keywordLength;
    });

    return matches[0].action;
  }

  /**
   * Find matching workflow from user input
   */
  findWorkflow(input: string): WorkflowDefinition | null {
    const normalizedInput = input.toLowerCase().trim();
    
    for (const workflow of WORKFLOWS) {
      for (const keyword of workflow.keywords) {
        if (normalizedInput.includes(keyword.toLowerCase())) {
          return workflow;
        }
      }
    }
    
    return null;
  }

  /**
   * Execute an action
   */
  async executeAction(action: ControlAction, params?: Record<string, any>): Promise<boolean | Record<string, any>> {
    console.log('[WebsiteControl] Executing action:', action.id, params);
    const requestId = String(
      params?.requestId
      || params?.idempotencyKey
      || globalThis.crypto?.randomUUID?.()
      || `${action.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const progressSteps = this.buildActionProgressSteps(action);
    const shouldEmitProgress = params?.silentProgress !== true;
    const stayOnCurrentPage = params?.stayOnCurrentPage === true;
    const emitProgress = (
      status: WebsiteActionProgressStatus,
      currentStep: number,
      error?: string,
      detailMessage?: string,
      extras: Partial<WebsiteActionProgressEvent> = {},
    ) => {
      if (!shouldEmitProgress) {
        return;
      }
      this.emitActionProgress({
        status,
        runId: extras.runId || requestId,
        actionId: action.id,
        title: extras.title || action.name,
        summary: extras.summary
          || (typeof params?.requestSummary === 'string' ? params.requestSummary : action.description),
        steps: progressSteps,
        currentStep: Math.min(currentStep, progressSteps.length - 1),
        error,
        detailMessage,
        result: extras.result,
        actions: extras.actions,
        artifacts: extras.artifacts,
        reuseMeta: extras.reuseMeta,
      });
    };

    const wantsBackend = action.executionMode === 'backend'
      || action.executionMode === 'backend_with_confirm'
      || action.executionMode === 'analysis';

    // Backend-first path: execute on the server, then navigate to the exact property/tab
    // returned by the backend (avoids opening Documents on the wrong property first).
    if (wantsBackend) {
      const documentCreate = isDocumentCreateAction(action);
      const workingStep = documentCreate
        ? Math.min(3, progressSteps.length - 2)
        : Math.min(2, progressSteps.length - 2);
      const finalizeStep = Math.min(workingStep + 1, progressSteps.length - 1);

      emitProgress('start', 0, undefined, 'Got it — starting this for you.');
      await this.pauseBetweenSteps(700);

      emitProgress(
        'step',
        1,
        undefined,
        stayOnCurrentPage
          ? 'Keeping this page open while I run the approved action…'
          : documentCreate
          ? 'Opening Documents on the right property so you can follow along…'
          : 'Opening the right workspace so you can follow along…',
      );

      // Navigate early for document creates so the owner sees the workspace while Gemini runs.
      if (!stayOnCurrentPage && documentCreate && action.requiresNavigation && this.onNavigate) {
        const earlyRoute = this.buildNavigationRoute(action, params);
        if (earlyRoute) {
          this.onNavigate(earlyRoute);
          await new Promise(resolve => setTimeout(resolve, 450));
        }
        // Open the on-page document generator so the owner sees the same UI context
        // the assistant is working in (property scoped), even while the backend drafts.
        try {
          window.sessionStorage.setItem('houseyield:document-action', JSON.stringify({
            action: 'create-lease-agreement',
            documentType: params?.documentType || params?.document_type || 'LEASE_AGREEMENT',
            propertyId: params?.propertyId,
            propertyAddress: params?.propertyAddress || params?.address || params?.location,
            tenantId: params?.tenantId,
            customInstructions: params?.customInstructions || params?.instructions,
            requestSummary: params?.requestSummary,
            // Backend owns generation — keep the modal open as visual context only.
            autoGenerate: false,
            followAlongOnly: true,
            createdAt: Date.now(),
          }));
          window.dispatchEvent(new CustomEvent('houseyield:document-action', {
            detail: {
              action: 'create-lease-agreement',
              documentType: params?.documentType || params?.document_type || 'LEASE_AGREEMENT',
              propertyId: params?.propertyId,
              propertyAddress: params?.propertyAddress || params?.address || params?.location,
              tenantId: params?.tenantId,
              customInstructions: params?.customInstructions || params?.instructions,
              requestSummary: params?.requestSummary,
              autoGenerate: false,
              followAlongOnly: true,
              createdAt: Date.now(),
            },
          }));
        } catch {
          // ignore storage / event failures
        }
      }
      await this.pauseBetweenSteps(650);

      if (documentCreate && progressSteps.length > 3) {
        emitProgress('step', 2, undefined, 'Loading property and tenant details…');
        await this.pauseBetweenSteps(550);
      }

      emitProgress(
        'step',
        workingStep,
        undefined,
        documentCreate
          ? 'Preparing your document draft with Gemini — this can take a minute…'
          : `Working on ${action.name.toLowerCase()} in the background…`,
      );

      try {
        const backend = await requestAssistantActionExecute({
          actionId: action.backendActionId || action.id,
          runId: requestId,
          requestId,
          idempotencyKey: requestId,
          parameters: {
            ...(params || {}),
            requestSummary: params?.requestSummary,
          },
        });

        const finalNav = stayOnCurrentPage
          ? null
          : backend.navigation?.route
            || (!documentCreate && action.requiresNavigation
              ? this.buildNavigationRoute(action, params)
              : null);
        if (finalNav && this.onNavigate) {
          this.onNavigate(finalNav);
          await new Promise(resolve => setTimeout(resolve, 250));
        }

        if (!backend.ok && !backend.needsInput) {
          emitProgress(
            'error',
            workingStep,
            backend.error || backend.summary || 'Action failed',
            backend.detailMessage || backend.error,
            {
              title: backend.title || action.name,
              summary: backend.summary || action.description,
              result: backend.result,
              actions: backend.actions,
              artifacts: backend.artifacts,
              reuseMeta: backend.reuseMeta,
            },
          );
          return backend;
        }

        if (finalizeStep < progressSteps.length - 1) {
          emitProgress('step', finalizeStep, undefined, backend.detailMessage || 'Preparing your result…', {
            title: backend.title || action.name,
            summary: backend.summary || action.description,
          });
          await this.pauseBetweenSteps(350);
        }

        emitProgress(
          'complete',
          progressSteps.length - 1,
          undefined,
          backend.detailMessage || (backend.reuseMeta?.reused ? `Reused prior result (${backend.reuseMeta.ageLabel || 'recent'}).` : 'Ready for your review.'),
          {
            title: backend.title || action.name,
            summary: backend.summary || action.description,
            result: backend.result,
            actions: backend.actions,
            artifacts: backend.artifacts,
            reuseMeta: backend.reuseMeta,
          },
        );
        return backend;
      } catch (error) {
        // Fall through to UI handlers if backend is unavailable.
        console.warn('[WebsiteControl] Backend action failed, falling back to UI handler:', error);
        emitProgress('step', workingStep, undefined, 'Backend path unavailable — trying the on-page workflow…');
        const fallbackRoute = stayOnCurrentPage ? null : this.buildNavigationRoute(action, params);
        if (fallbackRoute && this.onNavigate) {
          this.onNavigate(fallbackRoute);
          await new Promise(resolve => setTimeout(resolve, 350));
        }
      }
    }

    const handlerOwnsProgress = Boolean(action.progressSteps?.length) && !wantsBackend;

    if (!handlerOwnsProgress && !wantsBackend) {
      emitProgress('start', 0);
      await this.pauseBetweenSteps();
    }

    // Handle navigation if required
    if (!stayOnCurrentPage && action.requiresNavigation && this.onNavigate && !wantsBackend) {
      if (!handlerOwnsProgress) {
        emitProgress('step', 1, undefined, 'Opening the workspace…');
      }
      this.onNavigate(this.buildNavigationRoute(action, params) || action.requiresNavigation);
      await new Promise(resolve => setTimeout(resolve, 450));
      if (!handlerOwnsProgress) {
        await this.pauseBetweenSteps();
      }
    }

    // Handle route-based navigation
    if (!stayOnCurrentPage && action.category === 'navigation' && action.route && this.onNavigate) {
      emitProgress('step', 1, undefined, 'Navigating…');
      this.onNavigate(action.route);
      await this.pauseBetweenSteps();
      emitProgress('complete', progressSteps.length - 1, undefined, 'Ready.');
      return true;
    }

    // Check for registered custom handler
    const handler = await this.waitForActionHandler(action.id);
    if (handler) {
      const runningStep = Math.min(2, progressSteps.length - 2);
      if (!handlerOwnsProgress) {
        emitProgress('step', runningStep, undefined, `Running ${action.name.toLowerCase()}…`);
      }
      const succeeded = await Promise.resolve(handler(params)).then(() => true).catch((error: unknown) => {
        if (!handlerOwnsProgress) {
          emitProgress(
            'error',
            runningStep,
            error instanceof Error ? error.message : 'Action failed',
            error instanceof Error ? error.message : 'Action failed',
          );
        }
        return false;
      });
      if (!succeeded) {
        return false;
      }
      if (!action.progressSteps?.length || wantsBackend) {
        await this.pauseBetweenSteps();
        emitProgress('complete', progressSteps.length - 1, undefined, `${action.name} is ready.`);
      }
      return true;
    }
    
    // Highlight the element if we have a voiceId
    if (action.voiceId && this.onHighlight) {
      const element = UI_ELEMENTS[action.voiceId];
      this.onHighlight(action.voiceId, element?.description || action.description, 5000);
      emitProgress('step', Math.max(1, progressSteps.length - 2));
      
      // For modal/button actions, try to click the element
      if (action.category === 'modal' || action.category === 'button') {
        const el = await this.waitForVoiceElement(action.voiceId);
        if (el) {
          el.click();
          emitProgress('complete', progressSteps.length - 1);
          return true;
        }
      }
    }
    
    emitProgress('error', progressSteps.length - 1, `Could not find a handler or visible control for ${action.name}.`);
    return false;
  }

  /**
   * Start a multi-step workflow
   */
  async startWorkflow(workflow: WorkflowDefinition): Promise<void> {
    console.log('[WebsiteControl] Starting workflow:', workflow.id);
    this.activeWorkflow = workflow;
    this.currentStepIndex = 0;
    
    // Navigate if required
    if (workflow.requiredRoute && this.onNavigate) {
      this.onNavigate(workflow.requiredRoute);
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    
    // Execute first step
    await this.executeCurrentStep();
  }

  /**
   * Execute the current workflow step
   */
  private async executeCurrentStep(): Promise<void> {
    if (!this.activeWorkflow) return;
    
    const step = this.activeWorkflow.steps[this.currentStepIndex];
    if (!step) {
      this.activeWorkflow = null;
      return;
    }
    
    console.log('[WebsiteControl] Executing step:', step.id, step.description);
    
    // Speak the description
    if (this.onSpeak) {
      this.onSpeak(step.description);
    }
    
    // Execute step action
    switch (step.action) {
      case 'highlight':
        if (this.onHighlight) {
          this.onHighlight(step.voiceId, step.description, step.delay || 3000);
        }
        break;
        
      case 'click':
        if (this.onHighlight) {
          this.onHighlight(step.voiceId, step.description, 1500);
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
        const clickEl = document.querySelector(`[data-voice-id="${step.voiceId}"]`);
        if (clickEl && clickEl instanceof HTMLElement) {
          clickEl.click();
        }
        break;
        
      case 'input':
        if (this.onHighlight) {
          this.onHighlight(step.voiceId, step.description, 2000);
        }
        if (step.value) {
          const inputEl = document.querySelector(`[data-voice-id="${step.voiceId}"]`);
          if (inputEl && inputEl instanceof HTMLInputElement) {
            inputEl.focus();
            inputEl.value = step.value;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        break;
        
      case 'scroll':
        const scrollEl = document.querySelector(`[data-voice-id="${step.voiceId}"]`);
        if (scrollEl) {
          scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        break;
        
      case 'explain':
        if (this.onHighlight) {
          this.onHighlight(step.voiceId, step.description, step.delay || 4000);
        }
        break;
    }
  }

  /**
   * Advance to the next workflow step
   */
  async nextStep(): Promise<boolean> {
    if (!this.activeWorkflow) return false;
    
    this.currentStepIndex++;
    
    if (this.currentStepIndex >= this.activeWorkflow.steps.length) {
      this.activeWorkflow = null;
      this.currentStepIndex = 0;
      return false;
    }
    
    await this.executeCurrentStep();
    return true;
  }

  /**
   * Cancel the current workflow
   */
  cancelWorkflow(): void {
    this.activeWorkflow = null;
    this.currentStepIndex = 0;
  }

  /**
   * Check if a workflow is active
   */
  isWorkflowActive(): boolean {
    return this.activeWorkflow !== null;
  }

  /**
   * Get current step info
   */
  getCurrentStep(): ControlStep | null {
    if (!this.activeWorkflow) return null;
    return this.activeWorkflow.steps[this.currentStepIndex] || null;
  }

  /**
   * Get all available actions for a page
   */
  getActionsForPage(route: string): ControlAction[] {
    return WEBSITE_ACTIONS.filter(action => 
      action.category === 'navigation' || 
      action.requiresNavigation === route ||
      !action.requiresNavigation
    );
  }

  /**
   * Parse complex voice command into structured actions
   */
  parseVoiceCommand(input: string): {
    type: 'navigate' | 'action' | 'workflow' | 'highlight' | 'explain' | 'unknown';
    action?: ControlAction;
    workflow?: WorkflowDefinition;
    element?: string;
    params?: Record<string, any>;
  } {
    const normalizedInput = input.toLowerCase().trim();
    
    // Check for workflow triggers
    const workflow = this.findWorkflow(normalizedInput);
    if (workflow) {
      return { type: 'workflow', workflow };
    }
    
    // Check for specific actions
    const action = this.findAction(normalizedInput);
    if (action) {
      if (action.category === 'navigation') {
        return { type: 'navigate', action };
      }
      return { type: 'action', action };
    }
    
    // Check for highlight/explain requests
    const explainPatterns = [
      /show me (?:the |where |how )?(.+)/i,
      /where (?:is|can i find) (?:the )?(.+)/i,
      /what is (?:the )?(.+)/i,
      /explain (?:the )?(.+)/i,
      /highlight (?:the )?(.+)/i,
    ];
    
    for (const pattern of explainPatterns) {
      const match = normalizedInput.match(pattern);
      if (match) {
        const target = match[1].trim();
        // Try to find matching UI element
        for (const [key, element] of Object.entries(UI_ELEMENTS)) {
          if (element.description.toLowerCase().includes(target) ||
              key.toLowerCase().includes(target.replace(/\s+/g, '-'))) {
            return { type: 'highlight', element: key };
          }
        }
      }
    }
    
    return { type: 'unknown' };
  }
}

// Export singleton instance
export const websiteControl = new WebsiteControlService();
export default websiteControl;
