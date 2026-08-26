import { HelpCircle } from 'lucide-react';

/**
 * GlossaryTip — plain-English jargon hint (promoted from the Tax Center).
 * Renders a small help icon whose tooltip explains a term of art in one or
 * two sentences. Use next to any label a mom-and-pop landlord might not know.
 */
export interface GlossaryTipProps {
  term: string;
  explanation: string;
}

export function GlossaryTip({ term, explanation }: GlossaryTipProps) {
  if (!explanation) return null;
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`What does ${term} mean?`}
        className="ds-focus-ring inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-400 transition hover:text-blue-600 focus:text-blue-600 focus:outline-none"
        tabIndex={0}
      >
        <HelpCircle size={13} />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute left-1/2 top-full z-40 mt-1.5 w-64 -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-[11px] font-normal normal-case leading-relaxed tracking-normal text-slate-700 opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {term ? <span className="block font-semibold text-slate-900">{term}</span> : null}
        {explanation}
      </span>
    </span>
  );
}

export default GlossaryTip;
