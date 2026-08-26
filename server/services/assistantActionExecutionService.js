/**
 * Backend-first assistant action execution.
 * Completes landlord workflows server-side, then returns navigation + interactive
 * task-pad result cards so the owner can review without hunting through forms.
 */

import { getFirestore, initializeFirebaseAdmin } from '../firebase-admin.js';
import {
  buildReuseMeta,
  findReusableAssistantOutput,
  saveAssistantArtifact,
} from './assistantReusableOutputService.js';
import { computeAssistantAnalytics } from './assistantComputedAnalyticsService.js';
import { buildAssistantCanonicalContext } from './assistantCanonicalContextService.js';
import { getHistoricalMortgageRate } from '../fred.js';
import {
  getOwnerProperties,
  getPropertiesWithTenants,
  getPropertyById,
} from '../property-firestore-service.js';
import * as documentService from '../document-service.js';
import {
  createAssistantScheduledTask,
  listAssistantScheduledTasks,
} from './assistantScheduledTaskService.js';
import { looksLikeNaturalSchedulePhrase } from './assistantScheduleTime.js';
import {
  inferDocumentTypeKey as inferDocumentTypeKeyPure,
  normalizeDocumentTypeKey,
  wantsEsignature as wantsEsignaturePure,
} from './assistantDocumentType.js';
import {
  buildPropertyWorkspaceRoute,
  inferPlatformWorkspace,
  inferPropertyAnalysisMode,
  routeAssistantCapability,
  workspaceForAnalysisMode,
  PLATFORM_WORKSPACES,
} from './assistantCapabilityRouter.js';
import { buildAlignedRentalPricingAnalysis } from './assistantRentPotentialService.js';
import {
  beginAssistantActivity,
  completeAssistantActivity,
  failAssistantActivity,
} from './assistantActivityService.js';
import {
  buildSensorSpeakableAnswer,
  focusDevicesFromQuery,
  loadOwnerSensorInventory,
} from './assistantSensorInventoryService.js';

initializeFirebaseAdmin();

const db = getFirestore();

function clip(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function money(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '$0';
  return `$${Math.round(num).toLocaleString()}`;
}

function normalizeId(value) {
  return String(value || '').trim();
}

function normalizeAddress(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(road|rd|street|st|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|circle|cir|way|place|pl|terrace|ter)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addressTokens(value) {
  return normalizeAddress(value)
    .split(' ')
    .filter((token) => token.length > 1 && !['the', 'and', 'unit', 'apt', 'suite'].includes(token));
}

function addressesMatch(left, right) {
  const a = normalizeAddress(left);
  const b = normalizeAddress(right);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const aTokens = addressTokens(left);
  const bTokens = addressTokens(right);
  if (!aTokens.length || !bTokens.length) return false;

  // Require shared street number when both have one, plus most significant tokens.
  const aNumber = aTokens.find((token) => /^\d+[a-z]?$/.test(token));
  const bNumber = bTokens.find((token) => /^\d+[a-z]?$/.test(token));
  if (aNumber && bNumber && aNumber !== bNumber) return false;

  const overlap = aTokens.filter((token) => bTokens.includes(token));
  // Street number + one more token is enough (handles Rd/Road and minor street typos).
  if (aNumber && bNumber && aNumber === bNumber && overlap.length >= 1) return true;
  const needed = Math.min(2, Math.min(aTokens.length, bTokens.length));
  return overlap.length >= needed;
}

function scoreAddressMatch(candidate, needle) {
  if (!needle) return 0;
  if (!addressesMatch(candidate, needle)) return 0;
  const candidateTokens = addressTokens(candidate);
  const needleTokens = addressTokens(needle);
  const overlap = needleTokens.filter((token) => candidateTokens.includes(token)).length;
  const candidateNumber = candidateTokens.find((token) => /^\d+[a-z]?$/.test(token));
  const needleNumber = needleTokens.find((token) => /^\d+[a-z]?$/.test(token));
  const numberBonus = candidateNumber && needleNumber && candidateNumber === needleNumber ? 25 : 0;
  return overlap * 10 + numberBonus + (normalizeAddress(candidate) === normalizeAddress(needle) ? 50 : 0);
}

function tenantDisplayName(tenant) {
  return String(
    tenant?.name
    || tenant?.fullName
    || `${tenant?.firstName || ''} ${tenant?.lastName || ''}`.trim()
    || tenant?.email
    || 'Tenant',
  );
}

function buildFingerprint(parts = {}) {
  return Object.entries(parts)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}:${String(value).toLowerCase().trim()}`)
    .sort()
    .join('|');
}

function propertyManagementRoute({ tab = 'documents', propertyId = null, documentId = null } = {}) {
  const params = new URLSearchParams();
  params.set('tab', tab);
  if (propertyId) params.set('property', propertyId);
  if (documentId) params.set('documentId', documentId);
  return `/property-management?${params.toString()}`;
}

async function listOwnerProperties(userId, { withTenants = false } = {}) {
  if (withTenants) {
    const result = await getPropertiesWithTenants(userId);
    if (result?.ok && Array.isArray(result.properties)) {
      return result.properties;
    }
  }

  const result = await getOwnerProperties(userId);
  return result?.ok && Array.isArray(result.properties) ? result.properties : [];
}

async function resolveProperty({ userId, propertyId, propertyAddress, address, location }) {
  const addressNeedle = propertyAddress || address || location || '';

  if (propertyId) {
    const byId = await getPropertyById(propertyId);
    if (byId?.ok && byId.property && (byId.property.ownerId === userId || !byId.property.ownerId)) {
      return { id: byId.property.id, ...byId.property };
    }
  }

  const properties = await listOwnerProperties(userId, { withTenants: true });
  if (!properties.length) return null;

  if (addressNeedle) {
    const ranked = properties
      .map((property) => ({ property, score: scoreAddressMatch(property.address, addressNeedle) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    if (ranked[0]) return ranked[0].property;

    // Unique street-number fallback: "11822 Presbyterian" → only property at 11822.
    const needleNumber = addressTokens(addressNeedle).find((token) => /^\d+[a-z]?$/.test(token));
    if (needleNumber) {
      const numberMatches = properties.filter((property) => {
        const candidateNumber = addressTokens(property.address).find((token) => /^\d+[a-z]?$/.test(token));
        return candidateNumber === needleNumber;
      });
      if (numberMatches.length === 1) return numberMatches[0];
    }
  }

  return properties.length === 1 ? properties[0] : null;
}

async function resolveTenant({
  userId,
  tenantId,
  tenantName,
  propertyId,
  propertyAddress,
  address,
  location,
}) {
  const property = await resolveProperty({
    userId,
    propertyId,
    propertyAddress: propertyAddress || address || location,
  });
  const resolvedPropertyId = property?.id || propertyId || null;

  if (tenantId) {
    const snap = await db.collection('tenants').doc(tenantId).get();
    if (snap.exists) {
      return { id: snap.id, ...snap.data(), property };
    }
  }

  const properties = await listOwnerProperties(userId, { withTenants: true });
  const candidates = [];
  for (const item of properties) {
    const tenants = Array.isArray(item.tenants)
      ? item.tenants
      : item.tenant
        ? [item.tenant]
        : [];
    for (const tenant of tenants) {
      candidates.push({
        ...tenant,
        id: tenant.id,
        propertyId: tenant.propertyId || item.id,
        propertyAddress: item.address,
        property: item,
      });
    }
  }

  // Fallback direct tenant query if property join returned nothing.
  if (!candidates.length) {
    try {
      const snapshot = await db.collection('tenants').where('ownerId', '==', userId).limit(80).get();
      for (const doc of snapshot.docs) {
        candidates.push({ id: doc.id, ...doc.data() });
      }
    } catch {
      // ignore
    }
  }

  let matches = candidates;
  if (resolvedPropertyId) {
    matches = matches.filter((tenant) => {
      const tenantPropertyId = tenant.propertyId || tenant.property?.id;
      return tenantPropertyId === resolvedPropertyId
        || addressesMatch(tenant.propertyAddress || tenant.address, property?.address);
    });
  } else if (propertyAddress || address || location) {
    const needle = propertyAddress || address || location;
    matches = matches.filter((tenant) => addressesMatch(tenant.propertyAddress || tenant.address, needle));
  }

  // If property filter wiped everyone but the property has attached tenants, use those.
  if (resolvedPropertyId && matches.length === 0 && property) {
    const attached = Array.isArray(property.tenants)
      ? property.tenants
      : property.tenant
        ? [property.tenant]
        : [];
    matches = attached.map((tenant) => ({
      ...tenant,
      id: tenant.id,
      propertyId: property.id,
      propertyAddress: property.address,
      property,
    }));
  }

  const nameNeedle = String(tenantName || '').toLowerCase().trim();
  if (nameNeedle) {
    matches = matches.filter((tenant) => {
      const name = tenantDisplayName(tenant).toLowerCase();
      const email = String(tenant.email || '').toLowerCase();
      return name.includes(nameNeedle) || email.includes(nameNeedle);
    });
  }

  if (matches.length === 1) {
    return { ...matches[0], property: matches[0].property || property || null };
  }
  if (matches.length > 1) {
    return { ambiguous: true, matches: matches.slice(0, 5), property };
  }

  // If a property has exactly one tenant and no name was given, use that tenant.
  if (!nameNeedle && property?.tenants?.length === 1) {
    return { ...property.tenants[0], propertyId: property.id, property };
  }
  if (!nameNeedle && property?.tenant) {
    return { ...property.tenant, propertyId: property.id, property };
  }

  return null;
}

function needsInputResponse(actionId, title, message, fields) {
  return {
    ok: true,
    actionId,
    title,
    summary: message,
    detailMessage: message,
    needsInput: true,
    result: {
      type: 'needs_input',
      title,
      message,
      fields,
    },
    actions: [],
  };
}

async function setTenantRentRate({ userId, params }) {
  const monthlyRent = Number(params.monthlyRent ?? params.rent ?? params.newRent);
  if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) {
    return needsInputResponse(
      'set-tenant-rent-rate',
      'Set Rent Rate',
      'Tell me the new monthly rent amount and which tenant it applies to.',
      [
        { id: 'tenantName', label: 'Tenant name', required: true },
        { id: 'monthlyRent', label: 'New monthly rent', inputType: 'number', required: true },
      ],
    );
  }

  const tenant = await resolveTenant({
    userId,
    tenantId: params.tenantId,
    tenantName: params.tenantName,
    propertyId: params.propertyId,
  });

  if (!tenant) {
    return needsInputResponse(
      'set-tenant-rent-rate',
      'Set Rent Rate',
      'I could not find that tenant. Which tenant should get the new rent rate?',
      [{ id: 'tenantName', label: 'Tenant name', required: true }],
    );
  }

  if (tenant.ambiguous) {
    return needsInputResponse(
      'set-tenant-rent-rate',
      'Set Rent Rate',
      `I found more than one matching tenant (${tenant.matches.map((item) => item.name || item.email || item.id).join(', ')}). Which one?`,
      [{ id: 'tenantId', label: 'Tenant id or exact name', required: true }],
    );
  }

  const previousRent = tenant.monthlyRent ?? tenant.rent ?? null;
  await db.collection('tenants').doc(tenant.id).set({
    monthlyRent,
    rent: monthlyRent,
    updatedAt: new Date().toISOString(),
    updatedByAssistant: true,
  }, { merge: true });

  if (tenant.propertyId) {
    try {
      await db.collection('properties').doc(tenant.propertyId).set({
        'financials.monthlyRent': monthlyRent,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch {
      // non-blocking
    }
  }

  const title = 'Set Rent Rate';
  const summary = `Updated ${tenant.name || tenant.email || 'tenant'} rent to ${money(monthlyRent)}/mo.`;
  const result = {
    type: 'generic',
    title,
    message: summary,
    details: [
      previousRent != null ? `Previous rent: ${money(previousRent)}/mo` : null,
      `New rent: ${money(monthlyRent)}/mo`,
      tenant.email ? `Tenant email: ${tenant.email}` : null,
    ].filter(Boolean),
  };

  await saveAssistantArtifact({
    userId,
    actionId: 'set-tenant-rent-rate',
    title,
    summary,
    result,
    fingerprint: buildFingerprint({ tenantId: tenant.id, monthlyRent }),
  });

  return {
    ok: true,
    actionId: 'set-tenant-rent-rate',
    title,
    summary,
    detailMessage: 'Rent rate saved on the tenant record.',
    navigation: {
      route: '/property-management?tab=tenants',
      tab: 'tenants',
      highlightVoiceId: 'property-management-tenants-tab',
    },
    result,
    actions: [
      { id: 'open-tenants', label: 'Open tenants', kind: 'navigate', route: '/property-management?tab=tenants', primary: true },
    ],
  };
}

async function draftLatePaymentAlert({ userId, params }) {
  const property = await resolveProperty({
    userId,
    propertyId: params.propertyId,
    propertyAddress: params.propertyAddress || params.address || params.location,
    address: params.address,
    location: params.location,
  });

  const tenant = await resolveTenant({
    userId,
    tenantId: params.tenantId,
    tenantName: params.tenantName,
    propertyId: property?.id || params.propertyId,
    propertyAddress: property?.address || params.propertyAddress || params.address,
    address: params.address,
    location: params.location,
  });

  if (!tenant || tenant.ambiguous) {
    return needsInputResponse(
      'send-late-payment-alert',
      'Late Payment Alert',
      property?.address
        ? `I found ${property.address}, but need to know which tenant should get the reminder.`
        : 'Which property/tenant should receive the late payment reminder?',
      [
        { id: 'propertyAddress', label: 'Property address', required: !property },
        { id: 'tenantName', label: 'Tenant name', required: true },
        { id: 'amountDue', label: 'Amount due', inputType: 'number' },
        { id: 'dueDate', label: 'Due date', inputType: 'date' },
      ],
    );
  }

  const amountDue = Number(params.amountDue ?? params.amount ?? tenant.monthlyRent ?? tenant.rent ?? 0);
  const dueDate = params.dueDate || 'the due date';
  const tenantName = tenantDisplayName(tenant);
  const propertyAddress = property?.address || tenant.propertyAddress || '';
  const subject = params.subject || `Friendly reminder: rent payment due`;
  const body = params.body || [
    `Hi ${tenantName},`,
    '',
    `This is a friendly reminder that your rent payment${amountDue ? ` of ${money(amountDue)}` : ''} for ${propertyAddress || 'your rental'} was due on ${dueDate}.`,
    '',
    'Please submit payment at your earliest convenience. If you already paid, thank you — you can ignore this note.',
    '',
    'Best regards,',
    'Your property manager',
  ].join('\n');

  const fingerprint = buildFingerprint({
    tenantId: tenant.id,
    propertyId: property?.id || tenant.propertyId,
    amountDue,
    dueDate,
    kind: 'late-payment',
  });

  const reused = await findReusableAssistantOutput({
    userId,
    actionId: 'send-late-payment-alert',
    fingerprint,
    maxAgeMs: 6 * 60 * 60 * 1000,
  });

  if (reused.reused && reused.result) {
    return {
      ok: true,
      actionId: 'send-late-payment-alert',
      title: reused.title || 'Late Payment Alert',
      summary: reused.summary || 'Reused your recent late-payment draft.',
      detailMessage: `Reused draft from ${reused.ageLabel || 'earlier'}.`,
      navigation: {
        route: propertyManagementRoute({ tab: 'tenants', propertyId: property?.id || tenant.propertyId }),
        tab: 'tenants',
      },
      result: reused.result,
      actions: reused.actions || [],
      reuseMeta: buildReuseMeta(reused),
    };
  }

  const draftId = `draft_${Date.now()}`;
  const result = {
    type: 'message_draft',
    title: 'Late payment reminder',
    toName: tenantName,
    toEmail: tenant.email || '',
    subject,
    body,
    channel: 'tenant_portal',
    draftId,
    editable: true,
  };

  const actions = [
    {
      id: 'send-portal',
      label: 'Send via tenant portal',
      kind: 'send',
      primary: true,
      payload: {
        channel: 'tenant_portal',
        draftId,
        tenantId: tenant.id,
        tenantEmail: tenant.email || '',
        tenantName,
        propertyId: property?.id || tenant.propertyId || '',
        propertyAddress,
        subject,
        body,
      },
    },
    {
      id: 'open-tenants',
      label: 'Open tenants',
      kind: 'navigate',
      route: propertyManagementRoute({ tab: 'tenants', propertyId: property?.id || tenant.propertyId }),
    },
  ];

  const title = 'Late Payment Alert';
  const summary = `Drafted a late-payment reminder for ${tenantName}${propertyAddress ? ` at ${propertyAddress}` : ''}.`;

  await saveAssistantArtifact({
    userId,
    actionId: 'send-late-payment-alert',
    title,
    summary,
    result,
    actions,
    fingerprint,
    payload: { tenantId: tenant.id, amountDue, dueDate, propertyId: property?.id || tenant.propertyId },
  });

  return {
    ok: true,
    actionId: 'send-late-payment-alert',
    title,
    summary,
    detailMessage: 'Review the draft, then tap Send via tenant portal. It will show up in the tenant inbox.',
    navigation: {
      route: propertyManagementRoute({ tab: 'tenants', propertyId: property?.id || tenant.propertyId }),
      tab: 'tenants',
      highlightVoiceId: 'property-management-messages-activity',
    },
    result,
    actions,
    reuseMeta: { reused: false },
  };
}

async function draftTenantMessage({ userId, params }) {
  const property = await resolveProperty({
    userId,
    propertyId: params.propertyId,
    propertyAddress: params.propertyAddress || params.address || params.location,
    address: params.address,
    location: params.location,
  });
  const tenant = await resolveTenant({
    userId,
    tenantId: params.tenantId,
    tenantName: params.tenantName,
    propertyId: property?.id || params.propertyId,
    propertyAddress: property?.address || params.propertyAddress || params.address,
  });

  if (!tenant || tenant.ambiguous) {
    return needsInputResponse(
      'draft-tenant-message',
      'Message Tenant',
      'Which tenant should this message go to?',
      [
        { id: 'propertyAddress', label: 'Property address', required: !property },
        { id: 'tenantName', label: 'Tenant name', required: true },
        { id: 'body', label: 'What should the message say?', required: true },
      ],
    );
  }

  const tenantName = tenantDisplayName(tenant);
  const propertyAddress = property?.address || tenant.propertyAddress || '';
  const subject = params.subject || 'Message from your property manager';
  const body = params.body || params.message || params.customInstructions || `Hi ${tenantName},\n\n`;
  const shouldAutoSend = params.autoSend === true
    || params.send === true
    || /^(send|yes|confirm)$/i.test(String(params.confirm || '').trim());

  if (shouldAutoSend) {
    if (!body.trim()) {
      return needsInputResponse(
        'draft-tenant-message',
        'Message Tenant',
        'What should I send to the tenant?',
        [{ id: 'body', label: 'Message', required: true }],
      );
    }

    try {
      const { saveTenantMessage } = await import('../tenant-activity-service.js');
      const sent = await saveTenantMessage({
        tenantId: tenant.id,
        tenantEmail: tenant.email || '',
        tenantName,
        ownerId: userId,
        propertyId: property?.id || tenant.propertyId || null,
        propertyAddress,
        subject,
        message: body,
        senderType: 'owner',
        direction: 'outbound',
        ownerVisible: true,
        tenantVisible: true,
      });

      if (!sent?.ok) {
        throw new Error(sent?.error || 'Failed to send tenant portal message');
      }

      return {
        ok: true,
        actionId: 'draft-tenant-message',
        title: 'Message Tenant',
        summary: `Sent a message to ${tenantName}${propertyAddress ? ` at ${propertyAddress}` : ''} through the tenant portal.`,
        detailMessage: 'Delivered to the tenant inbox.',
        navigation: {
          route: propertyManagementRoute({ tab: 'tenants', propertyId: property?.id || tenant.propertyId }),
          tab: 'tenants',
        },
        result: {
          type: 'generic',
          title: 'Message sent',
          message: `Delivered to ${tenantName} via the tenant portal.`,
          details: [subject, clip(body, 180)].filter(Boolean),
        },
        actions: [
          {
            id: 'open-tenants',
            label: 'Open tenants',
            kind: 'navigate',
            route: propertyManagementRoute({ tab: 'tenants', propertyId: property?.id || tenant.propertyId }),
            primary: true,
          },
        ],
      };
    } catch (error) {
      return {
        ok: false,
        actionId: 'draft-tenant-message',
        title: 'Message Tenant',
        summary: 'Could not send through the tenant portal.',
        error: error.message || 'tenant_message_send_failed',
      };
    }
  }

  const result = {
    type: 'message_draft',
    title: 'Tenant message',
    toName: tenantName,
    toEmail: tenant.email || '',
    subject,
    body,
    channel: 'tenant_portal',
    draftId: `msg_${Date.now()}`,
    editable: true,
  };

  return {
    ok: true,
    actionId: 'draft-tenant-message',
    title: 'Message Tenant',
    summary: `Drafted a message for ${tenantName}${propertyAddress ? ` at ${propertyAddress}` : ''}.`,
    detailMessage: 'Review it below, then send through the tenant portal — or ask me to send it.',
    navigation: {
      route: propertyManagementRoute({ tab: 'tenants', propertyId: property?.id || tenant.propertyId }),
      tab: 'tenants',
    },
    result,
    actions: [
      {
        id: 'send-portal',
        label: 'Send via tenant portal',
        kind: 'send',
        primary: true,
        payload: {
          channel: 'tenant_portal',
          tenantId: tenant.id,
          tenantEmail: tenant.email || '',
          tenantName,
          propertyId: property?.id || tenant.propertyId || '',
          propertyAddress,
          subject,
          body,
        },
      },
      {
        id: 'send-now',
        label: 'Send now',
        kind: 'refresh',
        payload: {
          actionId: 'draft-tenant-message',
          autoSend: true,
          tenantId: tenant.id,
          propertyId: property?.id || tenant.propertyId,
          propertyAddress,
          subject,
          body,
        },
      },
    ],
  };
}

function inferDocumentTypeKey(params = {}) {
  return inferDocumentTypeKeyPure(params, documentService.DOCUMENT_TYPES);
}

function wantsEsignature(params = {}) {
  return wantsEsignaturePure(params);
}

async function resolveOwnerProfile(userId) {
  try {
    const snap = await db.collection('users').doc(userId).get();
    if (!snap.exists) return { id: userId };
    const data = snap.data() || {};
    return {
      id: userId,
      email: data.email || data.ownerEmail || '',
      name: data.displayName || data.name || data.fullName || 'Property Owner',
    };
  } catch {
    return { id: userId };
  }
}

function documentTypeStorageIds(documentTypeKey) {
  if (!documentTypeKey) return [];
  const config = documentService.DOCUMENT_TYPES?.[documentTypeKey];
  const ids = new Set();
  if (config?.id) ids.add(String(config.id).toLowerCase());
  ids.add(String(documentTypeKey).toLowerCase());
  ids.add(String(documentTypeKey).toLowerCase().replace(/_/g, ''));
  if (config?.name) ids.add(String(config.name).toLowerCase());
  return Array.from(ids);
}

function documentMatchesType(doc, documentTypeKey) {
  if (!documentTypeKey) return true;
  const accepted = documentTypeStorageIds(documentTypeKey);
  const candidates = [
    doc.documentType,
    doc.type,
    doc.metadata?.canonicalDocumentType,
    doc.metadata?.classifiedType,
    doc.metadata?.documentType,
    doc.title,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  if (candidates.some((value) => accepted.includes(value) || accepted.some((id) => value.includes(id.replace(/_/g, ' ')) || value.includes(id)))) {
    return true;
  }

  // Uploaded PDFs often store as uploaded_document but title says "Pet Addendum".
  const typeName = documentService.DOCUMENT_TYPES?.[documentTypeKey]?.name || documentTypeKey.replace(/_/g, ' ');
  const title = String(doc.title || '').toLowerCase();
  return title.includes(String(typeName).toLowerCase());
}

function documentRecencyMs(doc) {
  const raw = doc?.updatedAt || doc?.createdAt || doc?.metadata?.updatedAt || null;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function documentPdfPath(documentId) {
  return `/api/documents/${encodeURIComponent(documentId)}/pdf`;
}

function sanitizePdfFilename(title) {
  const base = String(title || 'document')
    .replace(/[^\w\s.-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${base || 'document'}.pdf`;
}

async function listDocuments({ userId, params }) {
  const explicitType = normalizeDocumentTypeKey(
    params.documentType || params.docType || params.type,
    documentService.DOCUMENT_TYPES,
  );
  const haystack = [
    params.requestSummary,
    params.title,
    params.customInstructions,
    params.documentTitle,
  ].filter(Boolean).join(' ').toLowerCase();
  let documentTypeKey = explicitType;
  if (!documentTypeKey) {
    // Soft infer from phrasing — but do NOT default to lease agreement for find/list.
    if (/\bpet\b.*\baddendum\b|\baddendum\b.*\bpet\b/.test(haystack)) documentTypeKey = 'PET_ADDENDUM';
    else if (/\blease\s+amendment\b/.test(haystack)) documentTypeKey = 'LEASE_AMENDMENT';
    else if (/\blease\s+agreement\b|\blease\b/.test(haystack) && !/\baddendum\b/.test(haystack)) documentTypeKey = 'LEASE_AGREEMENT';
    else if (/\bmove[-\s]?in\s+checklist\b/.test(haystack)) documentTypeKey = 'MOVE_IN_CHECKLIST';
    else if (/\bmove[-\s]?out\s+checklist\b/.test(haystack)) documentTypeKey = 'MOVE_OUT_CHECKLIST';
  }
  const docTypeConfig = documentTypeKey ? documentService.DOCUMENT_TYPES?.[documentTypeKey] : null;
  const property = await resolveProperty({
    userId,
    propertyId: params.propertyId,
    propertyAddress: params.propertyAddress || params.address || params.location,
    address: params.address,
    location: params.location,
  });

  if (!property && (params.propertyAddress || params.address || params.location)) {
    return needsInputResponse(
      'list-documents',
      'Find documents',
      `I could not find a property matching “${params.propertyAddress || params.address || params.location}”. Which property should I open documents for?`,
      [{ id: 'propertyAddress', label: 'Property address', required: true }],
    );
  }

  const fetched = await documentService.getDocuments({
    ownerId: userId,
    propertyId: property?.id || params.propertyId || undefined,
  });

  let documents = Array.isArray(fetched?.documents) ? fetched.documents : [];

  // If property-scoped query returned nothing, fall back to owner-wide and filter by address text.
  if (!documents.length && property?.id) {
    const all = await documentService.getDocuments({ ownerId: userId });
    documents = (all?.documents || []).filter((doc) => (
      doc.propertyId === property.id
      || addressesMatch(doc.propertyAddress || doc.metadata?.propertyAddress || '', property.address)
    ));
  }

  const typed = documents.filter((doc) => documentMatchesType(doc, documentTypeKey));
  const matched = (typed.length ? typed : (documentTypeKey ? [] : documents))
    .slice()
    .sort((a, b) => documentRecencyMs(b) - documentRecencyMs(a));

  const route = propertyManagementRoute({
    tab: 'documents',
    propertyId: property?.id || null,
    documentId: matched[0]?.id || null,
  });

  if (!matched.length) {
    const label = docTypeConfig?.name || 'documents';
    return {
      ok: true,
      actionId: 'list-documents',
      title: `Find ${label}`,
      summary: property?.address
        ? `I did not find existing ${label.toLowerCase()} for ${property.address}. I can create one or open the Documents workspace.`
        : `I did not find existing ${label.toLowerCase()} yet.`,
      navigation: { route: propertyManagementRoute({ tab: 'documents', propertyId: property?.id || null }), tab: 'documents' },
      result: {
        type: 'document_list',
        title: `No ${label.toLowerCase()} found`,
        summary: property?.address
          ? `No matching ${label.toLowerCase()} for ${property.address}.`
          : `No matching ${label.toLowerCase()} found.`,
        propertyAddress: property?.address || '',
        documentType: documentTypeKey,
        documents: [],
        presentation: {
          headline: property?.address
            ? `No ${label.toLowerCase()} on file for ${property.address} yet.`
            : `No ${label.toLowerCase()} found.`,
        },
      },
      actions: [
        {
          id: 'create-document',
          label: `Create ${docTypeConfig?.name || 'document'}`,
          kind: 'refresh',
          primary: true,
          payload: {
            actionId: 'create-document',
            documentType: documentTypeKey,
            propertyAddress: property?.address,
            propertyId: property?.id,
            requestSummary: `Create ${docTypeConfig?.name || 'document'} for ${property?.address || 'this property'}`,
          },
        },
        {
          id: 'open-documents',
          label: 'Open Documents',
          kind: 'navigate',
          route: propertyManagementRoute({ tab: 'documents', propertyId: property?.id || null }),
        },
      ],
    };
  }

  const cards = matched.slice(0, 12).map((doc) => ({
    id: doc.id,
    title: doc.title || docTypeConfig?.name || 'Document',
    documentType: doc.documentType || documentTypeKey,
    status: doc.status || 'draft',
    propertyAddress: doc.propertyAddress || doc.metadata?.propertyAddress || property?.address || '',
    updatedAt: doc.updatedAt || doc.createdAt || null,
    previewUrl: documentPdfPath(doc.id),
    route: propertyManagementRoute({
      tab: 'documents',
      propertyId: doc.propertyId || property?.id || null,
      documentId: doc.id,
    }),
  }));

  const typeLabel = docTypeConfig?.name || 'Document';
  const primary = cards[0];
  const pdfUrl = primary.previewUrl;
  const filename = sanitizePdfFilename(primary.title);
  const wantsSpecificDoc = Boolean(documentTypeKey)
    || /\b(open|show|view|latest|find)\b/.test(haystack);
  const summary = matched.length === 1
    ? `Here’s ${primary.title}${property?.address ? ` for ${property.address}` : ''}.`
    : `Here’s the latest ${typeLabel.toLowerCase()}${property?.address ? ` for ${property.address}` : ''}: ${primary.title}. Found ${matched.length} total.`;

  // Specific find/open requests render the actual PDF in the task pad.
  if (wantsSpecificDoc) {
    return {
      ok: true,
      actionId: 'list-documents',
      title: primary.title || typeLabel,
      summary,
      detailMessage: 'Document is ready in the task pad.',
      navigation: { route: primary.route, tab: 'documents' },
      result: {
        type: 'pdf',
        title: primary.title || typeLabel,
        url: pdfUrl,
        filename,
        formLabel: typeLabel,
        documentId: primary.id,
        propertyAddress: primary.propertyAddress,
        status: primary.status,
        relatedDocuments: cards.slice(1, 6),
        presentation: {
          headline: summary,
          highlights: matched.length > 1
            ? cards.slice(0, 4).map((doc) => `${doc.title} · ${doc.status}`)
            : [`${primary.status || 'saved'} · ready to review`],
        },
      },
      artifacts: [
        {
          id: primary.id,
          label: primary.title || typeLabel,
          kind: 'pdf',
          url: pdfUrl,
        },
      ],
      actions: [
        {
          id: 'view-pdf',
          label: 'Open full size',
          kind: 'open',
          href: pdfUrl,
          primary: true,
          payload: { filename },
        },
        {
          id: 'download-pdf',
          label: 'Download',
          kind: 'download',
          href: pdfUrl,
          payload: { filename },
        },
        {
          id: 'open-in-documents',
          label: 'Open in Documents',
          kind: 'navigate',
          route: primary.route,
        },
        {
          id: 'create-document',
          label: `Create another ${docTypeConfig?.name || 'document'}`,
          kind: 'refresh',
          payload: {
            actionId: 'create-document',
            documentType: documentTypeKey,
            propertyAddress: property?.address,
            propertyId: property?.id,
            forceRefresh: true,
            requestSummary: `Create ${docTypeConfig?.name || 'document'} for ${property?.address || 'this property'}`,
          },
        },
      ],
    };
  }

  return {
    ok: true,
    actionId: 'list-documents',
    title: typeLabel,
    summary,
    navigation: { route, tab: 'documents' },
    result: {
      type: 'document_list',
      title: typeLabel,
      summary,
      propertyAddress: property?.address || '',
      documentType: documentTypeKey,
      documents: cards,
      presentation: {
        headline: summary,
        highlights: cards.slice(0, 4).map((doc) => `${doc.title} · ${doc.status}`),
      },
    },
    actions: [
      {
        id: 'open-first-document',
        label: matched.length === 1 ? 'Open document' : 'Open latest',
        kind: 'navigate',
        route: cards[0].route,
        primary: true,
      },
      {
        id: 'open-documents',
        label: 'Open Documents workspace',
        kind: 'navigate',
        route: propertyManagementRoute({ tab: 'documents', propertyId: property?.id || null }),
      },
      {
        id: 'create-document',
        label: `Create another ${docTypeConfig?.name || 'document'}`,
        kind: 'refresh',
        payload: {
          actionId: 'create-document',
          documentType: documentTypeKey,
          propertyAddress: property?.address,
          propertyId: property?.id,
          forceRefresh: true,
          requestSummary: `Create ${docTypeConfig?.name || 'document'} for ${property?.address || 'this property'}`,
        },
      },
    ],
  };
}

async function createLeaseDocument({ userId, params }) {
  const documentType = inferDocumentTypeKey(params);
  const docTypeConfig = documentService.DOCUMENT_TYPES?.[documentType] || documentService.DOCUMENT_TYPES?.CUSTOM_DOCUMENT;
  const customInstructions = params.customInstructions || params.instructions || '';
  const requestEsignature = wantsEsignature(params);
  const property = await resolveProperty({
    userId,
    propertyId: params.propertyId,
    propertyAddress: params.propertyAddress || params.address || params.location,
    address: params.address,
    location: params.location,
  });

  if (!property && (params.propertyAddress || params.address || params.location)) {
    return needsInputResponse(
      'create-document',
      `Create ${docTypeConfig?.name || 'Document'}`,
      `I could not find a property matching “${params.propertyAddress || params.address || params.location}”. Which property should this document use?`,
      [{ id: 'propertyAddress', label: 'Property address', required: true }],
    );
  }

  const tenant = await resolveTenant({
    userId,
    tenantId: params.tenantId,
    tenantName: params.tenantName,
    propertyId: property?.id || params.propertyId,
    propertyAddress: property?.address,
  });

  const fingerprint = buildFingerprint({
    documentType,
    propertyId: property?.id,
    tenantId: tenant?.id && !tenant.ambiguous ? tenant.id : null,
    customInstructions,
    requestEsignature,
  });

  if (params.forceRefresh !== true) {
    const reused = await findReusableAssistantOutput({
      userId,
      actionId: 'create-document',
      fingerprint,
      maxAgeMs: 12 * 60 * 60 * 1000,
    });

    if (reused.reused && reused.result?.documentId) {
      return {
        ok: true,
        actionId: 'create-document',
        title: reused.title || `Create ${docTypeConfig?.name || 'Document'}`,
        summary: reused.summary || 'Reused your recent document draft.',
        detailMessage: `Reused saved document from ${reused.ageLabel || 'earlier'}.`,
        navigation: {
          route: propertyManagementRoute({
            tab: 'documents',
            propertyId: property?.id,
            documentId: reused.result.documentId,
          }),
          tab: 'documents',
        },
        result: reused.result,
        actions: reused.actions || [],
        reuseMeta: buildReuseMeta(reused),
      };
    }
  }

  const owner = await resolveOwnerProfile(userId);
  let content = '';
  let complianceMetadata = null;
  try {
    const generated = await documentService.generateDocumentContent({
      documentType,
      propertyAddress: property?.address || params.propertyAddress || '',
      landlordName: params.landlordName || owner.name || 'Property Owner',
      tenantName: tenant && !tenant.ambiguous ? tenantDisplayName(tenant) : (params.tenantName || ''),
      customInstructions,
      additionalData: {
        monthlyRent: (tenant && !tenant.ambiguous ? tenant.monthlyRent : null)
          || property?.financials?.monthlyRent
          || '',
        ownerEmail: params.ownerEmail || owner.email || '',
        tenantEmail: tenant && !tenant.ambiguous ? (tenant.email || '') : '',
        petType: params.petType || params.pet || '',
        petName: params.petName || '',
        petDeposit: params.petDeposit || '',
        petRent: params.petRent || '',
      },
    });
    if (generated?.success) {
      content = generated.content || '';
      complianceMetadata = generated.compliance || null;
    } else if (generated?.content) {
      content = generated.content;
    } else if (generated?.error) {
      console.warn('[AssistantActions] document generate returned error:', generated.error);
    }
  } catch (error) {
    console.warn('[AssistantActions] document generate fallback:', error.message);
  }

  if (!content) {
    content = [
      `${(docTypeConfig?.name || documentType.replace(/_/g, ' ')).toUpperCase()} DRAFT`,
      '',
      `Property: ${property?.address || params.propertyAddress || '[property address]'}`,
      `Tenant: ${tenant && !tenant.ambiguous ? tenantDisplayName(tenant) : (params.tenantName || '[tenant name]')}`,
      '',
      customInstructions ? `Owner instructions: ${customInstructions}` : 'Standard terms apply for this document type.',
      '',
      'This draft was prepared by HouseYield AI for your review before sending for signature.',
    ].join('\n');
  }

  const titleLabel = `${docTypeConfig?.name || documentType.replace(/_/g, ' ')}${property?.address ? ` – ${property.address}` : ''}`;

  let savedDocument = null;
  try {
    savedDocument = await documentService.createDocument({
      ownerId: userId,
      propertyId: property?.id || null,
      tenantId: tenant && !tenant.ambiguous ? tenant.id : null,
      documentType,
      title: titleLabel,
      content,
      metadata: {
        source: 'assistant_action',
        compliance: complianceMetadata,
        generatedAt: new Date().toISOString(),
        propertyAddress: property?.address || params.propertyAddress || '',
        canonicalDocumentType: documentType,
      },
    });
  } catch (error) {
    console.error('[AssistantActions] Failed to persist document:', error);
    return {
      ok: false,
      actionId: 'create-document',
      title: `Create ${docTypeConfig?.name || 'Document'}`,
      summary: 'Generated the draft, but saving it to Documents failed.',
      error: error.message || 'document_save_failed',
      navigation: {
        route: propertyManagementRoute({ tab: 'documents', propertyId: property?.id }),
        tab: 'documents',
      },
      result: {
        type: 'document',
        title: titleLabel,
        documentType,
        previewText: clip(content, 420),
        content,
        status: 'unsaved',
        propertyAddress: property?.address || '',
      },
    };
  }

  let signatureRequest = null;
  let signatureError = null;
  if (requestEsignature) {
    const tenantOk = tenant && !tenant.ambiguous;
    const tenantEmail = tenantOk ? String(tenant.email || '').trim() : '';
    if (!tenantOk || !tenantEmail) {
      signatureError = 'Document saved, but I need a tenant with an email before I can request e-signature.';
    } else {
      try {
        signatureRequest = await documentService.createSignatureRequest({
          documentId: savedDocument.id,
          signers: [
            {
              id: userId,
              email: owner.email || params.ownerEmail || 'owner@houseyield.app',
              name: owner.name || params.landlordName || 'Property Owner',
              role: 'landlord',
              firebaseUid: userId,
            },
            {
              id: tenant.id,
              email: tenantEmail,
              name: tenantDisplayName(tenant),
              role: 'tenant',
              firebaseUid: tenant.firebaseUid || tenant.userId || null,
            },
          ],
        });
        if (!signatureRequest?.success) {
          signatureError = signatureRequest?.error || 'Could not create the e-signature request.';
          signatureRequest = null;
        }
      } catch (error) {
        signatureError = error.message || 'Could not create the e-signature request.';
      }
    }
  }

  const docsRoute = propertyManagementRoute({
    tab: 'documents',
    propertyId: property?.id,
    documentId: savedDocument.id,
  });

  const signingLinks = signatureRequest?.signingLinks || [];
  const result = {
    type: 'document',
    title: savedDocument.title || titleLabel,
    documentId: savedDocument.id,
    documentType,
    documentTypeName: docTypeConfig?.name || documentType,
    previewText: clip(content, 420),
    content,
    status: signatureRequest ? 'pending_signatures' : (savedDocument.status || 'draft'),
    propertyAddress: property?.address || params.propertyAddress || '',
    tenantName: tenant && !tenant.ambiguous ? tenantDisplayName(tenant) : (params.tenantName || ''),
    signatureRequested: Boolean(signatureRequest),
    signingLinks,
    speakableAnswer: signatureRequest
      ? `Created and saved a ${docTypeConfig?.name || 'document'}${property?.address ? ` for ${property.address}` : ''} and requested e-signature from ${tenantDisplayName(tenant)}.`
      : `Created and saved a ${docTypeConfig?.name || 'document'}${property?.address ? ` for ${property.address}` : ''} to Documents${signatureError ? `. ${signatureError}` : ''}.`,
  };

  const actions = [
    {
      id: 'open-document',
      label: 'Open saved document',
      kind: 'navigate',
      route: docsRoute,
      primary: true,
    },
    {
      id: 'edit-document',
      label: 'Edit with AI',
      kind: 'refresh',
      payload: {
        actionId: 'edit-document',
        documentId: savedDocument.id,
        propertyId: property?.id,
      },
    },
  ];

  if (!signatureRequest) {
    actions.push({
      id: 'request-esignature',
      label: 'Request e-signature',
      kind: 'refresh',
      payload: {
        actionId: 'request-document-esignature',
        documentId: savedDocument.id,
        propertyId: property?.id,
        propertyAddress: property?.address,
        tenantId: tenant && !tenant.ambiguous ? tenant.id : undefined,
      },
    });
  } else {
    actions.push({
      id: 'follow-up-esignature',
      label: 'Follow up on signature',
      kind: 'refresh',
      payload: {
        actionId: 'follow-up-esignature-request',
        documentId: savedDocument.id,
      },
    });
  }

  actions.push({
    id: 'copy-draft',
    label: 'Copy draft text',
    kind: 'copy',
    payload: { text: content },
  });

  const title = `Create ${docTypeConfig?.name || 'Document'}`;
  const summary = result.speakableAnswer;

  await saveAssistantArtifact({
    userId,
    actionId: 'create-document',
    title,
    summary,
    result,
    actions,
    fingerprint,
    payload: {
      complianceMetadata,
      documentId: savedDocument.id,
      propertyId: property?.id,
      signatureRequested: Boolean(signatureRequest),
    },
  });

  return {
    ok: true,
    actionId: 'create-document',
    title,
    summary,
    detailMessage: signatureRequest
      ? 'Document is saved and pending signatures. Open it from Documents anytime.'
      : (signatureError || 'Document is saved on the Documents page for this property. You can open it, edit it, or request e-signature.'),
    navigation: {
      route: docsRoute,
      tab: 'documents',
    },
    result,
    actions,
    reuseMeta: { reused: false },
  };
}

async function requestDocumentEsignature({ userId, params }) {
  const documentId = normalizeId(params.documentId);
  if (!documentId) {
    return needsInputResponse(
      'request-document-esignature',
      'Request E-Signature',
      'Which document should I send for signature?',
      [{ id: 'documentId', label: 'Document id or title', required: true }],
    );
  }

  let documentSnap = await db.collection('documents').doc(documentId).get();
  if (!documentSnap.exists) {
    const byOwner = await db.collection('documents').where('ownerId', '==', userId).limit(50).get();
    const needle = documentId.toLowerCase();
    const match = byOwner.docs.find((doc) => {
      const data = doc.data() || {};
      return doc.id === documentId || String(data.title || '').toLowerCase().includes(needle);
    });
    if (match) documentSnap = match;
  }

  if (!documentSnap.exists) {
    return {
      ok: false,
      actionId: 'request-document-esignature',
      title: 'Request E-Signature',
      summary: 'I could not find that document.',
      error: 'Document not found',
    };
  }

  const document = { id: documentSnap.id, ...documentSnap.data() };
  if (document.ownerId && document.ownerId !== userId) {
    return {
      ok: false,
      actionId: 'request-document-esignature',
      title: 'Request E-Signature',
      summary: 'That document is outside your account.',
      error: 'Access denied',
    };
  }

  const property = await resolveProperty({
    userId,
    propertyId: document.propertyId || params.propertyId,
    propertyAddress: params.propertyAddress || document.metadata?.propertyAddress,
  });
  const tenant = await resolveTenant({
    userId,
    tenantId: document.tenantId || params.tenantId,
    tenantName: params.tenantName || document.tenantName,
    propertyId: property?.id || document.propertyId,
    propertyAddress: property?.address,
  });
  const owner = await resolveOwnerProfile(userId);

  if (!tenant || tenant.ambiguous || !tenant.email) {
    return needsInputResponse(
      'request-document-esignature',
      'Request E-Signature',
      'I need the tenant email before I can request a signature on this document.',
      [
        { id: 'tenantName', label: 'Tenant name', required: true },
        { id: 'tenantEmail', label: 'Tenant email', required: true },
      ],
    );
  }

  const signatureRequest = await documentService.createSignatureRequest({
    documentId: document.id,
    signers: [
      {
        id: userId,
        email: owner.email || params.ownerEmail || 'owner@houseyield.app',
        name: owner.name || 'Property Owner',
        role: 'landlord',
        firebaseUid: userId,
      },
      {
        id: tenant.id,
        email: String(params.tenantEmail || tenant.email).trim(),
        name: tenantDisplayName(tenant),
        role: 'tenant',
        firebaseUid: tenant.firebaseUid || tenant.userId || null,
      },
    ],
  });

  if (!signatureRequest?.success) {
    return {
      ok: false,
      actionId: 'request-document-esignature',
      title: 'Request E-Signature',
      summary: 'Could not create the e-signature request.',
      error: signatureRequest?.error || 'signature_request_failed',
    };
  }

  const route = propertyManagementRoute({
    tab: 'documents',
    propertyId: document.propertyId || property?.id,
    documentId: document.id,
  });

  return {
    ok: true,
    actionId: 'request-document-esignature',
    title: 'Request E-Signature',
    summary: `Requested e-signature on “${document.title || 'document'}” from ${tenantDisplayName(tenant)}.`,
    detailMessage: 'The document is now pending signatures in Documents.',
    navigation: { route, tab: 'documents' },
    result: {
      type: 'document',
      title: document.title || 'Document',
      documentId: document.id,
      documentType: document.documentType,
      status: 'pending_signatures',
      signatureRequested: true,
      signingLinks: signatureRequest.signingLinks || [],
      tenantName: tenantDisplayName(tenant),
      speakableAnswer: `Requested e-signature on ${document.title || 'the document'} from ${tenantDisplayName(tenant)}.`,
    },
    actions: [
      { id: 'open-document', label: 'Open document', kind: 'navigate', route, primary: true },
      {
        id: 'follow-up-esignature',
        label: 'Follow up',
        kind: 'refresh',
        payload: { actionId: 'follow-up-esignature-request', documentId: document.id },
      },
    ],
  };
}

async function editDocument({ userId, params }) {
  const documentId = normalizeId(params.documentId);
  const instructions = String(params.instructions || params.customInstructions || params.editRequest || params.body || '').trim();

  if (!documentId) {
    return needsInputResponse(
      'edit-document',
      'Edit Document',
      'Which document should I edit? Open Documents or give me the document id/title.',
      [
        { id: 'documentId', label: 'Document id or title', required: true },
        { id: 'instructions', label: 'What should I change?', required: true },
      ],
    );
  }

  if (!instructions) {
    return needsInputResponse(
      'edit-document',
      'Edit Document',
      'What should I change in this document?',
      [{ id: 'instructions', label: 'Describe the edits', required: true }],
    );
  }

  let documentSnap = await db.collection('documents').doc(documentId).get();
  if (!documentSnap.exists) {
    const byOwner = await db.collection('documents').where('ownerId', '==', userId).limit(50).get();
    const needle = documentId.toLowerCase();
    const match = byOwner.docs.find((doc) => {
      const data = doc.data() || {};
      return doc.id === documentId || String(data.title || '').toLowerCase().includes(needle);
    });
    if (match) documentSnap = match;
  }

  if (!documentSnap.exists) {
    return {
      ok: false,
      actionId: 'edit-document',
      title: 'Edit Document',
      summary: 'I could not find that document.',
      error: 'Document not found',
    };
  }

  const document = { id: documentSnap.id, ...documentSnap.data() };
  if (document.ownerId && document.ownerId !== userId) {
    return {
      ok: false,
      actionId: 'edit-document',
      title: 'Edit Document',
      summary: 'That document is outside your account.',
      error: 'Access denied',
    };
  }

  const currentContent = String(document.content || '');
  let nextContent = currentContent;

  // Prefer regenerating with instructions when this is a lease/template doc.
  try {
    const generated = await documentService.generateDocumentContent({
      documentType: document.documentType || 'LEASE_AGREEMENT',
      propertyAddress: document.metadata?.propertyAddress || params.propertyAddress || '',
      landlordName: params.landlordName || 'Property Owner',
      tenantName: document.tenantName || params.tenantName || '',
      customInstructions: [
        'Revise the existing document according to these owner instructions.',
        `Owner edit request: ${instructions}`,
        'Keep the document complete and ready for review.',
        currentContent ? `Current document content to revise:\n${clip(currentContent, 6000)}` : '',
      ].filter(Boolean).join('\n\n'),
      additionalData: {
        monthlyRent: params.monthlyRent || '',
      },
    });
    if (generated?.success && generated.content) {
      nextContent = generated.content;
    }
  } catch (error) {
    console.warn('[AssistantActions] edit regenerate failed, applying local patch:', error.message);
  }

  if (nextContent === currentContent) {
    // Lightweight local edit: append an owner-requested amendment note.
    nextContent = `${currentContent.trim()}\n\n---\nAMENDMENT / OWNER REQUESTED CHANGE\n${instructions}\n---\n`;
  }

  const update = await documentService.updateDocumentContent(document.id, nextContent, {
    summary: `Updated by HouseYield AI: ${clip(instructions, 120)}`,
  });

  if (!update?.success) {
    return {
      ok: false,
      actionId: 'edit-document',
      title: 'Edit Document',
      summary: 'Could not save the document edits.',
      error: update?.error || 'document_edit_failed',
    };
  }

  const route = propertyManagementRoute({
    tab: 'documents',
    propertyId: document.propertyId || params.propertyId,
    documentId: document.id,
  });

  return {
    ok: true,
    actionId: 'edit-document',
    title: 'Edit Document',
    summary: `Updated “${document.title || 'document'}” with your requested changes.`,
    detailMessage: 'The saved document now includes your edits.',
    navigation: { route, tab: 'documents' },
    result: {
      type: 'document',
      title: document.title || 'Updated document',
      documentId: document.id,
      documentType: document.documentType,
      previewText: clip(nextContent, 420),
      content: nextContent,
      status: document.status || 'draft',
      propertyAddress: document.metadata?.propertyAddress || '',
    },
    actions: [
      { id: 'open-document', label: 'Open document', kind: 'navigate', route, primary: true },
      {
        id: 'edit-again',
        label: 'Edit again',
        kind: 'refresh',
        payload: { actionId: 'edit-document', documentId: document.id },
      },
    ],
  };
}

async function followUpEsignature({ userId, params }) {
  const documentId = normalizeId(params.documentId);
  if (!documentId) {
    return needsInputResponse(
      'follow-up-esignature-request',
      'E-Signature Follow-up',
      'Which document needs a signature reminder? Open Documents or give me the document id/title.',
      [{ id: 'documentId', label: 'Document id or title', required: true }],
    );
  }

  let documentSnap = await db.collection('documents').doc(documentId).get();
  if (!documentSnap.exists) {
    const byOwner = await db.collection('documents').where('ownerId', '==', userId).limit(40).get();
    const needle = documentId.toLowerCase();
    const match = byOwner.docs.find((doc) => {
      const data = doc.data() || {};
      return doc.id === documentId
        || String(data.title || '').toLowerCase().includes(needle);
    });
    if (match) documentSnap = match;
  }

  if (!documentSnap.exists) {
    return {
      ok: false,
      actionId: 'follow-up-esignature-request',
      title: 'E-Signature Follow-up',
      summary: 'I could not find that document.',
      error: 'Document not found',
    };
  }

  const document = { id: documentSnap.id, ...documentSnap.data() };
  if (document.ownerId && document.ownerId !== userId) {
    return {
      ok: false,
      actionId: 'follow-up-esignature-request',
      title: 'E-Signature Follow-up',
      summary: 'That document is outside your account.',
      error: 'Access denied',
    };
  }

  const pendingSigner = (document.signers || []).find((signer) => signer.status !== 'signed')
    || (document.signatureRequests || []).find((signer) => signer.status !== 'signed')
    || null;

  const tenantName = pendingSigner?.name || document.tenantName || 'the tenant';
  const toEmail = pendingSigner?.email || document.tenantEmail || '';
  const subject = params.subject || `Reminder: please sign ${document.title || 'your document'}`;
  const body = params.body || [
    `Hi ${tenantName},`,
    '',
    `Just a quick reminder to review and sign "${document.title || 'your document'}".`,
    'You can use the secure signing link from the original email.',
    '',
    'Thank you,',
    'Your property manager',
  ].join('\n');

  const result = {
    type: 'message_draft',
    title: 'Signature follow-up',
    toName: tenantName,
    toEmail,
    subject,
    body,
    channel: 'email',
    draftId: `esign_${document.id}`,
    editable: true,
  };

  return {
    ok: true,
    actionId: 'follow-up-esignature-request',
    title: 'E-Signature Follow-up',
    summary: `Drafted a signature reminder for ${document.title || 'the document'}.`,
    detailMessage: pendingSigner?.id || toEmail
      ? 'Review and send when ready. I also opened Documents for you.'
      : 'I drafted the reminder, but this document is missing a signer target. Open the document to add or fix the recipient before sending.',
    navigation: {
      route: '/property-management?tab=documents',
      tab: 'documents',
    },
    result,
    actions: [
      ...((pendingSigner?.id || toEmail) ? [{
        id: 'send-draft',
        label: 'Send reminder',
        kind: 'send',
        primary: true,
        payload: {
          documentId: document.id,
          toEmail,
          subject,
          body,
          remindSignerId: pendingSigner?.id || null,
          channel: pendingSigner?.id ? undefined : 'email',
        },
      }] : []),
      {
        id: 'open-document',
        label: pendingSigner?.id || toEmail ? 'Open document' : 'Fix recipient in document',
        kind: 'navigate',
        route: '/property-management?tab=documents',
      },
    ],
    artifacts: [
      {
        id: document.id,
        label: document.title || 'Document',
        kind: 'document',
        route: '/property-management?tab=documents',
      },
    ],
  };
}

async function draftContractorReceipt({ userId, params }) {
  const vendorName = params.vendorName || params.contractorName || 'Contractor';
  const amount = Number(params.amount || 0);
  const description = params.description || params.workDescription || 'Maintenance work completed';
  const property = await resolveProperty({
    userId,
    propertyId: params.propertyId,
    propertyAddress: params.propertyAddress,
  });

  const content = [
    'CONTRACTOR PAYMENT RECEIPT',
    '',
    `Vendor: ${vendorName}`,
    `Amount: ${money(amount)}`,
    `Property: ${property?.address || params.propertyAddress || '[property]'}`,
    `Work: ${description}`,
    `Date: ${params.date || new Date().toLocaleDateString()}`,
    '',
    'Prepared by HouseYield AI for owner records.',
  ].join('\n');

  const result = {
    type: 'document',
    title: 'Contractor payment receipt',
    documentType: 'PAYMENT_RECEIPT',
    previewText: clip(content, 360),
    content,
    status: 'draft',
    propertyAddress: property?.address || '',
  };

  return {
    ok: true,
    actionId: 'draft-contractor-payment-receipt',
    title: 'Contractor Payment Receipt',
    summary: `Drafted a payment receipt for ${vendorName}${amount ? ` (${money(amount)})` : ''}.`,
    navigation: {
      route: '/property-management?tab=documents',
      tab: 'documents',
    },
    result,
    actions: [
      { id: 'open-documents', label: 'Open Documents', kind: 'navigate', route: '/property-management?tab=documents', primary: true },
      { id: 'copy-draft', label: 'Copy receipt', kind: 'copy', payload: { text: content } },
    ],
  };
}

function normalizeCategoryNeedle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function categoryAliasesForNeedle(needle) {
  const normalized = normalizeCategoryNeedle(needle);
  if (!normalized) return [];

  const aliases = new Set([normalized]);
  const aliasMap = {
    'mortgage interest': ['mortgage interest', 'interest', 'loan interest'],
    interest: ['mortgage interest', 'interest'],
    'management fees': ['management fees', 'property management', 'management'],
    'property management': ['management fees', 'property management', 'management'],
    management: ['management fees', 'property management', 'management'],
    repairs: ['repairs', 'repairs maintenance', 'maintenance'],
    insurance: ['insurance'],
    taxes: ['property taxes', 'taxes', 'property tax'],
    'property taxes': ['property taxes', 'taxes', 'property tax'],
    utilities: ['utilities'],
    depreciation: ['depreciation', 'depreciation expense'],
    cleaning: ['cleaning', 'cleaning maintenance'],
    advertising: ['advertising'],
    legal: ['legal', 'legal professional fees', 'professional fees'],
    supplies: ['supplies'],
  };

  for (const [key, values] of Object.entries(aliasMap)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      values.forEach((alias) => aliases.add(alias));
    }
  }

  return Array.from(aliases);
}

function entryMatchesCategoryNeedle(entry, categoryNeedle, taxCategory) {
  if (!categoryNeedle) return true;
  const aliases = categoryAliasesForNeedle(categoryNeedle);
  const haystack = normalizeCategoryNeedle([
    taxCategory,
    entry?.category,
    entry?.vendor,
    entry?.payee,
    entry?.memo,
    entry?.description,
    ...(entry?.lines || []).flatMap((line) => [
      line?.taxCategory,
      line?.accountName,
      line?.vendorName,
      line?.memo,
    ]),
  ].filter(Boolean).join(' '));

  return aliases.some((alias) => haystack.includes(alias) || alias.includes(haystack));
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

async function showBookkeepingExpenses({ userId, params }) {
  const limit = Math.min(Math.max(Number(params.limit) || 12, 1), 40);
  const categoryNeedle = normalizeCategoryNeedle(params.category || params.expenseCategory || '');
  const taxYear = Number(params.taxYear || params.year) || null;
  const includeIncome = params.includeIncome === true || params.type === 'all' || params.type === 'income';
  const property = await resolveProperty({
    userId,
    propertyId: params.propertyId,
    propertyAddress: params.propertyAddress || params.address || params.location,
    address: params.address,
    location: params.location,
  });
  const resolvedPropertyId = property?.id || params.propertyId || null;
  const startDate = taxYear ? `${taxYear}-01-01` : (params.startDate || null);
  const endDate = taxYear ? `${taxYear}-12-31` : (params.endDate || null);
  const periodLabel = taxYear
    ? `Tax year ${taxYear}${property?.address ? ` · ${property.address}` : ''}`
    : (property?.address ? `Recent ledger · ${property.address}` : 'Recent ledger activity');

  let entries = [];
  let deriveCanonicalTaxCategory = null;
  try {
    const bookkeeping = await import('../bookkeeping-firestore.js');
    deriveCanonicalTaxCategory = bookkeeping.deriveCanonicalTaxCategory;
    if (typeof bookkeeping.loadCanonicalLedgerEntriesForScope === 'function') {
      const loaded = await bookkeeping.loadCanonicalLedgerEntriesForScope({
        userId,
        propertyId: resolvedPropertyId,
        startDate,
        endDate,
        limit: 5000,
        errorLabel: 'assistant-expenses',
      });
      entries = loaded?.entries || [];
    }
  } catch (error) {
    console.warn('[AssistantActions] expense load via bookkeeping module failed:', error.message);
  }

  const expenseByCategory = new Map();
  const incomeByCategory = new Map();
  const matchingTransactions = [];
  let totalExpenses = 0;
  let totalIncome = 0;
  let matchedCategoryTotal = 0;

  for (const entry of entries) {
    const taxCategory = typeof deriveCanonicalTaxCategory === 'function'
      ? (deriveCanonicalTaxCategory(entry) || entry.category || 'Uncategorized')
      : (entry.category || 'Uncategorized');
    const matchesCategory = entryMatchesCategoryNeedle(entry, categoryNeedle, taxCategory);
    const amount = roundMoney(Math.abs(Number(entry.signedAmount ?? entry.amount ?? 0)));
    if (!amount) continue;

    if (entry.transactionType === 'income' || entry.type === 'income') {
      totalIncome += amount;
      if (!categoryNeedle || matchesCategory) {
        incomeByCategory.set(taxCategory, roundMoney((incomeByCategory.get(taxCategory) || 0) + amount));
        if (matchesCategory) matchedCategoryTotal += amount;
      }
      if (includeIncome && matchesCategory) {
        matchingTransactions.push({
          id: entry.id,
          label: entry.memo || entry.description || entry.payee || taxCategory || 'Income',
          amount,
          category: taxCategory,
          date: entry.entryDate || entry.date || undefined,
          propertyAddress: property?.address || undefined,
          type: 'income',
          vendor: entry.vendor || entry.payee || undefined,
        });
      }
      continue;
    }

    if (entry.transactionType === 'expense' || entry.type === 'expense' || entry.isExpense === true) {
      totalExpenses += amount;
      if (!categoryNeedle || matchesCategory) {
        expenseByCategory.set(taxCategory, roundMoney((expenseByCategory.get(taxCategory) || 0) + amount));
        if (matchesCategory) matchedCategoryTotal += amount;
      }
      if (matchesCategory) {
        matchingTransactions.push({
          id: entry.id,
          label: entry.memo || entry.description || entry.vendor || entry.payee || taxCategory || 'Expense',
          amount,
          category: taxCategory,
          date: entry.entryDate || entry.date || undefined,
          propertyAddress: property?.address || undefined,
          type: 'expense',
          vendor: entry.vendor || entry.payee || undefined,
        });
      }
    }
  }

  const categoryLines = Array.from(expenseByCategory.entries())
    .map(([category, amount]) => ({
      label: category,
      amount,
      category,
      propertyAddress: property?.address || undefined,
    }))
    .sort((left, right) => right.amount - left.amount);

  const incomeLines = Array.from(incomeByCategory.entries())
    .map(([category, amount]) => ({
      label: category,
      amount,
      category,
      propertyAddress: property?.address || undefined,
    }))
    .sort((left, right) => right.amount - left.amount);

  matchingTransactions.sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')));

  // Prefer full category totals for spoken answers; still show sample transactions in the pad.
  const primaryLines = categoryNeedle
    ? matchingTransactions.slice(0, limit)
    : categoryLines.slice(0, limit);

  // Prefer income totals when the owner asked about collected/rental income.
  const wantsIncomeAnswer = includeIncome
    || /\bincome|rent/.test(String(categoryNeedle || params.requestSummary || ''));
  const spokenTotal = categoryNeedle
    ? matchedCategoryTotal
    : (wantsIncomeAnswer ? totalIncome : totalExpenses);
  const openBookkeepingAction = {
    id: 'open-bookkeeping',
    label: 'Open Bookkeeping',
    kind: 'navigate',
    route: propertyManagementRoute({ tab: 'bookkeeping', propertyId: resolvedPropertyId }),
    primary: true,
  };

  if (!entries.length || (!categoryLines.length && !matchingTransactions.length && !incomeLines.length)) {
    // Fallback: portfolio analytics expense breakdown (may be model-based, not ledger-posted)
    const analytics = await computeAssistantAnalytics({
      userId,
      metric: 'expense_breakdown',
      propertyId: resolvedPropertyId || params.propertyAddress || params.address || null,
      year: taxYear,
    });
    const lines = (analytics.perProperty || []).flatMap((item) => (
      (item.ledgerExpenseCategories || []).map((entry) => ({
        label: `${item.address}: ${entry.category}`,
        amount: entry.amount,
        category: entry.category,
        propertyAddress: item.address,
      }))
    )).filter((line) => {
      if (!categoryNeedle) return true;
      return entryMatchesCategoryNeedle(line, categoryNeedle, line.category);
    }).slice(0, limit);

    const total = lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
    if (!lines.length) {
      return {
        ok: true,
        actionId: 'show-bookkeeping-expenses',
        title: 'Bookkeeping Expenses',
        summary: property
          ? `I opened Bookkeeping for ${property.address}, but I could not find expense entries${taxYear ? ` for ${taxYear}` : ''}${categoryNeedle ? ` matching “${categoryNeedle}”` : ''} yet.`
          : `I opened Bookkeeping, but I could not find expense entries${taxYear ? ` for ${taxYear}` : ''}${categoryNeedle ? ` matching “${categoryNeedle}”` : ''} yet.`,
        detailMessage: 'If this property uses sample finance data, switch to the live ledger or post transactions first.',
        navigation: {
          route: propertyManagementRoute({ tab: 'bookkeeping', propertyId: resolvedPropertyId }),
          tab: 'bookkeeping',
        },
        result: {
          type: 'expense_breakdown',
          title: 'No expenses found',
          total: 0,
          lines: [],
          periodLabel,
          categoryTotals: [],
          incomeTotals: [],
          matchedCategory: categoryNeedle || null,
          entryCount: 0,
          speakableAnswer: `No matching ledger entries found${taxYear ? ` for ${taxYear}` : ''}${property?.address ? ` at ${property.address}` : ''}${categoryNeedle ? ` for ${categoryNeedle}` : ''}.`,
        },
        actions: [openBookkeepingAction],
      };
    }

    return {
      ok: true,
      actionId: 'show-bookkeeping-expenses',
      title: 'Bookkeeping Expenses',
      summary: `Here are your top expense categories (${money(total)} shown)${property?.address ? ` for ${property.address}` : ''}.`,
      navigation: {
        route: propertyManagementRoute({ tab: 'bookkeeping', propertyId: resolvedPropertyId }),
        tab: 'bookkeeping',
      },
      result: {
        type: 'expense_breakdown',
        title: 'Expense breakdown',
        total,
        lines,
        periodLabel,
        categoryTotals: lines,
        incomeTotals: [],
        matchedCategory: categoryNeedle || null,
        entryCount: lines.length,
        speakableAnswer: categoryNeedle
          ? `${categoryNeedle} totals ${money(total)}${property?.address ? ` at ${property.address}` : ''}${taxYear ? ` in ${taxYear}` : ''}.`
          : `Top expense categories total ${money(total)}${property?.address ? ` at ${property.address}` : ''}${taxYear ? ` in ${taxYear}` : ''}: ${lines.slice(0, 5).map((line) => `${line.category} ${money(line.amount)}`).join(', ')}.`,
      },
      actions: [openBookkeepingAction],
    };
  }

  const topCategorySummary = (categoryNeedle ? categoryLines : categoryLines.slice(0, 6))
    .map((line) => `${line.category} ${money(line.amount)}`)
    .join(', ');
  const topIncomeSummary = incomeLines.slice(0, 6)
    .map((line) => `${line.category} ${money(line.amount)}`)
    .join(', ');

  const speakableAnswer = categoryNeedle
    ? `${categoryNeedle} totals ${money(spokenTotal)}${property?.address ? ` at ${property.address}` : ''}${taxYear ? ` in ${taxYear}` : ''} across ${matchingTransactions.length} transaction${matchingTransactions.length === 1 ? '' : 's'} (posted Azure bookkeeping).`
    : wantsIncomeAnswer
      ? `Posted ledger income totals ${money(totalIncome)}${property?.address ? ` at ${property.address}` : ''}${taxYear ? ` in ${taxYear}` : ''}${topIncomeSummary ? `: ${topIncomeSummary}` : ''} (actual collected — not modeled Analytics rent × 12).`
      : `Ledger expenses total ${money(totalExpenses)}${property?.address ? ` at ${property.address}` : ''}${taxYear ? ` in ${taxYear}` : ''}${topCategorySummary ? `: ${topCategorySummary}` : ''}.`;

  return {
    ok: true,
    actionId: 'show-bookkeeping-expenses',
    title: wantsIncomeAnswer && !categoryNeedle
      ? 'Bookkeeping Income'
      : (categoryNeedle ? 'Bookkeeping Category Detail' : 'Bookkeeping Expenses'),
    summary: speakableAnswer,
    detailMessage: categoryNeedle
      ? `Category total ${money(spokenTotal)} from the live Azure ledger (not just the first few rows).`
      : wantsIncomeAnswer
        ? `Posted income ${money(totalIncome)} from ${entries.length} ledger entries.`
        : `Category totals from ${entries.length} ledger entries.`,
    navigation: {
      route: propertyManagementRoute({ tab: 'bookkeeping', propertyId: resolvedPropertyId }),
      tab: 'bookkeeping',
    },
    result: {
      type: 'expense_breakdown',
      title: categoryNeedle
        ? `${categoryNeedle} · ${taxYear || 'ledger'}`
        : wantsIncomeAnswer
          ? (taxYear ? `${taxYear} posted income` : 'Posted income')
          : (taxYear ? `${taxYear} expense categories` : 'Expense categories'),
      total: spokenTotal,
      lines: wantsIncomeAnswer && !categoryNeedle
        ? incomeLines.slice(0, limit)
        : primaryLines,
      periodLabel,
      categoryTotals: categoryLines,
      incomeTotals: incomeLines,
      matchedCategory: categoryNeedle || null,
      totalExpenses,
      totalIncome,
      entryCount: entries.length,
      matchedTransactionCount: matchingTransactions.length,
      sampleTransactions: matchingTransactions.slice(0, limit),
      speakableAnswer,
      dataSource: 'azure_ledger',
    },
    actions: [openBookkeepingAction],
  };
}

async function addBookkeepingTransaction({ userId, params }) {
  const amount = Number(params.amount);
  const memo = params.memo || params.description || params.category || '';
  const isExpense = params.isExpense !== false && params.type !== 'income';

  if (!Number.isFinite(amount) || amount <= 0 || !memo) {
    return needsInputResponse(
      'add-bookkeeping-transaction',
      'Add Bookkeeping Transaction',
      'I need an amount and a short description to post this transaction.',
      [
        { id: 'amount', label: 'Amount', inputType: 'number', required: true },
        { id: 'memo', label: 'Description', required: true },
        { id: 'category', label: 'Category' },
      ],
    );
  }

  try {
    const bookkeeping = await import('../bookkeeping-firestore.js');
    const createPostedJournalEntry = bookkeeping.createPostedJournalEntry;
    if (typeof createPostedJournalEntry !== 'function') {
      throw new Error('Journal entry creator unavailable');
    }

    const category = params.category || (isExpense ? 'Repairs' : 'Rental Income');
    const entryDate = params.date || new Date().toISOString().slice(0, 10);
    const cashLine = {
      accountCode: '1000',
      accountName: 'Operating Cash',
      debit: isExpense ? 0 : amount,
      credit: isExpense ? amount : 0,
      propertyId: params.propertyId || null,
    };
    const categoryLine = {
      accountCode: params.accountCode || (isExpense ? '5100' : '4000'),
      accountName: category,
      debit: isExpense ? amount : 0,
      credit: isExpense ? 0 : amount,
      propertyId: params.propertyId || null,
    };

    const result = await createPostedJournalEntry(userId, {
      entryDate,
      memo,
      source: 'ASSISTANT',
      sourceRef: 'assistant-action',
      lines: [cashLine, categoryLine],
      propertyId: params.propertyId || null,
      postedBy: 'assistant',
      isExpense,
      category,
    });

    return {
      ok: true,
      actionId: 'add-bookkeeping-transaction',
      title: 'Add Bookkeeping Transaction',
      summary: `Posted ${isExpense ? 'expense' : 'income'} of ${money(amount)} — ${memo}.`,
      detailMessage: 'Transaction is in your ledger now.',
      navigation: {
        route: '/bookkeeping',
      },
      result: {
        type: 'generic',
        title: 'Transaction posted',
        message: `${money(amount)} ${isExpense ? 'expense' : 'income'} recorded as “${memo}”.`,
        details: [
          `Category: ${category}`,
          `Date: ${entryDate}`,
          result?.journalEntryId ? `Entry id: ${result.journalEntryId}` : null,
        ].filter(Boolean),
      },
      actions: [
        { id: 'open-bookkeeping', label: 'Open Bookkeeping', kind: 'navigate', route: '/bookkeeping', primary: true },
        { id: 'show-expenses', label: 'Show expenses', kind: 'refresh', payload: { actionId: 'show-bookkeeping-expenses' } },
      ],
    };
  } catch (error) {
    return {
      ok: false,
      actionId: 'add-bookkeeping-transaction',
      title: 'Add Bookkeeping Transaction',
      summary: 'Could not post that transaction yet.',
      error: error.message || 'bookkeeping_post_failed',
      navigation: {
        route: '/bookkeeping',
      },
    };
  }
}

async function downloadIrsTaxFile({ userId, params }) {
  const taxYear = Number(params.taxYear || params.year) || new Date().getFullYear() - 1;
  const query = new URLSearchParams({ year: String(taxYear) });
  if (params.propertyId) query.set('propertyId', String(params.propertyId));
  if (params.homeState) query.set('homeState', String(params.homeState));
  const url = `/api/bookkeeping/firestore/tax/export-pdf?${query.toString()}`;

  const result = {
    type: 'pdf',
    title: `Schedule E report (${taxYear})`,
    url,
    filename: `schedule-e-report-${taxYear}.pdf`,
    formLabel: 'IRS Schedule E packet',
    taxYear,
  };

  return {
    ok: true,
    actionId: 'download-irs-tax-file',
    title: 'Download IRS Tax File',
    summary: `Prepared your ${taxYear} Schedule E PDF from Tax Center.`,
    detailMessage: 'Open or download it from the task pad. I also took you to Tax Center.',
    navigation: {
      route: propertyManagementRoute({ tab: 'tax', propertyId: params.propertyId }),
      tab: 'tax',
    },
    result,
    actions: [
      { id: 'view-pdf', label: 'View PDF', kind: 'open', href: url, primary: true, payload: { filename: result.filename } },
      { id: 'download-pdf', label: 'Download', kind: 'download', href: url, payload: { filename: result.filename } },
      { id: 'open-tax', label: 'Open Tax Center', kind: 'navigate', route: propertyManagementRoute({ tab: 'tax', propertyId: params.propertyId }) },
    ],
    artifacts: [
      { id: `schedule-e-${taxYear}`, label: `Schedule E ${taxYear}`, kind: 'pdf', url },
    ],
  };
}

async function followUpMaintenance({ userId, params }) {
  let request = null;
  const requestId = normalizeId(params.requestId);

  try {
    if (requestId) {
      const snap = await db.collection('maintenance_requests').doc(requestId).get();
      if (snap.exists) request = { id: snap.id, ...snap.data() };
    }

    if (!request) {
      const snapshot = await db.collection('maintenance_requests')
        .where('ownerId', '==', userId)
        .limit(30)
        .get();
      const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      const needle = String(params.issue || params.query || '').toLowerCase();
      request = needle
        ? docs.find((item) => String(item.description || item.issue || item.title || '').toLowerCase().includes(needle))
        : docs.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0];
    }
  } catch (error) {
    console.warn('[AssistantActions] maintenance lookup failed:', error.message);
  }

  if (!request) {
    return needsInputResponse(
      'follow-up-maintenance-request',
      'Maintenance Follow-up',
      'I could not find an open maintenance request. Tell me the issue or request id.',
      [{ id: 'issue', label: 'Issue description', required: true }],
    );
  }

  const provider = request.aiAutomation?.selectedProvider || request.selectedProvider || {};
  const result = {
    type: 'maintenance_case',
    title: request.title || request.issue || 'Maintenance request',
    requestId: request.id,
    status: request.status || request.aiAutomation?.status || 'open',
    issueSummary: clip(request.description || request.issue || request.notes || 'No details on file', 280),
    propertyAddress: request.propertyAddress || '',
    providerName: provider.name || request.providerName || '',
    providerPhone: provider.phone || request.providerPhone || '',
    nextStep: request.aiAutomation?.status === 'provider_found'
      ? 'A provider was found — you can book or message them next.'
      : 'Review the case details and decide whether to book a provider.',
  };

  return {
    ok: true,
    actionId: 'follow-up-maintenance-request',
    title: 'Maintenance Follow-up',
    summary: `Here’s the latest on “${result.title}”.`,
    navigation: {
      route: '/property-management?tab=maintenance',
      tab: 'maintenance',
    },
    result,
    actions: [
      { id: 'open-maintenance', label: 'Open Maintenance', kind: 'navigate', route: '/property-management?tab=maintenance', primary: true },
      {
        id: 'book-provider',
        label: 'Find provider',
        kind: 'refresh',
        payload: { actionId: 'book-maintenance-provider', requestId: request.id },
      },
    ],
  };
}

async function bookMaintenanceProvider({ userId, params }) {
  const issue = params.issue || params.description || 'plumbing issue';
  const property = await resolveProperty({
    userId,
    propertyId: params.propertyId,
    propertyAddress: params.propertyAddress,
  });

  // Prefer kicking the existing maintenance automation when a request id exists.
  if (params.requestId) {
    try {
      // Soft signal: store an assistant booking intent on the request.
      await db.collection('maintenance_requests').doc(params.requestId).set({
        assistantBookingIntent: {
          requestedAt: new Date().toISOString(),
          issue,
          autoBook: params.autoBook !== false,
        },
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch {
      // non-blocking
    }
  }

  const result = {
    type: 'maintenance_case',
    title: 'Maintenance provider search',
    requestId: params.requestId || undefined,
    status: 'searching',
    issueSummary: `Looking for a good provider for: ${issue}`,
    propertyAddress: property?.address || params.propertyAddress || '',
    nextStep: 'I opened Maintenance and queued a provider search. Confirm details there if needed.',
  };

  return {
    ok: true,
    actionId: 'book-maintenance-provider',
    title: 'Book Maintenance Provider',
    summary: `Started a provider search for your ${issue}.`,
    detailMessage: 'Check Maintenance for provider options and booking status.',
    navigation: {
      route: '/property-management?tab=maintenance',
      tab: 'maintenance',
    },
    result,
    actions: [
      { id: 'open-maintenance', label: 'Open Maintenance', kind: 'navigate', route: '/property-management?tab=maintenance', primary: true },
    ],
  };
}

function propertyWorkspaceRoute(property, address, workspace) {
  return buildPropertyWorkspaceRoute({
    propertyId: property?.id || '',
    address: address || property?.address || '',
    workspace,
  });
}

async function loadMarketMortgageRate(userId) {
  let marketRate = null;
  try {
    marketRate = await getHistoricalMortgageRate(new Date().toISOString().slice(0, 10));
  } catch {
    marketRate = null;
  }
  if (!Number.isFinite(Number(marketRate))) {
    try {
      const context = await buildAssistantCanonicalContext({
        userId,
        includeFinancialDetails: false,
        includeGlobalContext: true,
      });
      const raw = context?.sections?.globalMarket?.housing?.overview?.mortgageRate?.value;
      marketRate = Number(raw);
    } catch {
      marketRate = null;
    }
  }
  return Number.isFinite(Number(marketRate)) ? Number(marketRate) : null;
}

async function buildRefinanceSlice(detail, market) {
  const currentRate = Number(detail.interestRate);
  const value = Number(detail.currentValue) || 0;
  const mortgageBalance = Number(detail.mortgageBalance) || 0;
  const equity = Number(detail.equity) || Math.max(value - mortgageBalance, 0);
  const ltv = value > 0 ? (mortgageBalance / value) * 100 : null;
  const cashOut75 = Math.max((value * 0.75) - mortgageBalance, 0);
  const rateGap = (Number.isFinite(currentRate) && market != null) ? (currentRate - market) : null;

  let verdict = 'Mixed — review the analytics workspace before deciding.';
  if (cashOut75 >= 25000 && rateGap != null && rateGap > 0.4 && (ltv == null || ltv < 72)) {
    verdict = 'Strong cash-out refinance candidate on paper: meaningful equity room and a higher current rate than today’s market reference.';
  } else if (cashOut75 >= 15000 && (ltv == null || ltv < 78)) {
    verdict = 'Possible cash-out candidate — equity exists, but compare closing costs and the new payment carefully.';
  } else if (cashOut75 < 10000) {
    verdict = 'Weak cash-out candidate right now — limited extractable equity at a conventional 75% LTV.';
  } else if (rateGap != null && rateGap < 0) {
    verdict = 'Equity may exist, but your current rate already looks competitive versus today’s market reference.';
  }

  return {
    verdict,
    metrics: [
      { label: 'Property value', value: money(value) },
      { label: 'Mortgage balance', value: money(mortgageBalance) },
      { label: 'Equity', value: money(equity) },
      { label: 'Current rate', value: Number.isFinite(currentRate) ? `${currentRate.toFixed(2)}%` : '—' },
      { label: 'Market rate', value: market != null ? `${market.toFixed(2)}%` : '—' },
      { label: 'LTV', value: Number.isFinite(ltv) ? `${ltv.toFixed(1)}%` : '—' },
      { label: 'NOI / yr', value: money(detail.noi) },
      { label: 'Cash flow / yr', value: money(detail.annualNetCashFlow) },
      { label: 'Cash-out @ 75% LTV', value: money(cashOut75) },
    ],
    bullets: [
      `Current value about ${money(value)} with ${money(mortgageBalance)} mortgage balance (${money(equity)} equity).`,
      Number.isFinite(currentRate)
        ? `Modeled loan rate about ${currentRate.toFixed(2)}%${market != null ? ` vs today’s ~${market.toFixed(2)}% market reference` : ''}.`
        : (market != null ? `Today’s market mortgage reference is about ${market.toFixed(2)}%.` : 'Market mortgage rate unavailable right now.'),
      Number.isFinite(ltv) ? `Current LTV about ${ltv.toFixed(1)}%.` : null,
      `Annual NOI about ${money(detail.noi)} with net cash flow around ${money(detail.annualNetCashFlow)}/yr.`,
      cashOut75 > 0
        ? `At a 75% LTV cash-out refi, modeled extractable equity is about ${money(cashOut75)} before closing costs.`
        : 'At 75% LTV there is little/no modeled cash-out room right now.',
    ].filter(Boolean),
    scenarios: [
      {
        label: market != null ? `Rate-and-term at ~${market.toFixed(2)}%` : 'Rate-and-term refinance',
        detail: rateGap != null && rateGap > 0.25
          ? `Could lower the modeled rate by about ${rateGap.toFixed(2)} pts if you qualify near today’s market.`
          : 'May not improve payment much unless you can beat your current rate after fees.',
      },
      {
        label: '75% LTV cash-out',
        detail: cashOut75 > 0
          ? `Modeled cash available ~${money(cashOut75)}; new loan would be sized near ${money(value * 0.75)}.`
          : 'Little/no cash-out room at 75% LTV on current value/balance.',
      },
      {
        label: 'Hold as-is',
        detail: `Keep current debt service (~${money(detail.annualDebtService)}/yr) and ${money(detail.annualNetCashFlow)} modeled annual cash flow.`,
      },
    ],
    nextSteps: [
      'Open the property Analytics tab to review cash flow, debt service, and equity charts.',
      'Compare closing costs and the new payment against the cash you would pull out.',
      cashOut75 > 0
        ? 'If you want, I can draft a lender outreach note or schedule a refinance follow-up.'
        : 'Focus on value-add or principal paydown before revisiting cash-out.',
    ],
    speakableAnswer: `${detail.address}: ${verdict} Value ${money(value)}, mortgage ${money(mortgageBalance)}, equity ${money(equity)}${Number.isFinite(currentRate) ? `, current rate ${currentRate.toFixed(2)}%` : ''}${market != null ? ` versus market ${market.toFixed(2)}%` : ''}. Cash-out room at 75% LTV is about ${money(cashOut75)}.`,
    cashOut75,
  };
}

function buildOverviewSlice(detail) {
  const beds = detail.beds != null ? detail.beds : '—';
  const baths = detail.baths != null ? detail.baths : '—';
  const sqft = detail.sqft != null ? `${Number(detail.sqft).toLocaleString()} sf` : '—';
  const yearBuilt = detail.yearBuilt != null ? String(detail.yearBuilt) : '—';
  const tenants = Number.isFinite(Number(detail.tenantCount)) ? Number(detail.tenantCount) : 0;
  const verdict = `${detail.address} looks like a ${beds}/${baths} rental with ${money(detail.currentValue)} modeled value and ${money(detail.monthlyRent)}/mo current rent.`;
  return {
    verdict,
    metrics: [
      { label: 'Beds / Baths', value: `${beds} / ${baths}` },
      { label: 'Living area', value: sqft },
      { label: 'Year built', value: yearBuilt },
      { label: 'Property value', value: money(detail.currentValue) },
      { label: 'Current rent', value: `${money(detail.monthlyRent)}/mo` },
      { label: 'Market rent', value: detail.marketRent != null ? `${money(detail.marketRent)}/mo` : '—' },
      { label: 'Tenants on file', value: String(tenants) },
      { label: 'Equity', value: money(detail.equity) },
    ],
    bullets: [
      `Basics: ${beds} bed / ${baths} bath, ${sqft}, built ${yearBuilt}.`,
      `Modeled value ${money(detail.currentValue)} with ${money(detail.equity)} equity.`,
      `Current rent ${money(detail.monthlyRent)}/mo${detail.marketRent != null ? ` vs market rent hint ${money(detail.marketRent)}/mo` : ''}.`,
      tenants > 0 ? `${tenants} tenant record(s) on file.` : 'No current tenant record on file yet.',
    ],
    scenarios: [],
    nextSteps: [
      'Open Overview for the full property snapshot.',
      'Ask me to check rental pricing power, refinance room, or environmental risk next.',
    ],
    speakableAnswer: verdict,
  };
}

function buildAnalyticsSlice(detail) {
  const verdict = `Modeled NOI about ${money(detail.noi)}/yr with net cash flow around ${money(detail.annualNetCashFlow)}/yr and a ${Number(detail.capRate || 0).toFixed(1)}% cap rate.`;
  return {
    verdict,
    metrics: [
      { label: 'Gross rent / yr', value: money(detail.annualGrossIncome) },
      { label: 'OpEx / yr', value: money(detail.annualOperatingExpenses) },
      { label: 'NOI / yr', value: money(detail.noi) },
      { label: 'Debt service / yr', value: money(detail.annualDebtService) },
      { label: 'Cash flow / yr', value: money(detail.annualNetCashFlow) },
      { label: 'Cap rate', value: `${Number(detail.capRate || 0).toFixed(1)}%` },
      { label: 'Gross yield', value: `${Number(detail.grossYield || 0).toFixed(1)}%` },
      { label: 'Expense ratio', value: `${(Number(detail.expenseRatio || 0) * 100).toFixed(0)}%` },
      { label: 'Equity', value: money(detail.equity) },
    ],
    bullets: [
      `Income ${money(detail.annualGrossIncome)}/yr minus OpEx ${money(detail.annualOperatingExpenses)} → NOI ${money(detail.noi)}.`,
      `After debt service ${money(detail.annualDebtService)}, modeled cash flow is ${money(detail.annualNetCashFlow)}/yr.`,
      `Cap rate ${Number(detail.capRate || 0).toFixed(1)}%, gross yield ${Number(detail.grossYield || 0).toFixed(1)}%.`,
    ],
    scenarios: [],
    nextSteps: [
      'Open Analytics for the charts behind these numbers.',
      'I can also run a cash-out refinance check or rental pricing reset from here.',
    ],
    speakableAnswer: `${detail.address}: ${verdict}`,
  };
}

async function buildRentalPricingSlice(detail, property, { userId, params = {} } = {}) {
  const targetRent = Number(
    params.targetRent
    || params.askingRent
    || params.candidateRent
    || null,
  );

  try {
    const analysis = await buildAlignedRentalPricingAnalysis({
      userId,
      property,
      detail,
      targetRent: Number.isFinite(targetRent) && targetRent > 0 ? targetRent : null,
    });

    if (!analysis.ok) {
      return {
        verdict: analysis.error === 'missing_zip'
          ? 'I need a ZIP code on this property before I can run the same RentCast comps + vacancy model as Rental Pricing Power.'
          : 'I could not resolve a current rent from bookkeeping or tenant records yet.',
        metrics: [
          { label: 'Current rent', value: analysis.currentRent ? `${money(analysis.currentRent)}/mo` : '—' },
          { label: 'ZIP', value: analysis.facts?.zipCode || '—' },
        ],
        bullets: [
          'Open Rental Pricing Power once ZIP / rent data is available — the assistant uses that exact endpoint.',
        ],
        scenarios: [],
        nextSteps: ['Open the property Overview and confirm ZIP + rent, then ask me again.'],
        speakableAnswer: `I could not finish rental pricing for ${detail.address} yet (${analysis.error}).`,
        recommendedRent: null,
      };
    }

    return {
      verdict: analysis.verdict,
      metrics: analysis.metrics,
      bullets: analysis.bullets,
      scenarios: analysis.scenarios,
      nextSteps: analysis.nextSteps,
      speakableAnswer: analysis.speakableAnswer,
      recommendedRent: analysis.recommendedRent,
    };
  } catch (error) {
    console.warn('[analyze-property] aligned rental pricing failed:', error?.message || error);
    return {
      verdict: 'Rental Pricing Power data failed to load — open the workspace and I can retry.',
      metrics: [
        { label: 'Current rent', value: detail.monthlyRent ? `${money(detail.monthlyRent)}/mo` : '—' },
      ],
      bullets: [`Error loading live comps/vacancy model: ${error?.message || 'unknown'}`],
      scenarios: [],
      nextSteps: ['Open Rental Pricing Power and ask me to re-run the analysis.'],
      speakableAnswer: `I hit an error loading the live rental pricing model for ${detail.address}.`,
      recommendedRent: null,
    };
  }
}

function buildEnvironmentalSlice(detail) {
  const flood = detail.floodZone || 'Unknown';
  const wildfire = detail.wildfireRisk != null ? String(detail.wildfireRisk) : 'Unknown';
  const floodHigh = /\b(A|AE|AH|AO|V|VE)\b/i.test(String(flood)) || /high|severe/i.test(String(flood));
  const fireHigh = Number(wildfire) >= 6 || /high|severe|extreme/i.test(String(wildfire));

  let verdict = 'Environmental risk looks manageable on the data we have — open Environmental Risk for the full mitigation plan.';
  if (floodHigh && fireHigh) {
    verdict = 'Elevated flood and wildfire signals — prioritize mitigation and insurance review.';
  } else if (floodHigh) {
    verdict = `Flood exposure looks elevated (zone ${flood}). Review drainage, barriers, and flood insurance.`;
  } else if (fireHigh) {
    verdict = `Wildfire signal looks elevated (${wildfire}). Review defensible space and fire-resistant upgrades.`;
  }

  return {
    verdict,
    metrics: [
      { label: 'Flood / FEMA', value: String(flood) },
      { label: 'Wildfire signal', value: String(wildfire) },
      { label: 'ZIP', value: detail.zip || '—' },
      { label: 'Beds / Baths', value: `${detail.beds ?? '—'} / ${detail.baths ?? '—'}` },
    ],
    bullets: [
      `Flood / FEMA context: ${flood}.`,
      `Wildfire signal: ${wildfire}.`,
      'I opened the Environmental Risk workspace so you can run the full AI mitigation plan with seasonal patterns.',
    ],
    scenarios: [
      {
        label: 'Run full mitigation plan',
        detail: 'Use the Environmental Risk panel for prioritized upgrades, cost ranges, and insurance impact.',
      },
      {
        label: 'Insurance follow-up',
        detail: 'I can help navigate insurance discount / certificate workflows after you review the risks.',
      },
    ],
    nextSteps: [
      'Open Environmental Risk and tap Analyze for the full improvement plan.',
      'Ask me to schedule a mitigation follow-up or open Sensors if you want leak monitoring next.',
    ],
    speakableAnswer: `${detail.address}: ${verdict} Flood ${flood}, wildfire ${wildfire}.`,
  };
}

function mergeAnalysisSlices(slices, { title, address }) {
  const metrics = [];
  const bullets = [];
  const scenarios = [];
  const nextSteps = [];
  const seenMetric = new Set();
  const seenBullet = new Set();

  for (const slice of slices) {
    for (const metric of slice.metrics || []) {
      if (seenMetric.has(metric.label)) continue;
      seenMetric.add(metric.label);
      metrics.push(metric);
    }
    for (const bullet of slice.bullets || []) {
      if (seenBullet.has(bullet)) continue;
      seenBullet.add(bullet);
      bullets.push(bullet);
    }
    scenarios.push(...(slice.scenarios || []));
    nextSteps.push(...(slice.nextSteps || []));
  }

  const verdict = slices.map((s) => s.verdict).filter(Boolean).join(' ');
  const speakableAnswer = slices.map((s) => s.speakableAnswer).filter(Boolean).join(' ')
    || `${address}: ${verdict}`;

  return {
    type: 'property_analysis',
    title,
    summary: `${address}: ${slices[0]?.verdict || verdict}`,
    propertyAddress: address,
    verdict: slices[0]?.verdict || verdict,
    bullets: bullets.slice(0, 10),
    metrics: metrics.slice(0, 12),
    scenarios: scenarios.slice(0, 6),
    nextSteps: [...new Set(nextSteps)].slice(0, 5),
    speakableAnswer: clip(speakableAnswer, 700),
  };
}

async function analyzeProperty({ userId, params }) {
  const actionId = 'analyze-property';
  const property = await resolveProperty({
    userId,
    propertyId: params.propertyId,
    propertyAddress: params.propertyAddress || params.address || params.location,
    address: params.address,
    location: params.location,
  });

  if (!property && (params.propertyAddress || params.address || params.location)) {
    return needsInputResponse(
      actionId,
      'Property Analysis',
      `I could not find a property matching “${params.propertyAddress || params.address || params.location}”. Which property should I analyze?`,
      [{ id: 'propertyAddress', label: 'Property address', required: true }],
    );
  }

  if (!property && !params.propertyId) {
    return needsInputResponse(
      actionId,
      'Property Analysis',
      'Which property should I analyze?',
      [{ id: 'propertyAddress', label: 'Property address', required: true }],
    );
  }

  const propertyNeedle = property?.id || property?.address || params.propertyAddress || params.address || null;
  const analytics = await computeAssistantAnalytics({
    userId,
    metric: 'portfolio_summary',
    propertyId: propertyNeedle,
  });
  const detail = Array.isArray(analytics.perProperty) && analytics.perProperty.length
    ? analytics.perProperty[0]
    : null;

  if (!detail) {
    return {
      ok: false,
      actionId,
      title: 'Property Analysis',
      summary: 'I could not load property details for that address yet.',
      error: 'property_analytics_unavailable',
      navigation: { route: '/portfolio?tab=properties' },
    };
  }

  let mode = inferPropertyAnalysisMode(params);
  if (mode === 'auto') {
    mode = 'full';
  }

  const address = detail.address || property?.address || '';
  const workspace = workspaceForAnalysisMode(mode);
  const primaryRoute = propertyWorkspaceRoute(property, address, workspace);
  const overviewRoute = propertyWorkspaceRoute(property, address, 'overview');
  const analyticsRoute = propertyWorkspaceRoute(property, address, 'analytics');
  const pricingRoute = propertyWorkspaceRoute(property, address, 'rentalPricingPower');
  const envRoute = propertyWorkspaceRoute(property, address, 'environmentalRisk');

  const slices = [];
  let title = 'Property Analysis';
  let recommendedRent = null;

  if (mode === 'overview') {
    title = 'Property Overview';
    slices.push(buildOverviewSlice(detail));
  } else if (mode === 'analytics') {
    title = 'Property Analytics';
    slices.push(buildAnalyticsSlice(detail));
  } else if (mode === 'refinance') {
    title = 'Cash-Out Refinance Analysis';
    const market = await loadMarketMortgageRate(userId);
    slices.push(await buildRefinanceSlice(detail, market));
  } else if (mode === 'rental_pricing') {
    title = 'Rental Pricing Power';
    const pricing = await buildRentalPricingSlice(detail, property, { userId, params });
    recommendedRent = pricing.recommendedRent;
    slices.push(pricing);
  } else if (mode === 'environmental_risk') {
    title = 'Environmental Risk';
    slices.push(buildEnvironmentalSlice(detail));
  } else {
    title = 'Full Property Review';
    slices.push(buildOverviewSlice(detail));
    slices.push(buildAnalyticsSlice(detail));
    const market = await loadMarketMortgageRate(userId);
    slices.push(await buildRefinanceSlice(detail, market));
    const pricing = await buildRentalPricingSlice(detail, property, { userId, params });
    recommendedRent = pricing.recommendedRent;
    slices.push(pricing);
    slices.push(buildEnvironmentalSlice(detail));
  }

  const result = mergeAnalysisSlices(slices, { title, address });

  const actions = [
    { id: 'open-primary', label: `Open ${workspace === 'rentalPricingPower' ? 'Rental Pricing' : workspace === 'environmentalRisk' ? 'Environmental Risk' : workspace === 'overview' ? 'Overview' : 'Analytics'}`, kind: 'navigate', route: primaryRoute, primary: true },
    { id: 'open-overview', label: 'Overview', kind: 'navigate', route: overviewRoute },
    { id: 'open-analytics', label: 'Analytics', kind: 'navigate', route: analyticsRoute },
    { id: 'open-pricing', label: 'Rental Pricing', kind: 'navigate', route: pricingRoute },
    { id: 'open-env', label: 'Environmental Risk', kind: 'navigate', route: envRoute },
  ];

  if (mode === 'rental_pricing' || mode === 'full') {
    actions.push({
      id: 'set-rent',
      label: recommendedRent ? `Set rent to ${money(recommendedRent)}` : 'Update tenant rent',
      kind: 'refresh',
      payload: {
        actionId: 'set-tenant-rent-rate',
        propertyId: property?.id,
        propertyAddress: address,
        monthlyRent: recommendedRent || undefined,
        requestSummary: `Update rent for ${address}`,
      },
    });
  }

  if (mode === 'refinance' || mode === 'analytics' || mode === 'full') {
    actions.push({
      id: 'show-expenses',
      label: 'Show expenses',
      kind: 'refresh',
      payload: {
        actionId: 'show-bookkeeping-expenses',
        propertyId: property?.id,
        propertyAddress: address,
      },
    });
  }

  return {
    ok: true,
    actionId,
    title,
    summary: result.speakableAnswer,
    detailMessage: `Opened ${workspace} and rendered the analysis in the task pad.`,
    navigation: { route: primaryRoute },
    result,
    actions,
  };
}

/** @deprecated Prefer analyze-property — kept as alias for older clients. */
async function analyzePropertyFinance(args) {
  const response = await analyzeProperty(args);
  if (response?.actionId === 'analyze-property') {
    return { ...response, actionId: 'analyze-property-finance' };
  }
  return response;
}

async function openPlatformWorkspace({ userId, params }) {
  // If the owner asked to open/find a specific document, find the file — don't just open the tab.
  const documentRoute = routeAssistantCapability({
    ...params,
    requestSummary: params.requestSummary || params.topic || params.notes || '',
  });
  if (documentRoute?.actionId === 'list-documents') {
    return listDocuments({
      userId,
      params: { ...params, ...(documentRoute.parameters || {}) },
    });
  }
  if (documentRoute?.actionId === 'create-document') {
    return createLeaseDocument({
      userId,
      params: { ...params, ...(documentRoute.parameters || {}) },
    });
  }

  const workspaceId = String(params.workspaceId || params.workspace || '').trim();
  const workspace = PLATFORM_WORKSPACES[workspaceId] || inferPlatformWorkspace(params);
  const property = await resolveProperty({
    userId,
    propertyId: params.propertyId,
    propertyAddress: params.propertyAddress || params.address || params.location,
  });

  if (!workspace && !workspaceId) {
    return needsInputResponse(
      'open-platform-workspace',
      'Open workspace',
      'Which area should I open — documents, tenants, maintenance, bookkeeping, tax, sensors, market, or renovations?',
      [{ id: 'workspaceId', label: 'Workspace', required: true }],
    );
  }

  const resolved = workspace || PLATFORM_WORKSPACES[workspaceId];
  if (!resolved) {
    return {
      ok: false,
      actionId: 'open-platform-workspace',
      title: 'Open workspace',
      summary: `I do not recognize workspace “${workspaceId}”.`,
      error: 'unknown_workspace',
    };
  }

  let route = resolved.route;
  if (property?.address && route.startsWith('/portfolio')) {
    route = propertyWorkspaceRoute(property, property.address, 'overview');
  }
  if (property?.id && /property-management/.test(route)) {
    const tab = String(new URL(route, 'https://houseyield.local').searchParams.get('tab') || 'documents');
    route = propertyManagementRoute({ tab, propertyId: property.id });
  }

  const layer = String(params.layer || '').trim().toLowerCase();
  if (layer && route.includes('/sensors')) {
    const url = new URL(route, 'https://houseyield.local');
    url.searchParams.set('tab', url.searchParams.get('tab') || 'analytics');
    url.searchParams.set('layer', layer);
    route = `${url.pathname}?${url.searchParams.toString()}`;
  }

  const result = {
    type: 'generic',
    title: `Opened ${resolved.label}`,
    message: property?.address
      ? `I opened ${resolved.label}${property.address ? ` with ${property.address} in mind` : ''}. Tell me what you want done next and I’ll execute it.`
      : `I opened ${resolved.label}. Tell me what you want done next and I’ll execute it.`,
    details: [
      'You do not need to hunt through menus — ask me to create, message, schedule, analyze, or update from here.',
    ],
  };

  return {
    ok: true,
    actionId: 'open-platform-workspace',
    title: resolved.label,
    summary: result.message,
    navigation: { route },
    result,
    actions: [
      { id: 'open-workspace', label: `Open ${resolved.label}`, kind: 'navigate', route, primary: true },
    ],
  };
}

async function analyzeMarketInsight({ userId, params }) {
  const fingerprint = buildFingerprint({
    topic: params.topic || params.query || 'market',
  });

  const reused = await findReusableAssistantOutput({
    userId,
    actionId: 'analyze-market-insight',
    fingerprint,
    maxAgeMs: 2 * 60 * 60 * 1000,
  });

  if (reused.reused && reused.result) {
    return {
      ok: true,
      actionId: 'analyze-market-insight',
      title: reused.title || 'Market Insight',
      summary: reused.summary || 'Reused your recent market analysis.',
      detailMessage: `Reused analysis from ${reused.ageLabel || 'earlier'}.`,
      navigation: { route: '/market-data' },
      result: reused.result,
      actions: reused.actions || [],
      reuseMeta: buildReuseMeta(reused),
    };
  }

  const context = await buildAssistantCanonicalContext({
    userId,
    includeFinancialDetails: false,
    includeGlobalContext: true,
  });

  const market = context.sections?.globalMarket || {};
  const housing = market.housing?.overview || {};
  const bullets = [];
  if (housing.mortgageRate?.value) bullets.push(`30Y mortgage around ${housing.mortgageRate.value}%`);
  if (housing.medianPrice?.value) bullets.push(`US median home price ${housing.medianPrice.value}`);
  if (housing.medianPrice?.yoy) bullets.push(`Home prices YoY ${housing.medianPrice.yoy}%`);
  if (market.treasury?.summary?.yieldCurve) bullets.push(`Yield curve: ${market.treasury.summary.yieldCurve}`);
  if (Array.isArray(market.headlines) && market.headlines[0]?.title) {
    bullets.push(`Headline: ${market.headlines[0].title}`);
  }

  const summary = bullets.length
    ? `Here’s the current market snapshot based on your cached HouseYield market context.`
    : 'Market context is limited right now, but I opened Market Data for you.';

  const result = {
    type: 'market_insight',
    title: params.topic || 'Market snapshot',
    summary,
    bullets,
    marketLabel: params.market || 'National / tracked markets',
  };

  const response = {
    ok: true,
    actionId: 'analyze-market-insight',
    title: 'Market Insight',
    summary,
    navigation: { route: '/market-data' },
    result,
    actions: [
      { id: 'open-market', label: 'Open Market Data', kind: 'navigate', route: '/market-data', primary: true },
      { id: 'refresh-market', label: 'Refresh analysis', kind: 'refresh', payload: { actionId: 'analyze-market-insight', forceRefresh: true } },
    ],
    reuseMeta: { reused: false },
  };

  await saveAssistantArtifact({
    userId,
    actionId: 'analyze-market-insight',
    title: response.title,
    summary,
    result,
    actions: response.actions,
    fingerprint,
  });

  return response;
}

async function analyzeSensorData({ userId, params }) {
  const inventory = await loadOwnerSensorInventory(userId);
  const { devices, alerts, counts } = inventory;

  const haystack = [
    params.requestSummary,
    params.view,
    params.layer,
    params.topic,
    params.customInstructions,
  ].filter(Boolean).join(' ').toLowerCase();

  let view = String(params.view || '').toLowerCase();
  if (!['overview', 'alerts', 'analytics'].includes(view)) {
    if (/\balerts?\b/.test(haystack)) view = 'alerts';
    else if (/\banalytics\b|\bmold\b|\bfreeze\b|\binsulation\b|\bhumidity\b|\btemperature\b/.test(haystack)) view = 'analytics';
    else view = 'overview';
  }

  let layer = String(params.layer || '').toLowerCase();
  if (!['conditions', 'mold', 'freeze', 'insulation'].includes(layer)) {
    if (/\bmold\b/.test(haystack)) layer = 'mold';
    else if (/\bfreeze\b/.test(haystack)) layer = 'freeze';
    else if (/\binsulation\b/.test(haystack)) layer = 'insulation';
    else layer = view === 'analytics' ? 'conditions' : '';
  }

  const focused = focusDevicesFromQuery(devices, haystack);
  const routeParams = new URLSearchParams({ tab: view });
  if (view === 'analytics' && layer) routeParams.set('layer', layer);
  const route = `/sensors?${routeParams.toString()}`;

  const recommendations = [];
  if (counts.flooded) recommendations.push(`Check ${counts.flooded} sensor${counts.flooded === 1 ? '' : 's'} reporting flood/leak conditions immediately.`);
  if (counts.offline) recommendations.push(`Reconnect or replace ${counts.offline} offline device${counts.offline === 1 ? '' : 's'}.`);
  if (counts.openAlerts) recommendations.push(`Review ${counts.openAlerts} open alert${counts.openAlerts === 1 ? '' : 's'} and acknowledge anything already handled.`);
  if (counts.shutoff) {
    const valves = devices.filter((device) => device.type === 'automatic_shutoff_controller');
    recommendations.push(
      `Water shutoff: ${valves.map((device) => `${device.name} is ${device.valveState || 'unknown'}`).join('; ')}.`,
    );
  }
  if (!recommendations.length) {
    recommendations.push('No urgent sensor issues found. Keep monitoring batteries on older devices.');
  }

  const speakableAnswer = buildSensorSpeakableAnswer(devices, focused, counts);
  const summary = devices.length
    ? speakableAnswer
    : 'I could not find linked sensors yet. I opened Predictive Maintenance so you can add one.';

  const metrics = [
    { label: 'Devices', value: String(counts.total) },
    { label: 'Online', value: String(counts.online) },
    { label: 'Temp / humidity', value: String(counts.ht) },
    { label: 'Flood', value: String(counts.flood) },
    { label: 'Shutoff valves', value: String(counts.shutoff) },
    { label: 'Gateways', value: String(counts.gateway) },
  ];

  return {
    ok: true,
    actionId: 'analyze-sensor-data',
    title: focused.length ? 'Room sensor check' : view === 'analytics' ? 'Predictive Maintenance Analytics' : 'Sensor Analysis',
    summary,
    detailMessage: focused.length
      ? `Focused on ${focused.map((device) => device.name).join(', ')}.`
      : undefined,
    navigation: { route },
    result: {
      type: 'sensor_insight',
      title: focused.length ? 'Requested rooms' : 'Your sensor inventory',
      deviceName: focused[0]?.name || devices.find((device) => device.type === 'temperature_humidity')?.name || devices[0]?.name,
      severity: counts.flooded ? 'high' : counts.offline || counts.openAlerts ? 'medium' : 'low',
      summary,
      speakableAnswer,
      recommendations,
      metrics,
      counts,
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        location: device.location,
        kindLabel: device.kindLabel,
        type: device.type,
        status: device.status,
        readingLabel: device.readingLabel,
        temperatureF: device.temperatureF,
        humidityPercent: device.humidityPercent,
        valveState: device.valveState,
        flooded: device.flooded,
        focused: focused.some((item) => item.canonicalKey === device.canonicalKey),
      })),
      focusedDeviceIds: focused.map((device) => device.id),
      openAlerts: alerts.filter((alert) => !alert.acknowledged).slice(0, 5).map((alert) => ({
        id: alert.id,
        deviceName: alert.deviceName,
        severity: alert.severity,
        message: alert.message,
      })),
      presentation: {
        headline: speakableAnswer,
        highlights: focused.length
          ? focused.map((device) => `${device.name}: ${device.readingLabel || device.status}`)
          : [
              counts.ht ? `${counts.ht} temperature & humidity sensor${counts.ht === 1 ? '' : 's'}` : null,
              counts.flood ? `${counts.flood} flood sensor${counts.flood === 1 ? '' : 's'}` : null,
              counts.shutoff ? `${counts.shutoff} water shutoff valve${counts.shutoff === 1 ? '' : 's'}` : null,
              counts.gateway ? `${counts.gateway} Bluetooth gateway${counts.gateway === 1 ? '' : 's'}` : null,
            ].filter(Boolean),
        rationale: recommendations.slice(0, 4),
      },
    },
    actions: [
      { id: 'open-sensors', label: 'Open Predictive Maintenance', kind: 'navigate', route, primary: true },
      { id: 'open-sensor-analytics', label: 'Open Analytics', kind: 'navigate', route: layer ? `/sensors?tab=analytics&layer=${layer}` : '/sensors?tab=analytics' },
      { id: 'add-sensor', label: 'Add sensor', kind: 'navigate', route: '/flood-sensors/setup' },
    ],
  };
}

function inferLinkedActionId(params = {}) {
  const explicit = String(params.actionId || params.linkedActionId || '').trim();
  if (explicit && explicit !== 'schedule-ai-task') return explicit;

  const haystack = [
    params.title,
    params.notes,
    params.body,
    params.message,
    params.requestSummary,
    params.customInstructions,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/late\s*(rent|payment)|overdue\s*rent|rent\s*reminder|pay\s*(their\s*)?rent/.test(haystack)) {
    return 'send-late-payment-alert';
  }
  if (/message|email|notify|tell\s+the\s+tenant|text\s+the\s+tenant|stopping\s+by|come\s+by/.test(haystack)) {
    return 'draft-tenant-message';
  }
  if (/plumb|maintenance|book\s+(a\s+)?(plumber|provider|contractor)|call\s+(the\s+)?(maintenance|plumber)/.test(haystack)) {
    return 'book-maintenance-provider';
  }
  if (/\b(find|show|list|open|view|existing|my)\b.*\b(pet\s+addendum|lease|document|addendum)\b/.test(haystack)
    && !/\b(create|make|draft|generate|new)\b/.test(haystack)) {
    return 'list-documents';
  }
  if (/create\s+(a\s+)?(lease|document|addendum)|make\s+(a\s+)?(lease|document|addendum)|draft\s+(a\s+)?(lease|document|addendum)|new\s+pet\s+addendum|generate\s+(a\s+)?(lease|document|addendum)/.test(haystack)) {
    return 'create-document';
  }
  if (/pet\s+addendum|lease\s+amendment/.test(haystack) && /\b(create|make|draft|generate|new)\b/.test(haystack)) {
    return 'create-document';
  }
  if (/e-?sign|request\s+signature|send\s+.*\s+for\s+signature/.test(haystack)) {
    return 'request-document-esignature';
  }
  return null;
}

async function scheduleAiTask({ userId, params }) {
  const title = String(params.title || params.requestSummary || params.notes || '').trim();
  const notes = String(params.notes || params.body || params.message || params.customInstructions || '').trim();
  // Prefer natural-language when over model-invented ISO runAt (which caused 8am/9am bugs).
  const when = params.when || params.scheduledFor || params.schedule || '';
  const runAt = looksLikeNaturalSchedulePhrase(params.runAt) ? params.runAt : (when ? undefined : params.runAt);

  if (!title && !notes) {
    return needsInputResponse(
      'schedule-ai-task',
      'Schedule AI Task',
      'What should I schedule, and when?',
      [
        { id: 'title', label: 'Task', required: true, placeholder: 'e.g. Remind Prestwick tenant about rent' },
        { id: 'when', label: 'When', required: true, placeholder: 'e.g. Friday at 3pm' },
        { id: 'notes', label: 'Details', placeholder: 'Optional notes for the AI' },
      ],
    );
  }

  if (!when && !params.date && !params.time && !runAt) {
    return needsInputResponse(
      'schedule-ai-task',
      'Schedule AI Task',
      'When should I do this?',
      [
        { id: 'title', label: 'Task', required: true },
        { id: 'when', label: 'When', required: true, placeholder: 'Monday at 2pm' },
        { id: 'notes', label: 'Details' },
      ],
    );
  }

  const linkedActionId = inferLinkedActionId(params);
  const property = await resolveProperty({
    userId,
    propertyId: params.propertyId,
    propertyAddress: params.propertyAddress || params.address || params.location,
    address: params.address,
    location: params.location,
  });

  let linkedParameters = {
    ...(params.parameters && typeof params.parameters === 'object' ? params.parameters : {}),
    requestSummary: title || notes,
    body: params.body || notes,
    subject: params.subject,
    propertyId: property?.id || params.propertyId,
    propertyAddress: property?.address || params.propertyAddress || params.address,
    tenantId: params.tenantId,
    tenantName: params.tenantName,
    issue: params.issue || notes,
    autoSend: params.autoSend === true,
  };

  if (linkedActionId === 'draft-tenant-message' || linkedActionId === 'send-late-payment-alert') {
    linkedParameters.body = linkedParameters.body || notes || title;
    if (params.autoSend === true || /\bsend\b/i.test(String(params.requestSummary || ''))) {
      linkedParameters.autoSend = params.autoSend === true;
    }
  }

  try {
    const created = await createAssistantScheduledTask({
      userId,
      title: title || clip(notes, 80) || 'Scheduled AI task',
      notes: notes || title,
      when: when || (looksLikeNaturalSchedulePhrase(params.runAt) ? params.runAt : ''),
      runAt,
      scheduledFor: params.scheduledFor,
      date: params.date,
      time: params.time,
      timeZone: params.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
      actionId: linkedActionId,
      parameters: linkedParameters,
      propertyId: property?.id || params.propertyId,
      propertyAddress: property?.address || params.propertyAddress,
      tenantId: params.tenantId,
      tenantName: params.tenantName,
      kind: linkedActionId ? 'action' : 'reminder',
    });

    const task = created.task;
    const whenLabel = new Date(task.runAt).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    const upcoming = await listAssistantScheduledTasks({ userId, includeCompleted: false, limit: 8 });

    return {
      ok: true,
      actionId: 'schedule-ai-task',
      title: 'Schedule AI Task',
      summary: `Scheduled “${task.title}” for ${whenLabel}.`,
      detailMessage: linkedActionId
        ? `At that time I’ll run ${linkedActionId.replace(/-/g, ' ')}. You can review the full list from the AI support card.`
        : 'Saved as a dated reminder on your AI task list.',
      result: {
        type: 'scheduled_tasks',
        title: 'Upcoming AI tasks',
        message: `Added for ${whenLabel}.`,
        tasks: upcoming.tasks || [task],
        highlightTaskId: task.id,
      },
      actions: [
        {
          id: 'view-schedule',
          label: 'Open schedule',
          kind: 'refresh',
          primary: true,
          payload: { actionId: 'list-scheduled-ai-tasks' },
        },
      ],
    };
  } catch (error) {
    return {
      ok: false,
      actionId: 'schedule-ai-task',
      title: 'Schedule AI Task',
      summary: 'Could not schedule that yet.',
      error: error.message || 'schedule_failed',
      result: {
        type: 'needs_input',
        title: 'Schedule AI Task',
        message: error.message || 'Tell me the task and when to run it.',
        fields: [
          { id: 'title', label: 'Task', required: true },
          { id: 'when', label: 'When', required: true, placeholder: 'Friday at 3pm' },
          { id: 'notes', label: 'Details' },
        ],
      },
    };
  }
}

async function listScheduledAiTasks({ userId, params }) {
  const includeCompleted = params.includeCompleted === true;
  const listed = await listAssistantScheduledTasks({
    userId,
    includeCompleted,
    limit: Number(params.limit) || 20,
  });

  const tasks = listed.tasks || [];
  return {
    ok: true,
    actionId: 'list-scheduled-ai-tasks',
    title: 'AI Task Schedule',
    summary: tasks.length
      ? `You have ${tasks.length} upcoming AI task${tasks.length === 1 ? '' : 's'}.`
      : 'No upcoming AI tasks yet. Ask me to schedule one.',
    detailMessage: 'Open the schedule from the AI support card anytime.',
    result: {
      type: 'scheduled_tasks',
      title: 'Upcoming AI tasks',
      message: tasks.length ? 'Here’s what’s on your calendar-dated list.' : 'Nothing scheduled yet.',
      tasks,
    },
    actions: [
      {
        id: 'schedule-another',
        label: 'Schedule another',
        kind: 'refresh',
        payload: { actionId: 'schedule-ai-task' },
      },
    ],
  };
}

async function annualWaterRecertification({ params }) {
  const propertyAddress = params.propertyAddress || 'your property';
  return {
    ok: true,
    actionId: 'annual-water-recertification',
    title: 'Water-Loss Protection Recertification',
    summary: `The annual functional recertification for ${propertyAddress} is due in approximately 30 days.`,
    detailMessage: 'Open the certificate packet to schedule and record the controlled sensor, shutoff, stopped-flow, restoration, and technician-signature tests.',
    navigation: {
      route: '/insurance-discount/certificate',
      state: {
        propertyId: params.propertyId || null,
        propertyAddress: params.propertyAddress || null,
        recertification: true,
      },
    },
    actions: [
      {
        id: 'open-recertification',
        label: 'Open recertification',
        kind: 'navigate',
        route: '/insurance-discount/certificate',
        primary: true,
      },
    ],
  };
}

const ACTION_HANDLERS = {
  'set-tenant-rent-rate': setTenantRentRate,
  'send-late-payment-alert': draftLatePaymentAlert,
  'draft-tenant-message': draftTenantMessage,
  'follow-up-esignature-request': followUpEsignature,
  'request-document-esignature': requestDocumentEsignature,
  'create-lease-agreement': createLeaseDocument,
  'create-document': createLeaseDocument,
  'list-documents': listDocuments,
  'open-document': listDocuments,
  'edit-document': editDocument,
  'draft-contractor-payment-receipt': draftContractorReceipt,
  'show-bookkeeping-expenses': showBookkeepingExpenses,
  'add-bookkeeping-transaction': addBookkeepingTransaction,
  'download-irs-tax-file': downloadIrsTaxFile,
  'follow-up-maintenance-request': followUpMaintenance,
  'book-maintenance-provider': bookMaintenanceProvider,
  'analyze-market-insight': analyzeMarketInsight,
  'analyze-property': analyzeProperty,
  'analyze-property-finance': analyzePropertyFinance,
  'open-platform-workspace': openPlatformWorkspace,
  'analyze-sensor-data': analyzeSensorData,
  'schedule-ai-task': scheduleAiTask,
  'list-scheduled-ai-tasks': listScheduledAiTasks,
  'annual-water-recertification': annualWaterRecertification,
};

export function listAssistantExecutableActions() {
  return Object.keys(ACTION_HANDLERS);
}

export async function executeAssistantAction({
  userId,
  actionId,
  parameters = {},
  runId = null,
  requestId = null,
  idempotencyKey = null,
  retryFailed = false,
  recoverRunning = false,
} = {}) {
  if (!userId) {
    throw new Error('userId is required');
  }

  let normalizedActionId = String(actionId || '').trim();
  let params = { ...(parameters || {}) };

  // Legacy alias → unified property analyzer (all workspaces).
  if (normalizedActionId === 'analyze-property-finance') {
    normalizedActionId = 'analyze-property';
  }

  let handler = ACTION_HANDLERS[normalizedActionId];
  if (!handler) {
    const routed = routeAssistantCapability({
      ...params,
      requestSummary: params.requestSummary || params.topic || params.notes || actionId,
    });
    if (routed?.actionId && ACTION_HANDLERS[routed.actionId]) {
      normalizedActionId = routed.actionId;
      params = { ...params, ...(routed.parameters || {}) };
      handler = ACTION_HANDLERS[normalizedActionId];
    }
  }

  // Model often opens the Documents workspace instead of finding the actual file.
  // Prefer list-documents / create-document when the request clearly asks for a document.
  if (normalizedActionId === 'open-platform-workspace') {
    const routed = routeAssistantCapability({
      ...params,
      requestSummary: params.requestSummary || params.topic || params.notes || '',
      workspaceId: params.workspaceId || params.workspace,
    });
    if (
      routed?.actionId
      && ACTION_HANDLERS[routed.actionId]
      && (routed.actionId === 'list-documents' || routed.actionId === 'create-document')
    ) {
      normalizedActionId = routed.actionId;
      params = { ...params, ...(routed.parameters || {}) };
      handler = ACTION_HANDLERS[normalizedActionId];
    }
  }

  if (!handler) {
    const unsupported = {
      ok: false,
      actionId: String(actionId || '').trim(),
      title: 'Unsupported action',
      summary: `No backend executor is registered for ${actionId}.`,
      error: 'unsupported_action',
    };
    const begun = await beginAssistantActivity({
      userId,
      runId,
      requestId,
      idempotencyKey,
      actionId: String(actionId || '').trim() || 'unsupported',
      requestSummary: params.requestSummary || params.topic || actionId,
      retryFailed,
      recoverRunning,
    });
    if (!begun.created && begun.response) return begun.response;
    const response = {
      ...unsupported,
      runId: begun.activity.runId,
      requestId: requestId || null,
      idempotencyKey: idempotencyKey || null,
    };
    await completeAssistantActivity({ userId, runId: begun.activity.runId, response });
    return response;
  }

  const begun = await beginAssistantActivity({
    userId,
    runId,
    requestId,
    idempotencyKey,
    actionId: normalizedActionId,
    requestSummary: params.requestSummary || params.topic || params.notes || actionId,
    retryFailed,
    recoverRunning,
  });
  if (!begun.created) {
    if (begun.response) return begun.response;
    return {
      ok: true,
      actionId: normalizedActionId,
      title: 'Action already running',
      summary: 'This assistant action is already in progress.',
      status: begun.activity.status || 'running',
      runId: begun.activity.runId,
      requestId: begun.activity.requestId || requestId || null,
      idempotencyKey: begun.activity.idempotencyKey || idempotencyKey || null,
      reused: true,
    };
  }

  try {
    const result = await handler({
      userId,
      params,
      runId: begun.activity.runId,
      requestId,
      idempotencyKey,
    });
    const response = {
      ...result,
      runId: begun.activity.runId,
      requestId: requestId || null,
      idempotencyKey: idempotencyKey || null,
    };
    await completeAssistantActivity({ userId, runId: begun.activity.runId, response });
    return response;
  } catch (error) {
    await failAssistantActivity({
      userId,
      runId: begun.activity.runId,
      error,
    }).catch((activityError) => {
      console.warn('[AssistantActions] Failed to record activity error:', activityError.message);
    });
    error.runId = begun.activity.runId;
    throw error;
  }
}
