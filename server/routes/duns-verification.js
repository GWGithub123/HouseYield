/**
 * DUNS Verification via D&B Direct+ API
 * Verifies contractor business entity using Dun & Bradstreet data.
 *
 * Required env vars: DNB_KEY, DNB_SECRET
 */

import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

// In-memory token cache — safe for single-process server
let tokenCache = { token: null, expiresAt: 0 };

async function getDnBToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const key = process.env.DNB_KEY;
  const secret = process.env.DNB_SECRET;
  if (!key || !secret) {
    throw new Error('DNB_KEY and DNB_SECRET environment variables are required');
  }

  const basicAuth = Buffer.from(`${key}:${secret}`).toString('base64');
  const resp = await fetch('https://plus.dnb.com/v2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`D&B authentication failed (${resp.status}): ${body}`);
  }

  const json = await resp.json();
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expiresIn || 3600) * 1000
  };
  return tokenCache.token;
}

/**
 * POST /api/duns/verify
 * Body: { dunsNumber: string }
 * Looks up a DUNS number against the D&B Direct+ cmpelk product.
 */
router.post('/verify', async (req, res) => {
  try {
    const { dunsNumber } = req.body;
    if (!dunsNumber) {
      return res.status(400).json({ success: false, error: 'dunsNumber is required' });
    }

    const cleaned = String(dunsNumber).replace(/\D/g, '');
    if (cleaned.length !== 9) {
      return res.status(400).json({
        success: false,
        error: 'DUNS number must be exactly 9 digits'
      });
    }

    const token = await getDnBToken();
    const dnbUrl = `https://plus.dnb.com/v1/data/duns/${cleaned}?productId=cmpelk&versionId=v1`;

    const dnbResp = await fetch(dnbUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });

    if (dnbResp.status === 404) {
      return res.json({
        success: false,
        error: 'DUNS number not found in the D&B database. Please double-check and try again.'
      });
    }

    if (dnbResp.status === 403) {
      return res.json({
        success: false,
        error: 'D&B access denied. Please contact support.'
      });
    }

    if (!dnbResp.ok) {
      throw new Error(`D&B lookup request failed with status ${dnbResp.status}`);
    }

    const data = await dnbResp.json();
    const org = data.organization;

    if (!org) {
      return res.json({ success: false, error: 'No organization data returned from D&B.' });
    }

    const verifiedData = {
      dunsNumber: cleaned,
      registeredName: org.primaryName || 'Unknown',
      primaryAddress: {
        streetAddress: org.primaryAddress?.streetAddress?.line1 || '',
        city: org.primaryAddress?.addressLocality?.name || '',
        state: org.primaryAddress?.addressRegion?.abbreviatedName || '',
        postalCode: org.primaryAddress?.postalCode || ''
      },
      operatingStatus: org.dunsControlStatus?.operatingStatus?.description || 'Unknown',
      employeeCount: org.numberOfEmployees?.[0]?.value ?? null,
      sicCodes: (org.primaryIndustryCodes || [])
        .map(c => c.usSicV4)
        .filter(Boolean)
    };

    res.json({ success: true, data: verifiedData });
  } catch (err) {
    console.error('[DUNS] verify error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message.includes('DNB_KEY')
        ? 'D&B API credentials are not configured on this server.'
        : `Verification failed: ${err.message}`
    });
  }
});

export default router;
