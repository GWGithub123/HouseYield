import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';

export type AssistantTelemetryEventName =
  | 'activity_started'
  | 'activity_completed'
  | 'activity_failed'
  | 'activity_abandoned'
  | 'activity_waiting_for_input'
  | 'approval_cancelled'
  | 'response_corrected'
  | 'duplicate_event_ignored';

type AssistantTelemetryProperties = {
  runId?: string;
  actionId?: string;
  durationMs?: number;
  sequence?: number;
  surface?: 'sidebar' | 'work_panel' | 'activity_center' | 'scheduled';
  reducedMotion?: boolean;
  responseLength?: 'brief' | 'standard' | 'detailed';
};

export function trackAssistantTelemetry(
  name: AssistantTelemetryEventName,
  properties: AssistantTelemetryProperties = {},
) {
  const payload = {
    name,
    properties,
    occurredAt: new Date().toISOString(),
  };

  window.dispatchEvent(new CustomEvent('houseyield:assistant-telemetry', { detail: payload }));
  void requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/telemetry'),
    {
      method: 'POST',
      body: JSON.stringify(payload),
      keepalive: true,
    },
    { 'Content-Type': 'application/json' },
  ).catch(() => {
    // Telemetry must never interrupt the owner's workflow.
  });
}
