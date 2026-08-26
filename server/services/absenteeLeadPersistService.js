/**
 * Persist absentee leads to SQLite (campaign queue) with enrichment fields.
 * Upserts by attom_id when present; preserves status/notes on re-save.
 */

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function ensureAbsenteeLeadsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS absentee_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attom_id TEXT UNIQUE,
      address TEXT NOT NULL,
      city TEXT,
      state TEXT,
      zip_code TEXT,
      property_type TEXT,
      beds INTEGER,
      baths REAL,
      sqft INTEGER,
      year_built INTEGER,
      assessed_value INTEGER,
      market_value INTEGER,
      owner_name TEXT,
      owner_name2 TEXT,
      is_corporate INTEGER,
      mailing_address TEXT,
      ownership_years INTEGER,
      likely_free_and_clear INTEGER,
      motivation_score INTEGER,
      motivation_factors TEXT,
      latitude REAL,
      longitude REAL,
      campaign_name TEXT,
      status TEXT DEFAULT 'new',
      notes TEXT,
      last_contact_date TEXT,
      rental_confidence INTEGER,
      leak_risk_score INTEGER,
      protection_lead_score INTEGER,
      enrichment_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  ensureColumn(db, 'absentee_leads', 'rental_confidence', 'INTEGER');
  ensureColumn(db, 'absentee_leads', 'leak_risk_score', 'INTEGER');
  ensureColumn(db, 'absentee_leads', 'protection_lead_score', 'INTEGER');
  ensureColumn(db, 'absentee_leads', 'enrichment_json', 'TEXT');
}

function enrichmentPayload(lead) {
  const hasEnrichment = lead.rentalConfidence != null
    || lead.leakRiskScore != null
    || lead.protectionLeadScore != null
    || lead.rentEstimate != null
    || lead.ownerEmail
    || lead.ownerPhone
    || lead.ownerContact
    || lead.enrichedAt;

  if (!hasEnrichment) return null;

  return {
    rentalConfidence: lead.rentalConfidence ?? null,
    rentalConfidenceLabel: lead.rentalConfidenceLabel ?? null,
    rentEstimate: lead.rentEstimate ?? null,
    grossYield: lead.grossYield ?? null,
    activeRentalListingMatch: lead.activeRentalListingMatch ?? null,
    listedForRent: lead.listedForRent ?? null,
    everListedForRent: lead.everListedForRent ?? null,
    listedInLast90Days: lead.listedInLast90Days ?? null,
    listedInLast5Years: lead.listedInLast5Years ?? null,
    lastListedDate: lead.lastListedDate ?? null,
    ownerDistanceMiles: lead.ownerDistanceMiles ?? null,
    ownerDistanceBand: lead.ownerDistanceBand ?? null,
    ownerPortfolioCount: lead.ownerPortfolioCount ?? null,
    ownerPortfolioBand: lead.ownerPortfolioBand ?? null,
    taxOverAssessmentFlag: lead.taxOverAssessmentFlag ?? null,
    taxEquityExcessPct: lead.taxEquityExcessPct ?? null,
    taxAnnualSavingsLow: lead.taxAnnualSavingsLow ?? null,
    taxAnnualSavingsHigh: lead.taxAnnualSavingsHigh ?? null,
    taxOverAssessmentNarrative: lead.taxOverAssessmentNarrative ?? null,
    taxAppealDeadline: lead.taxAppealDeadline ?? null,
    leakRiskScore: lead.leakRiskScore ?? null,
    leakRiskLabel: lead.leakRiskLabel ?? null,
    leakRiskSignals: lead.leakRiskSignals ?? null,
    plumbingPermitCount: lead.plumbingPermitCount ?? null,
    recentPlumbingPermit: lead.recentPlumbingPermit ?? null,
    protectionLeadScore: lead.protectionLeadScore ?? null,
    ownerEmail: lead.ownerEmail ?? null,
    ownerPhone: lead.ownerPhone ?? null,
    ownerContact: lead.ownerContact ?? null,
    enrichedAt: lead.enrichedAt ?? null,
    fromCache: lead.fromCache ?? null,
  };
}

/**
 * Upsert leads into absentee_leads. Preserves status/notes for existing rows.
 */
export function upsertAbsenteeLeads(db, leads = [], campaignName = 'default') {
  ensureAbsenteeLeadsTable(db);

  const findByAttom = db.prepare('SELECT id, status, notes, campaign_name FROM absentee_leads WHERE attom_id = ?');
  const findByAddress = db.prepare("SELECT id, status, notes, campaign_name FROM absentee_leads WHERE address = ? AND (attom_id IS NULL OR attom_id = '')");

  const insertStmt = db.prepare(`
    INSERT INTO absentee_leads (
      attom_id, address, city, state, zip_code, property_type,
      beds, baths, sqft, year_built, assessed_value, market_value,
      owner_name, owner_name2, is_corporate, mailing_address,
      ownership_years, likely_free_and_clear, motivation_score, motivation_factors,
      latitude, longitude, campaign_name, status,
      rental_confidence, leak_risk_score, protection_lead_score, enrichment_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const updateStmt = db.prepare(`
    UPDATE absentee_leads SET
      address = ?,
      city = ?,
      state = ?,
      zip_code = ?,
      property_type = ?,
      beds = ?,
      baths = ?,
      sqft = ?,
      year_built = ?,
      assessed_value = ?,
      market_value = ?,
      owner_name = ?,
      owner_name2 = ?,
      is_corporate = ?,
      mailing_address = ?,
      ownership_years = ?,
      likely_free_and_clear = ?,
      motivation_score = ?,
      motivation_factors = ?,
      latitude = ?,
      longitude = ?,
      campaign_name = COALESCE(?, campaign_name),
      rental_confidence = COALESCE(?, rental_confidence),
      leak_risk_score = COALESCE(?, leak_risk_score),
      protection_lead_score = COALESCE(?, protection_lead_score),
      enrichment_json = COALESCE(?, enrichment_json),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  let inserted = 0;
  let updated = 0;
  const savedLeads = [];

  const run = db.transaction((rows) => {
    for (const lead of rows) {
      if (!lead?.address) continue;

      const enrich = enrichmentPayload(lead);
      const enrichJson = enrich ? JSON.stringify(enrich) : null;
      const existing = lead.attomId
        ? findByAttom.get(String(lead.attomId))
        : findByAddress.get(lead.address);

      const common = [
        lead.address,
        lead.city || null,
        lead.state || null,
        lead.zipCode || null,
        lead.propertyType || null,
        lead.beds ?? null,
        lead.baths ?? null,
        lead.sqft ?? null,
        lead.yearBuilt ?? null,
        lead.assessedValue ?? null,
        lead.marketValue ?? null,
        lead.owner?.name || null,
        lead.owner?.name2 || null,
        lead.owner?.isCorporate ? 1 : 0,
        lead.owner?.mailingAddress || null,
        lead.ownershipYears ?? null,
        lead.likelyFreeAndClear ? 1 : 0,
        lead.motivationScore ?? null,
        JSON.stringify(lead.motivationFactors || []),
        lead.latitude ?? null,
        lead.longitude ?? null,
      ];

      if (existing?.id) {
        updateStmt.run(
          ...common,
          campaignName || existing.campaign_name || 'default',
          lead.rentalConfidence ?? null,
          lead.leakRiskScore ?? null,
          lead.protectionLeadScore ?? null,
          enrichJson,
          existing.id,
        );
        updated += 1;
        savedLeads.push({
          id: existing.id,
          attom_id: lead.attomId || null,
          address: lead.address,
          campaign_name: campaignName || existing.campaign_name,
          status: existing.status,
        });
      } else {
        const result = insertStmt.run(
          lead.attomId ? String(lead.attomId) : null,
          ...common,
          campaignName || 'default',
          'new',
          lead.rentalConfidence ?? null,
          lead.leakRiskScore ?? null,
          lead.protectionLeadScore ?? null,
          enrichJson,
        );
        inserted += 1;
        const row = lead.attomId
          ? db.prepare('SELECT id, attom_id, address, campaign_name, status FROM absentee_leads WHERE attom_id = ?').get(String(lead.attomId))
          : db.prepare('SELECT id, attom_id, address, campaign_name, status FROM absentee_leads WHERE rowid = ?').get(result.lastInsertRowid);
        if (row) savedLeads.push(row);
      }
    }
  });

  run(leads);

  return {
    inserted,
    updated,
    total: leads.length,
    saved: inserted + updated,
    savedLeads,
    campaignName: campaignName || 'default',
  };
}

export async function persistAbsenteeLeads(leads = [], campaignName = 'default') {
  const { getDb } = await import('../db/connection.js');
  const db = getDb();
  return upsertAbsenteeLeads(db, leads, campaignName);
}
