/**
 * Confirm-and-correct for a building's stacking plan.
 *
 * Mirrors the pattern the device pins already use: the twin draws its best guess,
 * says plainly that it is a guess, and gives you one obvious way to fix it. An
 * empty state that demanded a floor plan before drawing anything would get
 * abandoned; a building that is nearly right gets corrected in about fifteen
 * seconds, because the reader can see what is wrong.
 *
 * Five questions, and no more. Every field here changes what the propagation
 * engine will claim about a specific apartment, which is the bar for being on
 * this form — anything that only affects how the drawing looks does not belong.
 */
import { useEffect, useState } from 'react';

import { buildBuilding, type BuildingSpec, type CorridorKind } from './buildingModel';

export interface StackEditorProps {
  spec: BuildingSpec;
  /** True once a person has confirmed the plan rather than merely edited it. */
  confirmed: boolean;
  saving?: boolean;
  /** Persist failed; the drawing may still be using this draft. */
  error?: string | null;
  onSave: (spec: BuildingSpec) => void;
  onCancel: () => void;
}

const CORRIDOR_OPTIONS: Array<{ value: CorridorKind; label: string; hint: string }> = [
  {
    value: 'none',
    label: 'One row of units',
    hint: 'Walk-up or garden building, entries off an exterior breezeway.',
  },
  {
    value: 'double_loaded',
    label: 'Units on both sides',
    hint: 'Interior corridor with apartments facing each way.',
  },
];

/**
 * A number field with steppers.
 *
 * Bounded here as well as on the server, because the drawing is generated as
 * `floors × units × sides` and a typo in a free-text field should not be able to
 * ask the browser for fifty thousand rectangles.
 */
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const clamp = (next: number) => Math.min(Math.max(next, min), max);

  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[12px] font-medium text-slate-700">{label}</span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          className="h-7 w-7 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          onClick={() => onChange(clamp(value - 1))}
          disabled={value <= min}
          aria-label={`Fewer ${label.toLowerCase()}`}
        >
          −
        </button>
        <input
          type="number"
          className="h-7 w-14 rounded-md border border-slate-300 text-center text-[13px] font-semibold text-slate-800"
          value={value}
          min={min}
          max={max}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(clamp(Math.round(next)));
          }}
        />
        <button
          type="button"
          className="h-7 w-7 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          onClick={() => onChange(clamp(value + 1))}
          disabled={value >= max}
          aria-label={`More ${label.toLowerCase()}`}
        >
          +
        </button>
      </span>
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-[12px] font-medium text-slate-700">{label}</span>
        <span className="block text-[11px] leading-snug text-slate-500">{hint}</span>
      </span>
    </label>
  );
}

export default function StackEditor({
  spec,
  confirmed,
  saving = false,
  error = null,
  onSave,
  onCancel,
}: StackEditorProps) {
  const [draft, setDraft] = useState<BuildingSpec>(spec);

  // Re-seed when the underlying plan changes, e.g. the saved one arrives after
  // the guess. Editing a plan that is about to be replaced under you is worse
  // than losing an edit you have not committed.
  useEffect(() => setDraft(spec), [spec]);

  const set = <K extends keyof BuildingSpec>(key: K, value: BuildingSpec[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  // Built rather than multiplied out, so the count shown is the count the drawing
  // will actually produce — including the mirrored far side.
  const preview = buildBuilding(draft);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3">
        <h3 className="text-[13px] font-semibold text-slate-900">
          {confirmed ? 'Stacking plan' : 'Is this building right?'}
        </h3>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
          {confirmed
            ? 'Used to work out which apartments a leak can reach.'
            : 'Worked out from property records, which are often wrong about unit counts. Correcting it here is what lets the twin name specific apartments after a leak.'}
        </p>
      </div>

      <div className="space-y-2.5">
        <Stepper
          label="Floors"
          value={draft.floors}
          min={1}
          max={60}
          onChange={(value) => set('floors', value)}
        />
        <Stepper
          label="Units per floor, one side"
          value={draft.unitsPerFloor}
          min={1}
          max={40}
          onChange={(value) => set('unitsPerFloor', value)}
        />

        <fieldset className="pt-1">
          <legend className="mb-1.5 text-[12px] font-medium text-slate-700">Layout</legend>
          <div className="space-y-1.5">
            {CORRIDOR_OPTIONS.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="hy-corridor"
                  className="mt-0.5 h-4 w-4 border-slate-300 text-blue-600"
                  checked={draft.corridor === option.value}
                  onChange={() => set('corridor', option.value)}
                />
                <span>
                  <span className="block text-[12px] font-medium text-slate-700">{option.label}</span>
                  <span className="block text-[11px] leading-snug text-slate-500">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-2 pt-1">
          {draft.corridor === 'double_loaded' && (
            <Toggle
              label="Kitchens and baths back onto each other"
              /* Phrased as the thing a manager can see, not as "shared risers".
                 They are being asked whether the plumbing is in the wall between
                 the two units, and that is what it looks like from a hallway. */
              hint="Puts the unit across the hall in scope for a leak in the shared wall."
              checked={draft.sharedRisers}
              onChange={(value) => set('sharedRisers', value)}
            />
          )}
          <Toggle
            label="Has a basement or below-grade level"
            hint="Gives a ground-floor leak somewhere to run to."
            checked={draft.hasBasement}
            onChange={(value) => set('hasBasement', value)}
          />
        </div>
      </div>

      <p className="mt-3 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600">
        {preview.unitCount} {preview.unitCount === 1 ? 'unit' : 'units'} in total
        {preview.sides.length > 1 ? `, ${preview.unitsPerFloor * preview.floors} on each side` : ''}
        {draft.hasBasement ? ', plus a basement' : ''}.
      </p>

      {error ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-900">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-100"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          onClick={() => onSave(draft)}
          disabled={saving}
        >
          {saving ? 'Saving…' : confirmed ? 'Save changes' : "Yes, that's right"}
        </button>
      </div>
    </div>
  );
}

/**
 * The non-blocking prompt that opens the editor.
 *
 * Deliberately the same amber pill the device pins use for "placed by guess".
 * They are the same kind of statement — here is our guess, here is how to fix it
 * — and giving them one voice means a reader learns the convention once.
 */
export function SwitchToBuildingBanner({ onEdit }: { onEdit: () => void }) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className="rounded-full border border-slate-200 bg-white/95 px-3 py-1 text-[11px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
    >
      Drawing a house — if this is apartments, switch to a building view
    </button>
  );
}

export function StackGuessBanner({
  spec,
  onEdit,
}: {
  spec: BuildingSpec;
  onEdit: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className="rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1 text-[11px] font-semibold text-amber-800 shadow-sm hover:bg-amber-100"
    >
      {spec.floors} floors, {spec.unitsPerFloor} units per floor is a guess — confirm or correct it
    </button>
  );
}
