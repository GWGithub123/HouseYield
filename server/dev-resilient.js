#!/usr/bin/env node
/**
 * Resilient Development Server
 * 
 * Starts backend independently from frontend/tunnel.
 * Backend continues running even if Vite or Cloudflare crash.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env first
dotenv.config({ path: path.join(__dirname, '../.env') });

console.log('🚀 Starting resilient development environment...\n');

// Start backend server (persistent)
console.log('🔧 [1/3] Starting backend server (persistent)...');
const backend = spawn('node', ['index.js'], {
  cwd: __dirname,
  env: { ...process.env },
  stdio: 'inherit',
});

backend.on('close', (code) => {
  console.log(`\n❌ Backend exited with code ${code}`);
  // Don't kill everything - let frontend continue
});

// Give backend time to start
setTimeout(() => {
  // Start Cloudflare tunnel
  console.log('\n🚇 [2/3] Starting Cloudflare Tunnel...');
  const cloudflared = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:5173'], {
    stdio: 'pipe',
  });

  cloudflared.stdout.on('data', (data) => {
    const output = data.toString();
    if (output.includes('https://')) {
      const match = output.match(/(https:\/\/[^\s]+)/);
      if (match) {
        const tunnelUrl = match[1];
        console.log(`✅ [cloudflared] Tunnel established: ${tunnelUrl}`);
        console.log(`📱 Scan QR code or visit on your iPhone: ${tunnelUrl}/room-scanner`);
        
        // Update .env file
        const envPath = path.join(__dirname, '../.env');
        let envContent = fs.readFileSync(envPath, 'utf-8');
        envContent = envContent.replace(/CLOUDFLARE_TUNNEL_URL=.*/g, `CLOUDFLARE_TUNNEL_URL=${tunnelUrl}`);
        envContent = envContent.replace(/VITE_NGROK_URL=.*/g, `VITE_NGROK_URL=${tunnelUrl}`);
        fs.writeFileSync(envPath, envContent);
        console.log(`✅ [cloudflared] Updated .env with tunnel URL\n`);
      }
    }
  });

  cloudflared.stderr.on('data', (data) => {
    const output = data.toString();
    if (!output.includes('ERR Cannot determine default origin certificate')) {
      console.log(`[cloudflared] ${output.trim()}`);
    }
  });

  cloudflared.on('close', (code) => {
    console.log(`\n⚠️  Cloudflare tunnel closed (code ${code})`);
    console.log('Backend server continues running on http://localhost:3001');
  });

  // Start Vite
  console.log('\n⚡ [3/3] Starting Vite dev server...');
  const vite = spawn('npx', ['vite'], {
    stdio: 'inherit',
  });

  vite.on('close', (code) => {
    console.log(`\n⚠️  Vite exited with code ${code}`);
    console.log('Backend server continues running on http://localhost:3001');
  });

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n\n🧹 Shutting down gracefully...');
    backend.kill('SIGTERM');
    cloudflared.kill('SIGTERM');
    vite.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1000);
  });

}, 2000);

console.log('\n💡 Backend runs independently - even if frontend crashes, photogrammetry processing continues!\n');
