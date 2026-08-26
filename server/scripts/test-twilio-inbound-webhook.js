#!/usr/bin/env node
/**
 * Simulate a signed Twilio inbound SMS POST to our Cloud Run webhook.
 */
import 'dotenv/config';
import crypto from 'crypto';
import twilio from 'twilio';

const authToken = process.env.TWILIO_AUTH_TOKEN;
const webhookUrl = `${process.env.BACKEND_PUBLIC_URL || 'https://houseyield-backend-rhrpiopisa-uc.a.run.app'}/twilio/sms/inbound`;
const from = process.env.MAINTENANCE_OWNER_SMS_TEST_PHONE || process.env.TWILIO_TEST_TO_NUMBER || '+12026420437';
const body = process.argv[2] || 'YES';

const params = {
  From: from,
  To: process.env.TWILIO_FROM_NUMBER || '+12025194904',
  Body: body,
  MessageSid: `SM_test_${Date.now()}`,
  AccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  NumMedia: '0',
};

function sign(url, postParams, token) {
  const data = Object.keys(postParams).sort().reduce((acc, key) => acc + key + postParams[key], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

async function main() {
  if (!authToken) {
    throw new Error('TWILIO_AUTH_TOKEN missing');
  }

  const signature = sign(webhookUrl, params, authToken);
  const form = new URLSearchParams(params);

  console.log('POST', webhookUrl);
  console.log('From:', from, 'Body:', body);

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body: form.toString(),
  });

  const text = await response.text();
  console.log('Status:', response.status);
  console.log('Response:', text.slice(0, 500));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
