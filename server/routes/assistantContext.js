import { Router } from 'express';

import { requireAuth } from '../firebase-admin.js';
import { buildAssistantCanonicalContext } from '../services/assistantCanonicalContextService.js';
import { executeAssistantDataLookup } from '../services/assistantDataLookupService.js';
import { runGoogleCustomSearch } from '../services/googleCustomSearchService.js';
import {
  buildAssistantWeeklyDigest,
  getAssistantWeeklyDigestPreferences,
  sanitizeDigestForClient,
  sendAssistantWeeklyDigest,
  updateAssistantWeeklyDigestPreferences,
} from '../services/assistantWeeklyDigestService.js';
import { computeAssistantAnalytics } from '../services/assistantComputedAnalyticsService.js';
import {
  executeAssistantAction,
  listAssistantExecutableActions,
} from '../services/assistantActionExecutionService.js';
import {
  getAssistantActivity,
  listAssistantActivities,
  updateAssistantActivity,
} from '../services/assistantActivityService.js';
import {
  cancelAssistantScheduledTask,
  createAssistantScheduledTask,
  deleteAssistantScheduledTask,
  listAssistantScheduledTasks,
  updateAssistantScheduledTask,
} from '../services/assistantScheduledTaskService.js';
import {
  answerPropertyPortfolioFollowUp,
  buildPropertyPortfolioAnalysis,
} from '../services/propertyPortfolioAnalysisService.js';

const router = Router();

router.post('/canonical-context', requireAuth, async (req, res) => {
  try {
    const includeFinancialDetails = req.body?.includeFinancialDetails === true;
    const includeGlobalContext = req.body?.includeGlobalContext !== false;

    const context = await buildAssistantCanonicalContext({
      userId: req.user?.uid,
      includeFinancialDetails,
      includeGlobalContext,
    });

    res.json({
      ok: true,
      ...context,
    });
  } catch (error) {
    console.error('[Assistant Context] Error building canonical context:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_context_failed',
    });
  }
});

router.post('/computed-analytics', requireAuth, async (req, res) => {
  try {
    const result = await computeAssistantAnalytics({
      userId: req.user?.uid,
      metric: req.body?.metric,
      propertyId: req.body?.propertyId || null,
      year: req.body?.year || req.body?.taxYear || null,
      startDate: req.body?.startDate || null,
      endDate: req.body?.endDate || null,
    });

    res.json(result);
  } catch (error) {
    console.error('[Assistant Context] Error computing portfolio metric:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_computed_analytics_failed',
    });
  }
});

router.post('/data-lookup', requireAuth, async (req, res) => {
  try {
    const result = await executeAssistantDataLookup({
      userId: req.user?.uid,
      action: req.body?.action,
      documentPath: req.body?.documentPath,
      fieldPath: req.body?.fieldPath,
      collectionPath: req.body?.collectionPath,
      collectionGroup: req.body?.collectionGroup,
      filters: req.body?.filters,
      orderBy: req.body?.orderBy,
      limit: req.body?.limit,
      propertyId: req.body?.propertyId || null,
      propertyAddress: req.body?.propertyAddress || req.body?.address || null,
      address: req.body?.address || null,
      year: req.body?.year || req.body?.taxYear || null,
      taxYear: req.body?.taxYear || null,
      startDate: req.body?.startDate || null,
      endDate: req.body?.endDate || null,
      category: req.body?.category || null,
    });

    res.json(result);
  } catch (error) {
    console.error('[Assistant Context] Error performing raw data lookup:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_data_lookup_failed',
    });
  }
});

router.post('/google-search', requireAuth, async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    const limit = Math.min(Math.max(parseInt(req.body?.limit || '3', 10) || 3, 1), 5);

    if (!query) {
      return res.status(400).json({
        ok: false,
        error: 'missing_query',
      });
    }

    const result = await runGoogleCustomSearch(query, limit);
    if (!result.ok && result.error === 'google_search_not_configured') {
      return res.json({
        ok: true,
        results: [],
        warning: result.error,
      });
    }

    res.json({
      ok: true,
      results: result.results || [],
      searchInfo: result.searchInfo || null,
    });
  } catch (error) {
    if (String(error?.message || '').startsWith('google_search_failed:')) {
      return res.json({
        ok: true,
        results: [],
        warning: error.message,
      });
    }

    console.error('[Assistant Context] Error running Google search:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_google_search_failed',
    });
  }
});

router.post('/property-portfolio-analysis', requireAuth, async (req, res) => {
  try {
    const analysis = await buildPropertyPortfolioAnalysis({
      userId: req.user?.uid,
      scope: req.body?.scope || 'overview',
    });

    res.json({
      ok: true,
      analysis,
    });
  } catch (error) {
    console.error('[Assistant Context] Error building property portfolio analysis:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_property_portfolio_analysis_failed',
    });
  }
});

router.post('/property-portfolio-analysis/follow-up', requireAuth, async (req, res) => {
  try {
    const result = await answerPropertyPortfolioFollowUp({
      userId: req.user?.uid,
      scope: req.body?.scope || 'overview',
      question: req.body?.question || '',
      recommendationId: req.body?.recommendationId || null,
      history: Array.isArray(req.body?.history) ? req.body.history : [],
    });

    res.json(result);
  } catch (error) {
    console.error('[Assistant Context] Error answering property portfolio follow-up:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_property_portfolio_follow_up_failed',
    });
  }
});

router.get('/weekly-digest-preferences', requireAuth, async (req, res) => {
  try {
    const preferences = await getAssistantWeeklyDigestPreferences({
      userId: req.user?.uid,
    });

    res.json({
      ok: true,
      preferences,
    });
  } catch (error) {
    console.error('[Assistant Context] Error loading weekly digest preferences:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_weekly_digest_preferences_failed',
    });
  }
});

router.post('/weekly-digest-preferences', requireAuth, async (req, res) => {
  try {
    const preferences = await updateAssistantWeeklyDigestPreferences({
      userId: req.user?.uid,
      updates: {
        enabled: req.body?.enabled,
        recipientEmail: req.body?.recipientEmail,
        includeFinancialDetails: req.body?.includeFinancialDetails,
        includeGlobalContext: req.body?.includeGlobalContext,
        includeWebSearch: req.body?.includeWebSearch,
        includeAiNarrative: req.body?.includeAiNarrative,
        includeManagementActivity: req.body?.includeManagementActivity,
        includeTaxUpdates: req.body?.includeTaxUpdates,
        includeListingsWatch: req.body?.includeListingsWatch,
        watchedTickers: req.body?.watchedTickers,
        watchedZipCodes: req.body?.watchedZipCodes,
        schedule: req.body?.schedule,
        weekday: req.body?.weekday,
        localHour: req.body?.localHour,
        localMinute: req.body?.localMinute,
        timeZone: req.body?.timeZone,
      },
    });

    res.json({
      ok: true,
      preferences,
    });
  } catch (error) {
    console.error('[Assistant Context] Error saving weekly digest preferences:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_weekly_digest_preferences_save_failed',
    });
  }
});

router.post('/weekly-digest-preview', requireAuth, async (req, res) => {
  try {
    const digest = await buildAssistantWeeklyDigest({
      userId: req.user?.uid,
      fallbackRecipientEmail: req.user?.email || '',
      includeFinancialDetails: req.body?.includeFinancialDetails,
      includeGlobalContext: req.body?.includeGlobalContext,
      includeWebSearch: req.body?.includeWebSearch,
      preferencesOverride: req.body?.preferences || null,
    });

    res.json({
      ok: true,
      digest: sanitizeDigestForClient(digest),
    });
  } catch (error) {
    console.error('[Assistant Context] Error building weekly digest preview:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_weekly_digest_preview_failed',
    });
  }
});

router.get('/actions', requireAuth, async (_req, res) => {
  res.json({
    ok: true,
    actions: listAssistantExecutableActions(),
  });
});

router.post('/actions/execute', requireAuth, async (req, res) => {
  try {
    const actionId = String(req.body?.actionId || '').trim();
    if (!actionId) {
      return res.status(400).json({
        ok: false,
        error: 'missing_action_id',
      });
    }

    const requestId = String(
      req.body?.requestId
      || req.get('x-request-id')
      || '',
    ).trim() || null;
    const idempotencyKey = String(
      req.body?.idempotencyKey
      || req.get('idempotency-key')
      || '',
    ).trim() || null;
    const result = await executeAssistantAction({
      userId: req.user?.uid,
      actionId,
      parameters: req.body?.parameters || {},
      runId: req.body?.runId || null,
      requestId,
      idempotencyKey,
    });

    if (result.runId) res.set('x-assistant-run-id', result.runId);
    res.json(result);
  } catch (error) {
    console.error('[Assistant Context] Error executing assistant action:', error);
    if (error.runId) res.set('x-assistant-run-id', error.runId);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_action_execution_failed',
      runId: error.runId || null,
    });
  }
});

router.get('/activities', requireAuth, async (req, res) => {
  try {
    const result = await listAssistantActivities({
      userId: req.user?.uid,
      limit: Number(req.query?.limit) || 40,
      status: req.query?.status ? String(req.query.status) : null,
      actionId: req.query?.actionId ? String(req.query.actionId) : null,
    });
    res.json(result);
  } catch (error) {
    console.error('[Assistant Context] Error listing assistant activities:', error);
    res.status(500).json({ ok: false, error: error.message || 'assistant_activity_list_failed' });
  }
});

router.get('/activities/:runId', requireAuth, async (req, res) => {
  try {
    const result = await getAssistantActivity({
      userId: req.user?.uid,
      runId: req.params.runId,
    });
    res.status(result.ok ? 200 : 404).json(result);
  } catch (error) {
    console.error('[Assistant Context] Error loading assistant activity:', error);
    res.status(500).json({ ok: false, error: error.message || 'assistant_activity_get_failed' });
  }
});

router.patch('/activities/:runId', requireAuth, async (req, res) => {
  try {
    const result = await updateAssistantActivity({
      userId: req.user?.uid,
      runId: req.params.runId,
      updates: req.body || {},
    });
    res.status(result.ok ? 200 : 404).json(result);
  } catch (error) {
    const status = error.message === 'invalid_activity_status' ? 400 : 500;
    console.error('[Assistant Context] Error updating assistant activity:', error);
    res.status(status).json({ ok: false, error: error.message || 'assistant_activity_update_failed' });
  }
});

router.get('/scheduled-tasks', requireAuth, async (req, res) => {
  try {
    const includeCompleted = String(req.query?.includeCompleted || '').toLowerCase() === 'true';
    const result = await listAssistantScheduledTasks({
      userId: req.user?.uid,
      includeCompleted,
      limit: Number(req.query?.limit) || 40,
    });
    res.json(result);
  } catch (error) {
    console.error('[Assistant Context] Error listing scheduled tasks:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_scheduled_tasks_list_failed',
    });
  }
});

router.post('/scheduled-tasks', requireAuth, async (req, res) => {
  try {
    const result = await createAssistantScheduledTask({
      userId: req.user?.uid,
      title: req.body?.title,
      notes: req.body?.notes || req.body?.body,
      runAt: req.body?.runAt,
      when: req.body?.when,
      scheduledFor: req.body?.scheduledFor,
      date: req.body?.date,
      time: req.body?.time,
      timeZone: req.body?.timeZone,
      actionId: req.body?.actionId || null,
      parameters: req.body?.parameters || {},
      propertyId: req.body?.propertyId,
      propertyAddress: req.body?.propertyAddress,
      tenantId: req.body?.tenantId,
      tenantName: req.body?.tenantName,
      kind: req.body?.kind,
      requestId: req.body?.requestId || req.get('x-request-id') || null,
      dedupeKey: req.body?.dedupeKey || req.body?.idempotencyKey || req.get('idempotency-key') || null,
    });
    res.json(result);
  } catch (error) {
    console.error('[Assistant Context] Error creating scheduled task:', error);
    res.status(400).json({
      ok: false,
      error: error.message || 'assistant_scheduled_task_create_failed',
    });
  }
});

router.patch('/scheduled-tasks/:taskId', requireAuth, async (req, res) => {
  try {
    const result = await updateAssistantScheduledTask({
      userId: req.user?.uid,
      taskId: req.params.taskId,
      updates: req.body || {},
    });
    if (!result.ok) {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (error) {
    console.error('[Assistant Context] Error updating scheduled task:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_scheduled_task_update_failed',
    });
  }
});

router.post('/scheduled-tasks/:taskId/cancel', requireAuth, async (req, res) => {
  try {
    const result = await cancelAssistantScheduledTask({
      userId: req.user?.uid,
      taskId: req.params.taskId,
    });
    if (!result.ok) {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (error) {
    console.error('[Assistant Context] Error cancelling scheduled task:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_scheduled_task_cancel_failed',
    });
  }
});

router.delete('/scheduled-tasks/:taskId', requireAuth, async (req, res) => {
  try {
    const result = await deleteAssistantScheduledTask({
      userId: req.user?.uid,
      taskId: req.params.taskId,
    });
    res.json(result);
  } catch (error) {
    console.error('[Assistant Context] Error deleting scheduled task:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_scheduled_task_delete_failed',
    });
  }
});

router.post('/weekly-digest-send', requireAuth, async (req, res) => {
  try {
    const result = await sendAssistantWeeklyDigest({
      userId: req.user?.uid,
      to: req.body?.to || '',
      fallbackRecipientEmail: req.user?.email || '',
      includeFinancialDetails: req.body?.includeFinancialDetails,
      includeGlobalContext: req.body?.includeGlobalContext,
      includeWebSearch: req.body?.includeWebSearch,
      preferencesOverride: req.body?.preferences || null,
    });

    if (!result.ok) {
      return res.status(503).json({
        ok: false,
        error: result.sendResult?.error || 'assistant_weekly_digest_send_failed',
        digest: result.digest,
        authUrl: result.sendResult?.authUrl || null,
      });
    }

    res.json({
      ok: true,
      sendResult: result.sendResult,
      digest: result.digest,
    });
  } catch (error) {
    console.error('[Assistant Context] Error sending weekly digest:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'assistant_weekly_digest_send_failed',
    });
  }
});

export default router;