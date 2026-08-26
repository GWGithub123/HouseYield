#!/usr/bin/env node
import 'dotenv/config';
import twilio from 'twilio';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const sid = process.argv[2] || 'SMd9aac9d5a49089d7bf2790d333e0e5eb';

async function main() {
  const m = await client.messages(sid).fetch();
  console.log(JSON.stringify(m, null, 2));
}

main().catch((e) => console.error(e.message));
