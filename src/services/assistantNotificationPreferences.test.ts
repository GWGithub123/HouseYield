import { afterEach, describe, expect, it } from 'vitest';
import {
  getAssistantNotificationPreferences,
  isTrivialAssistantNavigation,
  setAssistantNotificationPreference,
  shouldNotifyAssistantEvent,
} from './assistantNotificationPreferences';

describe('assistant notification preferences', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults categories on and skips trivial navigation', () => {
    expect(getAssistantNotificationPreferences()).toEqual({
      completion: true,
      failure: true,
      approval: true,
      reminder: true,
    });
    expect(isTrivialAssistantNavigation('navigate-to-portfolio')).toBe(true);
    expect(shouldNotifyAssistantEvent('completion', { actionId: 'open-page-dashboard' })).toBe(false);
    expect(shouldNotifyAssistantEvent('completion', { actionId: 'message-tenant' })).toBe(true);
  });

  it('persists category toggles', () => {
    setAssistantNotificationPreference('reminder', false);
    expect(getAssistantNotificationPreferences().reminder).toBe(false);
    expect(shouldNotifyAssistantEvent('reminder')).toBe(false);
  });
});
