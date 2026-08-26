/**
 * Compact dark rippling-dot loader for the assistant task pad.
 * Inspired by the dashboard fluid analysis canvas.
 */

import { useEffect, useRef } from 'react';

type Particle = {
  x: number;
  y: number;
  base: number;
  phase: number;
  distance: number;
};

type Pulse = {
  x: number;
  y: number;
  startedAt: number;
  duration: number;
  radius: number;
  strength: number;
};

function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function AssistantFluidLoader({
  active,
  label = 'Working on it…',
  detail,
}: {
  active: boolean;
  label?: string;
  detail?: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return;
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const canvasEl = canvas;
    const hostEl = host;
    let animationFrame: number | null = null;
    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    let particles: Particle[] = [];
    let pulses: Pulse[] = [];
    let lastPulseAt = 0;
    const reduced = prefersReducedMotion();

    const rebuild = () => {
      const nextWidth = Math.max(1, Math.floor(hostEl.clientWidth));
      const nextHeight = Math.max(1, Math.floor(hostEl.clientHeight));
      const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
      width = nextWidth;
      height = nextHeight;
      pixelRatio = nextRatio;
      canvasEl.width = Math.floor(nextWidth * nextRatio);
      canvasEl.height = Math.floor(nextHeight * nextRatio);
      canvasEl.style.width = `${nextWidth}px`;
      canvasEl.style.height = `${nextHeight}px`;
      context.setTransform(nextRatio, 0, 0, nextRatio, 0, 0);

      const spacing = Math.max(14, Math.min(22, Math.floor(Math.min(nextWidth, nextHeight) / 12)));
      const nextParticles: Particle[] = [];
      const cx = nextWidth / 2;
      const cy = nextHeight / 2;
      for (let y = spacing / 2; y < nextHeight; y += spacing) {
        for (let x = spacing / 2; x < nextWidth; x += spacing) {
          const dx = x - cx;
          const dy = y - cy;
          nextParticles.push({
            x,
            y,
            base: 1.1 + Math.random() * 1.4,
            phase: Math.random() * Math.PI * 2,
            distance: Math.sqrt(dx * dx + dy * dy),
          });
        }
      }
      particles = nextParticles;
    };

    const spawnPulse = (now: number) => {
      pulses.push({
        x: width * (0.28 + Math.random() * 0.44),
        y: height * (0.28 + Math.random() * 0.44),
        startedAt: now,
        duration: 1800 + Math.random() * 900,
        radius: Math.max(width, height) * (0.45 + Math.random() * 0.35),
        strength: 0.55 + Math.random() * 0.35,
      });
      if (pulses.length > 4) pulses = pulses.slice(-4);
      lastPulseAt = now;
    };

    const draw = (now: number) => {
      context.clearRect(0, 0, width, height);
      if (!activeRef.current) {
        animationFrame = null;
        return;
      }

      if (!reduced && now - lastPulseAt > 1100) spawnPulse(now);

      const livePulses = pulses
        .map((pulse) => {
          const t = (now - pulse.startedAt) / pulse.duration;
          return { ...pulse, t };
        })
        .filter((pulse) => pulse.t >= 0 && pulse.t <= 1);
      pulses = livePulses.map(({ t: _t, ...pulse }) => pulse);

      for (const particle of particles) {
        let size = particle.base;
        let alpha = 0.18 + (1 - Math.min(1, particle.distance / (Math.max(width, height) * 0.7))) * 0.22;

        for (const pulse of livePulses) {
          const dx = particle.x - pulse.x;
          const dy = particle.y - pulse.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const ring = pulse.t * pulse.radius;
          const band = Math.max(18, pulse.radius * 0.12);
          const delta = Math.abs(dist - ring);
          if (delta < band) {
            const influence = (1 - delta / band) * (1 - pulse.t) * pulse.strength;
            size += influence * 2.8;
            alpha += influence * 0.55;
          }
        }

        const breathe = reduced ? 0 : Math.sin(now / 700 + particle.phase) * 0.25;
        size = Math.max(0.6, size + breathe);
        alpha = Math.min(0.95, Math.max(0.08, alpha + breathe * 0.08));

        context.beginPath();
        context.fillStyle = `rgba(146, 236, 255, ${alpha})`;
        context.arc(particle.x, particle.y, size, 0, Math.PI * 2);
        context.fill();
      }

      animationFrame = window.requestAnimationFrame(draw);
    };

    const ensureLoop = () => {
      if (animationFrame != null) return;
      animationFrame = window.requestAnimationFrame(draw);
    };

    rebuild();
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          rebuild();
          if (activeRef.current) ensureLoop();
        })
      : null;
    observer?.observe(hostEl);

    if (active) ensureLoop();

    return () => {
      observer?.disconnect();
      if (animationFrame != null) window.cancelAnimationFrame(animationFrame);
      context.clearRect(0, 0, width, height);
    };
  }, [active]);

  if (!active) return null;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-cyan-400/20 bg-[#071224] shadow-[inset_0_1px_0_rgba(194,255,246,0.08)]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgba(56,189,248,0.18),transparent_58%),linear-gradient(180deg,rgba(8,18,36,0.2),rgba(5,12,26,0.92))]" />
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />
      <div className="relative z-[1] flex min-h-[148px] flex-col items-center justify-center px-4 py-6 text-center">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-200/80">Preparing</div>
        <div className="mt-2 text-[15px] font-semibold text-slate-50">{label}</div>
        {detail ? <p className="mt-2 max-w-[28ch] text-sm leading-5 text-slate-300/90">{detail}</p> : null}
      </div>
    </div>
  );
}

export default AssistantFluidLoader;
