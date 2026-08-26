/**
 * Shelly OAuth Integration Routes
 * Allows customers to connect their Shelly account via OAuth
 */
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';

const router = express.Router();

// In-memory storage for OAuth states (use Redis in production)
const oauthStates = new Map();

// Shelly OAuth endpoints
const SHELLY_OAUTH_BASE = 'https://my.shelly.cloud';
const SHELLY_API_BASE = 'https://shelly-us.shelly.cloud'; // Change based on server region

/**
 * Step 1: Initiate OAuth flow
 * Customer clicks "Connect Shelly" button on your website
 */
router.get('/api/shelly/oauth/connect', (req, res) => {
  const { customerId, propertyId } = req.query;

  if (!customerId) {
    return res.status(400).json({ error: 'customerId required' });
  }

  // Generate random state for CSRF protection
  const state = crypto.randomBytes(16).toString('hex');
  
  // Store state with customer info (expires in 10 minutes)
  oauthStates.set(state, {
    customerId,
    propertyId,
    timestamp: Date.now()
  });

  // Clean up old states (older than 10 minutes)
  for (const [key, value] of oauthStates.entries()) {
    if (Date.now() - value.timestamp > 600000) {
      oauthStates.delete(key);
    }
  }

  const redirectUri = `${process.env.NGROK_URL || 'http://localhost:3001'}/api/shelly/oauth/callback`;
  
  // Build Shelly OAuth URL
  const authUrl = `${SHELLY_OAUTH_BASE}/oauth/authorize?` +
    `client_id=${process.env.SHELLY_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&state=${state}` +
    `&scope=devices`;

  res.json({ authUrl });
});

/**
 * Step 2: OAuth callback
 * Shelly redirects here after user approves
 */
router.get('/api/shelly/oauth/callback', async (req, res) => {
  const { code, state } = req.query;

  // Verify state (CSRF protection)
  const storedData = oauthStates.get(state);
  if (!storedData) {
    return res.status(400).send('Invalid or expired state. Please try again.');
  }

  oauthStates.delete(state);

  try {
    // Exchange authorization code for access token
    const redirectUri = `${process.env.NGROK_URL || 'http://localhost:3001'}/api/shelly/oauth/callback`;
    
    const tokenResponse = await axios.post(
      `${SHELLY_OAUTH_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.SHELLY_CLIENT_ID,
        client_secret: process.env.SHELLY_CLIENT_SECRET,
        code: code,
        redirect_uri: redirectUri
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Fetch user's devices using access token
    const devicesResponse = await axios.get(
      `${SHELLY_API_BASE}/device/list`,
      {
        headers: { 'Authorization': `Bearer ${access_token}` }
      }
    );

    const devices = devicesResponse.data.data?.devices || [];
    
    // Filter for Flood sensors only
    const floodSensors = devices.filter(device => 
      device.type === 'SHFLG-1' || device.name?.toLowerCase().includes('flood')
    );

    // Save to Firestore
    const firestoreService = require('../../backend/services/firestore-service.cjs');
    
    // Save OAuth tokens to customer profile
    await firestoreService.updateCustomer(storedData.customerId, {
      shellyOAuth: {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + (expires_in * 1000),
        connectedAt: new Date().toISOString()
      }
    });

    // Auto-register discovered sensors
    for (const device of floodSensors) {
      await firestoreService.registerSensor(device.id, {
        propertyId: storedData.propertyId || null,
        location: device.name || 'Unknown Location',
        deviceType: 'shelly_flood_gen4',
        manufacturer: 'Shelly',
        model: 'Flood Gen4',
        macAddress: device.mac || null,
        firmwareVersion: device.fw_version || null,
        connectedViaOAuth: true,
        customerId: storedData.customerId
      });
    }

    console.log(`✅ OAuth connected: ${floodSensors.length} sensors found for customer ${storedData.customerId}`);

    // Redirect back to your frontend with success
    res.redirect(`${process.env.VITE_NGROK_URL || 'http://localhost:5173'}/dashboard?shelly_connected=true&sensors=${floodSensors.length}`);

  } catch (error) {
    console.error('OAuth callback error:', error.response?.data || error.message);
    res.status(500).send('Failed to connect Shelly account. Please try again.');
  }
});

/**
 * Step 3: Fetch devices for a customer
 * Called periodically to sync new sensors
 */
router.get('/api/shelly/oauth/devices/:customerId', async (req, res) => {
  const { customerId } = req.params;

  try {
    const firestoreService = require('../../backend/services/firestore-service.cjs');
    
    // Get customer's OAuth tokens
    const customer = await firestoreService.getCustomer(customerId);
    
    if (!customer?.shellyOAuth?.accessToken) {
      return res.status(401).json({ error: 'Shelly account not connected' });
    }

    let accessToken = customer.shellyOAuth.accessToken;

    // Check if token expired, refresh if needed
    if (Date.now() >= customer.shellyOAuth.expiresAt) {
      const refreshResponse = await axios.post(
        `${SHELLY_OAUTH_BASE}/oauth/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.SHELLY_CLIENT_ID,
          client_secret: process.env.SHELLY_CLIENT_SECRET,
          refresh_token: customer.shellyOAuth.refreshToken
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );

      accessToken = refreshResponse.data.access_token;

      // Update tokens in Firestore
      await firestoreService.updateCustomer(customerId, {
        'shellyOAuth.accessToken': accessToken,
        'shellyOAuth.expiresAt': Date.now() + (refreshResponse.data.expires_in * 1000)
      });
    }

    // Fetch devices
    const devicesResponse = await axios.get(
      `${SHELLY_API_BASE}/device/list`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      }
    );

    const devices = devicesResponse.data.data?.devices || [];
    const floodSensors = devices.filter(device => 
      device.type === 'SHFLG-1' || device.name?.toLowerCase().includes('flood')
    );

    res.json({ 
      success: true, 
      sensors: floodSensors,
      count: floodSensors.length
    });

  } catch (error) {
    console.error('Error fetching devices:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

/**
 * Disconnect Shelly account
 */
router.post('/api/shelly/oauth/disconnect/:customerId', async (req, res) => {
  const { customerId } = req.params;

  try {
    const firestoreService = require('../../backend/services/firestore-service.cjs');
    
    await firestoreService.updateCustomer(customerId, {
      shellyOAuth: null
    });

    res.json({ success: true, message: 'Shelly account disconnected' });
  } catch (error) {
    console.error('Error disconnecting:', error.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

export default router;
