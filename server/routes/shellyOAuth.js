/**
 * Shelly OAuth API Endpoints
 * Handles customer Shelly account connections
 */
import express from 'express';
import shellyOAuthService from '../services/shellyOAuthService.js';
import firestoreService from '../../backend/services/firestore-service.cjs';

const router = express.Router();

/**
 * Step 1: Customer clicks "Connect Shelly Account" button
 * Redirects to Shelly OAuth page
 */
router.get('/api/shelly/connect', (req, res) => {
  try {
    const customerId = req.query.customerId || req.user?.id;
    
    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID required' });
    }

    const authUrl = shellyOAuthService.getAuthorizationUrl(customerId);
    
    // Redirect customer to Shelly OAuth page
    res.redirect(authUrl);
  } catch (error) {
    console.error('OAuth connection error:', error);
    res.status(500).json({ error: 'Failed to initiate OAuth' });
  }
});

/**
 * Step 2: Shelly redirects back here after customer approves
 * Exchange code for access token and import devices
 */
router.get('/api/shelly/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`/dashboard?error=shelly_oauth_${error}`);
    }

    if (!code || !state) {
      return res.redirect('/dashboard?error=invalid_oauth_response');
    }

    // Exchange code for access token
    const tokenData = await shellyOAuthService.exchangeCodeForToken(code, state);
    const { customerId, accessToken, refreshToken, expiresIn } = tokenData;

    // Save tokens to customer profile in Firestore
    await firestoreService.updateCustomer(customerId, {
      shellyIntegration: {
        connected: true,
        accessToken: accessToken,
        refreshToken: refreshToken,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        connectedAt: new Date().toISOString()
      }
    });

    // Fetch all customer's Shelly devices
    const devices = await shellyOAuthService.getCustomerDevices(accessToken);

    // Auto-register each device to Firestore
    for (const device of devices) {
      if (device.type === 'SHFLG-1' || device.name.toLowerCase().includes('flood')) {
        // This is a flood sensor - auto-register it
        
        // Find customer's property (or let them assign it in UI)
        const properties = await firestoreService.getPropertiesByCustomer(customerId);
        const defaultProperty = properties[0]; // Use first property for now

        if (defaultProperty) {
          await firestoreService.registerSensor(device.id, {
            propertyId: defaultProperty.id,
            deviceType: 'shelly_flood_gen4',
            manufacturer: 'Shelly',
            model: device.model || 'Flood Gen4',
            location: device.room || 'Not assigned',
            macAddress: device.mac,
            firmwareVersion: device.fw_version
          });

          console.log(`✅ Auto-registered sensor: ${device.id} to property ${defaultProperty.id}`);
        }
      }
    }

    // Redirect to success page
    res.redirect(`/dashboard?success=shelly_connected&devices=${devices.length}`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect('/dashboard?error=oauth_failed');
  }
});

/**
 * Get customer's connected Shelly devices
 */
router.get('/api/shelly/devices', async (req, res) => {
  try {
    const customerId = req.query.customerId || req.user?.id;
    
    if (!customerId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get customer's Shelly tokens
    const customer = await firestoreService.getCustomer(customerId);
    
    if (!customer?.shellyIntegration?.connected) {
      return res.json({ connected: false, devices: [] });
    }

    let { accessToken, refreshToken } = customer.shellyIntegration;

    // Check if token expired
    const expiresAt = new Date(customer.shellyIntegration.expiresAt);
    if (expiresAt < new Date()) {
      // Refresh token
      const newTokens = await shellyOAuthService.refreshAccessToken(refreshToken);
      accessToken = newTokens.accessToken;
      
      // Update customer tokens
      await firestoreService.updateCustomer(customerId, {
        'shellyIntegration.accessToken': newTokens.accessToken,
        'shellyIntegration.refreshToken': newTokens.refreshToken,
        'shellyIntegration.expiresAt': new Date(Date.now() + newTokens.expiresIn * 1000).toISOString()
      });
    }

    // Fetch devices
    const devices = await shellyOAuthService.getCustomerDevices(accessToken);

    res.json({
      connected: true,
      devices: devices
    });
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

/**
 * Disconnect Shelly account
 */
router.post('/api/shelly/disconnect', async (req, res) => {
  try {
    const customerId = req.body.customerId || req.user?.id;
    
    if (!customerId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Remove Shelly integration from customer
    await firestoreService.updateCustomer(customerId, {
      shellyIntegration: {
        connected: false,
        disconnectedAt: new Date().toISOString()
      }
    });

    res.json({ success: true, message: 'Shelly account disconnected' });
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

export default router;
