#!/usr/bin/env node
import 'dotenv/config';
import crypto from 'crypto';

const authToken = process.env.TWILIO_AUTH_TOKEN;
const host = 'houseyield-backend-rhrpiopisa-uc.a.run.app';
const path = '/twilio/sms/inbound';
const params = {
  From: '+12026420437',
  To: '+12025194904',
  Body: 'YES',
  MessageSid: 'SM_test_host',
  AccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  NumMedia: '0',
};

function sign(url, postParams, token) {
  const data = Object.keys(postParams).sort().reduce((acc, key) => acc + key + postParams[key], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

async function hit(label, url) {
  const signature = sign(url, params, authToken);
  const form = new URLSearchParams(params);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
      Host: host,
    },
    body: form.toString(),
  });
  const text = await response.text();
  console.log(label, '->', response.status, text.slice(0, 120).replace(/\n/g, ' '));
}

async function main() {
  await hit('public_url', `${process.env.BACKEND_PUBLIC_URL}${path}`);
  await hit('host_url', `https://${host}${path}`);
  await hit('alt_run_app', 'https://houseyield-backend-8294931847.us-central1.run.app/twilio/sms/inbound');
}

main();
