/**
 * GCP GPU Worker Service
 * 
 * Handles communication with Google Cloud GPU VM for CUDA-accelerated
 * dense reconstruction. Transfers files via SCP, executes remote processing,
 * and retrieves results.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);

class GcpGpuWorker {
  constructor() {
    this.enabled = process.env.GCP_GPU_WORKER_ENABLE === 'true';
    this.host = process.env.GCP_GPU_WORKER_HOST;
    this.instance = process.env.GCP_GPU_WORKER_INSTANCE;
    this.zone = process.env.GCP_GPU_WORKER_ZONE;
    this.project = process.env.GCP_GPU_WORKER_PROJECT;
    this.user = process.env.GCP_GPU_WORKER_USER || process.env.USER;
    // Use /opt/photogrammetry-data for persistent storage (survives VM restart)
    // /tmp is cleared on reboot, causing loss of completed scans
    this.processingDir = process.env.GCP_PROCESSING_DIR || '/opt/photogrammetry-data';
    this.serviceDir = '/opt/photogrammetry-service';  // Updated to match VM setup script
    
    if (this.enabled && (!this.host || !this.instance || !this.zone || !this.project)) {
      throw new Error('GCP_GPU_WORKER_HOST, GCP_GPU_WORKER_INSTANCE, GCP_GPU_WORKER_ZONE, and GCP_GPU_WORKER_PROJECT must be set when GCP_GPU_WORKER_ENABLE=true');
    }
    
    console.log('[GcpGpuWorker] Initialized:', {
      enabled: this.enabled,
      host: this.host,
      instance: this.instance,
      zone: this.zone,
      project: this.project,
      user: this.user,
    });
  }
  
  /**
   * Check if GPU worker is available
   */
  async isAvailable() {
    if (!this.enabled) return false;
    
    try {
      // Try to ping the VM
      await this.execRemote('echo "GPU worker ready"');
      return true;
    } catch (error) {
      console.error('[GcpGpuWorker] Not available:', error.message);
      return false;
    }
  }
  
  /**
   * Start the GPU VM if stopped
   */
  async startVM() {
    if (!this.enabled) return;
    
    console.log('[GcpGpuWorker] Starting GPU VM...');
    
    try {
      const { instance, zone, project } = this.getInstanceInfo();
      
      let startCmd = `gcloud compute instances start ${instance} --zone=${zone}`;
      if (project) {
        startCmd += ` --project=${project}`;
      }
      await execAsync(startCmd);
      
      // Wait for VM to be ready (max 90 seconds - VM boot takes time)
      let ready = false;
      for (let i = 0; i < 18; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (await this.isAvailable()) {
          ready = true;
          break;
        }
      }
      
      if (!ready) {
        throw new Error('GPU VM failed to start within 90 seconds');
      }
      
      console.log('[GcpGpuWorker] ✅ GPU VM started and ready');
    } catch (error) {
      console.error('[GcpGpuWorker] Failed to start VM:', error.message);
      throw error;
    }
  }
  
  /**
   * Process full COLMAP pipeline on GPU VM (features → matching → SfM → dense)
   * 
   * @param {string} localImagesDir - Local directory with images only
   * @param {string} localOutputDir - Local directory for output
   * @param {string} quality - 'high', 'medium', 'low'
   * @returns {Object} Result with num_points, points_path, sparse_path, method
   */
  async processFullPipeline(localImagesDir, localOutputDir, quality = 'high', progressCallback = null) {
    if (!this.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }
    
    console.log('[GcpGpuWorker] Starting FULL pipeline on GPU VM (quality: ' + quality + ')');
    
    try {
      // 1. Ensure VM is running
      if (progressCallback) progressCallback('Starting GPU VM...');
      const isReady = await this.isAvailable();
      if (!isReady) {
        await this.startVM();
      }
      
      // 2. Create remote directories
      if (progressCallback) progressCallback('Preparing remote workspace...');
      const jobId = Date.now().toString();
      const remoteImagesDir = `${this.processingDir}/images-${jobId}`;
      const remoteOutputDir = `${this.processingDir}/output-${jobId}`;
      
      await this.execRemote(`mkdir -p ${remoteImagesDir} ${remoteOutputDir}`);
      
      // 3. Save job metadata on VM for recovery
      const jobMetadata = {
        jobId,
        localOutputDir,
        remoteImagesDir,
        remoteOutputDir,
        startTime: new Date().toISOString(),
        status: 'running',
      };
      await this.execRemote(`echo '${JSON.stringify(jobMetadata)}' > ${remoteOutputDir}/job_metadata.json`);
      console.log(`[GcpGpuWorker] Job ${jobId} metadata saved for recovery`);
      
      // 4. Upload images only
      if (progressCallback) progressCallback('Uploading images to GPU VM...');
      await this.uploadDirectory(localImagesDir, remoteImagesDir);
      
      // 5. Run full pipeline with nohup to survive SSH disconnection
      if (progressCallback) progressCallback('Running full COLMAP pipeline on GPU...');
      const logFile = `${remoteOutputDir}/pipeline.log`;
      const statusFile = `${remoteOutputDir}/status.json`;
      
      // Start full pipeline in background with nohup (images → features → matching → sparse → dense → mesh → texture)
      // Uses process_images_to_mesh.py which includes HLOC/GLOMAP for 4×L4 GPU optimization
      // Use /opt/photogrammetry-venv/bin/python3 for Ubuntu 24.04 with PEP 668 compliance
      await this.execRemote(
        `nohup /opt/photogrammetry-venv/bin/python3 ${this.serviceDir}/process_images_to_mesh.py ${remoteImagesDir} ${remoteOutputDir} --quality high > ${logFile} 2>&1 && echo '{"done":true,"completedAt":"$(date -Iseconds)"}' > ${statusFile} || echo '{"done":true,"error":"Pipeline failed","completedAt":"$(date -Iseconds)"}' > ${statusFile} &`
      );
      
      // Poll for completion
      console.log('[GcpGpuWorker] Pipeline started, polling for completion...');
      console.log(`[GcpGpuWorker] Job ID: ${jobId}, Output Dir: ${remoteOutputDir}`);
      const startTime = Date.now();
      const timeout = 4 * 60 * 60 * 1000; // 4 hour timeout for large scans (433+ images)
      const pollInterval = 15000; // Check every 15 seconds
      
      let result = null;
      let lastProgress = '';
      let pollCount = 0;
      while (Date.now() - startTime < timeout) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        pollCount++;
        
        try {
          // Check if status file exists (indicates completion)
          const statusCheck = await this.execRemote(`cat ${statusFile} 2>/dev/null || echo ""`);
          if (statusCheck.includes('"done":true')) {
            // Pipeline finished, get the result from the log
            console.log(`[GcpGpuWorker] Job ${jobId} completed! Retrieving results...`);
            const logContent = await this.execRemote(`tail -100 ${logFile}`);
            
            // Extract JSON result from log (last JSON line)
            const jsonMatch = logContent.match(/\{[^{}]*"success"[^{}]*\}(?!.*\{[^{}]*"success")/s);
            if (jsonMatch) {
              result = jsonMatch[0];
              break;
            } else {
              console.error('[GcpGpuWorker] No result JSON in log. Last 100 lines:');
              console.error(logContent);
              throw new Error('Pipeline completed but no result JSON found in log');
            }
          }
          
          // Show progress from log (every 4th poll to reduce noise)
          if (pollCount % 4 === 0) {
            const lastLine = await this.execRemote(`tail -1 ${logFile} 2>/dev/null || echo ""`);
            if (lastLine && lastLine !== lastProgress) {
              lastProgress = lastLine;
              const elapsed = Math.round((Date.now() - startTime) / 1000 / 60);
              console.log(`[GcpGpuWorker] Job ${jobId} progress (${elapsed}m): ${lastLine.substring(0, 100)}`);
              if (progressCallback) {
                progressCallback(`GPU processing (${elapsed} min): ${lastLine.substring(0, 80)}...`);
              }
            }
          }
        } catch (pollError) {
          // Log poll errors but continue (VM might be temporarily unreachable)
          console.warn(`[GcpGpuWorker] Poll error (job ${jobId}):`, pollError.message);
        }
      }
      
      if (!result) {
        // Timeout - but job may still be running on VM
        console.error(`[GcpGpuWorker] Job ${jobId} timed out after 4 hours. Job may still be running.`);
        console.error(`[GcpGpuWorker] Recovery: VM output dir: ${remoteOutputDir}`);
        console.error(`[GcpGpuWorker] Use listCompletedJobs() and recoverJob() to retrieve results later.`);
        throw new Error(`Pipeline timed out after 4 hours. Job ${jobId} may still be running on VM. Check ${remoteOutputDir}`);
      }
      
      // Parse result JSON
      const resultData = JSON.parse(result);
      if (!resultData.success) {
        console.error(`[GcpGpuWorker] Job ${jobId} failed:`, resultData.error);
        throw new Error(`GPU processing failed: ${resultData.error}`);
      }
      
      // 6. Download results
      console.log(`[GcpGpuWorker] Job ${jobId} successful, downloading results...`);
      if (progressCallback) progressCallback('Downloading results...');
      await this.downloadFile(resultData.dense_path, path.join(localOutputDir, 'fused.ply'));
      await this.downloadFile(resultData.sparse_path, path.join(localOutputDir, 'sparse.ply'));
      
      // Download textured mesh files (OBJ, MTL, texture)
      if (resultData.textured_mesh_path) {
        if (progressCallback) progressCallback('Downloading textured mesh...');
        await this.downloadFile(resultData.textured_mesh_path, path.join(localOutputDir, 'textured_mesh.obj'));
        
        // Download MTL file
        const mtlPath = resultData.textured_mesh_path.replace('.obj', '.mtl');
        try {
          await this.downloadFile(mtlPath, path.join(localOutputDir, 'textured_mesh.mtl'));
        } catch (e) {
          console.warn('[GcpGpuWorker] No MTL file found');
        }
        
        // Download texture file(s) - check for common naming patterns
        const outputDir = resultData.textured_mesh_path.replace('/textured_mesh.obj', '');
        try {
          const textures = await this.execRemote(`ls ${outputDir}/*.jpg ${outputDir}/*.png 2>/dev/null || true`);
          for (const texFile of textures.trim().split('\n').filter(f => f)) {
            const texName = texFile.split('/').pop();
            await this.downloadFile(texFile, path.join(localOutputDir, texName));
            console.log(`[GcpGpuWorker] Downloaded texture: ${texName}`);
          }
        } catch (e) {
          console.warn('[GcpGpuWorker] Error downloading textures:', e.message);
        }
      }
      
      // Download mesh PLY if available
      if (resultData.mesh_path) {
        try {
          await this.downloadFile(resultData.mesh_path, path.join(localOutputDir, 'mesh.ply'));
        } catch (e) {
          console.warn('[GcpGpuWorker] No mesh PLY found');
        }
      }
      
      // Download sparse model directory for camera data
      const sparseModelLocal = path.join(localOutputDir, 'sparse', '0');
      await execAsync(`mkdir -p "${sparseModelLocal}"`);
      await this.execRemote(`cd ${resultData.sparse_model_dir} && tar -czf /tmp/sparse-${jobId}.tar.gz .`);
      await this.downloadFile(`/tmp/sparse-${jobId}.tar.gz`, path.join(localOutputDir, 'sparse.tar.gz'));
      await execAsync(`cd "${sparseModelLocal}" && tar -xzf "${path.join(localOutputDir, 'sparse.tar.gz')}"`);
      
      // 6. Cleanup remote files
      if (progressCallback) progressCallback('Cleaning up...');
      await this.execRemote(`rm -rf ${remoteImagesDir} ${remoteOutputDir} /tmp/sparse-${jobId}.tar.gz`);
      
      console.log(`[GcpGpuWorker] ✅ Full pipeline complete:`);
      console.log(`  Sparse: ${resultData.num_sparse_points.toLocaleString()} points`);
      console.log(`  Dense: ${resultData.num_dense_points.toLocaleString()} points`);
      if (resultData.textured_mesh_path) {
        console.log(`  Textured mesh: downloaded`);
      }
      
      return {
        num_sparse_points: resultData.num_sparse_points,
        num_dense_points: resultData.num_dense_points,
        sparse_path: path.join(localOutputDir, 'sparse.ply'),
        dense_path: path.join(localOutputDir, 'fused.ply'),
        sparse_model_dir: path.join(localOutputDir, 'sparse', '0'),
        textured_mesh_path: resultData.textured_mesh_path ? path.join(localOutputDir, 'textured_mesh.obj') : null,
        method: 'colmap_full_gpu',
      };
      
    } catch (error) {
      console.error('[GcpGpuWorker] Full pipeline failed:', error);
      throw error;
    }
  }

  /**
   * Process dense reconstruction on GPU VM
   * 
   * @param {string} localInputDir - Local directory with sparse reconstruction + images
   * @param {string} localOutputDir - Local directory for output
   * @returns {Object} Result with num_points, points_path, method
   */
  async processDenseReconstruction(localInputDir, localOutputDir, progressCallback = null) {
    if (!this.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }
    
    console.log('[GcpGpuWorker] Starting dense reconstruction on GPU VM');
    
    try {
      // 1. Ensure VM is running
      if (progressCallback) progressCallback('Starting GPU VM...');
      const isReady = await this.isAvailable();
      if (!isReady) {
        await this.startVM();
      }
      
      // 2. Create remote directories
      if (progressCallback) progressCallback('Preparing remote workspace...');
      const jobId = Date.now().toString();
      const remoteInputDir = `${this.processingDir}/input-${jobId}`;
      const remoteOutputDir = `${this.processingDir}/output-${jobId}`;
      
      await this.execRemote(`mkdir -p ${remoteInputDir} ${remoteOutputDir}`);
      
      // 3. Upload sparse reconstruction + images
      if (progressCallback) progressCallback('Uploading data to GPU VM...');
      await this.uploadDirectory(localInputDir, remoteInputDir);
      
      // 4. Run dense reconstruction
      if (progressCallback) progressCallback('Running CUDA dense reconstruction...');
      const result = await this.execRemote(
        `/opt/photogrammetry-venv/bin/python3 ${this.serviceDir}/process_dense.py ${remoteInputDir} ${remoteOutputDir}`
      );
      
      // Parse result JSON - extract last line which contains the JSON result
      // (previous lines are progress messages like "[GPU Worker] ...")
      const lines = result.trim().split('\n');
      let resultData = null;
      
      // Find the JSON result line (last line that starts with '{')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            resultData = JSON.parse(line);
            break;
          } catch (e) {
            // Not valid JSON, continue looking
          }
        }
      }
      
      if (!resultData) {
        throw new Error(`Failed to parse GPU worker response. Output: ${result.substring(0, 500)}`);
      }
      
      if (!resultData.success) {
        throw new Error(`GPU processing failed: ${resultData.error}`);
      }
      
      // 5. Download results
      if (progressCallback) progressCallback('Downloading dense point cloud...');
      await this.downloadFile(resultData.points_path, path.join(localOutputDir, 'fused.ply'));
      
      // 6. Cleanup remote files
      if (progressCallback) progressCallback('Cleaning up...');
      await this.execRemote(`rm -rf ${remoteInputDir} ${remoteOutputDir}`);
      
      console.log(`[GcpGpuWorker] ✅ Dense reconstruction complete: ${resultData.num_points.toLocaleString()} points`);
      
      return {
        num_points: resultData.num_points,
        points_path: path.join(localOutputDir, 'fused.ply'),
        method: 'colmap_cuda_gcp',
      };
      
    } catch (error) {
      console.error('[GcpGpuWorker] Processing failed:', error);
      throw error;
    }
  }
  
  /**
   * Process complete pipeline on GPU: Dense → Mesh → Texture
   * 
   * @param {string} localInputDir - Local directory with sparse reconstruction + images
   * @param {string} localOutputDir - Local directory for output
   * @returns {Object} Result with points, mesh, and texture paths
   */
  async processFullMeshPipeline(localInputDir, localOutputDir, progressCallback = null) {
    if (!this.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }
    
    const jobId = Date.now();
    // Use persistent storage directory
    const remoteInputDir = `${this.processingDir}/input-${jobId}`;
    const remoteOutputDir = `${this.processingDir}/output-${jobId}`;
    
    try {
      // 1. Ensure VM is running
      if (progressCallback) progressCallback('Starting GPU VM...');
      await this.startVM();
      
      // 2. Prepare remote workspace
      if (progressCallback) progressCallback('Preparing remote workspace...');
      await this.execRemote(`mkdir -p ${remoteInputDir} ${remoteOutputDir}`);
      
      // 3. Upload sparse reconstruction + images
      if (progressCallback) progressCallback('Uploading data to GPU VM...');
      await this.uploadDirectory(localInputDir, remoteInputDir);
      
      // 4. Run full pipeline (dense + mesh + texture)
      if (progressCallback) progressCallback('Running GPU pipeline (dense + mesh + texture)...');
      const result = await this.execRemote(
        `/opt/photogrammetry-venv/bin/python3 ${this.serviceDir}/process_full_pipeline.py ${remoteInputDir} ${remoteOutputDir}`
      );
      
      // Parse result JSON
      const lines = result.trim().split('\n');
      let resultData = null;
      
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            resultData = JSON.parse(line);
            break;
          } catch (e) {}
        }
      }
      
      if (!resultData) {
        throw new Error(`Failed to parse GPU worker response. Output: ${result.substring(0, 500)}`);
      }
      
      if (!resultData.success) {
        throw new Error(`GPU processing failed: ${resultData.error}`);
      }
      
      // 5. Download results
      if (progressCallback) progressCallback('Downloading results...');
      
      // Download dense point cloud
      await this.downloadFile(resultData.points_path, path.join(localOutputDir, 'fused.ply'));
      
      // Download mesh if available
      if (resultData.mesh_path) {
        await this.downloadFile(resultData.mesh_path, path.join(localOutputDir, 'mesh.ply'));
      }
      
      // Download textured mesh if available
      if (resultData.textured_mesh_path) {
        await this.downloadFile(resultData.textured_mesh_path, path.join(localOutputDir, 'textured_mesh.obj'));
      }
      if (resultData.texture_path) {
        await this.downloadFile(resultData.texture_path, path.join(localOutputDir, 'texture.png'));
      }
      
      // 6. Cleanup remote files
      if (progressCallback) progressCallback('Cleaning up...');
      await this.execRemote(`rm -rf ${remoteInputDir} ${remoteOutputDir}`);
      
      console.log(`[GcpGpuWorker] ✅ Full mesh pipeline complete:`);
      console.log(`  Points: ${resultData.num_points?.toLocaleString()}`);
      console.log(`  Vertices: ${resultData.num_vertices?.toLocaleString()}`);
      console.log(`  Triangles: ${resultData.num_triangles?.toLocaleString()}`);
      
      return {
        num_points: resultData.num_points,
        points_path: path.join(localOutputDir, 'fused.ply'),
        num_vertices: resultData.num_vertices,
        num_triangles: resultData.num_triangles,
        mesh_path: resultData.mesh_path ? path.join(localOutputDir, 'mesh.ply') : null,
        textured_mesh_path: resultData.textured_mesh_path ? path.join(localOutputDir, 'textured_mesh.obj') : null,
        texture_path: resultData.texture_path ? path.join(localOutputDir, 'texture.png') : null,
        method: 'colmap_cuda_full_gcp',
      };
      
    } catch (error) {
      console.error('[GcpGpuWorker] Full mesh pipeline failed:', error);
      throw error;
    }
  }
  
  /**
   * Get parsed instance name and zone from host
   */
  getInstanceInfo() {
    // Return instance info from env variables instead of parsing hostname
    return {
      instance: this.instance,
      zone: this.zone,
      project: this.project
    };
  }

  /**
   * Execute command on remote VM via gcloud compute ssh
   */
  async execRemote(command) {
    const { instance, zone, project } = this.getInstanceInfo();
    
    // Use gcloud compute ssh which handles IP resolution and SSH keys automatically
    let sshCmd = `gcloud compute ssh ${instance} --zone=${zone} --command="${command.replace(/"/g, '\\"')}"`;
    if (project) {
      sshCmd += ` --project=${project}`;
    }
    
    // Increase maxBuffer to 100MB to handle COLMAP's verbose output
    const { stdout, stderr } = await execAsync(sshCmd, { maxBuffer: 100 * 1024 * 1024 });
    
    if (stderr && !stderr.includes('Warning') && !stderr.includes('Updating project ssh metadata')) {
      // Only log first 1000 chars of stderr to avoid flooding console
      const truncatedStderr = stderr.length > 1000 ? stderr.substring(0, 1000) + '...' : stderr;
      console.warn('[GcpGpuWorker] Remote stderr (truncated):', truncatedStderr);
    }
    
    return stdout.trim();
  }
  
  /**
   * Upload directory to remote VM via gcloud compute scp
   */
  async uploadDirectory(localDir, remoteDir) {
    console.log(`[GcpGpuWorker] Uploading ${localDir} -> ${remoteDir}...`);
    
    const { instance, zone, project } = this.getInstanceInfo();
    let scpCmd = `gcloud compute scp --recurse "${localDir}"/* ${instance}:${remoteDir}/ --zone=${zone}`;
    if (project) {
      scpCmd += ` --project=${project}`;
    }
    await execAsync(scpCmd);
    
    console.log('[GcpGpuWorker] ✅ Upload complete');
  }
  
  /**
   * Upload a single file to remote VM via gcloud compute scp
   */
  async uploadFile(localPath, remotePath) {
    console.log(`[GcpGpuWorker] Uploading file ${localPath} -> ${remotePath}...`);
    
    const { instance, zone, project } = this.getInstanceInfo();
    let scpCmd = `gcloud compute scp "${localPath}" ${instance}:${remotePath} --zone=${zone}`;
    if (project) {
      scpCmd += ` --project=${project}`;
    }
    await execAsync(scpCmd);
    
    console.log('[GcpGpuWorker] ✅ File upload complete');
  }
  
  /**
   * Download file from remote VM via gcloud compute scp
   */
  async downloadFile(remotePath, localPath) {
    console.log(`[GcpGpuWorker] Downloading ${remotePath} -> ${localPath}...`);
    
    const { instance, zone, project } = this.getInstanceInfo();
    let scpCmd = `gcloud compute scp ${instance}:${remotePath} "${localPath}" --zone=${zone}`;
    if (project) {
      scpCmd += ` --project=${project}`;
    }
    await execAsync(scpCmd);
    
    console.log('[GcpGpuWorker] ✅ Download complete');
  }
  
  /**
   * Run OpenMVS retexturing with edited images.
   * This is for the multi-view renovation pipeline.
   * 
   * @param {string} localInputDir - Directory with edited images + camera data
   * @param {string} meshPath - Path to the mesh file (OBJ or PLY)
   * @returns {Object} Result with texturedMeshUrl and textureUrl
   */
  async runRetexturing(localInputDir, meshPath) {
    if (!this.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }
    
    console.log('[GcpGpuWorker] Starting OpenMVS retexturing pipeline...');
    const startTime = Date.now();
    
    try {
      // 1. Ensure VM is running
      const isReady = await this.isAvailable();
      if (!isReady) {
        await this.startVM();
      }
      
      // 2. Create remote directories
      const jobId = `retexture-${Date.now()}`;
      const remoteInputDir = `${this.processingDir}/${jobId}`;
      const remoteOutputDir = `${this.processingDir}/${jobId}-output`;
      
      // OpenMVS InterfaceCOLMAP expects files in 'sparse/' directly (not 'sparse/0/')
      await this.execRemote(`mkdir -p ${remoteInputDir}/images ${remoteInputDir}/sparse ${remoteOutputDir}`);
      
      // 3. Upload edited images
      console.log('[GcpGpuWorker] Uploading edited images...');
      await this.uploadDirectory(path.join(localInputDir, 'images'), `${remoteInputDir}/images`);
      
      // 4. Upload camera data (sparse reconstruction)
      console.log('[GcpGpuWorker] Uploading camera data...');
      await this.uploadDirectory(path.join(localInputDir, 'sparse'), `${remoteInputDir}/sparse`);
      
      // 5. Upload mesh file
      console.log('[GcpGpuWorker] Uploading mesh...');
      const remoteMeshPath = `${remoteInputDir}/input_mesh.obj`;
      await this.uploadFile(meshPath, remoteMeshPath);
      
      // 6. Run OpenMVS retexturing script
      console.log('[GcpGpuWorker] Running OpenMVS TextureMesh...');
      const retextureScript = `
import subprocess
import sys
from pathlib import Path
import json
import glob
import os

input_dir = Path("${remoteInputDir}")
output_dir = Path("${remoteOutputDir}")
mesh_path = Path("${remoteMeshPath}")

result = {"success": False}

try:
    # STEP 0: Convert PNG images to JPG (OpenMVS TextureMesh has issues with PNG)
    print("[Retexture] Converting PNG images to JPG for OpenMVS compatibility...")
    images_dir = input_dir / 'images'
    sparse_dir = input_dir / 'sparse'
    
    png_files = list(images_dir.glob("*.png"))
    if png_files:
        print(f"[Retexture] Found {len(png_files)} PNG files to convert")
        try:
            from PIL import Image
            for png_path in png_files:
                jpg_path = png_path.with_suffix('.jpg')
                print(f"[Retexture]   Converting {png_path.name} -> {jpg_path.name}")
                img = Image.open(png_path)
                # Convert to RGB if necessary (PNG might have alpha channel)
                if img.mode in ('RGBA', 'LA', 'P'):
                    img = img.convert('RGB')
                img.save(jpg_path, 'JPEG', quality=95)
                # Remove PNG after conversion
                png_path.unlink()
            print(f"[Retexture] ✅ Converted all PNG to JPG")
        except ImportError:
            # Fallback to ImageMagick if PIL not available
            print("[Retexture] PIL not available, using ImageMagick...")
            for png_path in png_files:
                jpg_path = png_path.with_suffix('.jpg')
                subprocess.run(['convert', str(png_path), '-quality', '95', str(jpg_path)], check=True)
                png_path.unlink()
            print(f"[Retexture] ✅ Converted using ImageMagick")
    
    # Update images.txt to use .jpg extension
    images_txt = sparse_dir / 'images.txt'
    if images_txt.exists():
        content = images_txt.read_text()
        if '.png' in content:
            print("[Retexture] Updating images.txt to use .jpg extension...")
            content = content.replace('.png', '.jpg')
            images_txt.write_text(content)
            print("[Retexture] ✅ Updated images.txt")
    
    # Convert to OpenMVS format
    # CRITICAL: Use relative paths to avoid path duplication bug in OpenMVS
    # InterfaceCOLMAP stores the working directory in the MVS file
    # and TextureMesh prepends it when loading images
    scene_mvs = output_dir / "scene.mvs"
    
    print("[Retexture] Converting to OpenMVS format...")
    # Run from input_dir so relative paths work correctly
    subprocess.run([
        'InterfaceCOLMAP',
        '-i', '.',  # Current directory (input_dir)
        '-o', str(scene_mvs),  # Output to separate directory
        '--image-folder', 'images',  # Relative path
    ], check=True, cwd=str(input_dir))  # CRITICAL: Run from input_dir
    
    # Run TextureMesh directly with the external mesh
    # TextureMesh outputs to the same directory as input MVS with suffix _texture
    # So scene.mvs will produce scene_texture.obj
    textured_output = output_dir / "textured_mesh.mvs"
    print("[Retexture] Running TextureMesh with external mesh...")
    subprocess.run([
        'TextureMesh',
        str(scene_mvs),
        '--mesh-file', str(mesh_path),
        '-o', str(textured_output),  # Explicitly set output path
        '--export-type', 'obj',
        '--resolution-level', '0',  # Highest quality
        '--cost-smoothness-ratio', '0.1',
    ], check=True)
    
    # Check outputs - TextureMesh creates <output_basename>.obj
    print("[Retexture] Looking for output files...")
    print(f"[Retexture] Output dir contents: {list(output_dir.iterdir())}")
    
    # Find the OBJ file - OpenMVS may use different naming conventions
    obj_candidates = list(output_dir.glob("*.obj"))
    print(f"[Retexture] Found OBJ candidates: {obj_candidates}")
    
    textured_obj = None
    for obj in obj_candidates:
        if 'input_mesh' not in obj.name:  # Skip the original input mesh
            textured_obj = obj
            break
    
    if textured_obj and textured_obj.exists():
        result["success"] = True
        result["textured_mesh_path"] = str(textured_obj)
        
        # Find texture file - look for any image with _material or _map_Kd in name
        textures = list(output_dir.glob("*_material*_map_Kd*"))
        if not textures:
            textures = list(output_dir.glob("*_texture*"))
        if not textures:
            textures = list(output_dir.glob("*.jpg")) + list(output_dir.glob("*.png"))
        
        print(f"[Retexture] Found texture candidates: {textures}")
        
        if textures:
            result["texture_path"] = str(textures[0])
            print(f"[Retexture] Using texture: {textures[0]}")
        else:
            print("[Retexture] WARNING: No texture file found!")
        
        print("[Retexture] ✅ Complete!")
    else:
        all_files = list(output_dir.iterdir())
        result["error"] = f"TextureMesh did not produce OBJ output. Files found: {all_files}"
        
except Exception as e:
    result["error"] = str(e)
    import traceback
    print(f"[Retexture] Error: {e}")
    traceback.print_exc()

print("RESULT_JSON:" + json.dumps(result))
`;
      
      // Execute the script
      const scriptPath = `${remoteInputDir}/retexture_script.py`;
      await this.execRemote(`cat > ${scriptPath} << 'SCRIPT_EOF'\n${retextureScript}\nSCRIPT_EOF`);
      
      const output = await this.execRemote(`cd ${remoteInputDir} && /opt/photogrammetry-venv/bin/python3 ${scriptPath} 2>&1`);
      console.log('[GcpGpuWorker] Script output:', output);
      
      // Parse result
      const resultMatch = output.match(/RESULT_JSON:(\{.*\})/);
      if (!resultMatch) {
        console.error('[GcpGpuWorker] Script output did not contain RESULT_JSON:', output);
        throw new Error('Failed to parse retexturing result');
      }
      
      const result = JSON.parse(resultMatch[1]);
      console.log('[GcpGpuWorker] Parsed result:', result);
      
      if (!result.success) {
        throw new Error(result.error || 'Retexturing failed');
      }
      
      // 7. Download results to public directory for browser access
      console.log('[GcpGpuWorker] Downloading retextured mesh...');
      console.log('[GcpGpuWorker] Remote mesh path:', result.textured_mesh_path);
      console.log('[GcpGpuWorker] Remote texture path:', result.texture_path);
      
      const publicDir = path.join(process.cwd(), 'public', 'retextured');
      await fs.mkdir(publicDir, { recursive: true });
      
      // Generate unique filenames
      const timestamp = Date.now();
      const meshFileName = `textured_mesh_${timestamp}.obj`;
      const localMeshPath = path.join(publicDir, meshFileName);
      await this.downloadFile(result.textured_mesh_path, localMeshPath);
      console.log('[GcpGpuWorker] ✅ Downloaded mesh to:', localMeshPath);
      
      // Download texture - CRITICAL for proper texturing!
      let textureFileName = null;
      let localTexturePath = null;
      if (result.texture_path) {
        const textureExt = path.extname(result.texture_path) || '.jpg';
        textureFileName = `texture_${timestamp}${textureExt}`;
        localTexturePath = path.join(publicDir, textureFileName);
        await this.downloadFile(result.texture_path, localTexturePath);
        console.log('[GcpGpuWorker] ✅ Downloaded texture to:', localTexturePath);
      } else {
        console.error('[GcpGpuWorker] ❌ No texture path in result! Mesh will appear untextured.');
      }
      
      // Download MTL
      const mtlFileName = `textured_mesh_${timestamp}.mtl`;
      const remoteMtlPath = result.textured_mesh_path.replace('.obj', '.mtl');
      try {
        const localMtlPath = path.join(publicDir, mtlFileName);
        await this.downloadFile(remoteMtlPath, localMtlPath);
        console.log('[GcpGpuWorker] ✅ Downloaded MTL to:', localMtlPath);
        
        // Update MTL to reference the correct texture filename
        if (textureFileName) {
          const mtlContent = await fs.readFile(localMtlPath, 'utf8');
          const updatedMtl = mtlContent.replace(/map_Kd\s+.+/g, `map_Kd ${textureFileName}`);
          await fs.writeFile(localMtlPath, updatedMtl, 'utf8');
          console.log('[GcpGpuWorker] ✅ Updated MTL to reference:', textureFileName);
        }
        
        // Update OBJ to reference the correct MTL filename
        const objContent = await fs.readFile(localMeshPath, 'utf8');
        const updatedObj = objContent.replace(/mtllib\s+.+/g, `mtllib ${mtlFileName}`);
        await fs.writeFile(localMeshPath, updatedObj, 'utf8');
      } catch (e) {
        console.warn('[GcpGpuWorker] No MTL file:', e.message);
      }
      
      // Verify we actually have the texture file locally before cleanup
      if (textureFileName) {
        const textureExists = await fs.access(path.join(publicDir, textureFileName)).then(() => true).catch(() => false);
        if (!textureExists) {
          console.error('[GcpGpuWorker] ❌ Texture file was not downloaded successfully!');
        } else {
          console.log('[GcpGpuWorker] ✅ Texture file verified on disk');
        }
      }
      
      // 8. Cleanup remote (keep for debugging if there were issues)
      // await this.execRemote(`rm -rf ${remoteInputDir} ${remoteOutputDir}`);
      console.log('[GcpGpuWorker] Skipping remote cleanup for debugging - files remain at:', remoteInputDir, remoteOutputDir);
      
      const processingTimeMs = Date.now() - startTime;
      console.log(`[GcpGpuWorker] ✅ Retexturing complete in ${(processingTimeMs / 1000).toFixed(1)}s`);
      
      // Return public URLs accessible from browser
      return {
        texturedMeshUrl: `/retextured/${meshFileName}`,
        textureUrl: textureFileName ? `/retextured/${textureFileName}` : null,
        processingTimeMs,
      };
      
    } catch (error) {
      console.error('[GcpGpuWorker] Retexturing failed:', error);
      throw error;
    }
  }
  
  /**
   * Stop the GPU VM to save costs
   */
  async stopVM() {
    if (!this.enabled) return;
    
    console.log('[GcpGpuWorker] Stopping GPU VM...');
    
    try {
      const { instance, zone, project } = this.getInstanceInfo();
      
      let stopCmd = `gcloud compute instances stop ${instance} --zone=${zone}`;
      if (project) {
        stopCmd += ` --project=${project}`;
      }
      await execAsync(stopCmd);
      console.log('[GcpGpuWorker] ✅ GPU VM stopped');
    } catch (error) {
      console.error('[GcpGpuWorker] Failed to stop VM:', error.message);
    }
  }
  
  /**
   * Check for completed jobs on VM that weren't downloaded
   * This is a recovery mechanism for jobs that completed after timeout/disconnect
   * 
   * @returns {Array} List of completed job IDs with their output directories
   */
  async listCompletedJobs() {
    if (!this.enabled) return [];
    
    try {
      const isReady = await this.isAvailable();
      if (!isReady) {
        console.log('[GcpGpuWorker] VM not running, cannot list jobs');
        return [];
      }
      
      // Find all status.json files that indicate completed jobs
      const findCmd = `find ${this.processingDir} -name "status.json" -exec cat {} \\; -print 2>/dev/null || true`;
      const result = await this.execRemote(findCmd);
      
      const jobs = [];
      const lines = result.split('\n').filter(l => l.trim());
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.includes('"done":true')) {
          // Next line should be the path
          if (i + 1 < lines.length) {
            const statusPath = lines[i + 1];
            const outputDir = statusPath.replace('/status.json', '');
            const jobId = outputDir.split('-').pop();
            
            // Check if result files exist
            const checkCmd = `ls ${outputDir}/fused.ply ${outputDir}/textured_mesh.obj 2>/dev/null | wc -l`;
            const fileCount = parseInt(await this.execRemote(checkCmd));
            
            if (fileCount >= 1) {
              jobs.push({
                jobId,
                outputDir,
                hasResult: true,
              });
            }
          }
        }
      }
      
      console.log(`[GcpGpuWorker] Found ${jobs.length} completed jobs on VM`);
      return jobs;
    } catch (error) {
      console.error('[GcpGpuWorker] Error listing completed jobs:', error.message);
      return [];
    }
  }
  
  /**
   * Recover a completed job by downloading its results
   * 
   * @param {string} remoteOutputDir - Remote output directory path
   * @param {string} localOutputDir - Local destination directory
   * @returns {Object} Result with paths to downloaded files
   */
  async recoverJob(remoteOutputDir, localOutputDir) {
    if (!this.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }
    
    console.log(`[GcpGpuWorker] Recovering job from ${remoteOutputDir}...`);
    
    try {
      // Ensure VM is running
      const isReady = await this.isAvailable();
      if (!isReady) {
        await this.startVM();
      }
      
      // Create local output directory
      await execAsync(`mkdir -p "${localOutputDir}"`);
      
      // Read the pipeline log to extract result JSON
      const logFile = `${remoteOutputDir}/pipeline.log`;
      const logContent = await this.execRemote(`tail -100 ${logFile} 2>/dev/null || echo ""`);
      
      // Extract result JSON from log
      const jsonMatch = logContent.match(/\{[^{}]*"success"[^{}]*\}(?!.*\{[^{}]*"success")/s);
      if (!jsonMatch) {
        throw new Error('Could not find result JSON in pipeline log');
      }
      
      const resultData = JSON.parse(jsonMatch[0]);
      if (!resultData.success) {
        throw new Error(`Job failed: ${resultData.error}`);
      }
      
      console.log('[GcpGpuWorker] Found completed job result, downloading files...');
      
      // Download all result files
      const downloads = [];
      
      // Dense point cloud
      if (resultData.dense_path) {
        downloads.push({
          remote: resultData.dense_path,
          local: path.join(localOutputDir, 'fused.ply'),
        });
      }
      
      // Sparse point cloud
      if (resultData.sparse_path) {
        downloads.push({
          remote: resultData.sparse_path,
          local: path.join(localOutputDir, 'sparse.ply'),
        });
      }
      
      // Textured mesh
      if (resultData.textured_mesh_path) {
        downloads.push({
          remote: resultData.textured_mesh_path,
          local: path.join(localOutputDir, 'textured_mesh.obj'),
        });
        
        // MTL file
        const mtlPath = resultData.textured_mesh_path.replace('.obj', '.mtl');
        downloads.push({
          remote: mtlPath,
          local: path.join(localOutputDir, 'textured_mesh.mtl'),
        });
        
        // Texture files
        const meshDir = resultData.textured_mesh_path.replace('/textured_mesh.obj', '');
        try {
          const textures = await this.execRemote(`ls ${meshDir}/*.jpg ${meshDir}/*.png 2>/dev/null || true`);
          for (const texFile of textures.trim().split('\n').filter(f => f)) {
            const texName = texFile.split('/').pop();
            downloads.push({
              remote: texFile,
              local: path.join(localOutputDir, texName),
            });
          }
        } catch (e) {
          // Ignore texture listing errors
        }
      }
      
      // Download all files
      for (const dl of downloads) {
        try {
          await this.downloadFile(dl.remote, dl.local);
          console.log(`[GcpGpuWorker] Downloaded: ${dl.local}`);
        } catch (e) {
          console.warn(`[GcpGpuWorker] Could not download ${dl.remote}: ${e.message}`);
        }
      }
      
      // Download sparse model directory
      if (resultData.sparse_model_dir) {
        const jobId = Date.now();
        const sparseModelLocal = path.join(localOutputDir, 'sparse', '0');
        await execAsync(`mkdir -p "${sparseModelLocal}"`);
        await this.execRemote(`cd ${resultData.sparse_model_dir} && tar -czf /tmp/sparse-${jobId}.tar.gz .`);
        await this.downloadFile(`/tmp/sparse-${jobId}.tar.gz`, path.join(localOutputDir, 'sparse.tar.gz'));
        await execAsync(`cd "${sparseModelLocal}" && tar -xzf "${path.join(localOutputDir, 'sparse.tar.gz')}"`);
        await this.execRemote(`rm /tmp/sparse-${jobId}.tar.gz`);
      }
      
      console.log('[GcpGpuWorker] ✅ Job recovery complete');
      
      return {
        num_sparse_points: resultData.num_sparse_points,
        num_dense_points: resultData.num_dense_points,
        sparse_path: path.join(localOutputDir, 'sparse.ply'),
        dense_path: path.join(localOutputDir, 'fused.ply'),
        sparse_model_dir: path.join(localOutputDir, 'sparse', '0'),
        textured_mesh_path: resultData.textured_mesh_path ? path.join(localOutputDir, 'textured_mesh.obj') : null,
        method: 'colmap_full_gpu_recovered',
        recovered: true,
      };
      
    } catch (error) {
      console.error('[GcpGpuWorker] Job recovery failed:', error);
      throw error;
    }
  }
  
  /**
   * Ensure V2 pipeline dependencies are installed on VM
   */
  async ensureV2DependenciesInstalled() {
    console.log('[GcpGpuWorker] Checking V2 pipeline dependencies...');
    
    // Check if V2 is already set up (check for all critical packages)
    try {
      const result = await this.execRemote(
        '/opt/photogrammetry-venv/bin/python3 -c "import open3d; import torch; import transformers; print(\'deps ok\')" 2>&1'
      );
      if (result.includes('deps ok')) {
        console.log('[GcpGpuWorker] V2 dependencies already installed');
        return true;
      }
    } catch (e) {
      console.log('[GcpGpuWorker] Installing V2 dependencies...');
    }
    
    // Install V2 dependencies (Depth Anything v2 via transformers, Open3D for TSDF)
    // Use venv pip for Ubuntu 24.04 PEP 668 compliance
    const installCmd = `
      /opt/photogrammetry-venv/bin/pip3 install --quiet open3d trimesh scipy pillow 2>&1 || true
      /opt/photogrammetry-venv/bin/pip3 install --quiet torch torchvision 2>&1 || true
      /opt/photogrammetry-venv/bin/pip3 install --quiet transformers accelerate 2>&1 || true
      echo "V2 dependencies installed"
    `;
    
    await this.execRemote(installCmd);
    console.log('[GcpGpuWorker] V2 dependencies installed');
    return true;
  }
  
  /**
   * Upload V2 pipeline code to VM (self-contained gcp_v2_pipeline.py)
   */
  async uploadV2Pipeline() {
    console.log('[GcpGpuWorker] Uploading V2 pipeline code...');
    
    // Use the self-contained GCP V2 pipeline script (no circular imports)
    // Decode URL-encoded path (handles spaces in directory names)
    const scriptDir = path.join(decodeURIComponent(path.dirname(new URL(import.meta.url).pathname)), '../scripts');
    const remoteV2Dir = '/opt/photogrammetry-service';
    
    // Upload the self-contained V2 pipeline script to user home first (avoids permission issues)
    const localV2Script = path.join(scriptDir, 'gcp_v2_pipeline.py');
    const tempRemotePath = `/home/${this.user}/gcp_v2_pipeline.py`;
    const finalRemotePath = `${remoteV2Dir}/gcp_v2_pipeline.py`;
    
    console.log(`[GcpGpuWorker] Uploading file ${localV2Script} -> ${tempRemotePath}...`);
    await this.uploadFile(localV2Script, tempRemotePath);
    
    // Move to final location with sudo
    console.log(`[GcpGpuWorker] Moving to ${finalRemotePath} with sudo...`);
    await this.execRemote(`sudo mkdir -p ${remoteV2Dir} && sudo mv ${tempRemotePath} ${finalRemotePath} && sudo chmod 755 ${finalRemotePath}`);
    console.log('[GcpGpuWorker] V2 pipeline script uploaded');
    
    return remoteV2Dir;
  }

  /**
   * Upload hybrid pipeline wrapper and optional room-tour splat script to VM.
   */
  async uploadHybridPipeline() {
    console.log('[GcpGpuWorker] Uploading hybrid pipeline code...');

    const remoteV2Dir = await this.uploadV2Pipeline();
    const scriptDir = path.join(decodeURIComponent(path.dirname(new URL(import.meta.url).pathname)), '../scripts');
    const uploads = [
      {
        localPath: path.join(scriptDir, 'gcp_hybrid_pipeline.py'),
        tempRemotePath: `/home/${this.user}/gcp_hybrid_pipeline.py`,
        finalRemotePath: `${remoteV2Dir}/gcp_hybrid_pipeline.py`,
      },
      {
        localPath: path.join(scriptDir, 'room_tour', 'process_room_tour.py'),
        tempRemotePath: `/home/${this.user}/process_room_tour.py`,
        finalRemotePath: `${remoteV2Dir}/process_room_tour.py`,
      },
    ];

    for (const upload of uploads) {
      console.log(`[GcpGpuWorker] Uploading file ${upload.localPath} -> ${upload.tempRemotePath}...`);
      await this.uploadFile(upload.localPath, upload.tempRemotePath);
      await this.execRemote(
        `sudo mkdir -p ${remoteV2Dir} && sudo mv ${upload.tempRemotePath} ${upload.finalRemotePath} && sudo chmod 755 ${upload.finalRemotePath}`
      );
    }

    console.log('[GcpGpuWorker] Hybrid pipeline scripts uploaded');
    return remoteV2Dir;
  }

  /**
   * Ensure hybrid pipeline dependencies are installed on VM.
   * Geometry uses the V2 environment. Splat packaging reuses room-tour runtime when present.
   */
  async ensureHybridDependenciesInstalled() {
    await this.ensureV2DependenciesInstalled();

    try {
      const roomTourRuntime = await this.execRemote('[ -x /opt/room-tour-venv/bin/python3 ] && echo ready || echo missing');
      console.log(`[GcpGpuWorker] Room-tour splat runtime: ${roomTourRuntime.trim()}`);
    } catch (error) {
      console.warn('[GcpGpuWorker] Could not verify room-tour runtime:', error.message);
    }

    return true;
  }

  /**
   * Process hybrid photogrammetry pipeline on GPU VM.
   * Geometry stays authoritative via V2. Splat artifacts are added when the room-tour runtime is available.
   */
  async processHybridPipeline(localImagesDir, localOutputDir, options = {}, progressCallback = null) {
    if (!this.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }

    console.log('[GcpGpuWorker] Starting hybrid pipeline on GPU VM (mesh + optional splats)');

    try {
      if (progressCallback) progressCallback('Starting GPU VM...');
      const isReady = await this.isAvailable();
      if (!isReady) {
        await this.startVM();
      }

      if (progressCallback) progressCallback('Setting up hybrid pipeline...');
      await this.ensureHybridDependenciesInstalled();
      const remoteHybridDir = await this.uploadHybridPipeline();

      if (progressCallback) progressCallback('Preparing remote workspace...');
      const jobId = options.jobId || Date.now().toString();
      const remoteImagesDir = `${this.processingDir}/hybrid-images-${jobId}`;
      const remoteOutputDir = `${this.processingDir}/hybrid-output-${jobId}`;
      await this.execRemote(`mkdir -p ${remoteImagesDir} ${remoteOutputDir}`);

      if (progressCallback) progressCallback('Uploading images to GPU VM...');
      await this.uploadDirectory(localImagesDir, remoteImagesDir);

      if (progressCallback) progressCallback('Running hybrid pipeline (mesh + splat packaging)...');
      const logFile = `${remoteOutputDir}/pipeline_hybrid.log`;
      const statusFile = `${remoteOutputDir}/status.json`;
      const resultFile = `${remoteOutputDir}/remote-processing.json`;

      const requestedCudaDevices = options.cudaVisibleDevices || process.env.HYBRID_PIPELINE_CUDA_VISIBLE_DEVICES || '0,1';
      const requestedGpuCount = options.gpuCount || 2;

      let pipelineCmd = `CUDA_VISIBLE_DEVICES=${requestedCudaDevices} /opt/photogrammetry-venv/bin/python3 ${remoteHybridDir}/gcp_hybrid_pipeline.py ${remoteImagesDir} ${remoteOutputDir}`;
      pipelineCmd += ` --job-id ${jobId}`;
      pipelineCmd += ` --gpu-count ${requestedGpuCount}`;

      if (options.metric3dModel) {
        pipelineCmd += ` --metric3d-model ${options.metric3dModel}`;
      }
      if (options.voxelSize) {
        pipelineCmd += ` --voxel-size ${options.voxelSize}`;
      }
      if (options.noGpu) {
        pipelineCmd += ' --no-gpu';
      }
      if (options.gsplatIterations) {
        pipelineCmd += ` --gsplat-iterations ${options.gsplatIterations}`;
      }
      if (options.skipRoomTourSplat) {
        pipelineCmd += ' --skip-room-tour-splat';
      }

      await this.execRemote(
        `nohup ${pipelineCmd} > ${logFile} 2>&1 && echo '{"done":true,"success":true}' > ${statusFile} || echo '{"done":true,"success":false,"error":"Hybrid pipeline failed"}' > ${statusFile} &`
      );

      console.log('[GcpGpuWorker] Hybrid pipeline started, polling for completion...');
      const maxWaitMs = 8 * 60 * 60 * 1000;
      const startTime = Date.now();
      let result = null;

      while (Date.now() - startTime < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, 15000));

        try {
          const status = await this.execRemote(`cat ${statusFile} 2>/dev/null || echo "{}"`);
          const statusData = JSON.parse(status);

          if (statusData.done) {
            if (!statusData.success) {
              throw new Error(statusData.error || 'Hybrid pipeline failed');
            }

            const resultJson = await this.execRemote(`cat ${resultFile} 2>/dev/null || echo "{}"`);
            result = JSON.parse(resultJson);
            break;
          }

          const logLines = await this.execRemote(`tail -5 ${logFile} 2>/dev/null || echo ""`);
          if (logLines.trim()) {
            console.log(`[GcpGpuWorker] Hybrid progress: ${logLines.split('\n')[0].substring(0, 80)}`);
          }
        } catch (error) {
          // Status file not ready yet, continue polling.
        }
      }

      if (!result || !result.success) {
        throw new Error(result?.error || 'Hybrid pipeline timed out after 8 hours');
      }

      if (progressCallback) progressCallback('Downloading hybrid results...');
      await execAsync(`mkdir -p "${localOutputDir}" "${path.join(localOutputDir, 'hybrid')}"`);

      const meshDir = `${remoteOutputDir}/mesh`;
      const meshFiles = ['scaled.ply', 'cleaned.ply', 'raw.ply', 'textured.obj', 'textured.mtl'];
      for (const meshFile of meshFiles) {
        try {
          await this.downloadFile(`${meshDir}/${meshFile}`, path.join(localOutputDir, meshFile));
        } catch (error) {
          // Mesh outputs are optional by filename.
        }
      }

      try {
        const textures = await this.execRemote(`ls ${meshDir}/*.jpg ${meshDir}/*.jpeg ${meshDir}/*.png 2>/dev/null || true`);
        for (const tex of textures.trim().split('\n').filter(Boolean)) {
          const texName = tex.split('/').pop();
          await this.downloadFile(tex, path.join(localOutputDir, texName));
        }
      } catch (error) {
        // No textures produced.
      }

      for (const artifact of ['measurements.json', 'pipeline_stats.json', 'remote-processing.json', 'hybrid_manifest.json']) {
        try {
          await this.downloadFile(`${remoteOutputDir}/${artifact}`, path.join(localOutputDir, artifact));
        } catch (error) {
          // Optional artifact.
        }
      }

      const hybridLocalDir = path.join(localOutputDir, 'hybrid');
      for (const artifact of ['scene.splat', 'scene.ksplat', 'scene.ply', 'fused_scene.ply', 'mesh.glb', 'hybrid_manifest.json']) {
        try {
          await this.downloadFile(`${remoteOutputDir}/hybrid/${artifact}`, path.join(hybridLocalDir, artifact));
        } catch (error) {
          // Optional hybrid artifact.
        }
      }

      try {
        await this.execRemote(`if [ -d ${remoteOutputDir}/hybrid/viewer ]; then cd ${remoteOutputDir}/hybrid && tar -czf /tmp/hybrid-viewer-${jobId}.tar.gz viewer; fi`);
        await this.downloadFile(`/tmp/hybrid-viewer-${jobId}.tar.gz`, path.join(localOutputDir, 'hybrid-viewer.tar.gz'));
        await execAsync(`mkdir -p "${path.join(hybridLocalDir, 'viewer')}" && tar -xzf "${path.join(localOutputDir, 'hybrid-viewer.tar.gz')}" -C "${hybridLocalDir}"`);
      } catch (error) {
        console.log('[GcpGpuWorker] No hybrid viewer bundle to download');
      }

      const sparseModelLocal = path.join(localOutputDir, 'sparse', '0');
      await execAsync(`mkdir -p "${sparseModelLocal}"`);
      try {
        await this.execRemote(`cd ${remoteOutputDir}/sparse/0 && tar -czf /tmp/sparse-hybrid-${jobId}.tar.gz .`);
        await this.downloadFile(`/tmp/sparse-hybrid-${jobId}.tar.gz`, path.join(localOutputDir, 'sparse.tar.gz'));
        await execAsync(`cd "${sparseModelLocal}" && tar -xzf "${path.join(localOutputDir, 'sparse.tar.gz')}"`);
      } catch (error) {
        console.warn('[GcpGpuWorker] Could not download hybrid sparse model:', error.message);
      }

      if (progressCallback) progressCallback('Cleaning up...');
      await this.execRemote(`rm -rf ${remoteImagesDir} ${remoteOutputDir} /tmp/sparse-hybrid-${jobId}.tar.gz /tmp/hybrid-viewer-${jobId}.tar.gz 2>/dev/null || true`);

      let meshPath = null;
      for (const meshFile of ['textured.obj', 'scaled.ply', 'cleaned.ply', 'raw.ply']) {
        const localMesh = path.join(localOutputDir, meshFile);
        try {
          await fs.access(localMesh);
          meshPath = localMesh;
          break;
        } catch (error) {
          // Try next mesh candidate.
        }
      }

      return {
        success: true,
        mesh_path: meshPath,
        measurements_path: path.join(localOutputDir, 'measurements.json'),
        stats_path: path.join(localOutputDir, 'pipeline_stats.json'),
        sparse_model_dir: sparseModelLocal,
        hybrid_manifest_path: path.join(localOutputDir, 'hybrid_manifest.json'),
        viewer_path: path.join(localOutputDir, 'hybrid', 'viewer', 'index.html'),
        splat_scene_path: path.join(localOutputDir, 'hybrid', 'scene.splat'),
        method: 'hybrid_mesh_gaussian_v1',
        used_room_tour_splat: Boolean(result.used_room_tour_splat),
        fallback_reason: result.fallback_reason || null,
      };
    } catch (error) {
      console.error('[GcpGpuWorker] Hybrid pipeline failed:', error);
      throw error;
    }
  }
  
  /**
   * Process V2 pipeline on GPU VM (SfM + Metric3D + TSDF + SAM2)
   * 
   * Full pipeline includes:
   * 1. GLOMAP/SuperPoint/LightGlue SfM
   * 2. COLMAP MVS dense reconstruction  
   * 3. Metric3D depth estimation (replaces Depth Anything)
   * 4. Depth fusion (MVS + Metric3D)
   * 5. TSDF volumetric reconstruction
   * 6. Mesh cleaning and texturing
   * 7. Optional: SAM2 segmentation + measurements
   * 
   * @param {string} localImagesDir - Local directory with images
   * @param {string} localOutputDir - Local directory for output
   * @param {Object} options - Pipeline options
   * @returns {Object} Result with mesh path, measurements, stats
   */
  async processV2Pipeline(localImagesDir, localOutputDir, options = {}, progressCallback = null) {
    if (!this.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }
    
    console.log('[GcpGpuWorker] Starting V2 pipeline on GPU VM (Metric3D + TSDF)');
    
    try {
      // 1. Ensure VM is running
      if (progressCallback) progressCallback('Starting GPU VM...');
      const isReady = await this.isAvailable();
      if (!isReady) {
        await this.startVM();
      }
      
      // 2. Ensure V2 dependencies and code are available
      if (progressCallback) progressCallback('Setting up V2 pipeline...');
      await this.ensureV2DependenciesInstalled();
      const remoteV2Dir = await this.uploadV2Pipeline();
      
      // 3. Create remote directories
      if (progressCallback) progressCallback('Preparing remote workspace...');
      const jobId = Date.now().toString();
      const remoteImagesDir = `${this.processingDir}/v2-images-${jobId}`;
      const remoteOutputDir = `${this.processingDir}/v2-output-${jobId}`;
      
      await this.execRemote(`mkdir -p ${remoteImagesDir} ${remoteOutputDir}`);
      
      // 4. Upload images
      if (progressCallback) progressCallback('Uploading images to GPU VM...');
      await this.uploadDirectory(localImagesDir, remoteImagesDir);
      
      // 5. Run V2 pipeline with nohup (using gcp_v2_pipeline.py)
      if (progressCallback) progressCallback('Running V2 pipeline (Metric3D + TSDF)...');
      const logFile = `${remoteOutputDir}/pipeline_v2.log`;
      const statusFile = `${remoteOutputDir}/status.json`;
      
      // Build command with options - uses gcp_v2_pipeline.py (self-contained)
      let pipelineCmd = `/opt/photogrammetry-venv/bin/python3 ${remoteV2Dir}/gcp_v2_pipeline.py ${remoteImagesDir} ${remoteOutputDir}`;
      if (options.arPoses) {
        // Upload AR poses first
        const remoteArPoses = `${remoteOutputDir}/ar_poses.json`;
        await this.execRemote(`echo '${JSON.stringify(options.arPoses)}' > ${remoteArPoses}`);
        pipelineCmd += ` --ar-poses ${remoteArPoses}`;
      }
      if (options.metric3dModel) {
        pipelineCmd += ` --metric3d-model ${options.metric3dModel}`;
      }
      if (options.voxelSize) {
        pipelineCmd += ` --voxel-size ${options.voxelSize}`;
      }
      if (options.skipSegmentation) {
        pipelineCmd += ' --skip-segmentation';
      }
      
      // Start pipeline in background
      await this.execRemote(
        `nohup ${pipelineCmd} > ${logFile} 2>&1 && echo '{"done":true,"success":true}' > ${statusFile} || echo '{"done":true,"success":false,"error":"Pipeline failed"}' > ${statusFile} &`
      );
      
      // 6. Poll for completion (V2 may take longer due to Metric3D)
      console.log('[GcpGpuWorker] V2 pipeline started, polling for completion...');
      const maxWaitMs = 6 * 60 * 60 * 1000; // 6 hours for V2
      const startTime = Date.now();
      
      let result = null;
      while (Date.now() - startTime < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, 15000)); // Check every 15s
        
        try {
          const status = await this.execRemote(`cat ${statusFile} 2>/dev/null || echo "{}"`);
          const statusData = JSON.parse(status);
          
          if (statusData.done) {
            // Check for result in log
            const logTail = await this.execRemote(`tail -100 ${logFile} 2>/dev/null`);
            
            // Look for final result JSON
            const resultMatch = logTail.match(/\{"success":\s*true[^}]+\}/g);
            if (resultMatch) {
              result = JSON.parse(resultMatch[resultMatch.length - 1]);
            } else if (statusData.success) {
              result = { success: true };
            } else {
              throw new Error(statusData.error || 'V2 pipeline failed');
            }
            break;
          }
          
          // Log progress
          const logLines = await this.execRemote(`tail -5 ${logFile} 2>/dev/null || echo ""`);
          if (logLines.trim()) {
            console.log(`[GcpGpuWorker] V2 progress: ${logLines.split('\\n')[0].substring(0, 80)}`);
          }
        } catch (e) {
          // Status file not ready yet, continue polling
        }
      }
      
      if (!result) {
        throw new Error('V2 pipeline timed out after 6 hours');
      }
      
      // 7. Download results
      console.log('[GcpGpuWorker] V2 pipeline complete, downloading results...');
      if (progressCallback) progressCallback('Downloading V2 results...');
      
      await execAsync(`mkdir -p "${localOutputDir}"`);
      
      // Download mesh files
      const meshDir = `${remoteOutputDir}/mesh`;
      const meshFiles = ['scaled.ply', 'cleaned.ply', 'raw.ply', 'textured.obj', 'textured.mtl'];
      for (const meshFile of meshFiles) {
        try {
          await this.downloadFile(`${meshDir}/${meshFile}`, path.join(localOutputDir, meshFile));
          console.log(`[GcpGpuWorker] Downloaded: ${meshFile}`);
        } catch (e) {
          // Some files may not exist
        }
      }
      
      // Download textures
      try {
        const textures = await this.execRemote(`ls ${meshDir}/*.jpg ${meshDir}/*.png 2>/dev/null || true`);
        for (const tex of textures.trim().split('\n').filter(f => f)) {
          const texName = tex.split('/').pop();
          await this.downloadFile(tex, path.join(localOutputDir, texName));
        }
      } catch (e) {
        // No textures
      }
      
      // Download measurements
      try {
        await this.downloadFile(`${remoteOutputDir}/measurements.json`, path.join(localOutputDir, 'measurements.json'));
      } catch (e) {
        console.log('[GcpGpuWorker] No measurements file');
      }
      
      // Download stats
      try {
        await this.downloadFile(`${remoteOutputDir}/pipeline_stats.json`, path.join(localOutputDir, 'pipeline_stats.json'));
      } catch (e) {
        console.log('[GcpGpuWorker] No stats file');
      }
      
      // Download sparse model for camera data
      const sparseModelLocal = path.join(localOutputDir, 'sparse', '0');
      await execAsync(`mkdir -p "${sparseModelLocal}"`);
      try {
        await this.execRemote(`cd ${remoteOutputDir}/sparse/0 && tar -czf /tmp/sparse-v2-${jobId}.tar.gz .`);
        await this.downloadFile(`/tmp/sparse-v2-${jobId}.tar.gz`, path.join(localOutputDir, 'sparse.tar.gz'));
        await execAsync(`cd "${sparseModelLocal}" && tar -xzf "${path.join(localOutputDir, 'sparse.tar.gz')}"`);
      } catch (e) {
        console.warn('[GcpGpuWorker] Could not download sparse model:', e.message);
      }
      
      // 8. Cleanup
      if (progressCallback) progressCallback('Cleaning up...');
      await this.execRemote(`rm -rf ${remoteImagesDir} ${remoteOutputDir} /tmp/sparse-v2-${jobId}.tar.gz 2>/dev/null || true`);
      
      console.log('[GcpGpuWorker] ✅ V2 pipeline complete');
      
      // Determine which mesh file was created
      let meshPath = null;
      for (const meshFile of ['scaled.ply', 'cleaned.ply', 'raw.ply', 'textured.obj']) {
        const localMesh = path.join(localOutputDir, meshFile);
        try {
          await fs.access(localMesh);
          meshPath = localMesh;
          break;
        } catch (e) {
          // Try next
        }
      }
      
      return {
        success: true,
        mesh_path: meshPath,
        measurements_path: path.join(localOutputDir, 'measurements.json'),
        stats_path: path.join(localOutputDir, 'pipeline_stats.json'),
        sparse_model_dir: sparseModelLocal,
        method: 'v2_metric3d_tsdf',
      };
      
    } catch (error) {
      console.error('[GcpGpuWorker] V2 pipeline failed:', error);
      throw error;
    }
  }
}

// Singleton instance
let instance = null;

function getGcpGpuWorker() {
  if (!instance) {
    instance = new GcpGpuWorker();
  }
  return instance;
}

export { GcpGpuWorker, getGcpGpuWorker };
