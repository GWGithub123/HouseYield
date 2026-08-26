const CANONICAL_VISUAL_EVIDENCE_PROMPT = `You are extracting visible renovation evidence from property photos.

Analyze each photo individually. Only report what is directly visible in the image. Do not infer hidden system condition, exact cost, full ROI, or invisible defects.

Return a single JSON object with this shape:
{
  "photoAnalyses": [
    {
      "photoIndex": 0,
      "roomType": "kitchen|bathroom|bedroom|living_room|dining_room|hallway|laundry|basement|exterior|garage|unknown",
      "summary": "one sentence summary of visible condition",
      "findings": [
        {
          "category": "kitchen|bathroom|flooring|paint|lighting|fixtures|cabinetry|countertop|appliances|windows|doors|roof|siding|foundation|driveway|landscaping|hvac|electrical|plumbing|general",
          "subcategory": "short lower-level category",
          "severity": "minor|moderate|major|critical",
          "confidence": 0.0,
          "support": "observed|partially_visible|unclear|not_visible|likely_but_unconfirmed",
          "requiresHumanVerification": false,
          "region": { "x": 0.1, "y": 0.1, "width": 0.4, "height": 0.3 },
          "description": "what is visibly dated, worn, damaged, or notable",
          "normalizedTags": ["dated", "cabinets"],
          "evidenceText": "plain-language evidence taken only from the photo"
        }
      ]
    }
  ],
  "candidateOpportunities": [
    {
      "roomType": "kitchen",
      "category": "kitchen",
      "scopeType": "cosmetic_refresh|full_remodel|repair|replacement|deferred_maintenance|value_add_upgrade|further_review",
      "problemStatement": "visible problem summary",
      "suggestedIntervention": "package-level intervention",
      "marketFit": "poor|neutral|good|excellent|unknown",
      "priority": "critical|high|medium|low",
      "confidence": 0.0,
      "triggerPhotoIndexes": [0],
      "triggerCategories": ["cabinetry", "countertop"]
    }
  ],
  "summaryNotes": ["overall notes"]
}

Rules:
- Emit explicit uncertainty through support instead of pretending certainty.
- Use requiresHumanVerification=true when the photo is partial, unclear, or the condition may be misleading.
- If an area is not visible, do not invent a finding for it.
- Candidate opportunities must be package-level suggestions, not pricing claims.`;

function parseJsonObject(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) {
    throw new Error('Empty canonical visual evidence response');
  }

  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)\s*```/) || trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (fencedMatch?.[1]) {
    return JSON.parse(fencedMatch[1].trim());
  }

  return JSON.parse(trimmed);
}

function clampConfidence(value, fallback = 0.5) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function slugify(parts) {
  return parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function normalizeRoomType(value) {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

function normalizeCategory(value) {
  if (typeof value !== 'string' || !value.trim()) return 'general';
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

function normalizeSeverity(value) {
  switch (value) {
    case 'critical':
    case 'major':
    case 'moderate':
    case 'minor':
      return value;
    default:
      return 'moderate';
  }
}

function normalizeSupport(value) {
  switch (value) {
    case 'observed':
    case 'partially_visible':
    case 'unclear':
    case 'not_visible':
    case 'likely_but_unconfirmed':
      return value;
    default:
      return 'unclear';
  }
}

function normalizeScopeType(value) {
  switch (value) {
    case 'cosmetic_refresh':
    case 'full_remodel':
    case 'repair':
    case 'replacement':
    case 'deferred_maintenance':
    case 'value_add_upgrade':
    case 'further_review':
      return value;
    default:
      return 'further_review';
  }
}

function normalizePriority(value) {
  switch (value) {
    case 'critical':
    case 'high':
    case 'medium':
    case 'low':
      return value;
    default:
      return 'medium';
  }
}

function normalizeMarketFit(value) {
  switch (value) {
    case 'poor':
    case 'neutral':
    case 'good':
    case 'excellent':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function normalizeRegion(region) {
  if (!region || typeof region !== 'object') return null;
  const x = typeof region.x === 'number' ? region.x : null;
  const y = typeof region.y === 'number' ? region.y : null;
  const width = typeof region.width === 'number' ? region.width : null;
  const height = typeof region.height === 'number' ? region.height : null;

  if ([x, y, width, height].some((value) => value === null)) return null;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x > 1 || y > 1) return null;

  return { x, y, width, height, unit: 'normalized' };
}

function dedupe(values) {
  return [...new Set((values || []).filter(Boolean))];
}

export function createEmptyCanonicalVisualEvidence(photoCount, status, note) {
  return {
    findings: [],
    opportunities: [],
    roomSummaries: [],
    summary: {
      photoCount,
      findingCount: 0,
      opportunityCount: 0,
      uncertainFindingCount: 0,
      requiresHumanVerification: true,
      status,
      notes: note ? [note] : [],
    },
  };
}

function buildRoomSummaries(findings) {
  const grouped = new Map();

  for (const finding of findings) {
    const key = finding.roomType;
    const existing = grouped.get(key) || {
      roomType: finding.roomType,
      photoIndexes: [],
      categoriesObserved: [],
      requiresHumanVerification: false,
      confidence: 0,
    };

    if (typeof finding.photoIndex === 'number' && !existing.photoIndexes.includes(finding.photoIndex)) {
      existing.photoIndexes.push(finding.photoIndex);
    }
    if (!existing.categoriesObserved.includes(finding.category)) {
      existing.categoriesObserved.push(finding.category);
    }
    existing.requiresHumanVerification = existing.requiresHumanVerification || finding.requiresHumanVerification;
    existing.confidence = Math.max(existing.confidence, finding.confidence);

    grouped.set(key, existing);
  }

  return [...grouped.values()].sort((left, right) => left.roomType.localeCompare(right.roomType));
}

function normalizeCanonicalVisualEvidence(raw, photoCount) {
  const findings = [];
  const photoAnalyses = Array.isArray(raw?.photoAnalyses) ? raw.photoAnalyses : [];

  for (const photo of photoAnalyses) {
    const photoIndex = typeof photo?.photoIndex === 'number' && photo.photoIndex >= 0 && photo.photoIndex < photoCount
      ? photo.photoIndex
      : null;
    const roomType = normalizeRoomType(photo?.roomType);
    const photoSummary = typeof photo?.summary === 'string' ? photo.summary.trim() : '';
    const rawFindings = Array.isArray(photo?.findings) ? photo.findings : [];

    rawFindings.forEach((finding, index) => {
      const category = normalizeCategory(finding?.category);
      const subcategory = normalizeCategory(finding?.subcategory || category);
      const support = normalizeSupport(finding?.support);
      const confidence = clampConfidence(finding?.confidence, support === 'observed' ? 0.75 : 0.5);
      const requiresHumanVerification = Boolean(finding?.requiresHumanVerification)
        || support !== 'observed'
        || confidence < 0.7;
      const description = (typeof finding?.description === 'string' && finding.description.trim())
        || photoSummary
        || `${category} observation in ${roomType}`;
      const evidenceText = (typeof finding?.evidenceText === 'string' && finding.evidenceText.trim()) || description;
      const normalizedTags = dedupe([
        roomType,
        category,
        subcategory,
        ...(Array.isArray(finding?.normalizedTags) ? finding.normalizedTags.map((tag) => normalizeCategory(tag)) : []),
      ]);

      findings.push({
        findingId: `finding-${slugify([photoIndex ?? 'unknown', category, subcategory, index])}`,
        photoIndex,
        roomType,
        category,
        subcategory,
        severity: normalizeSeverity(finding?.severity),
        confidence,
        visibleOnly: true,
        support,
        requiresHumanVerification,
        bbox: normalizeRegion(finding?.region),
        description,
        normalizedTags,
        evidenceText,
      });
    });
  }

  const rawOpportunities = Array.isArray(raw?.candidateOpportunities) ? raw.candidateOpportunities : [];
  const opportunities = rawOpportunities.map((opportunity, index) => {
    const roomType = normalizeRoomType(opportunity?.roomType);
    const category = normalizeCategory(opportunity?.category);
    const triggerPhotoIndexes = Array.isArray(opportunity?.triggerPhotoIndexes)
      ? opportunity.triggerPhotoIndexes.filter((value) => typeof value === 'number')
      : [];
    const triggerCategories = Array.isArray(opportunity?.triggerCategories)
      ? opportunity.triggerCategories.map((value) => normalizeCategory(value))
      : [];

    const triggerFindings = findings
      .filter((finding) => {
        const roomMatches = finding.roomType === roomType || roomType === 'unknown';
        const photoMatches = triggerPhotoIndexes.length === 0 || (typeof finding.photoIndex === 'number' && triggerPhotoIndexes.includes(finding.photoIndex));
        const categoryMatches = triggerCategories.length === 0 || triggerCategories.includes(finding.category) || triggerCategories.includes(finding.subcategory);
        return roomMatches && photoMatches && categoryMatches;
      })
      .map((finding) => finding.findingId);

    return {
      opportunityId: `opportunity-${slugify([roomType, category, index])}`,
      roomType,
      category,
      scopeType: normalizeScopeType(opportunity?.scopeType),
      triggerFindings,
      measuredElements: [],
      problemStatement: typeof opportunity?.problemStatement === 'string' && opportunity.problemStatement.trim()
        ? opportunity.problemStatement.trim()
        : `Visible ${category} issue in ${roomType}`,
      suggestedIntervention: typeof opportunity?.suggestedIntervention === 'string' && opportunity.suggestedIntervention.trim()
        ? opportunity.suggestedIntervention.trim()
        : 'Human review required to define package scope',
      marketFit: normalizeMarketFit(opportunity?.marketFit),
      priority: normalizePriority(opportunity?.priority),
      confidence: clampConfidence(opportunity?.confidence, triggerFindings.length > 0 ? 0.7 : 0.5),
    };
  });

  const notes = Array.isArray(raw?.summaryNotes)
    ? raw.summaryNotes.filter((note) => typeof note === 'string' && note.trim().length > 0)
    : typeof raw?.summaryNotes === 'string' && raw.summaryNotes.trim().length > 0
      ? [raw.summaryNotes.trim()]
      : [];

  const uncertainFindingCount = findings.filter((finding) => finding.requiresHumanVerification).length;

  return {
    findings,
    opportunities,
    roomSummaries: buildRoomSummaries(findings),
    summary: {
      photoCount,
      findingCount: findings.length,
      opportunityCount: opportunities.length,
      uncertainFindingCount,
      requiresHumanVerification: uncertainFindingCount > 0,
      status: findings.length > 0 ? 'complete' : 'partial',
      notes,
    },
  };
}

export async function extractCanonicalVisualEvidenceFromImages({ photoBase64Array, openaiApiKey, model = 'gpt-4o' }) {
  if (!Array.isArray(photoBase64Array) || photoBase64Array.length === 0) {
    return createEmptyCanonicalVisualEvidence(0, 'unavailable', 'No photos were provided for canonical visual evidence extraction.');
  }

  if (!openaiApiKey) {
    throw new Error('OpenAI API key not configured for canonical visual evidence extraction');
  }

  const imageContent = photoBase64Array.map((base64) => ({
    type: 'image_url',
    image_url: {
      url: base64,
      detail: 'high',
    },
  }));

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: CANONICAL_VISUAL_EVIDENCE_PROMPT },
            ...imageContent,
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Canonical visual evidence extraction failed: ${response.status} ${errorText.slice(0, 180)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const parsed = parseJsonObject(content);
  return normalizeCanonicalVisualEvidence(parsed, photoBase64Array.length);
}