import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_MEMORY_MAX_RECENT_EXCHANGES,
  buildAssistantMemorySnapshot,
  clearAssistantMemory,
  createEmptyAssistantMemorySnapshot,
  formatAssistantMemoryForPrompt,
} from './assistantMemoryService';

describe('assistant memory session persistence', () => {
  it('retains bounded recent exchanges and session summaries', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: index % 2 === 0
        ? `Please help me review rental property number ${index}.`
        : `I reviewed rental property number ${index} and prepared next steps.`,
      timestamp: new Date(Date.UTC(2026, 6, 11, 12, index)).toISOString(),
    }));

    const snapshot = buildAssistantMemorySnapshot({
      messages,
      sessionId: 'session-1',
      sessionStartedAt: '2026-07-11T12:00:00.000Z',
      now: new Date('2026-07-11T13:00:00.000Z'),
    });

    expect(snapshot.recentSessions).toHaveLength(1);
    expect(snapshot.recentSessions[0].id).toBe('session-1');
    expect(snapshot.recentExchanges).toHaveLength(ASSISTANT_MEMORY_MAX_RECENT_EXCHANGES);
    expect(snapshot.recentSessions[0].summary.length).toBeLessThanOrEqual(220);
    expect(formatAssistantMemoryForPrompt(snapshot)).toContain('Most recent relevant session');
  });

  it('updates an existing session instead of duplicating it', () => {
    const first = buildAssistantMemorySnapshot({
      messages: [{
        role: 'user',
        content: 'Help me review my Prestwick rental property.',
        timestamp: '2026-07-11T12:00:00.000Z',
      }],
      sessionId: 'session-1',
      sessionStartedAt: '2026-07-11T12:00:00.000Z',
      now: new Date('2026-07-11T12:05:00.000Z'),
    });
    const updated = buildAssistantMemorySnapshot({
      existing: first,
      messages: [{
        role: 'assistant',
        content: 'I prepared the Prestwick rent review and saved the result.',
        timestamp: '2026-07-11T12:10:00.000Z',
      }],
      sessionId: 'session-1',
      sessionStartedAt: '2026-07-11T12:00:00.000Z',
      now: new Date('2026-07-11T12:10:00.000Z'),
    });

    expect(updated.recentSessions).toHaveLength(1);
    expect(updated.recentSessions[0].endedAt).toBe('2026-07-11T12:10:00.000Z');
  });

  it('builds an empty snapshot used by clear memory', () => {
    const empty = createEmptyAssistantMemorySnapshot(new Date('2026-07-11T12:00:00.000Z'));
    expect(empty.recentExchanges).toEqual([]);
    expect(empty.recentSessions).toEqual([]);
    expect(empty.profile.userPreferences).toEqual([]);
    expect(typeof clearAssistantMemory).toBe('function');
  });
});
