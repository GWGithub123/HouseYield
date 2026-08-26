/**
 * Server-side product mode. Mirrors src/product/productMode.ts.
 * Default is "full" so local `npm run dev` is unchanged.
 */

export function getServerProductMode() {
  const raw = process.env.PRODUCT_MODE || process.env.HOUSEYIELD_PRODUCT_MODE || 'full';
  return String(raw).trim().toLowerCase() === 'maintenance' ? 'maintenance' : 'full';
}

export function isMaintenanceProductMode() {
  return getServerProductMode() === 'maintenance';
}
