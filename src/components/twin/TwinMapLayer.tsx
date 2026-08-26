/**
 * The two map-based rungs of the zoom ladder: lot and neighbourhood.
 *
 * Both are the same machine at different focal lengths — satellite base, flood
 * depth raster, the property pinned at centre — so they share one component
 * rather than two near-copies that drift apart. The `scale` prop decides zoom,
 * which overlays appear, and how the caption reads.
 *
 * Lot adds the parcel boundary and the flow field, because "which way does water
 * cross my yard" only means something at that range. Neighbourhood drops both:
 * 350-odd arrows at that zoom is noise, and the raster already answers the
 * question the wider view is asking, which is where water collects.
 */
import React, { useEffect, useRef, useState } from 'react';
import { loadGoogleMaps } from '../../utils/googleMaps';
import { paintDepthRaster, tierSwatch } from '../../utils/floodDepthRaster';
import { paintRadar } from '../../utils/weatherRaster';
import { animateFlowLines, dischargeFactor, drawChannel, type AnimatedLine } from '../../utils/flowLines';
import { DEPTH_TIERS } from '../../design-system/riskPalette';
import type { FloodDepthGrid } from '../../hooks/useFloodDepthGrid';
import type { ParcelGeometry } from '../../types/attom';
import { type HazardScenario, bearingToCompass } from './hazardScenario';

export interface TwinMapLayerProps {
  scale: 'lot' | 'neighborhood';
  latitude: number;
  longitude: number;
  address?: string;
  grid: FloodDepthGrid | null;
  /**
   * A separate, finer analysis used for lot-scale flow. The neighbourhood grid
   * samples too coarsely over too wide a window to say anything about a single
   * parcel — tracing its flow at lot zoom just redraws neighbourhood drainage.
   */
  lotGrid?: FloodDepthGrid | null;
  hazard: HazardScenario;
  /**
   * Regional precipitation and cloud for the hour being played, if any. Drawn
   * over a much wider footprint than the flood raster because that is the scale
   * weather actually happens on — at neighbourhood zoom it reads as the sky
   * overhead changing rather than as a radar picture, which is the honest way
   * to show an 8 km model cell.
   */
  weatherFrame?: {
    precipMmH: number[];
    cloudPct: number[];
    rows: number;
    cols: number;
    bounds: { north: number; south: number; east: number; west: number };
  } | null;
  /** True while the flood grid request is in flight. */
  floodLoading?: boolean;
  /** Why the flood grid is missing, when it is. */
  floodError?: string | null;
  /** ATTOM id, used to fetch the real parcel outline for the lot view. */
  attomId?: string;
  /**
   * Parcel outline the caller already holds. Supplying it skips the
   * `/api/attom/parcel-geometry` round trip entirely, which matters because a
   * cache miss on that route costs ~19 ATTOM calls against a 1000/month cap.
   * `null` means "known to be unavailable" and also suppresses the fetch;
   * leave it `undefined` to let this component fetch for itself.
   */
  parcelGeometry?: ParcelGeometry | null;
  height?: number;
  /**
   * Move one rung closer. Wired to the property marker and a caption action so
   * the ladder can be climbed by clicking the thing you are looking at, not
   * only by reaching for the tabs.
   */
  onZoomIn?: () => void;
}

/** Zoom per scale. Lot frames a single property; neighbourhood frames the basin. */
const ZOOM: Record<TwinMapLayerProps['scale'], number> = { lot: 19, neighborhood: 16 };

/** The Maps namespace, off `window` since the API is script-loaded. */
const gmapsNS = () => (window as any).google?.maps;

const MAPS_UNAVAILABLE = 'Google Maps loaded but the API is unavailable.';

export const TwinMapLayer: React.FC<TwinMapLayerProps> = ({
  scale,
  latitude,
  longitude,
  address,
  grid,
  lotGrid,
  hazard,
  weatherFrame,
  floodLoading = false,
  floodError = null,
  attomId,
  parcelGeometry,
  height = 460,
  onZoomIn,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Untyped map handles, matching the rest of the codebase: @types/google.maps
  // is not installed and the global `google` is reached off `window`.
  const mapRef = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const radarRef = useRef<any>(null);
  const flowRef = useRef<any[]>([]);
  const parcelRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const stopAnimationRef = useRef<(() => void) | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ── map init ──────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps()
      .then(() => {
        if (cancelled || !containerRef.current) return;

        const gmaps = gmapsNS();
        if (!gmaps) throw new Error(MAPS_UNAVAILABLE);
        mapRef.current = new gmaps.Map(containerRef.current, {
          center: { lat: latitude, lng: longitude },
          zoom: ZOOM[scale],
          mapTypeId: 'satellite',
          tilt: 0,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: 'greedy',
        });
        setReady(true);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });

    return () => { cancelled = true; };
    // Recentre/zoom is handled below; this only builds the map once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the property and the active scale without rebuilding the map.
  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.setCenter({ lat: latitude, lng: longitude });
    mapRef.current.setZoom(ZOOM[scale]);
  }, [latitude, longitude, scale, ready]);

  /* ── property marker ──────────────────────────────────────────── */

  useEffect(() => {
    const gmaps = gmapsNS();
    if (!ready || !mapRef.current || !gmaps) return;
    markerRef.current?.setMap(null);
    markerRef.current = new gmaps.Marker({
      position: { lat: latitude, lng: longitude },
      map: mapRef.current,
      title: onZoomIn
        ? `${address ?? 'Property'} — click to zoom in`
        : address,
      cursor: onZoomIn ? 'pointer' : undefined,
      icon: {
        path: gmaps.SymbolPath.CIRCLE,
        scale: 7,
        fillColor: '#f8fafc',
        fillOpacity: 1,
        strokeColor: '#0f172a',
        strokeWeight: 2.5,
      },
      zIndex: 40,
    });

    if (onZoomIn) markerRef.current.addListener('click', onZoomIn);

    return () => { markerRef.current?.setMap(null); };
  }, [ready, latitude, longitude, address, onZoomIn]);

  /* ── depth raster ─────────────────────────────────────────────── */

  useEffect(() => {
    const gmaps = gmapsNS();
    if (!ready || !mapRef.current || !gmaps) return;

    overlayRef.current?.setMap(null);
    overlayRef.current = null;

    // Dimensions and extent come from the raster itself. A forecast hour and a
    // design storm are analyses over different windows, so borrowing the depth
    // grid's geometry here drew one scenario's water on the other's ground.
    const raster = hazard.raster;
    if (!raster) return;

    const url = paintDepthRaster({
      tiers: raster.tiers,
      samples: raster.samples,
      // Lower on the lot view so the roof and yard stay legible underneath —
      // at that zoom the imagery is the thing being annotated.
      opacity: scale === 'lot' ? 0.5 : 0.72,
    });
    if (!url) return;

    const { north, south, east, west } = raster.bounds;
    overlayRef.current = new gmaps.GroundOverlay(
      url,
      { north, south, east, west },
      { clickable: false, opacity: 1 },
    );
    overlayRef.current.setMap(mapRef.current);

    return () => { overlayRef.current?.setMap(null); };
  }, [ready, hazard.raster, scale]);

  /* ── weather radar ────────────────────────────────────────────────
     Under the depth raster in z-order: the flood is the subject, and rain
     colours would otherwise sit on top of the thing they cause. */

  useEffect(() => {
    const gmaps = gmapsNS();
    if (!ready || !mapRef.current || !gmaps) return;

    radarRef.current?.setMap(null);
    radarRef.current = null;

    if (!weatherFrame) return;

    const url = paintRadar(weatherFrame.precipMmH, {
      rows: weatherFrame.rows,
      cols: weatherFrame.cols,
      cloudPct: weatherFrame.cloudPct,
      width: 256,
      height: 256,
      // Restrained on the map itself; the thumbnail in the timeline is where
      // the field is meant to be read.
      opacity: 0.55,
    });
    if (!url) return;

    radarRef.current = new gmaps.GroundOverlay(url, weatherFrame.bounds, {
      clickable: false,
      opacity: 1,
    });
    radarRef.current.setMap(mapRef.current);

    return () => { radarRef.current?.setMap(null); };
  }, [ready, weatherFrame]);

  /* ── water flow ───────────────────────────────────────────────── */

  /*
   * Both scales draw water the same way, from the same helper — only the source
   * paths and widths differ. Neighbourhood shows traced drainage corridors; the
   * lot shows streamlines crossing the parcel. Every path is Chaikin-smoothed
   * inside `drawChannel`, which is what removes the D8 staircase that made
   * these look like plumbing rather than water.
   */
  useEffect(() => {
    const clear = () => {
      flowRef.current.forEach((p) => p.setMap(null));
      flowRef.current = [];
      stopAnimationRef.current?.();
      stopAnimationRef.current = null;
    };
    clear();

    const gmaps = gmapsNS();
    if (!ready || !mapRef.current || !gmaps) return;

    /*
     * Live means live.
     *
     * These lines are flow, and on a dry day there is none. Drawing the
     * network anyway — animated, at resting width — said water was moving
     * across the property when the actual answer was that nothing was
     * happening, and it made a clear afternoon indistinguishable from a storm.
     * The terrain is still there, and one storm chip will show where it sends
     * water; until then, the honest picture is an empty one, with a line of
     * copy saying so rather than leaving the map looking broken.
     */
    if (hazard.isLive && !(hazard.rainInches && hazard.rainInches > 0)) return;

    // Prefer the fine grid at lot scale, falling back to the wide one only so
    // the view is not empty while the tighter request is still in flight.
    const lotSource = lotGrid ?? grid;

    const paths: { path: { lat: number; lng: number }[]; strength: number }[] = scale === 'lot'
      ? (lotSource?.lotFlow?.streamlines ?? []).map((s) => ({
        path: s.path,
        // Drainage-touching streamlines are the ones carrying concentrated
        // flow, so give them presence even when their catchment is modest.
        strength: s.isDrainage ? Math.max(0.6, s.strength) : s.strength,
      }))
      : (grid?.drainageNetwork?.channels ?? []).map((c) => ({
        path: c.path,
        strength: c.strength,
      }));

    if (!paths.length) return;

    /*
     * How hard the network is running under the selected storm.
     *
     * Surge is held at the resting baseline rather than amplified. It arrives
     * from the sea and fills low ground from the outside in; the drainage lines
     * are not what carries it, and in a real surge they run backwards or not at
     * all. Swelling them for a Category 4 would say the opposite of what
     * happens. Shrinking them would too — the terrain network is still there,
     * so it stays drawn at its normal width and the surge raster carries the
     * story instead.
     */
    const discharge = hazard.mechanism === 'surge'
      ? 1
      : dischargeFactor(hazard.rainInches);

    const animated: AnimatedLine[] = [];
    for (const item of paths) {
      const { overlays, animated: anim } = drawChannel(gmaps, mapRef.current, item.path, {
        strength: item.strength,
        // Lot view packs many more paths into a far smaller area, so the same
        // weights would cover the parcel entirely. It cannot go much below this
        // either: the parcel network is mostly short low-order tributaries, and
        // scaling them down far enough to keep trunks slim leaves the
        // tributaries too faint to count as drawn at all.
        scale: scale === 'lot' ? 0.8 : 0.85,
        discharge,
        zIndexBase: 110,
      });
      flowRef.current.push(...overlays);
      if (anim) animated.push(anim);
    }

    stopAnimationRef.current = animateFlowLines(animated);

    return clear;
    // The hazard belongs here: without it the channels were drawn once from the
    // terrain and never redrawn, so selecting a bigger storm left them exactly
    // as they were.
  }, [ready, grid, lotGrid, scale, hazard.isLive, hazard.mechanism, hazard.rainInches]);

  /* ── parcel outline (lot only) ────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    parcelRef.current?.setMap(null);
    parcelRef.current = null;

    const gmaps = gmapsNS();

    if (!ready || !mapRef.current || !gmaps || scale !== 'lot') return;

    const draw = (geometry: ParcelGeometry | null | undefined) => {
      if (cancelled || !mapRef.current) return;
      const coords = geometry?.coordinates;
      if (!Array.isArray(coords?.[0])) return;

      const path = coords[0]
        .filter((c: number[]) => Array.isArray(c) && c.length >= 2)
        .map((c: number[]) => ({ lat: c[1], lng: c[0] }));
      if (path.length < 3) return;

      parcelRef.current = new gmaps.Polygon({
        paths: path,
        map: mapRef.current,
        strokeColor: '#fbbf24',
        strokeWeight: 2,
        strokeOpacity: 0.95,
        fillOpacity: 0,
        clickable: false,
        zIndex: 35,
      });
    };

    // A caller that already has the outline (or knows there is none) spares us
    // the request; only fetch when nobody has told us either way.
    if (parcelGeometry !== undefined) {
      draw(parcelGeometry);
      return () => {
        cancelled = true;
        parcelRef.current?.setMap(null);
      };
    }

    if (!address && !attomId) return;

    const params = new URLSearchParams();
    if (address) params.set('address', address);
    if (attomId) params.set('attomId', attomId);

    fetch(`/api/attom/parcel-geometry?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => draw(data?.parcel_geometry))
      .catch(() => { /* parcel outline is a nicety, not a requirement */ });

    return () => {
      cancelled = true;
      parcelRef.current?.setMap(null);
    };
  }, [ready, scale, address, attomId, parcelGeometry]);

  /* ── render ───────────────────────────────────────────────────── */

  const lotSourceGrid = lotGrid ?? grid;
  const fall = lotSourceGrid?.lotFlow?.homeFall;
  const channelCount = grid?.drainageNetwork?.channels?.length ?? 0;

  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-100" style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-50 p-6 text-center text-[11px] text-slate-500">
          {error}
        </div>
      )}

      {/* Flood overlays fail quietly without this — a bare satellite map with a
          pin looks like "nothing is wired up" rather than "the request failed". */}
      {(floodLoading || floodError || (!grid && !floodLoading)) && !error && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-[260px] rounded-lg bg-white/95 px-2.5 py-2 text-[10.5px] leading-snug text-slate-600 shadow-lg backdrop-blur-sm">
          {floodLoading && <span className="font-semibold text-slate-800">Loading flood model…</span>}
          {!floodLoading && floodError && (
            <>
              <span className="font-semibold text-rose-700">Flood model unavailable</span>
              <div className="mt-0.5 text-slate-500">{floodError}</div>
            </>
          )}
          {!floodLoading && !floodError && !grid && (
            <span className="font-semibold text-slate-800">No flood data for this location yet.</span>
          )}
        </div>
      )}

      {/* An empty live map is a result, not a failure — but only if it says so.
          Without this the honest "nothing is flowing" state is indistinguishable
          from the layer having failed to draw. */}
      {grid && !floodLoading && hazard.isLive && !(hazard.rainInches && hazard.rainInches > 0) && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-[250px] rounded-lg bg-white/95 px-2.5 py-2 text-[10.5px] leading-snug text-slate-600 shadow-lg backdrop-blur-sm">
          <span className="font-semibold text-slate-800">No rain right now</span>
          <div className="mt-0.5 text-slate-500">
            Nothing is running off the {scale === 'lot' ? 'lot' : 'catchment'}. Pick a storm above to
            see where water would go.
          </div>
        </div>
      )}

      {/* Depth legend, shared with the interior view's palette. */}
      {hazard.raster && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-white/92 px-2.5 py-2 shadow-lg backdrop-blur-sm">
          <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-slate-500">
            Flood depth
          </div>
          <div className="flex items-center gap-1.5">
            {DEPTH_TIERS.map((tier, i) => (
              <div key={tier.label} className="flex items-center gap-1">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-slate-300"
                  style={{ background: tierSwatch(i) }}
                />
                <span className="text-[9px] text-slate-600">{tier.label}</span>
              </div>
            ))}
          </div>
          {hazard.mechanism === 'surge' && !hazard.tiersAreProxy && (
            <div className="mt-1 max-w-[240px] text-[9px] leading-snug text-slate-500">
              Surge extent is filled inland from tidal water, so low ground with
              no path to the coast stays dry.
            </div>
          )}
          {hazard.tiersAreProxy && (
            <div className="mt-1 max-w-[230px] text-[9px] leading-snug text-amber-700">
              No tidal water in frame, so surge extent could not be mapped here —
              only the depth at the property is modelled.
            </div>
          )}
        </div>
      )}

      {/* Neighbourhood caption: says what the channels are and where they came
          from, and offers the next rung down. */}
      {scale === 'neighborhood' && channelCount > 0 && (
        <div className="absolute bottom-3 right-3 max-w-[228px] rounded-lg bg-white/92 px-2.5 py-2 text-[10px] leading-snug text-slate-600 shadow-lg backdrop-blur-sm">
          <div className="font-bold text-slate-800">Drainage corridors</div>
          {channelCount} channels traced from the same elevation model as the
          flood depth, so corridors and water agree.
          <div className="mt-1 text-[9px] text-slate-400">
            Moving dashes show flow direction on the main trunks.
          </div>
          {onZoomIn && (
            <button
              type="button"
              onClick={onZoomIn}
              className="mt-1.5 font-bold text-blue-600 hover:underline"
            >
              Zoom to the lot →
            </button>
          )}
        </div>
      )}

      {/* Lot view caption: the flow field needs a sentence to be useful. */}
      {scale === 'lot' && fall && (
        <div className="absolute bottom-3 right-3 max-w-[220px] rounded-lg bg-white/92 px-2.5 py-2 text-[10px] leading-snug text-slate-600 shadow-lg backdrop-blur-sm">
          <div className="font-bold text-slate-800">Ground fall at the house</div>
          Water runs{' '}
          <span className="font-semibold text-slate-800">
            {bearingToCompass(fall.bearingDeg)}
          </span>{' '}
          at {fall.slopePct}% grade.
          {lotSourceGrid?.lotFlow?.contributingAreaSqm != null && (
            <> Roughly {lotSourceGrid.lotFlow.contributingAreaSqm.toLocaleString()} m² drains through this point.</>
          )}
          {lotSourceGrid?.lotFlow?.drainageCrossesLot && (
            <div className="mt-1 font-semibold text-sky-700">
              A drainage channel crosses this lot.
            </div>
          )}
          <div className="mt-1 text-[9px] text-slate-400">
            Flow paths follow the elevation model at ~{lotSourceGrid?.lotFlow?.spacingMetres} m
            spacing, which is as fine as the terrain data resolves — the fall of
            the land, not surveyed grading.
          </div>
          {onZoomIn && (
            <button
              type="button"
              onClick={onZoomIn}
              className="mt-1.5 font-bold text-blue-600 hover:underline"
            >
              See what it reaches inside →
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default TwinMapLayer;
