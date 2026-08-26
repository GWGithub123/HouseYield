import { useEffect, useMemo, useState } from 'react';
import { bookkeepingClient } from '../services/canonicalBookkeepingClient';

interface FinanceDocumentRecord {
  id: string;
  title: string;
  documentType: string;
  propertyId?: string | null;
  vendorName?: string | null;
  documentDate?: string | null;
  amount?: number | null;
  notes?: string | null;
  mimeType?: string | null;
  originalFileName?: string | null;
  createdAt: string;
  downloadPath?: string | null;
  sourceUrl?: string | null;
  contentPreview?: string | null;
  extractedFields?: Record<string, unknown> | null;
  digitization?: {
    status?: string | null;
    summary?: string | null;
  } | null;
  evidenceShadow?: {
    status?: string | null;
    evidenceType?: string | null;
    evidenceId?: string | null;
    sourceRef?: string | null;
    error?: string | null;
    searchIndex?: {
      status?: string | null;
      provider?: string | null;
    } | null;
  } | null;
}

interface FinanceDocumentSearchOverview {
  provider?: string | null;
  status?: string | null;
  summary?: string | null;
  bullets?: string[];
  confidence?: string | null;
  error?: string | null;
}

const DOCUMENT_TYPE_OPTIONS = [
  { value: 'vendor_invoice', label: 'Vendor Invoice' },
  { value: 'utility_bill', label: 'Utility Bill' },
  { value: 'bank_statement', label: 'Bank Statement' },
  { value: 'tax_form', label: 'Tax Form' },
  { value: 'insurance_bill', label: 'Insurance Bill' },
  { value: 'closing_statement', label: 'Closing Statement' },
  { value: 'other_finance_document', label: 'Other Finance Document' }
];

function formatCurrency(amount?: number | null) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return null;
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2
  }).format(amount);
}

function statusPillClass(status?: string | null) {
  switch (status) {
    case 'searched':
    case 'loaded':
    case 'summarized':
    case 'stored':
    case 'updated':
    case 'persisted':
    case 'completed':
    case 'processed':
      return 'bg-emerald-100 text-emerald-700';
    case 'not_configured':
      return 'bg-amber-100 text-amber-700';
    case 'failed':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-slate-100 text-slate-700';
  }
}

function confidencePillClass(confidence?: string | null) {
  switch (String(confidence || '').toLowerCase()) {
    case 'high':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'medium':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700';
  }
}

function isResolvedStatus(status?: string | null) {
  return ['stored', 'updated', 'persisted', 'completed', 'processed'].includes(String(status || '').toLowerCase());
}

function buildDocumentIssues(document: FinanceDocumentRecord) {
  const issues: string[] = [];
  if (!isResolvedStatus(document.digitization?.status)) {
    issues.push('OCR review is still pending or incomplete.');
  }
  if (!isResolvedStatus(document.evidenceShadow?.status)) {
    issues.push(document.evidenceShadow?.error || 'Evidence citation sync is still pending or failed.');
  }
  if (!document.vendorName) {
    issues.push('Vendor or counterparty is missing.');
  }
  if (!document.documentDate) {
    issues.push('Document date is missing.');
  }
  if (document.amount == null) {
    issues.push('Amount is missing.');
  }
  if (!document.contentPreview) {
    issues.push('No OCR text preview is available yet.');
  }
  return issues;
}

function formatExtractedFieldValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatExtractedFieldValue(item)).join(', ');
  }
  return JSON.stringify(value);
}

async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Unable to read selected file'));
    reader.readAsDataURL(file);
  });
}

export default function BookkeepingFinanceDocuments() {
  const [documents, setDocuments] = useState<FinanceDocumentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [documentQuery, setDocumentQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState<string>('not_requested');
  const [searchProvider, setSearchProvider] = useState<string | null>(null);
  const [searchOverview, setSearchOverview] = useState<FinanceDocumentSearchOverview | null>(null);
  const [form, setForm] = useState({
    title: '',
    documentType: 'vendor_invoice',
    vendorName: '',
    documentDate: new Date().toISOString().split('T')[0],
    amount: '',
    notes: ''
  });

  const loadDocuments = async (query = documentQuery) => {
    try {
      setLoading(true);
      setError(null);
      const data = await bookkeepingClient.listFinanceDocuments({
        limit: 25,
        q: query.trim() || undefined,
      });
      if (data.ok) {
        setDocuments(data.documents || []);
        setSearchStatus(data.search?.status || (query.trim() ? 'loaded' : 'not_requested'));
        setSearchProvider(data.search?.provider || null);
        setSearchOverview(data.overview || null);
      } else {
        setError(data.error || 'Failed to load finance documents');
        setSearchOverview(null);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load finance documents');
      setSearchOverview(null);
    } finally {
      setLoading(false);
    }
  };

  const searchProviderLabel = searchProvider === 'local_filter'
    ? 'Local document search'
    : searchProvider === 'sql_like'
      ? 'Local evidence search'
      : 'Browse';

  const overviewProviderLabel = searchOverview?.provider === 'gemini' ? 'Gemini overview' : 'Local overview';

  useEffect(() => {
    loadDocuments();
  }, []);

  const resetForm = () => {
    setSelectedFile(null);
    setForm({
      title: '',
      documentType: 'vendor_invoice',
      vendorName: '',
      documentDate: new Date().toISOString().split('T')[0],
      amount: '',
      notes: ''
    });
  };

  const uploadDocument = async () => {
    if (!selectedFile) {
      setError('Select a finance document to upload');
      return;
    }

    try {
      setUploading(true);
      setError(null);
      setSuccess(null);
      const fileBase64 = await fileToDataUrl(selectedFile);
      const data = await bookkeepingClient.uploadFinanceDocument({
        title: form.title || selectedFile.name,
        documentType: form.documentType,
        vendorName: form.vendorName || null,
        documentDate: form.documentDate || null,
        amount: form.amount ? parseFloat(form.amount) : null,
        notes: form.notes || null,
        originalFileName: selectedFile.name,
        fileBase64,
      });
      if (data.ok) {
        setSuccess(`Uploaded ${data.document?.title || selectedFile.name}`);
        resetForm();
        loadDocuments(documentQuery);
      } else {
        setError(data.error || 'Failed to upload finance document');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to upload finance document');
    } finally {
      setUploading(false);
    }
  };

  const downloadDocument = async (document: FinanceDocumentRecord) => {
    if (!document.downloadPath) {
      setError('This finance document is missing a download path');
      return;
    }

    try {
      const blob = await bookkeepingClient.downloadOwnerFile(document.downloadPath);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = document.originalFileName || document.title;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || 'Failed to download finance document');
    }
  };

  const recentDocuments = useMemo(() => documents.slice(0, 8), [documents]);
  const needsAttentionCount = useMemo(
    () => documents.filter((document) => buildDocumentIssues(document).length > 0).length,
    [documents],
  );
  const ocrReadyCount = useMemo(
    () => documents.filter((document) => isResolvedStatus(document.digitization?.status)).length,
    [documents],
  );
  const evidenceReadyCount = useMemo(
    () => documents.filter((document) => isResolvedStatus(document.evidenceShadow?.status)).length,
    [documents],
  );

  return (
    <div className="space-y-6">
      <div className="bg-slate-900 text-white rounded-xl p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Bookkeeping Finance Documents</div>
            <h3 className="text-lg font-semibold mt-1">Separate from leases and legal paperwork</h3>
            <p className="text-sm text-slate-300 mt-1 max-w-2xl">
              Upload invoices, bank statements, tax forms, insurance bills, and other finance support here. Legal and lease documents remain in the Property Management document system.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
            <div className="bg-white/10 rounded-lg px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-slate-400">Recent Docs</div>
              <div className="text-2xl font-semibold">{documents.length}</div>
            </div>
            <div className="bg-white/10 rounded-lg px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-slate-400">Needs Review</div>
              <div className="text-2xl font-semibold">{needsAttentionCount}</div>
            </div>
            <div className="bg-white/10 rounded-lg px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-slate-400">OCR Ready</div>
              <div className="text-2xl font-semibold">{ocrReadyCount}</div>
            </div>
            <div className="bg-white/10 rounded-lg px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-slate-400">Evidence Ready</div>
              <div className="text-2xl font-semibold">{evidenceReadyCount}</div>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex justify-between">
          {error}
          <button onClick={() => setError(null)} className="text-red-500">×</button>
        </div>
      )}
      {success && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-700 text-sm flex justify-between">
          {success}
          <button onClick={() => setSuccess(null)} className="text-emerald-500">×</button>
        </div>
      )}

      <div className="bg-white border rounded-xl p-5 space-y-4">
        <div>
          <h4 className="font-medium text-gray-900">Upload Finance Document</h4>
          <p className="text-xs text-gray-500 mt-1">Supported: PDF, JPG, PNG, WEBP. Keep leases and legal docs out of this workflow.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input
              type="text"
              value={form.title}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              placeholder="March electric bill"
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Document Type</label>
            <select
              value={form.documentType}
              onChange={(event) => setForm((current) => ({ ...current, documentType: event.target.value }))}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500"
            >
              {DOCUMENT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vendor / Counterparty</label>
            <input
              type="text"
              value={form.vendorName}
              onChange={(event) => setForm((current) => ({ ...current, vendorName: event.target.value }))}
              placeholder="Duke Energy"
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Document Date</label>
            <input
              type="date"
              value={form.documentDate}
              onChange={(event) => setForm((current) => ({ ...current, documentDate: event.target.value }))}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
            <input
              type="number"
              step="0.01"
              value={form.amount}
              onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))}
              placeholder="125.42"
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">File</label>
            <input
              type="file"
              accept="application/pdf,image/*"
              onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
              className="w-full px-3 py-2 border rounded-lg bg-white"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
          <textarea
            value={form.notes}
            onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
            rows={3}
            placeholder="Optional bookkeeping note or context for this document"
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500"
          />
        </div>

        {selectedFile && (
          <div className="text-xs text-gray-500 bg-slate-50 border rounded-lg px-3 py-2">
            Selected: <span className="font-medium text-gray-700">{selectedFile.name}</span>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={uploadDocument}
            disabled={uploading || !selectedFile}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : 'Upload Finance Document'}
          </button>
          <button
            onClick={resetForm}
            disabled={uploading}
            className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-50"
          >
            Reset
          </button>
        </div>
      </div>

      <div className="bg-white border rounded-xl overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <div>
            <h4 className="font-medium text-gray-900">Recent Finance Documents</h4>
            <p className="text-xs text-gray-500">Separate bookkeeping support documents, not legal/lease files.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusPillClass(searchStatus)}`}>
              {searchProviderLabel}
            </span>
            <button
              onClick={() => loadDocuments(documentQuery)}
              disabled={loading}
              className="px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        <div className="px-4 py-3 border-b bg-white flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex-1">
            <input
              type="text"
              value={documentQuery}
              onChange={(event) => setDocumentQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  loadDocuments(documentQuery);
                }
              }}
              placeholder="Search invoices, vendors, OCR text, or notes"
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadDocuments(documentQuery)}
              disabled={loading}
              className="px-3 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
            <button
              onClick={() => {
                setDocumentQuery('');
                loadDocuments('');
              }}
              disabled={loading && !documentQuery}
              className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>

        {(searchOverview?.summary || (searchOverview?.bullets && searchOverview.bullets.length > 0)) && (
          <div className="px-4 py-4 border-b bg-white">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">Search overview</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    Summary of the current finance document results in this bookkeeping scope.
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <span className={`rounded-full border px-2 py-0.5 ${statusPillClass(searchOverview?.status)}`}>
                    {overviewProviderLabel}
                  </span>
                  {searchOverview?.confidence && (
                    <span className={`rounded-full border px-2 py-0.5 ${confidencePillClass(searchOverview.confidence)}`}>
                      {searchOverview.confidence} confidence
                    </span>
                  )}
                </div>
              </div>

              {searchOverview?.summary && (
                <div className="mt-3 text-sm leading-6 text-slate-700">{searchOverview.summary}</div>
              )}

              {searchOverview?.bullets && searchOverview.bullets.length > 0 && (
                <ul className="mt-3 space-y-2 text-sm text-slate-600">
                  {searchOverview.bullets.map((bullet) => (
                    <li key={bullet} className="rounded-lg border border-slate-200 bg-white px-3 py-2">{bullet}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {recentDocuments.length > 0 ? (
          <div className="divide-y">
            {recentDocuments.map((document) => (
              <div key={document.id} className="px-4 py-3 hover:bg-gray-50">
                {(() => {
                  const issues = buildDocumentIssues(document);
                  const extractedEntries = Object.entries(document.extractedFields || {}).filter(([, value]) => value !== null && value !== undefined && value !== '');
                  const open = openDocumentId === document.id;
                  return (
                    <div className="space-y-3">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-gray-900">{document.title}</span>
                            <span className="px-2 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-medium">{document.documentType.replace(/_/g, ' ')}</span>
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusPillClass(document.digitization?.status)}`}>
                              OCR {document.digitization?.status || 'pending'}
                            </span>
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusPillClass(document.evidenceShadow?.status)}`}>
                              Evidence {document.evidenceShadow?.status || 'pending'}
                            </span>
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${issues.length > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
                              {issues.length > 0 ? `${issues.length} issue${issues.length === 1 ? '' : 's'}` : 'Ready'}
                            </span>
                          </div>
                          <div className="text-sm text-gray-600">
                            {document.vendorName || 'No vendor'}
                            {formatCurrency(document.amount) ? ` • ${formatCurrency(document.amount)}` : ''}
                            {document.documentDate ? ` • ${document.documentDate}` : ''}
                            {document.propertyId ? ` • ${document.propertyId}` : ''}
                          </div>
                          <div className="text-xs text-gray-500">
                            {document.notes || document.contentPreview || document.originalFileName || 'No additional note recorded.'}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="text-xs text-gray-500 text-right">
                            {new Date(document.createdAt).toLocaleString()}
                          </div>
                          <button
                            onClick={() => setOpenDocumentId((current) => current === document.id ? null : document.id)}
                            className="px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                          >
                            {open ? 'Hide details' : 'Inspect'}
                          </button>
                          <button
                            onClick={() => downloadDocument(document)}
                            disabled={!document.downloadPath}
                            className="px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                          >
                            Download
                          </button>
                        </div>
                      </div>

                      {open && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-4">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Issue detection</div>
                            {issues.length > 0 ? (
                              <ul className="mt-2 space-y-2 text-sm text-slate-700">
                                {issues.map((issue) => (
                                  <li key={issue} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">{issue}</li>
                                ))}
                              </ul>
                            ) : (
                              <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                                OCR, evidence sync, and core document fields look complete in the current workflow.
                              </div>
                            )}
                          </div>

                          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">OCR preview</div>
                              <div className="mt-2 rounded-lg border border-white bg-white px-3 py-3 text-sm text-slate-700 whitespace-pre-wrap">
                                {document.contentPreview || 'No OCR preview is available yet for this document.'}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Evidence citations</div>
                              <div className="mt-2 rounded-lg border border-white bg-white px-3 py-3 text-sm text-slate-700 space-y-2">
                                <div>
                                  <span className="font-medium text-slate-900">Evidence id:</span> {document.evidenceShadow?.evidenceId || '—'}
                                </div>
                                <div>
                                  <span className="font-medium text-slate-900">Source ref:</span> {document.evidenceShadow?.sourceRef || '—'}
                                </div>
                                <div>
                                  <span className="font-medium text-slate-900">Search index:</span> {document.evidenceShadow?.searchIndex?.status || '—'}
                                </div>
                                {document.sourceUrl && (
                                  <a href={document.sourceUrl} target="_blank" rel="noreferrer" className="inline-block text-sm font-medium text-slate-700 underline hover:text-slate-900">
                                    Open source URL
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>

                          <div>
                            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Extracted fields</div>
                            {extractedEntries.length > 0 ? (
                              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                                {extractedEntries.slice(0, 8).map(([field, value]) => (
                                  <div key={field} className="rounded-lg border border-white bg-white px-3 py-2 text-sm text-slate-700">
                                    <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{field.replace(/([A-Z])/g, ' $1')}</div>
                                    <div className="mt-1">{formatExtractedFieldValue(value)}</div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-2 rounded-lg border border-white bg-white px-3 py-3 text-sm text-slate-500">
                                No extracted document fields were persisted for this file.
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 py-8 text-sm text-gray-500 text-center">
            No bookkeeping finance documents uploaded yet.
          </div>
        )}
      </div>
    </div>
  );
}