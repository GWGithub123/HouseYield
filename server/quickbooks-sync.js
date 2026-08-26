/**
 * QuickBooks Monthly Sync Endpoints
 * Handles pushing monthly summaries to QuickBooks as Journal Entries
 */

import express from 'express';
import {
  getPropertiesWithActivity,
  getPropertyMonthTotals,
  getSyncLedgerEntry,
  getPropertyMonthSyncs,
  saveSyncLedger,
  markSyncFailed
} from './db/qbo-sync.js';
import {
  buildMonthlyJournalEntry,
  buildDeltaJournalEntry,
  validatePropertyMappings
} from './db/qbo-builder.js';

const router = express.Router();

/**
 * Helper to make QuickBooks API requests
 * Note: This should be imported from the main quickbooks module
 * For now, we'll expect it to be passed via req.qboClient
 */
async function postJournalEntry(qboClient, payload) {
  // This will be called from the main quickbooks router
  // which has access to the makeQuickBooksRequest function
  return await qboClient.makeQuickBooksRequest('/journalentry', 'POST', payload);
}

/**
 * GET /api/quickbooks/sync/preview/:property_id/:period
 * Preview what will be synced for a property/month without posting
 * Period format: YYYY-MM
 */
router.get('/preview/:property_id/:period', (req, res) => {
  try {
    const { property_id, period } = req.params;
    const { property_code } = req.query;
    
    if (!property_code) {
      return res.status(400).json({
        ok: false,
        error: 'Missing query parameter: property_code'
      });
    }
    
    // Parse period
    const [year, month] = period.split('-').map(Number);
    const periodStart = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const periodEnd = new Date(year, month, 0).toISOString().split('T')[0];
    
    // Validate mappings
    const validation = validatePropertyMappings(parseInt(property_id));
    if (!validation.ok) {
      return res.status(400).json(validation);
    }
    
    // Build journal entry
    const result = buildMonthlyJournalEntry(
      parseInt(property_id),
      periodStart,
      periodEnd,
      property_code
    );
    
    if (!result.ok) {
      return res.status(400).json(result);
    }
    
    // Check if already synced
    const existingSync = getSyncLedgerEntry(
      parseInt(property_id),
      periodStart,
      periodEnd,
      result.doc_number
    );
    
    res.json({
      ok: true,
      preview: result.payload,
      summary: result.summary,
      doc_number: result.doc_number,
      already_synced: !!existingSync,
      existing_sync: existingSync || null
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error generating preview:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * POST /api/quickbooks/sync/push/:property_id/:period
 * Push monthly summary to QuickBooks
 * Period format: YYYY-MM
 */
router.post('/push/:property_id/:period', async (req, res) => {
  try {
    const { property_id, period } = req.params;
    const { property_code, posted_by, qboClient } = req.body;
    
    if (!property_code) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: property_code'
      });
    }
    
    // Parse period
    const [year, month] = period.split('-').map(Number);
    const periodStart = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const periodEnd = new Date(year, month, 0).toISOString().split('T')[0];
    
    // Validate mappings
    const validation = validatePropertyMappings(parseInt(property_id));
    if (!validation.ok) {
      return res.status(400).json(validation);
    }
    
    // Build journal entry
    const result = buildMonthlyJournalEntry(
      parseInt(property_id),
      periodStart,
      periodEnd,
      property_code
    );
    
    if (!result.ok) {
      return res.status(400).json(result);
    }
    
    // Check if already synced
    const existingSync = getSyncLedgerEntry(
      parseInt(property_id),
      periodStart,
      periodEnd,
      result.doc_number
    );
    
    if (existingSync && existingSync.sync_status === 'success') {
      // Check if totals have changed - need delta entry
      const previousTotals = JSON.parse(existingSync.pushed_totals_json || '{}');
      const currentTotals = getPropertyMonthTotals(parseInt(property_id), periodStart, periodEnd);
      
      // Build map of current totals
      const currentMap = {};
      for (const t of currentTotals) {
        currentMap[t.account_code] = t.amount;
      }
      
      // Check for changes
      const hasChanges = JSON.stringify(previousTotals) !== JSON.stringify(currentMap);
      
      if (!hasChanges) {
        return res.json({
          ok: true,
          already_synced: true,
          message: 'This period has already been synced with no changes',
          existing_sync: existingSync
        });
      }
      
      // Build delta entry
      const allSyncs = getPropertyMonthSyncs(parseInt(property_id), periodStart, periodEnd);
      const adjustmentNumber = allSyncs.filter(s => s.doc_number.includes('-ADJ')).length + 1;
      
      const deltaResult = buildDeltaJournalEntry(
        parseInt(property_id),
        periodStart,
        periodEnd,
        property_code,
        previousTotals,
        adjustmentNumber
      );
      
      if (!deltaResult.ok) {
        return res.status(400).json(deltaResult);
      }
      
      // Post delta to QuickBooks
      // Note: This requires the QB client to be passed in or injected
      try {
        const qboResponse = await postJournalEntry(qboClient, deltaResult.payload);
        
        // Save to sync ledger
        saveSyncLedger(
          parseInt(property_id),
          periodStart,
          periodEnd,
          deltaResult.doc_number,
          qboResponse.JournalEntry?.Id,
          currentMap,
          posted_by || 'user'
        );
        
        return res.json({
          ok: true,
          is_delta: true,
          adjustment_number: adjustmentNumber,
          qbo_journal_id: qboResponse.JournalEntry?.Id,
          doc_number: deltaResult.doc_number,
          message: 'Delta journal entry posted successfully'
        });
        
      } catch (qboError) {
        markSyncFailed(
          parseInt(property_id),
          periodStart,
          periodEnd,
          deltaResult.doc_number,
          qboError.message
        );
        
        return res.status(500).json({
          ok: false,
          error: qboError.message,
          message: 'Failed to post delta entry to QuickBooks'
        });
      }
    }
    
    // Post new journal entry to QuickBooks
    try {
      const qboResponse = await postJournalEntry(qboClient, result.payload);
      
      // Get totals map
      const totals = getPropertyMonthTotals(parseInt(property_id), periodStart, periodEnd);
      const totalsMap = {};
      for (const t of totals) {
        totalsMap[t.account_code] = t.amount;
      }
      
      // Save to sync ledger
      saveSyncLedger(
        parseInt(property_id),
        periodStart,
        periodEnd,
        result.doc_number,
        qboResponse.JournalEntry?.Id,
        totalsMap,
        posted_by || 'user'
      );
      
      res.json({
        ok: true,
        qbo_journal_id: qboResponse.JournalEntry?.Id,
        doc_number: result.doc_number,
        summary: result.summary,
        message: 'Monthly summary posted to QuickBooks successfully'
      });
      
    } catch (qboError) {
      // Save failed attempt
      markSyncFailed(
        parseInt(property_id),
        periodStart,
        periodEnd,
        result.doc_number,
        qboError.message
      );
      
      return res.status(500).json({
        ok: false,
        error: qboError.message,
        message: 'Failed to post to QuickBooks'
      });
    }

  } catch (error) {
    console.error('[QuickBooks Sync] Error pushing to QuickBooks:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * GET /api/quickbooks/sync/status/:property_id/:period
 * Get sync status for a property/month
 */
router.get('/status/:property_id/:period', (req, res) => {
  try {
    const { property_id, period } = req.params;
    
    // Parse period
    const [year, month] = period.split('-').map(Number);
    const periodStart = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const periodEnd = new Date(year, month, 0).toISOString().split('T')[0];
    
    const syncs = getPropertyMonthSyncs(parseInt(property_id), periodStart, periodEnd);
    
    res.json({
      ok: true,
      sync_history: syncs,
      is_synced: syncs.some(s => s.sync_status === 'success'),
      latest_sync: syncs[0] || null
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error fetching sync status:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * GET /api/quickbooks/sync/properties-with-activity/:period
 * Get all properties that have activity in a given month
 * Useful for bulk sync operations
 */
router.get('/properties-with-activity/:period', (req, res) => {
  try {
    const { period } = req.params;
    
    // Parse period
    const [year, month] = period.split('-').map(Number);
    const periodStart = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const periodEnd = new Date(year, month, 0).toISOString().split('T')[0];
    
    const properties = getPropertiesWithActivity(periodStart, periodEnd);
    
    res.json({
      ok: true,
      properties,
      count: properties.length,
      period: { start: periodStart, end: periodEnd }
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error fetching properties:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

export default router;
