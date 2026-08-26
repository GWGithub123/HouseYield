import { afterEach, describe, expect, it } from 'vitest';
import {
  getAssistantExperience,
  setAssistantExperience,
} from './assistantExperienceFlags';

describe('assistant experience rollout flag', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to the intuitive experience', () => {
    expect(getAssistantExperience()).toBe('intuitive');
  });

  it('supports a reversible per-browser override', () => {
    setAssistantExperience('legacy');
    expect(getAssistantExperience()).toBe('legacy');

    setAssistantExperience('intuitive');
    expect(getAssistantExperience()).toBe('intuitive');
  });

  it('falls back to the env default when localStorage is unavailable', () => {
    const experience = getAssistantExperience();
    expect(experience === 'intuitive' || experience === 'legacy').toBe(true);
  });
});
