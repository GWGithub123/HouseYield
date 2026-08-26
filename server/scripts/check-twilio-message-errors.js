#!/usr/bin/env node
import 'dotenv/config';
import twilio from 'twilio';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function main() {
  const msgs = await client.messages.list({ from: '+12026420437', limit: 5 });
  for (const m of msgs) {
    console.log({
      date: m.dateCreated,
      sid: m.sid,
      from: m.from,
      to: m.to,
      body: m.body,
      status: m.status,
      direction: m.direction,
      errorCode: m.errorCode,
      errorMessage: m.errorMessage,
    });
  }

  // Check if messaging services exist and their inbound URLs
  const services = await client.messaging.v1.services.list({ limit: 10 });
  console.log('\nMessaging services:');
  for (const s of services) {
    console.log({
      sid: s.sid,
      name: s.friendlyName,
      inboundRequestUrl: s.inboundRequestUrl || '(not set)',
    });
  }
}

main().catch((e) => console.error(e.message));
