import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getSelectedInsuranceProperty, insurancePacketClient } from '../../services/insurancePacketClient';
import { InsurancePacketSnapshot, WaterMitigationCommissioning } from '../../types/iot';
import {
  type InsuranceEvidenceCategory,
  uploadInsurancePacketEvidence,
} from '../../services/storageService';
import AnnualRecertificationPanel from './AnnualRecertificationPanel';

interface CertificateViewerProps {
  propertyId?: string;
}

type PacketTabId = 'insured' | 'installation' | 'testing' | 'evidence' | 'recert' | 'review';

const emptyForm = {
  insuredName: '',
  insuredEmail: '',
  insuredPhone: '',
  insurerName: '',
  policyNumber: '',
  installDate: '',
  installerName: '',
  installerCompany: '',
  installationMethod: 'Professional installation',
  installerLicenseNumber: '',
  installerEmail: '',
  installerPhone: '',
  hardwareModel: '',
  shutoffSerialNumber: '',
  relaySerialNumber: '',
  componentInventoryText: '',
  valveLocation: '',
  primaryWaterLineLocation: '',
  latestSuccessfulTestDate: '',
  remoteCommandVerifiedAt: '',
  leakAlertVerifiedAt: '',
  commandPathDescription: '',
  alertPathDescription: '',
  notes: '',
  batteryBackupInstalled: false,
  automaticLeakDetectionEnabled: true,
  automaticShutoffEnabled: true,
  unattendedShutoffVerified: false,
  manualOverrideVerified: false,
  waterFlowStoppedVerified: false,
  waterServiceRestoredVerified: false,
  valveTravelSeconds: '',
  testMethod: '',
  testPerformedBy: '',
  installationStandardized: false,
  maintenanceDocumented: false,
  wifiValidated: false,
  monitoringActive: false,
  installationPhotoCaptured: false,
  valvePhotoCaptured: false,
  sensorPhotoCaptured: false,
  modelLabelPhotosCaptured: false,
  evidencePhotoUrlsText: '',
  appScreenshotUrlsText: '',
  invoiceDocumentUrlsText: '',
  signedAttestationDocumentUrlsText: '',
  supportingDocumentUrlsText: '',
  attestationSignedAt: '',
  attestationSignerName: '',
  attestationSignerTitle: '',
  attestationSignerEmail: '',
  attestationConsentText: '',
  shellyPartnerStatus: 'not_documented',
  shellyCredentialId: '',
  shellyCredentialDocumentUrlsText: '',
  econetPartnerStatus: 'not_documented',
  econetCredentialId: '',
  econetCredentialDocumentUrlsText: '',
};

function splitMultiline(value: string): string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const CertificateViewer: React.FC<CertificateViewerProps> = ({ propertyId: propPropertyId }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const routeState = (location.state as { propertyId?: string; propertyAddress?: string } | null) || null;
  const storedProperty = getSelectedInsuranceProperty();
  const propertyId = propPropertyId || routeState?.propertyId || storedProperty?.propertyId || '';
  const propertyAddress = routeState?.propertyAddress || storedProperty?.address || '';
  const [snapshot, setSnapshot] = useState<InsurancePacketSnapshot | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [requestingSignature, setRequestingSignature] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id || !propertyId) {
      setLoading(false);
      return;
    }

    const loadSnapshot = async () => {
      try {
        const packetSnapshot = await insurancePacketClient.getSnapshot(user.id, propertyId);
        setSnapshot(packetSnapshot);
        hydrateForm(packetSnapshot.commissioning);
      } catch (loadError) {
        console.error('Failed to load certificate packet:', loadError);
        setError(loadError instanceof Error ? loadError.message : 'Failed to load property packet');
      } finally {
        setLoading(false);
      }
    };

    void loadSnapshot();
  }, [user?.id, propertyId]);

  const hydrateForm = (commissioning: WaterMitigationCommissioning) => {
    setForm({
      insuredName: commissioning.insuredName || '',
      insuredEmail: commissioning.insuredEmail || '',
      insuredPhone: commissioning.insuredPhone || '',
      insurerName: commissioning.insurerName || '',
      policyNumber: commissioning.policyNumber || '',
      installDate: commissioning.installDate || '',
      installerName: commissioning.installerName || '',
      installerCompany: commissioning.installerCompany || '',
      installationMethod: commissioning.installationMethod || 'Professional installation',
      installerLicenseNumber: commissioning.installerLicenseNumber || '',
      installerEmail: commissioning.installerEmail || '',
      installerPhone: commissioning.installerPhone || '',
      hardwareModel: commissioning.hardwareModel || '',
      shutoffSerialNumber: commissioning.shutoffSerialNumber || '',
      relaySerialNumber: commissioning.relaySerialNumber || '',
      componentInventoryText: commissioning.componentInventory.join('\n'),
      valveLocation: commissioning.valveLocation || '',
      primaryWaterLineLocation: commissioning.primaryWaterLineLocation || '',
      latestSuccessfulTestDate: commissioning.latestSuccessfulTestDate || '',
      remoteCommandVerifiedAt: commissioning.remoteCommandVerifiedAt || '',
      leakAlertVerifiedAt: commissioning.leakAlertVerifiedAt || '',
      commandPathDescription: commissioning.commandPathDescription || '',
      alertPathDescription: commissioning.alertPathDescription || '',
      notes: commissioning.notes || '',
      batteryBackupInstalled: commissioning.batteryBackupInstalled === true,
      automaticLeakDetectionEnabled: commissioning.automaticLeakDetectionEnabled !== false,
      automaticShutoffEnabled: commissioning.automaticShutoffEnabled !== false,
      unattendedShutoffVerified: commissioning.unattendedShutoffVerified === true,
      manualOverrideVerified: commissioning.manualOverrideVerified === true,
      waterFlowStoppedVerified: commissioning.waterFlowStoppedVerified === true,
      waterServiceRestoredVerified: commissioning.waterServiceRestoredVerified === true,
      valveTravelSeconds: commissioning.valveTravelSeconds == null ? '' : String(commissioning.valveTravelSeconds),
      testMethod: commissioning.testMethod || '',
      testPerformedBy: commissioning.testPerformedBy || '',
      installationStandardized: commissioning.installationStandardized === true,
      maintenanceDocumented: commissioning.maintenanceDocumented === true,
      wifiValidated: commissioning.wifiValidated === true,
      monitoringActive: commissioning.monitoringActive === true,
      installationPhotoCaptured: commissioning.installationPhotoCaptured === true,
      valvePhotoCaptured: commissioning.valvePhotoCaptured === true,
      sensorPhotoCaptured: commissioning.sensorPhotoCaptured === true,
      modelLabelPhotosCaptured: commissioning.modelLabelPhotosCaptured === true,
      evidencePhotoUrlsText: commissioning.evidencePhotoUrls.join('\n'),
      appScreenshotUrlsText: commissioning.appScreenshotUrls.join('\n'),
      invoiceDocumentUrlsText: commissioning.invoiceDocumentUrls.join('\n'),
      signedAttestationDocumentUrlsText: commissioning.signedAttestationDocumentUrls.join('\n'),
      supportingDocumentUrlsText: commissioning.supportingDocumentUrls.join('\n'),
      attestationSignedAt: commissioning.attestationSignedAt || '',
      attestationSignerName: commissioning.attestationSignerName || '',
      attestationSignerTitle: commissioning.attestationSignerTitle || '',
      attestationSignerEmail: commissioning.attestationSignerEmail || '',
      attestationConsentText: commissioning.attestationConsentText || '',
      shellyPartnerStatus: commissioning.shellyPartnerStatus || 'not_documented',
      shellyCredentialId: commissioning.shellyCredentialId || '',
      shellyCredentialDocumentUrlsText: (commissioning.shellyCredentialDocumentUrls || []).join('\n'),
      econetPartnerStatus: commissioning.econetPartnerStatus || 'not_documented',
      econetCredentialId: commissioning.econetCredentialId || '',
      econetCredentialDocumentUrlsText: (commissioning.econetCredentialDocumentUrls || []).join('\n'),
    });
  };

  const refreshSnapshot = async () => {
    if (!user?.id || !propertyId) {
      return;
    }
    const packetSnapshot = await insurancePacketClient.getSnapshot(user.id, propertyId);
    setSnapshot(packetSnapshot);
    hydrateForm(packetSnapshot.commissioning);
  };

  const handleSave = async () => {
    if (!user?.id || !propertyId) {
      return;
    }
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await insurancePacketClient.saveCommissioning(user.id, propertyId, {
        insuredName: form.insuredName,
        insuredEmail: form.insuredEmail,
        insuredPhone: form.insuredPhone,
        insurerName: form.insurerName,
        policyNumber: form.policyNumber,
        installDate: form.installDate,
        installerName: form.installerName,
        installerCompany: form.installerCompany,
        installationMethod: form.installationMethod,
        installerLicenseNumber: form.installerLicenseNumber,
        installerEmail: form.installerEmail,
        installerPhone: form.installerPhone,
        hardwareModel: form.hardwareModel,
        shutoffSerialNumber: form.shutoffSerialNumber,
        relaySerialNumber: form.relaySerialNumber,
        componentInventory: splitMultiline(form.componentInventoryText),
        valveLocation: form.valveLocation,
        primaryWaterLineLocation: form.primaryWaterLineLocation,
        latestSuccessfulTestDate: form.latestSuccessfulTestDate,
        remoteCommandVerifiedAt: form.remoteCommandVerifiedAt,
        leakAlertVerifiedAt: form.leakAlertVerifiedAt,
        commandPathDescription: form.commandPathDescription,
        alertPathDescription: form.alertPathDescription,
        notes: form.notes,
        batteryBackupInstalled: form.batteryBackupInstalled,
        automaticLeakDetectionEnabled: form.automaticLeakDetectionEnabled,
        automaticShutoffEnabled: form.automaticShutoffEnabled,
        unattendedShutoffVerified: form.unattendedShutoffVerified,
        manualOverrideVerified: form.manualOverrideVerified,
        waterFlowStoppedVerified: form.waterFlowStoppedVerified,
        waterServiceRestoredVerified: form.waterServiceRestoredVerified,
        valveTravelSeconds: form.valveTravelSeconds === '' ? null : Number(form.valveTravelSeconds),
        testMethod: form.testMethod,
        testPerformedBy: form.testPerformedBy,
        installationStandardized: form.installationStandardized,
        maintenanceDocumented: form.maintenanceDocumented,
        wifiValidated: form.wifiValidated,
        monitoringActive: form.monitoringActive,
        installationPhotoCaptured: form.installationPhotoCaptured,
        valvePhotoCaptured: form.valvePhotoCaptured,
        sensorPhotoCaptured: form.sensorPhotoCaptured,
        modelLabelPhotosCaptured: form.modelLabelPhotosCaptured,
        evidencePhotoUrls: splitMultiline(form.evidencePhotoUrlsText),
        appScreenshotUrls: splitMultiline(form.appScreenshotUrlsText),
        invoiceDocumentUrls: splitMultiline(form.invoiceDocumentUrlsText),
        signedAttestationDocumentUrls: splitMultiline(form.signedAttestationDocumentUrlsText),
        supportingDocumentUrls: splitMultiline(form.supportingDocumentUrlsText),
        attestationSignedAt: form.attestationSignedAt,
        attestationSignerName: form.attestationSignerName,
        attestationSignerTitle: form.attestationSignerTitle,
        attestationSignerEmail: form.attestationSignerEmail,
        attestationConsentText: form.attestationConsentText,
        shellyPartnerStatus: form.shellyPartnerStatus,
        shellyCredentialId: form.shellyCredentialId,
        shellyCredentialDocumentUrls: splitMultiline(form.shellyCredentialDocumentUrlsText),
        econetPartnerStatus: form.econetPartnerStatus,
        econetCredentialId: form.econetCredentialId,
        econetCredentialDocumentUrls: splitMultiline(form.econetCredentialDocumentUrlsText),
      });
      await refreshSnapshot();
      setMessage('Commissioning and evidence record saved.');
    } catch (saveError) {
      console.error('Failed to save commissioning record:', saveError);
      setError(saveError instanceof Error ? saveError.message : 'Failed to save commissioning record');
    } finally {
      setSaving(false);
    }
  };

  const handleEvidenceUpload = async (
    category: InsuranceEvidenceCategory,
    files: FileList | null,
    targetField:
      | 'evidencePhotoUrlsText'
      | 'appScreenshotUrlsText'
      | 'invoiceDocumentUrlsText'
      | 'signedAttestationDocumentUrlsText'
      | 'supportingDocumentUrlsText'
      | 'shellyCredentialDocumentUrlsText'
      | 'econetCredentialDocumentUrlsText',
  ) => {
    if (!user?.id || !propertyId || !files?.length) return;
    setUploadingEvidence(true);
    setError(null);
    try {
      const urls: string[] = [];
      for (const file of Array.from(files)) {
        const result = await uploadInsurancePacketEvidence(user.id, propertyId, category, file);
        if (!result.success || !result.downloadURL) {
          throw new Error(result.error || `Failed to upload ${file.name}`);
        }
        urls.push(result.downloadURL);
      }
      setForm((current) => ({
        ...current,
        [targetField]: [current[targetField], ...urls].filter(Boolean).join('\n'),
      }));
      setMessage(`${urls.length} evidence file${urls.length === 1 ? '' : 's'} uploaded. Save the record to include them in the packet.`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Failed to upload evidence');
    } finally {
      setUploadingEvidence(false);
    }
  };

  const handleDownload = async () => {
    if (!user?.id || !propertyId) {
      return;
    }
    await insurancePacketClient.downloadPdf(
      insurancePacketClient.buildCertificateDownloadUrl(user.id, propertyId),
      `HouseYield-Water-Shutoff-Commissioning-Certificate-${propertyId}.pdf`,
    );
  };

  const handleCombinedPacketDownload = async () => {
    if (!user?.id || !propertyId) return;
    await insurancePacketClient.downloadPdf(
      insurancePacketClient.buildCombinedPacketDownloadUrl(user.id, propertyId),
      `HouseYield-Insurance-Evidence-Packet-${propertyId}.pdf`,
    );
  };

  const handleRequestInstallerSignature = async () => {
    if (!propertyId || !form.attestationSignerName || !form.attestationSignerEmail || !form.attestationConsentText) {
      setError('Add the installer name, email, and attestation statement before requesting a signature.');
      return;
    }
    setRequestingSignature(true);
    setError(null);
    try {
      const result = await insurancePacketClient.requestInstallerAttestation(
        propertyId,
        form.attestationSignerName,
        form.attestationSignerEmail,
        form.attestationConsentText,
      );
      await refreshSnapshot();
      setMessage('Secure installer e-signature link created. Open it below or send it to the installer.');
      if (result.signingUrl) window.open(result.signingUrl, '_blank', 'noopener,noreferrer');
    } catch (signatureError) {
      setError(signatureError instanceof Error ? signatureError.message : 'Failed to create installer signature request');
    } finally {
      setRequestingSignature(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user?.id || !propertyId) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
            Select a property in the insurance flow before opening the certificate packet.
          </div>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            {error || 'Failed to load certificate packet.'}
          </div>
        </div>
      </div>
    );
  }

  const certificate = snapshot.certificate;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="bg-white rounded-lg shadow-lg p-6 print:hidden">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">HouseYield Property Certificate Packet</h1>
            <p className="text-sm text-gray-600 mt-1">{propertyAddress || snapshot.property.address}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() =>
                navigate('/insurance-discount/checklist', {
                  state: { propertyId, propertyAddress: snapshot.property.address },
                })
              }
              className="px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition"
            >
              Packet Checklist
            </button>
            <button
              onClick={() =>
                navigate('/insurance-discount/system-overview', {
                  state: { propertyId, propertyAddress: snapshot.property.address },
                })
              }
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition"
            >
              View Program Packet
            </button>
          </div>
        </div>

        <div className={`mt-4 rounded-lg border p-4 text-sm ${snapshot.commissioningStatus.readyForSubmission ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          {snapshot.commissioningStatus.readyForSubmission
            ? 'This property packet is ready for insurer submission.'
            : `Packet readiness: ${snapshot.commissioningStatus.completionPercent}%. Missing items: ${snapshot.commissioningStatus.missingFields.join(', ')}.`}
        </div>

        <div className="mt-6 space-y-6">
          <div className="rounded-xl border border-slate-200 p-5">
            <h2 className="text-lg font-semibold text-slate-900">1. Insured and carrier details</h2>
            <p className="mt-1 text-sm text-slate-600">Match the policyholder and insurer exactly as the carrier will expect to see them.</p>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Insured name</label>
                <input value={form.insuredName} onChange={(e) => setForm((current) => ({ ...current, insuredName: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Insurance carrier</label>
                <input value={form.insurerName} onChange={(e) => setForm((current) => ({ ...current, insurerName: e.target.value }))} placeholder="Example: Nationwide Private Client" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Insured email</label>
                <input value={form.insuredEmail} onChange={(e) => setForm((current) => ({ ...current, insuredEmail: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Policy number</label>
                <input value={form.policyNumber} onChange={(e) => setForm((current) => ({ ...current, policyNumber: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Insured phone</label>
                <input value={form.insuredPhone} onChange={(e) => setForm((current) => ({ ...current, insuredPhone: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-5">
            <h2 className="text-lg font-semibold text-slate-900">2. Installation record</h2>
            <p className="mt-1 text-sm text-slate-600">Document the installer, installation type, exact hardware, and where the shutoff was mounted.</p>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Install date</label>
                <input type="date" value={form.installDate ? form.installDate.slice(0, 10) : ''} onChange={(e) => setForm((current) => ({ ...current, installDate: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Installation method</label>
                <input value={form.installationMethod} onChange={(e) => setForm((current) => ({ ...current, installationMethod: e.target.value }))} placeholder="Professional installation" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Installer name</label>
                <input value={form.installerName} onChange={(e) => setForm((current) => ({ ...current, installerName: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Installer company</label>
                <input value={form.installerCompany} onChange={(e) => setForm((current) => ({ ...current, installerCompany: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Installer license / credential</label>
                <input value={form.installerLicenseNumber} onChange={(e) => setForm((current) => ({ ...current, installerLicenseNumber: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Installer email</label>
                <input type="email" value={form.installerEmail} onChange={(e) => setForm((current) => ({ ...current, installerEmail: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Installer phone</label>
                <input type="tel" value={form.installerPhone} onChange={(e) => setForm((current) => ({ ...current, installerPhone: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Valve hardware model</label>
                <input value={form.hardwareModel} onChange={(e) => setForm((current) => ({ ...current, hardwareModel: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Valve serial number</label>
                <input value={form.shutoffSerialNumber} onChange={(e) => setForm((current) => ({ ...current, shutoffSerialNumber: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Shelly / relay serial number</label>
                <input value={form.relaySerialNumber} onChange={(e) => setForm((current) => ({ ...current, relaySerialNumber: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Primary water line location</label>
                <input value={form.primaryWaterLineLocation} onChange={(e) => setForm((current) => ({ ...current, primaryWaterLineLocation: e.target.value }))} placeholder="Example: Basement mechanical room, east wall" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Valve location</label>
                <input value={form.valveLocation} onChange={(e) => setForm((current) => ({ ...current, valveLocation: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-sm font-medium text-gray-700">Component inventory</label>
                <textarea value={form.componentInventoryText} onChange={(e) => setForm((current) => ({ ...current, componentInventoryText: e.target.value }))} rows={4} placeholder="One component per line, including exact model names / SKUs / serials if available" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-5">
            <h2 className="text-lg font-semibold text-slate-900">3. Functional verification</h2>
            <p className="mt-1 text-sm text-slate-600">Capture the dates and checks that show the system was commissioned and actually works.</p>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Latest successful shutoff test</label>
                <input type="date" value={form.latestSuccessfulTestDate ? form.latestSuccessfulTestDate.slice(0, 10) : ''} onChange={(e) => setForm((current) => ({ ...current, latestSuccessfulTestDate: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Remote command verified</label>
                <input type="date" value={form.remoteCommandVerifiedAt ? form.remoteCommandVerifiedAt.slice(0, 10) : ''} onChange={(e) => setForm((current) => ({ ...current, remoteCommandVerifiedAt: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Leak alert path verified</label>
                <input type="date" value={form.leakAlertVerifiedAt ? form.leakAlertVerifiedAt.slice(0, 10) : ''} onChange={(e) => setForm((current) => ({ ...current, leakAlertVerifiedAt: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Test performed by</label>
                <input value={form.testPerformedBy} onChange={(e) => setForm((current) => ({ ...current, testPerformedBy: e.target.value }))} placeholder="Name of technician or plumber" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Valve travel time (seconds)</label>
                <input type="number" min="0" step="0.1" value={form.valveTravelSeconds} onChange={(e) => setForm((current) => ({ ...current, valveTravelSeconds: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-sm font-medium text-gray-700">Functional test method</label>
                <textarea value={form.testMethod} onChange={(e) => setForm((current) => ({ ...current, testMethod: e.target.value }))} rows={2} placeholder="Example: Triggered test sensor, confirmed automatic valve closure, opened upper-floor fixture to verify stopped flow, then restored service." className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              {[
                ['batteryBackupInstalled', 'Battery backup installed'],
                ['automaticLeakDetectionEnabled', 'Automatic leak detection enabled'],
                ['automaticShutoffEnabled', 'Automatic shutoff enabled'],
                ['unattendedShutoffVerified', 'Automatic shutoff verified during test'],
                ['manualOverrideVerified', 'Manual override / restore verified'],
                ['waterFlowStoppedVerified', 'Water flow stopped at a fixture during test'],
                ['waterServiceRestoredVerified', 'Water service restored after test'],
                ['installationStandardized', 'Installation follows HouseYield standard'],
                ['maintenanceDocumented', 'Maintenance / re-test procedure documented'],
                ['wifiValidated', 'Network / connectivity validated'],
                ['monitoringActive', 'Monitoring subscription / service active'],
              ].map(([field, label]) => (
                <label key={field} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={Boolean(form[field as keyof typeof form])}
                    onChange={(e) => setForm((current) => ({ ...current, [field]: e.target.checked }))}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Command path description</label>
                <textarea value={form.commandPathDescription} onChange={(e) => setForm((current) => ({ ...current, commandPathDescription: e.target.value }))} rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Alert path description</label>
                <textarea value={form.alertPathDescription} onChange={(e) => setForm((current) => ({ ...current, alertPathDescription: e.target.value }))} rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-5">
            <h2 className="text-lg font-semibold text-slate-900">4. Evidence and attestation</h2>
            <p className="mt-1 text-sm text-slate-600">This is the part insurers usually care about most after the core hardware story.</p>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              {[
                ['installationPhotoCaptured', 'Wide installation photo captured'],
                ['valvePhotoCaptured', 'Valve close-up photo captured'],
                ['sensorPhotoCaptured', 'Sensor placement photo(s) captured'],
                ['modelLabelPhotosCaptured', 'Model / serial label photo(s) captured'],
              ].map(([field, label]) => (
                <label key={field} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={Boolean(form[field as keyof typeof form])}
                    onChange={(e) => setForm((current) => ({ ...current, [field]: e.target.checked }))}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Evidence photo URLs</label>
                <textarea value={form.evidencePhotoUrlsText} onChange={(e) => setForm((current) => ({ ...current, evidencePhotoUrlsText: e.target.value }))} rows={4} placeholder="One URL per line" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <input type="file" accept="image/*" multiple disabled={uploadingEvidence} onChange={(e) => void handleEvidenceUpload('installation-photos', e.target.files, 'evidencePhotoUrlsText')} className="mt-2 block w-full text-xs text-slate-600" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">App / portal screenshot URLs</label>
                <textarea value={form.appScreenshotUrlsText} onChange={(e) => setForm((current) => ({ ...current, appScreenshotUrlsText: e.target.value }))} rows={4} placeholder="Healthy devices, online status, activation proof" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <input type="file" accept="image/*,.pdf" multiple disabled={uploadingEvidence} onChange={(e) => void handleEvidenceUpload('activation-captures', e.target.files, 'appScreenshotUrlsText')} className="mt-2 block w-full text-xs text-slate-600" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Invoice / receipt document URLs</label>
                <textarea value={form.invoiceDocumentUrlsText} onChange={(e) => setForm((current) => ({ ...current, invoiceDocumentUrlsText: e.target.value }))} rows={4} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <input type="file" accept="image/*,.pdf" multiple disabled={uploadingEvidence} onChange={(e) => void handleEvidenceUpload('invoices', e.target.files, 'invoiceDocumentUrlsText')} className="mt-2 block w-full text-xs text-slate-600" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Signed attestation document URLs</label>
                <textarea value={form.signedAttestationDocumentUrlsText} onChange={(e) => setForm((current) => ({ ...current, signedAttestationDocumentUrlsText: e.target.value }))} rows={4} placeholder="E-sign packet or signed installer certificate" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <input type="file" accept="image/*,.pdf" multiple disabled={uploadingEvidence} onChange={(e) => void handleEvidenceUpload('attestations', e.target.files, 'signedAttestationDocumentUrlsText')} className="mt-2 block w-full text-xs text-slate-600" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Supporting document URLs</label>
                <textarea value={form.supportingDocumentUrlsText} onChange={(e) => setForm((current) => ({ ...current, supportingDocumentUrlsText: e.target.value }))} rows={4} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <input type="file" accept="image/*,.pdf" multiple disabled={uploadingEvidence} onChange={(e) => void handleEvidenceUpload('supporting', e.target.files, 'supportingDocumentUrlsText')} className="mt-2 block w-full text-xs text-slate-600" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Attestation signed date</label>
                <input type="date" value={form.attestationSignedAt ? form.attestationSignedAt.slice(0, 10) : ''} onChange={(e) => setForm((current) => ({ ...current, attestationSignedAt: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Attestation signer name</label>
                <input value={form.attestationSignerName} onChange={(e) => setForm((current) => ({ ...current, attestationSignerName: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Attestation signer title</label>
                <input value={form.attestationSignerTitle} onChange={(e) => setForm((current) => ({ ...current, attestationSignerTitle: e.target.value }))} placeholder="Licensed plumber, technician, operations manager" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Attestation signer email</label>
                <input type="email" value={form.attestationSignerEmail} onChange={(e) => setForm((current) => ({ ...current, attestationSignerEmail: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-sm font-medium text-gray-700">Installer attestation statement</label>
                <textarea value={form.attestationConsentText} onChange={(e) => setForm((current) => ({ ...current, attestationConsentText: e.target.value }))} rows={3} placeholder="I attest that I installed or inspected the listed equipment, completed the recorded functional tests, and that the results are accurate to the best of my knowledge." className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <p className="mt-1 text-xs text-slate-500">Save the commissioning record before creating the request so the signer receives the final equipment and test details.</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button type="button" disabled={requestingSignature || !form.attestationSignerName || !form.attestationSignerEmail || !form.attestationConsentText} onClick={() => void handleRequestInstallerSignature()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
                    {requestingSignature ? 'Creating secure link...' : 'Create Installer E-Sign Link'}
                  </button>
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Status: {snapshot.commissioning.attestationStatus?.replace(/_/g, ' ') || 'not requested'}
                  </span>
                  {snapshot.commissioning.attestationSigningUrl && snapshot.commissioning.attestationStatus !== 'completed' && (
                    <a href={snapshot.commissioning.attestationSigningUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold text-blue-700 underline">
                      Open signing link
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-5">
            <h2 className="text-lg font-semibold text-slate-900">5. Manufacturer program credentials</h2>
            <p className="mt-1 text-sm text-slate-600">Only mark a relationship verified when the current certificate, account record, or approval notice is attached.</p>
            <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="space-y-3 rounded-lg border border-slate-200 p-4">
                <h3 className="font-semibold text-slate-900">Shelly installer / partner</h3>
                <select value={form.shellyPartnerStatus} onChange={(e) => setForm((current) => ({ ...current, shellyPartnerStatus: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2">
                  <option value="not_documented">Not documented</option>
                  <option value="pending_verification">Pending verification</option>
                  <option value="verified">Verified with attached evidence</option>
                </select>
                <input value={form.shellyCredentialId} onChange={(e) => setForm((current) => ({ ...current, shellyCredentialId: e.target.value }))} placeholder="Credential / dealer / installer ID" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <textarea value={form.shellyCredentialDocumentUrlsText} onChange={(e) => setForm((current) => ({ ...current, shellyCredentialDocumentUrlsText: e.target.value }))} rows={3} placeholder="Credential evidence URLs" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <input type="file" accept="image/*,.pdf" multiple disabled={uploadingEvidence} onChange={(e) => void handleEvidenceUpload('partner-credentials', e.target.files, 'shellyCredentialDocumentUrlsText')} className="block w-full text-xs text-slate-600" />
              </div>
              <div className="space-y-3 rounded-lg border border-slate-200 p-4">
                <h3 className="font-semibold text-slate-900">EcoNet Controls installer / integrator</h3>
                <select value={form.econetPartnerStatus} onChange={(e) => setForm((current) => ({ ...current, econetPartnerStatus: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2">
                  <option value="not_documented">Not documented</option>
                  <option value="pending_verification">Pending verification</option>
                  <option value="verified">Verified with attached evidence</option>
                </select>
                <input value={form.econetCredentialId} onChange={(e) => setForm((current) => ({ ...current, econetCredentialId: e.target.value }))} placeholder="Installer / integrator program ID" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <textarea value={form.econetCredentialDocumentUrlsText} onChange={(e) => setForm((current) => ({ ...current, econetCredentialDocumentUrlsText: e.target.value }))} rows={3} placeholder="Credential evidence URLs" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <input type="file" accept="image/*,.pdf" multiple disabled={uploadingEvidence} onChange={(e) => void handleEvidenceUpload('partner-credentials', e.target.files, 'econetCredentialDocumentUrlsText')} className="block w-full text-xs text-slate-600" />
              </div>
            </div>
          </div>

          <AnnualRecertificationPanel
            ownerId={user.id}
            propertyId={propertyId}
            summary={snapshot.annualCertification || null}
            installerDefaults={{
              name: form.installerName,
              company: form.installerCompany,
              email: form.installerEmail,
              phone: form.installerPhone,
              licenseNumber: form.installerLicenseNumber,
            }}
            onChanged={refreshSnapshot}
          />

          {snapshot.propertyFacts && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">
              <h2 className="text-lg font-semibold text-blue-900">6. Property context from ATTOM</h2>
              <p className="mt-1 text-sm text-blue-800">Use these facts to make the packet more property-specific without asking the installer to type them manually.</p>
              <div className="mt-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                <div><div className="text-blue-700">Property type</div><div className="font-semibold text-blue-950">{snapshot.propertyFacts.propertyType || 'Not documented'}</div></div>
                <div><div className="text-blue-700">Occupancy</div><div className="font-semibold text-blue-950">{snapshot.propertyFacts.occupancyType || 'Not documented'}</div></div>
                <div><div className="text-blue-700">Year built</div><div className="font-semibold text-blue-950">{snapshot.propertyFacts.yearBuilt || 'Not documented'}</div></div>
                <div><div className="text-blue-700">Living area</div><div className="font-semibold text-blue-950">{snapshot.propertyFacts.livingAreaSqFt ? `${snapshot.propertyFacts.livingAreaSqFt.toLocaleString()} sq ft` : 'Not documented'}</div></div>
                <div><div className="text-blue-700">Beds / baths</div><div className="font-semibold text-blue-950">{snapshot.propertyFacts.bedrooms || 'N/A'} / {snapshot.propertyFacts.bathrooms || 'N/A'}</div></div>
                <div><div className="text-blue-700">Stories</div><div className="font-semibold text-blue-950">{snapshot.propertyFacts.stories || 'Not documented'}</div></div>
                <div><div className="text-blue-700">Plumbing permits</div><div className="font-semibold text-blue-950">{snapshot.propertyFacts.plumbingPermitCount ?? 'Not documented'}</div></div>
                <div><div className="text-blue-700">Last plumbing permit</div><div className="font-semibold text-blue-950">{snapshot.propertyFacts.mostRecentPlumbingPermitDate ? new Date(snapshot.propertyFacts.mostRecentPlumbingPermitDate).toLocaleDateString() : 'Not documented'}</div></div>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
            <h2 className="text-lg font-semibold text-emerald-900">Submission checklist</h2>
            <div className="mt-4 space-y-3">
              {snapshot.submissionChecklist.map((item) => (
                <div key={item.id} className="rounded-lg border border-emerald-100 bg-white px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-medium text-slate-900">{item.label}</div>
                      {item.detail && <div className="mt-1 text-sm text-slate-600">{item.detail}</div>}
                    </div>
                    <div className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      item.status === 'complete'
                        ? 'bg-green-100 text-green-800'
                        : item.status === 'recommended'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-amber-100 text-amber-800'
                    }`}>
                      {item.status === 'complete' ? 'Complete' : item.status === 'recommended' ? 'Recommended' : 'Missing'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Notes / limitations</label>
            <textarea value={form.notes} onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))} rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
          </div>
        </div>

        {(message || error) && (
          <div className={`mt-4 rounded-lg border p-3 text-sm ${error ? 'border-red-200 bg-red-50 text-red-700' : 'border-green-200 bg-green-50 text-green-700'}`}>
            {error || message}
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <button onClick={handleSave} disabled={saving} className="px-5 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium disabled:opacity-60">
            {saving ? 'Saving...' : 'Save Commissioning Record'}
          </button>
          <button onClick={handlePrint} className="px-5 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition font-medium">
            Print Preview
          </button>
          <button onClick={() => void handleDownload()} className="px-5 py-3 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition font-medium">
            Download Certificate
          </button>
          <button onClick={() => void handleCombinedPacketDownload()} className="px-5 py-3 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition font-medium">
            Download Complete Evidence Packet
          </button>
        </div>
      </div>

      <div className="bg-white border-2 border-gray-300 rounded-lg p-8 shadow-lg print:shadow-none">
        <div className="text-center border-b-2 border-gray-800 pb-6 mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">HouseYield Water Shutoff Commissioning Certificate</h1>
          <h2 className="text-xl text-gray-700 mb-1">Property Insurance Packet</h2>
          <p className="text-sm text-gray-500">For underwriting and premium-credit review</p>
        </div>

        <div className="space-y-6">
          <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4 text-center">
            <div className="text-sm text-gray-600 mb-1">Verification Code</div>
            <div className="text-2xl font-mono font-bold text-blue-900">{certificate.verificationCode}</div>
            <div className="text-xs text-gray-500 mt-1">HouseYield property packet reference</div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-800 mb-3 border-b border-gray-300 pb-2">Property And Insured Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-gray-600">Insured name</div>
                <div className="font-medium text-gray-900">{certificate.userInfo.name || 'Not documented'}</div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Email</div>
                <div className="font-medium text-gray-900">{certificate.userInfo.email || 'Not documented'}</div>
              </div>
              <div className="col-span-2">
                <div className="text-sm text-gray-600">Property address</div>
                <div className="font-medium text-gray-900">{certificate.userInfo.address}</div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Phone</div>
                <div className="font-medium text-gray-900">{certificate.userInfo.phone || 'Not documented'}</div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Insurance carrier</div>
                <div className="font-medium text-gray-900">{snapshot.commissioning.insurerName || 'Not documented'}</div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Policy number</div>
                <div className="font-medium text-gray-900">{snapshot.commissioning.policyNumber || 'Not documented'}</div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-800 mb-3 border-b border-gray-300 pb-2">Property Underwriting Context</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-gray-600">Property type</div>
                <div className="font-medium text-gray-900">{snapshot.propertyFacts.propertyType || 'Not documented'}</div>
              </div>
              <div>
                <div className="text-gray-600">Occupancy</div>
                <div className="font-medium text-gray-900">{snapshot.propertyFacts.occupancyType || 'Not documented'}</div>
              </div>
              <div>
                <div className="text-gray-600">Year built</div>
                <div className="font-medium text-gray-900">{snapshot.propertyFacts.yearBuilt || 'Not documented'}</div>
              </div>
              <div>
                <div className="text-gray-600">Living area</div>
                <div className="font-medium text-gray-900">{snapshot.propertyFacts.livingAreaSqFt ? `${snapshot.propertyFacts.livingAreaSqFt.toLocaleString()} sq ft` : 'Not documented'}</div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-800 mb-3 border-b border-gray-300 pb-2">Installed Monitoring Equipment</h3>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div>
                <div className="text-sm text-gray-600">Total sensors</div>
                <div className="font-medium text-gray-900">{certificate.systemInfo.totalSensors}</div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Leak sensors</div>
                <div className="font-medium text-gray-900">{certificate.systemInfo.leakSensors || 0}</div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Online now</div>
                <div className="font-medium text-gray-900">{certificate.systemInfo.onlineSensors || 0}</div>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {certificate.systemInfo.sensors.map((sensor) => (
                <div key={sensor.id} className="rounded border border-gray-200 bg-gray-50 p-3 text-sm">
                  <div className="font-medium text-gray-800">{sensor.name}</div>
                  <div className="text-gray-600">{sensor.location}</div>
                  <div className="text-xs text-gray-500 capitalize">{sensor.type.replace(/_/g, ' ')}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-800 mb-3 border-b border-gray-300 pb-2">Automatic Shutoff Hardware And Commissioning</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-gray-600">Valve hardware</div>
                <div className="font-medium text-gray-900">{certificate.systemInfo.valveModel || 'Not documented'}</div>
              </div>
              <div>
                <div className="text-gray-600">Installation method</div>
                <div className="font-medium text-gray-900">{snapshot.commissioning.installationMethod || 'Not documented'}</div>
              </div>
              <div>
                <div className="text-gray-600">Valve location</div>
                <div className="font-medium text-gray-900">{certificate.systemInfo.valveLocation || 'Not documented'}</div>
              </div>
              <div>
                <div className="text-gray-600">Primary water line location</div>
                <div className="font-medium text-gray-900">{snapshot.commissioning.primaryWaterLineLocation || 'Not documented'}</div>
              </div>
              <div>
                <div className="text-gray-600">Install date</div>
                <div className="font-medium text-gray-900">{certificate.systemInfo.installationDate ? new Date(certificate.systemInfo.installationDate).toLocaleDateString() : 'Not documented'}</div>
              </div>
              <div>
                <div className="text-gray-600">Latest successful shutoff test</div>
                <div className="font-medium text-gray-900">{certificate.systemInfo.latestSuccessfulTestDate ? new Date(certificate.systemInfo.latestSuccessfulTestDate).toLocaleDateString() : 'Not documented'}</div>
              </div>
            </div>
            <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
              <strong>Component inventory:</strong>{' '}
              {snapshot.commissioning.componentInventory.length
                ? snapshot.commissioning.componentInventory.join(', ')
                : 'Not documented'}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-4 text-sm">
              {[
                ['Automatic shutoff enabled', certificate.systemInfo.automaticShutoffEnabled],
                ['Battery backup documented', certificate.systemInfo.batteryBackupInstalled],
                ['Packet ready for submission', certificate.systemInfo.commissioningReady],
                ['Monitoring active', snapshot.commissioning.monitoringActive],
                ['Install standardized', snapshot.commissioning.installationStandardized],
                ['Maintenance documented', snapshot.commissioning.maintenanceDocumented],
                ['Network validated', snapshot.commissioning.wifiValidated],
                ['Unattended shutoff verified', snapshot.commissioning.unattendedShutoffVerified],
                ['Manual override verified', snapshot.commissioning.manualOverrideVerified],
              ].map(([label, value], index) => (
                <div key={`${String(label)}-${index}`} className="flex items-center justify-between rounded border border-gray-200 bg-slate-50 px-3 py-2">
                  <span className="text-gray-700">{label}</span>
                  <span className={`font-semibold ${value ? 'text-green-700' : 'text-amber-700'}`}>{value ? 'Yes' : 'No'}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-800 mb-3 border-b border-gray-300 pb-2">Evidence And Attestation</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-4 text-sm">
              {[
                ['Installation photo captured', snapshot.commissioning.installationPhotoCaptured],
                ['Valve photo captured', snapshot.commissioning.valvePhotoCaptured],
                ['Sensor photo captured', snapshot.commissioning.sensorPhotoCaptured],
                ['Model label photos captured', snapshot.commissioning.modelLabelPhotosCaptured],
              ].map(([label, value], index) => (
                <div key={`${String(label)}-${index}`} className="flex items-center justify-between rounded border border-gray-200 bg-slate-50 px-3 py-2">
                  <span className="text-gray-700">{label}</span>
                  <span className={`font-semibold ${value ? 'text-green-700' : 'text-amber-700'}`}>{value ? 'Yes' : 'No'}</span>
                </div>
              ))}
            </div>
            <div className="text-sm text-gray-700 space-y-2 mt-4">
              <p><strong>Attestation signer:</strong> {[snapshot.commissioning.attestationSignerName, snapshot.commissioning.attestationSignerTitle].filter(Boolean).join(', ') || 'Not documented'}</p>
              <p><strong>Attestation signed:</strong> {snapshot.commissioning.attestationSignedAt ? new Date(snapshot.commissioning.attestationSignedAt).toLocaleDateString() : 'Not documented'}</p>
              <p><strong>App screenshots:</strong> {snapshot.commissioning.appScreenshotUrls.length ? snapshot.commissioning.appScreenshotUrls.join(', ') : 'None recorded'}</p>
              <p><strong>Invoice documents:</strong> {snapshot.commissioning.invoiceDocumentUrls.length ? snapshot.commissioning.invoiceDocumentUrls.join(', ') : 'None recorded'}</p>
              <p><strong>Signed attestation docs:</strong> {snapshot.commissioning.signedAttestationDocumentUrls.length ? snapshot.commissioning.signedAttestationDocumentUrls.join(', ') : 'None recorded'}</p>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-800 mb-3 border-b border-gray-300 pb-2">Evidence Appendix</h3>
            <div className="text-sm text-gray-700 space-y-2">
              <p><strong>Installer:</strong> {[snapshot.commissioning.installerName, snapshot.commissioning.installerCompany].filter(Boolean).join(', ') || 'Not documented'}</p>
              <p><strong>Command path:</strong> {snapshot.commissioning.commandPathDescription || 'Not documented'}</p>
              <p><strong>Alert path:</strong> {snapshot.commissioning.alertPathDescription || 'Not documented'}</p>
              <p><strong>Evidence photos:</strong> {snapshot.commissioning.evidencePhotoUrls.length ? snapshot.commissioning.evidencePhotoUrls.join(', ') : 'None recorded'}</p>
              <p><strong>App screenshots:</strong> {snapshot.commissioning.appScreenshotUrls.length ? snapshot.commissioning.appScreenshotUrls.join(', ') : 'None recorded'}</p>
              <p><strong>Invoice documents:</strong> {snapshot.commissioning.invoiceDocumentUrls.length ? snapshot.commissioning.invoiceDocumentUrls.join(', ') : 'None recorded'}</p>
              <p><strong>Supporting documents:</strong> {snapshot.commissioning.supportingDocumentUrls.length ? snapshot.commissioning.supportingDocumentUrls.join(', ') : 'None recorded'}</p>
              <p><strong>Notes:</strong> {snapshot.commissioning.notes || 'None recorded'}</p>
            </div>
          </div>

          <div className="bg-gray-50 border border-gray-300 rounded-lg p-4">
            <p className="text-sm text-gray-700 leading-relaxed">
              <strong>This certificate confirms</strong> that HouseYield has documented leak monitoring devices assigned to this property and a recorded automatic water shutoff installation evidence record for insurer review. This packet reflects live property/device data plus the most recent commissioning information saved for this address.
            </p>
          </div>
        </div>

        <div className="border-t-2 border-gray-300 pt-6 text-center mt-8">
          <div className="text-sm text-gray-600 mb-2">Certificate Generated: {new Date(certificate.generatedAt).toLocaleString()}</div>
          <div className="text-sm text-gray-600">Certificate ID: {certificate.id}</div>
        </div>
      </div>
    </div>
  );
};

export default CertificateViewer;
