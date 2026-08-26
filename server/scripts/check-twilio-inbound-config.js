#!/usr/bin/env node
import 'dotenv/config';
import twilio from 'twilio';

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const msSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
const fromNumber = process.env.TWILIO_FROM_NUMBER;

if (!sid || !token) {
  console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
  process.exit(1);
}

const client = twilio(sid, token);
const expectedWebhook = `${process.env.BACKEND_PUBLIC_URL || process.env.PUBLIC_URL || 'https://houseyield-backend-rhrpiopisa-uc.a.run.app'}/twilio/sms/inbound`;

async function main() {
  console.log('Expected inbound webhook:', expectedWebhook);
  console.log('');

  if (msSid) {
    const svc = await client.messaging.v1.services(msSid).fetch();
    console.log('Messaging Service:', svc.friendlyName, `(${msSid})`);
    console.log('  InboundRequestUrl:', svc.inboundRequestUrl || '(NOT SET — replies will not hit our server!)');
    console.log('  InboundMethod:', svc.inboundMethod || 'POST');
    console.log('  StatusCallback:', svc.statusCallback || '(not set)');
    console.log('');
  }

  const services = await client.messaging.v1.services.list({ limit: 10 });
  if (services.length > 0) {
    console.log('All Messaging Services:');
    for (const svc of services) {
      console.log(`  ${svc.sid}: inbound=${svc.inboundRequestUrl || '(NOT SET)'}`);
    }
    console.log('');
  } else if (!msSid) {
    console.log('TWILIO_MESSAGING_SERVICE_SID is not set — checking phone number webhook instead.');
    console.log('');
  }

  if (fromNumber) {
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: fromNumber, limit: 1 });
    if (numbers[0]) {
      console.log('Phone number:', numbers[0].phoneNumber);
      console.log('  SmsUrl:', numbers[0].smsUrl || '(NOT SET)');
      console.log('  SmsMethod:', numbers[0].smsMethod || 'POST');
    }
  }

  console.log('\n--- Recent messages from +12026420437 ---');
  const inbound = await client.messages.list({ from: '+12026420437', limit: 10 });
  for (const m of inbound) {
    console.log(`${m.dateCreated?.toISOString?.() || m.dateCreated} | ${m.direction} | to:${m.to} | "${(m.body || '').slice(0, 40)}" | ${m.status}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
