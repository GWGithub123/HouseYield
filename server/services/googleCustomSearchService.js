import 'dotenv/config';

const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_CX || '';

export async function runGoogleCustomSearch(query, limit = 5) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) {
    return { ok: false, error: 'missing_query', results: [] };
  }

  if (!GOOGLE_API_KEY || !GOOGLE_CSE_CX) {
    return { ok: false, error: 'google_search_not_configured', results: [] };
  }

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', GOOGLE_API_KEY);
  url.searchParams.set('cx', GOOGLE_CSE_CX);
  url.searchParams.set('q', normalizedQuery);
  url.searchParams.set('num', String(Math.min(Math.max(Number(limit) || 5, 1), 10)));

  const response = await fetch(url.toString());
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`google_search_failed:${response.status}:${errorText.slice(0, 180)}`);
  }

  const data = await response.json();
  const results = Array.isArray(data?.items)
    ? data.items.map((item) => ({
        title: item?.title || 'Untitled result',
        link: item?.link || '',
        snippet: item?.snippet || '',
        displayLink: item?.displayLink || '',
      }))
    : [];

  return {
    ok: true,
    results,
    searchInfo: data?.searchInformation || null,
  };
}