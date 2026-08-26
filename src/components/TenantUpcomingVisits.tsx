import { useCallback, useEffect, useState } from 'react';

interface ScheduledVisit {
  confirmed?: boolean;
  startAt: string;
  endAt?: string;
  timezone?: string;
  providerName?: string;
  summary?: string;
  googleCalendarUrl?: string;
}

interface UpcomingVisit {
  requestId: string;
  category?: string;
  description?: string;
  propertyAddress?: string;
  unit?: string;
  status?: string;
  providerName?: string | null;
  scheduledVisit: ScheduledVisit;
}

interface TenantUpcomingVisitsProps {
  tenantId: string;
  refreshKey?: number;
}

function formatVisitWindow(visit: ScheduledVisit) {
  const timezone = visit.timezone || 'America/New_York';
  const start = new Date(visit.startAt);
  const end = visit.endAt ? new Date(visit.endAt) : null;

  const startLabel = start.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone
  });

  if (!end || Number.isNaN(end.getTime())) {
    return startLabel;
  }

  const endLabel = end.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone
  });

  return `${startLabel} – ${endLabel}`;
}

export default function TenantUpcomingVisits({ tenantId, refreshKey = 0 }: TenantUpcomingVisitsProps) {
  const [visits, setVisits] = useState<UpcomingVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadVisits = useCallback(async () => {
    if (!tenantId) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/tenant/${tenantId}/upcoming-visits`);
      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to load upcoming visits');
      }

      setVisits(Array.isArray(data.visits) ? data.visits : []);
    } catch (err: any) {
      setError(err.message || 'Failed to load upcoming visits');
      setVisits([]);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    loadVisits();
    const interval = setInterval(loadVisits, 30000);
    return () => clearInterval(interval);
  }, [loadVisits, refreshKey]);

  if (loading) {
    return (
      <div className="mb-8 rounded-xl border border-purple-100 bg-purple-50/40 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Upcoming Visits</h3>
        <p className="text-sm text-gray-600">Loading scheduled maintenance visits…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-8 rounded-xl border border-red-100 bg-red-50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Upcoming Visits</h3>
        <p className="text-sm text-red-700">{error}</p>
      </div>
    );
  }

  if (visits.length === 0) {
    return (
      <div className="mb-8 rounded-xl border border-gray-200 bg-gray-50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Upcoming Visits</h3>
        <p className="text-sm text-gray-600">
          No confirmed maintenance visits yet. When a provider visit is scheduled, it will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Upcoming Visits</h3>
        <span className="text-xs font-medium uppercase tracking-wide text-purple-700 bg-purple-100 px-2 py-1 rounded-full">
          {visits.length} scheduled
        </span>
      </div>

      <div className="space-y-4">
        {visits.map((visit) => {
          const address = visit.unit
            ? `${visit.propertyAddress} (${visit.unit})`
            : visit.propertyAddress;
          const provider = visit.providerName || visit.scheduledVisit.providerName || 'Service provider';
          const calendarUrl = visit.scheduledVisit.googleCalendarUrl;

          return (
            <div
              key={visit.requestId}
              className="rounded-xl border border-purple-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-sm font-medium text-purple-700 uppercase tracking-wide">
                    {visit.category || 'Maintenance'}
                  </div>
                  <div className="text-lg font-semibold text-gray-900 mt-1">
                    {formatVisitWindow(visit.scheduledVisit)}
                  </div>
                  <div className="text-sm text-gray-600 mt-2">
                    <span className="font-medium text-gray-800">Provider:</span> {provider}
                  </div>
                  {address && (
                    <div className="text-sm text-gray-600 mt-1">
                      <span className="font-medium text-gray-800">Location:</span> {address}
                    </div>
                  )}
                  {(visit.scheduledVisit.summary || visit.description) && (
                    <div className="text-sm text-gray-600 mt-2">
                      {visit.scheduledVisit.summary || visit.description}
                    </div>
                  )}
                </div>

                {calendarUrl && (
                  <a
                    href={calendarUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 transition-colors shrink-0"
                  >
                    Add to Calendar
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
