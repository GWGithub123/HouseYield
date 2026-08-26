/**
 * Official landlord-tenant statute URLs and repair helpers for compliance audit links.
 *
 * Maryland's mgaleg StatuteText endpoint requires a full section number (e.g. 8-101),
 * not a title-only value like section=8, which returns "File Not Found".
 */

export const OFFICIAL_STATUTE_URLS = {
  MD: 'https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=grp&section=8-101',
  VA: 'https://law.lis.virginia.gov/vacodefull/title55.1/chapter12/',
  DC: 'https://code.dccouncil.gov/us/dc/council/code/titles/42/chapters/32',
  DE: 'https://delcode.delaware.gov/title25/c055/',
  PA: 'https://www.palegis.us/statutes/unconsolidated/law-information?sessYr=1951&sessInd=0&actNum=20',
  NJ: 'https://lis.njleg.state.nj.us/nxt/gateway.dll?f=templates&fn=default.htm&vid=Publish:10.1048/Enu',
  WV: 'https://www.wvlegislature.gov/wvcode/ChapterEntire.cfm?chap=37&art=6A'
};

const BROKEN_STATUTE_URL_PATTERNS = [
  {
    test: (url) => /mgaleg\.maryland\.gov\/mgawebsite\/Laws\/StatuteText\?article=grp&section=8(?:[&/?#]|$)/.test(url),
    repair: () => OFFICIAL_STATUTE_URLS.MD
  },
  {
    test: (url) => /legis\.state\.pa\.us/.test(url),
    repair: () => OFFICIAL_STATUTE_URLS.PA
  },
  {
    test: (url) => /njleg\.state\.nj\.us\/find-legislation/.test(url),
    repair: () => OFFICIAL_STATUTE_URLS.NJ
  }
];

/**
 * Repair known-broken official statute URLs saved in older compliance metadata.
 * @param {string|null|undefined} url
 * @param {string|null|undefined} stateCode
 * @returns {string|null|undefined}
 */
export function repairComplianceStatuteUrl(url, stateCode = null) {
  if (!url || typeof url !== 'string') return url;

  const trimmed = url.trim();
  if (!trimmed) return url;

  for (const pattern of BROKEN_STATUTE_URL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return pattern.repair();
    }
  }

  const canonical = stateCode ? OFFICIAL_STATUTE_URLS[stateCode.toUpperCase()] : null;
  if (canonical && trimmed === canonical) {
    return canonical;
  }

  return trimmed;
}

/**
 * @param {Object|null|undefined} metadata
 * @returns {Object|null|undefined}
 */
export function repairComplianceMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata;

  const stateCode = metadata.stateCode || null;
  const repaired = { ...metadata };

  if (repaired.governingAuthority && typeof repaired.governingAuthority === 'object') {
    repaired.governingAuthority = {
      ...repaired.governingAuthority,
      url: repairComplianceStatuteUrl(repaired.governingAuthority.url, stateCode)
    };
  }

  if (Array.isArray(repaired.sources)) {
    repaired.sources = repaired.sources.map((source) => {
      if (!source || typeof source !== 'object') return source;
      return {
        ...source,
        url: source.url ? repairComplianceStatuteUrl(source.url, stateCode) : source.url
      };
    });
  }

  return repaired;
}
