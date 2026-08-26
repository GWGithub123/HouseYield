/**
 * Shared result types for the interactive AI task pad.
 * Backend actions and frontend handlers emit these so owners can review
 * PDFs, drafts, expenses, and confirmations without hunting through the UI.
 */

export type AssistantResultType =
  | 'document'
  | 'document_list'
  | 'pdf'
  | 'message_draft'
  | 'expense_breakdown'
  | 'maintenance_case'
  | 'sensor_insight'
  | 'market_insight'
  | 'property_analysis'
  | 'confirmation'
  | 'needs_input'
  | 'scheduled_tasks'
  | 'daily_briefing'
  | 'generic';

export type AssistantPadActionKind =
  | 'open'
  | 'download'
  | 'send'
  | 'edit'
  | 'cancel'
  | 'confirm'
  | 'refresh'
  | 'navigate'
  | 'copy';

export interface AssistantPadAction {
  id: string;
  label: string;
  kind: AssistantPadActionKind;
  primary?: boolean;
  href?: string;
  route?: string;
  payload?: Record<string, unknown>;
}

export interface AssistantReuseMeta {
  reused: boolean;
  source?: string;
  ageLabel?: string;
  generatedAt?: string | null;
}

export interface AssistantDocumentResult {
  type: 'document';
  title: string;
  documentId?: string;
  documentType?: string;
  previewText?: string;
  content?: string;
  status?: string;
  propertyAddress?: string;
  tenantName?: string;
}

export interface AssistantDocumentListResult {
  type: 'document_list';
  title: string;
  summary: string;
  propertyAddress?: string;
  documentType?: string | null;
  documents: Array<{
    id: string;
    title: string;
    documentType?: string;
    status?: string;
    propertyAddress?: string;
    updatedAt?: string | null;
    previewUrl?: string;
    route?: string;
  }>;
}

export interface AssistantPdfResult {
  type: 'pdf';
  title: string;
  url: string;
  filename?: string;
  formLabel?: string;
  taxYear?: number | string;
  documentId?: string;
  propertyAddress?: string;
  status?: string;
  relatedDocuments?: Array<{
    id: string;
    title: string;
    status?: string;
    propertyAddress?: string;
    previewUrl?: string;
    route?: string;
  }>;
}

export interface AssistantMessageDraftResult {
  type: 'message_draft';
  title: string;
  toName?: string;
  toEmail?: string;
  subject: string;
  body: string;
  channel?: 'email' | 'sms' | 'in_app' | 'tenant_portal' | 'gmail';
  draftId?: string;
  editable?: boolean;
}

export interface AssistantExpenseLine {
  id?: string;
  label: string;
  amount: number;
  category?: string;
  date?: string;
  propertyAddress?: string;
}

export interface AssistantExpenseBreakdownResult {
  type: 'expense_breakdown';
  title: string;
  total: number;
  currency?: string;
  periodLabel?: string;
  lines: AssistantExpenseLine[];
}

export interface AssistantMaintenanceCaseResult {
  type: 'maintenance_case';
  title: string;
  requestId?: string;
  status?: string;
  issueSummary?: string;
  propertyAddress?: string;
  providerName?: string;
  providerPhone?: string;
  nextStep?: string;
}

export interface AssistantSensorInsightDeviceCard {
  id: string;
  name: string;
  location?: string | null;
  kindLabel: string;
  type: string;
  status: string;
  readingLabel?: string | null;
  temperatureF?: number | null;
  humidityPercent?: number | null;
  valveState?: string | null;
  flooded?: boolean;
  focused?: boolean;
}

export interface AssistantSensorInsightResult {
  type: 'sensor_insight';
  title: string;
  deviceName?: string;
  severity?: string;
  summary: string;
  speakableAnswer?: string;
  recommendations?: string[];
  metrics?: AssistantPropertyAnalysisMetric[];
  counts?: {
    total: number;
    online: number;
    offline: number;
    ht: number;
    flood: number;
    gateway: number;
    shutoff: number;
    flooded: number;
    openAlerts: number;
  };
  devices?: AssistantSensorInsightDeviceCard[];
  focusedDeviceIds?: string[];
  openAlerts?: Array<{
    id: string;
    deviceName: string;
    severity: string;
    message: string;
  }>;
}

export interface AssistantMarketInsightResult {
  type: 'market_insight';
  title: string;
  summary: string;
  bullets?: string[];
  marketLabel?: string;
}

export interface AssistantPropertyAnalysisMetric {
  label: string;
  value: string;
  hint?: string;
}

export interface AssistantPropertyAnalysisResult {
  type: 'property_analysis';
  title: string;
  summary: string;
  propertyAddress?: string;
  verdict?: string;
  bullets?: string[];
  metrics?: AssistantPropertyAnalysisMetric[];
  scenarios?: Array<{
    label: string;
    detail: string;
  }>;
  nextSteps?: string[];
}

export interface AssistantConfirmationResult {
  type: 'confirmation';
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface AssistantNeedsInputResult {
  type: 'needs_input';
  title: string;
  message: string;
  fields: Array<{
    id: string;
    label: string;
    placeholder?: string;
    required?: boolean;
    inputType?: 'text' | 'number' | 'email' | 'date';
  }>;
}

export interface AssistantGenericResult {
  type: 'generic';
  title: string;
  message: string;
  details?: string[];
}

export interface AssistantScheduledTaskItem {
  id: string;
  title: string;
  notes?: string;
  runAt: string;
  status?: string;
  kind?: string;
  actionId?: string | null;
  propertyAddress?: string | null;
}

export interface AssistantScheduledTasksResult {
  type: 'scheduled_tasks';
  title: string;
  message?: string;
  tasks: AssistantScheduledTaskItem[];
  highlightTaskId?: string;
}

export interface AssistantDailyBriefingResult {
  type: 'daily_briefing';
  title: string;
  generatedAt: string;
  summary: string;
  metrics: Array<{
    label: string;
    value: string;
    tone?: 'neutral' | 'positive' | 'warning' | 'critical';
  }>;
  sections: Array<{
    id: string;
    label: string;
    status: 'clear' | 'attention' | 'critical' | 'info';
    headline: string;
    details?: string[];
  }>;
}

export interface AssistantResultPresentation {
  headline?: string;
  highlights?: string[];
  rationale?: string[];
  sourceLabel?: string;
  sourceUrl?: string;
  freshAsOf?: string;
  confidence?: 'low' | 'medium' | 'high';
  recommendedNextAction?: string;
}

type AssistantActionResultContent =
  | AssistantDocumentResult
  | AssistantDocumentListResult
  | AssistantPdfResult
  | AssistantMessageDraftResult
  | AssistantExpenseBreakdownResult
  | AssistantMaintenanceCaseResult
  | AssistantSensorInsightResult
  | AssistantMarketInsightResult
  | AssistantPropertyAnalysisResult
  | AssistantConfirmationResult
  | AssistantNeedsInputResult
  | AssistantScheduledTasksResult
  | AssistantDailyBriefingResult
  | AssistantGenericResult;

export type AssistantActionResultPayload = AssistantActionResultContent & {
  presentation?: AssistantResultPresentation;
};

export interface AssistantActionArtifact {
  id: string;
  label: string;
  kind: 'pdf' | 'document' | 'link' | 'image';
  url?: string;
  route?: string;
}

export interface AssistantBackendActionResponse {
  ok: boolean;
  actionId: string;
  title: string;
  summary: string;
  detailMessage?: string;
  navigation?: {
    route: string;
    tab?: string;
    highlightVoiceId?: string;
  };
  result?: AssistantActionResultPayload;
  actions?: AssistantPadAction[];
  artifacts?: AssistantActionArtifact[];
  reuseMeta?: AssistantReuseMeta;
  error?: string;
  needsInput?: boolean;
  runId?: string;
  requestId?: string;
  idempotencyKey?: string;
  reused?: boolean;
}
