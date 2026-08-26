#!/usr/bin/env node
/**
 * Generates shelly-retrofit-valve-kit-assembly.pdf from the HTML guide.
 * Usage: node scripts/generate-valve-kit-pdf.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'docs/shelly-retrofit-valve-kit/assembly-guide.html');
const pdfPath = path.join(root, 'docs/shelly-retrofit-valve-kit/shelly-retrofit-valve-kit-assembly.pdf');

if (!fs.existsSync(htmlPath)) {
  console.error('Missing HTML guide:', htmlPath);
  process.exit(1);
}

const chromeCandidates = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const chromePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));

if (!chromePath) {
  console.error('Chrome not found. Open this file in a browser and Print → Save as PDF:');
  console.error(htmlPath);
  process.exit(1);
}

const result = spawnSync(
  chromePath,
  [
    '--headless',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ],
  { stdio: 'inherit' },
);

if (result.status !== 0 || !fs.existsSync(pdfPath)) {
  console.error('PDF generation failed.');
  process.exit(result.status || 1);
}

console.log(`Wrote ${pdfPath} (${fs.statSync(pdfPath).size} bytes)`);
