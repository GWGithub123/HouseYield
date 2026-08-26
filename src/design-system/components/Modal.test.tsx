import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Modal } from './Modal';

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Review action">
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Modal>
    </>
  );
}

describe('Modal accessibility', () => {
  it('moves focus inside, traps tab navigation, and restores focus', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Last action' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(dialog).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
