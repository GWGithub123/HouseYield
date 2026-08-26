/**
 * HouseYield internal ops — account lookup, install kits, bench provisioning helpers.
 */

import express from 'express';
import { getAuth, getFirestore } from '../firebase-admin.js';
import { requireInternalStaff } from '../middleware/internalStaff.js';
import { getOwnerProperties, getPropertyById } from '../property-firestore-service.js';
import {
  getInstallKit,
  recordProvisionedDevice,
  upsertInstallKit,
} from '../services/installKitService.js';
import { listLeadMarketPresets } from '../config/leadMarketPresets.js';
import { enrichAbsenteeLead, enrichAbsenteeLeads, buildEnrichmentContext } from '../services/leadEnrichmentService.js';
import { ensureAbsenteeLeadsTable, persistAbsenteeLeads } from '../services/absenteeLeadPersistService.js';
import { lookupOwnerContact } from '../owner-contact-lookup.js';
import { generateOutreachEmail } from '../ai-outreach-generator.js';
import { lookupAbsenteeLeadByAddress } from '../attom.js';

const router = express.Router();

router.use(requireInternalStaff);

function getSqliteDb() {
  return import('../db/connection.js').then((mod) => mod.getDb());
}

function ensureOutreachTables(db) {
  ensureAbsenteeLeadsTable(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS outreach_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      property_address TEXT,
      recipient_email TEXT,
      subject TEXT,
      body TEXT,
      status TEXT,
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
      response_received INTEGER DEFAULT 0,
      response_date TEXT,
      notes TEXT
    )
  `);
}

function mapDbLeadToPayload(lead) {
  let enrichment = {};
  if (lead.enrichment_json) {
    try {
      enrichment = JSON.parse(lead.enrichment_json);
    } catch {
      enrichment = {};
    }
  }

  return {
    id: lead.id,
    attomId: lead.attom_id,
    address: lead.address,
    city: lead.city,
    state: lead.state,
    zipCode: lead.zip_code,
    propertyType: lead.property_type,
    beds: lead.beds,
    baths: lead.baths,
    sqft: lead.sqft,
    yearBuilt: lead.year_built,
    assessedValue: lead.assessed_value,
    marketValue: lead.market_value,
    owner: {
      name: lead.owner_name,
      name2: lead.owner_name2,
      isCorporate: lead.is_corporate === 1,
      mailingAddress: lead.mailing_address,
    },
    ownershipYears: lead.ownership_years,
    likelyFreeAndClear: lead.likely_free_and_clear === 1,
    motivationScore: lead.motivation_score,
    motivationFactors: lead.motivation_factors ? JSON.parse(lead.motivation_factors) : [],
    latitude: lead.latitude,
    longitude: lead.longitude,
    campaignName: lead.campaign_name,
    status: lead.status,
    notes: lead.notes,
    lastContactDate: lead.last_contact_date,
    rentalConfidence: lead.rental_confidence ?? enrichment.rentalConfidence ?? null,
    rentalConfidenceLabel: enrichment.rentalConfidenceLabel ?? null,
    rentEstimate: enrichment.rentEstimate ?? null,
    leakRiskScore: lead.leak_risk_score ?? enrichment.leakRiskScore ?? null,
    leakRiskLabel: enrichment.leakRiskLabel ?? null,
    protectionLeadScore: lead.protection_lead_score ?? enrichment.protectionLeadScore ?? null,
    ...enrichment,
  };
}

router.get('/market-presets', (_req, res) => {
  res.json({ ok: true, presets: listLeadMarketPresets() });
});

/**
 * Single-address lead lookup: owner + rental enrichment + approximate portfolio.
 * GET /api/internal/lead-lookup?address=...&includeTax=true&includePortfolio=true
 */
router.get('/lead-lookup', async (req, res) => {
  try {
    const address = String(req.query.address || '').trim();
    if (!address) {
      return res.status(400).json({ ok: false, error: 'address is required' });
    }

    const includeTax = String(req.query.includeTax || '').toLowerCase() === 'true';
    const includePortfolio = String(req.query.includePortfolio || 'true').toLowerCase() !== 'false';
    const skipCache = String(req.query.skipCache || '').toLowerCase() === 'true';
    const save = String(req.query.save || '').toLowerCase() === 'true';
    const campaignName = String(req.query.campaignName || 'address-lookup').trim() || 'address-lookup';

    console.log(`[InternalOps] Lead lookup for: ${address}`);
    const result = await lookupAbsenteeLeadByAddress(address, {
      includePortfolioEstimate: includePortfolio,
    });

    if (!result.ok) {
      const status = /not found/i.test(result.error || '') ? 404 : 502;
      return res.status(status).json({ ok: false, error: result.error || 'Lookup failed' });
    }

    const enrichment = await enrichAbsenteeLead(result.lead, {
      includeRentcast: true,
      includeLeakRisk: true,
      includePermits: true,
      includeTaxOverAssessment: includeTax,
      skipCache,
    });

    const lead = {
      ...result.lead,
      ...enrichment,
      // Keep portfolio fields from ATTOM lookup (enrichment may overwrite with null from cache).
      ownerPortfolioCount: result.lead.ownerPortfolioCount ?? enrichment.ownerPortfolioCount ?? null,
      ownerPortfolioBand: result.lead.ownerPortfolioBand ?? enrichment.ownerPortfolioBand ?? null,
      ownerPortfolioApproximate: result.lead.ownerPortfolioApproximate ?? true,
      ownerPortfolioScope: result.lead.ownerPortfolioScope ?? null,
    };

    let saved = null;
    if (save) {
      saved = await persistAbsenteeLeads([lead], campaignName);
    }

    res.json({
      ok: true,
      lead,
      portfolio: result.portfolio || null,
      fromCache: Boolean(enrichment.fromCache),
      saved,
    });
  } catch (error) {
    console.error('[InternalOps] lead-lookup failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/leads/enrich', async (req, res) => {
  try {
    const { leads, limit = 25, sortBy = 'protectionLeadScore' } = req.body || {};
    if (!Array.isArray(leads) || !leads.length) {
      return res.status(400).json({ ok: false, error: 'leads array is required' });
    }

    const result = await enrichAbsenteeLeads(leads, {
      limit,
      includeRentcast: true,
      includeLeakRisk: true,
      sortBy,
    });

    res.json({
      ok: true,
      leads: result.leads,
      enrichedCount: result.enrichedCount,
      limit: result.limit,
    });
  } catch (error) {
    console.error('[InternalOps] enrich leads failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/campaigns', async (_req, res) => {
  try {
    const db = await getSqliteDb();
    ensureOutreachTables(db);

    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='absentee_leads'
    `).get();
    if (!tableExists) {
      return res.json({ ok: true, campaigns: [] });
    }

    const campaigns = db.prepare(`
      SELECT
        campaign_name AS name,
        COUNT(*) AS leadCount,
        SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) AS contactedCount,
        SUM(CASE WHEN status = 'draft_ready' THEN 1 ELSE 0 END) AS draftReadyCount,
        MAX(updated_at) AS updatedAt
      FROM absentee_leads
      WHERE campaign_name IS NOT NULL AND campaign_name != ''
      GROUP BY campaign_name
      ORDER BY updatedAt DESC
    `).all();

    res.json({ ok: true, campaigns });
  } catch (error) {
    console.error('[InternalOps] list campaigns failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/campaigns/:campaignName/leads', async (req, res) => {
  try {
    const campaignName = decodeURIComponent(req.params.campaignName);
    const status = req.query.status ? String(req.query.status) : null;
    const db = await getSqliteDb();
    ensureOutreachTables(db);

    let query = `
      SELECT * FROM absentee_leads
      WHERE campaign_name = ?
    `;
    const params = [campaignName];
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ` ORDER BY
      COALESCE(protection_lead_score, 0) DESC,
      COALESCE(motivation_score, 0) DESC,
      updated_at DESC
    `;

    const rows = db.prepare(query).all(...params);
    const leads = rows.map(mapDbLeadToPayload);

    let draftByLead = new Map();
    if (leads.length) {
      const draftCounts = db.prepare(`
        SELECT lead_id, COUNT(*) AS draftCount
        FROM outreach_log
        WHERE status = 'draft'
          AND lead_id IN (${leads.map(() => '?').join(',')})
        GROUP BY lead_id
      `).all(...leads.map((lead) => lead.id));
      draftByLead = new Map(draftCounts.map((row) => [row.lead_id, row.draftCount]));
    }

    const withDraftMeta = leads.map((lead) => ({
      ...lead,
      draftCount: draftByLead.get(lead.id) || 0,
      hasDraft: (draftByLead.get(lead.id) || 0) > 0,
    }));

    res.json({
      ok: true,
      campaignName,
      total: withDraftMeta.length,
      leads: withDraftMeta,
    });
  } catch (error) {
    console.error('[InternalOps] campaign leads failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/campaigns/:campaignName/queue', async (req, res) => {
  try {
    const campaignName = decodeURIComponent(req.params.campaignName);
    const db = await getSqliteDb();
    ensureOutreachTables(db);

    const leads = db.prepare(`
      SELECT * FROM absentee_leads
      WHERE campaign_name = ?
      ORDER BY motivation_score DESC, created_at DESC
    `).all(campaignName);

    const drafts = db.prepare(`
      SELECT ol.*, al.address AS lead_address, al.owner_name
      FROM outreach_log ol
      LEFT JOIN absentee_leads al ON al.id = ol.lead_id
      WHERE ol.status = 'draft'
      AND al.campaign_name = ?
      ORDER BY ol.sent_at DESC
    `).all(campaignName);

    res.json({
      ok: true,
      campaignName,
      leads: leads.map(mapDbLeadToPayload),
      drafts,
      total: leads.length,
    });
  } catch (error) {
    console.error('[InternalOps] campaign queue failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/campaigns/:campaignName/prepare', async (req, res) => {
  try {
    const campaignName = decodeURIComponent(req.params.campaignName);
    const {
      limit = 10,
      purpose = 'iot_protection',
      buyer = {},
      tone = 'professional',
      leadIds = null,
    } = req.body || {};

    const db = await getSqliteDb();
    ensureOutreachTables(db);

    const maxLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
    let rows = [];

    if (Array.isArray(leadIds) && leadIds.length) {
      const ids = leadIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
        .slice(0, maxLimit);
      if (ids.length) {
        rows = db.prepare(`
          SELECT * FROM absentee_leads
          WHERE campaign_name = ?
            AND id IN (${ids.map(() => '?').join(',')})
          ORDER BY motivation_score DESC
        `).all(campaignName, ...ids);
      }
    } else {
      rows = db.prepare(`
        SELECT * FROM absentee_leads
        WHERE campaign_name = ?
        AND status IN ('new', 'draft_ready')
        ORDER BY motivation_score DESC
        LIMIT ?
      `).all(campaignName, maxLimit);
    }

    if (!rows.length) {
      return res.json({ ok: true, prepared: 0, drafts: [], message: 'No leads to prepare' });
    }

    const leadPayloads = rows.map(mapDbLeadToPayload);
    const enriched = await enrichAbsenteeLeads(leadPayloads, {
      limit: leadPayloads.length,
      includeRentcast: true,
      includeLeakRisk: true,
      sortBy: 'protectionLeadScore',
    });

    const drafts = [];
    for (const lead of enriched.leads.slice(0, maxLimit)) {
      const contact = await lookupOwnerContact(lead.owner, {
        address: lead.address,
        city: lead.city,
        state: lead.state,
        zipCode: lead.zipCode,
      });

      const emailResult = await generateOutreachEmail({
        property: lead,
        owner: lead.owner,
        buyer: {
          name: buyer.name || 'HouseYield Team',
          company: buyer.company || 'HouseYield',
          email: buyer.email || '',
          phone: buyer.phone || '',
        },
        offer: {},
        insuranceEstimate: lead.insuranceEstimate,
        purpose,
        tone,
        questions: [],
        enrichmentContext: buildEnrichmentContext(lead),
      });

      const recipientEmail = contact?.email || null;
      const subject = emailResult.ok ? emailResult.email.subject : `Remote water protection for ${lead.address}`;
      const body = emailResult.ok ? emailResult.email.body : 'Draft generation failed — edit manually.';

      const existingDraft = db.prepare(`
        SELECT id FROM outreach_log
        WHERE lead_id = ? AND status = 'draft'
        ORDER BY id DESC LIMIT 1
      `).get(lead.id);

      if (existingDraft) {
        db.prepare(`
          UPDATE outreach_log
          SET recipient_email = ?, subject = ?, body = ?, notes = ?, sent_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          recipientEmail,
          subject,
          body,
          JSON.stringify({ contactConfidence: contact?.confidence || null, enrichment: lead }),
          existingDraft.id,
        );
        drafts.push({ id: existingDraft.id, leadId: lead.id, address: lead.address, recipientEmail, subject, body, contact });
      } else {
        const insert = db.prepare(`
          INSERT INTO outreach_log (lead_id, property_address, recipient_email, subject, body, status, notes)
          VALUES (?, ?, ?, ?, ?, 'draft', ?)
        `).run(
          lead.id,
          lead.address,
          recipientEmail,
          subject,
          body,
          JSON.stringify({ contactConfidence: contact?.confidence || null, enrichment: lead }),
        );
        drafts.push({
          id: insert.lastInsertRowid,
          leadId: lead.id,
          address: lead.address,
          recipientEmail,
          subject,
          body,
          contact,
        });
      }

      db.prepare(`
        UPDATE absentee_leads
        SET status = 'draft_ready', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(lead.id);
    }

    res.json({
      ok: true,
      prepared: drafts.length,
      drafts,
      campaignName,
    });
  } catch (error) {
    console.error('[InternalOps] prepare campaign failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

function pickAccountFields(uid, authUser, firestoreData = {}) {
  const profile = firestoreData.ownerProfile || {};
  return {
    id: uid,
    email: authUser?.email || firestoreData.email || null,
    displayName: profile.fullName
      || profile.name
      || firestoreData.displayName
      || authUser?.displayName
      || null,
    onboardingStatus: firestoreData.onboardingStatus || null,
    planId: firestoreData.planId || firestoreData.selectedPlanId || null,
    createdAt: firestoreData.createdAt || authUser?.metadata?.creationTime || null,
  };
}

router.get('/accounts', async (req, res) => {
  try {
    const db = getFirestore();
    const auth = getAuth();
    const search = String(req.query.search || '').trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);

    const [authList, userDocs, propertySnap] = await Promise.all([
      auth.listUsers(1000),
      db.collection('users').get(),
      db.collection('properties').get(),
    ]);

    const firestoreById = new Map(userDocs.docs.map((doc) => [doc.id, doc.data() || {}]));
    const propertyCounts = new Map();
    propertySnap.docs.forEach((doc) => {
      const ownerId = doc.data()?.ownerId;
      if (ownerId) {
        propertyCounts.set(ownerId, (propertyCounts.get(ownerId) || 0) + 1);
      }
    });

    const merged = new Map();

    authList.users.forEach((user) => {
      merged.set(user.uid, pickAccountFields(user.uid, user, firestoreById.get(user.uid)));
    });

    firestoreById.forEach((data, uid) => {
      if (!merged.has(uid)) {
        merged.set(uid, pickAccountFields(uid, null, data));
      }
    });

    let accounts = [...merged.values()].map((account) => ({
      ...account,
      propertyCount: propertyCounts.get(account.id) || 0,
    }));

    if (search) {
      accounts = accounts.filter((account) => (
        String(account.email || '').toLowerCase().includes(search)
        || String(account.displayName || '').toLowerCase().includes(search)
        || account.id.toLowerCase().includes(search)
      ));
    }

    accounts.sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));
    accounts = accounts.slice(0, limit);

    res.json({ success: true, count: accounts.length, accounts });
  } catch (error) {
    console.error('[InternalOps] list accounts failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/accounts/:ownerId/properties', async (req, res) => {
  try {
    const { ownerId } = req.params;
    const result = await getOwnerProperties(ownerId);
    if (!result.ok) {
      return res.status(500).json({ success: false, error: result.error || 'Failed to load properties' });
    }

    const properties = await Promise.all((result.properties || []).map(async (property) => {
      const kit = await getInstallKit(property.id);
      return {
        id: property.id,
        address: property.address || property.formattedAddress || property.name || property.id,
        ownerId: property.ownerId,
        installKitStatus: kit?.status || null,
        wifiConfigured: Boolean(kit?.wifiSsid),
        provisionedDeviceCount: kit?.provisionedDevices?.length || 0,
      };
    }));

    res.json({ success: true, count: properties.length, properties });
  } catch (error) {
    console.error('[InternalOps] list properties failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/install-kits/:propertyId', async (req, res) => {
  try {
    const kit = await getInstallKit(req.params.propertyId);
    if (!kit) {
      return res.json({ success: true, kit: null });
    }
    res.json({ success: true, kit });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/install-kits/:propertyId', async (req, res) => {
  try {
    const { propertyId } = req.params;
    const {
      ownerId,
      propertyLabel,
      wifiSsid,
      wifiPassword,
      networkType,
      customerContact,
      installNotes,
      status,
    } = req.body || {};

    if (!ownerId) {
      return res.status(400).json({ success: false, error: 'ownerId is required' });
    }

    const propertyResult = await getPropertyById(propertyId);
    if (!propertyResult.ok) {
      return res.status(404).json({ success: false, error: 'Property not found' });
    }
    if (propertyResult.property.ownerId && propertyResult.property.ownerId !== ownerId) {
      return res.status(400).json({ success: false, error: 'Property does not belong to selected account' });
    }

    const kit = await upsertInstallKit(propertyId, {
      ownerId,
      propertyLabel: propertyLabel
        || propertyResult.property.address
        || propertyResult.property.formattedAddress
        || propertyId,
      wifiSsid: String(wifiSsid || '').trim(),
      wifiPassword: String(wifiPassword || ''),
      networkType: networkType === 'public' ? 'public' : 'private',
      customerContact: customerContact || null,
      installNotes: installNotes || '',
      status: wifiSsid ? 'ready' : (status || 'draft'),
    }, req.internalStaff?.email);

    res.json({ success: true, kit });
  } catch (error) {
    console.error('[InternalOps] save install kit failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/install-kits/:propertyId/devices', async (req, res) => {
  try {
    const { deviceId, type, name, location, model } = req.body || {};
    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'deviceId is required' });
    }

    const kit = await recordProvisionedDevice(req.params.propertyId, {
      deviceId,
      type,
      name,
      location,
      model,
    }, req.internalStaff?.email);

    res.json({ success: true, kit });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/install-kits/:propertyId/install-sheet', async (req, res) => {
  try {
    const kit = await getInstallKit(req.params.propertyId);
    if (!kit) {
      return res.status(404).json({ success: false, error: 'Install kit not found' });
    }

    const propertyResult = await getPropertyById(req.params.propertyId);
    const address = kit.propertyLabel
      || propertyResult.property?.address
      || req.params.propertyId;

    const devices = kit.provisionedDevices || [];
    const lines = [
      'HouseYield sensor install kit',
      `Property: ${address}`,
      `WiFi SSID: ${kit.wifiSsid || '(not set)'}`,
      `Network: ${kit.networkType || 'private'} (Shelly requires 2.4 GHz)`,
      '',
      'Handyman steps:',
      '1. Plug GL.iNet travel router into backup power and connect it to the property home WiFi (repeater mode).',
      '2. Confirm the IoT WiFi network below is broadcasting (2.4 GHz).',
      '3. Mount sensors / wire relay, then power on each device.',
      '4. Devices join the GL.iNet IoT WiFi automatically. Flood sensors can close the water valve locally even if internet is down.',
      '5. No Shelly app or GL.iNet app required on site if bench provisioning was completed.',
      '',
      'Provisioned devices:',
      ...(devices.length
        ? devices.map((device) => `- ${device.type || 'device'} ${device.deviceId}${device.location ? ` (${device.location})` : ''}`)
        : ['- (none recorded yet)']),
    ];

    if (kit.installNotes) {
      lines.push('', 'Notes:', kit.installNotes);
    }

    res.json({
      success: true,
      installSheet: lines.join('\n'),
      kit,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
