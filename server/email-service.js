/**
 * Email Service
 * Prefers Gmail OAuth with a desktop-app client and falls back to SMTP only when
 * no Gmail OAuth credentials file is present.
 */

import { existsSync } from 'fs';
import nodemailer from 'nodemailer';
import path from 'path';
import dotenv from 'dotenv';
import { getGmailAuthStatus, sendSecureGmail, sendSecureGmailWithAttachments } from './gmail-oauth2-secure.js';

dotenv.config();

const DEFAULT_HOUSEYIELD_EMAIL = 'admin@myhouseyield.com';
const HOUSEYIELD_EMAIL = process.env.HOUSEYIELD_EMAIL_ADDRESS || DEFAULT_HOUSEYIELD_EMAIL;
const EMAIL_PASSWORD = process.env.HOUSEYIELD_EMAIL_PASSWORD;
const GMAIL_CREDENTIALS_PATH = path.join(process.cwd(), 'server', '.gmail-credentials.json');
const EMAIL_CONFIG_ERROR = `Email not configured. Save the Gmail OAuth desktop client JSON to ${GMAIL_CREDENTIALS_PATH} and complete /auth/gmail authorization.`;

// Create reusable transporter
let transporter = null;

function getTransporter() {
  if (!transporter) {
    if (!EMAIL_PASSWORD) {
      console.warn(`[Email Service] ⚠️ HOUSEYIELD_EMAIL_PASSWORD not set in .env for sender ${HOUSEYIELD_EMAIL}; SMTP fallback disabled`);
      return null;
    }
    
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: HOUSEYIELD_EMAIL,
        pass: EMAIL_PASSWORD
      }
    });
    
    console.log(`[Email Service] ✅ Nodemailer transporter created for ${HOUSEYIELD_EMAIL}`);
  }
  return transporter;
}

function hasGmailOAuthCredentials() {
  return existsSync(GMAIL_CREDENTIALS_PATH);
}

function toEmailFailure(result) {
  const failure = {
    ok: false,
    error: result.error || EMAIL_CONFIG_ERROR,
  };

  if (result.skipped) {
    failure.skipped = true;
  }

  if (result.needsAuthorization) {
    failure.needsAuthorization = true;
  }

  if (result.authUrl) {
    failure.authUrl = result.authUrl;
  }

  if (result.redirectUri) {
    failure.redirectUri = result.redirectUri;
  }

  return failure;
}

async function sendHouseYieldMail(mailOptions) {
  if (hasGmailOAuthCredentials()) {
    const result = await sendSecureGmail({
      to: mailOptions.to,
      subject: mailOptions.subject,
      html: mailOptions.html,
      from: mailOptions.from?.address || HOUSEYIELD_EMAIL,
    });

    if (result.ok) {
      return {
        ok: true,
        messageId: result.messageId || result.id,
        provider: 'gmail-oauth',
      };
    }

    return {
      ok: false,
      error: result.error,
      provider: 'gmail-oauth',
      needsAuthorization: result.needsAuthorization,
      authUrl: result.authUrl,
      redirectUri: result.redirectUri,
    };
  }

  const transport = getTransporter();
  if (!transport) {
    return {
      ok: false,
      error: EMAIL_CONFIG_ERROR,
      skipped: true,
      provider: 'smtp',
    };
  }

  try {
    const info = await transport.sendMail(mailOptions);
    return {
      ok: true,
      messageId: info.messageId,
      provider: 'smtp',
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      provider: 'smtp',
    };
  }
}

/**
 * Send a tenant onboarding invitation email
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.tenantName - Tenant's name
 * @param {string} options.ownerName - Property owner's name
 * @param {string} options.ownerEmail - Owner's email for contact
 * @param {string} options.propertyAddress - Property address
 * @param {string} options.unit - Unit number (optional)
 * @param {string} options.inviteLink - Registration link with token
 * @param {Date} options.expiresAt - When the invite expires
 */
export async function sendTenantInviteEmail({
  to,
  tenantName,
  ownerName,
  ownerEmail,
  propertyAddress,
  unit,
  inviteLink,
  expiresAt
}) {
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f5; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); color: white; padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0; }
        .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
        .header-icon { font-size: 48px; margin-bottom: 10px; }
        .content { background: white; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none; }
        .greeting { font-size: 20px; color: #1f2937; margin-bottom: 20px; }
        .property-card { background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); padding: 24px; border-radius: 12px; margin: 24px 0; border-left: 4px solid #7c3aed; }
        .property-card h3 { margin: 0 0 16px 0; color: #7c3aed; font-size: 18px; }
        .property-detail { margin: 8px 0; color: #4b5563; }
        .property-detail strong { color: #1f2937; }
        .features-list { list-style: none; padding: 0; margin: 24px 0; }
        .features-list li { padding: 12px 0; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; }
        .features-list li:last-child { border-bottom: none; }
        .feature-icon { margin-right: 12px; font-size: 20px; }
        .cta-container { text-align: center; margin: 32px 0; }
        .button { display: inline-block; background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 14px rgba(124, 58, 237, 0.4); }
        .warning-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px 20px; margin: 24px 0; border-radius: 0 8px 8px 0; }
        .warning-box strong { color: #92400e; }
        .footer { text-align: center; padding: 24px; color: #6b7280; font-size: 13px; background: #f9fafb; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none; }
        .help-text { color: #6b7280; font-size: 14px; margin-top: 24px; padding-top: 24px; border-top: 1px solid #e5e7eb; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="header-icon">🏠</div>
          <h1>Welcome to HouseYield!</h1>
        </div>
        <div class="content">
          <p class="greeting">Hello ${tenantName || 'there'}! 👋</p>
          <p><strong>${ownerName || 'Your property manager'}</strong> has invited you to join the tenant portal for your rental property.</p>
          
          <div class="property-card">
            <h3>📍 Your Property Details</h3>
            <p class="property-detail"><strong>Address:</strong> ${propertyAddress}</p>
            ${unit ? `<p class="property-detail"><strong>Unit:</strong> ${unit}</p>` : ''}
            <p class="property-detail"><strong>Property Manager:</strong> ${ownerName || 'Your Landlord'}</p>
          </div>

          <p style="font-weight: 600; color: #1f2937;">With your tenant portal, you can:</p>
          <ul class="features-list">
            <li><span class="feature-icon">💳</span> Pay rent online securely with ACH or card</li>
            <li><span class="feature-icon">🔧</span> Submit and track maintenance requests</li>
            <li><span class="feature-icon">📄</span> View and digitally sign lease documents</li>
            <li><span class="feature-icon">💬</span> Message your property manager directly</li>
            <li><span class="feature-icon">📊</span> View payment history and receipts</li>
          </ul>

          <div class="cta-container">
            <a href="${inviteLink}" class="button">Create Your Account →</a>
          </div>

          <div class="warning-box">
            <strong>⏱️ This link expires in 48 hours</strong><br>
            Please create your account before ${expiresAt ? new Date(expiresAt).toLocaleString() : '48 hours'}
          </div>

          <p class="help-text">
            If you didn't expect this invitation or have questions, please contact ${ownerName || 'your property manager'}${ownerEmail ? ` at <a href="mailto:${ownerEmail}">${ownerEmail}</a>` : ''}.
          </p>
        </div>
        <div class="footer">
          <p style="margin: 0 0 8px 0;"><strong>HouseYield</strong> - Modern Property Management</p>
          <p style="margin: 0; color: #9ca3af;">This is an automated message. Please do not reply directly to this email.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: {
      name: 'HouseYield',
      address: HOUSEYIELD_EMAIL
    },
    to,
    subject: `🏠 You're invited to your tenant portal - ${propertyAddress}`,
    html: emailHtml
  };

  const result = await sendHouseYieldMail(mailOptions);
  if (result.ok) {
    console.log(`[Email Service] ✅ Tenant invite sent to ${to} via ${result.provider} (messageId: ${result.messageId})`);
    return {
      ok: true,
      messageId: result.messageId,
      to,
    };
  }

  console.error(`[Email Service] ❌ Failed to send to ${to}:`, result.error);
  return toEmailFailure(result);
}

/**
 * Send a generic HTML email
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 */
export async function sendHtmlEmail({ to, subject, html }) {
  const mailOptions = {
    from: {
      name: 'HouseYield',
      address: HOUSEYIELD_EMAIL
    },
    to,
    subject,
    html
  };

  const result = await sendHouseYieldMail(mailOptions);
  if (result.ok) {
    console.log(`[Email Service] ✅ Email sent to ${to} via ${result.provider} (messageId: ${result.messageId})`);
    return {
      ok: true,
      messageId: result.messageId,
    };
  }

  console.error(`[Email Service] ❌ Failed to send to ${to}:`, result.error);
  return toEmailFailure(result);
}

/**
 * Send a document signature request email
 */
export async function sendDocumentSignatureEmail({
  to,
  signerName,
  documentTitle,
  senderName,
  propertyAddress,
  signatureLink,
  expiresAt
}) {
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f5; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); color: white; padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0; }
        .content { background: white; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none; }
        .document-card { background: #f8fafc; padding: 24px; border-radius: 12px; margin: 24px 0; border-left: 4px solid #7c3aed; }
        .cta-container { text-align: center; margin: 32px 0; }
        .button { display: inline-block; background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 10px; font-weight: 600; }
        .footer { text-align: center; padding: 24px; color: #6b7280; font-size: 13px; background: #f9fafb; border-radius: 0 0 12px 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div style="font-size: 48px; margin-bottom: 10px;">✍️</div>
          <h1 style="margin: 0;">Document Ready for Signature</h1>
        </div>
        <div class="content">
          <p>Hello ${signerName || 'there'},</p>
          <p><strong>${senderName}</strong> has sent you a document to review and sign.</p>
          
          <div class="document-card">
            <h3 style="margin: 0 0 16px 0; color: #7c3aed;">📄 ${documentTitle}</h3>
            ${propertyAddress ? `<p><strong>Property:</strong> ${propertyAddress}</p>` : ''}
            <p><strong>From:</strong> ${senderName}</p>
          </div>

          <div class="cta-container">
            <a href="${signatureLink}" class="button">Review & Sign Document →</a>
          </div>

          ${expiresAt ? `<p style="text-align: center; color: #6b7280;">This link expires on ${new Date(expiresAt).toLocaleString()}</p>` : ''}
        </div>
        <div class="footer">
          <p><strong>HouseYield</strong> - Secure Document Signing</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: { name: 'HouseYield', address: HOUSEYIELD_EMAIL },
    to,
    subject: `📝 Please sign: ${documentTitle}`,
    html: emailHtml
  };

  const result = await sendHouseYieldMail(mailOptions);
  if (result.ok) {
    console.log(`[Email Service] ✅ Signature request sent to ${to} via ${result.provider}`);
    return { ok: true, messageId: result.messageId };
  }

  console.error('[Email Service] ❌ Signature email failed:', result.error);
  return toEmailFailure(result);
}

/**
 * Send a tenant interview scheduling email
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.applicantName - Applicant's name
 * @param {string} options.propertyAddress - Property address
 * @param {string} options.ownerName - Property owner's name
 * @param {string} options.bookingLink - Link to book interview time slot
 * @param {Date} options.expiresAt - When the booking link expires
 */
export async function sendInterviewSchedulingEmail({
  to,
  applicantName,
  propertyAddress,
  ownerName,
  bookingLink,
  expiresAt
}) {
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f5; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: white; padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0; }
        .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
        .header-icon { font-size: 48px; margin-bottom: 10px; }
        .content { background: white; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none; }
        .greeting { font-size: 20px; color: #1f2937; margin-bottom: 20px; }
        .property-card { background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); padding: 24px; border-radius: 12px; margin: 24px 0; border-left: 4px solid #059669; }
        .property-card h3 { margin: 0 0 16px 0; color: #059669; font-size: 18px; }
        .steps-list { list-style: none; padding: 0; margin: 24px 0; }
        .steps-list li { padding: 16px 0; border-bottom: 1px solid #e5e7eb; display: flex; align-items: flex-start; }
        .steps-list li:last-child { border-bottom: none; }
        .step-number { width: 32px; height: 32px; background: #059669; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 16px; flex-shrink: 0; }
        .step-content { flex: 1; }
        .step-title { font-weight: 600; color: #1f2937; margin-bottom: 4px; }
        .step-desc { font-size: 14px; color: #6b7280; }
        .cta-container { text-align: center; margin: 32px 0; }
        .button { display: inline-block; background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 14px rgba(5, 150, 105, 0.4); }
        .info-box { background: #eff6ff; border-left: 4px solid #3b82f6; padding: 16px 20px; margin: 24px 0; border-radius: 0 8px 8px 0; }
        .info-box strong { color: #1d4ed8; }
        .warning-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px 20px; margin: 24px 0; border-radius: 0 8px 8px 0; }
        .warning-box strong { color: #92400e; }
        .footer { text-align: center; padding: 24px; color: #6b7280; font-size: 13px; background: #f9fafb; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="header-icon">📞</div>
          <h1>Schedule Your Phone Interview</h1>
        </div>
        <div class="content">
          <p class="greeting">Hello ${applicantName || 'there'}! 👋</p>
          <p>Great news! <strong>${ownerName || 'The property manager'}</strong> would like to schedule a brief phone interview as part of your rental application.</p>
          
          <div class="property-card">
            <h3>📍 Property You Applied For</h3>
            <p style="margin: 0; color: #374151; font-weight: 500;">${propertyAddress}</p>
          </div>

          <p style="font-weight: 600; color: #1f2937;">How it works:</p>
          <ul class="steps-list">
            <li>
              <div class="step-number">1</div>
              <div class="step-content">
                <div class="step-title">Choose Your Time</div>
                <div class="step-desc">Click the button below to pick a time slot that works for you</div>
              </div>
            </li>
            <li>
              <div class="step-number">2</div>
              <div class="step-content">
                <div class="step-title">Receive a Call</div>
                <div class="step-desc">Our AI assistant will call you at your scheduled time</div>
              </div>
            </li>
            <li>
              <div class="step-number">3</div>
              <div class="step-content">
                <div class="step-title">Quick Conversation</div>
                <div class="step-desc">Answer a few questions about your rental history and plans (10-15 min)</div>
              </div>
            </li>
            <li>
              <div class="step-number">4</div>
              <div class="step-content">
                <div class="step-title">Get Results</div>
                <div class="step-desc">We'll follow up within 2-3 business days with our decision</div>
              </div>
            </li>
          </ul>

          <div class="cta-container">
            <a href="${bookingLink}" class="button">📅 Schedule My Interview →</a>
          </div>

          <div class="info-box">
            <strong>💡 Interview Tips:</strong><br>
            Find a quiet place with good phone reception. Be ready to discuss your employment, rental history, and move-in timeline. There are no wrong answers - we just want to get to know you!
          </div>

          <div class="warning-box">
            <strong>⏱️ Please schedule within 48 hours</strong><br>
            This booking link expires on ${expiresAt ? new Date(expiresAt).toLocaleString() : 'soon'}
          </div>
        </div>
        <div class="footer">
          <p style="margin: 0 0 8px 0;"><strong>HouseYield</strong> - Modern Property Management</p>
          <p style="margin: 0; color: #9ca3af;">Questions? Reply to this email or contact ${ownerName || 'your property manager'}.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: { name: 'HouseYield', address: HOUSEYIELD_EMAIL },
    to,
    subject: `📞 Schedule your phone interview for ${propertyAddress}`,
    html: emailHtml
  };

  const result = await sendHouseYieldMail(mailOptions);
  if (result.ok) {
    console.log(`[Email Service] ✅ Interview scheduling email sent to ${to} via ${result.provider}`);
    return { ok: true, messageId: result.messageId, to };
  }

  console.error('[Email Service] ❌ Interview scheduling email failed:', result.error);
  return toEmailFailure(result);
}

/**
 * Send interview confirmation email after booking
 * @param {Object} options
 */
export async function sendInterviewConfirmationEmail({
  to,
  applicantName,
  propertyAddress,
  scheduledTime,
  applicantPhone
}) {
  const formattedTime = new Date(scheduledTime).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  });

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f5; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: white; padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0; }
        .content { background: white; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none; }
        .success-icon { font-size: 64px; margin-bottom: 10px; }
        .appointment-card { background: #f0fdf4; padding: 24px; border-radius: 12px; margin: 24px 0; text-align: center; border: 2px solid #10b981; }
        .appointment-time { font-size: 24px; font-weight: bold; color: #059669; margin: 10px 0; }
        .phone-info { background: #eff6ff; padding: 16px; border-radius: 8px; margin: 16px 0; text-align: center; }
        .footer { text-align: center; padding: 24px; color: #6b7280; font-size: 13px; background: #f9fafb; border-radius: 0 0 12px 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="success-icon">✅</div>
          <h1 style="margin: 0;">Interview Scheduled!</h1>
        </div>
        <div class="content">
          <p>Hi ${applicantName},</p>
          <p>Your phone interview has been confirmed! Here are the details:</p>
          
          <div class="appointment-card">
            <div style="font-size: 36px;">📞</div>
            <div class="appointment-time">${formattedTime}</div>
            <p style="margin: 10px 0 0 0; color: #374151;">Property: ${propertyAddress}</p>
          </div>

          <div class="phone-info">
            <strong>We'll call you at:</strong><br>
            <span style="font-size: 20px; color: #1d4ed8;">${applicantPhone}</span>
          </div>

          <p><strong>Before your interview:</strong></p>
          <ul style="color: #4b5563;">
            <li>Find a quiet location with good cell reception</li>
            <li>Have your employment details handy</li>
            <li>Be prepared to discuss your rental history</li>
            <li>Think about your ideal move-in date</li>
          </ul>

          <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
            Need to reschedule? Reply to this email at least 2 hours before your scheduled time.
          </p>
        </div>
        <div class="footer">
          <p><strong>HouseYield</strong> - We'll talk soon! 📞</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: { name: 'HouseYield', address: HOUSEYIELD_EMAIL },
    to,
    subject: `✅ Interview Confirmed: ${formattedTime}`,
    html: emailHtml
  };

  const result = await sendHouseYieldMail(mailOptions);
  if (result.ok) {
    console.log(`[Email Service] ✅ Interview confirmation sent to ${to} via ${result.provider}`);
    return { ok: true, messageId: result.messageId };
  }

  console.error('[Email Service] ❌ Confirmation email failed:', result.error);
  return toEmailFailure(result);
}

/**
 * Send a sensor alert notification email
 * Uses the same email infrastructure as tenant onboarding and interview scheduling
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.tenantName - Tenant's name
 * @param {string} options.propertyAddress - Property address
 * @param {Object} options.alert - Alert object with type, message, deviceId, sensorLocation, timestamp, level
 * @param {Object} options.maintenanceRequest - Optional maintenance request created from alert
 */
export async function sendSensorAlertEmail({
  to,
  tenantName,
  propertyAddress,
  alert,
  maintenanceRequest = null
}) {
  // Determine alert styling based on severity
  const alertColor = alert.level === 'critical' ? '#dc2626' : (alert.level === 'warning' ? '#f59e0b' : '#3b82f6');
  const headerGradient = alert.level === 'critical' 
    ? 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)' 
    : 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)';
  
  const iconMap = {
    'flood': '💧',
    'water_leak': '💧',
    'temperature': '🌡️',
    'low_battery': '🔋',
    'offline': '📡',
    'motion': '🚶'
  };
  const alertIcon = iconMap[alert.type] || '⚠️';

  const alertTypeDisplay = {
    'flood': 'Water/Flood Detected',
    'water_leak': 'Water Leak Detected',
    'temperature': 'Temperature Alert',
    'low_battery': 'Low Battery Warning',
    'offline': 'Sensor Offline',
    'motion': 'Motion Detected'
  };

  const alertTitle = alertTypeDisplay[alert.type] || `Sensor Alert: ${alert.type}`;
  const urgencyText = alert.level === 'critical' ? 'URGENT ALERT' : 'Property Alert';

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f5; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: ${headerGradient}; color: white; padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0; }
        .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
        .header-icon { font-size: 48px; margin-bottom: 10px; }
        .content { background: white; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none; }
        .greeting { font-size: 20px; color: #1f2937; margin-bottom: 20px; }
        .alert-card { background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%); padding: 24px; border-radius: 12px; margin: 24px 0; border-left: 4px solid ${alertColor}; }
        .alert-card h3 { margin: 0 0 16px 0; color: ${alertColor}; font-size: 18px; }
        .property-card { background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); padding: 24px; border-radius: 12px; margin: 24px 0; border-left: 4px solid #3b82f6; }
        .property-card h3 { margin: 0 0 16px 0; color: #3b82f6; font-size: 18px; }
        .detail-item { margin: 8px 0; color: #4b5563; }
        .detail-item strong { color: #1f2937; }
        .action-list { list-style: none; padding: 0; margin: 24px 0; background: #fef3c7; border-radius: 12px; padding: 20px; }
        .action-list h4 { margin: 0 0 16px 0; color: #92400e; display: flex; align-items: center; gap: 8px; }
        .action-list ol { margin: 0; padding-left: 20px; color: #78350f; }
        .action-list li { padding: 8px 0; }
        .maintenance-card { background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); padding: 24px; border-radius: 12px; margin: 24px 0; border-left: 4px solid #16a34a; }
        .maintenance-card h3 { margin: 0 0 16px 0; color: #16a34a; font-size: 18px; }
        .footer { text-align: center; padding: 24px; color: #6b7280; font-size: 13px; background: #f9fafb; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none; }
        .help-text { color: #6b7280; font-size: 14px; margin-top: 24px; padding-top: 24px; border-top: 1px solid #e5e7eb; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="header-icon">${alertIcon}</div>
          <h1>${urgencyText}</h1>
        </div>
        <div class="content">
          <p class="greeting">Hello ${tenantName || 'Resident'}! 👋</p>
          <p>Our property monitoring system has detected an issue that requires your immediate attention.</p>
          
          <div class="alert-card">
            <h3>${alertIcon} ${alertTitle}</h3>
            <p class="detail-item">${alert.message || 'A sensor has detected an issue at your property.'}</p>
          </div>

          <div class="property-card">
            <h3>📍 Alert Details</h3>
            <p class="detail-item"><strong>Property:</strong> ${propertyAddress || 'Your Property'}</p>
            <p class="detail-item"><strong>Location:</strong> ${alert.sensorLocation || 'Unknown'}</p>
            <p class="detail-item"><strong>Sensor ID:</strong> ${alert.deviceId || 'Unknown'}</p>
            <p class="detail-item"><strong>Time Detected:</strong> ${new Date(alert.timestamp).toLocaleString()}</p>
          </div>

          ${alert.type === 'flood' || alert.type === 'water_leak' ? `
          <div class="action-list">
            <h4>⚡ Immediate Actions Required:</h4>
            <ol>
              <li><strong>Turn off the water supply</strong> if safe to do so</li>
              <li><strong>Move valuable items</strong> away from the affected area</li>
              <li><strong>Do NOT use electrical appliances</strong> in the flooded area</li>
              <li><strong>Document any damage</strong> with photos if possible</li>
            </ol>
          </div>
          ` : ''}

          ${maintenanceRequest ? `
          <div class="maintenance-card">
            <h3>🔧 Maintenance Request Created</h3>
            <p class="detail-item">A maintenance request has been automatically created for this issue.</p>
            <p class="detail-item"><strong>Request ID:</strong> ${maintenanceRequest.id}</p>
            <p class="detail-item"><strong>Category:</strong> ${maintenanceRequest.category}</p>
            <p class="detail-item"><strong>Priority:</strong> ${maintenanceRequest.priority}</p>
          </div>
          ` : `
          <p style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 16px 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
            <strong style="color: #1d4ed8;">📋 What happens next:</strong><br>
            A maintenance request has been created automatically and a professional may contact you shortly to schedule a service visit.
          </p>
          `}

          <p class="help-text">
            If you have questions or need immediate assistance, please contact your property manager. This is an automated notification from the HouseYield property monitoring system.
          </p>
        </div>
        <div class="footer">
          <p style="margin: 0 0 8px 0;"><strong>HouseYield</strong> - Smart Property Protection</p>
          <p style="margin: 0; color: #9ca3af;">This is an automated message from your property's sensor monitoring system.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  // Build subject line
  const urgencyPrefix = alert.level === 'critical' ? '🚨 URGENT: ' : '⚠️ Alert: ';
  const subject = `${urgencyPrefix}${alertTitle} - ${propertyAddress || 'Your Property'}`;

  const mailOptions = {
    from: {
      name: 'HouseYield Alerts',
      address: HOUSEYIELD_EMAIL
    },
    to,
    subject,
    html: emailHtml
  };

  const result = await sendHouseYieldMail(mailOptions);
  if (result.ok) {
    console.log(`[Email Service] ✅ Sensor alert email sent to ${to} via ${result.provider} (messageId: ${result.messageId})`);
    return {
      ok: true,
      messageId: result.messageId,
      to,
    };
  }

  console.error(`[Email Service] ❌ Sensor alert email failed to ${to}:`, result.error);
  return toEmailFailure(result);
}

/**
 * Verify email configuration is working
 */
export async function verifyEmailConfig() {
  if (hasGmailOAuthCredentials()) {
    const status = await getGmailAuthStatus();

    if (status.ready) {
      console.log('[Email Service] ✅ Gmail OAuth is authorized');
      return {
        ok: true,
        configured: true,
        provider: 'gmail-oauth',
        redirectUri: status.redirectUri,
      };
    }

    return {
      ok: false,
      configured: status.hasCredentials,
      provider: 'gmail-oauth',
      needsAuthorization: status.needsAuthorization,
      authUrl: status.authUrl,
      redirectUri: status.redirectUri,
      message: status.needsAuthorization
        ? 'Gmail OAuth credentials loaded, but the mailbox still needs one-time authorization at /auth/gmail.'
        : `Gmail OAuth credentials were found at ${GMAIL_CREDENTIALS_PATH}, but the client could not initialize.`,
    };
  }

  const transport = getTransporter();
  
  if (!transport) {
    return { 
      ok: false, 
      configured: false,
      message: EMAIL_CONFIG_ERROR
    };
  }

  try {
    await transport.verify();
    console.log('[Email Service] ✅ SMTP connection verified');
    return { ok: true, configured: true };
  } catch (error) {
    console.error('[Email Service] ❌ SMTP verification failed:', error.message);
    return { 
      ok: false, 
      configured: true,
      error: error.message 
    };
  }
}

/**
 * Send a tenant screening request email
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.applicantName - Applicant's name
 * @param {string} options.propertyAddress - Property address
 * @param {string} options.ownerName - Property owner/manager name
 * @param {string} options.screeningLink - Link to screening form
 * @param {string} options.expiresAt - When the link expires
 */
export async function sendScreeningRequestEmail({
  to,
  applicantName,
  propertyAddress,
  ownerName,
  screeningLink,
  expiresAt
}) {
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f5; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: white; padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0; }
        .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
        .header-icon { font-size: 48px; margin-bottom: 10px; }
        .content { background: white; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none; }
        .greeting { font-size: 20px; color: #1f2937; margin-bottom: 20px; }
        .info-card { background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); padding: 24px; border-radius: 12px; margin: 24px 0; border-left: 4px solid #059669; }
        .steps-list { list-style: none; padding: 0; margin: 24px 0; }
        .steps-list li { padding: 12px 0; border-bottom: 1px solid #e5e7eb; display: flex; align-items: flex-start; }
        .steps-list li:last-child { border-bottom: none; }
        .step-number { background: #059669; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 14px; font-weight: 600; flex-shrink: 0; }
        .step-content { flex: 1; }
        .step-title { font-weight: 600; color: #1f2937; margin-bottom: 4px; }
        .step-description { font-size: 14px; color: #6b7280; }
        .cta-container { text-align: center; margin: 32px 0; }
        .button { display: inline-block; background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 14px rgba(5, 150, 105, 0.4); }
        .security-box { background: #dbeafe; border-left: 4px solid #3b82f6; padding: 16px 20px; margin: 24px 0; border-radius: 0 8px 8px 0; }
        .security-box strong { color: #1d4ed8; }
        .footer { background: #f9fafb; padding: 24px 30px; text-align: center; font-size: 12px; color: #6b7280; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="header-icon">📋</div>
          <h1>Complete Your Tenant Screening</h1>
        </div>
        <div class="content">
          <p class="greeting">Hi ${applicantName || 'there'},</p>
          
          <p><strong>${ownerName || 'The property manager'}</strong> has requested that you complete tenant screening for:</p>
          
          <div class="info-card">
            <h3 style="margin: 0 0 8px 0; color: #059669;">🏠 ${propertyAddress || 'Your Application'}</h3>
            <p style="margin: 0; color: #4b5563; font-size: 14px;">Complete the verification steps below to process your application.</p>
          </div>

          <p style="font-weight: 600; color: #1f2937;">What you'll need to provide:</p>

          <ul class="steps-list">
            <li>
              <div class="step-number">1</div>
              <div class="step-content">
                <div class="step-title">Personal Information</div>
                <div class="step-description">Full legal name, date of birth, and Social Security Number for credit and background verification</div>
              </div>
            </li>
            <li>
              <div class="step-number">2</div>
              <div class="step-content">
                <div class="step-title">Current Address</div>
                <div class="step-description">Your current residential address for identity verification</div>
              </div>
            </li>
            <li>
              <div class="step-number">3</div>
              <div class="step-content">
                <div class="step-title">Income Verification</div>
                <div class="step-description">Securely connect your bank account through Stripe to verify your income (no documents required)</div>
              </div>
            </li>
          </ul>

          <div class="cta-container">
            <a href="${screeningLink}" class="button" style="color: white;">Complete Screening →</a>
          </div>

          <div class="security-box">
            <strong>🔒 Your information is secure</strong>
            <p style="margin: 8px 0 0 0; font-size: 14px;">All data is encrypted and transmitted securely. We use Equifax for credit checks and Stripe for bank verification - the same services trusted by major financial institutions.</p>
          </div>

          ${expiresAt ? `<p style="font-size: 14px; color: #6b7280; text-align: center;">This link expires on ${new Date(expiresAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.</p>` : ''}
        </div>
        <div class="footer">
          <p><strong>HouseYield</strong> - Modern Property Management</p>
          <p>This email was sent because your rental application requires screening verification.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: {
      name: 'HouseYield Screening',
      address: HOUSEYIELD_EMAIL
    },
    to,
    subject: `Complete Your Tenant Screening - ${propertyAddress || 'Application'}`,
    html: emailHtml
  };

  const result = await sendHouseYieldMail(mailOptions);
  if (result.ok) {
    console.log(`[Email Service] ✅ Screening request email sent to ${to} via ${result.provider} (messageId: ${result.messageId})`);
    return {
      ok: true,
      messageId: result.messageId,
      to,
    };
  }

  console.error(`[Email Service] ❌ Screening request email failed to ${to}:`, result.error);
  return toEmailFailure(result);
}

async function sendHouseYieldMailWithAttachments(mailOptions) {
  if (hasGmailOAuthCredentials()) {
    const result = await sendSecureGmailWithAttachments({
      to: mailOptions.to,
      subject: mailOptions.subject,
      html: mailOptions.html,
      from: mailOptions.from?.address || HOUSEYIELD_EMAIL,
      attachments: mailOptions.attachments || []
    });

    if (result.ok) {
      return {
        ok: true,
        messageId: result.messageId || result.id,
        provider: 'gmail-oauth'
      };
    }

    return {
      ok: false,
      error: result.error,
      provider: 'gmail-oauth',
      needsAuthorization: result.needsReauth
    };
  }

  const transport = getTransporter();
  if (!transport) {
    return {
      ok: false,
      error: EMAIL_CONFIG_ERROR,
      skipped: true,
      provider: 'smtp'
    };
  }

  try {
    const info = await transport.sendMail(mailOptions);
    return {
      ok: true,
      messageId: info.messageId,
      provider: 'smtp'
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      provider: 'smtp'
    };
  }
}

/**
 * Send maintenance visit confirmation email with calendar invite attachment
 */
export async function sendMaintenanceVisitConfirmationEmail({
  to,
  recipientName,
  recipientRole = 'tenant',
  visitTitle,
  visitSummary,
  visitDescription,
  propertyAddress,
  providerName,
  startAt,
  endAt,
  timezone = 'America/New_York',
  googleCalendarUrl,
  icsContent,
  tenantName
}) {
  const startDate = new Date(startAt);
  const endDate = new Date(endAt);
  const formattedStart = startDate.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
    timeZoneName: 'short'
  });
  const formattedEnd = endDate.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
    timeZoneName: 'short'
  });

  const roleIntro = recipientRole === 'owner'
    ? `A maintenance visit has been scheduled for your property${tenantName ? ` (tenant: ${tenantName})` : ''}.`
    : 'Your maintenance visit has been confirmed. Here are the details:';

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f5; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); color: white; padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0; }
        .content { background: white; padding: 40px 30px; border: 1px solid #e5e7eb; border-top: none; }
        .visit-card { background: #f5f3ff; padding: 24px; border-radius: 12px; margin: 24px 0; text-align: center; border: 2px solid #a855f7; }
        .visit-time { font-size: 22px; font-weight: bold; color: #6d28d9; margin: 10px 0; }
        .detail-row { background: #f9fafb; padding: 12px 16px; border-radius: 8px; margin: 8px 0; }
        .cta-container { text-align: center; margin: 28px 0; }
        .button { display: inline-block; background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); color: white; padding: 14px 32px; text-decoration: none; border-radius: 10px; font-weight: 600; }
        .footer { text-align: center; padding: 24px; color: #6b7280; font-size: 13px; background: #f9fafb; border-radius: 0 0 12px 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div style="font-size: 48px; margin-bottom: 8px;">🔧</div>
          <h1 style="margin: 0;">Maintenance Visit Confirmed</h1>
        </div>
        <div class="content">
          <p>Hi ${recipientName || 'there'},</p>
          <p>${roleIntro}</p>

          <div class="visit-card">
            <div class="visit-time">${formattedStart}</div>
            <p style="margin: 8px 0 0 0; color: #374151;">Expected window through ${formattedEnd}</p>
            <p style="margin: 12px 0 0 0; color: #374151;"><strong>${visitTitle}</strong></p>
          </div>

          <div class="detail-row"><strong>Property:</strong> ${propertyAddress}</div>
          <div class="detail-row"><strong>Service provider:</strong> ${providerName}</div>
          <div class="detail-row"><strong>Summary:</strong> ${visitSummary}</div>

          ${googleCalendarUrl ? `
          <div class="cta-container">
            <a href="${googleCalendarUrl}" class="button">Add to Google Calendar</a>
          </div>
          ` : ''}

          <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
            A calendar invite (.ics) is attached. Open it to add this visit to Apple Calendar, Outlook, or other apps.
          </p>
        </div>
        <div class="footer">
          <p><strong>HouseYield</strong> — Maintenance scheduling</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: { name: 'HouseYield', address: HOUSEYIELD_EMAIL },
    to,
    subject: `✅ Maintenance visit confirmed — ${formattedStart}`,
    html: emailHtml,
    attachments: icsContent ? [{
      filename: 'maintenance-visit.ics',
      content: icsContent,
      contentType: 'text/calendar; charset=utf-8; method=REQUEST'
    }] : []
  };

  const result = await sendHouseYieldMailWithAttachments(mailOptions);
  if (result.ok) {
    console.log(`[Email Service] ✅ Maintenance visit confirmation sent to ${to} via ${result.provider}`);
    return { ok: true, messageId: result.messageId };
  }

  console.error('[Email Service] ❌ Maintenance visit confirmation failed:', result.error);
  return toEmailFailure(result);
}

export default {
  sendTenantInviteEmail,
  sendHtmlEmail,
  sendDocumentSignatureEmail,
  sendInterviewSchedulingEmail,
  sendInterviewConfirmationEmail,
  sendSensorAlertEmail,
  sendScreeningRequestEmail,
  sendMaintenanceVisitConfirmationEmail,
  verifyEmailConfig
};
