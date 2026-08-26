/**
 * Play the next day's weather and flood response through the twin, hour by hour.
 *
 * The rest of the flood UI asks the user to imagine a design storm. This asks
 * nothing: it takes the actual forecast, runs each hour through the depth
 * model, and lets them watch water arrive and drain.
 *
 * The layout owes its shape to weather apps rather than to dashboards, and for
 * a reason. An hourly strip you can drag puts the whole day in one glance and
 * makes "when" a spatial question, which a chart with a play button does not.
 * The panel is dark because the precipitation ramp is built for a dark ground —
 * on white, light rain and no rain are nearly the same colour.
 *
 * Two quantities are deliberately drawn together on the strip: the bars are the
 * forecast rain in each hour, and the line is the modelled flood response. The
 * gap between them is the point. Water keeps rising after the rain stops, and
 * that lag is the thing people get wrong when they look at a forecast alone.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pause, Play, RotateCcw, Wind } from 'lucide-react';
import type { FloodForecast, ForecastStep, HourConditions } from '../../hooks/useFloodForecast';
import type { ForecastTrackKind } from './hazardScenario';
import { PRECIP_LEGEND, describeIntensity, paintRadar } from '../../utils/weatherRaster';

export interface StormTimelineProps {
  forecast: FloodForecast | null;
  loading: boolean;
  error: string | null;
  track: ForecastTrackKind;
  onTrackChange: (track: ForecastTrackKind) => void;
  index: number;
  onIndexChange: (index: number) => void;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  /** Leave playback and go back to live conditions. */
  onExit: () => void;
}

/** Milliseconds of wall clock per forecast hour. */
const STEP_MS = 620;

const hourLabel = (ts: number) => new Date(ts)
  .toLocaleTimeString(undefined, { hour: 'numeric' })
  .replace(' ', '');

const dayLabel = (ts: number) => new Date(ts).toLocaleDateString(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

const money = (v: number) => `$${Math.round(v).toLocaleString()}`;

/* ── condition glyphs ─────────────────────────────────────────────
   Drawn rather than imported: the icon set in use here has no weather
   family, and a handful of primitives is smaller than a dependency. */

function WeatherGlyph({ icon, isDay, size = 30 }: { icon: string; isDay: boolean; size?: number }) {
  const cloud = (fill: string, opacity = 1) => (
    <path
      d="M9.5 22h11a4.5 4.5 0 0 0 .4-9 6.5 6.5 0 0 0-12.3-1.6A4.7 4.7 0 0 0 9.5 22Z"
      fill={fill}
      opacity={opacity}
    />
  );
  const drops = (color: string, n: number) => (
    <g stroke={color} strokeWidth={1.8} strokeLinecap="round">
      {Array.from({ length: n }, (_, i) => (
        <line key={i} x1={11 + i * 4} y1={24} x2={9.5 + i * 4} y2={28} />
      ))}
    </g>
  );

  return (
    <svg width={size} height={size} viewBox="0 0 30 30">
      {(icon === 'clear' || icon === 'partly') && (
        <g>
          <circle
            cx={icon === 'partly' ? 11 : 15}
            cy={icon === 'partly' ? 11 : 15}
            r={icon === 'partly' ? 5.5 : 7}
            fill={isDay ? '#fbbf24' : '#e2e8f0'}
          />
          {isDay && icon === 'clear' && (
            <g stroke="#fbbf24" strokeWidth={1.8} strokeLinecap="round">
              {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
                const r = (a * Math.PI) / 180;
                return (
                  <line
                    key={a}
                    x1={15 + Math.cos(r) * 9.5}
                    y1={15 + Math.sin(r) * 9.5}
                    x2={15 + Math.cos(r) * 12.5}
                    y2={15 + Math.sin(r) * 12.5}
                  />
                );
              })}
            </g>
          )}
        </g>
      )}
      {icon === 'partly' && cloud('#cbd5e1')}
      {(icon === 'cloudy' || icon === 'fog') && cloud('#cbd5e1')}
      {icon === 'fog' && (
        <g stroke="#94a3b8" strokeWidth={1.8} strokeLinecap="round">
          <line x1={8} y1={25} x2={22} y2={25} />
          <line x1={10} y1={28} x2={20} y2={28} />
        </g>
      )}
      {(icon === 'drizzle' || icon === 'rain' || icon === 'showers') && (
        <>
          {cloud('#94a3b8')}
          {drops('#60a5fa', icon === 'drizzle' ? 2 : 3)}
        </>
      )}
      {(icon === 'snow' || icon === 'sleet') && (
        <>
          {cloud('#94a3b8')}
          <g stroke="#bae6fd" strokeWidth={1.8} strokeLinecap="round">
            <line x1={12} y1={25} x2={12} y2={28} />
            <line x1={18} y1={25} x2={18} y2={28} />
          </g>
        </>
      )}
      {icon === 'storm' && (
        <>
          {cloud('#64748b')}
          <path d="M16 22l-4 5h3l-1.5 4 5.5-6h-3l2-3Z" fill="#fbbf24" />
        </>
      )}
    </svg>
  );
}

/* ── regional radar thumbnail ─────────────────────────────────────
   The flood map underneath is a couple of kilometres across; weather
   happens on a scale two orders of magnitude larger. Showing the region
   alongside is what makes "a band is arriving from the south-west" a
   thing you can see rather than infer from a number ticking up. */

function RadarThumb({
  forecast,
  index,
  size = 132,
}: { forecast: FloodForecast; index: number; size?: number }) {
  const weather = forecast.weather;

  const url = useMemo(() => {
    const step = weather?.steps[index];
    if (!step || typeof document === 'undefined') return null;
    return paintRadar(step.precipMmH, {
      rows: weather!.grid.rows,
      cols: weather!.grid.cols,
      cloudPct: step.cloudPct,
      width: 180,
      height: 180,
    });
  }, [weather, index]);

  if (!weather) return null;

  const span = Math.round((weather.grid.bounds.north - weather.grid.bounds.south) * 111);

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-lg border border-white/10 bg-slate-800"
      style={{ width: size, height: size }}
    >
      {url ? (
        <img src={url} alt="" className="absolute inset-0 h-full w-full" />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-[9px] text-slate-500">
          Clear skies
        </div>
      )}
      {/* Range rings, so the thumbnail has a sense of scale without a basemap. */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <circle cx={50} cy={50} r={16} fill="none" stroke="#fff" strokeOpacity={0.13} strokeWidth={0.6} />
        <circle cx={50} cy={50} r={33} fill="none" stroke="#fff" strokeOpacity={0.1} strokeWidth={0.6} />
        <circle cx={50} cy={50} r={3} fill="#fff" />
        <circle cx={50} cy={50} r={5.5} fill="none" stroke="#fff" strokeOpacity={0.6} strokeWidth={0.9} />
      </svg>
      <div className="absolute bottom-0.5 left-1 text-[8.5px] font-semibold text-white/50">
        {span} km
      </div>
    </div>
  );
}

/* ── component ────────────────────────────────────────────────────── */

export const StormTimeline: React.FC<StormTimelineProps> = ({
  forecast,
  loading,
  error,
  track,
  onTrackChange,
  index,
  onIndexChange,
  playing,
  onPlayingChange,
  onExit,
}) => {
  const rainfall = forecast?.rainfall ?? null;
  const surge = forecast?.surge ?? null;
  const active = track === 'surge' ? surge : rainfall;
  const steps: ForecastStep[] = active?.steps ?? [];
  const safeIndex = Math.min(index, Math.max(0, steps.length - 1));
  const step = steps[safeIndex] ?? null;
  const conditions: HourConditions[] = forecast?.weather?.conditions ?? [];
  const now: HourConditions | null = conditions[safeIndex] ?? null;

  /* ── playback clock ── */

  const onIndexRef = useRef(onIndexChange);
  onIndexRef.current = onIndexChange;

  useEffect(() => {
    if (!playing || steps.length === 0) return undefined;
    const timer = window.setInterval(() => {
      onIndexRef.current(index + 1 >= steps.length ? 0 : index + 1);
    }, STEP_MS);
    return () => window.clearInterval(timer);
    // `index` is intentionally a dependency: restarting the interval each tick
    // keeps the step cadence honest even when a frame is slow to paint.
  }, [playing, index, steps.length]);

  // Switching tracks mid-play would otherwise land on an index the new track
  // may not have.
  useEffect(() => {
    if (index >= steps.length && steps.length > 0) onIndexRef.current(0);
  }, [track, steps.length, index]);

  /* ── strip geometry ── */

  const strip = useMemo(() => {
    if (steps.length === 0) return null;

    const peakPrecip = Math.max(
      0.02,
      ...conditions.map((c) => c.precipIn),
      ...steps.map((s) => s.rainIn ?? 0),
    );

    const responses = track === 'surge'
      ? steps.map((s) => s.aboveMhhwFt ?? 0)
      : steps.map((s) => s.effectiveIn ?? 0);
    const lo = Math.min(...responses);
    const hi = Math.max(...responses, lo + 0.01);

    return {
      peakPrecip,
      // 0 at the bottom of the strip, 1 at the top.
      responseAt: (i: number) => (responses[i] - lo) / (hi - lo),
      precipAt: (i: number) => (conditions[i]?.precipIn ?? steps[i]?.rainIn ?? 0) / peakPrecip,
    };
  }, [steps, conditions, track]);

  const scrubRef = useRef<HTMLDivElement | null>(null);
  const scrubTo = useCallback((clientX: number) => {
    const el = scrubRef.current;
    if (!el || steps.length === 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    onIndexChange(Math.max(0, Math.min(steps.length - 1, Math.round(ratio * (steps.length - 1)))));
  }, [steps.length, onIndexChange]);

  /* ── render ── */

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-[12px] text-slate-500">
        Building the next 24 hours from the forecast…
      </div>
    );
  }

  if (error || !forecast) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-[12px] text-slate-500">
        <span>Hourly forecast unavailable{error ? ` — ${error}` : ''}.</span>
        <button type="button" onClick={onExit} className="font-bold text-blue-600 hover:underline">
          Back to live
        </button>
      </div>
    );
  }

  const noRain = track === 'rainfall' && (rainfall?.totalInchesForecast ?? 0) <= 0.01;
  const peakCellMmH = forecast.weather
    ? Math.max(...forecast.weather.steps.flatMap((s) => s.precipMmH))
    : 0;

  return (
    <div className="overflow-hidden rounded-xl bg-slate-900 text-slate-100 shadow-lg ring-1 ring-slate-900/10">
      {/* ── transport ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <button
          type="button"
          onClick={() => onPlayingChange(!playing)}
          disabled={steps.length === 0}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 disabled:opacity-40"
          aria-label={playing ? 'Pause storm playback' : 'Play storm playback'}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => { onIndexChange(0); onPlayingChange(false); }}
          className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Restart playback"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>

        <div className="leading-tight">
          <div className="text-[12px] font-bold">Forecast</div>
          {step && <div className="text-[10px] text-slate-400">{dayLabel(step.timestamp)}</div>}
        </div>

        <div className="ml-auto flex items-center gap-1">
          {rainfall && (
            <button
              type="button"
              onClick={() => onTrackChange('rainfall')}
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
                track === 'rainfall' ? 'bg-white text-slate-900' : 'text-slate-400 hover:bg-white/10'
              }`}
            >
              Rainfall
            </button>
          )}
          {surge && (
            <button
              type="button"
              onClick={() => onTrackChange('surge')}
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
                track === 'surge' ? 'bg-white text-slate-900' : 'text-slate-400 hover:bg-white/10'
              }`}
            >
              Cat {surge.category} surge
            </button>
          )}
          <button
            type="button"
            onClick={onExit}
            className="ml-1 rounded-full px-2.5 py-1 text-[11px] font-bold text-slate-400 transition-colors hover:bg-white/10"
          >
            Exit
          </button>
        </div>
      </div>

      {/* ── conditions + radar ── */}
      <div className="flex items-start gap-3 px-3 py-2.5">
        {forecast.weather && <RadarThumb forecast={forecast} index={safeIndex} />}

        <div className="min-w-0 flex-1">
          {now ? (
            <div className="flex items-center gap-2.5">
              <WeatherGlyph icon={now.icon} isDay={now.isDay} size={34} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[26px] font-semibold leading-none">{now.tempF}°</span>
                  <span className="truncate text-[12px] font-medium text-slate-300">{now.label}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-slate-400">
                  <span>Feels {now.feelsLikeF}°</span>
                  <span>
                    {now.precipIn > 0 ? `${now.precipIn.toFixed(2)}" rain` : 'No rain'}
                    {now.chancePct != null && ` · ${now.chancePct}%`}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <Wind className="h-3 w-3" />
                    {now.windMph}
                    {now.gustMph > now.windMph + 4 && ` g${now.gustMph}`} mph
                  </span>
                  {now.cloudPct != null && <span>{now.cloudPct}% cloud</span>}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-slate-400">
              {forecast.weatherError
                ? `Conditions unavailable — ${forecast.weatherError}`
                : 'Conditions unavailable for this location.'}
            </div>
          )}

          {/* What the storm is doing to the building, kept beside the weather so
              cause and consequence are read together. */}
          {step && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 pt-2 text-[11px]">
              {track === 'surge' && (
                <span className="text-slate-400">
                  {step.aboveMhhwFt?.toFixed(1)} ft above MHHW
                  <span className="text-slate-500"> (tide {step.tideFt?.toFixed(1)} + surge {step.surgeFt?.toFixed(1)})</span>
                </span>
              )}
              <span className={step.homeDepthFt ? 'font-bold text-rose-300' : 'text-emerald-300'}>
                {step.homeDepthFt
                  ? `${step.homeDepthFt.toFixed(1)} ft of water at the house`
                  : 'Dry at the house'}
              </span>
              {step.damageTotal ? (
                <span className="font-bold text-rose-300">{money(step.damageTotal)} damage</span>
              ) : null}
              {step.wetFraction != null && step.wetFraction > 0 && (
                <span className="text-slate-400">
                  {Math.round(step.wetFraction * 100)}% of the area wet
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── hourly strip ──
          One column per hour, draggable. Bars are forecast rain; the line is
          the modelled flood response, which peaks later than the rain does. */}
      {strip && steps.length > 0 && (
        <div
          className="cursor-pointer touch-none select-none px-3 pb-2"
          onPointerDown={(e) => {
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
            onPlayingChange(false);
            scrubTo(e.clientX);
          }}
          onPointerMove={(e) => { if (e.buttons === 1) scrubTo(e.clientX); }}
        >
          <div ref={scrubRef} className="relative">
          <div className="flex h-[62px] items-end gap-[2px]">
            {steps.map((s, i) => {
              const c = conditions[i];
              const rain = strip.precipAt(i);
              const activeCol = i === safeIndex;
              const mmh = (c?.precipIn ?? s.rainIn ?? 0) * 25.4;
              return (
                <div
                  key={s.timestamp}
                  className={`relative flex flex-1 flex-col items-center justify-end rounded-t transition-colors ${
                    activeCol ? 'bg-white/12' : ''
                  }`}
                  style={{ height: '100%' }}
                >
                  {c && (
                    <span className={`mb-auto pt-0.5 text-[9px] font-semibold ${activeCol ? 'text-white' : 'text-slate-500'}`}>
                      {c.tempF}°
                    </span>
                  )}
                  <div
                    className="w-full rounded-sm"
                    style={{
                      height: `${Math.max(rain > 0 ? 2 : 0, rain * 30)}px`,
                      background: mmh >= 7.6
                        ? 'rgb(219,39,119)'
                        : mmh >= 2.5
                          ? 'rgb(79,70,229)'
                          : 'rgb(56,189,248)',
                      opacity: activeCol ? 1 : 0.75,
                    }}
                  />
                </div>
              );
            })}
          </div>

          {/* Flood response, overlaid across the same hours and sharing their
              horizontal positions so the lag can be read off directly. */}
          <svg
            viewBox={`0 0 ${steps.length} 1`}
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[46px] w-full"
          >
            <polyline
              points={steps.map((_, i) => `${i + 0.5},${0.96 - strip.responseAt(i) * 0.92}`).join(' ')}
              fill="none"
              stroke="#38bdf8"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ strokeWidth: 2 }}
            />
          </svg>

          {/* Playhead, centred on the active column. */}
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-white/70"
            style={{ left: `${((safeIndex + 0.5) / steps.length) * 100}%` }}
          />
          </div>

          {/* Hour ruler. */}
          <div className="mt-1 flex text-[9px] font-semibold text-slate-500">
            {steps.map((s, i) => (
              <span key={s.timestamp} className="flex-1 text-center">
                {i === 0 ? 'Now' : i % 3 === 0 ? hourLabel(s.timestamp) : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── legend + provenance ──
          Which half of this is measurement and which is assumption is not a
          footnote for a storm animation; it is the difference between a
          forecast and a cartoon. */}
      <div className="border-t border-white/10 px-3 py-2 text-[10px] leading-snug text-slate-400">
        {forecast.weather && peakCellMmH > 0.1 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold uppercase tracking-wide text-slate-500">Precipitation</span>
            {PRECIP_LEGEND.map((l) => (
              <span key={l.label} className="flex items-center gap-1">
                <span className="h-2 w-4 rounded-sm" style={{ background: l.color }} />
                {l.label}
              </span>
            ))}
            <span className="text-slate-500">· peak {describeIntensity(peakCellMmH).toLowerCase()} in region</span>
          </div>
        )}

        {noRain && (
          <div className="mb-1 font-semibold text-slate-300">
            No measurable rain in the forecast — the map stays dry through the
            whole window. Use the storm chips above to test a design storm instead.
          </div>
        )}

        {track === 'rainfall' ? (
          <>
            {rainfall?.source}. {rainfall?.totalInchesForecast}&quot; total over{' '}
            {forecast.hours}h. The blue line is the modelled flood response — it
            keeps rising after the rain stops because water takes time to reach
            and leave the drainage lines.
          </>
        ) : (
          <>
            {surge?.basis}
            {surge?.station && (
              <> Datum from {surge.station.name}, {surge.station.distanceKm} km away.</>
            )}
          </>
        )}
        {forecast.weather && <> {forecast.weather.note}</>}
      </div>
    </div>
  );
};

export default StormTimeline;
