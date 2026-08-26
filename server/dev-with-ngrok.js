#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const envPath = join(rootDir, '.env');

console.log('🚀 Starting development environment with ngrok...\n');

// Step 1: Start ngrok and wait for tunnel URL
// Tunnel to Vite (port 5173) for frontend access on mobile
console.log('🚇 [1/2] Starting ngrok tunnel to frontend (port 5173)...');

// Use US region for faster connection and no logging for speed
const ngrok = spawn('ngrok', ['http', '5173', '--region', 'us'], {
  stdio: 'pipe'
});

let tunnelUrl = null;
let serverProcess = null;
let tunnelEstablished = false;

// Set timeout to detect slow connections
const tunnelTimeout = setTimeout(() => {
  if (!tunnelEstablished) {
    console.log('⚠️  [ngrok] Tunnel taking longer than expected...');
    console.log('💡 Tip: Sign up for ngrok account and add auth token for faster connections');
    console.log('   Run: ngrok config add-authtoken <your_token>');
  }
}, 5000);

ngrok.stdout.on('data', (data) => {
  const output = data.toString();
  
  // Look for the tunnel URL
  const urlMatch = output.match(/url=https:\/\/[^\s]+\.ngrok[^\s]*/i);
  if (urlMatch && !tunnelUrl) {
    tunnelUrl = urlMatch[0].replace('url=', '');
    tunnelEstablished = true;
    clearTimeout(tunnelTimeout);
    console.log(`✅ [ngrok] Tunnel established: ${tunnelUrl}\n`);
    console.log(`📱 Scan QR code or visit on your iPhone: ${tunnelUrl}/room-scanner\n`);
    
    // Update .env file with both NGROK_URL and VITE_NGROK_URL
    try {
      let envContent = fs.readFileSync(envPath, 'utf8');
      
      // Update NGROK_URL
      if (envContent.includes('NGROK_URL=')) {
        envContent = envContent.replace(/NGROK_URL=.*/g, `NGROK_URL=${tunnelUrl}`);
      } else {
        envContent += `\nNGROK_URL=${tunnelUrl}`;
      }
      
      // Update VITE_NGROK_URL (for frontend)
      if (envContent.includes('VITE_NGROK_URL=')) {
        envContent = envContent.replace(/VITE_NGROK_URL=.*/g, `VITE_NGROK_URL=${tunnelUrl}`);
      } else {
        envContent += `\nVITE_NGROK_URL=${tunnelUrl}`;
      }
      
      fs.writeFileSync(envPath, envContent);
      console.log('✅ [ngrok] Updated .env with tunnel URL (NGROK_URL and VITE_NGROK_URL)\n');
      
      // Step 2: Start the backend server
      startServer();
    } catch (err) {
      console.error('⚠️  [ngrok] Failed to update .env:', err.message);
    }
  }
});

ngrok.stderr.on('data', (data) => {
  console.error('[ngrok] Error:', data.toString());
});

function startServer() {
  console.log('🔧 [2/2] Starting backend server...\n');
  
  serverProcess = spawn('node', ['server/index.js'], {
    stdio: 'inherit',
    cwd: rootDir,
    env: { ...process.env, NGROK_URL: tunnelUrl }
  });

  serverProcess.on('close', (code) => {
    console.log(`\n🛑 Backend server exited with code ${code}`);
    cleanup();
  });
}

function cleanup() {
  console.log('\n🧹 Cleaning up...');
  if (ngrok) {
    ngrok.kill();
  }
  if (serverProcess) {
    serverProcess.kill();
  }
  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

console.log('⏳ Waiting for ngrok tunnel...');
