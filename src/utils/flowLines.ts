/**
 * Shared rendering for water flow on Google Maps.
 *
 * WHY SMOOTHING IS THE WHOLE GAME
 * -------------------------------
 * Flow direction comes from a D8 algorithm, which lets each DEM cell drain to
 * exactly one of its 8 neighbours. Every path is therefore built from steps of
 * 0°, 45° or 90°, and drawn literally it looks like pipework: hard staircases
 * and right-angle kinks that no stream has ever made. That geometry is an
 * artefact of the algorithm, not a feature of the terrain.
 *
 * Chaikin subdivision rounds those corners off. It stays close to the original
 * path — so we are not inventing a course the model did not produce — while
 * removing the quantisation that made it look synthetic.
 */

export interface LatLng { lat: number; lng: number }

/**
 * Chaikin corner-cutting. Each pass replaces every segment with two points at
 * 1/4 and 3/4, which halves the angle at each corner.
 *
 * Two passes is the sweet spot: one still reads as faceted, three starts
 * pulling noticeably away from the modelled path and rounds off real switchbacks.
 */
export function smoothPath(path: LatLng[], passes = 2): LatLng[] {
  if (path.length < 3) return path;

  let current = path;
  for (let pass = 0; pass < passes; pass += 1) {
    const next: LatLng[] = [current[0]];
    for (let i = 0; i < current.length - 1; i += 1) {
      const a = current[i];
      const b = current[i + 1];
      next.push(
        { lat: a.lat * 0.75 + b.lat * 0.25, lng: a.lng * 0.75 + b.lng * 0.25 },
        { lat: a.lat * 0.25 + b.lat * 0.75, lng: a.lng * 0.25 + b.lng * 0.75 },
      );
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

/** Whether the user has asked the OS to reduce motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export interface AnimatedLine { line: any; speed: number }

/**
 * Advance the dash offset on a set of polylines from one shared rAF loop.
 *
 * A timer per polyline is what makes these overlays stutter — a few hundred
 * lines each setting `icons` on its own schedule thrashes the map. They all
 * move in lockstep, so one loop is both smoother and cheaper.
 */
export function animateFlowLines(lines: AnimatedLine[]): () => void {
  if (lines.length === 0) return () => {};

  let frame = 0;
  let stopped = false;
  const start = performance.now();

  const tick = (now: number) => {
    if (stopped) return;
    const elapsed = (now - start) / 1000;
    for (const { line, speed } of lines) {
      const icons = line.get('icons');
      if (!icons?.length) continue;
      icons[0].offset = `${(elapsed * speed) % 100}%`;
      line.set('icons', icons);
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
  };
}

export interface ChannelStyle {
  /** 0–1. Drives width, opacity and dash speed together. */
  strength: number;
  /** Overall width multiplier, for tuning per zoom level. */
  scale?: number;
  /**
   * How much water the network is carrying, relative to a routine storm.
   *
   * `strength` is a property of the terrain — which of these channels is a
   * trunk and which a capillary — and does not change when the storm does.
   * This is the other half: the same network carrying more or less water. Keep
   * them separate, because conflating them means a 6-inch storm redraws the
   * drainage pattern rather than filling it.
   */
  discharge?: number;
  zIndexBase?: number;
}

/**
 * Width multiplier for a given discharge. 1 means "no storm selected".
 *
 * Anchored at 1 rather than centred on a mid-sized storm, and that anchoring is
 * the whole point. An earlier version returned 0.55 with nothing selected,
 * which multiplied against the lot view's own 0.5 width scale and produced a
 * third of a pixel of stroke — the channels were still being drawn, they were
 * simply too thin to see. A multiplier that can only ever add avoids reasoning
 * about the product of two independent scale factors.
 *
 * Growth is sub-linear because channel width does not scale one-for-one with
 * flow: at a given cross-section, water that doubles mostly gets deeper and
 * faster before it gets much wider. The exponent sits in the range hydraulic
 * geometry gives for at-a-station width (Leopold & Maddock put it near 0.26; a
 * little higher reads better on screen without overstating the change).
 */
const REFERENCE_STORM_IN = 2;
/** A half-inch storm is the baseline: real, but no wider than a quiet day. */
const BASELINE = (0.5 / REFERENCE_STORM_IN) ** 0.42;
export function dischargeFactor(rainInches: number | null | undefined): number {
  if (rainInches == null || rainInches <= 0) return 1;
  const growth = (rainInches / REFERENCE_STORM_IN) ** 0.42 - BASELINE;
  return Math.max(1, Math.min(1.9, 1 + 0.75 * growth));
}

/**
 * Draw one water channel as stacked strokes plus a moving dash.
 *
 * The stack is what creates the sense of depth: a wide soft halo suggesting
 * spread, a mid body, then a bright narrow thread for the thalweg. A single
 * flat stroke reads as a drawn line; three graded ones read as water.
 */
export function drawChannel(
  gmaps: any,
  map: any,
  rawPath: LatLng[],
  style: ChannelStyle,
): { overlays: any[]; animated: AnimatedLine | null } {
  const overlays: any[] = [];
  if (rawPath.length < 2) return { overlays, animated: null };

  const path = smoothPath(rawPath);
  const strength = Math.max(0, Math.min(1, style.strength));
  const scale = style.scale ?? 1;
  const z = style.zIndexBase ?? 110;

  /*
   * Taper width on short paths.
   *
   * Flat coastal terrain produces a genuinely fragmented drainage network — many
   * channels are only a handful of cells long. Giving those the full river width
   * turns each one into a fat disconnected blob, which reads as a rendering bug
   * rather than as water. Length is a decent proxy for whether something is a
   * real corridor, so short paths stay thin.
   */
  const lengthFactor = Math.max(0.35, Math.min(1, rawPath.length / 12));
  const weight = strength * lengthFactor;
  const q = style.discharge ?? 1;

  /*
   * Floors, in CSS pixels, below which a stroke stops being a thin line and
   * becomes a faint grey suggestion. The lot view runs a small `scale` so its
   * hundreds of paths do not merge into a sheet, and the lightest capillaries
   * there would otherwise land near a third of a pixel — drawn, antialiased
   * into nothing, and indistinguishable from a missing layer. Floors keep the
   * faintest tributary legible while leaving the trunk-versus-capillary spread
   * above them intact.
   */
  const outer = Math.max(2.6, (2.4 + 7 * weight) * scale * q);
  const mid = Math.max(1.6, (1.4 + 3.4 * weight) * scale * q);
  const core = Math.max(0.9, (0.7 + 1.5 * weight) * scale * q);

  /*
   * Cool and translucent, lightest at the edges.
   *
   * An earlier pass ran a near-black core down the middle of every path, which
   * is what made these read as inked pipes drawn over the imagery rather than
   * as water lying on it. Real water reads by tint and by movement, so the
   * strokes stay light and see-through and the moving dash carries the signal.
   */
  // Opacity leans on discharge too, but gently and with a ceiling: a big storm
  // should look like more water in the same channels, not like a different map.
  const ink = Math.max(1, Math.min(1.35, q));
  const layers = [
    { weight: outer * 1.2, opacity: (0.06 + 0.07 * weight) * ink, color: '#bae6fd', zIndex: z },
    { weight: outer, opacity: (0.10 + 0.13 * weight) * ink, color: '#7dd3fc', zIndex: z + 1 },
    { weight: mid, opacity: Math.min(0.55, (0.18 + 0.20 * weight) * ink), color: '#38bdf8', zIndex: z + 2 },
    { weight: core, opacity: Math.min(0.8, (0.32 + 0.28 * weight) * ink), color: '#0284c7', zIndex: z + 3 },
  ];

  for (const layer of layers) {
    overlays.push(new gmaps.Polyline({
      path,
      geodesic: true,
      strokeColor: layer.color,
      strokeOpacity: layer.opacity,
      strokeWeight: layer.weight,
      map,
      zIndex: layer.zIndex,
      clickable: false,
    }));
  }

  if (prefersReducedMotion()) return { overlays, animated: null };

  /*
   * Filled arrowheads rather than dashes.
   *
   * A dash tells you water is there; an arrowhead tells you which way it is
   * going, and on a lot view "which way does my yard drain" is the entire
   * question. Spacing them well apart keeps a dense network from turning into
   * herringbone texture, which is the failure mode chevrons have when they are
   * packed tightly.
   */
  const dash = new gmaps.Polyline({
    path,
    geodesic: true,
    strokeOpacity: 0,
    map,
    zIndex: z + 4,
    clickable: false,
    icons: [{
      icon: {
        path: gmaps.SymbolPath.FORWARD_CLOSED_ARROW,
        strokeColor: '#f0f9ff',
        strokeOpacity: 0.85,
        strokeWeight: 1,
        fillColor: '#e0f2fe',
        fillOpacity: 0.6 + 0.35 * weight,
        scale: Math.max(1.7, Math.min(3.6, core * 1.5)),
      },
      offset: '0%',
      // Arrowheads crowd together as discharge rises, so a heavier storm reads
      // as a denser, faster procession rather than just thicker lines.
      repeat: `${Math.round((58 - 14 * weight) / Math.max(0.7, q))}px`,
    }],
  });
  overlays.push(dash);

  return {
    overlays,
    // Trunks run faster than capillaries, and everything runs faster in a big
    // storm — velocity is the most legible cue that more water is moving.
    animated: { line: dash, speed: (2.5 + 5 * weight) * Math.max(1, Math.min(1.9, q)) },
  };
}
