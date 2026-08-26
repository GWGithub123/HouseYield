#!/usr/bin/env node
/**
 * Development server with auto-updating Cloudflare tunnel
 * Starts tunnel first, waits for URL, updates .env, then starts backend
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env first
dotenv.config({ path: path.join(__dirname, '../.env') });

console.log('🚀 Starting development environment with Cloudflare Tunnel...\n');

// Step 1: Start Vite
console.log('⚡ [1/3] Starting Vite...');
const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], {
  stdio: 'inherit',
});

// Give Vite a second to start
await new Promise(resolve => setTimeout(resolve, 1000));

// Step 2: Start Cloudflare tunnel and wait for URL
console.log('\n🚇 [2/3] Starting Cloudflare Tunnel...');
const cloudflared = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:5173'], {
  stdio: 'pipe',
});

let tunnelUrl = null;
let tunnelReady = false;

const tunnelPromise = new Promise((resolve) => {
  const checkForUrl = (output) => {
    if (!tunnelReady && output.includes('trycloudflare.com')) {
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('trycloudflare.com')) {
          const urlMatch = line.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
          if (urlMatch) {
            tunnelUrl = urlMatch[0];
            tunnelReady = true;
            console.log(`\n✅ Tunnel URL detected: ${tunnelUrl}`);
            console.log(`📱 Mobile scanner: ${tunnelUrl}/room-scanner\n`);
            
            try {
              const envPath = path.join(__dirname, '../.env');
              let envContent = fs.readFileSync(envPath, 'utf-8');
              
              envContent = envContent.replace(/NGROK_URL=.*/g, `NGROK_URL=${tunnelUrl}`);
              envContent = envContent.replace(/VITE_NGROK_URL=.*/g, `VITE_NGROK_URL=${tunnelUrl}`);
              envContent = envContent.replace(/CLOUDFLARE_TUNNEL_URL=.*/g, `CLOUDFLARE_TUNNEL_URL=${tunnelUrl}`);
              
              fs.writeFileSync(envPath, envContent);
              console.log(`✅ .env updated with new tunnel URL\n`);
              
              process.env.NGROK_URL = tunnelUrl;
              process.env.VITE_NGROK_URL = tunnelUrl;
              process.env.CLOUDFLARE_TUNNEL_URL = tunnelUrl;
              
              resolve();
              return true;
            } catch (err) {
              console.error(`❌ Failed to update .env: ${err.message}\n`);
              resolve();
              return true;
            }
          }
        }
      }
    }
    return false;
  };
  
  cloudflared.stdout.on('data', (data) => {
    const output = data.toString();
    if (checkForUrl(output)) return;
    
    if (!output.includes('ERR Cannot determine default origin certificate') &&
        !output.includes('Cannot determine default configuration path') &&
        !output.includes('Thank you for trying Cloudflare Tunnel')) {
      process.stdout.write(output);
    }
  });
  
  cloudflared.stderr.on('data', (data) => {
    const output = data.toString();
    if (checkForUrl(output)) return;
    
    if (!output.includes('ERR Cannot determine default origin certificate')) {
      process.stderr.write(output);
    }
  });
});

// Wait for tunnel URL (with longer timeout)
const timeout = new Promise(resolve => setTimeout(() => {
  console.log('⚠️  Tunnel taking longer than expected, starting backend anyway...\n');
  resolve();
}, 15000)); // 15 seconds

await Promise.race([tunnelPromise, timeout]);

// Step 3: Start backend server with updated .env
console.log('🔧 [3/3] Starting backend server...\n');
const backend = spawn('node', ['index.js'], {
  cwd: __dirname,
  env: { ...process.env },
  stdio: 'inherit',
});

// Handle cleanup
const cleanup = () => {
  console.log('\n\n🛑 Shutting down...');
  vite.kill();
  cloudflared.kill();
  backend.kill();
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

vite.on('close', () => {
  console.log('\n❌ Vite exited');
  cleanup();
});

backend.on('close', () => {
  console.log('\n❌ Backend exited');
  cleanup();
});

cloudflared.on('close', () => {
  console.log('\n❌ Cloudflare tunnel exited');
});
