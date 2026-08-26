/**
 * AnalyzePropertyModal — individual property analysis input: address, list
 * price, photos (25-30 recommended), key assumptions. Streams engine
 * progress, then hands the DealReport to the parent.
 */

import React, { useCallback, useRef, useState } from 'react';
import { dealEngine, type DealReportData } from '../../services/dealEngineClient';

interface AnalyzePropertyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (report: DealReportData) => void;
}

const STAGE_LABELS: Record<string, string> = {
  data: 'Pulling property, market & macro data',
  valuation: 'Running comps & blended valuation',
  rental: 'Underwriting rental income',
  renovation: 'Analyzing photos for renovation upside',
  underwrite: 'Building scenarios & 30-yr projections',
  score: 'Scoring the deal',
  done: 'Done',
};

const STAGE_ORDER = ['data', 'valuation', 'rental', 'renovation', 'underwrite', 'score', 'done'];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const AnalyzePropertyModal: React.FC<AnalyzePropertyModalProps> = ({ isOpen, onClose, onComplete }) => {
  const [address, setAddress] = useState('');
  const [listPrice, setListPrice] = useState('');
  const [downPct, setDownPct] = useState('20');
  const [rate, setRate] = useState('7');
  const [photos, setPhotos] = useState<string[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [stageDetail, setStageDetail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/')).slice(0, 30 - photos.length);
    const dataUrls = await Promise.all(list.map(fileToDataUrl));
    setPhotos((prev) => [...prev, ...dataUrls].slice(0, 30));
  }, [photos.length]);

  const handleAnalyze = async () => {
    if (!address.trim()) {
      setError('Enter a property address.');
      return;
    }
    setError(null);
    setAnalyzing(true);
    setCurrentStage('data');
    try {
      const report = await dealEngine.analyzeProperty(
        {
          address: address.trim(),
          listPrice: listPrice ? parseFloat(listPrice.replace(/[$,]/g, '')) : null,
          photos,
          assumptions: {
            downPaymentPercent: parseFloat(downPct) || 20,
            interestRate: parseFloat(rate) || 7,
          },
        },
        (stage, detail) => {
          setCurrentStage(stage);
          setStageDetail(detail);
        },
      );
      onComplete(report);
      setAnalyzing(false);
      setCurrentStage(null);
    } catch (err: any) {
      setError(err?.message || 'Analysis failed');
      setAnalyzing(false);
      setCurrentStage(null);
    }
  };

  if (!isOpen) return null;

  const stageIndex = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={analyzing ? undefined : onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Analyze a Property</h2>
            <p className="text-xs text-slate-500">Comps, renovation upside, BRRRR scenarios, cash flow & returns</p>
          </div>
          <button onClick={onClose} disabled={analyzing} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40">✕</button>
        </div>

        {!analyzing ? (
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr,160px]">
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Address</label>
                <input
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300"
                  placeholder="123 Main St, Columbus, OH 43004"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">List Price</label>
                <input
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300"
                  placeholder="$350,000"
                  value={listPrice}
                  onChange={(e) => setListPrice(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Down Payment %</label>
                <input
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-emerald-400"
                  value={downPct}
                  onChange={(e) => setDownPct(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Interest Rate %</label>
                <input
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-emerald-400"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
              </div>
            </div>

            <div
              className="cursor-pointer rounded-xl border-2 border-dashed border-slate-300 p-5 text-center transition-colors hover:border-emerald-400 hover:bg-emerald-50/40"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addFiles(e.dataTransfer.files);
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && addFiles(e.target.files)}
              />
              <div className="text-sm font-semibold text-slate-700">+ Add Property Photos</div>
              <div className="mt-1 text-xs text-slate-500">25–30 recommended — drives the AI renovation & condition analysis. Optional but powerful.</div>
              {photos.length > 0 && (
                <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                  {photos.map((p, i) => (
                    <div key={i} className="group relative h-12 w-12 overflow-hidden rounded-md border">
                      <img src={p} alt="" className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPhotos((prev) => prev.filter((_, idx) => idx !== i));
                        }}
                        className="absolute inset-0 hidden items-center justify-center bg-black/50 text-xs text-white group-hover:flex"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

            <button
              type="button"
              onClick={handleAnalyze}
              className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-lg hover:from-blue-700 hover:to-indigo-700"
            >
              Analyze
            </button>
          </div>
        ) : (
          <div className="p-6">
            <div className="space-y-3">
              {STAGE_ORDER.filter((s) => s !== 'done').map((stage) => {
                const idx = STAGE_ORDER.indexOf(stage);
                const isDone = stageIndex > idx;
                const isActive = stageIndex === idx;
                return (
                  <div key={stage} className="flex items-center gap-3">
                    <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${isDone ? 'bg-emerald-500 text-white' : isActive ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                      {isDone ? '✓' : isActive ? (
                        <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      ) : idx + 1}
                    </div>
                    <div>
                      <div className={`text-sm font-medium ${isActive ? 'text-blue-700' : isDone ? 'text-slate-700' : 'text-slate-400'}`}>
                        {STAGE_LABELS[stage]}
                      </div>
                      {isActive && stageDetail && <div className="text-xs text-slate-500">{stageDetail}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
