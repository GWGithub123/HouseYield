#!/usr/bin/env node
import 'dotenv/config';
import twilio from 'twilio';
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const sid = process.argv[2];
const c = await client.calls(sid).fetch();
console.log(JSON.stringify(c, null, 2));
