import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getSelectedInsuranceProperty, insurancePacketClient } from '../../services/insurancePacketClient';
import { InsurancePacketSnapshot } from '../../types/iot';

const SystemOverview: React.FC = () => {
  const { user } = useAuth();
  const location = useLocation();
  const routeState = (location.state as { propertyId?: string; propertyAddress?: string } | null) || null;
  const storedProperty = getSelectedInsuranceProperty();
  const propertyId = routeState?.propertyId || storedProperty?.propertyId || '';
  const [snapshot, setSnapshot] = useState<InsurancePacketSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id || !propertyId) {
      setLoading(false);
      return;
    }

    const loadSnapshot = async () => {
      try {
        const nextSnapshot = await insurancePacketClient.getSnapshot(user.id, propertyId);
        setSnapshot(nextSnapshot);
      } catch (loadError) {
        console.error('Failed to load system overview packet:', loadError);
        setError(loadError instanceof Error ? loadError.message : 'Failed to load program packet');
      } finally {
        setLoading(false);
      }
    };

    void loadSnapshot();
  }, [propertyId, user?.id]);

  const handleDownload = async () => {
    if (!user?.id || !propertyId) {
      return;
    }
    await insurancePacketClient.downloadPdf(
      insurancePacketClient.buildProgramPacketDownloadUrl(user.id, propertyId),
      'HouseYield-Water-Damage-Mitigation-Overview.pdf',
    );
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

  if (!snapshot) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            {error || 'Select a property before opening the HouseYield program packet.'}
          </div>
        </div>
      </div>
    );
  }

  const sensorsByType = snapshot.sensors.reduce((acc, sensor) => {
    const type = sensor.type;
    if (!acc[type]) acc[type] = [];
    acc[type].push(sensor);
    return acc;
  }, {} as Record<string, typeof snapshot.sensors>);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-white border-2 border-gray-300 rounded-lg p-8 shadow-lg mb-6 print:shadow-none">
        <div className="text-center border-b-2 border-blue-600 pb-6 mb-6">
          <div className="mb-3 text-xs font-bold uppercase tracking-[0.28em] text-blue-700">HouseYield Risk Engineering</div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">HouseYield Water Damage Mitigation Overview</h1>
          <h2 className="text-xl text-gray-700">Program packet for insurers, brokers, and underwriting review</h2>
          <p className="text-sm text-gray-500 mt-2">Reference property: {snapshot.property.address}</p>
        </div>

        <div className="mb-8">
          <h3 className="text-xl font-semibold text-gray-800 mb-4 border-b border-gray-300 pb-2">Live Property Protection Twin</h3>
          <div className="grid grid-cols-1 items-stretch gap-2 text-center text-xs font-semibold text-slate-800 md:grid-cols-5">
            {[
              'Leak and climate sensors',
              'Shelly gateway / property network',
              'HouseYield monitoring and alert logic',
              'Shelly dry-contact relay',
              'EcoNet Bulldog water actuator',
            ].map((node, index) => (
              <React.Fragment key={node}>
                <div className={`flex min-h-20 items-center justify-center rounded-lg border px-3 py-4 ${index === 4 ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50'}`}>
                  {node}
                </div>
              </React.Fragment>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">Functional topology generated from enrolled equipment and saved commissioning records; not a manufacturer wiring diagram.</p>
        </div>

        <div className="mb-8">
          <h3 className="text-xl font-semibold text-gray-800 mb-4 border-b border-gray-300 pb-2">Monitoring Evidence</h3>
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-slate-500">Observed continuity</div>
              <div className="font-semibold text-slate-900">{snapshot.monitoringEvidence.telemetryContinuityPercent == null ? 'Building history' : `${snapshot.monitoringEvidence.telemetryContinuityPercent}%`}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-slate-500">Telemetry observations</div>
              <div className="font-semibold text-slate-900">{snapshot.monitoringEvidence.observationCount.toLocaleString()}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-slate-500">Healthy / enrolled</div>
              <div className="font-semibold text-slate-900">{snapshot.monitoringEvidence.currentlyHealthyDeviceCount} / {snapshot.monitoringEvidence.enrolledDeviceCount}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-slate-500">Observed since</div>
              <div className="font-semibold text-slate-900">{snapshot.monitoringEvidence.firstObservedAt ? new Date(snapshot.monitoringEvidence.firstObservedAt).toLocaleDateString() : 'Not available'}</div>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">{snapshot.monitoringEvidence.methodology}</p>
        </div>

        <div className="grid grid-cols-4 gap-4 mb-8">
          <div className="text-center p-4 bg-blue-50 rounded-lg">
            <div className="text-2xl font-bold text-blue-900">{snapshot.systemSummary.totalSensors}</div>
            <div className="text-sm text-blue-700">Assigned Devices</div>
          </div>
          <div className="text-center p-4 bg-green-50 rounded-lg">
            <div className="text-2xl font-bold text-green-900">{snapshot.systemSummary.onlineSensors}</div>
            <div className="text-sm text-green-700">Online Now</div>
          </div>
          <div className="text-center p-4 bg-purple-50 rounded-lg">
            <div className="text-2xl font-bold text-purple-900">{snapshot.systemSummary.leakSensorCount}</div>
            <div className="text-sm text-purple-700">Leak Sensors</div>
          </div>
          <div className="text-center p-4 bg-orange-50 rounded-lg">
            <div className="text-2xl font-bold text-orange-900">{snapshot.systemSummary.activeAlerts}</div>
            <div className="text-sm text-orange-700">Open Alerts</div>
          </div>
        </div>

        <div className="mb-8">
          <h3 className="text-xl font-semibold text-gray-800 mb-4 border-b border-gray-300 pb-2">Property Underwriting Context</h3>
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="text-gray-500">Property Type</div>
              <div className="font-semibold text-gray-900">{snapshot.propertyFacts.propertyType || 'Not documented'}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="text-gray-500">Occupancy</div>
              <div className="font-semibold text-gray-900">{snapshot.propertyFacts.occupancyType || 'Not documented'}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="text-gray-500">Year Built</div>
              <div className="font-semibold text-gray-900">{snapshot.propertyFacts.yearBuilt || 'Not documented'}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="text-gray-500">Living Area</div>
              <div className="font-semibold text-gray-900">{snapshot.propertyFacts.livingAreaSqFt ? `${snapshot.propertyFacts.livingAreaSqFt.toLocaleString()} sq ft` : 'Not documented'}</div>
            </div>
          </div>
        </div>

        <div className="mb-8">
          <h3 className="text-xl font-semibold text-gray-800 mb-4 border-b border-gray-300 pb-2">HouseYield Risk-Control Features</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[
              ['Automatic leak detection', 'Shelly-connected field sensors report water events, device health, and signal state back to HouseYield.'],
              ['Automatic water shutoff', snapshot.commissioning.automaticShutoffEnabled && snapshot.commissioning.unattendedShutoffVerified && snapshot.commissioning.waterFlowStoppedVerified
                ? 'The saved commissioning record documents a tested relay-controlled shutoff path and stopped-flow verification.'
                : 'The shutoff path remains a draft claim until the functional close, stopped-flow, restoration, and attestation evidence is complete.'],
              ['Live owner/manager alerting', 'The platform can notify owners or operators immediately when leak conditions or device issues are detected.'],
              ['Documented commissioning', 'Each property packet includes installer information, shutoff test results, and evidence links when recorded.'],
            ].map(([title, copy]) => (
              <div key={title}>
                <h4 className="font-semibold text-gray-800 mb-2">{title}</h4>
                <p className="text-sm text-gray-700">{copy}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-8">
          <h3 className="text-xl font-semibold text-gray-800 mb-4 border-b border-gray-300 pb-2">Installed Equipment Snapshot</h3>
          <div className="space-y-4">
            {Object.entries(sensorsByType).map(([type, typeSensors]) => (
              <div key={type}>
                <h4 className="font-medium text-gray-800 mb-2 capitalize">{type.replace(/_/g, ' ')} ({typeSensors.length})</h4>
                <div className="grid grid-cols-2 gap-2">
                  {typeSensors.map((sensor) => (
                    <div key={sensor.id} className="text-sm bg-gray-50 rounded p-2 border border-gray-200">
                      <div className="font-medium text-gray-800">{sensor.name}</div>
                      <div className="text-gray-600">{sensor.location}</div>
                      <div className="text-xs text-gray-500">Status: {sensor.status}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-green-50 border-2 border-green-300 rounded-lg p-6 mb-8">
          <h3 className="text-xl font-semibold text-green-900 mb-4">Installation And Monitoring Standard</h3>
          <div className="space-y-3 text-sm text-green-800">
            <div><strong>Carrier:</strong> {snapshot.commissioning.insurerName || 'Not documented'}</div>
            <div><strong>Valve hardware:</strong> {snapshot.commissioning.hardwareModel || 'Not documented'}</div>
            <div><strong>Installer:</strong> {[snapshot.commissioning.installerName, snapshot.commissioning.installerCompany].filter(Boolean).join(', ') || 'Not documented'}</div>
            <div><strong>Latest successful valve test:</strong> {snapshot.commissioning.latestSuccessfulTestDate || 'Not documented'}</div>
            <div><strong>Remote command verified:</strong> {snapshot.commissioning.remoteCommandVerifiedAt || 'Not documented'}</div>
            <div><strong>Leak alert verified:</strong> {snapshot.commissioning.leakAlertVerifiedAt || 'Not documented'}</div>
            <div><strong>Battery backup documented:</strong> {snapshot.commissioning.batteryBackupInstalled ? 'Yes' : 'No'}</div>
            <div><strong>Monitoring active:</strong> {snapshot.commissioning.monitoringActive ? 'Yes' : 'No'}</div>
            <div><strong>Submission readiness:</strong> {snapshot.commissioningStatus.readyForSubmission ? 'Ready for insurer submission' : `${snapshot.commissioningStatus.completionPercent}% complete`}</div>
          </div>
        </div>

        <div className="mb-8">
          <h3 className="text-xl font-semibold text-gray-800 mb-4 border-b border-gray-300 pb-2">Carrier Submission Checklist</h3>
          <div className="space-y-3">
            {snapshot.submissionChecklist.map((item) => (
              <div key={item.id} className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-medium text-gray-900">{item.label}</div>
                    {item.detail && <div className="mt-1 text-gray-600">{item.detail}</div>}
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

        <div className="mb-6">
          <h3 className="text-xl font-semibold text-gray-800 mb-4 border-b border-gray-300 pb-2">Underwriting Notes</h3>
          <div className="space-y-3 text-sm text-gray-700">
            <p>{snapshot.underwritingNarrative.request}</p>
            <p>{snapshot.underwritingNarrative.mitigationStatement}</p>
            <ul className="list-disc ml-5 space-y-1">
              {snapshot.underwritingNarrative.keyControls.map((control) => (
                <li key={control}>{control}</li>
              ))}
            </ul>
          </div>
        </div>

        <div className="border-t-2 border-gray-300 pt-4 text-center text-sm text-gray-600">
          <p className="mb-1">This HouseYield overview is generated from live property, device, alert, and commissioning data.</p>
          <p>Packet generated: {new Date(snapshot.generatedAt).toLocaleString()}</p>
        </div>
      </div>

      <div className="flex justify-center space-x-4 mb-8 print:hidden">
        <button onClick={handlePrint} className="px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition font-medium">
          🖨️ Print Overview
        </button>
        <button onClick={() => void handleDownload()} className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium">
          📄 Download PDF
        </button>
      </div>
    </div>
  );
};

export default SystemOverview;
