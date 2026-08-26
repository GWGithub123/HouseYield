export type AssistantMemoryTopic =
  | 'portfolio'
  | 'netWorth'
  | 'properties'
  | 'maintenance'
  | 'sensors'
  | 'documents'
  | 'dashboard'
  | 'market'
  | 'navigation';

export interface AssistantMemoryExchange {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export type AssistantMemoryProfileArrayField =
  | 'userPreferences'
  | 'durableFacts'
  | 'realEstateSearchMemory'
  | 'recurringGoals'
  | 'favoriteWorkflows';

export type AssistantMemoryProfileItemCreatedAt = Record<AssistantMemoryProfileArrayField, Record<string, string>>;

export interface AssistantMemoryProfile {
  version: 1;
  updatedAt: string;
  preferredTone: string;
  preferredResponseLength: 'short';
  userPreferences: string[];
  durableFacts: string[];
  realEstateSearchMemory: string[];
  recurringGoals: string[];
  favoriteWorkflows: string[];
  itemCreatedAt: AssistantMemoryProfileItemCreatedAt;
  commonProperties: string[];
  portfolioContext: string[];
  topicCounts: Partial<Record<AssistantMemoryTopic, number>>;
  lastSessionSummary?: string;
}

export interface AssistantMemorySessionSummary {
  id: string;
  startedAt: string;
  endedAt: string;
  updatedAt: string;
  summary: string;
  userRequests: string[];
  assistantOutcomes: string[];
  topicTags: AssistantMemoryTopic[];
  messageCount: number;
}

export interface AssistantMemorySnapshot {
  profile: AssistantMemoryProfile;
  recentExchanges: AssistantMemoryExchange[];
  recentSessions: AssistantMemorySessionSummary[];
}