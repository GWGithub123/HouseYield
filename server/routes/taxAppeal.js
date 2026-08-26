/**
 * Tax over-assessment + legacy tax appeal brief routes
 *
 * GET /api/tax-appeal/brief?address=...&format=json|pdf
 * GET /api/tax-appeal/over-assessment?address=...
 */

import express from 'express';
import { buildTaxAppealBrief } from '../services/taxAppealBriefService.js';
import { generateTaxAppealBriefPdf } from '../services/taxAppealBriefPdf.js';
import { analyzePropertyTaxOverAssessment } from '../services/taxOverAssessmentService.js';

const router = express.Router();

router.get('/brief', async (req, res) => {
  try {
    const address = String(req.query.address || '').trim();
    if (!address) {
      return res.status(400).json({ ok: false, error: 'missing_address' });
    }

    const maxComps = req.query.maxComps ? parseInt(req.query.maxComps, 10) : undefined;
    const maxSaleAgeMonths = req.query.maxSaleAgeMonths ? parseInt(req.query.maxSaleAgeMonths, 10) : undefined;
    const format = String(req.query.format || 'json').toLowerCase();

    const brief = await buildTaxAppealBrief({ address, maxComps, maxSaleAgeMonths });
    if (!brief.ok) {
      return res.status(brief.error === 'attom_dashboard_unavailable' ? 404 : 400).json(brief);
    }

    if (format === 'pdf') {
      const pdfBytes = await generateTaxAppealBriefPdf(brief);
      const safeName = address.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="tax-appeal-brief-${safeName}.pdf"`);
      return res.send(Buffer.from(pdfBytes));
    }

    return res.json(brief);
  } catch (error) {
    console.error('[TaxAppeal] Brief error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'tax_appeal_brief_failed' });
  }
});

router.get('/over-assessment', async (req, res) => {
  try {
    const address = String(req.query.address || '').trim();
    if (!address) {
      return res.status(400).json({ ok: false, error: 'missing_address' });
    }

    const result = await analyzePropertyTaxOverAssessment({
      address,
      skipCache: req.query.skipCache === 'true',
      maxCompAvms: req.query.maxCompAvms ? parseInt(req.query.maxCompAvms, 10) : 8,
    });

    if (!result.ok) {
      return res.status(result.error === 'attom_dashboard_unavailable' ? 404 : 400).json({
        ...result,
        error: result.error === 'attom_dashboard_unavailable'
          ? 'No ATTOM property record found for that address'
          : (result.error || 'tax_over_assessment_failed'),
      });
    }

    return res.json({
      ok: true,
      fromCache: result.fromCache,
      ...result.analysis,
      leadFields: result.leadFields,
      disclaimer: result.analysis?.disclaimer
        || 'Estimate for owner review — not legal or tax advice.',
    });
  } catch (error) {
    console.error('[TaxAppeal] Over-assessment error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'tax_over_assessment_failed' });
  }
});

export default router;
