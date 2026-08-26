#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const envPath = join(rootDir, '.env');

console.log('🚇 [ngrok] Starting ngrok tunnel on port 3001...');

// Start ngrok on port 3001
const ngrok = spawn('ngrok', ['http', '3001', '--log=stdout'], {
  stdio: 'pipe'
});

let tunnelUrl = null;
let startupComplete = false;

ngrok.stdout.on('data', (data) => {
  const output = data.toString();
  
  // Look for the tunnel URL in ngrok output
  const urlMatch = output.match(/url=https:\/\/[^\s]+\.ngrok[^\s]*/i);
  if (urlMatch && !tunnelUrl) {
    tunnelUrl = urlMatch[0].replace('url=', '');
    console.log(`✅ [ngrok] Tunnel established: ${tunnelUrl}`);
    
    // Update .env file with the new URL
    try {
      let envContent = fs.readFileSync(envPath, 'utf8');
      
      // Replace or add PUBLIC_URL
      if (envContent.includes('PUBLIC_URL=')) {
        envContent = envContent.replace(/PUBLIC_URL=.*/g, `PUBLIC_URL=${tunnelUrl}`);
      } else {
        envContent += `\nPUBLIC_URL=${tunnelUrl}\n`;
      }
      
      fs.writeFileSync(envPath, envContent);
      console.log('✅ [ngrok] Updated .env with new tunnel URL');
      console.log(`📡 [ngrok] Public URL for Twilio webhooks: ${tunnelUrl}`);
      console.log(`⚠️  [ngrok] NOTE: Restart the backend server to use the new URL`);
      startupComplete = true;
    } catch (err) {
      console.error('⚠️  [ngrok] Failed to update .env:', err.message);
    }
  }
  
  // Show minimal output after startup
  if (!startupComplete) {
    // Show startup messages
    if (output.includes('started tunnel') || output.includes('session started')) {
      console.log('🔄 [ngrok] Session started, waiting for tunnel URL...');
    }
  }
});

ngrok.stderr.on('data', (data) => {
  const err = data.toString();
  console.error('[ngrok] Error:', err);
});

ngrok.on('close', (code) => {
  console.log(`🚇 [ngrok] Tunnel closed with code ${code}`);
  process.exit(code);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 [ngrok] Stopping tunnel...');
  ngrok.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 [ngrok] Stopping tunnel...');
  ngrok.kill();
  process.exit(0);
});

console.log('⏳ [ngrok] Establishing tunnel connection...');
