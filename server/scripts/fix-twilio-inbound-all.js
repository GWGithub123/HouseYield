#!/usr/bin/env node
import 'dotenv/config';
import twilio from 'twilio';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const webhookUrl = `${process.env.BACKEND_PUBLIC_URL || 'https://houseyield-backend-rhrpiopisa-uc.a.run.app'}/twilio/sms/inbound`;

async function main() {
  try {
    const alerts = await client.monitor.v1.alerts.list({ limit: 20 });
    console.log('--- Twilio Monitor Alerts ---');
    for (const a of alerts) {
      console.log({
        date: a.dateGenerated,
        errorCode: a.errorCode,
        logLevel: a.logLevel,
        alertText: a.alertText,
        resourceSid: a.resourceSid,
      });
    }
  } catch (error) {
    console.log('Monitor alerts unavailable:', error.message);
  }

  const services = await client.messaging.v1.services.list({ limit: 10 });
  for (const svc of services) {
    if (!svc.inboundRequestUrl) {
      console.log('\nUpdating messaging service inbound URL:', svc.sid);
      await client.messaging.v1.services(svc.sid).update({
        inboundRequestUrl: webhookUrl,
        inboundMethod: 'POST',
      });
    }
  }

  const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: process.env.TWILIO_FROM_NUMBER, limit: 1 });
  if (numbers[0]) {
    await client.incomingPhoneNumbers(numbers[0].sid).update({
      smsUrl: webhookUrl,
      smsMethod: 'POST',
    });
    console.log('\nPhone smsUrl:', webhookUrl);
  }
}

main().catch((e) => console.error(e.message));
