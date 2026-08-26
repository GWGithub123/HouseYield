import React, { useEffect, useState } from 'react';
import { Card } from '../design-system';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface FedData {
  success: boolean;
  generatedAt: string;
  latestMeeting: {
    title: string;
    date: string;
    link: string;
    summary: string;
    keyTopics: string[];
    aiSummary?: string | null;
    fullText?: string | null;
    hasFullText?: boolean;
    isStatement?: boolean;
    isMinutes?: boolean;
    publishDelay?: string;
  } | null;
  recentAnnouncements: Array<{
    title: string;
    date: string;
    link: string;
    preview: string;
    type?: string;
  }>;
  economicIndicators: {
    interestRates: {
      federalFundsTarget: number;
      federalFundsEffective: number;
      trend: string;
      date: string;
    };
    inflation: {
      cpi: { current: number; yoy: string; trend: string; date: string; };
      pce: { current: number; yoy: string; trend: string; date: string; };
    };
    employment: {
      unemploymentRate: number;
      trend: string;
      date: string;
    };
    gdp: {
      current: number;
      yoy: string;
      date: string;
    };
    housing: {
      mortgageRate: number;
      housingStarts: number;
      existingHomeSales: number;
    };
  };
  outlook: {
    economy: {
      overall: string;
      growth: string;
      laborMarket: string;
      inflation: string;
    };
    interestRates: {
      currentTarget: string;
      effectiveRate: string;
      trend: string;
      stance: string;
      outlook: string;
      nextMeetingExpectation: string;
    };
    housingMarket: {
      mortgageRate: {
        current: string;
        trend: string;
        impact: string;
      };
      activity: {
        housingStarts: { value: string; trend: string; yoy: string; };
        existingSales: { value: string; trend: string; yoy: string; };
      };
      outlook: string;
      investorImplications: string;
    };
  };
  summary: {
    headline: string;
    keyTakeaway: string;
    housingImpact: string;
    actionableInsight: string;
  };
}

interface FomcMeeting {
  start: string;
  end: string;
  label: string;
}

interface FomcCalendar {
  next: FomcMeeting | null;
  daysUntilNext: number | null;
  minutesReleaseDate: string | null;
  upcoming: FomcMeeting[];
  lastMeeting: FomcMeeting | null;
  source: string;
  note: string;
}

export type FedMeetingSummaryFocusSection =
  | 'executive-update'
  | 'upcoming-fomc-meeting'
  | 'policy-readout'
  | 'economic-outlook'
  | 'interest-rate-outlook'
  | 'housing-market-impact';

interface FedMeetingSummaryProps {
  focusSection?: FedMeetingSummaryFocusSection;
}

const FedMeetingSummary: React.FC<FedMeetingSummaryProps> = ({ focusSection }) => {
  const [fedData, setFedData] = useState<FedData | null>(null);
  const [fomcCalendar, setFomcCalendar] = useState<FomcCalendar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchFedData = async () => {
      try {
        const [summaryRes, calendarRes] = await Promise.all([
          fetch(`${API_BASE}/api/fred/fed-meeting-summary`),
          fetch(`${API_BASE}/api/fred/fomc-calendar`),
        ]);
        const summaryJson = await summaryRes.json();
        const calendarJson = await calendarRes.json();

        if (!summaryJson.ok) {
          throw new Error(summaryJson.error || 'Failed to fetch Fed data');
        }

        setFedData(summaryJson.data);
        if (calendarJson.ok) setFomcCalendar(calendarJson.data);
      } catch (err: any) {
        console.error('Error fetching Fed meeting summary:', err);
        setError(err.message || 'Failed to load Fed data');
      } finally {
        setLoading(false);
      }
    };

    fetchFedData();
  }, []);

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border p-6">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-3/4 mb-4"></div>
          <div className="h-4 bg-gray-200 rounded w-full mb-2"></div>
          <div className="h-4 bg-gray-200 rounded w-5/6"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border p-6">
        <div className="text-rose-600 font-medium mb-2">Fed Data Unavailable</div>
        <p className="text-sm text-gray-600">{error}</p>
      </div>
    );
  }

  if (!fedData) return null;

  const getTrendIcon = (trend: string) => {
    if (trend === 'rising') return '▲';
    if (trend === 'falling') return '▼';
    return '→';
  };

  const getTrendColor = (trend: string) => {
    if (trend === 'rising') return 'text-rose-600';
    if (trend === 'falling') return 'text-emerald-600';
    return 'text-gray-600';
  };

  const headerSection = (
    <div className="border-b border-slate-100 bg-white px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em] text-slate-900">Federal Reserve Update</h2>
          <p className="text-sm text-slate-500">Latest FOMC meeting summary</p>
        </div>
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Live</span>
      </div>
    </div>
  );

  const executiveSummarySection = (
    <div className="p-6 border-b bg-white">
      <div className="text-2xl font-bold mb-3">{fedData.summary.headline}</div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Fed Funds Rate</div>
          <div className="text-2xl font-bold text-blue-600">
            {fedData.outlook.interestRates.currentTarget}
          </div>
          <div className={`text-sm ${getTrendColor(fedData.outlook.interestRates.trend)}`}>
            {getTrendIcon(fedData.outlook.interestRates.trend)} {fedData.outlook.interestRates.trend}
          </div>
        </div>

        <div className="bg-gray-50 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">30Y Mortgage Rate</div>
          <div className="text-2xl font-bold text-indigo-600">
            {fedData.outlook.housingMarket.mortgageRate.current}
          </div>
          <div className={`text-sm ${getTrendColor(fedData.outlook.housingMarket.mortgageRate.trend)}`}>
            {getTrendIcon(fedData.outlook.housingMarket.mortgageRate.trend)} {fedData.outlook.housingMarket.mortgageRate.trend}
          </div>
        </div>

        <div className="bg-gray-50 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">PCE Inflation YoY</div>
          <div className="text-2xl font-bold text-purple-600">
            {fedData.economicIndicators.inflation.pce.yoy}
          </div>
          <div className={`text-sm ${getTrendColor(fedData.economicIndicators.inflation.pce.trend)}`}>
            {getTrendIcon(fedData.economicIndicators.inflation.pce.trend)} {fedData.economicIndicators.inflation.pce.trend}
          </div>
        </div>

        <div className="bg-gray-50 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Unemployment Rate</div>
          <div className="text-2xl font-bold text-emerald-600">
            {fedData.economicIndicators.employment.unemploymentRate != null
              ? `${fedData.economicIndicators.employment.unemploymentRate}%`
              : 'N/A'}
          </div>
          <div className={`text-sm ${getTrendColor(fedData.economicIndicators.employment.trend)}`}>
            {getTrendIcon(fedData.economicIndicators.employment.trend)} {fedData.economicIndicators.employment.trend}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="font-semibold text-slate-900 mb-1">Investor Implications</div>
            <p className="text-sm text-slate-700">{fedData.summary.actionableInsight}</p>
          </div>
        </div>
      </div>
    </div>
  );

  const upcomingMeetingSection = fomcCalendar?.next ? (
    <div className="p-6 border-b bg-white">
      <h3 className="font-bold text-lg mb-4">Upcoming FOMC Meeting</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <div className={`rounded-xl p-4 text-center ${
          (fomcCalendar.daysUntilNext ?? 99) <= 7
            ? 'bg-amber-50 border border-amber-200'
            : 'bg-blue-50 border border-blue-200'
        }`}>
          <div className="text-xs font-medium text-gray-500 mb-1 uppercase tracking-wide">Days Until Meeting</div>
          <div className={`text-4xl font-extrabold ${
            (fomcCalendar.daysUntilNext ?? 99) <= 7 ? 'text-amber-600' : 'text-blue-700'
          }`}>
            {fomcCalendar.daysUntilNext !== null && fomcCalendar.daysUntilNext >= 0
              ? fomcCalendar.daysUntilNext
              : 'Today'}
          </div>
          <div className="text-sm text-gray-600 mt-1">{fomcCalendar.next.label}</div>
        </div>

        <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
          <div className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">Meeting Dates</div>
          <div className="font-semibold text-gray-900 text-base">
            {new Date(fomcCalendar.next.start + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
            {' – '}
            {new Date(fomcCalendar.next.end + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </div>
          <div className="text-xs text-gray-500 mt-2">Statement released on final day ~2 PM ET</div>
          {fomcCalendar.minutesReleaseDate && (
            <div className="text-xs text-gray-500 mt-1">
              Minutes expected: {new Date(fomcCalendar.minutesReleaseDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </div>
          )}
        </div>

        <div className="bg-indigo-50 rounded-xl p-4 border border-indigo-200">
          <div className="text-xs font-medium text-indigo-500 mb-2 uppercase tracking-wide">Market Expectation</div>
          <div className="text-sm font-semibold text-indigo-900 mb-1">
            {fedData.outlook.interestRates.trend === 'rising'
              ? 'Rate Increase Likely'
              : fedData.outlook.interestRates.trend === 'falling'
              ? 'Rate Cut Expected'
              : 'Hold Rates Steady'}
          </div>
          <p className="text-xs text-indigo-800 leading-relaxed">
            {fedData.outlook.interestRates.nextMeetingExpectation}
          </p>
        </div>
      </div>

      {fomcCalendar.upcoming.length > 1 && (
        <div>
          <div className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">Full 2026 Schedule</div>
          <div className="flex flex-wrap gap-2">
            {fomcCalendar.upcoming.map((m, i) => (
              <span
                key={m.start}
                className={`text-xs px-3 py-1.5 rounded-full font-medium border ${
                  i === 0
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300'
                }`}
              >
                {m.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  ) : null;

  const policyReadoutSection = fedData.latestMeeting ? (
    <div className="p-5 border-b bg-white">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-base text-slate-900">Policy readout</h3>
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Source docs</span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="font-semibold text-gray-900 mb-2">{fedData.latestMeeting.title}</div>
        <div className="text-sm text-gray-600 mb-3">
          Published: {new Date(fedData.latestMeeting.date.replace(/\<\!\[CDATA\[|\]\]\>/g, '')).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          })}
        </div>

        {fedData.latestMeeting.publishDelay && (
          <div className="mb-3">
            <span className={`text-xs px-3 py-1 rounded-full font-medium ${
              fedData.latestMeeting.isStatement
                ? 'bg-green-100 text-green-700'
                : 'bg-amber-100 text-amber-700'
            }`}>
              {fedData.latestMeeting.isStatement ? 'Policy Statement' : 'Meeting Minutes'}
              {' • '}
              {fedData.latestMeeting.publishDelay}
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-3">
          {fedData.latestMeeting.keyTopics.map((topic, i) => (
            <span key={i} className="bg-slate-100 text-slate-700 text-xs px-3 py-1 rounded-full">
              {topic}
            </span>
          ))}
        </div>

        {(fedData.latestMeeting.aiSummary || fedData.latestMeeting.fullText) && (
          <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3">
            <div className="text-xs font-semibold text-gray-700 mb-2">
              {fedData.latestMeeting.aiSummary ? 'Meeting takeaways' : 'Statement Excerpt'}
            </div>
            <div className="text-xs text-gray-600 leading-relaxed whitespace-pre-line">
              {fedData.latestMeeting.aiSummary
                || `${fedData.latestMeeting.fullText!.substring(0, 400)}...`}
            </div>
          </div>
        )}

        <a
          href={fedData.latestMeeting.link.replace(/\<\!\[CDATA\[|\]\]\>/g, '')}
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-700 hover:text-slate-900 text-sm font-medium inline-flex items-center gap-1"
        >
          Read full official statement →
        </a>
      </div>
    </div>
  ) : null;

  const economicOutlookSection = (
    <div className="p-6 border-b bg-white">
      <h3 className="font-bold text-lg mb-3">Economic Outlook</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm font-medium text-gray-700">Overall Economy</div>
          </div>
          <div className="text-2xl font-bold text-blue-700 mb-0.5">
            {fedData.economicIndicators.interestRates.federalFundsTarget != null
              ? `${fedData.economicIndicators.interestRates.federalFundsTarget.toFixed(2)}%`
              : 'N/A'}
          </div>
          <div className="text-xs text-gray-500 mb-2">
            Fed Funds Target · effective {fedData.economicIndicators.interestRates.federalFundsEffective != null
              ? `${fedData.economicIndicators.interestRates.federalFundsEffective.toFixed(2)}%`
              : 'N/A'}
          </div>
          <p className="text-xs text-gray-600 leading-snug">{fedData.outlook.economy.overall}</p>
        </div>

        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm font-medium text-gray-700">Labor Market</div>
          </div>
          <div className={`text-2xl font-bold mb-0.5 ${
            fedData.economicIndicators.employment.unemploymentRate != null && fedData.economicIndicators.employment.unemploymentRate <= 4
              ? 'text-emerald-600' : 'text-amber-600'
          }`}>
            {fedData.economicIndicators.employment.unemploymentRate != null
              ? `${fedData.economicIndicators.employment.unemploymentRate.toFixed(1)}%`
              : 'N/A'}
          </div>
          <div className="text-xs text-gray-500 mb-2">
            Unemployment rate · {getTrendIcon(fedData.economicIndicators.employment.trend)}{' '}
            {fedData.economicIndicators.employment.trend}
            {fedData.economicIndicators.employment.date
              ? ` · as of ${fedData.economicIndicators.employment.date}`
              : ''}
          </div>
          <p className="text-xs text-gray-600 leading-snug">{fedData.outlook.economy.laborMarket}</p>
        </div>

        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm font-medium text-gray-700">Growth</div>
          </div>
          <div className={`text-2xl font-bold mb-0.5 ${
            fedData.economicIndicators.gdp?.yoy != null &&
            !isNaN(parseFloat(fedData.economicIndicators.gdp.yoy)) &&
            parseFloat(fedData.economicIndicators.gdp.yoy) >= 2
              ? 'text-emerald-600'
              : parseFloat(fedData.economicIndicators.gdp?.yoy ?? 'NaN') < 0
              ? 'text-rose-600'
              : 'text-amber-600'
          }`}>
            {fedData.economicIndicators.gdp?.yoy
              ? `${parseFloat(fedData.economicIndicators.gdp.yoy) >= 0 ? '+' : ''}${fedData.economicIndicators.gdp.yoy}`
              : 'N/A'}
          </div>
          <div className="text-xs text-gray-500 mb-2">
            GDP YoY
            {fedData.economicIndicators.gdp?.current
              ? ` · $${(fedData.economicIndicators.gdp.current / 1000).toFixed(1)}T`
              : ''}
            {fedData.economicIndicators.gdp?.date ? ` · ${fedData.economicIndicators.gdp.date}` : ''}
          </div>
          <p className="text-xs text-gray-600 leading-snug">{fedData.outlook.economy.growth}</p>
        </div>

        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm font-medium text-gray-700">Inflation</div>
          </div>
          <div className={`text-2xl font-bold mb-0.5 ${
            fedData.economicIndicators.inflation.cpi.yoy &&
            parseFloat(fedData.economicIndicators.inflation.cpi.yoy) <= 3
              ? 'text-emerald-600'
              : parseFloat(fedData.economicIndicators.inflation.cpi.yoy ?? '9') <= 5
              ? 'text-amber-600' : 'text-rose-600'
          }`}>
            {fedData.economicIndicators.inflation.cpi.yoy
              ? `${fedData.economicIndicators.inflation.cpi.yoy} CPI`
              : 'N/A'}
          </div>
          <div className="text-xs text-gray-500 mb-1">
            PCE: {fedData.economicIndicators.inflation.pce.yoy ?? 'N/A'} · Fed target: 2%
          </div>
          <div className="text-xs text-gray-500 mb-2">
            {getTrendIcon(fedData.economicIndicators.inflation.cpi.trend)}{' '}
            {fedData.economicIndicators.inflation.cpi.trend}
            {fedData.economicIndicators.inflation.cpi.date ? ` · ${fedData.economicIndicators.inflation.cpi.date}` : ''}
          </div>
          <p className="text-xs text-gray-600 leading-snug">{fedData.outlook.economy.inflation}</p>
        </div>
      </div>
    </div>
  );

  const interestRateOutlookSection = (
    <div>
      <h3 className="font-bold text-base mb-3">Interest Rate Outlook</h3>
      <div className="space-y-3">
        <div className="bg-blue-50 rounded-lg p-4">
          <div className="text-sm font-medium text-blue-900 mb-1">Fed Stance</div>
          <p className="text-blue-800">{fedData.outlook.interestRates.stance}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="text-sm font-medium text-gray-700 mb-1">Outlook</div>
          <p className="text-gray-900">{fedData.outlook.interestRates.outlook}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="text-sm font-medium text-gray-700 mb-1">Next Meeting Expectation</div>
          <p className="text-gray-900">{fedData.outlook.interestRates.nextMeetingExpectation}</p>
        </div>
      </div>
    </div>
  );

  const housingMarketImpactSection = (
    <div>
      <h3 className="font-bold text-base mb-3">Housing Market Impact</h3>
      <div className="space-y-3">
        <div className="bg-amber-50 rounded-lg p-4">
          <div className="text-sm font-medium text-amber-900 mb-1">Market Impact</div>
          <p className="text-amber-800">{fedData.outlook.housingMarket.mortgageRate.impact}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="text-sm font-medium text-gray-700 mb-1">Housing Activity</div>
          <div className="grid grid-cols-2 gap-4 mt-2">
            <div>
              <div className="text-xs text-gray-500">Housing Starts</div>
              <div className="font-semibold">{fedData.outlook.housingMarket.activity.housingStarts.value}</div>
              <div className="text-xs text-gray-600">YoY: {fedData.outlook.housingMarket.activity.housingStarts.yoy}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Existing Sales</div>
              <div className="font-semibold">{fedData.outlook.housingMarket.activity.existingSales.value}</div>
              <div className="text-xs text-gray-600">YoY: {fedData.outlook.housingMarket.activity.existingSales.yoy}</div>
            </div>
          </div>
        </div>
        <div className="bg-green-50 rounded-lg p-4">
          <div className="text-sm font-medium text-green-900 mb-1">Market Outlook</div>
          <p className="text-green-800">{fedData.outlook.housingMarket.outlook}</p>
        </div>
      </div>
    </div>
  );

  const dualOutlookSection = (
    <div className="p-6 bg-white">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {interestRateOutlookSection}
        {housingMarketImpactSection}
      </div>
    </div>
  );

  if (focusSection === 'executive-update') {
    return (
      <Card surface="light" flushBody className="overflow-hidden">
        {headerSection}
        {executiveSummarySection}
      </Card>
    );
  }

  if (focusSection === 'upcoming-fomc-meeting') return upcomingMeetingSection;
  if (focusSection === 'policy-readout') return policyReadoutSection;
  if (focusSection === 'economic-outlook') return economicOutlookSection;
  if (focusSection === 'interest-rate-outlook') return interestRateOutlookSection;
  if (focusSection === 'housing-market-impact') return housingMarketImpactSection;

  return (
    <Card surface="light" flushBody className="overflow-hidden">
      {headerSection}
      {executiveSummarySection}
      {upcomingMeetingSection}
      {policyReadoutSection}
      {economicOutlookSection}
      {dualOutlookSection}

      <div className="bg-slate-50 px-5 py-3 text-xs text-slate-500 flex items-center justify-between">
        <span>Data from Federal Reserve & FRED API</span>
        <span>Updated: {new Date(fedData.generatedAt).toLocaleString()}</span>
      </div>
    </Card>
  );
};

export default FedMeetingSummary;
