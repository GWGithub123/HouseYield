const STORAGE_KEY = 'houseyield:assistant-experience';

export type AssistantExperience = 'legacy' | 'intuitive';

export function getAssistantExperience(): AssistantExperience {
  if (typeof window !== 'undefined') {
    const override = window.localStorage.getItem(STORAGE_KEY);
    if (override === 'legacy' || override === 'intuitive') return override;
  }

  return import.meta.env.VITE_INTUITIVE_ASSISTANT === 'false' ? 'legacy' : 'intuitive';
}

export function setAssistantExperience(experience: AssistantExperience) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, experience);
  } catch {
    try {
      window.localStorage.removeItem('houseyield:assistant-activity:v1');
      window.localStorage.setItem(STORAGE_KEY, experience);
    } catch {
      // Preference persistence is optional.
    }
  }
  window.dispatchEvent(new CustomEvent('houseyield:assistant-experience-changed', {
    detail: { experience },
  }));
}
