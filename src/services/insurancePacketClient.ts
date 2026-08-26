import type {
  InsurancePacketSnapshot,
  InsurancePropertySummary,
  InstallationCertificate,
  WaterMitigationCertification,
  WaterMitigationCertificationSummary,
  WaterMitigationCommissioning,
} from '../types/iot';
import { authenticatedFetch } from '../utils/authenticatedFetch';

const baseUrl = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';
const STORAGE_KEY = 'houseyield_selected_insurance_property';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || `Request failed (${response.status})`);
  }
  return payload as T;
}

export function setSelectedInsuranceProperty(property: { propertyId: string; address: string }) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(property));
}

export function getSelectedInsuranceProperty(): { propertyId: string; address: string } | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.propertyId === 'string' && typeof parsed.address === 'string') {
      return parsed;
    }
  } catch (error) {
    console.error('Failed to parse selected insurance property:', error);
  }
  return null;
}

export const insurancePacketClient = {
  async listProperties(ownerId: string): Promise<InsurancePropertySummary[]> {
    return fetchJson<InsurancePropertySummary[]>(
      `${baseUrl}/api/insurance/properties?ownerId=${encodeURIComponent(ownerId)}`,
    );
  },

  async getSnapshot(ownerId: string, propertyId: string): Promise<InsurancePacketSnapshot> {
    return fetchJson<InsurancePacketSnapshot>(
      `${baseUrl}/api/insurance/packet-snapshot?ownerId=${encodeURIComponent(ownerId)}&propertyId=${encodeURIComponent(propertyId)}`,
    );
  },

  async getCertificate(ownerId: string, propertyId: string): Promise<InstallationCertificate> {
    return fetchJson<InstallationCertificate>(
      `${baseUrl}/api/insurance/certificate/generate?ownerId=${encodeURIComponent(ownerId)}&propertyId=${encodeURIComponent(propertyId)}`,
    );
  },

  async getCommissioning(ownerId: string, propertyId: string): Promise<WaterMitigationCommissioning | null> {
    const payload = await fetchJson<{ commissioning: WaterMitigationCommissioning | null }>(
      `${baseUrl}/api/insurance/commissioning?ownerId=${encodeURIComponent(ownerId)}&propertyId=${encodeURIComponent(propertyId)}`,
    );
    return payload.commissioning;
  },

  async saveCommissioning(
    ownerId: string,
    propertyId: string,
    commissioning: Partial<WaterMitigationCommissioning>,
  ): Promise<WaterMitigationCommissioning> {
    const payload = await fetchJson<{ commissioning: WaterMitigationCommissioning }>(
      `${baseUrl}/api/insurance/commissioning`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId, propertyId, commissioning }),
      },
    );
    return payload.commissioning;
  },

  async applyAutomatedPacketEvidence(
    propertyId: string,
  ): Promise<{
    snapshot: InsurancePacketSnapshot;
    completed: string[];
    systemEvidence: {
      enrolledDeviceCount: number;
      monitoredControllerCount: number;
      controllerOnline: boolean;
      telemetryObservationCount: number;
      inventoryGenerated: number;
    };
    manualEvidenceRequired: string[];
  }> {
    return fetchJson(`${baseUrl}/api/insurance/packet-checklist/auto-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propertyId }),
    });
  },

  async requestInstallerAttestation(
    propertyId: string,
    signerName: string,
    signerEmail: string,
    consentText: string,
  ): Promise<{ documentId: string; signingUrl: string; commissioning: WaterMitigationCommissioning }> {
    return fetchJson(
      `${baseUrl}/api/insurance/attestation-request`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId, signerName, signerEmail, consentText }),
      },
    );
  },

  async listRecertifications(
    propertyId: string,
  ): Promise<{ summary: WaterMitigationCertificationSummary; certifications: WaterMitigationCertification[] }> {
    return fetchJson(
      `${baseUrl}/api/insurance/certifications?propertyId=${encodeURIComponent(propertyId)}`,
    );
  },

  async startRecertification(
    propertyId: string,
    technician: WaterMitigationCertification['technician'],
    reason = 'annual_due',
  ): Promise<{ certification: WaterMitigationCertification; reused: boolean }> {
    return fetchJson(`${baseUrl}/api/insurance/certifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propertyId, technician, reason, type: 'annual_full' }),
    });
  },

  async updateRecertification(
    propertyId: string,
    certification: WaterMitigationCertification,
  ): Promise<{ certification: WaterMitigationCertification }> {
    return fetchJson(
      `${baseUrl}/api/insurance/certifications/${encodeURIComponent(certification.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId, certification }),
      },
    );
  },

  async requestRecertificationSignature(
    propertyId: string,
    certificationId: string,
  ): Promise<{ certification: WaterMitigationCertification; signingUrl: string }> {
    return fetchJson(
      `${baseUrl}/api/insurance/certifications/${encodeURIComponent(certificationId)}/signature-request`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId }),
      },
    );
  },

  async downloadPdf(url: string, filename: string): Promise<void> {
    const response = await authenticatedFetch(url);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error((payload as { error?: string }).error || `Download failed (${response.status})`);
    }
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
  },

  buildCertificateDownloadUrl(ownerId: string, propertyId: string): string {
    return `${baseUrl}/api/insurance/certificate/download?ownerId=${encodeURIComponent(ownerId)}&propertyId=${encodeURIComponent(propertyId)}`;
  },

  buildProgramPacketDownloadUrl(ownerId: string, propertyId: string): string {
    return `${baseUrl}/api/insurance/system-overview/download?ownerId=${encodeURIComponent(ownerId)}&propertyId=${encodeURIComponent(propertyId)}`;
  },

  buildCombinedPacketDownloadUrl(ownerId: string, propertyId: string): string {
    return `${baseUrl}/api/insurance/property-packet/download?ownerId=${encodeURIComponent(ownerId)}&propertyId=${encodeURIComponent(propertyId)}`;
  },
};
