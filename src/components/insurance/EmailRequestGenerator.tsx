import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getSelectedInsuranceProperty, insurancePacketClient } from '../../services/insurancePacketClient';
import { Insurer, InsurancePacketSnapshot } from '../../types/iot';
import { authenticatedFetch } from '../../utils/authenticatedFetch';

const EmailRequestGenerator: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const routeState = (location.state as { insurer?: Insurer; propertyId?: string; propertyAddress?: string } | null) || null;
  const storedProperty = getSelectedInsuranceProperty();
  const insurer = routeState?.insurer as Insurer | undefined;
  const propertyId = routeState?.propertyId || storedProperty?.propertyId || '';
  const propertyAddress = routeState?.propertyAddress || storedProperty?.address || '';

  const [snapshot, setSnapshot] = useState<InsurancePacketSnapshot | null>(null);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!insurer || !propertyId || !user?.id) {
      navigate('/insurance-discount/select-insurer');
      return;
    }

    const loadSnapshot = async () => {
      try {
        const packetSnapshot = await insurancePacketClient.getSnapshot(user.id, propertyId);
        setSnapshot(packetSnapshot);
      } catch (loadError) {
        console.error('Failed to load packet snapshot:', loadError);
        setError(loadError instanceof Error ? loadError.message : 'Failed to load insurer packet');
      } finally {
        setLoading(false);
      }
    };

    void loadSnapshot();
  }, [insurer, propertyId, user?.id]);

  useEffect(() => {
    if (!insurer || !snapshot) {
      return;
    }
    const subject = `HouseYield water mitigation discount request - ${snapshot.property.address}`;
    setEmailSubject(subject);

    const isCommissioned =
      snapshot.commissioning.automaticShutoffEnabled &&
      snapshot.commissioning.unattendedShutoffVerified &&
      snapshot.commissioning.waterFlowStoppedVerified;
    const monitoringLine = snapshot.monitoringEvidence.telemetryContinuityPercent == null
      ? 'Historical telemetry continuity: not yet sufficient for a percentage'
      : `Observed hourly telemetry continuity: ${snapshot.monitoringEvidence.telemetryContinuityPercent}% (${snapshot.monitoringEvidence.observedPeriodHours} observed-period hours)`;
    const body = `Hello ${insurer.name} underwriting team,

I am requesting underwriting consideration or any available premium credit for the HouseYield water-loss mitigation system installed at ${snapshot.property.address}${policyNumber ? ` under policy number ${policyNumber}` : ''}.

The attached evidence packet documents ${snapshot.systemSummary.leakSensorCount} enrolled point-of-leak sensor${snapshot.systemSummary.leakSensorCount === 1 ? '' : 's'}, environmental monitoring, and ${isCommissioned ? 'a functionally tested automatic main-water shutoff path' : 'the current automatic-shutoff commissioning status'}.

At the time this packet was generated:
- Enrolled property devices: ${snapshot.systemSummary.totalSensors}
- Devices reporting online now: ${snapshot.systemSummary.onlineSensors}
- Automatic shutoff fully commissioned: ${isCommissioned ? 'Yes' : 'No'}
- Latest successful shutoff test: ${snapshot.commissioning.latestSuccessfulTestDate || 'Not documented'}
- Remote shutoff command verified: ${snapshot.commissioning.remoteCommandVerifiedAt || 'Not documented'}
- Leak alert path verified: ${snapshot.commissioning.leakAlertVerifiedAt || 'Not documented'}
- Installer attestation signed: ${snapshot.commissioning.attestationSignedAt || 'Not documented'}
- ${monitoringLine}

Please review the attached sealed HouseYield evidence packet for eligibility under your ${insurer.discountProgramName || 'protective-device or smart-home'} program. I understand that eligibility and any credit are determined solely by the carrier and may vary by state, policy form, property, device, and installation.

Thank you,

${snapshot.insuredContact.name || user?.name || '[Your Name]'}
${snapshot.property.address}
${snapshot.insuredContact.email || user?.email || '[Your Email]'}
${snapshot.insuredContact.phone || '[Your Phone Number]'}`;

    setEmailBody(body);
  }, [insurer, policyNumber, snapshot, user?.email, user?.name]);

  const proofTypes = useMemo(
    () => insurer?.acceptedProofTypes || ['property-certificate', 'program-overview'],
    [insurer],
  );

  const handleSendEmail = () => {
    if (!insurer) {
      return;
    }
    const mailtoLink = `mailto:${insurer.submissionEmail || ''}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;
    window.location.href = mailtoLink;

    alert('Your email client will open with the pre-filled message.\n\nBefore sending:\n1. Download the HouseYield evidence packet below\n2. Attach the PDF to your email\n3. Review and send');
    void recordSubmission();
  };

  const handleDownloadDocuments = async () => {
    try {
      if (!user?.id || !propertyId || !snapshot) {
        return;
      }
      await insurancePacketClient.downloadPdf(
        insurancePacketClient.buildCombinedPacketDownloadUrl(user.id, propertyId),
        `HouseYield-Water-Loss-Mitigation-Evidence-${propertyId}.pdf`,
      );
      alert(snapshot.commissioningStatus.readyForSubmission
        ? 'The sealed HouseYield evidence packet is ready to attach.'
        : 'A DRAFT packet was downloaded. Complete the missing commissioning evidence before submitting it to an insurer.');
    } catch (error) {
      console.error('Failed to download documents:', error);
      alert('Download failed. Please try again after reviewing the packet.');
    }
  };

  const recordSubmission = async () => {
    if (!insurer) {
      return;
    }
    try {
      await authenticatedFetch(`${import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001'}/api/insurance/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerId: user?.id,
          propertyId,
          insurerId: insurer.id,
          policyNumber,
          certificateId: snapshot?.certificate.id,
          proofTypes,
        }),
      });

      navigate('/insurance-discount/confirmation');
    } catch (error) {
      console.error('Failed to record submission:', error);
    }
  };

  if (!insurer) return null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-600">Generating your request...</p>
        </div>
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            {error || 'Failed to load the HouseYield insurance packet.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow-lg p-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-800 mb-2">
            Review Your Request
          </h1>
          <p className="text-gray-600">
            HouseYield packet request for {propertyAddress || snapshot.property.address}, ready to send to {insurer.name}
          </p>
        </div>

        {!snapshot.commissioningStatus.readyForSubmission && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 text-sm text-amber-800">
            This property packet is not fully complete yet. Missing items: {snapshot.commissioningStatus.missingFields.join(', ')}.
            <button
              onClick={() =>
                navigate('/insurance-discount/certificate', {
                  state: { propertyId, propertyAddress: snapshot.property.address },
                })
              }
              className="ml-2 font-semibold underline"
            >
              Review commissioning details
            </button>
          </div>
        )}

        {/* Insurer Info */}
        <div className="bg-blue-50 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-800">{insurer.name}</h3>
              {insurer.submissionEmail && (
                <p className="text-sm text-gray-600 mt-1">
                  To: {insurer.submissionEmail}
                </p>
              )}
              {insurer.submissionPortalUrl && (
                <a 
                  href={insurer.submissionPortalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline mt-1 inline-block"
                >
                  Or submit via online portal →
                </a>
              )}
            </div>
            {insurer.discountPercentage && (
              <div className="text-right">
                <p className="text-sm text-gray-600">Eligibility</p>
                <p className="text-base font-bold text-slate-700">{insurer.discountPercentage}</p>
              </div>
            )}
          </div>
        </div>

        {/* Policy Number */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Policy Number (Optional)
          </label>
          <input
            type="text"
            value={policyNumber}
            onChange={(e) => setPolicyNumber(e.target.value)}
            placeholder="Enter your policy number"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Email Preview */}
        <div className="border border-gray-300 rounded-lg p-6 mb-6">
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Subject
            </label>
            <input
              type="text"
              value={emailSubject}
              onChange={(e) => setEmailSubject(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Body
            </label>
            <textarea
              value={emailBody}
              onChange={(e) => setEmailBody(e.target.value)}
              rows={16}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
            />
          </div>
        </div>

        {/* Attachments */}
        <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-6 mb-6">
          <div className="flex items-start space-x-3 mb-4">
            <span className="text-3xl">⚠️</span>
            <div>
              <h3 className="font-semibold text-gray-800 text-lg mb-2">Important: Download Documents First!</h3>
              <p className="text-sm text-gray-700 mb-3">
                Email clients cannot automatically attach files for security reasons. You must:
              </p>
              <ol className="text-sm text-gray-700 space-y-1 ml-4 list-decimal">
                <li>Click "Download HouseYield Evidence Packet" below</li>
                <li>Click "Open Email" to launch your email client with the pre-filled message</li>
                <li>Manually attach the downloaded PDF to your email</li>
                <li>Review and send your request</li>
              </ol>
            </div>
          </div>

          <button
            onClick={handleDownloadDocuments}
            className="w-full px-6 py-4 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition font-semibold text-lg shadow-lg mb-3"
          >
            📎 Step 1: Download HouseYield Evidence Packet
          </button>

          <div className="bg-white rounded-lg p-4 border border-yellow-200">
            <h4 className="font-semibold text-gray-800 mb-2">Documents to Attach:</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 bg-gray-50 rounded border border-gray-200">
                <div className="flex items-center space-x-3">
                  <span className="text-2xl">📄</span>
                  <div>
                    <p className="font-medium text-gray-800">Combined Water-Loss Mitigation Evidence Packet</p>
                    <p className="text-sm text-gray-500">
                      Sealed on download after all readiness requirements are complete
                    </p>
                  </div>
                </div>
                <button
                  onClick={() =>
                    navigate('/insurance-discount/certificate', {
                      state: { propertyId, propertyAddress: snapshot.property.address },
                    })
                  }
                  className="text-sm text-blue-600 hover:text-blue-700 underline"
                >
                  Preview →
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-between space-x-4">
          <button
            onClick={() => navigate('/insurance-discount/select-insurer')}
            className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition"
          >
            ← Back
          </button>
          
          <button
            onClick={handleSendEmail}
            className="px-8 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-semibold shadow-lg text-lg"
          >
            📧 Step 2: Open Email Client
          </button>
        </div>
      </div>
    </div>
  );
};

export default EmailRequestGenerator;
