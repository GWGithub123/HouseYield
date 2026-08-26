import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CloudUpload,
  LoaderCircle,
  ServerCog,
} from 'lucide-react';

import {
  deriveMasterJobProgress,
  type MasterReconstructionJob,
  type MasterReconstructionStage,
} from '../services/masterReconstructionService';

interface MasterPipelineProcessingViewProps {
  job: MasterReconstructionJob | null;
  uploadPercent: number;
  uploadMessage: string;
  onBack: () => void;
}

function getStageStyle(status: MasterReconstructionStage['status']) {
  switch (status) {
    case 'completed':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
    case 'running':
      return 'border-sky-500/50 bg-sky-500/10 text-sky-100';
    case 'queued':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-100';
    case 'failed':
      return 'border-red-500/50 bg-red-500/10 text-red-100';
    default:
      return 'border-white/10 bg-white/5 text-white/45';
  }
}

function getStageIcon(status: MasterReconstructionStage['status']) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-5 w-5 text-emerald-300" />;
    case 'running':
      return <LoaderCircle className="h-5 w-5 animate-spin text-sky-300" />;
    case 'failed':
      return <AlertCircle className="h-5 w-5 text-red-300" />;
    case 'queued':
      return <ServerCog className="h-5 w-5 text-amber-300" />;
    default:
      return <div className="h-2.5 w-2.5 rounded-full bg-white/25" />;
  }
}

const MasterPipelineProcessingView: React.FC<MasterPipelineProcessingViewProps> = ({
  job,
  uploadPercent,
  uploadMessage,
  onBack,
}) => {
  const jobProgress = job ? deriveMasterJobProgress(job) : null;
  const percent = job
    ? Math.max(
        jobProgress?.percent || 0,
        job.status === 'created' || job.status === 'input_uploaded' ? uploadPercent : 0,
      )
    : uploadPercent;
  const message = job
    ? (job.status === 'created' || job.status === 'input_uploaded'
      ? uploadMessage
      : jobProgress?.message || uploadMessage)
    : uploadMessage;
  const failureMessage = job && typeof job.metadata?.lastError === 'string'
    ? job.metadata.lastError
    : null;

  return (
    <div className="min-h-screen bg-gray-950 px-4 py-8 text-white">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 via-slate-900 to-slate-950 p-6 shadow-2xl shadow-cyan-900/20">
          <div className="mb-5 flex items-start gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-500/15 text-cyan-200">
              {job && job.status !== 'created' && job.status !== 'input_uploaded' ? (
                <ServerCog className="h-7 w-7" />
              ) : (
                <CloudUpload className="h-7 w-7" />
              )}
            </div>
            <div className="flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200/80">Canonical Master v1</p>
              <h1 className="mt-1 text-2xl font-semibold text-white">Processing your 3D scan on the dedicated VM</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
                This flow uploads the capture set to master_v1, runs the full canonical reconstruction pipeline on the dual-L4 worker,
                and posts the finished model into Saved Room Scans automatically.
              </p>
            </div>
          </div>

          <div className="mb-3 h-3 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-sky-400 to-emerald-400 transition-all duration-500"
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </div>

          <div className="flex items-center justify-between gap-3 text-sm text-slate-300">
            <span>{message || 'Preparing master_v1...'}</span>
            <span className="font-medium text-white">{Math.round(percent)}%</span>
          </div>

          {job ? (
            <div className="mt-4 grid gap-3 text-xs text-slate-400 md:grid-cols-3">
              <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                <div className="uppercase tracking-[0.18em] text-slate-500">Job ID</div>
                <div className="mt-1 truncate text-slate-200">{job.id}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                <div className="uppercase tracking-[0.18em] text-slate-500">Status</div>
                <div className="mt-1 text-slate-200">{job.status}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                <div className="uppercase tracking-[0.18em] text-slate-500">Frames</div>
                <div className="mt-1 text-slate-200">{job.capture?.selectedFrameCount || job.capture?.imageCount || 0}</div>
              </div>
            </div>
          ) : null}
        </div>

        {jobProgress?.currentStage ? (
          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">Pipeline stages</h2>
                <p className="text-sm text-slate-400">
                  {jobProgress.completedStages} of {jobProgress.totalStages} stages completed.
                </p>
              </div>
              <div className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-100">
                {jobProgress.currentStage.label}
              </div>
            </div>

            <div className="space-y-3">
              {job?.stages.map((stage) => (
                <div
                  key={stage.id}
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${getStageStyle(stage.status)}`}
                >
                  {getStageIcon(stage.status)}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{stage.label}</div>
                    <div className="mt-0.5 text-xs uppercase tracking-[0.18em] opacity-70">{stage.status}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 text-sm text-slate-300">
            Creating the master_v1 job and uploading the image set before the VM execution begins.
          </div>
        )}

        {failureMessage ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
            <div className="mb-1 font-semibold">Master v1 failed</div>
            <div>{failureMessage}</div>
          </div>
        ) : null}

        <div className="flex flex-col items-start gap-3 rounded-2xl border border-white/10 bg-slate-900/60 p-4 text-sm text-slate-300 md:flex-row md:items-center md:justify-between">
          <div>
            Leaving this screen does not cancel the backend job. When the VM finishes, the model will show up in Saved Room Scans.
          </div>
          <button
            onClick={onBack}
            className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 font-medium text-white transition-colors hover:bg-white/10"
          >
            Leave Screen
          </button>
        </div>
      </div>
    </div>
  );
};

export default MasterPipelineProcessingView;