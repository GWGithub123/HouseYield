import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { websiteControl, WEBSITE_ACTIONS, WORKFLOWS, UI_ELEMENTS, type ControlAction, type WorkflowDefinition, type ControlStep, type WebsiteActionProgressEvent } from '../services/websiteControlService';
import { resolveAssistantPageRoute } from '../utils/assistantPageCapabilities';
import type {
  AssistantActionArtifact,
  AssistantActionResultPayload,
  AssistantPadAction,
  AssistantReuseMeta,
} from '../services/assistantActionResultTypes';
import { getOwnerFinanceAuthToken, buildOwnerFinanceUrl } from '../services/ownerFinanceApi';
import gmailService from '../services/gmailService';
import { auth } from '../config/firebase';
import { useAssistantActivity } from './AssistantActivityContext';
import { AssistantWorkPanel } from '../components/AssistantWorkPanel';

// Types for voice commands
export interface VoiceCommand {
  type: 'navigate' | 'action' | 'highlight' | 'explain' | 'workflow' | 'input' | 'click' | 'scroll';
  target?: string;
  action?: string;
  parameters?: Record<string, any>;
  highlightSelector?: string;
  explanation?: string;
  workflowId?: string;
  inputValue?: string;
  stepDescription?: string;
}

export interface HighlightedElement {
  selector: string;
  label?: string;
  description?: string;
  isActive?: boolean;
  showArrow?: boolean;
  pulseColor?: string;
}

export interface WorkflowState {
  isActive: boolean;
  workflow: WorkflowDefinition | null;
  currentStep: number;
  totalSteps: number;
}

interface ActionNotepadTask {
  actionId: string;
  title: string;
  summary: string;
  steps: string[];
  currentStep: number;
  status: 'running' | 'complete' | 'error';
  error?: string;
  detailMessage?: string;
  result?: AssistantActionResultPayload;
  actions?: AssistantPadAction[];
  artifacts?: AssistantActionArtifact[];
  reuseMeta?: AssistantReuseMeta;
  startedAt?: number;
  completedAt?: number;
}

interface ActionNotepadHistoryEntry {
  id: string;
  actionId: string;
  title: string;
  summary: string;
  status: 'complete' | 'error';
  detailMessage?: string;
  completedAt: number;
}

interface VoiceCommandContextType {
  // Navigation
  navigateTo: (page: string) => void;
  currentPage: string;
  
  // Actions
  executeAction: (action: string, parameters?: Record<string, any>) => void;
  executeActionAndWait: (action: string, parameters?: Record<string, any>) => Promise<Record<string, any> | boolean | null>;
  pendingAction: { action: string; parameters?: Record<string, any> } | null;
  clearPendingAction: () => void;
  
  // Highlighting
  highlightElement: (selector: string, label?: string, duration?: number) => void;
  highlightMultiple: (elements: { voiceId: string; label?: string }[], duration?: number) => void;
  highlightedElements: HighlightedElement[];
  clearHighlights: () => void;
  
  // Workflow control
  startWorkflow: (workflowId: string) => Promise<void>;
  nextWorkflowStep: () => Promise<boolean>;
  cancelWorkflow: () => void;
  workflowState: WorkflowState;
  
  // Click and interact
  clickElement: (voiceId: string) => boolean;
  setInputValue: (voiceId: string, value: string) => boolean;
  scrollToElement: (voiceId: string) => boolean;
  
  // Process voice command from AI
  processVoiceCommand: (command: VoiceCommand) => void;
  processMultipleCommands: (commands: VoiceCommand[]) => Promise<void>;
  
  // Register action handlers from different pages
  registerActionHandler: (actionName: string, handler: (params?: Record<string, any>) => void) => void;
  unregisterActionHandler: (actionName: string) => void;
  
  // Get available actions for current page
  getAvailableActions: () => ControlAction[];
  
  // Find action by natural language
  findActionByKeyword: (keyword: string) => ControlAction | null;
}

const VoiceCommandContext = createContext<VoiceCommandContextType | null>(null);

// Page navigation aliases live in assistantPageCapabilities (shared with Realtime tools).

// UI Element selectors for highlighting
export const UI_ELEMENT_MAPPINGS: Record<string, { selector: string; description: string }> = {
  // Net Worth Page
  'add asset button': { selector: '[data-voice-id="add-asset-btn"]', description: 'Click this button to add a new asset to your portfolio' },
  'add asset': { selector: '[data-voice-id="add-asset-btn"]', description: 'The Add Asset button opens a modal to add stocks, properties, or other assets' },
  'portfolio chart': { selector: '[data-voice-id="portfolio-chart"]', description: 'This chart shows your portfolio value over time' },
  'allocation chart': { selector: '[data-voice-id="allocation-chart"]', description: 'This pie chart shows how your assets are distributed' },
  'update prices': { selector: '[data-voice-id="update-prices-btn"]', description: 'Click to refresh stock prices with live market data' },
  'portfolio tab': { selector: '[data-voice-id="tab-portfolio-btn"]', description: 'Switch to portfolio value view' },
  'allocation tab': { selector: '[data-voice-id="tab-allocation-btn"]', description: 'Switch to allocation breakdown view' },
  
  // Portfolio Page
  'add property': { selector: '[data-voice-id="add-property-btn"]', description: 'Click to add a new property to your portfolio' },
  'property list': { selector: '[data-voice-id="property-list"]', description: 'Your list of managed properties' },
  'tenant section': { selector: '[data-voice-id="tenant-section"]', description: 'Manage your tenants and lease agreements here' },
  'maintenance section': { selector: '[data-voice-id="maintenance-section"]', description: 'Track and manage maintenance requests' },
  'add tenant': { selector: '[data-voice-id="add-tenant-btn"]', description: 'Click to add a new tenant' },
  'export tenants': { selector: '[data-voice-id="export-tenants-btn"]', description: 'Export your tenant list' },
  'screen applicant': { selector: '[data-voice-id="screen-applicant-btn"]', description: 'Run background check on applicant' },
  'create listing': { selector: '[data-voice-id="create-listing-btn"]', description: 'Create a rental listing' },
  'collect payment': { selector: '[data-voice-id="collect-payment-btn"]', description: 'Send payment link to tenant' },
  'save property': { selector: '[data-voice-id="save-property-btn"]', description: 'Save property changes' },
  'personal filter': { selector: '[data-voice-id="filter-personal-btn"]', description: 'Filter to show personal properties' },
  'investment filter': { selector: '[data-voice-id="filter-investment-btn"]', description: 'Filter to show investment properties' },
  'combined filter': { selector: '[data-voice-id="filter-combined-btn"]', description: 'Show all properties combined' },
  'street view': { selector: '[data-voice-id="street-view-btn"]', description: 'Open Google Street View' },
  'expand price history': { selector: '[data-voice-id="expand-price-history-btn"]', description: 'Expand price history chart' },

  // Property Management Page
  'property management navigation': { selector: '[data-voice-id="nav-property-management"]', description: 'Navigate to the Property Management workspace' },
  'property management header': { selector: '[data-voice-id="property-management-header"]', description: 'Header with property scope and workspace tabs' },
  'property selector': { selector: '[data-voice-id="property-management-property-select"]', description: 'Choose the active property for the management workspace' },
  'property management tabs': { selector: '[data-voice-id="property-management-tabs"]', description: 'Switch between documents, tenants, maintenance, bookkeeping, and tax' },
  'documents tab': { selector: '[data-voice-id="property-management-documents-tab"]', description: 'Open the documents workspace' },
  'property management tenants tab': { selector: '[data-voice-id="property-management-tenants-tab"]', description: 'Open the tenants workspace' },
  'property management maintenance tab': { selector: '[data-voice-id="property-management-maintenance-tab"]', description: 'Open the maintenance workspace' },
  'bookkeeping tab': { selector: '[data-voice-id="nav-bookkeeping"]', description: 'Open the bookkeeping workspace' },
  'bookkeeping': { selector: '[data-voice-id="nav-bookkeeping"]', description: 'Open the bookkeeping workspace' },
  'property management tax tab': { selector: '[data-voice-id="property-management-tax-tab"]', description: 'Open the tax workspace' },
  'finance snapshot': { selector: '[data-voice-id="property-management-finance-snapshot"]', description: 'Review top-line finance metrics for the active property' },
  'property management add tenant': { selector: '[data-voice-id="property-management-add-tenant-btn"]', description: 'Open tenant onboarding in Property Management' },
  'tenant screening': { selector: '[data-voice-id="property-management-screening"]', description: 'Tenant screening workspace with invite and application controls' },
  'property management screen applicant': { selector: '[data-voice-id="property-management-screen-applicant-btn"]', description: 'Open the screening form for a new applicant' },
  'payments workspace': { selector: '[data-voice-id="property-management-payments"]', description: 'Payments section for rent collection and payment requests' },
  'property management send payment request': { selector: '[data-voice-id="property-management-send-payment-request-btn"]', description: 'Open the payment request dialog' },
  'tenant discovery': { selector: '[data-voice-id="property-management-discovery"]', description: 'Vacancy listing and tenant discovery workflows' },
  'property management create listing': { selector: '[data-voice-id="property-management-create-listing-btn"]', description: 'Open the vacancy listing form' },
  'maintenance workspace': { selector: '[data-voice-id="property-management-maintenance-panel"]', description: 'Maintenance request, provider, and call workflows' },
  'maintenance request log': { selector: '[data-voice-id="property-management-maintenance-log"]', description: 'Maintenance request history and status log' },
  'trusted providers': { selector: '[data-voice-id="property-management-trusted-providers"]', description: 'Trusted providers and vendor recommendations' },
  'maintenance call system': { selector: '[data-voice-id="property-management-maintenance-calls"]', description: 'Call workflow for maintenance dispatch and follow-up' },
  
  // Search Page  
  'search box': { selector: '[data-voice-id="property-search-box"]', description: 'Enter an address to analyze a property' },
  'search input': { selector: '[data-voice-id="property-search-box"]', description: 'Type a property address here to get detailed analysis' },
  'address input': { selector: '[data-voice-id="property-search-box"]', description: 'Enter the property address you want to analyze' },
  
  // Market Data Page
  'mortgage rate': { selector: '[data-voice-id="mortgage-rate-detail"]', description: '30-year mortgage rate with historical trends and changes' },
  '30 year mortgage': { selector: '[data-voice-id="mortgage-rate-detail"]', description: 'Detailed 30-year fixed mortgage rate information' },
  'treasury yields': { selector: '[data-voice-id="treasury-yields"]', description: 'Treasury yields that influence mortgage rates' },
  
  // Absentee Search
  'search absentee': { selector: '[data-voice-id="search-absentee-btn"]', description: 'Search for absentee owners' },
  'save leads': { selector: '[data-voice-id="save-leads-btn"]', description: 'Save selected leads to database' },
  'export leads': { selector: '[data-voice-id="export-leads-btn"]', description: 'Export leads to CSV file' },
  
  // Tenant Dashboard
  'logout': { selector: '[data-voice-id="logout-btn"]', description: 'Log out of the tenant portal' },
  
  // Contractor Marketplace
  'contractor logout': { selector: '[data-voice-id="contractor-logout-btn"]', description: 'Log out of contractor portal' },
  
  // Common Elements
  'navigation': { selector: '[data-voice-id="main-nav"]', description: 'The main navigation menu to access different sections' },
  'sidebar': { selector: '[data-voice-id="sidebar"]', description: 'The sidebar menu with all app sections' },
  
  // Navigation Links
  'nav dashboard': { selector: '[data-voice-id="nav-dashboard"]', description: 'Navigate to dashboard' },
  'nav search': { selector: '[data-voice-id="nav-search"]', description: 'Navigate to property search' },
  'nav properties': { selector: '[data-voice-id="nav-portfolio"]', description: 'Navigate to properties' },
  'nav property management': { selector: '[data-voice-id="nav-property-management"]', description: 'Navigate to property management' },
  'nav management': { selector: '[data-voice-id="nav-property-management"]', description: 'Navigate to management' },
  'nav renovations': { selector: '[data-voice-id="nav-renovations"]', description: 'Navigate to renovations' },
  'nav portfolio': { selector: '[data-voice-id="nav-net-worth"]', description: 'Navigate to portfolio' },
  'nav net worth': { selector: '[data-voice-id="nav-net-worth"]', description: 'Navigate to net worth' },
  'nav saved': { selector: '[data-voice-id="nav-saved"]', description: 'Navigate to saved properties' },
  'nav absentee': { selector: '[data-voice-id="nav-absentee"]', description: 'Navigate to off-market leads' },
  'nav market data': { selector: '[data-voice-id="nav-market-data"]', description: 'Navigate to market data' },
  'nav sensors': { selector: '[data-voice-id="nav-sensors"]', description: 'Navigate to sensors' },
};

export const VoiceCommandProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { activeRun, dismissRun } = useAssistantActivity();
  
  const [highlightedElements, setHighlightedElements] = useState<HighlightedElement[]>([]);
  const [pendingAction, setPendingAction] = useState<{ action: string; parameters?: Record<string, any> } | null>(null);
  const [workflowState, setWorkflowState] = useState<WorkflowState>({
    isActive: false,
    workflow: null,
    currentStep: 0,
    totalSteps: 0
  });
  
  // Store action handlers from various pages
  const actionHandlersRef = useRef<Map<string, (params?: Record<string, any>) => void>>(new Map());
  
  // Highlight timeout refs
  const highlightTimeoutsRef = useRef<NodeJS.Timeout[]>([]);
  
  // Command queue for sequential execution
  const commandQueueRef = useRef<VoiceCommand[]>([]);
  const isProcessingQueueRef = useRef(false);

  // Initialize websiteControl service
  useEffect(() => {
    websiteControl.initialize({
      navigate: (route: string) => navigate(route),
      highlight: (voiceId: string, description: string, duration?: number) => {
        highlightByVoiceId(voiceId, description, duration);
      },
      speak: (text: string) => {
        // Dispatch event for TTS
        window.dispatchEvent(new CustomEvent('voice-speak', { detail: { text } }));
      }
    });
  }, [navigate]);

  // Navigate to a page by natural language name (React Router only — no hard reload).
  const navigateTo = useCallback((pageName: string) => {
    const normalizedName = pageName.toLowerCase().trim();

    // First check websiteControl for navigation actions
    const action = websiteControl.findAction(normalizedName);
    if (action?.route) {
      console.log('[VoiceCommand] Navigating via websiteControl to:', action.route);
      navigate(action.route);
      return;
    }

    const route = resolveAssistantPageRoute(pageName);
    if (route) {
      console.log('[VoiceCommand] Navigating via page capabilities to:', route);
      navigate(route);
      return;
    }

    console.warn('[VoiceCommand] Unknown page:', pageName);
  }, [navigate]);

  const emitAdHocActionProgress = useCallback((
    actionId: string,
    parameters: Record<string, any> | undefined,
    handler: (params?: Record<string, any>) => void,
  ) => {
    const title = actionId.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
    const summary = typeof parameters?.requestSummary === 'string'
      ? parameters.requestSummary
      : `Working on ${title.toLowerCase()}.`;
    const steps = ['Understand the request', 'Run the action', 'Confirm result'];

    const emit = (status: WebsiteActionProgressEvent['status'], currentStep: number, error?: string) => {
      window.dispatchEvent(new CustomEvent<WebsiteActionProgressEvent>('houseyield:action-progress', {
        detail: {
          status,
          actionId,
          title,
          summary,
          steps,
          currentStep,
          error,
        },
      }));
    };

    emit('start', 0);
    emit('step', 1);

    Promise.resolve(handler(parameters))
      .then(() => emit('complete', steps.length - 1))
      .catch((error: unknown) => {
        emit('error', 1, error instanceof Error ? error.message : 'Action failed');
      });
  }, []);

  // Execute an action
  const executeAction = useCallback((action: string, parameters?: Record<string, any>) => {
    const normalizedAction = action.toLowerCase().trim();
    console.log('[VoiceCommand] Executing action:', normalizedAction, parameters);

    // Always route registry actions through websiteControl so the task pad receives progress events.
    const controlAction =
      websiteControl.findActionById(normalizedAction)
      ?? websiteControl.findAction(normalizedAction);
    if (controlAction) {
      void websiteControl.executeAction(controlAction, parameters);
      return;
    }

    const handler = actionHandlersRef.current.get(normalizedAction);
    if (handler) {
      emitAdHocActionProgress(normalizedAction, parameters, handler);
      return;
    }

    // Store as pending action for the appropriate page component to handle
    setPendingAction({ action: normalizedAction, parameters });
    
    // Common actions that may require navigation first
    if (normalizedAction.includes('add property') || normalizedAction.includes('new property')) {
      navigate('/portfolio');
      setPendingAction({ action: 'open-add-property-modal', parameters });
    } else if (normalizedAction.includes('add asset') || normalizedAction.includes('add stock')) {
      navigate('/net-worth');
      setPendingAction({ action: 'open-add-asset-modal', parameters });
    } else if (normalizedAction.includes('search property') || normalizedAction.includes('analyze property')) {
      navigate('/search');
      if (parameters?.address) {
        setPendingAction({ action: 'search-property', parameters });
      }
    }
  }, [emitAdHocActionProgress, navigate]);

  const executeActionAndWait = useCallback(async (
    action: string,
    parameters?: Record<string, any>,
  ): Promise<Record<string, any> | boolean | null> => {
    const normalizedAction = action.toLowerCase().trim();
    const controlAction =
      websiteControl.findActionById(normalizedAction)
      ?? websiteControl.findAction(normalizedAction);

    if (controlAction) {
      return websiteControl.executeAction(controlAction, parameters);
    }

    const handler = actionHandlersRef.current.get(normalizedAction);
    if (handler) {
      emitAdHocActionProgress(normalizedAction, parameters, handler);
      return { ok: true, actionId: normalizedAction, summary: `Started ${normalizedAction}.` };
    }

    executeAction(normalizedAction, parameters);
    return { ok: true, actionId: normalizedAction, summary: `Queued ${normalizedAction}.` };
  }, [emitAdHocActionProgress, executeAction]);

  const clearPendingAction = useCallback(() => {
    setPendingAction(null);
  }, []);

  // Helper to highlight by voice ID
  const highlightByVoiceId = useCallback((voiceId: string, label?: string, duration: number = 5000) => {
    const selector = `[data-voice-id="${voiceId}"]`;
    const uiElement = UI_ELEMENTS[voiceId];
    const description = label || uiElement?.description || voiceId;
    
    setHighlightedElements(prev => {
      if (prev.some(el => el.selector === selector)) {
        return prev;
      }
      return [...prev, { selector, label: description, isActive: true, showArrow: true }];
    });
    
    const timeout = setTimeout(() => {
      setHighlightedElements(prev => prev.filter(el => el.selector !== selector));
    }, duration);
    
    highlightTimeoutsRef.current.push(timeout);
    
    // Scroll element into view
    const el = document.querySelector(selector);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  // Highlight an element on the page
  const highlightElement = useCallback((selector: string, label?: string, duration: number = 5000) => {
    // Check if it's a voice-id reference
    if (!selector.startsWith('[') && !selector.startsWith('.') && !selector.startsWith('#')) {
      highlightByVoiceId(selector, label, duration);
      return;
    }
    
    // Look up selector from UI mappings if it's a natural language name
    const normalizedSelector = selector.toLowerCase().trim();
    const mapping = UI_ELEMENT_MAPPINGS[normalizedSelector];
    const actualSelector = mapping?.selector || selector;
    const description = mapping?.description || label;
    
    // Add to highlighted elements
    setHighlightedElements(prev => {
      // Don't add duplicates
      if (prev.some(el => el.selector === actualSelector)) {
        return prev;
      }
      return [...prev, { selector: actualSelector, label: description, isActive: true, showArrow: true }];
    });
    
    // Auto-remove after duration
    const timeout = setTimeout(() => {
      setHighlightedElements(prev => prev.filter(el => el.selector !== actualSelector));
    }, duration);
    
    highlightTimeoutsRef.current.push(timeout);
  }, [highlightByVoiceId]);

  // Highlight multiple elements
  const highlightMultiple = useCallback((elements: { voiceId: string; label?: string }[], duration: number = 5000) => {
    elements.forEach(({ voiceId, label }) => {
      highlightByVoiceId(voiceId, label, duration);
    });
  }, [highlightByVoiceId]);

  const clearHighlights = useCallback(() => {
    // Clear all timeouts
    highlightTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
    highlightTimeoutsRef.current = [];
    setHighlightedElements([]);
  }, []);

  // Click an element by voice ID (with retry for elements that may not exist yet)
  const clickElement = useCallback((voiceId: string): boolean => {
    const el = document.querySelector(`[data-voice-id="${voiceId}"]`);
    if (el && el instanceof HTMLElement) {
      highlightByVoiceId(voiceId, 'Clicking...', 1500);
      setTimeout(() => {
        el.click();
      }, 500);
      return true;
    }
    
    // Element not found - retry up to 8 times (2 seconds total) for elements appearing after navigation
    console.warn('[VoiceCommand] Element not found for click:', voiceId, '- will retry...');
    let attempts = 0;
    const maxAttempts = 8;
    const retryInterval = setInterval(() => {
      attempts++;
      const retryEl = document.querySelector(`[data-voice-id="${voiceId}"]`);
      if (retryEl && retryEl instanceof HTMLElement) {
        clearInterval(retryInterval);
        console.log('[VoiceCommand] ✅ Element found after', attempts, 'retries:', voiceId);
        highlightByVoiceId(voiceId, 'Clicking...', 1500);
        setTimeout(() => {
          retryEl.click();
        }, 300);
      } else if (attempts >= maxAttempts) {
        clearInterval(retryInterval);
        console.error('[VoiceCommand] ❌ Element not found after', maxAttempts, 'retries:', voiceId);
      }
    }, 250);
    
    return false;
  }, [highlightByVoiceId]);

  // Set input value by voice ID
  const setInputValue = useCallback((voiceId: string, value: string): boolean => {
    const el = document.querySelector(`[data-voice-id="${voiceId}"]`);
    if (el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      highlightByVoiceId(voiceId, `Entering: "${value}"`, 2000);
      setTimeout(() => {
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, 500);
      return true;
    }
    console.warn('[VoiceCommand] Input element not found:', voiceId);
    return false;
  }, [highlightByVoiceId]);

  // Scroll to element by voice ID
  const scrollToElement = useCallback((voiceId: string): boolean => {
    const el = document.querySelector(`[data-voice-id="${voiceId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightByVoiceId(voiceId, undefined, 3000);
      return true;
    }
    return false;
  }, [highlightByVoiceId]);

  // Start a workflow
  const startWorkflow = useCallback(async (workflowId: string): Promise<void> => {
    const workflow = WORKFLOWS.find(w => w.id === workflowId);
    if (!workflow) {
      console.warn('[VoiceCommand] Workflow not found:', workflowId);
      return;
    }
    
    console.log('[VoiceCommand] Starting workflow:', workflow.name);
    
    // Navigate if required
    if (workflow.requiredRoute) {
      navigate(workflow.requiredRoute);
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    
    setWorkflowState({
      isActive: true,
      workflow,
      currentStep: 0,
      totalSteps: workflow.steps.length
    });
    
    // Execute first step
    const firstStep = workflow.steps[0];
    if (firstStep) {
      await executeWorkflowStep(firstStep);
    }
  }, [navigate]);

  // Execute a workflow step
  const executeWorkflowStep = useCallback(async (step: ControlStep): Promise<void> => {
    console.log('[VoiceCommand] Executing workflow step:', step.id, step.action);
    
    // Dispatch speak event for the step description
    window.dispatchEvent(new CustomEvent('voice-workflow-step', { 
      detail: { description: step.description, step } 
    }));
    
    switch (step.action) {
      case 'highlight':
        highlightByVoiceId(step.voiceId, step.description, step.delay || 3000);
        break;
        
      case 'click':
        highlightByVoiceId(step.voiceId, step.description, 1500);
        await new Promise(resolve => setTimeout(resolve, 1500));
        clickElement(step.voiceId);
        break;
        
      case 'input':
        if (step.value) {
          setInputValue(step.voiceId, step.value);
        } else {
          highlightByVoiceId(step.voiceId, step.description, step.delay || 2000);
        }
        break;
        
      case 'scroll':
        scrollToElement(step.voiceId);
        break;
        
      case 'explain':
        highlightByVoiceId(step.voiceId, step.description, step.delay || 4000);
        break;
        
      case 'wait':
        await new Promise(resolve => setTimeout(resolve, step.delay || 2000));
        break;
    }
  }, [highlightByVoiceId, clickElement, setInputValue, scrollToElement]);

  // Advance to next workflow step
  const nextWorkflowStep = useCallback(async (): Promise<boolean> => {
    if (!workflowState.isActive || !workflowState.workflow) {
      return false;
    }
    
    const nextIndex = workflowState.currentStep + 1;
    
    if (nextIndex >= workflowState.workflow.steps.length) {
      // Workflow complete
      setWorkflowState({
        isActive: false,
        workflow: null,
        currentStep: 0,
        totalSteps: 0
      });
      window.dispatchEvent(new CustomEvent('voice-workflow-complete'));
      return false;
    }
    
    setWorkflowState(prev => ({
      ...prev,
      currentStep: nextIndex
    }));
    
    const nextStep = workflowState.workflow.steps[nextIndex];
    await executeWorkflowStep(nextStep);
    return true;
  }, [workflowState, executeWorkflowStep]);

  // Cancel current workflow
  const cancelWorkflow = useCallback(() => {
    setWorkflowState({
      isActive: false,
      workflow: null,
      currentStep: 0,
      totalSteps: 0
    });
    clearHighlights();
  }, [clearHighlights]);

  // Get available actions for current page
  const getAvailableActions = useCallback((): ControlAction[] => {
    return websiteControl.getActionsForPage(location.pathname);
  }, [location.pathname]);

  // Find action by keyword
  const findActionByKeyword = useCallback((keyword: string): ControlAction | null => {
    return websiteControl.findAction(keyword);
  }, []);

  // Process a voice command from the AI
  const processVoiceCommand = useCallback((command: VoiceCommand) => {
    console.log('[VoiceCommand] Processing:', command);
    
    // Handle both server naming (voiceId/value) and client naming (target/inputValue)
    const targetId = (command as any).voiceId || command.target;
    const inputVal = (command as any).value || command.inputValue;
    
    switch (command.type) {
      case 'navigate':
        if (command.target) {
          navigateTo(command.target);
        }
        break;
        
      case 'action':
        if (command.action) {
          executeAction(command.action, command.parameters);
          // Also click the voiceId element if provided
          if ((command as any).voiceId) {
            setTimeout(() => clickElement((command as any).voiceId), 500);
          }
        }
        break;
        
      case 'highlight':
        if (command.highlightSelector || targetId) {
          highlightElement(command.highlightSelector || targetId, command.explanation);
        }
        break;
        
      case 'explain':
        // Highlight relevant UI element while explaining
        if (command.highlightSelector || targetId) {
          highlightElement(command.highlightSelector || targetId, command.explanation, 8000);
        }
        break;
        
      case 'workflow':
        if (command.workflowId) {
          startWorkflow(command.workflowId);
        }
        break;
        
      case 'click':
        if (targetId) {
          clickElement(targetId);
        }
        break;
        
      case 'input':
        if (targetId && inputVal) {
          setInputValue(targetId, inputVal);
        }
        break;
        
      case 'scroll':
        if (targetId) {
          scrollToElement(targetId);
        }
        break;
        
      default:
        console.warn('[VoiceCommand] Unknown command type:', command.type);
    }
  }, [navigateTo, executeAction, highlightElement, startWorkflow, clickElement, setInputValue, scrollToElement]);

  // Process multiple commands sequentially
  const processMultipleCommands = useCallback(async (commands: VoiceCommand[]): Promise<void> => {
    for (const command of commands) {
      processVoiceCommand(command);
      // Add delay between commands for visual feedback
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }, [processVoiceCommand]);

  // Register action handlers from page components
  const registerActionHandler = useCallback((actionName: string, handler: (params?: Record<string, any>) => void) => {
    actionHandlersRef.current.set(actionName.toLowerCase(), handler);
    // Also register with websiteControl
    websiteControl.registerAction(actionName.toLowerCase(), handler);
  }, []);

  const unregisterActionHandler = useCallback((actionName: string) => {
    actionHandlersRef.current.delete(actionName.toLowerCase());
    websiteControl.unregisterAction(actionName.toLowerCase());
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      highlightTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
    };
  }, []);

  const value: VoiceCommandContextType = {
    navigateTo,
    currentPage: location.pathname,
    executeAction,
    executeActionAndWait,
    pendingAction,
    clearPendingAction,
    highlightElement,
    highlightMultiple,
    highlightedElements,
    clearHighlights,
    startWorkflow,
    nextWorkflowStep,
    cancelWorkflow,
    workflowState,
    clickElement,
    setInputValue,
    scrollToElement,
    processVoiceCommand,
    processMultipleCommands,
    registerActionHandler,
    unregisterActionHandler,
    getAvailableActions,
    findActionByKeyword,
  };

  return (
    <VoiceCommandContext.Provider value={value}>
      {children}
      {/* Enhanced Highlight Overlay */}
      <HighlightOverlay elements={highlightedElements} />
      {/* Workflow Progress Indicator */}
      {workflowState.isActive && (
        <WorkflowProgressBar 
          currentStep={workflowState.currentStep}
          totalSteps={workflowState.totalSteps}
          workflowName={workflowState.workflow?.name || ''}
          onCancel={cancelWorkflow}
          onNext={nextWorkflowStep}
        />
      )}
      <AssistantWorkPanel
        run={activeRun}
        onClose={() => activeRun && dismissRun(activeRun.runId)}
        onAction={async (action, edits) => {
          if (action.kind === 'navigate' && action.route) {
            navigate(action.route);
            return;
          }
          if ((action.kind === 'open' || action.kind === 'download') && action.href) {
            await openAuthenticatedUrl(action.href, action.kind === 'download', action.payload?.filename as string | undefined);
            return;
          }
          if (action.kind === 'copy') {
            const fallback = activeRun?.result && 'content' in activeRun.result ? activeRun.result.content : '';
            await navigator.clipboard.writeText(String(action.payload?.text || fallback || ''));
            return;
          }
          const actionId = String(action.payload?.actionId || activeRun?.actionId || '');
          if (action.kind === 'send' && activeRun?.result?.type === 'message_draft') {
            const toEmail = String(action.payload?.toEmail || activeRun.result.toEmail || '');
            if (!toEmail) throw new Error('This draft has no recipient email.');
            const sent = await gmailService.sendMessage(toEmail, edits?.subject || activeRun.result.subject, edits?.body || activeRun.result.body);
            if (!sent.success) throw new Error(sent.error || 'Message could not be sent.');
            return;
          }
          if (actionId) {
            await websiteControl.executeAction(
              websiteControl.findActionById(actionId) || {
                id: actionId,
                name: actionId,
                description: actionId,
                category: 'data',
                keywords: [],
                executionMode: 'backend',
              },
              { ...(action.payload || {}), ...(edits?.fields || {}) },
            );
          }
        }}
      />
    </VoiceCommandContext.Provider>
  );
};

function formatMoney(value: number) {
  return `$${Math.round(Number(value) || 0).toLocaleString()}`;
}

async function openAuthenticatedUrl(url: string, download = false, filename?: string) {
  if (!url) return;
  if (url.startsWith('http') || url.startsWith('blob:') || url.startsWith('data:')) {
    if (download) {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename || 'download';
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.click();
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const resolvedUrl = buildOwnerFinanceUrl(url);
  const token = await getOwnerFinanceAuthToken();
  const response = await fetch(resolvedUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    let message = `Unable to open file (${response.status})`;
    if (contentType.includes('application/json')) {
      const payload = await response.json().catch(() => ({}));
      message = payload?.error || payload?.message || message;
    } else {
      const text = await response.text().catch(() => '');
      if (text) message = text.slice(0, 240);
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  if (download) {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename || 'download.pdf';
    anchor.click();
  } else {
    window.open(objectUrl, '_blank', 'noopener,noreferrer');
  }
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

const ActionNotepadModal: React.FC<{
  task: ActionNotepadTask;
  history: ActionNotepadHistoryEntry[];
  onDismiss: () => void;
  onNavigate: (route: string) => void;
  onRefreshAction: (actionId: string, parameters?: Record<string, any>) => void;
}> = ({ task, history, onDismiss, onNavigate, onRefreshAction }) => {
  const [draftSubject, setDraftSubject] = useState(
    task.result?.type === 'message_draft' ? task.result.subject : '',
  );
  const [draftBody, setDraftBody] = useState(
    task.result?.type === 'message_draft' ? task.result.body : '',
  );
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [needsInputValues, setNeedsInputValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (task.result?.type === 'message_draft') {
      setDraftSubject(task.result.subject);
      setDraftBody(task.result.body);
    }
  }, [task.actionId, task.result]);

  const completedStepCount = task.status === 'complete'
    ? task.steps.length
    : task.status === 'error'
      ? Math.max(task.currentStep, 1)
      : task.currentStep;
  // While running, count the active step as in-progress so the bar moves past prior steps
  // and the footer reflects the real stage (e.g. "Prepare document draft" during Gemini).
  const progress = task.steps.length > 0
    ? Math.round(
      (
        task.status === 'running'
          ? Math.min(task.currentStep + 0.55, task.steps.length - 0.05)
          : completedStepCount
      ) / task.steps.length * 100,
    )
    : 0;
  const activeStepLabel = task.steps[task.currentStep];
  const showResult = Boolean(task.result) && (task.status === 'complete' || task.status === 'error' || task.result?.type === 'needs_input');
  const isProcessing = task.status === 'running';

  const handlePadAction = async (action: AssistantPadAction) => {
    setActionBusy(action.id);
    setActionNote(null);
    try {
      if (action.kind === 'navigate' && action.route) {
        onNavigate(action.route);
        return;
      }

      if ((action.kind === 'open' || action.kind === 'download') && action.href) {
        await openAuthenticatedUrl(action.href, action.kind === 'download', action.payload?.filename as string | undefined);
        setActionNote(action.kind === 'download' ? 'Download started.' : 'Opened in a new tab.');
        return;
      }

      if (action.kind === 'copy') {
        const text = String(action.payload?.text || (task.result && 'content' in task.result ? task.result.content : '') || '');
        await navigator.clipboard.writeText(text);
        setActionNote('Copied to clipboard.');
        return;
      }

      if (action.kind === 'refresh') {
        const nextActionId = String(action.payload?.actionId || task.actionId);
        onRefreshAction(nextActionId, action.payload as Record<string, any>);
        return;
      }

      if (action.kind === 'send') {
        const channel = String(action.payload?.channel || (task.result?.type === 'message_draft' ? task.result.channel : '') || 'tenant_portal');
        const toEmail = String(action.payload?.toEmail || action.payload?.tenantEmail || (task.result?.type === 'message_draft' ? task.result.toEmail : '') || '');
        const subject = draftSubject || String(action.payload?.subject || '');
        const body = draftBody || String(action.payload?.body || '');
        const documentId = action.payload?.documentId ? String(action.payload.documentId) : '';
        const remindSignerId = action.payload?.remindSignerId ? String(action.payload.remindSignerId) : '';

        if (documentId && remindSignerId) {
          const token = await getOwnerFinanceAuthToken();
          const response = await fetch(buildOwnerFinanceUrl(`/api/documents/${encodeURIComponent(documentId)}/remind`), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ signerId: remindSignerId }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || 'Could not send signature reminder');
          }
          setActionNote('Signature reminder sent.');
          return;
        }

        if (documentId && !remindSignerId && !toEmail) {
          throw new Error('This document is missing the signer recipient. Open the document and add or fix the signer email before sending a reminder.');
        }

        if (channel === 'tenant_portal' || action.payload?.tenantId || !toEmail) {
          const token = await getOwnerFinanceAuthToken();
          const ownerId = auth.currentUser?.uid;
          if (!ownerId) {
            throw new Error('Sign in to send through the tenant portal.');
          }
          if (!action.payload?.tenantId && !toEmail) {
            throw new Error('Missing tenant for portal send. Ask the assistant to message a specific property/tenant.');
          }
          const response = await fetch(buildOwnerFinanceUrl('/api/owner/messages/send'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              ownerId,
              tenantId: action.payload?.tenantId || null,
              tenantEmail: toEmail,
              tenantName: action.payload?.tenantName || (task.result?.type === 'message_draft' ? task.result.toName : 'Tenant'),
              propertyId: action.payload?.propertyId || null,
              propertyAddress: action.payload?.propertyAddress || '',
              subject,
              message: body,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || 'Could not send via tenant portal');
          }
          setActionNote('Sent through the tenant portal. Your tenant will see it in their inbox.');
          return;
        }

        // Explicit email channel only — never default to mailto for tenant messaging.
        if (channel === 'email' || channel === 'gmail') {
          if (!toEmail) {
            throw new Error('This draft has no recipient email yet.');
          }

          if (gmailService.isUserSignedIn()) {
            const result = await gmailService.sendMessage(toEmail, subject, body);
            if (!result.success) {
              throw new Error(result.error || 'Gmail send failed');
            }
            setActionNote(`Sent to ${toEmail}.`);
            return;
          }

          window.location.href = `mailto:${encodeURIComponent(toEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
          setActionNote('Opened your email app with the draft filled in.');
          return;
        }

        throw new Error('Unsupported send channel. Use the tenant portal send button.');
      }

      if (action.kind === 'confirm' && action.payload?.actionId) {
        onRefreshAction(String(action.payload.actionId), action.payload as Record<string, any>);
      }
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setActionBusy(null);
    }
  };

  const submitNeedsInput = () => {
    onRefreshAction(task.actionId, {
      ...needsInputValues,
      requestSummary: task.summary,
    });
  };

  return (
    <div className="fixed bottom-5 right-5 z-[10002] w-[min(420px,calc(100vw-2rem))] max-h-[min(82vh,760px)] overflow-y-auto rounded-[24px] border border-slate-200/80 bg-[#fffdf7] p-4 shadow-[0_24px_80px_rgba(15,23,42,0.24)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">AI task pad</div>
          <div className="mt-1 text-base font-semibold tracking-[-0.03em] text-slate-950">{task.title}</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-full border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-500 hover:text-slate-900"
          aria-label="Dismiss action progress"
        >
          Close
        </button>
      </div>

      <div className="rounded-2xl border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-sm leading-5 text-slate-700">
        {task.summary}
      </div>

      {history.length > 0 ? (
        <div className="mt-3 rounded-2xl border border-slate-200 bg-white/80 px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
            Workflow so far · {history.length + 1} steps
          </div>
          <div className="mt-2 space-y-1.5">
            {history.map((entry) => (
              <div key={entry.id} className="flex items-start gap-2 text-xs leading-4 text-slate-600">
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold ${
                  entry.status === 'error'
                    ? 'border-red-300 bg-red-50 text-red-600'
                    : 'border-emerald-300 bg-emerald-50 text-emerald-700'
                }`}>
                  {entry.status === 'error' ? '!' : '✓'}
                </span>
                <div className="min-w-0">
                  <div className="font-semibold text-slate-800">{entry.title}</div>
                  <div className="truncate text-slate-500">{entry.detailMessage || entry.summary}</div>
                </div>
              </div>
            ))}
            <div className="flex items-start gap-2 text-xs leading-4 text-slate-700">
              <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold ${
                task.status === 'complete'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                  : task.status === 'error'
                    ? 'border-red-300 bg-red-50 text-red-600'
                    : 'border-blue-300 bg-blue-50 text-blue-700'
              }`}>
                {task.status === 'complete' ? '✓' : task.status === 'error' ? '!' : '…'}
              </span>
              <div className="min-w-0">
                <div className="font-semibold text-slate-900">{task.title}</div>
                <div className="text-slate-500">
                  {task.status === 'running' ? 'In progress' : task.status === 'complete' ? 'Done' : 'Needs attention'}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {task.reuseMeta?.reused ? (
        <div className="mt-2 text-[11px] font-medium text-emerald-700">
          Reused prior result{task.reuseMeta.ageLabel ? ` · ${task.reuseMeta.ageLabel}` : ''}
        </div>
      ) : null}

      {task.status === 'running' && task.detailMessage ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs leading-5 text-blue-900">
          <span
            className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600"
            aria-hidden="true"
          />
          <span>{task.detailMessage}</span>
        </div>
      ) : null}

      <div className={`mt-3 space-y-2 ${showResult ? 'opacity-90' : ''}`}>
        {task.steps.map((step, index) => {
          const isDone = index < completedStepCount && task.status !== 'error';
          const isActive = index === task.currentStep && task.status === 'running';
          const isError = index === task.currentStep && task.status === 'error';
          return (
            <div
              key={`${task.actionId}-${step}-${index}`}
              className={`flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm transition-colors duration-300 ${
                isActive ? 'bg-blue-50/80 ring-1 ring-blue-100' : ''
              }`}
            >
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
                isError
                  ? 'border-red-300 bg-red-50 text-red-600'
                  : isDone
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : isActive
                      ? 'border-blue-300 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-white text-slate-400'
              }`}>
                {isError ? '!' : isDone ? '✓' : isActive ? (
                  <span
                    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600"
                    aria-hidden="true"
                  />
                ) : index + 1}
              </span>
              <span className={`flex-1 ${isDone ? 'text-slate-500 line-through decoration-slate-300' : 'text-slate-700'} ${isActive ? 'font-semibold text-slate-950' : ''}`}>
                {step}
              </span>
              {isActive ? (
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-600">
                  Working
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {showResult && task.result ? (
        <div className="mt-3 space-y-3">
          {task.result.type === 'document' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="text-sm font-semibold text-slate-950">{task.result.title}</div>
              {task.result.propertyAddress ? <div className="mt-1 text-xs text-slate-500">{task.result.propertyAddress}</div> : null}
              <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-700">
                {task.result.previewText || task.result.content || 'Draft ready.'}
              </pre>
            </div>
          ) : null}

          {task.result.type === 'pdf' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="text-sm font-semibold text-slate-950">{task.result.title}</div>
              <div className="mt-1 text-xs text-slate-500">{task.result.formLabel || 'PDF ready for review'}</div>
              <div className="mt-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-xs text-slate-600">
                Tax PDF prepared. Use View or Download below.
              </div>
            </div>
          ) : null}

          {task.result.type === 'message_draft' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="text-sm font-semibold text-slate-950">{task.result.title}</div>
              <div className="mt-1 text-xs text-slate-500">
                To: {task.result.toName || 'Tenant'}{task.result.toEmail ? ` · ${task.result.toEmail}` : ''}
                {task.result.channel === 'tenant_portal' ? ' · Tenant portal' : ''}
              </div>
              <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Subject</label>
              <input
                value={draftSubject}
                onChange={(event) => setDraftSubject(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800"
              />
              <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Message</label>
              <textarea
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
                rows={7}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-5 text-slate-800"
              />
            </div>
          ) : null}

          {task.result.type === 'expense_breakdown' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-950">{task.result.title}</div>
                <div className="text-sm font-semibold tabular-nums text-slate-950">{formatMoney(task.result.total)}</div>
              </div>
              {task.result.periodLabel ? <div className="mt-1 text-xs text-slate-500">{task.result.periodLabel}</div> : null}
              <div className="mt-3 space-y-2">
                {task.result.lines.map((line, index) => (
                  <div key={`${line.id || line.label}-${index}`} className="flex items-start justify-between gap-3 text-sm">
                    <div>
                      <div className="text-slate-800">{line.label}</div>
                      <div className="text-xs text-slate-500">
                        {[line.category, line.date, line.propertyAddress].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <div className="shrink-0 font-medium tabular-nums text-slate-900">{formatMoney(line.amount)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {task.result.type === 'maintenance_case' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
              <div className="font-semibold text-slate-950">{task.result.title}</div>
              {task.result.status ? <div className="mt-1 text-xs uppercase tracking-[0.14em] text-slate-500">{task.result.status}</div> : null}
              {task.result.issueSummary ? <p className="mt-2 text-slate-700">{task.result.issueSummary}</p> : null}
              <div className="mt-2 space-y-1 text-xs text-slate-500">
                {task.result.propertyAddress ? <div>{task.result.propertyAddress}</div> : null}
                {task.result.providerName ? <div>Provider: {task.result.providerName}{task.result.providerPhone ? ` · ${task.result.providerPhone}` : ''}</div> : null}
                {task.result.nextStep ? <div className="text-slate-700">{task.result.nextStep}</div> : null}
              </div>
            </div>
          ) : null}

          {task.result.type === 'sensor_insight' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
              <div className="font-semibold text-slate-950">{task.result.title}</div>
              <p className="mt-2 text-slate-700">{task.result.summary}</p>
              {task.result.recommendations?.length ? (
                <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-slate-600">
                  {task.result.recommendations.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {task.result.type === 'market_insight' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
              <div className="font-semibold text-slate-950">{task.result.title}</div>
              <p className="mt-2 text-slate-700">{task.result.summary}</p>
              {task.result.bullets?.length ? (
                <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-slate-600">
                  {task.result.bullets.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {task.result.type === 'property_analysis' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
              <div className="font-semibold text-slate-950">{task.result.title}</div>
              {task.result.propertyAddress ? (
                <div className="mt-1 text-xs text-slate-500">{task.result.propertyAddress}</div>
              ) : null}
              {task.result.verdict ? (
                <div className="mt-2 rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-950">
                  {task.result.verdict}
                </div>
              ) : null}
              <p className="mt-2 text-slate-700">{task.result.summary}</p>
              {task.result.metrics?.length ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {task.result.metrics.map((metric) => (
                    <div key={metric.label} className="rounded-xl border border-slate-100 bg-slate-50 px-2.5 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{metric.label}</div>
                      <div className="mt-1 text-sm font-semibold tabular-nums text-slate-950">{metric.value}</div>
                      {metric.hint ? <div className="mt-0.5 text-[10px] text-slate-500">{metric.hint}</div> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {task.result.bullets?.length ? (
                <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-slate-600">
                  {task.result.bullets.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : null}
              {task.result.scenarios?.length ? (
                <div className="mt-3 space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Scenarios</div>
                  {task.result.scenarios.map((scenario) => (
                    <div key={scenario.label} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                      <div className="text-xs font-semibold text-slate-900">{scenario.label}</div>
                      <div className="mt-1 text-xs leading-5 text-slate-600">{scenario.detail}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              {task.result.nextSteps?.length ? (
                <div className="mt-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Next steps</div>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-slate-600">
                    {task.result.nextSteps.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {task.result.type === 'generic' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
              <div className="font-semibold text-slate-950">{task.result.title}</div>
              <p className="mt-2 text-slate-700">{task.result.message}</p>
              {task.result.details?.length ? (
                <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-slate-600">
                  {task.result.details.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {task.result.type === 'daily_briefing' ? (
            <div className="space-y-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="text-sm font-semibold text-slate-950">{task.result.title}</div>
                <p className="mt-1.5 text-sm leading-5 text-slate-600">{task.result.summary}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {task.result.metrics.map((metric) => {
                    const toneClass = metric.tone === 'positive'
                      ? 'text-emerald-700'
                      : metric.tone === 'warning'
                        ? 'text-amber-700'
                        : metric.tone === 'critical'
                          ? 'text-rose-700'
                          : 'text-slate-950';
                    return (
                      <div key={metric.label} className="rounded-xl border border-slate-100 bg-slate-50 px-2.5 py-2">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{metric.label}</div>
                        <div className={`mt-1 text-base font-semibold tabular-nums ${toneClass}`}>{metric.value}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                {task.result.sections.map((section) => {
                  const statusClass = section.status === 'critical'
                    ? 'border-rose-200 bg-rose-50/70'
                    : section.status === 'attention'
                      ? 'border-amber-200 bg-amber-50/70'
                      : section.status === 'clear'
                        ? 'border-emerald-200 bg-emerald-50/60'
                        : 'border-slate-200 bg-white';
                  const dotClass = section.status === 'critical'
                    ? 'bg-rose-500'
                    : section.status === 'attention'
                      ? 'bg-amber-500'
                      : section.status === 'clear'
                        ? 'bg-emerald-500'
                        : 'bg-slate-400';
                  return (
                    <div key={section.id} className={`rounded-xl border px-3 py-2.5 ${statusClass}`}>
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
                        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{section.label}</div>
                      </div>
                      <div className="mt-1.5 text-sm font-semibold leading-5 text-slate-900">{section.headline}</div>
                      {section.details?.length ? (
                        <ul className="mt-1.5 space-y-1 text-xs leading-5 text-slate-600">
                          {section.details.map((detail) => (
                            <li key={detail} className="flex gap-2">
                              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                              <span>{detail}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {task.result.type === 'scheduled_tasks' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
              <div className="font-semibold text-slate-950">{task.result.title}</div>
              {task.result.message ? <p className="mt-2 text-slate-700">{task.result.message}</p> : null}
              <div className="mt-3 space-y-2">
                {(task.result.tasks || []).slice(0, 6).map((item) => {
                  const whenLabel = (() => {
                    const date = new Date(item.runAt);
                    if (Number.isNaN(date.getTime())) return item.runAt;
                    return date.toLocaleString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    });
                  })();
                  const highlighted = item.id === (
                    task.result?.type === 'scheduled_tasks' ? task.result.highlightTaskId : undefined
                  );
                  return (
                    <div
                      key={item.id}
                      className={`rounded-xl border px-3 py-2 ${highlighted ? 'border-emerald-300 bg-emerald-50/70' : 'border-slate-200 bg-slate-50'}`}
                    >
                      <div className="font-medium text-slate-900">{item.title}</div>
                      <div className="mt-0.5 text-xs text-slate-500">{whenLabel}</div>
                      {item.notes ? <div className="mt-1 text-xs text-slate-600 line-clamp-2">{item.notes}</div> : null}
                    </div>
                  );
                })}
                {!task.result.tasks?.length ? (
                  <div className="text-xs text-slate-500">No upcoming tasks yet.</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {task.result.type === 'needs_input' ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-3">
              <div className="text-sm font-semibold text-slate-950">{task.result.title}</div>
              <p className="mt-2 text-sm text-slate-700">{task.result.message}</p>
              <div className="mt-3 space-y-2">
                {task.result.fields.map((field) => (
                  <div key={field.id}>
                    <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{field.label}</label>
                    <input
                      type={field.inputType || 'text'}
                      placeholder={field.placeholder}
                      value={needsInputValues[field.id] || ''}
                      onChange={(event) => setNeedsInputValues((current) => ({ ...current, [field.id]: event.target.value }))}
                      className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    />
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={submitNeedsInput}
                className="mt-3 w-full rounded-full bg-slate-950 px-3 py-2 text-sm font-semibold text-white"
              >
                Continue
              </button>
            </div>
          ) : null}

          {task.result.type === 'confirmation' ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
              <div className="font-semibold text-slate-950">{task.result.title}</div>
              <p className="mt-2 text-slate-700">{task.result.message}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {task.error ? (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
          {task.error}
        </div>
      ) : null}

      {actionNote ? (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800">
          {actionNote}
        </div>
      ) : null}

      {task.actions && task.actions.length > 0 ? (
        <div className="mt-3 rounded-2xl border border-slate-200 bg-white/80 p-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
            {task.actions.some((action) => action.kind === 'confirm')
              ? 'Suggested actions · your approval required'
              : 'Available actions'}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {task.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                disabled={actionBusy === action.id}
                onClick={() => void handlePadAction(action)}
                className={`rounded-full px-3 py-2 text-xs font-semibold ${
                  action.primary
                    ? 'bg-slate-950 text-white'
                    : 'border border-slate-200 bg-white text-slate-700'
                } disabled:opacity-60`}
              >
                {actionBusy === action.id ? 'Working…' : action.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          <span className="inline-flex items-center gap-2">
            {isProcessing ? (
              <span
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700"
                aria-hidden="true"
              />
            ) : null}
            {task.status === 'complete'
              ? (showResult ? 'Ready for review' : 'Complete')
              : task.status === 'error'
                ? 'Needs attention'
                : activeStepLabel || 'Working'}
          </span>
          <span>{progress}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-200">
          <div
            className={`h-full rounded-full transition-all duration-700 ease-out ${task.status === 'error' ? 'bg-red-500' : task.status === 'complete' ? 'bg-emerald-600' : 'bg-slate-950'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
};

// Workflow Progress Bar Component
const WorkflowProgressBar: React.FC<{
  currentStep: number;
  totalSteps: number;
  workflowName: string;
  onCancel: () => void;
  onNext: () => Promise<boolean>;
}> = ({ currentStep, totalSteps, workflowName, onCancel, onNext }) => {
  const progress = ((currentStep + 1) / totalSteps) * 100;
  
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[10001] bg-white rounded-xl shadow-2xl border border-purple-200 p-4 min-w-[400px]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-purple-600 text-lg">🎙️</span>
          <span className="font-semibold text-gray-800">{workflowName}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">Step {currentStep + 1} of {totalSteps}</span>
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 p-1"
            title="Cancel workflow"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden mb-3">
        <div 
          className="h-full bg-gradient-to-r from-purple-500 to-indigo-500 transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="flex justify-between items-center">
        <span className="text-xs text-gray-500">Voice AI is guiding you through this process</span>
        <button
          onClick={onNext}
          className="px-4 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg transition-colors"
        >
          Next Step →
        </button>
      </div>
    </div>
  );
};

// Highlight Overlay Component
const HighlightOverlay: React.FC<{ elements: HighlightedElement[] }> = ({ elements }) => {
  const [positions, setPositions] = useState<Map<string, DOMRect>>(new Map());
  
  useEffect(() => {
    if (elements.length === 0) return;
    
    const updatePositions = () => {
      const newPositions = new Map<string, DOMRect>();
      
      elements.forEach(element => {
        const el = document.querySelector(element.selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          newPositions.set(element.selector, rect);
          
          // Add visual highlight class to the element
          el.classList.add('voice-highlight-target');
        }
      });
      
      setPositions(newPositions);
    };
    
    // Initial position update
    updatePositions();
    
    // Update on scroll/resize
    window.addEventListener('scroll', updatePositions, true);
    window.addEventListener('resize', updatePositions);
    
    return () => {
      window.removeEventListener('scroll', updatePositions, true);
      window.removeEventListener('resize', updatePositions);
      
      // Remove highlight classes
      elements.forEach(element => {
        const el = document.querySelector(element.selector);
        if (el) {
          el.classList.remove('voice-highlight-target');
        }
      });
    };
  }, [elements]);
  
  if (elements.length === 0) return null;
  
  return (
    <>
      {/* Inject highlight styles */}
      <style>{`
        .voice-highlight-target {
          animation: voice-highlight-pulse 1.5s ease-in-out infinite;
          position: relative;
          z-index: 1000 !important;
        }
        
        @keyframes voice-highlight-pulse {
          0%, 100% {
            box-shadow: 0 0 0 4px rgba(147, 51, 234, 0.5), 0 0 20px rgba(147, 51, 234, 0.3);
          }
          50% {
            box-shadow: 0 0 0 8px rgba(147, 51, 234, 0.3), 0 0 40px rgba(147, 51, 234, 0.5);
          }
        }
        
        .voice-highlight-overlay {
          pointer-events: none;
          position: fixed;
          z-index: 9999;
        }
        
        .voice-highlight-label {
          position: fixed;
          background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%);
          color: white;
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          max-width: 300px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
          animation: voice-label-appear 0.3s ease-out;
          z-index: 10000;
        }
        
        .voice-highlight-label::before {
          content: '🎤';
          margin-right: 8px;
        }
        
        @keyframes voice-label-appear {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .voice-highlight-arrow {
          position: fixed;
          width: 0;
          height: 0;
          border-left: 10px solid transparent;
          border-right: 10px solid transparent;
          border-top: 10px solid #7c3aed;
          z-index: 10000;
        }
      `}</style>
      
      {/* Render labels for highlighted elements */}
      {elements.map(element => {
        const rect = positions.get(element.selector);
        if (!rect) return null;
        
        // Position label above the element
        const labelTop = rect.top - 50;
        const labelLeft = Math.max(10, Math.min(rect.left, window.innerWidth - 320));
        
        return (
          <div key={element.selector} className="voice-highlight-overlay">
            {element.label && (
              <>
                <div 
                  className="voice-highlight-label"
                  style={{
                    top: `${Math.max(10, labelTop)}px`,
                    left: `${labelLeft}px`,
                  }}
                >
                  {element.label}
                </div>
                <div 
                  className="voice-highlight-arrow"
                  style={{
                    top: `${rect.top - 10}px`,
                    left: `${rect.left + rect.width / 2 - 10}px`,
                  }}
                />
              </>
            )}
          </div>
        );
      })}
    </>
  );
};

export const useVoiceCommand = () => {
  const context = useContext(VoiceCommandContext);
  if (!context) {
    throw new Error('useVoiceCommand must be used within a VoiceCommandProvider');
  }
  return context;
};

// Helper hook for pages to handle pending actions
export const useVoiceActionHandler = (
  actionName: string,
  handler: (params?: Record<string, any>) => void,
  deps: React.DependencyList = []
) => {
  const { registerActionHandler, unregisterActionHandler, pendingAction, clearPendingAction } = useVoiceCommand();
  
  useEffect(() => {
    registerActionHandler(actionName, handler);
    return () => unregisterActionHandler(actionName);
  }, [actionName, ...deps]);
  
  // Handle pending action if it matches
  useEffect(() => {
    if (pendingAction && pendingAction.action === actionName.toLowerCase()) {
      handler(pendingAction.parameters);
      clearPendingAction();
    }
  }, [pendingAction, actionName]);
};

export default VoiceCommandContext;
