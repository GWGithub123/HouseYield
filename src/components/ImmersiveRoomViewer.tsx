import React, { useEffect, useMemo, useState } from 'react';
import type { CapturedFrame } from '../types/roomScanner';

interface ImmersiveRoomViewerProps {
  frames: CapturedFrame[];
  roomName?: string;
  onClose?: () => void;
  autoRotate?: boolean;
  showMinimap?: boolean;
  enableGyroscope?: boolean;
}

const ImmersiveRoomViewer: React.FC<ImmersiveRoomViewerProps> = ({
  frames,
  roomName = 'Room Scan',
  onClose,
  autoRotate = false,
  showMinimap = true,
  enableGyroscope = false,
}) => {
  const orderedFrames = useMemo(() => {
    return [...frames].sort((left, right) => {
      const leftAlpha = left.orientation?.alpha ?? 0;
      const rightAlpha = right.orientation?.alpha ?? 0;
      return leftAlpha - rightAlpha;
    });
  }, [frames]);

  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (!autoRotate || orderedFrames.length <= 1) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setCurrentIndex((previousIndex) => (previousIndex + 1) % orderedFrames.length);
    }, 2500);

    return () => window.clearInterval(intervalId);
  }, [autoRotate, orderedFrames.length]);

  const currentFrame = orderedFrames[currentIndex];

  if (!currentFrame) {
    return null;
  }

  const frameImage = currentFrame.imageData.startsWith('data:')
    ? currentFrame.imageData
    : `data:image/jpeg;base64,${currentFrame.imageData}`;

  return (
    <div className="fixed inset-0 z-50 bg-black text-white">
      <div className="absolute inset-0">
        <img
          src={frameImage}
          alt={roomName}
          className="h-full w-full object-contain bg-black"
        />
      </div>

      <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/80 to-transparent p-4">
        <div>
          <h2 className="text-lg font-semibold">{roomName}</h2>
          <p className="text-sm text-white/70">
            Frame {currentIndex + 1} of {orderedFrames.length}
            {enableGyroscope ? ' • Gyroscope enabled' : ''}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20"
        >
          Close
        </button>
      </div>

      {orderedFrames.length > 1 && (
        <>
          <button
            onClick={() => setCurrentIndex((previousIndex) => (previousIndex - 1 + orderedFrames.length) % orderedFrames.length)}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-black/50 px-4 py-3 text-2xl hover:bg-black/70"
            aria-label="Previous frame"
          >
            ‹
          </button>
          <button
            onClick={() => setCurrentIndex((previousIndex) => (previousIndex + 1) % orderedFrames.length)}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-black/50 px-4 py-3 text-2xl hover:bg-black/70"
            aria-label="Next frame"
          >
            ›
          </button>
        </>
      )}

      {showMinimap && orderedFrames.length > 1 && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-4">
          <div className="mx-auto flex max-w-5xl gap-2 overflow-x-auto rounded-xl bg-white/5 p-2">
            {orderedFrames.map((frame, index) => {
              const thumbnail = frame.imageData.startsWith('data:')
                ? frame.imageData
                : `data:image/jpeg;base64,${frame.imageData}`;

              return (
                <button
                  key={frame.id || `${frame.timestamp}-${index}`}
                  onClick={() => setCurrentIndex(index)}
                  className={`shrink-0 overflow-hidden rounded-lg border-2 ${
                    index === currentIndex ? 'border-emerald-400' : 'border-transparent'
                  }`}
                >
                  <img
                    src={thumbnail}
                    alt={`Frame ${index + 1}`}
                    className="h-16 w-24 object-cover"
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default ImmersiveRoomViewer;