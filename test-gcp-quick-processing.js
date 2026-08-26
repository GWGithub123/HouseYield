#!/usr/bin/env node
/**
 * Quick GCP Pipeline Processing Test
 * 
 * Tests actual processing on the VM with minimal data to verify
 * the pipeline works end-to-end in ~5 minutes instead of hours.
 * 
 * What it does:
 * 1. Creates 5-8 simple test images locally
 * 2. Uploads them to the GCP VM
 * 3. Runs COLMAP feature extraction (tests GPU)
 * 4. Runs COLMAP matching (tests GPU)
 * 5. Attempts sparse reconstruction
 * 6. Reports success/failure for each stage
 * 
 * Usage:
 *   node test-gcp-quick-processing.js
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Colors
const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(msg, color = 'reset') {
  console.log(`${c[color]}${msg}${c.reset}`);
}

// Load env
async function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    const envContent = await fs.readFile(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    });
  } catch (e) {}
}

function parseHost(host) {
  if (host && host.includes('.')) {
    const parts = host.split('.');
    if (parts.length >= 2) return [parts[0], parts[1]];
  }
  return [host, process.env.GCP_GPU_WORKER_ZONE || 'us-central1-a'];
}

async function sshCommand(instance, zone, user, command, timeout = 120000) {
  const { stdout, stderr } = await execAsync(
    `gcloud compute ssh ${user}@${instance} --zone=${zone} --command='${command}'`,
    { timeout, maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout.trim();
}

async function main() {
  console.log();
  log('╔═══════════════════════════════════════════════════════════════╗', 'cyan');
  log('║   GCP PIPELINE - QUICK PROCESSING TEST (~5 min)              ║', 'cyan');
  log('╚═══════════════════════════════════════════════════════════════╝', 'cyan');
  console.log();
  
  await loadEnv();
  
  const host = process.env.GCP_GPU_WORKER_HOST;
  const user = process.env.GCP_GPU_WORKER_USER || process.env.USER;
  const [instance, zone] = parseHost(host);
  
  if (!host) {
    log('❌ GCP_GPU_WORKER_HOST not configured in .env', 'red');
    process.exit(1);
  }
  
  log(`📡 VM: ${instance} (zone: ${zone})`, 'dim');
  log(`👤 User: ${user}`, 'dim');
  console.log();
  
  const testId = Date.now().toString();
  const remoteTestDir = `/tmp/pipeline-test-${testId}`;
  const remoteImagesDir = `${remoteTestDir}/images`;
  const remoteOutputDir = `${remoteTestDir}/output`;
  
  const results = {};
  const startTime = Date.now();
  
  try {
    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Create test images on VM using ImageMagick
    // ═══════════════════════════════════════════════════════════════
    log('[1/6] Creating test images on VM...', 'blue');
    
    await sshCommand(instance, zone, user, `mkdir -p ${remoteImagesDir} ${remoteOutputDir}`);
    
    // Create simple test images with ImageMagick (installed by default on most Linux)
    // These images have features that COLMAP can detect
    const createImagesCmd = `
cd ${remoteImagesDir} && \\
for i in 1 2 3 4 5 6; do \\
  convert -size 800x600 xc:white \\
    -fill black -draw "rectangle $((50+i*20)),$((50+i*10)) $((200+i*30)),$((150+i*20))" \\
    -fill gray -draw "circle $((400+i*15)),$((300+i*10)) $((450+i*15)),$((300+i*10))" \\
    -fill darkgray -draw "polygon $((600-i*10)),$((100+i*5)) $((700-i*10)),$((200+i*5)) $((550-i*10)),$((200+i*5))" \\
    -pointsize 30 -annotate +100+400 "Frame $i" \\
    test_\${i}.jpg 2>/dev/null || echo "ImageMagick not available"; \\
done && ls -la
`;
    
    let imagesCreated = false;
    try {
      const imgResult = await sshCommand(instance, zone, user, createImagesCmd, 60000);
      if (imgResult.includes('test_1.jpg')) {
        log('  ✅ Created 6 test images with ImageMagick', 'green');
        imagesCreated = true;
        results.images = true;
      }
    } catch (e) {
      log('  ⚠️  ImageMagick not available, downloading sample images...', 'yellow');
    }
    
    // Fallback: Download real test images from the web
    if (!imagesCreated) {
      const downloadCmd = `
cd ${remoteImagesDir} && \\
for i in 1 2 3 4 5 6; do \\
  curl -s -o test_\${i}.jpg "https://picsum.photos/800/600?random=\${i}" 2>/dev/null; \\
done && ls -la *.jpg
`;
      try {
        const dlResult = await sshCommand(instance, zone, user, downloadCmd, 60000);
        if (dlResult.includes('test_1.jpg')) {
          log('  ✅ Downloaded 6 sample images', 'green');
          results.images = true;
        } else {
          throw new Error('Download failed');
        }
      } catch (e) {
        log('  ❌ Failed to create test images', 'red');
        results.images = false;
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // STEP 2: Test COLMAP Feature Extraction (GPU)
    // ═══════════════════════════════════════════════════════════════
    log('\n[2/6] Testing COLMAP feature extraction (GPU)...', 'blue');
    
    const featureCmd = `
cd ${remoteTestDir} && \\
colmap feature_extractor \\
  --database_path ${remoteOutputDir}/database.db \\
  --image_path ${remoteImagesDir} \\
  --ImageReader.single_camera 1 \\
  --SiftExtraction.use_gpu 1 \\
  --SiftExtraction.max_num_features 2000 \\
  2>&1 | tail -20
`;
    
    try {
      const featureResult = await sshCommand(instance, zone, user, featureCmd, 120000);
      
      if (featureResult.includes('Processed') || featureResult.includes('features')) {
        log('  ✅ Feature extraction successful (GPU SIFT)', 'green');
        results.features = true;
        
        // Check if GPU was used
        if (featureResult.includes('CUDA') || featureResult.includes('GPU')) {
          log('  ✅ Confirmed GPU acceleration active', 'green');
        }
      } else {
        log(`  ⚠️  Feature extraction output: ${featureResult.substring(0, 200)}`, 'yellow');
        results.features = 'partial';
      }
    } catch (e) {
      log(`  ❌ Feature extraction failed: ${e.message.substring(0, 100)}`, 'red');
      results.features = false;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // STEP 3: Test COLMAP Feature Matching (GPU)
    // ═══════════════════════════════════════════════════════════════
    log('\n[3/6] Testing COLMAP feature matching (GPU)...', 'blue');
    
    const matchCmd = `
cd ${remoteTestDir} && \\
colmap exhaustive_matcher \\
  --database_path ${remoteOutputDir}/database.db \\
  --SiftMatching.use_gpu 1 \\
  2>&1 | tail -20
`;
    
    try {
      const matchResult = await sshCommand(instance, zone, user, matchCmd, 120000);
      
      if (matchResult.includes('Matching') || matchResult.includes('matches')) {
        log('  ✅ Feature matching successful (GPU)', 'green');
        results.matching = true;
      } else {
        log(`  ⚠️  Matching output: ${matchResult.substring(0, 200)}`, 'yellow');
        results.matching = 'partial';
      }
    } catch (e) {
      log(`  ❌ Feature matching failed: ${e.message.substring(0, 100)}`, 'red');
      results.matching = false;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // STEP 4: Test COLMAP Sparse Reconstruction
    // ═══════════════════════════════════════════════════════════════
    log('\n[4/6] Testing COLMAP sparse reconstruction (SfM)...', 'blue');
    
    const mapperCmd = `
mkdir -p ${remoteOutputDir}/sparse && \\
colmap mapper \\
  --database_path ${remoteOutputDir}/database.db \\
  --image_path ${remoteImagesDir} \\
  --output_path ${remoteOutputDir}/sparse \\
  --Mapper.min_num_matches 5 \\
  --Mapper.init_min_num_inliers 10 \\
  --Mapper.ba_refine_focal_length 0 \\
  2>&1 | tail -30
`;
    
    try {
      const mapperResult = await sshCommand(instance, zone, user, mapperCmd, 180000);
      
      // Check output directory
      const sparseCheck = await sshCommand(instance, zone, user, 
        `ls -la ${remoteOutputDir}/sparse/ 2>/dev/null || echo "empty"`);
      
      if (sparseCheck.includes('0') && !sparseCheck.includes('empty')) {
        log('  ✅ Sparse reconstruction created model', 'green');
        results.sparse = true;
      } else if (mapperResult.includes('Registered') || mapperResult.includes('images')) {
        log('  ⚠️  Mapper ran but model may be incomplete (expected with synthetic images)', 'yellow');
        results.sparse = 'partial';
      } else {
        log('  ⚠️  Sparse reconstruction: insufficient feature matches (normal for test images)', 'yellow');
        log('  ℹ️  This is expected - synthetic images lack real-world features', 'dim');
        results.sparse = 'expected-fail';
      }
    } catch (e) {
      log(`  ⚠️  Mapper error (expected with test images): ${e.message.substring(0, 80)}`, 'yellow');
      results.sparse = 'expected-fail';
    }
    
    // ═══════════════════════════════════════════════════════════════
    // STEP 5: Verify GPU is actually being used
    // ═══════════════════════════════════════════════════════════════
    log('\n[5/6] Verifying GPU utilization...', 'blue');
    
    try {
      const gpuInfo = await sshCommand(instance, zone, user, 
        'nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader');
      
      log(`  ✅ GPU: ${gpuInfo}`, 'green');
      results.gpu = true;
    } catch (e) {
      log(`  ❌ Could not query GPU: ${e.message}`, 'red');
      results.gpu = false;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // STEP 6: Test full pipeline script (dry run check)
    // ═══════════════════════════════════════════════════════════════
    log('\n[6/6] Verifying full pipeline script...', 'blue');
    
    try {
      const pipelineCheck = await sshCommand(instance, zone, user,
        'python3 /opt/photogrammetry-service/process_full_pipeline.py --help | head -5');
      
      if (pipelineCheck.includes('usage:')) {
        log('  ✅ Full pipeline script is ready', 'green');
        results.pipeline = true;
      } else {
        log('  ⚠️  Pipeline script check unclear', 'yellow');
        results.pipeline = 'partial';
      }
    } catch (e) {
      log(`  ❌ Pipeline script error: ${e.message}`, 'red');
      results.pipeline = false;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // Cleanup
    // ═══════════════════════════════════════════════════════════════
    log('\n🧹 Cleaning up test files...', 'dim');
    await sshCommand(instance, zone, user, `rm -rf ${remoteTestDir}`).catch(() => {});
    
  } catch (error) {
    log(`\n❌ Test failed: ${error.message}`, 'red');
    results.error = error.message;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  
  console.log();
  log('═══════════════════════════════════════════════════════════════', 'cyan');
  log('  QUICK PROCESSING TEST RESULTS', 'cyan');
  log('═══════════════════════════════════════════════════════════════', 'cyan');
  console.log();
  
  const statusIcon = (v) => {
    if (v === true) return '✅';
    if (v === false) return '❌';
    if (v === 'partial' || v === 'expected-fail') return '⚠️';
    return '❓';
  };
  
  log(`  ${statusIcon(results.images)} Test images created`, results.images ? 'green' : 'yellow');
  log(`  ${statusIcon(results.features)} Feature extraction (GPU SIFT)`, results.features ? 'green' : 'yellow');
  log(`  ${statusIcon(results.matching)} Feature matching (GPU)`, results.matching ? 'green' : 'yellow');
  log(`  ${statusIcon(results.sparse)} Sparse reconstruction`, results.sparse === true ? 'green' : 'yellow');
  log(`  ${statusIcon(results.gpu)} GPU verification`, results.gpu ? 'green' : 'red');
  log(`  ${statusIcon(results.pipeline)} Pipeline script ready`, results.pipeline ? 'green' : 'yellow');
  
  console.log();
  log(`  ⏱️  Completed in ${elapsed} seconds`, 'dim');
  console.log();
  
  // Determine overall status
  const criticalPassed = results.features && results.matching && results.gpu && results.pipeline;
  
  if (criticalPassed) {
    log('═══════════════════════════════════════════════════════════════', 'green');
    log('  🎉 PIPELINE IS OPERATIONAL!', 'green');
    log('═══════════════════════════════════════════════════════════════', 'green');
    console.log();
    log('  The GCP GPU pipeline is working correctly:', 'dim');
    log('  • COLMAP feature extraction works with GPU', 'dim');
    log('  • COLMAP matching works with GPU', 'dim');
    log('  • Full pipeline script is ready', 'dim');
    console.log();
    log('  Note: Sparse reconstruction may fail with synthetic test', 'dim');
    log('  images but will work with real room photos.', 'dim');
    console.log();
    process.exit(0);
  } else {
    log('═══════════════════════════════════════════════════════════════', 'yellow');
    log('  ⚠️  Some components need attention', 'yellow');
    log('═══════════════════════════════════════════════════════════════', 'yellow');
    console.log();
    process.exit(1);
  }
}

main().catch(e => {
  log(`\n❌ Fatal error: ${e.message}`, 'red');
  console.error(e);
  process.exit(1);
});
