#!/usr/bin/env node

import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const localEnv = {
  ...process.env,
  NGROK_URL: '',
  VITE_NGROK_URL: '',
  VITE_PUSH_SERVER_URL: 'http://localhost:3001',
  VITE_API_URL: 'http://localhost:3001',
  CLOUDFLARE_TUNNEL_URL: '',
  CLOUDFLARE_RUNNING: '',
  PUBLIC_URL: 'http://localhost:3001',
  FRONTEND_URL: 'http://localhost:5173',
  RENOVATION_MEASUREMENT_API_URL: process.env.RENOVATION_MEASUREMENT_API_URL || 'http://35.243.185.85:8090',
  RENOVATION_MEASUREMENT_API_ALLOW_LOCAL_FALLBACK: process.env.RENOVATION_MEASUREMENT_API_ALLOW_LOCAL_FALLBACK || 'false',
  RENOVATION_MEASUREMENT_API_TIMEOUT_MS: process.env.RENOVATION_MEASUREMENT_API_TIMEOUT_MS || '600000',
};

let serverProcess = null;
let viteProcess = null;
let isCleaningUp = false;

function isPortOpen(port) {
  const hosts = ['::1', '127.0.0.1', 'localhost'];

  const tryHost = (host) => new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });

  return (async () => {
    for (const host of hosts) {
      if (await tryHost(host)) {
        return true;
      }
    }

    return false;
  })();
}

function stopProcess(processRef, label) {
  if (!processRef) {
    return;
  }

  processRef.kill('SIGTERM');
  console.log(`✅ [${label}] Stopped`);
}

function stopProcessOnPort(port) {
  try {
    const output = execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
    if (!output) {
      return false;
    }

    for (const pid of output.split(/\s+/).filter(Boolean)) {
      process.kill(Number(pid), 'SIGTERM');
    }

    return true;
  } catch {
    return false;
  }
}

function cleanup(exitCode = 0) {
  if (isCleaningUp) {
    return;
  }

  isCleaningUp = true;
  console.log('\n🧹 Cleaning up...');
  stopProcess(viteProcess, 'vite');
  stopProcess(serverProcess, 'backend');
  process.exit(exitCode);
}

function handleExit(name, code, port) {
  if (isCleaningUp) {
    return;
  }

  if (code !== 0) {
    console.error(`\n❌ ${name} exited with code ${code}.`);
    console.error(`   Stop the process using port ${port}, then run \`npm run dev\` again.`);
  } else {
    console.log(`\n🛑 ${name} exited with code 0`);
  }

  cleanup(code || 0);
}

console.log('🚀 Starting local development environment...\n');
console.log('🌐 Frontend: http://localhost:5173');
console.log('🔧 Backend:  http://localhost:3001');
if (process.env.VITE_PHONE_CALL_BACKEND_URL) {
  console.log(`☎️  Phone call backend: ${process.env.VITE_PHONE_CALL_BACKEND_URL}`);
  console.log('🔒 Cloudflare/ngrok tunnel variables are disabled for the local backend only.\n');
} else {
  console.log('🔒 Cloudflare/ngrok tunnel variables are disabled for this session.\n');
}

const frontendAlreadyRunning = await isPortOpen(5173);
if (frontendAlreadyRunning) {
  console.log('ℹ️  Reusing existing frontend on http://localhost:5173');
} else {
  viteProcess = spawn('npx', ['vite', '--port', '5173', '--strictPort'], {
    stdio: 'inherit',
    cwd: rootDir,
    env: localEnv,
  });

  viteProcess.on('close', (code) => {
    handleExit('Vite', code, 5173);
  });
}

const backendAlreadyRunning = await isPortOpen(3001);
if (backendAlreadyRunning) {
  if (process.env.HOUSEYIELD_REUSE_BACKEND === '1') {
    console.log('ℹ️  Reusing existing backend on http://localhost:3001');
    console.warn('⚠️  Backend code changes are not reloaded in this mode. Stop the existing process on port 3001 if you need the latest server code.');
  } else {
    console.log('ℹ️  Restarting backend on http://localhost:3001 to pick up latest server code...');
    stopProcessOnPort(3001);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
} else {
  console.log('ℹ️  Starting backend on http://localhost:3001');
}

if (!(backendAlreadyRunning && process.env.HOUSEYIELD_REUSE_BACKEND === '1')) {
  serverProcess = spawn('node', ['--max-old-space-size=4096', 'server/index.js'], {
    stdio: 'inherit',
    cwd: rootDir,
    env: localEnv,
  });

  serverProcess.on('close', (code) => {
    handleExit('Backend server', code, 3001);
  });
}

if (!viteProcess && !serverProcess) {
  console.log('ℹ️  Frontend and backend are already running. Nothing to start.');
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));