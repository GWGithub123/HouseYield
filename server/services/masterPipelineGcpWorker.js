import { exec } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);
const GCLOUD_MISSING_ERROR = 'Master pipeline GCP handoff unavailable: google-cloud-cli is not installed in the local runtime.';
const LOCAL_SHELL = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
const GCLOUD_TRANSPORT = 'gcloud';
const SSH_TRANSPORT = 'ssh';
const GCLOUD_EXEC_ENV = {
  ...process.env,
  CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
};
const DEFAULT_GCLOUD_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_GCLOUD_TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_VM_START_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_VM_READY_POLL_MS = 5 * 1000;
const DEFAULT_REMOTE_STATUS_STALE_MS = 2 * 60 * 1000;
const DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS = parsePositiveInt(process.env.MASTER_V1_GCP_SSH_CONNECT_TIMEOUT_SECONDS, 20);
const DEFAULT_MIRROR_GAUSSIAN_COMMAND = process.env.MASTER_PIPELINE_MIRROR_GAUSSIAN_COMMAND
  || '/opt/master-v1-venv/bin/python3 /opt/master-v1-service/server/scripts/master_pipeline/run_mirrorgs_adapter.py --manifest {manifest_path} --result {result_path} --output-dir {output_dir} --mirrorgs-root /opt/MirrorGS --python /opt/master-v1-venv/bin/python3';
const DEFAULT_REQUIRE_MIRROR_GAUSSIAN = process.env.MASTER_PIPELINE_REQUIRE_MIRROR_GAUSSIAN === 'true';
const DEFAULT_REF_GAUSSIAN_COMMAND = process.env.MASTER_PIPELINE_REF_GAUSSIAN_COMMAND
  || '/opt/ref-gaussian-venv/bin/python3 /opt/master-v1-service/server/scripts/master_pipeline/run_refgaussian_adapter.py --manifest {manifest_path} --result {result_path} --output-dir {output_dir} --refgaussian-root /opt/ref-gaussian --python /opt/ref-gaussian-venv/bin/python3';
const DEFAULT_REQUIRE_REF_GAUSSIAN = process.env.MASTER_PIPELINE_REQUIRE_REF_GAUSSIAN === 'true';
const DEFAULT_SCAFFOLD_GS_COMMAND = process.env.MASTER_PIPELINE_SCAFFOLD_GS_COMMAND || '';
const DEFAULT_REQUIRE_SCAFFOLD_GS = process.env.MASTER_PIPELINE_REQUIRE_SCAFFOLD_GS === 'true';
const REMOTE_ARTIFACT_DIRS = [
  'masks',
  'priors',
  'sfm',
  'dense_evidence',
  'gaussian',
  'layout',
  'mesh',
  'texture',
  'appearance',
  'export',
  'logs',
];
const REMOTE_ARTIFACT_FILES = [
  ['outputs/master_pipeline_remote_status.json', 'outputs/master_pipeline_remote_status.json'],
  ['outputs/master_pipeline_remote_result.json', 'outputs/master_pipeline_remote_result.json'],
];
const DEFAULT_SEMANTIC_MASK_URL = process.env.MASTER_PIPELINE_SEMANTIC_MASK_URL
  || 'http://127.0.0.1:8010/segment-open-vocab';
const REFGAUSSIAN_ENV_PASSTHROUGH = [
  'MASTER_PIPELINE_REFGAUSSIAN_PROFILE_MODE',
  'MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIORS_MODE',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_IMAGE_COUNT',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_SPARSE_POINT_COUNT',
  'MASTER_PIPELINE_REFGAUSSIAN_LIGHT_POINTS_PER_IMAGE',
  'MASTER_PIPELINE_REFGAUSSIAN_LIGHT_MAX_ADDED_POINTS',
  'MASTER_PIPELINE_REFGAUSSIAN_LIGHT_MAX_ADDED_POINTS_CEILING',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_LIGHT_POINTS_PER_IMAGE',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_LIGHT_MAX_ADDED_POINTS',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_LIGHT_MAX_ADDED_RATIO',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_INITIAL_STAGE_ITERATIONS',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_DENSIFY_UNTIL_FRACTION',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_INDIRECT_FROM_ITER',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_DENSIFY_GRAD_THRESHOLD',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_PRUNE_OPACITY_THRESHOLD',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_PERCENT_DENSE',
  'MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_OPACITY_RESET_INTERVAL',
  'MASTER_PIPELINE_REFGAUSSIAN_SCALING_BASELINE_IMAGE_COUNT',
  'MASTER_PIPELINE_REFGAUSSIAN_SCALING_IMAGE_RANGE',
  'MASTER_PIPELINE_REFGAUSSIAN_SCALING_BASELINE_SPARSE_POINTS',
  'MASTER_PIPELINE_REFGAUSSIAN_SCALING_SPARSE_RANGE',
  'MASTER_PIPELINE_REFGAUSSIAN_BASELINE_IMAGE_COUNT',
  'MASTER_PIPELINE_REFGAUSSIAN_BASELINE_SPARSE_POINTS',
  'MASTER_PIPELINE_REFGAUSSIAN_BASELINE_INIT_POINTS',
  'MASTER_PIPELINE_REFGAUSSIAN_BASELINE_FINAL_POINTS',
  'MASTER_PIPELINE_REFGAUSSIAN_BASELINE_ITERATIONS',
  'MASTER_PIPELINE_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_PX',
  'MASTER_PIPELINE_REFGAUSSIAN_MAX_MIRROR_EXCLUSION_BAND_PX',
  'MASTER_PIPELINE_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_COVERAGE_SCALE_PX',
  'MASTER_PIPELINE_REFGAUSSIAN_REFLECTIVE_SKIP_COVERAGE_THRESHOLD',
  'MASTER_PIPELINE_REFGAUSSIAN_ITERATIONS',
  'MASTER_PIPELINE_REFGAUSSIAN_STAGED_INDOOR_ITERATIONS',
  'MASTER_PIPELINE_REFGAUSSIAN_LAMBDA_NORMAL_SMOOTH',
  'MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIOR_LOSS',
  'MASTER_PIPELINE_REFGAUSSIAN_LAMBDA_DEPTH_PRIOR',
  'MASTER_PIPELINE_REFGAUSSIAN_LAMBDA_NORMAL_PRIOR',
  'MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIOR_EXCLUSION_BAND_PX',
  'MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIOR_MAX_SIDE',
  'MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIOR_MIN_CONFIDENCE',
  'MASTER_PIPELINE_ROMA_MULTIVIEW_TRACK_CONSOLIDATION',
  'MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_PASSES',
  'MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_MAX_TRACK_SUPPORT',
  'MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_MIN_MEAN_SCORE',
  'MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_MERGE_RADIUS',
  'MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_REJECT_RADIUS',
  'MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_MIN_SHARED_IMAGES',
  'MASTER_PIPELINE_MIN_TRACK_SUPPORT_FOR_PAIRWISE_IMPORT',
];

const REFGAUSSIAN_PROFILE_ENV_DEFAULTS = {
  sfm_only_marginal_indoor: {
    MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIORS_MODE: 'light',
    MASTER_PIPELINE_ROMA_EXHAUSTIVE_IMAGE_LIMIT: '32',
    MASTER_PIPELINE_ROMA_MEDIUM_ANCHOR_COUNT: '12',
    MASTER_PIPELINE_MATCHING_REFLECTIVE_BATHROOM_DENSE_PAIRS: 'true',
    MASTER_PIPELINE_SFM_CAMERA_OUTLIER_FILTER_ENABLE: 'true',
    MASTER_PIPELINE_FAST3R_MULTIVIEW_TRACK_PROMOTION: 'false',
    MASTER_PIPELINE_FAST3R_POINTMAP_TAIL_RESCUE: 'false',
    MASTER_PIPELINE_MATCHING_REFLECTIVE_MASK_CLASSES: 'mirror,window',
    MASTER_PIPELINE_MATCHING_REFLECTIVE_MASK_MAX_COVERAGE: '0.40',
  },
};

function refGaussianProfileEnvAssignments(profileMode) {
  const normalized = String(profileMode || '').trim().toLowerCase();
  const defaults = REFGAUSSIAN_PROFILE_ENV_DEFAULTS[normalized];
  if (!defaults) {
    return [];
  }

  return Object.entries(defaults).map(([name, value]) => {
    const explicit = String(process.env[name] || '').trim();
    return `${name}=${shellEscape(explicit || value)}`;
  });
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildSshOptions(connectTimeoutSeconds = DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ChallengeResponseAuthentication=no',
    '-o', `ConnectTimeout=${Math.max(1, Number(connectTimeoutSeconds) || 20)}`,
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseGpuIndices(rawValue) {
  return String(rawValue || '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function joinGpuIndices(indices) {
  return indices.length ? indices.join(',') : '';
}

function normalizeTransport(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === SSH_TRANSPORT) {
    return SSH_TRANSPORT;
  }

  if (normalized === GCLOUD_TRANSPORT) {
    return GCLOUD_TRANSPORT;
  }

  return '';
}

function rewriteRemotePaths(value, remoteRoot, localRoot) {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteRemotePaths(entry, remoteRoot, localRoot));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteRemotePaths(entry, remoteRoot, localRoot)]),
    );
  }

  if (typeof value === 'string' && value.startsWith(remoteRoot)) {
    return path.join(localRoot, path.relative(remoteRoot, value));
  }

  return value;
}

async function rewriteJsonFilesRecursively(rootDir, remoteRoot, localRoot) {
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') {
        continue;
      }

      try {
        const raw = await fs.readFile(entryPath, 'utf8');
        const parsed = JSON.parse(raw);
        const rewritten = rewriteRemotePaths(parsed, remoteRoot, localRoot);
        await fs.writeFile(entryPath, JSON.stringify(rewritten, null, 2));
      } catch {
        // Leave non-JSON or malformed files untouched.
      }
    }
  }
}

class MasterPipelineGcpWorker {
  constructor() {
    this.enabled = process.env.MASTER_V1_GCP_WORKER_ENABLE === 'true';
    this.host = process.env.MASTER_V1_GCP_HOST || '';
    this.instance = process.env.MASTER_V1_GCP_VM_NAME;
    this.zone = process.env.MASTER_V1_GCP_VM_ZONE;
    this.project = process.env.MASTER_V1_GCP_VM_PROJECT;
    this.user = process.env.MASTER_V1_GCP_WORKER_USER || process.env.USER;
    this.processingDir = process.env.MASTER_V1_GCP_DATA_DIR || '/opt/master-v1-data';
    this.serviceDir = process.env.MASTER_V1_GCP_SERVICE_DIR || '/opt/master-v1-service';
    this.remotePython = process.env.MASTER_V1_GCP_PYTHON_PATH || '/opt/master-v1-venv/bin/python3';
    this.keepRemoteArtifacts = process.env.MASTER_V1_GCP_KEEP_REMOTE_ARTIFACTS === 'true';
    this.sshKeyPath = process.env.MASTER_V1_GCP_SSH_KEY_PATH || path.join(os.homedir(), '.ssh', 'google_compute_engine');
    this.vmStartWaitMs = parsePositiveInt(process.env.MASTER_V1_GCP_START_WAIT_MS, DEFAULT_VM_START_WAIT_MS);
    this.vmReadyPollMs = parsePositiveInt(process.env.MASTER_V1_GCP_READY_POLL_MS, DEFAULT_VM_READY_POLL_MS);
    this.remoteStatusStaleMs = parsePositiveInt(process.env.MASTER_V1_GCP_STATUS_STALE_MS, DEFAULT_REMOTE_STATUS_STALE_MS);
    this.transferTimeoutMs = parsePositiveInt(process.env.MASTER_V1_GCP_TRANSFER_TIMEOUT_MS, DEFAULT_GCLOUD_TRANSFER_TIMEOUT_MS);
    this.transport = normalizeTransport(process.env.MASTER_V1_GCP_TRANSPORT)
      || (this.host && existsSync(this.sshKeyPath) ? SSH_TRANSPORT : GCLOUD_TRANSPORT);
    this.gcloudCheckPromise = null;

    if (this.enabled && this.transport === SSH_TRANSPORT && !this.host) {
      throw new Error('MASTER_V1_GCP_HOST must be set when MASTER_V1_GCP_TRANSPORT=ssh');
    }

    if (this.enabled && this.transport === GCLOUD_TRANSPORT && (!this.instance || !this.zone)) {
      throw new Error('MASTER_V1_GCP_VM_NAME and MASTER_V1_GCP_VM_ZONE must be set when MASTER_V1_GCP_TRANSPORT=gcloud');
    }
  }

  async ensureGcloudAvailable() {
    if (this.transport === SSH_TRANSPORT) {
      return true;
    }

    if (this.gcloudCheckPromise) {
      return this.gcloudCheckPromise;
    }

    this.gcloudCheckPromise = execAsync('gcloud --version', {
      env: GCLOUD_EXEC_ENV,
      maxBuffer: 1024 * 1024,
      shell: LOCAL_SHELL,
      timeout: 30 * 1000,
    })
      .then(() => true)
      .catch(() => {
        this.gcloudCheckPromise = null;
        throw new Error(GCLOUD_MISSING_ERROR);
      });

    return this.gcloudCheckPromise;
  }

  getRemoteJobDir(jobId) {
    return path.posix.join(this.processingDir, 'jobs', jobId);
  }

  async isAvailable() {
    if (!this.enabled) {
      return false;
    }

    try {
      await this.execRemote('echo master-v1-worker-ready');
      return true;
    } catch {
      return false;
    }
  }

  async waitForAvailability(waitMs = this.vmStartWaitMs) {
    const startTime = Date.now();
    let lastError = null;

    while ((Date.now() - startTime) < waitMs) {
      await sleep(this.vmReadyPollMs);

      try {
        await this.execRemote('echo master-v1-worker-ready');
        return;
      } catch (error) {
        lastError = error;
      }
    }

    const timeoutError = new Error('master_v1_gcp_worker_start_timeout');
    if (lastError) {
      timeoutError.cause = lastError;
    }
    throw timeoutError;
  }

  async startVM() {
    if (!this.enabled || !this.instance || !this.zone) {
      return;
    }

    await this.ensureGcloudAvailable();

    let command = `gcloud compute instances start ${this.instance} --zone=${this.zone} --quiet`;
    if (this.project) {
      command += ` --project=${this.project}`;
    }

    console.log(`[MasterPipelineGcpWorker] Starting VM ${this.instance} in ${this.zone}`);
    await execAsync(command, {
      env: GCLOUD_EXEC_ENV,
      shell: LOCAL_SHELL,
      maxBuffer: 32 * 1024 * 1024,
      timeout: DEFAULT_GCLOUD_TIMEOUT_MS,
    });

    try {
      await this.waitForAvailability();
    } catch (error) {
      const detail = error?.cause?.message ? ` (${error.cause.message})` : '';
      console.warn(`[MasterPipelineGcpWorker] VM ${this.instance} did not become reachable within ${this.vmStartWaitMs}ms${detail}`);
      throw error;
    }
  }

  async execRemote(command) {
    if (this.transport === SSH_TRANSPORT) {
      const sshCommand = [
        'ssh',
        '-i', shellEscape(this.sshKeyPath),
        ...buildSshOptions().map(shellEscape),
        shellEscape(`${this.user}@${this.host}`),
        shellEscape(command),
      ].join(' ');

      const { stdout, stderr } = await execAsync(sshCommand, {
        shell: LOCAL_SHELL,
        maxBuffer: 64 * 1024 * 1024,
        timeout: DEFAULT_GCLOUD_TIMEOUT_MS,
      });

      if (stderr && !stderr.includes('Warning: Permanently added')) {
        console.warn('[MasterPipelineGcpWorker] Remote stderr:', stderr.slice(0, 1000));
      }

      return stdout.trim();
    }

    await this.ensureGcloudAvailable();

    let sshCommand = `gcloud compute ssh ${this.instance} --zone=${this.zone} --quiet --command=${shellEscape(command)}`;
    if (this.project) {
      sshCommand += ` --project=${this.project}`;
    }

    const { stdout, stderr } = await execAsync(sshCommand, {
      env: GCLOUD_EXEC_ENV,
      shell: LOCAL_SHELL,
      maxBuffer: 64 * 1024 * 1024,
      timeout: DEFAULT_GCLOUD_TIMEOUT_MS,
    });

    if (stderr && !stderr.includes('Warning') && !stderr.includes('Updating project ssh metadata')) {
      console.warn('[MasterPipelineGcpWorker] Remote stderr:', stderr.slice(0, 1000));
    }

    return stdout.trim();
  }

  async uploadDirectory(localDir, remoteDir, callbacks = {}) {
    const archivePath = path.join(path.dirname(localDir), `${path.basename(localDir)}-${Date.now()}.tar`);
    const remoteArchivePath = `/tmp/${path.basename(archivePath)}`;

    if (callbacks.onArchiveStart) {
      await callbacks.onArchiveStart();
    }

    await execAsync(`COPYFILE_DISABLE=1 tar --exclude='.DS_Store' --exclude='._*' -cf ${shellEscape(archivePath)} -C ${shellEscape(localDir)} .`, {
      shell: LOCAL_SHELL,
      maxBuffer: 64 * 1024 * 1024,
      timeout: this.transferTimeoutMs,
    });

    if (callbacks.onArchiveComplete) {
      await callbacks.onArchiveComplete({ archivePath });
    }

    try {
      if (this.transport === SSH_TRANSPORT) {
        const scpCommand = [
          'scp',
          '-i', shellEscape(this.sshKeyPath),
          ...buildSshOptions().map(shellEscape),
          shellEscape(archivePath),
          shellEscape(`${this.user}@${this.host}:${remoteArchivePath}`),
        ].join(' ');

        await execAsync(scpCommand, {
          shell: LOCAL_SHELL,
          maxBuffer: 64 * 1024 * 1024,
          timeout: this.transferTimeoutMs,
        });
      } else {
        await this.ensureGcloudAvailable();

        let scpCommand = `gcloud compute scp ${shellEscape(archivePath)} ${this.instance}:${shellEscape(remoteArchivePath)} --zone=${this.zone} --quiet`;
        if (this.project) {
          scpCommand += ` --project=${this.project}`;
        }

        await execAsync(scpCommand, {
          env: GCLOUD_EXEC_ENV,
          shell: LOCAL_SHELL,
          maxBuffer: 64 * 1024 * 1024,
          timeout: this.transferTimeoutMs,
        });
      }

      if (callbacks.onUploadComplete) {
        await callbacks.onUploadComplete({ remoteArchivePath });
      }

      await this.execRemote(`rm -rf ${shellEscape(remoteDir)} && mkdir -p ${shellEscape(remoteDir)} && tar -xf ${shellEscape(remoteArchivePath)} -C ${shellEscape(remoteDir)} && rm -f ${shellEscape(remoteArchivePath)}`);

      if (callbacks.onExtractComplete) {
        await callbacks.onExtractComplete({ remoteDir });
      }
    } finally {
      await fs.rm(archivePath, { force: true });
    }
  }

  buildGcloudSshCommand(remoteCommand) {
    let sshCommand = `gcloud compute ssh ${this.instance} --zone=${this.zone} --quiet --command=${shellEscape(remoteCommand)}`;
    if (this.project) {
      sshCommand += ` --project=${this.project}`;
    }
    return sshCommand;
  }

  async downloadDirectoryViaGcloudSsh(remoteDir, localParentDir) {
    const remoteParentDir = path.posix.dirname(remoteDir);
    const remoteBaseName = path.posix.basename(remoteDir);
    const archivePath = path.join(os.tmpdir(), `${remoteBaseName}-${Date.now()}.tar`);
    const remoteCommand = `tar -C ${shellEscape(remoteParentDir)} -cf - ${shellEscape(remoteBaseName)}`;
    const streamCommand = `${this.buildGcloudSshCommand(remoteCommand)} > ${shellEscape(archivePath)}`;

    await fs.mkdir(localParentDir, { recursive: true });

    try {
      await execAsync(streamCommand, {
        env: GCLOUD_EXEC_ENV,
        shell: LOCAL_SHELL,
        maxBuffer: 64 * 1024 * 1024,
        timeout: this.transferTimeoutMs,
      });

      await execAsync(`tar -xf ${shellEscape(archivePath)} -C ${shellEscape(localParentDir)}`, {
        shell: LOCAL_SHELL,
        maxBuffer: 64 * 1024 * 1024,
        timeout: this.transferTimeoutMs,
      });
    } finally {
      await fs.rm(archivePath, { force: true }).catch(() => {});
    }
  }

  async downloadFileViaGcloudSsh(remotePath, localPath) {
    const remoteCommand = `cat ${shellEscape(remotePath)}`;
    const streamCommand = `${this.buildGcloudSshCommand(remoteCommand)} > ${shellEscape(localPath)}`;

    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await execAsync(streamCommand, {
      env: GCLOUD_EXEC_ENV,
      shell: LOCAL_SHELL,
      maxBuffer: 64 * 1024 * 1024,
      timeout: this.transferTimeoutMs,
    });
  }

  async downloadDirectory(remoteDir, localParentDir) {
    if (this.transport === SSH_TRANSPORT) {
      const scpCommand = [
        'scp',
        '-r',
        '-i', shellEscape(this.sshKeyPath),
        ...buildSshOptions().map(shellEscape),
        shellEscape(`${this.user}@${this.host}:${remoteDir}`),
        shellEscape(localParentDir),
      ].join(' ');

      await execAsync(scpCommand, {
        shell: LOCAL_SHELL,
        maxBuffer: 256 * 1024 * 1024,
        timeout: this.transferTimeoutMs,
      });
      return;
    }

    await this.ensureGcloudAvailable();

    let command = `gcloud compute scp --recurse ${this.instance}:${shellEscape(remoteDir)} ${shellEscape(localParentDir)} --zone=${this.zone} --quiet`;
    if (this.project) {
      command += ` --project=${this.project}`;
    }

    try {
      await execAsync(command, {
        env: GCLOUD_EXEC_ENV,
        shell: LOCAL_SHELL,
        maxBuffer: 256 * 1024 * 1024,
        timeout: DEFAULT_GCLOUD_TIMEOUT_MS,
      });
    } catch (error) {
      console.warn(
        `[MasterPipelineGcpWorker] gcloud compute scp failed for ${remoteDir}; falling back to tar streaming over gcloud compute ssh: ${error.message}`,
      );
      await this.downloadDirectoryViaGcloudSsh(remoteDir, localParentDir);
    }
  }

  async downloadFile(remotePath, localPath) {
    await fs.mkdir(path.dirname(localPath), { recursive: true });

    if (this.transport === SSH_TRANSPORT) {
      const scpCommand = [
        'scp',
        '-i', shellEscape(this.sshKeyPath),
        ...buildSshOptions().map(shellEscape),
        shellEscape(`${this.user}@${this.host}:${remotePath}`),
        shellEscape(localPath),
      ].join(' ');

      await execAsync(scpCommand, {
        shell: LOCAL_SHELL,
        maxBuffer: 64 * 1024 * 1024,
        timeout: this.transferTimeoutMs,
      });
      return;
    }

    await this.ensureGcloudAvailable();

    let command = `gcloud compute scp ${this.instance}:${shellEscape(remotePath)} ${shellEscape(localPath)} --zone=${this.zone} --quiet`;
    if (this.project) {
      command += ` --project=${this.project}`;
    }

    try {
      await execAsync(command, {
        env: GCLOUD_EXEC_ENV,
        shell: LOCAL_SHELL,
        maxBuffer: 64 * 1024 * 1024,
        timeout: DEFAULT_GCLOUD_TIMEOUT_MS,
      });
    } catch (error) {
      console.warn(
        `[MasterPipelineGcpWorker] gcloud compute scp failed for ${remotePath}; falling back to file streaming over gcloud compute ssh: ${error.message}`,
      );
      await this.downloadFileViaGcloudSsh(remotePath, localPath);
    }
  }

  async pathExistsRemote(remotePath) {
    const result = await this.execRemote(`if [ -e ${shellEscape(remotePath)} ]; then echo 1; fi`);
    return result.trim() === '1';
  }

  async isRemoteProcessRunning(remotePidFile) {
    const result = await this.execRemote(`pid=$(cat ${shellEscape(remotePidFile)} 2>/dev/null || true); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo 1; fi`);
    return result.trim() === '1';
  }

  async syncArtifacts(localJobDir, remoteJobDir) {
    for (const dirName of REMOTE_ARTIFACT_DIRS) {
      const remoteDir = path.posix.join(remoteJobDir, dirName);
      if (!(await this.pathExistsRemote(remoteDir))) {
        continue;
      }

      await fs.rm(path.join(localJobDir, dirName), { recursive: true, force: true });
      await this.downloadDirectory(remoteDir, localJobDir);
    }

    for (const [remoteRelativePath, localRelativePath] of REMOTE_ARTIFACT_FILES) {
      const remotePath = path.posix.join(remoteJobDir, remoteRelativePath);
      if (!(await this.pathExistsRemote(remotePath))) {
        continue;
      }

      await this.downloadFile(remotePath, path.join(localJobDir, localRelativePath));
    }

    await rewriteJsonFilesRecursively(localJobDir, remoteJobDir, localJobDir);
  }

  async listRemoteGpuIndices() {
    const output = await this.execRemote('nvidia-smi --query-gpu=index --format=csv,noheader 2>/dev/null || true');
    return output
      .split(/\r?\n/)
      .map((token) => token.trim())
      .filter((token) => /^\d+$/.test(token));
  }

  async resolveRemoteGpuAssignments(options = {}) {
    const availableGpuIndices = await this.listRemoteGpuIndices().catch(() => []);
    const explicitMetric3dGpuIndices = parseGpuIndices(options.metric3dGpuIndices);
    const explicitLearnedMatchingGpuIndices = parseGpuIndices(options.learnedMatchingGpuIndices);
    const explicitDenseStereoGpuIndices = parseGpuIndices(options.denseStereoGpuIndices);

    const metric3dGpuIndices = explicitMetric3dGpuIndices.length ? explicitMetric3dGpuIndices : availableGpuIndices;
    const learnedMatchingGpuIndices = explicitLearnedMatchingGpuIndices.length ? explicitLearnedMatchingGpuIndices : availableGpuIndices;
    const denseStereoGpuIndices = explicitDenseStereoGpuIndices.length ? explicitDenseStereoGpuIndices : availableGpuIndices;

    return {
      availableGpuIndices,
      metric3dGpuIndices: joinGpuIndices(metric3dGpuIndices),
      learnedMatchingGpuIndices: joinGpuIndices(learnedMatchingGpuIndices),
      denseStereoGpuIndices: joinGpuIndices(denseStereoGpuIndices),
    };
  }

  async processPipeline(localJobDir, options = {}, progressCallback = null) {
    if (!this.enabled) {
      throw new Error('master_v1_gcp_worker_disabled');
    }

    const jobId = options.jobId || path.basename(localJobDir);
    const remoteJobDir = this.getRemoteJobDir(jobId);
    const remoteStatusFile = path.posix.join(remoteJobDir, 'outputs', 'master_pipeline_remote_status.json');
    const remoteResultFile = path.posix.join(remoteJobDir, 'outputs', 'master_pipeline_remote_result.json');
    const remoteStdoutLogFile = path.posix.join(remoteJobDir, 'logs', 'master_pipeline_remote_stdout.log');
    const remotePidFile = path.posix.join(remoteJobDir, 'outputs', 'master_pipeline_remote.pid');
    const remoteLauncherFile = path.posix.join(remoteJobDir, 'outputs', 'master_pipeline_remote_launcher.sh');
    const localResultPath = path.join(localJobDir, 'outputs', 'master_pipeline_remote_result.json');
    const localStatusPath = path.join(localJobDir, 'outputs', 'master_pipeline_remote_status.json');
    const staleStatusMs = parsePositiveInt(options.staleStatusMs, this.remoteStatusStaleMs);

    console.log(`[MasterPipelineGcpWorker] Starting remote pipeline handoff for ${jobId}`);

    if (!(await this.isAvailable())) {
      console.log(`[MasterPipelineGcpWorker] VM unavailable for ${jobId}, attempting start`);
      await this.startVM();
    }

    console.log(`[MasterPipelineGcpWorker] Uploading local job ${jobId} to ${remoteJobDir}`);
    await this.uploadDirectory(localJobDir, remoteJobDir);
    await this.execRemote(`mkdir -p ${shellEscape(path.posix.join(remoteJobDir, 'logs'))} ${shellEscape(path.posix.join(remoteJobDir, 'outputs'))} && rm -f ${shellEscape(remoteStatusFile)} ${shellEscape(remoteResultFile)} ${shellEscape(remoteStdoutLogFile)} ${shellEscape(remotePidFile)} ${shellEscape(remoteLauncherFile)}`);

    const gpuAssignments = await this.resolveRemoteGpuAssignments(options);
    const mirrorGaussianCommand = options.mirrorGaussianCommand === null || options.mirrorGaussianCommand === false
      ? ''
      : String(options.mirrorGaussianCommand || DEFAULT_MIRROR_GAUSSIAN_COMMAND || '').trim();
    const requireMirrorGaussian = options.requireMirrorGaussian === true || (
      options.requireMirrorGaussian !== false && DEFAULT_REQUIRE_MIRROR_GAUSSIAN
    );
    const meshOnly = options.metric3dMeshOnly === true;
    const wantsRefGaussian = !meshOnly && (
      options.refGaussianOnly === true
      || options.preferRefGaussian === true
      || options.preferredGaussianBackend === 'ref_gaussian'
    );
    const refGaussianCommand = options.refGaussianCommand === null || options.refGaussianCommand === false
      ? ''
      : String(
        options.refGaussianCommand
        || (wantsRefGaussian ? DEFAULT_REF_GAUSSIAN_COMMAND : '')
        || DEFAULT_REF_GAUSSIAN_COMMAND
        || '',
      ).trim();
    const requireRefGaussian = !meshOnly && (
      options.requireRefGaussian === true
      || wantsRefGaussian
      || (options.requireRefGaussian !== false && DEFAULT_REQUIRE_REF_GAUSSIAN)
    );
    const wantsScaffoldGs = !meshOnly && (
      options.scaffoldGsOnly === true
      || options.preferScaffoldGs === true
      || options.preferredGaussianBackend === 'scaffold_gs'
      || options.preferredGaussianBackend === 'scaffold-gs'
    );
    const scaffoldGsCommand = options.scaffoldGsCommand === null || options.scaffoldGsCommand === false
      ? ''
      : String(
        options.scaffoldGsCommand
        || (wantsScaffoldGs ? DEFAULT_SCAFFOLD_GS_COMMAND : '')
        || DEFAULT_SCAFFOLD_GS_COMMAND
        || '',
      ).trim();
    const requireScaffoldGs = !meshOnly && (
      options.requireScaffoldGs === true
      || wantsScaffoldGs
      || (options.requireScaffoldGs !== false && DEFAULT_REQUIRE_SCAFFOLD_GS)
    );
    console.log(
      `[MasterPipelineGcpWorker] ${jobId} remote GPU assignments available=${gpuAssignments.availableGpuIndices.join(',') || 'none'} `
      + `metric3d=${gpuAssignments.metric3dGpuIndices || 'none'} `
      + `learnedMatching=${gpuAssignments.learnedMatchingGpuIndices || 'none'} `
      + `denseStereo=${gpuAssignments.denseStereoGpuIndices || 'none'}`,
    );

    const orchestratorArgs = [
      shellEscape(this.remotePython),
      shellEscape(path.posix.join(this.serviceDir, 'server', 'scripts', 'master_pipeline', 'orchestrator.py')),
      '--job-dir', shellEscape(remoteJobDir),
      '--status-path', shellEscape(remoteStatusFile),
      '--result-path', shellEscape(remoteResultFile),
      '--metric3d-model-size', shellEscape(options.metric3dModelSize || 'large'),
      '--gaussian-viewer-preset', shellEscape(options.gaussianViewerPreset || 'sparse_first'),
      '--learned-matching-preset', shellEscape(options.learnedMatchingPreset || 'aliked_superpoint_lightglue_loftr'),
      ...(options.learnedMatchingPresetExplicit ? ['--allow-explicit-learned-matching-override'] : []),
      '--learned-matching-image-size', shellEscape(String(options.learnedMatchingImageSize || '1024')),
      ...(options.gaussianOnly && !meshOnly ? ['--gaussian-only'] : []),
      ...(options.gsplatIterations ? ['--gsplat-iterations', shellEscape(String(options.gsplatIterations))] : []),
      ...(options.gaussianMaxInitPoints ? ['--gaussian-max-init-points', shellEscape(String(options.gaussianMaxInitPoints))] : []),
      ...(options.gaussianDepthPriorsMaxPointsPerImage ? ['--gaussian-depth-priors-max-points-per-image', shellEscape(String(options.gaussianDepthPriorsMaxPointsPerImage))] : []),
      ...(mirrorGaussianCommand ? ['--mirror-gaussian-command', shellEscape(mirrorGaussianCommand)] : []),
      ...(requireMirrorGaussian ? ['--require-mirror-gaussian'] : []),
      ...(refGaussianCommand ? ['--ref-gaussian-command', shellEscape(refGaussianCommand)] : []),
      ...(requireRefGaussian ? ['--require-ref-gaussian'] : []),
      ...(options.refGaussianOnly && !meshOnly ? ['--ref-gaussian-only'] : []),
      ...(scaffoldGsCommand ? ['--scaffold-gs-command', shellEscape(scaffoldGsCommand)] : []),
      ...(requireScaffoldGs ? ['--require-scaffold-gs'] : []),
      ...(options.scaffoldGsOnly && !meshOnly ? ['--scaffold-gs-only'] : []),
      ...(options.metric3dMeshSidecar ? ['--metric3d-mesh-sidecar'] : []),
      ...(meshOnly ? ['--metric3d-mesh-only'] : []),
      ...(gpuAssignments.metric3dGpuIndices ? ['--metric3d-gpu-indices', shellEscape(gpuAssignments.metric3dGpuIndices)] : []),
      ...(gpuAssignments.learnedMatchingGpuIndices ? ['--learned-matching-gpu-indices', shellEscape(gpuAssignments.learnedMatchingGpuIndices)] : []),
      ...(gpuAssignments.denseStereoGpuIndices ? ['--dense-stereo-gpu-indices', shellEscape(gpuAssignments.denseStereoGpuIndices)] : []),
      ...(options.metric3dDryRun ? ['--metric3d-dry-run'] : []),
      ...(options.learnedMatchingDryRun ? ['--learned-matching-dry-run'] : []),
      ...(options.globalSfmDryRun ? ['--global-sfm-dry-run'] : []),
      ...(options.denseEvidenceDryRun ? ['--dense-evidence-dry-run'] : []),
      ...(options.gaussianSplattingDryRun ? ['--gaussian-splatting-dry-run'] : []),
      ...(options.planeLayoutDryRun ? ['--plane-layout-dry-run'] : []),
      ...(options.openingDetectionDryRun ? ['--opening-detection-dry-run'] : []),
      ...(options.meshAuthoringDryRun ? ['--mesh-authoring-dry-run'] : []),
      ...(options.uvInitialBakeDryRun ? ['--uv-initial-bake-dry-run'] : []),
      ...(options.appearanceRefinementDryRun ? ['--appearance-refinement-dry-run'] : []),
    ].join(' ');

    const semanticMaskUrl = String(
      process.env.MASTER_PIPELINE_SEMANTIC_MASK_URL || DEFAULT_SEMANTIC_MASK_URL,
    ).trim();
    const refGaussianIterations = String(
      process.env.MASTER_PIPELINE_REFGAUSSIAN_ITERATIONS
      || options.gsplatIterations
      || '20000',
    ).trim();
    const refGaussianProfileMode = String(
      options.refGaussianProfileMode
      || process.env.MASTER_PIPELINE_REFGAUSSIAN_PROFILE_MODE
      || '',
    ).trim();

    const orchestratorEnv = [
      `MASTER_PIPELINE_GAUSSIAN_SPLATTING_ENABLE=${shellEscape(meshOnly || options.enableGaussianSplatting === false ? 'false' : 'true')}`,
      `MASTER_PIPELINE_REQUIRE_GAUSSIAN_SPLATTING=${shellEscape(meshOnly ? 'false' : (options.requireGaussianSplatting ? 'true' : 'false'))}`,
      ...(mirrorGaussianCommand ? [`MASTER_PIPELINE_MIRROR_GAUSSIAN_COMMAND=${shellEscape(mirrorGaussianCommand)}`] : []),
      `MASTER_PIPELINE_REQUIRE_MIRROR_GAUSSIAN=${shellEscape(requireMirrorGaussian ? 'true' : 'false')}`,
      ...(refGaussianCommand ? [`MASTER_PIPELINE_REF_GAUSSIAN_COMMAND=${shellEscape(refGaussianCommand)}`] : []),
      `MASTER_PIPELINE_REQUIRE_REF_GAUSSIAN=${shellEscape(requireRefGaussian ? 'true' : 'false')}`,
      ...(scaffoldGsCommand ? [`MASTER_PIPELINE_SCAFFOLD_GS_COMMAND=${shellEscape(scaffoldGsCommand)}`] : []),
      `MASTER_PIPELINE_REQUIRE_SCAFFOLD_GS=${shellEscape(requireScaffoldGs ? 'true' : 'false')}`,
      `MASTER_PIPELINE_METRIC3D_MESH_SIDECAR=${shellEscape(options.metric3dMeshSidecar ? 'true' : 'false')}`,
      `MASTER_PIPELINE_METRIC3D_MESH_ONLY=${shellEscape(meshOnly ? 'true' : 'false')}`,
      ...(options.efficientLoftrRequired ? ['MASTER_PIPELINE_EFFICIENT_LOFTR_REQUIRED=true'] : []),
      ...(semanticMaskUrl ? [`MASTER_PIPELINE_SEMANTIC_MASK_URL=${shellEscape(semanticMaskUrl)}`] : []),
      ...(refGaussianIterations ? [`MASTER_PIPELINE_REFGAUSSIAN_ITERATIONS=${shellEscape(refGaussianIterations)}`] : []),
      ...(refGaussianProfileMode ? [`MASTER_PIPELINE_REFGAUSSIAN_PROFILE_MODE=${shellEscape(refGaussianProfileMode)}`] : []),
      ...refGaussianProfileEnvAssignments(refGaussianProfileMode),
      ...REFGAUSSIAN_ENV_PASSTHROUGH
        .filter((name) => name !== 'MASTER_PIPELINE_REFGAUSSIAN_ITERATIONS')
        .filter((name) => name !== 'MASTER_PIPELINE_REFGAUSSIAN_PROFILE_MODE')
        .filter((name) => String(process.env[name] || '').trim().length > 0)
        .map((name) => `${name}=${shellEscape(process.env[name])}`),
    ];

    const launcherScript = [
      '#!/bin/sh',
      'set -eu',
      `exec env ${orchestratorEnv.join(' ')} ${orchestratorArgs} > ${shellEscape(remoteStdoutLogFile)} 2>&1 < /dev/null`,
    ].join('\n');

    console.log(`[MasterPipelineGcpWorker] Launching remote orchestrator for ${jobId}`);
    await this.execRemote([
      `cat > ${shellEscape(remoteLauncherFile)} <<'EOF'`,
      launcherScript,
      'EOF',
      `chmod 700 ${shellEscape(remoteLauncherFile)}`,
      `rm -f ${shellEscape(remotePidFile)}`,
      `setsid ${shellEscape(remoteLauncherFile)} >/dev/null 2>&1 < /dev/null & echo $! > ${shellEscape(remotePidFile)}`,
    ].join('\n'));

    const remotePid = await this.execRemote(`cat ${shellEscape(remotePidFile)} 2>/dev/null || true`);
    if (!remotePid.trim()) {
      throw new Error('master_v1_remote_launch_failed');
    }

    const timeoutMs = options.timeoutMs || (4 * 60 * 60 * 1000);
    const startTime = Date.now();
    let lastStageId = null;
    let finalStatus = null;
    let lastStatusToken = null;
    let lastStatusChangeAt = Date.now();
    let remoteProcessExitError = null;
    let lastActiveStagesToken = JSON.stringify([]);

    while ((Date.now() - startTime) < timeoutMs) {
      await sleep(15000);
      const statusRaw = await this.execRemote(`cat ${shellEscape(remoteStatusFile)} 2>/dev/null || true`);
      if (!statusRaw) {
        continue;
      }

      let status = null;
      try {
        status = JSON.parse(statusRaw);
      } catch {
        status = null;
      }

      if (!status) {
        continue;
      }

      const statusToken = JSON.stringify({
        updatedAt: status.updatedAt || '',
        currentStage: status.currentStage || '',
        activeStages: Array.isArray(status.activeStages) ? status.activeStages : [],
        completedStages: Array.isArray(status.completedStages) ? status.completedStages : [],
        done: Boolean(status.done),
        failedStage: status.failedStage || '',
        error: status.error || '',
      });
      if (statusToken !== lastStatusToken) {
        lastStatusToken = statusToken;
        lastStatusChangeAt = Date.now();
      }

      const activeStagesToken = JSON.stringify(Array.isArray(status.activeStages) ? status.activeStages : []);
      const stageChanged = status.currentStage && status.currentStage !== lastStageId;
      const activeStagesChanged = activeStagesToken !== lastActiveStagesToken;

      if (stageChanged || activeStagesChanged) {
        if (status.currentStage) {
          lastStageId = status.currentStage;
          console.log(`[MasterPipelineGcpWorker] ${jobId} remote stage=${status.currentStage}`);
        }
        lastActiveStagesToken = activeStagesToken;
        if (progressCallback) {
          await progressCallback(status);
        }
      }

      if (status.done) {
        finalStatus = status;
        break;
      }

      if ((Date.now() - lastStatusChangeAt) >= staleStatusMs) {
        const isRunning = await this.isRemoteProcessRunning(remotePidFile).catch(() => false);
        if (!isRunning) {
          remoteProcessExitError = new Error('master_v1_remote_process_exited');
          remoteProcessExitError.failedStageId = status.currentStage || lastStageId || 'metric3d_priors';
          break;
        }
      }
    }

    await this.syncArtifacts(localJobDir, remoteJobDir);

    if (remoteProcessExitError) {
      throw remoteProcessExitError;
    }

    const resultRaw = await fs.readFile(localResultPath, 'utf8').catch(() => '');
    let result = null;
    if (resultRaw) {
      try {
        result = JSON.parse(resultRaw);
      } catch {
        result = null;
      }
    }

    if (!finalStatus) {
      const lastStatusRaw = await fs.readFile(localStatusPath, 'utf8').catch(() => '');
      let timeoutStatus = null;
      if (lastStatusRaw) {
        try {
          timeoutStatus = JSON.parse(lastStatusRaw);
        } catch {
          timeoutStatus = null;
        }
      }

      const error = new Error('master_v1_gcp_worker_timeout');
      error.failedStageId = timeoutStatus?.currentStage || lastStageId || 'metric3d_priors';
      throw error;
    }

    if (!this.keepRemoteArtifacts) {
      await this.execRemote(`rm -rf ${shellEscape(remoteJobDir)}`);
    }

    if (!result?.success) {
      const error = new Error(result?.error || finalStatus.error || 'master_v1_remote_failed');
      error.failedStageId = result?.failedStage || finalStatus.failedStage || lastStageId || 'metric3d_priors';
      throw error;
    }

    return {
      ...result,
      remoteJobDir,
    };
  }

  async processLegacyPhotogrammetryScan(localScanDir, options = {}, progressCallback = null) {
    if (!this.enabled) {
      throw new Error('master_v1_gcp_worker_disabled');
    }

    const scanId = options.scanId || path.basename(localScanDir);
    const localPhotogrammetryRoot = path.dirname(localScanDir);
    const remoteRoot = path.posix.join(this.processingDir, 'legacy-photogrammetry', scanId);
    const remoteDataDir = path.posix.join(remoteRoot, 'data');
    const remoteScanDir = path.posix.join(remoteDataDir, 'photogrammetry', scanId);
    const remoteProgressFile = path.posix.join(remoteScanDir, 'progress.json');
    const remoteResultFile = path.posix.join(remoteScanDir, 'result.json');
    const remoteLogFile = path.posix.join(remoteRoot, 'legacy_pipeline_stdout.log');
    const remotePidFile = path.posix.join(remoteRoot, 'legacy_pipeline.pid');
    const remoteLauncherFile = path.posix.join(remoteRoot, 'legacy_pipeline_launcher.sh');
    const localProgressPath = path.join(localScanDir, 'progress.json');
    const localResultPath = path.join(localScanDir, 'result.json');
    const localLogsDir = path.join(localScanDir, 'logs');
    const localRemoteLogPath = path.join(localLogsDir, 'legacy_pipeline_stdout.log');
    const localStageRoot = path.join(localPhotogrammetryRoot, `.${scanId}.master-v1-stage-${Date.now()}`);
    const stagedLocalScanDir = path.join(localStageRoot, scanId);
    const stagedLocalLogsDir = path.join(stagedLocalScanDir, 'logs');
    const stagedRemoteLogPath = path.join(stagedLocalLogsDir, 'legacy_pipeline_stdout.log');
    const localScanBackupDir = path.join(localPhotogrammetryRoot, `.${scanId}.master-v1-backup-${Date.now()}`);

    if (!(await this.isAvailable())) {
      await this.startVM();
    }

    await progressCallback?.({ message: 'Uploading legacy scan to master-v1 VM...', phase: 'initializing', percent: 5 });
    await this.uploadDirectory(localScanDir, remoteScanDir, {
      onArchiveStart: async () => {
        await progressCallback?.({
          message: 'Preparing scan archive for VM transfer...',
          phase: 'initializing',
          percent: 6,
        });
      },
      onArchiveComplete: async () => {
        await progressCallback?.({
          message: 'Scan archive prepared. Uploading to master-v1 VM...',
          phase: 'initializing',
          percent: 8,
        });
      },
      onUploadComplete: async () => {
        await progressCallback?.({
          message: 'Scan archive uploaded. Extracting on master-v1 VM...',
          phase: 'initializing',
          percent: 12,
        });
      },
      onExtractComplete: async () => {
        await progressCallback?.({
          message: 'Scan uploaded. Launching legacy photogrammetry pipeline on master-v1 VM...',
          phase: 'initializing',
          percent: 15,
        });
      },
    });
    await this.execRemote(`mkdir -p ${shellEscape(remoteRoot)} && rm -f ${shellEscape(remoteProgressFile)} ${shellEscape(remoteResultFile)} ${shellEscape(remoteLogFile)} ${shellEscape(remotePidFile)} ${shellEscape(remoteLauncherFile)}`);

    const denseMethod = String(options.denseMethod || 'colmap');
    const depthPriorSource = String(options.depthPriorSource || 'auto');
    const meshMethod = String(options.meshMethod || 'poisson');
    const meshDepth = Number.parseInt(String(options.meshDepth || 10), 10) || 10;
    const targetTriangles = Number.parseInt(String(options.targetTriangles || 500000), 10) || 500000;
    const textureResolution = Number.parseInt(String(options.textureResolution || 4096), 10) || 4096;
    const clusterRadius = Number.parseFloat(String(options.clusterRadius || 0.5)) || 0.5;
    const exportFormats = Array.isArray(options.exportFormats) && options.exportFormats.length
      ? options.exportFormats.map((entry) => String(entry))
      : ['glb'];

    const availableGpuIndices = await this.listRemoteGpuIndices().catch(() => []);

    const commandParts = [
      'cd', shellEscape(this.serviceDir), '&&',
      'PYTHONPATH=' + shellEscape(path.posix.join(this.serviceDir, 'server', 'scripts')),
      'GCP_GPU_WORKER_ENABLE=false',
      shellEscape(this.remotePython),
      shellEscape(path.posix.join(this.serviceDir, 'server', 'scripts', 'photogrammetry', 'pipeline.py')),
      shellEscape(scanId),
      '--data-dir', shellEscape(remoteDataDir),
      '--dense-method', shellEscape(denseMethod),
      '--depth-prior-source', shellEscape(depthPriorSource),
      '--mesh-method', shellEscape(meshMethod),
      '--mesh-depth', shellEscape(String(meshDepth)),
      '--target-triangles', shellEscape(String(targetTriangles)),
      '--texture-resolution', shellEscape(String(textureResolution)),
      '--cluster-radius', shellEscape(String(clusterRadius)),
    ];

    for (const format of exportFormats) {
      commandParts.push('--export-formats', shellEscape(format));
    }

    const launcherScript = [
      '#!/bin/sh',
      'set -eu',
      `cd ${shellEscape(this.serviceDir)}`,
      `export PYTHONPATH=${shellEscape(path.posix.join(this.serviceDir, 'server', 'scripts'))}`,
      'export GCP_GPU_WORKER_ENABLE=false',
      `exec ${[
        shellEscape(this.remotePython),
        shellEscape(path.posix.join(this.serviceDir, 'server', 'scripts', 'photogrammetry', 'pipeline.py')),
        shellEscape(scanId),
        '--data-dir', shellEscape(remoteDataDir),
        '--dense-method', shellEscape(denseMethod),
        '--depth-prior-source', shellEscape(depthPriorSource),
        '--mesh-method', shellEscape(meshMethod),
        '--mesh-depth', shellEscape(String(meshDepth)),
        '--target-triangles', shellEscape(String(targetTriangles)),
        '--texture-resolution', shellEscape(String(textureResolution)),
        '--cluster-radius', shellEscape(String(clusterRadius)),
        ...exportFormats.flatMap((format) => ['--export-formats', shellEscape(format)]),
      ].join(' ')} > ${shellEscape(remoteLogFile)} 2>&1 < /dev/null`,
    ].join('\n');

    await this.execRemote([
      `cat > ${shellEscape(remoteLauncherFile)} <<'EOF'`,
      launcherScript,
      'EOF',
      `chmod 700 ${shellEscape(remoteLauncherFile)}`,
      `rm -f ${shellEscape(remotePidFile)}`,
      `setsid ${shellEscape(remoteLauncherFile)} >/dev/null 2>&1 < /dev/null & echo $! > ${shellEscape(remotePidFile)}`,
    ].join('\n'));

    const remotePid = await this.execRemote(`cat ${shellEscape(remotePidFile)} 2>/dev/null || true`);
    if (!remotePid.trim()) {
      throw new Error('master_v1_legacy_remote_launch_failed');
    }

    let finalProgress = null;
    const timeoutMs = options.timeoutMs || (4 * 60 * 60 * 1000);
    const startTime = Date.now();
    let lastProgressToken = null;

    while ((Date.now() - startTime) < timeoutMs) {
      await sleep(15000);

      const progressRaw = await this.execRemote(`cat ${shellEscape(remoteProgressFile)} 2>/dev/null || true`);
      if (progressRaw) {
        try {
          const progress = JSON.parse(progressRaw);
          const token = JSON.stringify(progress);
          if (token !== lastProgressToken) {
            lastProgressToken = token;
            finalProgress = progress;
            await fs.writeFile(localProgressPath, JSON.stringify(progress, null, 2));
            await progressCallback?.(progress);
          }

          if (progress.phase === 'complete' || progress.phase === 'failed') {
            break;
          }
        } catch {
          // Ignore malformed progress until the next poll.
        }
      }

      const isRunning = await this.isRemoteProcessRunning(remotePidFile).catch(() => false);
      if (!isRunning) {
        break;
      }
    }

    let localScanBackedUp = false;
    let localHandoffSucceeded = false;

    await fs.rm(localStageRoot, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(localStageRoot, { recursive: true });

    try {
      await this.downloadDirectory(remoteScanDir, localStageRoot);
      await fs.mkdir(stagedLocalLogsDir, { recursive: true }).catch(() => {});
      if (await this.pathExistsRemote(remoteLogFile).catch(() => false)) {
        await this.downloadFile(remoteLogFile, stagedRemoteLogPath).catch(() => {});
      }

      if (existsSync(localScanDir)) {
        await fs.rm(localScanBackupDir, { recursive: true, force: true }).catch(() => {});
        await fs.rename(localScanDir, localScanBackupDir);
        localScanBackedUp = true;
      }

      await fs.rename(stagedLocalScanDir, localScanDir);
      localHandoffSucceeded = true;
    } catch (error) {
      if (localScanBackedUp && !existsSync(localScanDir)) {
        await fs.rename(localScanBackupDir, localScanDir).catch(() => {});
      }
      throw error;
    } finally {
      if (localHandoffSucceeded && localScanBackedUp) {
        await fs.rm(localScanBackupDir, { recursive: true, force: true }).catch(() => {});
      }
      await fs.rm(localStageRoot, { recursive: true, force: true }).catch(() => {});
    }

    const resultRaw = await fs.readFile(localResultPath, 'utf8').catch(() => '');
    let result = null;
    if (resultRaw) {
      try {
        result = JSON.parse(resultRaw);
      } catch {
        result = null;
      }
    }

    const remoteLogTail = await fs.readFile(localRemoteLogPath, 'utf8')
      .then((raw) => raw.split(/\r?\n/).filter(Boolean).slice(-40).join('\n'))
      .catch(() => '');

    if (!result?.success) {
      const baseMessage = result?.error || finalProgress?.message || 'master_v1_legacy_remote_failed';
      const detailSuffix = remoteLogTail ? `\nRemote log tail:\n${remoteLogTail}` : '';
      const error = new Error(`${baseMessage}${detailSuffix}`);
      error.remoteGpuIndices = availableGpuIndices;
      error.remoteLogPath = remoteLogTail ? localRemoteLogPath : null;
      error.remoteLogTail = remoteLogTail;
      throw error;
    }

    if (!this.keepRemoteArtifacts && localHandoffSucceeded) {
      await this.execRemote(`rm -rf ${shellEscape(remoteRoot)}`);
    }

    return {
      ...result,
      remoteGpuIndices: availableGpuIndices,
      remoteScanDir,
    };
  }
}

let masterPipelineWorkerInstance = null;

function getMasterPipelineGcpWorker() {
  if (!masterPipelineWorkerInstance) {
    masterPipelineWorkerInstance = new MasterPipelineGcpWorker();
  }

  return masterPipelineWorkerInstance;
}

export { MasterPipelineGcpWorker, getMasterPipelineGcpWorker };