import React, { useCallback, useState, useEffect, useRef } from 'react';
import './DocumentManager.css';
import { useAuth } from '../contexts/AuthContext';
import { useSearchParams } from 'react-router-dom';
import { ownerPropertiesClient } from '../services/ownerPropertiesClient';
import { buildOwnerFinanceUrl, requestOwnerFinanceBlob, requestOwnerFinanceJson } from '../services/ownerFinanceApi';
import { uploadPropertyDocument } from '../services/storageService';
import { pdfjs } from 'react-pdf';
import SigningReceipt from './SigningReceipt';
import DocumentPdfViewer from './DocumentPdfViewer';
import { Badge, Button, KpiStrip, Modal, SectionGroupHeader, TileGrid } from '../design-system';
import { StreetViewImage } from './StreetViewImage';
import { FileText, Pencil, PenLine, Search, Sparkles, Trash2 } from 'lucide-react';
import {
  CREATE_LEASE_PROGRESS_STEPS,
  emitAssistantActionProgress,
} from '../services/websiteControlService';

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

function resolveDocumentBackendUrl(path: string): string {
  if (!path) {
    return '';
  }

  if (/^(https?:|blob:|data:)/i.test(path)) {
    return path;
  }

  return buildOwnerFinanceUrl(path);
}

// Types
interface DigitizationKeyFact {
  label: string;
  value: string;
  confidence?: 'high' | 'medium' | 'low';
}

interface DigitizationSection {
  heading: string;
  pageNumber?: number | null;
  text: string;
}

interface ComplianceSource {
  title?: string;
  label?: string;
  url?: string;
  hostname?: string;
  category?: string;
  authorityLevel?: string;
  citation?: string | null;
  isOfficial?: boolean;
  appliesTo?: string | null;
  effectiveDate?: string | null;
  lastUpdated?: string | null;
}

interface ComplianceAuthority {
  title?: string;
  citation?: string;
  url?: string;
}

interface DocumentComplianceMetadata {
  stateCode?: string | null;
  stateName?: string | null;
  localJurisdiction?:
    | string
    | {
        name?: string;
        additionalRules?: string[];
        statuteReference?: string;
      }
    | null;
  county?: string | null;
  countyName?: string | null;
  locality?: string | null;
  city?: string | null;
  governingAuthority?: ComplianceAuthority | null;
  stateRequirements?: string[];
  localRequirements?: string[];
  requiredDisclosures?: string[];
  documentRequirements?: string[];
  warnings?: string[];
  sources?: ComplianceSource[];
  verification?: {
    status?: string | null;
    summary?: string | null;
    checkedAt?: string | null;
    provider?: string | null;
    scope?: string | null;
  } | null;
  generatedAt?: string | null;
  [key: string]: any;
}

interface DocumentDigitizationMetadata {
  status?: 'completed' | 'partial' | 'failed' | 'skipped';
  supported?: boolean;
  provider?: string | null;
  interpretationProvider?: string | null;
  claudeModel?: string | null;
  processedAt?: string;
  mimeType?: string | null;
  pageCount?: number;
  rawTextLength?: number;
  documentType?: string | null;
  classificationConfidence?: number;
  summary?: string | null;
  extractionQuality?: 'high' | 'medium' | 'low' | null;
  repairedLineCount?: number;
  keyFacts?: DigitizationKeyFact[];
  parties?: string[];
  addresses?: string[];
  dates?: string[];
  monetaryAmounts?: string[];
  identifiers?: string[];
  actionItems?: string[];
  missingOrUnclear?: string[];
  reviewNotes?: string[];
  structuredSections?: DigitizationSection[];
  tableSummaries?: Array<{
    id: string;
    pageNumber?: number | null;
    rowCount?: number;
    columnCount?: number;
    previewRows?: string[];
  }>;
  lowConfidenceWords?: Array<{
    text: string;
    confidence: number;
  }>;
  error?: string | null;
}

interface ReplicaLayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ReplicaLayoutLine {
  id: string;
  text: string;
  bbox: ReplicaLayoutBox;
  angle?: number;
  paragraphRole?: string | null;
  paragraphId?: string | null;
}

interface ReplicaLayoutParagraph {
  id: string;
  role?: string | null;
  content: string;
  bbox?: ReplicaLayoutBox | null;
  lineIds?: string[];
}

interface ReplicaLayoutPage {
  pageNumber: number;
  renderWidth: number;
  renderHeight: number;
  lines: ReplicaLayoutLine[];
  paragraphs?: ReplicaLayoutParagraph[];
}

interface ReplicaLayout {
  version?: number;
  generatedAt?: string;
  title?: string;
  pages: ReplicaLayoutPage[];
}

interface AuditMatch {
  id: string;
  matchType: 'layout' | 'text';
  pageNumber?: number | null;
  lineIds?: string[];
  excerpt: string;
  startIndex?: number;
  endIndex?: number;
  score?: number;
}

type PrimaryViewerMode = 'document' | 'layout' | 'text';

interface Document {
  id: string;
  ownerId: string;
  propertyId?: string;
  tenantId?: string;
  documentType: string;
  title: string;
  content: string;
  status: 'draft' | 'pending_signatures' | 'partially_signed' | 'completed' | 'expired' | 'cancelled';
  requiresSignature: boolean;
  signerRoles: string[];
  signatures: any[];
  signatureRequests?: SignatureRequest[];
  metadata: {
    icon: string;
    description: string;
    compliance?: DocumentComplianceMetadata;
    digitization?: DocumentDigitizationMetadata;
    // Uploaded document metadata
    isUploaded?: boolean;
    fileName?: string;
    fileType?: string;
    fileExtension?: string;
    fileSize?: number;
    filePath?: string; // URL path to download the file
    storedFileName?: string;
    uploadedAt?: string;
    hasReplica?: boolean;
    replicaStoredFileName?: string;
    replicaLayoutStoredFileName?: string;
    replicaGeneratedAt?: string;
    // Generated PDF metadata
    hasPdf?: boolean;
    pdfPath?: string;
    pdfGenerated?: boolean;
    pdfUrl?: string;
    ocrProcessed?: boolean;
    extractedText?: string | null;
    textLength?: number;
    classifiedType?: string | null;
    classificationConfidence?: number;
    extractedFields?: Record<string, any>;
    summary?: string | null;
    generatedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  expiresAt?: string;
}

interface SignatureRequest {
  signerId: string;
  signerEmail: string;
  signerName: string;
  signerRole: string;
  token: string;
  status: 'pending' | 'signed';
  requestedAt: string;
  signedAt?: string;
}

interface DocumentType {
  id: string;
  name: string;
  icon: string;
  description: string;
  requiresSignature: boolean;
  signerRoles: string[];
}

interface Property {
  id: string;
  address: string;
}

interface FirestoreProperty {
  id: string;
  ownerId?: string;
  address: string;
  propertyData?: {
    summary?: {
      beds?: number;
      baths?: number;
      living_sqft?: number;
      avm_value?: number;
      rental_avm?: number;
      attom_id?: string;
      propAddress?: string;
      address?: string;
      propCity?: string;
      city?: string;
      propState?: string;
      state?: string;
      propZip?: string;
      zip?: string;
      county?: string;
      countyName?: string;
    };
    [key: string]: any;
  };
  financials?: any;
  tenantId?: string;
  tenant?: FirestoreTenant;
  tenants?: FirestoreTenant[]; // Multiple tenants for multifamily
  tenantCount?: number;
  image?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface FirestoreTenant {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  firebaseUid?: string;
  email?: string;
  phone?: string;
  propertyAddress?: string;
  unit?: string;
  leaseStart?: string;
  leaseEnd?: string;
  monthlyRent?: number;
}

interface Tenant {
  id: string;
  name: string;
  email: string;
  propertyId: string;
  firebaseUid?: string | null;
  phone?: string;
  propertyAddress?: string;
  status?: string;
}

function formatAuditTimestamp(value?: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleString();
}

function normalizeAuditStrings(values: Array<unknown>): string[] {
  return values
    .flatMap((value) => {
      if (Array.isArray(value)) {
        return normalizeAuditStrings(value);
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
      }
      return [];
    })
    .filter((value, index, items) => items.indexOf(value) === index);
}

function getComplianceSourceLabel(source: ComplianceSource, index: number) {
  if (source.label?.trim()) {
    return source.label.trim();
  }
  if (source.title?.trim()) {
    return source.title.trim();
  }
  if (source.url?.trim()) {
    return source.url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }
  return `Source ${index + 1}`;
}

function getComplianceSourceHostname(source: ComplianceSource) {
  if (source.hostname?.trim()) {
    return source.hostname.trim();
  }
  if (source.url?.trim()) {
    try {
      return new URL(source.url).hostname.replace(/^www\./i, '');
    } catch {
      return source.url.replace(/^https?:\/\//i, '').split('/')[0] || null;
    }
  }
  return null;
}

function getComplianceSourceBadge(source: ComplianceSource) {
  if (source.isOfficial || source.category === 'official') {
    return 'Official';
  }
  if (source.category === 'legal') {
    return 'Legal';
  }
  return null;
}

const AUDIT_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'must', 'should', 'where', 'when',
  'from', 'into', 'your', 'have', 'has', 'had', 'been', 'are', 'was', 'were',
  'will', 'such', 'than', 'then', 'them', 'they', 'their', 'there', 'about',
  'under', 'after', 'before', 'only', 'also', 'each', 'through', 'include',
  'includes', 'including', 'state', 'local', 'document', 'requirements', 'required'
]);

function normalizeAuditSearchText(value = '') {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getAuditSearchTerms(value = '') {
  return Array.from(
    new Set(
      normalizeAuditSearchText(value)
        .split(' ')
        .filter((token) => token.length >= 4 && !AUDIT_STOP_WORDS.has(token))
    )
  ).slice(0, 8);
}

function countAuditTokenHits(text: string, tokens: string[]) {
  const normalized = normalizeAuditSearchText(text);
  return tokens.reduce((count, token) => (normalized.includes(token) ? count + 1 : count), 0);
}

function getHighlightedTextExcerpt(text: string, start: number, end: number, radius = 110) {
  const excerptStart = Math.max(0, start - radius);
  const excerptEnd = Math.min(text.length, end + radius);
  const prefix = excerptStart > 0 ? '...' : '';
  const suffix = excerptEnd < text.length ? '...' : '';
  return `${prefix}${text.slice(excerptStart, excerptEnd).trim()}${suffix}`;
}

function findTextAuditMatches(text: string, requirement: string): AuditMatch[] {
  if (!text.trim() || !requirement.trim()) {
    return [];
  }

  const lowerText = text.toLowerCase();
  const exactNeedle = requirement.trim().toLowerCase();
  const tokens = getAuditSearchTerms(requirement);
  const rawMatches: AuditMatch[] = [];

  if (exactNeedle.length >= 12) {
    let fromIndex = 0;
    while (fromIndex < lowerText.length) {
      const startIndex = lowerText.indexOf(exactNeedle, fromIndex);
      if (startIndex === -1) {
        break;
      }
      const endIndex = startIndex + exactNeedle.length;
      rawMatches.push({
        id: `text-exact-${startIndex}`,
        matchType: 'text',
        excerpt: getHighlightedTextExcerpt(text, startIndex, endIndex),
        startIndex,
        endIndex,
        score: 100,
      });
      fromIndex = endIndex;
    }
  }

  tokens.slice(0, 3).forEach((token, tokenIndex) => {
    const matcher = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) {
      const startIndex = match.index;
      const endIndex = startIndex + match[0].length;
      const excerpt = getHighlightedTextExcerpt(text, startIndex, endIndex);
      const score = countAuditTokenHits(excerpt, tokens) * 10 + Math.max(0, 6 - tokenIndex);
      if (score >= 12) {
        rawMatches.push({
          id: `text-token-${token}-${startIndex}`,
          matchType: 'text',
          excerpt,
          startIndex,
          endIndex,
          score,
        });
      }
    }
  });

  const deduped: AuditMatch[] = [];
  const sorted = rawMatches.sort((left, right) => {
    const scoreDiff = (right.score || 0) - (left.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (left.startIndex || 0) - (right.startIndex || 0);
  });

  for (const match of sorted) {
    if (deduped.some((existing) => {
      const leftStart = existing.startIndex || 0;
      const leftEnd = existing.endIndex || leftStart;
      const rightStart = match.startIndex || 0;
      const rightEnd = match.endIndex || rightStart;
      return Math.max(leftStart, rightStart) <= Math.min(leftEnd, rightEnd) + 24;
    })) {
      continue;
    }
    deduped.push(match);
  }

  return deduped
    .sort((left, right) => (left.startIndex || 0) - (right.startIndex || 0))
    .slice(0, 8);
}

function findLayoutAuditMatches(layout: ReplicaLayout | null, requirement: string): AuditMatch[] {
  if (!layout?.pages?.length || !requirement.trim()) {
    return [];
  }

  const normalizedRequirement = normalizeAuditSearchText(requirement);
  const tokens = getAuditSearchTerms(requirement);
  const matches: AuditMatch[] = [];

  for (const page of layout.pages) {
    const pageLines = Array.isArray(page.lines) ? page.lines : [];
    const pageParagraphs = Array.isArray(page.paragraphs) ? page.paragraphs : [];

    for (const paragraph of pageParagraphs) {
      const paragraphText = paragraph.content || '';
      const paragraphNormalized = normalizeAuditSearchText(paragraphText);
      const tokenHits = countAuditTokenHits(paragraphText, tokens);
      const hasExact = normalizedRequirement.length >= 12 && paragraphNormalized.includes(normalizedRequirement);
      if (!hasExact && tokenHits < Math.min(2, Math.max(tokens.length, 1))) {
        continue;
      }

      const lineIds = Array.isArray(paragraph.lineIds) && paragraph.lineIds.length > 0
        ? paragraph.lineIds
        : pageLines
            .filter((line) => countAuditTokenHits(line.text || '', tokens) > 0)
            .map((line) => line.id);

      if (lineIds.length === 0) {
        continue;
      }

      matches.push({
        id: `layout-paragraph-${page.pageNumber}-${paragraph.id}`,
        matchType: 'layout',
        pageNumber: page.pageNumber,
        lineIds,
        excerpt: paragraphText.trim(),
        score: (hasExact ? 80 : 0) + tokenHits * 10,
      });
    }

    if (matches.some((match) => match.pageNumber === page.pageNumber)) {
      continue;
    }

    for (const line of pageLines) {
      const lineText = line.text || '';
      const lineNormalized = normalizeAuditSearchText(lineText);
      const tokenHits = countAuditTokenHits(lineText, tokens);
      const hasExact = normalizedRequirement.length >= 12 && lineNormalized.includes(normalizedRequirement);
      if (!hasExact && tokenHits < Math.min(2, Math.max(tokens.length, 1))) {
        continue;
      }

      matches.push({
        id: `layout-line-${page.pageNumber}-${line.id}`,
        matchType: 'layout',
        pageNumber: page.pageNumber,
        lineIds: [line.id],
        excerpt: lineText.trim(),
        score: (hasExact ? 70 : 0) + tokenHits * 10,
      });
    }
  }

  return matches
    .sort((left, right) => {
      const scoreDiff = (right.score || 0) - (left.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return (left.pageNumber || 0) - (right.pageNumber || 0);
    })
    .slice(0, 8);
}

// Document type configurations
const DOCUMENT_TYPES: Record<string, DocumentType> = {
  LEASE_AGREEMENT: {
    id: 'lease_agreement',
    name: 'Lease Agreement',
    icon: '📝',
    description: 'Standard residential lease agreement',
    requiresSignature: true,
    signerRoles: ['landlord', 'tenant']
  },
  LEASE_AMENDMENT: {
    id: 'lease_amendment',
    name: 'Lease Amendment',
    icon: '📋',
    description: 'Amendment to existing lease terms',
    requiresSignature: true,
    signerRoles: ['landlord', 'tenant']
  },
  MOVE_IN_CHECKLIST: {
    id: 'move_in_checklist',
    name: 'Move-In Checklist',
    icon: '✅',
    description: 'Document property condition at move-in',
    requiresSignature: true,
    signerRoles: ['landlord', 'tenant']
  },
  MOVE_OUT_CHECKLIST: {
    id: 'move_out_checklist',
    name: 'Move-Out Checklist',
    icon: '📤',
    description: 'Document property condition at move-out',
    requiresSignature: true,
    signerRoles: ['landlord', 'tenant']
  },
  NOTICE_TO_VACATE: {
    id: 'notice_to_vacate',
    name: 'Notice to Vacate',
    icon: '📨',
    description: 'Formal notice of intent to vacate',
    requiresSignature: true,
    signerRoles: ['tenant']
  },
  RENT_INCREASE_NOTICE: {
    id: 'rent_increase_notice',
    name: 'Rent Increase Notice',
    icon: '💰',
    description: 'Notice of rent increase',
    requiresSignature: true,
    signerRoles: ['landlord']
  },
  PET_ADDENDUM: {
    id: 'pet_addendum',
    name: 'Pet Addendum',
    icon: '🐕',
    description: 'Pet policy agreement addendum',
    requiresSignature: true,
    signerRoles: ['landlord', 'tenant']
  },
  MAINTENANCE_AUTHORIZATION: {
    id: 'maintenance_authorization',
    name: 'Maintenance Authorization',
    icon: '🔧',
    description: 'Authorization for maintenance work',
    requiresSignature: true,
    signerRoles: ['tenant']
  },
  SECURITY_DEPOSIT_RECEIPT: {
    id: 'security_deposit_receipt',
    name: 'Security Deposit Receipt',
    icon: '🧾',
    description: 'Receipt for security deposit',
    requiresSignature: false,
    signerRoles: []
  },
  RENT_RECEIPT: {
    id: 'rent_receipt',
    name: 'Rent Receipt',
    icon: '💵',
    description: 'Monthly rent payment receipt',
    requiresSignature: false,
    signerRoles: []
  },
  RENTERS_INSURANCE: {
    id: 'renters_insurance',
    name: "Renter's Insurance",
    icon: '🛡️',
    description: 'Renter\'s insurance certificate uploaded by tenant',
    requiresSignature: false,
    signerRoles: []
  },
  UPLOADED_DOCUMENT: {
    id: 'uploaded_document',
    name: 'Uploaded Document',
    icon: '📁',
    description: 'Custom uploaded document',
    requiresSignature: false,
    signerRoles: []
  }
};

function resolveDocumentTypeKey(documentType?: string | null): string {
  if (!documentType) return 'UPLOADED_DOCUMENT';
  const upper = documentType.toUpperCase().replace(/-/g, '_');
  if (DOCUMENT_TYPES[upper]) return upper;
  const byId = Object.entries(DOCUMENT_TYPES).find(([, type]) => type.id === documentType);
  return byId ? byId[0] : 'UPLOADED_DOCUMENT';
}

function groupDocsByType(docs: Document[]): Map<string, Document[]> {
  const grouped = new Map<string, Document[]>();
  for (const doc of docs) {
    const key = resolveDocumentTypeKey(doc.documentType);
    const list = grouped.get(key) ?? [];
    list.push(doc);
    grouped.set(key, list);
  }
  return grouped;
}

function getPendingSignatureDocs(docs: Document[]): Document[] {
  return docs.filter((doc) => ['pending_signatures', 'partially_signed'].includes(doc.status));
}

function getDocumentTypeLabel(documentType?: string | null): string {
  const key = resolveDocumentTypeKey(documentType);
  return DOCUMENT_TYPES[key]?.name || formatAiDocumentType(documentType);
}

const DIGITIZATION_STATUS_LABELS: Record<string, string> = {
  completed: 'AI Digitized',
  partial: 'AI Extracted',
  failed: 'Digitization Failed',
  skipped: 'Digitization Skipped'
};

const DIGITIZATION_STATUS_STYLES: Record<string, { background: string; color: string; border: string }> = {
  completed: { background: '#ecfdf5', color: '#047857', border: '#a7f3d0' },
  partial: { background: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  failed: { background: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
  skipped: { background: '#f8fafc', color: '#475569', border: '#cbd5e1' }
};

function formatAiDocumentType(value?: string | null) {
  if (!value) return 'Unclassified';
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getDigitizationStyle(status?: string) {
  return DIGITIZATION_STATUS_STYLES[status || ''] || DIGITIZATION_STATUS_STYLES.partial;
}

function shouldDigitizeUploadFile(file: File) {
  return file.type.startsWith('image/');
}

function shouldShowDigitizationBadge(document: Document) {
  const status = document.metadata?.digitization?.status;
  if (status === 'not_needed') {
    return false;
  }
  return Boolean(status || document.metadata?.ocrProcessed);
}

const STATUS_CONFIG = {
  draft: { label: 'Draft', color: '#6b7280', bgColor: '#f3f4f6' },
  pending_signatures: { label: 'Pending Signatures', color: '#d97706', bgColor: '#fef3c7' },
  partially_signed: { label: 'Partially Signed', color: '#2563eb', bgColor: '#dbeafe' },
  completed: { label: 'Completed', color: '#059669', bgColor: '#d1fae5' },
  expired: { label: 'Expired', color: '#dc2626', bgColor: '#fee2e2' },
  cancelled: { label: 'Cancelled', color: '#6b7280', bgColor: '#e5e7eb' }
};

interface DocumentManagerProps {
  ownerId?: string;
  propertyId?: string;
  tenantId?: string;
  properties?: Property[];
  tenants?: Tenant[];
}

const DocumentManager: React.FC<DocumentManagerProps> = ({
  ownerId: ownerIdProp,
  propertyId,
  tenantId,
  properties = [],
  tenants: tenantsFromProps = []
}) => {
  // Get user from auth context
  const { user } = useAuth();
  const ownerId = ownerIdProp || user?.id || 'owner-1';
  const [searchParams, setSearchParams] = useSearchParams();
  const openedDocumentIdRef = useRef<string | null>(null);
  
  // State
  const [documents, setDocuments] = useState<Document[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>(tenantsFromProps);
  const [firestoreProperties, setFirestoreProperties] = useState<FirestoreProperty[]>([]);
  const [loadingProperties, setLoadingProperties] = useState(true);
  const [propertyLoadError, setPropertyLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'all' | 'pending' | 'completed' | 'templates'>('all');
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSignModal, setShowSignModal] = useState(false);
  const [showLeaseBuilder, setShowLeaseBuilder] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [isFileViewerFullscreen, setIsFileViewerFullscreen] = useState(false);

  const clearDocumentIdFromUrl = useCallback(() => {
    if (!searchParams.get('documentId')) {
      return;
    }
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('documentId');
    setSearchParams(nextParams, { replace: true });
    openedDocumentIdRef.current = null;
  }, [searchParams, setSearchParams]);

  const closeSelectedDocument = useCallback(() => {
    setSelectedDocument(null);
    setIsFileViewerFullscreen(false);
    clearDocumentIdFromUrl();
  }, [clearDocumentIdFromUrl]);

  // Open a specific document when the assistant navigates with ?documentId=
  // Only auto-open once per documentId so closing/reloading does not keep forcing it open.
  useEffect(() => {
    if (loading) {
      return;
    }

    const documentId = searchParams.get('documentId');
    if (!documentId) {
      openedDocumentIdRef.current = null;
      return;
    }

    if (openedDocumentIdRef.current === documentId && selectedDocument?.id === documentId) {
      return;
    }

    const match = documents.find((doc) => doc.id === documentId);
    if (match) {
      openedDocumentIdRef.current = documentId;
      setSelectedDocument(match);
      setShowCreateModal(false);

      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('documentId');
      setSearchParams(nextParams, { replace: true });
      return;
    }

    // Property-scoped list can miss the doc; fetch by id so assistant deep-links still work.
    let cancelled = false;
    void (async () => {
      try {
        const data = await requestOwnerFinanceJson(
          resolveDocumentBackendUrl(`/api/documents/${encodeURIComponent(documentId)}`),
        );
        const fetched = (data as any)?.document || (data as any)?.data?.document || null;
        if (cancelled || !fetched?.id) {
          return;
        }
        openedDocumentIdRef.current = documentId;
        setSelectedDocument(fetched);
        setShowCreateModal(false);
        const nextParams = new URLSearchParams(searchParams);
        nextParams.delete('documentId');
        setSearchParams(nextParams, { replace: true });
      } catch {
        // Leave documentId in the URL; list refresh may still resolve it.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documents, loading, searchParams, selectedDocument?.id, setSearchParams]);
  const [isAuditPanelOpen, setIsAuditPanelOpen] = useState(false);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [receiptDocumentId, setReceiptDocumentId] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState<boolean>(true);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string>('');
  const [previewLoadError, setPreviewLoadError] = useState<string | null>(null);
  const [replicaLayout, setReplicaLayout] = useState<ReplicaLayout | null>(null);
  const [replicaLayoutError, setReplicaLayoutError] = useState<string | null>(null);
  const [activeAuditRequirementKey, setActiveAuditRequirementKey] = useState<string>('');
  const [activeAuditRequirementText, setActiveAuditRequirementText] = useState<string>('');
  const [auditMatches, setAuditMatches] = useState<AuditMatch[]>([]);
  const [activeAuditMatchIndex, setActiveAuditMatchIndex] = useState<number>(0);
  const [editableText, setEditableText] = useState<string>('');
  const [lastSavedEditableText, setLastSavedEditableText] = useState<string>('');
  const [isEditingText, setIsEditingText] = useState<boolean>(false);
  const [autosaveStatus, setAutosaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  const [pdfHighlightCount, setPdfHighlightCount] = useState<number>(0);
  const [activePdfHighlightPage, setActivePdfHighlightPage] = useState<number | null>(null);
  const [primaryViewerMode, setPrimaryViewerMode] = useState<PrimaryViewerMode>('document');
  const [auditFallbackMode, setAuditFallbackMode] = useState<Exclude<PrimaryViewerMode, 'document'> | null>(null);
  const [isDocumentHighlightPending, setIsDocumentHighlightPending] = useState<boolean>(false);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const activeTextMatchRef = useRef<HTMLElement | null>(null);
  const replicaPageRefs = useRef<Record<number, HTMLElement | null>>({});
  const autosaveRequestCounterRef = useRef<number>(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterProperty, setFilterProperty] = useState<string>('all');

  // Document scanner state
  const [scanPropertyId, setScanPropertyId] = useState('');
  const [scannerUrl, setScannerUrl] = useState('');
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [loadingTunnel, setLoadingTunnel] = useState(false);

  // Document category tile modal (grouped by status)
  const [openDocCategoryKey, setOpenDocCategoryKey] = useState<string | null>(null);

  // Bulk selection state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDownloading, setBulkDownloading] = useState(false);

  // Property focus + templates visibility (tile grid layout)
  const [templatePickerValue, setTemplatePickerValue] = useState('');

  // Rename state
  const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Create document state
  const [newDocType, setNewDocType] = useState<string>('');
  const [newDocProperty, setNewDocProperty] = useState<string>(propertyId || '');
  const [newDocTenant, setNewDocTenant] = useState<string>(tenantId || '');
  const [newDocTitle, setNewDocTitle] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<string>('');
  const [customInstructions, setCustomInstructions] = useState<string>('');
  const [complianceMetadata, setComplianceMetadata] = useState<any>(null);

  // Signature state
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [signatureData, setSignatureData] = useState<string>('');
  const [signingAsOwner, setSigningAsOwner] = useState(false);
  const [isSubmittingSignature, setIsSubmittingSignature] = useState(false);
  const [ownerSigningToken, setOwnerSigningToken] = useState<string>('');
  const [agreeToSign, setAgreeToSign] = useState(false);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const [saveSignatureForFuture, setSaveSignatureForFuture] = useState(false);
  const [loadingSavedSignature, setLoadingSavedSignature] = useState(false);

  // Upload document state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadProperty, setUploadProperty] = useState<string>('');
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Fetch saved signature on mount
  useEffect(() => {
    if (ownerId) {
      fetchSavedSignature();
    }
  }, [ownerId]);

  const fetchSavedSignature = async () => {
    try {
      setLoadingSavedSignature(true);
      const data = await requestOwnerFinanceJson(
        resolveDocumentBackendUrl(`/api/signatures/${ownerId}`)
      );
      if (data.ok && data.hasSignature) {
        setSavedSignature(data.signature.signatureData);
        console.log('[DocumentManager] Loaded saved signature');
      }
    } catch (error) {
      console.error('[DocumentManager] Error fetching saved signature:', error);
    } finally {
      setLoadingSavedSignature(false);
    }
  };

  // Fetch properties from Firestore
  useEffect(() => {
    if (ownerId) {
      fetchFirestoreProperties();
    }
  }, [ownerId]);

  useEffect(() => {
    if (!showCreateModal) return;
    if (newDocProperty && firestoreProperties.some((property) => property.id === newDocProperty)) return;

    const fallbackPropertyId = propertyId || firestoreProperties[0]?.id || '';
    if (fallbackPropertyId && fallbackPropertyId !== newDocProperty) {
      setNewDocProperty(fallbackPropertyId);
    }
  }, [firestoreProperties, newDocProperty, propertyId, showCreateModal]);

  const fetchFirestoreProperties = async () => {
    if (!ownerId) {
      setFirestoreProperties([]);
      setPropertyLoadError(null);
      setLoadingProperties(false);
      return;
    }

    setLoadingProperties(true);
    setPropertyLoadError(null);
    try {
      const properties = await ownerPropertiesClient.listDetailed(ownerId, { withTenants: true });
      const normalizeFirestoreTenant = (tenant: any, fallbackId?: string | null): FirestoreTenant | undefined => {
        const resolvedId = typeof tenant?.id === 'string' && tenant.id
          ? tenant.id
          : (typeof fallbackId === 'string' && fallbackId ? fallbackId : undefined);

        if (!tenant && !resolvedId) {
          return undefined;
        }

        return {
          id: resolvedId || '',
          name: tenant?.name,
          firstName: tenant?.firstName,
          lastName: tenant?.lastName,
          firebaseUid: tenant?.firebaseUid,
          email: tenant?.email,
          phone: tenant?.phone,
          propertyAddress: tenant?.propertyAddress,
          unit: tenant?.unit,
          leaseStart: tenant?.leaseStart,
          leaseEnd: tenant?.leaseEnd,
          monthlyRent: tenant?.monthlyRent,
        };
      };

      const normalizedProperties: FirestoreProperty[] = properties.map((property) => ({
        id: property.id,
        ownerId,
        address: property.address || '',
        propertyData: (property.propertyData || property.property_data) as FirestoreProperty['propertyData'],
        financials: property.financials,
        tenantId: property.tenantId || undefined,
        tenant: normalizeFirestoreTenant(property.tenant, property.tenantId),
        tenants: Array.isArray(property.tenants)
          ? property.tenants
              .map((tenant) => normalizeFirestoreTenant(tenant))
              .filter((tenant): tenant is FirestoreTenant => Boolean(tenant))
          : undefined,
        tenantCount: property.tenantCount,
        image: property.image || undefined,
        createdAt: property.createdAt,
        updatedAt: property.updatedAt,
      }));

      setFirestoreProperties(normalizedProperties);
      console.log('[DocumentManager] Loaded', normalizedProperties.length, 'properties from canonical owner store');

      const extractedTenants: Tenant[] = normalizedProperties.flatMap((property) => {
        const propertyTenants = Array.isArray(property.tenants) && property.tenants.length > 0
          ? property.tenants
          : property.tenant
            ? [{ ...property.tenant, id: property.tenantId || property.tenant.id }]
            : [];

        return propertyTenants
          .map((tenant: any): Tenant | null => {
            const resolvedTenantId = tenant.id || property.tenantId;
            if (!resolvedTenantId) {
              return null;
            }

            return {
              id: resolvedTenantId,
              firebaseUid: tenant.firebaseUid || null,
              name: tenant.name || `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Unknown',
              email: tenant.email || '',
              phone: tenant.phone || '',
              propertyId: property.id,
              propertyAddress: property.address,
              status: tenant.status || 'active',
            };
          })
          .filter((tenant): tenant is Tenant => Boolean(tenant));
      });

      if (extractedTenants.length > 0) {
        console.log('[DocumentManager] Extracted', extractedTenants.length, 'tenants from properties');
        setTenants(prev => {
          const existingIds = new Set(prev.map(t => t.id));
          const newTenants = extractedTenants.filter((tenant: any) => !existingIds.has(tenant.id));
          return [...prev, ...newTenants];
        });
      }
    } catch (error) {
      console.error('[DocumentManager] Error fetching properties:', error);
      setFirestoreProperties([]);
      setPropertyLoadError(error instanceof Error ? error.message : 'Unable to load properties from the owner property store.');
    } finally {
      setLoadingProperties(false);
    }
  };

  // Fetch tenants
  useEffect(() => {
    if (!tenantsFromProps.length) {
      fetchTenants();
    }
  }, [ownerId, tenantsFromProps.length]);

  const fetchTenants = async () => {
    try {
      if (!ownerId) {
        setTenants([]);
        return;
      }

      const ownerTenants = await ownerPropertiesClient.listTenants(ownerId);
      setTenants(ownerTenants as Tenant[]);
    } catch (error) {
      console.error('Error fetching tenants:', error);
    }
  };

  // Fetch documents
  useEffect(() => {
    fetchDocuments();
  }, [ownerId, propertyId, tenantId]);

  const fetchDocuments = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (ownerId) params.append('ownerId', ownerId);
      if (propertyId) params.append('propertyId', propertyId);
      if (tenantId) params.append('tenantId', tenantId);

      const requestPath = params.toString() ? `/api/documents?${params.toString()}` : '/api/documents';
      const data = await requestOwnerFinanceJson(resolveDocumentBackendUrl(requestPath));
      
      if (data.ok) {
        setDocuments(data.documents);
      }
    } catch (error) {
      console.error('Error fetching documents:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter documents
  const filteredDocuments = documents.filter(doc => {
    // Tab filter
    if (activeTab === 'pending' && !['pending_signatures', 'partially_signed'].includes(doc.status)) {
      return false;
    }
    if (activeTab === 'completed' && doc.status !== 'completed') {
      return false;
    }

    // Search filter
    if (searchTerm && !doc.title.toLowerCase().includes(searchTerm.toLowerCase())) {
      return false;
    }

    // Type filter
    if (filterType !== 'all' && doc.documentType !== filterType) {
      return false;
    }

    // Property filter
    if (filterProperty !== 'all' && doc.propertyId !== filterProperty) {
      return false;
    }

    return true;
  });

  // Stats
  const stats = {
    total: documents.length,
    pending: documents.filter(d => ['pending_signatures', 'partially_signed'].includes(d.status)).length,
    completed: documents.filter(d => d.status === 'completed').length,
    draft: documents.filter(d => d.status === 'draft').length
  };

  const getDocumentOriginalUrl = (document: Document) => {
    if (document.metadata?.isUploaded) {
      return resolveDocumentBackendUrl(`/api/documents/${document.id}/pdf`);
    }

    if (document.metadata?.pdfGenerated && document.metadata?.pdfUrl) {
      return resolveDocumentBackendUrl(document.metadata.pdfUrl);
    }

    return resolveDocumentBackendUrl(`/api/documents/${document.id}/pdf`);
  };

  const getDocumentPreviewUrl = (document: Document) => {
    if (document.metadata?.replicaStoredFileName) {
      return resolveDocumentBackendUrl(`/api/documents/${document.id}/replica`);
    }

    return getDocumentOriginalUrl(document);
  };

  const hasDigitizedReplica = !!selectedDocument?.metadata?.replicaStoredFileName;

  const openOriginalDocument = async (document: Document) => {
    try {
      const blob = await requestOwnerFinanceBlob(getDocumentOriginalUrl(document));
      const objectUrl = URL.createObjectURL(blob);
      const openedWindow = window.open(objectUrl, '_blank', 'noopener,noreferrer');

      if (!openedWindow) {
        window.location.href = objectUrl;
      }

      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
      console.error('Error opening original document:', error);
      alert('Unable to open the original document. Please try Download instead.');
    }
  };

  const getReplicaLayoutUrl = (document: Document) => {
    if (!document.metadata?.replicaLayoutStoredFileName) {
      return '';
    }
    return resolveDocumentBackendUrl(`/api/documents/${document.id}/layout`);
  };

  const getDigitizationSummaryHeading = (document: Document) => {
    if (document.metadata?.replicaStoredFileName) {
      return 'AI Interpretation';
    }
    return 'Summary';
  };

  const getDigitizationTextHeading = (document: Document) => {
    if (document.metadata?.replicaStoredFileName) {
      return 'Source Text';
    }
    if (document.metadata?.isUploaded || document.metadata?.ocrProcessed) {
      return 'Extracted Text';
    }
    return 'Document Text';
  };

  const selectedReplicaLayoutUrl = selectedDocument ? getReplicaLayoutUrl(selectedDocument) : '';

  const getDigitizedReplicaLabel = (document: Document) => {
    if (document.metadata?.replicaStoredFileName) {
      return 'Digitized Replica';
    }
    return 'AI Extracted';
  };

  const getDocumentPreviewMode = (document: Document) => {
    if (document.metadata?.replicaStoredFileName) {
      return 'replica';
    }
  
    if (document.metadata?.isUploaded) {
      return 'original';
    }
  
    if (document.metadata?.pdfGenerated && document.metadata?.pdfUrl) {
      return 'generated';
    }
  
    return 'original'; // Changed from 'generated' to 'original'
  };

  const selectedDigitization = selectedDocument?.metadata?.digitization;
  const selectedComplianceMetadata = selectedDocument?.metadata?.compliance || null;
  const selectedProperty = selectedDocument?.propertyId
    ? firestoreProperties.find((property) => property.id === selectedDocument.propertyId)
    : undefined;
  const selectedPropertySummary = selectedProperty?.propertyData?.summary;
  const selectedPreviewRequestUrl = selectedDocument ? getDocumentOriginalUrl(selectedDocument) : '';
  const selectedPreviewIsPdf = Boolean(
    selectedDocument?.metadata?.hasPdf
    || selectedDocument?.metadata?.pdfGenerated
    || selectedDocument?.metadata?.fileType === 'application/pdf'
    || selectedDocument?.metadata?.fileExtension?.toLowerCase() === 'pdf'
    || (!selectedDocument?.metadata?.isUploaded && !selectedDocument?.metadata?.fileType)
  );
  const selectedDigitizationStatus = selectedDigitization?.status || (selectedDocument?.metadata?.ocrProcessed ? 'partial' : undefined);
  const selectedDigitizationStyle = getDigitizationStyle(selectedDigitizationStatus);
  const selectedKeyFacts = (selectedDigitization?.keyFacts || selectedDocument?.metadata?.extractedFields?.keyFacts || []) as DigitizationKeyFact[];
  const selectedExtractedText = selectedDocument?.metadata?.extractedText || selectedDocument?.content || '';
  const selectedLocalJurisdiction = typeof selectedComplianceMetadata?.localJurisdiction === 'string'
    ? selectedComplianceMetadata.localJurisdiction
    : selectedComplianceMetadata?.localJurisdiction?.name || null;
  const selectedCounty = selectedComplianceMetadata?.county
    || selectedComplianceMetadata?.countyName
    || selectedProperty?.propertyData?.area_context?.county
    || selectedPropertySummary?.county
    || selectedPropertySummary?.countyName
    || null;
  const selectedLocality = selectedComplianceMetadata?.locality
    || selectedComplianceMetadata?.city
    || selectedProperty?.propertyData?.area_context?.city
    || selectedPropertySummary?.propCity
    || selectedPropertySummary?.city
    || null;
  const selectedStateLabel = selectedComplianceMetadata?.stateName
    || selectedPropertySummary?.propState
    || selectedPropertySummary?.state
    || selectedComplianceMetadata?.stateCode
    || null;
  const selectedAuditWarnings = normalizeAuditStrings([
    selectedComplianceMetadata?.warnings || []
  ]);
  const selectedGoverningAuthority = selectedComplianceMetadata?.governingAuthority || null;
  const selectedStateRequirements = normalizeAuditStrings([
    selectedComplianceMetadata?.stateRequirements || []
  ]);
  const selectedLocalRequirements = normalizeAuditStrings([
    selectedComplianceMetadata?.localRequirements || []
  ]);
  const selectedDisclosureRequirements = normalizeAuditStrings([
    selectedComplianceMetadata?.requiredDisclosures || []
  ]);
  const selectedDocumentRequirements = normalizeAuditStrings([
    selectedComplianceMetadata?.documentRequirements || []
  ]);
  const selectedAuditSources = Array.isArray(selectedComplianceMetadata?.sources)
    ? selectedComplianceMetadata.sources.filter((source): source is ComplianceSource => Boolean(source?.label || source?.title || source?.url || source?.citation))
    : [];
  const selectedVerificationItems = normalizeAuditStrings([
    selectedComplianceMetadata?.verification?.summary,
    selectedComplianceMetadata?.verification?.status
      ? `Verification status: ${selectedComplianceMetadata.verification.status}`
      : null,
    selectedComplianceMetadata?.verification?.provider
      ? `Provider: ${selectedComplianceMetadata.verification.provider}`
      : null,
    selectedComplianceMetadata?.verification?.scope
      ? `Scope: ${selectedComplianceMetadata.verification.scope}`
      : null,
    formatAuditTimestamp(selectedComplianceMetadata?.verification?.checkedAt)
      ? `Checked ${formatAuditTimestamp(selectedComplianceMetadata?.verification?.checkedAt)}`
      : null,
    formatAuditTimestamp(selectedComplianceMetadata?.generatedAt || selectedDocument?.metadata?.generatedAt)
      ? `Saved ${formatAuditTimestamp(selectedComplianceMetadata?.generatedAt || selectedDocument?.metadata?.generatedAt)}`
      : null
  ]);
  const auditStatusTone = selectedAuditWarnings.length > 0 ? 'warning' : 'ready';
  const auditStatusLabel = !selectedComplianceMetadata
    ? 'No audit data saved'
    : selectedAuditWarnings.length > 0
      ? 'Review warnings'
      : 'Compliance snapshot saved';
  const selectedInfoGroups = [
    { label: 'Parties', values: selectedDigitization?.parties },
    { label: 'Addresses', values: selectedDigitization?.addresses },
    { label: 'Dates', values: selectedDigitization?.dates },
    { label: 'Amounts', values: selectedDigitization?.monetaryAmounts },
    { label: 'Identifiers', values: selectedDigitization?.identifiers },
    { label: 'Action Items', values: selectedDigitization?.actionItems },
    { label: 'Needs Review', values: selectedDigitization?.missingOrUnclear }
  ].filter((group) => Array.isArray(group.values) && group.values.length > 0);
  const editableTextSource = selectedExtractedText || selectedDocument?.content || '';
  const hasDocumentPreview = Boolean(selectedPreviewRequestUrl);
  const hasLayoutPrimary = Boolean(replicaLayout?.pages?.length);
  const hasTextPrimary = Boolean(editableTextSource.trim());
  const canEditDocumentText = Boolean(selectedDocument) && (!selectedDocument?.signatureRequests || selectedDocument.signatureRequests.length === 0);
  const signatureLockReason = selectedDocument?.signatureRequests?.length
    ? 'Editing is locked while signature requests are active.'
    : '';
  const activeAuditMatch = auditMatches[activeAuditMatchIndex] || null;
  const resolvedPrimaryViewerMode: PrimaryViewerMode = primaryViewerMode === 'layout'
    ? (hasLayoutPrimary ? 'layout' : hasDocumentPreview ? 'document' : hasTextPrimary ? 'text' : 'document')
    : primaryViewerMode === 'text'
      ? (hasTextPrimary ? 'text' : hasLayoutPrimary ? 'layout' : hasDocumentPreview ? 'document' : 'document')
      : (hasDocumentPreview ? 'document' : hasLayoutPrimary ? 'layout' : hasTextPrimary ? 'text' : 'document');
  const usesReplicaHighlighting = resolvedPrimaryViewerMode === 'layout' && hasLayoutPrimary;
  const usesPdfHighlighting = resolvedPrimaryViewerMode === 'document' && selectedPreviewIsPdf && pdfHighlightCount > 0;
  const isSearchingPrimaryDocument = resolvedPrimaryViewerMode === 'document' && selectedPreviewIsPdf && isDocumentHighlightPending;
  const activeViewerMatchCount = usesPdfHighlighting
    ? pdfHighlightCount
    : (usesReplicaHighlighting || resolvedPrimaryViewerMode === 'text')
      ? auditMatches.length
      : 0;
  const currentAuditMatchLabel = activeAuditMatch?.matchType === 'layout'
    ? `Page ${activeAuditMatch.pageNumber}`
    : usesPdfHighlighting && activePdfHighlightPage
      ? `Page ${activePdfHighlightPage}`
      : usesPdfHighlighting
        ? `PDF match ${Math.min(activeAuditMatchIndex + 1, pdfHighlightCount)}`
        : 'Text excerpt';
  const primaryViewerLabel = resolvedPrimaryViewerMode === 'layout'
    ? 'layout view'
    : resolvedPrimaryViewerMode === 'text'
      ? (isEditingText ? 'text editor' : 'text view')
      : 'document preview';
  const auditRequirementSections = [
    { key: 'state', label: 'State requirements', items: selectedStateRequirements, tone: 'default' as const },
    { key: 'local', label: 'Local requirements', items: selectedLocalRequirements, tone: 'default' as const },
    { key: 'disclosures', label: 'Disclosures', items: selectedDisclosureRequirements, tone: 'default' as const },
    { key: 'document', label: 'Document requirements', items: selectedDocumentRequirements, tone: 'default' as const },
    { key: 'warnings', label: 'Warnings', items: selectedAuditWarnings, tone: 'warning' as const }
  ].filter((section) => section.items.length > 0);

  useEffect(() => {
    setIsAuditPanelOpen(false);
    setReplicaLayout(null);
    setReplicaLayoutError(null);
    setActiveAuditRequirementKey('');
    setActiveAuditRequirementText('');
    setAuditMatches([]);
    setActiveAuditMatchIndex(0);
    setEditableText(editableTextSource);
    setLastSavedEditableText(editableTextSource);
    setIsEditingText(false);
    setAutosaveStatus('idle');
    setAutosaveError(null);
    setPdfHighlightCount(0);
    setActivePdfHighlightPage(null);
    setPrimaryViewerMode('document');
    setAuditFallbackMode(null);
    setIsDocumentHighlightPending(false);
  }, [selectedDocument?.id]);

  useEffect(() => {
    setEditableText(editableTextSource);
    setLastSavedEditableText(editableTextSource);
  }, [editableTextSource, selectedDocument?.id]);

  useEffect(() => {
    let isCancelled = false;

    if (!selectedReplicaLayoutUrl) {
      setReplicaLayout(null);
      setReplicaLayoutError(null);
      return () => undefined;
    }

    const loadReplicaLayout = async () => {
      try {
        const data = await requestOwnerFinanceJson(selectedReplicaLayoutUrl);
        if (isCancelled) {
          return;
        }

        if (data?._httpOk === false) {
          throw new Error(data.error || 'Unable to load digitized layout.');
        }

        setReplicaLayout(data as ReplicaLayout);
        setReplicaLayoutError(null);
      } catch (error) {
        if (isCancelled) {
          return;
        }
        setReplicaLayout(null);
        setReplicaLayoutError(error instanceof Error ? error.message : 'Unable to load digitized layout.');
      }
    };

    void loadReplicaLayout();
    return () => {
      isCancelled = true;
    };
  }, [selectedReplicaLayoutUrl]);

  useEffect(() => {
    if (!activeAuditRequirementText) {
      setAuditMatches([]);
      setAuditFallbackMode(null);
      setIsDocumentHighlightPending(false);
      return;
    }

    const layoutMatches = findLayoutAuditMatches(replicaLayout, activeAuditRequirementText);
    const textMatches = findTextAuditMatches(editableText, activeAuditRequirementText);
    const nextMatches = layoutMatches.length > 0 ? layoutMatches : textMatches;
    setAuditMatches(nextMatches);
    setAuditFallbackMode(layoutMatches.length > 0 ? 'layout' : textMatches.length > 0 ? 'text' : null);
    setActiveAuditMatchIndex(0);
  }, [activeAuditRequirementText, replicaLayout, editableText]);

  useEffect(() => {
    if (!activeAuditRequirementText || !selectedPreviewIsPdf || resolvedPrimaryViewerMode !== 'document') {
      return;
    }
    if (isDocumentHighlightPending || pdfHighlightCount > 0) {
      return;
    }
    if (auditFallbackMode) {
      setPrimaryViewerMode(auditFallbackMode);
    }
  }, [
    activeAuditRequirementText,
    auditFallbackMode,
    isDocumentHighlightPending,
    pdfHighlightCount,
    resolvedPrimaryViewerMode,
    selectedPreviewIsPdf
  ]);

  useEffect(() => {
    if (!selectedDocument || !canEditDocumentText) {
      return;
    }
    if (editableText === lastSavedEditableText) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const requestId = autosaveRequestCounterRef.current + 1;
      autosaveRequestCounterRef.current = requestId;
      setAutosaveStatus('saving');
      setAutosaveError(null);

      void requestOwnerFinanceJson(
        resolveDocumentBackendUrl(`/api/documents/${selectedDocument.id}/content`),
        {
          method: 'PATCH',
          body: JSON.stringify({
            content: editableText,
            ...(selectedDocument.metadata?.ocrProcessed
              || selectedDocument.metadata?.replicaStoredFileName
              || selectedDocument.metadata?.extractedText
              ? { extractedText: editableText }
              : {})
          })
        },
        { 'Content-Type': 'application/json' }
      ).then((data) => {
        if (requestId !== autosaveRequestCounterRef.current) {
          return;
        }
        if (!data.ok || !data.document) {
          throw new Error(data.error || 'Autosave failed.');
        }

        setLastSavedEditableText(editableText);
        setAutosaveStatus('saved');
        setDocuments((prev) => prev.map((document) => (
          document.id === data.document.id ? data.document : document
        )));
        setSelectedDocument((prev) => (prev?.id === data.document.id ? data.document : prev));
      }).catch((error) => {
        if (requestId !== autosaveRequestCounterRef.current) {
          return;
        }
        setAutosaveStatus('error');
        setAutosaveError(error instanceof Error ? error.message : 'Autosave failed.');
      });
    }, 900);

    return () => window.clearTimeout(timeoutId);
  }, [canEditDocumentText, editableText, lastSavedEditableText, selectedDocument]);

  useEffect(() => {
    if (!activeAuditMatch) {
      return;
    }

    if (activeAuditMatch.matchType === 'layout' && activeAuditMatch.pageNumber != null) {
      replicaPageRefs.current[activeAuditMatch.pageNumber]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });
      return;
    }

    if (activeAuditMatch.matchType === 'text') {
      if (isEditingText && textEditorRef.current && activeAuditMatch.startIndex != null && activeAuditMatch.endIndex != null) {
        textEditorRef.current.focus();
        textEditorRef.current.setSelectionRange(activeAuditMatch.startIndex, activeAuditMatch.endIndex);
        const lineHeight = 22;
        const charactersPerLine = 78;
        const estimatedLine = Math.max(Math.floor(activeAuditMatch.startIndex / charactersPerLine), 0);
        textEditorRef.current.scrollTop = Math.max(estimatedLine * lineHeight - 80, 0);
      } else {
        activeTextMatchRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }
    }
  }, [activeAuditMatch, isEditingText]);

  useEffect(() => {
    let isCancelled = false;
    let objectUrl: string | null = null;

    if (!selectedDocument || !selectedPreviewRequestUrl) {
      setPreviewObjectUrl('');
      setPreviewLoadError(null);
      setPdfLoading(false);
      return () => undefined;
    }

    setPdfLoading(true);
    setPreviewLoadError(null);
    setPreviewObjectUrl('');

    const loadPreview = async () => {
      try {
        const blob = await requestOwnerFinanceBlob(selectedPreviewRequestUrl);
        objectUrl = URL.createObjectURL(blob);

        if (isCancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        setPreviewObjectUrl(objectUrl);
      } catch (error) {
        if (isCancelled) {
          return;
        }

        console.error('Error loading document preview:', error);
        setPreviewLoadError(error instanceof Error ? error.message : 'Unable to load document preview.');
      } finally {
        if (!isCancelled) {
          setPdfLoading(false);
        }
      }
    };

    void loadPreview();

    return () => {
      isCancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [selectedDocument?.id, selectedDocument?.updatedAt, selectedPreviewRequestUrl]);

  // Generate document content with AI
  const generateDocumentCore = useCallback(async (options: {
    docType: string;
    docPropertyId?: string;
    docTenantId?: string;
    instructions?: string;
  }) => {
    const activePropertyId = options.docPropertyId || propertyId || firestoreProperties[0]?.id || '';
    const selectedProperty = firestoreProperties.find(p => p.id === activePropertyId);
    const selectedTenant = tenants.find(t => t.id === (options.docTenantId || ''));

    const ownerName = user?.name || 'Property Owner';

    let tenantFullName = '';
    if (selectedTenant) {
      tenantFullName = (selectedTenant as any).name ||
        `${(selectedTenant as any).firstName || ''} ${(selectedTenant as any).lastName || ''}`.trim();
    }

    const tenantData = selectedProperty?.tenant || selectedTenant;
    const leaseStart = (tenantData as any)?.leaseStart || '';
    const leaseEnd = (tenantData as any)?.leaseEnd || '';
    const monthlyRent = (tenantData as any)?.monthlyRent || selectedProperty?.financials?.monthlyRent || '';
    const securityDeposit = selectedProperty?.financials?.securityDeposit || monthlyRent || '';
    const propertySummary = ((selectedProperty?.propertyData?.summary || selectedProperty?.propertyData || {}) as NonNullable<FirestoreProperty['propertyData']>['summary']);

    let propertyAddress = selectedProperty?.address || '';

    if (!propertyAddress && activePropertyId) {
      const propFromProps = properties.find((p: any) => p.id === activePropertyId || p.address === activePropertyId);
      if (propFromProps) {
        propertyAddress = (propFromProps as any).address || (propFromProps as any).fullAddress || '';
      }
    }

    if (!propertyAddress && selectedProperty?.propertyData) {
      const parts = [
        propertySummary?.propAddress || propertySummary?.address || '',
        propertySummary?.propCity || propertySummary?.city || '',
        propertySummary?.propState || propertySummary?.state || '',
        propertySummary?.propZip || propertySummary?.zip || ''
      ].filter(Boolean);
      if (parts.length > 0) propertyAddress = parts.join(', ');
    }

    if (propertyAddress && !/[A-Z]{2}\s*\d{5}/i.test(propertyAddress) &&
        !/(,|\s)(MD|VA|DC|DE|PA|NJ|WV|D\.C\.)/i.test(propertyAddress)) {
      const propCity = propertySummary?.propCity || propertySummary?.city || '';
      const propState = propertySummary?.propState || propertySummary?.state || '';
      const propZip = propertySummary?.propZip || propertySummary?.zip || '';
      if (propState) {
        propertyAddress = `${propertyAddress}, ${propCity} ${propState} ${propZip}`.replace(/\s+/g, ' ').trim();
      }
    }

    return requestOwnerFinanceJson(
      resolveDocumentBackendUrl('/api/documents/generate'),
      {
        method: 'POST',
        body: JSON.stringify({
          documentType: options.docType,
          propertyAddress,
          landlordName: ownerName,
          tenantName: tenantFullName,
          customInstructions: options.instructions || '',
          additionalData: {
            leaseStartDate: leaseStart,
            leaseEndDate: leaseEnd,
            monthlyRent,
            securityDeposit,
            ownerEmail: user?.email || '',
            tenantEmail: selectedTenant?.email || '',
            propertyBeds: propertySummary?.beds,
            propertyBaths: propertySummary?.baths,
            propertySqft: propertySummary?.living_sqft,
            propertyState: propertySummary?.propState || propertySummary?.state || '',
            propertyCity: propertySummary?.propCity || propertySummary?.city || '',
            propertyZip: propertySummary?.propZip || propertySummary?.zip || '',
            propertyCounty: propertySummary?.county || propertySummary?.countyName || ''
          }
        })
      },
      { 'Content-Type': 'application/json' }
    );
  }, [firestoreProperties, propertyId, properties, tenants, user?.email, user?.name]);

  const handleGenerateDocument = async () => {
    if (!newDocType) return;

    setGenerating(true);
    try {
      const data = await generateDocumentCore({
        docType: newDocType,
        docPropertyId: newDocProperty || propertyId || firestoreProperties[0]?.id || '',
        docTenantId: newDocTenant || tenantId || '',
        instructions: customInstructions,
      });

      if (data.ok) {
        setGeneratedContent(data.content);
        if (data.complianceMetadata) {
          setComplianceMetadata(data.complianceMetadata);
        }
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Error generating document:', error);
      alert('Failed to generate document');
    } finally {
      setGenerating(false);
    }
  };

  // Create document
  const handleCreateDocument = async () => {
    if (!newDocType || !generatedContent) return;

    try {
      const activePropertyId = newDocProperty || propertyId || firestoreProperties[0]?.id || undefined;
      const data = await requestOwnerFinanceJson(
        resolveDocumentBackendUrl('/api/documents'),
        {
          method: 'POST',
          body: JSON.stringify({
          ownerId,
          propertyId: activePropertyId,
          tenantId: newDocTenant || undefined,
          documentType: newDocType,
          title: newDocTitle || DOCUMENT_TYPES[newDocType]?.name || 'New Document',
          content: generatedContent,
          metadata: complianceMetadata ? {
            compliance: complianceMetadata,
            generatedAt: new Date().toISOString()
          } : undefined
          })
        },
        { 'Content-Type': 'application/json' }
      );

      if (data.ok && data.document?.id) {
        await fetchDocuments();
        resetCreateForm();
        setShowCreateModal(false);
      } else {
        alert(`Error: ${data.error || 'Document save did not return a persisted document.'}`);
      }
    } catch (error) {
      console.error('Error creating document:', error);
      alert('Failed to create document');
    }
  };

  // Request signatures
  const handleRequestSignatures = async (document: Document) => {
    // First try to find tenant by document.tenantId
    let selectedTenant: any = tenants.find(t => t.id === document.tenantId);
    
    // If no tenant on document, try to find tenant by property
    if (!selectedTenant && document.propertyId) {
      // Look for a tenant associated with this property
      selectedTenant = tenants.find(t => t.propertyId === document.propertyId);
      console.log('[Signature] Looking for tenant by propertyId:', document.propertyId, 'Found:', selectedTenant);
    }
    
    // Also check Firestore properties for tenant data
    if (!selectedTenant && document.propertyId) {
      const propertyWithTenant = firestoreProperties.find(p => p.id === document.propertyId);
      if (propertyWithTenant?.tenant && propertyWithTenant?.tenantId) {
        selectedTenant = {
          id: propertyWithTenant.tenantId,
          firebaseUid: propertyWithTenant.tenant.firebaseUid || null,
          name: propertyWithTenant.tenant.name || `${propertyWithTenant.tenant.firstName || ''} ${propertyWithTenant.tenant.lastName || ''}`.trim() || 'Tenant',
          email: propertyWithTenant.tenant.email || '',
          propertyId: document.propertyId
        };
        console.log('[Signature] Found tenant from Firestore property:', selectedTenant);
      }
    }
    
    if (!selectedTenant) {
      alert('No tenant associated with this document. Please make sure the property has a tenant linked.');
      return;
    }

    const signers = [
      { id: ownerId, email: 'owner@example.com', name: 'Property Owner', role: 'landlord' },
      { 
        id: selectedTenant.id, 
        firebaseUid: selectedTenant.firebaseUid || null, // Pass Firebase UID for tenant portal queries
        email: selectedTenant.email, 
        name: selectedTenant.name, 
        role: 'tenant' 
      }
    ];

    try {
      const data = await requestOwnerFinanceJson(
        resolveDocumentBackendUrl('/api/documents/signature-request'),
        {
          method: 'POST',
          body: JSON.stringify({
          documentId: document.id,
          signers
          })
        },
        { 'Content-Type': 'application/json' }
      );

      if (data.ok) {
        alert('Signature requests sent successfully!');
        fetchDocuments();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Error requesting signatures:', error);
      alert('Failed to send signature requests');
    }
  };

  // Signature canvas handlers
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;

    setIsDrawing(true);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const x = 'touches' in e ? e.touches[0].clientX - rect.left : e.clientX - rect.left;
    const y = 'touches' in e ? e.touches[0].clientY - rect.top : e.clientY - rect.top;

    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const x = 'touches' in e ? e.touches[0].clientX - rect.left : e.clientX - rect.left;
    const y = 'touches' in e ? e.touches[0].clientY - rect.top : e.clientY - rect.top;

    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    setIsDrawing(false);
    const canvas = signatureCanvasRef.current;
    if (canvas) {
      setSignatureData(canvas.toDataURL());
    }
  };

  const clearSignature = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setSignatureData('');
  };

  // Open owner signing modal
  const openOwnerSigningModal = (doc: Document) => {
    // Find the landlord signature request
    const landlordRequest = doc.signatureRequests?.find(
      req => req.signerRole === 'landlord' && req.status === 'pending'
    );
    
    if (!landlordRequest) {
      alert('No pending landlord signature required for this document');
      return;
    }
    
    setOwnerSigningToken(landlordRequest.token);
    setSelectedDocument(doc);
    setShowSignModal(true);
    setSigningAsOwner(true);
    setAgreeToSign(false);
    clearSignature();
  };

  // Submit owner signature
  const handleOwnerSign = async () => {
    if (!selectedDocument || !signatureData || !ownerSigningToken || !agreeToSign) {
      if (!agreeToSign) {
        alert('Please agree to the electronic signature terms');
      }
      return;
    }

    setIsSubmittingSignature(true);
    try {
      // Save signature for future use if requested
      if (saveSignatureForFuture && ownerId) {
        try {
          await requestOwnerFinanceJson(
            resolveDocumentBackendUrl('/api/signatures/save'),
            {
              method: 'POST',
              body: JSON.stringify({
              userId: ownerId,
              signatureData,
              name: user?.name || 'Owner Signature'
              })
            },
            { 'Content-Type': 'application/json' }
          );
          setSavedSignature(signatureData);
          console.log('[DocumentManager] Signature saved for future use');
        } catch (saveError) {
          console.error('Error saving signature:', saveError);
          // Continue with signing even if save fails
        }
      }

      const data = await requestOwnerFinanceJson(
        resolveDocumentBackendUrl(`/api/documents/sign/${selectedDocument.id}`),
        {
          method: 'POST',
          body: JSON.stringify({
          token: ownerSigningToken,
          signatureData,
          ipAddress: 'client', // Server will capture actual IP
          userAgent: navigator.userAgent
          })
        },
        { 'Content-Type': 'application/json' }
      );

      if (data.ok) {
        alert('Document signed successfully!');
        setShowSignModal(false);
        clearSignature();
        setOwnerSigningToken('');
        setAgreeToSign(false);
        setSaveSignatureForFuture(false);
        setSigningAsOwner(false);
        fetchDocuments(); // Refresh documents list
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Error signing document:', error);
      alert('Failed to sign document');
    } finally {
      setIsSubmittingSignature(false);
    }
  };

  // Use saved signature for auto-sign
  const useSavedSignature = () => {
    if (savedSignature) {
      setSignatureData(savedSignature);
      // Draw saved signature on canvas
      const canvas = signatureCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const img = new Image();
          img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          };
          img.src = savedSignature;
        }
      }
    }
  };

  // Delete saved signature
  const deleteSavedSignature = async () => {
    if (!ownerId) return;
    
    try {
      await requestOwnerFinanceJson(
        resolveDocumentBackendUrl(`/api/signatures/${ownerId}`),
        { method: 'DELETE' }
      );
      setSavedSignature(null);
      console.log('[DocumentManager] Saved signature deleted');
    } catch (error) {
      console.error('Error deleting saved signature:', error);
    }
  };

  const readFileAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error('Failed to read uploaded file'));
    };

    reader.onerror = () => {
      reject(reader.error || new Error('Failed to read uploaded file'));
    };

    reader.readAsDataURL(file);
  });

  const resetCreateForm = () => {
    setNewDocType('');
    setNewDocProperty(propertyId || firestoreProperties[0]?.id || '');
    setNewDocTenant(tenantId || '');
    setNewDocTitle('');
    setGeneratedContent('');
    setCustomInstructions('');
    setComplianceMetadata(null);
  };

  const documentActionInFlightRef = useRef(false);

  const runQueuedDocumentAction = useCallback(async (payload: {
    action?: string;
    documentType?: string;
    propertyId?: string;
    propertyAddress?: string;
    tenantId?: string;
    customInstructions?: string;
    requestSummary?: string;
    autoGenerate?: boolean;
    followAlongOnly?: boolean;
  }) => {
    if (payload.action !== 'create-lease-agreement' || documentActionInFlightRef.current) {
      return;
    }

    documentActionInFlightRef.current = true;
    const actionId = 'create-lease-agreement';
    const summary = payload.requestSummary || 'Create a lease agreement with Gemini.';
    const title = 'Create Lease Agreement';
    const pause = (ms = 750) => new Promise(resolve => window.setTimeout(resolve, ms));
    const followAlongOnly = payload.followAlongOnly === true;

    const emit = (
      currentStep: number,
      status: 'start' | 'step' | 'complete' | 'error',
      detailMessage?: string,
      error?: string,
    ) => {
      // When the backend owns generation, keep the modal as visual context only —
      // do not overwrite the smoother backend task-pad progress stream.
      if (followAlongOnly) return;
      emitAssistantActionProgress({
        actionId,
        title,
        summary,
        steps: CREATE_LEASE_PROGRESS_STEPS,
        currentStep,
        status,
        detailMessage,
        error,
      });
    };

    try {
      emit(0, 'start', 'Got it — starting your lease request.');
      await pause();

      resetCreateForm();
      const docType = payload.documentType || 'LEASE_AGREEMENT';
      let docProperty = payload.propertyId || propertyId || '';
      if (!docProperty && payload.propertyAddress) {
        const needle = String(payload.propertyAddress).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const needleNumber = needle.split(' ').find((token) => /^\d+[a-z]?$/.test(token));
        const match = firestoreProperties.find((property) => {
          const candidate = String(property.address || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          if (!candidate) return false;
          const candidateNumber = candidate.split(' ').find((token) => /^\d+[a-z]?$/.test(token));
          if (needleNumber && candidateNumber && needleNumber !== candidateNumber) return false;
          return candidate.includes(needle) || needle.includes(candidate);
        });
        docProperty = match?.id || '';
      }
      if (!docProperty) {
        docProperty = firestoreProperties[0]?.id || '';
      }
      const docTenant = payload.tenantId || tenantId || '';
      setNewDocType(docType);
      setNewDocProperty(docProperty);
      setNewDocTenant(docTenant);
      if (payload.customInstructions) {
        setCustomInstructions(payload.customInstructions);
      }
      setShowCreateModal(true);

      emit(1, 'step', 'Documents workspace is open.');
      await pause();

      emit(2, 'step', 'Loading property, tenant, and lease context.');
      await pause(500);

      if (followAlongOnly || payload.autoGenerate === false) {
        if (!followAlongOnly) {
          emit(4, 'complete', 'Lease form is open — review details and click Generate when ready.');
        }
        window.dispatchEvent(new CustomEvent('houseyield:document-action-complete', {
          detail: { action: actionId, success: true, followAlongOnly },
        }));
        return;
      }

      emit(3, 'step', 'Submitting your lease draft to the Gemini document generator…');
      setGenerating(true);

      const data = await generateDocumentCore({
        docType,
        docPropertyId: docProperty,
        docTenantId: docTenant,
        instructions: payload.customInstructions || '',
      });

      if (!data.ok) {
        throw new Error(data.error || 'Gemini document generation failed.');
      }

      setGeneratedContent(data.content);
      if (data.complianceMetadata) {
        setComplianceMetadata(data.complianceMetadata);
      }

      emit(4, 'step', 'Saving the lease to Documents for this property…');
      const propertyLabel = firestoreProperties.find((p) => p.id === docProperty)?.address;
      const typeName = DOCUMENT_TYPES[docType]?.name || 'Lease Agreement';
      const savedTitle = propertyLabel ? `${typeName} – ${propertyLabel}` : (newDocTitle || typeName);
      const saved = await requestOwnerFinanceJson(
        resolveDocumentBackendUrl('/api/documents'),
        {
          method: 'POST',
          body: JSON.stringify({
            ownerId,
            propertyId: docProperty || undefined,
            tenantId: docTenant || undefined,
            documentType: docType,
            title: savedTitle,
            content: data.content,
            metadata: {
              source: 'assistant_action',
              ...(data.complianceMetadata ? { compliance: data.complianceMetadata } : {}),
              generatedAt: new Date().toISOString(),
              propertyAddress: propertyLabel || '',
            },
          }),
        },
        { 'Content-Type': 'application/json' },
      );

      if (!saved?.ok || !saved.document) {
        throw new Error(saved?.error || 'Lease generated but could not be saved to Documents.');
      }

      setShowCreateModal(false);
      await fetchDocuments();
      setSelectedDocument(saved.document);

      emit(4, 'complete', 'Lease saved to Documents for this property.');
      window.dispatchEvent(new CustomEvent('houseyield:document-action-complete', {
        detail: {
          action: actionId,
          success: true,
          documentId: saved.document.id,
          propertyId: docProperty,
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Document generation failed.';
      emit(3, 'error', message, message);
      window.dispatchEvent(new CustomEvent('houseyield:document-action-complete', {
        detail: { action: actionId, success: false, error: message },
      }));
    } finally {
      setGenerating(false);
      documentActionInFlightRef.current = false;
    }
  }, [firestoreProperties, generateDocumentCore, newDocTitle, ownerId, propertyId, tenantId]);

  useEffect(() => {
    const consumeQueuedDocumentAction = () => {
      const raw = window.sessionStorage.getItem('houseyield:document-action');
      if (!raw) {
        return;
      }

      try {
        const payload = JSON.parse(raw);
        if (payload?.action !== 'create-lease-agreement') {
          return;
        }

        if (payload.createdAt && Date.now() - payload.createdAt > 120000) {
          window.sessionStorage.removeItem('houseyield:document-action');
          return;
        }

        window.sessionStorage.removeItem('houseyield:document-action');
        void runQueuedDocumentAction(payload);
      } catch {
        window.sessionStorage.removeItem('houseyield:document-action');
      }
    };

    const handleDocumentAction = (event: Event) => {
      const detail = (event as CustomEvent<{
        action?: string;
        documentType?: string;
        propertyId?: string;
        tenantId?: string;
        customInstructions?: string;
        requestSummary?: string;
        autoGenerate?: boolean;
      }>).detail;

      if (detail?.action !== 'create-lease-agreement') {
        return;
      }

      window.sessionStorage.removeItem('houseyield:document-action');
      void runQueuedDocumentAction(detail);
    };

    consumeQueuedDocumentAction();
    window.addEventListener('houseyield:document-action', handleDocumentAction);
    return () => window.removeEventListener('houseyield:document-action', handleDocumentAction);
  }, [runQueuedDocumentAction]);

  // Generate document scanner URL with Cloudflare tunnel for mobile access
  const generateScannerUrl = async (propertyId: string) => {
    setLoadingTunnel(true);
    try {
      // Fetch tunnel URL from backend
      const response = await fetch('/api/auth/mobile-scan-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: ownerId,
          userEmail: 'owner@houseyield.com',
          userName: 'Property Owner',
          userRole: 'owner'
        })
      });

      const data = await response.json();
      
      // Generate a unique session token for this scan
      const sessionToken = `scan_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
      const cacheBuster = `v=${Date.now()}`;
      
      // Use tunnel URL if available, otherwise fall back to window.location.origin
      const baseUrl = data.tunnelUrl || window.location.origin;
      setTunnelUrl(data.tunnelUrl || null);
      
      const scanUrl = `${baseUrl}/document-scanner?ownerId=${ownerId}&propertyId=${propertyId}&session=${sessionToken}&${cacheBuster}`;
      setScannerUrl(scanUrl);
      return scanUrl;
    } catch (error) {
      console.error('[DocumentScanner] Error fetching tunnel URL:', error);
      // Fallback to localhost
      const sessionToken = `scan_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
      const scanUrl = `${window.location.origin}/document-scanner?ownerId=${ownerId}&propertyId=${propertyId}&session=${sessionToken}`;
      setScannerUrl(scanUrl);
      setTunnelUrl(null);
      return scanUrl;
    } finally {
      setLoadingTunnel(false);
    }
  };

  // Reset scanner modal
  const resetScanModal = () => {
    setScanPropertyId('');
    setScannerUrl('');
    setTunnelUrl(null);
    setLoadingTunnel(false);
  };

  // Reset upload form
  const resetUploadForm = () => {
    setUploadFile(null);
    setUploadTitle('');
    setUploadProperty('');
    setUploadProgress(0);
    if (uploadInputRef.current) {
      uploadInputRef.current.value = '';
    }
  };

  // Handle file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadFile(file);
      // Auto-populate title from filename if empty
      if (!uploadTitle) {
        const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
        setUploadTitle(nameWithoutExt);
      }
    }
  };

  // Upload document handler - uploads to Firebase Storage, stores metadata in Firestore
  const handleUploadDocument = async () => {
    if (!uploadFile || !uploadProperty) {
      alert('Please select a file and property');
      return;
    }

    // Check file size - limit to 25MB for Firebase Storage
    const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
    if (uploadFile.size > MAX_FILE_SIZE) {
      alert('File size must be less than 25MB.');
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      const fileType = uploadFile.type || 'application/octet-stream';
      const fileExtension = uploadFile.name.split('.').pop()?.toLowerCase() || 'file';
      const willDigitize = shouldDigitizeUploadFile(uploadFile);
      
      setUploadProgress(20);

      // Step 1: Upload file to Firebase Storage (NOT base64 to Firestore)
      const uploadResult = await uploadPropertyDocument(ownerId, uploadProperty, uploadFile);
      setUploadProgress(willDigitize ? 70 : 85);

      if (!uploadResult.success) {
        throw new Error(uploadResult.error || 'Failed to upload file to storage');
      }

      const fileData = willDigitize ? await readFileAsDataUrl(uploadFile) : undefined;

      // Step 2: Save document metadata to Firestore (images are digitized server-side)
      const data = await requestOwnerFinanceJson(
        resolveDocumentBackendUrl('/api/documents/save-metadata'),
        {
          method: 'POST',
          body: JSON.stringify({
          ownerId,
          propertyId: uploadProperty,
          title: uploadTitle || uploadFile.name,
          fileName: uploadFile.name,
          fileType: fileType,
          fileExtension: fileExtension,
          fileSize: uploadFile.size,
          ...(fileData ? { fileData } : {}),
          fileUrl: uploadResult.downloadURL,     // Firebase Storage URL
          storagePath: uploadResult.storagePath  // For deletion if needed
          })
        },
        { 'Content-Type': 'application/json' }
      );

      setUploadProgress(100);

      if (data.ok) {
        setDocuments([data.document, ...documents]);
        resetUploadForm();
        setShowUploadModal(false);
        alert('Document uploaded successfully! 📄');
      } else {
        alert(`Error saving document: ${data.error}`);
      }
      
      setUploading(false);
    } catch (error: any) {
      console.error('Error uploading document:', error);
      alert(error.message || 'Failed to upload document');
      setUploading(false);
    }
  };

  // Delete document
  const handleDeleteDocument = async (documentId: string) => {
    if (!confirm('Are you sure you want to delete this document?')) return;

    try {
      const data = await requestOwnerFinanceJson(
        resolveDocumentBackendUrl(`/api/documents/${documentId}`),
        { method: 'DELETE' }
      );
      if (data.ok) {
        setDocuments(documents.filter(d => d.id !== documentId));
        closeSelectedDocument();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Error deleting document:', error);
      alert('Failed to delete document');
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} document${selectedIds.size > 1 ? 's' : ''}? This cannot be undone.`)) return;

    const ids = Array.from(selectedIds);
    const results = await Promise.allSettled(
      ids.map(id => requestOwnerFinanceJson(resolveDocumentBackendUrl(`/api/documents/${id}`), { method: 'DELETE' }))
    );
    const deleted = ids.filter((_, i) => (results[i] as PromiseFulfilledResult<any>).value?.ok);
    setDocuments(prev => prev.filter(d => !deleted.includes(d.id)));
    setSelectedIds(new Set());
    setSelectionMode(false);
    if (deleted.length < ids.length) alert(`${ids.length - deleted.length} document(s) could not be deleted.`);
  };

  const toggleSelectDoc = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleBulkDownload = async () => {
    if (selectedIds.size === 0) return;
    setBulkDownloading(true);
    const docs = documents.filter(d => selectedIds.has(d.id));
    // Stagger downloads to avoid browser pop-up blocking
    for (let i = 0; i < docs.length; i++) {
      await handleDownloadDocument(docs[i]);
      if (i < docs.length - 1) await new Promise(r => setTimeout(r, 400));
    }
    setBulkDownloading(false);
  };

  const handleRenameDocument = async (docId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) { setRenamingDocId(null); return; }
    // Update local state immediately
    setDocuments(prev => prev.map(d => d.id === docId ? { ...d, title: trimmed } : d));
    if (selectedDocument?.id === docId) setSelectedDocument(prev => prev ? { ...prev, title: trimmed } : prev);
    setRenamingDocId(null);
    try {
      await requestOwnerFinanceJson(
        resolveDocumentBackendUrl(`/api/documents/${docId}/title`),
        {
          method: 'PATCH',
          body: JSON.stringify({ title: trimmed }),
        },
        { 'Content-Type': 'application/json' }
      );
    } catch (error) {
      console.error('Error renaming document:', error);
    }
  };

  const handleAuditRequirementSelect = (sectionKey: string, requirement: string) => {
    const nextKey = `${sectionKey}:${requirement}`;
    setActiveAuditRequirementKey(nextKey);
    setActiveAuditRequirementText(requirement);
    setPdfHighlightCount(0);
    setActivePdfHighlightPage(null);
    const layoutMatches = findLayoutAuditMatches(replicaLayout, requirement);
    const textMatches = findTextAuditMatches(editableText, requirement);
    const matches = layoutMatches.length > 0 ? layoutMatches : textMatches;
    const nextFallbackMode = layoutMatches.length > 0 ? 'layout' : textMatches.length > 0 ? 'text' : null;
    setAuditMatches(matches);
    setActiveAuditMatchIndex(0);
    setAuditFallbackMode(nextFallbackMode);
    if (selectedPreviewIsPdf && hasDocumentPreview) {
      setPrimaryViewerMode('document');
      setIsDocumentHighlightPending(true);
      return;
    }
    setIsDocumentHighlightPending(false);
    if (nextFallbackMode) {
      setPrimaryViewerMode(nextFallbackMode);
      return;
    }
    if (hasDocumentPreview) {
      setPrimaryViewerMode('document');
    }
  };

  const goToAuditMatch = (direction: 1 | -1) => {
    const matchCount = Math.max(activeViewerMatchCount, auditMatches.length);
    if (matchCount <= 1) {
      return;
    }
    setActiveAuditMatchIndex((current) => {
      const nextIndex = current + direction;
      if (nextIndex < 0) {
        return matchCount - 1;
      }
      if (nextIndex >= matchCount) {
        return 0;
      }
      return nextIndex;
    });
  };

  const toggleDocumentEditing = () => {
    if (!canEditDocumentText) {
      return;
    }
    setIsEditingText((value) => {
      const nextValue = !value;
      if (nextValue) {
        setPrimaryViewerMode('text');
      }
      return nextValue;
    });
    setAutosaveError(null);
    setAutosaveStatus((current) => (current === 'error' ? 'idle' : current));
  };

  const formatComplianceSourceContext = (source: ComplianceSource) => {
    const metadata = [
      getComplianceSourceHostname(source),
      source.citation,
      source.appliesTo ? `Applies to ${source.appliesTo}` : null,
      source.effectiveDate && formatAuditTimestamp(source.effectiveDate)
        ? `In effect ${formatAuditTimestamp(source.effectiveDate)}`
        : null,
      source.lastUpdated && formatAuditTimestamp(source.lastUpdated)
        ? `Updated ${formatAuditTimestamp(source.lastUpdated)}`
        : null
    ].filter(Boolean);

    return metadata.join(' • ');
  };
  const handleDownloadDocument = async (document: Document) => {
    try {
      const blob = await requestOwnerFinanceBlob(getDocumentOriginalUrl(document));
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = document.metadata?.fileName || `${document.title.replace(/[^a-z0-9]/gi, '_')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Fallback to text download on error
      const blob = new Blob([document.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = `${document.title.replace(/[^a-z0-9]/gi, '_')}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const renderHighlightedEditableText = () => {
    if (!activeAuditMatch || activeAuditMatch.matchType !== 'text' || activeAuditMatch.startIndex == null || activeAuditMatch.endIndex == null) {
      return editableText;
    }

    return (
      <>
        {editableText.slice(0, activeAuditMatch.startIndex)}
        <mark ref={activeTextMatchRef} className="doc-viewer-text-highlight">
          {editableText.slice(activeAuditMatch.startIndex, activeAuditMatch.endIndex)}
        </mark>
        {editableText.slice(activeAuditMatch.endIndex)}
      </>
    );
  };

  const renderPrimaryTextPane = () => (
    <div className={`doc-viewer-primary-editor ${isEditingText ? 'editing' : 'reading'}`}>
      <div className="doc-viewer-primary-editor-top">
        <div>
          <div className="doc-viewer-primary-editor-title">
            {isEditingText ? 'Editing saved document' : 'Saved document text'}
          </div>
          <div className="doc-viewer-primary-editor-copy">
            {isEditingText
              ? 'Changes autosave to the saved document and update downstream document text where supported.'
              : activeAuditRequirementKey
                ? 'Requirement highlights are shown in this main pane when the original document preview cannot map them directly.'
                : 'Use this primary view to read, highlight, and edit the saved document text.'}
          </div>
        </div>
      </div>
      {autosaveError && (
        <div className="doc-viewer-inline-alert error">
          {autosaveError}
        </div>
      )}
      <div className="doc-viewer-primary-text-stage">
        <div className={`doc-viewer-primary-text-page ${isEditingText ? 'editing' : 'reading'}`}>
          {isEditingText ? (
            <textarea
              ref={textEditorRef}
              className="doc-viewer-primary-editor-input"
              value={editableText}
              onChange={(event) => {
                setEditableText(event.target.value);
                if (autosaveStatus === 'saved') {
                  setAutosaveStatus('idle');
                }
              }}
            />
          ) : (
            <pre className="doc-viewer-primary-text-display">
              {renderHighlightedEditableText()}
            </pre>
          )}
        </div>
      </div>
    </div>
  );

  const renderReplicaPreview = () => {
    if (!replicaLayout?.pages?.length) {
      return null;
    }

    const activeLineIds = new Set(
      activeAuditMatch?.matchType === 'layout'
        ? activeAuditMatch.lineIds || []
        : []
    );

    return (
      <div className="doc-viewer-replica-shell">
        {replicaLayout.pages.map((page) => (
          <section
            key={page.pageNumber}
            ref={(node) => {
              replicaPageRefs.current[page.pageNumber] = node;
            }}
            className={`doc-viewer-replica-page ${activeAuditMatch?.matchType === 'layout' && activeAuditMatch.pageNumber === page.pageNumber ? 'active' : ''}`}
          >
            <div className="doc-viewer-replica-page-meta">Page {page.pageNumber}</div>
            <div
              className="doc-viewer-replica-surface"
              style={{ aspectRatio: `${Math.max(page.renderWidth || 1, 1)} / ${Math.max(page.renderHeight || 1, 1)}` }}
            >
              {page.lines.map((line) => (
                <div
                  key={line.id}
                  className={`doc-viewer-replica-line ${activeLineIds.has(line.id) ? 'matched' : ''}`}
                  style={{
                    left: `${(line.bbox.x / Math.max(page.renderWidth || 1, 1)) * 100}%`,
                    top: `${(line.bbox.y / Math.max(page.renderHeight || 1, 1)) * 100}%`,
                    width: `${(line.bbox.width / Math.max(page.renderWidth || 1, 1)) * 100}%`,
                    minHeight: `${Math.max((line.bbox.height / Math.max(page.renderHeight || 1, 1)) * 100, 1.6)}%`,
                    transform: line.angle ? `rotate(${line.angle}deg)` : undefined,
                  }}
                  title={line.text}
                >
                  {line.text}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  };

  // Helper: group documents by status (used for pending e-signature sidebar)
  const groupDocsByStatus = (docs: Document[]) => {
    const pending = docs.filter(d => ['pending_signatures', 'partially_signed'].includes(d.status));
    const completed = docs.filter(d => d.status === 'completed');
    const drafts = docs.filter(d => d.status === 'draft');
    const other = docs.filter(d => !['pending_signatures', 'partially_signed', 'completed', 'draft'].includes(d.status));
    return { pending, completed, drafts, other };
  };

  const getOpenCategoryMeta = (typeKey: string) => {
    return DOCUMENT_TYPES[typeKey] ?? DOCUMENT_TYPES.UPLOADED_DOCUMENT;
  };

  // Helper: render a single document item card
  const renderDocumentItem = (doc: Document) => (
    <div
      key={doc.id}
      className={`document-item-card${selectionMode && selectedIds.has(doc.id) ? ' selected' : ''}`}
      onClick={() => {
        if (renamingDocId === doc.id) return;
        selectionMode ? toggleSelectDoc(doc.id) : setSelectedDocument(doc);
      }}
    >
      {selectionMode && (
        <input
          type="checkbox"
          className="doc-item-checkbox"
          checked={selectedIds.has(doc.id)}
          onChange={() => toggleSelectDoc(doc.id)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <div className="doc-item-icon">
        <FileText size={18} strokeWidth={1.75} />
      </div>
      <div className="doc-item-info">
        {renamingDocId === doc.id ? (
          <div className="doc-item-rename-row" onClick={(e) => e.stopPropagation()}>
            <input
              className="doc-item-rename-input"
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameDocument(doc.id, renameValue);
                if (e.key === 'Escape') setRenamingDocId(null);
              }}
            />
            <button
              className="rename-save-btn"
              onClick={() => handleRenameDocument(doc.id, renameValue)}
              title="Save"
            >✓</button>
            <button
              className="rename-cancel-btn"
              onClick={() => setRenamingDocId(null)}
              title="Cancel"
            >✕</button>
          </div>
        ) : (
          <div className="doc-item-title">{doc.title}</div>
        )}
        <div className="doc-item-meta">
          {new Date(doc.createdAt).toLocaleDateString()}
          {doc.documentType && ` · ${getDocumentTypeLabel(doc.documentType)}`}
        </div>
        {(shouldShowDigitizationBadge(doc)) && (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              marginTop: '6px',
              padding: '3px 8px',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.02em',
              background: getDigitizationStyle(doc.metadata?.digitization?.status || 'partial').background,
              color: getDigitizationStyle(doc.metadata?.digitization?.status || 'partial').color,
              border: `1px solid ${getDigitizationStyle(doc.metadata?.digitization?.status || 'partial').border}`
            }}
          >
            <span>AI</span>
            <span>{DIGITIZATION_STATUS_LABELS[doc.metadata?.digitization?.status || 'partial'] || 'AI Extracted'}</span>
          </div>
        )}
      </div>
      <span
        className="doc-item-status"
        style={{
          backgroundColor: STATUS_CONFIG[doc.status]?.bgColor,
          color: STATUS_CONFIG[doc.status]?.color
        }}
      >
        {STATUS_CONFIG[doc.status]?.label}
      </span>
      <div className="doc-item-actions">
        {!selectionMode && (
          <>
            <button
              className="doc-item-action-btn"
              title="Rename document"
              onClick={(e) => {
                e.stopPropagation();
                setRenamingDocId(doc.id);
                setRenameValue(doc.title);
              }}
            >
              <Pencil size={14} />
            </button>
            <button
              className="doc-item-action-btn danger"
              title="Delete document"
              onClick={(e) => { e.stopPropagation(); handleDeleteDocument(doc.id); }}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );

  const renderPendingSignatureItem = (doc: Document) => {
    const pendingSigners = (doc.signatureRequests ?? []).filter((req) => req.status === 'pending');
    const signerSummary = pendingSigners.length > 0
      ? pendingSigners.map((req) => req.signerName || req.signerRole).join(', ')
      : 'Awaiting signature';

    return (
      <button
        key={doc.id}
        type="button"
        className="pending-signature-item"
        onClick={() => setSelectedDocument(doc)}
      >
        <div className="pending-signature-item-main">
          <span className="pending-signature-item-title">{doc.title}</span>
          <span className="pending-signature-item-meta">{getDocumentTypeLabel(doc.documentType)}</span>
          <span className="pending-signature-item-signers">{signerSummary}</span>
        </div>
        <Badge tone="warn" dot>Awaiting</Badge>
      </button>
    );
  };

  if (loading) {
    return (
      <div className="document-manager-loading">
        <div className="loading-spinner"></div>
        <p>Loading documents...</p>
      </div>
    );
  }

  return (
    <div className="document-manager">
      <div className="dm-scroll-area">
        <KpiStrip
          items={[
            { label: 'Total documents', value: String(stats.total), sub: 'All records in scope' },
            { label: 'Pending signatures', value: String(stats.pending), sub: 'Awaiting tenant sign-off', tone: stats.pending > 0 ? 'negative' : 'default' },
            { label: 'Completed', value: String(stats.completed), sub: 'Fully signed' },
            { label: 'Drafts', value: String(stats.draft), sub: 'In progress' },
          ]}
        />

        {/* Header — page-level title lives in the pinned Management header */}
        <div className="dm-header">
          <div className="dm-header-content">
            <p>Manage leases, agreements, and get e-signatures from tenants.</p>
          </div>
        </div>

        {/* Filters */}
        <div className="dm-filters">
          <div className="search-box">
            <Search size={16} className="search-icon-lucide" aria-hidden />
            <input
              type="text"
              placeholder="Search documents..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="filter-select"
          >
            <option value="all">All Types</option>
            {Object.entries(DOCUMENT_TYPES).map(([key, type]) => (
              <option key={key} value={type.id}>{type.name}</option>
            ))}
          </select>
        </div>

        {/* Property Cards with Documents */}
        <div className="property-cards-section">
          {loadingProperties ? (
            <div className="property-cards-loading">
              <div className="loading-spinner"></div>
              <span>Loading properties...</span>
            </div>
          ) : propertyLoadError ? (
            <div className="property-cards-empty property-cards-error">
              <div className="empty-icon">⚠️</div>
              <h3>Couldn&apos;t load properties</h3>
              <p>{propertyLoadError}</p>
            </div>
          ) : firestoreProperties.length === 0 ? (
            <div className="property-cards-empty">
              <div className="empty-icon">🏠</div>
              <h3>No properties found</h3>
              <p>Add properties in Portfolio Management to see them here with their documents.</p>
            </div>
          ) : (
            <>
              <div className="property-cards-grid">
              {firestoreProperties.filter(p => p.id === (propertyId ?? firestoreProperties[0]?.id)).map(property => {
                // Get documents for this property, applying search/type filters
                let propertyDocuments = documents.filter(doc => doc.propertyId === property.id);
                if (searchTerm) {
                  propertyDocuments = propertyDocuments.filter(d => d.title.toLowerCase().includes(searchTerm.toLowerCase()));
                }
                if (filterType !== 'all') {
                  propertyDocuments = propertyDocuments.filter(d => d.documentType === filterType);
                }
                const statusGroups = groupDocsByStatus(propertyDocuments);
                const docsByType = groupDocsByType(propertyDocuments);
                const pendingSignatureDocs = getPendingSignatureDocs(propertyDocuments);
                const typeEntries = Array.from(docsByType.entries()).sort((left, right) =>
                  (DOCUMENT_TYPES[left[0]]?.name ?? left[0]).localeCompare(DOCUMENT_TYPES[right[0]]?.name ?? right[0]),
                );
                const openCategoryDocs = openDocCategoryKey ? docsByType.get(openDocCategoryKey) ?? [] : [];

                return (
                  <div key={property.id} className="property-document-card">
                    <div className="property-doc-toolbar">
                      <div className="property-doc-toolbar-info">
                        <h3 className="property-address">{property.address}</h3>
                        <div className="documents-summary">
                          {statusGroups.pending.length > 0 && (
                            <Badge tone="warn" dot>{statusGroups.pending.length} pending signature{statusGroups.pending.length === 1 ? '' : 's'}</Badge>
                          )}
                          {statusGroups.completed.length > 0 && (
                            <Badge tone="success">{statusGroups.completed.length} signed</Badge>
                          )}
                        </div>
                      </div>
                      <div className="property-card-actions">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => {
                            setNewDocProperty(property.id);
                            setShowLeaseBuilder(true);
                          }}
                        >
                          Create Document
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setUploadProperty(property.id);
                            setShowUploadModal(true);
                          }}
                        >
                          Upload
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setScanPropertyId(property.id);
                            generateScannerUrl(property.id);
                            setShowScanModal(true);
                          }}
                        >
                          Scan
                        </Button>
                        <select
                          className="dm-template-select dm-template-select--compact"
                          value={templatePickerValue}
                          onChange={(e) => {
                            const key = e.target.value;
                            if (!key) return;
                            setNewDocProperty(property.id);
                            setNewDocType(key);
                            setShowCreateModal(true);
                            setTemplatePickerValue('');
                          }}
                        >
                          <option value="">Start from template…</option>
                          {Object.entries(DOCUMENT_TYPES)
                            .filter(([key]) => key !== 'UPLOADED_DOCUMENT')
                            .map(([key, type]) => (
                              <option key={key} value={key}>{type.name}</option>
                            ))}
                        </select>
                        <span className="property-card-actions-divider" />
                        {selectionMode ? (
                          <>
                            {selectedIds.size > 0 && (
                              <>
                                <Button size="sm" variant="secondary" onClick={handleBulkDownload} disabled={bulkDownloading} loading={bulkDownloading}>
                                  Download ({selectedIds.size})
                                </Button>
                                <Button size="sm" variant="destructive" onClick={handleBulkDelete}>
                                  Delete ({selectedIds.size})
                                </Button>
                              </>
                            )}
                            <Button size="sm" variant="tertiary" onClick={() => { setSelectionMode(false); setSelectedIds(new Set()); }}>
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="tertiary" onClick={() => setSelectionMode(true)}>
                            Select
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="property-card-body">
                      <div className="property-card-left">
                        <div className="property-image-section">
                          {property.image ? (
                            <img src={property.image} alt={property.address} className="property-thumbnail" style={{ objectPosition: 'center 62%' }} />
                          ) : (
                            <StreetViewImage
                              address={property.address}
                              className="property-thumbnail"
                              width={480}
                              height={264}
                              pitch={-8}
                              fov={65}
                              objectPosition="center 62%"
                              fill
                            />
                          )}
                        </div>
                        <div className="property-info-section">
                          {property.propertyData?.summary && (
                            <div className="property-details">
                              {property.propertyData.summary.beds && <span>{property.propertyData.summary.beds} bed</span>}
                              {property.propertyData.summary.baths && <span>{property.propertyData.summary.baths} bath</span>}
                              {property.propertyData.summary.living_sqft && <span>{property.propertyData.summary.living_sqft.toLocaleString()} sqft</span>}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="property-card-main">
                        <SectionGroupHeader
                          title="Document categories"
                          accent="indigo"
                          hint="Browse documents grouped by type, such as lease agreements or addenda."
                          right={`${propertyDocuments.length} total`}
                        />
                        {propertyDocuments.length === 0 ? (
                          <div className="no-documents">No documents yet</div>
                        ) : (
                          <TileGrid minTile={112} gap={12} className="doc-category-tiles">
                            {typeEntries.map(([typeKey, docs]) => {
                              const typeMeta = DOCUMENT_TYPES[typeKey] ?? DOCUMENT_TYPES.UPLOADED_DOCUMENT;
                              return (
                                <button
                                  key={typeKey}
                                  type="button"
                                  className="doc-category-tile"
                                  onClick={() => setOpenDocCategoryKey(typeKey)}
                                >
                                  <span className="doc-category-tile-icon" aria-hidden="true">
                                    <FileText size={22} strokeWidth={1.5} />
                                    <span className="doc-category-tile-badge">{docs.length}</span>
                                  </span>
                                  <span className="doc-category-tile-label">{typeMeta.name}</span>
                                </button>
                              );
                            })}
                          </TileGrid>
                        )}
                      </div>

                      <aside className="property-card-pending">
                        <SectionGroupHeader
                          title="Pending e-signatures"
                          accent="amber"
                          hint="Documents waiting for tenant or landlord signature."
                          right={pendingSignatureDocs.length > 0 ? String(pendingSignatureDocs.length) : undefined}
                        />
                        {pendingSignatureDocs.length === 0 ? (
                          <div className="pending-signatures-empty">
                            <PenLine size={18} strokeWidth={1.75} aria-hidden />
                            <p>No documents awaiting signature</p>
                          </div>
                        ) : (
                          <div className="pending-signatures-list">
                            {pendingSignatureDocs.map(renderPendingSignatureItem)}
                          </div>
                        )}
                      </aside>
                    </div>

                    <Modal
                      open={Boolean(openDocCategoryKey && docsByType.has(openDocCategoryKey))}
                      onClose={() => setOpenDocCategoryKey(null)}
                      title={openDocCategoryKey ? getOpenCategoryMeta(openDocCategoryKey).name : undefined}
                      subtitle={openDocCategoryKey ? `${openCategoryDocs.length} document${openCategoryDocs.length === 1 ? '' : 's'} for this property` : undefined}
                      size="md"
                      bodyClassName="!px-4 !py-3"
                    >
                      {openCategoryDocs.length > 0
                        ? openCategoryDocs.map(renderDocumentItem)
                        : <div className="no-documents">No documents in this category</div>}
                    </Modal>
                  </div>
                );
              })}
              </div>
            </>
          )}
        </div>

      </div>{/* end dm-scroll-area */}

      {/* ===== Document Viewer Modal ===== */}
      {selectedDocument && (
        <div
          className={`doc-viewer-overlay ${isFileViewerFullscreen ? 'fullscreen' : ''}`}
          onClick={closeSelectedDocument}
        >
          <div className={`doc-viewer-panel ${isFileViewerFullscreen ? 'fullscreen' : ''}`} onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className={`doc-viewer-header ${isFileViewerFullscreen ? 'fullscreen' : ''}`}>
              <div className="doc-viewer-title">
                <div className="doc-viewer-icon-wrap">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </div>
                <div className="doc-viewer-title-copy">
                  <h2>{selectedDocument.title}</h2>
                  <p>Created {new Date(selectedDocument.createdAt).toLocaleDateString()}</p>
                </div>
                {isFileViewerFullscreen && selectedDocument.signatureRequests && selectedDocument.signatureRequests.length > 0 && (
                  <div className="viewer-sig-pills inline-header">
                    {selectedDocument.signatureRequests.map((req, index) => (
                      <button
                        key={index}
                        type="button"
                        className={`viewer-sig-pill ${req.status} clickable`}
                        onClick={() => {
                          setReceiptDocumentId(selectedDocument.id);
                          setShowReceiptModal(true);
                        }}
                        title="Open signing receipt"
                      >
                        <span className="viewer-sig-dot" />
                        <span className="viewer-sig-name">{req.signerName}</span>
                        <span className="viewer-sig-role">{req.signerRole}</span>
                        <span className="viewer-sig-state">
                          {req.status === 'signed'
                            ? `Signed ${new Date(req.signedAt!).toLocaleDateString()}`
                            : 'Awaiting'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="doc-viewer-header-right">
                {canEditDocumentText ? (
                  <button
                    type="button"
                    className={`viewer-action-btn viewer-action-btn-header viewer-action-btn-edit ${isEditingText ? 'active' : ''}`}
                    onClick={toggleDocumentEditing}
                    aria-pressed={isEditingText}
                    title={isEditingText ? 'Finish editing and stay in the main document view' : 'Edit saved document text in the main document view'}
                  >
                    <Pencil size={14} />
                    {isEditingText ? 'Done Editing' : 'Edit in Main View'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="viewer-action-btn viewer-action-btn-header locked"
                    disabled
                    title={signatureLockReason}
                  >
                    <Pencil size={14} />
                    Edit Locked
                  </button>
                )}
                {isEditingText && (
                  <span className={`doc-viewer-autosave header ${autosaveStatus}`}>
                    {autosaveStatus === 'saving'
                      ? 'Saving...'
                      : autosaveStatus === 'saved'
                        ? 'Saved'
                        : autosaveStatus === 'error'
                          ? 'Save failed'
                          : 'Autosave on'}
                  </span>
                )}
                <button
                  type="button"
                  className={`viewer-action-btn viewer-action-btn-header audit-toggle ${isAuditPanelOpen ? 'active' : ''}`}
                  onClick={() => setIsAuditPanelOpen((value) => !value)}
                  aria-pressed={isAuditPanelOpen}
                >
                  <Sparkles size={14} />
                  Audit
                </button>
                <button
                  className="viewer-fullscreen-btn"
                  title="Full Screen"
                  onClick={() => setIsFileViewerFullscreen(!isFileViewerFullscreen)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 1 1 1 1 6" />
                    <polyline points="10 1 15 1 15 6" />
                    <polyline points="6 15 1 15 1 10" />
                    <polyline points="10 15 15 15 15 10" />
                  </svg>
                </button>
                <span
                  className="doc-viewer-status"
                  style={{
                    backgroundColor: STATUS_CONFIG[selectedDocument.status]?.bgColor,
                    color: STATUS_CONFIG[selectedDocument.status]?.color
                  }}
                >
                  {STATUS_CONFIG[selectedDocument.status]?.label}
                </span>
                <button className="doc-viewer-close" onClick={closeSelectedDocument}>✕</button>
              </div>
            </div>

            {/* Signature Status — clean pill row */}
            {!isFileViewerFullscreen && selectedDocument.signatureRequests && selectedDocument.signatureRequests.length > 0 && (
              <div className="viewer-sig-bar">
                <span className="viewer-sig-label">Signatures</span>
                <div className="viewer-sig-pills">
                  {selectedDocument.signatureRequests.map((req, index) => (
                    <button
                      key={index}
                      type="button"
                      className={`viewer-sig-pill ${req.status} clickable`}
                      onClick={() => {
                        setReceiptDocumentId(selectedDocument.id);
                        setShowReceiptModal(true);
                      }}
                      title="Open signing receipt"
                    >
                      <span className="viewer-sig-dot" />
                      <span className="viewer-sig-name">{req.signerName}</span>
                      <span className="viewer-sig-role">{req.signerRole}</span>
                      <span className="viewer-sig-state">
                        {req.status === 'signed'
                          ? `Signed ${new Date(req.signedAt!).toLocaleDateString()}`
                          : 'Awaiting'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="doc-viewer-scroll-body">
              {isAuditPanelOpen && (
                <aside className="doc-viewer-audit-rail">
                  <div className="doc-viewer-audit-inner">
                    <div className="doc-viewer-audit-hero">
                      <div className="doc-viewer-audit-badge">
                        <Sparkles size={15} />
                        <span>Audit</span>
                      </div>
                      <h3>Compliance audit snapshot</h3>
                      <p>
                        AI-assisted guidance only. Review the saved document and cited sources before relying on this for legal or regulatory decisions.
                      </p>
                    </div>

                    {selectedComplianceMetadata ? (
                      <>
                        <div className={`doc-viewer-audit-status-card ${auditStatusTone}`}>
                          <div className="doc-viewer-audit-status-top">
                            <span className="doc-viewer-audit-status-label">{auditStatusLabel}</span>
                            <span className="doc-viewer-audit-status-pill">
                              {selectedAuditWarnings.length > 0 ? `${selectedAuditWarnings.length} warning${selectedAuditWarnings.length === 1 ? '' : 's'}` : 'Saved'}
                            </span>
                          </div>
                          <p>
                            {selectedLocalJurisdiction
                              ? `${selectedStateLabel || 'State'} rules plus ${selectedLocalJurisdiction} locality context were captured when this document was generated.`
                              : `${selectedStateLabel || 'Jurisdiction'} compliance context was captured when this document was generated.`}
                          </p>
                          {(selectedAuditSources.length > 0 || selectedVerificationItems.length > 0) && (
                            <div className="doc-viewer-audit-status-meta">
                              {selectedAuditSources.length > 0 && <span>{selectedAuditSources.length} source{selectedAuditSources.length === 1 ? '' : 's'}</span>}
                              {selectedVerificationItems.length > 0 && <span>{selectedVerificationItems.length} verification note{selectedVerificationItems.length === 1 ? '' : 's'}</span>}
                            </div>
                          )}
                          <p className="doc-viewer-audit-capability-note">
                            {usesReplicaHighlighting
                              ? 'Clickable requirements highlight matching text directly in the digitized document preview.'
                              : usesPdfHighlighting
                                ? 'Clickable requirements highlight matching text directly on the PDF preview.'
                                : 'Clickable requirements search the PDF preview and extracted text for matching language.'}
                          </p>
                        </div>

                        <div className="doc-viewer-audit-section">
                          <div className="doc-viewer-audit-section-label">Jurisdiction</div>
                          <ul className="doc-viewer-audit-list">
                            <li>{selectedLocalJurisdiction ? `${selectedLocalJurisdiction} local overlay` : 'State-level only compliance context'}</li>
                            {selectedDocument.documentType && <li>{formatAiDocumentType(selectedDocument.documentType)}</li>}
                          </ul>
                        </div>

                        {selectedGoverningAuthority?.title && (
                          <div className="doc-viewer-audit-section">
                            <div className="doc-viewer-audit-section-label">Governing law</div>
                            <ul className="doc-viewer-audit-list">
                              <li>
                                {selectedGoverningAuthority.url ? (
                                  <a href={selectedGoverningAuthority.url} target="_blank" rel="noreferrer" className="doc-viewer-audit-link">
                                    {selectedGoverningAuthority.title}
                                  </a>
                                ) : (
                                  selectedGoverningAuthority.title
                                )}
                              </li>
                            </ul>
                          </div>
                        )}

                        {selectedStateLabel && (
                          <div className="doc-viewer-audit-section">
                            <div className="doc-viewer-audit-section-label">State</div>
                            <ul className="doc-viewer-audit-list">
                              <li>{selectedStateLabel}{selectedComplianceMetadata?.stateCode && selectedComplianceMetadata.stateName ? ` (${selectedComplianceMetadata.stateCode})` : ''}</li>
                            </ul>
                          </div>
                        )}

                        {(selectedCounty || selectedLocality || selectedLocalJurisdiction || selectedLocalRequirements.length > 0) && (
                          <div className="doc-viewer-audit-section">
                            <div className="doc-viewer-audit-section-label">County / locality</div>
                            <ul className="doc-viewer-audit-list">
                              {selectedCounty && <li>County: {selectedCounty}</li>}
                              {selectedLocality && <li>Locality: {selectedLocality}</li>}
                              {selectedLocalJurisdiction && selectedLocalJurisdiction !== selectedLocality && <li>Local overlay: {selectedLocalJurisdiction}</li>}
                            </ul>
                          </div>
                        )}

                        {auditRequirementSections.map((section) => (
                          <div className="doc-viewer-audit-section" key={section.key}>
                            <div className="doc-viewer-audit-section-label">{section.label}</div>
                            <ul className={`doc-viewer-audit-list ${section.tone === 'warning' ? 'warning' : ''}`}>
                              {section.items.map((item, index) => {
                                const auditKey = `${section.key}:${item}`;
                                const isActive = activeAuditRequirementKey === auditKey;
                                return (
                                  <li key={`${section.key}-${index}-${item}`} className="doc-viewer-audit-item">
                                    <button
                                      type="button"
                                      className={`doc-viewer-audit-item-button ${isActive ? 'active' : ''} ${section.tone === 'warning' ? 'warning' : ''}`}
                                      onClick={() => handleAuditRequirementSelect(section.key, item)}
                                    >
                                      <span>{item}</span>
                                    </button>
                                    {isActive && (
                                      <div className="doc-viewer-audit-item-meta">
                                        {isSearchingPrimaryDocument ? (
                                          <span>Searching the primary PDF preview...</span>
                                        ) : activeViewerMatchCount > 0 ? (
                                          <>
                                            <span>
                                              {activeViewerMatchCount} linked {usesReplicaHighlighting || usesPdfHighlighting ? 'location' : 'excerpt'}
                                              {activeViewerMatchCount === 1 ? '' : 's'}
                                            </span>
                                            <span>{currentAuditMatchLabel}</span>
                                            {activeViewerMatchCount > 1 && (
                                              <span className="doc-viewer-audit-item-nav">
                                                <button type="button" onClick={() => goToAuditMatch(-1)}>Prev</button>
                                                <span>{activeAuditMatchIndex + 1} / {activeViewerMatchCount}</span>
                                                <button type="button" onClick={() => goToAuditMatch(1)}>Next</button>
                                              </span>
                                            )}
                                          </>
                                        ) : (
                                          <span>No linked location found in this viewer.</span>
                                        )}
                                      </div>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ))}

                        {selectedAuditSources.length > 0 && (
                          <div className="doc-viewer-audit-section">
                            <div className="doc-viewer-audit-section-label">Sources</div>
                            <ul className="doc-viewer-audit-list">
                              {selectedAuditSources.map((source, index) => (
                                <li key={`${source.url || source.title || index}`} className="doc-viewer-audit-source-item">
                                  <div className="doc-viewer-audit-source-row">
                                    {source.url ? (
                                      <a href={source.url} target="_blank" rel="noreferrer" className="doc-viewer-audit-link">
                                        {getComplianceSourceLabel(source, index)}
                                      </a>
                                    ) : (
                                      <span>{getComplianceSourceLabel(source, index)}</span>
                                    )}
                                    {getComplianceSourceBadge(source) && (
                                      <span className={`doc-viewer-audit-source-badge ${source.isOfficial || source.category === 'official' ? 'official' : 'legal'}`}>
                                        {getComplianceSourceBadge(source)}
                                      </span>
                                    )}
                                  </div>
                                  {formatComplianceSourceContext(source) && (
                                    <div className="doc-viewer-audit-source-meta">
                                      {formatComplianceSourceContext(source)}
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {selectedVerificationItems.length > 0 && (
                          <div className="doc-viewer-audit-section">
                            <div className="doc-viewer-audit-section-label">Verification</div>
                            <ul className="doc-viewer-audit-list">
                              {selectedVerificationItems.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="doc-viewer-audit-empty">
                        <div className="doc-viewer-audit-empty-icon">
                          <Sparkles size={18} />
                        </div>
                        <h4>No audit metadata yet</h4>
                        <p>
                          This saved document does not include compliance or verification metadata. The viewer can show audit details only when that data was captured at generation time.
                        </p>
                      </div>
                    )}
                  </div>
                </aside>
              )}

              <div className={`doc-viewer-main-pane ${isAuditPanelOpen ? 'audit-open' : ''}`}>
                <div className="doc-viewer-main-scroll">
                  <div className="doc-viewer-main-toolbar">
                    <div>
                      <div className="doc-viewer-main-toolbar-title">Main document view</div>
                      <div className="doc-viewer-main-toolbar-copy">
                        {isEditingText
                          ? 'Editing happens directly in this primary pane and autosaves.'
                          : activeAuditRequirementKey
                            ? `The active requirement is targeting the ${primaryViewerLabel}.`
                            : 'Switch the main pane between the original document, layout, and text views.'}
                      </div>
                    </div>
                    <div className="doc-viewer-main-toolbar-actions">
                      {hasDocumentPreview && (
                        <button
                          type="button"
                          className={`doc-viewer-mode-btn ${resolvedPrimaryViewerMode === 'document' ? 'active' : ''}`}
                          onClick={() => setPrimaryViewerMode('document')}
                        >
                          Document
                        </button>
                      )}
                      {hasLayoutPrimary && (
                        <button
                          type="button"
                          className={`doc-viewer-mode-btn ${resolvedPrimaryViewerMode === 'layout' ? 'active' : ''}`}
                          onClick={() => setPrimaryViewerMode('layout')}
                        >
                          Layout
                        </button>
                      )}
                      {hasTextPrimary && (
                        <button
                          type="button"
                          className={`doc-viewer-mode-btn ${resolvedPrimaryViewerMode === 'text' ? 'active' : ''}`}
                          onClick={() => setPrimaryViewerMode('text')}
                        >
                          Text
                        </button>
                      )}
                      {canEditDocumentText ? (
                        <button
                          type="button"
                          className={`viewer-action-btn viewer-action-btn-edit ${isEditingText ? 'active' : ''}`}
                          onClick={toggleDocumentEditing}
                        >
                          <Pencil size={14} />
                          {isEditingText ? 'Done Editing' : 'Edit in Main View'}
                        </button>
                      ) : (
                        signatureLockReason && (
                          <span className="doc-viewer-lock-note">
                            {signatureLockReason}
                          </span>
                        )
                      )}
                      {isEditingText && (
                        <span className={`doc-viewer-autosave ${autosaveStatus}`}>
                          {autosaveStatus === 'saving'
                            ? 'Saving...'
                            : autosaveStatus === 'saved'
                              ? 'Saved'
                              : autosaveStatus === 'error'
                                ? 'Save failed'
                                : 'Autosave on'}
                        </span>
                      )}
                    </div>
                  </div>
                  {activeAuditRequirementKey && resolvedPrimaryViewerMode !== 'document' && (
                    <div className="doc-viewer-inline-alert">
                      Showing the highlighted requirement in the main {primaryViewerLabel} because the original document preview could not map this section directly.
                    </div>
                  )}
                  {activeAuditRequirementKey && isSearchingPrimaryDocument && (
                    <div className="doc-viewer-inline-alert">
                      Searching the primary PDF preview for the selected requirement.
                    </div>
                  )}
                  {/* Main document surface */}
                  <div className="doc-viewer-pdf-embed">
                    {resolvedPrimaryViewerMode === 'text' ? (
                      renderPrimaryTextPane()
                    ) : resolvedPrimaryViewerMode === 'layout' ? (
                      renderReplicaPreview()
                    ) : pdfLoading ? (
                      <div className="doc-viewer-pdf-state">Loading preview...</div>
                    ) : previewLoadError ? (
                      <div className="doc-viewer-pdf-state error">
                        <div>Unable to load the document preview.</div>
                        <div className="doc-viewer-pdf-state-detail">{previewLoadError}</div>
                      </div>
                    ) : previewObjectUrl ? (
                      selectedPreviewIsPdf ? (
                        <DocumentPdfViewer
                          fileUrl={previewObjectUrl}
                          title={selectedDocument.title}
                          highlightQuery={activeAuditRequirementText}
                          highlightExcerpt={activeAuditMatch?.excerpt}
                          activeHighlightIndex={activeAuditMatchIndex}
                          onHighlightCountChange={(count) => {
                            setPdfHighlightCount(count);
                            setIsDocumentHighlightPending(false);
                          }}
                          onActiveHighlightChange={(highlight) => {
                            setActivePdfHighlightPage(highlight?.pageNumber ?? null);
                          }}
                        />
                      ) : (
                        <iframe
                          src={previewObjectUrl}
                          title={selectedDocument.title}
                        />
                      )
                    ) : (
                      <div className="doc-viewer-pdf-state">Preview unavailable.</div>
                    )}
                  </div>

                  {replicaLayoutError && (
                    <div className="doc-viewer-inline-alert">
                      Digitized layout unavailable: {replicaLayoutError}
                    </div>
                  )}

                  {(selectedDigitization || selectedDocument.metadata?.ocrProcessed || selectedDocument.metadata?.summary || selectedDocument.metadata?.digitization?.error || editableTextSource) && (
                    <div className="doc-viewer-text-card">
                    <div className="doc-viewer-text-card-top">
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '6px 10px',
                          borderRadius: '999px',
                          fontSize: '12px',
                          fontWeight: 700,
                          background: selectedDigitizationStyle.background,
                          color: selectedDigitizationStyle.color,
                          border: `1px solid ${selectedDigitizationStyle.border}`
                        }}
                      >
                        <span>AI</span>
                        <span>{DIGITIZATION_STATUS_LABELS[selectedDigitizationStatus || 'partial'] || getDigitizedReplicaLabel(selectedDocument)}</span>
                      </span>
                      {hasDigitizedReplica && (
                        <span className="doc-viewer-muted-meta">
                          Replica view
                        </span>
                      )}
                      <span className="doc-viewer-strong-meta">
                        {formatAiDocumentType(selectedDigitization?.documentType || selectedDocument.metadata?.classifiedType)}
                      </span>
                      {selectedDigitization?.classificationConfidence != null && selectedDigitization.classificationConfidence > 0 && (
                        <span className="doc-viewer-muted-meta">
                          Confidence {Math.round(selectedDigitization.classificationConfidence * 100)}%
                        </span>
                      )}
                      {selectedDigitization?.pageCount ? (
                        <span className="doc-viewer-muted-meta">
                          {selectedDigitization.pageCount} page{selectedDigitization.pageCount === 1 ? '' : 's'}
                        </span>
                      ) : null}
                      {selectedDigitization?.repairedLineCount ? (
                        <span className="doc-viewer-muted-meta">
                          {selectedDigitization.repairedLineCount} repaired line{selectedDigitization.repairedLineCount === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </div>

                    {(selectedDigitization?.summary || selectedDocument.metadata?.summary) && (
                      <div>
                        <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#64748b', marginBottom: '6px' }}>
                          {getDigitizationSummaryHeading(selectedDocument)}
                        </div>
                        <p style={{ margin: 0, color: '#0f172a', lineHeight: 1.6 }}>
                          {selectedDigitization?.summary || selectedDocument.metadata?.summary}
                        </p>
                      </div>
                    )}

                    {selectedKeyFacts.length > 0 && (
                      <div>
                        <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#64748b', marginBottom: '8px' }}>
                          Key Facts
                        </div>
                        <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                          {selectedKeyFacts.map((fact, index) => (
                            <div key={`${fact.label}-${index}`} style={{ padding: '10px 12px', borderRadius: '12px', border: '1px solid #dbe4f0', background: '#ffffff' }}>
                              <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#64748b', marginBottom: '4px' }}>
                                {fact.label}
                              </div>
                              <div style={{ color: '#0f172a', fontWeight: 600 }}>{fact.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedInfoGroups.length > 0 && (
                      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                        {selectedInfoGroups.map((group) => (
                          <div key={group.label} style={{ padding: '10px 12px', borderRadius: '12px', border: '1px solid #dbe4f0', background: '#ffffff' }}>
                            <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#64748b', marginBottom: '8px' }}>
                              {group.label}
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                              {(group.values || []).map((value) => (
                                <span key={`${group.label}-${value}`} style={{ padding: '4px 8px', borderRadius: '999px', background: '#eef2ff', color: '#3730a3', fontSize: '12px', fontWeight: 600 }}>
                                  {value}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {selectedDigitization?.error && (
                      <div style={{ padding: '10px 12px', borderRadius: '12px', border: '1px solid #fecaca', background: '#fff1f2', color: '#991b1b', fontSize: '13px' }}>
                        {selectedDigitization.error}
                      </div>
                    )}

                    {editableTextSource && (
                      <div className="doc-viewer-text-section">
                        <div className="doc-viewer-text-section-top">
                          <div className="doc-viewer-text-section-title">{getDigitizationTextHeading(selectedDocument)}</div>
                          <div className="doc-viewer-text-toolbar">
                            {hasTextPrimary && (
                              <button
                                type="button"
                                className="btn-small"
                                onClick={() => setPrimaryViewerMode('text')}
                              >
                                {resolvedPrimaryViewerMode === 'text' ? 'Text in Main View' : 'Open Text View'}
                              </button>
                            )}
                            {canEditDocumentText && (
                              <button
                                type="button"
                                className="btn-small"
                                onClick={toggleDocumentEditing}
                              >
                                {isEditingText ? 'Done Editing' : 'Edit in Main View'}
                              </button>
                            )}
                            {isEditingText && (
                              <span className={`doc-viewer-autosave ${autosaveStatus}`}>
                                {autosaveStatus === 'saving'
                                  ? 'Saving...'
                                  : autosaveStatus === 'saved'
                                    ? 'Saved'
                                    : autosaveStatus === 'error'
                                      ? 'Save failed'
                                      : 'Editing in main view'}
                              </span>
                            )}
                          </div>
                        </div>
                        {activeAuditRequirementKey && (
                          <div className="doc-viewer-match-status">
                            {isSearchingPrimaryDocument ? (
                              <span>Searching the primary PDF preview for the selected requirement.</span>
                            ) : activeViewerMatchCount > 0 ? (
                              <>
                                <span>
                                  {usesReplicaHighlighting
                                    ? 'The active requirement is highlighted in yellow in the document preview above.'
                                    : usesPdfHighlighting
                                      ? 'The active requirement is highlighted in yellow on the PDF preview above.'
                                      : 'The active requirement is linked in the main text view above.'}
                                </span>
                                <span>{currentAuditMatchLabel}</span>
                              </>
                            ) : (
                              <span>No matching location was found for the active requirement.</span>
                            )}
                          </div>
                        )}
                        {autosaveError && (
                          <div className="doc-viewer-inline-alert error">
                            {autosaveError}
                          </div>
                        )}
                        {resolvedPrimaryViewerMode === 'text' ? (
                          <div className="doc-viewer-inline-alert">
                            {isEditingText
                              ? 'Editing and requirement highlights are happening directly in the main viewer above.'
                              : 'Requirement highlights are being shown in the main text viewer above.'}
                          </div>
                        ) : canEditDocumentText && isEditingText ? (
                          <div className="doc-viewer-inline-alert">
                            Document editing is open in the main viewer above. Use Done Editing when finished.
                          </div>
                        ) : canEditDocumentText ? (
                          isEditingText ? null : (
                            <pre className="doc-viewer-text-display">
                              {renderHighlightedEditableText()}
                            </pre>
                          )
                        ) : (
                          <>
                            {signatureLockReason && (
                              <div className="doc-viewer-inline-alert">
                                {signatureLockReason}
                              </div>
                            )}
                            <pre className="doc-viewer-text-display">
                              {renderHighlightedEditableText()}
                            </pre>
                          </>
                        )}
                      </div>
                    )}

                    {selectedReplicaLayoutUrl && (
                      <div style={{ fontSize: '12px', color: '#475569' }}>
                        Layout sidecar: <a href={selectedReplicaLayoutUrl} target="_blank" rel="noreferrer" style={{ color: '#2563eb', fontWeight: 600 }}>open JSON</a>
                      </div>
                    )}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="doc-viewer-actions">
                  {selectedDocument.status === 'draft' && selectedDocument.requiresSignature && (
                    <button className="viewer-action-btn primary" onClick={() => handleRequestSignatures(selectedDocument)}>
                      Request Signatures
                    </button>
                  )}
                  {(['pending_signatures', 'partially_signed'].includes(selectedDocument.status)) &&
                    selectedDocument.signatureRequests?.some(req => req.signerRole === 'landlord' && req.status === 'pending') && (
                    <button className="viewer-action-btn primary" onClick={() => openOwnerSigningModal(selectedDocument)}>
                      Sign as Owner
                    </button>
                  )}
                  <button className="viewer-action-btn" onClick={() => handleDownloadDocument(selectedDocument)}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1v10M4 8l4 4 4-4"/><path d="M1 13h14"/></svg>
                    Download
                  </button>
                  {canEditDocumentText && (
                    <button
                      className={`viewer-action-btn ${isEditingText ? 'active' : ''}`}
                      onClick={toggleDocumentEditing}
                    >
                      <Pencil size={14} />
                      {isEditingText ? 'Done Editing' : 'Edit Document'}
                    </button>
                  )}
                  {hasDigitizedReplica && (
                    <button className="viewer-action-btn" onClick={() => openOriginalDocument(selectedDocument)}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2h4v4"/><path d="M9 7l5-5"/><path d="M14 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h4"/></svg>
                      View Original
                    </button>
                  )}
                  {selectedDocument.status === 'completed' && selectedDocument.signatureRequests && selectedDocument.signatureRequests.length > 0 && (
                    <button
                      className="viewer-action-btn"
                      onClick={() => {
                        setReceiptDocumentId(selectedDocument.id);
                        setShowReceiptModal(true);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="1" width="12" height="14" rx="1.5"/><path d="M5 5h6M5 8h6M5 11h3"/></svg>
                      Signing Receipt
                    </button>
                  )}
                  {selectedDocument.status === 'draft' && (
                    <button className="viewer-action-btn danger" onClick={() => handleDeleteDocument(selectedDocument.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Document Modal */}
      {showCreateModal && (
        <div className="modal-overlay" data-voice-id="create-document-modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal create-document-modal" data-voice-id="create-document-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Create New Document</h2>
              <button className="close-btn" onClick={() => {
                setShowCreateModal(false);
                resetCreateForm();
              }}>×</button>
            </div>
            <div className="modal-body">
              {!generatedContent ? (
                <>
                  <div className="form-group">
                    <label>Document Type *</label>
                    <select 
                      value={newDocType} 
                      onChange={(e) => setNewDocType(e.target.value)}
                      data-voice-id="document-type-select"
                    >
                      <option value="">Select type...</option>
                      {Object.entries(DOCUMENT_TYPES).map(([key, type]) => (
                        <option key={key} value={key}>{type.icon} {type.name}</option>
                      ))}
                    </select>
                  </div>

                  {properties.length > 0 && (
                    <div className="form-group">
                      <label>Property</label>
                      <select 
                        value={newDocProperty} 
                        onChange={(e) => setNewDocProperty(e.target.value)}
                        data-voice-id="document-property-select"
                      >
                        <option value="">Select property...</option>
                        {properties.map(prop => (
                          <option key={prop.id} value={prop.id}>{prop.address}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {tenants.length > 0 && (
                    <div className="form-group">
                      <label>Tenant</label>
                      <select 
                        value={newDocTenant} 
                        onChange={(e) => setNewDocTenant(e.target.value)}
                        data-voice-id="document-tenant-select"
                      >
                        <option value="">Select tenant...</option>
                        {tenants.filter(t => !newDocProperty || t.propertyId === newDocProperty).map(tenant => (
                          <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="form-group">
                    <label>Custom Instructions (Optional)</label>
                    <textarea
                      value={customInstructions}
                      onChange={(e) => setCustomInstructions(e.target.value)}
                      placeholder="Add any specific requirements or terms to include in the document..."
                      rows={4}
                      data-voice-id="document-custom-instructions"
                    />
                  </div>

                  <button 
                    className="btn-primary btn-full"
                    onClick={handleGenerateDocument}
                    disabled={!newDocType || generating}
                    data-voice-id="generate-document-btn"
                  >
                    {generating ? '🔄 Generating...' : '🤖 Generate with AI'}
                  </button>
                </>
              ) : (
                <>
                  <div className="form-group">
                    <label>Document Title</label>
                    <input
                      type="text"
                      value={newDocTitle}
                      onChange={(e) => setNewDocTitle(e.target.value)}
                      placeholder={DOCUMENT_TYPES[newDocType]?.name || 'Document Title'}
                    />
                  </div>

                  {complianceMetadata && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 14px',
                      background: complianceMetadata.warnings?.length > 0 ? '#fef3c7' : '#d1fae5',
                      borderRadius: '8px',
                      marginBottom: '12px',
                      fontSize: '13px',
                      border: `1px solid ${complianceMetadata.warnings?.length > 0 ? '#fbbf24' : '#34d399'}`
                    }}>
                      <span>{complianceMetadata.warnings?.length > 0 ? '⚠️' : '✅'}</span>
                      <div>
                        <strong>
                          {complianceMetadata.stateName || complianceMetadata.stateCode} Legal Compliance
                        </strong>
                        {complianceMetadata.localJurisdiction && (
                          <span style={{ marginLeft: '6px', color: '#6b7280' }}>
                            ({complianceMetadata.localJurisdiction})
                          </span>
                        )}
                        {complianceMetadata.warnings?.length > 0 && (
                          <div style={{ marginTop: '4px', color: '#92400e' }}>
                            {complianceMetadata.warnings.map((w: string, i: number) => (
                              <div key={i}>• {w}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="form-group">
                    <label>Generated Content</label>
                    <div className="generated-preview">
                      <pre>{generatedContent}</pre>
                    </div>
                  </div>

                  <div className="modal-actions">
                    <button 
                      className="btn-secondary"
                      onClick={() => setGeneratedContent('')}
                    >
                      ← Regenerate
                    </button>
                    <button 
                      className="btn-primary"
                      onClick={handleCreateDocument}
                      data-voice-id="save-document-btn"
                    >
                      ✓ Save Document
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sign Document Modal */}
      {showSignModal && selectedDocument && (
        <div className="modal-overlay" onClick={() => setShowSignModal(false)}>
          <div className="modal sign-document-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Sign Document as Owner</h2>
              <button className="close-btn" onClick={() => {
                setShowSignModal(false);
                setOwnerSigningToken('');
                setAgreeToSign(false);
                setSaveSignatureForFuture(false);
                setSigningAsOwner(false);
                setIsSubmittingSignature(false);
                clearSignature();
              }}>×</button>
            </div>
            <div className="modal-body">
              <div className="document-to-sign">
                <h3>{selectedDocument.title}</h3>
                <div className="document-preview-scroll">
                  <pre>{selectedDocument.content}</pre>
                </div>
              </div>

              <div className="signature-section">
                <h3>Your Signature</h3>
                
                {/* Auto-Sign Option */}
                {savedSignature && (
                  <div className="auto-sign-section" style={{ 
                    marginBottom: '16px', 
                    padding: '12px', 
                    background: '#f0fdf4', 
                    borderRadius: '8px',
                    border: '1px solid #86efac'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span style={{ fontWeight: 600, color: '#166534' }}>✅ Saved Signature Available</span>
                      <button 
                        style={{ 
                          fontSize: '12px', 
                          color: '#dc2626', 
                          background: 'none', 
                          border: 'none', 
                          cursor: 'pointer',
                          textDecoration: 'underline'
                        }}
                        onClick={deleteSavedSignature}
                      >
                        Delete
                      </button>
                    </div>
                    <button
                      className="btn-secondary"
                      style={{ width: '100%' }}
                      onClick={useSavedSignature}
                    >
                      ⚡ Use Saved Signature (Auto-Sign)
                    </button>
                  </div>
                )}

                <p className="signature-instructions">
                  {savedSignature ? 'Or draw a new signature below:' : 'Draw your signature below using your mouse or finger'}
                </p>
                <div className="signature-canvas-container">
                  <canvas
                    ref={signatureCanvasRef}
                    width={400}
                    height={150}
                    className="signature-canvas"
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={stopDrawing}
                    onMouseLeave={stopDrawing}
                    onTouchStart={startDrawing}
                    onTouchMove={draw}
                    onTouchEnd={stopDrawing}
                  />
                  <button className="clear-signature-btn" onClick={clearSignature}>
                    Clear
                  </button>
                </div>
                
                {/* Save for future checkbox - only show if no saved signature */}
                {!savedSignature && signatureData && (
                  <div style={{ marginTop: '12px' }}>
                    <input 
                      type="checkbox" 
                      id="save-signature" 
                      checked={saveSignatureForFuture}
                      onChange={(e) => setSaveSignatureForFuture(e.target.checked)}
                    />
                    <label htmlFor="save-signature" style={{ marginLeft: '8px', color: '#374151' }}>
                      💾 Save this signature for future documents
                    </label>
                    {saveSignatureForFuture && (
                      <p style={{ fontSize: '11px', color: '#d97706', marginTop: '4px', marginLeft: '24px' }}>
                        ⚠️ Even with a saved signature, you must review each document and confirm your intent to sign. A saved signature does not constitute automatic consent.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* ESIGN Act / UETA Consent Disclosure */}
              <div style={{ marginBottom: '12px', padding: '10px', background: '#f9fafb', borderRadius: '8px', border: '1px solid #e5e7eb', maxHeight: '160px', overflowY: 'auto', fontSize: '12px', lineHeight: '1.5', color: '#4b5563' }}>
                <p style={{ fontWeight: 600, marginBottom: '4px' }}>⚖️ ESIGN Act & UETA Disclosure</p>
                <p>By signing electronically, you consent to conduct this transaction under the U.S. ESIGN Act (15 U.S.C. §7001) and UETA. Your electronic signature has the same legal force as a handwritten signature.</p>
                <p><strong>Your rights:</strong> You may request a paper copy at no charge. You may withdraw consent to electronic records at any time (without affecting signatures already applied). You need a modern web browser and internet access to view and retain records.</p>
                <p><strong>Limitations:</strong> Wills, codicils, testamentary trusts, and certain court documents cannot be signed electronically.</p>
              </div>
              <div className="legal-notice">
                <input 
                  type="checkbox" 
                  id="agree-terms" 
                  checked={agreeToSign}
                  onChange={(e) => setAgreeToSign(e.target.checked)}
                />
                <label htmlFor="agree-terms">
                  I have read the ESIGN Act & UETA disclosure above. I agree that this electronic signature is legally binding and equivalent to my handwritten signature, and I intend to sign this document.
                </label>
              </div>

              <button 
                className="btn-primary btn-full"
                disabled={!signatureData || !agreeToSign || isSubmittingSignature}
                onClick={handleOwnerSign}
              >
                {isSubmittingSignature ? '⏳ Signing...' : '✍️ Apply Signature'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Document Options Modal (replaces old lease builder + new document button) */}
      {showLeaseBuilder && (
        <div className="modal-overlay" onClick={() => setShowLeaseBuilder(false)}>
          <div className="modal lease-builder-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '560px' }}>
            <div className="modal-header">
              <h2>Create Document</h2>
              <button className="close-btn" onClick={() => setShowLeaseBuilder(false)}>×</button>
            </div>
            <div className="modal-body">
              <p className="modal-description">
                Choose how you'd like to create a new document.
              </p>
              <div className="lease-builder-options">
                <div
                  className="lease-option-card"
                  onClick={() => {
                    setShowLeaseBuilder(false);
                    setNewDocType('LEASE_AGREEMENT');
                    setShowCreateModal(true);
                  }}
                >
                  <div className="option-icon">📝</div>
                  <div className="option-content">
                    <h3>Full Lease Builder</h3>
                    <p>Create a comprehensive lease with AI-powered section-by-section customization</p>
                  </div>
                </div>
                <div
                  className="lease-option-card"
                  onClick={() => {
                    setShowLeaseBuilder(false);
                    setNewDocType('LEASE_AGREEMENT');
                    setShowCreateModal(true);
                  }}
                >
                  <div className="option-icon">⚡</div>
                  <div className="option-content">
                    <h3>Quick Lease</h3>
                    <p>Generate a standard lease quickly with minimal input</p>
                  </div>
                </div>
                <div
                  className="lease-option-card"
                  onClick={() => {
                    setShowLeaseBuilder(false);
                    setNewDocType('');
                    setShowCreateModal(true);
                  }}
                >
                  <div className="option-icon">📄</div>
                  <div className="option-content">
                    <h3>Other Document</h3>
                    <p>Generate any document type (amendments, notices, checklists, etc.)</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Scan Document Modal */}
      {showScanModal && (
        <div className="modal-overlay" onClick={() => { setShowScanModal(false); resetScanModal(); }}>
          <div className="modal scan-document-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>📷 Scan Document</h2>
              <button className="close-btn" onClick={() => { setShowScanModal(false); resetScanModal(); }}>×</button>
            </div>
            <div className="modal-body">
              <p className="modal-description">
                Scan paper documents using your mobile phone's camera. The scanned document will be saved to your selected property.
              </p>

              <div className="form-group">
                <label>Select Property *</label>
                <select
                  value={scanPropertyId}
                  onChange={(e) => {
                    setScanPropertyId(e.target.value);
                    if (e.target.value) {
                      generateScannerUrl(e.target.value);
                    } else {
                      setScannerUrl('');
                      setTunnelUrl(null);
                    }
                  }}
                  className="form-select"
                >
                  <option value="">-- Select Property --</option>
                  {firestoreProperties.map(prop => (
                    <option key={prop.id} value={prop.id}>{prop.address}</option>
                  ))}
                </select>
              </div>

              {loadingTunnel && (
                <div className="loading-tunnel" style={{ textAlign: 'center', padding: '20px' }}>
                  <div className="loading-spinner" style={{ margin: '0 auto 10px' }}></div>
                  <p style={{ color: '#9ca3af' }}>Setting up mobile scanner link...</p>
                </div>
              )}

              {!loadingTunnel && scannerUrl && (
                <div className="scanner-qr-section">
                  {!tunnelUrl && (
                    <div className="tunnel-warning" style={{ 
                      background: 'rgba(234, 179, 8, 0.1)', 
                      border: '1px solid rgba(234, 179, 8, 0.3)',
                      borderRadius: '8px',
                      padding: '12px',
                      marginBottom: '16px',
                      color: '#fbbf24',
                      fontSize: '14px'
                    }}>
                      ⚠️ <strong>No Cloudflare tunnel detected.</strong> Start the tunnel with <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: '4px' }}>npm run dev:tunnel</code> for mobile access.
                    </div>
                  )}
                  
                  <div className="qr-instructions">
                    <h4>📱 Open on Your Phone</h4>
                    <p>Scan this QR code with your phone's camera to open the document scanner:</p>
                  </div>
                  
                  <div className="qr-code-container">
                    <img 
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(scannerUrl)}`}
                      alt="QR Code for mobile scanner"
                      className="qr-code-image"
                    />
                  </div>

                  <div className="scanner-url-section">
                    <label>Or copy this link:</label>
                    <div className="link-copy-box">
                      <input
                        type="text"
                        value={scannerUrl}
                        readOnly
                        className="scanner-link-input"
                      />
                      <button
                        className="copy-btn"
                        onClick={() => {
                          navigator.clipboard.writeText(scannerUrl);
                          alert('Link copied to clipboard!');
                        }}
                      >
                        📋 Copy
                      </button>
                    </div>
                    <p className="link-note">
                      {tunnelUrl 
                        ? '✅ Using Cloudflare tunnel - accessible from your mobile device.'
                        : 'Note: This localhost URL won\'t work on mobile. Start a tunnel for mobile access.'}
                    </p>
                  </div>
                </div>
              )}

              <div className="modal-actions">
                <button
                  className="btn-secondary"
                  onClick={() => { setShowScanModal(false); resetScanModal(); }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upload Document Modal */}
      {showUploadModal && (
        <div className="modal-overlay" onClick={() => { setShowUploadModal(false); resetUploadForm(); }}>
          <div className="modal" style={{ maxWidth: '500px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>📤 Upload Document</h2>
              <button 
                className="close-btn"
                onClick={() => { setShowUploadModal(false); resetUploadForm(); }}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-description">
                Upload existing documents to associate with a property. Digital files like PDFs are stored as-is. Photos and scans are digitized with Azure Document Intelligence and refined with Claude.
              </p>

              {/* Property Selection */}
              <div className="form-group">
                <label>Property *</label>
                <select
                  value={uploadProperty}
                  onChange={(e) => setUploadProperty(e.target.value)}
                  className="form-select"
                >
                  <option value="">-- Select Property --</option>
                  {firestoreProperties.map(prop => (
                    <option key={prop.id} value={prop.id}>{prop.address}</option>
                  ))}
                </select>
              </div>

              {/* Document Title */}
              <div className="form-group">
                <label>Document Title</label>
                <input
                  type="text"
                  placeholder="e.g., Insurance Certificate, Inspection Report..."
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  className="form-input"
                />
              </div>

              {/* File Upload Area */}
              <div className="form-group">
                <label>Document File *</label>
                <div 
                  className="upload-dropzone"
                  style={{
                    border: '2px dashed #d1d5db',
                    borderRadius: '8px',
                    padding: '30px 20px',
                    textAlign: 'center',
                    backgroundColor: uploadFile ? '#f0fdf4' : '#f9fafb',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                  onClick={() => uploadInputRef.current?.click()}
                >
                  {uploadFile ? (
                    <div>
                      <div style={{ fontSize: '40px', marginBottom: '10px' }}>
                        {uploadFile.type.includes('pdf') ? '📄' : 
                         uploadFile.type.includes('image') ? '🖼️' : '📁'}
                      </div>
                      <p style={{ fontWeight: 'bold', color: '#059669', margin: '0 0 5px 0' }}>
                        {uploadFile.name}
                      </p>
                      <p style={{ color: '#6b7280', fontSize: '14px', margin: 0 }}>
                        {(uploadFile.size / 1024).toFixed(2)} KB • Click to change
                      </p>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: '40px', marginBottom: '10px' }}>📁</div>
                      <p style={{ fontWeight: 'bold', color: '#374151', margin: '0 0 5px 0' }}>
                        Click to select a file
                      </p>
                      <p style={{ color: '#6b7280', fontSize: '14px', margin: 0 }}>
                        PDFs and other digital files are stored as-is. Upload photos for AI digitization.
                      </p>
                    </div>
                  )}
                </div>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.txt,.csv"
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
              </div>

              {/* Upload Progress */}
              {uploading && (
                <div className="upload-progress" style={{ marginBottom: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                    <span style={{ fontSize: '14px', color: '#6b7280' }}>
                      {uploadFile && shouldDigitizeUploadFile(uploadFile) ? 'Uploading and digitizing...' : 'Uploading...'}
                    </span>
                    <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#059669' }}>
                      {Math.round(uploadProgress)}%
                    </span>
                  </div>
                  <div 
                    style={{
                      height: '8px',
                      backgroundColor: '#e5e7eb',
                      borderRadius: '4px',
                      overflow: 'hidden'
                    }}
                  >
                    <div 
                      style={{
                        height: '100%',
                        width: `${uploadProgress}%`,
                        backgroundColor: '#10b981',
                        borderRadius: '4px',
                        transition: 'width 0.3s ease'
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="modal-actions">
                <button
                  className="btn-secondary"
                  onClick={() => { setShowUploadModal(false); resetUploadForm(); }}
                  disabled={uploading}
                >
                  Cancel
                </button>
                <button
                  className="btn-primary"
                  onClick={handleUploadDocument}
                  disabled={uploading || !uploadFile || !uploadProperty}
                  style={{ backgroundColor: '#10b981' }}
                >
                  {uploading
                    ? (uploadFile && shouldDigitizeUploadFile(uploadFile) ? '⏳ Uploading & Digitizing...' : '⏳ Uploading...')
                    : '📤 Upload Document'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Signing Receipt Modal */}
      {showReceiptModal && receiptDocumentId && (
        <div className="modal-overlay" onClick={() => setShowReceiptModal(false)}>
          <div className="receipt-glass-frame" onClick={(e) => e.stopPropagation()}>
            {/* Gradient border glow — beveled edges */}
            <div className="receipt-glass-border" />
            {/* Inner highlight for beveled look */}
            <div className="receipt-glass-highlight" />
            {/* Top edge glow */}
            <div className="receipt-glass-top-edge" />
            {/* Side edge glows */}
            <div className="receipt-glass-left-edge" />
            <div className="receipt-glass-right-edge" />
            {/* Scrollable content */}
            <div className="receipt-glass-content">
              <SigningReceipt
                documentId={receiptDocumentId}
                onClose={() => {
                  setShowReceiptModal(false);
                  setReceiptDocumentId(null);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DocumentManager;