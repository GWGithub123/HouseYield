# HouseYield Maintenance Orchestration

Slimmed customer-facing product focused on property overview, maintenance operations, predictive maintenance, documents, and bookkeeping. The full property-management system remains available via `npm run dev:houseyield`.

## Local development

```bash
npm run dev
```

(`npm run dev:maintenance` is an alias for the same script.)

- UI: [http://localhost:5175](http://localhost:5175)
- Backend: `:3001` with `PRODUCT_MODE=maintenance` (API allowlist enabled)

If the backend is already running on `:3001`, this starts the UI only. Restart the backend with `PRODUCT_MODE=maintenance` if you want the allowlist active:

```bash
PRODUCT_MODE=maintenance npm run push-server
npm run dev:maintenance:ui
```

## What is included

| Area | Included |
| --- | --- |
| Dashboard | Hidden |
| Properties → Overview / Analytics / Environmental Risk | Yes |
| Properties → Rental Pricing Power | Hidden |
| Maintenance (Maintenance tab + Bookkeeping) | Yes |
| Management → Documents / Tenants / Tax Center | Hidden |
| Predictive Maintenance | Yes |
| Market Insights | Hidden |
| AI Support agent | Yes (nav capabilities filtered) |

## Build

```bash
npm run build:maintenance
```

Output: `dist-maintenance/`

## Backend product mode

With `PRODUCT_MODE=maintenance`, the Express server blocks full-PMS-only API prefixes (market analysis, rental pricing, absentee leads, renovation ROI, internal ops, etc.). Core maintenance / sensors / documents / bookkeeping routes stay available.

## Google Maps

The Maps JS API key must allow this origin. Local maintenance runs on **http://localhost:5175**, so the key’s HTTP referrers need:

- `http://localhost:5175/*`
- `http://127.0.0.1:5175/*`

(alongside the existing `:5173` entries).

## Future hosting (not configured in this pass)

When ready for public customers, prefer a **paid always-on Render** Web Service that builds this app and runs the Express backend with `PRODUCT_MODE=maintenance`. Railway is a reasonable DX alternative with a spend cap. Do not use Render’s free web tier (it sleeps and breaks Shelly webhooks).
