import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantActivityRun } from '../contexts/AssistantActivityContext';
import { AssistantWorkPanel } from './AssistantWorkPanel';

const run: AssistantActivityRun = {
  runId: 'run-1',
  actionId: 'message-tenant',
  sequence: 2,
  title: 'Message tenant',
  summary: 'A concise message is ready for your review.',
  highlights: ['The recipient and wording are ready.', 'Nothing has been sent yet.'],
  steps: ['Prepared a draft'],
  currentStep: 0,
  status: 'complete',
  result: {
    type: 'message_draft',
    title: 'Tenant message',
    toName: 'Taylor',
    subject: 'Maintenance update',
    body: 'The repair is scheduled for Tuesday.',
  },
  actions: [{ id: 'send-message', label: 'Send message', kind: 'send', primary: true }],
  startedAt: 100,
  completedAt: 200,
};

describe('AssistantWorkPanel', () => {
  it('shows the answer first and gates consequential actions', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<AssistantWorkPanel run={run} onClose={() => undefined} onAction={onAction} />);

    expect(screen.getByRole('heading', { name: 'Answer' })).toBeInTheDocument();
    expect(screen.getByText('Nothing has been sent yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Nothing happens until you confirm');

    await user.click(screen.getByRole('button', { name: 'Confirm Send message' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('lets the owner cancel approval without running the action', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<AssistantWorkPanel run={run} onClose={() => undefined} onAction={onAction} />);

    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('shows a working state for in-progress runs', () => {
    const running: AssistantActivityRun = {
      ...run,
      status: 'running',
      completedAt: undefined,
      result: undefined,
      actions: [],
      steps: ['Working on your request'],
    };
    render(<AssistantWorkPanel run={running} onClose={() => undefined} onAction={async () => undefined} />);
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause guidance' })).toBeInTheDocument();
  });
});
