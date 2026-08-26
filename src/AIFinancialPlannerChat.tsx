/**
 * AIFinancialPlannerChat - AI chatbot for retirement and financial planning
 * Uses Claude AI to analyze user's financials and adjust chart parameters
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  generateScenarioId,
  getScenarios,
  saveScenario,
  sendChatMessage,
  type ChatMessage,
  type AIAction,
  type FinancialContext,
  type FinancialPlannerDraftScenario,
  type RetirementScenario,
  type RetirementScenarioBigPurchase,
  type RetirementScenarioPortfolioReallocation,
} from './services/aiFinancialPlannerService';
import { auth } from './config/firebase';
import { useAuth } from './contexts/AuthContext';
import {
  loadFinancialPlannerWorkspace,
  saveFinancialPlannerDraftScenarios,
} from './services/financialPlannerWorkspaceService';

interface AIFinancialPlannerChatProps {
  financialContext: FinancialContext;
  currentParameters: RetirementScenario['parameters'];
  currentTimelineHints?: RetirementScenario['timelineHints'];
  fiYear: number | null;
  onApplyActions: (actions: AIAction[]) => void;
  isExpanded: boolean;
  onToggle: () => void;
  compact?: boolean;
}

const QUICK_PROMPTS = [
  { label: '🎯 When can I retire?', prompt: 'Based on my current financials, when is the earliest I can realistically retire? What would my income vs expenses look like?' },
  { label: '🏠 Sell a property', prompt: 'I\'m thinking about selling one of my properties. When would be the best time and how should I reallocate the proceeds to maximize my retirement income?' },
  { label: '🏖️ Vacation home', prompt: 'I want to buy a vacation home for about $400,000 in the next 5-10 years. Is this feasible with my current plan, and what adjustments would I need to make?' },
  { label: '✂️ Cut spending', prompt: 'Where can I cut my expenses to accelerate my path to financial independence? Show me the impact of different spending reduction levels.' },
  { label: '🚗 Big purchase', prompt: 'I\'m thinking about a major purchase. Can you help me figure out if I can afford it without derailing my retirement plans?' },
  { label: '📊 Compare scenarios', prompt: 'Can you compare a conservative vs aggressive retirement strategy for me? Show me retiring at different ages and what that looks like.' },
];

export default function AIFinancialPlannerChat({
  financialContext,
  currentParameters,
  currentTimelineHints,
  fiYear,
  onApplyActions,
  isExpanded,
  onToggle,
  compact = false,
}: AIFinancialPlannerChatProps) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingActions, setPendingActions] = useState<AIAction[] | null>(null);
  const [draftScenarios, setDraftScenarios] = useState<FinancialPlannerDraftScenario[]>([]);
  const [savedScenarios, setSavedScenarios] = useState<RetirementScenario[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState('');
  const [scenarioMutationKey, setScenarioMutationKey] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;

    const loadWorkspace = async () => {
      if (!user?.id) {
        setDraftScenarios([]);
        setSavedScenarios([]);
        setSelectedScenarioId('');
        return;
      }

      try {
        const [workspace, scenarios] = await Promise.all([
          loadFinancialPlannerWorkspace(),
          getScenarios(user.id),
        ]);
        if (!cancelled) {
          setDraftScenarios(workspace.draftScenarios);
          setSavedScenarios(scenarios);
          setSelectedScenarioId((currentSelectedId) => (
            scenarios.some((scenario) => scenario.id === currentSelectedId)
              ? currentSelectedId
              : scenarios[0]?.id || ''
          ));
        }
      } catch (error) {
        console.error('[AI Financial Planner] Failed to load planner workspace:', error);
      }
    };

    void loadWorkspace();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isExpanded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isExpanded]);

  const currentYear = new Date().getFullYear();
  const toFiniteNumber = (value: unknown, fallback = Number.NaN) => {
    const nextValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(nextValue) ? nextValue : fallback;
  };
  const normalizeFraction = (value: unknown, fallback: number) => {
    const nextValue = toFiniteNumber(value);
    if (!Number.isFinite(nextValue)) {
      return fallback;
    }
    return nextValue > 1 ? nextValue / 100 : nextValue;
  };
  const normalizeProjectionOffset = (value: unknown, fallback: number) => {
    const nextValue = toFiniteNumber(value);
    if (!Number.isFinite(nextValue)) {
      return fallback;
    }
    if (nextValue >= 1900) {
      return Math.max(0, Math.round(nextValue) - currentYear);
    }
    return Math.max(0, Math.round(nextValue));
  };
  const normalizeRetirementYear = (value: unknown, fallback: number | null) => {
    const nextValue = toFiniteNumber(value);
    if (!Number.isFinite(nextValue)) {
      return fallback;
    }
    return nextValue >= 1900 ? Math.round(nextValue) : currentYear + Math.max(0, Math.round(nextValue));
  };
  const normalizeDisplayedPercent = (value: unknown, fallback: number) => {
    const nextValue = toFiniteNumber(value);
    if (!Number.isFinite(nextValue)) {
      return fallback;
    }
    return nextValue > 1 ? nextValue : nextValue * 100;
  };

  const buildDefaultPortfolioReallocation = useCallback((): RetirementScenarioPortfolioReallocation => ({
    enabled: false,
    year: currentParameters.portfolioReallocation?.year ?? 10,
    targetAssetName: currentParameters.portfolioReallocation?.targetAssetName || 'Income asset',
    targetTicker: currentParameters.portfolioReallocation?.targetTicker || '',
    targetYield: currentParameters.portfolioReallocation?.targetYield ?? currentParameters.dividendYield,
    targetGrowth: currentParameters.portfolioReallocation?.targetGrowth ?? currentParameters.dividendGrowth,
    sellStocks: currentParameters.portfolioReallocation?.sellStocks ?? true,
    sellBonds: currentParameters.portfolioReallocation?.sellBonds ?? true,
    sellRealEstate: currentParameters.portfolioReallocation?.sellRealEstate ?? true,
    sellCash: currentParameters.portfolioReallocation?.sellCash ?? true,
  }), [currentParameters.dividendGrowth, currentParameters.dividendYield, currentParameters.portfolioReallocation]);

  const normalizePortfolioReallocation = useCallback((
    value: Partial<RetirementScenarioPortfolioReallocation> | null | undefined,
    fallback?: RetirementScenarioPortfolioReallocation,
  ): RetirementScenarioPortfolioReallocation => {
    const base = fallback || buildDefaultPortfolioReallocation();
    const nextValue = value || {};

    return {
      enabled: Boolean(nextValue.enabled ?? base.enabled),
      year: normalizeProjectionOffset(nextValue.year, base.year),
      targetAssetName: typeof nextValue.targetAssetName === 'string' && nextValue.targetAssetName.trim()
        ? nextValue.targetAssetName.trim()
        : base.targetAssetName,
      targetTicker: typeof nextValue.targetTicker === 'string' && nextValue.targetTicker.trim()
        ? nextValue.targetTicker.trim().toUpperCase()
        : base.targetTicker,
      targetYield: normalizeFraction(nextValue.targetYield, base.targetYield),
      targetGrowth: normalizeFraction(nextValue.targetGrowth, base.targetGrowth),
      sellStocks: nextValue.sellStocks ?? base.sellStocks,
      sellBonds: nextValue.sellBonds ?? base.sellBonds,
      sellRealEstate: nextValue.sellRealEstate ?? base.sellRealEstate,
      sellCash: nextValue.sellCash ?? base.sellCash,
    };
  }, [buildDefaultPortfolioReallocation]);

  const cloneCurrentParameters = useCallback((): RetirementScenario['parameters'] => ({
    ...currentParameters,
    propertySaleAllocation: { ...currentParameters.propertySaleAllocation },
    propertyPurchaseDetails: { ...currentParameters.propertyPurchaseDetails },
    bigPurchases: Array.isArray(currentParameters.bigPurchases)
      ? currentParameters.bigPurchases.map((purchase) => ({ ...purchase }))
      : [],
    portfolioReallocation: currentParameters.portfolioReallocation
      ? { ...currentParameters.portfolioReallocation }
      : buildDefaultPortfolioReallocation(),
  }), [buildDefaultPortfolioReallocation, currentParameters]);

  const cloneTimelineHints = useCallback((timelineHints?: RetirementScenario['timelineHints']) => (
    Array.isArray(timelineHints) ? timelineHints.map((hint) => ({ ...hint })) : []
  ), []);

  const inferBigPurchasesFromTimelineHints = useCallback((
    timelineHints?: RetirementScenario['timelineHints'],
  ): RetirementScenarioBigPurchase[] => {
    return (timelineHints || [])
      .filter((hint) => hint.kind === 'bigPurchase')
      .map((hint, index) => {
        const metadata = `${hint.title} ${hint.description}`;
        const amountMatch = metadata.match(/\$([\d,]+(?:\.\d+)?)/);
        const monthlyMatch = metadata.match(/\+?\$([\d,]+(?:\.\d+)?)\/mo/i);
        return {
          id: `big-purchase-${index}-${hint.year}`,
          year: Number(hint.year),
          amount: amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : 0,
          description: hint.title || hint.label || 'Major purchase',
          ongoingMonthlyCost: monthlyMatch ? Number(monthlyMatch[1].replace(/,/g, '')) : undefined,
        };
      })
      .filter((purchase) => Number.isFinite(purchase.year) && (purchase.amount > 0 || (purchase.ongoingMonthlyCost || 0) > 0));
  }, []);

  const buildFallbackScenarioName = useCallback((existingScenario?: RetirementScenario | null) => {
    if (existingScenario?.name) {
      return existingScenario.name;
    }

    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'user' && message.content.trim())
      ?.content
      .replace(/\s+/g, ' ')
      .trim();

    if (lastUserMessage) {
      return lastUserMessage.length > 48 ? `${lastUserMessage.slice(0, 48).trim()}...` : lastUserMessage;
    }

    return `AI Scenario ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }, [messages]);

  const buildFallbackScenarioSummary = useCallback((draft?: FinancialPlannerDraftScenario) => {
    if (draft?.summary?.trim()) {
      return draft.summary.trim();
    }

    const lastAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim())
      ?.content
      .replace(/\s+/g, ' ')
      .trim();

    if (lastAssistantMessage) {
      return lastAssistantMessage.length > 180 ? `${lastAssistantMessage.slice(0, 180).trim()}...` : lastAssistantMessage;
    }

    return 'Saved from the AI financial planner conversation.';
  }, [messages]);

  const buildFallbackScenarioNotes = useCallback((draft?: FinancialPlannerDraftScenario) => {
    if (draft?.notes?.length) {
      return draft.notes;
    }

    const notes: string[] = [];
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'user' && message.content.trim())
      ?.content
      .replace(/\s+/g, ' ')
      .trim();

    if (lastUserMessage) {
      notes.push(`Conversation prompt: ${lastUserMessage}`);
    }

    if (financialContext.projectionSummary?.fiYear) {
      notes.push(`Canonical FI target at save time: ${financialContext.projectionSummary.fiYear}.`);
    }

    if (notes.length === 0) {
      notes.push('Saved directly from the AI financial planner workspace.');
    }

    return notes;
  }, [financialContext.projectionSummary?.fiYear, messages]);

  const refreshSavedScenarios = useCallback(async (preferredScenarioId?: string) => {
    if (!user?.id) {
      setSavedScenarios([]);
      setSelectedScenarioId('');
      return;
    }

    const scenarios = await getScenarios(user.id);
    setSavedScenarios(scenarios);
    setSelectedScenarioId((currentSelectedId) => {
      const nextSelectedId = preferredScenarioId && scenarios.some((scenario) => scenario.id === preferredScenarioId)
        ? preferredScenarioId
        : currentSelectedId;

      return scenarios.some((scenario) => scenario.id === nextSelectedId)
        ? nextSelectedId
        : scenarios[0]?.id || '';
    });
  }, [user?.id]);

  const buildScenarioParameters = useCallback((draft: FinancialPlannerDraftScenario): RetirementScenario['parameters'] => {
    const draftParameters = draft.parameters || {};
    const mergedPropertyPurchaseDetails = {
      ...currentParameters.propertyPurchaseDetails,
      ...((draftParameters.propertyPurchaseDetails as Record<string, unknown> | undefined) || {}),
    };
    const mergedPortfolioReallocation = normalizePortfolioReallocation(
      (draftParameters.portfolioReallocation as Partial<RetirementScenarioPortfolioReallocation> | undefined)
        ? {
            ...(currentParameters.portfolioReallocation || buildDefaultPortfolioReallocation()),
            ...(draftParameters.portfolioReallocation as Partial<RetirementScenarioPortfolioReallocation>),
          }
        : currentParameters.portfolioReallocation || buildDefaultPortfolioReallocation(),
      currentParameters.portfolioReallocation || buildDefaultPortfolioReallocation(),
    );
    const inferredBigPurchases = Array.isArray(draftParameters.bigPurchases) && draftParameters.bigPurchases.length > 0
      ? draftParameters.bigPurchases.map((purchase, index) => ({
          id: typeof purchase?.id === 'string' && purchase.id.trim() ? purchase.id.trim() : `big-purchase-${index}`,
          year: Number(purchase?.year),
          amount: Number(purchase?.amount || 0),
          description: typeof purchase?.description === 'string' && purchase.description.trim()
            ? purchase.description.trim()
            : 'Major purchase',
          ongoingMonthlyCost: purchase?.ongoingMonthlyCost !== undefined ? Number(purchase.ongoingMonthlyCost) : undefined,
        }))
      : inferBigPurchasesFromTimelineHints(draft.timelineHints);

    return {
      ...currentParameters,
      ...draftParameters,
      retirementYear: normalizeRetirementYear(draftParameters.retirementYear, currentParameters.retirementYear),
      spendingReduction: normalizeFraction(draftParameters.spendingReduction, currentParameters.spendingReduction),
      stockGrowth: normalizeFraction(draftParameters.stockGrowth, currentParameters.stockGrowth),
      dividendGrowth: normalizeFraction(draftParameters.dividendGrowth, currentParameters.dividendGrowth),
      dividendYield: normalizeFraction(draftParameters.dividendYield, currentParameters.dividendYield),
      bondYield: normalizeFraction(draftParameters.bondYield, currentParameters.bondYield),
      propertyAppreciation: normalizeFraction(draftParameters.propertyAppreciation, currentParameters.propertyAppreciation),
      rentGrowth: normalizeFraction(draftParameters.rentGrowth, currentParameters.rentGrowth),
      propertySaleYear: normalizeProjectionOffset(draftParameters.propertySaleYear, currentParameters.propertySaleYear),
      propertyPurchaseYear: normalizeProjectionOffset(draftParameters.propertyPurchaseYear, currentParameters.propertyPurchaseYear),
      propertyPurchaseDetails: {
        ...mergedPropertyPurchaseDetails,
        downPaymentPercent: normalizeDisplayedPercent(mergedPropertyPurchaseDetails.downPaymentPercent, currentParameters.propertyPurchaseDetails.downPaymentPercent),
        expectedAppreciation: normalizeDisplayedPercent(mergedPropertyPurchaseDetails.expectedAppreciation, currentParameters.propertyPurchaseDetails.expectedAppreciation),
      },
      bigPurchases: inferredBigPurchases,
      portfolioReallocation: mergedPortfolioReallocation,
    };
  }, [buildDefaultPortfolioReallocation, currentParameters, inferBigPurchasesFromTimelineHints, normalizePortfolioReallocation]);

  const buildScenarioTimelineHints = useCallback((
    parameters: RetirementScenario['parameters'],
    draft?: FinancialPlannerDraftScenario,
    existingScenario?: RetirementScenario | null,
  ): RetirementScenario['timelineHints'] => {
    if (draft?.timelineHints?.length) {
      return cloneTimelineHints(draft.timelineHints);
    }

    if (!draft && currentTimelineHints?.length) {
      return cloneTimelineHints(currentTimelineHints);
    }

    const nextTimelineHints: NonNullable<RetirementScenario['timelineHints']> = [];
    const propertyPurchasePrice = Number(parameters.propertyPurchaseDetails?.purchasePrice);

    if (parameters.retirementYear) {
      nextTimelineHints.push({
        kind: 'retirement',
        year: parameters.retirementYear,
        label: 'Retire',
        title: 'Retirement starts',
        description: 'Contributions and DRIP stop here.',
      });
    }

    if (parameters.propertyPurchase) {
      nextTimelineHints.push({
        kind: 'propertyPurchase',
        year: currentYear + Math.max(0, Math.round(parameters.propertyPurchaseYear || 0)),
        label: 'Buy',
        title: 'Property purchase',
        description: Number.isFinite(propertyPurchasePrice) && propertyPurchasePrice > 0
          ? `Acquire a $${propertyPurchasePrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} property in this year.`
          : 'Property acquisition planned for this year.',
      });
    }

    if (parameters.propertySale) {
      nextTimelineHints.push({
        kind: 'propertySale',
        year: currentYear + Math.max(0, Math.round(parameters.propertySaleYear || 0)),
        label: 'Sell',
        title: 'Property sale',
        description: 'Sell property holdings and redeploy the proceeds in this year.',
      });
    }

    if (parameters.portfolioReallocation?.enabled) {
      const labelSource = parameters.portfolioReallocation.targetTicker || parameters.portfolioReallocation.targetAssetName || 'Scenario';
      const label = labelSource.length > 18 ? `${labelSource.slice(0, 16).trim()}...` : labelSource;
      const targetAssetName = parameters.portfolioReallocation.targetAssetName || 'the target income asset';
      nextTimelineHints.push({
        kind: 'scenario',
        year: currentYear + Math.max(0, Math.round(parameters.portfolioReallocation.year || 0)),
        label,
        title: `Move portfolio to ${targetAssetName}`,
        description: `Sell selected assets and reinvest into ${targetAssetName} at ${(parameters.portfolioReallocation.targetYield * 100).toFixed(1)}% target yield.`,
      });
    }

    if (nextTimelineHints.length > 0) {
      return nextTimelineHints;
    }

    return cloneTimelineHints(existingScenario?.timelineHints);
  }, [cloneTimelineHints, currentTimelineHints, currentYear]);

  const buildScenarioRecord = useCallback((draft?: FinancialPlannerDraftScenario, existingScenario?: RetirementScenario | null): RetirementScenario => {
    const parameters = draft ? buildScenarioParameters(draft) : cloneCurrentParameters();

    return {
      id: existingScenario?.id || generateScenarioId(),
      name: draft?.name || buildFallbackScenarioName(existingScenario),
      createdAt: existingScenario?.createdAt || Date.now(),
      summary: buildFallbackScenarioSummary(draft),
      notes: buildFallbackScenarioNotes(draft),
      timelineHints: buildScenarioTimelineHints(parameters, draft, existingScenario),
      parameters,
      fiYear: draft?.fiYear ?? fiYear,
      source: 'ai',
    };
  }, [
    buildFallbackScenarioName,
    buildFallbackScenarioNotes,
    buildFallbackScenarioSummary,
    buildScenarioParameters,
    buildScenarioTimelineHints,
    cloneCurrentParameters,
    fiYear,
  ]);

  const persistScenario = useCallback(async ({
    draft,
    existingScenario,
    mutationKey,
  }: {
    draft?: FinancialPlannerDraftScenario;
    existingScenario?: RetirementScenario | null;
    mutationKey: string;
  }) => {
    if (!user?.id || scenarioMutationKey) {
      return;
    }

    setScenarioMutationKey(mutationKey);

    try {
      const scenario = buildScenarioRecord(draft, existingScenario);
      await saveScenario(user.id, scenario);
      await refreshSavedScenarios(scenario.id);

      if (draft) {
        const nextDrafts = draftScenarios.filter((entry) => entry.id !== draft.id);
        setDraftScenarios(nextDrafts);
        await saveFinancialPlannerDraftScenarios(user.id, nextDrafts);
      }

      const statusMessage: ChatMessage = {
        role: 'assistant',
        content: existingScenario
          ? `Updated scenario "${scenario.name}" with the latest planner state.`
          : `Saved scenario "${scenario.name}" to your scenario library.`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, statusMessage]);
    } catch (error: any) {
      const errorMessage: ChatMessage = {
        role: 'assistant',
        content: `I couldn't save that scenario yet: ${error.message || 'unknown error'}.`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setScenarioMutationKey(null);
    }
  }, [
    buildScenarioRecord,
    draftScenarios,
    refreshSavedScenarios,
    scenarioMutationKey,
    user?.id,
  ]);

  const handleSaveDraftScenario = useCallback(async (draft: FinancialPlannerDraftScenario) => {
    await persistScenario({ draft, mutationKey: `save:${draft.id}` });
  }, [persistScenario]);

  const handleUpdateScenario = useCallback(async (draft?: FinancialPlannerDraftScenario) => {
    const existingScenario = savedScenarios.find((scenario) => scenario.id === selectedScenarioId) || null;
    if (!existingScenario) {
      return;
    }

    await persistScenario({
      draft,
      existingScenario,
      mutationKey: `${draft ? `update-draft:${draft.id}` : 'update-current'}:${existingScenario.id}`,
    });
  }, [persistScenario, savedScenarios, selectedScenarioId]);

  const handleSaveCurrentScenario = useCallback(async () => {
    await persistScenario({ mutationKey: 'save-current' });
  }, [persistScenario]);

  const handleSend = useCallback(async (customMessage?: string) => {
    const text = customMessage || inputValue.trim();
    if (!text || isLoading) return;

    const userMessage: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);

    try {
      const chatHistory = [...messages, userMessage].map(m => ({
        role: m.role,
        content: m.content,
      }));

      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;

      const result = await sendChatMessage(chatHistory, financialContext, idToken);

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: result.message,
        actions: result.actions,
        timestamp: Date.now(),
      };

      setMessages(prev => [...prev, assistantMessage]);

      setDraftScenarios(result.scenarioDrafts || []);
      await refreshSavedScenarios();

      // If there are actions, show the apply button
      if (result.actions && result.actions.length > 0) {
        setPendingActions(result.actions);
      }
    } catch (error: any) {
      const errorMessage: ChatMessage = {
        role: 'assistant',
        content: `Sorry, I encountered an error: ${error.message}. Please try again.`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  }, [inputValue, isLoading, messages, financialContext, refreshSavedScenarios]);

  const handleApplyActions = useCallback((actions: AIAction[]) => {
    onApplyActions(actions);
    setPendingActions(null);
  }, [onApplyActions]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const formatActionDescription = (action: AIAction): string => {
    switch (action.type) {
      case 'setRetirementYear': return `Set retirement year to ${action.year}`;
      case 'sellProperty': return `Plan property sale in ${action.year}`;
      case 'buyProperty': return `Plan property purchase ($${(action.purchasePrice || 0).toLocaleString()})`;
      case 'adjustSpending': return `Reduce spending by ${action.reductionPercent}%`;
      case 'adjustContributions': return `Set monthly contributions to $${(action.monthlyAmount || 0).toLocaleString()}`;
      case 'adjustGrowthAssumptions': return `Update growth assumptions`;
      case 'setMonthlyCostOfLiving': return `Set cost of living to $${(action.amount || 0).toLocaleString()}/mo`;
      case 'bigPurchase': return `Plan ${action.description} ($${(action.amount || 0).toLocaleString()}) in ${action.year}`;
      default: return `Update ${action.type}`;
    }
  };

  const selectedScenario = savedScenarios.find((scenario) => scenario.id === selectedScenarioId) || null;
  const shouldShowScenarioWorkspace = messages.length > 0 || draftScenarios.length > 0;

  if (!isExpanded) {
    return (
      <button
        onClick={onToggle}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all hover:scale-[1.02]"
        style={{
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%)',
          color: 'white',
          boxShadow: '0 4px 15px rgba(99, 102, 241, 0.3)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2a10 10 0 0 1 10 10 10 10 0 0 1-10 10 10 10 0 0 1-10-10A10 10 0 0 1 12 2z" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
        AI Financial Planner
        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
      </button>
    );
  }

  return (
    <div 
      className={`overflow-hidden ${compact ? 'rounded-[24px]' : 'rounded-2xl'}`}
      style={{
        background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.97) 0%, rgba(248, 250, 252, 0.95) 100%)',
        border: '1px solid rgba(99, 102, 241, 0.2)',
        boxShadow: '0 4px 24px rgba(99, 102, 241, 0.08)',
      }}
    >
      {/* Header */}
      <div 
        className={`flex items-center justify-between cursor-pointer ${compact ? 'px-4 py-2.5' : 'px-4 py-3'}`}
        onClick={onToggle}
        style={{ 
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%)',
        }}
      >
        <div className="flex items-center gap-3">
          <div className={`${compact ? 'h-7 w-7' : 'w-8 h-8'} rounded-lg bg-white/20 flex items-center justify-center`}>
            <svg width={compact ? '16' : '18'} height={compact ? '16' : '18'} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">AI Financial Planner</h3>
            <p className="text-[10px] text-white/70">Powered by Claude • Ask about retirement, goals, scenarios</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          {compact ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              aria-label="Close AI financial planner"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" className="opacity-70">
              <path d="M18 15l-6-6-6 6" />
            </svg>
          )}
        </div>
      </div>

      {/* Messages Area */}
      <div className={`${compact ? 'h-72 p-3.5' : 'h-80 p-4'} overflow-y-auto space-y-3`} style={{ scrollBehavior: 'smooth' }}>
        {messages.length === 0 ? (
          <div className="space-y-3">
            <div className={`text-center ${compact ? 'py-2' : 'py-4'}`}>
              <div className={`${compact ? 'mb-2 h-10 w-10' : 'w-12 h-12 mb-3'} mx-auto rounded-xl flex items-center justify-center`} style={{ background: 'rgba(99, 102, 241, 0.1)' }}>
                <svg width={compact ? '20' : '24'} height={compact ? '20' : '24'} viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2">
                  <path d="M12 2a10 10 0 0 1 10 10 10 10 0 0 1-10 10 10 10 0 0 1-10-10A10 10 0 0 1 12 2z" />
                  <path d="M12 16v-4M12 8h.01" />
                </svg>
              </div>
              <p className="text-sm text-gray-600 font-medium">How can I help with your retirement plan?</p>
              <p className="text-xs text-gray-400 mt-1">Ask about retirement timing, asset moves, big purchases, or spending optimization</p>
            </div>
            
            {/* Quick prompts */}
            <div className={`grid gap-2 ${compact ? 'grid-cols-1' : 'grid-cols-2'}`}>
              {QUICK_PROMPTS.map((qp, i) => (
                <button
                  key={i}
                  onClick={() => handleSend(qp.prompt)}
                  className={`text-left rounded-lg text-xs text-gray-600 hover:text-indigo-700 transition-all hover:scale-[1.01] ${compact ? 'p-2.5' : 'p-2.5'}`}
                  style={{ 
                    background: 'rgba(99, 102, 241, 0.04)',
                    border: '1px solid rgba(99, 102, 241, 0.1)',
                  }}
                >
                  {qp.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-50 text-gray-800 border border-gray-100'
                }`}
              >
                <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                
                {/* Action buttons for AI responses */}
                {msg.actions && msg.actions.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-gray-200/50">
                    <div className="text-[10px] text-gray-500 mb-1.5 font-medium">📊 Suggested Changes:</div>
                    <div className="space-y-1">
                      {msg.actions.map((action, j) => (
                        <div key={j} className="flex items-center gap-1.5 text-[11px] text-indigo-600">
                          <span className="w-1 h-1 rounded-full bg-indigo-400" />
                          {formatActionDescription(action)}
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => handleApplyActions(msg.actions!)}
                      className="mt-2 w-full px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-all hover:opacity-90"
                      style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
                    >
                      ✨ Apply Changes to Charts
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 text-sm text-gray-500">
              <div className="flex items-center gap-2">
                <div className="flex space-x-1">
                  <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                Analyzing your financials...
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      {shouldShowScenarioWorkspace && (
        <div className={`border-t border-gray-100 ${compact ? 'px-3 py-2.5' : 'px-3 py-3'}`} style={{ background: 'rgba(99, 102, 241, 0.03)' }}>
          <div className="flex items-center justify-between mb-2 gap-3">
            <div>
              <div className="text-xs font-semibold text-gray-900">AI Scenario Workspace</div>
              <div className="text-[11px] text-gray-500">
                Save a new scenario or overwrite an existing one from the current planner state. AI drafts show up here when the model structures them.
              </div>
            </div>
            <div className="text-[10px] text-indigo-600 font-medium">{draftScenarios.length} draft{draftScenarios.length === 1 ? '' : 's'}</div>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              value={selectedScenarioId}
              onChange={(event) => setSelectedScenarioId(event.target.value)}
              className="min-w-[220px] rounded-lg border border-indigo-100 bg-white px-3 py-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              <option value="">Select saved scenario to update</option>
              {savedScenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name}
                </option>
              ))}
            </select>

            <button
              onClick={() => handleSaveCurrentScenario()}
              disabled={!user?.id || scenarioMutationKey === 'save-current'}
              className="px-3 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
            >
              {scenarioMutationKey === 'save-current' ? 'Saving...' : 'Save Current Plan'}
            </button>

            <button
              onClick={() => handleUpdateScenario()}
              disabled={!user?.id || !selectedScenario || scenarioMutationKey === `update-current:${selectedScenario?.id || ''}`}
              className="px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
              style={{
                background: selectedScenario ? 'rgba(99, 102, 241, 0.08)' : 'rgba(0,0,0,0.04)',
                border: '1px solid rgba(99, 102, 241, 0.18)',
                color: selectedScenario ? '#4f46e5' : '#9ca3af',
              }}
            >
              {scenarioMutationKey === `update-current:${selectedScenario?.id || ''}` ? 'Updating...' : selectedScenario ? `Update "${selectedScenario.name}"` : 'Update Selected'}
            </button>
          </div>

          {draftScenarios.length === 0 && (
            <div
              className="rounded-xl p-3 mb-2"
              style={{
                background: 'white',
                border: '1px dashed rgba(99, 102, 241, 0.2)',
              }}
            >
              <div className="text-xs font-medium text-gray-700">No structured AI draft yet</div>
              <div className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                You can still save or update the current planner state above. If you want the model to generate a fully named scenario draft, ask it to turn the recommendation into a save-ready scenario.
              </div>
            </div>
          )}

          <div className="space-y-2">
            {draftScenarios.map((draft) => (
              <div
                key={draft.id}
                className="rounded-xl p-3"
                style={{
                  background: 'white',
                  border: '1px solid rgba(99, 102, 241, 0.12)',
                  boxShadow: '0 4px 16px rgba(99, 102, 241, 0.05)',
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-sm font-semibold text-gray-900">{draft.name}</div>
                      {draft.fiYear && (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 text-[10px] font-semibold">
                          FI {draft.fiYear}
                        </span>
                      )}
                      {draft.saveRecommended && (
                        <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-semibold">
                          Save-ready
                        </span>
                      )}
                    </div>
                    {draft.summary && (
                      <div className="mt-1 text-xs text-gray-600 leading-relaxed">{draft.summary}</div>
                    )}
                    {draft.notes.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {draft.notes.map((note, index) => (
                          <div key={`${draft.id}-note-${index}`} className="text-[11px] text-gray-500 leading-relaxed">
                            • {note}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => handleSaveDraftScenario(draft)}
                    disabled={!user?.id || scenarioMutationKey === `save:${draft.id}`}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
                  >
                    {scenarioMutationKey === `save:${draft.id}` ? 'Saving...' : 'Save Scenario'}
                  </button>
                  <button
                    onClick={() => handleUpdateScenario(draft)}
                    disabled={!user?.id || !selectedScenario || scenarioMutationKey === `update-draft:${draft.id}:${selectedScenario?.id || ''}`}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
                    style={{
                      background: selectedScenario ? 'rgba(99, 102, 241, 0.08)' : 'rgba(0,0,0,0.04)',
                      border: '1px solid rgba(99, 102, 241, 0.18)',
                      color: selectedScenario ? '#4f46e5' : '#9ca3af',
                    }}
                  >
                    {scenarioMutationKey === `update-draft:${draft.id}:${selectedScenario?.id || ''}` ? 'Updating...' : 'Update Selected'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={`border-t border-gray-100 ${compact ? 'p-2.5' : 'p-3'}`}>
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about retirement, selling properties, big purchases..."
            className="flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
            rows={1}
            style={{ maxHeight: 100, minHeight: 36 }}
          />
          <button
            onClick={() => handleSend()}
            disabled={!inputValue.trim() || isLoading}
            className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
