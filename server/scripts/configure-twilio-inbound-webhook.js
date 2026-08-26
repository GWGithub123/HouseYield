#!/usr/bin/env node
/**
 * Point Twilio inbound SMS webhooks at the HouseYield backend.
 */
import 'dotenv/config';
import twilio from 'twilio';

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const msSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
const fromNumber = process.env.TWILIO_FROM_NUMBER;
const webhookUrl = `${process.env.BACKEND_PUBLIC_URL || process.env.PUBLIC_URL || 'https://houseyield-backend-rhrpiopisa-uc.a.run.app'}/twilio/sms/inbound`;

if (!sid || !token) {
  console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
  process.exit(1);
}

const client = twilio(sid, token);

async function updateAllMessagingServices() {
  const services = await client.messaging.v1.services.list({ limit: 20 });
  for (const svc of services) {
    const updated = await client.messaging.v1.services(svc.sid).update({
      inboundRequestUrl: webhookUrl,
      inboundMethod: 'POST',
    });
    console.log('Updated Messaging Service:', updated.friendlyName, `(${updated.sid})`);
    console.log('  InboundRequestUrl:', updated.inboundRequestUrl);
  }
}

async function main() {
  console.log('Setting inbound SMS webhook to:', webhookUrl);

  if (msSid) {
    const updated = await client.messaging.v1.services(msSid).update({
      inboundRequestUrl: webhookUrl,
      inboundMethod: 'POST',
    });
    console.log('Updated Messaging Service:', updated.friendlyName);
    console.log('  InboundRequestUrl:', updated.inboundRequestUrl);
  }

  await updateAllMessagingServices();

  if (fromNumber) {
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: fromNumber, limit: 1 });
    if (!numbers[0]) {
      console.warn('Phone number not found in account:', fromNumber);
    } else {
      const updated = await client.incomingPhoneNumbers(numbers[0].sid).update({
        smsUrl: webhookUrl,
        smsMethod: 'POST',
      });
      console.log('Updated phone number:', updated.phoneNumber);
      console.log('  SmsUrl:', updated.smsUrl);
    }
  }

  console.log('\nDone. Reply YES to a HouseYield text to test end-to-end.');
}

main().catch((error) => {
  console.error('Failed to update Twilio webhook:', error.message);
  process.exit(1);
});
