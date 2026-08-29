import { describe, expect, it } from 'vitest';
import { buildFloodDispatchFeed } from '../floodDispatchFeed';
import type { MaintenanceTicket } from '../ticketTypes';

function ticket(overrides: Partial<MaintenanceTicket> = {}): MaintenanceTicket {
  return {
    id: 'req-1',
    category: 'plumbing',
    priority: 'emergency',
    description: 'FLOOD/LEAK DETECTED',
    status: 'pending',
    createdAt: '2026-08-26T23:55:00.000Z',
    propertyAddress: '100 Demo Lane',
    aiAutomation: { status: 'processing' },
    ...overrides,
  };
}

describe('buildFloodDispatchFeed', () => {
  it('shows ticket opening while the request has not landed yet', () => {
    const items = buildFloodDispatchFeed(null);
    expect(items[0]).toMatchObject({ id: 'ticket', state: 'active' });
    expect(items[1].state).toBe('pending');
  });

  it('marks search live while the AI is processing', () => {
    const items = buildFloodDispatchFeed(ticket());
    expect(items.find((item) => item.id === 'ticket')?.state).toBe('complete');
    expect(items.find((item) => item.id === 'search')).toMatchObject({
      state: 'active',
      label: 'Searching for a plumber',
    });
  });

  it('shows plumber identity, owner text, and call wait after a shortlist', () => {
    const items = buildFloodDispatchFeed(ticket({
      aiAutomation: {
        status: 'awaiting_provider_approval',
        providerSearch: { totalFound: 12, analyzedCount: 8 },
        selectedProvider: { name: 'Harbor Plumbing Co.', phone: '+15555550100' },
      },
      ownerSmsNotifications: {
        status: 'pending',
        ownerPhone: '+15555550199',
        sentAt: '2026-08-26T23:55:30.000Z',
      },
    }));

    expect(items.find((item) => item.id === 'search')?.state).toBe('complete');
    expect(items.find((item) => item.id === 'identify')).toMatchObject({
      state: 'complete',
      detail: 'Harbor Plumbing Co.',
    });
    expect(items.find((item) => item.id === 'sms')?.state).toBe('complete');
    expect(items.find((item) => item.id === 'call')).toMatchObject({
      state: 'active',
      detail: 'Ready to call Harbor Plumbing Co. after YES',
    });
  });
});
