#!/usr/bin/env node
/**
 * Verify Google server-side APIs used by maintenance provider search.
 *
 * Usage:
 *   node scripts/verify-google-server-key.mjs
 *
 * Requires in .env:
 *   GOOGLE_SERVER_API_KEY (preferred) or GOOGLE_MAPS_API_KEY / GOOGLE_SEARCH_API_KEY
 *   GOOGLE_CSE_CX
 */

import 'dotenv/config';

const serverKey =
  process.env.GOOGLE_SERVER_API_KEY ||
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.GOOGLE_SEARCH_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  '';
const browserKey = process.env.VITE_GOOGLE_MAPS_API_KEY || '';
const cseCx = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_CX || '';

function statusLine(name, ok, detail) {
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function testGeocoding(key) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', '11822 Prestwick Road, Potomac, MD 20854');
  url.searchParams.set('key', key);
  const data = await fetch(url).then((r) => r.json());
  return {
    ok: data.status === 'OK',
    detail: data.error_message || data.status
  };
}

async function testPlacesNew(key) {
  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.displayName,places.nationalPhoneNumber,places.rating'
    },
    body: JSON.stringify({
      textQuery: 'plumber near Potomac MD 20854',
      maxResultCount: 3
    })
  });
  const data = await resp.json();
  const count = data.places?.length || 0;
  return {
    ok: resp.ok && count > 0,
    detail: data.error?.message || `${count} place(s) found`
  };
}

async function testCustomSearch(key) {
  if (!cseCx) {
    return { ok: false, detail: 'GOOGLE_CSE_CX not set' };
  }
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', key);
  url.searchParams.set('cx', cseCx);
  url.searchParams.set('q', 'plumber Potomac MD');
  url.searchParams.set('num', '1');
  const data = await fetch(url).then((r) => r.json());
  const count = data.items?.length || 0;
  return {
    ok: count > 0,
    detail: data.error?.message || `${count} result(s) found`
  };
}

console.log('Google server API verification\n');

if (!serverKey) {
  statusLine('Server key configured', false, 'Set GOOGLE_SERVER_API_KEY in .env');
  process.exit(1);
}

statusLine('Server key configured', true, `…${serverKey.slice(-4)}`);
statusLine('Custom Search CX configured', Boolean(cseCx), cseCx ? `…${cseCx.slice(-4)}` : 'missing');
if (browserKey && browserKey !== serverKey) {
  statusLine('Browser key separate', true, `…${browserKey.slice(-4)}`);
} else if (browserKey) {
  statusLine('Browser key separate', false, 'Same key as server key — create a separate browser key');
}

console.log('\nTesting server key:');
for (const [name, fn] of [
  ['Geocoding API', () => testGeocoding(serverKey)],
  ['Places API (New)', () => testPlacesNew(serverKey)],
  ['Custom Search JSON API', () => testCustomSearch(serverKey)]
]) {
  const result = await fn();
  statusLine(name, result.ok, result.detail);
}

console.log('\nIf any test fails with "referer" or "referrer":');
console.log('  Your key is browser-restricted. Create a new server key with NO HTTP referrer restriction.');
console.log('\nIf Places fails with "legacy API not enabled":');
console.log('  Enable "Places API (New)" in Google Cloud Console → APIs & Services → Library.');
