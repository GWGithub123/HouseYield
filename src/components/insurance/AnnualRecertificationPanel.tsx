import React, { useEffect, useMemo, useState } from 'react';
import { insurancePacketClient } from '../../services/insurancePacketClient';
import { uploadInsurancePacketEvidence } from '../../services/storageService';
import type {
  WaterMitigationCertification,
  WaterMitigationCertificationSummary,
  WaterMitigationTestResult,
} from '../../types/iot';

const EMPTY_SUMMARY: WaterMitigationCertificationSummary = {
  status: 'not_certified',
  packetEligible: false,
  latest: null,
  latestCertified: null,
  records: [],
  currentInventoryFingerprint: '',
  inventoryChanged: false,
  recertificationRequired: false,
  requiredReason: null,
  requiredAt: null,
  expiresAt: null,
  nextDueAt: null,
  daysUntilDue: null,
  protocolVersion: 'HY-WM-ANNUAL-1.0',
  validForDays: 365,
  latestAutomatedHealthCheck: null,
};

interface AnnualRecertificationPanelProps {
  ownerId: string;
  propertyId: string;
  summary?: WaterMitigationCertificationSummary | null;
  installerDefaults?: {
    name?: string;
    company?: string;
    email?: string;
    phone?: string;
    licenseNumber?: string;
  };
  onChanged: () => Promise<void>;
}

const resultStyles: Record<WaterMitigationTestResult, string> = {
  pending: 'border-slate-200 bg-white',
  passed: 'border-emerald-200 bg-emerald-50',
  failed: 'border-red-200 bg-red-50',
  not_applicable: 'border-blue-200 bg-blue-50',
};

const statusStyles: Record<string, string> = {
  certified: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  expiring_soon: 'border-amber-200 bg-amber-50 text-amber-900',
  in_progress: 'border-blue-200 bg-blue-50 text-blue-900',
  pending_signature: 'border-violet-200 bg-violet-50 text-violet-900',
  failed: 'border-red-200 bg-red-50 text-red-900',
  integrity_failed: 'border-red-200 bg-red-50 text-red-900',
  expired: 'border-red-200 bg-red-50 text-red-900',
  retest_required: 'border-amber-200 bg-amber-50 text-amber-900',
  not_certified: 'border-slate-200 bg-slate-50 text-slate-900',
};

const AnnualRecertificationPanel: React.FC<AnnualRecertificationPanelProps> = ({
  ownerId,
  propertyId,
  summary: summaryProp,
  installerDefaults,
  onChanged,
}) => {
  const summary = summaryProp || EMPTY_SUMMARY;
  const [certification, setCertification] = useState<WaterMitigationCertification | null>(
    summary.latest && ['in_progress', 'failed', 'pending_signature'].includes(summary.latest.status)
      ? summary.latest
      : null,
  );
  const [technician, setTechnician] = useState({
    name: installerDefaults?.name || '',
    company: installerDefaults?.company || '',
    email: installerDefaults?.email || '',
    phone: installerDefaults?.phone || '',
    licenseNumber: installerDefaults?.licenseNumber || '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const editable = Boolean(certification && ['in_progress', 'failed'].includes(certification.status));
  const completion = certification?.testSummary.completionPercent || 0;
  const testedCount = useMemo(
    () => certification?.steps.filter((step) => step.result !== 'pending').length || 0,
    [certification],
  );
  const readyForSignature = useMemo(
    () => Boolean(certification?.steps.every((step) =>
      !step.required || step.result === 'passed' || (step.allowNotApplicable && step.result === 'not_applicable' && step.notes.trim()),
    )),
    [certification],
  );

  useEffect(() => {
    const latest = summary?.latest;
    if (latest && ['in_progress', 'failed', 'pending_signature'].includes(latest.status)) {
      setCertification(latest);
    }
  }, [summary]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'The recertification action failed');
    } finally {
      setBusy(false);
    }
  };

  const startCertification = () => runAction(async () => {
    if (!technician.name || !technician.email) {
      throw new Error('Technician name and email are required to begin.');
    }
    const response = await insurancePacketClient.startRecertification(
      propertyId,
      technician,
      summary.requiredReason || 'annual_due',
    );
    setCertification(response.certification);
    setMessage(response.reused ? 'Existing inspection reopened.' : 'Guided annual inspection started.');
    await onChanged();
  });

  const updateStep = (
    stepId: string,
    field: 'result' | 'notes' | 'testedBy',
    value: string,
  ) => {
    setCertification((current) => current ? {
      ...current,
      steps: current.steps.map((step) => step.id === stepId
        ? {
            ...step,
            [field]: value,
            testedAt: field === 'result' && value !== 'pending'
              ? new Date().toISOString()
              : step.testedAt,
          }
        : step),
    } : current);
  };

  const uploadStepEvidence = (stepId: string, files: FileList | null) => runAction(async () => {
    if (!certification || !files?.length) return;
    const urls: string[] = [];
    for (const file of Array.from(files)) {
      const result = await uploadInsurancePacketEvidence(ownerId, propertyId, 'supporting', file);
      if (!result.success || !result.downloadURL) throw new Error(result.error || `Failed to upload ${file.name}`);
      urls.push(result.downloadURL);
    }
    setCertification((current) => current ? {
      ...current,
      steps: current.steps.map((step) => step.id === stepId
        ? { ...step, evidenceUrls: [...step.evidenceUrls, ...urls] }
        : step),
    } : current);
    setMessage(`${urls.length} test evidence file${urls.length === 1 ? '' : 's'} attached. Save the inspection.`);
  });

  const saveCertification = () => runAction(async () => {
    if (!certification) return;
    const response = await insurancePacketClient.updateRecertification(propertyId, certification);
    setCertification(response.certification);
    setMessage('Inspection progress saved with server timestamps.');
    await onChanged();
  });

  const requestSignature = () => runAction(async () => {
    if (!certification) return;
    const saved = await insurancePacketClient.updateRecertification(propertyId, certification);
    const response = await insurancePacketClient.requestRecertificationSignature(propertyId, saved.certification.id);
    setCertification(response.certification);
    setMessage('Sealed technician attestation created. Complete the e-signature to activate the certificate.');
    if (response.signingUrl) window.open(response.signingUrl, '_blank', 'noopener,noreferrer');
    await onChanged();
  });

  return (
    <div className="rounded-xl border border-slate-300 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-700">Annual risk-control inspection</div>
          <h2 className="mt-1 text-xl font-semibold text-slate-950">Water-Loss Protection System Recertification</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            A guided functional inspection modeled as a recurring risk-control record. It verifies actual operation; it is not a code inspection or carrier guarantee.
          </p>
        </div>
        <div className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide ${statusStyles[summary.status] || statusStyles.not_certified}`}>
          {summary.status.replace(/_/g, ' ')}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-slate-500">Protocol</div><div className="font-semibold">{summary.protocolVersion}</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-slate-500">Valid period</div><div className="font-semibold">{summary.validForDays} days</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-slate-500">Expires / due</div><div className="font-semibold">{summary.expiresAt ? new Date(summary.expiresAt).toLocaleDateString() : 'Not certified'}</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-slate-500">Inventory change</div><div className="font-semibold">{summary.inventoryChanged ? 'Retest required' : 'No change detected'}</div></div>
      </div>

      {!certification && (
        <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h3 className="font-semibold text-slate-900">Start a controlled functional inspection</h3>
          <p className="mt-1 text-xs text-slate-600">Plan for a brief water interruption. Notify occupants and confirm that shutting off and restoring water is safe before testing.</p>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <input value={technician.name} onChange={(event) => setTechnician((current) => ({ ...current, name: event.target.value }))} placeholder="Technician name" className="rounded-lg border border-slate-300 px-3 py-2" />
            <input value={technician.company} onChange={(event) => setTechnician((current) => ({ ...current, company: event.target.value }))} placeholder="Company" className="rounded-lg border border-slate-300 px-3 py-2" />
            <input type="email" value={technician.email} onChange={(event) => setTechnician((current) => ({ ...current, email: event.target.value }))} placeholder="Technician email" className="rounded-lg border border-slate-300 px-3 py-2" />
            <input value={technician.licenseNumber} onChange={(event) => setTechnician((current) => ({ ...current, licenseNumber: event.target.value }))} placeholder="License / credential (if applicable)" className="rounded-lg border border-slate-300 px-3 py-2" />
          </div>
          <button type="button" disabled={busy} onClick={() => void startCertification()} className="mt-4 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Begin Annual Inspection
          </button>
        </div>
      )}

      {certification && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-950 px-4 py-3 text-white">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-300">Inspection {certification.id}</div>
              <div className="font-semibold">{testedCount} of {certification.steps.length} steps recorded · {completion}% complete</div>
            </div>
            <div className="text-sm capitalize">{certification.status.replace(/_/g, ' ')}</div>
          </div>

          <div className="mt-4 space-y-3">
            {certification.steps.map((step, index) => (
              <div key={step.id} className={`rounded-lg border p-4 ${resultStyles[step.result]}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="max-w-2xl">
                    <div className="font-semibold text-slate-950">{index + 1}. {step.label}</div>
                    <div className="mt-1 text-xs text-slate-600">{step.description}</div>
                  </div>
                  <select
                    value={step.result}
                    disabled={!editable || busy}
                    onChange={(event) => updateStep(step.id, 'result', event.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"
                  >
                    <option value="pending">Pending</option>
                    <option value="passed">Passed</option>
                    <option value="failed">Failed</option>
                    {step.allowNotApplicable && <option value="not_applicable">Not applicable</option>}
                  </select>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <input value={step.testedBy} disabled={!editable} onChange={(event) => updateStep(step.id, 'testedBy', event.target.value)} placeholder="Person who performed this step" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" />
                  <input type="file" accept="image/*,.pdf" multiple disabled={!editable || busy} onChange={(event) => void uploadStepEvidence(step.id, event.target.files)} className="block w-full text-xs text-slate-600" />
                  <textarea value={step.notes} disabled={!editable} onChange={(event) => updateStep(step.id, 'notes', event.target.value)} rows={2} placeholder={step.allowNotApplicable ? 'Notes or required not-applicable explanation' : 'Observed result, measurement, event ID, or repair detail'} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm md:col-span-2" />
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                  {step.testedAt && <span>Recorded: {new Date(step.testedAt).toLocaleString()}</span>}
                  {step.evidenceUrls.length > 0 && <span>{step.evidenceUrls.length} evidence file(s)</span>}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {editable && (
              <button type="button" disabled={busy} onClick={() => void saveCertification()} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                Save Inspection Progress
              </button>
            )}
            {editable && (
              <button type="button" disabled={busy || !readyForSignature} onClick={() => void requestSignature()} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
                Seal and Request Technician Signature
              </button>
            )}
            {certification.attestationSigningUrl && certification.status === 'pending_signature' && (
              <a href={certification.attestationSigningUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold text-blue-700 underline">Open secure signing link</a>
            )}
          </div>
          {!readyForSignature && editable && (
            <p className="mt-2 text-xs text-amber-700">Every required step must pass or have an allowed, explained not-applicable result before the record can be sealed.</p>
          )}
        </div>
      )}

      {(message || error) && (
        <div className={`mt-4 rounded-lg border p-3 text-sm ${error ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
          {error || message}
        </div>
      )}
    </div>
  );
};

export default AnnualRecertificationPanel;
