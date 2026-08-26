#!/usr/bin/env node
/**
 * Auto-updating Cloudflare Tunnel
 * Captures the tunnel URL and updates .env automatically
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🚇 Starting Cloudflare Tunnel...');
console.log('⚠️  This tunnels directly to localhost:5173. For secure tunnel access,');
console.log('   use `npm run dev` instead (runs gateway with token auth).\n');

const cloudflared = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:5173'], {
  stdio: 'pipe',
});

let urlUpdated = false;

cloudflared.stdout.on('data', (data) => {
  const output = data.toString();
  
  // Look for the tunnel URL
  if (!urlUpdated && output.includes('https://') && output.includes('trycloudflare.com')) {
    const match = output.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (match) {
      const tunnelUrl = match[1];
      urlUpdated = true;
      
      console.log(`\n✅ Tunnel established: ${tunnelUrl}`);
      console.log(`📱 Visit: ${tunnelUrl}/room-scanner`);
      console.log(`\n⚠️  IMPORTANT: Restart the push-server to use the new URL\n`);
      
      // Update .env file
      try {
        const envPath = path.join(__dirname, '../.env');
        let envContent = fs.readFileSync(envPath, 'utf-8');
        
        // Update all tunnel URL variables
        envContent = envContent.replace(/NGROK_URL=.*/g, `NGROK_URL=${tunnelUrl}`);
        envContent = envContent.replace(/VITE_NGROK_URL=.*/g, `VITE_NGROK_URL=${tunnelUrl}`);
        envContent = envContent.replace(/CLOUDFLARE_TUNNEL_URL=.*/g, `CLOUDFLARE_TUNNEL_URL=${tunnelUrl}`);
        
        fs.writeFileSync(envPath, envContent);
        console.log(`✅ Updated .env file\n`);
      } catch (err) {
        console.error(`❌ Failed to update .env: ${err.message}\n`);
      }
    }
  }
  
  // Pass through other output (but filter noise)
  if (!output.includes('ERR Cannot determine default origin certificate') &&
      !output.includes('Cannot determine default configuration path')) {
    process.stdout.write(output);
  }
});

cloudflared.stderr.on('data', (data) => {
  const output = data.toString();
  if (!output.includes('ERR Cannot determine default origin certificate')) {
    process.stderr.write(output);
  }
});

cloudflared.on('close', (code) => {
  console.log(`\n⚠️  Cloudflare tunnel closed (code ${code})`);
  process.exit(code);
});

// Forward signals
process.on('SIGINT', () => {
  cloudflared.kill('SIGINT');
});

process.on('SIGTERM', () => {
  cloudflared.kill('SIGTERM');
});
