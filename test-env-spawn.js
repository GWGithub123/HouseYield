#!/usr/bin/env node
import { spawn } from 'child_process';
import 'dotenv/config';

console.log('Node.js process.env.GCP_GPU_WORKER_ENABLE:', process.env.GCP_GPU_WORKER_ENABLE);

const proc = spawn('python3', ['-c', 'import os; print("Python GCP_GPU_WORKER_ENABLE:", os.environ.get("GCP_GPU_WORKER_ENABLE", "NOT SET"))'], {
  env: { ...process.env }
});

proc.stdout.on('data', (data) => console.log(data.toString().trim()));
proc.stderr.on('data', (data) => console.error(data.toString().trim()));
