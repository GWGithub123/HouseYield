/**
 * Multiple-choice follow-up questions for maintenance intake.
 *
 * Intake works best when the submitter taps a concrete option instead of typing prose.
 * Gemini generates these questions when it is reachable; this module supplies the
 * detection of what the submitter already told us (so nothing gets asked twice), a
 * per-category question bank used when the model is unavailable, and the validation
 * that keeps model output in the shape the UI can render.
 */

const ROOM_PATTERNS = [
  [/\bkitchens?\b/, 'Kitchen'],
  [/\b(master|primary)\s+(bath|bathroom)\b/, 'Primary bathroom'],
  [/\b(half|guest|powder)\s*(bath|bathroom|room)\b/, 'Half bathroom'],
  [/\bbath(room)?s?\b/, 'Bathroom'],
  [/\bbasements?\b/, 'Basement'],
  [/\bcrawl\s?spaces?\b/, 'Crawl space'],
  [/\battics?\b/, 'Attic'],
  [/\bgarages?\b/, 'Garage'],
  [/\blaundry\s*(room)?\b|\butility\s+room\b/, 'Laundry room'],
  [/\bliving\s+room\b|\bden\b|\bfamily\s+room\b/, 'Living room'],
  [/\bdining\s+room\b/, 'Dining room'],
  [/\bbed\s?rooms?\b/, 'Bedroom'],
  [/\bhall(way)?s?\b/, 'Hallway'],
  [/\bclosets?\b/, 'Closet'],
  [/\broofs?\b/, 'Roof'],
  [/\b(back|front)\s?yard\b|\bdriveways?\b|\bporch\b|\bpatio\b|\bdecks?\b/, 'Exterior'],
];

const FIXTURE_PATTERNS = [
  [/\bgarbage\s+disposal\b|\bdisposals?\b/, 'garbage disposal'],
  [/\bwater\s+heaters?\b/, 'water heater'],
  [/\bsump\s+pumps?\b/, 'sump pump'],
  [/\bdishwashers?\b/, 'dishwasher'],
  [/\brefrigerators?\b|\bfridges?\b|\bfreezers?\b/, 'refrigerator'],
  [/\bwashers?\b|\bwashing\s+machines?\b/, 'washer'],
  [/\bdryers?\b/, 'dryer'],
  [/\bovens?\b|\bstoves?\b|\branges?\b|\bcooktops?\b/, 'oven'],
  [/\bmicrowaves?\b/, 'microwave'],
  [/\bfurnaces?\b|\bboilers?\b/, 'furnace'],
  [/\bthermostats?\b/, 'thermostat'],
  [/\bair\s?condition(er|ing)?\b|\bac\s+unit\b|\bhvac\b|\bcondensers?\b/, 'AC unit'],
  [/\btoilets?\b/, 'toilet'],
  [/\bshowers?\b/, 'shower'],
  [/\b(bath)?tubs?\b/, 'tub'],
  [/\bfaucets?\b|\btaps?\b/, 'faucet'],
  [/\bsinks?\b/, 'sink'],
  [/\bdrains?\b/, 'drain'],
  [/\bpipes?\b|\bplumbing\b/, 'pipe'],
  [/\boutlets?\b|\breceptacles?\b/, 'outlet'],
  [/\bbreakers?\b|\b(electrical\s+)?panels?\b|\bfuse\s?box\b/, 'breaker panel'],
  [/\blight\s*(fixture|switch)?s?\b/, 'light fixture'],
  [/\bceiling\s+fans?\b/, 'ceiling fan'],
  [/\bgarage\s+doors?\b/, 'garage door'],
  [/\bwindows?\b/, 'window'],
  [/\bdoors?\b/, 'door'],
  [/\bgutters?\b/, 'gutter'],
  [/\bvents?\b|\bducts?\b/, 'vent'],
];

/** Sentinel returned for a fact the submitter has not addressed yet. */
const UNKNOWN = null;

function firstMatch(patterns, text) {
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) return label;
  }
  return UNKNOWN;
}

/**
 * Reads the conversation text for details the submitter already volunteered.
 * Anything detected here is never asked about again.
 */
export function detectKnownFacts(text = '') {
  const normalized = String(text || '').toLowerCase();

  const room = firstMatch(ROOM_PATTERNS, normalized);
  const fixture = firstMatch(FIXTURE_PATTERNS, normalized);

  let location = UNKNOWN;
  if (room && fixture) location = `${room} ${fixture}`;
  else if (room) location = room;
  else if (fixture) location = fixture.charAt(0).toUpperCase() + fixture.slice(1);

  let severity = UNKNOWN;
  if (/\b(pour|pouring|gush|gushing|spray|spraying|flood|flooding|pooling|puddle|soak|soaked|burst)\b/.test(normalized)) {
    severity = 'severe';
  } else if (/\b(steady|constant|running|streaming|continuous)\b/.test(normalized)) {
    severity = 'moderate';
  } else if (/\b(slow|slight|small|minor|occasional|drip|dripping|seep|seeping)\b/.test(normalized)) {
    severity = 'slow';
  }

  let duration = UNKNOWN;
  if (/\b(just started|just now|right now|this morning|tonight|today|an hour|hour ago|minutes ago)\b/.test(normalized)) {
    duration = 'today';
  } else if (/\b(yesterday|couple (of )?days|few days|two days|three days|\d+ days)\b/.test(normalized)) {
    duration = 'days';
  } else if (/\b(week|weeks|month|months|year|years|a while|long time|ongoing)\b/.test(normalized)) {
    duration = 'long';
  }

  const damage = /\b(damage|damaged|water damage|stain|staining|warp|warped|soft|rot|rotten|mold|mildew|musty|ceiling fell|collapsed)\b/.test(normalized)
    ? 'reported'
    : UNKNOWN;

  const shutoff = /\b(shut ?off|shut it off|turned (it )?off|valve|main off|killed the (power|breaker))\b/.test(normalized)
    ? 'reported'
    : UNKNOWN;

  return { location, room, fixture, severity, duration, damage, shutoff };
}

/**
 * Question bank keyed by category. `fact` names the entry in `detectKnownFacts`
 * that makes a question redundant; questions without a `fact` are always eligible.
 */
const QUESTION_BANK = {
  Plumbing: [
    {
      id: 'flow_rate',
      fact: 'severity',
      question: 'How fast is the water coming out?',
      options: [
        { label: 'Slow drip', detail: 'A few drops a minute' },
        { label: 'Steady trickle', detail: 'Constant but small' },
        { label: 'Fast stream', detail: 'Visibly running' },
        { label: 'Pouring or spraying', detail: 'Water going everywhere' },
      ],
    },
    {
      id: 'leak_source',
      fact: 'source',
      question: 'Where is the water actually coming from?',
      options: [
        { label: 'Pipes underneath' },
        { label: 'The faucet or handle' },
        { label: 'Around the base' },
        { label: 'The drain line' },
        { label: 'Not sure' },
      ],
    },
    {
      id: 'water_damage',
      fact: 'damage',
      question: 'How much damage is there so far?',
      options: [
        { label: 'None visible' },
        { label: 'Cabinet or floor is damp' },
        { label: 'Water pooling on the floor' },
        { label: 'Wood is soft or warped' },
        { label: 'Mold or musty smell' },
      ],
    },
    {
      id: 'water_shutoff',
      fact: 'shutoff',
      question: 'Can the water be shut off at that fixture?',
      options: [
        { label: 'Already shut it off' },
        { label: 'There is a valve, still on' },
        { label: 'No shutoff valve there' },
        { label: 'Not sure' },
      ],
    },
  ],
  Electrical: [
    {
      id: 'electrical_scope',
      fact: 'severity',
      question: 'How much is affected?',
      options: [
        { label: 'One outlet or fixture' },
        { label: 'One room' },
        { label: 'Several rooms' },
        { label: 'The whole property' },
      ],
    },
    {
      id: 'electrical_danger',
      question: 'Any of these happening right now?',
      options: [
        { label: 'Sparks' },
        { label: 'Burning smell' },
        { label: 'Hot outlet or panel' },
        { label: 'Buzzing sound' },
        { label: 'None of these' },
      ],
      allowMultiple: true,
    },
    {
      id: 'breaker_state',
      question: 'What happens at the breaker?',
      options: [
        { label: 'Breaker keeps tripping' },
        { label: 'Reset it and it held' },
        { label: 'Breaker looks normal' },
        { label: "Haven't checked" },
      ],
    },
  ],
  HVAC: [
    {
      id: 'hvac_mode',
      question: 'What is not working?',
      options: [
        { label: 'Heat' },
        { label: 'Air conditioning' },
        { label: 'Both' },
        { label: 'Fan or airflow only' },
      ],
    },
    {
      id: 'hvac_behavior',
      fact: 'severity',
      question: 'What is the system doing?',
      options: [
        { label: 'Runs but wrong temperature' },
        { label: 'Turns on then shuts off' },
        { label: 'Will not turn on at all' },
        { label: 'Running but making noise' },
        { label: 'Leaking water' },
      ],
    },
    {
      id: 'hvac_habitability',
      question: 'How bad is it inside right now?',
      options: [
        { label: 'Uncomfortable but fine' },
        { label: 'Getting hard to tolerate' },
        { label: 'Unsafe temperature' },
        { label: 'Nobody is there right now' },
      ],
    },
  ],
  Appliances: [
    {
      id: 'appliance_symptom',
      fact: 'severity',
      question: 'What is it doing?',
      options: [
        { label: 'Will not turn on' },
        { label: 'Turns on but does not work right' },
        { label: 'Leaking' },
        { label: 'Making a loud noise' },
        { label: 'Showing an error code' },
      ],
    },
    {
      id: 'appliance_usable',
      question: 'Is it still usable?',
      options: [
        { label: 'Yes, just annoying' },
        { label: 'Partly usable' },
        { label: 'Completely unusable' },
      ],
    },
  ],
  Structural: [
    {
      id: 'structural_kind',
      question: 'What are you seeing?',
      options: [
        { label: 'Crack' },
        { label: 'Water stain' },
        { label: 'Sagging or bowing' },
        { label: 'Hole or missing material' },
        { label: 'Something came loose' },
      ],
    },
    {
      id: 'structural_trend',
      fact: 'severity',
      question: 'Is it getting worse?',
      options: [
        { label: 'Looks the same as always' },
        { label: 'Slowly getting worse' },
        { label: 'Noticeably worse this week' },
        { label: 'Actively falling or shifting' },
      ],
    },
  ],
  'Pest Control': [
    {
      id: 'pest_type',
      question: 'What are you seeing?',
      options: [
        { label: 'Mice or rats' },
        { label: 'Roaches' },
        { label: 'Ants' },
        { label: 'Wasps or bees' },
        { label: 'Termites' },
        { label: 'Something else' },
      ],
    },
    {
      id: 'pest_extent',
      fact: 'severity',
      question: 'How widespread is it?',
      options: [
        { label: 'Saw one or two' },
        { label: 'Several in one area' },
        { label: 'All over the property' },
        { label: 'Found a nest' },
      ],
    },
  ],
  'Lock/Security': [
    {
      id: 'security_problem',
      question: 'What is wrong?',
      options: [
        { label: 'Lock will not latch' },
        { label: 'Key or code does not work' },
        { label: 'Door or frame damaged' },
        { label: 'Window will not secure' },
        { label: 'Lost key or code' },
      ],
    },
    {
      id: 'security_state',
      fact: 'severity',
      question: 'Is the property secure right now?',
      options: [
        { label: 'Yes, secure' },
        { label: 'Secure but hard to use' },
        { label: 'No, it cannot be locked' },
        { label: 'Someone is locked out' },
      ],
    },
  ],
  Other: [
    {
      id: 'general_severity',
      fact: 'severity',
      question: 'How bad is it right now?',
      options: [
        { label: 'Minor annoyance' },
        { label: 'Noticeable problem' },
        { label: 'Cannot use the space' },
        { label: 'Causing damage right now' },
      ],
    },
    {
      id: 'general_damage',
      fact: 'damage',
      question: 'Is anything getting damaged?',
      options: [
        { label: 'No damage' },
        { label: 'Some damage starting' },
        { label: 'Active damage spreading' },
      ],
    },
  ],
};

const LOCATION_QUESTION = {
  id: 'room',
  fact: 'location',
  question: 'Which area is affected?',
  options: [
    { label: 'Kitchen' },
    { label: 'Bathroom' },
    { label: 'Basement' },
    { label: 'Bedroom' },
    { label: 'Laundry room' },
    { label: 'Outside' },
    { label: 'Somewhere else' },
  ],
};

const DURATION_QUESTION = {
  id: 'duration',
  fact: 'duration',
  question: 'How long has this been going on?',
  options: [
    { label: 'Started today' },
    { label: 'A few days' },
    { label: 'A week or more' },
    { label: 'Comes and goes' },
  ],
};

export const MAX_CHOICE_QUESTIONS = 3;

/**
 * Picks the highest-value questions still worth asking, skipping anything the
 * submitter already answered either in prose or by tapping an option.
 */
export function buildChoiceQuestions({ category = 'Other', text = '', answeredIds = [] } = {}) {
  const facts = detectKnownFacts(text);
  const answered = new Set(answeredIds || []);
  const bank = QUESTION_BANK[category] || QUESTION_BANK.Other;

  return [LOCATION_QUESTION, ...bank, DURATION_QUESTION]
    .filter((entry) => !answered.has(entry.id))
    .filter((entry) => !entry.fact || !facts[entry.fact])
    .slice(0, MAX_CHOICE_QUESTIONS)
    .map((entry) => ({
      id: entry.id,
      question: entry.question,
      allowMultiple: Boolean(entry.allowMultiple),
      options: entry.options.map((option, index) => ({
        id: `${entry.id}_${index}`,
        label: option.label,
        detail: option.detail || '',
      })),
    }));
}

function slugify(value, fallback) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

/**
 * Coerces model-generated questions into renderable shape, dropping anything
 * without at least two real options so the UI never shows a dead chip row.
 */
export function normalizeChoiceQuestions(raw, { answeredIds = [] } = {}) {
  if (!Array.isArray(raw)) return [];
  const answered = new Set(answeredIds || []);
  const seen = new Set();
  const questions = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;

    const question = String(entry.question || entry.prompt || '').trim();
    if (!question) continue;

    const id = slugify(entry.id, slugify(question, `q_${questions.length}`));
    if (seen.has(id) || answered.has(id)) continue;

    const options = [];
    const seenLabels = new Set();
    for (const option of Array.isArray(entry.options) ? entry.options : []) {
      const label = String(typeof option === 'string' ? option : option?.label || '').trim();
      if (!label || label.length > 60) continue;
      const key = label.toLowerCase();
      if (seenLabels.has(key)) continue;
      seenLabels.add(key);
      options.push({
        id: `${id}_${options.length}`,
        label,
        detail: String((typeof option === 'object' && option?.detail) || '').trim().slice(0, 80),
      });
      if (options.length >= 6) break;
    }

    if (options.length < 2) continue;

    seen.add(id);
    questions.push({
      id,
      question,
      allowMultiple: Boolean(entry.allowMultiple),
      options,
    });
    if (questions.length >= MAX_CHOICE_QUESTIONS) break;
  }

  return questions;
}

/**
 * Builds the Gemini instruction for one intake turn.
 *
 * Lives here rather than inline in the route so the prompt and the question-shape
 * contract it promises stay in one place, and so tests exercise the real text.
 */
export function buildTriagePrompt({
  speaker = 'tenant',
  message = '',
  sanitizedMessages = [],
  currentDraft = {},
  knownFacts = {},
  answeredIds = [],
} = {}) {
  const speakerLabel = speaker === 'owner' ? 'property owner' : 'tenant';
  const statedFacts = Object.entries(knownFacts)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}: ${value}`);

  return `You are a maintenance intake assistant talking to a ${speakerLabel}. Gather the minimum high-value details needed to dispatch the right contractor.

HOW YOU ASK QUESTIONS
- You do not ask open-ended questions. Every question you ask comes with 3-5 concrete tappable answer options.
- Options must be specific to the issue they described, not generic. If they said "leak under the kitchen sink", severity options look like "Slow drip", "Steady trickle", "Fast stream", "Pouring or spraying" — never "Low / Medium / High".
- Write options as short noun phrases a person can recognize instantly. Max 5 words each. Add an optional one-line "detail" to disambiguate.
- Always include an escape option such as "Not sure" or "Something else" when a wrong guess would be costly.
- Ask at most ${MAX_CHOICE_QUESTIONS} questions per turn, ordered by how much they change which contractor gets dispatched.
- Set allowMultiple true only when several answers can be true at once (for example symptoms present right now).

WHAT YOU MUST NOT DO
- NEVER ask about a detail the ${speakerLabel} already stated. They told you these already: ${statedFacts.length ? statedFacts.join('; ') : '(nothing yet)'}
- If they named a room or fixture, that IS the location. Do not ask which room.
- Do not re-ask questions with these ids, which they already answered: ${answeredIds.length ? answeredIds.join(', ') : '(none)'}
- Do not ask more than one question about the same underlying detail.

REPLY TEXT
- Open by reflecting back what you understood in one short clause, so they can tell you were listening ("Got it — slow leak under the kitchen sink.").
- Then one sentence at most. The options carry the conversation, not your prose.
- Never claim you called 911 or dispatched anyone.

TRIAGE FIELDS
- category: exactly one of Plumbing, Electrical, HVAC, Appliances, Structural, Pest Control, Lock/Security, Other.
- priority: exactly one of low, normal, urgent.
- location: the specific spot, for example "Kitchen sink" or "Basement water heater". Fill this in from what they said; leave it empty only if truly unstated.
- summary: one line written back to the ${speakerLabel}.
- ownerSummary: dispatch-ready summary with issue, severity, and location.
- readyToSubmit: true only when a contractor could be dispatched from this alone. When true, return an empty questions array.
- emergencyLevel: none, urgent, or call_911. Use call_911 only for active break-in, uncontrollable fire, explosion, violence, or another immediate threat to life. Tell them to call 911 themselves.
- suggestedActions: safe damage-control steps only, such as shutting off water at the valve.${speaker === 'owner' ? `

OWNER CONTEXT
- You are speaking with the property owner, not an occupant. Never tell them to contact their landlord or property manager, and never ask who their landlord is.
- Whether anyone is currently at the property is useful for access planning; ask it as a choice question, not open text.` : ''}

Return only JSON in exactly this shape:
{
  "reply": "string",
  "questions": [
    {
      "id": "short_snake_case_id",
      "question": "string",
      "allowMultiple": false,
      "options": [
        { "label": "string", "detail": "string" }
      ]
    }
  ],
  "triage": {
    "category": "Plumbing|Electrical|HVAC|Appliances|Structural|Pest Control|Lock/Security|Other",
    "priority": "low|normal|urgent",
    "location": "string",
    "summary": "string",
    "ownerSummary": "string",
    "serviceTypeHint": "string",
    "readyToSubmit": false,
    "emergencyLevel": "none|urgent|call_911",
    "emergencyGuidance": "string",
    "suggestedActions": ["string"]
  }
}

Conversation so far:
${JSON.stringify(sanitizedMessages, null, 2)}

Current draft:
${JSON.stringify(currentDraft || {}, null, 2)}

Newest ${speakerLabel} message:
${String(message).trim()}`;
}

/** Category guess used to select a question bank when the model is unavailable. */
export function detectCategory(text = '') {
  const normalized = String(text || '').toLowerCase();
  if (/sink|toilet|faucet|pipe|drain|water heater|leak|flood|overflow|sewage|sump/.test(normalized)) return 'Plumbing';
  if (/outlet|breaker|electrical|spark|burning wire|no power|light switch|fuse/.test(normalized)) return 'Electrical';
  if (/heat|heating|\bac\b|air conditioning|furnace|thermostat|hvac|vent|duct/.test(normalized)) return 'HVAC';
  if (/washer|dryer|dishwasher|refrigerator|fridge|oven|stove|microwave|disposal|appliance/.test(normalized)) return 'Appliances';
  if (/lock|deadbolt|key|door won|window won|break-?in|security/.test(normalized)) return 'Lock/Security';
  if (/bug|roach|rodent|mice|rat|termite|pest|ant|wasp|bee/.test(normalized)) return 'Pest Control';
  if (/ceiling|wall|floor|roof|foundation|drywall|crack|sagging|siding/.test(normalized)) return 'Structural';
  return 'Other';
}
