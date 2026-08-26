import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getSelectedInsuranceProperty, insurancePacketClient, setSelectedInsuranceProperty } from '../../services/insurancePacketClient';
import type { InsurancePacketSnapshot } from '../../types/iot';

type ChecklistGroup = {
  title: string;
  description: string;
  complete: boolean;
  items: Array<{ label: string; complete: boolean; detail?: string }>;
  actionLabel: string;
  action: 'auto' | 'certificate' | 'recertification' | 'send';
};

const PacketChecklist: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = (location.state as { propertyId?: string; propertyAddress?: string } | null) || null;
  const stored = getSelectedInsuranceProperty();
  const propertyId = routeState.propertyId || stored?.propertyId || '';
  const [snapshot, setSnapshot] = useState<InsurancePacketSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [automating, setAutomating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user?.id || !propertyId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await insurancePacketClient.getSnapshot(user.id, propertyId);
      setSnapshot(next);
      setSelectedInsuranceProperty({ propertyId, address: next.property.address });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the packet checklist');
    } finally {
      setLoading(false);
    }
  }, [propertyId, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo<ChecklistGroup[]>(() => {
    if (!snapshot) return [];
    const c = snapshot.commissioning || ({} as InsurancePacketSnapshot['commissioning']);
    // Older running API instances can briefly return a snapshot without the
    // newly added evidence sections during hot reload. Treat those as pending.
    const evidence: Partial<InsurancePacketSnapshot['monitoringEvidence']> = snapshot.monitoringEvidence || {};
    const sensors = snapshot.sensors || [];
    const annualCertification = snapshot.annualCertification || null;
    const systemItems = [
      { label: 'Property and owner profile', complete: Boolean(snapshot.property.address && snapshot.insuredContact.name) },
      { label: 'Enrolled equipment inventory', complete: sensors.length > 0 && (c.componentInventory || []).length > 0, detail: `${sensors.length} enrolled device(s)` },
      { label: 'Observed monitoring history', complete: Number(evidence.observationCount || 0) > 0, detail: `${Number(evidence.observationCount || 0).toLocaleString()} telemetry observation(s)` },
      { label: 'Current controller connectivity', complete: sensors.some((sensor) => sensor.type === 'automatic_shutoff_controller' && sensor.online) },
    ];
    const installItems = [
      { label: 'Carrier and policy', complete: Boolean(c.insurerName) },
      { label: 'Installer and installation date', complete: Boolean(c.installDate && (c.installerName || c.installerCompany)) },
      { label: 'Valve, relay, serials, and main-line location', complete: Boolean(c.hardwareModel && c.shutoffSerialNumber && c.relaySerialNumber && c.valveLocation && c.primaryWaterLineLocation) },
      { label: 'Installation photos and invoice', complete: Boolean((c.evidencePhotoUrls || []).length && (c.invoiceDocumentUrls || []).length) },
    ];
    const testItems = [
      { label: 'Leak alert, remote command, shutoff, stopped-flow, and restoration test', complete: Boolean(c.latestSuccessfulTestDate && c.remoteCommandVerifiedAt && c.leakAlertVerifiedAt && c.unattendedShutoffVerified && c.waterFlowStoppedVerified && c.waterServiceRestoredVerified) },
      { label: 'Installer e-signature', complete: c.attestationStatus === 'completed' },
    ];
    const recertItems = [
      { label: 'Annual guided functional recertification', complete: annualCertification?.packetEligible === true, detail: annualCertification?.status?.replace(/_/g, ' ') || 'not started' },
    ];
    return [
      {
        title: '1. HouseYield-generated system evidence',
        description: 'Generated from property records and IoT telemetry. This button saves only observed facts — it never invents installation or test evidence.',
        complete: systemItems.every((item) => item.complete),
        items: systemItems,
        actionLabel: 'Refresh System Evidence',
        action: 'auto',
      },
      {
        title: '2. Installation and carrier evidence',
        description: 'These items must be supplied from the installation record, invoice, and photos.',
        complete: installItems.every((item) => item.complete),
        items: installItems,
        actionLabel: 'Complete Installation Evidence',
        action: 'certificate',
      },
      {
        title: '3. Functional commissioning',
        description: 'A real controlled test is required before the packet can state that automatic shutoff works.',
        complete: testItems.every((item) => item.complete),
        items: testItems,
        actionLabel: 'Record Commissioning Test',
        action: 'certificate',
      },
      {
        title: '4. Annual recertification',
        description: 'A signed guided annual test keeps the protection claim current and is required for sealed issuance.',
        complete: recertItems.every((item) => item.complete),
        items: recertItems,
        actionLabel: 'Run Annual Recertification',
        action: 'recertification',
      },
    ];
  }, [snapshot]);

  const autoComplete = async () => {
    if (!propertyId) return;
    setAutomating(true);
    setNotice(null);
    try {
      const result = await insurancePacketClient.applyAutomatedPacketEvidence(propertyId);
      setSnapshot(result.snapshot);
      setNotice(result.completed.length
        ? `Added ${result.completed.length} verified system-evidence item${result.completed.length === 1 ? '' : 's'} from HouseYield data.`
        : 'System evidence is already current. The remaining items need field evidence, a controlled test, or a signature.');
    } catch (autoError) {
      setError(autoError instanceof Error ? autoError.message : 'Could not refresh system evidence');
    } finally {
      setAutomating(false);
    }
  };

  const openCertificate = (recertification = false) => {
    if (!snapshot) return;
    navigate('/insurance-discount/certificate', {
      state: {
        propertyId,
        propertyAddress: snapshot.property.address,
        ...(recertification ? { recertification: true } : {}),
      },
    });
  };

  if (loading) return <div className="p-12 text-center text-slate-600">Loading packet checklist…</div>;
  if (!user?.id || !propertyId) return <div className="mx-auto max-w-4xl p-6 text-slate-700">Choose a property before completing its insurance packet.</div>;
  if (!snapshot) return <div className="mx-auto max-w-4xl p-6 text-red-700">{error || 'The packet checklist could not be loaded.'}</div>;

  const ready = snapshot.commissioningStatus.readyForSubmission;
  const completedGroups = groups.filter((group) => group.complete).length;
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="rounded-2xl bg-slate-950 p-8 text-white">
        <div className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-300">Insurance packet checklist</div>
        <h1 className="mt-2 text-3xl font-bold">Complete evidence for {snapshot.property.address}</h1>
        <p className="mt-3 max-w-3xl text-slate-300">HouseYield fills what it can verify from property and device data. The remaining evidence is intentionally assigned to the person who can prove installation and real-world operation.</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <div className="rounded-lg bg-white/10 px-4 py-3"><div className="text-xs text-slate-300">Packet progress</div><div className="text-xl font-bold">{snapshot.commissioningStatus.completionPercent}%</div></div>
          <div className="rounded-lg bg-white/10 px-4 py-3"><div className="text-xs text-slate-300">Checklist sections</div><div className="text-xl font-bold">{completedGroups} / {groups.length}</div></div>
          <div className="rounded-lg bg-white/10 px-4 py-3"><div className="text-xs text-slate-300">Submission state</div><div className="text-xl font-bold">{ready ? 'Ready' : 'Evidence needed'}</div></div>
        </div>
      </div>

      {(notice || error) && <div className={`rounded-lg border p-4 text-sm ${error ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{error || notice}</div>}

      <div className="space-y-4">
        {groups.map((group) => (
          <section key={group.title} className={`rounded-xl border p-5 ${group.complete ? 'border-emerald-200 bg-emerald-50/30' : 'border-slate-200 bg-white'}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">{group.title}</h2>
                <p className="mt-1 max-w-3xl text-sm text-slate-600">{group.description}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${group.complete ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{group.complete ? 'Complete' : 'Action needed'}</span>
            </div>
            <div className="mt-4 space-y-2">
              {group.items.map((item) => <div key={item.label} className="flex items-start gap-3 rounded-lg border border-slate-100 bg-white px-3 py-2 text-sm">
                <span className={item.complete ? 'text-emerald-600' : 'text-slate-400'}>{item.complete ? '✓' : '○'}</span>
                <div><div className="font-medium text-slate-800">{item.label}</div>{item.detail && <div className="text-xs capitalize text-slate-500">{item.detail}</div>}</div>
              </div>)}
            </div>
            {!group.complete && <button type="button" disabled={automating && group.action === 'auto'} onClick={() => group.action === 'auto' ? void autoComplete() : openCertificate(group.action === 'recertification')} className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {automating && group.action === 'auto' ? 'Refreshing…' : group.actionLabel}
            </button>}
          </section>
        ))}
      </div>

      <div className="flex flex-wrap justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5">
        <button type="button" onClick={() => void load()} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Refresh checklist</button>
        <button type="button" disabled={!ready} onClick={() => navigate('/insurance-discount/select-insurer', { state: { propertyId, propertyAddress: snapshot.property.address } })} className="rounded-lg bg-blue-700 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {ready ? 'Choose Carrier and Send Packet' : 'Complete Required Evidence to Send'}
        </button>
      </div>
    </div>
  );
};

export default PacketChecklist;
