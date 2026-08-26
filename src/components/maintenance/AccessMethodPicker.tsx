import { Building2, KeyRound, Lock, Smartphone, UserCheck, Users } from 'lucide-react';
import type { AccessMethod, PropertyAccess } from '../../services/maintenanceApi';

interface AccessOption {
  id: AccessMethod;
  label: string;
  hint: string;
  Icon: typeof KeyRound;
}

const OPTIONS: AccessOption[] = [
  { id: 'owner_present', label: "I'll be there", hint: 'You meet the provider on site', Icon: UserCheck },
  { id: 'tenant_present', label: 'Tenant will be there', hint: 'An occupant lets them in', Icon: Users },
  { id: 'lockbox', label: 'Lockbox', hint: 'Provider retrieves a key on site', Icon: Lock },
  { id: 'hidden_key', label: 'Hidden key', hint: 'Key stashed somewhere on the property', Icon: KeyRound },
  { id: 'smart_lock', label: 'Smart lock code', hint: 'We issue a temporary entry code', Icon: Smartphone },
  { id: 'concierge', label: 'Concierge / front desk', hint: 'Building staff grants access', Icon: Building2 },
];

/** Methods that need a numeric code from the owner before dispatch. */
const CODE_METHODS: AccessMethod[] = ['lockbox', 'smart_lock'];

/** Methods where written directions matter more than a code. */
const INSTRUCTION_METHODS: AccessMethod[] = ['lockbox', 'hidden_key', 'smart_lock', 'concierge'];

interface AccessMethodPickerProps {
  value: PropertyAccess;
  onChange: (next: PropertyAccess) => void;
}

export default function AccessMethodPicker({ value, onChange }: AccessMethodPickerProps) {
  const update = (patch: Partial<PropertyAccess>) => onChange({ ...value, ...patch });

  const needsCode = CODE_METHODS.includes(value.method);
  const needsInstructions = INSTRUCTION_METHODS.includes(value.method);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {OPTIONS.map(({ id, label, hint, Icon }) => {
          const active = value.method === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => update({ method: id })}
              aria-pressed={active}
              className={[
                'ds-focus-ring flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition',
                active
                  ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500/30'
                  : 'border-slate-200 bg-white hover:border-emerald-300 hover:bg-slate-50',
              ].join(' ')}
            >
              <Icon className={`h-5 w-5 ${active ? 'text-emerald-600' : 'text-slate-400'}`} />
              <div className={`text-sm font-semibold ${active ? 'text-emerald-900' : 'text-slate-800'}`}>
                {label}
              </div>
              <div className="text-xs leading-snug text-slate-500">{hint}</div>
            </button>
          );
        })}
      </div>

      {needsCode && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">
              {value.method === 'smart_lock' ? 'Smart lock code' : 'Lockbox code'}
            </span>
            <input
              type="text"
              value={value.code}
              onChange={(event) => update({ code: event.target.value })}
              placeholder="e.g., 4821"
              autoComplete="off"
              className="ds-focus-ring w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          {value.method === 'smart_lock' && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">
                Lock brand <span className="font-normal text-slate-400">(optional)</span>
              </span>
              <input
                type="text"
                value={value.smartLockProvider}
                onChange={(event) => update({ smartLockProvider: event.target.value })}
                placeholder="e.g., August, Schlage, Yale"
                className="ds-focus-ring w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          )}
        </div>
      )}

      {needsInstructions && (
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">
            Access instructions for the provider
          </span>
          <textarea
            value={value.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
            rows={3}
            placeholder={
              value.method === 'hidden_key'
                ? 'e.g., Key is under the grey planter to the right of the side door.'
                : value.method === 'concierge'
                  ? 'e.g., Ask for Marcus at the front desk, unit is registered under my name.'
                  : 'e.g., Lockbox hangs on the gas meter pipe on the left side of the house.'
            }
            className="ds-focus-ring w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      )}

      {value.method === 'smart_lock' && (
        <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-3">
          <div className="text-sm font-semibold text-indigo-900">No smart lock yet?</div>
          <p className="mt-0.5 text-xs leading-relaxed text-indigo-700">
            HouseYield can install one and issue single-use codes per visit, so you never hand out a
            permanent key. Mention it on your next ticket and we will follow up.
          </p>
        </div>
      )}

      {(value.method === 'concierge' || value.method === 'tenant_present') && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">
              On-site contact name
            </span>
            <input
              type="text"
              value={value.contactName}
              onChange={(event) => update({ contactName: event.target.value })}
              placeholder="Who the provider should ask for"
              className="ds-focus-ring w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Contact phone</span>
            <input
              type="tel"
              value={value.contactPhone}
              onChange={(event) => update({ contactPhone: event.target.value })}
              placeholder="(202) 555-0134"
              className="ds-focus-ring w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      )}
    </div>
  );
}
