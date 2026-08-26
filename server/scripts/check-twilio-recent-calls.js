#!/usr/bin/env node
import 'dotenv/config';
import twilio from 'twilio';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function main() {
  console.log('--- Recent outbound calls ---');
  const calls = await client.calls.list({ to: '+12026420437', limit: 10 });
  for (const c of calls) {
    console.log({
      date: c.dateCreated,
      sid: c.sid,
      from: c.from,
      to: c.to,
      status: c.status,
      direction: c.direction,
      duration: c.duration,
      answeredBy: c.answeredBy,
    });
  }

  console.log('\n--- Recent calls from Twilio number ---');
  const calls2 = await client.calls.list({ from: process.env.TWILIO_FROM_NUMBER, limit: 10 });
  for (const c of calls2) {
    console.log({
      date: c.dateCreated,
      sid: c.sid,
      from: c.from,
      to: c.to,
      status: c.status,
      duration: c.duration,
    });
  }

  try {
    const alerts = await client.monitor.v1.alerts.list({ limit: 10 });
    console.log('\n--- Recent Twilio alerts ---');
    for (const a of alerts.slice(0, 5)) {
      if (String(a.alertText || '').includes('call') || String(a.resourceSid || '').startsWith('CA')) {
        console.log({ date: a.dateGenerated, code: a.errorCode, text: a.alertText, sid: a.resourceSid });
      }
    }
  } catch {
    // ignore
  }
}

main().catch((e) => console.error(e.message));
