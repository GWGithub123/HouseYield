import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildAssistantMemoryItemKey, clearAssistantMemory, getAssistantMemory, setAssistantMemory } from '../services/assistantMemoryService';
import type { AssistantMemoryProfileArrayField, AssistantMemorySnapshot } from '../types/assistantMemory';

interface DashboardAssistantMemoriesModalProps {
  isOpen: boolean;
  userId?: string | null;
  onClose: () => void;
}

const PROFILE_ARRAY_FIELDS = [
  'userPreferences',
  'durableFacts',
  'realEstateSearchMemory',
  'recurringGoals',
  'favoriteWorkflows',
] as const;

type EditableProfileArrayField = AssistantMemoryProfileArrayField;

type EditableMemoryItemTarget =
  {
      kind: 'profile-array';
      field: EditableProfileArrayField;
      index: number;
    };

type EditableMemoryItem = {
  id: string;
  section: string;
  title: string;
  text: string;
  preview: string;
  subtitle: string;
  createdAt: string | null;
  sortTimestamp: number;
  target: EditableMemoryItemTarget;
};

const PROFILE_ARRAY_META: Record<EditableProfileArrayField, { section: string; title: string }> = {
  userPreferences: { section: 'Personalization', title: 'User preference' },
  durableFacts: { section: 'Durable facts', title: 'Durable fact' },
  realEstateSearchMemory: { section: 'Real estate search', title: 'Saved search signal' },
  recurringGoals: { section: 'Recurring goals', title: 'Recurring goal' },
  favoriteWorkflows: { section: 'Favorite workflows', title: 'Workflow' },
};

const MEMORY_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatMemoryDate(value?: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return MEMORY_DATE_FORMATTER.format(date);
}

function buildPreview(text: string, maxLength = 110) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function buildSubtitle(...parts: Array<string | null | undefined | false>) {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' • ');
}

function buildSessionSubtitle(session: AssistantMemorySnapshot['recentSessions'][number]) {
  return buildSubtitle(
    formatMemoryDate(session.updatedAt || session.endedAt || session.startedAt),
    session.topicTags.length > 0 ? session.topicTags.join(', ') : null,
    session.messageCount > 0 ? `${session.messageCount} messages` : null,
  );
}

function getMemoryItemCreatedAt(
  snapshot: AssistantMemorySnapshot,
  field: EditableProfileArrayField,
  text: string,
) {
  const key = buildAssistantMemoryItemKey(field, text);
  if (!key) {
    return snapshot.profile.updatedAt || null;
  }

  return snapshot.profile.itemCreatedAt[field][key] || snapshot.profile.updatedAt || null;
}

function buildAssistantMemoryItems(snapshot: AssistantMemorySnapshot | null) {
  if (!snapshot) {
    return [] as EditableMemoryItem[];
  }

  const items: EditableMemoryItem[] = [];

  PROFILE_ARRAY_FIELDS.forEach((field) => {
    const meta = PROFILE_ARRAY_META[field];

    snapshot.profile[field].forEach((value, index) => {
      const text = value.trim();
      if (!text) {
        return;
      }

      const createdAt = getMemoryItemCreatedAt(snapshot, field, text);
      const sortTimestamp = createdAt ? new Date(createdAt).getTime() : 0;

      items.push({
        id: `profile-${field}-${index}`,
        section: meta.section,
        title: meta.title,
        text,
        preview: buildPreview(text, 124),
        subtitle: buildSubtitle('Added', formatMemoryDate(createdAt)),
        createdAt,
        sortTimestamp: Number.isNaN(sortTimestamp) ? 0 : sortTimestamp,
        target: {
          kind: 'profile-array',
          field,
          index,
        },
      });
    });
  });

  return items.sort((left, right) => {
    if (right.sortTimestamp !== left.sortTimestamp) {
      return right.sortTimestamp - left.sortTimestamp;
    }

    return left.id.localeCompare(right.id);
  });
}

function applyAssistantMemoryMutation(
  snapshot: AssistantMemorySnapshot,
  item: EditableMemoryItem,
  nextText: string,
  remove: boolean,
): AssistantMemorySnapshot {
  const nowIso = new Date().toISOString();
  const fieldCreatedAt = { ...snapshot.profile.itemCreatedAt[item.target.field] };
  const currentItemKey = buildAssistantMemoryItemKey(item.target.field, item.text);
  const nextItemKey = buildAssistantMemoryItemKey(item.target.field, nextText);
  const preservedCreatedAt = currentItemKey ? fieldCreatedAt[currentItemKey] || nowIso : nowIso;

  if (currentItemKey) {
    delete fieldCreatedAt[currentItemKey];
  }
  if (!remove && nextItemKey) {
    fieldCreatedAt[nextItemKey] = preservedCreatedAt;
  }

  const nextProfile = {
    ...snapshot.profile,
    updatedAt: nowIso,
    itemCreatedAt: {
      ...snapshot.profile.itemCreatedAt,
      [item.target.field]: fieldCreatedAt,
    },
  };
  const nextValues = remove
    ? snapshot.profile[item.target.field].filter((_, index) => index !== item.target.index)
    : snapshot.profile[item.target.field].map((value, index) => (
        index === item.target.index ? nextText : value
      ));

  return {
    ...snapshot,
    profile: {
      ...nextProfile,
      [item.target.field]: nextValues,
    } as AssistantMemorySnapshot['profile'],
  };
}

export default function DashboardAssistantMemoriesModal({
  isOpen,
  userId,
  onClose,
}: DashboardAssistantMemoriesModalProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [memorySnapshot, setMemorySnapshot] = useState<AssistantMemorySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusIsError, setStatusIsError] = useState(false);

  const items = useMemo(() => buildAssistantMemoryItems(memorySnapshot), [memorySnapshot]);
  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return items;
    }

    return items.filter((item) => [item.section, item.title, item.text, item.subtitle]
      .some((value) => value.toLowerCase().includes(query)));
  }, [items, searchQuery]);
  const selectedItem = useMemo(
    () => filteredItems.find((item) => item.id === selectedItemId) || null,
    [filteredItems, selectedItemId],
  );
  const hasUnsavedChanges = selectedItem ? draftText.trim() !== selectedItem.text.trim() : false;
  const profileUpdatedAt = formatMemoryDate(memorySnapshot?.profile.updatedAt);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setStatusMessage(null);
      setStatusIsError(false);
      return;
    }

    let cancelled = false;

    const loadSnapshot = async () => {
      if (!userId) {
        setMemorySnapshot(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setMemorySnapshot(null);
      setStatusMessage(null);
      setStatusIsError(false);

      try {
        const snapshot = await getAssistantMemory(userId);
        if (cancelled) {
          return;
        }

        setMemorySnapshot(snapshot);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setMemorySnapshot(null);
        setStatusMessage('Failed to load assistant memory.');
        setStatusIsError(true);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadSnapshot();

    return () => {
      cancelled = true;
    };
  }, [isOpen, reloadToken, userId]);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!filteredItems.length) {
      setSelectedItemId(null);
      return;
    }

    setSelectedItemId((current) => (
      current && filteredItems.some((item) => item.id === current)
        ? current
        : filteredItems[0].id
    ));
  }, [filteredItems]);

  useEffect(() => {
    setDraftText(selectedItem?.text ?? '');
    setStatusMessage(null);
    setStatusIsError(false);
  }, [selectedItem]);

  if (!isOpen) {
    return null;
  }

  const handleSave = async () => {
    if (!userId || !memorySnapshot || !selectedItem) {
      return;
    }

    const trimmedDraft = draftText.trim();
    if (!trimmedDraft) {
      setStatusMessage('Memory text cannot be blank.');
      setStatusIsError(true);
      return;
    }

    const nextSnapshot = applyAssistantMemoryMutation(memorySnapshot, selectedItem, trimmedDraft, false);

    setSaving(true);
    setStatusMessage(null);
    setStatusIsError(false);

    try {
      const result = await setAssistantMemory(userId, nextSnapshot);
      if (!result.success) {
        setStatusMessage(result.error || 'Failed to save assistant memory.');
        setStatusIsError(true);
        return;
      }

      const refreshedSnapshot = await getAssistantMemory(userId);
      setMemorySnapshot(refreshedSnapshot || nextSnapshot);
      setStatusMessage('Saved to Firestore.');
    } catch (error) {
      setStatusMessage('Failed to save assistant memory.');
      setStatusIsError(true);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!userId || !memorySnapshot || !selectedItem) {
      return;
    }

    const nextSnapshot = applyAssistantMemoryMutation(memorySnapshot, selectedItem, selectedItem.text, true);

    setSaving(true);
    setStatusMessage(null);
    setStatusIsError(false);

    try {
      const result = await setAssistantMemory(userId, nextSnapshot);
      if (!result.success) {
        setStatusMessage(result.error || 'Failed to remove assistant memory.');
        setStatusIsError(true);
        return;
      }

      const refreshedSnapshot = await getAssistantMemory(userId);
      setMemorySnapshot(refreshedSnapshot || nextSnapshot);
      setStatusMessage('Removed from Firestore memory.');
    } catch (error) {
      setStatusMessage('Failed to remove assistant memory.');
      setStatusIsError(true);
    } finally {
      setSaving(false);
    }
  };

  const handleClearAll = async () => {
    if (!userId) {
      return;
    }

    const confirmed = window.confirm(
      'Clear all saved assistant memories, recent sessions, and recent exchanges for this account?',
    );
    if (!confirmed) {
      return;
    }

    setSaving(true);
    setStatusMessage(null);
    setStatusIsError(false);

    try {
      const result = await clearAssistantMemory(userId);
      if (!result.success) {
        setStatusMessage(result.error || 'Failed to clear assistant memory.');
        setStatusIsError(true);
        return;
      }

      const refreshedSnapshot = await getAssistantMemory(userId);
      setMemorySnapshot(refreshedSnapshot);
      setSelectedItemId(null);
      setStatusMessage('Cleared all assistant memory.');
    } catch (error) {
      setStatusMessage('Failed to clear assistant memory.');
      setStatusIsError(true);
    } finally {
      setSaving(false);
    }
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-[10002] flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-md sm:p-5 lg:p-8"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dashboard-assistant-memories-title"
        className="flex h-[min(640px,76vh)] w-full max-w-[920px] flex-col overflow-hidden rounded-[26px] border border-slate-700 bg-[#10141b] text-slate-100 shadow-[0_28px_100px_rgba(2,6,23,0.5)]"
      >
        <div className="flex flex-col gap-4 border-b border-slate-800 px-6 py-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Persistent assistant memory</div>
            <h2 id="dashboard-assistant-memories-title" className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-white">Saved memories</h2>
            <div className="mt-2 text-sm text-slate-400">
              {profileUpdatedAt
                ? `${filteredItems.length} of ${items.length} memories • profile updated ${profileUpdatedAt}`
                : `${filteredItems.length} of ${items.length} memories synced from Firestore`}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setReloadToken((value) => value + 1)}
              disabled={loading || !userId}
              className="rounded-full border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => void handleClearAll()}
              disabled={loading || saving || !userId}
              className="rounded-full border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-200 transition hover:border-red-400/60 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear all memory
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-700 bg-transparent px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-slate-500 hover:text-white"
              aria-label="Close saved memories"
            >
              Close
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,0.95fr)_minmax(320px,0.8fr)]">
          <div className="flex min-h-0 flex-col border-b border-slate-800 lg:border-b-0 lg:border-r lg:border-slate-800">
            <div className="border-b border-slate-800 px-6 py-4">
              <label className="flex items-center gap-3 rounded-full border border-slate-700 bg-slate-900/80 px-4 py-3 focus-within:border-cyan-400/70 focus-within:ring-2 focus-within:ring-cyan-400/20">
                <svg className="h-4 w-4 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m21 21-4.35-4.35m1.85-5.15a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />
                </svg>
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search memories"
                  disabled={loading || !items.length}
                  className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500 disabled:cursor-not-allowed disabled:text-slate-500"
                />
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {loading ? (
                <div className="flex h-full items-center justify-center px-6 py-12 text-center text-slate-400">
                  <div>
                    <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-300" />
                    <div className="mt-4 text-sm font-medium">Loading saved memories from Firestore...</div>
                  </div>
                </div>
              ) : !userId ? (
                <div className="flex h-full items-center justify-center px-6 py-12 text-center text-slate-400">
                  Sign in to load persistent assistant memory.
                </div>
              ) : items.length === 0 ? (
                <div className="flex h-full items-center justify-center px-6 py-12 text-center text-slate-400">
                  No saved memories are stored for this account yet.
                </div>
              ) : filteredItems.length === 0 ? (
                <div className="flex h-full items-center justify-center px-6 py-12 text-center text-slate-400">
                  No saved memories match this search.
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredItems.map((item) => {
                    const isSelected = selectedItem?.id === item.id;

                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedItemId(item.id)}
                        className={`w-full rounded-[22px] border px-4 py-4 text-left transition ${
                          isSelected
                            ? 'border-cyan-400/60 bg-slate-800/90 shadow-[0_12px_30px_rgba(8,145,178,0.18)]'
                            : 'border-transparent bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900'
                        }`}
                      >
                        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                          <span>{item.section}</span>
                          <span className="rounded-full bg-slate-800 px-2 py-1 text-[9px] tracking-[0.14em] text-slate-300">{item.title}</span>
                        </div>
                        <p className="mt-3 text-[15px] leading-6 text-slate-100">{item.preview}</p>
                        <div className="mt-3 text-xs text-slate-500">{item.subtitle}</div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col bg-slate-950/35">
            {selectedItem ? (
              <>
                <div className="border-b border-slate-800 px-6 py-5">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">{selectedItem.section}</div>
                  <h3 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-white">{selectedItem.title}</h3>
                  <p className="mt-2 text-sm text-slate-400">{selectedItem.subtitle}</p>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                  <div className="text-sm leading-6 text-slate-400">
                    Edit the exact saved memory text the persistent assistant uses the next time it pulls this Firestore snapshot.
                  </div>

                  <textarea
                    value={draftText}
                    onChange={(event) => {
                      setDraftText(event.target.value);
                      setStatusMessage(null);
                      setStatusIsError(false);
                    }}
                    className="mt-4 min-h-[320px] w-full rounded-[24px] border border-slate-700 bg-slate-900 px-4 py-4 text-[15px] leading-7 text-slate-100 outline-none transition focus:border-cyan-400/70 focus:ring-2 focus:ring-cyan-400/20"
                  />

                  {statusMessage ? (
                    <div className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${statusIsError ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'}`}>
                      {statusMessage}
                    </div>
                  ) : null}

                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saving || !hasUnsavedChanges || !draftText.trim()}
                      className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {saving ? 'Saving...' : 'Save changes'}
                    </button>

                    <button
                      type="button"
                      onClick={handleRemove}
                      disabled={saving}
                      className="rounded-full border border-slate-700 bg-transparent px-5 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Remove memory
                    </button>

                    <div className={`text-xs font-medium ${hasUnsavedChanges ? 'text-amber-300' : 'text-slate-500'}`}>
                      {hasUnsavedChanges ? 'Unsaved changes' : 'No local changes'}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center px-6 py-12 text-center text-slate-400">
                Select a memory to view and edit its exact Firestore value.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modalContent;
  }

  return createPortal(modalContent, document.body);
}