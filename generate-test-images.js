#!/usr/bin/env node
/**
 * Mini Image Set Generator for Quick Pipeline Testing
 * 
 * Generates a small set of synthetic test images with known geometry
 * that can be processed quickly (minutes instead of hours) to verify
 * the pipeline is working end-to-end.
 * 
 * Usage:
 *   node generate-test-images.js               # Generate 10 test images
 *   node generate-test-images.js --count=5     # Generate 5 test images
 *   node generate-test-images.js --run         # Generate and run pipeline
 */

import { createCanvas } from 'canvas';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, 'server/data/test-images');

// Parse command line args
const args = process.argv.slice(2);
const countArg = args.find(a => a.startsWith('--count='));
const imageCount = countArg ? parseInt(countArg.split('=')[1]) : 10;
const runPipeline = args.includes('--run');

console.log(`\n🖼️  Test Image Generator for GCP Pipeline Testing`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

async function generateTestImages() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  
  console.log(`📁 Output directory: ${OUTPUT_DIR}`);
  console.log(`📸 Generating ${imageCount} test images...\n`);
  
  const width = 1920;
  const height = 1080;
  
  for (let i = 0; i < imageCount; i++) {
    // Simulate camera rotating around a 3D scene
    const angle = (i / imageCount) * Math.PI * 2;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Sky gradient background
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#87CEEB');
    gradient.addColorStop(1, '#E0F6FF');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    
    // Ground
    ctx.fillStyle = '#8B7355';
    ctx.fillRect(0, height * 0.6, width, height * 0.4);
    
    // 3D cube simulation (rotate around scene)
    const centerX = width / 2 + Math.cos(angle) * 200;
    const centerY = height / 2 - 100;
    const size = 150;
    
    // Draw a simple 3D box with perspective
    const perspective = 0.5 + Math.sin(angle) * 0.3;
    
    // Front face
    ctx.fillStyle = '#FF6B6B';
    ctx.fillRect(centerX - size/2, centerY - size/2, size * perspective, size);
    
    // Side face
    ctx.fillStyle = '#4ECDC4';
    const sideWidth = size * (1 - perspective);
    ctx.beginPath();
    ctx.moveTo(centerX - size/2 + size * perspective, centerY - size/2);
    ctx.lineTo(centerX - size/2 + size * perspective + sideWidth, centerY - size/2 - 30);
    ctx.lineTo(centerX - size/2 + size * perspective + sideWidth, centerY + size/2 - 30);
    ctx.lineTo(centerX - size/2 + size * perspective, centerY + size/2);
    ctx.closePath();
    ctx.fill();
    
    // Top face
    ctx.fillStyle = '#45B7D1';
    ctx.beginPath();
    ctx.moveTo(centerX - size/2, centerY - size/2);
    ctx.lineTo(centerX - size/2 + size * perspective, centerY - size/2);
    ctx.lineTo(centerX - size/2 + size * perspective + sideWidth, centerY - size/2 - 30);
    ctx.lineTo(centerX - size/2 + sideWidth, centerY - size/2 - 30);
    ctx.closePath();
    ctx.fill();
    
    // Add some feature points (important for COLMAP)
    ctx.fillStyle = '#333333';
    for (let j = 0; j < 50; j++) {
      const px = Math.random() * width;
      const py = Math.random() * height;
      const psize = 2 + Math.random() * 3;
      ctx.beginPath();
      ctx.arc(px, py, psize, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // Add frame number and camera info
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(10, 10, 200, 60);
    ctx.fillStyle = 'white';
    ctx.font = '14px sans-serif';
    ctx.fillText(`Frame ${i + 1}/${imageCount}`, 20, 35);
    ctx.fillText(`Angle: ${Math.round(angle * 180 / Math.PI)}°`, 20, 55);
    
    // Save image
    const buffer = canvas.toBuffer('image/jpeg', { quality: 0.95 });
    const filename = `test_${String(i + 1).padStart(4, '0')}.jpg`;
    await fs.writeFile(path.join(OUTPUT_DIR, filename), buffer);
    
    process.stdout.write(`  ✅ Generated ${filename}\n`);
  }
  
  // Create metadata file
  const metadata = {
    scanId: `test-${Date.now()}`,
    roomName: 'Test Room (Synthetic)',
    captureDate: new Date().toISOString(),
    imageCount,
    imageResolution: `${width}x${height}`,
    purpose: 'GCP Pipeline Quick Test',
    note: 'These synthetic images are for testing pipeline connectivity only',
  };
  
  await fs.writeFile(
    path.join(OUTPUT_DIR, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );
  
  console.log(`\n✅ Generated ${imageCount} test images in ${OUTPUT_DIR}`);
  console.log(`📋 Metadata saved to metadata.json`);
  
  return metadata;
}

async function runQuickPipelineTest(metadata) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🚀 Running Quick Pipeline Test`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  
  console.log(`⚠️  This will run the actual GCP pipeline with ${imageCount} images.`);
  console.log(`   Expected time: 5-15 minutes (depending on GPU)\n`);
  
  // Check if backend is running
  try {
    const response = await fetch('http://localhost:3001/health');
    if (!response.ok) {
      console.error('❌ Backend server is not running. Start it with: npm run push-server');
      return;
    }
  } catch {
    console.error('❌ Backend server is not running. Start it with: npm run push-server');
    return;
  }
  
  // Create a scan via API
  console.log('📤 Creating test scan...');
  const createResponse = await fetch('http://localhost:3001/api/photogrammetry/scans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomName: metadata.roomName,
      propertyId: 'test-property',
    }),
  });
  
  if (!createResponse.ok) {
    console.error('❌ Failed to create scan');
    return;
  }
  
  const { scanId } = await createResponse.json();
  console.log(`   Scan ID: ${scanId}`);
  
  // Upload images
  console.log('\n📤 Uploading test images...');
  const images = await fs.readdir(OUTPUT_DIR);
  const jpgImages = images.filter(f => f.endsWith('.jpg'));
  
  for (const img of jpgImages) {
    const formData = new FormData();
    const imgBuffer = await fs.readFile(path.join(OUTPUT_DIR, img));
    formData.append('images', new Blob([imgBuffer]), img);
    
    await fetch(`http://localhost:3001/api/photogrammetry/scans/${scanId}/images`, {
      method: 'POST',
      body: formData,
    });
    process.stdout.write('.');
  }
  console.log(' Done!');
  
  // Start processing
  console.log('\n🔄 Starting processing...');
  const processResponse = await fetch(
    `http://localhost:3001/api/photogrammetry/scans/${scanId}/process`,
    { method: 'POST' }
  );
  
  if (!processResponse.ok) {
    console.error('❌ Failed to start processing');
    return;
  }
  
  console.log('   Processing started! Monitor progress in the frontend or via SSE.');
  console.log(`   Frontend URL: http://localhost:5173/room-scanner`);
  console.log(`\n   To monitor via command line:`);
  console.log(`   curl -N http://localhost:3001/api/photogrammetry/scans/${scanId}/progress`);
}

// Main
async function main() {
  try {
    // Check if canvas is available
    try {
      await import('canvas');
    } catch {
      console.error('❌ The "canvas" package is not installed.');
      console.error('   Install it with: npm install canvas');
      console.error('\n   Alternatively, you can use real images for testing.');
      console.error('   Just place 10-20 JPG images in: server/data/test-images/');
      process.exit(1);
    }
    
    const metadata = await generateTestImages();
    
    if (runPipeline) {
      await runQuickPipelineTest(metadata);
    } else {
      console.log(`\nTo run the pipeline with these images:`);
      console.log(`  node generate-test-images.js --run`);
      console.log(`\nOr manually upload them via the Photogrammetry Scanner.`);
    }
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
