/**
 * RetirementScenarioSelector - Save, load, and compare retirement scenarios
 */

import { useState, useRef, useEffect } from 'react';
import { useAuth } from './contexts/AuthContext';
import { 
  type RetirementScenario, 
  saveScenario, 
  getScenarios, 
  deleteScenario, 
  generateScenarioId 
} from './services/aiFinancialPlannerService';

interface RetirementScenarioSelectorProps {
  currentParameters: RetirementScenario['parameters'];
  currentTimelineHints?: RetirementScenario['timelineHints'];
  fiYear: number | null;
  activeScenarioId?: string | null;
  onLoadScenario: (scenario: RetirementScenario) => void;
}

export default function RetirementScenarioSelector({
  currentParameters,
  currentTimelineHints,
  fiYear,
  activeScenarioId,
  onLoadScenario,
}: RetirementScenarioSelectorProps) {
  const { user } = useAuth();
  const [scenarios, setScenarios] = useState<RetirementScenario[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const loadScenarios = async () => {
      if (!user?.id) {
        setScenarios([]);
        return;
      }

      const storedScenarios = await getScenarios(user.id);
      if (!cancelled) {
        setScenarios(storedScenarios);
      }
    };

    void loadScenarios();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsSaving(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSave = async () => {
    if (!user?.id || !newName.trim()) return;
    const scenario: RetirementScenario = {
      id: generateScenarioId(),
      name: newName.trim(),
      createdAt: Date.now(),
      timelineHints: currentTimelineHints?.map((hint) => ({ ...hint })) ?? [],
      parameters: { ...currentParameters },
      fiYear,
      source: 'manual',
    };
    const updatedScenarios = await saveScenario(user.id, scenario);
    setScenarios(updatedScenarios);
    setNewName('');
    setIsSaving(false);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user?.id) return;

    const updatedScenarios = await deleteScenario(user.id, id);
    setScenarios(updatedScenarios);
  };

  const handleLoad = (scenario: RetirementScenario) => {
    onLoadScenario(scenario);
    setIsOpen(false);
  };

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleDateString('en-US', { 
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
    });
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02]"
        style={{
          background: scenarios.length > 0 
            ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(139, 92, 246, 0.1))' 
            : 'rgba(0, 0, 0, 0.04)',
          border: scenarios.length > 0 ? '1px solid rgba(99, 102, 241, 0.2)' : '1px solid rgba(0,0,0,0.08)',
          color: scenarios.length > 0 ? '#6366f1' : '#6b7280',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
        Scenarios
        {activeScenarioId && (
          <span className="px-1.5 py-0.5 rounded-full bg-white text-indigo-600 text-[9px] font-semibold border border-indigo-100">
            Applied
          </span>
        )}
        {scenarios.length > 0 && (
          <span className="w-4 h-4 rounded-full bg-indigo-500 text-white text-[9px] flex items-center justify-center font-bold">
            {scenarios.length}
          </span>
        )}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div 
          className="absolute right-0 top-full mt-2 w-80 rounded-xl overflow-hidden z-50"
          style={{
            background: 'white',
            border: '1px solid rgba(0,0,0,0.1)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.12)',
          }}
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold text-gray-900">Saved Scenarios</h4>
              <p className="text-[10px] text-gray-400">Compare different retirement strategies</p>
            </div>
            <button
              onClick={() => setIsSaving(true)}
              disabled={!user?.id}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-colors"
            >
              + Save Current
            </button>
          </div>

          {/* Save form */}
          {isSaving && (
            <div className="px-4 py-3 border-b border-gray-100 bg-indigo-50/30">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                  placeholder="Scenario name (e.g. 'Aggressive 2040')"
                  className="flex-1 px-3 py-1.5 rounded-lg text-xs border border-indigo-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  autoFocus
                />
                <button
                  onClick={handleSave}
                  disabled={!newName.trim()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {/* Scenarios list */}
          <div className="max-h-64 overflow-y-auto">
            {!user?.id ? (
              <div className="px-4 py-6 text-center">
                <div className="text-gray-400 text-xs">Sign in to save scenarios</div>
                <div className="text-gray-300 text-[10px] mt-1">Retirement scenarios now persist to your Firestore profile</div>
              </div>
            ) : scenarios.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <div className="text-gray-400 text-xs">No saved scenarios yet</div>
                <div className="text-gray-300 text-[10px] mt-1">Save your current settings to compare later</div>
              </div>
            ) : (
              scenarios.map(scenario => {
                const isActive = scenario.id === activeScenarioId;

                return (
                  <div
                    key={scenario.id}
                    onClick={() => handleLoad(scenario)}
                    className={`px-4 py-3 cursor-pointer border-b border-gray-50 last:border-0 transition-colors group ${isActive ? 'bg-indigo-50/70 hover:bg-indigo-50' : 'hover:bg-gray-50'}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div 
                          className="w-2 h-2 rounded-full"
                          style={{ background: scenario.source === 'ai' ? '#8b5cf6' : '#6366f1' }}
                        />
                        <span className="text-xs font-medium text-gray-800">{scenario.name}</span>
                        {isActive && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-600 text-white font-semibold">Applied</span>
                        )}
                      </div>
                      <button
                        onClick={(e) => handleDelete(scenario.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-400 transition-all"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    {scenario.summary && (
                      <div className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                        {scenario.summary}
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[10px] text-gray-400">{formatDate(scenario.createdAt)}</span>
                      <span className="text-[10px] text-gray-400">•</span>
                      <span className="text-[10px] text-gray-400">
                        Retire: {scenario.parameters.retirementYear || 'Not set'}
                      </span>
                      {scenario.fiYear && (
                        <>
                          <span className="text-[10px] text-gray-400">•</span>
                          <span className="text-[10px] text-emerald-500 font-medium">FI: {scenario.fiYear}</span>
                        </>
                      )}
                      {scenario.source === 'ai' && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-500 font-medium">AI</span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
