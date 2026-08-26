import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  AVAILABILITY_WINDOW_LABELS,
  formatAvailabilityDate,
  type AvailabilitySelection,
  type AvailabilityWindow,
} from '../../services/maintenanceApi';

const WINDOWS: AvailabilityWindow[] = ['morning', 'afternoon', 'evening'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function toDateStr(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

interface AvailabilityPickerProps {
  value: AvailabilitySelection[];
  onChange: (next: AvailabilitySelection[]) => void;
}

/** Date grid plus per-date time windows. Shared by owner intake and tenant submission. */
export default function AvailabilityPicker({ value, onChange }: AvailabilityPickerProps) {
  const [month, setMonth] = useState<Date>(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });

  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const leadingBlanks = new Date(year, monthIndex, 1).getDay();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const isSelected = (dateStr: string) => value.some((entry) => entry.date === dateStr);
  const windowsFor = (dateStr: string) => value.find((entry) => entry.date === dateStr)?.windows ?? [];

  const toggleDate = (dateStr: string) => {
    if (isSelected(dateStr)) {
      onChange(value.filter((entry) => entry.date !== dateStr));
      return;
    }
    onChange([...value, { date: dateStr, windows: [] }].sort((a, b) => a.date.localeCompare(b.date)));
  };

  const toggleWindow = (dateStr: string, window: AvailabilityWindow) => {
    onChange(
      value.map((entry) => {
        if (entry.date !== dateStr) return entry;
        const windows = entry.windows.includes(window)
          ? entry.windows.filter((w) => w !== window)
          : [...entry.windows, window];
        return { ...entry, windows };
      }),
    );
  };

  const cells = [
    ...Array.from({ length: leadingBlanks }, (_, i) => <div key={`blank-${i}`} />),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      const dateStr = toDateStr(year, monthIndex, day);
      const cellDate = new Date(year, monthIndex, day);
      cellDate.setHours(0, 0, 0, 0);
      const isPast = cellDate < today;
      const selected = isSelected(dateStr);

      return (
        <button
          key={dateStr}
          type="button"
          disabled={isPast}
          onClick={() => toggleDate(dateStr)}
          aria-pressed={selected}
          className={[
            'ds-focus-ring h-9 w-full rounded-lg text-sm font-medium transition',
            isPast
              ? 'cursor-not-allowed text-slate-300'
              : selected
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-700 hover:bg-emerald-50 hover:text-emerald-700',
          ].join(' ')}
        >
          {day}
        </button>
      );
    }),
  ];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}
          className="ds-focus-ring rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold text-slate-800">
          {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </span>
        <button
          type="button"
          onClick={() => setMonth(new Date(year, monthIndex + 1, 1))}
          className="ds-focus-ring rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100"
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7 text-center">
        {WEEKDAYS.map((day) => (
          <div key={day} className="py-1 text-xs font-medium text-slate-400">{day}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">{cells}</div>

      {value.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Preferred windows</p>
          {[...value]
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(({ date }) => (
              <div key={date} className="flex flex-wrap items-center gap-1.5">
                <span className="w-24 shrink-0 text-xs font-medium text-slate-700">
                  {formatAvailabilityDate(date)}
                </span>
                {WINDOWS.map((window) => {
                  const active = windowsFor(date).includes(window);
                  return (
                    <button
                      key={window}
                      type="button"
                      onClick={() => toggleWindow(date, window)}
                      aria-pressed={active}
                      title={AVAILABILITY_WINDOW_LABELS[window]}
                      className={[
                        'ds-focus-ring rounded-full border px-2 py-0.5 text-xs font-medium transition',
                        active
                          ? 'border-emerald-600 bg-emerald-600 text-white'
                          : 'border-slate-300 text-slate-500 hover:border-emerald-400 hover:text-emerald-600',
                      ].join(' ')}
                    >
                      {window.charAt(0).toUpperCase() + window.slice(1)}
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
