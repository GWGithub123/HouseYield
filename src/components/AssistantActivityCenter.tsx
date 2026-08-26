import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer } from '../design-system';
import { useAssistantActivity } from '../contexts/AssistantActivityContext';
import {
  cancelAssistantScheduledTask,
  createAssistantScheduledTask,
  deleteAssistantScheduledTask,
  formatScheduledTaskWhen,
  listAssistantScheduledTasks,
  pauseAssistantScheduledTask,
  rescheduleAssistantScheduledTask,
  resumeAssistantScheduledTask,
  retryAssistantScheduledTask,
  updateAssistantScheduledTask,
  type AssistantScheduledTask,
} from '../services/assistantScheduledTasksClient';
import { trackAssistantTelemetry } from '../services/assistantTelemetry';

type Props = {
  open: boolean;
  onClose: () => void;
  onAskAssistant?: (prompt: string) => void;
};

type Filter = 'all' | 'waiting' | 'in_progress' | 'scheduled' | 'completed' | 'failed';

type ActivityItem = {
  id: string;
  title: string;
  detail: string;
  status: Filter;
  time: number;
  runId?: string;
  task?: AssistantScheduledTask;
};

function runFilterStatus(run: {
  status: string;
  result?: { type?: string } | null;
  steps: string[];
}): Exclude<Filter, 'all' | 'scheduled'> {
  if (run.status === 'error') return 'failed';
  if (run.status === 'complete') return 'completed';
  if (run.result?.type === 'needs_input' || run.steps.some((step) => /waiting/i.test(step))) {
    return 'waiting';
  }
  return 'in_progress';
}

function taskFilterStatus(task: AssistantScheduledTask): Exclude<Filter, 'all'> {
  if (task.status === 'failed') return 'failed';
  if (task.status === 'completed' || task.status === 'cancelled') return 'completed';
  if (task.status === 'running') return 'in_progress';
  if (task.status === 'paused') return 'scheduled';
  return 'scheduled';
}

export function AssistantActivityCenter({ open, onClose, onAskAssistant }: Props) {
  const { runs, activateRun, clearCompleted, refreshActivities } = useAssistantActivity();
  const [scheduled, setScheduled] = useState<AssistantScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editWhen, setEditWhen] = useState('');
  const [showComposer, setShowComposer] = useState(false);
  const [composerTitle, setComposerTitle] = useState('');
  const [composerWhen, setComposerWhen] = useState('');
  const [composerNotes, setComposerNotes] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setScheduled(await listAssistantScheduledTasks({ includeCompleted: true, limit: 50 }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Scheduled work is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void Promise.all([
        refresh(),
        refreshActivities().catch(() => undefined),
      ]);
    }
  }, [open, refresh, refreshActivities]);

  const items = useMemo(() => {
    const runItems: ActivityItem[] = runs.map((run) => ({
      id: run.runId,
      title: run.title,
      detail: run.summary,
      status: runFilterStatus(run),
      time: run.completedAt || run.startedAt,
      runId: run.runId,
    }));
    const scheduledItems: ActivityItem[] = scheduled.map((task) => ({
      id: `scheduled:${task.id}`,
      title: task.title,
      detail: task.resultSummary || task.lastError || formatScheduledTaskWhen(task.runAt),
      status: taskFilterStatus(task),
      time: new Date(task.updatedAt || task.createdAt || task.runAt).getTime(),
      task,
    }));
    return [...runItems, ...scheduledItems]
      .filter((item) => filter === 'all' || item.status === filter)
      .sort((a, b) => b.time - a.time);
  }, [filter, runs, scheduled]);

  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'waiting', label: 'Waiting' },
    { id: 'in_progress', label: 'In progress' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'completed', label: 'Completed' },
    { id: 'failed', label: 'Failed' },
  ];

  const runTaskAction = async (taskId: string, action: () => Promise<unknown>) => {
    setBusyId(taskId);
    setError('');
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update scheduled task.');
    } finally {
      setBusyId(null);
    }
  };

  const handleCreate = async () => {
    if (!composerTitle.trim() || !composerWhen.trim()) {
      setError('Add a title and when it should run.');
      return;
    }
    await runTaskAction('create', async () => {
      await createAssistantScheduledTask({
        title: composerTitle.trim(),
        when: composerWhen.trim(),
        notes: composerNotes.trim() || undefined,
      });
      setComposerTitle('');
      setComposerWhen('');
      setComposerNotes('');
      setShowComposer(false);
      trackAssistantTelemetry('activity_started', { surface: 'activity_center', actionId: 'schedule-task' });
    });
  };

  return (
    <Drawer open={open} onClose={onClose} width="lg" title="Activity" subtitle="Current, scheduled, and recent assistant work">
      <div className="flex flex-wrap gap-2" aria-label="Filter activity">
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={`min-h-10 rounded-full px-3 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${filter === item.id ? 'bg-slate-950 text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setShowComposer((value) => !value)}
          className="min-h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800"
        >
          {showComposer ? 'Hide scheduler' : 'Schedule something'}
        </button>
        {onAskAssistant ? (
          <button
            type="button"
            onClick={() => {
              onClose();
              onAskAssistant('Help me schedule a reminder or action for later.');
            }}
            className="min-h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800"
          >
            Ask assistant to schedule
          </button>
        ) : null}
      </div>

      {showComposer ? (
        <div className="mt-3 space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-3">
          <label className="block text-sm font-medium text-slate-700">
            Title
            <input value={composerTitle} onChange={(event) => setComposerTitle(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3" />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            When
            <input value={composerWhen} onChange={(event) => setComposerWhen(event.target.value)} placeholder="tomorrow at 9am" className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3" />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Notes
            <textarea value={composerNotes} onChange={(event) => setComposerNotes(event.target.value)} rows={2} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>
          <button type="button" disabled={busyId === 'create'} onClick={() => void handleCreate()} className="min-h-11 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-50">
            {busyId === 'create' ? 'Saving…' : 'Save schedule'}
          </button>
        </div>
      ) : null}

      {error ? <div role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{error}</div> : null}

      <div className="mt-4 space-y-2" aria-busy={loading}>
        {items.map((item) => {
          const isExpanded = expandedId === item.id;
          return (
            <div key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  disabled={!item.runId && !item.task}
                  onClick={() => {
                    if (item.runId) {
                      onClose();
                      activateRun(item.runId);
                      return;
                    }
                    if (item.task) {
                      setExpandedId(isExpanded ? null : item.id);
                      setEditTitle(item.task.title);
                      setEditWhen('');
                    }
                  }}
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                >
                  <div className="font-semibold text-slate-950">{item.title}</div>
                  <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-600">{item.detail}</p>
                </button>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs font-medium capitalize text-slate-600">
                  {item.status.replace('_', ' ')}
                  {item.task?.status === 'paused' ? ' · paused' : ''}
                </span>
              </div>

              {item.task && isExpanded ? (
                <div className="mt-4 space-y-3 border-t border-slate-100 pt-3">
                  <label className="block text-sm font-medium text-slate-700">
                    Edit title
                    <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3" />
                  </label>
                  <label className="block text-sm font-medium text-slate-700">
                    Reschedule
                    <input value={editWhen} onChange={(event) => setEditWhen(event.target.value)} placeholder="Friday at 3pm" className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3" />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busyId === item.task.id || !editTitle.trim()}
                      onClick={() => void runTaskAction(item.task!.id, () => updateAssistantScheduledTask(item.task!.id, { title: editTitle.trim() }))}
                      className="min-h-10 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-800 disabled:opacity-50"
                    >
                      Save edit
                    </button>
                    {editWhen.trim() ? (
                      <button
                        type="button"
                        disabled={busyId === item.task.id}
                        onClick={() => void runTaskAction(item.task!.id, () => rescheduleAssistantScheduledTask(item.task!.id, editWhen.trim()))}
                        className="min-h-10 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-800 disabled:opacity-50"
                      >
                        Reschedule
                      </button>
                    ) : null}
                    {item.task.status === 'paused' ? (
                      <button
                        type="button"
                        disabled={busyId === item.task.id}
                        onClick={() => void runTaskAction(item.task!.id, () => resumeAssistantScheduledTask(item.task!.id))}
                        className="min-h-10 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-800 disabled:opacity-50"
                      >
                        Resume
                      </button>
                    ) : item.task.status === 'scheduled' ? (
                      <button
                        type="button"
                        disabled={busyId === item.task.id}
                        onClick={() => void runTaskAction(item.task!.id, () => pauseAssistantScheduledTask(item.task!.id))}
                        className="min-h-10 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-800 disabled:opacity-50"
                      >
                        Pause
                      </button>
                    ) : null}
                    {item.task.status === 'failed' || item.task.status === 'cancelled' ? (
                      <button
                        type="button"
                        disabled={busyId === item.task.id}
                        onClick={() => void runTaskAction(item.task!.id, () => retryAssistantScheduledTask(item.task!.id))}
                        className="min-h-10 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-800 disabled:opacity-50"
                      >
                        Retry
                      </button>
                    ) : null}
                    {item.task.status === 'scheduled' || item.task.status === 'paused' || item.task.status === 'failed' ? (
                      <button
                        type="button"
                        disabled={busyId === item.task.id}
                        onClick={() => void runTaskAction(item.task!.id, () => cancelAssistantScheduledTask(item.task!.id))}
                        className="min-h-10 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-800 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busyId === item.task.id}
                      onClick={() => void runTaskAction(item.task!.id, () => deleteAssistantScheduledTask(item.task!.id))}
                      className="min-h-10 rounded-xl border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-800 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        {!loading && items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">No activity in this view.</p>
        ) : null}
      </div>

      {runs.some((run) => run.status !== 'running') ? (
        <button type="button" onClick={clearCompleted} className="mt-5 min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700">
          Clear finished activity
        </button>
      ) : null}
    </Drawer>
  );
}

export default AssistantActivityCenter;
