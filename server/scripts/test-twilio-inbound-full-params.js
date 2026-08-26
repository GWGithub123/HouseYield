#!/usr/bin/env node
/** Simulate Twilio inbound with full parameter set like production webhooks. */
import 'dotenv/config';
import crypto from 'crypto';

const authToken = process.env.TWILIO_AUTH_TOKEN;
const webhookUrl = `${process.env.BACKEND_PUBLIC_URL || 'https://houseyield-backend-rhrpiopisa-uc.a.run.app'}/twilio/sms/inbound`;

const params = {
  ToCountry: 'US',
  ToState: 'DC',
  SmsMessageSid: 'SMd9aac9d5a49089d7bf2790d333e0e5eb',
  NumMedia: '0',
  ToCity: 'WASHINGTON',
  FromZip: '20001',
  SmsSid: 'SMd9aac9d5a49089d7bf2790d333e0e5eb',
  FromState: 'DC',
  SmsStatus: 'received',
  FromCity: 'WASHINGTON',
  Body: 'YES',
  FromCountry: 'US',
  To: '+12025194904',
  MessagingServiceSid: 'MG1c223674201d183589f6b7f9fa3f4adf',
  ToZip: '20001',
  NumSegments: '1',
  MessageSid: 'SMd9aac9d5a49089d7bf2790d333e0e5eb',
  AccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  From: '+12026420437',
  ApiVersion: '2010-04-01',
};

function sign(url, postParams, token) {
  const data = Object.keys(postParams).sort().reduce((acc, key) => acc + key + postParams[key], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

async function main() {
  const signature = sign(webhookUrl, params, authToken);
  const form = new URLSearchParams(params);
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body: form.toString(),
  });
  console.log('Status:', response.status);
  console.log(await response.text());
}

main();
