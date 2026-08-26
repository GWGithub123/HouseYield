/**
 * Sensor Alert Automation Service
 * 
 * This service handles automated responses to sensor alerts (flood, temperature, etc.)
 * by creating maintenance requests and notifying tenants via multiple channels:
 * 
 * 1. Email via Nodemailer (same system as tenant onboarding & interview scheduling)
 * 2. SMS via Twilio
 * 3. AI-powered phone calls via OpenAI Realtime + Twilio
 * 
 * The service retrieves tenant information from the property data
 * and uses it to personalize notifications.
 */

import twilio from 'twilio';
import { EventEmitter } from 'events';
import { sendSensorAlertEmail } from '../email-service.js';
import { updateCloudAlertNotification } from '../iot-cloud-firestore.js';
import { pickCurrentTenant } from './sensorAlertTenantResolver.js';
import {
  buildPublicWebhookUrlError,
  isLoopbackPublicWebhookUrl,
  resolvePublicWebhookUrl,
} from '../utils/publicWebhookUrl.js';

// ===================================================================
// CONFIGURATION
// ===================================================================

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

// Initialize Twilio client for SMS
let twilioClient = null;
if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_ACCOUNT_SID) {
  twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { 
    accountSid: TWILIO_ACCOUNT_SID 
  });
  console.log('✅ [SensorAlert] Twilio SMS client initialized');
} else if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('✅ [SensorAlert] Twilio SMS client initialized (auth token)');
} else {
  console.warn('⚠️  [SensorAlert] Twilio not configured - SMS notifications disabled');
}

// In-memory store for sensor alert automation records
const alertAutomationRecords = new Map();

// Track active notification attempts to prevent duplicates
const activeNotifications = new Map();

// ===================================================================
// MAIN SERVICE CLASS
// ===================================================================

class SensorAlertAutomationService extends EventEmitter {
  constructor() {
    super();
    this.voiceModule = null;
    this.firestoreService = null;
    this.initialized = false;
  }

  /**
   * Initialize with external modules
   * Note: Email notifications now use the centralized email-service.js (Nodemailer)
   * instead of the Gmail module, matching tenant onboarding and interview scheduling
   */
  initialize({ voiceModule, firestoreService } = {}) {
    this.voiceModule = voiceModule;
    this.firestoreService = firestoreService;
    this.initialized = true;
    console.log('✅ [SensorAlert] Automation service initialized with email/SMS/voice capabilities');
    
    return this;
  }

  /**
   * Process a sensor alert and trigger all notification channels
   * 
   * @param {object} alert - The sensor alert object
   * @param {object} propertyInfo - Property information containing tenant data
   * @param {object} options - Notification options
   */
  async processAlert(alert, propertyInfo = {}, options = {}) {
    const {
      sendEmail = true,
      sendSMS = true,
      makePhoneCall = true,
      createMaintenanceRequest = true,
      publicUrl = null
    } = options;

    const alertId = alert.id || `alert-${Date.now()}`;
    
    // Prevent duplicate processing
    if (activeNotifications.has(alertId)) {
      console.log(`[SensorAlert] Alert ${alertId} already being processed`);
      return { ok: false, error: 'Alert already being processed' };
    }

    activeNotifications.set(alertId, { startedAt: Date.now() });

    console.log('🚨 [SensorAlert] Processing alert:', alertId);
    console.log('[SensorAlert] Alert type:', alert.type);
    console.log('[SensorAlert] Property:', propertyInfo.address || 'Unknown');

    const result = {
      alertId,
      alert,
      propertyInfo,
      notifications: {
        email: null,
        sms: null,
        phoneCall: null
      },
      maintenanceRequest: null,
      timestamp: new Date().toISOString()
    };

    try {
      const currentTenant = pickCurrentTenant(propertyInfo);

      if (!currentTenant) {
        console.warn('[SensorAlert] No tenant found for property');
        result.error = 'No tenant found for property';
        activeNotifications.delete(alertId);
        return result;
      }

      console.log('[SensorAlert] Found tenant:', currentTenant.name);
      console.log('[SensorAlert] Tenant email:', currentTenant.email);
      console.log('[SensorAlert] Tenant phone:', currentTenant.phone);

      // Create maintenance request first
      if (createMaintenanceRequest) {
        result.maintenanceRequest = await this.createMaintenanceRequestFromAlert(alert, propertyInfo, currentTenant);
      }

      // Run notifications in parallel for speed
      const notificationPromises = [];

      // Send Email (pass maintenanceRequest for reference in email)
      if (sendEmail && currentTenant.email) {
        notificationPromises.push(
          this.sendEmailNotification(alert, currentTenant, propertyInfo, result.maintenanceRequest)
            .then(emailResult => { result.notifications.email = emailResult; })
            .catch(err => { 
              result.notifications.email = { ok: false, error: err.message };
            })
        );
      }

      // Send SMS
      if (sendSMS && currentTenant.phone) {
        notificationPromises.push(
          this.sendSMSNotification(alert, currentTenant, propertyInfo)
            .then(smsResult => { result.notifications.sms = smsResult; })
            .catch(err => { 
              result.notifications.sms = { ok: false, error: err.message };
            })
        );
      }

      // Make AI Phone Call
      if (makePhoneCall && currentTenant.phone) {
        const resolvedPublicUrl = publicUrl || resolvePublicWebhookUrl();
        if (!resolvedPublicUrl || isLoopbackPublicWebhookUrl(resolvedPublicUrl)) {
          result.notifications.phoneCall = {
            ok: false,
            error: buildPublicWebhookUrlError(resolvedPublicUrl || publicUrl),
          };
        } else {
          notificationPromises.push(
            this.makeAIPhoneCall(alert, currentTenant, propertyInfo, resolvedPublicUrl)
              .then(callResult => { result.notifications.phoneCall = callResult; })
              .catch(err => {
                result.notifications.phoneCall = { ok: false, error: err.message };
              })
          );
        }
      } else if (makePhoneCall && !currentTenant.phone) {
        result.notifications.phoneCall = { ok: false, error: 'No phone number available' };
      }

      await Promise.all(notificationPromises);

      const tenantNotification = {
        sentAt: new Date().toISOString(),
        tenantName: currentTenant.name,
        tenantEmail: currentTenant.email || null,
        tenantPhone: currentTenant.phone || null,
        channels: result.notifications,
        maintenanceRequestId: result.maintenanceRequest?.id || null,
      };

      result.tenantNotification = tenantNotification;

      try {
        await updateCloudAlertNotification(alertId, {
          notificationSent: true,
          tenantNotifiedAt: tenantNotification.sentAt,
          tenantNotification,
        });
      } catch (persistError) {
        console.warn('[SensorAlert] Could not persist tenant notification on alert:', persistError.message);
      }

      // Store the automation record
      alertAutomationRecords.set(alertId, result);

      // Emit event for external handlers
      this.emit('alert:processed', result);

      console.log('✅ [SensorAlert] Alert processing complete:', alertId);

    } catch (error) {
      console.error('[SensorAlert] Error processing alert:', error);
      result.error = error.message;
    } finally {
      activeNotifications.delete(alertId);
    }

    return result;
  }

  /**
   * Create a maintenance request from a sensor alert
   */
  async createMaintenanceRequestFromAlert(alert, propertyInfo, tenant) {
    const alertTypeToCategory = {
      'flood': 'Plumbing',
      'water_leak': 'Plumbing',
      'temperature': 'HVAC',
      'freeze_risk': 'Plumbing',
      'pipe_burst': 'Plumbing',
      'mold_risk': 'Moisture',
      'insulation_failure': 'HVAC',
      'rapid_temp_change': 'HVAC',
      'humidity_damage': 'Moisture',
      'energy_waste': 'HVAC',
      'low_battery': 'Other',
      'offline': 'Other',
      'power_outage': 'Electrical',
      'motion': 'Lock/Security'
    };

    const maintenanceRequest = {
      id: `sensor-${alert.id || Date.now()}`,
      category: alertTypeToCategory[alert.type] || 'Other',
      serviceType: (['flood', 'water_leak', 'freeze_risk', 'pipe_burst'].includes(alert.type)) ? 'plumbing' 
        : (['mold_risk', 'humidity_damage'].includes(alert.type)) ? 'moisture_remediation'
        : (['insulation_failure', 'energy_waste', 'rapid_temp_change'].includes(alert.type)) ? 'hvac'
        : 'general',
      priority: alert.level === 'critical' ? 'emergency' : (alert.level === 'warning' ? 'high' : 'normal'),
      description: this.formatAlertDescription(alert),
      location: alert.sensorLocation || 'Unknown',
      propertyAddress: propertyInfo.address || '',
      unit: tenant?.unit || '',
      status: 'submitted',
      createdAt: new Date().toISOString(),
      source: 'sensor_automation',
      sensorId: alert.deviceId,
      sensorType: alert.type,
      tenantInfo: {
        name: tenant?.name,
        email: tenant?.email,
        phone: tenant?.phone
      },
      aiAutomation: {
        status: 'pending',
        triggeredBy: 'sensor_alert'
      }
    };

    console.log('[SensorAlert] Created maintenance request:', maintenanceRequest.id);
    
    // Store in memory (in production, save to database)
    this.emit('maintenanceRequest:created', maintenanceRequest);

    return maintenanceRequest;
  }

  /**
   * Format alert description for human readability
   */
  formatAlertDescription(alert) {
    const typeDescriptions = {
      'flood': '🚨 FLOOD/WATER LEAK DETECTED',
      'water_leak': '🚨 WATER LEAK DETECTED',
      'temperature': '🌡️ ABNORMAL TEMPERATURE DETECTED',
      'freeze_risk': '❄️ FREEZE / PIPE BURST RISK',
      'pipe_burst': '🧊 PIPE BURST RISK — Temperature critically low',
      'mold_risk': '🦠 MOLD GROWTH RISK — Sustained high humidity',
      'insulation_failure': '🏠 INSULATION GAP DETECTED — Room significantly colder than others',
      'rapid_temp_change': '📉 RAPID TEMPERATURE CHANGE — Possible HVAC failure or window breach',
      'humidity_damage': '💧 HUMIDITY DAMAGE RISK — Extended high moisture levels',
      'energy_waste': '⚡ ENERGY WASTE DETECTED — HVAC running inefficiently',
      'low_battery': '🔋 LOW BATTERY ALERT',
      'offline': '📡 SENSOR OFFLINE',
      'power_outage': '⚡ POSSIBLE POWER OUTAGE',
      'motion': '🚶 MOTION DETECTED'
    };

    const baseDescription = typeDescriptions[alert.type] || `⚠️ SENSOR ALERT: ${alert.type}`;
    
    let details = alert.message || '';
    
    if (alert.type === 'flood' && alert.data) {
      details += ` Water detected at ${alert.sensorLocation || 'sensor location'}. `;
      details += alert.data.temperature ? `Temperature: ${alert.data.temperature}°C. ` : '';
    }

    return `${baseDescription}\n\n${details}\n\nSensor: ${alert.deviceId}\nLocation: ${alert.sensorLocation || 'Unknown'}\nTime: ${new Date(alert.timestamp).toLocaleString()}`;
  }

  /**
   * Send email notification via Nodemailer
   * Uses the same email infrastructure as tenant onboarding and interview scheduling
   */
  async sendEmailNotification(alert, tenant, propertyInfo, maintenanceRequest = null) {
    if (!tenant.email) {
      console.warn('[SensorAlert] No email address for tenant');
      return { ok: false, error: 'No email address available' };
    }

    console.log('[SensorAlert] Sending email to:', tenant.email);

    try {
      const result = await sendSensorAlertEmail({
        to: tenant.email,
        tenantName: tenant.name,
        propertyAddress: propertyInfo.address || '',
        alert: {
          type: alert.type,
          level: alert.level || alert.severity || 'warning',
          message: alert.message,
          deviceId: alert.deviceId,
          sensorLocation: alert.sensorLocation || alert.location || 'Unknown',
          timestamp: alert.timestamp
        },
        maintenanceRequest
      });

      if (result.ok) {
        console.log('[SensorAlert] ✅ Email sent successfully via Nodemailer');
      } else {
        console.error('[SensorAlert] ❌ Email failed:', result.error);
      }

      return result;
    } catch (error) {
      console.error('[SensorAlert] Email error:', error);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Send SMS notification via Twilio
   */
  async sendSMSNotification(alert, tenant, propertyInfo) {
    if (!twilioClient) {
      console.warn('[SensorAlert] Twilio not configured for SMS');
      return { ok: false, error: 'Twilio not configured' };
    }

    if (!tenant.phone) {
      return { ok: false, error: 'No phone number available' };
    }

    // Format phone number for Twilio
    let phoneNumber = tenant.phone.replace(/\D/g, '');
    if (phoneNumber.length === 10) {
      phoneNumber = '+1' + phoneNumber;
    } else if (phoneNumber.length === 11 && phoneNumber[0] === '1') {
      phoneNumber = '+' + phoneNumber;
    } else if (!phoneNumber.startsWith('+')) {
      phoneNumber = '+' + phoneNumber;
    }

    const smsBody = this.generateSMSBody(alert, tenant, propertyInfo);

    console.log('[SensorAlert] Sending SMS to:', phoneNumber);
    console.log('[SensorAlert] SMS From:', TWILIO_FROM_NUMBER);
    console.log('[SensorAlert] SMS Body:', smsBody);

    try {
      const message = await twilioClient.messages.create({
        body: smsBody,
        from: TWILIO_FROM_NUMBER,
        to: phoneNumber
      });

      console.log('[SensorAlert] ✅ SMS sent successfully, SID:', message.sid);
      console.log('[SensorAlert] SMS Status:', message.status);
      console.log('[SensorAlert] SMS Error Code:', message.errorCode);
      console.log('[SensorAlert] SMS Error Message:', message.errorMessage);
      
      return {
        ok: true,
        messageSid: message.sid,
        to: phoneNumber,
        status: message.status
      };
    } catch (error) {
      console.error('[SensorAlert] ❌ SMS failed:', error.message);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Generate SMS message body
   */
  generateSMSBody(alert, tenant, propertyInfo) {
    const urgency = alert.level === 'critical' ? '🚨 URGENT' : '⚠️ Alert';
    const location = alert.sensorLocation || 'your property';
    const propertyName = propertyInfo.address ? ` at ${propertyInfo.address}` : '';

    const alertMessages = {
      'flood': `${urgency}: Water leak detected at ${location}${propertyName}! Please check immediately. Turn off water if safe. A maintenance request has been created.`,
      'water_leak': `${urgency}: Water leak detected at ${location}${propertyName}! Please check immediately.`,
      'temperature': `${urgency}: Abnormal temperature detected at ${location}${propertyName}. Please check your HVAC system.`,
      'low_battery': `⚠️ Low battery on sensor at ${location}${propertyName}. Replacement recommended.`,
      'offline': `📡 Sensor at ${location}${propertyName} is offline. Please check the device.`,
      'power_outage': `${urgency}: Mains-powered monitors at ${location}${propertyName} went silent. This may indicate a property power outage or internet failure.`
    };

    return alertMessages[alert.type] || `${urgency}: Sensor alert at ${location}${propertyName}. Please check the property.`;
  }

  /**
   * Make AI-powered phone call to tenant
   */
  async makeAIPhoneCall(alert, tenant, propertyInfo, publicUrl) {
    if (!this.voiceModule?.makeOutboundCall) {
      console.warn('[SensorAlert] Voice module not available');
      return { ok: false, error: 'Voice module not configured' };
    }

    if (!tenant.phone) {
      return { ok: false, error: 'No phone number available' };
    }

    // Format phone number
    let phoneNumber = tenant.phone.replace(/\D/g, '');
    if (phoneNumber.length === 10) {
      phoneNumber = '+1' + phoneNumber;
    } else if (phoneNumber.length === 11 && phoneNumber[0] === '1') {
      phoneNumber = '+' + phoneNumber;
    } else if (!phoneNumber.startsWith('+')) {
      phoneNumber = '+' + phoneNumber;
    }

    // Create maintenance context for the AI call
    const maintenanceContext = {
      issue: this.formatAlertDescription(alert),
      urgency: alert.level === 'critical' ? 'emergency' : 'high',
      serviceCategory: alert.type === 'flood' ? 'plumbing' : 'general',
      propertyAddress: propertyInfo.address || '',
      tenantName: tenant.name,
      tenantPhone: tenant.phone,
      tenantEmail: tenant.email,
      alertType: alert.type,
      sensorLocation: alert.sensorLocation || 'Unknown',
      callerType: 'tenant_notification',
      callScript: {
        greeting: `Hello ${tenant.name}, this is an automated call from your property management regarding an urgent alert at your residence.`,
        issueDescription: this.getCallIssueDescription(alert),
        instructions: this.getCallInstructions(alert),
        closing: 'A maintenance professional has been notified and may contact you shortly. Is there anything else you need assistance with?'
      }
    };

    console.log('[SensorAlert] Initiating AI phone call to:', phoneNumber);

    try {
      const result = await this.voiceModule.makeOutboundCall(phoneNumber, {
        publicUrl,
        maintenanceContext
      });

      console.log('[SensorAlert] ✅ Phone call initiated, SID:', result.callSid);

      return {
        ok: true,
        callSid: result.callSid,
        to: phoneNumber,
        status: result.status
      };
    } catch (error) {
      console.error('[SensorAlert] ❌ Phone call failed:', error.message);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Get issue description for phone call
   */
  getCallIssueDescription(alert) {
    const descriptions = {
      'flood': 'Our water leak sensor has detected water at your property. This could indicate a pipe leak, appliance malfunction, or flooding.',
      'water_leak': 'Our sensor has detected a water leak at your property.',
      'temperature': 'Our temperature sensor has detected an abnormal temperature reading at your property.',
      'low_battery': 'One of the safety sensors at your property has a low battery and needs replacement.',
      'offline': 'One of the safety sensors at your property appears to be offline.'
    };
    return descriptions[alert.type] || 'A sensor has detected an issue at your property.';
  }

  /**
   * Get instructions for phone call based on alert type
   */
  getCallInstructions(alert) {
    const instructions = {
      'flood': 'For your safety, please locate your main water shutoff valve and turn off the water supply if you believe there is a significant leak. Avoid using electrical appliances near any standing water. Move valuable items away from the affected area if possible.',
      'water_leak': 'If you can safely access the source of the leak, please turn off the local water supply. If water is spreading, please locate your main water shutoff valve.',
      'temperature': 'Please check your thermostat and HVAC system. Make sure all windows and doors are properly closed.',
      'low_battery': 'The sensor will continue to work for a short time, but we recommend replacing the battery soon to ensure continuous protection.',
      'offline': 'Please check if the sensor has power and is properly connected.'
    };
    return instructions[alert.type] || 'Please check your property for any issues.';
  }

  /**
   * Get all alert automation records
   */
  getAlertRecords(limit = 50) {
    const records = Array.from(alertAutomationRecords.values());
    return records.slice(-limit).reverse();
  }

  /**
   * Get a specific alert record
   */
  getAlertRecord(alertId) {
    return alertAutomationRecords.get(alertId);
  }

  /**
   * Clear old records (call periodically for cleanup)
   */
  cleanupOldRecords(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, record] of alertAutomationRecords) {
      const recordTime = new Date(record.timestamp).getTime();
      if (now - recordTime > maxAgeMs) {
        alertAutomationRecords.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[SensorAlert] Cleaned up ${cleaned} old records`);
    }
  }
}

// ===================================================================
// SINGLETON INSTANCE
// ===================================================================

const sensorAlertAutomation = new SensorAlertAutomationService();

// Cleanup old records every hour
setInterval(() => {
  sensorAlertAutomation.cleanupOldRecords();
}, 60 * 60 * 1000);

// ===================================================================
// EXPORTS
// ===================================================================

export {
  sensorAlertAutomation,
  SensorAlertAutomationService,
  twilioClient,
  alertAutomationRecords
};

export default sensorAlertAutomation;
