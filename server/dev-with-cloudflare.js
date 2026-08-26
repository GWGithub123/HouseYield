#!/usr/bin/env node

/**
 * Development server with Cloudflare Tunnel
 * 
 * Uses cloudflared for tunneling - NO timeout limits (unlike ngrok free tier)
 * Perfect for long-running operations like panorama stitching and depth processing
 * 
 * This script:
 * 1. Starts Cloudflare tunnel FIRST to get the URL
 * 2. Updates .env with the tunnel URL
 * 3. Starts Vite (which reads the new VITE_NGROK_URL)
 * 4. Starts the backend server
 * 
 * Prerequisites:
 *   brew install cloudflared
 */

import { spawn, execSync } from 'child_process';
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

// Set flag so ngrok script knows we're running (prevents duplicate server start)
process.env.CLOUDFLARE_RUNNING = 'true';

console.log('🚀 Starting development environment with Cloudflare Tunnel...\n');
console.log('💡 Cloudflare has NO timeout limits - perfect for long processing!\n');

let serverProcess = null;
let viteProcess = null;
let gatewayProcess = null;
let cloudflaredProcess = null;
let tunnelUrl = null;

function startLocalDev() {
  console.log('⚠️  Starting local dev without any tunnel (Vite on 5173 directly).');
  // No gateway needed — run Vite on 5173 directly
  viteProcess = spawn('npx', ['vite', '--host', '--port', '5173', '--strictPort'], {
    stdio: 'inherit',
    cwd: rootDir,
    env: { ...process.env }
  });
  viteProcess.on('close', (code) => {
    console.log(`\n🛑 Vite exited with code ${code}`);
    cleanup();
  });
  startServer('http://localhost:5173');
}

// Check if cloudflared is installed
function checkCloudflared() {
  try {
    execSync('which cloudflared', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function startCloudflaredTunnel() {
  return new Promise((resolve, reject) => {
    console.log('🚇 [1/4] Starting Cloudflare Tunnel (port 5173 → secure gateway)...');
    
    // Use Quick Tunnel (no account required)
    // Tunnel points to the secure gateway on 5173; Vite runs internally on 5175
    cloudflaredProcess = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:5173'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let urlFound = false;
    
    // cloudflared outputs the URL to stderr
    cloudflaredProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Look for the tunnel URL in the output
      const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !urlFound) {
        urlFound = true;
        tunnelUrl = urlMatch[0];
        console.log(`✅ [cloudflared] Tunnel established: ${tunnelUrl}`);
        console.log(`📱 Scan QR code or visit on your iPhone: ${tunnelUrl}/room-scanner`);
        console.log(`\n⏱️  NO TIMEOUT LIMITS - process as long as you need!\n`);
        resolve(tunnelUrl);
      }
      
      // Log other important messages
      if (output.includes('ERR') || output.includes('error')) {
        console.error('[cloudflared]', output.trim());
      }
    });
    
    cloudflaredProcess.stdout.on('data', (data) => {
      const output = data.toString();
      // Check stdout as well for URL
      const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !urlFound) {
        urlFound = true;
        tunnelUrl = urlMatch[0];
        console.log(`✅ [cloudflared] Tunnel established: ${tunnelUrl}`);
        console.log(`📱 Scan QR code or visit on your iPhone: ${tunnelUrl}/room-scanner\n`);
        resolve(tunnelUrl);
      }
    });
    
    cloudflaredProcess.on('error', (err) => {
      reject(new Error(`Failed to start cloudflared: ${err.message}`));
    });
    
    cloudflaredProcess.on('close', (code) => {
      if (!urlFound) {
        reject(new Error(`cloudflared exited with code ${code} before establishing tunnel`));
      }
    });
    
    // Timeout after 30 seconds
    setTimeout(() => {
      if (!urlFound) {
        reject(new Error('Timeout waiting for cloudflared tunnel URL'));
      }
    }, 30000);
  });
}

function updateEnvFile(url) {
  try {
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    // Update NGROK_URL (we reuse this var for compatibility)
    if (envContent.includes('NGROK_URL=')) {
      envContent = envContent.replace(/NGROK_URL=.*/g, `NGROK_URL=${url}`);
    } else {
      envContent += `\nNGROK_URL=${url}`;
    }
    
    // Update VITE_NGROK_URL (for frontend)
    if (envContent.includes('VITE_NGROK_URL=')) {
      envContent = envContent.replace(/VITE_NGROK_URL=.*/g, `VITE_NGROK_URL=${url}`);
    } else {
      envContent += `\nVITE_NGROK_URL=${url}`;
    }
    
    // Also set a cloudflare-specific var
    if (envContent.includes('CLOUDFLARE_TUNNEL_URL=')) {
      envContent = envContent.replace(/CLOUDFLARE_TUNNEL_URL=.*/g, `CLOUDFLARE_TUNNEL_URL=${url}`);
    } else {
      envContent += `\nCLOUDFLARE_TUNNEL_URL=${url}`;
    }
    
    fs.writeFileSync(envPath, envContent);
    console.log('✅ [cloudflared] Updated .env with tunnel URL\n');
  } catch (err) {
    console.error('⚠️  [cloudflared] Failed to update .env:', err.message);
  }
}

function startVite(url) {
  console.log('⚡ [2/4] Starting Vite dev server on port 5175 (internal)...');
  console.log('   (Gateway on 5173 proxies allowed paths to Vite 5175)\n');
  
  viteProcess = spawn('npx', ['vite', '--host', '--port', '5175', '--strictPort'], {
    stdio: 'inherit',
    cwd: rootDir,
    env: { 
      ...process.env, 
      VITE_NGROK_URL: url,
      CLOUDFLARE_TUNNEL_URL: url
    }
  });

  viteProcess.on('close', (code) => {
    if (code !== 0) {
      console.error('\n❌ Vite failed to bind to port 5175.');
      console.error('   Stop the other process using 5175, then run `npm run dev` again.');
    }
    console.log(`\n🛑 Vite exited with code ${code}`);
    cleanup();
  });
}

function startServer(url) {
  console.log('🔧 [3/4] Starting backend server on port 3001 (internal)...');
  console.log('   (Gateway on 5173 proxies /api/room-scanner/* to backend 3001)\n');
  
  // Increase Node.js memory limit to 4GB for large point cloud processing
  serverProcess = spawn('node', ['--max-old-space-size=4096', 'server/index.js'], {
    stdio: 'inherit',
    cwd: rootDir,
    env: { 
      ...process.env, 
      NGROK_URL: url, 
      VITE_NGROK_URL: url,
      CLOUDFLARE_TUNNEL_URL: url
    }
  });

  serverProcess.on('close', (code) => {
    console.log(`\n🛑 Backend server exited with code ${code}`);
    cleanup();
  });
}

async function cleanup() {
  console.log('\n🧹 Cleaning up...');
  
  if (cloudflaredProcess) {
    cloudflaredProcess.kill('SIGTERM');
    console.log('✅ [cloudflared] Tunnel closed');
  }
  
  if (gatewayProcess) {
    gatewayProcess.kill('SIGTERM');
    console.log('✅ [gateway] Secure tunnel gateway stopped');
  }
  
  if (viteProcess) {
    viteProcess.kill('SIGTERM');
    console.log('✅ [vite] Dev server stopped');
  }
  
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
  
  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Main
async function main() {
  // Check if cloudflared is installed
  if (!checkCloudflared()) {
    console.error('❌ cloudflared is not installed!\n');
    console.log('Install it with:');
    console.log('  brew install cloudflared\n');
    console.log('Or download from:');
    console.log('  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n');
    console.log('Falling back to local dev startup...\n');
    startLocalDev();
    return;
  }
  
  try {
    const url = await startCloudflaredTunnel();
    updateEnvFile(url);
    startVite(url);
    startServer(url);
    
    // Start the secure tunnel gateway on port 5173 — this is what cloudflared connects to
    console.log('🔒 [4/4] Starting secure tunnel gateway on port 5173...');
    gatewayProcess = spawn('node', ['server/tunnel-gateway.js'], {
      stdio: 'inherit',
      cwd: rootDir,
      env: {
        ...process.env,
        NGROK_URL: url,
        VITE_NGROK_URL: url,
        CLOUDFLARE_TUNNEL_URL: url,
        TUNNEL_GATEWAY_PORT: '5173',
        VITE_INTERNAL_PORT: '5175'
      }
    });

    gatewayProcess.on('close', (code) => {
      console.log(`\n🛑 Tunnel gateway exited with code ${code}`);
      cleanup();
    });
  } catch (error) {
    console.error('❌ [cloudflared] Failed to start tunnel:', error.message);
    console.log('\n💡 Falling back to local dev startup...\n');
    
    // Cleanup cloudflared if it's running
    if (cloudflaredProcess) {
      cloudflaredProcess.kill('SIGTERM');
    }

    startLocalDev();
  }
}

main();
