/**
 * Turns the AI provider selector's output into a ranked shortlist, and decides
 * whether HouseYield places the booking call itself.
 *
 * The product deliberately stops at a shortlist: an operator reads the ranked
 * candidates and the generated call script, dials the provider, and logs the outcome.
 * Set MAINTENANCE_AUTO_CALL_ENABLED=true to re-enable the legacy Twilio auto-call.
 */

export const AUTO_CALL_ENV_FLAG = 'MAINTENANCE_AUTO_CALL_ENABLED';

export function isMaintenanceAutoCallEnabled() {
  return String(process.env[AUTO_CALL_ENV_FLAG] || '').trim().toLowerCase() === 'true';
}

/** Flattens `selected` + `alternative` + `allCandidates` into one deduped ranked list. */
export function buildProviderShortlist(searchResult = {}) {
  const seen = new Set();
  const shortlist = [];

  const push = (candidate, analysisOverride) => {
    if (!candidate?.name) return;

    const key = `${String(candidate.name).toLowerCase()}|${candidate.placeId || candidate.phone || ''}`;
    if (seen.has(key)) return;
    seen.add(key);

    const reviewAnalysis = analysisOverride || candidate.reviewAnalysis || null;
    const phone = candidate.phone || candidate.formatted_phone_number || '';

    shortlist.push({
      placeId: candidate.placeId || '',
      name: candidate.name,
      phone,
      address: candidate.address || candidate.formatted_address || '',
      website: candidate.website || '',
      rating: candidate.rating ?? null,
      reviewCount: candidate.reviewCount ?? candidate.user_ratings_total ?? null,
      lat: candidate.lat ?? null,
      lng: candidate.lng ?? null,
      aiScore: reviewAnalysis?.overallScore ?? candidate.aiScore ?? null,
      selectionReasoning: candidate.selectionReasoning || '',
      reviewAnalysis,
      isTrusted: Boolean(candidate.isTrusted),
      trustedNote: candidate.trustedNote || '',
    });
  };

  push(searchResult.selected, searchResult.selected?.reviewAnalysis);
  push(searchResult.alternative, null);
  (searchResult.allCandidates || []).forEach((candidate) => push(candidate, null));

  // AI-scored candidates first; Google rating breaks ties among unscored ones.
  return shortlist.sort((a, b) => {
    const scoreDelta = (Number(b.aiScore) || 0) - (Number(a.aiScore) || 0);
    if (scoreDelta !== 0) return scoreDelta;
    return (Number(b.rating) || 0) - (Number(a.rating) || 0);
  });
}

/** The selector returns either a plain string or a structured script object. */
export function formatCallScript(callScript) {
  if (!callScript) return '';
  if (typeof callScript === 'string') return callScript;

  const sections = [];
  if (callScript.opening) sections.push(callScript.opening);
  if (callScript.issueDescription) sections.push(callScript.issueDescription);

  const bulletBlock = (title, items) => {
    if (!Array.isArray(items) || !items.length) return null;
    return `${title}\n${items.map((item) => `• ${item}`).join('\n')}`;
  };

  const questions = bulletBlock('Ask about:', callScript.keyQuestions);
  if (questions) sections.push(questions);

  const redFlags = bulletBlock('Watch for:', callScript.redFlagsToWatch);
  if (redFlags) sections.push(redFlags);

  if (callScript.closing) sections.push(callScript.closing);

  return sections.join('\n\n');
}
