import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  attachRoomTourMetadata,
  createRoomTourJob,
  queueRoomTourProcessing,
  uploadRoomTourVideo,
} from '../services/roomTourService';
import { RoomTourJob } from '../types/roomTour';

interface RoomTourVideoCaptureProps {
  roomName: string;
  propertyId?: string;
  onComplete: (job: RoomTourJob) => void;
  onCancel: () => void;
}

function getSupportedMimeType(): string {
  const mimeTypes = [
    'video/mp4;codecs=h264',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  for (const mimeType of mimeTypes) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return '';
}

const RoomTourVideoCapture: React.FC<RoomTourVideoCaptureProps> = ({
  roomName,
  propertyId,
  onComplete,
  onCancel,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number | null>(null);

  const [isInitializing, setIsInitializing] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('Preparing mobile tour capture...');

  const supportedMimeType = useMemo(() => getSupportedMimeType(), []);
  const hasCompletedRecording = Boolean(recordedBlob && !isRecording);
  const controlDockStyle = {
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
  };
  const statusCardStyle = {
    bottom: hasCompletedRecording
      ? 'calc(env(safe-area-inset-bottom, 0px) + 108px)'
      : 'calc(env(safe-area-inset-bottom, 0px) + 164px)',
  };
  const reviewCardStyle = {
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 176px)',
  };

  useEffect(() => {
    let active = true;

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });

        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try {
            await videoRef.current.play();
          } catch (playError: any) {
            // iOS Safari sometimes rejects play() with AbortError even when the
            // camera preview is already rendering. This is not a real failure —
            // ignore AbortError specifically; surface anything else (e.g. NotAllowedError).
            if (playError.name !== 'AbortError') {
              throw playError;
            }
          }
        }

        if (active) {
          setStatusMessage('Camera ready. Walk slowly through the unit and capture the full tour.');
        }
      } catch (cameraError: any) {
        if (active) {
          setError(cameraError.message || 'Unable to access the camera.');
        }
      } finally {
        if (active) {
          setIsInitializing(false);
        }
      }
    };

    startCamera();

    return () => {
      active = false;

      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;

      // Clear the video element so a re-mount starts clean
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (recordedUrl) {
        URL.revokeObjectURL(recordedUrl);
      }
    };
  }, [recordedUrl]);

  useEffect(() => {
    let intervalId: number | null = null;

    if (isRecording) {
      intervalId = window.setInterval(() => {
        if (startTimeRef.current) {
          setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }
      }, 250);
    }

    return () => {
      if (intervalId) {
        window.clearInterval(intervalId);
      }
    };
  }, [isRecording]);

  const beginRecording = () => {
    if (!streamRef.current) {
      setError('Camera is not ready yet.');
      return;
    }

    try {
      chunksRef.current = [];
      setRecordedBlob(null);
      setRecordedUrl((currentUrl) => {
        if (currentUrl) {
          URL.revokeObjectURL(currentUrl);
        }
        return null;
      });

      const recorder = supportedMimeType
        ? new MediaRecorder(streamRef.current, { mimeType: supportedMimeType })
        : new MediaRecorder(streamRef.current);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
        const url = URL.createObjectURL(blob);
        setRecordedBlob(blob);
        setRecordedUrl(url);
        setStatusMessage('Capture complete. Review and upload to start GCP processing.');
      };

      recorderRef.current = recorder;
      startTimeRef.current = Date.now();
      setElapsedSeconds(0);
      setError(null);
      setStatusMessage('Recording walkthrough video... keep a slow pace and cover each doorway.');
      recorder.start(1000);
      setIsRecording(true);
    } catch (recordError: any) {
      setError(recordError.message || 'Failed to start recording.');
    }
  };

  const stopRecording = () => {
    if (!recorderRef.current) {
      return;
    }

    recorderRef.current.stop();
    setIsRecording(false);
  };

  const handleSubmit = async () => {
    if (!recordedBlob) {
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      setStatusMessage('Creating room tour job...');

      const fileExtension = recordedBlob.type.includes('mp4') ? 'mp4' : 'webm';
      const videoFile = new File([recordedBlob], `room-tour-${Date.now()}.${fileExtension}`, {
        type: recordedBlob.type || 'video/webm',
      });

      const job = await createRoomTourJob({
        roomName,
        propertyId,
        captureMode: 'video_walkthrough',
        devicePlatform: navigator.userAgent,
        notes: 'Captured through QR-linked mobile room scanner flow.',
      });

      setStatusMessage('Uploading walkthrough video...');
      setUploadProgress(0);
      await uploadRoomTourVideo(job.id, videoFile, (pct) => {
        setUploadProgress(pct);
        setStatusMessage(`Uploading video... ${pct}%`);
      });

      setStatusMessage('Attaching capture metadata...');
      await attachRoomTourMetadata(job.id, {
        roomName,
        propertyId,
        captureMode: 'video_walkthrough',
        recordedAt: new Date().toISOString(),
        durationMs: elapsedSeconds * 1000,
        mimeType: videoFile.type,
        supportsMediaRecorderMimeType: supportedMimeType || 'browser_default',
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        device: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language,
        },
      });

      setStatusMessage('Queueing GCP processing plan...');
      const queuedJob = await queueRoomTourProcessing(job.id, {
        depthRegularizer: 'metric3d_v2',
        optionalOutputs: ['tour_manifest'],
        roomAwareProcessing: true,
        useArPoses: true,
      });

      onComplete(queuedJob);
    } catch (submitError: any) {
      setError(submitError.message || 'Failed to upload room tour video.');
      setStatusMessage('Upload failed. You can retry with the recorded clip.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 bg-black/70 text-white">
        <div>
          <h2 className="text-lg font-semibold">Video Room Tour</h2>
          <p className="text-xs text-white/70">Capture a slow walkthrough for the new GCP tour pipeline</p>
        </div>
        <button
          onClick={onCancel}
          className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
          aria-label="Close video room tour capture"
        >
          <svg className="w-6 h-6 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="relative flex-1 bg-black">
        <video ref={videoRef} className="w-full h-full object-cover" muted playsInline autoPlay />

        <div className="absolute top-4 left-4 right-4 flex items-center justify-between gap-3">
          <div className="px-3 py-2 rounded-full bg-black/55 text-white text-sm">
            {isRecording ? `Recording ${elapsedSeconds}s` : 'Ready to capture'}
          </div>
          <div className="px-3 py-2 rounded-full bg-black/55 text-white text-sm text-right">
            Slow pace. Cover each doorway.
          </div>
        </div>

        {recordedUrl && !isRecording && (
          <div className="absolute inset-x-4 bg-black/65 text-white rounded-2xl p-4" style={reviewCardStyle}>
            <p className="text-sm font-medium mb-2">Recorded clip ready</p>
            <video src={recordedUrl} controls className="w-full rounded-xl max-h-52 object-cover" />
          </div>
        )}

        {(error || statusMessage) && (
          <div className="absolute inset-x-4 bg-white rounded-2xl p-4 shadow-xl" style={statusCardStyle}>
            <p className="text-sm font-medium text-gray-900">{statusMessage}</p>
            {isSubmitting && uploadProgress > 0 && uploadProgress < 100 && (
              <div className="mt-2">
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">{uploadProgress}% uploaded</p>
              </div>
            )}
            {error && <p className="text-sm text-red-600 mt-1">{error}</p>}
            <p className="text-xs text-gray-500 mt-2">
              Best results: keep the phone upright, move steadily, and pause briefly in each doorway.
            </p>
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 z-10 px-4 pt-3 pointer-events-none" style={controlDockStyle}>
          {!hasCompletedRecording && (
            <div className="mx-auto flex max-w-md flex-col items-center gap-3 pointer-events-auto">
              {!isRecording && (
                <button
                  onClick={beginRecording}
                  disabled={isInitializing || isSubmitting}
                  className="w-24 h-24 rounded-full bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:text-gray-300 border-4 border-white/90 shadow-2xl flex flex-col items-center justify-center text-white transition-colors"
                >
                  <span className="text-[11px] font-semibold tracking-[0.24em] uppercase">
                    {isInitializing ? 'Wait' : 'Start'}
                  </span>
                  <span className="mt-1 w-4 h-4 rounded-full bg-white/90" />
                </button>
              )}

              {isRecording && (
                <button
                  onClick={stopRecording}
                  className="w-24 h-24 rounded-full bg-white text-gray-900 border-4 border-red-500 shadow-2xl flex flex-col items-center justify-center font-semibold"
                >
                  <span className="text-[11px] tracking-[0.24em] uppercase text-gray-500">Stop</span>
                  <span className="mt-1 w-5 h-5 rounded-md bg-red-500" />
                </button>
              )}

              <div className="rounded-full bg-black/70 backdrop-blur-md px-4 py-2 shadow-xl text-white text-xs font-medium">
                {isInitializing
                  ? 'Preparing camera access...'
                  : isRecording
                    ? 'Tap stop when the walkthrough is complete.'
                    : 'Tap the shutter to start recording the tour.'}
              </div>
            </div>
          )}

          {hasCompletedRecording && (
            <div className="max-w-md mx-auto rounded-3xl bg-black/70 backdrop-blur-md p-4 shadow-2xl pointer-events-auto">
              <div className="flex items-center justify-center gap-3 flex-wrap">
                <button
                  onClick={beginRecording}
                  disabled={isSubmitting}
                  className="px-5 py-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
                >
                  Re-record
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  className="px-6 py-4 rounded-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-800 font-semibold transition-colors"
                >
                  {isSubmitting ? 'Uploading...' : 'Upload and Queue Tour'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default RoomTourVideoCapture;