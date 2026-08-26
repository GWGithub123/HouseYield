import { exec } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);
const GCLOUD_MISSING_ERROR = 'Room-tour GCP handoff unavailable: google-cloud-cli is not installed in the scanner-host runtime.';
const LOCAL_SHELL = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

class RoomTourGcpWorker {
  constructor() {
    this.enabled = process.env.ROOM_TOUR_GCP_WORKER_ENABLE === 'true';
    this.host = process.env.ROOM_TOUR_GCP_WORKER_HOST || process.env.GCP_GPU_WORKER_HOST;
    this.instance = process.env.ROOM_TOUR_GCP_WORKER_INSTANCE || process.env.GCP_GPU_WORKER_INSTANCE;
    this.zone = process.env.ROOM_TOUR_GCP_WORKER_ZONE || process.env.GCP_GPU_WORKER_ZONE;
    this.project = process.env.ROOM_TOUR_GCP_WORKER_PROJECT || process.env.GCP_GPU_WORKER_PROJECT;
    this.user = process.env.ROOM_TOUR_GCP_WORKER_USER || process.env.GCP_GPU_WORKER_USER || process.env.USER;
    this.processingDir = process.env.ROOM_TOUR_GCP_PROCESSING_DIR || '/opt/room-tour-data';
    this.serviceDir = process.env.ROOM_TOUR_GCP_SERVICE_DIR || '/opt/room-tour-service';
    this.keepRemoteArtifacts = process.env.ROOM_TOUR_GCP_KEEP_REMOTE_ARTIFACTS === 'true';
    this.gcloudCheckPromise = null;

    if (this.enabled && (!this.instance || !this.zone)) {
      throw new Error('ROOM_TOUR_GCP_WORKER_INSTANCE and ROOM_TOUR_GCP_WORKER_ZONE must be set when ROOM_TOUR_GCP_WORKER_ENABLE=true');
    }
  }

  async ensureGcloudAvailable() {
    if (this.gcloudCheckPromise) {
      return this.gcloudCheckPromise;
    }

    this.gcloudCheckPromise = execAsync('gcloud --version', { maxBuffer: 1024 * 1024 })
      .then(() => true)
      .catch(() => {
        this.gcloudCheckPromise = null;
        throw new Error(GCLOUD_MISSING_ERROR);
      });

    return this.gcloudCheckPromise;
  }

  getInstanceInfo() {
    return {
      instance: this.instance,
      zone: this.zone,
      project: this.project,
    };
  }

  async isAvailable() {
    if (!this.enabled) {
      return false;
    }

    try {
      await this.execRemote('echo room-tour-worker-ready');
      return true;
    } catch {
      return false;
    }
  }

  async startVM() {
    if (!this.enabled) {
      return;
    }

    await this.ensureGcloudAvailable();

    const { instance, zone, project } = this.getInstanceInfo();
    let command = `gcloud compute instances start ${instance} --zone=${zone}`;

    if (project) {
      command += ` --project=${project}`;
    }

    await execAsync(command);

    for (let attempt = 0; attempt < 24; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (await this.isAvailable()) {
        return;
      }
    }

    throw new Error('room_tour_gcp_worker_start_timeout');
  }

  async execRemote(command) {
    await this.ensureGcloudAvailable();

    const { instance, zone, project } = this.getInstanceInfo();
    let sshCommand = `gcloud compute ssh ${instance} --zone=${zone} --command=${shellEscape(command)}`;

    if (project) {
      sshCommand += ` --project=${project}`;
    }

    const { stdout, stderr } = await execAsync(sshCommand, { maxBuffer: 64 * 1024 * 1024 });
    if (stderr && !stderr.includes('Warning') && !stderr.includes('Updating project ssh metadata')) {
      console.warn('[RoomTourGcpWorker] Remote stderr:', stderr.slice(0, 1000));
    }
    return stdout.trim();
  }

  async uploadDirectory(localDir, remoteDir) {
    await this.ensureGcloudAvailable();

    const archivePath = path.join(path.dirname(localDir), `${path.basename(localDir)}-${Date.now()}.tar.gz`);
    const remoteArchivePath = `/tmp/${path.basename(archivePath)}`;
    const { instance, zone, project } = this.getInstanceInfo();

    await execAsync(`tar -czf ${shellEscape(archivePath)} -C ${shellEscape(localDir)} .`, {
      shell: LOCAL_SHELL,
      maxBuffer: 32 * 1024 * 1024,
    });

    let command = `gcloud compute scp ${shellEscape(archivePath)} ${instance}:${shellEscape(remoteArchivePath)} --zone=${zone}`;

    if (project) {
      command += ` --project=${project}`;
    }

    try {
      await execAsync(command, { shell: LOCAL_SHELL, maxBuffer: 32 * 1024 * 1024 });
      await this.execRemote(`mkdir -p ${shellEscape(remoteDir)} && tar -xzf ${shellEscape(remoteArchivePath)} -C ${shellEscape(remoteDir)} && rm -f ${shellEscape(remoteArchivePath)}`);
    } finally {
      await fs.rm(archivePath, { force: true });
    }
  }

  async downloadFile(remotePath, localPath) {
    await this.ensureGcloudAvailable();

    const { instance, zone, project } = this.getInstanceInfo();
    let command = `gcloud compute scp ${instance}:${shellEscape(remotePath)} ${shellEscape(localPath)} --zone=${zone}`;

    if (project) {
      command += ` --project=${project}`;
    }

    await execAsync(command, { shell: LOCAL_SHELL, maxBuffer: 32 * 1024 * 1024 });
  }

  async processRoomTour(localPackageDir, localJobDir, options = {}, progressCallback = null) {
    if (!this.enabled) {
      throw new Error('room_tour_gcp_worker_disabled');
    }

    const jobId = options.jobId || `room-tour-${Date.now()}`;
    const remoteRoot = `${this.processingDir}/${jobId}-${Date.now()}`;
    const remoteInputDir = `${remoteRoot}/input`;
    const remoteOutputDir = `${remoteRoot}/output`;
    const remoteLogFile = `${remoteOutputDir}/room-tour.log`;
    const remoteStatusFile = `${remoteOutputDir}/status.json`;
    const remoteResultFile = `${remoteOutputDir}/outputs/remote-processing.json`;
    const localBundlePath = path.join(localJobDir, 'outputs', 'room-tour-gcp-bundle.tar.gz');

    await fs.mkdir(path.join(localJobDir, 'outputs'), { recursive: true });

    if (progressCallback) {
      progressCallback('Checking room-tour GPU worker...');
    }

    if (!(await this.isAvailable())) {
      if (progressCallback) {
        progressCallback('Starting room-tour GPU worker VM...');
      }
      await this.startVM();
    }

    await this.execRemote(`mkdir -p ${shellEscape(remoteInputDir)} ${shellEscape(remoteOutputDir)} ${shellEscape(`${remoteOutputDir}/outputs`)}`);

    if (progressCallback) {
      progressCallback('Uploading room-tour package...');
    }
    await this.uploadDirectory(localPackageDir, remoteInputDir);

    const workerCommand = [
      'nohup',
      '/opt/room-tour-venv/bin/python3',
      `${this.serviceDir}/process_room_tour.py`,
      '--input-dir', remoteInputDir,
      '--output-dir', remoteOutputDir,
      '--job-id', jobId,
      '>', remoteLogFile,
      '2>&1',
      '&&', `echo '{"done":true,"completedAt":"$(date -Iseconds)"}' > ${remoteStatusFile}`,
      '||', `echo '{"done":true,"error":"room_tour_pipeline_failed","completedAt":"$(date -Iseconds)"}' > ${remoteStatusFile}`,
      '&',
    ].join(' ');

    await this.execRemote(workerCommand);

    const timeoutMs = 2 * 60 * 60 * 1000;
    const startTime = Date.now();
    let lastProgress = '';
    let remoteStatusRaw = '';

    while ((Date.now() - startTime) < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 15000));
      const status = await this.execRemote(`cat ${shellEscape(remoteStatusFile)} 2>/dev/null || true`);

      if (status.includes('"done":true')) {
        remoteStatusRaw = status;
        break;
      }

      const tail = await this.execRemote(`tail -1 ${shellEscape(remoteLogFile)} 2>/dev/null || true`);
      if (tail && tail !== lastProgress) {
        lastProgress = tail;
        if (progressCallback) {
          progressCallback(`Remote geometry: ${tail.slice(0, 120)}`);
        }
      }
    }

    if (!remoteStatusRaw) {
      const logTail = await this.execRemote(`tail -40 ${shellEscape(remoteLogFile)} 2>/dev/null || true`);
      throw new Error(logTail ? `room_tour_gcp_worker_timeout\n${logTail}` : 'room_tour_gcp_worker_timeout');
    }

    let remoteStatus = null;
    try {
      remoteStatus = JSON.parse(remoteStatusRaw);
    } catch {
      remoteStatus = null;
    }

    const remoteResultJson = await this.execRemote(`cat ${shellEscape(remoteResultFile)} 2>/dev/null || true`);
    if (!remoteResultJson) {
      const logTail = await this.execRemote(`tail -40 ${shellEscape(remoteLogFile)} 2>/dev/null || true`);
      if (remoteStatus?.error) {
        throw new Error(logTail ? `${remoteStatus.error}\n${logTail}` : remoteStatus.error);
      }

      throw new Error(logTail || 'room_tour_remote_result_missing');
    }

    const result = JSON.parse(remoteResultJson);
    if (!result.success) {
      throw new Error(result.error || 'room_tour_remote_failed');
    }

    if (progressCallback) {
      progressCallback('Downloading room-tour artifacts...');
    }

    const remoteBundlePath = `${remoteOutputDir}/room-tour-bundle.tar.gz`;
    await this.execRemote(`cd ${shellEscape(remoteOutputDir)} && tar -czf ${shellEscape(remoteBundlePath)} native-output outputs`);
    await this.downloadFile(remoteBundlePath, localBundlePath);
    await execAsync(`tar -xzf ${shellEscape(localBundlePath)} -C ${shellEscape(localJobDir)}`, { shell: LOCAL_SHELL });

    if (!this.keepRemoteArtifacts) {
      await this.execRemote(`rm -rf ${shellEscape(remoteRoot)}`);
    }

    await fs.rm(localBundlePath, { force: true });
    return result;
  }
}

let roomTourWorkerInstance = null;

function getRoomTourGcpWorker() {
  if (!roomTourWorkerInstance) {
    roomTourWorkerInstance = new RoomTourGcpWorker();
  }

  return roomTourWorkerInstance;
}

export { RoomTourGcpWorker, getRoomTourGcpWorker };