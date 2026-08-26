import { describe, expect, it } from 'vitest';
import {
  assistantActivityReducer,
  type AssistantActivityEvent,
} from './AssistantActivityContext';

const baseEvent: AssistantActivityEvent = {
  runId: 'run-1',
  sequence: 1,
  occurredAt: 100,
  actionId: 'analyze-property',
  title: 'Analyze property',
  summary: 'Reviewing the property.',
  steps: ['Working on your request'],
  currentStep: 0,
  status: 'running',
};

describe('assistantActivityReducer', () => {
  it('ignores duplicate and stale events', () => {
    const started = assistantActivityReducer(
      { runs: [], activeRunId: null },
      { type: 'event', event: baseEvent },
    );
    const duplicate = assistantActivityReducer(started, {
      type: 'event',
      event: { ...baseEvent, summary: 'Duplicate should not win.' },
    });
    const stale = assistantActivityReducer(started, {
      type: 'event',
      event: { ...baseEvent, sequence: 0, summary: 'Stale should not win.' },
    });

    expect(duplicate).toBe(started);
    expect(stale).toBe(started);
    expect(started.runs[0].summary).toBe('Reviewing the property.');
  });

  it('updates one stable run in place when sequence advances', () => {
    const started = assistantActivityReducer(
      { runs: [], activeRunId: null },
      { type: 'event', event: baseEvent },
    );
    const completed = assistantActivityReducer(started, {
      type: 'event',
      event: {
        ...baseEvent,
        sequence: 2,
        occurredAt: 200,
        summary: 'The property review is ready.',
        status: 'complete',
      },
    });

    expect(completed.runs).toHaveLength(1);
    expect(completed.runs[0]).toMatchObject({
      runId: 'run-1',
      sequence: 2,
      status: 'complete',
      startedAt: 100,
      completedAt: 200,
    });
  });

  it('activates a dismissed run and clears finished activity', () => {
    const started = assistantActivityReducer(
      { runs: [], activeRunId: null },
      { type: 'event', event: baseEvent },
    );
    const completed = assistantActivityReducer(started, {
      type: 'event',
      event: {
        ...baseEvent,
        sequence: 2,
        occurredAt: 200,
        status: 'complete',
        summary: 'Ready.',
      },
    });
    const dismissed = assistantActivityReducer(completed, { type: 'dismiss', runId: 'run-1' });
    expect(dismissed.runs[0].dismissed).toBe(true);
    expect(dismissed.activeRunId).toBeNull();

    const activated = assistantActivityReducer(dismissed, { type: 'activate', runId: 'run-1' });
    expect(activated.activeRunId).toBe('run-1');
    expect(activated.runs[0].dismissed).toBe(false);

    const cleared = assistantActivityReducer(activated, { type: 'clear-completed' });
    expect(cleared.runs).toHaveLength(0);
  });

  it('keeps a second concurrent run without overwriting the first', () => {
    const first = assistantActivityReducer(
      { runs: [], activeRunId: null },
      { type: 'event', event: baseEvent },
    );
    const second = assistantActivityReducer(first, {
      type: 'event',
      event: {
        ...baseEvent,
        runId: 'run-2',
        actionId: 'message-tenant',
        title: 'Message tenant',
        summary: 'Drafting a tenant message.',
      },
    });

    expect(second.runs).toHaveLength(2);
    expect(second.activeRunId).toBe('run-2');
    expect(second.runs.find((run) => run.runId === 'run-1')?.summary).toBe('Reviewing the property.');
  });
});
