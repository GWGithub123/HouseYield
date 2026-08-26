/**
 * PredictiveMaintenancePanel - Displays AI-driven predictive maintenance alerts
 * 
 * Analyzes temperature and humidity sensor trends to predict issues like:
 * - Mold growth risk from sustained humidity
 * - Pipe freeze/burst risk from low temperatures  
 * - Insulation failures from room-to-room temp differences
 * - HVAC issues from rapid temperature swings
 */

import { useMemo, useState } from 'react';
import type { ShellyDevice, SensorReading } from '../hooks/useShellyFirestore';
import type { PredictiveMaintenanceRisk } from '../types/iot';
import { 
  analyzeAllRisks, 
  RISK_METADATA, 
  getSeverityBgClass,
  getSeverityColor,
  DEFAULT_THRESHOLDS 
} from '../services/predictiveMaintenanceService';

interface PredictiveMaintenancePanelProps {
  devices: ShellyDevice[];
  readings: SensorReading[];
  propertyMap?: Map<string, string>; // propertyId -> address
  onCreateMaintenanceRequest?: (risk: PredictiveMaintenanceRisk) => void;
}

const PredictiveMaintenancePanel: React.FC<PredictiveMaintenancePanelProps> = ({
  devices,
  readings,
  propertyMap,
  onCreateMaintenanceRequest,
}) => {
  const [dismissedRisks, setDismissedRisks] = useState<Set<string>>(new Set());
  const [expandedRisk, setExpandedRisk] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  // Run predictive analysis
  const allRisks = useMemo(() => {
    return analyzeAllRisks(devices, readings, DEFAULT_THRESHOLDS, propertyMap);
  }, [devices, readings, propertyMap]);

  const activeRisks = allRisks.filter(r => !dismissedRisks.has(r.id));
  const dismissed = allRisks.filter(r => dismissedRisks.has(r.id));
  const displayedRisks = showDismissed ? dismissed : activeRisks;

  const criticalCount = activeRisks.filter(r => r.severity === 'critical').length;
  const highCount = activeRisks.filter(r => r.severity === 'high').length;

  const handleDismiss = (riskId: string) => {
    setDismissedRisks(prev => new Set(prev).add(riskId));
    setExpandedRisk(null);
  };

  const handleRestore = (riskId: string) => {
    setDismissedRisks(prev => {
      const next = new Set(prev);
      next.delete(riskId);
      return next;
    });
  };

  return (
    <div className="space-y-5">
      {/* Header with summary stats */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🔮</span>
            <h4 className="text-lg font-semibold text-slate-900">Predictive Maintenance</h4>
          </div>
          {activeRisks.length > 0 && (
            <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/20 text-yellow-600 border border-yellow-400/30">
              {activeRisks.length} {activeRisks.length === 1 ? 'risk' : 'risks'} detected
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {dismissed.length > 0 && (
            <button
              onClick={() => setShowDismissed(!showDismissed)}
              className="text-xs text-slate-500 hover:text-slate-700 transition px-2 py-1 rounded-lg hover:bg-slate-50"
            >
              {showDismissed ? 'Show Active' : `${dismissed.length} Dismissed`}
            </button>
          )}
        </div>
      </div>

      {/* Severity Summary Bar */}
      {activeRisks.length > 0 && !showDismissed && (
        <div className="flex items-center gap-3 text-sm">
          {criticalCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-400/30">
              <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
              <span className="text-red-600 font-medium">{criticalCount} Critical</span>
            </div>
          )}
          {highCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-500/15 border border-orange-400/30">
              <span className="w-2 h-2 rounded-full bg-orange-400" />
              <span className="text-orange-600 font-medium">{highCount} High</span>
            </div>
          )}
          {activeRisks.length - criticalCount - highCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-yellow-500/15 border border-yellow-400/30">
              <span className="w-2 h-2 rounded-full bg-yellow-400" />
              <span className="text-yellow-600 font-medium">
                {activeRisks.length - criticalCount - highCount} Medium/Low
              </span>
            </div>
          )}
        </div>
      )}

      {/* No risks — all clear */}
      {allRisks.length === 0 && (
        <div className="rounded-2xl p-8 border border-green-400/20 text-center" style={{
          background: 'linear-gradient(180deg, rgba(34,197,94,0.1) 0%, rgba(34,197,94,0.03) 100%)',
          backdropFilter: 'blur(16px)',
        }}>
          <div className="text-4xl mb-3">✅</div>
          <h5 className="text-slate-900 font-semibold text-lg mb-1">All Systems Healthy</h5>
          <p className="text-slate-500 text-sm max-w-md mx-auto">
            No predictive maintenance risks detected. Temperature and humidity levels are within normal ranges across all sensors.
          </p>
          <div className="flex items-center justify-center gap-4 mt-4 text-xs text-slate-400">
            <span>🌡️ Freeze threshold: {DEFAULT_THRESHOLDS.freezeCriticalTempF}°F</span>
            <span>💧 Mold threshold: {DEFAULT_THRESHOLDS.moldHumidityPercent}%</span>
            <span>🏠 Insulation diff: {DEFAULT_THRESHOLDS.insulationDiffTempF}°F</span>
          </div>
          <p className="text-slate-400 text-[10px] mt-3">
            Monitoring: Mold growth (EPA/ASHRAE) • Pipe burst (IBHS data) • Insulation gaps • HVAC anomalies • Energy waste
          </p>
        </div>
      )}

      {/* No active risks but some dismissed */}
      {activeRisks.length === 0 && dismissed.length > 0 && !showDismissed && (
        <div className="rounded-2xl p-6 border border-slate-200 text-center" style={{
          background: 'linear-gradient(180deg, rgba(15,23,42,0.05) 0%, rgba(15,23,42,0.02) 100%)',
        }}>
          <p className="text-slate-500 text-sm">
            All active risks have been addressed. {dismissed.length} dismissed {dismissed.length === 1 ? 'alert' : 'alerts'}.
          </p>
        </div>
      )}

      {/* Risk Cards */}
      <div className="space-y-3">
        {displayedRisks.map((risk) => {
          const meta = RISK_METADATA[risk.riskType];
          const isExpanded = expandedRisk === risk.id;
          const isDismissed = dismissedRisks.has(risk.id);

          return (
            <div
              key={risk.id}
              className={`rounded-2xl border overflow-hidden transition-all ${
                isDismissed ? 'opacity-50' : ''
              } ${getSeverityBgClass(risk.severity)}`}
              style={{
                backdropFilter: 'blur(16px)',
              }}
            >
              {/* Card Header */}
              <button
                onClick={() => setExpandedRisk(isExpanded ? null : risk.id)}
                className="w-full text-left p-4 flex items-start gap-3 hover:bg-slate-50 transition"
              >
                <span className="text-2xl mt-0.5">{meta.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-semibold text-slate-900 text-sm">{risk.title}</span>
                    <span 
                      className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border"
                      style={{ 
                        borderColor: getSeverityColor(risk.severity) + '60',
                        color: getSeverityColor(risk.severity),
                        background: getSeverityColor(risk.severity) + '15',
                      }}
                    >
                      {risk.severity}
                    </span>
                    <span className="text-slate-400 text-xs">{risk.confidence}% confidence</span>
                  </div>
                  <p className="text-slate-600 text-sm leading-relaxed line-clamp-2">
                    {risk.description}
                  </p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-slate-500">
                    <span>📍 {risk.deviceName}</span>
                    {risk.propertyAddress && <span>🏠 {risk.propertyAddress}</span>}
                    {risk.estimatedTimeToIssue && (
                      <span>⏱️ Est: {risk.estimatedTimeToIssue}</span>
                    )}
                    {risk.trendDirection && risk.trendDirection !== 'stable' && (
                      <span>{risk.trendDirection === 'rising' ? '📈' : '📉'} {risk.trendDirection}</span>
                    )}
                  </div>
                </div>
                <span className="text-slate-400 text-sm mt-1">
                  {isExpanded ? '▲' : '▼'}
                </span>
              </button>

              {/* Expanded Details */}
              {isExpanded && (
                <div className="px-4 pb-4 border-t border-slate-200 pt-4 space-y-4">
                  {/* Current Reading & Threshold */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {risk.currentValue != null && (
                      <div className="rounded-xl p-3 bg-slate-50 border border-slate-200">
                        <div className="text-slate-500 text-xs mb-1">Current</div>
                        <div className="text-slate-900 font-bold text-lg">
                          {risk.currentValue.toFixed(1)}
                          {risk.riskType.includes('humidity') || risk.riskType === 'mold_risk' ? '%' : '°F'}
                        </div>
                      </div>
                    )}
                    {risk.thresholdValue != null && (
                      <div className="rounded-xl p-3 bg-slate-50 border border-slate-200">
                        <div className="text-slate-500 text-xs mb-1">Threshold</div>
                        <div className="text-slate-900 font-bold text-lg">
                          {risk.thresholdValue}
                          {risk.riskType.includes('humidity') || risk.riskType === 'mold_risk' ? '%' : '°F'}
                        </div>
                      </div>
                    )}
                    <div className="rounded-xl p-3 bg-slate-50 border border-slate-200">
                      <div className="text-slate-500 text-xs mb-1">Data Points</div>
                      <div className="text-slate-900 font-bold text-lg">{risk.dataPoints}</div>
                    </div>
                    <div className="rounded-xl p-3 bg-slate-50 border border-slate-200">
                      <div className="text-slate-500 text-xs mb-1">Category</div>
                      <div className="text-slate-900 font-bold text-lg">{meta.category}</div>
                    </div>
                  </div>

                  {/* Recommendation */}
                  <div className="rounded-xl p-4 bg-blue-500/10 border border-blue-400/20">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm">💡</span>
                      <span className="text-blue-600 font-medium text-sm">Recommended Action</span>
                    </div>
                    <p className="text-slate-600 text-sm leading-relaxed">{risk.recommendation}</p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {onCreateMaintenanceRequest && (
                      <button
                        onClick={() => onCreateMaintenanceRequest(risk)}
                        className="px-4 py-2 rounded-xl text-sm font-medium bg-blue-500/20 hover:bg-blue-500/30 text-blue-600 border border-blue-400/30 transition"
                      >
                        🔧 Create Maintenance Request
                      </button>
                    )}
                    {!isDismissed ? (
                      <button
                        onClick={() => handleDismiss(risk.id)}
                        className="px-4 py-2 rounded-xl text-sm font-medium bg-slate-50 hover:bg-slate-50 text-slate-500 border border-slate-200 transition"
                      >
                        Dismiss
                      </button>
                    ) : (
                      <button
                        onClick={() => handleRestore(risk.id)}
                        className="px-4 py-2 rounded-xl text-sm font-medium bg-slate-50 hover:bg-slate-50 text-slate-500 border border-slate-200 transition"
                      >
                        Restore
                      </button>
                    )}
                  </div>

                  <div className="text-xs text-slate-400">
                    Detected {risk.detectedAt.toLocaleString()} · Risk ID: {risk.id.slice(0, 20)}...
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer info */}
      {allRisks.length > 0 && (
        <div className="text-center text-xs text-slate-400 pt-2">
          Analysis based on {readings.length} sensor readings from {devices.length} devices.
          Thresholds can be customized per property.
        </div>
      )}
    </div>
  );
};

export default PredictiveMaintenancePanel;
