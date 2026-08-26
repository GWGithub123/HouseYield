import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Model3DViewer from '../components/Model3DViewer';
import { getRoomTourJob } from '../services/roomTourService';
import type { RoomTourJob } from '../types/roomTour';

interface RoomTourManifest {
  preview?: {
    thumbnailUrl?: string;
    storyboardUrl?: string;
    selectedKeyframeCount?: number;
    extractedFrameCount?: number;
  };
  artifacts?: {
    nativeOutputBaseUrl?: string;
    executionManifestUrl?: string;
    keyframeDirectoryUrl?: string;
  };
}

function deriveViewerAsset(job: RoomTourJob | null, manifest: RoomTourManifest | null): string | null {
  if (!job) {
    return null;
  }

  if (job.outputs.viewerPath) {
    return job.outputs.viewerPath;
  }

  if (job.outputs.meshPath) {
    return job.outputs.meshPath;
  }

  if (job.outputs.splatScenePath?.endsWith('.html')) {
    return job.outputs.splatScenePath;
  }

  if (job.outputs.splatScenePath?.endsWith('.splat') && manifest?.artifacts?.nativeOutputBaseUrl) {
    return `${manifest.artifacts.nativeOutputBaseUrl}/viewer/index.html`;
  }

  if (job.outputs.splatScenePath?.endsWith('.ksplat') && manifest?.artifacts?.nativeOutputBaseUrl) {
    return `${manifest.artifacts.nativeOutputBaseUrl}/viewer/index.html`;
  }

  return null;
}

const RoomTourViewPage: React.FC = () => {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();

  const [job, setJob] = useState<RoomTourJob | null>(null);
  const [manifest, setManifest] = useState<RoomTourManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) {
      setError('Missing room-tour job ID.');
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    const loadJob = async () => {
      try {
        const nextJob = await getRoomTourJob(jobId);
        if (cancelled) {
          return;
        }

        setJob(nextJob);
        setError(null);

        if (nextJob.outputs.tourManifestPath) {
          try {
            const response = await fetch(nextJob.outputs.tourManifestPath);
            if (response.ok && !cancelled) {
              const nextManifest = await response.json();
              setManifest(nextManifest);
            }
          } catch (manifestError) {
            console.warn('[RoomTourView] Failed to load manifest:', manifestError);
          }
        }
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : 'Failed to load room tour');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadJob();

    const intervalId = window.setInterval(() => {
      void loadJob();
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [jobId]);

  const viewerAssetUrl = useMemo(() => deriveViewerAsset(job, manifest), [job, manifest]);

  const artifactLinks = useMemo(() => {
    if (!job) {
      return [];
    }

    return [
      { label: 'Tour manifest', url: job.outputs.tourManifestPath },
      { label: 'Execution contract', url: job.outputs.executionManifestPath || manifest?.artifacts?.executionManifestUrl },
      { label: 'Mesh output', url: job.outputs.meshPath },
      { label: 'Splat scene', url: job.outputs.splatScenePath },
      { label: 'Viewer bundle', url: job.outputs.viewerPath || (manifest?.artifacts?.nativeOutputBaseUrl ? `${manifest.artifacts.nativeOutputBaseUrl}/viewer/index.html` : null) },
      { label: 'Preview thumbnail', url: job.outputs.previewThumbnailPath || manifest?.preview?.thumbnailUrl },
    ].filter((entry): entry is { label: string; url: string } => Boolean(entry.url));
  }, [job, manifest]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-cyan-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm text-slate-300">Loading room-tour assets...</p>
        </div>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="max-w-lg w-full rounded-3xl border border-white/10 bg-white/5 p-6">
          <h1 className="text-xl font-semibold">Room tour unavailable</h1>
          <p className="mt-3 text-sm text-slate-300">{error || 'The requested room-tour job could not be loaded.'}</p>
          <button
            onClick={() => navigate('/room-scanner')}
            className="mt-6 inline-flex items-center rounded-full bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-300 transition-colors"
          >
            Back to scanner
          </button>
        </div>
      </div>
    );
  }

  if (viewerAssetUrl) {
    return <Model3DViewer modelUrl={viewerAssetUrl} onClose={() => navigate('/room-scanner')} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6 md:p-8">
      <div className="max-w-5xl mx-auto">
        <button
          onClick={() => navigate('/room-scanner')}
          className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white transition-colors"
        >
          <span aria-hidden="true">←</span>
          Back to scanner
        </button>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <section className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-cyan-300">Separate room-tour pipeline</p>
                <h1 className="mt-2 text-3xl font-semibold">{job.roomName}</h1>
                <p className="mt-3 text-sm text-slate-300">
                  Job {job.id} is running independently from photogrammetry. This page reads the room-tour artifact bundle directly.
                </p>
              </div>
              <div className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">
                {job.status}
              </div>
            </div>

            {(job.outputs.previewThumbnailPath || manifest?.preview?.thumbnailUrl) && (
              <img
                src={job.outputs.previewThumbnailPath || manifest?.preview?.thumbnailUrl}
                alt={`${job.roomName} preview`}
                className="mt-6 h-64 w-full rounded-2xl object-cover border border-white/10"
              />
            )}

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Primary output</p>
                <p className="mt-2 text-sm font-medium text-white">{job.primaryOutput}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Selected keyframes</p>
                <p className="mt-2 text-sm font-medium text-white">{job.capture.selectedKeyframeCount || manifest?.preview?.selectedKeyframeCount || 0}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Extracted frames</p>
                <p className="mt-2 text-sm font-medium text-white">{job.capture.extractedFrameCount || manifest?.preview?.extractedFrameCount || 0}</p>
              </div>
            </div>

            {typeof job.metadata?.lastError === 'string' && (
              <div className="mt-6 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                {job.metadata.lastError}
              </div>
            )}
          </section>

          <section className="space-y-6">
            <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
              <h2 className="text-lg font-semibold">Pipeline stages</h2>
              <div className="mt-4 space-y-3">
                {job.stages.map((stage) => (
                  <div key={stage.id} className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-white">{stage.label}</p>
                        <p className="mt-1 text-xs text-slate-400">{stage.systems.join(' • ')}</p>
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-200">{stage.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
              <h2 className="text-lg font-semibold">Artifacts</h2>
              <div className="mt-4 space-y-3">
                {artifactLinks.length > 0 ? artifactLinks.map((artifact) => (
                  <a
                    key={artifact.label}
                    href={artifact.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-900/70 px-4 py-3 text-sm text-slate-200 hover:border-cyan-400/40 hover:text-white transition-colors"
                  >
                    <span>{artifact.label}</span>
                    <span aria-hidden="true">↗</span>
                  </a>
                )) : (
                  <p className="text-sm text-slate-400">
                    Native geometry artifacts have not been written yet. Once the separate GCP workers publish a viewer bundle or mesh, this page will switch into the interactive viewer automatically.
                  </p>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default RoomTourViewPage;