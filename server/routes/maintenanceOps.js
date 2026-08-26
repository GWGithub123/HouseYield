/**
 * HouseYield maintenance operations console API.
 *
 * Cross-account ticket queue and step-advance actions for internal staff. Mounted
 * under `/api/maintenance/ops` rather than `/api/internal` so it survives the
 * maintenance product-mode API allowlist, which blocks the `/api/internal` prefix.
 *
 * Every route here reads across all customer accounts, so the staff guard is the
 * only thing standing between this and a data leak — do not mount it without it.
 */

import express from 'express';
import { getAuth, getFirestore } from '../firebase-admin.js';
import { requireInternalStaff } from '../middleware/internalStaff.js';
import {
  appendMaintenanceOperatorLog,
  getAllMaintenanceRequests,
  getMaintenanceRequestById,
  updateMaintenanceRequestDetails,
  updateMaintenanceStatus,
} from '../tenant-activity-service.js';
import { mergeServiceRecord, summarizeServiceRecord } from '../maintenance/serviceRecord.js';
import { recordProviderJob, upsertProvidersFromSearch } from '../maintenance/providerNetwork.js';
import { buildProviderShortlist, formatCallScript } from '../maintenance/providerShortlist.js';
import { uploadMaintenancePhotos } from '../maintenance/photoStore.js';

const router = express.Router();

router.use(requireInternalStaff);

/** Steps an operator can advance, mirroring the six dots the customer sees. */
const ADVANCE_ACTIONS = [
  'log_provider_search',
  'select_provider',
  'log_provider_call',
  'schedule_visit',
  'record_service',
  'record_outcome',
  'update_status',
  'note',
];

function actorFrom(req) {
  return {
    actorEmail: req.internalStaff?.email || '',
    actorName: req.internalStaff?.email || 'HouseYield ops',
  };
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * GET /api/maintenance/ops/queue
 * Cross-account ticket queue with owner display names attached.
 */
router.get('/queue', async (req, res) => {
  try {
    const { status, priority, ownerId, limit } = req.query;

    const result = await getAllMaintenanceRequests({
      status: status ? String(status).split(',').filter(Boolean) : null,
      priority: priority ? String(priority).split(',').filter(Boolean) : null,
      ownerId: ownerId ? String(ownerId) : null,
      limit: limit ? Number(limit) : 300,
    });

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    const requests = result.requests || [];

    // Attach owner labels so the queue reads as accounts, not raw uids.
    const ownerIds = [...new Set(requests.map((request) => request.ownerId).filter(Boolean))];
    const ownerLabels = new Map();

    if (ownerIds.length) {
      try {
        const db = getFirestore();
        const userDocs = await Promise.all(
          ownerIds.map((id) => db.collection('users').doc(id).get().catch(() => null)),
        );
        userDocs.forEach((doc, index) => {
          const data = doc?.exists ? doc.data() : null;
          if (data) {
            ownerLabels.set(ownerIds[index], {
              email: data.email || '',
              name: data.displayName || data.name || '',
            });
          }
        });
      } catch (lookupError) {
        console.warn('[MaintenanceOps] Owner label lookup failed:', lookupError.message);
      }

      // Fall back to Auth for owners without a Firestore user doc.
      const missing = ownerIds.filter((id) => !ownerLabels.has(id));
      if (missing.length) {
        try {
          const auth = getAuth();
          const authResult = await auth.getUsers(missing.map((uid) => ({ uid })));
          authResult.users.forEach((user) => {
            ownerLabels.set(user.uid, { email: user.email || '', name: user.displayName || '' });
          });
        } catch (authError) {
          console.warn('[MaintenanceOps] Auth label lookup failed:', authError.message);
        }
      }
    }

    return res.json({
      ok: true,
      total: result.total,
      count: requests.length,
      requests: requests.map((request) => ({
        ...request,
        ownerLabel: ownerLabels.get(request.ownerId) || null,
      })),
    });
  } catch (error) {
    console.error('[MaintenanceOps] Queue failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/maintenance/ops/requests/:id/search-providers
 *
 * Runs the AI provider search on demand, normalizes the candidates into a ranked
 * shortlist, writes it to the ticket, and feeds the provider network collection.
 * No outbound call is placed — the operator dials from the shortlist themselves.
 */
router.post('/requests/:id/search-providers', async (req, res) => {
  try {
    const { id } = req.params;

    const existingResult = await getMaintenanceRequestById(id);
    if (!existingResult.ok) {
      return res.status(404).json({ ok: false, error: 'Maintenance request not found' });
    }

    const existing = existingResult.request;
    if (!existing.propertyAddress) {
      return res.status(400).json({ ok: false, error: 'This ticket has no property address to search around' });
    }

    const selector = await import('../ai-provider-selector.js');
    const searchResult = await selector.findBestRepairService({
      repairType: existing.description || `${existing.category} repair`,
      serviceCategory: existing.serviceType || existing.category || 'general',
      location: existing.propertyAddress,
      urgency: existing.priority || 'medium',
      maxCandidates: 5,
      includeDetailedReviews: true,
    });

    if (!searchResult.ok) {
      return res.status(502).json({ ok: false, error: searchResult.error || 'Provider search failed' });
    }

    const shortlist = buildProviderShortlist(searchResult);
    const callScript = formatCallScript(searchResult.callScript);

    const aiAutomation = {
      ...(existing.aiAutomation || {}),
      status: 'awaiting_operator_dispatch',
      providerSearch: {
        totalFound: searchResult.allCandidates?.length || shortlist.length,
        analyzedCount: shortlist.filter((provider) => provider.reviewAnalysis).length || shortlist.length,
      },
      providerShortlist: shortlist,
      callScript,
      selectedProvider: shortlist[0] || existing.aiAutomation?.selectedProvider || null,
    };

    await updateMaintenanceRequestDetails(id, { aiAutomation });

    await upsertProvidersFromSearch({
      providers: shortlist,
      category: existing.category,
      serviceType: existing.serviceType,
      propertyAddress: existing.propertyAddress,
    }).catch((error) => {
      console.warn('[MaintenanceOps] Provider upsert failed:', error.message);
    });

    await appendMaintenanceOperatorLog(id, {
      ...actorFrom(req),
      event: 'provider_search',
      step: 'search',
      note: `${shortlist.length} candidates ranked`,
    });

    const refreshed = await getMaintenanceRequestById(id);
    return res.json({
      ok: true,
      shortlist,
      callScript,
      request: refreshed.ok ? refreshed.request : null,
    });
  } catch (error) {
    console.error('[MaintenanceOps] Provider search failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/** GET /api/maintenance/ops/requests/:id */
router.get('/requests/:id', async (req, res) => {
  try {
    const result = await getMaintenanceRequestById(req.params.id);
    if (!result.ok) {
      return res.status(404).json({ ok: false, error: result.error || 'Maintenance request not found' });
    }
    return res.json({ ok: true, request: result.request });
  } catch (error) {
    console.error('[MaintenanceOps] Fetch request failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/maintenance/ops/requests/:id/advance
 * One endpoint per operator action, each writing the fields the customer's
 * progress stepper reads and appending an audit entry.
 */
router.post('/requests/:id/advance', async (req, res) => {
  try {
    const { id } = req.params;
    const { action, payload = {}, note = '' } = req.body || {};

    if (!ADVANCE_ACTIONS.includes(action)) {
      return res.status(400).json({
        ok: false,
        error: `Unknown action. Expected one of: ${ADVANCE_ACTIONS.join(', ')}`,
      });
    }

    const existingResult = await getMaintenanceRequestById(id);
    if (!existingResult.ok) {
      return res.status(404).json({ ok: false, error: existingResult.error || 'Maintenance request not found' });
    }

    const existing = existingResult.request;
    const actor = actorFrom(req);
    const updates = {};
    let step = '';

    switch (action) {
      case 'log_provider_search': {
        step = 'search';
        const shortlist = Array.isArray(payload.providers) ? payload.providers : [];
        updates.aiAutomation = {
          ...(existing.aiAutomation || {}),
          status: 'awaiting_operator_dispatch',
          providerSearch: {
            totalFound: toNumberOrNull(payload.totalFound) ?? shortlist.length,
            analyzedCount: toNumberOrNull(payload.analyzedCount) ?? shortlist.length,
          },
          providerShortlist: shortlist,
          callScript: payload.callScript || existing.aiAutomation?.callScript || '',
        };

        // Feed the provider network so the map accumulates coverage over time.
        if (shortlist.length) {
          await upsertProvidersFromSearch({
            providers: shortlist,
            category: existing.category,
            serviceType: existing.serviceType,
            propertyAddress: existing.propertyAddress,
          }).catch((error) => {
            console.warn('[MaintenanceOps] Provider upsert failed:', error.message);
          });
        }
        break;
      }

      case 'select_provider': {
        step = 'search';
        if (!payload.provider?.name) {
          return res.status(400).json({ ok: false, error: 'A provider with a name is required' });
        }
        updates.aiAutomation = {
          ...(existing.aiAutomation || {}),
          status: 'provider_found',
          selectedProvider: payload.provider,
        };
        break;
      }

      case 'log_provider_call': {
        step = 'connected';
        const outcome = String(payload.outcome || '').trim();
        updates.aiAutomation = {
          ...(existing.aiAutomation || {}),
          status: outcome === 'booked' ? 'scheduled' : 'provider_contacted',
          operatorCall: {
            calledAt: payload.calledAt || new Date().toISOString(),
            calledBy: actor.actorEmail,
            providerName: payload.providerName || existing.aiAutomation?.selectedProvider?.name || '',
            providerPhone: payload.providerPhone || existing.aiAutomation?.selectedProvider?.phone || '',
            outcome,
            notes: payload.notes || '',
          },
        };
        if (existing.status === 'pending') {
          updates.status = 'in_progress';
        }
        break;
      }

      case 'schedule_visit': {
        step = 'scheduled';
        if (!payload.startAt) {
          return res.status(400).json({ ok: false, error: 'startAt is required to schedule a visit' });
        }
        updates.scheduledVisit = {
          confirmed: true,
          startAt: payload.startAt,
          endAt: payload.endAt || '',
          timezone: payload.timezone || 'America/New_York',
          providerName: payload.providerName || existing.aiAutomation?.selectedProvider?.name || '',
          providerPhone: payload.providerPhone || existing.aiAutomation?.selectedProvider?.phone || '',
          summary: payload.summary || '',
          confirmedAt: new Date().toISOString(),
          googleCalendarUrl: payload.googleCalendarUrl || '',
        };
        updates.status = 'scheduled';
        break;
      }

      case 'record_service': {
        step = 'performed';
        const serviceRecord = mergeServiceRecord(existing.serviceRecord, {
          ...payload,
          completedAt: payload.completedAt || new Date().toISOString(),
          completedBy: payload.completedBy || actor.actorEmail,
        });

        updates.serviceRecord = serviceRecord;
        // Keep the legacy field in sync for older readers.
        updates.serviceCompletion = {
          completedAt: serviceRecord.completedAt,
          completedBy: serviceRecord.completedBy,
          notes: summarizeServiceRecord(serviceRecord),
        };
        updates.status = 'completed';
        updates.paymentWorkflow = {
          amount: serviceRecord.totals?.total ?? existing.paymentWorkflow?.amount ?? null,
          serviceSummary: summarizeServiceRecord(serviceRecord),
        };
        break;
      }

      case 'record_outcome': {
        step = 'outcome';
        updates.outcome = {
          resolvedFirstVisit: payload.resolvedFirstVisit ?? null,
          repeatIssue: Boolean(payload.repeatIssue),
          repeatOfRequestId: payload.repeatOfRequestId || '',
          verifiedAt: payload.verifiedAt || new Date().toISOString(),
          ownerRating: toNumberOrNull(payload.ownerRating),
          notes: payload.notes || '',
        };
        break;
      }

      case 'update_status': {
        step = 'status';
        if (!payload.status) {
          return res.status(400).json({ ok: false, error: 'status is required' });
        }
        await updateMaintenanceStatus(id, payload.status, note || payload.notes || null);
        break;
      }

      case 'note':
        step = payload.step || 'note';
        break;

      default:
        break;
    }

    if (Object.keys(updates).length) {
      const updateResult = await updateMaintenanceRequestDetails(id, updates);
      if (!updateResult.ok) {
        return res.status(500).json({ ok: false, error: updateResult.error });
      }
    }

    await appendMaintenanceOperatorLog(id, {
      ...actor,
      event: action,
      step,
      note: note || payload.notes || '',
    });

    const refreshed = await getMaintenanceRequestById(id);
    const ticket = refreshed.ok ? refreshed.request : null;

    // Roll the completed visit into the flat serviceRecords collection and the
    // provider's network stats. Runs on both actions because the outcome usually
    // lands after the service record, and the rollup recomputes from scratch.
    if (ticket?.serviceRecord?.completedAt && ['record_service', 'record_outcome'].includes(action)) {
      await recordProviderJob({
        requestId: id,
        ownerId: ticket.ownerId,
        propertyId: ticket.propertyId,
        propertyAddress: ticket.propertyAddress,
        category: ticket.category,
        serviceType: ticket.serviceType,
        provider: ticket.aiAutomation?.selectedProvider || null,
        serviceRecord: ticket.serviceRecord,
        outcome: ticket.outcome,
        reportedAt: ticket.createdAt,
      }).catch((error) => {
        console.warn('[MaintenanceOps] Provider job rollup failed:', error.message);
      });
    }

    return res.json({ ok: true, request: ticket });
  } catch (error) {
    console.error('[MaintenanceOps] Advance failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/maintenance/ops/requests/:id/photos
 * Attaches service-record photos (before/after/parts/receipt) to a ticket.
 */
router.post('/requests/:id/photos', async (req, res) => {
  try {
    const { id } = req.params;
    const { kind = 'after', photos = [] } = req.body || {};

    const existingResult = await getMaintenanceRequestById(id);
    if (!existingResult.ok) {
      return res.status(404).json({ ok: false, error: 'Maintenance request not found' });
    }

    const existing = existingResult.request;
    const uploadResult = await uploadMaintenancePhotos({
      requestId: id,
      ownerId: existing.ownerId,
      kind,
      photos,
    });

    if (!uploadResult.ok) {
      return res.status(400).json({ ok: false, error: uploadResult.error, errors: uploadResult.errors || [] });
    }

    const serviceRecord = mergeServiceRecord(existing.serviceRecord, {
      photos: {
        ...(existing.serviceRecord?.photos || {}),
        [kind]: [...(existing.serviceRecord?.photos?.[kind] || []), ...uploadResult.photos],
      },
    });

    await updateMaintenanceRequestDetails(id, { serviceRecord });
    await appendMaintenanceOperatorLog(id, {
      ...actorFrom(req),
      event: 'attach_photos',
      step: 'performed',
      note: `${uploadResult.photos.length} ${kind} photo(s)`,
    });

    return res.json({ ok: true, photos: uploadResult.photos, serviceRecord });
  } catch (error) {
    console.error('[MaintenanceOps] Photo attach failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
