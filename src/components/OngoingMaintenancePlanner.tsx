import React, { useEffect, useMemo, useState } from 'react';
import { useFirestoreBookkeeping } from '../hooks/useFirestoreBookkeeping';

interface PropertyOption {
  id: string;
  address: string;
}

interface PlannerItem {
  id: string;
  ownerId?: string;
  propertyId?: string;
  propertyAddress?: string;
  title: string;
  description?: string;
  category: string;
  source: string;
  productName?: string;
  modelNumber?: string;
  installedAt?: string | null;
  dueDate?: string | null;
  cadenceDays?: number | null;
  priority?: string;
  notes?: string;
  status?: string;
  searchQuery?: string;
  manufacturerGuidance?: {
    intervalDays?: number | null;
    intervalText?: string;
    orderLeadDays?: number;
    orderDate?: string | null;
    confidence?: number;
  } | null;
  aiSummary?: string;
  sources?: Array<{ title?: string; link?: string; note?: string; source?: string }>;
  sourceTransactionId?: string;
  sourceAppointmentId?: string;
  createdAt?: string;
}

interface MaintenanceRequest {
  id: string;
  category: string;
  description: string;
  propertyAddress: string;
  status: string;
  priority: string;
  createdAt: string;
}

interface Appointment {
  id: string;
  address: string;
  issueDescription: string;
  status: string;
  preferredSlots?: Array<{ id: string; start: string; end: string }>;
  confirmedSlotId?: string | null;
  createdAt: string;
}

interface NativeTransaction {
  id: string;
  date: string;
  description: string;
  category: string;
  amount: number;
  type: string;
  propertyId?: string;
}

interface Props {
  ownerId: string;
  properties: PropertyOption[];
}

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const solidPanel = 'rounded-3xl border border-slate-200 bg-white p-0 shadow-[0_16px_48px_rgba(15,23,42,0.08)]';
const insetPanel = 'rounded-2xl border border-slate-200 bg-slate-50';
const subtleText = 'text-slate-500';

function formatShortDate(value?: string | null) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not scheduled';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(value));
}

function normalizeString(value?: string | null) {
  return (value || '').trim();
}

function extractModelNumber(text: string) {
  const match = text.match(/\b[A-Z0-9]{2,}(?:[-/][A-Z0-9]{2,})+\b/i) || text.match(/\b[A-Z0-9]{5,}\b/i);
  return match ? match[0] : '';
}

function inferReplacementPlan(description: string, category: string) {
  const haystack = `${description} ${category}`.toLowerCase();

  if (haystack.includes('air filter') || haystack.includes('furnace filter') || haystack.includes('hvac filter')) {
    return { category: 'filter', title: 'Replace air filter', cadenceDays: 90, priority: 'medium' };
  }
  if (haystack.includes('water filter') || haystack.includes('fridge filter') || haystack.includes('refrigerator filter') || haystack.includes('reverse osmosis')) {
    return { category: 'filter', title: 'Replace water filter', cadenceDays: 180, priority: 'medium' };
  }
  if (haystack.includes('gutter')) {
    return { category: 'exterior', title: 'Clean gutters and downspouts', cadenceDays: 180, priority: 'medium' };
  }
  if (haystack.includes('roof')) {
    return { category: 'roof', title: 'Roof inspection', cadenceDays: 365, priority: 'high' };
  }
  if (haystack.includes('hvac') || haystack.includes('furnace') || haystack.includes('heat pump') || haystack.includes('ac tune')) {
    return { category: 'hvac', title: 'Seasonal HVAC service', cadenceDays: 180, priority: 'high' };
  }
  if (haystack.includes('hose bib') || haystack.includes('spigot') || haystack.includes('shut off valve') || haystack.includes('winterize')) {
    return { category: 'winterization', title: 'Winterize exterior water lines', cadenceDays: 365, priority: 'high' };
  }
  if (haystack.includes('smoke detector') || haystack.includes('co detector')) {
    return { category: 'safety', title: 'Safety detector battery and test', cadenceDays: 180, priority: 'medium' };
  }

  return null;
}

function scoreUrgency(item: PlannerItem) {
  if (!item.dueDate) return 9999;
  const diff = new Date(item.dueDate).getTime() - Date.now();
  return Math.round(diff / 86400000);
}

export default function OngoingMaintenancePlanner({ ownerId, properties }: Props) {
  const [calendarMonth, setCalendarMonth] = useState(new Date().getMonth());
  const [calendarYear, setCalendarYear] = useState(new Date().getFullYear());
  const [manualItems, setManualItems] = useState<PlannerItem[]>([]);
  const [maintenanceRequests, setMaintenanceRequests] = useState<MaintenanceRequest[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [nativeTransactions, setNativeTransactions] = useState<NativeTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [researchingId, setResearchingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: '',
    propertyId: properties[0]?.id || '',
    category: 'filter',
    installedAt: new Date().toISOString().slice(0, 10),
    cadenceDays: '180',
    productName: '',
    modelNumber: '',
    notes: '',
  });

  const {
    user: bookkeepingUser,
    isInitialized: bookkeepingInitialized,
    isLoading: bookkeepingLoading,
    transactions: bookkeepingTransactions,
    initialize: initializeBookkeeping,
    fetchData: fetchBookkeepingData,
  } = useFirestoreBookkeeping();

  useEffect(() => {
    if (properties.length > 0 && !form.propertyId) {
      setForm((current) => ({ ...current, propertyId: properties[0].id }));
    }
  }, [form.propertyId, properties]);

  useEffect(() => {
    let ignore = false;

    async function load() {
      setLoading(true);
      try {
        const [ongoingData, requestData, appointmentData, nativeTxnData] = await Promise.all([
          fetch(`/api/maintenance/ongoing?ownerId=${encodeURIComponent(ownerId)}`).then((res) => res.json()),
          fetch('/api/maintenance/requests').then((res) => res.json()),
          fetch('/api/appointments').then((res) => res.json()),
          fetch('/api/bookkeeping/transactions?limit=150').then((res) => res.json()),
        ]);
        if (ignore) return;

        setManualItems(Array.isArray(ongoingData.items) ? ongoingData.items : []);
        setMaintenanceRequests(Array.isArray(requestData.requests) ? requestData.requests : []);
        setAppointments(Array.isArray(appointmentData.appointments) ? appointmentData.appointments : []);
        setNativeTransactions(Array.isArray(nativeTxnData.transactions) ? nativeTxnData.transactions : []);
      } catch (error) {
        if (!ignore) {
          setMessage(error instanceof Error ? error.message : 'Failed to load maintenance planner data');
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();
    return () => {
      ignore = true;
    };
  }, [ownerId]);

  useEffect(() => {
    if (!bookkeepingUser || bookkeepingLoading) return;
    if (!bookkeepingInitialized) {
      initializeBookkeeping().catch(() => undefined);
      return;
    }
    fetchBookkeepingData().catch(() => undefined);
  }, [bookkeepingInitialized, bookkeepingLoading, bookkeepingUser, fetchBookkeepingData, initializeBookkeeping]);

  const transactionFeed: NativeTransaction[] = useMemo(() => {
    if (bookkeepingTransactions.length > 0) {
      return bookkeepingTransactions.map((txn) => ({
        id: txn.id,
        date: txn.date,
        description: txn.description,
        category: txn.category,
        amount: txn.amount,
        type: txn.type,
        propertyId: txn.propertyId,
      }));
    }
    return nativeTransactions;
  }, [bookkeepingTransactions, nativeTransactions]);

  const propertyLookup = useMemo(() => {
    const map = new Map<string, string>();
    properties.forEach((property) => map.set(property.id, property.address));
    return map;
  }, [properties]);

  const derivedFromTransactions = useMemo(() => {
    return transactionFeed
      .map((txn) => {
        const inferred = inferReplacementPlan(txn.description, txn.category);
        if (!inferred || !txn.date) return null;
        const installedAt = new Date(txn.date).toISOString();
        return {
          id: `txn-${txn.id}`,
          propertyId: txn.propertyId,
          propertyAddress: txn.propertyId ? propertyLookup.get(txn.propertyId) : '',
          title: inferred.title,
          description: txn.description,
          category: inferred.category,
          source: 'transaction',
          installedAt,
          dueDate: new Date(new Date(installedAt).getTime() + inferred.cadenceDays * 86400000).toISOString(),
          cadenceDays: inferred.cadenceDays,
          priority: inferred.priority,
          notes: `Derived from ${txn.category} transaction for ${formatMoney(txn.amount)}.`,
          productName: txn.description,
          modelNumber: extractModelNumber(txn.description),
          sourceTransactionId: txn.id,
        } as PlannerItem;
      })
      .filter(Boolean) as PlannerItem[];
  }, [propertyLookup, transactionFeed]);

  const derivedFromRequests = useMemo(() => {
    return maintenanceRequests.slice(0, 12).map((request) => ({
      id: `request-${request.id}`,
      title: request.category || 'Maintenance follow-up',
      description: request.description,
      propertyAddress: request.propertyAddress,
      category: 'repair',
      source: 'maintenance_request',
      dueDate: request.createdAt,
      priority: request.priority,
      notes: `Current status: ${request.status}`,
    }));
  }, [maintenanceRequests]);

  const derivedFromAppointments = useMemo(() => {
    return appointments.map((appointment) => {
      const confirmed = appointment.preferredSlots?.find((slot) => slot.id === appointment.confirmedSlotId);
      const slot = confirmed || appointment.preferredSlots?.[0];
      return {
        id: `apt-${appointment.id}`,
        title: 'Scheduled maintenance visit',
        description: appointment.issueDescription,
        propertyAddress: appointment.address,
        category: 'visit',
        source: 'appointment',
        dueDate: slot?.start || appointment.createdAt,
        priority: appointment.status === 'confirmed' ? 'high' : 'medium',
        notes: `Visit status: ${appointment.status.replace(/_/g, ' ')}`,
        sourceAppointmentId: appointment.id,
      } as PlannerItem;
    });
  }, [appointments]);

  const combinedItems = useMemo(() => {
    const deduped = new Map<string, PlannerItem>();
    [...manualItems, ...derivedFromTransactions, ...derivedFromRequests, ...derivedFromAppointments].forEach((item) => {
      deduped.set(item.id, item);
    });
    return Array.from(deduped.values()).sort((a, b) => scoreUrgency(a) - scoreUrgency(b));
  }, [derivedFromAppointments, derivedFromRequests, derivedFromTransactions, manualItems]);

  const monthItems = useMemo(() => {
    return combinedItems.filter((item) => {
      if (!item.dueDate) return false;
      const date = new Date(item.dueDate);
      return date.getMonth() === calendarMonth && date.getFullYear() === calendarYear;
    });
  }, [calendarMonth, calendarYear, combinedItems]);

  const monthTotal = monthItems.length;

  const calendarWeeks = useMemo(() => {
    const firstDayOfMonth = new Date(calendarYear, calendarMonth, 1).getDay();
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const weeks: Array<Array<number | null>> = [];
    let currentWeek: Array<number | null> = [];

    for (let index = 0; index < firstDayOfMonth; index += 1) currentWeek.push(null);
    for (let day = 1; day <= daysInMonth; day += 1) {
      currentWeek.push(day);
      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
    }
    while (currentWeek.length > 0 && currentWeek.length < 7) currentWeek.push(null);
    if (currentWeek.length > 0) weeks.push(currentWeek);
    return weeks;
  }, [calendarMonth, calendarYear]);

  const itemsByDay = useMemo(() => {
    const grouped: Record<number, PlannerItem[]> = {};
    monthItems.forEach((item) => {
      if (!item.dueDate) return;
      const day = new Date(item.dueDate).getDate();
      if (!grouped[day]) grouped[day] = [];
      grouped[day].push(item);
    });
    return grouped;
  }, [monthItems]);

  const upcomingItems = combinedItems.filter((item) => scoreUrgency(item) <= 45).slice(0, 8);
  const transactionCandidates = derivedFromTransactions.slice(0, 6);

  async function reloadManualItems() {
    const response = await fetch(`/api/maintenance/ongoing?ownerId=${encodeURIComponent(ownerId)}`);
    const data = await response.json();
    if (data.ok) setManualItems(data.items || []);
  }

  async function handleManualSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const propertyAddress = propertyLookup.get(form.propertyId) || '';
      const response = await fetch('/api/maintenance/ongoing/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerId,
          propertyId: form.propertyId,
          propertyAddress,
          title: form.title,
          category: form.category,
          installedAt: form.installedAt,
          cadenceDays: Number(form.cadenceDays),
          productName: form.productName,
          modelNumber: form.modelNumber,
          notes: form.notes,
          source: 'manual',
          priority: form.category === 'winterization' ? 'high' : 'medium',
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Failed to save maintenance item');
      await reloadManualItems();
      setMessage('Manual maintenance item saved.');
      setForm((current) => ({ ...current, title: '', productName: '', modelNumber: '', notes: '' }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save maintenance item');
    } finally {
      setSaving(false);
    }
  }

  async function handleResearch(source: PlannerItem) {
    setResearchingId(source.id);
    setMessage(null);
    try {
      const response = await fetch('/api/maintenance/ongoing/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerId,
          propertyId: source.propertyId,
          propertyAddress: source.propertyAddress,
          title: source.title,
          category: source.category,
          productName: source.productName || source.title,
          modelNumber: source.modelNumber,
          installedAt: source.installedAt || source.dueDate || new Date().toISOString(),
          notes: source.notes,
          source: source.source === 'manual' ? 'manual_research' : 'transaction_research',
          sourceTransactionId: source.sourceTransactionId,
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Research failed');
      await reloadManualItems();
      setMessage('Manufacturer replacement interval added to the calendar.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Research failed');
    } finally {
      setResearchingId(null);
    }
  }

  async function handleDelete(itemId: string) {
    if (!window.confirm('Remove this maintenance item from the calendar?')) return;
    try {
      const response = await fetch(`/api/maintenance/ongoing/${encodeURIComponent(itemId)}?ownerId=${encodeURIComponent(ownerId)}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Failed to delete item');
      await reloadManualItems();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete maintenance item');
    }
  }

  return (
    <div className="space-y-5">
      <div className={`${solidPanel} p-5`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Ongoing Maintenance Planner</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Recurring upkeep, service visits, and replacement cycles from manual entries, bookkeeping, and scheduled repairs.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <div className={`${insetPanel} px-4 py-2`}>
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">This Month</div>
              <div className="mt-0.5 text-xl font-bold text-slate-900">{monthTotal}</div>
            </div>
            <div className={`${insetPanel} px-4 py-2`}>
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Next 45 Days</div>
              <div className="mt-0.5 text-xl font-bold text-slate-900">{upcomingItems.length}</div>
            </div>
            <div className={`${insetPanel} px-4 py-2`}>
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">From Transactions</div>
              <div className="mt-0.5 text-xl font-bold text-slate-900">{derivedFromTransactions.length}</div>
            </div>
          </div>
        </div>
      </div>

      {message && (
        <div className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-800">
          {message}
        </div>
      )}

      {/* ── Full-width Calendar ── */}
      <div className={`${solidPanel} p-5`}>
        <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-lg">🗓️</div>
            <div>
              <div className="text-base font-semibold text-slate-900">Maintenance Calendar</div>
              <div className="text-xs text-slate-500">Recurring replacements, repair visits, and seasonal reminders</div>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5">
            <button
              onClick={() => {
                const nextMonth = calendarMonth - 1;
                if (nextMonth < 0) {
                  setCalendarMonth(11);
                  setCalendarYear((value) => value - 1);
                } else {
                  setCalendarMonth(nextMonth);
                }
              }}
              className="rounded-lg px-2 py-1 text-slate-500 transition hover:bg-slate-100"
            >
              ‹
            </button>
            <div className="min-w-[160px] text-center text-sm font-semibold text-slate-900">
              {monthNames[calendarMonth]} {calendarYear}
            </div>
            <button
              onClick={() => {
                const nextMonth = calendarMonth + 1;
                if (nextMonth > 11) {
                  setCalendarMonth(0);
                  setCalendarYear((value) => value + 1);
                } else {
                  setCalendarMonth(nextMonth);
                }
              }}
              className="rounded-lg px-2 py-1 text-slate-500 transition hover:bg-slate-100"
            >
              ›
            </button>
          </div>
        </div>

        <div className="mt-4">
          <div className="grid grid-cols-7 gap-1.5">
            {dayNames.map((day) => (
              <div key={day} className="px-2 py-1 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                {day}
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1.5">
            {calendarWeeks.flat().map((day, index) => {
              const dayItems = day ? itemsByDay[day] || [] : [];
              const isToday = day === new Date().getDate() && calendarMonth === new Date().getMonth() && calendarYear === new Date().getFullYear();
              return (
                <div
                  key={`${calendarMonth}-${calendarYear}-${index}`}
                  className={`min-h-[110px] rounded-xl border px-2 py-1.5 ${day ? 'bg-white' : 'bg-slate-50/50'} ${isToday ? 'border-violet-400 ring-1 ring-violet-200' : 'border-slate-100'}`}
                >
                  {day && (
                    <>
                      <div className={`mb-1 text-xs font-semibold ${isToday ? 'text-violet-600' : 'text-slate-700'}`}>{day}</div>
                      <div className="space-y-1">
                        {dayItems.slice(0, 3).map((item) => (
                          <div
                            key={item.id}
                            className={`rounded-lg px-1.5 py-1 text-[10px] leading-tight ${
                              item.source.includes('transaction')
                                ? 'bg-blue-50 text-blue-700'
                                : item.source === 'appointment'
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : item.source === 'maintenance_request'
                                    ? 'bg-amber-50 text-amber-700'
                                    : 'bg-violet-50 text-violet-700'
                            }`}
                          >
                            <div className="font-semibold truncate">{item.title}</div>
                            <div className="truncate opacity-70">{item.propertyAddress || item.category}</div>
                          </div>
                        ))}
                        {dayItems.length > 3 && (
                          <div className="px-1 text-[10px] font-medium text-slate-400">+{dayItems.length - 3} more</div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Add Manual + Upcoming (side by side) ── */}
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <div className={`${solidPanel} p-5`}>
          <div className="mb-3">
            <div className="text-base font-semibold text-slate-900">Add Manual Item</div>
            <div className="text-xs text-slate-500">Create recurring upkeep and replacement reminders.</div>
          </div>
          <form className="space-y-3" onSubmit={handleManualSubmit}>
            <input
              value={form.title}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              placeholder="Replace under-sink water filter"
              className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none"
              required
            />
            <div className="grid gap-3 md:grid-cols-2">
              <select
                value={form.propertyId}
                onChange={(event) => setForm((current) => ({ ...current, propertyId: event.target.value }))}
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 focus:border-violet-400 focus:outline-none"
              >
                {properties.map((property) => (
                  <option key={property.id} value={property.id}>{property.address}</option>
                ))}
              </select>
              <select
                value={form.category}
                onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 focus:border-violet-400 focus:outline-none"
              >
                <option value="filter">Filter replacement</option>
                <option value="hvac">HVAC service</option>
                <option value="winterization">Winterization</option>
                <option value="roof">Roof maintenance</option>
                <option value="exterior">Exterior upkeep</option>
                <option value="safety">Safety devices</option>
                <option value="general">General upkeep</option>
              </select>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <input
                type="date"
                value={form.installedAt}
                onChange={(event) => setForm((current) => ({ ...current, installedAt: event.target.value }))}
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 focus:border-violet-400 focus:outline-none"
              />
              <input
                type="number"
                min="30"
                step="1"
                value={form.cadenceDays}
                onChange={(event) => setForm((current) => ({ ...current, cadenceDays: event.target.value }))}
                placeholder="Cadence in days"
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none"
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <input
                value={form.productName}
                onChange={(event) => setForm((current) => ({ ...current, productName: event.target.value }))}
                placeholder="Product name"
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none"
              />
              <input
                value={form.modelNumber}
                onChange={(event) => setForm((current) => ({ ...current, modelNumber: event.target.value }))}
                placeholder="Exact model number"
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none"
              />
            </div>
            <textarea
              value={form.notes}
              onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
              placeholder="Notes, install details, or preferred vendor"
              rows={2}
              className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Add Maintenance Item'}
              </button>
              {(form.productName || form.modelNumber) && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => handleResearch({
                    id: 'manual-draft',
                    propertyId: form.propertyId,
                    propertyAddress: propertyLookup.get(form.propertyId) || '',
                    title: form.title || form.productName || 'Scheduled replacement',
                    category: form.category,
                    source: 'manual',
                    productName: form.productName,
                    modelNumber: form.modelNumber,
                    installedAt: form.installedAt,
                    notes: form.notes,
                  })}
                  className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  Use AI Replacement Interval
                </button>
              )}
            </div>
          </form>
        </div>

        <div className={`${solidPanel} p-5`}>
          <div className="text-base font-semibold text-slate-900">Upcoming Focus</div>
          <div className="mt-3 space-y-2">
            {upcomingItems.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 px-4 py-4 text-xs text-slate-400 text-center">
                No upcoming maintenance actions on the calendar yet.
              </div>
            )}
            {upcomingItems.map((item) => (
              <div key={item.id} className={`${insetPanel} p-3`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-800">{item.title}</div>
                    <div className="mt-0.5 text-[10px] text-slate-500">{item.propertyAddress || item.description || item.category}</div>
                    <div className="mt-1 text-[10px] text-slate-400">Due {formatShortDate(item.dueDate)}</div>
                  </div>
                  {item.source === 'manual' && (
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="rounded-lg border border-rose-200 px-2 py-1 text-[10px] font-semibold text-rose-600 hover:bg-rose-50"
                    >
                      Delete
                    </button>
                  )}
                </div>
                {item.manufacturerGuidance?.intervalText && (
                  <div className="mt-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[10px] text-slate-600">
                    {item.manufacturerGuidance.intervalText}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Transaction Opportunities + Scheduled Workstream ── */}
      <div className="grid gap-5 xl:grid-cols-2">
        <div className={`${solidPanel} p-5`}>
          <div className="mb-3">
            <div className="text-base font-semibold text-slate-900">Transaction-Derived Opportunities</div>
            <div className="text-xs text-slate-500">Detected from bookkeeping descriptions and maintenance-related spending.</div>
          </div>
          <div className="space-y-2">
            {transactionCandidates.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 px-4 py-4 text-xs text-slate-400 text-center">
                Connect bookkeeping activity or add maintenance transactions to derive replacement cycles automatically.
              </div>
            )}
            {transactionCandidates.map((item) => (
              <div key={item.id} className={`${insetPanel} p-3`}>
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="text-xs font-semibold text-slate-800">{item.title}</div>
                    <div className="mt-0.5 text-[10px] text-slate-500">{item.description}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">Installed {formatShortDate(item.installedAt)}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">Next due {formatShortDate(item.dueDate)}</span>
                      {item.modelNumber && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">Model {item.modelNumber}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => handleResearch(item)}
                    disabled={researchingId === item.id}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                  >
                    {researchingId === item.id ? 'Researching...' : 'Use AI Interval'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={`${solidPanel} p-5`}>
          <div className="mb-3">
            <div className="text-base font-semibold text-slate-900">Scheduled Workstream</div>
            <div className="text-xs text-slate-500">Open repair requests and confirmed service visits.</div>
          </div>
          <div className="space-y-2">
            {[...derivedFromAppointments.slice(0, 4), ...derivedFromRequests.slice(0, 4)].map((item) => (
              <div key={item.id} className={`${insetPanel} p-3`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-800">{item.title}</div>
                    <div className="mt-0.5 text-[10px] text-slate-500">{item.propertyAddress || item.description}</div>
                    <div className="mt-1 text-[10px] text-slate-400">{formatShortDate(item.dueDate)}</div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${item.source === 'appointment' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                    {item.source === 'appointment' ? 'Visit' : 'Request'}
                  </span>
                </div>
              </div>
            ))}
            {derivedFromAppointments.length === 0 && derivedFromRequests.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 px-4 py-4 text-xs text-slate-400 text-center">
                No scheduled visits or maintenance requests are available.
              </div>
            )}
          </div>
        </div>
      </div>

      {loading && (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          Loading maintenance planner data...
        </div>
      )}
    </div>
  );
}
