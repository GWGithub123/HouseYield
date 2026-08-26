import React, { useCallback, useEffect, useState } from 'react';
import {
  cancelAssistantScheduledTask,
  createAssistantScheduledTask,
  deleteAssistantScheduledTask,
  formatScheduledTaskWhen,
  listAssistantScheduledTasks,
  type AssistantScheduledTask,
} from '../services/assistantScheduledTasksClient';

type Props = {
  open: boolean;
  onClose: () => void;
  onAskAssistant?: (prompt: string) => void;
};

function statusStyles(status: string) {
  switch (status) {
    case 'scheduled':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800';
    case 'running':
      return 'border-blue-200 bg-blue-50 text-blue-800';
    case 'failed':
      return 'border-red-200 bg-red-50 text-red-700';
    case 'cancelled':
      return 'border-slate-200 bg-slate-50 text-slate-500';
    case 'completed':
      return 'border-slate-200 bg-slate-100 text-slate-600';
    default:
      return 'border-slate-200 bg-white text-slate-600';
  }
}

export const AssistantScheduledTasksModal: React.FC<Props> = ({ open, onClose, onAskAssistant }) => {
  const [tasks, setTasks] = useState<AssistantScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await listAssistantScheduledTasks({ includeCompleted: false, limit: 40 });
      setTasks(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load scheduled tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleCreate = async () => {
    if (!title.trim() || !when.trim()) {
      setError('Add a task title and when it should run.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createAssistantScheduledTask({
        title: title.trim(),
        when: when.trim(),
        notes: notes.trim() || undefined,
      });
      setTitle('');
      setWhen('');
      setNotes('');
      setShowComposer(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create task');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async (taskId: string) => {
    setBusyId(taskId);
    setError(null);
    try {
      await cancelAssistantScheduledTask(taskId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel task');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (taskId: string) => {
    setBusyId(taskId);
    setError(null);
    try {
      await deleteAssistantScheduledTask(taskId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete task');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[10020] flex items-end justify-center bg-slate-950/35 p-3 sm:items-center">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close schedule" onClick={onClose} />
      <div className="relative z-10 flex max-h-[min(88vh,720px)] w-full max-w-md flex-col overflow-hidden rounded-[24px] border border-slate-200/80 bg-[#fffdf7] shadow-[0_24px_80px_rgba(15,23,42,0.28)]">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 px-4 py-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">AI schedule</div>
            <div className="mt-1 text-base font-semibold tracking-[-0.03em] text-slate-950">Upcoming tasks</div>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              Ask the assistant to run something later, or jot dated reminders here.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-500 hover:text-slate-900"
          >
            Close
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="rounded-2xl border border-slate-200 bg-white px-3 py-8 text-center text-sm text-slate-500">
              Loading schedule…
            </div>
          ) : tasks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-3 py-8 text-center">
              <div className="text-sm font-semibold text-slate-900">Nothing scheduled yet</div>
              <p className="mt-2 text-xs leading-5 text-slate-600">
                Try: “Monday at 2pm, book a plumber for Prestwick” or add a task below.
              </p>
            </div>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm shadow-slate-900/5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-950">{task.title}</div>
                    <div className="mt-1 text-xs font-medium text-slate-600">
                      {formatScheduledTaskWhen(task.runAt)}
                    </div>
                  </div>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] ${statusStyles(task.status)}`}>
                    {task.status}
                  </span>
                </div>
                {task.notes ? (
                  <p className="mt-2 text-xs leading-5 text-slate-600 line-clamp-3">{task.notes}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-medium text-slate-500">
                  {task.kind === 'action' && task.actionId ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5">AI: {task.actionId.replace(/-/g, ' ')}</span>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5">Reminder</span>
                  )}
                  {task.propertyAddress ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5">{task.propertyAddress}</span>
                  ) : null}
                </div>
                <div className="mt-3 flex gap-2">
                  {task.status === 'scheduled' || task.status === 'failed' ? (
                    <button
                      type="button"
                      disabled={busyId === task.id}
                      onClick={() => void handleCancel(task.id)}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busyId === task.id}
                    onClick={() => void handleDelete(task.id)}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-500 hover:text-red-600 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-slate-200/70 bg-[#fbf8ef] px-4 py-3">
          {showComposer ? (
            <div className="space-y-2">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Task title"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              />
              <input
                value={when}
                onChange={(event) => setWhen(event.target.value)}
                placeholder="When — e.g. Friday at 3pm"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              />
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Notes for the AI (optional)"
                rows={3}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleCreate()}
                  className="flex-1 rounded-full bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Add to schedule'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowComposer(false)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowComposer(true)}
                className="w-full rounded-full bg-slate-950 px-3 py-2 text-sm font-semibold text-white"
              >
                Add dated task
              </button>
              {onAskAssistant ? (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onAskAssistant('Help me schedule an upcoming AI task. Ask me what to do and when.');
                  }}
                  className="w-full rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                >
                  Ask AI to schedule something
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AssistantScheduledTasksModal;
