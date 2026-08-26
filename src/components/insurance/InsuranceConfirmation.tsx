import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSelectedInsuranceProperty } from '../../services/insurancePacketClient';
import { authenticatedFetch } from '../../utils/authenticatedFetch';

const InsuranceConfirmation: React.FC = () => {
  const navigate = useNavigate();
  const [reminderSet, setReminderSet] = useState(false);
  const [submissions, setSubmissions] = useState<Array<{
    id: string;
    insurerId: string;
    status: string;
    submittedAt: string;
    carrierReference?: string | null;
    carrierResponseNotes?: string | null;
  }>>([]);
  const selectedProperty = getSelectedInsuranceProperty();
  const baseUrl = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';

  const loadSubmissions = async () => {
    if (!selectedProperty?.propertyId) return;
    const response = await authenticatedFetch(
      `${baseUrl}/api/insurance/submissions?propertyId=${encodeURIComponent(selectedProperty.propertyId)}`,
    );
    if (response.ok) setSubmissions(await response.json());
  };

  useEffect(() => {
    void loadSubmissions();
  }, [selectedProperty?.propertyId]);

  const setFollowUpReminder = async () => {
    try {
      const followUpDate = new Date();
      followUpDate.setDate(followUpDate.getDate() + 7); // 7 days from now

      await authenticatedFetch(`${baseUrl}/api/insurance/submissions/set-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          followUpDate: followUpDate.toISOString(),
          propertyId: getSelectedInsuranceProperty()?.propertyId || null,
        })
      });

      setReminderSet(true);
    } catch (error) {
      console.error('Failed to set reminder:', error);
    }
  };

  const updateSubmissionStatus = async (submissionId: string, status: string) => {
    const response = await authenticatedFetch(`${baseUrl}/api/insurance/submissions/${submissionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (response.ok) await loadSubmissions();
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow-lg p-8">
        {/* Success Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-green-100 rounded-full mb-4">
            <span className="text-5xl">✅</span>
          </div>
          <h1 className="text-4xl font-bold text-gray-800 mb-4">
            You're All Set!
          </h1>
          <p className="text-lg text-gray-600">
            Your HouseYield insurance discount request is ready to submit
          </p>
        </div>

        {/* Next Steps */}
        <div className="bg-blue-50 rounded-lg p-6 mb-8">
          <h2 className="text-xl font-semibold text-gray-800 mb-4">Next Steps</h2>
          <div className="space-y-3">
            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0 w-6 h-6 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm font-bold mt-0.5">
                1
              </div>
              <div className="flex-1">
                <p className="text-gray-700">
                  <strong>Check your email client</strong> - The pre-filled email should have opened
                </p>
              </div>
            </div>
            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0 w-6 h-6 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm font-bold mt-0.5">
                2
              </div>
              <div className="flex-1">
                <p className="text-gray-700">
                  <strong>Attach the evidence packet</strong> - Add the single sealed HouseYield water-loss mitigation PDF
                </p>
              </div>
            </div>
            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0 w-6 h-6 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm font-bold mt-0.5">
                3
              </div>
              <div className="flex-1">
                <p className="text-gray-700">
                  <strong>Review and send</strong> - Make any final edits and send your request
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Recommendation */}
        <div className="bg-yellow-50 border-l-4 border-yellow-400 p-6 mb-8">
          <div className="flex items-start space-x-3">
            <span className="text-2xl">💡</span>
            <div>
              <h3 className="font-semibold text-gray-800 mb-2">Pro Tip</h3>
              <p className="text-gray-700">
                Follow up with your agent or underwriting contact if you do not receive confirmation. Carrier review times and documentation requirements vary.
              </p>
            </div>
          </div>
        </div>

        {/* Follow-up Reminder */}
        <div className="border border-gray-200 rounded-lg p-6 mb-8">
          <h3 className="font-semibold text-gray-800 mb-3">Track Your Submission</h3>
          {submissions.length > 0 && (
            <div className="mb-5 space-y-3">
              {submissions.map((submission) => (
                <div key={submission.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-medium text-slate-900">{submission.insurerId || 'Carrier submission'}</div>
                      <div className="text-xs text-slate-500">{new Date(submission.submittedAt).toLocaleString()}</div>
                    </div>
                    <select value={submission.status} onChange={(event) => void updateSubmissionStatus(submission.id, event.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                      <option value="prepared">Prepared</option>
                      <option value="submitted">Sent to carrier / agent</option>
                      <option value="under_review">Under review</option>
                      <option value="more_information_requested">More information requested</option>
                      <option value="approved_credit">Credit approved</option>
                      <option value="denied">Declined</option>
                      <option value="no_response">No response</option>
                      <option value="withdrawn">Withdrawn</option>
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!reminderSet ? (
            <div className="flex items-center justify-between">
              <p className="text-gray-600">
                Set a reminder to follow up in 7 days
              </p>
              <button
                onClick={setFollowUpReminder}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
              >
                Set Reminder
              </button>
            </div>
          ) : (
            <div className="flex items-center space-x-3 text-green-600">
              <span className="text-xl">✓</span>
              <p className="font-medium">Reminder set for 7 days from now</p>
            </div>
          )}
        </div>

        {/* Additional Resources */}
        <div className="bg-gray-50 rounded-lg p-6 mb-8">
          <h3 className="font-semibold text-gray-800 mb-4">What to Expect</h3>
          <div className="space-y-3 text-sm text-gray-700">
            <div className="flex items-start space-x-2">
              <span className="text-blue-600">•</span>
              <p>
                <strong>Response time:</strong> Carrier review time varies; ask your agent when to follow up
              </p>
            </div>
            <div className="flex items-start space-x-2">
              <span className="text-blue-600">•</span>
              <p>
                <strong>Verification:</strong> They may request additional information or schedule an inspection
              </p>
            </div>
            <div className="flex items-start space-x-2">
              <span className="text-blue-600">•</span>
              <p>
                <strong>Eligibility decision:</strong> The carrier determines whether a credit applies, its amount, and its effective date
              </p>
            </div>
            <div className="flex items-start space-x-2">
              <span className="text-blue-600">•</span>
              <p>
                <strong>Certificate verification:</strong> Insurers can verify your certificate authenticity at any time
              </p>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-center space-x-4">
          <button
            onClick={() => navigate('/sensors')}
            className="px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition font-semibold"
          >
            Return to Dashboard
          </button>
          <button
            onClick={() => navigate('/insurance-discount/select-insurer')}
            className="px-6 py-3 border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition font-semibold"
          >
            Submit Another Request
          </button>
        </div>
      </div>
    </div>
  );
};

export default InsuranceConfirmation;
