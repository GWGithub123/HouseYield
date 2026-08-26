export interface TriageChoiceOption {
  id: string;
  label: string;
  detail: string;
}

export interface TriageChoiceQuestion {
  id: string;
  question: string;
  allowMultiple: boolean;
  options: TriageChoiceOption[];
}

export interface TriageKnownFacts {
  location: string | null;
  room: string | null;
  fixture: string | null;
  severity: 'slow' | 'moderate' | 'severe' | null;
  duration: 'today' | 'days' | 'long' | null;
  damage: 'reported' | null;
  shutoff: 'reported' | null;
}

export type TriageCategory =
  | 'Plumbing'
  | 'Electrical'
  | 'HVAC'
  | 'Appliances'
  | 'Structural'
  | 'Pest Control'
  | 'Lock/Security'
  | 'Other';

export declare const MAX_CHOICE_QUESTIONS: number;

export declare function detectKnownFacts(text?: string): TriageKnownFacts;

export declare function detectCategory(text?: string): TriageCategory;

export declare function buildChoiceQuestions(options?: {
  category?: string;
  text?: string;
  answeredIds?: string[];
}): TriageChoiceQuestion[];

export declare function normalizeChoiceQuestions(
  raw: unknown,
  options?: { answeredIds?: string[] },
): TriageChoiceQuestion[];

export declare function buildTriagePrompt(options?: {
  speaker?: 'owner' | 'tenant';
  message?: string;
  sanitizedMessages?: Array<{ role: string; content: string }>;
  currentDraft?: unknown;
  knownFacts?: Partial<TriageKnownFacts>;
  answeredIds?: string[];
}): string;
