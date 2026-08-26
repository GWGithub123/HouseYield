#!/usr/bin/env node

import ngrok from '@ngrok/ngrok';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const envPath = join(rootDir, '.env');

// Load environment variables
dotenv.config({ path: envPath });

// Check if we're running alongside cloudflare (in parallel mode)
const isParallelMode = process.env.CLOUDFLARE_TUNNEL_URL || process.argv.includes('--parallel');

console.log('🚀 Starting ngrok tunnel for backend API...\n');
if (isParallelMode) {
  console.log('📡 Running in parallel mode (cloudflare handles frontend + server)\n');
}

let serverProcess = null;
let listener = null;

async function startNgrokTunnel() {
  try {
    console.log('🚇 Starting ngrok tunnel to backend (port 3001)...');
    
    // Use ngrok SDK for instant tunnel creation (3-5x faster)
    listener = await ngrok.connect({
      addr: 3001,
      authtoken: process.env.NGROK_AUTHTOKEN,
      domain: process.env.NGROK_DOMAIN // Use reserved domain if you have one
    });
    
    const tunnelUrl = listener.url();
    console.log(`✅ [ngrok] Tunnel established: ${tunnelUrl}`);
    console.log(`📱 Backend API accessible at: ${tunnelUrl}\n`);
    
    // Update .env file with NGROK_URL (backend API tunnel)
    try {
      let envContent = fs.readFileSync(envPath, 'utf8');
      
      // Update NGROK_URL (backend API)
      if (envContent.includes('NGROK_URL=')) {
        envContent = envContent.replace(/NGROK_URL=.*/g, `NGROK_URL=${tunnelUrl}`);
      } else {
        envContent += `\nNGROK_URL=${tunnelUrl}`;
      }
      
      fs.writeFileSync(envPath, envContent);
      console.log('✅ [ngrok] Updated .env with backend tunnel URL\n');
      
      // Only start server if NOT in parallel mode (cloudflare starts it)
      if (!isParallelMode) {
        startServer(tunnelUrl);
      } else {
        console.log('⏳ [ngrok] Waiting... (cloudflare script starts the server)\n');
        // Keep the process alive to maintain the tunnel
        setInterval(() => {}, 1000);
      }
    } catch (err) {
      console.error('⚠️  [ngrok] Failed to update .env:', err.message);
      if (!isParallelMode) {
        startServer(tunnelUrl);
      }
    }
  } catch (error) {
    console.error('❌ [ngrok] Failed to start tunnel:', error.message);

    if (isParallelMode) {
      console.log('\n⚠️  [ngrok] Continuing without ngrok because parallel mode already has Cloudflare handling dev access.');
      console.log('💡 If you specifically need an ngrok backend URL, start it separately after freeing your ngrok agent limit.\n');
      return;
    }

    console.log('\n💡 Falling back to CLI method...');

    // Fallback to original method only when ngrok is the primary tunnel path.
    import('./dev-with-ngrok.js');
  }
}

function startServer(tunnelUrl) {
  console.log('🔧 [2/2] Starting backend server...\n');
  
  serverProcess = spawn('node', ['server/index.js'], {
    stdio: 'inherit',
    cwd: rootDir,
    env: { ...process.env, NGROK_URL: tunnelUrl, VITE_NGROK_URL: tunnelUrl }
  });

  serverProcess.on('close', (code) => {
    console.log(`\n🛑 Backend server exited with code ${code}`);
    cleanup();
  });
}

async function cleanup() {
  console.log('\n🧹 Cleaning up...');
  
  if (listener) {
    try {
      await listener.close();
      console.log('✅ [ngrok] Tunnel closed');
    } catch (err) {
      console.error('⚠️  Failed to close ngrok tunnel:', err.message);
    }
  }
  
  if (serverProcess) {
    serverProcess.kill();
  }
  
  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  cleanup();
});

// Start the tunnel
startNgrokTunnel().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
