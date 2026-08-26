/**
 * API surface control when PRODUCT_MODE=maintenance.
 *
 * Strategy: keep the Express app intact, but block full-PMS-only routes
 * (market insights, rental pricing, absentee leads, deal-finder ROI, etc.)
 * so a future public host does not expose them. Everything else stays available
 * for Dashboard / Properties / Maintenance / Predictive Maintenance / AI.
 *
 * Tighten further once the maintenance product’s real call graph is stable.
 */

import { isMaintenanceProductMode } from './productMode.js';

/** Full PMS / internal-only prefixes blocked in maintenance orchestration mode. */
const BLOCKED_PREFIXES = [
  '/api/market-analysis',
  '/api/rental-pricing',
  '/api/attom/absentee',
  '/api/attom/assumable',
  '/api/renovation-roi',
  '/api/snowflake',
  '/api/mls/',
  '/api/ai-financial-planner',
  '/api/internal',
  '/api/tax-appeal',
  '/api/v2/',
  '/api/deal-finder',
  '/api/absentee',
];

export function isPathAllowedInMaintenanceMode(pathname) {
  const path = String(pathname || '').split('?')[0] || '/';
  return !BLOCKED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * Express middleware. No-op unless PRODUCT_MODE=maintenance.
 */
export function maintenanceApiAllowlistMiddleware(req, res, next) {
  if (!isMaintenanceProductMode()) {
    return next();
  }

  const path = req.path || req.url || '/';
  if (isPathAllowedInMaintenanceMode(path)) {
    return next();
  }

  if (process.env.NODE_ENV !== 'production') {
    console.warn(`[product-mode] Blocked full-PMS path in maintenance mode: ${req.method} ${path}`);
  }

  return res.status(404).json({
    ok: false,
    error: 'Not available in maintenance orchestration mode',
    productMode: 'maintenance',
  });
}
