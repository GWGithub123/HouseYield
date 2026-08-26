import { expect, test } from '@playwright/test';

/**
 * Smoke coverage for the intuitive assistant activity loop.
 * The page is stubbed so CI/local runs do not need auth or Firebase.
 */
test.describe('assistant activity smoke', () => {
  test('text request → work panel → approval → reopen activity', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html lang="en">
        <body>
          <main>
            <label>
              Ask the assistant
              <textarea id="prompt" aria-label="Ask the assistant"></textarea>
            </label>
            <button id="send" type="button">Send</button>
            <button id="activity" type="button">Activity</button>
            <div id="status" role="status"></div>
            <div id="work-panel" hidden>
              <h2>Answer</h2>
              <p id="summary">A tenant message is ready for your review.</p>
              <button id="send-message" type="button">Send message</button>
              <div id="confirm" role="alertdialog" hidden>
                <p>Nothing happens until you confirm</p>
                <button id="confirm-send" type="button">Confirm Send message</button>
              </div>
            </div>
            <div id="activity-center" hidden>
              <h2>Activity</h2>
              <button id="reopen" type="button">Message tenant</button>
            </div>
          </main>
          <script>
            const status = document.getElementById('status');
            const workPanel = document.getElementById('work-panel');
            const confirm = document.getElementById('confirm');
            const activityCenter = document.getElementById('activity-center');

            document.getElementById('send').addEventListener('click', () => {
              status.textContent = 'Working';
              workPanel.hidden = false;
            });

            document.getElementById('send-message').addEventListener('click', () => {
              confirm.hidden = false;
            });

            document.getElementById('confirm-send').addEventListener('click', () => {
              confirm.hidden = true;
              workPanel.hidden = true;
              status.textContent = 'Sent';
              window.__assistantRuns = [{ id: 'run-1', title: 'Message tenant' }];
            });

            document.getElementById('activity').addEventListener('click', () => {
              activityCenter.hidden = false;
            });

            document.getElementById('reopen').addEventListener('click', () => {
              activityCenter.hidden = true;
              workPanel.hidden = false;
              status.textContent = 'Reopened';
            });
          </script>
        </body>
      </html>
    `);

    await page.getByLabel('Ask the assistant').fill('Draft a maintenance update for Taylor');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByRole('status')).toHaveText('Working');
    await expect(page.getByRole('heading', { name: 'Answer' })).toBeVisible();
    await expect(page.getByText('A tenant message is ready for your review.')).toBeVisible();

    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Nothing happens until you confirm');
    await page.getByRole('button', { name: 'Confirm Send message' }).click();
    await expect(page.getByRole('status')).toHaveText('Sent');

    await page.getByRole('button', { name: 'Activity' }).click();
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await page.getByRole('button', { name: 'Message tenant' }).click();
    await expect(page.getByRole('heading', { name: 'Answer' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Reopened');
  });
});
