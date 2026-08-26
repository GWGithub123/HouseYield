#!/usr/bin/env node
import 'dotenv/config';
import twilio from 'twilio';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function main() {
  const out = await client.messages.list({ to: '+12026420437', limit: 5 });
  console.log('--- Outbound to user ---');
  for (const m of out) {
    console.log({
      date: m.dateCreated,
      from: m.from,
      to: m.to,
      messagingServiceSid: m.messagingServiceSid || '(direct from number)',
      bodyPreview: (m.body || '').slice(0, 50),
    });
  }
}

main().catch((e) => console.error(e.message));
