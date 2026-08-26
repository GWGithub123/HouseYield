/**
 * Shelly OAuth Integration Service
 * Allows customers to connect their Shelly account to your platform
 */
import axios from 'axios';
import crypto from 'crypto';

class ShellyOAuthService {
  constructor() {
    // You'll get these after registering your app with Shelly
    this.clientId = process.env.SHELLY_OAUTH_CLIENT_ID;
    this.clientSecret = process.env.SHELLY_OAUTH_CLIENT_SECRET;
    this.redirectUri = process.env.SHELLY_OAUTH_REDIRECT_URI || 'http://localhost:5173/shelly/callback';
    this.baseUrl = 'https://api.shelly.cloud';
  }

  /**
   * Generate OAuth authorization URL
   * Customer clicks this to connect their Shelly account
   */
  getAuthorizationUrl(customerId) {
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store state with customerId to verify callback
    // In production, save this to Redis/database
    global.shellyOAuthStates = global.shellyOAuthStates || {};
    global.shellyOAuthStates[state] = {
      customerId,
      timestamp: Date.now()
    };

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state: state,
      scope: 'device:read device:control'
    });

    return `${this.baseUrl}/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code, state) {
    try {
      // Verify state
      const stateData = global.shellyOAuthStates?.[state];
      if (!stateData) {
        throw new Error('Invalid state parameter');
      }

      // Exchange code for token
      const response = await axios.post(
        `${this.baseUrl}/oauth/token`,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const { access_token, refresh_token, expires_in } = response.data;

      // Clean up state
      delete global.shellyOAuthStates[state];

      return {
        customerId: stateData.customerId,
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresIn: expires_in
      };
    } catch (error) {
      console.error('Token exchange error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get all devices for a customer using their access token
   */
  async getCustomerDevices(accessToken) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/device/list`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        }
      );

      return response.data.data?.devices || [];
    } catch (error) {
      console.error('Error fetching customer devices:', error.message);
      throw error;
    }
  }

  /**
   * Get device status using customer's access token
   */
  async getDeviceStatus(accessToken, deviceId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/device/status`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          },
          params: {
            id: deviceId
          }
        }
      );

      return response.data.data;
    } catch (error) {
      console.error(`Error fetching device ${deviceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Refresh expired access token
   */
  async refreshAccessToken(refreshToken) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/oauth/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.clientId,
          client_secret: this.clientSecret
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const { access_token, refresh_token: new_refresh_token, expires_in } = response.data;

      return {
        accessToken: access_token,
        refreshToken: new_refresh_token || refreshToken,
        expiresIn: expires_in
      };
    } catch (error) {
      console.error('Token refresh error:', error.message);
      throw error;
    }
  }
}

export default new ShellyOAuthService();
