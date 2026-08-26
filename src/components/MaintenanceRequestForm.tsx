import { useEffect, useRef, useState } from 'react';
import { findTrustedProviderForCategory } from './TrustedProviders';
import { extractStateCode } from '../services/regionalDataService';
import { getStoredPracticeTestPhone } from '../utils/practiceTestPhone';

interface AIAutomationResult {
  enabled: boolean;
  status: 'processing' | 'completed' | 'disabled' | 'error';
  usedTrustedProvider?: boolean;
  selectedProvider?: {
    name: string;
    phone: string;
    rating: number;
    reviewCount?: number;
    address?: string;
    aiAnalysis?: {
      overallScore: number;
      recommendation: string;
    };
  };
  callInitiated?: boolean;
  error?: string;
}

interface MaintenanceTriage {
  category: string;
  priority: 'low' | 'normal' | 'urgent';
  location: string;
  summary: string;
  ownerSummary?: string;
  serviceTypeHint?: string;
  readyToSubmit: boolean;
  emergencyLevel: 'none' | 'urgent' | 'call_911';
  emergencyGuidance?: string;
  suggestedActions?: string[];
  liveAssistantSummary?: string;
  appliance?: {
    isVisible: boolean;
    type: string;
    brand: string;
    model: string;
    confidence: 'high' | 'medium' | 'low';
  } | null;
  applianceTroubleshooting?: {
    steps: string[];
    safetyWarnings?: string[];
    needsProfessional?: boolean;
  } | null;
  transcript?: Array<{ role: string; content: string }>;
}

type TimeWindow = 'morning' | 'afternoon' | 'evening';

interface AvailabilityDate {
  dateStr: string;
  windows: TimeWindow[];
}

interface Scenario {
  label: string;
  description: string;
  priority: 'low' | 'normal' | 'urgent';
}

const MAINTENANCE_SCENARIOS: Record<string, Scenario[]> = {
  Plumbing: [
    { label: 'Sink or toilet is actively leaking', description: 'There is an active leak from a sink, toilet, or pipe that may be causing water damage.', priority: 'urgent' },
    { label: 'Drain is clogged or draining slowly', description: 'A drain is fully clogged or draining very slowly.', priority: 'normal' },
    { label: 'No hot water', description: 'No hot water from any faucet — possible water heater issue.', priority: 'urgent' },
    { label: "Toilet won't flush or is running", description: 'Toilet is not flushing or is running continuously.', priority: 'normal' },
    { label: 'Low water pressure throughout unit', description: 'Water pressure throughout the unit is unusually low.', priority: 'low' },
    { label: 'Other plumbing issue', description: 'A plumbing issue not listed above.', priority: 'normal' },
  ],
  Electrical: [
    { label: 'Outlet not working', description: 'One or more electrical outlets are dead and not providing power.', priority: 'normal' },
    { label: 'Lights flickering or out', description: 'Lights are flickering, dimming, or completely out in part of the unit.', priority: 'normal' },
    { label: 'Breaker keeps tripping', description: 'A circuit breaker is repeatedly tripping and cutting power.', priority: 'urgent' },
    { label: 'Sparks or burning smell from outlet', description: 'Sparks or a burning smell from an outlet, switch, or panel — immediate safety concern.', priority: 'urgent' },
    { label: 'Other electrical issue', description: 'An electrical issue not listed above.', priority: 'normal' },
  ],
  HVAC: [
    { label: 'AC running but not cooling', description: 'Air conditioning is running but not cooling the unit to the set temperature.', priority: 'urgent' },
    { label: 'Heat not working', description: 'Heating system is not producing warm air or heating the unit.', priority: 'urgent' },
    { label: 'Thermostat unresponsive or broken', description: 'Thermostat display is off or not responding to adjustments.', priority: 'normal' },
    { label: 'Strange noise from HVAC system', description: 'HVAC system is making unusual banging, rattling, or grinding noises.', priority: 'low' },
    { label: 'Other HVAC issue', description: 'An HVAC issue not listed above.', priority: 'normal' },
  ],
  Appliances: [
    { label: 'Refrigerator not cooling', description: 'Refrigerator is not maintaining safe temperature — food may spoil.', priority: 'urgent' },
    { label: 'Washer or dryer not working', description: 'Washer or dryer is not completing cycles or not turning on.', priority: 'normal' },
    { label: 'Dishwasher not cleaning or cycling', description: 'Dishwasher is not cleaning dishes or completing cycles.', priority: 'low' },
    { label: 'Stove or oven not heating', description: 'Stove burners or oven are not heating properly or not turning on.', priority: 'normal' },
    { label: 'Built-in microwave not working', description: 'Built-in microwave is not functioning.', priority: 'low' },
    { label: 'Other appliance issue', description: 'An appliance issue not listed above.', priority: 'normal' },
  ],
  Structural: [
    { label: 'Water leaking through ceiling', description: 'Water is actively dripping or leaking through the ceiling.', priority: 'urgent' },
    { label: 'Window damaged or not closing', description: 'A window is cracked, broken, or cannot be properly closed or locked.', priority: 'normal' },
    { label: 'Mold or visible water damage', description: 'Visible mold or signs of water damage on walls, floors, or ceiling.', priority: 'urgent' },
    { label: 'Large crack in wall or ceiling', description: 'A significant crack has appeared in a wall or ceiling.', priority: 'normal' },
    { label: 'Flooring damaged or lifted', description: 'Flooring is damaged, lifted, or creating a safety hazard.', priority: 'normal' },
    { label: 'Other structural issue', description: 'A structural issue not listed above.', priority: 'normal' },
  ],
  'Pest Control': [
    { label: 'Cockroaches or ants present', description: 'Cockroaches or ants are present inside the unit.', priority: 'normal' },
    { label: 'Mice or rats in the unit', description: 'Evidence of mice or rats inside the unit — droppings, sounds, or sightings.', priority: 'urgent' },
    { label: 'Suspected bed bug infestation', description: 'Suspected bed bug infestation — bites, spotting on mattress or furniture.', priority: 'urgent' },
    { label: 'Wasps, hornets, or bees', description: 'Wasp, hornet, or bee nest on or near the unit.', priority: 'normal' },
    { label: 'Other pest issue', description: 'A pest issue not listed above.', priority: 'normal' },
  ],
  'Lock/Security': [
    { label: 'Door lock is broken', description: 'Door lock is broken and the unit cannot be securely locked.', priority: 'urgent' },
    { label: 'Key lost or locked out', description: 'Key is lost or tenant is locked out of the unit.', priority: 'urgent' },
    { label: 'Door not closing properly', description: 'Entry door is not closing, latching, or sealing properly.', priority: 'normal' },
    { label: 'Building intercom not working', description: 'Building intercom system is not functioning.', priority: 'low' },
    { label: 'Other lock or security issue', description: 'A lock or security issue not listed above.', priority: 'normal' },
  ],
  Other: [
    { label: 'Common area cleaning needed', description: 'Common area cleaning or trash removal is needed.', priority: 'low' },
    { label: 'Parking or garage door issue', description: 'Parking space or garage door is blocked or not working.', priority: 'normal' },
    { label: 'Building elevator out of service', description: 'Building elevator is out of service.', priority: 'normal' },
    { label: 'Something else not listed', description: 'An issue not covered by any other category.', priority: 'normal' },
  ],
};

function CategoryIcon({ id }: { id: string }) {
  const cls = 'w-7 h-7';
  if (id === 'Plumbing') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1M4.22 4.22l.7.7M18.36 18.36l.7.7M1 12h1M21 12h1M4.22 19.78l.7-.7M18.36 5.64l.7-.7" />
    </svg>
  );
  if (id === 'Electrical') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  );
  if (id === 'HVAC') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
  if (id === 'Appliances') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.75}>
      <rect x="2" y="3" width="20" height="14" rx="2" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8M12 17v4" />
      <circle cx="9" cy="10" r="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 8h4M14 11h4M14 14h2" />
    </svg>
  );
  if (id === 'Structural') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 21V12h6v9" />
    </svg>
  );
  if (id === 'Pest Control') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  );
  if (id === 'Lock/Security') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.75}>
      <rect x="5" y="11" width="14" height="10" rx="2" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 018 0v4" />
      <circle cx="12" cy="16" r="1" fill="currentColor" />
    </svg>
  );
  return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.75}>
      <circle cx="12" cy="12" r="10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
      <circle cx="12" cy="17" r="0.5" fill="currentColor" />
    </svg>
  );
}

const PRIORITY_STYLES: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  normal: 'bg-amber-100 text-amber-700 border-amber-200',
  low: 'bg-green-100 text-green-700 border-green-200',
};

const PRIORITY_LABELS: Record<string, string> = {
  urgent: 'Urgent',
  normal: 'Normal',
  low: 'Low priority',
};

const CATEGORY_COLORS: Record<string, { border: string; bg: string; icon: string }> = {
  Plumbing: { border: 'border-blue-300', bg: 'bg-blue-50 hover:bg-blue-100', icon: 'text-blue-600' },
  Electrical: { border: 'border-yellow-300', bg: 'bg-yellow-50 hover:bg-yellow-100', icon: 'text-yellow-600' },
  HVAC: { border: 'border-cyan-300', bg: 'bg-cyan-50 hover:bg-cyan-100', icon: 'text-cyan-600' },
  Appliances: { border: 'border-purple-300', bg: 'bg-purple-50 hover:bg-purple-100', icon: 'text-purple-600' },
  Structural: { border: 'border-orange-300', bg: 'bg-orange-50 hover:bg-orange-100', icon: 'text-orange-600' },
  'Pest Control': { border: 'border-green-300', bg: 'bg-green-50 hover:bg-green-100', icon: 'text-green-600' },
  'Lock/Security': { border: 'border-slate-300', bg: 'bg-slate-50 hover:bg-slate-100', icon: 'text-slate-600' },
  Other: { border: 'border-gray-300', bg: 'bg-gray-50 hover:bg-gray-100', icon: 'text-gray-600' },
};

function formatDateStr(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatDisplayDate(dateStr: string) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

interface MaintenanceRequestFormProps {
  propertyAddress?: string;
  unit?: string;
  tenantId?: string;
  tenantEmail?: string;
  tenantName?: string;
  ownerId?: string;
  propertyId?: string;
  onSubmitSuccess?: () => void;
  enableAIAutomation?: boolean;
  showLiveAssistantInline?: boolean;
}

export default function MaintenanceRequestForm({
  propertyAddress,
  unit,
  tenantId,
  tenantEmail,
  tenantName,
  ownerId,
  propertyId,
  onSubmitSuccess,
  enableAIAutomation = true,
}: MaintenanceRequestFormProps) {
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'urgent'>('normal');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [tenantAvailability, setTenantAvailability] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [triage, setTriage] = useState<MaintenanceTriage | null>(null);
  const [autoBook, setAutoBook] = useState(false);
  const [manualPropertyAddress, setManualPropertyAddress] = useState('');
  const [aiStatus, setAiStatus] = useState<AIAutomationResult | null>(null);
  const [showAIDetails, setShowAIDetails] = useState(false);
  const automationPollTimeoutRef = useRef<number | null>(null);

  // Scenario selection flow
  const [scenarioStep, setScenarioStep] = useState<'category' | 'scenario' | 'form'>('category');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  // Calendar / availability
  const [availabilityDates, setAvailabilityDates] = useState<AvailabilityDate[]>([]);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });

  useEffect(() => () => {
    if (automationPollTimeoutRef.current !== null) {
      window.clearTimeout(automationPollTimeoutRef.current);
    }
  }, []);

  // Sync calendar selection → tenantAvailability string
  useEffect(() => {
    if (availabilityDates.length === 0) {
      setTenantAvailability('');
      return;
    }
    const parts = [...availabilityDates]
      .sort((a, b) => a.dateStr.localeCompare(b.dateStr))
      .map(({ dateStr, windows }) => {
        const label = formatDisplayDate(dateStr);
        if (windows.length === 0) return label;
        const windowLabels = windows.map((w) =>
          w === 'morning' ? 'Morning (8am–12pm)' :
          w === 'afternoon' ? 'Afternoon (12pm–5pm)' :
          'Evening (5pm–9pm)'
        );
        return `${label}: ${windowLabels.join(', ')}`;
      });
    setTenantAvailability(parts.join(' | '));
  }, [availabilityDates]);

  // Calendar helpers
  const toggleDate = (dateStr: string) => {
    setAvailabilityDates((prev) => {
      const exists = prev.find((d) => d.dateStr === dateStr);
      if (exists) return prev.filter((d) => d.dateStr !== dateStr);
      return [...prev, { dateStr, windows: [] }];
    });
  };

  const toggleWindow = (dateStr: string, window: TimeWindow) => {
    setAvailabilityDates((prev) =>
      prev.map((d) => {
        if (d.dateStr !== dateStr) return d;
        const windows = d.windows.includes(window)
          ? d.windows.filter((w) => w !== window)
          : [...d.windows, window];
        return { ...d, windows };
      })
    );
  };

  const isDateSelected = (dateStr: string) => availabilityDates.some((d) => d.dateStr === dateStr);
  const getDateWindows = (dateStr: string) => availabilityDates.find((d) => d.dateStr === dateStr)?.windows ?? [];

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files);
      setImages([...images, ...newFiles].slice(0, 5));
    }
  };

  const removeImage = (index: number) => {
    setImages(images.filter((_, i) => i !== index));
  };

  const handleScenarioSelect = (scenario: Scenario, catId: string) => {
    setCategory(catId);
    setPriority(scenario.priority);
    setDescription(scenario.description);
    setTriage({
      category: catId,
      priority: scenario.priority,
      location: '',
      summary: scenario.description,
      ownerSummary: scenario.description,
      serviceTypeHint: catId.toLowerCase(),
      readyToSubmit: scenario.description.trim().length >= 20,
      emergencyLevel: scenario.priority === 'urgent' ? 'urgent' : 'none',
      emergencyGuidance: '',
      suggestedActions: [],
    });
    setScenarioStep('form');
  };

  const handleReset = () => {
    setScenarioStep('category');
    setSelectedCategoryId(null);
    setCategory('');
    setPriority('normal');
    setDescription('');
    setLocation('');
    setTriage(null);
    setAvailabilityDates([]);
    setImages([]);
    setAutoBook(false);
    setManualPropertyAddress('');
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);
    setAiStatus(null);

    try {
      const finalPropertyAddress = propertyAddress || manualPropertyAddress;
      const trustedProvider = await findTrustedProviderForCategory(ownerId, category, {
        propertyScopeId: propertyId,
        region: finalPropertyAddress ? extractStateCode(finalPropertyAddress) : undefined
      });
      const finalDescription = (description || triage?.ownerSummary || triage?.summary || '').trim();

      const requestBody: Record<string, unknown> = {
        category,
        priority,
        description: finalDescription,
        location,
        tenantAvailability,
        propertyAddress: finalPropertyAddress,
        unit: unit || '',
        autoBook: autoBook && enableAIAutomation,
        tenantId,
        tenantEmail,
        tenantName,
        ownerId,
        propertyId,
        triage: triage ?? null,
        practiceTestPhone: getStoredPracticeTestPhone(),
      };

      if (trustedProvider) {
        requestBody.trustedProvider = {
          name: trustedProvider.name,
          phone: trustedProvider.phone,
          email: trustedProvider.email,
          notes: trustedProvider.notes
        };
      }

      const response = await fetch('/api/maintenance/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to submit maintenance request');
      }

      setSuccess(true);

      if (data.aiAutomation) {
        setAiStatus({
          enabled: data.aiAutomation.enabled,
          status: data.aiAutomation.status === 'processing'
            ? 'processing'
            : data.aiAutomation.status === 'provider_found'
              ? 'completed'
              : 'processing',
          usedTrustedProvider: data.aiAutomation.usedTrustedProvider || false
        });

        if (!data.aiAutomation.usedTrustedProvider && data.aiAutomation.enabled && data.request?.id) {
          pollAIAutomationStatus(data.request.id);
        }
      }

      setCategory('');
      setPriority('normal');
      setDescription('');
      setLocation('');
      setTenantAvailability('');
      setImages([]);
      setAutoBook(false);
      setManualPropertyAddress('');
      setTriage(null);
      setScenarioStep('category');
      setSelectedCategoryId(null);
      setAvailabilityDates([]);

      if (onSubmitSuccess) {
        onSubmitSuccess();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to submit request');
    } finally {
      setLoading(false);
    }
  };

  const pollAIAutomationStatus = async (requestId: string, attemptsRemaining = 8) => {
    try {
      const response = await fetch('/api/maintenance/automation-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId })
      });

      const data = await response.json();

      if (data.ok && data.aiAutomation?.status === 'provider_found') {
        setAiStatus({
          enabled: true,
          status: 'completed',
          usedTrustedProvider: Boolean(data.aiAutomation?.usedTrustedProvider),
          selectedProvider: data.aiAutomation?.selectedProvider,
          callInitiated: Boolean(data.aiAutomation?.callInitiated)
        });
      } else if (data.ok && (data.aiAutomation?.status === 'no_provider_found' || data.aiAutomation?.status === 'error')) {
        setAiStatus({
          enabled: true,
          status: 'error',
          usedTrustedProvider: Boolean(data.aiAutomation?.usedTrustedProvider),
          error: data.aiAutomation?.callError || data.aiAutomation?.error || 'No suitable providers found'
        });
      } else if (data.ok && attemptsRemaining > 0) {
        automationPollTimeoutRef.current = window.setTimeout(() => {
          pollAIAutomationStatus(requestId, attemptsRemaining - 1);
        }, 2000);
      } else {
        setAiStatus({ enabled: true, status: 'processing' });
      }
    } catch {
      setAiStatus({ enabled: true, status: 'error', error: 'Failed to check AI automation status' });
    }
  };

  // ── Calendar renderer ──────────────────────────────────────────────────────
  function renderCalendar() {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDay = new Date(year, month, 1).getDay();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const monthName = calendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const cells: React.ReactNode[] = [];
    for (let i = 0; i < firstDay; i++) {
      cells.push(<div key={`empty-${i}`} />);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = formatDateStr(year, month, day);
      const cellDate = new Date(year, month, day);
      cellDate.setHours(0, 0, 0, 0);
      const isPast = cellDate < today;
      const isSelected = isDateSelected(dateStr);
      cells.push(
        <button
          key={day}
          type="button"
          disabled={isPast}
          onClick={() => toggleDate(dateStr)}
          className={[
            'h-9 w-full rounded-lg text-sm font-medium transition-colors',
            isPast ? 'text-gray-300 cursor-not-allowed' : '',
            isSelected
              ? 'bg-indigo-600 text-white shadow-sm'
              : !isPast
                ? 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-700'
                : '',
          ].join(' ')}
        >
          {day}
        </button>
      );
    }

    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <button
            type="button"
            onClick={() => setCalendarMonth(new Date(year, month - 1, 1))}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-gray-800">{monthName}</span>
          <button
            type="button"
            onClick={() => setCalendarMonth(new Date(year, month + 1, 1))}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-7 text-center mb-1">
          {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
            <div key={d} className="text-xs font-medium text-gray-400 py-1">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">{cells}</div>

        {availabilityDates.length > 0 && (
          <div className="mt-4 space-y-2 pt-4 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Selected dates</p>
            {[...availabilityDates]
              .sort((a, b) => a.dateStr.localeCompare(b.dateStr))
              .map(({ dateStr }) => (
                <div key={dateStr} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-gray-700 w-24 shrink-0">{formatDisplayDate(dateStr)}</span>
                  {(['morning', 'afternoon', 'evening'] as TimeWindow[]).map((w) => {
                    const active = getDateWindows(dateStr).includes(w);
                    return (
                      <button
                        key={w}
                        type="button"
                        onClick={() => toggleWindow(dateStr, w)}
                        className={[
                          'px-2 py-0.5 text-xs rounded-full border font-medium transition-colors',
                          active
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'border-gray-300 text-gray-500 hover:border-indigo-400 hover:text-indigo-600',
                        ].join(' ')}
                      >
                        {w.charAt(0).toUpperCase() + w.slice(1)}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => toggleDate(dateStr)}
                    className="text-gray-300 hover:text-red-400 transition-colors ml-auto"
                    title="Remove date"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* Success banner */}
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-green-600 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <div className="flex-1">
              <div className="text-sm font-semibold text-green-800">Request Submitted</div>
              <div className="text-sm text-green-700 mt-0.5">Your property owner has been notified and will respond shortly.</div>

              {aiStatus?.enabled && (
                <div className="mt-3 p-3 bg-white/60 rounded-lg border border-green-100">
                  <div className="flex items-center gap-2 text-green-800 text-sm font-medium">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    AI Service Finder
                  </div>
                  {aiStatus.status === 'processing' && (
                    <div className="mt-2 flex items-center gap-2 text-sm text-green-700">
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Searching for the best repair service provider...
                    </div>
                  )}
                  {aiStatus.status === 'completed' && aiStatus.selectedProvider && (
                    <div className="mt-2">
                      <div className="text-sm text-green-700">Found recommended provider:</div>
                      <div className="mt-1.5 p-2 bg-white rounded border border-green-200">
                        <div className="font-medium text-gray-800 text-sm">{aiStatus.selectedProvider.name}</div>
                        <div className="flex items-center gap-2 text-xs text-gray-600 mt-1">
                          <span className="flex items-center gap-0.5">
                            <svg className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                            </svg>
                            {aiStatus.selectedProvider.rating?.toFixed(1)}
                          </span>
                          {aiStatus.selectedProvider.phone && <span>{aiStatus.selectedProvider.phone}</span>}
                        </div>
                        {aiStatus.selectedProvider.aiAnalysis && (
                          <div className="mt-1.5 text-xs text-gray-500">
                            AI Score: {aiStatus.selectedProvider.aiAnalysis.overallScore}/100
                            <button type="button" onClick={() => setShowAIDetails(!showAIDetails)} className="ml-2 text-purple-600 hover:text-purple-700">
                              {showAIDetails ? 'Hide' : 'Show details'}
                            </button>
                          </div>
                        )}
                        {showAIDetails && aiStatus.selectedProvider.aiAnalysis?.recommendation && (
                          <div className="mt-1.5 text-xs text-gray-600 bg-gray-50 p-2 rounded">{aiStatus.selectedProvider.aiAnalysis.recommendation}</div>
                        )}
                      </div>
                    </div>
                  )}
                  {aiStatus.status === 'error' && (
                    <div className="mt-1.5 text-sm text-orange-600">{aiStatus.error || 'Could not find service providers'}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-red-600 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <div className="text-sm text-red-800">{error}</div>
          </div>
        </div>
      )}

      {/* ── Step 1: Category Selection ─────────────────────────────────────── */}
      {scenarioStep === 'category' && (
        <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-sky-50 p-5">
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-1">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white text-xs font-bold">1</div>
              <h3 className="text-lg font-semibold text-slate-900">What type of issue is it?</h3>
            </div>
            <p className="text-sm text-slate-500 ml-8">Select the category that best describes your problem.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Object.keys(MAINTENANCE_SCENARIOS).map((catId) => {
              const colors = CATEGORY_COLORS[catId] ?? CATEGORY_COLORS.Other;
              return (
                <button
                  key={catId}
                  type="button"
                  onClick={() => {
                    setSelectedCategoryId(catId);
                    setScenarioStep('scenario');
                  }}
                  className={[
                    'flex flex-col items-center gap-2.5 p-4 rounded-xl border-2 transition-all text-center',
                    colors.border,
                    colors.bg,
                  ].join(' ')}
                >
                  <span className={colors.icon}>
                    <CategoryIcon id={catId} />
                  </span>
                  <span className="text-sm font-medium text-gray-800 leading-tight">{catId}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Step 2: Scenario Selection ─────────────────────────────────────── */}
      {scenarioStep === 'scenario' && selectedCategoryId && (
        <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-sky-50 p-5">
          <div className="flex items-center gap-3 mb-5">
            <button
              type="button"
              onClick={() => setScenarioStep('category')}
              className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
            <div className="h-4 w-px bg-gray-300" />
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white text-xs font-bold">2</div>
              <h3 className="text-lg font-semibold text-slate-900">What best describes your situation?</h3>
            </div>
          </div>
          <div className="space-y-2">
            {MAINTENANCE_SCENARIOS[selectedCategoryId].map((scenario) => (
              <button
                key={scenario.label}
                type="button"
                onClick={() => handleScenarioSelect(scenario, selectedCategoryId)}
                className="w-full text-left p-4 rounded-xl border-2 border-gray-200 bg-white hover:border-indigo-400 hover:bg-indigo-50 transition-all group"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-gray-900 group-hover:text-indigo-900">{scenario.label}</span>
                  <span className={`shrink-0 text-xs px-2.5 py-0.5 rounded-full border font-medium ${PRIORITY_STYLES[scenario.priority]}`}>
                    {PRIORITY_LABELS[scenario.priority]}
                  </span>
                </div>
                {scenario.description && (
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">{scenario.description}</p>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 3: Unified Form ───────────────────────────────────────────── */}
      {scenarioStep === 'form' && (
        <>
          {/* Emergency banners */}
          {triage?.emergencyLevel === 'call_911' && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-4">
              <div className="text-sm font-semibold text-red-900">Immediate emergency</div>
              <div className="mt-1 text-sm text-red-800">{triage.emergencyGuidance || 'Call 911 now if there is an active threat to safety or property.'}</div>
              {triage.suggestedActions && triage.suggestedActions.length > 0 && (
                <div className="mt-2 space-y-0.5 text-sm text-red-800">
                  {triage.suggestedActions.map((action) => <div key={action}>– {action}</div>)}
                </div>
              )}
            </div>
          )}
          {triage?.emergencyLevel === 'urgent' && triage.emergencyGuidance && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="font-semibold">Urgent issue</div>
              <div className="mt-0.5">{triage.emergencyGuidance}</div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Selected issue banner */}
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className={`shrink-0 mt-0.5 ${CATEGORY_COLORS[category]?.icon ?? 'text-indigo-600'}`}>
                    <CategoryIcon id={category} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-indigo-900">{category}</span>
                      <span className={`text-xs px-2.5 py-0.5 rounded-full border font-medium ${PRIORITY_STYLES[priority]}`}>
                        {PRIORITY_LABELS[priority]}
                      </span>
                    </div>
                    <p className="text-sm text-indigo-800 mt-0.5">{description}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleReset}
                  className="shrink-0 text-xs text-indigo-600 hover:text-indigo-800 font-medium border border-indigo-300 bg-white rounded-lg px-2.5 py-1 hover:bg-indigo-50 transition-colors"
                >
                  Change issue
                </button>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
              {/* Left column */}
              <div className="space-y-5">
                {/* Category */}
                <div>
                  <label htmlFor="category" className="block text-sm font-medium text-gray-700 mb-1.5">
                    Issue Category <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    required
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                  >
                    <option value="">Select a category...</option>
                    {Object.keys(MAINTENANCE_SCENARIOS).map((cat) => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>

                {/* Priority */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Priority Level</label>
                  <div className="flex gap-4">
                    {(['low', 'normal', 'urgent'] as const).map((p) => (
                      <label key={p} className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          value={p}
                          checked={priority === p}
                          onChange={() => setPriority(p)}
                          className="w-4 h-4 text-indigo-600"
                        />
                        <span className="text-sm capitalize">{p}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Location */}
                <div>
                  <label htmlFor="location" className="block text-sm font-medium text-gray-700 mb-1.5">
                    Location in Unit
                  </label>
                  <input
                    id="location"
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                    placeholder="e.g., Kitchen sink, Master bedroom closet"
                  />
                </div>

                {/* Description */}
                <div>
                  <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1.5">
                    Request Summary <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    required
                    rows={4}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none text-sm"
                    placeholder="Add any additional detail about the issue."
                  />
                </div>

                {/* Availability Calendar */}
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <rect x="3" y="4" width="18" height="18" rx="2" strokeLinecap="round" strokeLinejoin="round" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16 2v4M8 2v4M3 10h18" />
                    </svg>
                    <label className="text-sm font-medium text-gray-700">When are you available for a visit?</label>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">Click dates to select them, then choose your preferred time windows. Select as many as you like.</p>
                  {renderCalendar()}
                  {tenantAvailability && (
                    <div className="mt-3 pt-3 border-t border-gray-100">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Availability summary</p>
                      <p className="text-xs text-gray-700 leading-relaxed">{tenantAvailability}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Right column */}
              <div className="space-y-5">
                {/* AI Summary */}
                <div className="rounded-xl border border-indigo-100 bg-gradient-to-br from-indigo-50 to-white p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    <div className="text-sm font-semibold text-indigo-900">AI Request Summary</div>
                    <div className="ml-auto rounded-full bg-white px-2 py-0.5 text-xs font-medium text-indigo-600 border border-indigo-200">
                      Powered by Gemini
                    </div>
                  </div>
                  <div className="space-y-1.5 text-sm text-slate-700">
                    <div className="flex gap-1.5"><span className="font-medium text-slate-500 w-20 shrink-0">Category</span><span>{triage?.category || category || '—'}</span></div>
                    <div className="flex gap-1.5">
                      <span className="font-medium text-slate-500 w-20 shrink-0">Priority</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${PRIORITY_STYLES[triage?.priority || priority]}`}>
                        {PRIORITY_LABELS[triage?.priority || priority]}
                      </span>
                    </div>
                    <div className="flex gap-1.5"><span className="font-medium text-slate-500 w-20 shrink-0">Location</span><span>{triage?.location || location || 'Not set'}</span></div>
                    <div className="flex gap-1.5"><span className="font-medium text-slate-500 w-20 shrink-0">Availability</span><span className="text-xs leading-relaxed">{tenantAvailability || 'Not selected yet'}</span></div>
                    <div className="flex gap-1.5">
                      <span className="font-medium text-slate-500 w-20 shrink-0">Ready</span>
                      <span className={triage?.readyToSubmit ? 'text-green-600 font-medium' : 'text-amber-600'}>
                        {triage?.readyToSubmit ? 'Ready to submit' : 'Add more detail'}
                      </span>
                    </div>
                  </div>

                  {triage?.suggestedActions && triage.suggestedActions.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-indigo-100">
                      <div className="text-xs font-semibold uppercase tracking-wide text-indigo-500 mb-1.5">Suggested next steps</div>
                      <div className="space-y-0.5 text-xs text-slate-700">
                        {triage.suggestedActions.map((action) => <div key={action}>– {action}</div>)}
                      </div>
                    </div>
                  )}

                  {triage?.applianceTroubleshooting?.steps?.length ? (
                    <div className="mt-3 rounded-lg bg-emerald-50 p-3 border border-emerald-200">
                      <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700 mb-1.5">Troubleshooting tips</div>
                      <div className="space-y-0.5 text-xs text-slate-700">
                        {triage.applianceTroubleshooting.steps.map((step) => <div key={step}>– {step}</div>)}
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Photos */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Photos <span className="text-gray-400 font-normal">(optional, max 5)</span>
                  </label>
                  <div className="border-2 border-dashed border-gray-300 rounded-xl p-5 text-center hover:border-indigo-300 transition-colors">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleImageChange}
                      className="hidden"
                      id="image-upload"
                      disabled={images.length >= 5}
                    />
                    <label htmlFor="image-upload" className="cursor-pointer">
                      <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      <div className="mt-2 text-sm text-gray-500">
                        {images.length >= 5 ? (
                          <span className="text-red-600">Maximum 5 images reached</span>
                        ) : (
                          <><span className="font-medium text-purple-600">Click to upload</span> or drag and drop</>
                        )}
                      </div>
                    </label>
                  </div>

                  {images.length > 0 && (
                    <div className="mt-3 grid grid-cols-5 gap-2">
                      {images.map((image, index) => (
                        <div key={index} className="relative group">
                          <img src={URL.createObjectURL(image)} alt={`Preview ${index + 1}`} className="w-full h-16 object-cover rounded-lg" />
                          <button
                            type="button"
                            onClick={() => removeImage(index)}
                            className="absolute top-0.5 right-0.5 bg-red-600 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* AI automation */}
            {enableAIAutomation && (
              <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <input
                    id="auto-book"
                    type="checkbox"
                    checked={autoBook}
                    onChange={(e) => setAutoBook(e.target.checked)}
                    className="mt-0.5 w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
                  />
                  <div className="flex-1">
                    <label htmlFor="auto-book" className="text-sm font-medium text-gray-800 cursor-pointer">AI-powered repair scheduling</label>
                    <p className="text-xs text-gray-600 mt-0.5">After you submit, the system can search for the best-rated repair service in your area and help start the scheduling process.</p>
                    {autoBook && (
                      <div className="mt-1.5 text-xs text-purple-600 flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        The system will analyze local providers and can initiate scheduling
                      </div>
                    )}
                  </div>
                </div>

                {autoBook && !propertyAddress && (
                  <div className="mt-3">
                    <label htmlFor="manual-address" className="block text-sm font-medium text-gray-700 mb-1.5">
                      Property Address <span className="text-red-500">*</span>
                      <span className="text-xs text-gray-500 font-normal ml-1">(required to find local providers)</span>
                    </label>
                    <input
                      id="manual-address"
                      type="text"
                      value={manualPropertyAddress}
                      onChange={(e) => setManualPropertyAddress(e.target.value)}
                      required={autoBook}
                      className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                      placeholder="e.g., 123 Main St, Potomac, MD 20854"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-3 px-6 rounded-xl transition-colors duration-200 text-sm"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Submitting...
                </span>
              ) : autoBook ? 'Submit and start scheduling' : 'Submit Request'}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
