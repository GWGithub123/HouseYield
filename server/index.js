// --- Server bootstrap (reconstructed after accidental truncation) ---
// If you see this header it replaced a previously corrupted file start that began with "*** End Patch".
// This section wires up express, env, and imports used further down in the file.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import nodeFetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import http from 'http';
import crypto from 'crypto';
import { calculateLaborItems, calculateMaterialQuantities } from './services/renovationMeasurementScopeCalculator.js';
import { estimateVacancyForRentModel, estimateLeaseUpRecoveryForRent } from '../src/utils/rentalVacancyModel.js';
import { getLocalRentalVacancy } from './services/censusRentalVacancyService.js';
import { analyzeRentalCondition } from './services/rentalConditionAnalysisService.js';
import {
  getAzureSqlConfig,
  isAzureSqlConfigured,
  pingAzureSql
} from './accounting-core/azureSqlClient.js';
import { getGmailAuthStatus, getGmailClient } from './gmail-oauth2-secure.js';
import { maintenanceApiAllowlistMiddleware } from './product/maintenanceApiAllowlist.js';
import { getServerProductMode } from './product/productMode.js';
import {
  AWAITING_OPERATOR_DISPATCH,
  describeAccessMethod,
  formatAvailabilityWindows,
} from './maintenance/requestSchema.js';
import { maintenancePhotoLimits, uploadMaintenancePhotos } from './maintenance/photoStore.js';
import {
  getPropertyServiceHistory,
  listProviders,
  updateProviderCoordinates,
  upsertProvidersFromSearch,
} from './maintenance/providerNetwork.js';
import {
  buildProviderShortlist,
  formatCallScript,
  isMaintenanceAutoCallEnabled,
} from './maintenance/providerShortlist.js';
import {
  buildChoiceQuestions,
  buildTriagePrompt,
  detectCategory,
  detectKnownFacts,
  normalizeChoiceQuestions,
} from './maintenance/triageQuestions.js';

// Gemini AI for OCR and document classification
import { GoogleGenerativeAI } from '@google/generative-ai';

// PDF generation
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Firebase Admin for Firestore access
import { initializeFirebaseAdmin, requireAuth, verifyIdToken } from './firebase-admin.js';
import { buildAssistantCanonicalContext } from './services/assistantCanonicalContextService.js';
import { executeAssistantDataLookup, getAssistantDataLookupToolDefinition } from './services/assistantDataLookupService.js';
import { computeAssistantAnalytics, getAssistantComputedAnalyticsToolDefinition } from './services/assistantComputedAnalyticsService.js';
import voiceIdentityRouter from './voice-identity.js';

// Initialize Firestore for signature storage
let signatureDb = null;
try {
  const admin = initializeFirebaseAdmin();
  signatureDb = admin.firestore();
  console.log('[Server] ✅ Firestore connected for signatures');
} catch (error) {
  console.warn('[Server] ⚠️ Firestore unavailable for signatures:', error.message);
}

// Domain + storage helpers
import { generateInitialSlots } from './appointments/slots.js';
import { newAppointmentRequest, newAttempt, AppointmentStatus } from './appointments/models.js';
import { insertAppointment, updateAppointment, listAppointments, getAppointment, insertAttempt, updateAttempt } from './appointments/storage.js';
import { generateMobileScanToken, validateMobileScanToken, MOBILE_SCAN_TOKEN_TTL_SECONDS } from './auth.js';
import { requireInternalStaff } from './middleware/internalStaff.js';
import {
  getPracticeTestPhoneSettings,
  isPracticeModeEnabled,
  resolvePracticeCallPhone,
  resolvePracticeSmsPhone,
  resolvePracticeTestPhone,
} from './utils/practiceTestPhone.js';
import {
  buildPropertyInfoForSensorAlert,
  resolveAddressFromPropertyId,
  resolveOwnerIdForSensorAlert,
} from './utils/sensorAlertOwner.js';
import {
  buildOwnerDispatchKey,
  claimOwnerDispatchPersisted,
  isOwnerDispatchClaimed,
  recordOwnerDispatchPersisted,
  tryClaimOwnerDispatch,
} from './utils/sensorAlertOwnerDispatchDedup.js';

// Gmail + email composition helpers (gracefully degrade if module missing)
let sendGmailHtml = async () => ({ ok:false, error:'gmail_not_configured' });
let composeSchedulingEmail = () => ({ subject:'Appointment Request', html:'Email module not configured.' });
(async () => {
  try {
    const gmailMod = await import('./gmail/index.js').catch(()=>import('./gmail.js').catch(()=>null));
    if (gmailMod) {
      if (gmailMod.sendGmailHtml) sendGmailHtml = gmailMod.sendGmailHtml;
      if (gmailMod.composeSchedulingEmail) composeSchedulingEmail = gmailMod.composeSchedulingEmail;
    }
  } catch {}
})();

// Token helpers (for confirmation links) – tolerate absence
let verifyToken = () => null;
let newActionToken = () => null;
(async () => {
  try {
    const tokenMod = await import('./appointments/tokens.js').catch(()=>null);
    if (tokenMod) { verifyToken = tokenMod.verifyToken || verifyToken; newActionToken = tokenMod.newActionToken || newActionToken; }
  } catch {}
})();

// ATTOM integration (dashboard + tax history + absentee owner search)
import { fetchPropertyDashboard, fetchSalesComparables, searchAbsenteeOwners, searchAbsenteeOwnersBatch, getAbsenteePropertyDetails, scanAssumableMortgages } from './attom.js';
import { fetchAttom, getAttomUsageSnapshot } from './attom-usage-limiter.js';
// Property data cache
import { getCachedPropertyData, cachePropertyData, getCachedPropertyDataById } from './db/property-cache.js';
// FRED API integration (housing market data)
import { 
  getHousingMarketData, 
  getRegionalMarketData,
  searchRegions,
  getRegionalDetail,
  getCountyFipsFromCoords,
  getCountyData,
  getTreasuryYields,
  searchSeries, 
  getSeriesObservations, 
  getSeriesInfo,
  getReleases,
  getCategory,
  getCategorySeries,
  getFedMeetingSummary,
  getFomcCalendar,
  calculateHybridAppreciation,
  getHeatMapData,
  clearHeatMapMemoryCache,
  getAdditionalMacroData,
  getMetroHistory
} from './fred.js';
// Firestore-backed FRED data cache (instant loads, refresh on demand)
import {
  getCachedFredData,
  setCachedFredData,
  invalidateFredCache,
  listFredCache,
  clearFredCache
} from './fred-cache.js';
import {
  getCachedPolygonData,
  setCachedPolygonData,
} from './polygon-cache.js';
import CBSA_CATALOG from './cbsa-catalog.js';
import { getMetroZipMarketData, getSupportedMetroZipProfilesSummary, getZipMarketData, getRentalListingComparables, getRentalListingByAddress, getZipRadiusMarkets, geocodeLocation } from './rentcast.js';
import { getCachedRentalCompData, setCachedRentalCompData } from './rental-comp-cache.js';
import { getCachedRentPotentialData, setCachedRentPotentialData } from './rent-potential-cache.js';
// Firestore-backed ATTOM property data cache (90-day TTL per ATTOM license)
import {
  getCachedAttomData,
  getCachedAttomDataById,
  cacheAttomData,
  invalidateAttomCache,
  isUsableAttomDashboardData,
  purgeExpiredAttomCache,
  getAttomCacheStats,
  listAttomCache,
  clearAllAttomCache
} from './attom-firestore-cache.js';
// Coarse building geometry (floors/units/archetype) derived from cached ATTOM data only
import { deriveBuildingGeometry } from './services/buildingGeometryDerivation.js';
import { getBuildingModel, saveBuildingModel } from './services/buildingModelStore.js';
import { getSiteModel, saveSiteModel } from './services/siteModelService.js';
// Flight tracking integration (real-time aircraft positions for noise map)
import { getNearbyAircraft } from './flight-tracking.js';
// Crime data integration (FBI UCR API with Firestore caching)
import { getCrimeDataForFips } from './crime-data.js';
// Zillow API integration (property listings via RapidAPI, replaces Snowflake)
import snowflake from './zillowApi.js';
console.log('✅ [Zillow API] Property data integration loaded');
// Polymarket integration (prediction markets - simplified, no auth needed)
import { 
  getEconomicPredictions,
  getMarketWithOdds,
  getHousingMarketPredictions
} from './polymarket-simple.js';
import {
  getPolygonBasicInfo,
  getPolygonCompanyDetails,
  getPolygonDividends,
  getPolygonFinancials,
  getPolygonHistoricalDividends,
  getPolygonHistoricalPrices,
  getPolygonQuote,
  getPolygonStockNews,
  getPolygonStockSplits,
} from './polygon-stock-data.js';

// Native Bookkeeping System (SQLite - legacy, will be deprecated)
import bookkeepingRouter from './bookkeeping.js';
console.log('✅ [Bookkeeping] Native bookkeeping system loaded');

// AI Financial Planner (Claude API)
import aiFinancialPlannerRouter from './routes/ai-financial-planner.js';
import assistantContextRouter from './routes/assistantContext.js';
import marketAnalysisRouter from './routes/marketAnalysis.js';
console.log('✅ [AI Financial Planner] Claude-powered retirement planning loaded');

// Email Service (Nodemailer with HouseYield Gmail)
let sendTenantInviteEmail = async () => ({ ok: false, error: 'email_service_not_loaded', skipped: true });
let sendDocumentSignatureEmail = async () => ({ ok: false, error: 'email_service_not_loaded', skipped: true });
let sendInterviewSchedulingEmail = async () => ({ ok: false, error: 'email_service_not_loaded', skipped: true });
let sendInterviewConfirmationEmail = async () => ({ ok: false, error: 'email_service_not_loaded', skipped: true });
let verifyEmailConfig = async () => ({ ok: false, configured: false });
let sendScreeningRequestEmail = async () => ({ ok: false, skipped: true });
try {
  const emailServiceModule = await import('./email-service.js');
  sendTenantInviteEmail = emailServiceModule.sendTenantInviteEmail;
  sendDocumentSignatureEmail = emailServiceModule.sendDocumentSignatureEmail;
  sendInterviewSchedulingEmail = emailServiceModule.sendInterviewSchedulingEmail;
  sendInterviewConfirmationEmail = emailServiceModule.sendInterviewConfirmationEmail;
  sendScreeningRequestEmail = emailServiceModule.sendScreeningRequestEmail;
  verifyEmailConfig = emailServiceModule.verifyEmailConfig;
  console.log('✅ [Email Service] Nodemailer email service loaded');
} catch (error) {
  console.warn('⚠️  [Email Service] Email service not available:', error.message);
}

// Tenant Service (Firestore-backed tenant management)
let createTenantInvite = null;
let getTenantInvite = null;
let consumeInviteAndCreateTenant = null;
let getTenantsByOwner = null;
let getTenantByFirebaseUid = null;
let updateTenantUnit = null;
try {
  const tenantServiceModule = await import('./tenant-service.js');
  createTenantInvite = tenantServiceModule.createTenantInvite;
  getTenantInvite = tenantServiceModule.getTenantInvite;
  consumeInviteAndCreateTenant = tenantServiceModule.consumeInviteAndCreateTenant;
  getTenantsByOwner = tenantServiceModule.getTenantsByOwner;
  getTenantByFirebaseUid = tenantServiceModule.getTenantByFirebaseUid;
  updateTenantUnit = tenantServiceModule.updateTenantUnit;
  console.log('✅ [Tenant Service] Firestore tenant management loaded');
} catch (error) {
  console.warn('⚠️  [Tenant Service] Tenant service not available:', error.message);
}

// Property Firestore Service (property management with Firestore)
let savePropertyToFirestore = null;
let getOwnerProperties = null;
let getPropertyById = null;
let getPropertiesWithTenants = null;
let linkTenantToProperty = null;
let clearTenantFromProperty = null;
let deletePropertyFromFirestore = null;
let updatePropertyHealthAssets = null;
try {
  const propertyFirestoreModule = await import('./property-firestore-service.js');
  savePropertyToFirestore = propertyFirestoreModule.savePropertyToFirestore;
  getOwnerProperties = propertyFirestoreModule.getOwnerProperties;
  getPropertyById = propertyFirestoreModule.getPropertyById;
  getPropertiesWithTenants = propertyFirestoreModule.getPropertiesWithTenants;
  linkTenantToProperty = propertyFirestoreModule.linkTenantToProperty;
  clearTenantFromProperty = propertyFirestoreModule.clearTenantFromProperty;
  deletePropertyFromFirestore = propertyFirestoreModule.deletePropertyFromFirestore;
  updatePropertyHealthAssets = propertyFirestoreModule.updatePropertyHealthAssets;
  console.log('✅ [Property Firestore] Property management with Firestore loaded');
} catch (error) {
  console.warn('⚠️  [Property Firestore] Property service not available:', error.message);
}

// Tenant Activity Service (messages, maintenance requests, payments)
let tenantActivityService = null;
let maintenanceOwnerSmsService = null;
try {
  tenantActivityService = await import('./tenant-activity-service.js');
  console.log('✅ [Tenant Activity] Tenant activity tracking service loaded');
} catch (error) {
  console.warn('⚠️  [Tenant Activity] Tenant activity service not available:', error.message);
}

try {
  maintenanceOwnerSmsService = await import('./services/maintenanceOwnerSmsService.js');
  if (maintenanceOwnerSmsService?.isMaintenanceOwnerSmsEnabled?.()) {
    console.log('✅ [MaintenanceOwnerSMS] Owner SMS confirmations enabled (block dispatch until YES:', maintenanceOwnerSmsService.shouldBlockDispatchUntilOwnerConfirm?.(), ', require provider YES:', maintenanceOwnerSmsService.shouldRequireProviderApprovalBeforeCall?.(), ')');
  } else {
    console.log('ℹ️  [MaintenanceOwnerSMS] Owner SMS confirmations disabled or Twilio not configured');
  }
} catch (error) {
  console.warn('⚠️  [MaintenanceOwnerSMS] Service not available:', error.message);
}

// Firestore Bookkeeping System (Firebase - production)
let bookkeepingFirestoreRouter = null;
try {
  const firestoreModule = await import('./bookkeeping-firestore.js');
  bookkeepingFirestoreRouter = firestoreModule.default;
  console.log('✅ [Bookkeeping Firestore] Firebase-backed bookkeeping system loaded');
} catch (error) {
  console.warn('⚠️  [Bookkeeping Firestore] Firebase bookkeeping not available:', error.message);
}

// Plaid Bank Integration (auto-populate bookkeeping from bank accounts)
let plaidRouter = null;
try {
  const plaidModule = await import('./plaid.js');
  plaidRouter = plaidModule.default;
  console.log('✅ [Plaid] Bank account integration loaded');
} catch (error) {
  console.warn('⚠️  [Plaid] Bank integration not available:', error.message);
}

// Stripe Connect Integration (landlord-tenant payments with bank accounts)
let stripeConnectRouter = null;
try {
  const stripeConnectModule = await import('./stripe-connect.js');
  stripeConnectRouter = stripeConnectModule.default;
  console.log('✅ [Stripe Connect] Landlord-tenant payment system loaded');
} catch (error) {
  console.warn('⚠️  [Stripe Connect] Payment system not available:', error.message);
}

// Income Verification Integration (analyze Stripe Financial Connections for tenant screening)
let incomeVerificationRouter = null;
try {
  const incomeVerificationModule = await import('./income-verification.js');
  incomeVerificationRouter = incomeVerificationModule.default;
  console.log('✅ [Income Verification] Tenant income analysis system loaded');
} catch (error) {
  console.warn('⚠️  [Income Verification] Income verification not available:', error.message);
}

// Equifax Credit Check Integration (tenant screening)
let equifaxModule = null;
try {
  equifaxModule = await import('./equifax.js');
  console.log('✅ [Equifax] Credit check integration loaded');
} catch (error) {
  console.warn('⚠️  [Equifax] Credit check integration not available:', error.message);
}

// Equifax Background Check Integration (tenant screening)
let equifaxBackgroundModule = null;
try {
  equifaxBackgroundModule = await import('./equifax-background.js');
  console.log('✅ [Equifax Background] Tenant background check integration loaded');
} catch (error) {
  console.warn('⚠️  [Equifax Background] Background check integration not available:', error.message);
}

// Room Scanner Integration (3D room scanning with Luma AI + OpenAI)
let roomScannerRouter = null;
try {
  const roomScannerModule = await import('./room-scanner.js');
  roomScannerRouter = roomScannerModule.default;
  console.log('✅ [Room Scanner] 3D room scanning with Luma AI loaded');
} catch (error) {
  console.warn('⚠️  [Room Scanner] Room scanner not available:', error.message);
}

// Image Stitching Integration (OpenCV panorama stitching for room scanner)
let imageStitchingRouter = null;
try {
  const imageStitchingModule = await import('./image-stitching.js');
  imageStitchingRouter = imageStitchingModule.default;
  console.log('✅ [Image Stitching] OpenCV panorama stitching loaded');
} catch (error) {
  console.warn('⚠️  [Image Stitching] Panorama stitching not available:', error.message);
}

// Photogrammetry Integration (3D mesh reconstruction from photos)
let photogrammetryRouter = null;
try {
  const photogrammetryModule = await import('./routes/photogrammetry.js');
  photogrammetryRouter = photogrammetryModule.default;
  console.log('✅ [Photogrammetry] 3D mesh reconstruction pipeline loaded');
} catch (error) {
  console.warn('⚠️  [Photogrammetry] Photogrammetry pipeline not available:', error.message);
}

// Room Tour Integration (video-first 3D home tours with Gaussian splats)
let roomToursRouter = null;
try {
  const roomToursModule = await import('./routes/room-tours.js');
  roomToursRouter = roomToursModule.default;
  console.log('✅ [Room Tours] Video-first 3D room tour pipeline loaded');
} catch (error) {
  console.warn('⚠️  [Room Tours] Room tour pipeline not available:', error.message);
}

// Master Reconstruction Integration (canonical mesh-first reconstruction pipeline)
let masterReconstructionRouter = null;
try {
  const masterReconstructionModule = await import('./routes/master-reconstruction.js');
  masterReconstructionRouter = masterReconstructionModule.default;
  console.log('✅ [Master Reconstruction] Canonical master_v1 reconstruction pipeline loaded');
} catch (error) {
  console.warn('⚠️  [Master Reconstruction] master_v1 pipeline not available:', error.message);
}

// AI Renovation Detection from 3D Scans
let renovationDetectionRouter = null;
try {
  const renovationDetectionModule = await import('./routes/renovation-detection.js');
  renovationDetectionRouter = renovationDetectionModule.default;
  console.log('✅ [Renovation Detection] AI-powered 3D scan renovation analysis loaded');
} catch (error) {
  console.warn('⚠️  [Renovation Detection] Renovation detection not available:', error.message);
}

// Live Renovation Scanner (Real-time AI-guided renovation assessment)
let liveRenovationRouter = null;
try {
  const liveRenovationModule = await import('./routes/live-renovation.js');
  liveRenovationRouter = liveRenovationModule.default;
  console.log('✅ [Live Renovation] Real-time AI renovation scanner loaded');
} catch (error) {
  console.warn('⚠️  [Live Renovation] Live renovation scanner not available:', error.message);
}

// Mesh Calibration (AI-powered auto-calibration for accurate measurements)
let calibrationRouter = null;
try {
  const calibrationModule = await import('./routes/calibration.js');
  calibrationRouter = calibrationModule.default;
  console.log('✅ [Calibration] AI-powered mesh calibration loaded');
} catch (error) {
  console.warn('⚠️  [Calibration] Calibration system not available:', error.message);
}

// Renovation Preview (Gemini-powered visualization)
let renovationPreviewRouter = null;
try {
  const renovationPreviewModule = await import('./routes/renovation-preview.js');
  renovationPreviewRouter = renovationPreviewModule.default;
  console.log('✅ [Renovation Preview] Gemini-powered renovation visualization loaded');
} catch (error) {
  console.warn('⚠️  [Renovation Preview] Preview system not available:', error.message);
}

// Mesh Editor (Open3D/Trimesh for furniture removal, CSG, etc.)
let meshEditorRouter = null;
try {
  const meshEditorModule = await import('./routes/mesh-editor.js');
  meshEditorRouter = meshEditorModule.default;
  console.log('✅ [Mesh Editor] Advanced mesh editing loaded');
} catch (error) {
  console.warn('⚠️  [Mesh Editor] Mesh editor not available:', error.message);
}

// AI Texture Generation (Gemini Nano Banana for 3D mesh textures)
let aiTextureRouter = null;
try {
  const aiTextureModule = await import('./routes/ai-texture-generation.js');
  aiTextureRouter = aiTextureModule.default;
  console.log('✅ [AI Texture] Gemini Nano Banana 3D texture generation loaded');
} catch (error) {
  console.warn('⚠️  [AI Texture] AI texture generation not available:', error.message);
}

// Seamless Texture Generation (Gemini Nano Banana Pro for tileable textures)
let seamlessTextureRouter = null;
try {
  const seamlessTextureModule = await import('./routes/seamless-texture.js');
  seamlessTextureRouter = seamlessTextureModule.default;
  console.log('✅ [Seamless Texture] Gemini seamless texture generation loaded');
} catch (error) {
  console.warn('⚠️  [Seamless Texture] Seamless texture generation not available:', error.message);
}

// Floor Overlay Generation (Gemini + Meshy Image-to-3D for simple floor renovation)
let floorOverlayRouter = null;
try {
  const floorOverlayModule = await import('./routes/floor-overlay.js');
  floorOverlayRouter = floorOverlayModule.default;
  console.log('✅ [Floor Overlay] Gemini + Meshy floor overlay generation loaded');
} catch (error) {
  console.warn('⚠️  [Floor Overlay] Floor overlay generation not available:', error.message);
}

// Mesh Segmentation (Trimesh + AI for selective retexturing)
let meshSegmentationRouter = null;
try {
  const meshSegmentationModule = await import('./routes/mesh-segmentation.js');
  meshSegmentationRouter = meshSegmentationModule.default;
  console.log('✅ [Mesh Segmentation] Trimesh + AI mesh segmentation loaded');
} catch (error) {
  console.warn('⚠️  [Mesh Segmentation] Mesh segmentation not available:', error.message);
}

// Mesh Preprocessing (Fix photogrammetry scans for Meshy AI)
let meshPreprocessingRouter = null;
try {
  const meshPreprocessingModule = await import('./routes/mesh-preprocessing.js');
  meshPreprocessingRouter = meshPreprocessingModule.default;
  console.log('✅ [Mesh Preprocessing] Photogrammetry scan repair (normals, decimation, holes) loaded');
} catch (error) {
  console.warn('⚠️  [Mesh Preprocessing] Mesh preprocessing not available:', error.message);
}

// Meshy AI Retexturing (AI-powered mesh retexturing for renovation visualization)
let meshyRetextureRouter = null;
try {
  const meshyRetextureModule = await import('./routes/meshy-retexture.js');
  meshyRetextureRouter = meshyRetextureModule.default;
  console.log('✅ [Meshy Retexture] AI mesh retexturing for renovation visualization loaded');
} catch (error) {
  console.warn('⚠️  [Meshy Retexture] Meshy retexturing not available:', error.message);
}

// Meshy AI Text-to-3D (Generate 3D objects from text prompts)
let meshyTextTo3DRouter = null;
try {
  const meshyTextTo3DModule = await import('./routes/meshy-text-to-3d.js');
  meshyTextTo3DRouter = meshyTextTo3DModule.default;
  console.log('✅ [Meshy Text-to-3D] AI 3D object generation loaded');
} catch (error) {
  console.warn('⚠️  [Meshy Text-to-3D] Text-to-3D not available:', error.message);
}

// Meshy AI Image-to-3D (Generate 3D objects from viewport captures)
let meshyImageTo3DRouter = null;
try {
  const meshyImageTo3DModule = await import('./routes/meshy-image-to-3d.js');
  meshyImageTo3DRouter = meshyImageTo3DModule.default;
  console.log('✅ [Meshy Image-to-3D] Viewport capture to 3D object generation loaded');
} catch (error) {
  console.warn('⚠️  [Meshy Image-to-3D] Image-to-3D not available:', error.message);
}

// Meshy AI Text-to-Image (Generate concept images with Nano Banana Pro)
let meshyTextToImageRouter = null;
try {
  const meshyTextToImageModule = await import('./routes/meshy-text-to-image.js');
  meshyTextToImageRouter = meshyTextToImageModule.default;
  console.log('✅ [Meshy Text-to-Image] Nano Banana Pro concept generation loaded');
} catch (error) {
  console.warn('⚠️  [Meshy Text-to-Image] Text-to-Image not available:', error.message);
}

// Renovation Planner (Room context + AI concept + 3D with exact dimensions)
let renovationPlannerRouter = null;
try {
  const renovationPlannerModule = await import('./routes/renovation-planner.js');
  renovationPlannerRouter = renovationPlannerModule.default;
  console.log('✅ [Renovation Planner] Professional renovation planning with dimensions loaded');
} catch (error) {
  console.warn('⚠️  [Renovation Planner] Renovation planner not available:', error.message);
}

// DUNS Business Verification (D&B Direct+ API)
let dunsVerificationRouter = null;
try {
  const dunsModule = await import('./routes/duns-verification.js');
  dunsVerificationRouter = dunsModule.default;
  console.log('✅ [DUNS] D&B Direct+ business verification loaded');
} catch (error) {
  console.warn('⚠️  [DUNS] D&B verification not available:', error.message);
}

// AI Bid Analysis (Google Custom Search + GPT-4o)
let bidAnalysisRouter = null;
try {
  const bidAnalysisModule = await import('./routes/bid-analysis.js');
  bidAnalysisRouter = bidAnalysisModule.default;
  console.log('✅ [BidAnalysis] AI contractor bid scoring loaded');
} catch (error) {
  console.warn('⚠️  [BidAnalysis] Bid analysis not available:', error.message);
}

// Listing AI Description Generator (GPT-4o)
let listingAIRouter = null;
try {
  const listingAIModule = await import('./routes/listing-ai.js');
  listingAIRouter = listingAIModule.default;
  console.log('✅ [ListingAI] GPT-4o listing description generator loaded');
} catch (error) {
  console.warn('⚠️  [ListingAI] Listing AI not available:', error.message);
}

// QuickBooks integration (optional - for users who already have QuickBooks)
let quickbooksRouter = null;
let quickbooksSyncRouter = null;
try {
  const qbModule = await import('./quickbooks.js');
  quickbooksRouter = qbModule.default;
  console.log('✅ [QuickBooks] Optional QuickBooks sync available');
  
  // Load sync module for monthly journal entry push
  try {
    const qbSyncModule = await import('./quickbooks-sync.js');
    quickbooksSyncRouter = qbSyncModule.default;
    console.log('✅ [QuickBooks Sync] Monthly summary sync endpoints loaded');
  } catch (syncError) {
    console.log('ℹ️  [QuickBooks Sync] Advanced sync features not available');
  }
} catch (error) {
  console.log('ℹ️  [QuickBooks] QuickBooks sync not configured (native bookkeeping still works)');
}

// Tenant email monitoring (optional - gracefully degrades if not configured)
let emailMonitorModule = null;
try {
  emailMonitorModule = await import('./tenant-email-monitor.js');
  if (emailMonitorModule) {
    console.log('✅ [Email Monitor] Tenant email monitoring module loaded');
  }
} catch (error) {
  console.warn('⚠️  [Email Monitor] Email monitoring module not available:', error.message);
}

// AI-Powered Service Provider Selector (Google Places + Review Analysis)
let aiProviderSelector = null;
try {
  aiProviderSelector = await import('./ai-provider-selector.js');
  if (aiProviderSelector) {
    console.log('✅ [AI Provider Selector] Smart repair service selection with review analysis loaded');
  }
} catch (error) {
  console.warn('⚠️  [AI Provider Selector] AI provider selection not available:', error.message);
}

// Voice call integration (optional - gracefully degrades if not configured)
let voiceModule = null;
try {
  voiceModule = await import('./voice-call.js');
  if (voiceModule) {
    console.log('✅ [Voice] Voice call module loaded');
  }
} catch (error) {
  console.warn('⚠️  [Voice] Voice call module not available:', error.message);
}

let maintenanceCallScheduler = null;
try {
  maintenanceCallScheduler = await import('./maintenance-call-scheduler.js');
  if (maintenanceCallScheduler && voiceModule) {
    maintenanceCallScheduler.startMaintenanceCallScheduler(voiceModule);
    console.log('✅ [MaintenanceCallScheduler] Deferred maintenance call scheduler loaded');
  }
} catch (error) {
  console.warn('⚠️  [MaintenanceCallScheduler] Scheduler not available:', error.message);
}

// GROQ Voice call integration (ultra-low latency LPU-powered voice)
let groqVoiceModule = null;
try {
  groqVoiceModule = await import('./groq-voice-call.js');
  if (groqVoiceModule) {
    console.log('✅ [GROQ-Voice] GROQ voice call module loaded (LPU-powered)');
  }
} catch (error) {
  console.warn('⚠️  [GROQ-Voice] GROQ voice call module not available:', error.message);
}

// ElevenLabs + GROQ Hybrid Voice (Best quality V3 Alpha voice + GROQ LPU speed)
let elevenLabsGroqModule = null;
try {
  elevenLabsGroqModule = await import('./elevenlabs-groq-voice.js');
  if (elevenLabsGroqModule) {
    console.log('✅ [ElevenLabs-GROQ] ElevenLabs V3 Alpha + GROQ LPU hybrid voice module loaded');
  }
} catch (error) {
  console.warn('⚠️  [ElevenLabs-GROQ] ElevenLabs+GROQ hybrid module not available:', error.message);
}

// New Twilio Phone Call System (fresh GROQ implementation)
let phoneModule = null;
try {
  phoneModule = await import('./twilio-phone-call.js');
  if (phoneModule) {
    console.log('✅ [Phone] Twilio phone call module loaded');
  }
} catch (error) {
  console.warn('⚠️  [Phone] Twilio phone call module not available:', error.message);
}

// GROQ + ElevenLabs Phone Call System (Best of both worlds for phone calls)
let groqElevenLabsPhoneModule = null;
try {
  groqElevenLabsPhoneModule = await import('./groq-elevenlabs-phone.js');
  if (groqElevenLabsPhoneModule) {
    console.log('✅ [GROQ-ElevenLabs-Phone] GROQ LPU + ElevenLabs V3 phone module loaded');
  }
} catch (error) {
  console.warn('⚠️  [GROQ-ElevenLabs-Phone] Module not available:', error.message);
}

// Tenant Interview System (AI phone interviews for tenant screening)
let tenantInterviewModule = null;
try {
  tenantInterviewModule = await import('./tenant-interview.js');
  if (tenantInterviewModule) {
    console.log('✅ [Interview] Tenant interview module loaded');
  }
} catch (error) {
  console.warn('⚠️  [Interview] Tenant interview module not available:', error.message);
}

// Security middleware for voice calls
let authModule = null;
try {
  authModule = await import('./auth.js');
  console.log('✅ [Auth] Security middleware loaded');
} catch (error) {
  console.warn('⚠️  [Auth] Security middleware not available:', error.message);
}

// Basic config
const PORT = parseInt(process.env.PORT || '3001', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';
const GEMINI_API_KEY = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_CX || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

// Validate critical environment variables
if (!process.env.APPOINTMENT_TOKEN_SECRET && process.env.NODE_ENV === 'production') {
  console.error('❌ CRITICAL: APPOINTMENT_TOKEN_SECRET must be set in production!');
  process.exit(1);
}

console.log('[config] Security check:', {
  NODE_ENV: process.env.NODE_ENV || 'development',
  TOKEN_SECRET: process.env.APPOINTMENT_TOKEN_SECRET ? '✓ Custom' : '⚠️  Ephemeral dev secret',
  OPENAI: OPENAI_API_KEY ? '✓' : '❌',
  GEMINI: GEMINI_API_KEY ? '✓' : '❌',
  GOOGLE: GOOGLE_API_KEY ? '✓' : '❌',
  ATTOM: process.env.ATTOM_API_KEY ? '✓' : '❌'
});

// Express app
const app = express();
app.set('trust proxy', 1);

// Lightweight in-memory monitor for the renovation analysis pipeline.
// Useful for live status checks while users run AI image analysis.
const renovationAnalysisMonitor = {
  running: false,
  stage: 'idle',
  startedAt: null,
  finishedAt: null,
  address: null,
  imageCount: 0,
  analyzedCount: 0,
  suggestionCount: 0,
  positiveRoiCount: 0,
  fallbackSuggestionsUsed: false,
  marketDataSource: null,
  marketDataDiagnostics: null,
  lastError: null,
  updatedAt: new Date().toISOString(),
};

function updateRenovationAnalysisMonitor(patch = {}) {
  Object.assign(renovationAnalysisMonitor, patch, { updatedAt: new Date().toISOString() });
}

// Security: Helmet for security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: [
        "'self'", 
        "'unsafe-inline'", 
        "'unsafe-eval'",
        "blob:",
        "https://apis.google.com", 
        "https://accounts.google.com",
        "https://cdn.plaid.com",
        "https://js.stripe.com"
      ],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: [
        "'self'",
        "wss:",
        "https://api.openai.com",
        "https://www.googleapis.com",
        "https://gmail.googleapis.com",
        "https://places.googleapis.com",
        "https://maps.googleapis.com",
        "https://api.fred.louisfed.org",
        "https://api.gateway.attomdata.com",
        "https://customsearch.googleapis.com",
        "https://sandbox.plaid.com",
        "https://production.plaid.com",
        "https://cdn.plaid.com",
        "https://api.stripe.com"
      ],
      frameSrc: [
        "'self'", 
        "https://apis.google.com", 
        "https://accounts.google.com",
        "https://cdn.plaid.com",
        "https://js.stripe.com",
        "https://hooks.stripe.com"
      ],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// Security: CORS with environment-based whitelist
const defaultBrowserOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  // Maintenance Orchestration Vite app
  'http://localhost:5175',
  'http://127.0.0.1:5175',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
];

const configuredBrowserOrigins = [
  ...(process.env.ALLOWED_ORIGINS || '').split(','),
  process.env.FRONTEND_URL || '',
  process.env.VITE_PUSH_SERVER_URL || '',
  process.env.NGROK_URL || '',
  process.env.VITE_NGROK_URL || '',
].map((origin) => origin.trim()).filter(Boolean);

const allowedOrigins = Array.from(new Set([
  ...defaultBrowserOrigins,
  ...configuredBrowserOrigins,
]));

// Log allowed origins in dev
if (process.env.NODE_ENV !== 'production') {
  console.log('[CORS] Allowed origins:', allowedOrigins);
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    // Allow any trycloudflare.com subdomain for tunnel testing
    if (origin.includes('trycloudflare.com')) {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Prevent caching for all API responses (critical for mobile scanner updates)
app.use((req, res, next) => {
  // Set multiple cache prevention headers for maximum compatibility
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  
  // Add ETag support but with validation required
  if (!res.getHeader('ETag')) {
    res.setHeader('ETag', `W/"${Date.now()}-${Math.random()}"`);
  }
  
  next();
});

const LOOPBACK_RATE_LIMIT_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function normalizeRateLimitHost(value) {
  const rawValue = String(value || '')
    .trim()
    .toLowerCase()
    .split(',')[0]
    .trim();

  const normalizedValue = rawValue.replace(/^::ffff:/, '');

  if (!normalizedValue || normalizedValue === '::1') {
    return normalizedValue;
  }

  if (normalizedValue.startsWith('[')) {
    return normalizedValue.slice(1).split(']')[0];
  }

  return (normalizedValue.match(/:/g) || []).length > 1
    ? normalizedValue
    : normalizedValue.split(':')[0];
}

function isLocalLoopbackRequest(req) {
  const candidates = [
    req.ip,
    req.hostname,
    req.headers.host,
    req.headers['x-forwarded-for'],
    req.socket?.remoteAddress,
  ].map(normalizeRateLimitHost);

  return candidates.some((candidate) => LOOPBACK_RATE_LIMIT_HOSTS.has(candidate));
}

function getOwnerPropertiesRateLimitKey(req) {
  const ownerId = [
    req.query?.ownerId,
    req.body?.ownerId,
  ].find((value) => typeof value === 'string' && value.trim().length > 0);

  if (ownerId) {
    return `owner-properties:${ownerId.trim()}`;
  }

  return `ip:${ipKeyGenerator(req.ip)}`;
}

// Security: General rate limiter for all API endpoints
const generalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Increased from 100 to handle room scanning traffic
  message: { ok: false, error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const rateLimitPath = req.baseUrl === '/api' ? req.path : req.originalUrl;

    // Mounted /api middleware receives relative req.path values like /room-scanner/scans.
    return (process.env.NODE_ENV !== 'production' && isLocalLoopbackRequest(req)) ||
           rateLimitPath === '/flood/pooling-zones' ||
           rateLimitPath === '/owner-properties' ||
           rateLimitPath.startsWith('/owner-properties/') ||
           rateLimitPath.startsWith('/room-scanner') ||
           // Device webhooks + live probes must never 429 or history/presence stops.
           rateLimitPath.startsWith('/shelly/webhook') ||
           rateLimitPath === '/webhook' ||
           rateLimitPath.startsWith('/shelly/');
  },
});

const ownerPropertiesRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { ok: false, error: 'Too many property requests for this owner, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getOwnerPropertiesRateLimitKey,
  skip: (req) => process.env.NODE_ENV !== 'production' && isLocalLoopbackRequest(req),
});

// Security: Strict rate limiter for sensitive operations
const strictRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: { ok: false, error: 'Too many submission attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Security: CRITICAL - Voice call rate limiter (very expensive operation)
const voiceCallRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes (reduced for dev)
  max: 50, // 50 calls per 15 minutes for development/testing
  message: { ok: false, error: 'Too many voice calls from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false, // Count even successful requests
});

// Security: Document signing rate limiter - prevents brute-force token guessing
const signingRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // limit each IP to 15 signing attempts per 15 minutes
  message: { ok: false, error: 'Too many signing attempts from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Analysis endpoints rate limiter (for endpoints that make many downstream API calls)
const analysisRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 analysis requests per 15 minutes
  message: { ok: false, error: 'Too many analysis requests. Please try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/*
 * Flood twin endpoints are a different budget.
 *
 * The generic analysis limiter is 20 / 15 min because those routes fan out to
 * paid upstreams. Flood depth and the forecast timeline hit free terrain tiles
 * and Open-Meteo, and the twin alone needs several of them per property (wide
 * grid, tight lot grid, then a forecast when you hit Play). Twenty shared
 * across the whole analysis surface meant a few property toggles silently
 * emptied the map for the next quarter hour — and the UI had no way to say so.
 */
const floodAnalysisRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { ok: false, error: 'Too many flood analysis requests. Please try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const clampFloodQuery = (v, lo, hi, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

const floodCoords = (req) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  return { lat, lng };
};

/*
 * Parsed once and shared between the cache-peek middleware and the handler.
 * If the two ever built their arguments differently the peek would quietly
 * miss on every request and the optimisation would vanish without a symptom.
 */
const floodDepthArgs = (req) => {
  const coords = floodCoords(req);
  if (!coords) return null;
  return {
    ...coords,
    radiusMetres: clampFloodQuery(req.query.radiusMeters, 200, 3000, 900),
    samples: Math.round(clampFloodQuery(req.query.samples, 32, 160, 120)),
    livingSqft: clampFloodQuery(req.query.livingSqft, 100, 40000, undefined),
    costPerSqft: clampFloodQuery(req.query.costPerSqft, 50, 1200, undefined),
    finishedFloorAboveGradeFt: clampFloodQuery(req.query.floorHeightFt, 0, 12, undefined),
  };
};

const floodTimelineArgs = (req) => {
  const coords = floodCoords(req);
  if (!coords) return null;
  const surgeCategory = clampFloodQuery(req.query.surgeCategory, 1, 5, null);
  return {
    ...coords,
    hours: Math.round(clampFloodQuery(req.query.hours, 6, 48, 24)),
    radiusMetres: clampFloodQuery(req.query.radiusMeters, 200, 3000, 900),
    samples: Math.round(clampFloodQuery(req.query.samples, 32, 128, 96)),
    livingSqft: clampFloodQuery(req.query.livingSqft, 100, 40000, undefined),
    costPerSqft: clampFloodQuery(req.query.costPerSqft, 50, 1200, undefined),
    finishedFloorAboveGradeFt: clampFloodQuery(req.query.floorHeightFt, 0, 12, undefined),
    surgeCategory: surgeCategory != null ? Math.round(surgeCategory) : null,
  };
};

/**
 * Answer from the model's cache before the rate limiter ever sees the request.
 *
 * The flood budget exists to protect the upstream terrain-tile and Open-Meteo
 * calls, and a cache hit makes none of them. Charging one is the twin
 * throttling itself against work it already did: three layers, a lot grid and
 * a wide grid, a forecast, a React StrictMode double-render and a couple of
 * property switches all replay the same handful of keys, and the budget can be
 * gone in a minute of clicking. Serving hits ahead of the limiter keeps the
 * quota pointed at requests that actually cost something.
 *
 * A failure to peek is never fatal — it falls through to the normal path.
 */
const serveCachedFlood = (parseArgs, loadPeek, cacheControl) => async (req, res, next) => {
  let cached = null;
  try {
    const args = parseArgs(req);
    if (!args) return next();
    cached = (await loadPeek())(args);
  } catch (e) {
    console.warn('[Flood cache] peek failed, falling through:', e.message);
    return next();
  }
  if (!cached) return next();
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Flood-Cache', 'hit');
  return res.json(cached);
};

const FLOOD_DEPTH_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400';
const FLOOD_TIMELINE_CACHE_CONTROL = 'public, max-age=600';

// Maintenance Orchestration product mode: narrow public API surface when enabled.
// Default PRODUCT_MODE=full leaves all routes available (local `npm run dev` unchanged).
app.use(maintenanceApiAllowlistMiddleware);
console.log(`📦 [ProductMode] ${getServerProductMode()}`);

// Apply general rate limiting to API routes
app.use('/api/', generalRateLimiter);
app.use('/service-search', generalRateLimiter);

// Stripe subscription webhook needs the raw body for signature verification.
// Register raw parsing for this path BEFORE the global JSON parser so body-parser
// flags the request as already-parsed and skips it.
app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }));

// Request parsing with size limits (increased for image uploads - 25 images can be ~100MB)
app.use(bodyParser.json({ limit: '150mb' })); // Increased for up to 25 base64 images
app.use(bodyParser.urlencoded({ extended: true, limit: '150mb' }));
app.use(express.urlencoded({ extended:true, limit: '150mb' }));
app.use('/api/owner-properties', ownerPropertiesRateLimiter);
app.use(express.static(path.join(process.cwd(), 'public')));

// Simple health endpoint
app.get('/healthz', (req,res)=>res.json({ ok:true, status:'healthy', ts:Date.now() }));

app.get('/auth/gmail/status', async (req, res) => {
  try {
    const status = await getGmailAuthStatus();
    return res.json({
      ok: status.ready,
      ...status,
      senderEmail: process.env.HOUSEYIELD_EMAIL_ADDRESS || 'admin@myhouseyield.com',
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/auth/gmail', async (req, res) => {
  try {
    const status = await getGmailAuthStatus();

    if (!status.hasCredentials) {
      return res.status(404).type('text/plain').send(
        'Gmail OAuth credentials not found. Save the Desktop app JSON as server/.gmail-credentials.json and retry.'
      );
    }

    if (status.ready) {
      return res.type('text/plain').send('Gmail OAuth is already authorized for HouseYield. You can close this tab.');
    }

    if (!status.authUrl) {
      return res.status(500).type('text/plain').send(
        'Gmail OAuth client could not initialize. Check server/.gmail-credentials.json and GMAIL_OAUTH_REDIRECT_URI.'
      );
    }

    return res.redirect(status.authUrl);
  } catch (error) {
    return res.status(500).type('text/plain').send(`Gmail authorization setup failed: ${error.message}`);
  }
});

app.get('/auth/gmail/callback', async (req, res) => {
  const { code, error } = req.query;

  if (typeof error === 'string' && error) {
    return res.status(400).type('text/plain').send(`Gmail authorization was denied: ${error}`);
  }

  if (typeof code !== 'string' || !code) {
    return res.status(400).type('text/plain').send('Missing Gmail authorization code.');
  }

  try {
    const client = await getGmailClient();
    await client.authorize(code);
    return res.type('text/html').send(`
      <html>
        <body style="font-family: sans-serif; padding: 24px; line-height: 1.5;">
          <h1>Gmail Authorization Complete</h1>
          <p>HouseYield can now send mail as ${process.env.HOUSEYIELD_EMAIL_ADDRESS || 'admin@myhouseyield.com'}.</p>
          <p>You can close this tab and retry the email verification flow.</p>
        </body>
      </html>
    `);
  } catch (authorizeError) {
    return res.status(500).type('text/plain').send(`Gmail authorization failed: ${authorizeError.message}`);
  }
});

app.get('/api/accounting-core/health', async (req, res) => {
  const configured = isAzureSqlConfigured();
  const config = getAzureSqlConfig();

  if (!configured) {
    return res.json({
      ok: true,
      status: 'not_configured',
      configured: false,
      connected: false,
      server: config.server || null,
      database: config.database || null
    });
  }

  try {
    const ping = await pingAzureSql();
    res.json({
      ok: true,
      status: 'healthy',
      configured: true,
      connected: true,
      server: config.server,
      database: ping?.databaseName || config.database,
      serverTimeUtc: ping?.serverTimeUtc || null
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      status: 'unreachable',
      configured: true,
      connected: false,
      server: config.server,
      database: config.database,
      error: error.message
    });
  }
});

// Test endpoint for hybrid appreciation calculation (ATTOM ZIP → FRED Metro fallback)
app.get('/api/test/appreciation', async (req, res) => {
  try {
    const { state, zipCode, startDate, endDate } = req.query;
    
    if (!state || !startDate || !endDate) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Required params: state, startDate, endDate. Optional: zipCode',
        example: '/api/test/appreciation?state=OR&zipCode=97062&startDate=2024-04-01&endDate=2024-10-01'
      });
    }
    
    const result = await calculateHybridAppreciation({
      state,
      zipCode: zipCode || null,
      startDate: new Date(startDate),
      endDate: new Date(endDate)
    });
    
    res.json({ 
      ok: true, 
      appreciation: result,
      summary: {
        percent: result.appreciationPercent?.toFixed(2) + '%',
        annualized: result.annualizedRate?.toFixed(2) + '% per year',
        source: result.dataSource,
        granularity: result.granularity,
        confidence: (result.confidence * 100).toFixed(0) + '%'
      }
    });
  } catch (error) {
    console.error('[Test Appreciation] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Root route - redirect to main app or show server status
app.get('/', (req, res) => {
  // Check if this might be a redirect from OAuth
  if (req.query.code || req.query.state) {
    // Redirect to QuickBooks callback if OAuth params present
    return res.redirect(`/api/quickbooks/callback${req.url.substring(1)}`);
  }
  
  // Otherwise show a simple server status page
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Property Management API Server</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 100px auto; padding: 20px; text-align: center; background: #f5f5f5; }
          .status { color: #10b981; font-size: 48px; margin-bottom: 20px; }
          h1 { color: #1f2937; margin-bottom: 10px; }
          p { color: #6b7280; margin-bottom: 30px; }
          .button { display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: 500; }
          .button:hover { background: #1d4ed8; }
          .info { background: white; border-radius: 12px; padding: 20px; margin-top: 30px; text-align: left; }
          .info h3 { color: #374151; margin-bottom: 10px; }
          .info ul { color: #6b7280; padding-left: 20px; }
        </style>
      </head>
      <body>
        <div class="status">✅</div>
        <h1>API Server Running</h1>
        <p>The property management backend server is online and healthy.</p>
        <a href="http://localhost:5173" class="button">Go to Application</a>
        <div class="info">
          <h3>Available Services</h3>
          <ul>
            <li>Bookkeeping & Accounting API</li>
            <li>QuickBooks Integration</li>
            <li>Property Data Services</li>
            <li>Tenant Screening</li>
            <li>AI Analysis Tools</li>
          </ul>
        </div>
      </body>
    </html>
  `);
});

// ===== AUTHENTICATION ENDPOINTS =====

// Mock user database (replace with real database in production)
const mockUsers = {
  owners: [
    {
      id: 'owner1',
      email: 'owner@demo.com',
      password: 'demo123', // In production, use bcrypt to hash passwords
      name: 'John Property Owner',
      role: 'owner',
      properties: ['123 Main St', '456 Oak Ave']
    }
  ],
  tenants: [
    {
      id: 'tenant1',
      email: 'tenant@demo.com',
      password: 'demo123', // In production, use bcrypt to hash passwords
      name: 'Jane Tenant',
      role: 'tenant',
      propertyAddress: '123 Main St, Apt 2B',
      unit: 'Apt 2B',
      landlordAccountId: 'acct_demo123' // Stripe Connect account ID
    }
  ]
};

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({
        ok: false,
        error: 'Email, password, and role are required'
      });
    }

    // Find user in mock database
    const userList = role === 'owner' ? mockUsers.owners : mockUsers.tenants;
    const user = userList.find(u => u.email.toLowerCase() === email.toLowerCase());

    if (!user || user.password !== password) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid email or password'
      });
    }

    // In production, generate a JWT token here
    // For demo purposes, return user data directly
    const userData = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      ...(role === 'tenant' ? {
        propertyAddress: user.propertyAddress,
        unit: user.unit,
        landlordAccountId: user.landlordAccountId
      } : {
        properties: user.properties
      })
    };

    console.log('[AUTH] Login successful:', email, 'as', role);

    res.json({
      ok: true,
      user: userData,
      message: 'Login successful'
    });
  } catch (error) {
    console.error('[AUTH] Login error:', error);
    res.status(500).json({
      ok: false,
      error: 'Authentication failed'
    });
  }
});

// POST /api/auth/mobile-scan-token
// Generate a temporary token for QR code mobile scanning
app.post('/api/auth/mobile-scan-token', async (req, res) => {
  try {
    const { userId, userEmail, userName, userRole } = req.body;

    if (!userId || !userEmail || !userName || !userRole) {
      return res.status(400).json({
        ok: false,
        error: 'User details are required'
      });
    }

    const token = generateMobileScanToken(userId, userEmail, userName, userRole);

    console.log('[AUTH] Mobile scan token generated for:', userEmail);

    res.json({
      ok: true,
      token,
      scannerBaseUrl: process.env.SCANNER_PUBLIC_URL || null,
      tunnelUrl: process.env.CLOUDFLARE_TUNNEL_URL || process.env.VITE_NGROK_URL || null,
      expiresIn: MOBILE_SCAN_TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    console.error('[AUTH] Mobile token generation error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to generate mobile scan token'
    });
  }
});

// POST /api/auth/validate-mobile-token
// Validate a mobile scan token and return user data
app.post('/api/auth/validate-mobile-token', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: 'Token is required'
      });
    }

    const userData = validateMobileScanToken(token);

    if (!userData) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid or expired token'
      });
    }

    console.log('[AUTH] Mobile scan token validated for:', userData.email);

    res.json({
      ok: true,
      user: userData
    });
  } catch (error) {
    console.error('[AUTH] Mobile token validation error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to validate token'
    });
  }
});

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    console.log('[AUTH] Registration request received:', req.body);
    
    const { name, email, password, role, phone, company, propertyCode } = req.body;

    if (!name || !email || !password || !role) {
      console.log('[AUTH] Missing required fields');
      return res.status(400).json({
        ok: false,
        error: 'Name, email, password, and role are required'
      });
    }

    if (password.length < 6) {
      console.log('[AUTH] Password too short');
      return res.status(400).json({
        ok: false,
        error: 'Password must be at least 6 characters'
      });
    }

    // Check if user already exists
    const userList = role === 'owner' ? mockUsers.owners : mockUsers.tenants;
    const existingUser = userList.find(u => u.email.toLowerCase() === email.toLowerCase());

    if (existingUser) {
      console.log('[AUTH] User already exists:', email);
      return res.status(409).json({
        ok: false,
        error: 'An account with this email already exists'
      });
    }

    // For tenants, verify property code (in production, this would check against real property codes)
    if (role === 'tenant' && !propertyCode) {
      console.log('[AUTH] Missing property code for tenant');
      return res.status(400).json({
        ok: false,
        error: 'Property code is required for tenant registration'
      });
    }

    // Create new user
    const newUser = {
      id: `${role}_${Date.now()}`,
      email: email.toLowerCase(),
      password, // In production, hash this with bcrypt
      name,
      role,
      ...(role === 'owner' ? {
        phone: phone || '',
        company: company || '',
        properties: []
      } : {
        phone: phone || '',
        propertyAddress: 'Pending Assignment', // Would be set based on propertyCode
        unit: 'TBD',
        landlordAccountId: null
      })
    };

    // Add to mock database
    userList.push(newUser);

    console.log('[AUTH] New user registered:', email, 'as', role);

    return res.status(200).json({
      ok: true,
      message: 'Account created successfully',
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        role: newUser.role
      }
    });
  } catch (error) {
    console.error('[AUTH] Registration error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Registration failed'
    });
  }
});

function parseModelJsonResponse(responseText) {
  const trimmed = (responseText || '').trim();
  if (!trimmed) {
    throw new Error('Empty AI response');
  }

  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)\s*```/) || trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (fencedMatch?.[1]) {
    return JSON.parse(fencedMatch[1].trim());
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch?.[0]) {
      return JSON.parse(objectMatch[0]);
    }
    throw new Error('Failed to parse AI JSON response');
  }
}

/**
 * Deterministic intake response used when Gemini is unreachable or returns junk.
 * It has to reflect what the submitter already said, otherwise the assistant
 * looks like it ignored them (asking "which room?" right after "kitchen sink").
 */
function buildMaintenanceTriageFallback(message, messages = [], currentDraft = {}, answeredQuestionIds = []) {
  const userText = [
    ...messages.filter((entry) => entry?.role !== 'assistant').map((entry) => entry?.content || ''),
    message || '',
    currentDraft?.description || '',
    currentDraft?.summary || ''
  ].join(' ').trim();

  const combinedText = userText.toLowerCase();
  const detected = detectCategory(combinedText);
  const category = detected !== 'Other' ? detected : (currentDraft?.category || 'Other');
  const facts = detectKnownFacts(combinedText);

  const emergency911 = /break-?in|intruder|fire|smoke everywhere|gun|violence|explosion/.test(combinedText);
  const urgentIssue = emergency911
    || facts.severity === 'severe'
    || /flood|overflow|sparking|gas smell|no heat|no ac|locked out|won't lock/.test(combinedText);

  if (emergency911) {
    return {
      reply: 'This sounds like an immediate emergency. Please call 911 right now if anyone is in danger, then come back here when it is safe.',
      questions: [
        {
          id: 'safety_check',
          question: 'Is everyone safe right now?',
          allowMultiple: false,
          options: [
            { id: 'safety_check_0', label: 'Everyone is safe', detail: '' },
            { id: 'safety_check_1', label: 'Someone needs help', detail: '' },
            { id: 'safety_check_2', label: '911 is already on the way', detail: '' },
          ],
        },
      ],
      triage: {
        category,
        priority: 'urgent',
        location: facts.location || currentDraft?.location || '',
        summary: userText || message || '',
        ownerSummary: userText || message || '',
        serviceTypeHint: category.toLowerCase(),
        readyToSubmit: false,
        emergencyLevel: 'call_911',
        emergencyGuidance: 'Call 911 immediately if there is danger to people or property. Do not wait for a contractor.',
        suggestedActions: ['Call 911 now', 'Move to a safe location', 'Come back here once it is safe'],
      },
    };
  }

  const questions = buildChoiceQuestions({ category, text: combinedText, answeredIds: answeredQuestionIds });
  const location = facts.location || currentDraft?.location || '';

  const acknowledgement = location
    ? `Got it — ${location.toLowerCase()}, ${category.toLowerCase()} issue.`
    : 'Got it.';
  const reply = questions.length
    ? `${acknowledgement} A couple of quick details and I can get this dispatched.`
    : `${acknowledgement} I have what I need to route this.`;

  return {
    reply,
    questions,
    triage: {
      category,
      priority: urgentIssue ? 'urgent' : (currentDraft?.priority || 'normal'),
      location,
      summary: userText || message || '',
      ownerSummary: userText || message || '',
      serviceTypeHint: category.toLowerCase(),
      readyToSubmit: questions.length === 0 && Boolean(location),
      emergencyLevel: urgentIssue ? 'urgent' : 'none',
      emergencyGuidance: '',
      suggestedActions: [],
    },
  };
}

function detectMaintenanceCategoryFromText(text = '') {
  const normalized = String(text || '').toLowerCase();
  if (/sink|toilet|faucet|pipe|drain|water heater|leak|flood|overflow/.test(normalized)) return 'Plumbing';
  if (/outlet|breaker|electrical|light|power|spark|burning wire/.test(normalized)) return 'Electrical';
  if (/heat|ac\b|air conditioning|furnace|thermostat|vent/.test(normalized)) return 'HVAC';
  if (/washer|dryer|dishwasher|refrigerator|fridge|oven|stove|microwave|appliance/.test(normalized)) return 'Appliances';
  if (/lock|door|window|break-?in|security/.test(normalized)) return 'Lock/Security';
  if (/bug|roach|rodent|mice|rat|termite|pest/.test(normalized)) return 'Pest Control';
  if (/ceiling|wall|floor|roof|foundation|window frame|drywall/.test(normalized)) return 'Structural';
  return 'Other';
}

function normalizeMaintenancePriority(value = 'normal') {
  return value === 'low' || value === 'urgent' ? value : 'normal';
}

function sanitizeImageDataUrl(imageDataUrl = '') {
  if (typeof imageDataUrl !== 'string') return '';
  const trimmed = imageDataUrl.trim();
  if (!trimmed.startsWith('data:image/')) return '';
  return trimmed;
}

function buildMaintenanceRealtimeInstructions({ tenantName, propertyAddress, unit, issueSummary } = {}) {
  const locationLine = [propertyAddress, unit].filter(Boolean).join(' ');
  return `You are HouseYield's live maintenance assistant for tenants.

ROLE:
- You are on a live voice support session with a tenant who may also receive separate camera-based vision updates.
- Keep the conversation natural, calm, and efficient.
- Ask one short question at a time when you still need critical information.

SAFETY RULES:
- If there is immediate danger to people, tell the tenant to call 911.
- For urgent but non-911 hazards like active leaking, sparking, flooding, or gas smell, focus on safe damage-control steps first.
- Never tell the tenant to do unsafe electrical, gas, or mechanical work.

MAINTENANCE RULES:
- Help the tenant troubleshoot only simple, safe steps such as checking a breaker, confirming a door latch, locating a shutoff, or trying a documented appliance reset.
- If the problem needs a professional, say so clearly and help prepare a maintenance request.
- When you receive a message that starts with VISION UPDATE, treat it as the latest camera analysis.
- Do not claim you can directly see the camera unless a VISION UPDATE is provided.

OUTPUT STYLE:
- Keep replies to 2-4 short sentences.
- Be practical, specific, and non-repetitive.
- If a maintenance request is warranted, say exactly why.

SESSION CONTEXT:
- Tenant name: ${tenantName || 'Unknown tenant'}
- Property: ${locationLine || 'Unknown property'}
- Current issue summary: ${issueSummary || 'Not provided yet'}`;
}

async function runGoogleCustomSearch(query, limit = 5) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_CX) {
    return { ok: false, error: 'Google Search API not configured', results: [] };
  }

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', GOOGLE_API_KEY);
  url.searchParams.set('cx', GOOGLE_CSE_CX);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(Math.max(limit, 1), 10)));

  const response = await fetch(url.toString());
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Search API error: ${response.status} ${errorText.slice(0, 180)}`);
  }

  const data = await response.json();
  const results = Array.isArray(data.items)
    ? data.items.slice(0, limit).map((item) => ({
        title: item.title || 'Untitled result',
        link: item.link || '',
        snippet: item.snippet || '',
        displayLink: item.displayLink || ''
      }))
    : [];

  return { ok: true, results };
}

function buildApplianceTroubleshootingQuery(appliance = {}) {
  const parts = [appliance.brand, appliance.model, appliance.type, 'troubleshooting manual reset leaking not working'];
  return parts.filter(Boolean).join(' ').trim();
}

async function summarizeApplianceTroubleshooting({ appliance, issueContext, searchQuery, results }) {
  if (!OPENAI_API_KEY || !Array.isArray(results) || results.length === 0) {
    return null;
  }

  const prompt = `You are generating safe appliance troubleshooting guidance for a property maintenance assistant.

Rules:
- Only provide safe tenant-level steps.
- Do not suggest opening panels, bypassing safeties, gas work, wiring work, or anything requiring a licensed technician.
- Keep steps concise and model-specific when the search results support that.
- If professional repair is clearly needed, say so.

Return only JSON with this exact shape:
{
  "steps": ["string"],
  "safetyWarnings": ["string"],
  "needsProfessional": true,
  "reason": "string"
}

Appliance:
${JSON.stringify(appliance, null, 2)}

Issue context:
${issueContext || 'Not provided'}

Search query:
${searchQuery}

Search results:
${JSON.stringify(results, null, 2)}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        {
          role: 'system',
          content: 'You summarize search findings into safe household troubleshooting steps. Output only valid JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI troubleshooting summary failed: ${response.status} ${errorText.slice(0, 180)}`);
  }

  const data = await response.json();
  return parseModelJsonResponse(data.choices?.[0]?.message?.content || '');
}

// In-memory store for maintenance request automation status (in production, use database)
const maintenanceAutomationStatus = new Map();

// In-memory store to track active calls and prevent duplicates
const activeCallsInProgress = new Map();

// Temporary migration guard for tickets created before owner-submitted intake
// bypassed the owner-SMS confirmation gate.
const ownerSubmittedDispatchRecoveryInFlight = new Set();

app.post('/api/maintenance/triage', async (req, res) => {
  const {
    message,
    messages = [],
    currentDraft = {},
    submitterRole,
    answeredQuestionIds = []
  } = req.body || {};

  if (!message || !String(message).trim()) {
    return res.status(400).json({ ok: false, error: 'Message is required' });
  }

  const speaker = String(submitterRole || '').toLowerCase() === 'owner' ? 'owner' : 'tenant';
  const speakerLabel = speaker === 'owner' ? 'property owner' : 'tenant';

  const sanitizedMessages = Array.isArray(messages)
    ? messages
        .filter((entry) => entry && typeof entry.content === 'string')
        .slice(-12)
        .map((entry) => ({
          role: entry.role === 'assistant' ? 'assistant' : 'user',
          content: entry.content.trim()
        }))
    : [];

  const answeredIds = Array.isArray(answeredQuestionIds)
    ? answeredQuestionIds.filter((id) => typeof id === 'string').slice(0, 40)
    : [];

  // Everything the submitter has said, so we never ask for a detail they already gave.
  const submitterText = [
    ...sanitizedMessages.filter((entry) => entry.role === 'user').map((entry) => entry.content),
    String(message).trim()
  ].join(' ');

  const knownFacts = detectKnownFacts(submitterText);

  const respondWithFallback = (reason) => {
    if (reason) console.warn(`[MAINTENANCE-TRIAGE] Falling back to rule-based intake: ${reason}`);
    return res.json({
      ok: true,
      ...buildMaintenanceTriageFallback(message, sanitizedMessages, currentDraft, answeredIds),
      provider: 'rules',
      degraded: Boolean(reason)
    });
  };

  if (!GEMINI_API_KEY) {
    return respondWithFallback(null);
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = buildTriagePrompt({
      speaker,
      message,
      sanitizedMessages,
      currentDraft,
      knownFacts,
      answeredIds,
    });

    const result = await model.generateContent(prompt);
    const parsed = parseModelJsonResponse(result.response.text());

    const category = parsed?.triage?.category || currentDraft?.category || detectCategory(submitterText);
    const readyToSubmit = Boolean(parsed?.triage?.readyToSubmit);

    let questions = normalizeChoiceQuestions(parsed?.questions, { answeredIds });
    // The model occasionally returns prose questions or none at all while still
    // flagging the ticket incomplete; fill from the bank so the UI stays tappable.
    if (!questions.length && !readyToSubmit) {
      questions = buildChoiceQuestions({ category, text: submitterText, answeredIds });
    }

    res.json({
      ok: true,
      reply: parsed.reply || 'Tell me a bit more and I can route this correctly.',
      questions,
      triage: {
        category,
        priority: parsed?.triage?.priority || currentDraft?.priority || 'normal',
        location: parsed?.triage?.location || currentDraft?.location || knownFacts.location || '',
        summary: parsed?.triage?.summary || currentDraft?.description || message,
        ownerSummary: parsed?.triage?.ownerSummary || parsed?.triage?.summary || currentDraft?.description || message,
        serviceTypeHint: parsed?.triage?.serviceTypeHint || '',
        readyToSubmit,
        emergencyLevel: parsed?.triage?.emergencyLevel || 'none',
        emergencyGuidance: parsed?.triage?.emergencyGuidance || '',
        suggestedActions: Array.isArray(parsed?.triage?.suggestedActions) ? parsed.triage.suggestedActions.slice(0, 4) : []
      },
      provider: 'gemini-2.5-flash',
      degraded: false
    });
  } catch (error) {
    console.error('[MAINTENANCE-TRIAGE] Gemini call failed:', error?.message || error);
    return respondWithFallback(error?.message || 'unknown error');
  }
});

app.post('/api/maintenance/live/token', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
  }

  try {
    const { tenantName, propertyAddress, unit, issueSummary } = req.body || {};
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        expires_after: {
          anchor: 'created_at',
          seconds: 600
        },
        session: {
          type: 'realtime',
          model: 'gpt-realtime-2',
          output_modalities: ['audio'],
          instructions: buildMaintenanceRealtimeInstructions({ tenantName, propertyAddress, unit, issueSummary }),
          audio: {
            input: {
              transcription: {
                model: 'whisper-1'
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 700
              }
            },
            output: {
              voice: 'marin'
            }
          }
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Maintenance Live] Realtime token error:', errorText);
      return res.status(response.status).json({ ok: false, error: 'Failed to get live maintenance session token' });
    }

    const data = await response.json();
    return res.json({
      ok: true,
      token: data.value,
      model: 'gpt-realtime-2'
    });
  } catch (error) {
    console.error('[Maintenance Live] Token error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to get live maintenance session token' });
  }
});

app.post('/api/maintenance/live/frame-analysis', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
  }

  try {
    const {
      imageDataUrl,
      propertyAddress,
      unit,
      transcript = [],
      issueSummary = '',
      latestNotes = ''
    } = req.body || {};

    const sanitizedImage = sanitizeImageDataUrl(imageDataUrl);
    if (!sanitizedImage) {
      return res.status(400).json({ ok: false, error: 'A valid imageDataUrl is required' });
    }

    const recentTranscript = Array.isArray(transcript)
      ? transcript
          .filter((entry) => entry && typeof entry.content === 'string')
          .slice(-8)
          .map((entry) => ({
            role: entry.role === 'assistant' ? 'assistant' : 'user',
            content: entry.content.trim()
          }))
      : [];

    const prompt = `You are analyzing a tenant's maintenance livestream frame.

Goals:
- Identify the likely maintenance issue visible right now.
- Detect urgent safety hazards like active water leaks, flooding, electrical danger, smoke, fire, or gas-risk indicators.
- If an appliance is visible, identify type, brand, and model if legible.
- Decide whether the tenant can try simple safe troubleshooting or should submit a maintenance request for professional service.

Rules:
- Never invent appliance model details. Leave blank if not readable.
- Only recommend safe tenant-level actions.
- Priority must be one of: low, normal, urgent.
- issueCategory must be one of: Plumbing, Electrical, HVAC, Appliances, Structural, Pest Control, Lock/Security, Other.
- emergencyLevel must be one of: none, urgent, call_911.

Return only JSON with this exact shape:
{
  "reply": "string",
  "visionSummary": "string",
  "hazardDetected": true,
  "hazardType": "none|water_leak|electrical|fire|gas|other",
  "shouldCreateMaintenanceRequest": true,
  "issueCategory": "Plumbing|Electrical|HVAC|Appliances|Structural|Pest Control|Lock/Security|Other",
  "priority": "low|normal|urgent",
  "location": "string",
  "troubleshootingSteps": ["string"],
  "recommendedProfessional": "string",
  "appliance": {
    "isVisible": true,
    "type": "string",
    "brand": "string",
    "model": "string",
    "confidence": "high|medium|low"
  },
  "requestDraft": {
    "summary": "string",
    "ownerSummary": "string",
    "emergencyLevel": "none|urgent|call_911",
    "emergencyGuidance": "string",
    "suggestedActions": ["string"]
  }
}

Context:
- Property: ${[propertyAddress, unit].filter(Boolean).join(' ') || 'Unknown property'}
- Issue summary from tenant: ${issueSummary || 'Not provided'}
- Latest notes: ${latestNotes || 'None'}
- Recent transcript: ${JSON.stringify(recentTranscript, null, 2)}`;

    const visionResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 1400,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
              },
              {
                type: 'image_url',
                image_url: {
                  url: sanitizedImage,
                  detail: 'high'
                }
              }
            ]
          }
        ]
      })
    });

    if (!visionResponse.ok) {
      const errorText = await visionResponse.text();
      console.error('[Maintenance Live] Frame analysis error:', errorText);
      return res.status(502).json({ ok: false, error: 'Vision analysis failed' });
    }

    const visionData = await visionResponse.json();
    const parsed = parseModelJsonResponse(visionData.choices?.[0]?.message?.content || '');
    const combinedText = [
      parsed?.visionSummary,
      parsed?.reply,
      parsed?.requestDraft?.summary,
      issueSummary,
      latestNotes,
      ...recentTranscript.map((entry) => entry.content)
    ].filter(Boolean).join(' ');

    const issueCategory = parsed?.issueCategory || detectMaintenanceCategoryFromText(combinedText);
    const priority = normalizeMaintenancePriority(parsed?.priority || (parsed?.hazardDetected ? 'urgent' : 'normal'));
    const appliance = parsed?.appliance && typeof parsed.appliance === 'object'
      ? {
          isVisible: Boolean(parsed.appliance.isVisible),
          type: parsed.appliance.type || '',
          brand: parsed.appliance.brand || '',
          model: parsed.appliance.model || '',
          confidence: parsed.appliance.confidence === 'high' || parsed.appliance.confidence === 'low' ? parsed.appliance.confidence : 'medium'
        }
      : { isVisible: false, type: '', brand: '', model: '', confidence: 'low' };

    let applianceTroubleshooting = null;
    if (appliance.isVisible && (appliance.type || appliance.brand || appliance.model) && GOOGLE_API_KEY && GOOGLE_CSE_CX) {
      try {
        const searchQuery = buildApplianceTroubleshootingQuery(appliance);
        const search = await runGoogleCustomSearch(searchQuery, 5);
        const summary = search.ok
          ? await summarizeApplianceTroubleshooting({
              appliance,
              issueContext: combinedText,
              searchQuery,
              results: search.results
            })
          : null;

        applianceTroubleshooting = {
          searchQuery,
          steps: Array.isArray(summary?.steps) ? summary.steps.slice(0, 5) : [],
          safetyWarnings: Array.isArray(summary?.safetyWarnings) ? summary.safetyWarnings.slice(0, 4) : [],
          needsProfessional: Boolean(summary?.needsProfessional),
          reason: summary?.reason || '',
          results: search.results || []
        };
      } catch (searchError) {
        console.warn('[Maintenance Live] Appliance troubleshooting search failed:', searchError.message);
      }
    }

    return res.json({
      ok: true,
      analysis: {
        reply: parsed?.reply || 'I analyzed the current camera frame and prepared a maintenance assessment.',
        visionSummary: parsed?.visionSummary || combinedText || 'Maintenance issue detected from the current camera frame.',
        hazardDetected: Boolean(parsed?.hazardDetected),
        hazardType: parsed?.hazardType || 'none',
        shouldCreateMaintenanceRequest: parsed?.shouldCreateMaintenanceRequest !== false,
        issueCategory,
        priority,
        location: parsed?.location || '',
        troubleshootingSteps: Array.isArray(parsed?.troubleshootingSteps) ? parsed.troubleshootingSteps.slice(0, 5) : [],
        recommendedProfessional: parsed?.recommendedProfessional || '',
        appliance,
        requestDraft: {
          summary: parsed?.requestDraft?.summary || parsed?.visionSummary || issueSummary || 'Maintenance issue observed during live camera session.',
          ownerSummary: parsed?.requestDraft?.ownerSummary || parsed?.visionSummary || combinedText || 'Maintenance issue observed during live camera session.',
          emergencyLevel: parsed?.requestDraft?.emergencyLevel || (priority === 'urgent' ? 'urgent' : 'none'),
          emergencyGuidance: parsed?.requestDraft?.emergencyGuidance || '',
          suggestedActions: Array.isArray(parsed?.requestDraft?.suggestedActions) ? parsed.requestDraft.suggestedActions.slice(0, 5) : []
        },
        applianceTroubleshooting
      },
      provider: applianceTroubleshooting ? 'openai-vision+google-cse' : 'openai-vision'
    });
  } catch (error) {
    console.error('[Maintenance Live] Frame analysis error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to analyze maintenance frame' });
  }
});

function mapMaintenanceCategoryToServiceType(category) {
  const categoryToServiceType = {
    'Plumbing': 'plumbing',
    'Electrical': 'electrical',
    'HVAC': 'hvac',
    'Appliances': 'appliance',
    'Structural': 'general',
    'Pest Control': 'pest_control',
    'Lock/Security': 'locksmith',
    'Roofing': 'roofing',
    'Other': 'general'
  };

  return categoryToServiceType[category] || 'general';
}

function mapMaintenancePriorityToSearchUrgency(priority) {
  switch (priority) {
    case 'urgent':
      return 'high';
    case 'normal':
      return 'medium';
    default:
      return 'low';
  }
}

function mapMaintenancePriorityToVoiceUrgency(priority) {
  switch (priority) {
    case 'urgent':
      return 'urgent';
    case 'normal':
      return 'within the next few days';
    default:
      return 'flexible';
  }
}

function normalizeMaintenancePropertyAddress(propertyAddress, { propertyId, location } = {}) {
  const raw = String(propertyAddress || '').trim();
  const decoded = resolveAddressFromPropertyId(propertyId || '');
  const looksLikeSensorLabel = !raw
    || /^flood sensor\b/i.test(raw)
    || /^sensor\b/i.test(raw)
    || raw === String(location || '').trim();

  if (decoded && looksLikeSensorLabel) {
    return decoded.includes(' Rd') || decoded.includes(' Road') || decoded.includes(',')
      ? decoded
      : `${decoded} Rd`;
  }

  return raw || decoded || String(location || '').trim() || 'Property';
}

function buildMaintenanceSchedulingContext({
  category,
  serviceType,
  description,
  priority,
  location,
  propertyAddress,
  propertyId,
  unit,
  tenantAvailability,
  tenantName,
  tenantEmail,
  firestoreId,
  ownerId,
  ownerEmail,
  providerName,
  providerPhone
}) {
  const normalizedPropertyAddress = normalizeMaintenancePropertyAddress(propertyAddress, {
    propertyId,
    location,
  });
  const issueParts = [
    category ? `${category} issue` : null,
    description || null,
    location && location !== normalizedPropertyAddress ? `Location in unit: ${location}` : null
  ].filter(Boolean);

  return {
    category,
    issue: issueParts.join('. '),
    description,
    priority: priority || 'normal',
    urgency: mapMaintenancePriorityToVoiceUrgency(priority || 'normal'),
    location: location || unit || 'Not specified',
    serviceCategory: serviceType,
    tenantAvailability: tenantAvailability || 'Availability not provided yet. Ask what day and time would work.',
    tenantName,
    tenantEmail,
    propertyAddress: normalizedPropertyAddress,
    unitNumber: unit || '',
    firestoreId: firestoreId || null,
    ownerId: ownerId || null,
    ownerEmail: ownerEmail || '',
    providerName: providerName || '',
    providerPhone: providerPhone || ''
  };
}

async function resolveMaintenanceOwnerEmail(ownerId, existingEmail = '') {
  if (existingEmail) {
    return existingEmail;
  }
  if (!ownerId) {
    return '';
  }

  try {
    const { getFirestore } = await import('./firebase-admin.js');
    const db = getFirestore();
    const inviteSnap = await db.collection('tenant_invites')
      .where('ownerId', '==', ownerId)
      .limit(1)
      .get();
    if (!inviteSnap.empty) {
      return inviteSnap.docs[0].data()?.ownerEmail || '';
    }
  } catch (error) {
    console.warn('[MAINTENANCE] Owner email lookup failed:', error.message);
  }

  return '';
}

async function buildMaintenanceSchedulingContextForCall(maintenanceRequest, fields) {
  const ownerEmail = await resolveMaintenanceOwnerEmail(fields.ownerId, fields.ownerEmail);
  return buildMaintenanceSchedulingContext({
    ...fields,
    firestoreId: maintenanceRequest?.firestoreId || fields.firestoreId || null,
    ownerId: fields.ownerId,
    ownerEmail
  });
}

async function syncMaintenanceAutomationToFirestore(maintenanceRequest) {
  if (!maintenanceRequest?.firestoreId || !tenantActivityService?.updateMaintenanceAutomation) {
    return;
  }

  try {
    await tenantActivityService.updateMaintenanceAutomation(maintenanceRequest.firestoreId, {
      aiAutomation: maintenanceRequest.aiAutomation,
      tenantAvailability: maintenanceRequest.tenantAvailability || '',
      serviceType: maintenanceRequest.serviceType || mapMaintenanceCategoryToServiceType(maintenanceRequest.category)
    });
  } catch (error) {
    console.warn('[MAINTENANCE] Failed to sync automation status to Firestore:', error.message);
  }
}

function mapSelectedProviderFromAiResult(selected) {
  if (!selected) {
    return null;
  }

  return {
    name: selected.name,
    phone: selected.phone || selected.formatted_phone_number,
    rating: selected.rating,
    reviewCount: selected.reviewCount || selected.user_ratings_total || null,
    website: selected.website || '',
    aiScore: selected.reviewAnalysis?.overallScore ?? selected.selectionConfidence,
    address: selected.address || selected.formatted_address,
    selectionReasoning: selected.selectionReasoning || selected.reviewAnalysis?.summary || '',
    reviewAnalysis: selected.reviewAnalysis || null,
    isTrusted: Boolean(selected.isTrusted),
    trustedNote: selected.trustedNote || selected.notes || '',
    isOwnerSuggested: Boolean(selected.isOwnerSuggested),
  };
}

async function sendProviderApprovalAndHoldCall(maintenanceRequest, dispatchContext) {
  if (!maintenanceOwnerSmsService?.shouldRequireProviderApprovalBeforeCall?.()) {
    return { holdCall: false };
  }

  if (!dispatchContext?.autoBook) {
    return { holdCall: false };
  }

  const smsResult = await maintenanceOwnerSmsService.sendMaintenanceOwnerProviderApprovalSms({
    ...maintenanceRequest,
    id: maintenanceRequest.firestoreId || maintenanceRequest.id,
    ownerId: dispatchContext.ownerId,
    propertyAddress: dispatchContext.propertyAddress || maintenanceRequest.propertyAddress,
    description: dispatchContext.description || maintenanceRequest.description,
    category: dispatchContext.category || maintenanceRequest.category,
    priority: dispatchContext.priority || maintenanceRequest.priority,
    ownerSmsNotifications: maintenanceRequest.ownerSmsNotifications,
    aiAutomation: maintenanceRequest.aiAutomation,
  });

  if (maintenanceOwnerSmsService.shouldHoldProviderCallForOwnerSms(smsResult)) {
    maintenanceRequest.aiAutomation.status = 'awaiting_provider_approval';
    return { holdCall: true, providerSmsResult: smsResult };
  }

  return { holdCall: false, providerSmsResult: smsResult };
}

async function initiateMaintenanceBookingCall(maintenanceRequest, dispatchContext, maintenancePublicUrl, providerOverride = null) {
  const provider = providerOverride || maintenanceRequest.aiAutomation?.selectedProvider;
  if (!provider?.phone && !provider?.formatted_phone_number) {
    return { ok: false, error: 'Provider phone missing' };
  }

  if (!isMaintenanceAutoCallEnabled()) {
    return { ok: true, skipped: true, reason: 'awaiting_operator_dispatch' };
  }

  if (!dispatchContext?.autoBook || !voiceModule?.findProviderAndCall) {
    return { ok: true, skipped: true, reason: 'auto_book_disabled' };
  }

  if (!maintenancePublicUrl) {
    const error = 'Phone calls need a public webhook URL. Start the app with a tunnel (npm run dev:tunnel) or set NGROK_URL / CLOUDFLARE_TUNNEL_URL.';
    maintenanceRequest.aiAutomation.callError = error;
    await syncMaintenanceAutomationToFirestore(maintenanceRequest);
    return { ok: false, error };
  }

  const issueDetails = await buildMaintenanceSchedulingContextForCall(maintenanceRequest, dispatchContext);
  issueDetails.practiceTestPhone = maintenanceRequest.practiceTestPhone
    || maintenanceRequest.ownerSmsNotifications?.practiceTestPhone
    || dispatchContext.practiceTestPhone
    || null;
  issueDetails.practiceCallPhone = maintenanceRequest.practiceCallPhone
    || dispatchContext.practiceCallPhone
    || resolvePracticeCallPhone();
  const callResult = await executeMaintenanceProviderCall({
    maintenanceRequest,
    propertyAddress: dispatchContext.propertyAddress,
    provider,
    callOptions: {
      repairType: dispatchContext.serviceType,
      serviceCategory: dispatchContext.serviceType,
      location: dispatchContext.propertyAddress,
      urgency: mapMaintenancePriorityToSearchUrgency(dispatchContext.priority || 'normal'),
      maintenanceContext: issueDetails,
      publicUrl: maintenancePublicUrl,
      skipProviderSearch: true,
      preSelectedProvider: {
        ...provider,
        formatted_phone_number: provider.phone || provider.formatted_phone_number,
      },
    },
  });

  if (callResult.ok || callResult.scheduled) {
    maintenanceRequest.aiAutomation.status = callResult.scheduled ? 'scheduled_for_callback' : 'call_initiated';
  }

  await syncMaintenanceAutomationToFirestore(maintenanceRequest);
  return callResult;
}

async function executeMaintenanceProviderCall({
  maintenanceRequest,
  propertyAddress,
  provider,
  callOptions
}) {
  const applyCallResult = (callResult) => {
    if (callResult.scheduled) {
      maintenanceRequest.aiAutomation.status = 'scheduled_for_callback';
      maintenanceRequest.aiAutomation.callInitiated = false;
      maintenanceRequest.aiAutomation.scheduledCall = {
        scheduledFor: callResult.scheduledFor,
        reason: callResult.reason || 'outside_business_hours'
      };
      return;
    }

    if (callResult.ok) {
      maintenanceRequest.aiAutomation.callInitiated = true;
      maintenanceRequest.aiAutomation.callDetails = {
        callSid: callResult.call?.callSid,
        providerPhone: provider?.phone || provider?.formatted_phone_number || '',
        initiatedAt: new Date().toISOString(),
        ...(provider?.isTrusted ? { note: 'Called trusted provider' } : {})
      };
      if (maintenanceRequest.firestoreId && maintenanceOwnerSmsService?.notifyMaintenanceOwnerProviderConnected) {
        void tenantActivityService?.getMaintenanceRequestById?.(maintenanceRequest.firestoreId)
          .then((result) => {
            if (!result?.ok || !result.request) {
              return null;
            }
            return maintenanceOwnerSmsService.notifyMaintenanceOwnerProviderConnected({
              ...result.request,
              aiAutomation: maintenanceRequest.aiAutomation,
            });
          })
          .catch((smsError) => {
            console.warn('[MAINTENANCE] Owner provider-connected SMS failed:', smsError.message);
          });
      }
      return;
    }

    maintenanceRequest.aiAutomation.callInitiated = false;
    maintenanceRequest.aiAutomation.callError = callResult.error || 'Voice call was not initiated';
  };

  if (maintenanceCallScheduler?.initiateMaintenanceProviderCall) {
    const callResult = await maintenanceCallScheduler.initiateMaintenanceProviderCall({
      voiceModule,
      callOptions,
      propertyAddress,
      provider,
      maintenanceRequest
    });
    applyCallResult(callResult);
    return callResult;
  }

  const callResult = await voiceModule.findProviderAndCall(callOptions);
  applyCallResult(callResult);
  return callResult;
}

async function persistMaintenancePendingDispatch(firestoreId, maintenanceRequest, dispatchContext) {
  if (!firestoreId || !tenantActivityService?.updateMaintenanceRequestDetails) {
    return;
  }

  await tenantActivityService.updateMaintenanceRequestDetails(firestoreId, {
    pendingDispatch: dispatchContext,
    aiAutomation: maintenanceRequest.aiAutomation,
    status: 'pending',
  });
}

async function dispatchTrustedProviderForMaintenance(maintenanceRequest, dispatchContext, maintenancePublicUrl) {
  const trustedProvider = dispatchContext.trustedProvider;
  if (!trustedProvider?.phone) {
    return { ok: false, error: 'Trusted provider phone missing' };
  }

  maintenanceRequest.aiAutomation.status = 'provider_found';
  maintenanceRequest.aiAutomation.usedTrustedProvider = true;
  maintenanceRequest.aiAutomation.selectedProvider = {
    name: trustedProvider.name,
    phone: trustedProvider.phone,
    rating: 5.0,
    aiScore: 100,
    address: '',
    isTrusted: true,
    trustedNote: trustedProvider.notes || `Pre-approved trusted provider for ${dispatchContext.category}`,
  };

  // A trusted provider still needs a human to call and confirm a time.
  if (!isMaintenanceAutoCallEnabled()) {
    maintenanceRequest.aiAutomation.status = AWAITING_OPERATOR_DISPATCH;
    maintenanceRequest.aiAutomation.providerShortlist = [maintenanceRequest.aiAutomation.selectedProvider];
    await syncMaintenanceAutomationToFirestore(maintenanceRequest);
    return { ok: true, awaitingOperatorDispatch: true };
  }

  if (!dispatchContext.autoBook || !voiceModule?.findProviderAndCall) {
    await syncMaintenanceAutomationToFirestore(maintenanceRequest);
    return { ok: true, skipped: true, reason: 'auto_book_disabled' };
  }

  const approvalGate = await sendProviderApprovalAndHoldCall(maintenanceRequest, dispatchContext);
  if (approvalGate.holdCall) {
    await syncMaintenanceAutomationToFirestore(maintenanceRequest);
    return { ok: true, awaitingProviderApproval: true };
  }

  const issueDetails = await buildMaintenanceSchedulingContextForCall(maintenanceRequest, dispatchContext);
  if (!maintenancePublicUrl) {
    maintenanceRequest.aiAutomation.callError = 'Phone calls need a public webhook URL. Start the app with a tunnel (npm run dev:tunnel) or set NGROK_URL / CLOUDFLARE_TUNNEL_URL.';
    await syncMaintenanceAutomationToFirestore(maintenanceRequest);
    return { ok: false, error: maintenanceRequest.aiAutomation.callError };
  }

  try {
    const callResult = await executeMaintenanceProviderCall({
      maintenanceRequest,
      propertyAddress: dispatchContext.propertyAddress,
      provider: {
        ...trustedProvider,
        isTrusted: true,
        notes: trustedProvider.notes,
      },
      callOptions: {
        repairType: dispatchContext.serviceType,
        serviceCategory: dispatchContext.serviceType,
        location: dispatchContext.propertyAddress,
        urgency: mapMaintenancePriorityToSearchUrgency(dispatchContext.priority || 'normal'),
        maintenanceContext: issueDetails,
        publicUrl: maintenancePublicUrl,
        skipProviderSearch: true,
        preSelectedProvider: {
          name: trustedProvider.name,
          phone: trustedProvider.phone,
          formatted_phone_number: trustedProvider.phone,
          rating: 5.0,
          isTrusted: true,
          notes: trustedProvider.notes,
        },
      },
    });
    await syncMaintenanceAutomationToFirestore(maintenanceRequest);
    return callResult;
  } catch (callError) {
    maintenanceRequest.aiAutomation.callError = callError.message;
    await syncMaintenanceAutomationToFirestore(maintenanceRequest);
    return { ok: false, error: callError.message };
  }
}

async function runMaintenanceAiPipelineForRequest(maintenanceRequest, dispatchContext, maintenancePublicUrl) {
  if (!dispatchContext.propertyAddress || !aiProviderSelector) {
    return { ok: false, error: 'AI provider selection unavailable' };
  }

  try {
    maintenanceRequest.aiAutomation.status = 'processing';
    await syncMaintenanceAutomationToFirestore(maintenanceRequest);

    const aiResult = await aiProviderSelector.findBestRepairService({
      repairType: dispatchContext.serviceType,
      serviceCategory: dispatchContext.serviceType,
      location: dispatchContext.propertyAddress,
      urgency: mapMaintenancePriorityToSearchUrgency(dispatchContext.priority || 'normal'),
      issueDescription: dispatchContext.description,
    });

    if (!aiResult.ok || !aiResult.selected) {
      maintenanceRequest.aiAutomation.status = 'no_provider_found';
      maintenanceRequest.aiAutomation.error = aiResult.error || 'No suitable providers found';
      await syncMaintenanceAutomationToFirestore(maintenanceRequest);
      return { ok: false, error: maintenanceRequest.aiAutomation.error };
    }

    const shortlist = buildProviderShortlist(aiResult);

    maintenanceRequest.aiAutomation.status = 'provider_found';
    maintenanceRequest.aiAutomation.providerSearch = {
      totalFound: aiResult.allCandidates?.length || shortlist.length,
      analyzedCount: shortlist.filter((provider) => provider.reviewAnalysis).length || shortlist.length,
    };
    maintenanceRequest.aiAutomation.selectedProvider = mapSelectedProviderFromAiResult(aiResult.selected);
    maintenanceRequest.aiAutomation.providerShortlist = shortlist;
    maintenanceRequest.aiAutomation.callScript = formatCallScript(aiResult.callScript);

    // Grow the provider network on every search, not just for the winner.
    void upsertProvidersFromSearch({
      providers: shortlist,
      category: dispatchContext.category,
      serviceType: dispatchContext.serviceType,
      propertyAddress: dispatchContext.propertyAddress,
    }).catch((error) => {
      console.warn('[MAINTENANCE] Provider network upsert failed:', error.message);
    });

    // The shortlist is the deliverable: an operator calls from it and logs the outcome.
    if (!isMaintenanceAutoCallEnabled()) {
      maintenanceRequest.aiAutomation.status = AWAITING_OPERATOR_DISPATCH;
      await syncMaintenanceAutomationToFirestore(maintenanceRequest);
      return { ok: true, awaitingOperatorDispatch: true, shortlistCount: shortlist.length };
    }

    const approvalGate = await sendProviderApprovalAndHoldCall(maintenanceRequest, dispatchContext);
    if (approvalGate.holdCall) {
      await syncMaintenanceAutomationToFirestore(maintenanceRequest);
      return { ok: true, awaitingProviderApproval: true };
    }

    if (dispatchContext.autoBook && voiceModule?.findProviderAndCall && (aiResult.selected.phone || aiResult.selected.formatted_phone_number)) {
      await initiateMaintenanceBookingCall(maintenanceRequest, dispatchContext, maintenancePublicUrl, aiResult.selected);
    }

    await syncMaintenanceAutomationToFirestore(maintenanceRequest);
    return { ok: true };
  } catch (aiError) {
    maintenanceRequest.aiAutomation.status = 'error';
    maintenanceRequest.aiAutomation.error = aiError.message;
    await syncMaintenanceAutomationToFirestore(maintenanceRequest);
    return { ok: false, error: aiError.message };
  }
}

function buildSensorAlertMaintenanceDescription(alert = {}) {
  const location = alert.sensorLocation || alert.location || alert.deviceName || 'sensor location';
  const message = alert.message || 'Water leak detected by IoT sensor';
  const deviceId = alert.deviceId || alert.sensorId || 'unknown';
  const timestamp = alert.timestamp ? new Date(alert.timestamp).toLocaleString() : new Date().toLocaleString();
  return [
    '🚨 FLOOD/LEAK DETECTED',
    '',
    message,
    '',
    `Sensor: ${deviceId}`,
    `Location: ${location}`,
    `Time: ${timestamp}`,
  ].join('\n');
}

async function dispatchOwnerMaintenanceFromSensorAlert({
  alert,
  propertyInfo,
  practiceTestPhone: rawPracticeTestPhone,
  req = null,
}) {
  if (!maintenanceOwnerSmsService?.isMaintenanceOwnerSmsEnabled?.()) {
    console.warn('[MAINTENANCE] Sensor alert owner SMS skipped: SMS not configured');
    return { ok: false, skipped: true, reason: 'owner_sms_disabled' };
  }

  const dispatchKey = buildOwnerDispatchKey({
    alertId: alert?.id,
    propertyId: alert?.propertyId,
    sensorDeviceId: alert?.deviceId || alert?.sensorId,
  });

  const persistedClaim = await claimOwnerDispatchPersisted(alert?.id || dispatchKey);
  if (!persistedClaim.claimed) {
    console.log('[MAINTENANCE] Sensor alert owner dispatch skipped (duplicate):', dispatchKey, persistedClaim.requestId || '');
    return {
      ok: true,
      skipped: true,
      reason: persistedClaim.reason || 'already_dispatched',
      alertId: alert?.id || null,
      requestId: persistedClaim.requestId || null,
    };
  }

  const resolvedPropertyInfo = buildPropertyInfoForSensorAlert(alert, propertyInfo);
  const ownerId = resolveOwnerIdForSensorAlert(alert, resolvedPropertyInfo);
  if (!ownerId) {
    console.warn('[MAINTENANCE] Sensor alert owner SMS skipped: missing ownerId', {
      alertId: alert?.id,
      propertyId: alert?.propertyId || resolvedPropertyInfo?.id,
    });
    return { ok: false, error: 'Property owner not found for sensor alert' };
  }

  if (!tenantActivityService?.saveMaintenanceRequest) {
    return { ok: false, error: 'Maintenance activity service unavailable' };
  }

  const practiceTestPhone = resolvePracticeSmsPhone(rawPracticeTestPhone);
  const practiceCallPhone = resolvePracticeCallPhone();
  const maintenancePublicUrl = await resolveMaintenancePublicUrl(req);
  const tenant = Array.isArray(resolvedPropertyInfo?.tenants) ? resolvedPropertyInfo.tenants[0] : null;
  const description = buildSensorAlertMaintenanceDescription(alert);
  const propertyAddress = normalizeMaintenancePropertyAddress(
    resolvedPropertyInfo?.address || alert.propertyAddress || '',
    {
      propertyId: resolvedPropertyInfo?.id || alert.propertyId || '',
      location: alert.sensorLocation || alert.location || alert.deviceName || 'Sensor',
    },
  );
  const propertyId = resolvedPropertyInfo?.id || alert.propertyId || '';

  const saveResult = await tenantActivityService.saveMaintenanceRequest({
    tenantId: tenant?.id || `sensor-${alert.id || Date.now()}`,
    tenantEmail: tenant?.email || '',
    tenantName: tenant?.name || 'Sensor Automation',
    ownerId,
    propertyId,
    propertyAddress,
    unit: tenant?.unit || '',
    serviceType: 'plumbing',
    category: 'plumbing',
    priority: 'emergency',
    location: alert.sensorLocation || alert.location || alert.deviceName || 'Sensor',
    description,
    tenantAvailability: 'Emergency — respond as soon as possible',
  });

  if (!saveResult.ok || !saveResult.requestId) {
    return { ok: false, error: saveResult.error || 'Failed to save maintenance request' };
  }

  await recordOwnerDispatchPersisted(alert?.id || dispatchKey, saveResult.requestId);

  const dispatchContext = {
    autoBook: true,
    trustedProvider: null,
    practiceTestPhone,
    practiceCallPhone,
    category: 'plumbing',
    serviceType: 'plumbing',
    description,
    location: alert.sensorLocation || alert.location || alert.deviceName || 'Sensor',
    propertyAddress,
    unit: tenant?.unit || '',
    tenantAvailability: 'Emergency — respond as soon as possible',
    tenantName: tenant?.name || 'Sensor Automation',
    tenantEmail: tenant?.email || '',
    ownerId,
    propertyId,
    priority: 'emergency',
    createdAt: new Date().toISOString(),
    source: 'sensor_alert',
    sensorAlertId: alert.id,
    sensorType: alert.type || 'flood',
  };

  const maintenanceRequest = {
    id: saveResult.requestId,
    firestoreId: saveResult.requestId,
    ownerId,
    propertyId,
    propertyAddress,
    description,
    category: 'plumbing',
    serviceType: 'plumbing',
    priority: 'emergency',
    location: dispatchContext.location,
    tenantName: dispatchContext.tenantName,
    tenantEmail: dispatchContext.tenantEmail,
    tenantAvailability: dispatchContext.tenantAvailability,
    practiceTestPhone,
    practiceCallPhone,
    aiAutomation: {
      status: 'pending',
      triggeredBy: 'sensor_alert',
      sensorAlertId: alert.id,
    },
  };

  maintenanceAutomationStatus.set(maintenanceRequest.id, maintenanceRequest);

  // Flood/leak alerts skip the generic dispatch-confirm SMS and go straight to
  // AI provider search + provider rundown approval (same YES → call flow as maintenance).
  await tenantActivityService.updateMaintenanceRequestDetails(saveResult.requestId, {
    practiceTestPhone,
    practiceCallPhone,
    pendingDispatch: dispatchContext,
    activeDispatchContext: dispatchContext,
    aiAutomation: maintenanceRequest.aiAutomation,
    status: 'pending',
  }).catch(() => {});

  maintenanceRequest.aiAutomation.status = 'processing';
  const pipelineResult = await runMaintenanceAiPipelineForRequest(
    maintenanceRequest,
    dispatchContext,
    maintenancePublicUrl,
  );

  await tenantActivityService.updateMaintenanceRequestDetails(saveResult.requestId, {
    aiAutomation: maintenanceRequest.aiAutomation,
    status: maintenanceRequest.aiAutomation.status === 'awaiting_provider_approval'
      ? 'pending'
      : maintenanceRequest.aiAutomation.status,
  }).catch(() => {});

  if (!pipelineResult.ok) {
    console.warn('[MAINTENANCE] Sensor alert AI pipeline failed:', saveResult.requestId, pipelineResult.error);
    return {
      ok: false,
      error: pipelineResult.error || 'Provider search failed',
      requestId: saveResult.requestId,
    };
  }

  console.log('[MAINTENANCE] Sensor alert provider approval SMS sent:', saveResult.requestId, maintenanceRequest.aiAutomation?.status);
  return {
    ok: true,
    requestId: saveResult.requestId,
    awaitingProviderApproval: Boolean(pipelineResult.awaitingProviderApproval),
    practiceTestPhone,
    practiceCallPhone,
    aiAutomation: maintenanceRequest.aiAutomation,
  };
}

async function resumeMaintenanceDispatchAfterOwnerConfirm(requestId) {
  if (!requestId || !tenantActivityService?.getMaintenanceRequestById) {
    return { ok: false, error: 'Maintenance activity service unavailable' };
  }

  const persisted = await tenantActivityService.getMaintenanceRequestById(requestId);
  if (!persisted.ok || !persisted.request) {
    return { ok: false, error: persisted.error || 'Maintenance request not found' };
  }

  const storedRequest = persisted.request;
  const dispatchContext = storedRequest.pendingDispatch || storedRequest.activeDispatchContext;
  if (!dispatchContext) {
    return { ok: false, error: 'No pending dispatch for this request' };
  }

  if (tenantActivityService?.updateMaintenanceRequestDetails) {
    await tenantActivityService.updateMaintenanceRequestDetails(requestId, {
      activeDispatchContext: dispatchContext,
    });
  }

  const maintenanceRequest = {
    id: storedRequest.id,
    firestoreId: storedRequest.id,
    category: storedRequest.category,
    serviceType: storedRequest.serviceType || mapMaintenanceCategoryToServiceType(storedRequest.category),
    priority: storedRequest.priority || 'normal',
    description: storedRequest.description,
    location: storedRequest.location || '',
    tenantAvailability: storedRequest.tenantAvailability || '',
    propertyAddress: storedRequest.propertyAddress || '',
    unit: storedRequest.unit || '',
    tenantName: storedRequest.tenantName || '',
    tenantEmail: storedRequest.tenantEmail || '',
    ownerSmsNotifications: storedRequest.ownerSmsNotifications || null,
    practiceTestPhone: storedRequest.practiceTestPhone
      || storedRequest.ownerSmsNotifications?.practiceTestPhone
      || dispatchContext.practiceTestPhone
      || null,
    practiceCallPhone: storedRequest.practiceCallPhone
      || dispatchContext.practiceCallPhone
      || resolvePracticeCallPhone(),
    aiAutomation: {
      ...(storedRequest.aiAutomation || {}),
      status: 'processing',
    },
  };

  maintenanceAutomationStatus.set(maintenanceRequest.id, maintenanceRequest);
  const maintenancePublicUrl = await resolveMaintenancePublicUrl();

  let dispatchResult;
  if (dispatchContext.trustedProvider?.name && dispatchContext.trustedProvider?.phone) {
    dispatchResult = await dispatchTrustedProviderForMaintenance(maintenanceRequest, dispatchContext, maintenancePublicUrl);
  } else {
    dispatchResult = await runMaintenanceAiPipelineForRequest(maintenanceRequest, dispatchContext, maintenancePublicUrl);
  }

  if (tenantActivityService?.updateMaintenanceRequestDetails) {
    await tenantActivityService.updateMaintenanceRequestDetails(requestId, {
      aiAutomation: maintenanceRequest.aiAutomation,
      status: maintenanceRequest.aiAutomation.status === 'awaiting_provider_approval'
        ? 'pending'
        : maintenanceRequest.aiAutomation.status === 'scheduled_for_callback'
          ? 'scheduled'
          : maintenanceRequest.aiAutomation.callInitiated
            ? 'in_progress'
            : storedRequest.status || 'pending',
    });
  }

  console.log('[MAINTENANCE] Resumed dispatch after owner SMS confirmation:', requestId, dispatchResult?.ok === false ? dispatchResult.error : 'ok');
  return { ok: true, dispatchResult, request: maintenanceRequest };
}

/**
 * Self-heal tickets submitted by an owner during the brief period where they
 * were incorrectly held for that same owner's SMS confirmation. This runs only
 * for the obsolete state, is idempotent per server process, and does not touch
 * tenant-submitted requests (those still require explicit owner approval).
 */
function recoverOwnerSubmittedDispatchIfNeeded(request = {}) {
  const requestId = request.id;
  const isOwnerSubmitted = String(request.submittedBy?.role || '').toLowerCase() === 'owner';
  const isIncorrectlyHeld = request.aiAutomation?.status === 'awaiting_owner_confirmation';

  if (!requestId || !isOwnerSubmitted || !isIncorrectlyHeld || ownerSubmittedDispatchRecoveryInFlight.has(requestId)) {
    return;
  }

  ownerSubmittedDispatchRecoveryInFlight.add(requestId);
  void (async () => {
    // Some documents from the affected flow are missing pendingDispatch, even
    // though they were marked awaiting_owner_confirmation. Rebuild that context
    // from the persisted ticket so the standard resume path can run normally.
    if (!request.pendingDispatch && !request.activeDispatchContext) {
      await tenantActivityService?.updateMaintenanceRequestDetails?.(requestId, {
        pendingDispatch: {
          autoBook: true,
          trustedProvider: null,
          category: request.category,
          serviceType: request.serviceType || mapMaintenanceCategoryToServiceType(request.category),
          description: request.description,
          location: request.location || '',
          propertyAddress: request.propertyAddress || '',
          unit: request.unit || '',
          tenantAvailability: request.tenantAvailability || '',
          tenantName: request.tenantName || '',
          tenantEmail: request.tenantEmail || '',
          ownerId: request.ownerId || '',
          propertyId: request.propertyId || '',
          priority: request.priority || 'normal',
          createdAt: request.createdAt || new Date().toISOString(),
        },
      });
    }

    return resumeMaintenanceDispatchAfterOwnerConfirm(requestId);
  })()
    .then((result) => {
      if (!result.ok) {
        console.warn('[MAINTENANCE] Owner-submitted ticket recovery failed:', requestId, result.error);
      }
    })
    .catch((error) => {
      console.warn('[MAINTENANCE] Owner-submitted ticket recovery threw:', requestId, error.message);
    })
    .finally(() => {
      ownerSubmittedDispatchRecoveryInFlight.delete(requestId);
    });
}

async function bookMaintenanceAfterProviderApproval(requestId, alternateProvider = null) {
  if (!requestId || !tenantActivityService?.getMaintenanceRequestById) {
    return { ok: false, error: 'Maintenance activity service unavailable' };
  }

  const persisted = await tenantActivityService.getMaintenanceRequestById(requestId);
  if (!persisted.ok || !persisted.request) {
    return { ok: false, error: persisted.error || 'Maintenance request not found' };
  }

  const storedRequest = persisted.request;
  const dispatchContext = storedRequest.pendingDispatch || storedRequest.activeDispatchContext;
  if (!dispatchContext) {
    return { ok: false, error: 'No dispatch context for this request' };
  }

  const normalizedPropertyAddress = normalizeMaintenancePropertyAddress(
    storedRequest.propertyAddress || dispatchContext.propertyAddress,
    {
      propertyId: storedRequest.propertyId || dispatchContext.propertyId,
      location: storedRequest.location || dispatchContext.location,
    },
  );
  dispatchContext.propertyAddress = normalizedPropertyAddress;

  const maintenanceRequest = {
    id: storedRequest.id,
    firestoreId: storedRequest.id,
    category: storedRequest.category,
    serviceType: storedRequest.serviceType || mapMaintenanceCategoryToServiceType(storedRequest.category),
    priority: storedRequest.priority || 'normal',
    description: storedRequest.description,
    location: storedRequest.location || '',
    tenantAvailability: storedRequest.tenantAvailability || '',
    propertyAddress: normalizedPropertyAddress,
    unit: storedRequest.unit || '',
    tenantName: storedRequest.tenantName || '',
    tenantEmail: storedRequest.tenantEmail || '',
    ownerSmsNotifications: storedRequest.ownerSmsNotifications || null,
    practiceTestPhone: storedRequest.practiceTestPhone
      || storedRequest.ownerSmsNotifications?.practiceTestPhone
      || dispatchContext.practiceTestPhone
      || null,
    practiceCallPhone: storedRequest.practiceCallPhone
      || dispatchContext.practiceCallPhone
      || resolvePracticeCallPhone(),
    aiAutomation: {
      ...(storedRequest.aiAutomation || {}),
      status: 'processing',
    },
  };

  if (alternateProvider?.phone) {
    maintenanceRequest.aiAutomation.selectedProvider = {
      name: alternateProvider.name || 'Owner suggested provider',
      phone: alternateProvider.phone,
      rating: null,
      aiScore: null,
      address: '',
      isOwnerSuggested: true,
    };
  }

  maintenanceAutomationStatus.set(maintenanceRequest.id, maintenanceRequest);
  const maintenancePublicUrl = await resolveMaintenancePublicUrl();

  const callerId = process.env.TWILIO_FROM_NUMBER || '';
  const callerLabel = callerId.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') || callerId;
  if (maintenanceOwnerSmsService?.sendOwnerInboundConfirmationSms && callerLabel) {
    const practiceSmsPhone = resolvePracticeSmsPhone(
      storedRequest.practiceTestPhone
        || storedRequest.ownerSmsNotifications?.practiceTestPhone
    );
    const practiceCallPhone = resolvePracticeCallPhone(
      storedRequest.practiceCallPhone || dispatchContext.practiceCallPhone,
    );
    await maintenanceOwnerSmsService.sendOwnerInboundConfirmationSms(
      practiceSmsPhone,
      isPracticeModeEnabled()
        ? `HouseYield: Placing a practice scheduling call to ${practiceCallPhone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3')} now from ${callerLabel}. Practice mode — test line only, not the provider.`
        : `HouseYield: Calling ${maintenanceRequest.aiAutomation?.selectedProvider?.name || 'the provider'} now from ${callerLabel} to schedule service.`,
    ).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  const callResult = await initiateMaintenanceBookingCall(
    maintenanceRequest,
    dispatchContext,
    maintenancePublicUrl,
    maintenanceRequest.aiAutomation.selectedProvider,
  );

  if (tenantActivityService?.updateMaintenanceRequestDetails) {
    await tenantActivityService.updateMaintenanceRequestDetails(requestId, {
      pendingDispatch: null,
      activeDispatchContext: null,
      aiAutomation: maintenanceRequest.aiAutomation,
      status: maintenanceRequest.aiAutomation.status === 'scheduled_for_callback'
        ? 'scheduled'
        : callResult.ok
          ? 'in_progress'
          : storedRequest.status || 'pending',
    });
  }

  console.log('[MAINTENANCE] Booked provider after owner SMS approval:', requestId, callResult?.ok === false ? callResult.error : 'ok');
  return { ok: true, callResult, request: maintenanceRequest };
}

async function reselectMaintenanceProviderAfterOwnerDecline(requestId) {
  if (!requestId || !tenantActivityService?.getMaintenanceRequestById || !aiProviderSelector) {
    return { ok: false, error: 'Maintenance reselection unavailable' };
  }

  const persisted = await tenantActivityService.getMaintenanceRequestById(requestId);
  if (!persisted.ok || !persisted.request) {
    return { ok: false, error: persisted.error || 'Maintenance request not found' };
  }

  const storedRequest = persisted.request;
  const dispatchContext = storedRequest.pendingDispatch || storedRequest.activeDispatchContext;
  if (!dispatchContext?.propertyAddress) {
    return { ok: false, error: 'No dispatch context for this request' };
  }

  const rejectedProviders = storedRequest.ownerSmsNotifications?.rejectedProviders || [];
  const maintenanceRequest = {
    id: storedRequest.id,
    firestoreId: storedRequest.id,
    category: storedRequest.category,
    serviceType: storedRequest.serviceType || mapMaintenanceCategoryToServiceType(storedRequest.category),
    priority: storedRequest.priority || 'normal',
    description: storedRequest.description,
    location: storedRequest.location || '',
    tenantAvailability: storedRequest.tenantAvailability || '',
    propertyAddress: storedRequest.propertyAddress || '',
    unit: storedRequest.unit || '',
    tenantName: storedRequest.tenantName || '',
    tenantEmail: storedRequest.tenantEmail || '',
    ownerSmsNotifications: storedRequest.ownerSmsNotifications || null,
    aiAutomation: {
      ...(storedRequest.aiAutomation || {}),
      status: 'processing',
    },
  };

  maintenanceAutomationStatus.set(maintenanceRequest.id, maintenanceRequest);
  maintenanceRequest.aiAutomation.status = 'processing';
  await syncMaintenanceAutomationToFirestore(maintenanceRequest);

  const aiResult = await aiProviderSelector.findBestRepairService({
    repairType: dispatchContext.serviceType,
    serviceCategory: dispatchContext.serviceType,
    location: dispatchContext.propertyAddress,
    urgency: mapMaintenancePriorityToSearchUrgency(dispatchContext.priority || 'normal'),
    issueDescription: dispatchContext.description,
    excludeProviders: rejectedProviders,
  });

  if (!aiResult.ok || !aiResult.selected) {
    maintenanceRequest.aiAutomation.status = 'no_provider_found';
    maintenanceRequest.aiAutomation.error = aiResult.error || 'No additional providers found';
    await syncMaintenanceAutomationToFirestore(maintenanceRequest);
    return { ok: false, error: maintenanceRequest.aiAutomation.error };
  }

  maintenanceRequest.aiAutomation.status = 'provider_found';
  maintenanceRequest.aiAutomation.providerSearch = {
    totalFound: aiResult.allCandidates?.length || 0,
    analyzedCount: aiResult.allCandidates?.length || 0,
  };
  maintenanceRequest.aiAutomation.selectedProvider = mapSelectedProviderFromAiResult(aiResult.selected);

  const approvalGate = await sendProviderApprovalAndHoldCall(maintenanceRequest, dispatchContext);
  await syncMaintenanceAutomationToFirestore(maintenanceRequest);

  if (tenantActivityService?.updateMaintenanceRequestDetails) {
    await tenantActivityService.updateMaintenanceRequestDetails(requestId, {
      aiAutomation: maintenanceRequest.aiAutomation,
      status: approvalGate.holdCall ? 'pending' : storedRequest.status || 'pending',
    });
  }

  console.log('[MAINTENANCE] Reselected provider after owner decline:', requestId, maintenanceRequest.aiAutomation.selectedProvider?.name);
  return { ok: true, awaitingProviderApproval: Boolean(approvalGate.holdCall), request: maintenanceRequest };
}

function isProductionVoiceRuntime() {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE);
}

function getVoiceWebhookEnvCandidates() {
  if (isProductionVoiceRuntime()) {
    return [
      process.env.PUBLIC_URL,
      process.env.BACKEND_PUBLIC_URL
    ];
  }

  return [
    process.env.CLOUDFLARE_TUNNEL_URL,
    process.env.NGROK_URL,
    process.env.VITE_PHONE_CALL_BACKEND_URL,
    process.env.VITE_NGROK_URL,
    process.env.BACKEND_PUBLIC_URL,
    process.env.PUBLIC_URL
  ];
}

function buildVoiceWebhookCandidateList(req = null) {
  let requestUrl = null;
  if (req) {
    const forwardedProtoRaw = req.headers['x-forwarded-proto'];
    const forwardedHostRaw = req.headers['x-forwarded-host'] || req.get('host');
    const forwardedProto = Array.isArray(forwardedProtoRaw)
      ? forwardedProtoRaw[0]
      : String(forwardedProtoRaw || req.protocol || 'http').split(',')[0].trim();
    const forwardedHost = Array.isArray(forwardedHostRaw)
      ? forwardedHostRaw[0]
      : String(forwardedHostRaw || '').split(',')[0].trim();
    requestUrl = forwardedHost ? `${forwardedProto}://${forwardedHost}` : null;
  }

  const seen = new Set();
  const ordered = [];
  const addCandidate = (candidate) => {
    const normalized = normalizeVoiceWebhookBaseUrl(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    ordered.push(normalized);
  };

  if (requestUrl) {
    addCandidate(requestUrl);
  }

  for (const candidate of getVoiceWebhookEnvCandidates()) {
    addCandidate(candidate);
  }

  return ordered;
}

function pickPublicWebhookUrl(candidates = []) {
  for (const candidate of candidates) {
    const normalized = normalizeVoiceWebhookBaseUrl(candidate);
    if (normalized && !isLoopbackVoiceWebhookUrl(normalized)) {
      return normalized;
    }
  }

  return null;
}

async function discoverNgrokTunnelUrl() {
  try {
    const resp = await fetch('http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(800)
    });
    if (!resp.ok) {
      return null;
    }

    const data = await resp.json();
    const httpsTunnel = (data.tunnels || []).find((tunnel) =>
      String(tunnel.public_url || '').startsWith('https://')
    );
    return normalizeVoiceWebhookBaseUrl(httpsTunnel?.public_url);
  } catch {
    return null;
  }
}

async function resolveMaintenancePublicUrl(req = null) {
  if (req) {
    const fromRequest = resolveVoiceWebhookBaseUrl(req);
    if (fromRequest && !isLoopbackVoiceWebhookUrl(fromRequest)) {
      return fromRequest;
    }
  }

  const ngrokDiscovered = isProductionVoiceRuntime() ? null : await discoverNgrokTunnelUrl();
  return pickPublicWebhookUrl([
    ...buildVoiceWebhookCandidateList(req),
    ngrokDiscovered
  ].filter(Boolean));
}

// GET /api/maintenance/practice-settings
app.get('/api/maintenance/practice-settings', (req, res) => {
  const settings = getPracticeTestPhoneSettings(req.query?.practiceTestPhone);
  res.json({
    ok: true,
    ...settings,
  });
});

// POST /api/maintenance/test/owner-sms-flow
// Sends a practice provider-approval SMS to the test phone and prepares Firestore state for YES/NO replies.
app.post('/api/maintenance/test/owner-sms-flow', async (req, res) => {
  try {
    const testPhone = maintenanceOwnerSmsService?.normalizePhoneNumber?.(
      req.body?.phone || resolvePracticeTestPhone(req.body?.practiceTestPhone)
    ) || resolvePracticeTestPhone();
    const practiceTestPhone = resolvePracticeTestPhone(req.body?.practiceTestPhone || testPhone);

    if (!maintenanceOwnerSmsService?.isMaintenanceOwnerSmsEnabled?.()) {
      return res.status(503).json({
        ok: false,
        error: 'Maintenance owner SMS is not configured. Set Twilio credentials and TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID.',
      });
    }

    const requestId = req.body?.requestId || `test_sms_${Date.now()}`;
    const ownerId = req.body?.ownerId || 'test-owner-sms';
    const propertyAddress = req.body?.propertyAddress || '123 Test Property Ln, Potomac, MD 20854';
    const description = req.body?.description || 'Practice maintenance issue: kitchen sink is leaking under the cabinet.';
    const dispatchContext = {
      autoBook: true,
      trustedProvider: null,
      category: req.body?.category || 'plumbing',
      serviceType: req.body?.serviceType || 'plumbing',
      description,
      location: req.body?.location || 'Kitchen',
      propertyAddress,
      unit: req.body?.unit || '2B',
      tenantAvailability: req.body?.tenantAvailability || 'Weekdays after 5pm or weekends',
      tenantName: req.body?.tenantName || 'Test Tenant',
      tenantEmail: req.body?.tenantEmail || 'tenant@example.com',
      ownerId,
      propertyId: req.body?.propertyId || '586uaWuCbcZ8zRlE9sdJpqDf4JG2_MTE4MjIgUHJlc3R3aWNr',
      priority: req.body?.priority || 'high',
      createdAt: new Date().toISOString(),
    };

    const selectedProvider = {
      name: req.body?.providerName || 'ARI Plumbing (Practice Provider)',
      phone: req.body?.providerPhone || '+12404323005',
      rating: 4.9,
      reviewCount: 32,
      website: req.body?.providerWebsite || 'https://www.ariplumbing.com',
      aiScore: 92,
      address: '11816 Smoketree Rd, Potomac, MD 20854',
      selectionReasoning: 'Strong local plumbing reviews, reliable emergency response, and good fit for sink leak repairs.',
      isTrusted: false,
    };

    const maintenanceRequest = {
      id: requestId,
      firestoreId: requestId,
      ownerId,
      propertyId: dispatchContext.propertyId,
      propertyAddress,
      description,
      category: dispatchContext.category,
      priority: dispatchContext.priority,
      tenantName: dispatchContext.tenantName,
      tenantEmail: dispatchContext.tenantEmail,
      tenantAvailability: dispatchContext.tenantAvailability,
      practiceTestPhone,
      ownerSmsNotifications: {
        ownerPhone: testPhone,
        practiceTestPhone,
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
      },
      aiAutomation: {
        status: 'provider_found',
        selectedProvider,
        callInitiated: false,
        usedTrustedProvider: false,
      },
    };

    try {
      const { getFirestore } = await import('./firebase-admin.js');
      const db = getFirestore();
      await db.collection('maintenanceRequests').doc(requestId).set({
        id: requestId,
        ownerId,
        propertyAddress,
        description,
        category: dispatchContext.category,
        serviceType: dispatchContext.serviceType,
        priority: dispatchContext.priority,
        location: dispatchContext.location,
        unit: dispatchContext.unit,
        tenantName: dispatchContext.tenantName,
        tenantEmail: dispatchContext.tenantEmail,
        tenantAvailability: dispatchContext.tenantAvailability,
        practiceTestPhone,
        pendingDispatch: dispatchContext,
        activeDispatchContext: dispatchContext,
        ownerSmsNotifications: maintenanceRequest.ownerSmsNotifications,
        aiAutomation: maintenanceRequest.aiAutomation,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (firestoreError) {
      console.warn('[MAINTENANCE] Test SMS flow Firestore write failed:', firestoreError.message);
    }

    if (tenantActivityService?.updateMaintenanceRequestDetails) {
      await tenantActivityService.updateMaintenanceRequestDetails(requestId, {
        pendingDispatch: dispatchContext,
        activeDispatchContext: dispatchContext,
        ownerSmsNotifications: maintenanceRequest.ownerSmsNotifications,
        aiAutomation: maintenanceRequest.aiAutomation,
        status: 'pending',
      }).catch(() => {});
    }

    const smsResult = await maintenanceOwnerSmsService.sendMaintenanceOwnerProviderApprovalSms(maintenanceRequest);
    maintenanceAutomationStatus.set(requestId, maintenanceRequest);

    return res.json({
      ok: smsResult.ok,
      requestId,
      testPhone,
      sms: smsResult,
      practiceCallTarget: resolvePracticeTestPhone(req.body?.practiceTestPhone),
      instructions: [
        '1. Check your phone for the provider recommendation text.',
        '2. Reply YES to trigger a practice booking call to the test number (not the real provider).',
        '3. Reply NO to get another provider recommendation, or "No - Company Name 555-123-4567" to suggest one.',
      ],
      inboundWebhook: `${await resolveMaintenancePublicUrl(req) || process.env.PUBLIC_URL || 'YOUR_PUBLIC_URL'}/twilio/sms/inbound`,
      error: smsResult.error || null,
    });
  } catch (error) {
    console.error('[MAINTENANCE] Test owner SMS flow failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/maintenance/test/simulate-owner-reply
// Dev helper to simulate an inbound owner SMS reply without Twilio signature verification.
app.post('/api/maintenance/test/simulate-owner-reply', async (req, res) => {
  if (process.env.NODE_ENV === 'production' || process.env.K_SERVICE) {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }

  try {
    const from = maintenanceOwnerSmsService?.normalizePhoneNumber?.(
      req.body?.from || resolvePracticeTestPhone(req.body?.practiceTestPhone)
    );
    const body = req.body?.body || req.body?.message || 'YES';

    if (!maintenanceOwnerSmsService?.handleMaintenanceOwnerInboundSms) {
      return res.status(503).json({ ok: false, error: 'Maintenance owner SMS service unavailable' });
    }

    const result = await maintenanceOwnerSmsService.handleMaintenanceOwnerInboundSms({ from, body });
    let replyMessage = result.replyMessage || 'Thanks for your message.';

    if (result.shouldResumeAutomation && result.requestId) {
      await resumeMaintenanceDispatchAfterOwnerConfirm(result.requestId);
    }

    if (result.shouldBookProvider && result.requestId) {
      const bookResult = await bookMaintenanceAfterProviderApproval(
        result.requestId,
        result.alternateProvider || null,
      );
      const callResult = bookResult?.callResult || {};
      if (callResult.ok && !callResult.scheduled) {
        replyMessage = `${replyMessage} Your practice booking call is ringing now.`;
      } else if (callResult.scheduled) {
        replyMessage = `${replyMessage} Practice call queued for ${callResult.scheduledFor || 'later'}.`;
      } else {
        replyMessage = `${replyMessage} Call error: ${callResult.error || bookResult.error || 'unknown'}.`;
      }
    }

    if (result.shouldReselectProvider && result.requestId) {
      await reselectMaintenanceProviderAfterOwnerDecline(result.requestId);
    }

    if (maintenanceOwnerSmsService.sendOwnerInboundConfirmationSms) {
      await maintenanceOwnerSmsService.sendOwnerInboundConfirmationSms(from, replyMessage);
    }

    return res.json({ ok: true, result: { ...result, replyMessage } });
  } catch (error) {
    console.error('[MAINTENANCE] Simulate owner reply failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/maintenance/providers
// The persisted provider network for the map view, optionally scoped to a radius
// around one property and narrowed to a service category.
app.get('/api/maintenance/providers', async (req, res) => {
  try {
    const { category, status, lat, lng, radiusMiles, limit } = req.query;

    const result = await listProviders({
      category: category ? String(category) : null,
      status: status ? String(status) : null,
      lat: lat ?? null,
      lng: lng ?? null,
      radiusMiles: radiusMiles ?? null,
      limit: limit ? Number(limit) : 200,
    });

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    // Provider records created before geometry was carried through the Places
    // details response cannot be pinned. Backfill the small set returned to this
    // map request, then return the refreshed network so the first post-upgrade
    // map load repairs the old data as well.
    const coordinateBackfills = (result.providers || [])
      .filter((provider) => (
        provider?.placeId
        && (provider.lat === null || provider.lat === undefined || !Number.isFinite(Number(provider.lat))
          || provider.lng === null || provider.lng === undefined || !Number.isFinite(Number(provider.lng)))
      ))
      .slice(0, 20);

    if (coordinateBackfills.length && aiProviderSelector?.getProviderCoordinates) {
      await Promise.all(coordinateBackfills.map(async (provider) => {
        try {
          const coordinates = await aiProviderSelector.getProviderCoordinates(provider.placeId);
          if (coordinates.ok) {
            await updateProviderCoordinates(provider.id, {
              lat: coordinates.lat,
              lng: coordinates.lng,
            });
          }
        } catch (backfillError) {
          console.warn('[MAINTENANCE] Provider coordinate backfill failed:', provider.id, backfillError.message);
        }
      }));

      const refreshed = await listProviders({
        category: category ? String(category) : null,
        status: status ? String(status) : null,
        lat: lat ?? null,
        lng: lng ?? null,
        radiusMiles: radiusMiles ?? null,
        limit: limit ? Number(limit) : 200,
      });
      if (refreshed.ok) {
        return res.json({ ok: true, providers: refreshed.providers, total: refreshed.total });
      }
    }

    return res.json({ ok: true, providers: result.providers, total: result.total });
  } catch (error) {
    console.error('[MAINTENANCE] Provider network fetch failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/maintenance/properties/:propertyId/service-history
// Per-property maintenance history rolled up from the flat serviceRecords collection.
app.get('/api/maintenance/properties/:propertyId/service-history', async (req, res) => {
  try {
    const result = await getPropertyServiceHistory(req.params.propertyId, {
      limit: req.query.limit ? Number(req.query.limit) : 100,
    });

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    return res.json({ ok: true, records: result.records, summary: result.summary });
  } catch (error) {
    console.error('[MAINTENANCE] Service history fetch failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/maintenance/photos
// Uploads intake or service-record photos and returns durable URLs to attach to a ticket.
app.post('/api/maintenance/photos', async (req, res) => {
  try {
    const { requestId, ownerId, kind, photos } = req.body || {};

    const result = await uploadMaintenancePhotos({ requestId, ownerId, kind, photos });
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, errors: result.errors || [] });
    }

    // Append to the ticket when one already exists; intake uploads happen pre-submit.
    if (requestId && tenantActivityService?.getMaintenanceRequestById && tenantActivityService?.updateMaintenanceRequestDetails) {
      try {
        const existing = await tenantActivityService.getMaintenanceRequestById(requestId);
        if (existing.ok) {
          const current = Array.isArray(existing.request?.photos) ? existing.request.photos : [];
          await tenantActivityService.updateMaintenanceRequestDetails(requestId, {
            photos: [...current, ...result.photos],
          });
        }
      } catch (attachError) {
        console.warn('[MAINTENANCE] Photo attach failed:', attachError.message);
      }
    }

    return res.json({
      ok: true,
      photos: result.photos,
      errors: result.errors || [],
      storage: result.storage,
      limits: maintenancePhotoLimits,
    });
  } catch (error) {
    console.error('[MAINTENANCE] Photo upload error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Photo upload failed' });
  }
});

// POST /api/maintenance/submit
// Enhanced with AI provider selection automation pipeline
// Now supports trusted providers that skip AI search
app.post('/api/maintenance/submit', async (req, res) => {
  try {
    const { category, priority, description, location, tenantAvailability, propertyAddress, unit, autoBook, trustedProvider, tenantId, tenantEmail, tenantName, ownerId, propertyId, photos, triage, practiceTestPhone: rawPracticeTestPhone, intake, propertyAccess, availabilityWindows, submittedBy, sensorContext: rawSensorContext } = req.body;
    const practiceTestPhone = resolvePracticeSmsPhone(rawPracticeTestPhone);
    const practiceCallPhone = resolvePracticeCallPhone();
    const sensorContext = rawSensorContext && typeof rawSensorContext === 'object'
      ? {
          alertId: String(rawSensorContext.alertId || '').slice(0, 200),
          alertType: String(rawSensorContext.alertType || '').slice(0, 80),
          severity: String(rawSensorContext.severity || '').slice(0, 40),
          detectedAt: String(rawSensorContext.detectedAt || '').slice(0, 80),
          deviceId: String(rawSensorContext.deviceId || '').slice(0, 200),
          deviceName: String(rawSensorContext.deviceName || '').slice(0, 200),
          deviceModel: String(rawSensorContext.deviceModel || '').slice(0, 120),
          room: String(rawSensorContext.room || '').slice(0, 120),
          message: String(rawSensorContext.message || '').slice(0, 1000),
          readings: rawSensorContext.readings && typeof rawSensorContext.readings === 'object'
            ? rawSensorContext.readings
            : {},
        }
      : null;

    if (!category || !description) {
      return res.status(400).json({
        ok: false,
        error: 'Category and description are required'
      });
    }

    const serviceType = mapMaintenanceCategoryToServiceType(category);
    const maintenancePublicUrl = await resolveMaintenancePublicUrl(req);
    if (maintenancePublicUrl) {
      console.log('[MAINTENANCE] Voice webhook URL:', maintenancePublicUrl);
    } else {
      console.warn('[MAINTENANCE] No public voice webhook URL — auto-calls will fail until NGROK_URL, BACKEND_PUBLIC_URL, or a tunnel is configured');
    }

    // Create maintenance request record
    const maintenanceRequest = {
      id: `req_${Date.now()}`,
      category,
      serviceType,
      priority: priority || 'normal',
      description,
      location,
      tenantAvailability: tenantAvailability || formatAvailabilityWindows(availabilityWindows),
      availabilityWindows: Array.isArray(availabilityWindows) ? availabilityWindows : [],
      propertyAccess: propertyAccess || null,
      intake: intake || null,
      submittedBy: submittedBy || null,
      sensorContext,
      propertyAddress,
      unit,
      tenantName,
      tenantEmail,
      triage,
      practiceTestPhone,
      practiceCallPhone,
      status: 'submitted',
      createdAt: new Date().toISOString(),
      aiAutomation: {
        status: 'pending',
        ...(sensorContext?.alertId
          ? { triggeredBy: 'sensor_alert', sensorAlertId: sensorContext.alertId }
          : {}),
        providerSearch: null,
        selectedProvider: null,
        callInitiated: false,
        usedTrustedProvider: false
      }
    };

    // Store the request in the automation status map for tracking
    maintenanceAutomationStatus.set(maintenanceRequest.id, maintenanceRequest);

    console.log('[MAINTENANCE] New request submitted:', maintenanceRequest);
    
    // Owner-submitted tickets have no tenant, so ownerId alone is enough to persist.
    if (tenantActivityService?.saveMaintenanceRequest && ownerId) {
      try {
        const firestoreResult = await tenantActivityService.saveMaintenanceRequest({
          tenantId,
          tenantEmail,
          tenantName,
          ownerId,
          propertyId,
          propertyAddress,
          unit,
          serviceType,
          category,
          priority: priority || 'normal',
          location,
          description,
          tenantAvailability: tenantAvailability || '',
          photos: photos || [],
          triageSummary: triage?.ownerSummary || triage?.summary || '',
          triageTranscript: Array.isArray(triage?.transcript) ? triage.transcript : [],
          emergencyGuidance: triage?.emergencyGuidance || '',
          suggestedActions: Array.isArray(triage?.suggestedActions) ? triage.suggestedActions : [],
          liveAssistantSummary: triage?.liveAssistantSummary || '',
          applianceInfo: triage?.appliance || null,
          applianceTroubleshooting: triage?.applianceTroubleshooting || null,
          intake,
          propertyAccess,
          availabilityWindows,
          submittedBy
        });
        if (firestoreResult.ok) {
          console.log('[MAINTENANCE] ✅ Request saved to Firestore:', firestoreResult.requestId);
          maintenanceRequest.firestoreId = firestoreResult.requestId;
          if (tenantActivityService?.updateMaintenanceRequestDetails) {
            await tenantActivityService.updateMaintenanceRequestDetails(firestoreResult.requestId, {
              practiceTestPhone,
              practiceCallPhone,
              sensorContext,
              ...(sensorContext?.alertId
                ? {
                    aiAutomation: maintenanceRequest.aiAutomation,
                    source: 'sensor_alert',
                  }
                : {}),
            }).catch(() => {});
          }
        }
      } catch (fsError) {
        console.warn('[MAINTENANCE] Firestore save failed:', fsError.message);
      }
    }

    // A tenant-submitted ticket needs the owner to approve dispatch. An owner
    // submitting their own ticket has already made that approval decision, so
    // holding it for an owner SMS would dead-end provider search.
    const isOwnerSubmittedTicket = String(submittedBy?.role || '').toLowerCase() === 'owner';

    let holdForOwnerConfirm = false;
    if (
      maintenanceRequest.firestoreId
      && ownerId
      && !isOwnerSubmittedTicket
      && maintenanceOwnerSmsService?.sendOwnerConfirmationAndShouldHoldDispatch
    ) {
      try {
        const gate = await maintenanceOwnerSmsService.sendOwnerConfirmationAndShouldHoldDispatch({
          ...maintenanceRequest,
          id: maintenanceRequest.firestoreId,
          ownerId,
          propertyId,
          practiceTestPhone,
          category,
          serviceType,
          priority: priority || 'normal',
          description,
          location,
          propertyAddress,
          unit,
          tenantAvailability: tenantAvailability || '',
          tenantName,
          tenantEmail,
        });
        maintenanceRequest.ownerSmsResult = gate.ownerSmsResult;
        holdForOwnerConfirm = Boolean(gate.holdDispatch);
      } catch (smsError) {
        console.warn('[MAINTENANCE] Owner submission SMS gate failed:', smsError.message);
      }
    }

    console.log('[MAINTENANCE] Owner confirmation gate result:', {
      holdForOwnerConfirm,
      isOwnerSubmittedTicket,
      firestoreId: maintenanceRequest.firestoreId || null,
      ownerId: ownerId || null,
      trustedProvider: trustedProvider?.name || null,
    });

    const buildDispatchContext = () => ({
      autoBook: Boolean(autoBook),
      trustedProvider: trustedProvider || null,
      practiceTestPhone,
      practiceCallPhone,
      category,
      serviceType,
      description,
      location,
      propertyAddress,
      unit,
      tenantAvailability: tenantAvailability || '',
      tenantName,
      tenantEmail,
      ownerId,
      propertyId,
      priority: priority || 'normal',
      source: sensorContext ? 'sensor_alert' : 'owner_intake',
      sensorAlertId: sensorContext?.alertId || null,
      sensorType: sensorContext?.alertType || null,
      createdAt: new Date().toISOString(),
    });

    const returnAwaitingOwnerConfirmation = async (extraAutomation = {}) => {
      maintenanceRequest.aiAutomation = {
        ...maintenanceRequest.aiAutomation,
        status: 'awaiting_owner_confirmation',
        ...extraAutomation,
      };

      if (maintenanceRequest.firestoreId) {
        await persistMaintenancePendingDispatch(
          maintenanceRequest.firestoreId,
          maintenanceRequest,
          buildDispatchContext(),
        );
      }
      await syncMaintenanceAutomationToFirestore(maintenanceRequest);

      return res.json({
        ok: true,
        request: maintenanceRequest,
        awaitingOwnerConfirmation: true,
        message: 'Maintenance request submitted. Waiting for property owner SMS confirmation before calling the provider.',
        ownerSms: maintenanceRequest.ownerSmsResult?.confirmationState || null,
        aiAutomation: {
          enabled: true,
          status: 'awaiting_owner_confirmation',
          usedTrustedProvider: Boolean(trustedProvider),
        },
      });
    };

    // Check if a trusted provider was passed from the frontend
    if (trustedProvider && trustedProvider.name && trustedProvider.phone) {
      console.log('[MAINTENANCE-AI] ⭐ Using trusted provider:', trustedProvider.name);
      
      maintenanceRequest.aiAutomation.status = 'provider_found';
      maintenanceRequest.aiAutomation.usedTrustedProvider = true;
      maintenanceRequest.aiAutomation.selectedProvider = {
        name: trustedProvider.name,
        phone: trustedProvider.phone,
        rating: 5.0,  // Trusted providers get max rating by default
        aiScore: 100,
        address: '',
        isTrusted: true,
        trustedNote: trustedProvider.notes || `Pre-approved trusted provider for ${category}`
      };

      if (holdForOwnerConfirm) {
        console.log('[MAINTENANCE] Holding trusted provider dispatch until owner confirms by SMS');
        return await returnAwaitingOwnerConfirmation({
          usedTrustedProvider: true,
          selectedProvider: maintenanceRequest.aiAutomation.selectedProvider,
          callInitiated: false,
        });
      }

      // With auto-call gated off, this parks the ticket for operator dispatch instead.
      if (trustedProvider.phone && (autoBook || !isMaintenanceAutoCallEnabled())) {
        await dispatchTrustedProviderForMaintenance(
          maintenanceRequest,
          buildDispatchContext(),
          maintenancePublicUrl,
        );
      }

      // Return response with trusted provider info
      await syncMaintenanceAutomationToFirestore(maintenanceRequest);
      return res.json({
        ok: true,
        request: maintenanceRequest,
        message: 'Maintenance request submitted successfully (using trusted provider)',
        aiAutomation: {
          enabled: true,
          status: maintenanceRequest.aiAutomation.status,
          usedTrustedProvider: true
        }
      });
    }

    // Initiate AI automation pipeline if we have an address (no trusted provider)
    if (propertyAddress && aiProviderSelector) {
      if (holdForOwnerConfirm) {
        console.log('[MAINTENANCE] Holding AI provider dispatch until owner confirms by SMS');
        return await returnAwaitingOwnerConfirmation();
      }

      console.log('[MAINTENANCE-AI] Starting AI provider selection pipeline...');
      
      // Run AI automation in background (non-blocking)
      (async () => {
        try {
          await runMaintenanceAiPipelineForRequest(
            maintenanceRequest,
            buildDispatchContext(),
            maintenancePublicUrl,
          );
          console.log('[MAINTENANCE-AI] Automation pipeline completed:', maintenanceRequest.aiAutomation);
        } catch (aiError) {
          console.error('[MAINTENANCE-AI] Pipeline error:', aiError);
          maintenanceRequest.aiAutomation.status = 'error';
          maintenanceRequest.aiAutomation.error = aiError.message;
          await syncMaintenanceAutomationToFirestore(maintenanceRequest);
        }
      })();
    }

    // Return immediate response (AI automation runs in background)
    res.json({
      ok: true,
      request: maintenanceRequest,
      message: 'Maintenance request submitted successfully',
      aiAutomation: {
        enabled: !!propertyAddress && !!aiProviderSelector,
        status: propertyAddress ? 'processing' : 'disabled',
        note: propertyAddress 
          ? 'AI is searching for the best repair service provider' 
          : 'Provide property address to enable AI automation'
      }
    });
  } catch (error) {
    console.error('[MAINTENANCE] Submit error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to submit maintenance request'
    });
  }
});

// POST /api/maintenance/automation-status - Check AI automation status
app.post('/api/maintenance/automation-status', async (req, res) => {
  try {
    const { requestId } = req.body;
    
    if (!requestId) {
      return res.status(400).json({
        ok: false,
        error: 'Request ID is required'
      });
    }

    const status = maintenanceAutomationStatus.get(requestId);
    
    if (!status) {
      return res.json({
        ok: true,
        status: 'processing',
        message: 'AI automation is still processing'
      });
    }

    res.json({
      ok: true,
      ...status
    });
  } catch (error) {
    console.error('[MAINTENANCE] Status check error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to check automation status'
    });
  }
});

// GET /api/maintenance/requests - Get all maintenance requests with their automation status
app.get('/api/maintenance/requests', async (req, res) => {
  try {
    const { ownerId, propertyId } = req.query;

    if (ownerId) {
      if (!tenantActivityService?.getOwnerMaintenanceRequests) {
        return res.status(503).json({ ok: false, error: 'Tenant activity service not available' });
      }

      const persistedResult = await tenantActivityService.getOwnerMaintenanceRequests(ownerId, propertyId || null);
      if (!persistedResult.ok) {
        return res.status(500).json({ ok: false, error: persistedResult.error || 'Failed to fetch maintenance requests' });
      }

      // Recover owner-created tickets that older builds incorrectly parked behind
      // an owner-confirmation SMS. The next refresh reflects the search status.
      for (const request of persistedResult.requests || []) {
        recoverOwnerSubmittedDispatchIfNeeded(request);
      }

      const liveRequestsByFirestoreId = new Map();
      maintenanceAutomationStatus.forEach((value, key) => {
        if (value?.firestoreId) {
          liveRequestsByFirestoreId.set(value.firestoreId, {
            id: key,
            ...value,
          });
        }
      });

      const requests = (persistedResult.requests || []).map((request) => {
        const liveRequest = liveRequestsByFirestoreId.get(request.id);
        let fallbackAutomationStatus = 'pending';
        switch (request.status) {
          case 'in_progress':
            fallbackAutomationStatus = 'processing';
            break;
          case 'scheduled':
            fallbackAutomationStatus = 'scheduled';
            break;
          case 'completed':
            fallbackAutomationStatus = 'completed';
            break;
          default:
            fallbackAutomationStatus = 'pending';
            break;
        }

        return {
          id: request.id,
          category: request.category,
          serviceType: liveRequest?.serviceType || request.serviceType || String(request.category || 'general').toLowerCase(),
          priority: request.priority || 'normal',
          description: request.description,
          location: request.location || '',
          tenantAvailability: liveRequest?.tenantAvailability || request.tenantAvailability || '',
          propertyAddress: request.propertyAddress || '',
          unit: request.unit || '',
          status: request.status || 'pending',
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          tenantId: request.tenantId,
          tenantEmail: request.tenantEmail,
          tenantName: request.tenantName,
          ownerId: request.ownerId,
          propertyId: request.propertyId,
          contractorId: request.contractorId,
          contractorEmail: request.contractorEmail,
          contractorName: request.contractorName,
          contractorCompanyName: request.contractorCompanyName,
          contractorAssignment: request.contractorAssignment,
          serviceCompletion: request.serviceCompletion,
          serviceRecord: request.serviceRecord || null,
          outcome: request.outcome || null,
          triageSummary: request.triageSummary || '',
          paymentWorkflow: request.paymentWorkflow,
          scheduledVisit: request.scheduledVisit || null,
          callOutcome: request.callOutcome || null,
          ownerSmsNotifications: request.ownerSmsNotifications || null,
          ownerConfirmed: Boolean(request.ownerConfirmed),
          propertyAccess: request.propertyAccess || null,
          availabilityWindows: request.availabilityWindows || [],
          submittedBy: request.submittedBy || null,
          intake: request.intake || null,
          photos: Array.isArray(request.photos) ? request.photos : [],
          operatorLog: Array.isArray(request.operatorLog) ? request.operatorLog : [],
          firestoreId: request.id,
          aiAutomation: liveRequest?.aiAutomation || request.aiAutomation || {
            status: fallbackAutomationStatus,
            providerSearch: null,
            selectedProvider: null,
            callInitiated: false,
            usedTrustedProvider: false,
            error: null,
            callError: null
          },
        };
      });

      return res.json({
        ok: true,
        requests,
        ...getPracticeTestPhoneSettings(req.query?.practiceTestPhone),
        testPhoneNumber: resolvePracticeTestPhone(req.query?.practiceTestPhone),
      });
    }

    // Convert the Map to an array of requests
    const requests = [];
    maintenanceAutomationStatus.forEach((value, key) => {
      requests.push({
        id: key,
        ...value
      });
    });
    
    // Sort by createdAt descending (most recent first)
    requests.sort((a, b) => {
      const dateA = new Date(a.createdAt || 0);
      const dateB = new Date(b.createdAt || 0);
      return dateB.getTime() - dateA.getTime();
    });
    
    res.json({
      ok: true,
      requests,
      ...getPracticeTestPhoneSettings(req.query?.practiceTestPhone),
      testPhoneNumber: resolvePracticeTestPhone(req.query?.practiceTestPhone),
    });
  } catch (error) {
    console.error('[MAINTENANCE] Fetch requests error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch maintenance requests'
    });
  }
});

// GET /api/maintenance/requests/:requestId/call-transcript - Load provider call transcript for a request
app.get('/api/maintenance/requests/:requestId/call-transcript', async (req, res) => {
  try {
    const { requestId } = req.params;
    if (!requestId) {
      return res.status(400).json({ ok: false, error: 'Request ID is required' });
    }

    let callSid = '';
    let requestRecord = null;

    if (tenantActivityService?.getMaintenanceRequestById) {
      const persisted = await tenantActivityService.getMaintenanceRequestById(requestId);
      if (persisted.ok && persisted.request) {
        requestRecord = persisted.request;
        callSid = persisted.request.aiAutomation?.callDetails?.callSid
          || persisted.request.callOutcome?.callSid
          || '';
      }
    }

    if (!callSid) {
      for (const value of maintenanceAutomationStatus.values()) {
        if (value?.firestoreId === requestId || value?.id === requestId) {
          callSid = value.aiAutomation?.callDetails?.callSid || value.callOutcome?.callSid || '';
          requestRecord = requestRecord || value;
          break;
        }
      }
    }

    if (!callSid) {
      return res.json({
        ok: true,
        transcript: [],
        message: 'No call transcript is available for this request yet.'
      });
    }

    const { loadVoiceCallContext } = await import('./voice-call-context-store.js');
    const voiceData = await loadVoiceCallContext(callSid, { includeTranscript: true });
    const transcript = Array.isArray(voiceData?.transcript) ? voiceData.transcript : [];

    return res.json({
      ok: true,
      callSid,
      transcript,
      transcriptLineCount: transcript.length,
      requestId,
      providerName: requestRecord?.aiAutomation?.selectedProvider?.name || null
    });
  } catch (error) {
    console.error('[MAINTENANCE] Call transcript fetch error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch call transcript'
    });
  }
});

// POST /api/maintenance/trigger-automation - Manually trigger AI automation for an existing request
app.post('/api/maintenance/trigger-automation', async (req, res) => {
  try {
    const { category, description, propertyAddress, priority, location, unit, tenantAvailability, tenantName, tenantEmail, autoBook, firestoreId, ownerId } = req.body;

    if (!category || !description || !propertyAddress) {
      return res.status(400).json({
        ok: false,
        error: 'Category, description, and property address are required'
      });
    }

    const serviceType = mapMaintenanceCategoryToServiceType(category);
    const maintenancePublicUrl = await resolveMaintenancePublicUrl(req);

    if (!aiProviderSelector) {
      return res.status(500).json({
        ok: false,
        error: 'AI provider selector not available'
      });
    }

    console.log(`[MAINTENANCE-AI] Manual trigger: searching for ${serviceType} services near ${propertyAddress}...`);

    // Find best repair service using AI
    const aiResult = await aiProviderSelector.findBestRepairService({
      repairType: serviceType,
      serviceCategory: serviceType,
      location: propertyAddress,
      urgency: mapMaintenancePriorityToSearchUrgency(priority || 'normal'),
      issueDescription: description
    });

    if (!aiResult.ok || !aiResult.selected) {
      return res.json({
        ok: true,
        success: false,
        message: 'No suitable providers found',
        error: aiResult.error
      });
    }

    const selectedPhone = aiResult.selected.phone || aiResult.selected.formatted_phone_number;
    
    const response = {
      ok: true,
      success: true,
      selectedProvider: {
        name: aiResult.selected.name,
        phone: selectedPhone,
        rating: aiResult.selected.rating,
        reviewCount: aiResult.selected.user_ratings_total || aiResult.selected.reviewCount,
        address: aiResult.selected.address || aiResult.selected.formatted_address,
        aiAnalysis: aiResult.selected.reviewAnalysis
      },
      providerShortlist: buildProviderShortlist(aiResult),
      callScript: formatCallScript(aiResult.callScript),
      searchStats: {
        totalFound: aiResult.allCandidates?.length || 0,
        analyzedCount: aiResult.allCandidates?.length || 0
      },
      callInitiated: false
    };

    // If auto-booking is enabled, initiate voice call
    // Add deduplication check to prevent duplicate calls from submit + trigger-automation
    const triggerCallKey = `${propertyAddress}_${serviceType}_${Date.now() - (Date.now() % 60000)}`; // 1-minute window
    if (autoBook && isMaintenanceAutoCallEnabled() && voiceModule?.findProviderAndCall && selectedPhone) {
      // Check if a call is already in progress for this request
      if (activeCallsInProgress.has(triggerCallKey)) {
        console.log('[MAINTENANCE-AI] ⚠️ Call already in progress from submit, skipping duplicate trigger');
        response.callInitiated = false;
        response.callSkipped = true;
        response.callSkipReason = 'Call already initiated by submit endpoint';
      } else {
        activeCallsInProgress.set(triggerCallKey, true);
        // Auto-cleanup after 5 minutes
        setTimeout(() => activeCallsInProgress.delete(triggerCallKey), 5 * 60 * 1000);
        console.log('[MAINTENANCE-AI] Auto-booking: initiating voice call...');
        
        const issueDetails = await buildMaintenanceSchedulingContextForCall(
          firestoreId ? { firestoreId } : null,
          {
            category,
            serviceType,
            description,
            priority: priority || 'normal',
            location,
            propertyAddress,
            unit,
            tenantAvailability,
            tenantName,
            tenantEmail,
            ownerId,
            firestoreId
          }
        );

        const publicUrl = maintenancePublicUrl;
        if (!publicUrl) {
          console.error('[MAINTENANCE-AI] No public webhook URL configured for Twilio voice calls');
          response.callError = 'Phone calls need a public webhook URL. Start the app with a tunnel (npm run dev:tunnel) or set NGROK_URL / CLOUDFLARE_TUNNEL_URL.';
          activeCallsInProgress.delete(triggerCallKey);
        } else {
          try {
            const callResult = await executeMaintenanceProviderCall({
              maintenanceRequest: firestoreId ? { firestoreId } : {},
              propertyAddress,
              provider: aiResult.selected,
              callOptions: {
                repairType: serviceType,
                serviceCategory: serviceType,
                location: propertyAddress,
                urgency: mapMaintenancePriorityToSearchUrgency(priority || 'normal'),
                maintenanceContext: issueDetails,
                publicUrl: publicUrl,
                skipProviderSearch: true,
                preSelectedProvider: aiResult.selected
              }
            });

            if (callResult.ok || callResult.scheduled) {
              response.callInitiated = !callResult.scheduled;
              response.callDetails = callResult.scheduled
                ? { scheduledFor: callResult.scheduledFor, reason: callResult.reason }
                : {
                    callSid: callResult.call?.callSid,
                    providerPhone: selectedPhone,
                    initiatedAt: new Date().toISOString()
                  };
              if (callResult.scheduled) {
                console.log('[MAINTENANCE-AI] Voice call scheduled for business hours:', callResult.scheduledFor);
              } else {
                console.log('[MAINTENANCE-AI] Voice call initiated successfully');
              }
            } else {
              response.callError = callResult.error;
              activeCallsInProgress.delete(triggerCallKey);
            }
          } catch (callError) {
            console.error('[MAINTENANCE-AI] Voice call failed:', callError.message);
            response.callError = callError.message;
            activeCallsInProgress.delete(triggerCallKey);
          }
        }
      }
    }

    res.json(response);
  } catch (error) {
    console.error('[MAINTENANCE-AI] Trigger automation error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to trigger AI automation'
    });
  }
});

// POST /api/gmail/sync-token - Store Gmail access token from frontend for server-side use
app.post('/api/gmail/sync-token', async (req, res) => {
  try {
    const { accessToken, email, userId } = req.body;
    
    if (!accessToken || !email) {
      return res.status(400).json({
        ok: false,
        error: 'Access token and email are required'
      });
    }
    
    // Import the setUserGmailToken function
    const { setUserGmailToken } = await import('./appointments/gmailSend.js');
    
    // Store the token
    const userKey = userId || 'default';
    setUserGmailToken(userKey, accessToken, email);
    
    console.log(`[Gmail Sync] Token stored for user: ${userKey} (${email})`);
    
    res.json({
      ok: true,
      message: 'Gmail token synced successfully'
    });
  } catch (error) {
    console.error('[Gmail Sync] Error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to sync Gmail token'
    });
  }
});

// POST /api/tenant-messages/send
app.post('/api/tenant-messages/send', async (req, res) => {
  try {
    const { tenantId, tenantEmail, tenantName, ownerId, propertyId, propertyAddress, unit, message, subject } = req.body;

    if (!message || !tenantEmail) {
      return res.status(400).json({
        ok: false,
        error: 'Message and tenant email are required'
      });
    }

    const messageText = String(message || '').trim();

    function shouldAutoReplyToTenantMessage(text, subjectLine = '') {
      if (!text) return false;

      const combined = `${subjectLine} ${text}`.toLowerCase();

      const maintenanceOrUrgentSignals = [
        'leak', 'flood', 'water damage', 'no heat', 'no ac', 'no a/c', 'burst pipe', 'mold',
        'smoke', 'fire', 'gas', 'emergency', 'urgent', 'broken', 'not working', 'maintenance',
        'repair', 'electrical', 'outage', 'lock out', 'lockout', 'security issue'
      ];
      if (maintenanceOrUrgentSignals.some((token) => combined.includes(token))) return false;

      const legalOrLeaseSignals = [
        'eviction', 'lawsuit', 'legal', 'attorney', 'court', 'lease violation', 'notice to vacate'
      ];
      if (legalOrLeaseSignals.some((token) => combined.includes(token))) return false;

      return true;
    }

    async function generateTenantAutoReply({ tenantName: name, propertyAddress: address, messageBody }) {
      if (!GEMINI_API_KEY) {
        return `Thanks for your message${name ? `, ${name}` : ''}. We received your question and will follow up shortly if anything needs owner review.`;
      }

      const systemPrompt = `You are HouseYield's tenant support assistant. Write a concise, friendly reply to a general tenant question.\nRules:\n- 2-4 sentences max.\n- Helpful and practical, but do not promise actions requiring owner approval.\n- If uncertain, say you'll notify the property owner/manager.\n- Never provide legal advice.\n- Avoid mentioning AI.\n- Plain text only.`;

      const userPrompt = `Tenant name: ${name || 'Tenant'}\nProperty: ${address || 'N/A'}\nTenant message: ${messageBody}`;

      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      const geminiResult = await model.generateContent([
        `${systemPrompt}\n\n${userPrompt}`
      ]);

      const reply = geminiResult?.response?.text?.()?.trim();

      return reply ||
        `Thanks for your message${name ? `, ${name}` : ''}. We received your question and will follow up shortly.`;
    }

    async function scheduleTenantAutoReply({ originalMessageId, tenantId: tId, tenantEmail: tEmail, tenantName: tName, ownerId: oId, propertyId: pId, propertyAddress: pAddress, unit: tenantUnit, subjectLine, messageBody }) {
      const delayMs = 2 * 60 * 1000;

      setTimeout(async () => {
        try {
          const autoReply = await generateTenantAutoReply({
            tenantName: tName,
            propertyAddress: pAddress,
            messageBody
          });

          if (!tenantActivityService?.saveTenantMessage) return;

          await tenantActivityService.saveTenantMessage({
            tenantId: tId,
            tenantEmail: tEmail,
            tenantName: tName,
            ownerId: oId,
            propertyId: pId,
            propertyAddress: pAddress,
            unit: tenantUnit,
            subject: `Re: ${subjectLine || 'General Question'}`,
            message: autoReply,
            senderType: 'assistant',
            direction: 'inbound',
            inReplyTo: originalMessageId,
            ownerVisible: false,
            tenantVisible: true
          });

          console.log('[TENANT-MESSAGE] 🤖 Auto-reply sent for message:', originalMessageId);
        } catch (autoReplyError) {
          console.error('[TENANT-MESSAGE] Auto-reply failed:', autoReplyError?.message || autoReplyError);
        }
      }, delayMs);
    }

    const shouldAutoReply = shouldAutoReplyToTenantMessage(messageText, subject || '');

    // Save to Firestore if service is available
    if (tenantActivityService?.saveTenantMessage) {
      const result = await tenantActivityService.saveTenantMessage({
        tenantId,
        tenantEmail,
        tenantName,
        ownerId,
        propertyId,
        propertyAddress,
        unit,
        message: messageText,
        subject
      });
      
      if (result.ok) {
        console.log('[TENANT-MESSAGE] ✅ Message saved to Firestore:', result.messageId);

        if (shouldAutoReply) {
          console.log('[TENANT-MESSAGE] Auto-reply provider: Gemini (gemini-2.5-flash)');
          scheduleTenantAutoReply({
            originalMessageId: result.messageId,
            tenantId,
            tenantEmail,
            tenantName,
            ownerId,
            propertyId,
            propertyAddress,
            unit,
            subjectLine: subject,
            messageBody: messageText
          });
        }

        return res.json({
          ok: true,
          message: 'Message sent successfully',
          messageId: result.messageId,
          autoReplyScheduled: shouldAutoReply,
          autoReplyProvider: shouldAutoReply ? 'gemini-2.5-flash' : null
        });
      }
    }

    // Fallback: just log and acknowledge
    const messageRecord = {
      id: `msg_${Date.now()}`,
      tenantId,
      tenantEmail,
      tenantName,
      propertyAddress,
      unit,
      message,
      sentAt: new Date().toISOString()
    };

    console.log('[TENANT-MESSAGE] New message from tenant:', messageRecord);

    res.json({
      ok: true,
      message: 'Message sent successfully',
      messageId: messageRecord.id
    });
  } catch (error) {
    console.error('[TENANT-MESSAGE] Send error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to send message'
    });
  }
});

// GET /api/owner/messages - Get all messages for property owner
app.get('/api/owner/messages', async (req, res) => {
  try {
    const { ownerId, propertyId } = req.query;
    
    if (!ownerId) {
      return res.status(400).json({ ok: false, error: 'ownerId is required' });
    }
    
    if (!tenantActivityService?.getOwnerMessages) {
      return res.status(503).json({ ok: false, error: 'Tenant activity service not available' });
    }
    
    const result = await tenantActivityService.getOwnerMessages(ownerId, propertyId || null);
    res.json(result);
  } catch (error) {
    console.error('[OWNER-MESSAGES] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/owner/messages/send - Owner sends a message into the tenant portal inbox
app.post('/api/owner/messages/send', async (req, res) => {
  try {
    if (!tenantActivityService?.saveTenantMessage) {
      return res.status(503).json({ ok: false, error: 'Tenant activity service not available' });
    }

    const {
      ownerId,
      tenantId,
      tenantEmail,
      tenantName,
      propertyId,
      propertyAddress,
      unit,
      subject,
      message,
      body,
    } = req.body || {};

    const resolvedOwnerId = ownerId || req.user?.uid;
    const messageText = String(message || body || '').trim();

    if (!resolvedOwnerId) {
      return res.status(400).json({ ok: false, error: 'ownerId is required' });
    }
    if (!tenantId && !tenantEmail) {
      return res.status(400).json({ ok: false, error: 'tenantId or tenantEmail is required' });
    }
    if (!messageText) {
      return res.status(400).json({ ok: false, error: 'message is required' });
    }

    const result = await tenantActivityService.saveTenantMessage({
      tenantId: tenantId || null,
      tenantEmail: tenantEmail || '',
      tenantName: tenantName || 'Tenant',
      ownerId: resolvedOwnerId,
      propertyId: propertyId || null,
      propertyAddress: propertyAddress || '',
      unit: unit || '',
      subject: subject || 'Message from your property manager',
      message: messageText,
      senderType: 'owner',
      direction: 'outbound',
      ownerVisible: true,
      tenantVisible: true,
    });

    if (!result?.ok) {
      return res.status(500).json({ ok: false, error: result?.error || 'Failed to send message' });
    }

    res.json({
      ok: true,
      messageId: result.messageId,
      message: result.message,
    });
  } catch (error) {
    console.error('[OWNER-MESSAGES] Send error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// PUT /api/owner/messages/:messageId/read - Mark message as read
app.put('/api/owner/messages/:messageId/read', async (req, res) => {
  try {
    const { messageId } = req.params;
    
    if (!tenantActivityService?.markMessageRead) {
      return res.status(503).json({ ok: false, error: 'Tenant activity service not available' });
    }
    
    const result = await tenantActivityService.markMessageRead(messageId);
    res.json(result);
  } catch (error) {
    console.error('[OWNER-MESSAGES] Error marking read:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/owner/maintenance - Get all maintenance requests for property owner
app.get('/api/owner/maintenance', async (req, res) => {
  try {
    const { ownerId, propertyId } = req.query;
    
    if (!ownerId) {
      return res.status(400).json({ ok: false, error: 'ownerId is required' });
    }
    
    if (!tenantActivityService?.getOwnerMaintenanceRequests) {
      return res.status(503).json({ ok: false, error: 'Tenant activity service not available' });
    }
    
    const result = await tenantActivityService.getOwnerMaintenanceRequests(ownerId, propertyId || null);
    res.json(result);
  } catch (error) {
    console.error('[OWNER-MAINTENANCE] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// PUT /api/owner/maintenance/:requestId/status - Update maintenance request status
app.put('/api/owner/maintenance/:requestId/status', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { status, notes } = req.body;
    
    if (!tenantActivityService?.updateMaintenanceStatus) {
      return res.status(503).json({ ok: false, error: 'Tenant activity service not available' });
    }
    
    const result = await tenantActivityService.updateMaintenanceStatus(requestId, status, notes);
    res.json(result);
  } catch (error) {
    console.error('[OWNER-MAINTENANCE] Error updating status:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/owner/payments - Get payment history for property owner
app.get('/api/owner/payments', async (req, res) => {
  try {
    const { ownerId, propertyId } = req.query;
    
    if (!ownerId) {
      return res.status(400).json({ ok: false, error: 'ownerId is required' });
    }
    
    if (!tenantActivityService?.getOwnerPaymentHistory) {
      return res.status(503).json({ ok: false, error: 'Tenant activity service not available' });
    }
    
    const result = await tenantActivityService.getOwnerPaymentHistory(ownerId, propertyId || null);
    res.json(result);
  } catch (error) {
    console.error('[OWNER-PAYMENTS] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/tenant/:tenantId/upcoming-visits - Confirmed maintenance visits for tenant portal
app.get('/api/tenant/:tenantId/upcoming-visits', async (req, res) => {
  try {
    const { tenantId } = req.params;

    if (!tenantActivityService?.getTenantUpcomingMaintenanceVisits) {
      return res.status(503).json({ ok: false, error: 'Tenant activity service not available' });
    }

    const result = await tenantActivityService.getTenantUpcomingMaintenanceVisits(tenantId);
    res.json(result);
  } catch (error) {
    console.error('[TENANT-VISITS] Error:', error);
    res.status(500).json({ ok: false, error: error.message, visits: [] });
  }
});

// GET /api/tenant/:tenantId/activity - Get all activity for a specific tenant
app.get('/api/tenant/:tenantId/activity', async (req, res) => {
  try {
    const { tenantId } = req.params;
    
    if (!tenantActivityService?.getTenantActivity) {
      return res.status(503).json({ ok: false, error: 'Tenant activity service not available' });
    }
    
    const result = await tenantActivityService.getTenantActivity(tenantId);
    res.json(result);
  } catch (error) {
    console.error('[TENANT-ACTIVITY] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===== END AUTHENTICATION ENDPOINTS =====


// Property dashboard (ATTOM) proxy endpoint
// GET /api/attom/dashboard?address=123+Main+St+City+ST+00000
// Requires server env ATTOM_API_KEY. Returns { summary, tax_history, tax_meta, components? }
app.get('/api/attom/dashboard', async (req,res) => {
  try {
    const address = (req.query.address||'').toString().trim();
    const attomId = (req.query.id||'').toString().trim() || undefined;
    if (!address && !attomId) return res.status(400).json({ ok:false, error:'missing_address_or_id' });
    const rawParam = (req.query.raw||'').toString();
    const includeComponents = rawParam === '1' || req.query.components === '1' || rawParam === '2';
    const skipCache = req.query.skipCache === '1' || req.query.skipCache === 'true';
    const cacheOnlyMode = ['1', 'true', 'yes'].includes(String(process.env.ATTOM_CACHE_ONLY || '').toLowerCase());
    
    // Try Firestore cache first (90-day TTL per ATTOM data license)
    let dashboard = null;
    let fromCache = false;
    let cacheFallbackUsed = false;
    let cachedRecord = null;
    
    if (!skipCache) {
      const cached = address
        ? await getCachedAttomData(address)
        : await getCachedAttomDataById(attomId);
      cachedRecord = cached;

      const cachedUsable = isUsableAttomDashboardData(cached?.data);

      if (cached && !cached.stale && cachedUsable) {
        // Fresh cache hit — skip ATTOM API entirely
        dashboard = cached.data;
        fromCache = true;
        console.log(`[ATTOM] ✅ Using Firestore cache (${cached.ageDays}d old, limit ${90}d)`);
      } else if (cached && cached.stale && cachedUsable) {
        // Data exists but is >90 days old — return stale data immediately,
        // then kick off a background refresh to stay compliant
        dashboard = cached.data;
        fromCache = true;
        console.log(`[ATTOM] ⚠️ Stale cache (${cached.ageDays}d old) — returning & refreshing in background`);
        // Background refresh (fire-and-forget)
        fetchPropertyDashboard({ address: address||undefined, attomId, includeComponents: false })
          .then(fresh => {
            if (fresh && address) cacheAttomData(address, fresh);
          })
          .catch(err => console.error('[ATTOM] Background refresh failed:', err.message));
      } else if (cached && !cachedUsable) {
        console.warn(`[ATTOM] Ignoring incomplete Firestore cache entry for ${address || attomId}`);
      }
    }
    
    // Cache miss or skipCache — fetch from ATTOM API unless cache-only mode is active
    if (!dashboard && !cacheOnlyMode) {
      try {
        const fetchedDashboard = await fetchPropertyDashboard({ address: address||undefined, attomId, includeComponents, debugRaw: rawParam==='2' });
        const fetchedUsable = isUsableAttomDashboardData(fetchedDashboard);

        // Do not hard-fail the dashboard route when ATTOM returns partial data.
        // The frontend can still render with partial fields while other flows continue.
        if (!fetchedUsable) {
          console.warn('[ATTOM] ATTOM returned incomplete property data; returning partial dashboard payload');
        }

        dashboard = fetchedDashboard;
        
        // Store in Firestore cache for future lookups (90-day window)
        if (dashboard && address) {
          cacheAttomData(address, dashboard).catch(err =>
            console.error('[ATTOM] Cache write failed:', err.message)
          );
        }
      } catch (attomErr) {
        console.warn('[ATTOM] Live ATTOM fetch failed:', attomErr.message);
      }
    }

    // Final fallback: use any cached payload (even partial) so UI does not 500 on ATTOM rate limits.
    if (!dashboard && cachedRecord?.data) {
      dashboard = cachedRecord.data;
      fromCache = true;
      cacheFallbackUsed = true;
      console.warn('[ATTOM] Using partial cached payload due to live ATTOM unavailability');
    }

    if (!dashboard) {
      const modeMsg = cacheOnlyMode
        ? 'ATTOM cache-only mode enabled and no cached record found'
        : 'ATTOM data unavailable and no cached record found';
      return res.status(503).json({ ok: false, error: modeMsg, cacheOnlyMode });
    }
    
    // Log comprehensive property data to terminal
    console.log('\n' + '━'.repeat(80));
    console.log('🏠 PROPERTY SEARCH EXECUTED');
    console.log('━'.repeat(80));
    console.log('Address:', address || attomId);
    
    // Property Summary
    if (dashboard.summary) {
      console.log('\n📊 PROPERTY SUMMARY:');
      console.log('  ATTOM ID:', dashboard.summary.attom_id);
      console.log('  Beds:', dashboard.summary.beds, '| Baths:', dashboard.summary.baths);
      console.log('  Living Sq Ft:', dashboard.summary.living_sqft?.toLocaleString());
      console.log('  Year Built:', dashboard.summary.year_built, '| Age:', dashboard.summary.age, 'years');
      console.log('  Property Type:', dashboard.summary.property_type);
      console.log('  Lot Size:', dashboard.summary.lot_acres, 'acres');
    }
    
    // Valuation
    if (dashboard.summary?.avm_value || dashboard.summary?.assessed_value) {
      console.log('\n💰 VALUATION:');
      if (dashboard.summary.avm_value) {
        console.log('  AVM Value:', '$' + dashboard.summary.avm_value.toLocaleString());
        console.log('  AVM Range:', '$' + (dashboard.summary.avm_low?.toLocaleString() || 'N/A'), '-', '$' + (dashboard.summary.avm_high?.toLocaleString() || 'N/A'));
      }
      if (dashboard.summary.price_per_sqft) {
        console.log('  Price/Sq Ft:', '$' + dashboard.summary.price_per_sqft.toFixed(2));
      }
      if (dashboard.summary.assessed_value) {
        console.log('  Assessed Value:', '$' + dashboard.summary.assessed_value.toLocaleString());
      }
    }
    
    // Rental Estimate
    if (dashboard.summary?.rental_avm) {
      console.log('\n🏘️  RENTAL ESTIMATE:');
      console.log('  Monthly Rent:', '$' + dashboard.summary.rental_avm.toLocaleString());
      console.log('  Range:', '$' + (dashboard.summary.rental_avm_low?.toLocaleString() || 'N/A'), '-', '$' + (dashboard.summary.rental_avm_high?.toLocaleString() || 'N/A'));
    }
    
    // Location
    if (dashboard.summary?.latitude || dashboard.summary?.area_context) {
      console.log('\n📍 LOCATION:');
      if (dashboard.summary.latitude) {
        console.log('  Coordinates:', dashboard.summary.latitude + ',', dashboard.summary.longitude);
      }
      if (dashboard.summary.area_context) {
        console.log('  County:', dashboard.summary.area_context.county);
        console.log('  Municipality:', dashboard.summary.area_context.municipality);
        console.log('  Census Tract:', dashboard.summary.area_context.census_tract);
        console.log('  Zoning:', dashboard.summary.area_context.zoning);
      }
    }
    
    // Sale History
    if (dashboard.summary?.last_sale_date) {
      console.log('\n📈 SALE HISTORY:');
      console.log('  Last Sale:', dashboard.summary.last_sale_date, '-', dashboard.summary.last_sale_price ? '$' + dashboard.summary.last_sale_price.toLocaleString() : 'N/A');
    }
    
    // Tax History
    if (dashboard.tax_history?.length > 0) {
      console.log('\n🏛️  TAX HISTORY:', dashboard.tax_history.length, 'years');
      const latest = dashboard.tax_history[0];
      console.log('  Latest (' + latest.year + '):', latest.tax_amount ? '$' + latest.tax_amount.toLocaleString() : 'N/A');
      if (latest.cagr_pct) console.log('  Tax CAGR:', latest.cagr_pct.toFixed(2) + '%');
    }
    
    // AVM History
    if (dashboard.avm_history?.length > 0) {
      console.log('\n📊 AVM PRICE HISTORY:', dashboard.avm_history.length, 'records');
      const oldest = dashboard.avm_history[0];
      const newest = dashboard.avm_history[dashboard.avm_history.length - 1];
      console.log('  Oldest (' + oldest.date + '):', oldest.value ? '$' + oldest.value.toLocaleString() : 'N/A');
      console.log('  Newest (' + newest.date + '):', newest.value ? '$' + newest.value.toLocaleString() : 'N/A');
      if (oldest.value && newest.value) {
        const change = ((newest.value - oldest.value) / oldest.value * 100).toFixed(1);
        console.log('  Total Change:', change + '%');
      }
    }
    
    // Mortgage
    if (dashboard.summary?.mortgage) {
      console.log('\n🏦 MORTGAGE:');
      const m = dashboard.summary.mortgage;
      console.log('  Lender:', m.lender_name || 'N/A');
      console.log('  Amount:', m.amount ? '$' + m.amount.toLocaleString() : 'N/A', '| Type:', m.loan_type);
      console.log('  Date:', m.date, '| Term:', m.term_months, 'months');
      if (m.estimated_interest_rate) {
        console.log('  Est. Rate:', m.estimated_interest_rate.toFixed(3) + '%', '| Monthly P&I:', m.estimated_monthly_payment_pi ? '$' + m.estimated_monthly_payment_pi.toLocaleString() : 'N/A');
      }
      if (m.assumability) {
        console.log('  Assumable:', m.assumability.assumable, '| Attractiveness:', m.assumability.attractiveness);
      }
    }
    
    // Owner
    if (dashboard.summary?.owner) {
      console.log('\n👤 OWNER:');
      const o = dashboard.summary.owner;
      console.log('  Name:', o.owner1_name || 'N/A');
      console.log('  Corporate:', o.is_corporate ? 'Yes' : 'No', '| Absentee:', o.absentee_status || 'N/A');
    }
    
    // Environmental
    if (dashboard.environmental) {
      console.log('\n🌍 ENVIRONMENTAL RISKS:');
      console.log('  Flood:', dashboard.environmental.flood?.floodZone || 'N/A');
      console.log('  Fire:', dashboard.environmental.fire?.score || 'N/A');
      console.log('  Earthquake:', dashboard.environmental.earthquake?.score || 'N/A');
      if (dashboard.environmental.fire?.nasa_enhancement) {
        console.log('  NASA Active Fires:', dashboard.environmental.fire.nasa_enhancement.nearbyFireCount || 0);
        console.log('  Drought Level:', dashboard.environmental.fire.nasa_enhancement.droughtLevel || 'N/A');
      }
    }
    
    // Schools
    if (dashboard.schools?.length > 0 || dashboard.school_district) {
      console.log('\n🎓 SCHOOLS:', dashboard.schools?.length || 0, 'found');
      if (dashboard.school_district) {
        console.log('  District:', dashboard.school_district.name, '| Rating:', dashboard.school_district.rating || 'N/A');
      }
      if (dashboard.schools?.length > 0) {
        dashboard.schools.slice(0, 3).forEach((s, i) => {
          console.log('  ' + (i+1) + '.', s.name, '(' + s.level + ') - Rating:', s.rating || 'N/A');
        });
      }
    }
    
    // Building Permits
    if (dashboard.building_permits?.length > 0) {
      console.log('\n🔨 BUILDING PERMITS:', dashboard.building_permits.length, 'found');
      dashboard.building_permits.slice(0, 5).forEach((p, i) => {
        console.log('  ' + (i+1) + '.', p.permit_type || p.permit_type_description);
        console.log('     Date:', p.issue_date, '| Cost:', p.estimated_cost ? '$' + p.estimated_cost.toLocaleString() : 'N/A');
      });
    }
    
    // Parcel Geometry
    if (dashboard.parcel_geometry) {
      console.log('\n🗺️  PARCEL GEOMETRY:');
      console.log('  Type:', dashboard.parcel_geometry.type);
      console.log('  Has Boundary:', !!dashboard.parcel_geometry.coordinates);
    }
    
    console.log('\n' + '━'.repeat(80));
    console.log('✅ Property data extraction complete');
    if (fromCache) {
      console.log('📦 Source: CACHE');
    } else {
      console.log('🌐 Source: ATTOM API (cached for future use)');
    }
    console.log('━'.repeat(80) + '\n');
    
    // raw=2 -> attach limited raw component samples for debugging AVM paths
    if (rawParam === '2') {
      try {
        // Avoid huge payload: only include avm related and primary property node excerpts
        const payload = { ok:true, data: dashboard, fromCache, debugNote:'raw includes truncated raw JSON for selected components.' };
        return res.json(payload);
      } catch {}
    }
    res.json({
      ok: true,
      data: dashboard,
      fromCache,
      partialData: !isUsableAttomDashboardData(dashboard),
      cacheFallbackUsed,
      cacheOnlyMode,
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message || 'attom_failed' });
  }
});

// Community crime data endpoint (FBI UCR API with Firestore cache)
// GET /api/community/crime?fips=24031&state=MD&county=Montgomery
app.get('/api/community/crime', async (req, res) => {
  try {
    const fips = (req.query.fips || '').toString().trim();
    const stateCode = (req.query.state || '').toString().trim();
    const county = (req.query.county || '').toString().trim();
    if (!stateCode) {
      return res.status(400).json({ ok: false, error: 'missing_state' });
    }
    const data = await getCrimeDataForFips(fips, stateCode, county);
    if (!data) {
      return res.json({ ok: true, data: null, message: 'no_crime_data_available' });
    }
    res.json({ ok: true, data });
  } catch (e) {
    console.error('[Crime] Endpoint error:', e.message);
    res.status(500).json({ ok: false, error: e.message || 'crime_data_failed' });
  }
});

// Sales Comparables endpoint
// GET /api/attom/comparables?address=123+Main+St&radius=1.0&maxResults=10
app.get('/api/attom/comparables', async (req, res) => {
  try {
    const address = (req.query.address || '').toString().trim();
    if (!address) {
      return res.status(400).json({ ok: false, error: 'missing_address' });
    }

    const radius = parseFloat(req.query.radius) || 1.0;
    const maxResults = parseInt(req.query.maxResults) || 10;
    
    // Optional filters
    const options = {
      radius,
      maxResults,
      minBeds: req.query.minBeds ? parseInt(req.query.minBeds) : null,
      maxBeds: req.query.maxBeds ? parseInt(req.query.maxBeds) : null,
      minBaths: req.query.minBaths ? parseFloat(req.query.minBaths) : null,
      maxBaths: req.query.maxBaths ? parseFloat(req.query.maxBaths) : null,
      minSqft: req.query.minSqft ? parseInt(req.query.minSqft) : null,
      maxSqft: req.query.maxSqft ? parseInt(req.query.maxSqft) : null,
      minYearBuilt: req.query.minYearBuilt ? parseInt(req.query.minYearBuilt) : null,
      maxYearBuilt: req.query.maxYearBuilt ? parseInt(req.query.maxYearBuilt) : null
    };

    console.log('[API] Fetching sales comparables for:', address);
    const result = await fetchSalesComparables(address, options);

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    console.log(`[API] Returning ${result.comparables.length} comparables`);
    res.json({ ok: true, data: result.comparables });
  } catch (error) {
    console.error('[API] Error fetching comparables:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

function normalizeComparableAvmHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item?.date && Number.isFinite(Number(item?.value)))
    .map((item) => ({
      date: new Date(item.date),
      value: Number(item.value),
    }))
    .filter((item) => !Number.isNaN(item.date.getTime()))
    .sort((left, right) => left.date.getTime() - right.date.getTime());
}

function buildComparableAvmMeanHistory(dashboards) {
  const monthBuckets = new Map();

  (Array.isArray(dashboards) ? dashboards : []).forEach((dashboard) => {
    normalizeComparableAvmHistory(dashboard?.avm_history).forEach((point) => {
      const monthKey = `${point.date.getFullYear()}-${String(point.date.getMonth() + 1).padStart(2, '0')}-01`;
      const bucket = monthBuckets.get(monthKey) || { sum: 0, count: 0 };
      bucket.sum += point.value;
      bucket.count += 1;
      monthBuckets.set(monthKey, bucket);
    });
  });

  return Array.from(monthBuckets.entries())
    .map(([date, bucket]) => ({
      date,
      value: bucket.count > 0 ? Math.round(bucket.sum / bucket.count) : 0,
    }))
    .filter((point) => Number.isFinite(point.value) && point.value > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function getComparableMeanAvm(comparables) {
  const values = (Array.isArray(comparables) ? comparables : [])
    .map((comparable) => Number(comparable?.sale_price))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!values.length) {
    return null;
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// Cached AVM comparison-history endpoint
// GET /api/attom/avm-comparison-history?address=123+Main+St&radius=1.0&maxResults=6
app.get('/api/attom/avm-comparison-history', async (req, res) => {
  try {
    const address = (req.query.address || '').toString().trim();
    if (!address) {
      return res.status(400).json({ ok: false, error: 'missing_address' });
    }

    const radius = parseFloat(req.query.radius) || 1.0;
    const requestedMaxResults = parseInt(req.query.maxResults, 10);
    const maxResults = Number.isFinite(requestedMaxResults)
      ? Math.min(Math.max(requestedMaxResults, 3), 10)
      : 6;
    const forceRefresh = String(req.query.refresh || '').toLowerCase() === 'true';

    const cachedSubject = forceRefresh ? null : await getCachedAttomData(address);
    let subjectDashboard = cachedSubject?.data || null;
    const cachedComparableHistory = Array.isArray(subjectDashboard?.avm_comparable_history)
      ? subjectDashboard.avm_comparable_history.filter((item) => item?.date && Number.isFinite(Number(item?.value)))
      : [];

    if (!forceRefresh && cachedComparableHistory.length > 1) {
      return res.json({
        ok: true,
        data: {
          avm_comparable_history: cachedComparableHistory,
          avm_comparable_context: subjectDashboard?.avm_comparable_context || null,
        },
        source: 'firestore-cache',
        cachedAt: cachedSubject?.cachedAt || null,
      });
    }

    if (!subjectDashboard) {
      subjectDashboard = await fetchPropertyDashboard({ address, includeComponents: false });
      if (!subjectDashboard || !isUsableAttomDashboardData(subjectDashboard)) {
        return res.status(404).json({ ok: false, error: 'property_dashboard_unavailable' });
      }

      await cacheAttomData(address, subjectDashboard, subjectDashboard?.summary?.attom_id).catch((cacheError) => {
        console.warn('[ATTOM AVM Compare] Failed to cache subject dashboard:', cacheError?.message || cacheError);
      });
    }

    const comparableResult = await fetchSalesComparables(address, { radius, maxResults });
    if (!comparableResult?.ok) {
      if (cachedComparableHistory.length > 1) {
        return res.json({
          ok: true,
          data: {
            avm_comparable_history: cachedComparableHistory,
            avm_comparable_context: subjectDashboard?.avm_comparable_context || null,
          },
          source: 'firestore-cache-fallback',
          cachedAt: cachedSubject?.cachedAt || null,
        });
      }

      return res.status(500).json({ ok: false, error: comparableResult?.error || 'comparables_lookup_failed' });
    }

    const comparableAddresses = Array.from(
      new Set(
        comparableResult.comparables
          .map((comparable) => String(comparable?.address || '').trim())
          .filter(Boolean)
      )
    )
      .filter((comparableAddress) => comparableAddress.toLowerCase() !== address.toLowerCase())
      .slice(0, maxResults);

    const comparableDashboards = [];

    for (const comparableAddress of comparableAddresses) {
      const cachedComparable = await getCachedAttomData(comparableAddress);
      let comparableDashboard = cachedComparable?.data || null;

      if (!Array.isArray(comparableDashboard?.avm_history) || comparableDashboard.avm_history.length < 2) {
        comparableDashboard = await fetchPropertyDashboard({ address: comparableAddress, includeComponents: false });

        if (comparableDashboard && isUsableAttomDashboardData(comparableDashboard)) {
          await cacheAttomData(comparableAddress, comparableDashboard, comparableDashboard?.summary?.attom_id).catch((cacheError) => {
            console.warn('[ATTOM AVM Compare] Failed to cache comparable dashboard:', comparableAddress, cacheError?.message || cacheError);
          });
        }
      }

      if (Array.isArray(comparableDashboard?.avm_history) && comparableDashboard.avm_history.length > 0) {
        comparableDashboards.push(comparableDashboard);
      }
    }

    const comparableHistory = buildComparableAvmMeanHistory(comparableDashboards);
    if (!comparableHistory.length) {
      if (cachedComparableHistory.length > 1) {
        return res.json({
          ok: true,
          data: {
            avm_comparable_history: cachedComparableHistory,
            avm_comparable_context: subjectDashboard?.avm_comparable_context || null,
          },
          source: 'firestore-cache-fallback',
          cachedAt: cachedSubject?.cachedAt || null,
        });
      }

      return res.status(404).json({ ok: false, error: 'avm_comparison_history_unavailable' });
    }

    const comparisonPayload = {
      avm_comparable_history: comparableHistory,
      avm_comparable_context: {
        comparableCount: comparableDashboards.length,
        comparableAddresses: comparableAddresses.slice(0, 10),
        currentMeanAvm: getComparableMeanAvm(comparableResult.comparables)
          || comparableHistory[comparableHistory.length - 1]?.value
          || null,
        generatedAt: new Date().toISOString(),
        maxResults,
        radiusMiles: radius,
        source: 'ATTOM AVM comparables',
      },
    };

    await cacheAttomData(
      address,
      {
        ...subjectDashboard,
        ...comparisonPayload,
      },
      subjectDashboard?.summary?.attom_id,
    ).catch((cacheError) => {
      console.warn('[ATTOM AVM Compare] Failed to cache comparable mean history:', cacheError?.message || cacheError);
    });

    res.json({ ok: true, data: comparisonPayload, source: 'attom-live' });
  } catch (error) {
    console.error('[API] Error fetching AVM comparison history:', error);
    res.status(500).json({ ok: false, error: error.message || 'avm_comparison_history_failed' });
  }
});

// ATTOM Firestore cache management endpoints
// GET /api/attom/cache/stats - Cache statistics (90-day TTL)
app.get('/api/attom/cache/stats', async (req, res) => {
  try {
    const stats = await getAttomCacheStats();
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'cache_stats_failed' });
  }
});

// GET /api/attom/cache/list - List all cached entries with age
app.get('/api/attom/cache/list', async (req, res) => {
  try {
    const entries = await listAttomCache();
    res.json({ ok: true, entries, count: entries.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'cache_list_failed' });
  }
});

// POST /api/attom/cache/clear - Clear expired entries (>90 days) for ATTOM compliance
app.post('/api/attom/cache/clear', async (req, res) => {
  try {
    const removed = await purgeExpiredAttomCache();
    res.json({ ok: true, removed, message: `Purged ${removed} entries older than 90 days` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'cache_clear_failed' });
  }
});

// POST /api/attom/cache/clear-all - Nuclear option: clear ALL cached ATTOM data
app.post('/api/attom/cache/clear-all', async (req, res) => {
  try {
    const removed = await clearAllAttomCache();
    res.json({ ok: true, removed, message: `Cleared all ${removed} ATTOM cache entries` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'cache_clear_all_failed' });
  }
});

// POST /api/attom/cache/refresh-stale - Re-fetch ATTOM data for entries nearing expiry
// Refreshes entries older than `thresholdDays` (default 80) so they don't expire at 90
app.post('/api/attom/cache/refresh-stale', async (req, res) => {
  try {
    const thresholdDays = parseInt(req.query.thresholdDays || '80', 10);
    const entries = await listAttomCache();
    const staleEntries = entries.filter(e => e.ageDays >= thresholdDays && e.address);
    
    // Deduplicate by address (we store both address-keyed and attomId-keyed docs)
    const seen = new Set();
    const toRefresh = staleEntries.filter(e => {
      if (seen.has(e.address)) return false;
      seen.add(e.address);
      return true;
    });
    
    console.log(`[ATTOM Cache] Refreshing ${toRefresh.length} entries older than ${thresholdDays}d`);
    
    let refreshed = 0;
    let failed = 0;
    
    // Process sequentially to avoid hammering the ATTOM API
    for (const entry of toRefresh) {
      try {
        const fresh = await fetchPropertyDashboard({ address: entry.address });
        if (fresh) {
          await cacheAttomData(entry.address, fresh);
          refreshed++;
          console.log(`[ATTOM Cache] ✅ Refreshed: ${entry.address}`);
        }
        // Small delay between API calls to be respectful
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        failed++;
        console.warn(`[ATTOM Cache] ❌ Failed to refresh ${entry.address}:`, err.message);
      }
    }
    
    res.json({
      ok: true,
      thresholdDays,
      found: toRefresh.length,
      refreshed,
      failed,
      message: `Refreshed ${refreshed}/${toRefresh.length} stale entries`
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'cache_refresh_failed' });
  }
});

// ============================================================================
// ABSENTEE OWNER SEARCH - Find off-market investment opportunities
// ============================================================================

// GET /api/attom/absentee-search - Search for absentee owner properties in an area
// Query params:
//   preset: Market preset id (e.g. umd_college_park)
//   zips: Comma-separated ZIP codes for batch search
//   searchMode: radius | zips | county (used with preset)
//   zipCode: ZIP code to search (e.g., "20854")
//   county: County FIPS code (alternative to ZIP)
//   lat/lng/radius: Coordinate-based search with radius in miles
//   enrich: true to enrich top leads with RentCast + leak risk scoring
//   enrichLimit: Max leads to enrich (default 25)
//   likelyRentalsOnly: true to filter enriched leads with rentalConfidence >= 60
//   autoSave: true (default) to upsert qualified leads into absentee_leads / campaign queue
//   campaignName: Campaign name used when autoSave is enabled
//   minValue/maxValue: Property value range
//   minSqft/maxSqft: Square footage range
//   minYearsOwned: Filter for long-term owners (tired landlords)
//   corporateOnly: Only corporate owners (true/false)
//   freeAndClear: Only properties without mortgages (true/false)
//   propertyType: SFR, CONDO, MFR, etc.
//   pageSize/page: Pagination
async function finalizeAbsenteeSearchPayload({
  properties = [],
  totalFound = 0,
  page = 1,
  pageSize = 100,
  searchCriteria = {},
  cache = {},
  enrichRequested = false,
  enrichLimit = 25,
  includeTaxOverAssessment = false,
  likelyRentalsOnly = false,
  autoSave = true,
  campaignName = 'default',
}) {
  let props = properties;
  let enrichmentMeta = null;
  let persistMeta = null;

  if (enrichRequested && props.length) {
    const { enrichAbsenteeLeads } = await import('./services/leadEnrichmentService.js');
    const enriched = await enrichAbsenteeLeads(props, {
      limit: enrichLimit,
      includeRentcast: true,
      includeLeakRisk: true,
      // Tax analysis is API-heavy (comp AVMs) — opt-in, capped via enrichLimit
      includeTaxOverAssessment,
      maxTaxCompAvms: 5,
      sortBy: 'protectionLeadScore',
    });
    props = enriched.leads;
    enrichmentMeta = {
      enrichedCount: enriched.enrichedCount,
      enrichLimit: enriched.limit,
      enrichmentCacheHits: enriched.enrichmentCacheHits || 0,
      includeTaxOverAssessment,
    };
  }

  if (likelyRentalsOnly) {
    props = props.filter((lead) => (lead.rentalConfidence || 0) >= 60);
  }

  if (autoSave && props.length) {
    try {
      const { persistAbsenteeLeads } = await import('./services/absenteeLeadPersistService.js');
      const saved = await persistAbsenteeLeads(props, campaignName);
      persistMeta = {
        saved: saved.saved,
        inserted: saved.inserted,
        updated: saved.updated,
        campaignName: saved.campaignName,
      };
      console.log(`[API] Auto-saved ${saved.saved} absentee leads to campaign "${saved.campaignName}"`);
    } catch (err) {
      console.warn('[API] Auto-save leads failed:', err.message);
      persistMeta = { error: err.message };
    }
  }

  return {
    ok: true,
    properties: props,
    totalFound,
    totalQualified: props.length,
    page,
    pageSize,
    searchCriteria,
    enrichment: enrichmentMeta,
    persist: persistMeta,
    cache: {
      ...(cache || {}),
      enrichmentCacheHits: enrichmentMeta?.enrichmentCacheHits || 0,
    },
  };
}

app.get('/api/attom/absentee-search', requireInternalStaff, async (req, res) => {
  try {
    const presetId = req.query.preset ? String(req.query.preset) : null;
    const searchMode = req.query.searchMode ? String(req.query.searchMode) : 'radius';
    const zipsParam = req.query.zips ? String(req.query.zips) : null;
    const enrichRequested = req.query.enrich === 'true';
    const enrichLimit = req.query.enrichLimit ? parseInt(req.query.enrichLimit) : 25;
    const includeTaxOverAssessment = req.query.includeTaxOverAssessment === 'true'
      || req.query.taxOverAssessment === 'true';
    const likelyRentalsOnly = req.query.likelyRentalsOnly === 'true';
    const autoSave = req.query.autoSave !== 'false';
    const campaignName = req.query.campaignName
      ? String(req.query.campaignName)
      : (presetId ? `${presetId} Remote Protection` : `Search-${new Date().toISOString().slice(0, 10)}`);

    const options = {
      zipCode: req.query.zipCode || req.query.zip || null,
      county: req.query.county || req.query.countyfips || null,
      latitude: req.query.lat ? parseFloat(req.query.lat) : null,
      longitude: req.query.lng ? parseFloat(req.query.lng) : null,
      radius: req.query.radius ? parseFloat(req.query.radius) : 5,
      minValue: req.query.minValue ? parseInt(req.query.minValue) : null,
      maxValue: req.query.maxValue ? parseInt(req.query.maxValue) : null,
      minSqft: req.query.minSqft ? parseInt(req.query.minSqft) : null,
      maxSqft: req.query.maxSqft ? parseInt(req.query.maxSqft) : null,
      minYearsOwned: req.query.minYearsOwned ? parseInt(req.query.minYearsOwned) : null,
      corporateOnly: req.query.corporateOnly === 'true',
      individualsOnly: req.query.individualsOnly === 'true',
      freeAndClear: req.query.freeAndClear === 'true',
      outOfStateOnly: req.query.outOfStateOnly === 'true',
      propertyType: req.query.propertyType && req.query.propertyType !== 'ALL'
        ? String(req.query.propertyType)
        : null,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize) : 100,
      page: req.query.page ? parseInt(req.query.page) : 1,
      skipCache: req.query.skipCache === 'true' || req.query.refresh === 'true',
    };

    const finalizeOpts = {
      enrichRequested,
      enrichLimit,
      includeTaxOverAssessment,
      likelyRentalsOnly,
      autoSave,
      campaignName,
    };

    if (presetId) {
      const { getLeadMarketPreset, resolvePresetSearchPlans } = await import('./config/leadMarketPresets.js');
      const preset = getLeadMarketPreset(presetId);
      if (!preset) {
        return res.status(400).json({ ok: false, error: `Unknown preset: ${presetId}` });
      }

      const presetDefaults = preset.defaultFilters || {};
      if (req.query.propertyType && req.query.propertyType !== 'ALL') {
        options.propertyType = String(req.query.propertyType);
      } else if (presetDefaults.propertyType && presetDefaults.propertyType !== 'ALL') {
        options.propertyType = presetDefaults.propertyType;
      } else {
        options.propertyType = null;
      }
      if (req.query.outOfStateOnly === undefined && presetDefaults.outOfStateOnly !== undefined) {
        options.outOfStateOnly = presetDefaults.outOfStateOnly;
      }
      if (req.query.individualsOnly === undefined && presetDefaults.individualsOnly !== undefined) {
        options.individualsOnly = !!presetDefaults.individualsOnly;
      }
      if (req.query.corporateOnly === undefined && presetDefaults.corporateOnly !== undefined) {
        options.corporateOnly = !!presetDefaults.corporateOnly;
      }
      if (req.query.minYearsOwned !== undefined && req.query.minYearsOwned !== '') {
        options.minYearsOwned = parseInt(String(req.query.minYearsOwned), 10);
      } else if (presetDefaults.minYearsOwned) {
        options.minYearsOwned = presetDefaults.minYearsOwned;
      } else {
        options.minYearsOwned = null;
      }

      const searchPlans = resolvePresetSearchPlans(presetId, searchMode);
      if (!searchPlans?.length) {
        return res.status(400).json({ ok: false, error: 'Preset has no search geography configured' });
      }

      console.log('[API] Absentee owner batch search via preset:', presetId, searchPlans);
      const batchResult = await searchAbsenteeOwnersBatch(searchPlans, options);
      if (!batchResult.ok) {
        return res.status(500).json({ ok: false, error: batchResult.error || 'Batch search failed' });
      }

      const payload = await finalizeAbsenteeSearchPayload({
        properties: batchResult.properties || [],
        totalFound: batchResult.totalFound,
        page: batchResult.page,
        pageSize: batchResult.pageSize,
        searchCriteria: { ...options, preset: presetId, searchMode },
        cache: batchResult.cache,
        ...finalizeOpts,
      });
      console.log(`[API] Absentee preset search returned ${payload.totalQualified} qualified leads`);
      return res.json(payload);
    }

    if (zipsParam) {
      const zipList = zipsParam.split(',').map((zip) => zip.trim()).filter(Boolean);
      if (!zipList.length) {
        return res.status(400).json({ ok: false, error: 'No valid ZIP codes provided' });
      }

      const searchPlans = zipList.map((zipCode) => ({ zipCode }));
      console.log('[API] Absentee owner batch search via ZIP list:', zipList);
      const batchResult = await searchAbsenteeOwnersBatch(searchPlans, options);
      if (!batchResult.ok) {
        return res.status(500).json({ ok: false, error: batchResult.error || 'Batch search failed' });
      }

      return res.json(await finalizeAbsenteeSearchPayload({
        properties: batchResult.properties || [],
        totalFound: batchResult.totalFound,
        page: batchResult.page,
        pageSize: batchResult.pageSize,
        searchCriteria: { ...options, zips: zipList },
        cache: batchResult.cache,
        ...finalizeOpts,
      }));
    }

    // Validate that we have at least one geographic filter
    if (!options.zipCode && !options.county && !(options.latitude && options.longitude)) {
      return res.status(400).json({
        ok: false,
        error: 'Must provide zipCode, county, lat/lng coordinates, zips, or preset'
      });
    }

    console.log('[API] Absentee owner search with options:', options);
    const result = await searchAbsenteeOwners(options);

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    const payload = await finalizeAbsenteeSearchPayload({
      properties: result.properties || [],
      totalFound: result.totalFound,
      page: result.page,
      pageSize: result.pageSize,
      searchCriteria: result.searchCriteria,
      cache: result.cache,
      ...finalizeOpts,
    });
    console.log(`[API] Absentee search returned ${payload.totalQualified} qualified leads`);
    res.json(payload);
  } catch (error) {
    console.error('[API] Absentee search error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/attom/absentee-detail?address=... - Get detailed analysis for a single property
app.get('/api/attom/absentee-detail', requireInternalStaff, async (req, res) => {
  try {
    const address = (req.query.address || '').toString().trim();
    const attomId = req.query.id || req.query.attomId;
    
    if (!address && !attomId) {
      return res.status(400).json({ ok: false, error: 'missing_address_or_id' });
    }

    console.log('[API] Absentee detail for:', address || attomId);
    const result = await getAbsenteePropertyDetails(address || attomId);

    if (!result.ok) {
      return res.status(404).json({ ok: false, error: result.error });
    }

    res.json({
      ok: true,
      property: result.property
    });
  } catch (error) {
    console.error('[API] Absentee detail error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// ASSUMABLE MORTGAGE SCANNER API
// Bulk scan ZIP codes for FHA/VA/USDA assumable mortgages
// Prioritizes multifamily (2-4 units) with low-rate government loans
// ============================================================================

// GET /api/attom/assumable-scan - Scan for assumable mortgage deals
// Query params:
//   zipCode: ZIP code to scan
//   county: County FIPS code
//   lat/lng/radius: Coordinate search
//   propertyTypes: Comma-separated (SFR,MFR) - default: SFR,MFR
//   minRateSavings: Min rate savings vs current (default 0.5)
//   minBalance: Min remaining loan balance (default 50000)
//   maxPages: Max pages to scan (default 5 = 500 properties)
//   originatedAfter: Only loans after this date (default 2019-01-01)
//   originatedBefore: Only loans before this date (default 2024-01-01)
//   sortBy: tier|rateSavings|balance|monthlySavings
app.get('/api/attom/assumable-scan', async (req, res) => {
  try {
    const options = {
      zipCode: req.query.zipCode || req.query.zip,
      county: req.query.county || req.query.countyfips,
      latitude: req.query.lat ? parseFloat(req.query.lat) : null,
      longitude: req.query.lng ? parseFloat(req.query.lng) : null,
      radius: req.query.radius ? parseFloat(req.query.radius) : 5,
      propertyTypes: req.query.propertyTypes ? req.query.propertyTypes.split(',') : ['SFR', 'MFR'],
      minRateSavings: req.query.minRateSavings ? parseFloat(req.query.minRateSavings) : 0.5,
      minBalance: req.query.minBalance ? parseInt(req.query.minBalance) : 50000,
      maxPages: req.query.maxPages ? parseInt(req.query.maxPages) : 5,
      originatedAfter: req.query.originatedAfter || '2019-01-01',
      originatedBefore: req.query.originatedBefore || '2024-01-01',
      sortBy: req.query.sortBy || 'tier'
    };

    if (!options.zipCode && !options.county && !(options.latitude && options.longitude)) {
      return res.status(400).json({
        ok: false,
        error: 'Must provide zipCode, county, or lat/lng coordinates'
      });
    }

    console.log('[API] Assumable mortgage scan with options:', options);
    const result = await scanAssumableMortgages(options);

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    console.log(`[API] Assumable scan found ${result.deals.length} deals from ${result.stats.totalScanned} scanned`);
    res.json(result);
  } catch (error) {
    console.error('[API] Assumable scan error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// SNOWFLAKE MLS PROPERTY SEARCH API
// ============================================================================

// GET /api/snowflake/properties - Search MLS properties with filters
app.get('/api/snowflake/properties', async (req, res) => {
  try {
    const filters = {
      city: req.query.city?.toString().trim() || null,
      state: req.query.state?.toString().trim() || null,
      zip: req.query.zip?.toString().trim() || null,
      minPrice: req.query.minPrice ? parseInt(req.query.minPrice) : null,
      maxPrice: req.query.maxPrice ? parseInt(req.query.maxPrice) : null,
      minBeds: req.query.minBeds ? parseInt(req.query.minBeds) : null,
      maxBeds: req.query.maxBeds ? parseInt(req.query.maxBeds) : null,
      minBaths: req.query.minBaths ? parseInt(req.query.minBaths) : null,
      maxBaths: req.query.maxBaths ? parseInt(req.query.maxBaths) : null,
      propertyType: req.query.propertyType?.toString().trim() || null,
      propertySubtype: req.query.propertySubtype?.toString().trim() || null,
      status: req.query.status?.toString().trim() || 'Active',
      minSqft: req.query.minSqft ? parseInt(req.query.minSqft) : null,
      maxSqft: req.query.maxSqft ? parseInt(req.query.maxSqft) : null,
      minYearBuilt: req.query.minYearBuilt ? parseInt(req.query.minYearBuilt) : null,
      maxYearBuilt: req.query.maxYearBuilt ? parseInt(req.query.maxYearBuilt) : null,
      minLotSize: req.query.minLotSize ? parseInt(req.query.minLotSize) : null,
      maxLotSize: req.query.maxLotSize ? parseInt(req.query.maxLotSize) : null,
      limit: Math.min(parseInt(req.query.limit) || 50, 200),
      offset: parseInt(req.query.offset) || 0
    };

    console.log('[Snowflake API] Searching properties with filters:', filters);
    
    const properties = await snowflake.searchMLSPropertiesWithImages(filters);
    
    console.log(`[Snowflake API] Found ${properties.length} properties`);
    
    res.json({ 
      ok: true, 
      data: properties,
      count: properties.length,
      filters
    });
  } catch (error) {
    console.error('[Snowflake API] Search error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/snowflake/properties/:listingKey - Get single property with all images
app.get('/api/snowflake/properties/:listingKey', async (req, res) => {
  try {
    const listingKey = req.params.listingKey;
    if (!listingKey) {
      return res.status(400).json({ ok: false, error: 'Missing listing key' });
    }

    console.log('[Snowflake API] Fetching property:', listingKey);
    
    const property = await snowflake.getMLSPropertyWithImages(listingKey);
    
    if (!property) {
      return res.status(404).json({ ok: false, error: 'Property not found' });
    }
    
    // Also fetch rooms and open houses
    const [rooms, openHouses] = await Promise.all([
      snowflake.getPropertyRooms(listingKey).catch(() => []),
      snowflake.getPropertyOpenHouses(listingKey).catch(() => [])
    ]);
    
    res.json({ 
      ok: true, 
      data: {
        ...property,
        rooms,
        openHouses
      }
    });
  } catch (error) {
    console.error('[Snowflake API] Property fetch error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/snowflake/stats - Get available cities, statuses, property types
app.get('/api/snowflake/stats', async (req, res) => {
  try {
    console.log('[Snowflake API] Fetching stats...');
    
    // Get distinct cities, statuses, types, subtypes, and states with counts
    const [citiesData, statusesData, typesData, subtypesData, statesData] = await Promise.all([
      snowflake.executeQuery(`
        SELECT "CITY", "STATEORPROVINCE", COUNT(*) as cnt 
        FROM "Property" 
        WHERE "CITY" IS NOT NULL
        GROUP BY "CITY", "STATEORPROVINCE"
        ORDER BY cnt DESC 
        LIMIT 100
      `),
      snowflake.executeQuery(`
        SELECT "STANDARDSTATUS", COUNT(*) as cnt 
        FROM "Property" 
        GROUP BY "STANDARDSTATUS" 
        ORDER BY cnt DESC
      `),
      snowflake.executeQuery(`
        SELECT "PROPERTYTYPE", COUNT(*) as cnt 
        FROM "Property" 
        WHERE "PROPERTYTYPE" IS NOT NULL
        GROUP BY "PROPERTYTYPE" 
        ORDER BY cnt DESC
      `),
      snowflake.executeQuery(`
        SELECT "PROPERTYSUBTYPE", COUNT(*) as cnt 
        FROM "Property" 
        WHERE "PROPERTYSUBTYPE" IS NOT NULL
        GROUP BY "PROPERTYSUBTYPE" 
        ORDER BY cnt DESC
        LIMIT 50
      `),
      snowflake.executeQuery(`
        SELECT "STATEORPROVINCE", COUNT(*) as cnt 
        FROM "Property" 
        WHERE "STATEORPROVINCE" IS NOT NULL
        GROUP BY "STATEORPROVINCE" 
        ORDER BY cnt DESC
      `)
    ]);

    res.json({
      ok: true,
      data: {
        cities: citiesData.map(c => ({ 
          city: c.CITY, 
          state: c.STATEORPROVINCE, 
          count: c.CNT 
        })),
        statuses: statusesData.map(s => ({ 
          status: s.STANDARDSTATUS, 
          count: s.CNT 
        })),
        propertyTypes: typesData.map(t => ({ 
          type: t.PROPERTYTYPE, 
          count: t.CNT 
        })),
        propertySubtypes: subtypesData.map(s => ({
          subtype: s.PROPERTYSUBTYPE,
          count: s.CNT
        })),
        states: statesData.map(s => ({
          state: s.STATEORPROVINCE,
          count: s.CNT
        }))
      }
    });
  } catch (error) {
    console.error('[Snowflake API] Stats error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/snowflake/test - Test Snowflake connection
app.get('/api/snowflake/test', async (req, res) => {
  try {
    const result = await snowflake.testConnection();
    res.json({ ok: true, data: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/snowflake/tables - List all available Snowflake tables
app.get('/api/snowflake/tables', async (req, res) => {
  try {
    const tables = await snowflake.listTables();
    res.json({ ok: true, data: tables });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/snowflake/describe/:table - Describe a Snowflake table
app.get('/api/snowflake/describe/:table', async (req, res) => {
  try {
    const columns = await snowflake.describeTable(`"${req.params.table}"`);
    res.json({ ok: true, data: columns });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/snowflake/duplicate-addresses - Find addresses that appear in multiple listings
app.get('/api/snowflake/duplicate-addresses', async (req, res) => {
  try {
    // Query for addresses that appear in multiple listings (indicating relisted properties)
    const rows = await snowflake.executeQuery(`
      SELECT 
        UNPARSEDADDRESS,
        CITY,
        STATEORPROVINCE,
        POSTALCODE,
        COUNT(*) as LISTING_COUNT,
        LISTAGG(DISTINCT LISTINGKEY, ', ') as LISTING_KEYS,
        MIN(ONMARKETDATE) as FIRST_LISTED,
        MAX(ONMARKETDATE) as LAST_LISTED
      FROM "Property"
      WHERE UNPARSEDADDRESS IS NOT NULL
      GROUP BY UNPARSEDADDRESS, CITY, STATEORPROVINCE, POSTALCODE
      HAVING COUNT(*) > 1
      ORDER BY LISTING_COUNT DESC
      LIMIT 50
    `);
    
    res.json({ ok: true, data: rows, count: rows.length });
  } catch (error) {
    console.error('Error finding duplicate addresses:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/snowflake/property-history/:address - Get property history via Zillow API
// (Kept same route path for frontend compatibility)
app.get('/api/snowflake/property-history/:address', async (req, res) => {
  try {
    const address = decodeURIComponent(req.params.address);
    
    // Parse address into components
    const parts = address.split(',').map(s => s.trim());
    const street = parts[0] || address;
    const city = parts.length >= 3 ? parts[parts.length - 2] : (parts[1] || '');
    const stateZip = parts.length >= 2 ? parts[parts.length - 1] : '';
    const state = stateZip.replace(/\d+/g, '').trim();
    
    console.log(`[PropertyHistory] Zillow lookup: "${street}", city="${city}", state="${state}"`);
    
    // Look up property via Zillow
    const propertyData = await snowflake.getPropertyByAddress(street, city, state);
    
    if (!propertyData || !propertyData.ZPID) {
      return res.json({ ok: true, data: [] });
    }
    
    // Fetch price history and photos in parallel
    const [priceHistory, photos] = await Promise.all([
      snowflake.getPriceHistory(propertyData.ZPID).catch(() => []),
      snowflake.getPropertyMedia(propertyData.ZPID).catch(() => []),
    ]);
    
    // Build a listing-like object compatible with the old Snowflake shape
    const soldEvents = (priceHistory || []).filter(e => e.event === 'Sold' && e.price > 0)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const latestSale = soldEvents[0] || null;
    
    const listing = {
      LISTINGKEY: `ZPID-${propertyData.ZPID}`,
      STREETNUMBER: propertyData.STREETNUMBER || street.match(/^\d+/)?.[0] || '',
      STREETNAME: propertyData.STREETNAME || street.replace(/^\d+\s+/, ''),
      CITY: propertyData.CITY || city,
      STATEORPROVINCE: propertyData.STATEORPROVINCE || state,
      POSTALCODE: propertyData.POSTALCODE || '',
      LISTPRICE: propertyData.LISTPRICE || propertyData.ZESTIMATE || 0,
      CLOSEPRICE: latestSale?.price || null,
      CLOSEDATE: latestSale?.date || null,
      STANDARDSTATUS: latestSale ? 'Closed' : 'Active',
      ONMARKETDATE: null,
      DAYSONMARKET: null,
      BEDROOMSTOTAL: propertyData.BEDROOMSTOTAL,
      BATHROOMSTOTALINTEGER: propertyData.BATHROOMSTOTALINTEGER,
      LIVINGAREA: propertyData.LIVINGAREA,
      YEARBUILT: propertyData.YEARBUILT,
      PHOTOSCOUNT: photos.length,
      PROPERTYTYPE: propertyData.PROPERTYTYPE || '',
      PROPERTYCONDITION: null,
      PUBLICREMARKS: propertyData.PUBLICREMARKS || '',
      images: photos || [],
      zpid: propertyData.ZPID,
      zestimate: propertyData.ZESTIMATE,
      priceHistory: soldEvents,
    };
    
    // Build additional listings for each sale event
    const listings = [listing];
    if (soldEvents.length > 1) {
      for (let i = 1; i < soldEvents.length; i++) {
        listings.push({
          ...listing,
          LISTINGKEY: `ZPID-${propertyData.ZPID}-sale-${i}`,
          CLOSEPRICE: soldEvents[i].price,
          CLOSEDATE: soldEvents[i].date,
          STANDARDSTATUS: 'Closed',
          images: [], // photos only on most recent
        });
      }
    }
    
    console.log(`[PropertyHistory] Found ${listings.length} listing(s) for ${street} via Zillow (${photos.length} photos)`);
    
    res.json({ ok: true, data: listings });
  } catch (error) {
    console.error('Error fetching property history:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// SNOWFLAKE SCHEMA EXPLORATION ENDPOINTS
// ============================================================================

// GET /api/mls/schema/tables - List all available tables
app.get('/api/mls/schema/tables', async (req, res) => {
  try {
    const tables = await snowflake.executeQuery('SHOW TABLES IN SCHEMA');
    res.json({ ok: true, tables: tables.map(t => ({ name: t.name, rows: t.rows })) });
  } catch (error) {
    console.error('Error listing tables:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/mls/schema/columns/:table - Describe table columns
app.get('/api/mls/schema/columns/:table', async (req, res) => {
  try {
    const columns = await snowflake.executeQuery(`DESCRIBE TABLE "${req.params.table}"`);
    res.json({ ok: true, columns: columns.map(c => ({ name: c.name, type: c.type })) });
  } catch (error) {
    console.error('Error describing table:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/mls/schema/sample/:table - Get sample rows from a table
app.get('/api/mls/schema/sample/:table', async (req, res) => {
  try {
    const limit = req.query.limit || 5;
    const rows = await snowflake.executeQuery(`SELECT * FROM "${req.params.table}" LIMIT ${limit}`);
    res.json({ ok: true, rows });
  } catch (error) {
    console.error('Error sampling table:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/mls/query - Run an arbitrary read-only query (for debugging)
app.get('/api/mls/query', async (req, res) => {
  try {
    const { sql } = req.query;
    if (!sql) return res.status(400).json({ ok: false, error: 'sql query param required' });
    // Only allow SELECT statements for safety
    if (!sql.trim().toUpperCase().startsWith('SELECT')) {
      return res.status(400).json({ ok: false, error: 'Only SELECT queries allowed' });
    }
    const rows = await snowflake.executeQuery(sql);
    res.json({ ok: true, rows, count: rows.length });
  } catch (error) {
    console.error('Error running query:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// RENOVATION ROI ANALYSIS ENDPOINTS
// ============================================================================

// GET /api/renovation-roi/debug - Debug endpoint to check Zillow API data availability
app.get('/api/renovation-roi/debug', async (req, res) => {
  try {
    const { zipCode, address } = req.query;
    if (!zipCode && !address) {
      return res.status(400).json({ ok: false, error: 'zipCode or address required' });
    }

    const results = {};

    if (address) {
      // Test property lookup
      const [street, ...rest] = address.split(',').map(s => s.trim());
      const city = rest[0] || '';
      const state = rest[1] || '';
      const propertyData = await snowflake.getPropertyByAddress(street, city, state);
      results.propertyLookup = {
        found: !!propertyData,
        zpid: propertyData?.ZPID || null,
        zestimate: propertyData?.ZESTIMATE || null,
        address: propertyData?.address_str || address,
        beds: propertyData?.BEDROOMSTOTAL || null,
        baths: propertyData?.BATHROOMSTOTALINTEGER || null,
        sqft: propertyData?.LIVINGAREA || null,
        yearBuilt: propertyData?.YEARBUILT || null
      };

      // Test price history if we found the property
      if (propertyData?.ZPID) {
        try {
          const priceHistory = await snowflake.getPriceHistory(propertyData.ZPID);
          results.priceHistory = {
            found: Array.isArray(priceHistory) && priceHistory.length > 0,
            eventCount: priceHistory?.length || 0,
            events: (priceHistory || []).slice(0, 5)
          };
        } catch (e) {
          results.priceHistory = { found: false, error: e.message };
        }
      }
    }

    if (zipCode) {
      // Test market data via housing_market endpoint
      try {
        const marketData = await snowflake.getMarketAppreciation({ zip: zipCode });
        results.marketData = {
          found: !!marketData && marketData.length > 0,
          hasZHVI: !!(marketData?.[0]?.ZHVI_VALUES?.length),
          zhviPoints: marketData?.[0]?.ZHVI_VALUES?.length || 0,
          medianPrice: marketData?.[0]?.MEDIAN_CLOSE_PRICE || null,
          yearCount: marketData?.length || 0,
          source: 'zillow_housing_market'
        };
      } catch (e) {
        results.marketData = { found: false, error: e.message };
      }

      // Test area stats
      try {
        const areaStats = await snowflake.getRenovationAreaStats({ zipCode });
        results.areaStats = {
          found: !!areaStats,
          medianHomeValue: areaStats?.medianHomeValue || null,
          avgRent: areaStats?.avgRent || null,
          source: 'zillow_area_stats'
        };
      } catch (e) {
        results.areaStats = { found: false, error: e.message };
      }
    }

    res.json({
      ok: true,
      dataSource: 'zillow_api',
      filter: { zipCode, address },
      ...results
    });
  } catch (error) {
    console.error('[Renovation ROI Debug] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/renovation-roi/candidates - Find properties with renovation history
app.get('/api/renovation-roi/candidates', async (req, res) => {
  try {
    const { 
      zipCode, 
      city, 
      state,
      minPriceIncrease = 0,  // Default to 0 to show all (including price decreases)
      minHoldingMonths = 0,  // Default to 0 to include quick flips
      maxHoldingMonths = 120,
      limit = 50
    } = req.query;
    
    // If no filters provided, search entire database for multi-sale properties
    console.log('[Renovation ROI] Finding candidates:', { zipCode, city, state, minPriceIncrease, minHoldingMonths, maxHoldingMonths, limit });
    
    const candidates = await snowflake.findRenovationCandidates({
      zipCode,
      city,
      state,
      minPriceIncrease: parseFloat(minPriceIncrease) * 1000, // Convert to dollars
      minHoldingMonths: parseInt(minHoldingMonths),
      maxHoldingMonths: parseInt(maxHoldingMonths),
      limit: parseInt(limit)
    });
    
    console.log('[Renovation ROI] Found', candidates.length, 'candidates');
    
    res.json({ 
      ok: true, 
      count: candidates.length,
      data: candidates 
    });
  } catch (error) {
    console.error('[Renovation ROI] Error finding candidates:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/renovation-roi/candidate/:address - Get full renovation candidate data via Zillow
app.get('/api/renovation-roi/candidate/:address', async (req, res) => {
  try {
    const address = decodeURIComponent(req.params.address);
    
    // Parse address into components
    const parts = address.split(',').map(s => s.trim());
    const street = parts[0] || address;
    const city = parts[1] || '';
    const state = parts[2] || '';
    
    // Lookup property via Zillow
    const propertyData = await snowflake.getPropertyByAddress(street, city, state);
    
    if (!propertyData || !propertyData.ZPID) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Property not found via Zillow for this address' 
      });
    }
    
    // Fetch price history to find multi-sale events
    const priceHistory = await snowflake.getPriceHistory(propertyData.ZPID);
    const soldEvents = (priceHistory || []).filter(e => 
      e.event === 'Sold' && e.price > 0
    ).sort((a, b) => new Date(a.date) - new Date(b.date));
    
    if (soldEvents.length < 2) {
      return res.status(404).json({ 
        ok: false, 
        error: 'No multi-sale renovation data found for this address' 
      });
    }
    
    const beforeSale = soldEvents[0];
    const afterSale = soldEvents[soldEvents.length - 1];
    
    // Get full property detail with photos
    const detail = await snowflake.getMLSPropertyWithImages(propertyData.ZPID);
    
    const candidateData = {
      address: propertyData.address_str || address,
      city: propertyData.CITY || city,
      state: propertyData.STATEORPROVINCE || state,
      zipCode: propertyData.POSTALCODE || '',
      propertyType: propertyData.PROPERTYTYPE || '',
      beds: propertyData.BEDROOMSTOTAL,
      baths: propertyData.BATHROOMSTOTALINTEGER,
      sqft: propertyData.LIVINGAREA,
      yearBuilt: propertyData.YEARBUILT,
      zpid: propertyData.ZPID,
      before: {
        saleDate: beforeSale.date,
        salePrice: beforeSale.price,
        source: beforeSale.source || 'zillow_price_history'
      },
      after: {
        saleDate: afterSale.date,
        salePrice: afterSale.price,
        source: afterSale.source || 'zillow_price_history'
      },
      photos: (detail?.images || []).map(img => img.MEDIAURL).filter(Boolean),
      publicRemarks: detail?.PUBLICREMARKS || propertyData.PUBLICREMARKS || '',
      metrics: {
        priceIncrease: afterSale.price - beforeSale.price,
        priceIncreasePercent: beforeSale.price 
          ? ((afterSale.price - beforeSale.price) / beforeSale.price * 100).toFixed(2)
          : null,
        holdingMonths: beforeSale.date && afterSale.date
          ? Math.round((new Date(afterSale.date) - new Date(beforeSale.date)) / (1000 * 60 * 60 * 24 * 30))
          : null,
        totalSaleEvents: soldEvents.length
      }
    };
    
    res.json({ ok: true, data: candidateData });
  } catch (error) {
    console.error('[Renovation ROI] Error fetching candidate:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/renovation-roi/demo - Demo property lookup via Zillow (6323 SW Delker Rd, Tualatin OR)
app.get('/api/renovation-roi/demo', async (req, res) => {
  try {
    // Our known demo property: 6323 SW DELKER RD, Tualatin, OR 97062
    const demoStreet = '6323 SW Delker Rd';
    const demoCity = 'Tualatin';
    const demoState = 'OR';
    
    // Look up property via Zillow
    const propertyData = await snowflake.getPropertyByAddress(demoStreet, demoCity, demoState);
    
    if (!propertyData || !propertyData.ZPID) {
      return res.status(404).json({ ok: false, error: 'Demo property not found via Zillow' });
    }
    
    // Fetch price history and property detail with photos in parallel
    const [priceHistory, detail] = await Promise.all([
      snowflake.getPriceHistory(propertyData.ZPID),
      snowflake.getMLSPropertyWithImages(propertyData.ZPID)
    ]);
    
    const soldEvents = (priceHistory || []).filter(e => 
      e.event === 'Sold' && e.price > 0
    ).sort((a, b) => new Date(a.date) - new Date(b.date));
    
    const beforeSale = soldEvents.length >= 2 ? soldEvents[0] : null;
    const afterSale = soldEvents.length >= 2 ? soldEvents[soldEvents.length - 1] : null;
    
    const candidateData = {
      address: propertyData.address_str || `${demoStreet}, ${demoCity}, ${demoState}`,
      city: propertyData.CITY || demoCity,
      state: propertyData.STATEORPROVINCE || demoState,
      zipCode: propertyData.POSTALCODE || '97062',
      propertyType: propertyData.PROPERTYTYPE || 'Residential',
      beds: propertyData.BEDROOMSTOTAL,
      baths: propertyData.BATHROOMSTOTALINTEGER,
      sqft: propertyData.LIVINGAREA,
      yearBuilt: propertyData.YEARBUILT,
      zpid: propertyData.ZPID,
      zestimate: propertyData.ZESTIMATE,
      before: beforeSale ? {
        saleDate: beforeSale.date,
        salePrice: beforeSale.price,
        source: 'zillow_price_history'
      } : null,
      after: afterSale ? {
        saleDate: afterSale.date,
        salePrice: afterSale.price,
        source: 'zillow_price_history'
      } : null,
      photos: (detail?.images || []).map(img => img.MEDIAURL).filter(Boolean),
      publicRemarks: detail?.PUBLICREMARKS || propertyData.PUBLICREMARKS || '',
      allSaleEvents: soldEvents,
      metrics: beforeSale && afterSale ? {
        priceIncrease: afterSale.price - beforeSale.price,
        priceIncreasePercent: beforeSale.price 
          ? ((afterSale.price - beforeSale.price) / beforeSale.price * 100).toFixed(2)
          : null,
        holdingMonths: beforeSale.date && afterSale.date
          ? Math.round((new Date(afterSale.date) - new Date(beforeSale.date)) / (1000 * 60 * 60 * 24 * 30))
          : null
      } : null
    };
    
    res.json({ ok: true, data: candidateData });
  } catch (error) {
    console.error('[Renovation ROI] Error fetching demo:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/renovation-roi/search-address - Search for a property by address via Zillow
app.get('/api/renovation-roi/search-address', async (req, res) => {
  try {
    const { address } = req.query;
    
    if (!address) {
      return res.status(400).json({ ok: false, error: 'Address is required' });
    }
    
    console.log(`[Renovation ROI] Searching for address: ${address}`);
    
    // Parse address into components
    const parts = address.split(',').map(s => s.trim());
    const street = parts[0] || address;
    const city = parts[1] || '';
    const state = parts[2] || '';
    
    // Look up property via Zillow API
    const propertyData = await snowflake.getPropertyByAddress(street, city, state);
    
    if (!propertyData || !propertyData.ZPID) {
      return res.status(404).json({ ok: false, error: `No properties found matching "${address}"` });
    }
    
    console.log(`[Renovation ROI] Found property: zpid=${propertyData.ZPID}`);
    
    // Fetch price history to find multi-sale events
    const priceHistory = await snowflake.getPriceHistory(propertyData.ZPID);
    const soldEvents = (priceHistory || []).filter(e => 
      e.event === 'Sold' && e.price > 0
    ).sort((a, b) => new Date(a.date) - new Date(b.date));
    
    let beforeProperty = null;
    let afterProperty = null;
    
    if (soldEvents.length >= 2) {
      beforeProperty = soldEvents[0];
      afterProperty = soldEvents[soldEvents.length - 1];
      console.log(`[Renovation ROI] Found multi-sale property with ${soldEvents.length} sales`);
    }
    
    // Get photos
    const detail = await snowflake.getMLSPropertyWithImages(propertyData.ZPID);
    
    const candidateData = {
      address: propertyData.address_str || address,
      city: propertyData.CITY || propertyData.STATEORPROVINCE ? city : city,
      state: propertyData.STATEORPROVINCE || state,
      zipCode: propertyData.POSTALCODE || '',
      propertyType: propertyData.PROPERTYTYPE || '',
      beds: propertyData.BEDROOMSTOTAL,
      baths: propertyData.BATHROOMSTOTALINTEGER,
      sqft: propertyData.LIVINGAREA,
      yearBuilt: propertyData.YEARBUILT,
      zpid: propertyData.ZPID,
      zestimate: propertyData.ZESTIMATE,
      totalSaleEvents: soldEvents.length,
      before: beforeProperty ? {
        saleDate: beforeProperty.date,
        salePrice: beforeProperty.price,
        source: 'zillow_price_history'
      } : {
        saleDate: null,
        salePrice: propertyData.LISTPRICE || propertyData.ZESTIMATE,
        source: 'zillow_current'
      },
      after: afterProperty ? {
        saleDate: afterProperty.date,
        salePrice: afterProperty.price,
        source: 'zillow_price_history'
      } : null,
      photos: (detail?.images || []).map(img => img.MEDIAURL).filter(Boolean),
      publicRemarks: detail?.PUBLICREMARKS || propertyData.PUBLICREMARKS || '',
      metrics: beforeProperty && afterProperty ? {
        priceIncrease: afterProperty.price - beforeProperty.price,
        priceIncreasePercent: beforeProperty.price 
          ? ((afterProperty.price - beforeProperty.price) / beforeProperty.price * 100).toFixed(2)
          : null,
        holdingMonths: beforeProperty.date && afterProperty.date
          ? Math.round((new Date(afterProperty.date) - new Date(beforeProperty.date)) / (1000 * 60 * 60 * 24 * 30))
          : null
      } : null
    };
    
    res.json({ ok: true, data: candidateData });
  } catch (error) {
    console.error('[Renovation ROI] Error searching address:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/renovation-roi/area-stats/:zipCode - Get area renovation statistics
app.get('/api/renovation-roi/area-stats/:zipCode', async (req, res) => {
  try {
    const { zipCode } = req.params;
    
    const stats = await snowflake.getRenovationAreaStats({ zipCode });
    
    res.json({ ok: true, data: stats });
  } catch (error) {
    console.error('[Renovation ROI] Error fetching area stats:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/renovation-roi/similar - Find similar renovation comparables
app.get('/api/renovation-roi/similar', async (req, res) => {
  try {
    const { 
      zipCode,
      propertyType,
      minPriceIncrease = 10,
      maxPriceIncrease = 100,
      limit = 20
    } = req.query;
    
    if (!zipCode) {
      return res.status(400).json({ 
        ok: false, 
        error: 'zipCode is required' 
      });
    }
    
    const similar = await snowflake.findSimilarRenovations({
      zipCode,
      propertyType,
      minPriceIncreasePercent: parseFloat(minPriceIncrease),
      maxPriceIncreasePercent: parseFloat(maxPriceIncrease),
      limit: parseInt(limit)
    });
    
    res.json({ 
      ok: true, 
      count: similar.length,
      data: similar 
    });
  } catch (error) {
    console.error('[Renovation ROI] Error finding similar:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/renovation-roi/detect-needs - Analyze current property photos to identify NEEDED renovations
// This is different from /analyze which compares before/after photos
app.post('/api/renovation-roi/detect-needs', async (req, res) => {
  try {
    const { photos, propertyType, yearBuilt, sqft, beds, baths, avm, zipCode, state } = req.body;
    
    if (!photos?.length) {
      return res.status(400).json({ ok: false, error: 'photos array is required' });
    }
    
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
    }
    
    const selectedPhotos = photos;
    console.log(`[Detect Needs] Analyzing ${selectedPhotos.length} photos for renovation opportunities`);
    
    const DETECT_PROMPT = `You are an expert real estate renovation analyst and property inspector. Analyze these listing photos of a property and identify ALL renovation opportunities — things that could be upgraded, are outdated, or need repair.

Property Details:
- Type: ${propertyType || 'Single Family'}
- Year Built: ${yearBuilt || 'Unknown'}
- Sq Ft: ${sqft || 'Unknown'}
- Beds/Baths: ${beds || '?'}/${baths || '?'}
- Current Value: $${(avm || 0).toLocaleString()}
- Location: ZIP ${zipCode || '?'}, ${state || '?'}

Look at the photos carefully and identify:
1. Outdated kitchens (old cabinets, countertops, appliances, fixtures)
2. Outdated bathrooms (old vanity, tile, fixtures, toilet)
3. Old/worn flooring (carpet, vinyl, damaged hardwood)
4. Dated paint colors or wallpaper
5. Old/inefficient windows
6. Aging roof or siding
7. Overgrown or neglected landscaping
8. Old HVAC systems visible
9. Unfinished spaces that could be improved
10. General wear and tear, deferred maintenance
11. Layout issues that could be improved
12. Curb appeal improvements needed

For each renovation opportunity, provide:
1. area: room/area (kitchen, bathroom_master, bathroom_secondary, flooring, paint_interior, paint_exterior, roof, windows, landscaping, hvac, basement, deck_patio, living_room, bedroom, dining_room, garage, etc.)
2. type: specific renovation type (e.g., "kitchen_refresh", "bathroom_remodel", "flooring_replacement", "paint_refresh")
3. scope: "cosmetic" ($2k-$10k) | "refresh" ($10k-$25k) | "full_remodel" ($25k-$75k) | "gut_reno" ($75k+)
4. confidence: 0-1 how confident you are this needs renovation
5. description: What you see and why it needs updating
6. estimatedCost: Dollar estimate for this renovation
7. estimatedValueAdd: Expected value increase from this renovation
8. priority: "high" | "medium" | "low" — based on ROI and impact
9. reasoning: Why this renovation would add value in this market/price range

Return JSON:
{
  "renovations": [
    {
      "area": "kitchen",
      "type": "kitchen_refresh",
      "scope": "refresh",
      "confidence": 0.9,
      "description": "Dated oak cabinets, laminate countertops, white appliances from the 1990s",
      "estimatedCost": 18000,
      "estimatedValueAdd": 30000,
      "priority": "high",
      "reasoning": "Kitchen updates have the highest ROI in this price range. Modern buyers expect updated kitchens."
    }
  ],
  "overallCondition": "fair",
  "conditionScore": 38,
  "conditionByArea": {
    "kitchen": 25,
    "bathrooms": 40,
    "flooring": 55,
    "exterior": 60,
    "systems": 65,
    "curb_appeal": 50
  },
  "totalEstimatedCost": 45000,
  "totalEstimatedValueAdd": 75000,
  "summary": "Brief overall assessment"
}

The "conditionScore" is your overall assessment of the property's current condition on a 1-100 scale:
  1-15: Severely distressed (major damage, safety concerns, uninhabitable)
  16-25: Poor (very dated/worn everywhere, needs full remodel, significant deferred maintenance)
  26-35: Below average (mostly dated, multiple areas need major work)
  36-45: Fair (functional but dated, cosmetic wear throughout, original finishes from 20+ years ago)
  46-55: Average (mix of dated and acceptable areas, some updates done, generally functional)
  56-65: Above average (mostly well-maintained, minor updates needed, clean and functional)
  66-75: Good (well-maintained throughout, recently refreshed in key areas, move-in ready)
  76-85: Very good (most areas updated, modern finishes, minimal work needed)
  86-95: Excellent (fully renovated or like-new, premium finishes, turnkey)
  96-100: Perfect (brand new or just completed luxury renovation)

The "conditionByArea" rates each visible area on the same 1-100 scale. Only rate areas you can actually see in the photos.
The "overallCondition" label should match: poor (1-25), fair (26-45), good (46-75), excellent (76-100).

Be thorough but realistic. Look at EVERY photo. If the property looks well-maintained and modern, say so. Don't invent problems that aren't visible.`;

    const messageContent = [
      { type: 'text', text: 'Analyze these property listing photos and identify all renovation opportunities:' }
    ];
    
    for (const url of selectedPhotos) {
      messageContent.push({
        type: 'image_url',
        image_url: { url, detail: 'high' }
      });
    }
    
    messageContent.push({
      type: 'text',
      text: 'Now analyze all photos above and identify every renovation opportunity. Return JSON only, no markdown fences.'
    });
    
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: DETECT_PROMPT },
          { role: 'user', content: messageContent }
        ],
        max_tokens: 4000,
        temperature: 0.3
      })
    });
    
    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('[Detect Needs] OpenAI error:', errText);
      throw new Error(`OpenAI API error: ${openaiRes.status}`);
    }
    
    const openaiData = await openaiRes.json();
    const content = openaiData.choices?.[0]?.message?.content || '';
    
    // Parse JSON from response (handle markdown fences)
    let analysis;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      analysis = JSON.parse(jsonMatch ? jsonMatch[1].trim() : content.trim());
    } catch (parseErr) {
      console.error('[Detect Needs] JSON parse error:', parseErr.message);
      console.error('[Detect Needs] Raw content:', content.substring(0, 500));
      // Try to find JSON object in the response
      const objMatch = content.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try { analysis = JSON.parse(objMatch[0]); } catch { analysis = null; }
      }
    }
    
    if (!analysis) {
      return res.json({ ok: false, error: 'Could not parse AI response', raw: content.substring(0, 500) });
    }
    
    console.log(`[Detect Needs] Found ${analysis.renovations?.length || 0} renovation opportunities`);
    
    res.json({
      ok: true,
      renovations: analysis.renovations || [],
      overallCondition: analysis.overallCondition,
      conditionScore: analysis.conditionScore || null,
      conditionByArea: analysis.conditionByArea || null,
      totalEstimatedCost: analysis.totalEstimatedCost,
      totalEstimatedValueAdd: analysis.totalEstimatedValueAdd,
      summary: analysis.summary,
      usage: openaiData.usage
    });
  } catch (error) {
    console.error('[Detect Needs] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/renovation-roi/analyze - Analyze photos and calculate renovation ROI
// FULL IMPLEMENTATION with natural appreciation, stratification, rent impact, confidence scoring
app.post('/api/renovation-roi/analyze', async (req, res) => {
  try {
    const { 
      beforePhotos, 
      afterPhotos, 
      beforePrice,
      afterPrice,
      beforeDate,
      afterDate,
      propertyId,
      state,
      // Extended inputs for full analysis
      zipCode,
      propertyType,
      yearBuilt,
      sqft,
      beds,
      baths,
      beforeRent,
      afterRent,
      beforeTaxAssessment,
      afterTaxAssessment
    } = req.body;
    
    if (!beforePhotos?.length || !afterPhotos?.length) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Both beforePhotos and afterPhotos arrays are required' 
      });
    }
    
    if (!beforePrice || !afterPrice) {
      return res.status(400).json({ 
        ok: false, 
        error: 'beforePrice and afterPrice are required' 
      });
    }
    
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ 
        ok: false, 
        error: 'OpenAI API key not configured' 
      });
    }
    
    // Select representative photos (max 6 from each set)
    const selectedBefore = beforePhotos.slice(0, 6);
    const selectedAfter = afterPhotos.slice(0, 6);
    
    console.log(`[Renovation ROI] Analyzing ${selectedBefore.length} before + ${selectedAfter.length} after photos for ${propertyId || 'unknown'}`);
    
    // ========================================================================
    // STEP 1: GPT-4 Vision Photo Comparison
    // ========================================================================
    const RENOVATION_PROMPT = `You are an expert real estate renovation analyst. Compare these BEFORE and AFTER photos of the same property to identify what renovations were done.

BEFORE photos show the property at an earlier listing date.
AFTER photos show the same property at a later listing date.

Analyze carefully and identify ALL visible renovations between the two sets of photos.

For each renovation detected, provide:
1. category: One of: kitchen, bathroom_master, bathroom_secondary, flooring, paint_interior, paint_exterior, roof, windows, doors, siding, landscaping, driveway, hvac, electrical, plumbing, basement, attic, garage, deck_patio, pool, living_room, bedroom, dining_room, other
2. scope: One of:
   - "cosmetic" = Paint, hardware, light fixtures ($2k-$10k)
   - "refresh" = Counters, backsplash, appliances, some cabinets ($10k-$25k)
   - "full_remodel" = Full cabinet replacement, layout changes ($25k-$75k)
   - "gut_reno" = Down to studs, complete rebuild ($75k+)
3. description: Specific description of what was changed
4. confidence: 0-1 how confident you are this renovation occurred
5. qualityLevel: "budget", "mid_grade", "high_end", or "luxury"
6. beforeDescription: What it looked like before
7. afterDescription: What it looks like after
8. estimatedCost: Estimated cost in dollars (be realistic based on scope and quality)
9. positiveImpact: true if renovation adds value, false if it may hurt value (bad DIY, wrong style for area, over-improvement)
10. warning: Optional string if there's a concern (e.g., "Gray laminate in luxury market", "Closed off kitchen")

Return a JSON object with this structure:
{
  "renovationsDetected": [
    {
      "category": "kitchen",
      "scope": "refresh",
      "description": "Updated countertops to quartz, new stainless steel appliances",
      "confidence": 0.95,
      "qualityLevel": "mid_grade",
      "beforeDescription": "Laminate countertops, white appliances",
      "afterDescription": "Quartz countertops, stainless appliances",
      "estimatedCost": 18000,
      "positiveImpact": true,
      "warning": null
    }
  ],
  "overallConfidence": 0.85,
  "notes": "Any additional observations about the renovations",
  "overallAssessment": "positive" | "mixed" | "negative" | "neutral"
}

BE SPECIFIC about what changed. Look for:
- Kitchen: Countertops, cabinets, appliances, backsplash, flooring, lighting
- Bathrooms: Vanity, toilet, shower/tub, tile, fixtures
- Flooring: Type change (carpet to hardwood, etc.), refinishing
- Paint: Wall colors, trim, ceiling
- Exterior: Siding, roof, windows, doors, landscaping, driveway
- Look for NEGATIVE signals too: over-improvement, bad DIY work, style mismatches`;

    const messageContent = [
      { type: 'text', text: '=== BEFORE PHOTOS (Earlier Listing) ===' }
    ];
    
    for (const url of selectedBefore) {
      messageContent.push({
        type: 'image_url',
        image_url: { url: url, detail: 'high' }
      });
    }
    
    messageContent.push({ type: 'text', text: '=== AFTER PHOTOS (Later Listing) ===' });
    
    for (const url of selectedAfter) {
      messageContent.push({
        type: 'image_url',
        image_url: { url: url, detail: 'high' }
      });
    }
    
    messageContent.push({
      type: 'text',
      text: 'Now compare the BEFORE and AFTER photos and identify all renovations. Include positiveImpact and warning fields. Return JSON only.'
    });
    
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: RENOVATION_PROMPT },
          { role: 'user', content: messageContent }
        ],
        max_tokens: 4000,
        temperature: 0.3
      })
    });
    
    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('[Renovation ROI] OpenAI error:', errText);
      throw new Error(`OpenAI API error: ${openaiRes.status}`);
    }
    
    const openaiData = await openaiRes.json();
    const content = openaiData.choices?.[0]?.message?.content || '';
    
    // Parse the JSON response
    let photoAnalysis;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      const cleanJson = jsonMatch[1].trim();
      photoAnalysis = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error('[Renovation ROI] Failed to parse GPT response:', content);
      photoAnalysis = {
        renovationsDetected: [],
        overallConfidence: 0,
        notes: 'Failed to parse AI response: ' + parseErr.message,
        overallAssessment: 'neutral'
      };
    }
    
    // ========================================================================
    // STEP 2: Calculate Natural Market Appreciation using HYBRID approach
    // Uses best available data: ATTOM Property AVM > ATTOM ZIP Trend > FRED Metro HPI
    // ========================================================================
    const beforeDateObj = new Date(beforeDate || Date.now() - 365 * 24 * 60 * 60 * 1000);
    const afterDateObj = new Date(afterDate || Date.now());
    const holdingMonths = Math.max(1, Math.round((afterDateObj - beforeDateObj) / (30.44 * 24 * 60 * 60 * 1000)));
    
    // Use hybrid appreciation calculator for real market data
    let appreciationData;
    try {
      appreciationData = await calculateHybridAppreciation({
        state: state,
        city: null, // Could parse from address if available
        zipCode: zipCode,
        attomId: null, // Could pass from ATTOM dashboard if available
        startDate: beforeDateObj,
        endDate: afterDateObj,
        propertyType: propertyType || 'single_family'
      });
      
      console.log('[Renovation ROI] Hybrid appreciation result:', {
        source: appreciationData.dataSource,
        granularity: appreciationData.granularity,
        percent: appreciationData.appreciationPercent?.toFixed(2),
        confidence: appreciationData.confidence?.toFixed(2),
        methods: appreciationData.methodsAttempted
      });
    } catch (appreciationError) {
      console.error('[Renovation ROI] Appreciation calculation failed:', appreciationError.message);
      // Fallback to conservative estimate
      appreciationData = {
        appreciationPercent: (holdingMonths / 12) * 4.0, // 4% annual fallback
        annualizedRate: 4.0,
        dataSource: 'Fallback Estimate',
        granularity: 'national',
        confidence: 0.2,
        methodsAttempted: ['fallback'],
        error: appreciationError.message
      };
    }
    
    const naturalAppreciationPercent = appreciationData.appreciationPercent || 0;
    const naturalAppreciationAmount = Math.round(beforePrice * (naturalAppreciationPercent / 100));
    
    // Market heat indicator based on annualized rate
    const avgAnnualRate = appreciationData.annualizedRate || (holdingMonths > 0 ? (naturalAppreciationPercent / holdingMonths) * 12 : 0);
    const marketHeat = avgAnnualRate > 15 ? 'hot' : avgAnnualRate > 8 ? 'warm' : avgAnnualRate > 3 ? 'normal' : 'cold';
    
    // ========================================================================
    // STEP 3: Calculate Renovation-Attributed Value
    // ========================================================================
    const totalEstimatedCost = (photoAnalysis.renovationsDetected || []).reduce(
      (sum, reno) => sum + (reno.estimatedCost || 0), 0
    );
    
    const rawPriceIncrease = afterPrice - beforePrice;
    const rawPriceIncreasePercent = (rawPriceIncrease / beforePrice) * 100;
    
    // The TRUE renovation value = price increase - natural appreciation
    let renovationAttributedValue = rawPriceIncrease - naturalAppreciationAmount;
    const renovationAttributedPercent = (renovationAttributedValue / beforePrice) * 100;
    
    // ========================================================================
    // STEP 4: Calculate ROI Metrics
    // ========================================================================
    const flags = [];
    
    if (renovationAttributedValue < 0) {
      flags.push('Renovation value negative after market adjustment - property may have sold below market or declined');
      renovationAttributedValue = Math.max(0, renovationAttributedValue);
    }
    
    // Value ROI (the true ROI after accounting for natural appreciation)
    const valueROI = totalEstimatedCost > 0 
      ? (renovationAttributedValue / totalEstimatedCost) * 100 
      : (renovationAttributedValue > 0 ? Infinity : 0);
    
    const annualizedValueROI = valueROI !== Infinity && holdingMonths > 0 
      ? valueROI * (12 / holdingMonths) 
      : null;
    
    // Simple ROI (not accounting for appreciation - for comparison)
    const simpleROI = totalEstimatedCost > 0
      ? ((rawPriceIncrease - totalEstimatedCost) / totalEstimatedCost) * 100
      : 0;
    
    // Check for outliers
    if (valueROI > 500) {
      flags.push('Unusually high ROI - may indicate underestimated renovation cost or market anomaly');
    }
    if (valueROI < 50 && totalEstimatedCost > 10000) {
      flags.push('Low ROI - renovations may have been over-improved for the area');
    }
    if (totalEstimatedCost === 0 && rawPriceIncrease > 50000) {
      flags.push('No renovation cost detected but significant price increase - may have missed renovations');
    }
    
    // ========================================================================
    // STEP 5: Rent Impact Analysis
    // ========================================================================
    let rentAnalysis = null;
    if (beforeRent && afterRent) {
      const rentIncrease = afterRent - beforeRent;
      const rentIncreasePercent = (rentIncrease / beforeRent) * 100;
      const annualRentIncrease = rentIncrease * 12;
      const rentROI = totalEstimatedCost > 0 ? (annualRentIncrease / totalEstimatedCost) * 100 : 0;
      const paybackMonths = rentIncrease > 0 ? Math.ceil(totalEstimatedCost / rentIncrease) : 999;
      
      rentAnalysis = {
        beforeRent,
        afterRent,
        rentIncrease,
        rentIncreasePercent: Math.round(rentIncreasePercent * 100) / 100,
        annualRentIncrease,
        rentROI: Math.round(rentROI * 100) / 100,
        paybackMonths,
        verdict: paybackMonths < 36 ? 'excellent' : paybackMonths < 60 ? 'good' : paybackMonths < 120 ? 'fair' : 'poor'
      };
    }
    
    // ========================================================================
    // STEP 6: Tax Assessment Validation
    // ========================================================================
    let taxValidation = { status: 'unvalidated', message: 'No tax data provided' };
    if (beforeTaxAssessment && afterTaxAssessment) {
      const taxDelta = afterTaxAssessment - beforeTaxAssessment;
      const expectedTaxDelta = renovationAttributedValue * 0.8; // Tax lags market by ~20%
      const taxRatio = expectedTaxDelta > 0 ? taxDelta / expectedTaxDelta : 0;
      
      if (taxRatio >= 0.6 && taxRatio <= 1.5) {
        taxValidation = { status: 'validated', message: 'Tax assessment aligns with renovation value', taxDelta, taxRatio };
      } else if (taxRatio >= 0.3 && taxRatio <= 2.0) {
        taxValidation = { status: 'partial', message: 'Tax assessment partially aligns', taxDelta, taxRatio };
        flags.push('Tax assessment partially aligns with renovation value');
      } else {
        taxValidation = { status: 'mismatch', message: 'Tax assessment does not align with renovation value', taxDelta, taxRatio };
        flags.push('Tax assessment mismatch - may indicate data issues');
      }
    }
    
    // ========================================================================
    // STEP 7: Property Stratification
    // ========================================================================
    const getPriceTier = (price) => {
      if (price < 200000) return 'under_200k';
      if (price < 350000) return '200k_350k';
      if (price < 500000) return '350k_500k';
      if (price < 750000) return '500k_750k';
      if (price < 1000000) return '750k_1m';
      return 'over_1m';
    };
    
    const getYearBuiltBracket = (year) => {
      if (!year) return 'unknown';
      if (year < 1960) return 'pre_1960';
      if (year < 1980) return '1960_1980';
      if (year < 2000) return '1980_2000';
      if (year < 2010) return '2000_2010';
      return 'post_2010';
    };
    
    const stratification = {
      priceTier: getPriceTier(beforePrice),
      yearBuiltBracket: getYearBuiltBracket(yearBuilt),
      propertyType: propertyType || 'unknown',
      state: state || 'unknown',
      zipCode: zipCode || 'unknown'
    };
    
    // ========================================================================
    // STEP 8: Confidence Scoring
    // ========================================================================
    let confidenceScore = 50; // Base
    
    // AI detection confidence
    const avgRenoConfidence = photoAnalysis.renovationsDetected?.length > 0
      ? photoAnalysis.renovationsDetected.reduce((sum, r) => sum + (r.confidence || 0.5), 0) / photoAnalysis.renovationsDetected.length
      : 0;
    confidenceScore += avgRenoConfidence * 20;
    
    // Multiple renovations detected
    if (photoAnalysis.renovationsDetected?.length >= 2) confidenceScore += 5;
    if (photoAnalysis.renovationsDetected?.length >= 4) confidenceScore += 5;
    
    // Reasonable price increase
    if (rawPriceIncreasePercent >= 5 && rawPriceIncreasePercent <= 50) {
      confidenceScore += 10;
    } else if (rawPriceIncreasePercent > 80) {
      confidenceScore -= 10;
    }
    
    // Reasonable ROI
    if (valueROI >= 80 && valueROI <= 300) {
      confidenceScore += 10;
    } else if (valueROI > 400 || valueROI < 30) {
      confidenceScore -= 10;
    }
    
    // Tax validation bonus
    if (taxValidation.status === 'validated') confidenceScore += 15;
    else if (taxValidation.status === 'partial') confidenceScore += 5;
    else if (taxValidation.status === 'mismatch') confidenceScore -= 10;
    
    // Penalty for flags
    confidenceScore -= flags.length * 3;
    
    confidenceScore = Math.max(0, Math.min(100, confidenceScore));
    const confidenceLevel = confidenceScore >= 75 ? 'high' : confidenceScore >= 45 ? 'medium' : 'low';
    const dataQuality = confidenceScore >= 75 && taxValidation.status === 'validated' ? 'verified' 
      : confidenceScore < 45 ? 'low_confidence' 
      : 'estimated';
    
    // ========================================================================
    // STEP 9: Negative Signal Detection
    // ========================================================================
    const negativeSignals = (photoAnalysis.renovationsDetected || [])
      .filter(r => r.positiveImpact === false || r.warning)
      .map(r => ({
        category: r.category,
        warning: r.warning || 'Potential negative impact on value',
        confidence: r.confidence
      }));
    
    // ========================================================================
    // STEP 10: Best Bang for Buck Rankings
    // ========================================================================
    const renovationRankings = (photoAnalysis.renovationsDetected || [])
      .map(r => {
        // Estimate value attribution per renovation (proportional to cost)
        const costShare = totalEstimatedCost > 0 ? (r.estimatedCost / totalEstimatedCost) : 0;
        const estimatedValueGain = renovationAttributedValue * costShare;
        const individualROI = r.estimatedCost > 0 ? (estimatedValueGain / r.estimatedCost) * 100 : 0;
        
        return {
          category: r.category,
          scope: r.scope,
          cost: r.estimatedCost,
          estimatedValueGain: Math.round(estimatedValueGain),
          roi: Math.round(individualROI),
          ranking: individualROI > 150 ? 'excellent' : individualROI > 100 ? 'good' : individualROI > 50 ? 'fair' : 'poor',
          positiveImpact: r.positiveImpact !== false
        };
      })
      .sort((a, b) => b.roi - a.roi);
    
    // ========================================================================
    // STEP 11: Market Timing Signals
    // ========================================================================
    const marketTimingSignals = {
      marketHeat,
      holdingPeriodMonths: holdingMonths,
      naturalAppreciationPercent: Math.round(naturalAppreciationPercent * 100) / 100,
      avgAnnualAppreciation: Math.round(avgAnnualRate * 100) / 100,
      timing: marketHeat === 'hot' ? 'Sold during hot market - ROI may be inflated' :
              marketHeat === 'cold' ? 'Sold during cold market - ROI may be understated' :
              'Normal market conditions'
    };
    
    // ========================================================================
    // BUILD FINAL RESPONSE
    // ========================================================================
    const roiCalculation = {
      // Price data
      beforePrice,
      afterPrice,
      rawPriceIncrease,
      rawPriceIncreasePercent: Math.round(rawPriceIncreasePercent * 100) / 100,
      
      // Natural appreciation (the key differentiator)
      naturalAppreciation: {
        amount: naturalAppreciationAmount,
        percent: Math.round(naturalAppreciationPercent * 100) / 100,
        region: state || 'NATIONAL',
        // NEW: Include data source info from hybrid calculation
        dataSource: appreciationData.dataSource || 'Unknown',
        granularity: appreciationData.granularity || 'unknown',
        confidence: Math.round((appreciationData.confidence || 0) * 100) / 100,
        methodsAttempted: appreciationData.methodsAttempted || [],
        metroName: appreciationData.metroName || null,
        zipCode: appreciationData.zipCode || zipCode || null
      },
      
      // Renovation-attributed value (TRUE renovation gain)
      renovationAttributedValue: Math.round(renovationAttributedValue),
      renovationAttributedPercent: Math.round(renovationAttributedPercent * 100) / 100,
      
      // Costs
      totalEstimatedCost,
      netProfit: Math.round(renovationAttributedValue - totalEstimatedCost),
      
      // ROI metrics
      valueROI: valueROI === Infinity ? null : Math.round(valueROI * 100) / 100,
      annualizedValueROI: annualizedValueROI ? Math.round(annualizedValueROI * 100) / 100 : null,
      simpleROI: Math.round(simpleROI * 100) / 100, // For comparison (without appreciation adjustment)
      
      // Verdict
      profitability: renovationAttributedValue >= totalEstimatedCost * 1.2 ? 'profitable' 
        : renovationAttributedValue >= totalEstimatedCost * 0.8 ? 'break-even' 
        : 'loss',
      holdingMonths,
      
      // Rankings
      renovationRankings,
      bestRenovation: renovationRankings[0] || null
    };
    
    console.log(`[Renovation ROI] Analysis complete: ${photoAnalysis.renovationsDetected?.length || 0} renovations, True ROI: ${valueROI?.toFixed(1)}%, Simple ROI: ${simpleROI.toFixed(1)}%`);
    
    res.json({ 
      ok: true, 
      data: {
        photoAnalysis: {
          ...photoAnalysis,
          beforePhotos: selectedBefore,
          afterPhotos: selectedAfter,
          beforePhotoCount: beforePhotos.length,
          afterPhotoCount: afterPhotos.length,
          propertyId: propertyId || 'manual-analysis'
        },
        roiCalculation,
        rentAnalysis,
        taxValidation,
        stratification,
        confidence: {
          score: confidenceScore,
          level: confidenceLevel,
          dataQuality,
          flags
        },
        negativeSignals,
        marketTiming: marketTimingSignals
      }
    });
  } catch (error) {
    console.error('[Renovation ROI] Error analyzing:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/renovation-roi/area-summary/:zipCode - Get comprehensive area renovation summary
app.get('/api/renovation-roi/area-summary/:zipCode', async (req, res) => {
  try {
    const { zipCode } = req.params;
    const { processIfMissing, maxAge } = req.query;
    
    // Try the v2 uplift-based processor first (real regional data)
    let summary = null;
    let rentalSummary = null;
    try {
      const processorModule = await import('./renovation/processor.js');
      summary = await processorModule.getAreaSummary(zipCode, {
        maxAge: maxAge ? parseInt(maxAge) : 7 * 24 * 60 * 60 * 1000,
        processIfMissing: processIfMissing === 'true'
      });
      rentalSummary = await processorModule.getRentalSummary(zipCode);
    } catch (importError) {
      console.warn('[Renovation ROI] v2 processor not available:', importError.message);
    }
    
    if (summary && ((summary.bestROIRenovations && summary.bestROIRenovations.length > 0) || summary.coreValuation?.available)) {
      // We have real uplift-isolated regional data
      return res.json({
        ok: true,
        source: 'regional_uplift_analysis',
        summary: {
          ...summary,
          rentalAnalysis: rentalSummary || undefined
        }
      });
    }
    
    // Fallback: raw area stats from Snowflake (no uplift isolation)
    const stats = await snowflake.getRenovationAreaStats({ zipCode });
    
    const fallbackSummary = {
      zipCode,
      city: stats?.city || '',
      state: stats?.state || '',
      bestROIRenovations: [],
      marketSignals: {
        overallHealth: 'moderate',
        saturatedRenovations: [],
        highOpportunityRenovations: [],
        warnings: ['Regional uplift analysis not yet available — run background processing for this ZIP']
      },
      totalComparables: stats?.totalSales || 0,
      lastUpdated: new Date()
    };
    
    res.json({ 
      ok: true,
      source: 'raw_mls_stats',
      summary: fallbackSummary,
      areaStats: stats
    });
  } catch (error) {
    console.error('[Renovation ROI] Error fetching area summary:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/renovation-roi/area-comparables/:zipCode - Get comparable properties used in uplift analysis
app.get('/api/renovation-roi/area-comparables/:zipCode', async (req, res) => {
  try {
    const { zipCode } = req.params;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || '20', 10), 100));

    const processorModule = await import('./renovation/processor.js');
    const comparables = await processorModule.getAreaComparables(zipCode, { limit });

    res.json({
      ok: true,
      zipCode,
      count: comparables.length,
      comparables
    });
  } catch (error) {
    console.error('[Renovation ROI] Error fetching area comparables:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/renovation-roi/process - Trigger background processing for a ZIP code
app.post('/api/renovation-roi/process', async (req, res) => {
  try {
    const { zipCode, city, state, subjectPropertyType, subjectProfile, limit, forceReprocess, maxResultAgeDays } = req.body;
    
    if (!zipCode && !city) {
      return res.status(400).json({ ok: false, error: 'zipCode or city is required' });
    }
    
    const processorModule = await import('./renovation/processor.js');
    
    // Run processing (this can take a while for many candidates)
    const result = await processorModule.processAreaRenovations({
      zipCode,
      city,
      state,
      subjectPropertyType: subjectPropertyType || null,
      subjectProfile: subjectProfile || null,
      limit: limit || processorModule.CONFIG?.BATCH_SIZE || 20,
      forceReprocess: forceReprocess === true,
      maxResultAgeDays: Number.isFinite(Number(maxResultAgeDays)) ? Number(maxResultAgeDays) : undefined
    });
    
    res.json({
      ok: true,
      result: {
        processed: result.processed,
        successful: result.successful,
        failed: result.failed,
        skipped: result.skipped,
        candidatePairsFound: result.candidatePairsFound || 0,
        rentalPairsLoaded: result.rentalPairsLoaded || 0,
        rentalMatchesUsed: result.rentalMatchesUsed || 0,
        renovationTypesFound: result.areaSummary?.bestROIRenovations?.length || 0,
        totalComparables: result.areaSummary?.totalComparables || 0,
        coreValuation: result.coreValuation || result.areaSummary?.coreValuation || null,
        errors: result.errors,
        // Include the full area summary so Step 4 has the data
        areaSummary: result.areaSummary || null
      }
    });
  } catch (error) {
    console.error('[Renovation ROI] Error processing area:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/renovation-roi/bulk-process - Process multiple ZIP codes
app.post('/api/renovation-roi/bulk-process', async (req, res) => {
  try {
    const { zipCodes, limit } = req.body;
    
    if (!zipCodes || !Array.isArray(zipCodes) || zipCodes.length === 0) {
      return res.status(400).json({ ok: false, error: 'zipCodes array is required' });
    }
    
    if (zipCodes.length > 50) {
      return res.status(400).json({ ok: false, error: 'Maximum 50 zip codes per request' });
    }
    
    const processorModule = await import('./renovation/processor.js');
    
    const result = await processorModule.bulkProcessAreas(zipCodes, { limit });
    
    res.json({ ok: true, result });
  } catch (error) {
    console.error('[Renovation ROI] Error in bulk processing:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// RENTAL PRICING AI ANALYSIS
// ============================================================================

// POST /api/rental-pricing/analyze - AI-powered rental pricing analysis
app.post('/api/rental-pricing/analyze', async (req, res) => {
  try {
    const {
      currentRent,
      marketPotentialRent,
      marketAverage,
      bedrooms,
      bathrooms,
      squareFeet,
      propertyAddress,
      zipCode,
      conditionScore,
      conditionGrade,
      conditionNotes,
      hasRecentRenovations,
      monthlyExpenses,
      monthlyMortgage,
      currentCashFlow,
      vacancyRate,
      availableRenovations,
      comparableRents,
      percentileRank
    } = req.body;

    if (!currentRent || !marketPotentialRent) {
      return res.status(400).json({
        ok: false,
        error: 'currentRent and marketPotentialRent are required'
      });
    }

    console.log(`[Rental Pricing AI] Analyzing rent $${currentRent} vs market $${marketPotentialRent} for ${propertyAddress || 'unknown'}`);

    const percentDifference = ((currentRent - marketPotentialRent) / marketPotentialRent) * 100;
    const dollarDifference = currentRent - marketPotentialRent;

    // Determine situation
    let situation, situationSeverity;
    if (percentDifference > 15) {
      situation = 'above_market';
      situationSeverity = 'significant';
    } else if (percentDifference > 5) {
      situation = 'above_market';
      situationSeverity = 'moderate';
    } else if (percentDifference > 0) {
      situation = 'above_market';
      situationSeverity = 'slight';
    } else if (percentDifference < -15) {
      situation = 'below_market';
      situationSeverity = 'significant';
    } else if (percentDifference < -5) {
      situation = 'below_market';
      situationSeverity = 'moderate';
    } else if (percentDifference < 0) {
      situation = 'below_market';
      situationSeverity = 'slight';
    } else {
      situation = 'at_market';
      situationSeverity = 'slight';
    }

    // Try AI analysis if OpenAI key is available
    if (OPENAI_API_KEY) {
      try {
        const actualCashFlow = currentCashFlow ??
          (currentRent - (monthlyExpenses || 0) - (monthlyMortgage || 0));

        // Fetch Rentcast and FRED macro data to enrich the prompt
        let rentcastContext = '';
        let macroContext = '';

        try {
          const [rentcastResult, macroResult] = await Promise.allSettled([
            zipCode ? getZipMarketData(zipCode) : Promise.resolve(null),
            getAdditionalMacroData()
          ]);

          const rentcastRental = rentcastResult.status === 'fulfilled'
            ? (rentcastResult.value?.rentalData || rentcastResult.value?.rental || null)
            : null;

          if (rentcastRental) {
            const rental = rentcastRental;
            rentcastContext = `
Rentcast Market Data (ZIP ${zipCode}):
- Median Asking Rent: $${rental.median || 'N/A'}/mo
- Average Rent: $${rental.average || 'N/A'}/mo
- Rent Range: $${rental.min || 'N/A'} - $${rental.max || 'N/A'}/mo
- Median Rent/SqFt: $${rental.medianPerSquareFoot || 'N/A'}/sqft
- Total Active Listings: ${rental.totalListings || 'N/A'}
- Days on Market: ${rental.medianDaysOnMarket || 'N/A'} median
${rental.byBedrooms?.length ? `- Rent by Bedrooms: ${rental.byBedrooms.map(b => `${b.bedrooms || 0}BR: $${b.median || 'N/A'}`).join(', ')}` : ''}`;
          }

          if (macroResult.status === 'fulfilled' && macroResult.value) {
            const macro = macroResult.value;
            const findIndicator = (label) => {
              if (Array.isArray(macro)) return macro.find(d => d.label === label);
              if (macro.indicators) return macro.indicators.find(d => d.label === label);
              return null;
            };
            const mortgage = findIndicator('15-Year Fixed Mortgage');
            const vacancy = findIndicator('Rental Vacancy Rate');
            const sentiment = findIndicator('Consumer Sentiment');
            const ppi = findIndicator('Construction Materials PPI');

            macroContext = `
Macroeconomic Context (FRED):
${mortgage ? `- 15yr Fixed Mortgage Rate: ${mortgage.value}% (MoM: ${mortgage.mom || 'N/A'}%, YoY: ${mortgage.yoy || 'N/A'}%)` : ''}
${vacancy ? `- Rental Vacancy Rate: ${vacancy.value}% (YoY: ${vacancy.yoy || 'N/A'}%)` : ''}
${sentiment ? `- Consumer Sentiment (UMich): ${sentiment.value} (YoY: ${sentiment.yoy || 'N/A'}%)` : ''}
${ppi ? `- Construction Materials PPI: ${ppi.value} (YoY: ${ppi.yoy || 'N/A'}%)` : ''}`;
          }
        } catch (enrichErr) {
          console.warn('[Rental Pricing AI] Failed to enrich with market data:', enrichErr.message);
        }

        let renovationContext = '';
        if (availableRenovations && availableRenovations.length > 0) {
          renovationContext = `
Available Renovations (sorted by ROI):
${availableRenovations.slice(0, 5).map(r => 
  `- ${r.name}: $${r.cost} cost, +$${r.rentIncrease}/mo rent increase, ${r.roi?.toFixed(0) || 'N/A'}% ROI, ${r.paybackMonths} month payback`
).join('\n')}`;
        }

        let conditionContext = '';
        if (conditionScore !== undefined || conditionGrade) {
          conditionContext = `
Property Condition:
- Score: ${conditionScore || 'Unknown'}/100
- Grade: ${conditionGrade || 'Unknown'}
${conditionNotes?.length ? `- Notes: ${conditionNotes.join(', ')}` : ''}
${hasRecentRenovations ? '- Has recent renovations' : ''}`;
        }

        const prompt = `Analyze this rental property's pricing dynamics:

**Current Situation: ${situation.replace('_', ' ').toUpperCase()}**

Property Details:
- Address: ${propertyAddress || 'Not specified'} (${zipCode || 'Unknown ZIP'})
- Size: ${squareFeet || 'Unknown'} sq ft, ${bedrooms || 'Unknown'} bed / ${bathrooms || 'Unknown'} bath

Rental Pricing:
- Current Rent: $${currentRent}/month
- Market Potential: $${marketPotentialRent}/month
- Market Average: $${marketAverage || marketPotentialRent}/month
- Difference: ${percentDifference > 0 ? '+' : ''}${percentDifference.toFixed(1)}% ($${Math.abs(dollarDifference)}/mo ${dollarDifference > 0 ? 'above' : 'below'} market)
${percentileRank !== undefined ? `- Percentile Rank: ${percentileRank}th percentile` : ''}

Financial Metrics:
- Monthly Expenses: $${monthlyExpenses || 'Unknown'}
- Monthly Mortgage: $${monthlyMortgage || 'Unknown'}
- Current Cash Flow: $${actualCashFlow}/month
- Vacancy Rate: ${vacancyRate || 5}%
${conditionContext}
${renovationContext}
${rentcastContext}
${macroContext}

Consider the macroeconomic factors when making recommendations — e.g., if mortgage rates are high, more people are renting which supports higher rents; if consumer sentiment is low, tenants are price-sensitive; if construction costs are rising, renovation ROI may be lower.

Please provide a comprehensive analysis as JSON with:
1. "summary": A 2-3 sentence executive summary of the rental pricing situation
2. "marketComparison": { "explanation": string, "marketPosition": string }
3. "conditionAssessment": { "explanation": string, "justifiesCurrentRent": boolean, "conditionVsRentAlignment": string }
4. "risks": Array of { "title": string, "description": string, "severity": "high"|"medium"|"low" }
5. "opportunities": Array of { "title": string, "description": string, "potentialImpact": string }
6. "financialImpact": { "currentMonthlyCashFlow": number, "potentialMonthlyCashFlow": number, "annualDifference": number, "fiveYearImpact": number, "explanation": string }
7. "recommendations": { "primary": string, "actions": Array of { "action": string, "impact": string, "priority": "immediate"|"short-term"|"long-term" }, "suggestedRenovations": optional array of { "name": string, "cost": number, "rentJustification": number, "reason": string } }
8. "insightCards": Array of 3-4 cards { "icon": emoji, "title": string, "value": string, "subtext": string, "color": "green"|"yellow"|"red"|"blue"|"purple" }`;

        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: `You are an expert real estate investment advisor specializing in rental property optimization. 
Analyze rental pricing dynamics and provide actionable insights. Be specific with numbers and recommendations.
Always consider the relationship between property condition, rental rates, tenant quality, and cash flow.
Format your response as a JSON object.`
              },
              { role: 'user', content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 1500,
            response_format: { type: 'json_object' }
          })
        });

        if (openaiRes.ok) {
          const openaiData = await openaiRes.json();
          const content = openaiData.choices?.[0]?.message?.content;
          
          if (content) {
            const aiAnalysis = JSON.parse(content);
            console.log('[Rental Pricing AI] AI analysis complete');
            
            return res.json({
              ok: true,
              source: 'ai',
              analysis: {
                ...aiAnalysis,
                situation,
                situationSeverity,
                marketComparison: {
                  ...aiAnalysis.marketComparison,
                  percentDifference,
                  dollarDifference
                }
              }
            });
          }
        }
      } catch (aiError) {
        console.warn('[Rental Pricing AI] AI analysis failed, using rule-based:', aiError.message);
      }
    }

    // Fallback to rule-based analysis
    console.log('[Rental Pricing AI] Using rule-based analysis');
    const ruleBasedAnalysis = generateRuleBasedRentalAnalysis(
      currentRent, marketPotentialRent, marketAverage,
      situation, situationSeverity, percentDifference, dollarDifference,
      currentCashFlow, monthlyExpenses, monthlyMortgage,
      conditionScore, availableRenovations, percentileRank
    );

    res.json({
      ok: true,
      source: 'rule-based',
      analysis: ruleBasedAnalysis
    });

  } catch (error) {
    console.error('[Rental Pricing AI] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Helper function for rule-based rental analysis
function generateRuleBasedRentalAnalysis(
  currentRent, marketPotentialRent, marketAverage,
  situation, situationSeverity, percentDifference, dollarDifference,
  currentCashFlow, monthlyExpenses, monthlyMortgage,
  conditionScore, availableRenovations, percentileRank
) {
  const actualCashFlow = currentCashFlow ?? 
    (currentRent - (monthlyExpenses || 0) - (monthlyMortgage || 0));
  
  let summary, marketPosition, risks = [], opportunities = [], primaryRecommendation;
  let insightCards = [];

  if (situation === 'above_market') {
    if (situationSeverity === 'significant') {
      summary = `Your rent of $${currentRent}/mo is ${percentDifference.toFixed(0)}% above market rate ($${marketPotentialRent}/mo). This premium pricing could lead to tenant turnover issues if not justified by property condition.`;
      marketPosition = 'Premium pricing tier - significantly above comparable properties';
      risks = [
        { title: 'High Turnover Risk', description: `Tenants paying ${percentDifference.toFixed(0)}% above market may actively seek cheaper alternatives.`, severity: 'high' },
        { title: 'Extended Vacancy Periods', description: 'Premium-priced units may take 6+ weeks to lease vs 2-3 weeks for at-market properties.', severity: 'medium' }
      ];
      primaryRecommendation = 'Either reduce rent to align with market, or invest in renovations to justify the premium.';
    } else {
      summary = `Your rent is ${percentDifference.toFixed(0)}% above market ($${Math.abs(dollarDifference)}/mo premium). You're generating strong cash flow.`;
      marketPosition = 'Above-market pricing - moderate premium';
      primaryRecommendation = 'Current pricing is sustainable. Focus on tenant retention through excellent service.';
    }
    
    insightCards = [
      { icon: '💰', title: 'Monthly Premium', value: `+$${dollarDifference.toLocaleString()}`, subtext: 'Above market rate', color: situationSeverity === 'significant' ? 'yellow' : 'green' },
      { icon: '📊', title: 'Market Position', value: `${percentDifference.toFixed(0)}%`, subtext: 'Above comparable rents', color: 'blue' },
      { icon: '🏠', title: 'Cash Flow', value: `$${actualCashFlow.toLocaleString()}/mo`, subtext: actualCashFlow > 0 ? 'Positive flow' : 'Negative flow', color: actualCashFlow > 0 ? 'green' : 'red' },
      { icon: situationSeverity === 'significant' ? '⚠️' : '✅', title: 'Risk Level', value: situationSeverity === 'significant' ? 'Elevated' : 'Low', subtext: 'Turnover risk', color: situationSeverity === 'significant' ? 'yellow' : 'green' }
    ];

  } else if (situation === 'below_market') {
    const potentialIncrease = Math.abs(dollarDifference);
    const potentialCashFlow = actualCashFlow + potentialIncrease;
    
    if (situationSeverity === 'significant') {
      summary = `You're leaving $${potentialIncrease}/mo on the table! Your rent is ${Math.abs(percentDifference).toFixed(0)}% below market. Raising rent would add $${(potentialIncrease * 12).toLocaleString()}/year to your cash flow.`;
      marketPosition = 'Significantly underpriced - major opportunity for income growth';
      opportunities = [
        { title: 'Significant Income Opportunity', description: `Raising rent to market rate would increase annual income by $${(potentialIncrease * 12).toLocaleString()}.`, potentialImpact: `+$${potentialIncrease}/mo cash flow` },
        { title: '5-Year Impact', description: `Over 5 years, market-rate pricing would generate an additional $${(potentialIncrease * 12 * 5).toLocaleString()}.`, potentialImpact: 'Substantial wealth building' }
      ];
      primaryRecommendation = `Implement a rent increase plan: Start with a $${Math.round(potentialIncrease * 0.6)}/mo increase at next lease renewal.`;
    } else {
      summary = `Your rent is ${Math.abs(percentDifference).toFixed(0)}% below market. While this provides tenant stability, you're missing $${potentialIncrease}/mo in potential income.`;
      marketPosition = 'Below market - opportunity for optimization';
      primaryRecommendation = `Consider a rent increase of $${Math.round(potentialIncrease * 0.8)}/mo at the next lease renewal.`;
    }
    
    insightCards = [
      { icon: '📉', title: 'Below Market', value: `-$${Math.abs(dollarDifference).toLocaleString()}`, subtext: 'Monthly opportunity cost', color: situationSeverity === 'significant' ? 'red' : 'yellow' },
      { icon: '💵', title: 'Potential Cash Flow', value: `$${potentialCashFlow.toLocaleString()}/mo`, subtext: 'At market rate', color: 'green' },
      { icon: '📈', title: '5-Year Impact', value: `+$${(potentialIncrease * 12 * 5).toLocaleString()}`, subtext: 'Cumulative additional income', color: 'blue' },
      { icon: '🎯', title: 'Market Rate', value: `$${marketPotentialRent.toLocaleString()}`, subtext: 'Target rent', color: 'purple' }
    ];

  } else {
    summary = `Your rent of $${currentRent}/mo is right at market rate. You've found the optimal balance.`;
    marketPosition = 'At market rate - optimal pricing achieved';
    primaryRecommendation = 'Maintain current pricing and focus on property improvements to command premium rates.';
    
    insightCards = [
      { icon: '✅', title: 'Pricing Status', value: 'Optimal', subtext: 'At market rate', color: 'green' },
      { icon: '💰', title: 'Monthly Rent', value: `$${currentRent.toLocaleString()}`, subtext: 'Current rate', color: 'blue' },
      { icon: '🏠', title: 'Cash Flow', value: `$${actualCashFlow.toLocaleString()}/mo`, subtext: actualCashFlow > 0 ? 'Positive flow' : 'Needs attention', color: actualCashFlow > 0 ? 'green' : 'yellow' },
      { icon: '📊', title: 'Market Rank', value: `${percentileRank || 50}th`, subtext: 'Percentile', color: 'purple' }
    ];
  }

  // Add suggested renovations if available
  let suggestedRenovations;
  if (availableRenovations && availableRenovations.length > 0) {
    suggestedRenovations = availableRenovations.slice(0, 3).map(r => ({
      name: r.name,
      cost: r.cost,
      rentJustification: r.rentIncrease,
      reason: situation === 'above_market' 
        ? `Justifies current premium with +$${r.rentIncrease}/mo value`
        : `Would allow +$${r.rentIncrease}/mo rent increase with ${r.paybackMonths} month payback`
    }));
  }

  const potentialRent = situation === 'below_market' ? marketPotentialRent : currentRent;
  const potentialCashFlow = potentialRent - (monthlyExpenses || 0) - (monthlyMortgage || 0);
  const annualDifference = (potentialCashFlow - actualCashFlow) * 12;

  return {
    summary,
    situation,
    situationSeverity,
    marketComparison: {
      explanation: `Your current rent of $${currentRent}/mo places you ${
        situation === 'above_market' ? `$${dollarDifference} above` : 
        situation === 'below_market' ? `$${Math.abs(dollarDifference)} below` : 
        'right at'
      } the market rate of $${marketPotentialRent}/mo.`,
      percentDifference,
      dollarDifference,
      marketPosition
    },
    risks,
    opportunities,
    financialImpact: {
      currentMonthlyCashFlow: actualCashFlow,
      potentialMonthlyCashFlow: potentialCashFlow,
      annualDifference,
      fiveYearImpact: annualDifference * 5,
      explanation: situation === 'below_market'
        ? `Raising rent to market rate would increase your annual cash flow by $${annualDifference.toLocaleString()}.`
        : situation === 'above_market'
        ? `Your premium pricing generates $${(dollarDifference * 12).toLocaleString()}/year above market.`
        : 'Your cash flow is optimized at current market-rate pricing.'
    },
    recommendations: {
      primary: primaryRecommendation,
      actions: [
        { action: 'Review rent at next lease renewal', impact: 'Stay aligned with market trends', priority: 'short-term' },
        { action: 'Track comparable rental listings monthly', impact: 'Informed pricing decisions', priority: 'long-term' }
      ],
      suggestedRenovations
    },
    insightCards
  };
}

const rentSubjectMemoryCache = new Map();
const RENT_SUBJECT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function normalizeRentSubjectCacheKey(address) {
  return String(address || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function withRentSubjectTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
    }),
  ]);
}

function buildSubjectCompCacheSignature(subject) {
  return {
    version: 10,
    zipCode: String(subject.zipCode || ''),
    bedrooms: Number.isFinite(Number(subject.bedrooms)) ? Math.round(Number(subject.bedrooms)) : null,
    bathrooms: Number.isFinite(Number(subject.bathrooms)) ? Number(subject.bathrooms) : null,
    squareFeet: Number.isFinite(Number(subject.squareFeet)) ? Number(subject.squareFeet) : null,
    yearBuilt: Number.isFinite(Number(subject.yearBuilt)) ? Math.round(Number(subject.yearBuilt)) : null,
    propertyType: subject.propertyType || null,
    latitude: Number.isFinite(Number(subject.latitude)) ? Number(subject.latitude) : null,
    longitude: Number.isFinite(Number(subject.longitude)) ? Number(subject.longitude) : null,
    subjectAddress: subject.address || null,
  };
}

async function warmSubjectComparableCache(subject, userId = null) {
  if (!subject?.zipCode || !subject?.address) return { warmed: false, reason: 'incomplete_subject' };

  const signature = buildSubjectCompCacheSignature(subject);
  const cacheKeys = [
    `rentcast-comp:${subject.address}`,
    userId ? `rentcast-comp:${userId}:${subject.address}` : null,
  ].filter(Boolean);

  for (const cacheKey of cacheKeys) {
    const existing = await getCachedRentalCompData(cacheKey, signature, 72);
    if (existing?.matchedCount) {
      return { warmed: true, fromCache: true, matchedCount: existing.matchedCount, cacheKey };
    }
  }

  const comps = await getRentalListingComparables({
    zipCode: subject.zipCode,
    latitude: subject.latitude,
    longitude: subject.longitude,
    bedrooms: subject.bedrooms,
    bathrooms: subject.bathrooms,
    squareFeet: subject.squareFeet,
    yearBuilt: subject.yearBuilt,
    propertyType: subject.propertyType,
    subjectAddress: subject.address,
  });

  if (!comps?.matchedCount) {
    return { warmed: false, reason: 'no_comps', matchedCount: 0 };
  }

  await Promise.all(cacheKeys.map((cacheKey) => setCachedRentalCompData(cacheKey, signature, comps)));
  return { warmed: true, fromCache: false, matchedCount: comps.matchedCount };
}

// POST /api/market-analysis/rent-subject
// Resolves a manually entered address into one coherent subject package so
// rent/DOM overrides cannot accidentally retain another portfolio property's
// coordinates or physical attributes. Also warms the subject-specific rental
// comps cache so the next rent-potential call is a cache hit.
app.post('/api/market-analysis/rent-subject', async (req, res) => {
  try {
    const address = String(req.body?.address || '').trim();
    if (!address) return res.status(400).json({ ok: false, error: 'Address is required.' });

    const userId = String(req.body?.userId || '').trim() || null;
    const skipCache = String(req.body?.skipCache || '').toLowerCase() === 'true';
    const warmComps = String(req.body?.warmComps || 'true').toLowerCase() !== 'false';
    const cacheAddressKey = normalizeRentSubjectCacheKey(address);

    if (!skipCache && rentSubjectMemoryCache.has(cacheAddressKey)) {
      const cached = rentSubjectMemoryCache.get(cacheAddressKey);
      if (cached && Date.now() - cached.cachedAt < RENT_SUBJECT_CACHE_TTL_MS) {
        let compsCache = { warmed: false, fromCache: true };
        if (warmComps && cached.payload?.subject) {
          try {
            compsCache = await withRentSubjectTimeout(
              warmSubjectComparableCache(cached.payload.subject, userId),
              25000,
              'comps_warm',
            );
          } catch (error) {
            console.warn('[RentSubject] cached subject comps warm skipped:', error.message);
          }
        }
        return res.json({ ...cached.payload, fromCache: true, compsCache });
      }
    }

    const [dashboardResult, geocodeResult, listingResult] = await Promise.allSettled([
      (async () => {
        const cached = await getCachedAttomData(address);
        if (cached?.data && isUsableAttomDashboardData(cached.data)) {
          return cached.data;
        }
        const fresh = await withRentSubjectTimeout(
          fetchPropertyDashboard({ address, includeComponents: false }),
          12000,
          'attom',
        );
        if (fresh && address) {
          cacheAttomData(address, fresh).catch(() => {});
        }
        return fresh;
      })(),
      withRentSubjectTimeout(geocodeLocation(address), 8000, 'geocode'),
      // Include historical/removed records because the subject may have just
      // gone stale or been temporarily withdrawn from active syndication.
      withRentSubjectTimeout(getRentalListingByAddress(address, { status: null }), 10000, 'rentcast_listing'),
    ]);
    const dashboard = dashboardResult.status === 'fulfilled' ? dashboardResult.value : null;
    const geocode = geocodeResult.status === 'fulfilled' ? geocodeResult.value : null;
    const listing = listingResult.status === 'fulfilled' && listingResult.value?.matched
      ? listingResult.value
      : null;
    const summary = dashboard?.summary || {};
    const latitude = Number(summary.latitude ?? geocode?.location?.lat);
    const longitude = Number(summary.longitude ?? geocode?.location?.lng);
    const resolvedAddress = summary.address || listing?.formattedAddress || geocode?.formattedAddress || address;
    const zipMatches = [
      ...String(resolvedAddress).matchAll(/\b\d{5}(?:-\d{4})?\b/g),
      ...String(address).matchAll(/\b\d{5}(?:-\d{4})?\b/g),
    ];
    const zipCode = zipMatches.at(-1)?.[0]?.slice(0, 5)
      || null;

    if (!zipCode || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(422).json({
        ok: false,
        error: 'Could not resolve a ZIP code and coordinates for that address.',
      });
    }

    const subject = {
      address: resolvedAddress,
      zipCode,
      latitude,
      longitude,
      bedrooms: Number(summary.beds || dashboard?.beds || listing?.bedrooms) || null,
      bathrooms: Number(summary.baths || dashboard?.bathrooms || dashboard?.baths || listing?.bathrooms) || null,
      squareFeet: Number(
        summary.living_sqft || summary.building_sqft || summary.sqft
        || dashboard?.living_sqft || dashboard?.building_sqft || dashboard?.sqft
        || listing?.squareFootage,
      ) || null,
      yearBuilt: Number(summary.year_built || dashboard?.yearBuilt) || null,
      propertyType: summary.property_type || dashboard?.propertyType || listing?.propertyType || null,
      listedRent: Number(listing?.listedRent) || null,
      daysOnMarket: Number.isFinite(Number(listing?.daysOnMarket))
        ? Number(listing.daysOnMarket)
        : null,
      attomRentAvm: Number(summary.rental_avm) || null,
      attomRentLow: Number(summary.rental_avm_low) || null,
      attomRentHigh: Number(summary.rental_avm_high) || null,
      attomId: summary.attom_id || null,
    };

    let compsCache = { warmed: false };
    if (warmComps) {
      try {
        compsCache = await withRentSubjectTimeout(
          warmSubjectComparableCache(subject, userId),
          25000,
          'comps_warm',
        );
      } catch (error) {
        console.warn('[RentSubject] comps warm skipped:', error.message);
        compsCache = { warmed: false, reason: error.message };
      }
    }

    const payload = {
      ok: true,
      subject,
      sources: {
        attom: Boolean(dashboard),
        geocode: Boolean(geocode),
        rentcastListing: Boolean(listing),
      },
      compsCache,
    };
    rentSubjectMemoryCache.set(cacheAddressKey, { cachedAt: Date.now(), payload });
    rentSubjectMemoryCache.set(normalizeRentSubjectCacheKey(resolvedAddress), {
      cachedAt: Date.now(),
      payload,
    });

    return res.json({ ...payload, fromCache: false });
  } catch (error) {
    console.error('[RentSubject] lookup failed:', error.message);
    return res.status(500).json({ ok: false, error: error.message || 'subject_lookup_failed' });
  }
});

// POST /api/market-analysis/rent-condition-analysis
// Visible-condition input for rental pricing. The model returns a bounded,
// auditable adjustment and never claims to detect hidden defects.
app.post('/api/market-analysis/rent-condition-analysis', async (req, res) => {
  try {
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!images.length) {
      return res.status(400).json({ ok: false, error: 'At least one property photo is required.' });
    }
    const analysis = await analyzeRentalCondition({
      images,
      property: req.body?.property || {},
      apiKey: OPENAI_API_KEY,
    });
    return res.json({ ok: true, analysis });
  } catch (error) {
    console.error('[RentCondition] analysis failed:', error.message);
    const status = error.message === 'openai_not_configured' ? 503 : 500;
    return res.status(status).json({ ok: false, error: error.message || 'condition_analysis_failed' });
  }
});

// POST /api/market-analysis/rent-potential - Real market-informed rental pricing data
app.post('/api/market-analysis/rent-potential', async (req, res) => {
  try {
    const {
      userId,
      cachePropertyId,
      propertyId,
      currentRent,
      bedrooms,
      bathrooms,
      squareFeet,
      zipCode,
      latitude,
      longitude,
      propertyType,
      yearBuilt,
      schoolRating,
      subjectDaysOnMarket: reportedSubjectDaysOnMarket,
      conditionAnalysis,
      attomRentAvm,
      attomRentLow,
      attomRentHigh
    } = req.body;

    if (!currentRent || !zipCode) {
      return res.status(400).json({ error: 'currentRent and zipCode are required' });
    }

    console.log(`[RentPotential] Analyzing rent $${currentRent} for ZIP ${zipCode} (${bedrooms}bd/${bathrooms}ba, ${squareFeet}sqft)`);

    const normalizedBedrooms = Number.isFinite(Number(bedrooms)) ? Math.round(Number(bedrooms)) : null;
    const normalizedBathrooms = Number.isFinite(Number(bathrooms)) ? Number(bathrooms) : null;
    const normalizedSquareFeet = Number.isFinite(Number(squareFeet)) ? Number(squareFeet) : null;
    const normalizedLatitude = Number.isFinite(Number(latitude)) ? Number(latitude) : null;
    const normalizedLongitude = Number.isFinite(Number(longitude)) ? Number(longitude) : null;
    const cacheKey = userId && cachePropertyId
      ? `rentcast-comp:${userId}:${cachePropertyId}`
      : propertyId
        ? `rentcast-comp:${propertyId}`
        : null;
    const rentPotentialCacheKey = userId && cachePropertyId
      ? `rent-potential:${userId}:${cachePropertyId}`
      : propertyId
        ? `rent-potential:${propertyId}`
        : null;
    const cacheSignature = {
      version: 10,
      zipCode: String(zipCode),
      bedrooms: normalizedBedrooms,
      bathrooms: normalizedBathrooms,
      squareFeet: normalizedSquareFeet,
      yearBuilt: Number.isFinite(Number(yearBuilt)) ? Math.round(Number(yearBuilt)) : null,
      propertyType: propertyType || null,
      latitude: normalizedLatitude,
      longitude: normalizedLongitude,
      subjectAddress: typeof propertyId === 'string' ? propertyId : null,
    };
    const rentPotentialCacheSignature = {
      version: 10,
      currentRent: Number(currentRent),
      zipCode: String(zipCode),
      bedrooms: normalizedBedrooms,
      bathrooms: normalizedBathrooms,
      squareFeet: normalizedSquareFeet,
      propertyType: propertyType || null,
      yearBuilt: Number.isFinite(Number(yearBuilt)) ? Math.round(Number(yearBuilt)) : null,
      schoolRating: Number.isFinite(Number(schoolRating)) ? Number(schoolRating) : null,
      subjectDaysOnMarket: Number.isFinite(Number(reportedSubjectDaysOnMarket))
        ? Number(reportedSubjectDaysOnMarket)
        : null,
      conditionScore: Number.isFinite(Number(conditionAnalysis?.conditionScore))
        ? Number(conditionAnalysis.conditionScore)
        : null,
      conditionAdjustmentPct: Number.isFinite(Number(conditionAnalysis?.rentAdjustmentPct))
        ? Number(conditionAnalysis.rentAdjustmentPct)
        : null,
      latitude: normalizedLatitude,
      longitude: normalizedLongitude,
      attomRentAvm: Number.isFinite(Number(attomRentAvm)) ? Number(attomRentAvm) : null,
      attomRentLow: Number.isFinite(Number(attomRentLow)) ? Number(attomRentLow) : null,
      attomRentHigh: Number.isFinite(Number(attomRentHigh)) ? Number(attomRentHigh) : null,
    };

    const cachedRentPotential = rentPotentialCacheKey
      ? await getCachedRentPotentialData(rentPotentialCacheKey, rentPotentialCacheSignature)
      : null;

    if (cachedRentPotential) {
      console.log(`[RentPotential] Returning cached pricing payload for ${rentPotentialCacheKey}`);
      return res.json({
        ...cachedRentPotential,
        dataSources: {
          ...(cachedRentPotential.dataSources || {}),
          rentPotentialCacheHit: true,
        },
      });
    }

    const cachedListingCompPackage = cacheKey
      ? await getCachedRentalCompData(cacheKey, cacheSignature, 72)
      : null;

    // Fetch Rentcast market data, listing-level comps, and FRED macro indicators.
    const [rentcastResult, macroResult, listingCompResult, subjectListingResult, localVacancyResult] = await Promise.allSettled([
      getZipMarketData(zipCode),
      getAdditionalMacroData(),
      cachedListingCompPackage
        ? Promise.resolve(cachedListingCompPackage)
        : getRentalListingComparables({
            zipCode,
            latitude: normalizedLatitude,
            longitude: normalizedLongitude,
            bedrooms: normalizedBedrooms,
            bathrooms: normalizedBathrooms,
            squareFeet: normalizedSquareFeet,
            yearBuilt,
            propertyType,
            subjectAddress: typeof propertyId === 'string' ? propertyId : null,
            limit: 100,
          }),
      typeof propertyId === 'string' && /\d/.test(propertyId)
        ? getRentalListingByAddress(propertyId, { status: 'Active' })
        : Promise.resolve({ matched: false, reason: 'subject_address_unavailable' }),
      getLocalRentalVacancy(zipCode),
    ]);

    const rentcastData = rentcastResult.status === 'fulfilled' ? rentcastResult.value : null;
    const macroData = macroResult.status === 'fulfilled' ? macroResult.value : null;
    const localVacancyData = localVacancyResult.status === 'fulfilled' && localVacancyResult.value?.ok
      ? localVacancyResult.value
      : null;
    const rawListingCompPackage = listingCompResult.status === 'fulfilled' ? listingCompResult.value : null;
    const directSubjectListing = subjectListingResult.status === 'fulfilled' && subjectListingResult.value?.matched
      ? {
          id: subjectListingResult.value.listingId || null,
          formattedAddress: subjectListingResult.value.formattedAddress || propertyId || null,
          price: subjectListingResult.value.listedRent ?? null,
          status: subjectListingResult.value.status || null,
          daysOnMarket: subjectListingResult.value.daysOnMarket ?? null,
          listedDate: subjectListingResult.value.listedDate || null,
        }
      : null;
    const listingCompPackage = rawListingCompPackage
      ? {
          ...rawListingCompPackage,
          subjectListing: directSubjectListing || rawListingCompPackage.subjectListing || null,
        }
      : null;
    const listingCompCacheHit = !!cachedListingCompPackage && listingCompResult.status === 'fulfilled';

    if (!cachedListingCompPackage && cacheKey && listingCompPackage?.matchedCount) {
      await setCachedRentalCompData(cacheKey, cacheSignature, listingCompPackage);
    }

    if (rentcastData) {
      console.log('[RentPotential] Rentcast data available');
    } else {
      console.warn('[RentPotential] Rentcast data unavailable, using estimates');
    }

    if (listingCompPackage?.matchedCount) {
      console.log(`[RentPotential] Listing comps available (${listingCompPackage.matchedCount}${listingCompCacheHit ? ', cache hit' : ', fresh fetch'})`);
    } else {
      console.warn('[RentPotential] Listing comps unavailable or insufficient, falling back to aggregate benchmarks');
    }

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const round1 = (value) => Math.round(value * 10) / 10;

    // Calculate market potential from Rentcast data
    let marketPotentialRent, marketAverage, comparableRents, percentileRank;
    let rentPerSqFt = null;
    let marketFactors = [];
    const rental = rentcastData?.rentalData || rentcastData?.rental || null;
    const sale = rentcastData?.saleData || rentcastData?.sale || null;
    const listingComparables = Array.isArray(listingCompPackage?.comparables) ? listingCompPackage.comparables : [];
    const listingSummary = listingCompPackage?.summary || null;
    let baseVacancyRate = 5.5;
    let nationalVacancyRate = null;
    let mortgageRate = null;
    let consumerSentiment = null;
    let employmentClaims = null;
    let comparablesMethod = {
      source: 'Estimated fallback benchmark',
      matching: ['current-rent-derived estimate'],
      limitations: ['No RentCast market aggregate or listing data available']
    };

    const listingCompSampleAdequate = Boolean(
      listingCompPackage?.cleanSampleAdequate
      && Number(listingCompPackage?.matchedCount) >= 8
    );

    if (listingSummary?.weightedMedianRent && listingCompSampleAdequate) {
      marketPotentialRent = Number(listingSummary.weightedMedianRent);
      marketAverage = Number(listingSummary.averageRent) || marketPotentialRent;
      comparableRents = listingComparables
        .map((listing) => Number(listing.sizeAdjustedRent || listing.price))
        .filter((price) => Number.isFinite(price) && price > 0)
        .sort((a, b) => a - b);
      percentileRank = comparableRents.length > 0
        ? Math.round((comparableRents.filter((rent) => rent < currentRent).length / comparableRents.length) * 100)
        : 50;

      const compRentPerSqFt = listingComparables
        .map((listing) => listing.squareFootage ? listing.price / listing.squareFootage : null)
        .filter((value) => Number.isFinite(value) && value > 0);
      rentPerSqFt = Number(listingSummary.weightedMedianRentPerSqFt)
        || (compRentPerSqFt.length
          ? compRentPerSqFt.reduce((sum, value) => sum + value, 0) / compRentPerSqFt.length
          : null);

      comparablesMethod = {
        source: 'RentCast listing-level long-term rental comps',
        matching: [
          'active long-term rental listings',
          'bedroom ±1 filter',
          'bathroom ±1 filter',
          'square-foot ±25% filter',
          'year-built similarity filter',
          'normalized property-type match',
          'duplicate and subject-address removal',
          'IQR outlier trimming on rent per square foot',
          'size-adjusted weighted median',
          normalizedLatitude && normalizedLongitude ? 'adaptive 1.5–5 mile radius search' : 'ZIP search'
        ].filter(Boolean),
        limitations: [
          'Uses active asking-rent comps, not closed lease rents',
          'Accuracy depends on RentCast listing coverage in the subject market'
        ],
        diagnostics: {
          cleanCompCount: listingCompPackage.matchedCount,
          totalFetched: listingCompPackage.totalFetched,
          duplicatesRemoved: Math.max(
            0,
            Number(listingCompPackage.totalFetched || 0) - Number(listingCompPackage.totalAfterDedupe || 0)
          ),
          outliersRemoved: Number(listingCompPackage.outliersRemoved || 0),
          radiusUsed: listingCompPackage.search?.radiusUsed ?? null,
          subjectExcluded: Boolean(listingCompPackage.search?.subjectExcluded),
          weightedMedianRentPerSqFt: listingSummary.weightedMedianRentPerSqFt ?? null,
        }
      };
    } else if (rental) {
      // Find matching bedroom count in by-bedrooms breakdown
      const bedroomMatch = (rental.byBedrooms || []).find(b => b.bedrooms === bedrooms);
      const singleFamilyMatch = (rental.byPropertyType || []).find((propertyTypeBucket) => {
        const label = String(propertyTypeBucket.propertyType || propertyTypeBucket.label || '').toLowerCase();
        return label.includes('single') || label.includes('detached') || label.includes('house');
      });

      const bedroomMedianRent = Number(bedroomMatch?.median) || null;
      const bedroomPerSqFt = Number(bedroomMatch?.medianPerSquareFoot) || Number(rental.medianPerSquareFoot) || null;
      const sqftBenchmarkRent = bedroomPerSqFt && squareFeet ? Math.round(bedroomPerSqFt * Number(squareFeet)) : null;
      const singleFamilyMedianRent = Number(singleFamilyMatch?.median) || null;
      const saleMedianPrice = Number(sale?.median) || Number(rentcastData?.derived?.medianSalePrice) || null;
      const grossYieldPct = Number(rentcastData?.derived?.grossYieldPct) || null;
      const saleImpliedRent = saleMedianPrice && grossYieldPct
        ? Math.round((saleMedianPrice * (grossYieldPct / 100)) / 12)
        : null;

      if (bedroomMedianRent) {
        marketPotentialRent = bedroomMedianRent;
        marketAverage = Number(bedroomMatch?.average) || bedroomMedianRent;
        rentPerSqFt = bedroomMatch.medianPerSquareFoot;

        // Guardrail for large homes: ZIP bedroom medians can skew low when inventory is apartment-heavy.
        if (Number(squareFeet) >= 2200 || currentRent > marketPotentialRent * 1.25) {
          const benchmarkCandidates = [
            marketPotentialRent,
            sqftBenchmarkRent,
            singleFamilyMedianRent,
            saleImpliedRent
          ].filter((candidate) => Number.isFinite(candidate) && candidate > 0);

          if (benchmarkCandidates.length > 0) {
            const optimisticBenchmark = Math.max(...benchmarkCandidates);
            // Only lift benchmark when the spread is material to avoid overreacting to noisy data.
            if (optimisticBenchmark > marketPotentialRent * 1.12) {
              marketPotentialRent = Math.round(marketPotentialRent * 0.6 + optimisticBenchmark * 0.4);
            }
          }
        }
      } else {
        marketPotentialRent = rental.median || Math.round(currentRent * 1.1);
        marketAverage = rental.average || marketPotentialRent;
        rentPerSqFt = rental.medianPerSquareFoot;
      }

      // Build comparable rents from breakdown data
      const allBreakdowns = [...(rental.byBedrooms || []), ...(rental.byPropertyType || [])];
      comparableRents = allBreakdowns
        .filter(b => b.median && b.median > 0)
        .map(b => b.median)
        .sort((a, b) => a - b);

      // Add min/max/average to comparables for distribution
      if (rental.min) comparableRents.unshift(rental.min);
      if (rental.max) comparableRents.push(rental.max);
      comparableRents = [...new Set(comparableRents)].sort((a, b) => a - b);

      // If we have fewer than 5 comparables, interpolate
      if (comparableRents.length < 5 && rental.min && rental.max) {
        const step = (rental.max - rental.min) / 6;
        comparableRents = Array.from({ length: 7 }, (_, i) => Math.round(rental.min + step * i));
      }

      // Calculate percentile rank
      if (comparableRents.length > 0) {
        const belowCount = comparableRents.filter(r => r < currentRent).length;
        percentileRank = Math.round((belowCount / comparableRents.length) * 100);
      } else {
        percentileRank = 50;
      }

      comparablesMethod = {
        source: 'RentCast ZIP aggregates + ATTOM subject benchmark blending',
        matching: [
          'bedroom bucket',
          'property-type bucket',
          'square-foot normalization',
          'subject rent AVM/range anchoring',
          'subject school/year-built alignment'
        ],
        limitations: [
          'Not enough listing-level comps were available for a direct comp set',
          'No direct per-listing school-score match in the market aggregate feed'
        ]
      };
    } else {
      // Fallback estimates
      const pricePerSqFt = currentRent / squareFeet;
      const marketPricePerSqFt = pricePerSqFt * 1.15;
      marketPotentialRent = Math.round(squareFeet * marketPricePerSqFt);
      marketAverage = marketPotentialRent;
      // Deterministic, explicitly estimated distribution. Never fabricate random comps.
      comparableRents = [0.85, 0.9, 0.94, 0.97, 0.99, 1, 1.01, 1.03, 1.06, 1.1, 1.15]
        .map((ratio) => Math.round(marketPotentialRent * ratio));
      percentileRank = Math.round(
        (comparableRents.filter(r => r < currentRent).length / comparableRents.length) * 100
      );
    }

    const subjectYearBuilt = Number(yearBuilt) || null;
    const subjectSchoolRating = Number(schoolRating) || null;
    const subjectAttomRent = Number(attomRentAvm) || null;
    const subjectAttomLow = Number(attomRentLow) || null;
    const subjectAttomHigh = Number(attomRentHigh) || null;

    // Strong listing-level comp sets remain authoritative. ATTOM is a fallback
    // anchor only when listing coverage is insufficient or noisy.
    if (subjectAttomRent && subjectAttomRent > 0 && !listingCompSampleAdequate) {
      marketPotentialRent = marketPotentialRent
        ? Math.round(marketPotentialRent * 0.65 + subjectAttomRent * 0.35)
        : Math.round(subjectAttomRent);

      marketAverage = marketAverage
        ? Math.round(marketAverage * 0.7 + subjectAttomRent * 0.3)
        : Math.round(subjectAttomRent);

      if (subjectAttomLow || subjectAttomHigh) {
        const lowBound = subjectAttomLow || Math.round(subjectAttomRent * 0.9);
        const highBound = subjectAttomHigh || Math.round(subjectAttomRent * 1.1);
        marketPotentialRent = clamp(marketPotentialRent, lowBound, highBound);
      }
    }

    // Subject multipliers are only appropriate for aggregate/fallback data.
    // Strong listing-level comps already encode the subject's size and class.
    let subjectMatchMultiplier = 1.0;
    if (!listingCompSampleAdequate) {
      if (Number(squareFeet) >= 3000) subjectMatchMultiplier += 0.035;
      if (Number(bedrooms) >= 5) subjectMatchMultiplier += 0.025;
      if (Number(bathrooms) >= 3.5) subjectMatchMultiplier += 0.015;
      if (subjectSchoolRating && subjectSchoolRating >= 8) subjectMatchMultiplier += 0.02;
      if (subjectYearBuilt && subjectYearBuilt < 1980) subjectMatchMultiplier -= 0.01;
      if (subjectYearBuilt && subjectYearBuilt >= 2000) subjectMatchMultiplier += 0.01;
    }

    marketPotentialRent = Math.round(marketPotentialRent * subjectMatchMultiplier);
    marketAverage = Math.round((marketAverage || marketPotentialRent) * subjectMatchMultiplier);

    const marketBenchmarkBeforeCondition = marketPotentialRent;
    const conditionScore = Number(conditionAnalysis?.conditionScore);
    const requestedConditionAdjustment = Number(conditionAnalysis?.rentAdjustmentPct);
    const conditionAdjustmentPct = Number.isFinite(conditionScore)
      && Number.isFinite(requestedConditionAdjustment)
      ? round1(clamp(requestedConditionAdjustment, -5, 4))
      : 0;
    const conditionAdjustmentDollar = Math.round(
      marketBenchmarkBeforeCondition * conditionAdjustmentPct / 100,
    );
    if (conditionAdjustmentPct !== 0) {
      marketPotentialRent = Math.round(marketBenchmarkBeforeCondition + conditionAdjustmentDollar);
      marketAverage = Math.round(marketAverage * (1 + conditionAdjustmentPct / 100));
    }

    // Build market factors from FRED macro data
    if (macroData) {
      const findIndicator = (label) => {
        if (Array.isArray(macroData)) return macroData.find(d => d.label === label);
        if (macroData.indicators) return macroData.indicators.find(d => d.label === label);
        return null;
      };

      const mortgage15 = findIndicator('15-Year Fixed Mortgage');
      const vacancy = findIndicator('Rental Vacancy Rate');
      const sentiment = findIndicator('Consumer Sentiment');
      const constructionPPI = findIndicator('Construction Materials PPI');
      const jobless = findIndicator('Initial Jobless Claims');

      if (mortgage15) {
        const rate = parseFloat(mortgage15.value);
        mortgageRate = Number.isFinite(rate) ? rate : null;
        marketFactors.push({
          name: 'Mortgage Rate Pressure',
          impact: rate < 5 ? 90 : rate < 6 ? 70 : rate < 7 ? 50 : 30,
          description: `15yr fixed at ${mortgage15.value}% — ${rate < 5.5 ? 'low rates push buyers out of rental market' : 'high rates keep renters renting'}`,
          source: 'FRED',
          rawValue: mortgage15.value,
          trend: mortgage15.mom ? (parseFloat(mortgage15.mom) > 0 ? 'up' : 'down') : 'flat'
        });
      }
      if (vacancy) {
        const vRate = parseFloat(vacancy.value);
        nationalVacancyRate = Number.isFinite(vRate) ? vRate : null;
        baseVacancyRate = Number.isFinite(vRate) ? vRate : baseVacancyRate;
        marketFactors.push({
          name: 'Rental Vacancy Rate',
          impact: vRate < 4 ? 90 : vRate < 6 ? 75 : vRate < 8 ? 50 : 30,
          description: `National vacancy at ${vacancy.value}% — ${vRate < 5 ? 'tight market favors landlords' : 'elevated vacancy weakens pricing power'}`,
          source: 'FRED',
          rawValue: vacancy.value,
          trend: vacancy.mom ? (parseFloat(vacancy.mom) > 0 ? 'up' : 'down') : 'flat'
        });
      }
      if (sentiment) {
        const sent = parseFloat(sentiment.value);
        consumerSentiment = Number.isFinite(sent) ? sent : null;
        marketFactors.push({
          name: 'Consumer Sentiment',
          impact: sent > 80 ? 85 : sent > 60 ? 65 : 40,
          description: `UMich Sentiment at ${sentiment.value} — ${sent > 70 ? 'confident consumers accept rent increases' : 'weak sentiment limits pricing power'}`,
          source: 'FRED',
          rawValue: sentiment.value,
          trend: sentiment.mom ? (parseFloat(sentiment.mom) > 0 ? 'up' : 'down') : 'flat'
        });
      }
      if (constructionPPI) {
        marketFactors.push({
          name: 'Construction Cost Trend',
          impact: 60,
          description: `PPI at ${constructionPPI.value} — ${constructionPPI.yoy ? `${constructionPPI.yoy}% YoY` : 'stable'}, affects renovation ROI`,
          source: 'FRED',
          rawValue: constructionPPI.value,
          trend: constructionPPI.mom ? (parseFloat(constructionPPI.mom) > 0 ? 'up' : 'down') : 'flat'
        });
      }
      if (jobless) {
        const claims = parseInt(jobless.value.replace(/,/g, ''));
        employmentClaims = Number.isFinite(claims) ? claims : null;
        marketFactors.push({
          name: 'Employment Health',
          impact: claims < 220000 ? 85 : claims < 280000 ? 65 : 40,
          description: `${jobless.value} weekly claims — ${claims < 250000 ? 'strong employment supports rents' : 'rising joblessness threatens demand'}`,
          source: 'FRED',
          rawValue: jobless.value,
          trend: jobless.mom ? (parseFloat(jobless.mom) > 0 ? 'up' : 'down') : 'flat'
        });
      }
      if (subjectSchoolRating) {
        marketFactors.push({
          name: 'School Quality Alignment',
          impact: clamp(subjectSchoolRating * 10, 30, 95),
          description: `Subject school rating ${subjectSchoolRating}/10 used to align benchmark to neighborhood quality tier`,
          source: 'ATTOM/subject',
          rawValue: String(subjectSchoolRating),
          trend: 'flat'
        });
      }
    }

    if (localVacancyData?.vacancyRate != null) {
      const observedRate = Number(localVacancyData.vacancyRate);
      const localReliability = clamp(
        clamp(Number(localVacancyData.rentalInventory || 0) / 2500, 0.35, 0.9)
          * clamp(1 - Number(localVacancyData.vacancyRateMoe || 0) / 10, 0.45, 1),
        0.25,
        0.9,
      );
      const fallbackRate = nationalVacancyRate ?? baseVacancyRate;
      // Local observed structural vacancy supersedes the national FRED series
      // as the primary baseline, but wide ACS sampling error is explicitly
      // shrunk toward the macro rate instead of treating the point estimate as exact.
      baseVacancyRate = clamp(
        observedRate * localReliability + fallbackRate * (1 - localReliability),
        1.5,
        20,
      );
      localVacancyData.modelReliability = round1(localReliability);
      localVacancyData.blendedBaselineRate = round1(baseVacancyRate);
      marketFactors.push({
        name: 'Local Observed Rental Vacancy',
        impact: observedRate < 4 ? 90 : observedRate < 6 ? 75 : observedRate < 8 ? 55 : 35,
        description: `${localVacancyData.survey} ZCTA rental vacancy is ${observedRate}%`
          + (localVacancyData.vacancyRateMoe != null
            ? ` (approx. ±${localVacancyData.vacancyRateMoe} pts)`
            : '')
          + `; reliability-weighted baseline is ${round1(baseVacancyRate)}% before live RentCast adjustments.`,
        source: 'U.S. Census ACS',
        rawValue: `${observedRate}%`,
        trend: 'flat',
      });
    }

    if (Number.isFinite(conditionScore)) {
      marketFactors.push({
        name: 'Visible Property Condition',
        impact: clamp(conditionScore, 0, 100),
        description: `AI visible-condition score ${Math.round(conditionScore)}/100`
          + ` applies a bounded ${conditionAdjustmentPct >= 0 ? '+' : ''}${conditionAdjustmentPct}% benchmark adjustment.`
          + ' Hidden defects and unphotographed areas are excluded.',
        source: 'Uploaded photos / OpenAI vision',
        rawValue: `${Math.round(conditionScore)}/100`,
        trend: 'flat',
      });
    }

    // Fallback market factors if none from FRED
    if (marketFactors.length === 0) {
      marketFactors = [
        { name: 'Location Score', impact: 85, description: 'Neighborhood desirability', source: 'estimate' },
        { name: 'School District', impact: 72, description: 'Quality of nearby schools', source: 'estimate' },
        { name: 'Market Demand', impact: 88, description: 'Local rental market activity', source: 'estimate' }
      ];
    }

    const averageFactorImpact = marketFactors.length
      ? marketFactors.reduce((sum, factor) => sum + (factor.impact || 0), 0) / marketFactors.length
      : 60;
    const listingRentSeries = listingComparables
      .map((listing) => Number(listing.sizeAdjustedRent || listing.price))
      .filter((rent) => Number.isFinite(rent) && rent > 0)
      .sort((left, right) => left - right);
    const percentile = (values, ratio) => {
      if (!Array.isArray(values) || values.length === 0) return null;
      const boundedRatio = Math.min(Math.max(ratio, 0), 1);
      const index = (values.length - 1) * boundedRatio;
      const lowerIndex = Math.floor(index);
      const upperIndex = Math.ceil(index);
      if (lowerIndex === upperIndex) return values[lowerIndex];
      const weight = index - lowerIndex;
      return values[lowerIndex] + (values[upperIndex] - values[lowerIndex]) * weight;
    };
    const average = (values) => {
      const numeric = values.filter((value) => Number.isFinite(value));
      return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null;
    };
    const compP25Rent = Math.round(percentile(listingRentSeries, 0.25) || Math.max(marketPotentialRent * 0.94, 0));
    const compMedianRent = Math.round(percentile(listingRentSeries, 0.5) || marketPotentialRent || currentRent);
    const compP75Rent = Math.round(percentile(listingRentSeries, 0.75) || Math.max(compMedianRent, marketPotentialRent * 1.04));
    const compP90Rent = Math.round(percentile(listingRentSeries, 0.9) || Math.max(compP75Rent, marketPotentialRent * 1.08));
    const compHighRent = Math.round(percentile(listingRentSeries, 0.98) || Math.max(compP90Rent, marketPotentialRent * 1.12));
    const medianDaysOnMarket = Number(listingSummary?.averageDaysOnMarket)
      || Number(rental?.medianDaysOnMarket)
      || Number(rentcastData?.derived?.medianDaysOnMarket)
      || null;
    const averageDaysOnMarket = Number(listingSummary?.averageDaysOnMarket)
      || Number(rental?.averageDaysOnMarket)
      || null;
    const totalListings = Number(listingCompPackage?.matchedCount)
      || Number(rental?.totalListings)
      || Number(rentcastData?.derived?.rentalListings)
      || null;
    const newListings = Number(rental?.newListings) || null;
    const grossYieldPct = Number(rentcastData?.derived?.grossYieldPct) || null;
    const priceToRentRatio = Number(rentcastData?.derived?.priceToRentRatio) || null;
    const saleVsRentDomSpread = Number(rentcastData?.derived?.saleVsRentDomSpread) || null;
    const compDaysOnMarketSeries = listingComparables
      .map((listing) => Number(listing.daysOnMarket))
      .filter((value) => Number.isFinite(value) && value >= 0);

    // ── DOM-based marketing-friction curve from comp data ───────────────
    // DOM is not physical vacancy or achieved lease-up time. It is retained
    // only as a relative absorption-risk signal between asking-price tiers.
    // Instead of converting DOM directly into annual vacancy, we:
    // 1. Sort comps by price and split into price bins at comp percentiles
    // 2. Compute average marketing time for each bin
    // 3. Translate relative DOM differences into a bounded risk adjustment
    //    around the independently anchored vacancy baseline below.
    const compPriceDomPairs = listingComparables
      .map((listing) => ({
        rent: Number(listing.price),
        dom: Number(listing.daysOnMarket),
      }))
      .filter((pair) => Number.isFinite(pair.rent) && pair.rent > 0 && Number.isFinite(pair.dom) && pair.dom >= 0)
      .sort((a, b) => a.rent - b.rent);

    let domBinData = null;
    let domBins = null;
    if (compPriceDomPairs.length >= 6) {
      // Split into price-ordered bins and compute the average DOM-derived
      // vacancy for each bin. This gives us empirical vacancy at different
      // price tiers without requiring a clean linear fit.
      const binCount = Math.min(4, Math.floor(compPriceDomPairs.length / 3));
      const binSize = Math.floor(compPriceDomPairs.length / binCount);
      const bins = [];
      for (let i = 0; i < binCount; i++) {
        const start = i * binSize;
        const end = i === binCount - 1 ? compPriceDomPairs.length : (i + 1) * binSize;
        const slice = compPriceDomPairs.slice(start, end);
        const avgRent = slice.reduce((s, p) => s + p.rent, 0) / slice.length;
        const avgDom = slice.reduce((s, p) => s + p.dom, 0) / slice.length;
        bins.push({ avgRent: Math.round(avgRent), avgDom: round1(avgDom), count: slice.length });
      }

      const domSpread = bins[bins.length - 1].avgDom - bins[0].avgDom;
      // Only infer a price-risk curve when higher asking tiers actually take
      // longer to absorb. Otherwise use the deterministic fallback curve.
      if (domSpread > 0 && compPriceDomPairs.length >= 8) {
        domBinData = {
          bins,
          n: compPriceDomPairs.length,
          domSpread: round1(domSpread),
        };
      }
    }
    // ────────────────────────────────────────────────────────────────────
    const compFreshShare = listingComparables.length
      ? round1((listingComparables.filter((listing) => Number(listing.daysOnMarket) <= 14).length / listingComparables.length) * 100)
      : 0;
    const compStaleShare = listingComparables.length
      ? round1((listingComparables.filter((listing) => Number(listing.daysOnMarket) >= 45).length / listingComparables.length) * 100)
      : 0;
    const activeStatusShare = listingComparables.length
      ? round1((listingComparables.filter((listing) => {
          const status = String(listing.status || '').toLowerCase();
          return !status || status.includes('active') || status.includes('new') || status.includes('listed');
        }).length / listingComparables.length) * 100)
      : null;
    const listingChurnRate = totalListings && newListings
      ? round1((newListings / Math.max(totalListings, 1)) * 100)
      : null;
    const monthsOfSupply = totalListings && newListings
      ? round1(totalListings / Math.max(newListings, 1))
      : null;
    const rentSpreadRatio = round1(((compP90Rent - compP25Rent) / Math.max(compMedianRent, 1)) * 100);
    const propertyTypeBucket = Array.isArray(rental?.byPropertyType)
      ? rental.byPropertyType.find((bucket) => {
          const bucketLabel = String(bucket.propertyType || bucket.label || '').toLowerCase();
          const requestedPropertyType = String(propertyType || '').toLowerCase();
          if (!bucketLabel || !requestedPropertyType) return false;
          return bucketLabel.includes(requestedPropertyType)
            || requestedPropertyType.includes(bucketLabel)
            || (requestedPropertyType.includes('single') && (bucketLabel.includes('single') || bucketLabel.includes('house')))
            || (requestedPropertyType.includes('town') && bucketLabel.includes('town'))
            || (requestedPropertyType.includes('condo') && bucketLabel.includes('condo'))
            || (requestedPropertyType.includes('apart') && bucketLabel.includes('apart'));
        })
      : null;
    const propertyTypePremiumPct = propertyTypeBucket?.median && rental?.median
      ? round1(((Number(propertyTypeBucket.median) - Number(rental.median)) / Math.max(Number(rental.median), 1)) * 100)
      : null;

    if (grossYieldPct != null) {
      marketFactors.push({
        name: 'Gross Yield Signal',
        impact: grossYieldPct >= 8 ? 84 : grossYieldPct >= 6 ? 68 : grossYieldPct >= 4.5 ? 52 : 38,
        description: `RentCast gross yield is ${grossYieldPct}% — stronger yields usually support investor demand and renter resilience.`,
        source: 'RentCast',
        rawValue: `${grossYieldPct}%`,
        trend: 'flat'
      });
    }
    if (priceToRentRatio != null) {
      marketFactors.push({
        name: 'Price-to-Rent Balance',
        impact: priceToRentRatio <= 18 ? 82 : priceToRentRatio <= 24 ? 66 : priceToRentRatio <= 30 ? 52 : 38,
        description: `Price-to-rent sits at ${priceToRentRatio} — higher ratios usually cap how aggressively investors can underwrite rent growth.`,
        source: 'RentCast',
        rawValue: String(priceToRentRatio),
        trend: 'flat'
      });
    }
    if (listingChurnRate != null) {
      marketFactors.push({
        name: 'Inventory Flow',
        impact: listingChurnRate >= 35 ? 78 : listingChurnRate >= 20 ? 64 : listingChurnRate >= 10 ? 52 : 40,
        description: `New listings are running at ${listingChurnRate}% of active inventory — faster flow supports tighter leasing conditions.`,
        source: 'RentCast',
        rawValue: `${listingChurnRate}%`,
        trend: listingChurnRate >= 20 ? 'down' : 'up'
      });
    }
    if (monthsOfSupply != null) {
      marketFactors.push({
        name: 'Rental Months of Supply',
        impact: monthsOfSupply <= 1.5 ? 85 : monthsOfSupply <= 3 ? 68 : monthsOfSupply <= 5 ? 52 : 34,
        description: `Local rental inventory implies roughly ${monthsOfSupply} months of supply — low supply supports pricing power, high supply raises vacancy risk.`,
        source: 'RentCast',
        rawValue: `${monthsOfSupply}`,
        trend: monthsOfSupply <= 3 ? 'down' : 'up'
      });
    }
    if (compStaleShare > 0) {
      marketFactors.push({
        name: 'Listing Staleness',
        impact: compStaleShare <= 10 ? 82 : compStaleShare <= 20 ? 67 : compStaleShare <= 35 ? 48 : 30,
        description: `${compStaleShare}% of matched listings are 45+ days old — stale inventory usually means vacancy starts to climb well before top-of-range asking rents.`,
        source: 'RentCast listings',
        rawValue: `${compStaleShare}%`,
        trend: compStaleShare <= 20 ? 'down' : 'up'
      });
    }
    if (propertyTypePremiumPct != null) {
      marketFactors.push({
        name: 'Property Type Premium',
        impact: propertyTypePremiumPct >= 10 ? 76 : propertyTypePremiumPct >= 3 ? 64 : propertyTypePremiumPct >= -5 ? 54 : 40,
        description: `${propertyType || 'Subject type'} rents ${propertyTypePremiumPct >= 0 ? 'about' : 'roughly'} ${Math.abs(propertyTypePremiumPct)}% ${propertyTypePremiumPct >= 0 ? 'above' : 'below'} the overall ZIP median.`,
        source: 'RentCast',
        rawValue: `${propertyTypePremiumPct}%`,
        trend: propertyTypePremiumPct >= 0 ? 'up' : 'down'
      });
    }
    if (saleVsRentDomSpread != null) {
      marketFactors.push({
        name: 'Sale vs Rental Velocity',
        impact: saleVsRentDomSpread >= 20 ? 76 : saleVsRentDomSpread >= 5 ? 64 : saleVsRentDomSpread >= -10 ? 53 : 42,
        description: `Rental listings clear ${saleVsRentDomSpread >= 0 ? 'faster' : 'slower'} than sales by ${Math.abs(saleVsRentDomSpread)} days.`,
        source: 'RentCast',
        rawValue: `${saleVsRentDomSpread}`,
        trend: saleVsRentDomSpread >= 0 ? 'down' : 'up'
      });
    }

    // ── Local vacancy baseline ──────────────────────────────────────────
    // Anchor vacancy to observed macro/market vacancy. DOM adjusts the baseline
    // modestly as a marketing-friction signal; it is never converted directly
    // into physical vacancy.
    const compMedianDom = compDaysOnMarketSeries.length >= 5
      ? compDaysOnMarketSeries.sort((a, b) => a - b)[Math.floor(compDaysOnMarketSeries.length / 2)]
      : null;
    const subjectListingDaysOnMarket = Number.isFinite(Number(reportedSubjectDaysOnMarket))
      ? Number(reportedSubjectDaysOnMarket)
      : Number(listingCompPackage?.subjectListing?.daysOnMarket);
    const subjectStaleThresholdDays = Math.max(
      45,
      compMedianDom != null ? Math.round(compMedianDom * 1.5) : 45,
    );
    const subjectListingIsStale = Number.isFinite(subjectListingDaysOnMarket)
      && subjectListingDaysOnMarket >= subjectStaleThresholdDays;
    const subjectMarketingPressure = subjectListingIsStale
      ? round1(clamp((subjectListingDaysOnMarket - subjectStaleThresholdDays) / 8 + 2, 2, 8))
      : 0;
    const marketLeaseUpDays = round1(clamp(
      compMedianDom ?? averageDaysOnMarket ?? 30,
      10,
      60,
    ));
    const subjectDomEvidenceWeight = subjectListingIsStale
      ? round1(clamp(
        0.25 + (subjectListingDaysOnMarket - subjectStaleThresholdDays) / 180,
        0.25,
        0.45,
      ))
      : 0;
    const localVacancyBaseline = round1(clamp(
      baseVacancyRate
        + (compMedianDom != null ? (compMedianDom <= 14 ? -0.6 : compMedianDom <= 28 ? -0.2 : compMedianDom >= 75 ? 1.2 : compMedianDom >= 45 ? 0.6 : 0) : 0)
        + (averageDaysOnMarket != null ? (averageDaysOnMarket <= 25 ? -0.2 : averageDaysOnMarket >= 60 ? 0.4 : 0) : 0)
        + (monthsOfSupply != null ? (monthsOfSupply <= 1.5 ? -0.7 : monthsOfSupply <= 3 ? -0.2 : monthsOfSupply >= 5 ? 1.2 : monthsOfSupply >= 3.5 ? 0.5 : 0) : 0)
        + (compStaleShare >= 35 ? 0.8 : compStaleShare >= 20 ? 0.35 : 0)
        - Math.min(compFreshShare / 70, 0.5)
        + (saleVsRentDomSpread != null ? (saleVsRentDomSpread >= 20 ? -0.25 : saleVsRentDomSpread <= -10 ? 0.25 : 0) : 0)
        + (propertyTypePremiumPct != null ? (propertyTypePremiumPct >= 10 ? -0.2 : propertyTypePremiumPct <= -8 ? 0.2 : 0) : 0),
      2,
      12
    ));
    // ──────────────────────────────────────────────────────────────────
    baseVacancyRate = localVacancyBaseline;

    const demandScore = clamp(
      averageFactorImpact
        + (medianDaysOnMarket ? (medianDaysOnMarket <= 21 ? 7 : medianDaysOnMarket >= 60 ? -7 : 0) : 0)
        + (rentPerSqFt ? (rentPerSqFt >= 2.2 ? 4 : rentPerSqFt <= 1.2 ? -4 : 0) : 0)
        + (monthsOfSupply != null ? (monthsOfSupply <= 1.5 ? 5 : monthsOfSupply >= 5 ? -6 : 0) : 0)
        + (compFreshShare >= 35 ? 3 : 0)
        - (compStaleShare >= 30 ? 5 : 0),
      25,
      95
    );

    const marketTightness = demandScore >= 72 ? 'tight' : demandScore <= 45 ? 'soft' : 'balanced';
    const vacancyFloor = round1(clamp(baseVacancyRate - (marketTightness === 'tight' ? 1.1 : marketTightness === 'balanced' ? 0.4 : -0.1), 1.5, 6));

    if (domBinData?.bins?.length >= 2 && compMedianDom != null) {
      let priorVacancy = vacancyFloor;
      const calibratedBins = domBinData.bins.map((bin) => {
        const relativeDomRisk = clamp((bin.avgDom - compMedianDom) / 30 * 2.5, -1.5, 8);
        const calibratedVacancy = Math.max(
          priorVacancy,
          round1(clamp(baseVacancyRate + relativeDomRisk, vacancyFloor, Math.min(vacancyFloor + 12, 24)))
        );
        priorVacancy = calibratedVacancy;
        return { ...bin, avgVacancy: calibratedVacancy };
      });
      domBins = {
        ...domBinData,
        bins: calibratedBins,
        vacancySpread: round1(
          calibratedBins[calibratedBins.length - 1].avgVacancy - calibratedBins[0].avgVacancy
        ),
        overallMedianDom: round1(compMedianDom),
        overallMedianVacancy: round1(baseVacancyRate),
        interpretation: 'DOM-calibrated marketing friction around independent vacancy baseline',
      };
    }

    const demandAdjustment = demandScore >= 85 ? -1.6 : demandScore >= 72 ? -1.0 : demandScore >= 60 ? -0.3 : demandScore <= 35 ? 1.8 : demandScore <= 45 ? 1.0 : 0.4;
    const domAdjustment = medianDaysOnMarket == null
      ? 0
      : medianDaysOnMarket <= 14
        ? -1.0
        : medianDaysOnMarket <= 28
          ? -0.4
          : medianDaysOnMarket >= 90
            ? 2.0
            : medianDaysOnMarket >= 60
              ? 1.1
              : 0;
    const listingsAdjustment = monthsOfSupply == null
      ? (totalListings == null ? 0 : totalListings >= 120 ? 0.5 : totalListings <= 25 ? -0.3 : 0)
      : monthsOfSupply >= 5
        ? 1.4
        : monthsOfSupply >= 3.5
          ? 0.7
          : monthsOfSupply <= 1.5
            ? -0.8
            : monthsOfSupply <= 2.25
              ? -0.3
              : 0;
    const mortgageAdjustment = mortgageRate == null
      ? 0
      : mortgageRate >= 7
        ? -0.6
        : mortgageRate >= 6
          ? -0.3
          : mortgageRate <= 5.25
            ? 0.4
            : 0;
    const sentimentAdjustment = consumerSentiment == null
      ? 0
      : consumerSentiment >= 80
        ? -0.2
        : consumerSentiment <= 60
          ? 0.5
          : 0;
    const employmentAdjustment = employmentClaims == null
      ? 0
      : employmentClaims >= 300000
        ? 0.7
        : employmentClaims <= 220000
          ? -0.2
          : 0;

    let projectedRentGrowth = 2.7 + (demandScore - 50) / 18;
    if (baseVacancyRate <= 4.5) projectedRentGrowth += 0.5;
    if (baseVacancyRate >= 7) projectedRentGrowth -= 0.6;
    if (medianDaysOnMarket != null) {
      if (medianDaysOnMarket <= 21) projectedRentGrowth += 0.4;
      if (medianDaysOnMarket >= 60) projectedRentGrowth -= 0.5;
    }
    if (monthsOfSupply != null) {
      if (monthsOfSupply <= 2) projectedRentGrowth += 0.3;
      if (monthsOfSupply >= 5) projectedRentGrowth -= 0.6;
    }
    if (grossYieldPct != null && grossYieldPct >= 7) projectedRentGrowth += 0.2;
    projectedRentGrowth = round1(clamp(projectedRentGrowth, 0.8, 6.5));

    // Keep the supported ceiling close to the cleaned P90 ask. Prior logic could
    // compound P98 outliers with a 12–42% premium and create implausible ceilings.
    const supportedFlexPremium = clamp(
      (marketTightness === 'tight' ? 0.07 : marketTightness === 'balanced' ? 0.045 : 0.025)
        + Math.min(Math.max(rentSpreadRatio - 20, 0) / 100 * 0.08, 0.025)
        + (compFreshShare >= 40 ? 0.01 : 0)
        - (compStaleShare >= 25 ? 0.015 : 0)
        - (monthsOfSupply != null && monthsOfSupply >= 5 ? 0.015 : 0),
      0.02,
      0.09
    );
    const supportedCeilingRent = Math.round(
      Math.max(compP90Rent, marketPotentialRent) * (1 + supportedFlexPremium)
    );
    const rejectionSpread = Math.max(compP90Rent - compP75Rent, Math.round(compMedianRent * 0.1), 175);
    const rejectionMultiplier = marketTightness === 'tight' ? 2.0 : marketTightness === 'balanced' ? 1.65 : 1.35;
    const rentAtFullVacancy = Math.round(Math.max(
      supportedCeilingRent * 1.12,
      compP90Rent + rejectionSpread * rejectionMultiplier,
      compMedianRent * (1 + supportedFlexPremium + 0.16)
    ));
    const pricingPowerCapRatio = clamp(
      (marketTightness === 'tight' ? 0.10 : marketTightness === 'balanced' ? 0.065 : 0.035)
        + (monthsOfSupply != null ? (monthsOfSupply <= 1.5 ? 0.02 : monthsOfSupply >= 5 ? -0.025 : monthsOfSupply >= 3.5 ? -0.012 : 0) : 0)
        + (compFreshShare >= 35 ? 0.01 : 0)
        - (compStaleShare >= 25 ? 0.018 : 0)
        - (employmentClaims != null && employmentClaims >= 300000 ? 0.015 : 0),
      0.03,
      0.12
    );
    const empiricalPricingHeadroom = Math.max(0, Math.min(compP90Rent, supportedCeilingRent) - marketPotentialRent);
    const pricingPowerSoftCapDollar = empiricalPricingHeadroom > 0
      ? Math.max(75, Math.min(empiricalPricingHeadroom, Math.round(marketPotentialRent * pricingPowerCapRatio)))
      : 75;
    const baseRecommendationSoftCap = Math.round(Math.min(
      supportedCeilingRent,
      marketPotentialRent + pricingPowerSoftCapDollar
    ));
    // A stale active subject is direct evidence that its current campaign is not
    // clearing. Do not recommend a rent increase until that signal resets.
    const recommendationSoftCap = subjectListingIsStale
      ? Math.round(Math.min(baseRecommendationSoftCap, currentRent, marketPotentialRent))
      : baseRecommendationSoftCap;
    const weakEconomicTrendScore =
      (monthsOfSupply != null ? (monthsOfSupply >= 5 ? 2 : monthsOfSupply >= 3.5 ? 1 : 0) : 0)
      + (compStaleShare >= 35 ? 2 : compStaleShare >= 20 ? 1 : 0)
      + (listingChurnRate != null ? (listingChurnRate < 10 ? 1 : 0) : 0)
      + (employmentClaims != null ? (employmentClaims >= 300000 ? 1 : employmentClaims >= 260000 ? 0.5 : 0) : 0);

    const vacancyModelDefinition = {
      anchorRent: marketPotentialRent,
      baseVacancyRate,
      compP25Rent,
      compMedianRent,
      compP75Rent,
      compP90Rent,
      compHighRent,
      supportedCeilingRent,
      rentAtFullVacancy,
      // Market/DOM/macro context is already incorporated into baseVacancyRate.
      // Keep curve adjustments at zero to avoid counting the same signals twice.
      demandAdjustment: 0,
      domAdjustment: 0,
      listingsAdjustment: 0,
      mortgageAdjustment: 0,
      sentimentAdjustment: 0,
      employmentAdjustment: 0,
      minVacancyRate: vacancyFloor,
      maxVacancyRate: 100,
      domBins,
      subjectCurrentRent: Number(currentRent),
      subjectDaysOnMarket: Number.isFinite(subjectListingDaysOnMarket) ? subjectListingDaysOnMarket : null,
      subjectStaleThresholdDays,
      subjectMarketingPressure,
      subjectListingIsStale,
      marketLeaseUpDays,
      leaseUpPriceElasticity: 8,
      subjectDomEvidenceWeight,
    };
    const estimateVacancyRate = (candidateRent) => estimateVacancyForRentModel(
      candidateRent,
      vacancyModelDefinition,
      { baseVacancyRate },
    );

    const estimateRentGrowthRate = (candidateRent, candidateVacancyRate) => {
      let candidateGrowth = projectedRentGrowth;
      const premiumRatio = compMedianRent > 0 ? (candidateRent - compMedianRent) / compMedianRent : 0;
      if (premiumRatio > 0) {
        candidateGrowth -= Math.min(1.8, premiumRatio * 4.8);
      } else {
        candidateGrowth += Math.min(0.45, Math.abs(premiumRatio) * 1.2);
      }
      if (candidateRent >= compP90Rent) candidateGrowth -= 0.4;
      if (candidateVacancyRate >= 20) candidateGrowth -= 0.6;
      if (candidateVacancyRate >= 40) candidateGrowth -= 1.2;
      if (monthsOfSupply != null && monthsOfSupply <= 2 && candidateRent <= compP75Rent) candidateGrowth += 0.2;
      return round1(clamp(candidateGrowth, 0.5, 6.5));
    };

    const discountRate = clamp((mortgageRate != null ? mortgageRate / 100 + 0.015 : 0.08), 0.06, 0.11);
    // Vacancy recovery prioritizes the next lease-up year; occupied/non-stale
    // properties retain a three-year decision horizon.
    const objectiveHorizonYears = subjectListingIsStale ? 1 : 3;
    const evaluateScenario = (candidateRent) => {
      const leaseUpRecovery = estimateLeaseUpRecoveryForRent(
        candidateRent,
        vacancyModelDefinition,
        { baseVacancyRate },
      );
      const stabilizedVacancyRate = leaseUpRecovery?.stabilizedVacancyRate
        ?? estimateVacancyRate(candidateRent);
      const candidateVacancyRate = subjectListingIsStale
        ? (leaseUpRecovery?.projectedCampaignVacancyPct ?? stabilizedVacancyRate)
        : stabilizedVacancyRate;
      const expectedAdditionalLeaseUpDays = subjectListingIsStale
        ? (leaseUpRecovery?.expectedAdditionalLeaseUpDays ?? marketLeaseUpDays)
        : 0;
      const candidateGrowth = estimateRentGrowthRate(candidateRent, stabilizedVacancyRate);
      // For an actively vacant home, optimize the next 365 days from today
      // using expected remaining lease-up time. Elapsed DOM is reported as
      // realized campaign vacancy but is sunk cost and is not charged again.
      const effectiveAnnualRevenue = subjectListingIsStale
        ? candidateRent * 12 * (1 - expectedAdditionalLeaseUpDays / 365)
        : candidateRent * 12 * (1 - stabilizedVacancyRate / 100);

      let discountedCollectedRevenue = 0;
      let turnoverPenalty = 0;
      for (let year = 1; year <= objectiveHorizonYears; year += 1) {
        const grownRent = candidateRent * Math.pow(1 + candidateGrowth / 100, year - 1);
        const grownVacancyRate = estimateVacancyRate(grownRent);
        const annualCollectedRevenue = subjectListingIsStale && year === 1
          ? candidateRent * 12 * (1 - expectedAdditionalLeaseUpDays / 365)
          : grownRent * 12 * (1 - grownVacancyRate / 100);
        discountedCollectedRevenue += annualCollectedRevenue / Math.pow(1 + discountRate, year);
        // One-month turnover-cost proxy scaled only by vacancy above the local floor.
        if (!subjectListingIsStale) {
          turnoverPenalty += grownRent
            * Math.max(0, grownVacancyRate - vacancyFloor)
            / 100
            / Math.pow(1 + discountRate, year);
        }
      }

      const pricingPowerPenalty = 0;
      const tenantQualityPenalty = 0;
      const retentionPenalty = 0;
      const economicTrendPenalty = 0;
      const marketRejectionPenalty = 0;
      const investorObjectiveScore = discountedCollectedRevenue - turnoverPenalty;

      return {
        rent: Math.round(candidateRent),
        vacancyRate: candidateVacancyRate,
        stabilizedVacancyRate,
        realizedVacancyPct: leaseUpRecovery?.realizedVacancyPct ?? 0,
        expectedAdditionalLeaseUpDays,
        projectedCampaignVacancyPct: leaseUpRecovery?.projectedCampaignVacancyPct
          ?? candidateVacancyRate,
        projectedRentGrowth: candidateGrowth,
        effectiveAnnualRevenue,
        discountedCollectedRevenue,
        pricingPowerPenalty,
        tenantQualityPenalty,
        retentionPenalty,
        economicTrendPenalty,
        turnoverPenalty,
        investorObjectiveScore,
        objectiveHorizonYears,
      };
    };

    const currentScenario = evaluateScenario(currentRent);
    const benchmarkScenario = evaluateScenario(marketPotentialRent);
    const lowerBoundRent = Math.round(Math.max(500, Math.min(currentRent, marketPotentialRent, compP25Rent) * 0.65) / 25) * 25;
    const upperBoundRent = Math.round(Math.max(currentRent, rentAtFullVacancy) / 25) * 25;
    const candidateStep = 25;

    let bestScenario = currentScenario;
    // Cap how far above market the optimizer can recommend, but always
    // include the current rent so the search can evaluate alternatives
    // both above and below it. Without this, when current rent exceeds
    // the cap the optimizer can't find anything better and just echoes
    // back the current rent as "recommended."
    const maxRecommendedRent = Math.min(
      Math.max(recommendationSoftCap, currentRent > marketPotentialRent ? currentRent : marketPotentialRent),
      supportedCeilingRent
    );
    const effectiveUpperBound = Math.min(upperBoundRent, maxRecommendedRent);
    const nearTieObjectiveTolerance = Math.max(currentScenario.effectiveAnnualRevenue * 0.012, 900);
    const nearTieRevenueTolerance = 450;
    const evaluatedScenarios = [currentScenario];
    for (let candidateRent = lowerBoundRent; candidateRent <= effectiveUpperBound; candidateRent += candidateStep) {
      const scenario = evaluateScenario(candidateRent);
      evaluatedScenarios.push(scenario);
      const objectiveDelta = scenario.investorObjectiveScore - bestScenario.investorObjectiveScore;
      const revenueDelta = scenario.effectiveAnnualRevenue - bestScenario.effectiveAnnualRevenue;
      const isMateriallyBetter = objectiveDelta > nearTieObjectiveTolerance;
      const isNearTieButSafer = Math.abs(objectiveDelta) <= nearTieObjectiveTolerance
        && revenueDelta >= -nearTieRevenueTolerance
        && (
          scenario.vacancyRate < bestScenario.vacancyRate - 0.6
          || (
            Math.abs(scenario.vacancyRate - bestScenario.vacancyRate) <= 0.6
            && scenario.rent < bestScenario.rent
          )
        );

      if (
        isMateriallyBetter
        || isNearTieButSafer
        || (
          Math.abs(objectiveDelta) < 1
          && scenario.effectiveAnnualRevenue > bestScenario.effectiveAnnualRevenue
        )
      ) {
        bestScenario = scenario;
      }
    }

    const maxReturnScenario = evaluatedScenarios.reduce((best, scenario) => (
      scenario.effectiveAnnualRevenue > best.effectiveAnnualRevenue
        || (
          Math.abs(scenario.effectiveAnnualRevenue - best.effectiveAnnualRevenue) < 1
          && scenario.vacancyRate < best.vacancyRate
        )
        ? scenario
        : best
    ), currentScenario);
    const vacancyRecoveryRevenueFloor = maxReturnScenario.effectiveAnnualRevenue * 0.985;
    const vacancyRecoveryScenario = evaluatedScenarios
      .filter((scenario) => scenario.effectiveAnnualRevenue >= vacancyRecoveryRevenueFloor)
      .reduce((best, scenario) => (
        scenario.vacancyRate < best.vacancyRate
          || (
            Math.abs(scenario.vacancyRate - best.vacancyRate) < 0.1
            && scenario.effectiveAnnualRevenue > best.effectiveAnnualRevenue
          )
          ? scenario
          : best
      ), maxReturnScenario);

    const recommendedRent = Math.round(bestScenario.rent);
    const recommendedVacancyRate = bestScenario.vacancyRate;
    const currentVacancyRateEstimate = currentScenario.vacancyRate;
    const benchmarkVacancyRate = benchmarkScenario.vacancyRate;
    const currentEffectiveAnnualRevenue = currentScenario.effectiveAnnualRevenue;
    const benchmarkEffectiveAnnualRevenue = benchmarkScenario.effectiveAnnualRevenue;
    const annualRevenueUpside = Math.round(bestScenario.effectiveAnnualRevenue - currentEffectiveAnnualRevenue);
    const objectiveNpvUpside = Math.round(bestScenario.investorObjectiveScore - currentScenario.investorObjectiveScore);
    const pricingPowerDollar = recommendedRent - currentRent;
    const pricingPowerPercent = currentRent > 0 ? (pricingPowerDollar / currentRent) * 100 : 0;
    const pricingPowerLeftDollar = Math.max(0, recommendationSoftCap - currentRent);
    const recommendationPremiumToBenchmark = Math.max(0, recommendedRent - marketPotentialRent);
    const pricingPowerScore = clamp(
      48
        + Math.min(pricingPowerLeftDollar / Math.max(currentRent, 1) * 100, 10) * 2.2
        + (demandScore - 50) * 0.42
        - Math.max(0, recommendedVacancyRate - currentVacancyRateEstimate) * 0.85
        - Math.min(recommendationPremiumToBenchmark / Math.max(pricingPowerSoftCapDollar, 1) * 14, 20)
        - (annualRevenueUpside < 1500 ? 12 : annualRevenueUpside < 3500 ? 6 : 0),
      0,
      100
    );
    const marketPosition = pricingPowerDollar >= 125
      ? 'material pricing power remains'
      : pricingPowerDollar >= 25
        ? 'some pricing power remains'
        : pricingPowerDollar > -50
          ? 'roughly aligned with market'
          : currentRent >= rentAtFullVacancy
            ? 'rent appears to be in the market rejection zone'
            : 'rent is likely ahead of market support';

    const vacancyMethodBasis = domBins
      ? `DOM-calibrated marketing friction across ${domBins.n} comparable listings (${domBins.bins.length} price bins), anchored to independent market vacancy`
      : 'modeled absorption-risk curve based on rent positioning within the comparable band';
    const benchmarkBasis = listingSummary?.weightedMedianRent && listingCompSampleAdequate
      ? 'size-adjusted RentCast listing-level comps'
      : 'RentCast ZIP-level benchmarks';
    const pricingPowerExplanation = subjectListingIsStale
      ? `The subject has been actively marketed for ${subjectListingDaysOnMarket} days, creating ${currentScenario.realizedVacancyPct}% realized annual vacancy to date. The model uses comparable DOM and price position to estimate remaining lease-up time; subject DOM receives only a bounded ${Math.round(subjectDomEvidenceWeight * 100)}% evidence weight.`
      : pricingPowerDollar >= 0
        ? `Based on ${benchmarkBasis} plus ${vacancyMethodBasis}, the recommended rent is $${pricingPowerDollar.toLocaleString()}/mo above current rent and remains inside the market-supported band.`
        : `Based on ${benchmarkBasis} plus ${vacancyMethodBasis}, current rent is $${Math.abs(pricingPowerDollar).toLocaleString()}/mo above the ${objectiveHorizonYears}-year collected-revenue optimum.`;
    const scenarioSummary = subjectListingIsStale
      ? `Vacancy-recovery mode recommends $${recommendedRent.toLocaleString()}/mo and models ${bestScenario.expectedAdditionalLeaseUpDays} more vacant days versus ${currentScenario.expectedAdditionalLeaseUpDays} at the current ask. Including the ${subjectListingDaysOnMarket} days already elapsed, projected campaign vacancy falls from ${currentVacancyRateEstimate}% to ${recommendedVacancyRate}%; the next-365-day collected-rent change is ${annualRevenueUpside >= 0 ? '+' : '-'}$${Math.abs(annualRevenueUpside).toLocaleString()}.`
      : `Modeled ${objectiveHorizonYears}-year collected-rent NPV peaks near $${recommendedRent.toLocaleString()}/mo. Year-one modeled vacancy risk is ${recommendedVacancyRate}% at the recommendation versus ${currentVacancyRateEstimate}% at current rent. DOM is used only as relative marketing friction, not as observed physical vacancy. The curve approaches full market rejection continuously near $${rentAtFullVacancy.toLocaleString()}/mo.`;
    const pricingConfidence = listingCompSampleAdequate && macroData
      ? 'high'
      : listingCompSampleAdequate || rental || macroData
        ? 'medium'
        : 'low';
    const fullVacancyReason = compStaleShare >= 25 || (monthsOfSupply != null && monthsOfSupply >= 4)
      ? 'Current market depth and stale inventory suggest leasing demand stays weak but nonzero above the support band, then drops to effectively zero once pricing crosses the market rejection point.'
      : 'Above the supported ceiling the model increases lease-up risk continuously until pricing reaches the modeled market rejection point.';

    const response = {
      currentRent,
      marketPotentialRent,
      comparableRents,
      marketAverage,
      percentileRank,
      comparableListings: listingComparables,
      comparablesMethod,
      marketFactors,
      pricingPower: {
        score: Math.round(pricingPowerScore),
        pricingPowerPercent: round1(pricingPowerPercent),
        pricingPowerDollar,
        marketPosition,
        explanation: pricingPowerExplanation,
        confidence: pricingConfidence
      },
      scenario: {
        recommendedRent,
        currentVacancyRate: currentVacancyRateEstimate,
        benchmarkVacancyRate,
        recommendedVacancyRate,
        projectedRentGrowth: bestScenario.projectedRentGrowth,
        currentProjectedRentGrowth: currentScenario.projectedRentGrowth,
        benchmarkProjectedRentGrowth: benchmarkScenario.projectedRentGrowth,
        recommendedProjectedRentGrowth: bestScenario.projectedRentGrowth,
        monthlyRevenueUpside: Math.round(annualRevenueUpside / 12),
        annualRevenueUpside,
        objectiveHorizonYears,
        objectiveNpvUpside,
        objectiveLabel: subjectListingIsStale
          ? 'Next-365-day collected rent after expected remaining lease-up time'
          : `${objectiveHorizonYears}-year discounted collected-rent NPV`,
        recommendationMode: subjectListingIsStale ? 'vacancy_recovery' : 'npv_optimization',
        vacancyRecovery: subjectListingIsStale ? {
          elapsedVacantDays: subjectListingDaysOnMarket,
          realizedVacancyPct: currentScenario.realizedVacancyPct,
          marketLeaseUpDays,
          subjectDomEvidenceWeight,
          currentExpectedAdditionalDays: currentScenario.expectedAdditionalLeaseUpDays,
          benchmarkExpectedAdditionalDays: benchmarkScenario.expectedAdditionalLeaseUpDays,
          recommendedExpectedAdditionalDays: bestScenario.expectedAdditionalLeaseUpDays,
          currentProjectedCampaignVacancyPct: currentScenario.projectedCampaignVacancyPct,
          recommendedProjectedCampaignVacancyPct: bestScenario.projectedCampaignVacancyPct,
          currentStabilizedVacancyRate: currentScenario.stabilizedVacancyRate,
          recommendedStabilizedVacancyRate: bestScenario.stabilizedVacancyRate,
          method: 'Comparable lease-up time adjusted by price position; subject DOM is bounded evidence. Elapsed vacancy is disclosed but treated as sunk cost in optimization.',
        } : null,
        strategyOptions: {
          maxReturn: {
            rent: Math.round(maxReturnScenario.rent),
            vacancyRate: maxReturnScenario.vacancyRate,
            effectiveAnnualRevenue: Math.round(maxReturnScenario.effectiveAnnualRevenue),
            deltaVsCurrent: Math.round(maxReturnScenario.effectiveAnnualRevenue - currentScenario.effectiveAnnualRevenue),
            description: 'Highest modeled year-one collected rent in the permitted search range.',
          },
          balanced: {
            rent: Math.round(bestScenario.rent),
            vacancyRate: bestScenario.vacancyRate,
            effectiveAnnualRevenue: Math.round(bestScenario.effectiveAnnualRevenue),
            deltaVsCurrent: Math.round(bestScenario.effectiveAnnualRevenue - currentScenario.effectiveAnnualRevenue),
            description: 'Risk-adjusted recommendation using NPV/turnover objective and safer near-tie preference.',
          },
          vacancyRecovery: {
            rent: Math.round(vacancyRecoveryScenario.rent),
            vacancyRate: vacancyRecoveryScenario.vacancyRate,
            effectiveAnnualRevenue: Math.round(vacancyRecoveryScenario.effectiveAnnualRevenue),
            deltaVsCurrent: Math.round(vacancyRecoveryScenario.effectiveAnnualRevenue - currentScenario.effectiveAnnualRevenue),
            description: 'Lowest modeled vacancy while retaining at least 98.5% of maximum collected rent.',
          },
        },
        currentEffectiveAnnualRevenue: Math.round(currentEffectiveAnnualRevenue),
        benchmarkEffectiveAnnualRevenue: Math.round(benchmarkEffectiveAnnualRevenue),
        recommendedEffectiveAnnualRevenue: Math.round(bestScenario.effectiveAnnualRevenue),
        currentInvestorObjectiveScore: Math.round(currentScenario.investorObjectiveScore),
        benchmarkInvestorObjectiveScore: Math.round(benchmarkScenario.investorObjectiveScore),
        recommendedInvestorObjectiveScore: Math.round(bestScenario.investorObjectiveScore),
        demandScore: Math.round(demandScore),
        marketTightness,
        sliderMinRent: lowerBoundRent,
        sliderMaxRent: upperBoundRent,
        recommendationSoftCap,
        pricingPowerSoftCapDollar,
        supportedCeilingRent,
        rentAtFullVacancy,
        fullVacancyReason,
        riskAdjustments: {
          turnoverPenalty: Math.round(bestScenario.turnoverPenalty),
          pricingPowerPenalty: Math.round(bestScenario.pricingPowerPenalty),
          tenantQualityPenalty: Math.round(bestScenario.tenantQualityPenalty),
          retentionPenalty: Math.round(bestScenario.retentionPenalty),
          economicTrendPenalty: Math.round(bestScenario.economicTrendPenalty),
          weakEconomicTrendScore: round1(weakEconomicTrendScore),
        },
        vacancyModel: {
          ...vacancyModelDefinition,
          domBins: domBins ? {
            bins: domBins.bins.map(b => ({ avgRent: round1(b.avgRent), avgVacancy: round1(b.avgVacancy), avgDom: round1(b.avgDom), count: b.count })),
            n: domBins.n,
            overallMedianVacancy: round1(domBins.overallMedianVacancy),
            interpretation: domBins.interpretation,
          } : null,
        },
        growthModel: {
          baseGrowthRate: projectedRentGrowth,
          recommendedGrowthRate: bestScenario.projectedRentGrowth,
          compMedianRent,
          compP75Rent,
          compP90Rent,
          supportedCeilingRent,
          rentAtFullVacancy,
          minGrowthRate: 0.5,
          maxGrowthRate: 6.5,
        },
        summary: scenarioSummary
      },
      marketIntelligence: {
        averageDaysOnMarket,
        compAverageDaysOnMarket: compDaysOnMarketSeries.length ? round1(average(compDaysOnMarketSeries) || 0) : null,
        compFreshShare,
        compStaleShare,
        activeStatusShare,
        listingChurnRate,
        monthsOfSupply,
        grossYieldPct,
        priceToRentRatio,
        saleVsRentDomSpread,
        propertyTypePremiumPct,
        rentSpreadRatio,
        subjectListingDaysOnMarket: Number.isFinite(subjectListingDaysOnMarket) ? subjectListingDaysOnMarket : null,
        subjectStaleThresholdDays,
        subjectListingIsStale,
        subjectMarketingPressure,
      },
      vacancyEvidence: {
        observedLocal: localVacancyData ? {
          source: 'U.S. Census ACS',
          geography: localVacancyData.geographyName,
          survey: localVacancyData.survey,
          vacancyRate: localVacancyData.vacancyRate,
          vacancyRateMoe: localVacancyData.vacancyRateMoe,
          modelReliability: localVacancyData.modelReliability,
          blendedBaselineRate: localVacancyData.blendedBaselineRate,
          rentalInventory: localVacancyData.rentalInventory,
          renterOccupied: localVacancyData.renterOccupied,
          vacantForRent: localVacancyData.vacantForRent,
          rentedNotOccupied: localVacancyData.rentedNotOccupied,
          definition: localVacancyData.definition,
          limitation: localVacancyData.limitation,
          sourceUrl: localVacancyData.sourceUrl,
        } : null,
        liveMarket: {
          source: 'RentCast active listings',
          cleanCompCount: listingCompPackage?.matchedCount || 0,
          medianDaysOnMarket,
          averageDaysOnMarket,
          staleShare: compStaleShare,
          freshShare: compFreshShare,
          monthsOfSupply,
          interpretation: 'Current listing velocity and inventory adjust the observed structural vacancy baseline; they are not themselves physical vacancy.',
        },
        subject: {
          daysOnMarket: Number.isFinite(subjectListingDaysOnMarket) ? subjectListingDaysOnMarket : null,
          staleThresholdDays: subjectStaleThresholdDays,
          isStale: subjectListingIsStale,
          marketingPressure: subjectMarketingPressure,
        },
        finalBaselineRate: baseVacancyRate,
      },
      conditionEvidence: Number.isFinite(conditionScore) ? {
        ...conditionAnalysis,
        conditionScore: Math.round(conditionScore),
        rentAdjustmentPct: conditionAdjustmentPct,
        rentAdjustmentDollar: conditionAdjustmentDollar,
        benchmarkBeforeAdjustment: marketBenchmarkBeforeCondition,
        benchmarkAfterAdjustment: marketPotentialRent,
      } : null,
      pricingAudit: {
        version: 'rental-pricing-v10',
        inputs: {
          currentAskingRent: Number(currentRent),
          subjectDaysOnMarket: Number.isFinite(subjectListingDaysOnMarket) ? subjectListingDaysOnMarket : null,
          bedrooms: normalizedBedrooms,
          bathrooms: normalizedBathrooms,
          squareFeet: normalizedSquareFeet,
          propertyType: propertyType || null,
          yearBuilt: Number.isFinite(Number(yearBuilt)) ? Number(yearBuilt) : null,
        },
        comparableBenchmark: {
          source: comparablesMethod.source,
          cleanCompCount: listingCompPackage?.matchedCount || 0,
          totalFetched: listingCompPackage?.totalFetched || 0,
          outliersRemoved: listingCompPackage?.outliersRemoved || 0,
          weightedMedianRawRent: listingSummary?.weightedMedianRawRent ?? null,
          weightedMedianSizeAdjustedRent: listingSummary?.weightedMedianRent ?? null,
          weightedMedianRentPerSqFt: listingSummary?.weightedMedianRentPerSqFt ?? null,
          p25: compP25Rent,
          median: compMedianRent,
          p75: compP75Rent,
          p90: compP90Rent,
          method: 'Active asks are normalized to subject square footage, similarity weighted, deduplicated, and IQR-trimmed.',
        },
        conditionAdjustment: {
          score: Number.isFinite(conditionScore) ? Math.round(conditionScore) : null,
          confidence: conditionAnalysis?.confidence ?? null,
          coverage: conditionAnalysis?.coverageScore ?? null,
          adjustmentPct: conditionAdjustmentPct,
          adjustmentDollar: conditionAdjustmentDollar,
          benchmarkBefore: marketBenchmarkBeforeCondition,
          benchmarkAfter: marketPotentialRent,
          cap: '-5% to +4%',
        },
        vacancyModel: {
          observedStructuralBaseline: localVacancyData?.vacancyRate ?? null,
          observedMarginOfError: localVacancyData?.vacancyRateMoe ?? null,
          fallbackNationalRate: marketFactors.find(f => f.name === 'Rental Vacancy Rate')?.rawValue || null,
          liveAdjustedBaseline: baseVacancyRate,
          currentRentRisk: currentVacancyRateEstimate,
          recommendedRentRisk: recommendedVacancyRate,
          subjectMarketingPressure,
          realizedVacancyPct: currentScenario.realizedVacancyPct,
          currentExpectedAdditionalLeaseUpDays: currentScenario.expectedAdditionalLeaseUpDays,
          recommendedExpectedAdditionalLeaseUpDays: bestScenario.expectedAdditionalLeaseUpDays,
          currentStabilizedVacancyRate: currentScenario.stabilizedVacancyRate,
          recommendedStabilizedVacancyRate: bestScenario.stabilizedVacancyRate,
          method: subjectListingIsStale
            ? 'Projected campaign vacancy = elapsed DOM + price-sensitive expected remaining lease-up time. Stabilized vacancy is reported separately.'
            : 'Observed local ACS vacancy baseline plus bounded RentCast DOM and inventory adjustments.',
        },
        optimizer: {
          objective: subjectListingIsStale
            ? 'First-year vacancy recovery with collected-return near-tie guardrail'
            : `${objectiveHorizonYears}-year discounted collected-rent NPV`,
          recommendationMode: subjectListingIsStale ? 'vacancy_recovery' : 'npv_optimization',
          searchStep: candidateStep,
          searchMin: lowerBoundRent,
          searchMax: effectiveUpperBound,
          currentEffectiveAnnualRevenue: Math.round(currentEffectiveAnnualRevenue),
          recommendedEffectiveAnnualRevenue: Math.round(bestScenario.effectiveAnnualRevenue),
          annualRevenueDelta: annualRevenueUpside,
          currentObjectiveScore: Math.round(currentScenario.investorObjectiveScore),
          recommendedObjectiveScore: Math.round(bestScenario.investorObjectiveScore),
          recommendation: recommendedRent,
          strategyOptions: {
            maxReturnRent: Math.round(maxReturnScenario.rent),
            balancedRent: Math.round(bestScenario.rent),
            vacancyRecoveryRent: Math.round(vacancyRecoveryScenario.rent),
          },
          formula: subjectListingIsStale
            ? 'next-365-day collected rent = monthly rent × 12 × (1 − expected additional lease-up days ÷ 365); elapsed DOM is sunk cost'
            : 'effective annual revenue = monthly rent × 12 × (1 − stabilized vacancy risk)',
        },
      },
      dataSources: {
        listingComps: listingCompSampleAdequate,
        listingCompSampleAdequate,
        listingCompsCacheHit: listingCompCacheHit,
        rentcast: !!rentcastData,
        fred: !!macroData,
        censusAcs: !!localVacancyData,
        conditionVision: Number.isFinite(conditionScore),
        estimated: !rentcastData && !listingCompSampleAdequate,
        rentcastUpdated: rental?.lastUpdatedDate || rentcastData?.source?.fetchedAt || null,
        rentPotentialCacheHit: false,
      },
      macroContext: macroData ? {
        mortgage15Rate: marketFactors.find(f => f.name === 'Mortgage Rate Pressure')?.rawValue || null,
        rentalVacancyRate: marketFactors.find(f => f.name === 'Rental Vacancy Rate')?.rawValue || null,
        consumerSentiment: marketFactors.find(f => f.name === 'Consumer Sentiment')?.rawValue || null,
        constructionPPI: marketFactors.find(f => f.name === 'Construction Cost Trend')?.rawValue || null,
        employmentClaims: marketFactors.find(f => f.name === 'Employment Health')?.rawValue || null
      } : null
    };

    if (rentPotentialCacheKey && (response.dataSources?.rentcast || response.dataSources?.listingComps)) {
      await setCachedRentPotentialData(rentPotentialCacheKey, rentPotentialCacheSignature, response);
    }

    console.log(`[RentPotential] Market benchmark: $${marketPotentialRent}, recommended: $${recommendedRent}, softCap: $${recommendationSoftCap}, rejection: $${rentAtFullVacancy}, vacancyCurrent=${currentVacancyRateEstimate}%, vacancyRec=${recommendedVacancyRate}%, baseVacancy=${baseVacancyRate}%, domBins=${domBins ? `bins=${domBins.bins.length},n=${domBins.n},medianVac=${round1(domBins.overallMedianVacancy)}` : 'none'}, penalties=${`power=${Math.round(bestScenario.pricingPowerPenalty)},tenant=${Math.round(bestScenario.tenantQualityPenalty)},retention=${Math.round(bestScenario.retentionPenalty)},econ=${Math.round(bestScenario.economicTrendPenalty)}`}, listingComps=${listingComparables.length}, cacheHit=${listingCompCacheHit}, Rentcast=${!!rentcastData}, FRED=${!!macroData}`);
    res.json(response);

  } catch (error) {
    console.error('[RentPotential] Error:', error);
    res.status(500).json({ error: error.message || 'rent_potential_failed' });
  }
});

// GET /api/streetview/capture - Server-side proxy for Google Street View images (avoids CORS)
app.get('/api/streetview/capture', async (req, res) => {
  try {
    const { address, heading, width, height, type } = req.query;
    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }

    const mapsApiKey = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
    if (!mapsApiKey) {
      return res.status(503).json({ error: 'google_maps_not_configured' });
    }

    const encodedAddress = encodeURIComponent(address);
    const w = Number(width) || 640;
    const h = Number(height) || 480;

    let url;
    if (type === 'satellite') {
      url = `https://maps.googleapis.com/maps/api/staticmap?center=${encodedAddress}&zoom=19&size=${w}x${h}&maptype=satellite&key=${mapsApiKey}`;
    } else {
      const hdg = Number(heading) || 0;
      url = `https://maps.googleapis.com/maps/api/streetview?size=${w}x${h}&location=${encodedAddress}&heading=${hdg}&pitch=5&fov=90&key=${mapsApiKey}&source=outdoor`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: 'google_api_failed' });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const base64 = `data:${contentType};base64,${buffer.toString('base64')}`;

    res.json({ ok: true, base64, contentType });
  } catch (error) {
    console.error('[StreetView Proxy] Error:', error);
    res.status(500).json({ error: error.message || 'streetview_proxy_failed' });
  }
});

// POST /api/environmental-risk/analyze - AI-powered environmental risk mitigation analysis
// Analyzes heat map data, risk levels, and seasonal fluctuations (data-driven, no images)
app.post('/api/environmental-risk/analyze', async (req, res) => {
  try {
    const {
      address, latitude, longitude, zipCode,
      risks, propertyDetails, seasonalFluctuations
    } = req.body;

    if (!address || !risks) {
      return res.status(400).json({ error: 'address and risks are required' });
    }

    console.log(`[EnvRiskAI] Analyzing environmental risks for ${address}`);

    const systemMsg = `You are an expert in property environmental risk mitigation and resilience.
Analyze a property's environmental risk data — including heat map readings, FEMA flood zones,
AQI levels, wildfire scores, and seasonal fluctuation patterns — to create a prioritized improvement plan.
Use the seasonal data to identify when risks peak and recommend timing-sensitive mitigations.
For each recommendation, provide realistic cost estimates and expected risk reduction.
Format your response as JSON.`;

    const riskSummary = [];
    if (risks.airQuality) {
      riskSummary.push(`Air Quality — AQI: ${risks.airQuality.aqi || 'Unknown'}, Season: ${risks.airQuality.season || 'Unknown'}, Ozone Risk: ${risks.airQuality.ozoneRisk || 'Unknown'}`);
    }
    if (risks.flood) {
      riskSummary.push(`Flood — Risk Level: ${risks.flood.riskLevel || 'Unknown'}, FEMA Zone: ${risks.flood.femaZone || 'Unknown'}, Elevation: ${risks.flood.elevation || 'Unknown'}ft`);
    }
    if (risks.wildfire) {
      riskSummary.push(`Wildfire — Risk Score: ${risks.wildfire.riskScore || 'Unknown'}/10, Vegetation Dryness: ${risks.wildfire.vegetationDryness || 'Unknown'}%`);
    }

    // Build seasonal fluctuation context
    let seasonalContext = '';
    if (seasonalFluctuations && Object.keys(seasonalFluctuations).length > 0) {
      seasonalContext = '\n**Seasonal Risk Fluctuations (12-month data):**\n';
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      if (seasonalFluctuations.airQuality) {
        const s = seasonalFluctuations.airQuality;
        seasonalContext += `- Air Quality: peaks in ${s.peakMonth} (AQI ${s.peakValue}), current ${s.currentMonth} (AQI ${s.currentValue}), year avg AQI ${s.yearRoundAvg || '?'}, ${s.monthsAboveModerate ?? '?'} months above moderate\n`;
        if (s.monthlyValues?.length) seasonalContext += `  Monthly AQI: ${s.monthlyValues.map((v, i) => months[i] + ':' + Math.round(v)).join(', ')}\n`;
      }
      if (seasonalFluctuations.flood) {
        const s = seasonalFluctuations.flood;
        seasonalContext += `- Flood Risk: peaks in ${s.peakMonth} (${s.peakValue}/10), current ${s.currentMonth} (${s.currentValue}/10), year avg ${s.yearRoundAvg || '?'}/10, ${s.monthsAboveModerate ?? '?'} months above high risk\n`;
        if (s.monthlyValues?.length) seasonalContext += `  Monthly Risk: ${s.monthlyValues.map((v, i) => months[i] + ':' + v.toFixed(1)).join(', ')}\n`;
      }
      if (seasonalFluctuations.wildfire) {
        const s = seasonalFluctuations.wildfire;
        seasonalContext += `- Wildfire Risk: peaks in ${s.peakMonth} (${s.peakValue}/10), current ${s.currentMonth} (${s.currentValue}/10), year avg ${s.yearRoundAvg || '?'}/10, ${s.monthsAboveModerate ?? '?'} months above high risk\n`;
        if (s.monthlyValues?.length) seasonalContext += `  Monthly Risk: ${s.monthlyValues.map((v, i) => months[i] + ':' + v.toFixed(1)).join(', ')}\n`;
      }
    }

    const userPrompt = `Analyze environmental risks for this property and recommend specific mitigation improvements:

**Property:** ${address} (ZIP: ${zipCode || 'Unknown'})
**Coordinates:** ${latitude}, ${longitude}
**Details:** ${propertyDetails?.bedrooms || '?'} bed, ${propertyDetails?.sqft || '?'} sqft, ${propertyDetails?.stories || '1'} stories
${propertyDetails?.yearBuilt ? `Built: ${propertyDetails.yearBuilt}` : ''}

**Environmental Risk Data (from heat maps & risk assessments):**
${riskSummary.join('\n')}
${seasonalContext}

Use the heat map risk data and seasonal fluctuation patterns to identify where water may pool, when fire risk spikes, and which months drive air quality concerns. Recommend improvements that address peak-season vulnerabilities.

Return JSON:
{
  "propertyAssessment": "2-3 sentence summary of environmental vulnerability based on the data",
  "overallRiskLevel": "low" | "moderate" | "high" | "severe",
  "seasonalInsights": "1-2 sentence summary of how risks shift across seasons and what months are most critical",
  "mitigations": [
    {
      "category": "drainage" | "windows" | "roofing" | "landscaping" | "foundation" | "siding" | "insulation" | "air-filtration" | "fire-resistance" | "flood-barrier" | "other",
      "riskAddressed": "flood" | "wildfire" | "airQuality" | "storm" | "heat",
      "title": "Short descriptive title",
      "description": "Detailed description of the improvement and how it addresses peak-season risks",
      "estimatedCost": { "low": number, "high": number },
      "riskReductionPct": number (0-100),
      "priority": "critical" | "high" | "medium" | "low",
      "timeToComplete": "string (e.g., '2-3 days')",
      "insuranceImpact": "string describing potential insurance discount",
      "seasonalNote": "When to install and which peak months it protects against"
    }
  ],
  "estimatedInsuranceSavings": { "annualLow": number, "annualHigh": number },
  "totalInvestmentRange": { "low": number, "high": number }
}

Provide 4-8 specific, actionable improvements sorted by priority.`;

    if (!OPENAI_API_KEY) {
      console.log('[EnvRiskAI] No OpenAI key, using rule-based analysis');
      return res.json({
        ok: true,
        source: 'rule-based',
        analysis: generateRuleBasedEnvMitigations(risks, propertyDetails, address, seasonalFluctuations)
      });
    }

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.6,
        max_tokens: 2500,
        response_format: { type: 'json_object' }
      })
    });

    if (!openaiRes.ok) {
      console.warn('[EnvRiskAI] OpenAI request failed:', openaiRes.status);
      return res.json({
        ok: true,
        source: 'rule-based',
        analysis: generateRuleBasedEnvMitigations(risks, propertyDetails, address, seasonalFluctuations)
      });
    }

    const openaiData = await openaiRes.json();
    const content = openaiData.choices?.[0]?.message?.content;

    if (content) {
      const analysis = JSON.parse(content);
      console.log(`[EnvRiskAI] AI analysis complete: ${analysis.mitigations?.length || 0} mitigations`);
      return res.json({ ok: true, source: 'ai', analysis });
    }

    res.json({
      ok: true,
      source: 'rule-based',
      analysis: generateRuleBasedEnvMitigations(risks, propertyDetails, address, seasonalFluctuations)
    });

  } catch (error) {
    console.error('[EnvRiskAI] Error:', error);
    res.status(500).json({ ok: false, error: error.message || 'env_risk_analysis_failed' });
  }
});

// Rule-based fallback for environmental risk mitigations
function generateRuleBasedEnvMitigations(risks, propertyDetails, address, seasonalFluctuations) {
  const mitigations = [];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  if (risks?.flood) {
    const isHighRisk = risks.flood.riskLevel === 'High' || risks.flood.riskLevel === 'Very High' ||
      (risks.flood.femaZone && ['A', 'AE', 'AH', 'AO', 'V', 'VE'].includes(risks.flood.femaZone));
    const floodSeasonal = seasonalFluctuations?.flood;
    const peakNote = floodSeasonal ? `Install before ${floodSeasonal.peakMonth} when flood risk peaks at ${floodSeasonal.peakValue}/10` : '';

    mitigations.push({
      category: 'drainage',
      riskAddressed: 'flood',
      title: 'French Drain System',
      description: 'Install a perimeter French drain system to redirect water away from the foundation. Includes gravel trenches, perforated pipe, and proper grading.',
      estimatedCost: { low: 3000, high: 8000 },
      riskReductionPct: isHighRisk ? 25 : 40,
      priority: isHighRisk ? 'critical' : 'high',
      timeToComplete: '3-5 days',
      insuranceImpact: 'May reduce flood insurance by 5-15%',
      seasonalNote: peakNote || 'Best installed during dry season before peak rainfall months'
    });

    if (isHighRisk) {
      mitigations.push({
        category: 'flood-barrier',
        riskAddressed: 'flood',
        title: 'Flood Barriers & Sump Pump',
        description: 'Install permanent flood barriers around entry points and a battery-backup sump pump system in the basement/crawlspace.',
        estimatedCost: { low: 5000, high: 15000 },
        riskReductionPct: 35,
        priority: 'critical',
        timeToComplete: '1-2 weeks',
        insuranceImpact: 'May reduce flood insurance by 10-25%',
        seasonalNote: peakNote || 'Critical before peak flood season'
      });

      mitigations.push({
        category: 'foundation',
        riskAddressed: 'flood',
        title: 'Foundation Waterproofing',
        description: 'Apply exterior waterproofing membrane to foundation walls, seal all cracks, and install a vapor barrier.',
        estimatedCost: { low: 8000, high: 20000 },
        riskReductionPct: 30,
        priority: 'high',
        timeToComplete: '1-2 weeks',
        insuranceImpact: 'May reduce flood insurance by 5-10%',
        seasonalNote: 'Best done during dry months for proper curing'
      });
    }
  }

  if (risks?.wildfire) {
    const isHighRisk = (risks.wildfire.riskScore || 0) > 6;
    const fireSeasonal = seasonalFluctuations?.wildfire;
    const fireNote = fireSeasonal ? `Complete before ${fireSeasonal.peakMonth} when wildfire risk peaks at ${fireSeasonal.peakValue}/10` : '';

    mitigations.push({
      category: 'landscaping',
      riskAddressed: 'wildfire',
      title: 'Defensible Space & Fire-Resistant Landscaping',
      description: 'Create 100ft defensible space zones. Replace combustible plants with fire-resistant native species. Add gravel/stone borders around the structure.',
      estimatedCost: { low: 2000, high: 6000 },
      riskReductionPct: isHighRisk ? 30 : 45,
      priority: isHighRisk ? 'critical' : 'high',
      timeToComplete: '3-7 days',
      insuranceImpact: 'May reduce wildfire insurance by 10-20%',
      seasonalNote: fireNote || 'Complete during spring before summer fire season'
    });

    mitigations.push({
      category: 'roofing',
      riskAddressed: 'wildfire',
      title: 'Class A Fire-Rated Roofing',
      description: 'Replace roofing with Class A fire-rated materials (metal, concrete tile, or asphalt with fire barrier). Add ember-resistant vents.',
      estimatedCost: { low: 8000, high: 25000 },
      riskReductionPct: 35,
      priority: isHighRisk ? 'critical' : 'medium',
      timeToComplete: '3-5 days',
      insuranceImpact: 'May reduce wildfire insurance by 15-30%',
      seasonalNote: fireNote || 'Schedule during mild weather months'
    });

    if (isHighRisk) {
      mitigations.push({
        category: 'siding',
        riskAddressed: 'wildfire',
        title: 'Fire-Resistant Siding',
        description: 'Replace wood or vinyl siding with fiber cement (e.g., HardiePlank) or stucco for fire resistance.',
        estimatedCost: { low: 10000, high: 30000 },
        riskReductionPct: 25,
        priority: 'high',
        timeToComplete: '1-2 weeks',
        insuranceImpact: 'May reduce wildfire insurance by 10-15%',
        seasonalNote: fireNote || 'Must complete before fire season'
      });
    }
  }

  if (risks?.airQuality) {
    const isHighAQI = (risks.airQuality.aqi || 0) > 100;
    const aqiSeasonal = seasonalFluctuations?.airQuality;
    const aqiNote = aqiSeasonal ? `AQI peaks in ${aqiSeasonal.peakMonth} at ${aqiSeasonal.peakValue} — ${aqiSeasonal.monthsAboveModerate} months above moderate` : '';

    mitigations.push({
      category: 'air-filtration',
      riskAddressed: 'airQuality',
      title: 'HEPA Air Filtration System',
      description: 'Install whole-house HEPA air filtration integrated with HVAC. Add MERV-16 filters and smart air quality monitoring.',
      estimatedCost: { low: 2000, high: 5000 },
      riskReductionPct: isHighAQI ? 50 : 60,
      priority: isHighAQI ? 'high' : 'medium',
      timeToComplete: '1-2 days',
      insuranceImpact: 'Minimal direct insurance impact, but improves habitability',
      seasonalNote: aqiNote || 'Replace filters before peak AQI season'
    });

    mitigations.push({
      category: 'windows',
      riskAddressed: 'airQuality',
      title: 'Sealed Double-Pane Windows',
      description: 'Replace windows with premium sealed double-pane windows with low-E coating. Reduces air infiltration by 90%+ when closed.',
      estimatedCost: { low: 5000, high: 15000 },
      riskReductionPct: 30,
      priority: 'medium',
      timeToComplete: '2-4 days',
      insuranceImpact: 'May qualify for energy efficiency insurance discounts',
      seasonalNote: aqiNote || 'Install before poor air quality months'
    });
  }

  // Storm protection (universal based on any elevated risk)
  mitigations.push({
    category: 'windows',
    riskAddressed: 'storm',
    title: 'Impact-Resistant Storm Windows',
    description: 'Install impact-rated storm windows or hurricane shutters on all exterior windows. Protects against high winds, flying debris, and hail.',
    estimatedCost: { low: 3000, high: 12000 },
    riskReductionPct: 30,
    priority: 'medium',
    timeToComplete: '2-3 days',
    insuranceImpact: 'May reduce wind/storm insurance by 10-20%',
    seasonalNote: 'Install before storm season (varies by region)'
  });

  const totalLow = mitigations.reduce((s, m) => s + m.estimatedCost.low, 0);
  const totalHigh = mitigations.reduce((s, m) => s + m.estimatedCost.high, 0);

  // Build seasonal insights from available data
  let seasonalInsights = '';
  if (seasonalFluctuations) {
    const parts = [];
    if (seasonalFluctuations.flood) parts.push(`flood risk peaks in ${seasonalFluctuations.flood.peakMonth}`);
    if (seasonalFluctuations.wildfire) parts.push(`wildfire risk peaks in ${seasonalFluctuations.wildfire.peakMonth}`);
    if (seasonalFluctuations.airQuality) parts.push(`air quality worst in ${seasonalFluctuations.airQuality.peakMonth}`);
    if (parts.length > 0) {
      seasonalInsights = `Seasonal analysis shows ${parts.join(', ')}. Schedule improvements before peak months for maximum protection.`;
    }
  }

  return {
    propertyAssessment: `Based on environmental risk data for ${address}, this property faces ${mitigations.filter(m => m.priority === 'critical').length > 0 ? 'significant' : 'moderate'} environmental risks that can be substantially mitigated through targeted improvements.`,
    overallRiskLevel: mitigations.some(m => m.priority === 'critical') ? 'high' : 'moderate',
    seasonalInsights: seasonalInsights || null,
    mitigations: mitigations.sort((a, b) => {
      const pOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return (pOrder[a.priority] || 3) - (pOrder[b.priority] || 3);
    }),
    estimatedInsuranceSavings: { annualLow: 200, annualHigh: 1500 },
    totalInvestmentRange: { low: totalLow, high: totalHigh }
  };
}

// POST /api/attom/absentee-leads - Save absentee leads to database for tracking
app.post('/api/attom/absentee-leads', requireInternalStaff, async (req, res) => {
  try {
    const { leads, campaignName } = req.body;
    
    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ ok: false, error: 'No leads provided' });
    }

    const { persistAbsenteeLeads } = await import('./services/absenteeLeadPersistService.js');
    const result = await persistAbsenteeLeads(leads, campaignName || 'default');

    console.log(`[API] Saved ${result.saved}/${leads.length} absentee leads (${result.inserted} new, ${result.updated} updated)`);
    res.json({
      ok: true,
      inserted: result.inserted,
      updated: result.updated,
      saved: result.saved,
      total: leads.length,
      savedLeads: result.savedLeads,
      campaignName: result.campaignName,
    });
  } catch (error) {
    console.error('[API] Save leads error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/attom/absentee-leads - Get saved absentee leads
app.get('/api/attom/absentee-leads', requireInternalStaff, async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();

    // Check if table exists
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='absentee_leads'
    `).get();

    if (!tableExists) {
      return res.json({ ok: true, leads: [], total: 0 });
    }

    const status = req.query.status;
    const campaign = req.query.campaign;
    const minScore = req.query.minScore ? parseInt(req.query.minScore) : null;
    
    let query = 'SELECT * FROM absentee_leads WHERE 1=1';
    const params = [];
    
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    if (campaign) {
      query += ' AND campaign_name = ?';
      params.push(campaign);
    }
    if (minScore !== null) {
      query += ' AND motivation_score >= ?';
      params.push(minScore);
    }
    
    query += ' ORDER BY motivation_score DESC, created_at DESC';
    
    const leads = db.prepare(query).all(...params);

    // Parse JSON fields
    const parsed = leads.map(lead => {
      let enrichment = {};
      if (lead.enrichment_json) {
        try {
          enrichment = JSON.parse(lead.enrichment_json);
        } catch {
          enrichment = {};
        }
      }
      return {
        ...lead,
        motivationFactors: lead.motivation_factors ? JSON.parse(lead.motivation_factors) : [],
        isCorporate: lead.is_corporate === 1,
        likelyFreeAndClear: lead.likely_free_and_clear === 1,
        rentalConfidence: lead.rental_confidence ?? enrichment.rentalConfidence ?? null,
        leakRiskScore: lead.leak_risk_score ?? enrichment.leakRiskScore ?? null,
        protectionLeadScore: lead.protection_lead_score ?? enrichment.protectionLeadScore ?? null,
        ...enrichment,
      };
    });

    res.json({ ok: true, leads: parsed, total: parsed.length });
  } catch (error) {
    console.error('[API] Get leads error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// PATCH /api/attom/absentee-leads/:id - Update lead status/notes
app.patch('/api/attom/absentee-leads/:id', requireInternalStaff, async (req, res) => {
  try {
    const leadId = req.params.id;
    const { status, notes, lastContactDate } = req.body;
    
    const { getDb } = await import('./db/connection.js');
    const db = getDb();

    const updates = [];
    const params = [];
    
    if (status) {
      updates.push('status = ?');
      params.push(status);
    }
    if (notes !== undefined) {
      updates.push('notes = ?');
      params.push(notes);
    }
    if (lastContactDate) {
      updates.push('last_contact_date = ?');
      params.push(lastContactDate);
    }
    
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(leadId);

    const result = db.prepare(`
      UPDATE absentee_leads SET ${updates.join(', ')} WHERE id = ?
    `).run(...params);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Lead not found' });
    }

    res.json({ ok: true, updated: result.changes });
  } catch (error) {
    console.error('[API] Update lead error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// ABSENTEE OWNER OUTREACH SYSTEM
// AI-powered contact lookup and email generation for property owner outreach
// ============================================================================

// Import outreach modules
let lookupOwnerContact = null;
let generateOutreachEmail = null;
let generateEmailVariants = null;
let generateFollowUpSequence = null;
let generateTemplateEmail = null;
let improveOutreachEmail = null;

(async () => {
  try {
    const contactLookup = await import('./owner-contact-lookup.js');
    lookupOwnerContact = contactLookup.lookupOwnerContact;
    console.log('✅ [Outreach] Contact lookup service loaded');
  } catch (e) {
    console.warn('⚠️ [Outreach] Contact lookup service not available:', e.message);
  }
  
  try {
    const emailGen = await import('./ai-outreach-generator.js');
    generateOutreachEmail = emailGen.generateOutreachEmail;
    generateEmailVariants = emailGen.generateEmailVariants;
    generateFollowUpSequence = emailGen.generateFollowUpSequence;
    generateTemplateEmail = emailGen.generateTemplateEmail;
    improveOutreachEmail = emailGen.improveOutreachEmail;
    console.log('✅ [Outreach] AI email generator loaded');
  } catch (e) {
    console.warn('⚠️ [Outreach] AI email generator not available:', e.message);
  }
})();

// POST /api/outreach/lookup-contact - Find contact info for a property owner
app.post('/api/outreach/lookup-contact', requireInternalStaff, async (req, res) => {
  try {
    if (!lookupOwnerContact) {
      return res.status(503).json({ ok: false, error: 'Contact lookup service not available' });
    }

    const { owner, property } = req.body;
    
    if (!owner || !owner.name) {
      return res.status(400).json({ ok: false, error: 'Owner information required' });
    }

    console.log('[Outreach] Looking up contact for:', owner.name);
    const result = await lookupOwnerContact(owner, property || {});
    
    res.json({
      ok: true,
      contact: result
    });
  } catch (error) {
    console.error('[Outreach] Contact lookup error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/outreach/generate-email - Generate AI-powered outreach email
app.post('/api/outreach/generate-email', requireInternalStaff, async (req, res) => {
  try {
    if (!generateOutreachEmail) {
      // Fall back to template if AI not available
      if (generateTemplateEmail) {
        const result = generateTemplateEmail(req.body);
        return res.json(result);
      }
      return res.status(503).json({ ok: false, error: 'Email generator not available' });
    }

    const { property, owner, buyer, tone, questions, offer, insuranceEstimate, purpose, isFollowUp, previousEmailDate, enrichmentContext } = req.body;
    
    if (!property || !owner) {
      return res.status(400).json({ ok: false, error: 'Property and owner information required' });
    }

    console.log('[Outreach] Generating email for:', property.address, `(purpose: ${purpose || 'acquisition'})`);
    const result = await generateOutreachEmail({
      property,
      owner,
      buyer: buyer || {},
      tone: tone || 'professional',
      questions: questions || [],
      offer: offer || {},
      insuranceEstimate: insuranceEstimate || null,
      purpose: purpose || 'acquisition',
      isFollowUp: isFollowUp || false,
      previousEmailDate,
      enrichmentContext: enrichmentContext || '',
    });
    
    res.json(result);
  } catch (error) {
    console.error('[Outreach] Email generation error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/outreach/generate-variants - Generate multiple email variants
app.post('/api/outreach/generate-variants', requireInternalStaff, async (req, res) => {
  try {
    if (!generateEmailVariants) {
      return res.status(503).json({ ok: false, error: 'Email variant generator not available' });
    }

    const { property, owner, buyer, questions, offer, count } = req.body;
    
    console.log('[Outreach] Generating email variants for:', property?.address);
    const result = await generateEmailVariants({
      property,
      owner,
      buyer: buyer || {},
      questions: questions || [],
      offer: offer || {}
    }, count || 3);
    
    res.json(result);
  } catch (error) {
    console.error('[Outreach] Variant generation error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/outreach/generate-sequence - Generate follow-up email sequence
app.post('/api/outreach/generate-sequence', requireInternalStaff, async (req, res) => {
  try {
    if (!generateFollowUpSequence) {
      return res.status(503).json({ ok: false, error: 'Sequence generator not available' });
    }

    const { property, owner, buyer, questions, offer, sequenceLength } = req.body;
    
    console.log('[Outreach] Generating email sequence for:', property?.address);
    const result = await generateFollowUpSequence({
      property,
      owner,
      buyer: buyer || {},
      questions: questions || [],
      offer: offer || {}
    }, sequenceLength || 3);
    
    res.json(result);
  } catch (error) {
    console.error('[Outreach] Sequence generation error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/outreach/improve-email - Improve an existing email
app.post('/api/outreach/improve-email', requireInternalStaff, async (req, res) => {
  try {
    if (!improveOutreachEmail) {
      return res.status(503).json({ ok: false, error: 'Email improvement service not available' });
    }

    const { emailText, feedback } = req.body;
    
    if (!emailText) {
      return res.status(400).json({ ok: false, error: 'Email text required' });
    }

    console.log('[Outreach] Improving email...');
    const result = await improveOutreachEmail(emailText, feedback || '');
    
    res.json(result);
  } catch (error) {
    console.error('[Outreach] Email improvement error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/outreach/send-email - Send outreach email via Gmail
app.post('/api/outreach/send-email', requireInternalStaff, async (req, res) => {
  try {
    const { to, subject, body, leadId, propertyAddress } = req.body;
    
    if (!to || !subject || !body) {
      return res.status(400).json({ ok: false, error: 'Recipient, subject, and body required' });
    }

    const complianceFooter = '\n\n---\nHouseYield · Remote property protection\nReply STOP to opt out of future outreach.';
    const bodyWithCompliance = body.includes('opt out') ? body : `${body}${complianceFooter}`;

    // Try to send via Gmail
    const sendResult = await sendGmailHtml({
      to,
      subject,
      html: bodyWithCompliance.replace(/\n/g, '<br>')
    });

    // Log the outreach attempt
    if (leadId) {
      try {
        const { getDb } = await import('./db/connection.js');
        const db = getDb();

        const resolveLeadDbId = (rawLeadId) => {
          if (!rawLeadId) return null;
          const asInt = parseInt(rawLeadId, 10);
          if (Number.isFinite(asInt) && String(asInt) === String(rawLeadId)) {
            const byId = db.prepare('SELECT id FROM absentee_leads WHERE id = ?').get(asInt);
            if (byId) return byId.id;
          }
          const byAttom = db.prepare('SELECT id FROM absentee_leads WHERE attom_id = ?').get(String(rawLeadId));
          return byAttom?.id || null;
        };

        const resolvedLeadId = resolveLeadDbId(leadId);
        
        // Create outreach log table if not exists
        db.exec(`
          CREATE TABLE IF NOT EXISTS outreach_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id INTEGER,
            property_address TEXT,
            recipient_email TEXT,
            subject TEXT,
            body TEXT,
            status TEXT,
            sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
            response_received INTEGER DEFAULT 0,
            response_date TEXT,
            notes TEXT
          )
        `);

        db.prepare(`
          INSERT INTO outreach_log (lead_id, property_address, recipient_email, subject, body, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(resolvedLeadId, propertyAddress, to, subject, bodyWithCompliance, sendResult.ok ? 'sent' : 'failed');

        if (resolvedLeadId) {
          db.prepare(`
            UPDATE absentee_leads SET last_contact_date = CURRENT_TIMESTAMP, status = 'contacted', updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).run(resolvedLeadId);
        }
      } catch (dbError) {
        console.error('[Outreach] Database logging error:', dbError.message);
      }
    }

    if (sendResult.ok) {
      console.log('[Outreach] Email sent successfully to:', to);
      res.json({ ok: true, messageId: sendResult.id, status: 'sent' });
    } else {
      console.warn('[Outreach] Email send failed:', sendResult.error);
      res.json({ 
        ok: false, 
        error: sendResult.error,
        logged: true,
        message: 'Email logged but delivery failed. Check Gmail configuration.'
      });
    }
  } catch (error) {
    console.error('[Outreach] Send email error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/outreach/log - Get outreach history
app.get('/api/outreach/log', requireInternalStaff, async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();

    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='outreach_log'
    `).get();

    if (!tableExists) {
      return res.json({ ok: true, logs: [], total: 0 });
    }

    const leadId = req.query.leadId;
    const status = req.query.status;
    
    let query = 'SELECT * FROM outreach_log WHERE 1=1';
    const params = [];
    
    if (leadId) {
      query += ' AND lead_id = ?';
      params.push(leadId);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY sent_at DESC';
    
    const logs = db.prepare(query).all(...params);
    
    res.json({ ok: true, logs, total: logs.length });
  } catch (error) {
    console.error('[Outreach] Get log error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/outreach/stats - Get outreach statistics
app.get('/api/outreach/stats', requireInternalStaff, async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();

    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='outreach_log'
    `).get();

    if (!tableExists) {
      return res.json({ 
        ok: true, 
        stats: { 
          totalSent: 0, 
          totalResponses: 0, 
          responseRate: 0,
          lastSent: null 
        } 
      });
    }

    const stats = db.prepare(`
      SELECT 
        COUNT(*) as totalSent,
        SUM(CASE WHEN response_received = 1 THEN 1 ELSE 0 END) as totalResponses,
        MAX(sent_at) as lastSent
      FROM outreach_log WHERE status = 'sent'
    `).get();

    res.json({
      ok: true,
      stats: {
        totalSent: stats.totalSent || 0,
        totalResponses: stats.totalResponses || 0,
        responseRate: stats.totalSent > 0 
          ? ((stats.totalResponses / stats.totalSent) * 100).toFixed(1) + '%'
          : '0%',
        lastSent: stats.lastSent
      }
    });
  } catch (error) {
    console.error('[Outreach] Get stats error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/internal/staff-check', requireInternalStaff, (req, res) => {
  res.json({
    ok: true,
    email: req.internalStaff.email,
    uid: req.internalStaff.uid,
  });
});

(async () => {
  try {
    const internalOpsModule = await import('./routes/internalOps.js');
    app.use('/api/internal', internalOpsModule.default);
    console.log('✅ [InternalOps] Staff install-kit endpoints mounted at /api/internal');
  } catch (error) {
    console.warn('⚠️  [InternalOps] Failed to mount internal ops routes:', error.message);
  }
})();

(async () => {
  try {
    const taxAppealModule = await import('./routes/taxAppeal.js');
    app.use('/api/tax-appeal', requireInternalStaff, taxAppealModule.default);
    console.log('✅ [TaxAppeal] Over-assessment + brief routes mounted at /api/tax-appeal');
  } catch (error) {
    console.warn('⚠️  [TaxAppeal] Failed to mount tax appeal routes:', error.message);
  }
})();

// ============================================================================
// END ABSENTEE OWNER OUTREACH SYSTEM
// ============================================================================

// Google Custom Search proxy endpoint
// GET /api/google-search?q=query&num=10
app.get('/api/google-search', async (req, res) => {
  try {
    const query = req.query.q;
    const num = parseInt(req.query.num || '10', 10);
    
    if (!query) {
      return res.status(400).json({ ok: false, error: 'missing_query' });
    }
    
    if (!GOOGLE_API_KEY || !GOOGLE_CSE_CX) {
      console.warn('[Google Search] API credentials not configured');
      return res.json({ ok: true, items: [], warning: 'google_search_not_configured' });
    }
    
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', GOOGLE_API_KEY);
    url.searchParams.set('cx', GOOGLE_CSE_CX);
    url.searchParams.set('q', query);
    url.searchParams.set('num', num.toString());
    
    const response = await fetch(url.toString());
    
    if (!response.ok) {
      console.error('[Google Search] API error:', response.status);
      return res.json({ ok: true, items: [], warning: `google_api_error_${response.status}` });
    }
    
    const data = await response.json();
    
    res.json({ 
      ok: true, 
      items: data.items || [],
      searchInfo: data.searchInformation
    });
    
  } catch (e) {
    console.error('[Google Search] Error:', e);
    res.json({ ok: true, items: [], error: e.message });
  }
});

// BLS API proxy endpoint to avoid CORS issues
// GET /api/bls/wage?seriesId=OEUN000000000000232012&startYear=2024&endYear=2025
app.get('/api/bls/wage', async (req, res) => {
  try {
    const { seriesId, startYear, endYear } = req.query;
    
    if (!seriesId || !startYear || !endYear) {
      return res.status(400).json({ ok: false, error: 'missing_parameters' });
    }
    
    const BLS_API_KEY = process.env.BLS_API_KEY || process.env.VITE_BLS_API_KEY || process.env.Bureau_of_Labor_Statistics_API_Key || '';
    
    const requestBody = {
      seriesid: [seriesId],
      startyear: startYear,
      endyear: endYear
    };
    
    if (BLS_API_KEY) {
      requestBody.registrationkey = BLS_API_KEY;
    }
    
    const response = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      console.error('[BLS] API error:', response.status);
      return res.json({ ok: false, error: `bls_api_error_${response.status}` });
    }
    
    const data = await response.json();
    res.json({ ok: true, data });
    
  } catch (e) {
    console.error('[BLS] Error:', e);
    res.json({ ok: false, error: e.message });
  }
});

// Property management endpoints
import { saveProperty, getUserProperties, getProperty, deleteProperty, updatePropertyFinancials } from './db/properties.js';
import { 
  createListing, getUserListings, getListingById, updateListing, deleteListing,
  incrementListingViews, createSyndication, updateSyndicationStatus, getListingSyndication,
  createLead, getListingLeads, updateLeadStatus, createShowingRequest, getListingShowings, updateShowingStatus
} from './db/listings.js';
import { syndicateToAllPlatforms } from './syndication.js';
import { testFacebookConnection } from './facebook-marketplace.js';

async function hydratePropertyFromAttomCache(property) {
  if (!property || !property.address) {
    return property;
  }

  const embeddedPropertyData = property.propertyData || property.property_data || null;
  if (isUsableAttomDashboardData(embeddedPropertyData)) {
    return property;
  }

  const attomId = embeddedPropertyData?.summary?.attom_id || property.attomId || property.attom_id;

  let cachedRecord = await getCachedAttomData(property.address);
  if (!isUsableAttomDashboardData(cachedRecord?.data) && attomId) {
    cachedRecord = await getCachedAttomDataById(attomId);
  }

  if (!isUsableAttomDashboardData(cachedRecord?.data)) {
    return property;
  }

  console.log(`[Portfolio] Hydrated ATTOM property data from Firestore cache for ${property.address}`);

  return {
    ...property,
    propertyData: cachedRecord.data,
    property_data: cachedRecord.data,
    attomCacheHydrated: true,
    attomCacheAgeDays: cachedRecord.ageDays,
  };
}

async function hydratePropertiesFromAttomCache(properties) {
  if (!Array.isArray(properties) || properties.length === 0) {
    return properties;
  }

  return Promise.all(properties.map((property) => hydratePropertyFromAttomCache(property)));
}

function resolvePropertyUserId(rawUserId, fallback = '1') {
  const candidate = rawUserId === undefined || rawUserId === null
    ? fallback
    : String(rawUserId).trim();

  if (!candidate) {
    return fallback;
  }

  return /^\d+$/.test(candidate) ? parseInt(candidate, 10) : candidate;
}

// POST /api/properties - Save a property to portfolio
app.post('/api/properties', async (req, res) => {
  try {
    const { address, propertyData, financials } = req.body;
    const userId = resolvePropertyUserId(req.body.userId);
    
    if (!address) {
      return res.status(400).json({ ok: false, error: 'missing_address' });
    }
    
    const property = saveProperty(userId, address, propertyData, financials);
    res.json({ ok: true, property });
  } catch (e) {
    console.error('[API] Error saving property:', e);
    res.status(500).json({ ok: false, error: e.message || 'save_property_failed' });
  }
});

// GET /api/properties - Get all properties for user
app.get('/api/properties', async (req, res) => {
  try {
    const userId = resolvePropertyUserId(req.query.userId);
    const properties = await hydratePropertiesFromAttomCache(getUserProperties(userId));
    res.json({ ok: true, properties });
  } catch (e) {
    console.error('[API] Error getting properties:', e);
    res.status(500).json({ ok: false, error: e.message || 'get_properties_failed' });
  }
});

// GET /api/properties/:id - Get a single property
app.get('/api/properties/:id', async (req, res) => {
  try {
    const propertyId = parseInt(req.params.id, 10);
    const userId = resolvePropertyUserId(req.query.userId);
    
    const property = getProperty(propertyId, userId);
    
    if (!property) {
      return res.status(404).json({ ok: false, error: 'property_not_found' });
    }
    
    res.json({ ok: true, property });
  } catch (e) {
    console.error('[API] Error getting property:', e);
    res.status(500).json({ ok: false, error: e.message || 'get_property_failed' });
  }
});

// DELETE /api/properties/:id - Delete a property
app.delete('/api/properties/:id', async (req, res) => {
  try {
    const propertyId = parseInt(req.params.id, 10);
    const userId = resolvePropertyUserId(req.query.userId);
    
    const success = deleteProperty(propertyId, userId);
    
    if (!success) {
      return res.status(404).json({ ok: false, error: 'property_not_found' });
    }
    
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Error deleting property:', e);
    res.status(500).json({ ok: false, error: e.message || 'delete_property_failed' });
  }
});

// PUT /api/properties/:id/financials - Update property financials
app.put('/api/properties/:id/financials', async (req, res) => {
  try {
    const propertyId = parseInt(req.params.id, 10);
    const userId = resolvePropertyUserId(req.body.userId);
    const { financials } = req.body;
    
    if (!financials) {
      return res.status(400).json({ ok: false, error: 'missing_financials' });
    }
    
    const success = updatePropertyFinancials(propertyId, userId, financials);
    
    if (!success) {
      return res.status(404).json({ ok: false, error: 'property_not_found' });
    }
    
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Error updating financials:', e);
    res.status(500).json({ ok: false, error: e.message || 'update_financials_failed' });
  }
});

// ==================== PROPERTY LISTINGS & TENANT DISCOVERY ====================

// POST /api/listings - Create a new property listing
app.post('/api/listings', async (req, res) => {
  try {
    console.log('[API] Creating listing with data:', req.body);
    const userId = parseInt(req.body.userId || '1', 10);
    const listing = createListing(userId, req.body);
    console.log('[API] Listing created successfully:', listing.id);
    res.json({ ok: true, listing });
  } catch (e) {
    console.error('[API] Error creating listing:', e);
    console.error('[API] Error details:', e.message);
    console.error('[API] Stack trace:', e.stack);
    res.status(500).json({ ok: false, error: e.message || 'create_listing_failed' });
  }
});

// GET /api/listings - Get all listings for user
app.get('/api/listings', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId || '1', 10);
    const status = req.query.status;
    const filters = status ? { status } : {};
    const listings = getUserListings(userId, filters);
    res.json({ ok: true, listings });
  } catch (e) {
    console.error('[API] Error getting listings:', e);
    res.status(500).json({ ok: false, error: e.message || 'get_listings_failed' });
  }
});

// GET /api/listings/:id - Get a single listing
app.get('/api/listings/:id', async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    
    const listing = getListingById(listingId, userId);
    
    if (!listing) {
      return res.status(404).json({ ok: false, error: 'listing_not_found' });
    }
    
    // Increment view count for public views (no userId)
    if (!userId) {
      incrementListingViews(listingId);
    }
    
    res.json({ ok: true, listing });
  } catch (e) {
    console.error('[API] Error getting listing:', e);
    res.status(500).json({ ok: false, error: e.message || 'get_listing_failed' });
  }
});

// PUT /api/listings/:id - Update a listing
app.put('/api/listings/:id', async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const userId = parseInt(req.body.userId || '1', 10);
    const listing = updateListing(listingId, userId, req.body);
    res.json({ ok: true, listing });
  } catch (e) {
    console.error('[API] Error updating listing:', e);
    res.status(500).json({ ok: false, error: e.message || 'update_listing_failed' });
  }
});

// DELETE /api/listings/:id - Delete a listing
app.delete('/api/listings/:id', async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const userId = parseInt(req.query.userId || '1', 10);
    const success = deleteListing(listingId, userId);
    
    if (!success) {
      return res.status(404).json({ ok: false, error: 'listing_not_found' });
    }
    
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Error deleting listing:', e);
    res.status(500).json({ ok: false, error: e.message || 'delete_listing_failed' });
  }
});

// POST /api/listings/syndicate/facebook - Syndicate specific listing to Facebook
app.post('/api/listings/syndicate/facebook', async (req, res) => {
  try {
    const listingId = parseInt(req.body.listingId, 10);
    const userId = parseInt(req.body.userId || '1', 10);
    
    const listing = getListingById(listingId, userId);
    
    if (!listing) {
      return res.status(404).json({ ok: false, error: 'listing_not_found' });
    }
    
    console.log('[API] Posting listing to Facebook:', listingId);
    
    // Import Facebook module if available
    let facebookResult;
    try {
      const { postToFacebookMarketplace } = await import('./facebook-marketplace.js');
      facebookResult = await postToFacebookMarketplace(listing);
      
      // Save syndication result
      if (facebookResult.success) {
        createSyndication(listingId, 'facebook', facebookResult.externalId, facebookResult.platformUrl);
      }
      
      res.json({ ok: true, syndication: facebookResult });
    } catch (importError) {
      console.error('[API] Facebook integration not available:', importError);
      res.json({ 
        ok: false, 
        syndication: { 
          success: false, 
          error: 'Facebook integration not configured' 
        } 
      });
    }
  } catch (e) {
    console.error('[API] Error posting to Facebook:', e);
    res.status(500).json({ ok: false, error: e.message || 'facebook_posting_failed' });
  }
});

// POST /api/listings/:id/syndicate - Syndicate listing to all platforms
app.post('/api/listings/:id/syndicate', async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const userId = parseInt(req.body.userId || '1', 10);
    const platforms = req.body.platforms || ['zillow', 'facebook', 'craigslist'];
    
    const listing = getListingById(listingId, userId);
    
    if (!listing) {
      return res.status(404).json({ ok: false, error: 'listing_not_found' });
    }
    
    console.log('[API] Starting syndication for listing:', listingId, 'platforms:', platforms);
    
    const results = await syndicateToAllPlatforms(listing);
    
    // Save syndication results to database
    for (const [platform, result] of Object.entries(results)) {
      if (result && platforms.includes(platform)) {
        if (result.success && !result.manual) {
          createSyndication(listingId, platform, result.externalId, result.platformUrl);
        } else if (result.success && result.manual) {
          // For manual platforms like Craigslist
          createSyndication(listingId, platform, 'manual', result.url);
        } else if (result.error) {
          updateSyndicationStatus(listingId, platform, 'error', result.error);
        }
      }
    }
    
    res.json({ ok: true, results });
  } catch (e) {
    console.error('[API] Error syndicating listing:', e);
    res.status(500).json({ ok: false, error: e.message || 'syndication_failed' });
  }
});

// GET /api/listings/:id/syndication - Get syndication status
app.get('/api/listings/:id/syndication', async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const syndication = getListingSyndication(listingId);
    res.json({ ok: true, syndication });
  } catch (e) {
    console.error('[API] Error getting syndication:', e);
    res.status(500).json({ ok: false, error: e.message || 'get_syndication_failed' });
  }
});

// POST /api/listings/:id/leads - Create a lead from inquiry
app.post('/api/listings/:id/leads', async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const lead = createLead(listingId, req.body);
    
    // TODO: Send email notification to property manager
    
    res.json({ ok: true, lead });
  } catch (e) {
    console.error('[API] Error creating lead:', e);
    res.status(500).json({ ok: false, error: e.message || 'create_lead_failed' });
  }
});

// GET /api/listings/:id/leads - Get all leads for a listing
app.get('/api/listings/:id/leads', async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const leads = getListingLeads(listingId);
    res.json({ ok: true, leads });
  } catch (e) {
    console.error('[API] Error getting leads:', e);
    res.status(500).json({ ok: false, error: e.message || 'get_leads_failed' });
  }
});

// PUT /api/leads/:id/status - Update lead status
app.put('/api/leads/:id/status', async (req, res) => {
  try {
    const leadId = parseInt(req.params.id, 10);
    const { status, notes } = req.body;
    
    if (!status) {
      return res.status(400).json({ ok: false, error: 'missing_status' });
    }
    
    updateLeadStatus(leadId, status, notes);
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Error updating lead status:', e);
    res.status(500).json({ ok: false, error: e.message || 'update_lead_failed' });
  }
});

// POST /api/listings/:id/showings - Create showing request
app.post('/api/listings/:id/showings', async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const { leadId, requestedDate, requestedTime } = req.body;
    
    if (!requestedDate || !requestedTime) {
      return res.status(400).json({ ok: false, error: 'missing_date_or_time' });
    }
    
    const showingId = createShowingRequest(listingId, leadId, requestedDate, requestedTime);
    
    // TODO: Send notification to property manager
    
    res.json({ ok: true, showingId });
  } catch (e) {
    console.error('[API] Error creating showing:', e);
    res.status(500).json({ ok: false, error: e.message || 'create_showing_failed' });
  }
});

// GET /api/listings/:id/showings - Get showing requests
app.get('/api/listings/:id/showings', async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const showings = getListingShowings(listingId);
    res.json({ ok: true, showings });
  } catch (e) {
    console.error('[API] Error getting showings:', e);
    res.status(500).json({ ok: false, error: e.message || 'get_showings_failed' });
  }
});

// PUT /api/showings/:id/status - Update showing status
app.put('/api/showings/:id/status', async (req, res) => {
  try {
    const showingId = parseInt(req.params.id, 10);
    const { status } = req.body;
    
    if (!status) {
      return res.status(400).json({ ok: false, error: 'missing_status' });
    }
    
    updateShowingStatus(showingId, status);
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Error updating showing status:', e);
    res.status(500).json({ ok: false, error: e.message || 'update_showing_failed' });
  }
});

// GET /api/facebook/test - Test Facebook Marketplace connection
app.get('/api/facebook/test', async (req, res) => {
  try {
    const result = await testFacebookConnection();
    res.json(result);
  } catch (e) {
    console.error('[API] Facebook test error:', e);
    res.status(500).json({ ok: false, error: e.message || 'test_failed' });
  }
});

// POST /api/facebook/test-post - Post test listing to Facebook page
app.post('/api/facebook/test-post', async (req, res) => {
  try {
    const pageId = process.env.FACEBOOK_PAGE_ID;
    const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

    if (!pageId || !accessToken) {
      return res.json({ 
        success: false, 
        error: 'Facebook credentials not configured in .env' 
      });
    }

    // Create test post
    const postResponse = await fetch(`https://graph.facebook.com/v18.0/${pageId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `🏠 TEST POST from HouseYield - Property Management Platform\n\n` +
                 `Beautiful 2BR apartment available for rent!\n\n` +
                 `📍 Location: 123 Main Street, Seattle, WA\n` +
                 `💰 Rent: $2,500/month\n` +
                 `🛏️ Beds: 2 | 🛁 Baths: 2\n` +
                 `📏 Size: 1,200 sqft\n` +
                 `🐕 Pet-friendly ✓\n` +
                 `🚗 Parking included\n\n` +
                 `✨ Features:\n` +
                 `• Modern kitchen with stainless appliances\n` +
                 `• In-unit washer/dryer\n` +
                 `• Hardwood floors\n` +
                 `• Close to transit\n\n` +
                 `This is a test post demonstrating our automated listing system.`,
        access_token: accessToken
      })
    });

    const postData = await postResponse.json();

    if (postData.error) {
      console.error('[Facebook Test] Post error:', postData.error);
      return res.json({ 
        success: false, 
        error: postData.error.message || 'Failed to post' 
      });
    }

    // Get page info
    const pageResponse = await fetch(
      `https://graph.facebook.com/v18.0/${pageId}?fields=name,category,fan_count&access_token=${accessToken}`
    );
    const pageInfo = await pageResponse.json();

    res.json({ 
      success: true, 
      postId: postData.id,
      pageInfo: {
        name: pageInfo.name,
        category: pageInfo.category,
        followers: pageInfo.fan_count
      }
    });

  } catch (e) {
    console.error('[API] Facebook test post error:', e);
    res.status(500).json({ success: false, error: e.message || 'test_post_failed' });
  }
});

// ==================== END LISTINGS API ====================

// Parcel geometry endpoint (returns parcel boundaries and school zones)
// GET /api/attom/parcel-geometry?address=123+Main+St&attomId=12345
//
// Cache-first: a live fetchPropertyDashboard costs ~19 ATTOM calls against a
// 1000/month cap, and the twin hits this route on every property view. We only
// go to the API when the cached record has neither parcel geometry nor schools,
// since a hit carrying neither is indistinguishable from never having fetched
// the geometry-bearing endpoints.
app.get('/api/attom/parcel-geometry', async (req, res) => {
  try {
    const address = (req.query.address || '').toString().trim();
    const attomId = (req.query.attomId || '').toString().trim() || undefined;

    if (!address && !attomId) {
      return res.status(400).json({ ok: false, error: 'missing_address_or_attomId' });
    }

    const buildResponse = (dashboard, source, cachedAt = null) => ({
      ok: true,
      parcel_geometry: dashboard?.parcel_geometry || null,
      schools: dashboard?.schools || [],
      transportation_noise: dashboard?.transportation_noise || null,
      building_geometry: deriveBuildingGeometry(dashboard),
      source,
      cachedAt,
    });

    const hasGeometryPayload = (dashboard) => Boolean(
      dashboard?.parcel_geometry
      || (Array.isArray(dashboard?.schools) && dashboard.schools.length > 0)
    );

    const cached = address
      ? await getCachedAttomData(address)
      : await getCachedAttomDataById(attomId);

    if (cached?.data && hasGeometryPayload(cached.data)) {
      return res.json(buildResponse(
        cached.data,
        cached.stale ? 'firestore-cache-stale' : 'firestore-cache',
        cached.cachedAt || null,
      ));
    }

    /*
     * A cached dashboard with no parcel outline is still enough to pick a twin
     * shape. An earlier version only trusted the cache when it had geometry, so
     * an apartment whose ATTOM blob never included a lot line was live-fetched
     * (or drawn as a house) every time the twin opened.
     */
    if (cached?.data && deriveBuildingGeometry(cached.data)) {
      return res.json(buildResponse(
        cached.data,
        cached.stale ? 'firestore-cache-stale' : 'firestore-cache',
        cached.cachedAt || null,
      ));
    }

    const cacheOnlyMode = ['1', 'true', 'yes'].includes(
      String(process.env.ATTOM_CACHE_ONLY || '').toLowerCase()
    );

    if (cacheOnlyMode) {
      // Serve whatever the cache holds rather than spending calls.
      return res.json(buildResponse(cached?.data || null, 'cache-only', cached?.cachedAt || null));
    }

    const dashboard = await fetchPropertyDashboard({
      address: address || undefined,
      attomId,
      includeComponents: false
    });

    if (address && dashboard && isUsableAttomDashboardData(dashboard)) {
      cacheAttomData(address, dashboard, dashboard?.summary?.attom_id).catch((cacheError) => {
        console.warn('[ATTOM Parcel] Failed to cache dashboard:', cacheError?.message || cacheError);
      });
    }

    res.json(buildResponse(dashboard, 'attom-api'));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'fetch_failed' });
  }
});

// ==================== TWIN BUILDING MODEL ====================
// The stacking plan for a multifamily twin: floors, units per floor, whether
// there is a double-loaded corridor, and whether the risers are shared.
//
// Seeded from cached ATTOM data by the parcel-geometry route above, then
// corrected by whoever manages the building. Only the corrected version lives
// here, and it makes no ATTOM calls of its own.
app.get('/api/twin/building-model/:propertyId', async (req, res) => {
  try {
    const record = await getBuildingModel(req.params.propertyId);
    // A miss is a normal state, not an error: it means nobody has confirmed a
    // plan yet, so the client should keep showing its ATTOM-seeded guess and the
    // confirm prompt along with it.
    res.json({ ok: true, model: record });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'read_failed' });
  }
});

// The site envelope: lot boundary, the building's outline on it, storeys, and
// which parcel edge faces the street — everything the twin needs to draw a
// specific property rather than a generic house.
//
// Reads the ATTOM cache only. It never fetches, so it is safe to call on every
// twin open; see siteModelService.js for why that rule is absolute here.
app.get('/api/twin/site-model/:propertyId', async (req, res) => {
  try {
    const result = await getSiteModel(req.params.propertyId, {
      address: (req.query.address || '').toString().trim() || undefined,
      attomId: (req.query.attomId || '').toString().trim() || undefined,
      refresh: String(req.query.refresh || '').toLowerCase() === 'true',
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'site_model_failed' });
  }
});

app.put('/api/twin/site-model/:propertyId', async (req, res) => {
  try {
    const { spec, confirmedBy } = req.body || {};
    if (!spec || typeof spec !== 'object') {
      return res.status(400).json({ ok: false, error: 'spec_required' });
    }
    const result = await saveSiteModel(req.params.propertyId, spec, {
      confirmedBy: confirmedBy || null,
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'site_model_save_failed' });
  }
});

app.put('/api/twin/building-model/:propertyId', async (req, res) => {
  try {
    const { spec, confirmedBy, derivedFrom } = req.body || {};
    if (!spec || typeof spec !== 'object') {
      return res.status(400).json({ ok: false, error: 'spec_required' });
    }

    const record = await saveBuildingModel(req.params.propertyId, spec, {
      confirmedBy: confirmedBy || null,
      derivedFrom: derivedFrom || null,
    });
    res.json({ ok: true, model: record });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'save_failed' });
  }
});

// ==================== NASA ENVIRONMENTAL DATA ====================
// GET /api/nasa/wildfire-risk?lat=39.05&lng=-77.18
// Returns comprehensive wildfire risk with NASA FIRMS + POWER data
app.get('/api/nasa/wildfire-risk', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ ok: false, error: 'invalid_coordinates' });
    }
    
    const { getEnhancedWildfireRisk } = await import('./nasa-environmental.js');
    const result = await getEnhancedWildfireRisk(lat, lng);
    
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[NASA Wildfire API] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message || 'nasa_failed' });
  }
});

// GET /api/nasa/active-fires?lat=39.05&lng=-77.18&days=30
// Returns active fires from NASA FIRMS
app.get('/api/nasa/active-fires', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const days = parseInt(req.query.days) || 30;
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ ok: false, error: 'invalid_coordinates' });
    }
    
    const { getNASAActiveFires } = await import('./nasa-environmental.js');
    const result = await getNASAActiveFires(lat, lng, days);
    
    res.json(result);
  } catch (e) {
    console.error('[NASA Active Fires API] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message || 'nasa_failed' });
  }
});

// GET /api/nasa/drought?lat=39.05&lng=-77.18
// Returns drought conditions from NASA POWER
app.get('/api/nasa/drought', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ ok: false, error: 'invalid_coordinates' });
    }
    
    const { getNASADroughtData } = await import('./nasa-environmental.js');
    const result = await getNASADroughtData(lat, lng);
    
    res.json(result);
  } catch (e) {
    console.error('[NASA Drought API] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message || 'nasa_failed' });
  }
});

// ==================== FEMA FLOOD ZONE PROXY ====================
// GET /api/fema/flood-zone?lat=39.05&lng=-77.18
// Proxies FEMA National Flood Hazard Layer to avoid CSP issues
app.get('/api/fema/flood-zone', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ ok: false, error: 'invalid_coordinates' });
    }
    
    // FEMA National Flood Hazard Layer - Layer 28 is flood zones
    const femaUrl = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?where=1%3D1&geometry=${lng}%2C${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,STATIC_BFE&returnGeometry=false&f=json`;
    
    console.log('[FEMA Proxy] Fetching flood zone for:', { lat, lng });
    
    const response = await fetch(femaUrl);
    const data = await response.json();
    
    if (data.error) {
      console.error('[FEMA Proxy] API error:', data.error);
      return res.status(500).json({ ok: false, error: 'fema_api_error', details: data.error });
    }
    
    // Extract flood zone data
    let floodZone = 'X'; // Default to minimal risk
    let riskScore = 20;
    let zoneSubtype = null;
    
    if (data.features && data.features.length > 0) {
      const zone = data.features[0].attributes.FLD_ZONE;
      zoneSubtype = data.features[0].attributes.ZONE_SUBTY;
      floodZone = zone;
      
      // Calculate risk score based on FEMA zone
      if (zone === 'VE' || zone === 'V') riskScore = 100; // Coastal high velocity
      else if (zone === 'AE' || zone === 'A' || zone === 'AO' || zone === 'AH') riskScore = 85; // High risk
      else if (zone === 'X' && zoneSubtype?.includes('0.2')) riskScore = 50; // Moderate
      else if (zone === 'X') riskScore = 15; // Minimal
      else if (zone === 'D') riskScore = 40; // Undetermined
      else riskScore = 20;
    }
    
    console.log('[FEMA Proxy] Result:', { floodZone, riskScore, zoneSubtype });
    
    res.json({ 
      ok: true, 
      floodZone, 
      zoneSubtype,
      riskScore,
      lat,
      lng
    });
  } catch (e) {
    console.error('[FEMA Proxy] Error:', e);
    res.status(500).json({ ok: false, error: e.message || 'fema_proxy_failed' });
  }
});

// ==================== WATERWAY PROXY FOR FLOOD RISK MAP ====================
// GET /api/osm/waterways?lat=39.05&lng=-77.18&radius=5000
// Fetches rivers, streams, creeks, lakes, and oceans from OpenStreetMap
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];

app.get('/api/osm/waterways', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseInt(req.query.radius) || 5000; // meters (5km default)
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ ok: false, error: 'Invalid coordinates' });
    }
    
    // Create cache key
    const cacheKey = `waterways_${lat.toFixed(3)},${lng.toFixed(3)},${radius}`;
    const cached = osmCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < OSM_CACHE_TTL)) {
      console.log('[Waterway Proxy] Returning cached data for:', cacheKey);
      return res.json(cached.data);
    }
    
    console.log('[Waterway Proxy] Fetching waterways for:', { lat, lng, radius });
    
    // Keep the query lean — large around:* + relations often trip public Overpass mirrors.
    const overpassQuery = `
      [out:json][timeout:25];
      (
        way["waterway"~"river|stream|canal|drain|ditch"](around:${radius},${lat},${lng});
        way["natural"="water"](around:${Math.min(radius, 4000)},${lat},${lng});
      );
      out geom;
    `;

    let data = null;
    let lastError = null;

    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 28000);
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'HouseYieldFloodMap/1.0 (local-dev; contact=support@houseyield.com)',
            Accept: 'application/json',
          },
          body: `data=${encodeURIComponent(overpassQuery)}`,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
          lastError = `status_${response.status}`;
          console.warn('[Waterway Proxy] Overpass mirror failed:', endpoint, response.status);
          continue;
        }

        const payload = await response.json();
        if (payload?.error) {
          lastError = 'overpass_query_error';
          console.warn('[Waterway Proxy] Overpass query error from', endpoint, payload.error);
          continue;
        }

        data = payload;
        console.log('[Waterway Proxy] Success from', endpoint);
        break;
      } catch (mirrorError) {
        lastError = mirrorError?.message || 'mirror_failed';
        console.warn('[Waterway Proxy] Overpass mirror exception:', endpoint, lastError);
      }
    }

    if (!data) {
      console.error('[Waterway Proxy] All Overpass mirrors failed:', lastError);
      return res.status(502).json({ ok: false, error: 'overpass_api_error', details: lastError });
    }
    
    // Separate waterways by type
    const waterways = [];
    const lakes = [];
    const coastlines = [];
    
    (data.elements || []).forEach(element => {
      if (element.tags) {
        const waterwayType = element.tags.waterway;
        const naturalType = element.tags.natural;
        const name = element.tags.name || 'Unnamed';
        
        const item = {
          id: element.id,
          type: element.type,
          name,
          geometry: element.geometry || [],
          tags: element.tags
        };
        
        if (waterwayType === 'river' || waterwayType === 'stream' || waterwayType === 'canal' || waterwayType === 'drain' || waterwayType === 'ditch') {
          waterways.push({ ...item, waterwayType });
        } else if (naturalType === 'water') {
          lakes.push({ ...item, waterType: element.tags.water || 'lake' });
        } else if (naturalType === 'coastline') {
          coastlines.push(item);
        }
      }
    });
    
    const result = {
      ok: true,
      waterways,
      lakes,
      coastlines,
      count: {
        waterways: waterways.length,
        lakes: lakes.length,
        coastlines: coastlines.length,
        total: (data.elements || []).length
      }
    };
    
    // Cache the result
    osmCache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });
    
    console.log('[Waterway Proxy] Fetched:', result.count);
    res.json(result);
    
  } catch (e) {
    console.error('[Waterway Proxy] Error:', e);
    res.status(500).json({ ok: false, error: e.message || 'waterway_proxy_failed' });
  }
});

// ==================== POOLING ZONE DETECTION ====================
// GET /api/flood/pooling-zones?lat=39.05&lng=-77.18
// Analyzes micro-topography to detect depressions and flow accumulation zones
/*
 * On the flood budget rather than the generic analysis one. It hits the same
 * free terrain tiles as the depth grid, not the paid upstreams that 20-per-15
 * minutes was sized for, and sharing that small pool is what let a few minutes
 * on the environmental risk page blank the map for the next quarter hour.
 *
 * No cache peek here on purpose: this endpoint answers no-store by design, so
 * there is never a hit to serve.
 */
app.get('/api/flood/pooling-zones', floodAnalysisRateLimiter, async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ ok: false, error: 'invalid_coordinates' });
    }
    
    console.log('[Pooling API] Analyzing pooling zones for:', { lat, lng });
    
    // Disable caching for this endpoint
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Import pooling detection module
    const { analyzePoolingRisk } = await import('./pooling-detection.js');
    
    // Analyze property for pooling zones
    const result = await analyzePoolingRisk(lat, lng);
    
    res.json(result);
    
  } catch (e) {
    console.error('[Pooling API] Error:', e);
    res.status(500).json({ 
      ok: false, 
      error: e.message || 'pooling_analysis_failed',
      propertyRisk: { max: 0, average: 0, hasPoolingZones: false, zoneCount: 0 },
      poolingZones: []
    });
  }
});

// ==================== FLOOD DEPTH GRID ====================
// GET /api/flood/depth-grid?lat=39.05&lng=-77.18&livingSqft=2400
// Screening-level inundation depth raster plus return-period likelihood and
// FEMA depth-damage cost, from AWS terrain tiles + NOAA Atlas 14.
app.get(
  '/api/flood/depth-grid',
  serveCachedFlood(
    floodDepthArgs,
    async () => (await import('./services/floodDepthModel.js')).peekFloodDepth,
    FLOOD_DEPTH_CACHE_CONTROL,
  ),
  floodAnalysisRateLimiter,
  async (req, res) => {
    try {
      const args = floodDepthArgs(req);
      if (!args) {
        return res.status(400).json({ ok: false, error: 'invalid_coordinates' });
      }

      const { analyzeFloodDepth } = await import('./services/floodDepthModel.js');
      const result = await analyzeFloodDepth(args);

      // Terrain and precipitation curves are effectively static, so let the CDN
      // and browser hold onto this; the model itself caches for 12h.
      res.setHeader('Cache-Control', FLOOD_DEPTH_CACHE_CONTROL);
      res.json(result);
    } catch (e) {
      console.error('[Flood depth] Error:', e);
      res.status(502).json({ ok: false, error: e.message || 'flood_depth_failed' });
    }
  },
);

// ==================== FLOOD FORECAST TIMELINE ====================
// GET /api/flood/forecast-timeline?lat=&lng=&hours=24&surgeCategory=3
// One depth raster per hour for the next day, so the twin can play a storm
// through rather than only toggle between static design scenarios.
app.get(
  '/api/flood/forecast-timeline',
  serveCachedFlood(
    floodTimelineArgs,
    async () => (await import('./services/floodForecastTimeline.js')).peekFloodForecastTimeline,
    FLOOD_TIMELINE_CACHE_CONTROL,
  ),
  floodAnalysisRateLimiter,
  async (req, res) => {
    try {
      const args = floodTimelineArgs(req);
      if (!args) {
        return res.status(400).json({ ok: false, error: 'invalid_coordinates' });
      }

      const { buildFloodForecastTimeline } = await import('./services/floodForecastTimeline.js');
      const result = await buildFloodForecastTimeline(args);

      // Short, because unlike the static grid this genuinely expires — it is a
      // forecast, and it is keyed to the wall-clock hour inside the service.
      res.setHeader('Cache-Control', FLOOD_TIMELINE_CACHE_CONTROL);
      res.json(result);
    } catch (e) {
      console.error('[Flood forecast timeline] Error:', e);
      res.status(502).json({ ok: false, error: e.message || 'flood_forecast_failed' });
    }
  },
);

// ==================== OSM CACHE & OVERPASS PROXY FOR NOISE MAP ====================
// Shared cache for all OSM queries
const osmCache = new Map();
const OSM_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// GET /api/osm/roads?lat=39.05&lng=-77.18&radius=2000
// Proxies OpenStreetMap Overpass API to get road data for noise estimation
app.get('/api/osm/roads', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseInt(req.query.radius) || 2000; // meters
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ ok: false, error: 'Invalid coordinates' });
    }
    
    // Create cache key (round to 3 decimals to allow nearby requests to share cache)
    const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)},${radius}`;
    const cached = osmCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < OSM_CACHE_TTL)) {
      console.log('[OSM Proxy] Returning cached data for:', cacheKey);
      return res.json(cached.data);
    }
    
    console.log('[OSM Proxy] Fetching roads, railways, and aeroways for:', { lat, lng, radius });
    
    // Split into two queries to avoid timeout
    // Query 1: Roads and railway WAYS (lines, not just nodes)
    // Explicitly query ways and use '>; out geom;' to recurse and get geometry
    const overpassQuery1 = `
      [out:json][timeout:25];
      (
        way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|motorway_link|trunk_link|primary_link"](around:${radius},${lat},${lng});
        way["railway"~"rail|light_rail|subway|tram|narrow_gauge|preserved|disused"](around:${radius},${lat},${lng});
      );
      out geom;
    `;
    
    // Query 2: Aeroways and airports (larger radius for airports)
    const overpassQuery2 = `
      [out:json][timeout:15];
      (
        way["aeroway"~"runway|taxiway"](around:${radius},${lat},${lng});
        node["aeroway"="aerodrome"](around:10000,${lat},${lng});
        node["aeroway"="helipad"](around:${radius},${lat},${lng});
      );
      out geom;
    `;
    
    console.log('[OSM Proxy] Query 1 searches for railway WAYS (lines) only');
    console.log('[OSM Proxy] Full Query 1:', overpassQuery1);
    
    const overpassUrl1 = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery1)}`;
    const overpassUrl2 = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery2)}`;
    
    // Fetch both queries in parallel
    const [response1, response2] = await Promise.all([
      fetch(overpassUrl1).catch(e => ({ ok: false, error: e.message })),
      fetch(overpassUrl2).catch(e => ({ ok: false, error: e.message }))
    ]);
    
    let data1Elements = [];
    let data2Elements = [];
    
    if (response1.ok) {
      const data1 = await response1.json();
      data1Elements = data1.elements || [];
    } else {
      console.warn('[OSM Proxy] Query 1 failed:', response1.error || response1.status);
    }
    
    if (response2.ok) {
      const data2 = await response2.json();
      data2Elements = data2.elements || [];
    } else {
      console.warn('[OSM Proxy] Query 2 (aeroways) failed:', response2.error || response2.status);
    }
    
    // Combine results from both queries
    const allElements = [...data1Elements, ...data2Elements];
    
    // Separate elements by type
    const roads = [];
    const railways = [];
    const aeroways = [];
    const airports = [];
    const helipads = [];
    
    const railwayTypes = new Set();
    
    for (const element of allElements) {
      if (element.tags?.highway) {
        roads.push(element);
      } else if (element.tags?.railway) {
        railways.push(element);
        railwayTypes.add(element.tags.railway);
      } else if (element.tags?.aeroway === 'runway' || element.tags?.aeroway === 'taxiway') {
        aeroways.push(element);
      } else if (element.tags?.aeroway === 'aerodrome') {
        airports.push(element);
      } else if (element.tags?.aeroway === 'helipad') {
        helipads.push(element);
      }
    }
    
    console.log('[OSM Proxy] Found:', {
      roads: roads.length,
      railways: railways.length,
      aeroways: aeroways.length,
      airports: airports.length,
      helipads: helipads.length
    });
    
    if (railways.length > 0) {
      console.log('[OSM Proxy] Railway types found:', Array.from(railwayTypes));
      console.log('[OSM Proxy] Sample railway:', railways[0]?.tags);
      console.log('[OSM Proxy] Sample railway type:', railways[0]?.type);
      console.log('[OSM Proxy] Sample railway geometry:', railways[0]?.geometry ? `${railways[0].geometry.length} points` : 'NO GEOMETRY');
      console.log('[OSM Proxy] Sample railway nodes:', railways[0]?.nodes ? `${railways[0].nodes.length} node IDs` : 'NO NODES');
      
      // Count railways with actual geometry vs just nodes
      const railsWithGeom = railways.filter(r => r.geometry && r.geometry.length > 0).length;
      const railsWithoutGeom = railways.length - railsWithGeom;
      console.log('[OSM Proxy] Railways with geometry:', railsWithGeom, '| Railways without geometry:', railsWithoutGeom);
    }
    
    const responseData = { 
      ok: true, 
      roads,
      railways,
      aeroways,
      airports,
      helipads,
      lat,
      lng
    };
    
    // Cache the result
    osmCache.set(cacheKey, {
      data: responseData,
      timestamp: Date.now()
    });
    console.log('[OSM Proxy] Data cached with key:', cacheKey);
    
    res.json(responseData);
  } catch (e) {
    console.error('[OSM Proxy] Error:', e);
    res.status(500).json({ ok: false, error: e.message || 'osm_proxy_failed' });
  }
});

// ==================== FLIGHT TRACKING FOR NOISE MAP ====================
// GET /api/flights?lat=39.05&lng=-77.18&radius=10&maxAltitude=8000
// Returns nearby low-flying aircraft that contribute to noise pollution
// Uses OpenSky Network API (free, no API key required)
// Aircraft above maxAltitude (default 8000 ft) are filtered out as they're too high to hear
app.get('/api/flights', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusKm = parseFloat(req.query.radius) || 10; // Default 10km radius
    const maxAltitudeFt = parseInt(req.query.maxAltitude) || 8000; // Default 8000 ft max altitude
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ ok: false, error: 'Invalid coordinates' });
    }
    
    console.log('[Flight API] Fetching aircraft near:', { lat, lng, radiusKm, maxAltitudeFt });
    
    const result = await getNearbyAircraft(lat, lng, radiusKm, maxAltitudeFt);
    
    console.log('[Flight API] Result:', {
      ok: result.ok,
      count: result.count,
      error: result.error
    });
    
    res.json(result);
  } catch (e) {
    console.error('[Flight API] Error:', e);
    res.status(500).json({ 
      ok: false, 
      error: e.message || 'flight_tracking_failed',
      aircraft: [],
      count: 0
    });
  }
});

// ==================== PARCEL MAP ENDPOINT ====================
// GET /api/parcel-map?address=123+Main+St+City+ST+00000
// Returns parcel geometry, boundary, and map configuration
app.get('/api/parcel-map', async (req, res) => {
  try {
    const parcelMapModule = await import('./parcel-map.js');
    
    const address = (req.query.address || '').toString().trim();
    const attomId = (req.query.id || '').toString().trim() || undefined;
    
    if (!address && !attomId) {
      return res.status(400).json({ ok: false, error: 'missing_address_or_id' });
    }

    console.log('[Parcel Map] Fetching for:', address || attomId);

    // Fetch parcel geometry from ATTOM
    const parcelData = await parcelMapModule.getParcelGeometry(address, attomId);

    if (!parcelData.ok) {
      return res.status(404).json(parcelData);
    }

    // Generate map configuration for frontend
    const mapConfig = parcelMapModule.generateMapConfig(parcelData);

    // Generate static map URL if Mapbox token is configured
    const staticMapURL = parcelMapModule.generateStaticMapURL(
      parcelData.center,
      parcelData.boundary,
      {
        width: 800,
        height: 600,
        zoom: 18,
        style: 'satellite-streets-v12'
      }
    );

    res.json({
      ok: true,
      parcel: parcelData.parcel,
      center: parcelData.center,
      boundary: parcelData.boundary,
      mapConfig,
      staticMapURL,
      zoning: parcelData.zoning,
      subdivisionName: parcelData.subdivisionName
    });

  } catch (error) {
    console.error('[Parcel Map] Error:', error);
    res.status(500).json({ ok: false, error: error.message || 'parcel_map_failed' });
  }
});

// ==================== ATTOM TILE PROXY ENDPOINT ====================
// GET /api/attom/tile/:z/:x/:y
// Proxies ATTOM parcel tile requests to hide API key from browser
app.get('/api/attom/tile/:z/:x/:y', async (req, res) => {
  try {
    const { z, x, y } = req.params;
    const zoom = parseInt(z);
    const tileX = parseInt(x);
    const tileY = parseInt(y);

    // Set CORS headers to allow image loading from browser
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    // Validate zoom level (ATTOM supports 14-18)
    if (zoom < 14 || zoom > 18) {
      return res.status(204).send(); // No content - outside supported range
    }

    const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
    if (!ATTOM_API_KEY) {
      console.error('[ATTOM Tile] API key not configured');
      return res.status(500).send('ATTOM API key not configured');
    }

    // Fetch tile from ATTOM
    const tileUrl = `https://api.gateway.attomdata.com/parceltiles/${zoom}/${tileX}/${tileY}.png?apikey=${ATTOM_API_KEY}`;
    
    const tileResponse = await fetchAttom(tileUrl);

    if (!tileResponse.ok) {
      if (tileResponse.status === 204) {
        return res.status(204).send(); // No tile at this location
      }
      return res.status(tileResponse.status).send();
    }

    // Forward the tile image with CORS headers
    const tileBuffer = await tileResponse.arrayBuffer();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.send(Buffer.from(tileBuffer));

  } catch (error) {
    console.error('[ATTOM Tile] Error:', error);
    res.status(500).send('Failed to fetch tile');
  }
});

// ==================== LIVE PRODUCT SEARCH ENDPOINTS ====================
// Search for renovation products with live pricing from major retailers

// GET /api/products/search - Search for products by type
app.get('/api/products/search', async (req, res) => {
  try {
    const { productType, query, quality, zipCode, limit } = req.query;
    
    if (!productType && !query) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Either productType or query is required',
        availableTypes: Object.keys((await import('./product-search.js')).PRODUCT_CATEGORIES)
      });
    }
    
    const productSearch = await import('./product-search.js');
    const result = await productSearch.searchProducts({
      productType: productType || 'general',
      query: query,
      qualityLevel: quality || 'midRange',
      zipCode: zipCode,
      limit: parseInt(limit) || 10
    });
    
    res.json(result);
  } catch (error) {
    console.error('[Product Search] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/products/recommendations - Get product recommendations for a project
app.get('/api/products/recommendations', async (req, res) => {
  try {
    const { projectType, quality, zipCode, room } = req.query;
    
    if (!projectType) {
      return res.status(400).json({ 
        ok: false, 
        error: 'projectType is required',
        availableProjects: [
          'bathroom_full_remodel', 'bathroom_vanity_replace', 'bathroom_refresh',
          'kitchen_full_remodel', 'kitchen_countertop_replace', 'kitchen_cabinet_replace',
          'flooring_hardwood', 'flooring_lvp', 'flooring_tile',
          'hvac_update', 'lighting_update'
        ]
      });
    }
    
    const productSearch = await import('./product-search.js');
    const result = await productSearch.getProductRecommendations({
      projectType,
      qualityLevel: quality || 'midRange',
      zipCode: zipCode,
      room: room
    });
    
    res.json(result);
  } catch (error) {
    console.error('[Product Recommendations] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/products/compare - Compare prices across retailers
app.get('/api/products/compare', async (req, res) => {
  try {
    const { productName, productType, zipCode } = req.query;
    
    if (!productName) {
      return res.status(400).json({ ok: false, error: 'productName is required' });
    }
    
    const productSearch = await import('./product-search.js');
    const result = await productSearch.compareProductPrices({
      productName,
      productType: productType || 'general',
      zipCode: zipCode
    });
    
    res.json(result);
  } catch (error) {
    console.error('[Price Compare] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/products/categories - Get all available product categories
app.get('/api/products/categories', async (req, res) => {
  try {
    const productSearch = await import('./product-search.js');
    const categories = Object.entries(productSearch.PRODUCT_CATEGORIES).map(([key, value]) => ({
      key,
      keywords: value.keywords,
      specs: value.specs,
      priceRanges: value.priceRange,
      unit: value.unit || 'each'
    }));
    
    res.json({
      ok: true,
      categories,
      retailers: productSearch.PRIORITY_RETAILERS.map(r => ({
        name: r.name,
        domain: r.domain,
        hasLocalStores: !!r.storeLocator
      }))
    });
  } catch (error) {
    console.error('[Product Categories] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/products/stores - Get store locator links for a ZIP code
app.get('/api/products/stores', async (req, res) => {
  try {
    const { zipCode } = req.query;
    
    if (!zipCode) {
      return res.status(400).json({ ok: false, error: 'zipCode is required' });
    }
    
    const productSearch = await import('./product-search.js');
    const storeLinks = productSearch.PRIORITY_RETAILERS
      .filter(r => r.storeLocator)
      .map(r => ({
        retailer: r.name,
        domain: r.domain,
        storeLocatorUrl: `${r.storeLocator}?zipCode=${zipCode}`,
        directUrl: `https://${r.domain}`
      }));
    
    res.json({
      ok: true,
      zipCode,
      stores: storeLinks
    });
  } catch (error) {
    console.error('[Store Locator] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

console.log('✅ [Product Search] Live product search endpoints mounted at /api/products/*');

// GET /api/analyze-renovations/status
// Returns live status of the last/current renovation analysis run.
app.get('/api/analyze-renovations/status', (_req, res) => {
  res.json({ ok: true, status: renovationAnalysisMonitor });
});

// GET /api/analyze-renovations/attom-cache-debug?address=...&attomId=...&invalidateFirst=1
// Proves renovation ATTOM market-data behavior with at most one live ATTOM call.
app.get('/api/analyze-renovations/attom-cache-debug', async (req, res) => {
  try {
    const address = (req.query.address || '').toString().trim();
    const attomId = (req.query.attomId || req.query.id || '').toString().trim();
    const invalidateFirst = ['1', 'true', 'yes'].includes(String(req.query.invalidateFirst || '').toLowerCase());

    if (!address && !attomId) {
      return res.status(400).json({ ok: false, error: 'missing_address_or_attomId' });
    }

    const marketDataModule = await import('./renovation-market-data.js');
    const summarizeRecord = (record, keySource) => ({
      hit: Boolean(record),
      usable: isUsableAttomDashboardData(record?.data),
      keySource,
      ageDays: record?.ageDays ?? null,
      stale: record?.stale ?? null,
    });

    const beforeAddress = address ? await getCachedAttomData(address) : null;
    const beforeAttomId = attomId ? await getCachedAttomDataById(attomId) : null;

    if (invalidateFirst) {
      await invalidateAttomCache(address || beforeAddress?.data?.summary?.address || '', attomId || beforeAddress?.data?.summary?.attom_id || null);
    }

    const lookup = { address, attomId };
    const firstRun = await marketDataModule.getLocalMarketData(lookup, { skipCacheRead: false });
    const secondRun = await marketDataModule.getLocalMarketData(lookup, { skipCacheRead: false });

    const firstSource = firstRun?.diagnostics?.source || null;
    const secondSource = secondRun?.diagnostics?.source || null;
    const missThenHitProved = firstSource === 'live_attom'
      && (secondSource === 'address_cache' || secondSource === 'attom_id_cache');

    res.json({
      ok: true,
      request: {
        address: address || null,
        attomId: attomId || null,
        invalidateFirst,
      },
      beforeCache: {
        address: summarizeRecord(beforeAddress, 'address'),
        attomId: summarizeRecord(beforeAttomId, 'attomId'),
      },
      firstRun: {
        ok: firstRun.ok,
        error: firstRun.error || null,
        source: firstSource,
        diagnostics: firstRun.diagnostics || null,
      },
      secondRun: {
        ok: secondRun.ok,
        error: secondRun.error || null,
        source: secondSource,
        diagnostics: secondRun.diagnostics || null,
      },
      proof: {
        missThenHitProved,
        liveAttomCallsUsed: [firstRun, secondRun].filter(run => run?.diagnostics?.liveFetch?.attempted && run?.diagnostics?.liveFetch?.succeeded).length,
      },
    });
  } catch (error) {
    console.error('[AI Renovation] ATTOM cache debug failed:', error.message);
    res.status(500).json({ ok: false, error: error.message || 'attom_cache_debug_failed' });
  }
});

// GET /api/debug/attom-usage
// Returns the current month's ATTOM usage snapshot from the limiter backend.
app.get('/api/debug/attom-usage', async (_req, res) => {
  try {
    const usage = await getAttomUsageSnapshot();
    res.json({
      ok: true,
      apiKeyConfigured: Boolean(process.env.ATTOM_API_KEY),
      usage,
    });
  } catch (error) {
    console.error('[ATTOM Usage] Debug endpoint failed:', error.message);
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || 'attom_usage_status_failed',
      code: error.code || null,
    });
  }
});

const normalizeRenovationKnownSceneAnchors = (sceneAnchors = []) => {
  if (!Array.isArray(sceneAnchors)) return [];

  return sceneAnchors
    .slice(0, 8)
    .map((anchor, index) => {
      const targetType = typeof anchor?.targetType === 'string' ? anchor.targetType.trim() : '';
      const label = typeof anchor?.label === 'string' ? anchor.label.trim() : '';
      const width = Number(anchor?.width);
      const height = Number(anchor?.height);
      const scaleDimensions = [];

      if (Number.isFinite(width) && width > 0) scaleDimensions.push('width');
      if (Number.isFinite(height) && height > 0) scaleDimensions.push('height');

      if (!targetType || scaleDimensions.length === 0) return null;

      return {
        id: typeof anchor?.id === 'string' && anchor.id.trim()
          ? anchor.id.trim()
          : `renovation_known_scene_anchor_${index + 1}`,
        targetType,
        label: label || targetType.replace(/_/g, ' '),
        width: Number.isFinite(width) && width > 0 ? width : undefined,
        height: Number.isFinite(height) && height > 0 ? height : undefined,
        scaleDimensions,
        anchorQuality: anchor?.anchorQuality === 'medium' ? 'medium' : 'high',
        standardSizeConfidence: 0.99,
        confidence: 0.99,
      };
    })
    .filter(Boolean);
};

// ==================== AI RENOVATION ANALYSIS ENDPOINT ====================
// POST /api/analyze-renovations
// Body: { images: string[] (base64), propertyData: {...} }
// Returns: { ok: true, suggestions: [...] }
app.post('/api/analyze-renovations', async (req, res) => {
  try {
    const { images, propertyData, knownSceneAnchors: rawKnownSceneAnchors } = req.body;
    const knownSceneAnchors = normalizeRenovationKnownSceneAnchors(rawKnownSceneAnchors);
    updateRenovationAnalysisMonitor({
      running: true,
      stage: 'validating_input',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      address: propertyData?.address || null,
      imageCount: Array.isArray(images) ? images.length : 0,
      analyzedCount: 0,
      suggestionCount: 0,
      positiveRoiCount: 0,
      fallbackSuggestionsUsed: false,
      marketDataSource: null,
      marketDataDiagnostics: null,
      lastError: null,
    });
    
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ ok: false, error: 'No images provided' });
    }

    if (!OPENAI_API_KEY) {
      updateRenovationAnalysisMonitor({
        running: false,
        stage: 'failed',
        finishedAt: new Date().toISOString(),
        lastError: 'OpenAI API key not configured',
      });
      return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
    }

    const MAX_VISION_IMAGES = 20;
    const imagesForAnalysis = images.slice(0, MAX_VISION_IMAGES);
    const droppedImageCount = Math.max(0, images.length - imagesForAnalysis.length);
    const visionDetail = imagesForAnalysis.length > 12 ? 'low' : 'high';

    if (droppedImageCount > 0) {
      console.warn(`[AI Renovation] Trimming image set from ${images.length} to ${imagesForAnalysis.length} for vision analysis`);
    }

    updateRenovationAnalysisMonitor({
      stage: 'loading_market_data',
      analyzedCount: imagesForAnalysis.length,
    });

    console.log('[AI Renovation] Analyzing', imagesForAnalysis.length, 'images for property:', propertyData?.address || 'unknown');

    // STEP 1: Get local market data from ATTOM
    console.log('[AI Renovation] Fetching market data from ATTOM...');
    const marketDataModule = await import('./renovation-market-data.js');
    const marketData = await marketDataModule.getLocalMarketData(propertyData || '');

    updateRenovationAnalysisMonitor({
      marketDataSource: marketData?.diagnostics?.source || (marketData.ok ? 'unknown' : 'unavailable'),
      marketDataDiagnostics: marketData?.diagnostics || null,
    });
    
    if (!marketData.ok) {
      console.warn('[AI Renovation] Market data unavailable, using provided data');
    }

    const zipCodeForContext = (marketData.ok ? marketData.zipCode : '') || extractZipCode(propertyData?.address || '');
    const [rentcastResult, macroResult] = await Promise.allSettled([
      zipCodeForContext ? getZipMarketData(zipCodeForContext) : Promise.resolve(null),
      getAdditionalMacroData(),
    ]);

    const rentcastData = rentcastResult.status === 'fulfilled' ? rentcastResult.value : null;
    const macroData = macroResult.status === 'fulfilled' ? macroResult.value : null;

    const rentcastRental = rentcastData?.rentalData || null;
    const rentcastSale = rentcastData?.saleData || null;
    const rentcastBedroomMatch = (rentcastRental?.byBedrooms || []).find(b => b.bedrooms === (marketData.beds || propertyData?.bedrooms || null));
    const rentcastMarketRent = rentcastBedroomMatch?.median || rentcastRental?.median || rentcastData?.derived?.medianAskingRent || 0;
    const rentcastMarketSale = rentcastSale?.median || rentcastData?.derived?.medianSalePrice || 0;
    let regionalAreaSummary = null;
    let regionalRentalSummary = null;

    if (zipCodeForContext) {
      try {
        const processorModule = await import('./renovation/processor.js');
        regionalAreaSummary = await processorModule.getAreaSummary(zipCodeForContext, {
          maxAge: 7 * 24 * 60 * 60 * 1000,
          processIfMissing: false,
        });
        regionalRentalSummary = await processorModule.getRentalSummary(zipCodeForContext);
      } catch (regionalError) {
        console.warn('[AI Renovation] Regional uplift summary unavailable:', regionalError.message);
      }
    }

    if (rentcastResult.status === 'rejected') {
      console.warn('[AI Renovation] RentCast context unavailable:', rentcastResult.reason?.message || rentcastResult.reason);
    }
    if (macroResult.status === 'rejected') {
      console.warn('[AI Renovation] Macro context unavailable:', macroResult.reason?.message || macroResult.reason);
    }

    const renovationMeasurementVmClient = await import('./services/renovationMeasurementVmClient.js');
    let localMeasurementModule = null;
    const getLocalMeasurementModule = async () => {
      if (!localMeasurementModule) {
        localMeasurementModule = await import('./services/photoMeasurementService.js');
      }
      return localMeasurementModule;
    };

    let normalizedVisionImages = [];
    if (renovationMeasurementVmClient.isRenovationMeasurementVmEnabled()) {
      try {
        const normalizedResponse = await renovationMeasurementVmClient.normalizeVisionImagesViaRenovationMeasurementVm(imagesForAnalysis);
        normalizedVisionImages = Array.isArray(normalizedResponse?.images) ? normalizedResponse.images : [];
        if (!normalizedVisionImages.length) {
          throw new Error('Renovation measurement VM returned no normalized images');
        }
      } catch (remoteNormalizeError) {
        console.warn('[AI Renovation] Renovation measurement VM image normalization failed, falling back locally:', remoteNormalizeError.message);
        const measurementModule = await getLocalMeasurementModule();
        normalizedVisionImages = await measurementModule.normalizeVisionModelImages(imagesForAnalysis);
      }
    } else {
      const measurementModule = await getLocalMeasurementModule();
      normalizedVisionImages = await measurementModule.normalizeVisionModelImages(imagesForAnalysis);
    }
    const convertedVisionImageCount = normalizedVisionImages.filter(image => image.converted).length;

    if (convertedVisionImageCount > 0) {
      console.log(`[AI Renovation] Converted ${convertedVisionImageCount} HEIC/HEIF image(s) to JPEG for OpenAI vision`);
    }

    // Prepare images for OpenAI Vision API
    const imageMessages = normalizedVisionImages.map(image => ({
      type: 'image_url',
      image_url: {
        url: image.modelInput, // normalized URL/data URL for OpenAI-compatible vision input
        detail: visionDetail // High detail for smaller sets, low detail for larger sets
      }
    }));

    // Use market data if available, otherwise fall back to provided data
    const effectivePropertyValue = marketData.ok ? marketData.propertyValue : (propertyData?.propertyValue || 0);
    const attomRent = marketData.ok ? marketData.estimatedRent : (propertyData?.monthlyRent || 0);
    const effectiveRent = attomRent || rentcastMarketRent || 0;
    const marketContext = marketData.ok ? `

Local Market Context (ATTOM Data):
- Property Value (AVM): $${effectivePropertyValue.toLocaleString()}
- Estimated Market Rent: $${effectiveRent.toLocaleString()}/month
- Market Appreciation Rate: ${(marketData.marketAppreciationRate * 100).toFixed(2)}% annually
- Property Age: ${new Date().getFullYear() - (marketData.yearBuilt || propertyData?.yearBuilt || 2000)} years
- Neighborhood: ${marketData.neighborhood || 'N/A'}` : '';
    const rentcastContext = rentcastData ? `

  ZIP Rental Market Context (RentCast):
  - ZIP Code: ${zipCodeForContext}
  - Median Asking Rent: $${Math.round(rentcastMarketRent || 0).toLocaleString()}/month
  - Median Sale Price: $${Math.round(rentcastMarketSale || 0).toLocaleString()}
  - Gross Yield: ${rentcastData.derived?.grossYieldPct ?? 'N/A'}%
  - Price-to-Rent Ratio: ${rentcastData.derived?.priceToRentRatio ?? 'N/A'}
  - Rental Days on Market: ${rentcastRental?.medianDaysOnMarket ?? 'N/A'} days
  - Rental Listings: ${rentcastRental?.totalListings ?? rentcastData.derived?.rentalListings ?? 'N/A'}` : '';
    const macroContext = macroData ? `

  Macroeconomic Context (FRED):
  - 15-Year Mortgage Rate: ${macroData.mortgage15?.value ?? 'N/A'}%
  - Rental Vacancy Rate: ${macroData.rentalVacancy?.value ?? 'N/A'}%
  - Consumer Sentiment: ${macroData.consumerSentiment?.value ?? 'N/A'}
  - Construction Cost YoY: ${macroData.constructionPPI?.yoy ?? 'N/A'}%
  - Initial Jobless Claims: ${macroData.joblessClaims?.value ?? 'N/A'}` : '';

    updateRenovationAnalysisMonitor({ stage: 'calling_openai_vision' });

    // Create a comprehensive prompt for renovation analysis
    const prompt = `You are an expert real estate investment consultant analyzing property images to identify renovation opportunities with POSITIVE ROI for RENTAL PROPERTIES.

Property Details:
- Address: ${propertyData?.address || 'N/A'}
- Location: ${propertyData?.location || marketData.location || 'N/A'}
- Current Monthly Rent: $${effectiveRent.toLocaleString()}
- Property Value: $${effectivePropertyValue.toLocaleString()}
- Bedrooms: ${marketData.beds || propertyData?.bedrooms || 'N/A'}
- Bathrooms: ${marketData.baths || propertyData?.bathrooms || 'N/A'}
- Square Feet: ${marketData.sqft || propertyData?.squareFeet || 'N/A'}
- Year Built: ${marketData.yearBuilt || propertyData?.yearBuilt || 'N/A'}${marketContext}${rentcastContext}${macroContext}

CRITICAL INSTRUCTIONS FOR INVESTMENT ANALYSIS:
1. This is an INVESTMENT PROPERTY - focus on ROI and rent increase potential
2. Typical renovation value-add: Major kitchen 50-80%, Full bathroom 40-60%, Paint/cosmetic 20-30%, Flooring 35%, Landscaping 40%
3. Suggest BOTH major renovations AND cost-effective cosmetic updates if they add value
4. Consider: Property age, current condition, market standards, tenant appeal
5. Look for: Outdated features, damage/wear, missing amenities, curb appeal issues
6. Be realistic about scope - suggest what makes sense based on images

TASK: Identify 3-7 renovation opportunities that will increase property value or rental income.

For each renovation opportunity:
1. **name**: Specific renovation name (e.g., "Bathroom Tile and Fixture Upgrade")
2. **type**: Category keyword (kitchen, bathroom, flooring, paint, hvac, roof, windows, landscaping, tile, cabinets, countertops, appliances)
3. **summary**: Brief overview of the renovation and expected ROI/rent impact
4. **details**: Complete scope based on what you see in the images - materials, work needed, current issues
5. **estimatedCost**: Realistic cost estimate for this specific renovation
6. **preRenovationCondition**: "distressed" | "dated" | "average" | "good" | "excellent"
7. **scope**: "cosmetic" | "refresh" | "full_remodel" | "gut_reno"
8. **qualityLevel**: "budget" | "mid-range" | "luxury"
9. **marketFit**: "poor" | "neutral" | "good" | "excellent"
10. **priority**: "critical" (safety/prevents loss) | "high" (excellent ROI) | "medium" (good ROI)
11. **timeframe**: Realistic completion time

Return ONLY valid JSON array (no markdown, no code blocks):
[
  {
    "name": "Bathroom Tile and Fixture Upgrade",
    "type": "bathroom",
    "summary": "Modernize dated bathroom with new tile, vanity, and fixtures - adds $150/mo rent value",
    "details": "Images show 1990s beige tile and builder-grade fixtures. Install contemporary subway tile surround, new vanity with quartz top, updated faucets and lighting. Will appeal to quality tenants.",
    "estimatedCost": 4500,
    "preRenovationCondition": "dated",
    "scope": "refresh",
    "qualityLevel": "mid-range",
    "marketFit": "good",
    "priority": "high",
    "timeframe": "1-2 weeks"
  }
]

Analyze the images now and provide renovation recommendations.`;

    // STEP 2: Get AI vision analysis

    // Call OpenAI GPT-4 Vision API
    let response;
    try {
      response = await nodeFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o', // Using GPT-4o with vision
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                ...imageMessages
              ]
            }
          ],
          max_tokens: 2000,
          temperature: 0.7
        })
      });
    } catch (openAiFetchError) {
      console.error('[AI Renovation] OpenAI fetch failed:', openAiFetchError);
      const fetchCause = openAiFetchError?.cause?.message ? `: ${openAiFetchError.cause.message}` : '';
      throw new Error(`OpenAI request failed${fetchCause}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI Renovation] OpenAI API error:', errorText);
      throw new Error(`OpenAI API failed: ${response.status} ${response.statusText}`);
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('No response from AI');
    }

    console.log('[AI Renovation] Raw AI response:', content.substring(0, 200) + '...');

    // Parse the JSON response
    let suggestions;
    try {
      // Remove markdown code blocks and any text before/after the JSON array
      let cleanContent = content;
      
      // Find JSON array in the content
      const jsonMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        cleanContent = jsonMatch[0];
      } else {
        // Fallback: remove markdown code blocks
        cleanContent = content
          .replace(/```json\s*/g, '')
          .replace(/```\s*/g, '')
          .trim();
      }
      
      suggestions = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error('[AI Renovation] Failed to parse AI response:', parseError);
      console.error('[AI Renovation] Content was:', content);
      throw new Error('Failed to parse AI response. Please try again.');
    }

    // ========================================================================
    // STEP 2.5: Photo Measurements via DAv3-Metric + Reference Calibration
    // Runs depth estimation on all photos in one batch call, detects reference
    // objects for scale calibration, extracts room dimensions and object sizes,
    // and generates comprehensive material + labor breakdowns from measurements.
    // ========================================================================
    let photoMeasurements = null;
    let buildMeasuredMaterials = null;
    let buildMeasuredLabor = null;
    try {
      updateRenovationAnalysisMonitor({ stage: 'processing_measurements' });
      buildMeasuredMaterials = calculateMaterialQuantities;
      buildMeasuredLabor = calculateLaborItems;

      const measurementOptions = {
        totalPropertySqFt: marketData.sqft || propertyData?.squareFeet || null,
        measurementMode: 'hybrid',
        roomDimensionSource: 'gpt_vision',
        depthModelVersion: 'v2',
        knownSceneAnchors,
      };

      if (renovationMeasurementVmClient.isRenovationMeasurementVmEnabled()) {
        console.log('[AI Renovation] Step 2.5: Running photo measurements on dedicated renovation measurement VM...');
        try {
          photoMeasurements = await renovationMeasurementVmClient.measureFromPhotosViaRenovationMeasurementVm(imagesForAnalysis, measurementOptions);
        } catch (remoteMeasurementError) {
          console.warn('[AI Renovation] Renovation measurement VM failed, falling back to local measurement:', remoteMeasurementError.message);
          const { measureFromPhotos: measureFromPhotosLocal } = await getLocalMeasurementModule();
          photoMeasurements = await measureFromPhotosLocal(imagesForAnalysis, measurementOptions);
        }
      } else {
        console.log('[AI Renovation] Step 2.5: Running DAv3-Metric photo measurements locally...');
        const { measureFromPhotos: measureFromPhotosLocal } = await getLocalMeasurementModule();
        photoMeasurements = await measureFromPhotosLocal(imagesForAnalysis, measurementOptions);
      }

      if (photoMeasurements.ok) {
        console.log(`[AI Renovation] ✓ Measurements complete: ${photoMeasurements.rooms.length} rooms, ${photoMeasurements.objects.length} objects in ${photoMeasurements.processingTime}ms`);
        for (const room of photoMeasurements.rooms) {
          console.log(`[AI Renovation]   ${room.roomType}: ${room.dimensions.widthFt}'×${room.dimensions.lengthFt}' (${room.dimensions.floorAreaSqFt} sq ft) [${room.confidence}]`);
        }
        for (const obj of photoMeasurements.objects) {
          console.log(`[AI Renovation]   ${obj.type}: ${obj.dimensions?.widthInches}"W × ${obj.dimensions?.heightInches}"H [${obj.confidence}]`);
        }
      } else {
        console.warn('[AI Renovation] ⚠ Photo measurements failed:', photoMeasurements.error, '— proceeding without measurements');
      }
    } catch (measureError) {
      console.warn('[AI Renovation] ⚠ Photo measurement service error (non-fatal):', measureError.message);
    }

    // Helper: match a renovation suggestion to its measured room
    // NOW WITH: (1) material/labor filtering by renovation type (prevents duplicate
    //           materials across flooring/tile/paint suggestions for same room)
    //           (2) whole-house aggregation for paint/flooring across all rooms
    const normalizeSuggestionType = (suggestion) => {
      const type = String(suggestion?.type || '').toLowerCase();
      const name = String(suggestion?.name || '').toLowerCase();
      const summary = String(suggestion?.summary || '').toLowerCase();
      const details = String(suggestion?.details || '').toLowerCase();
      const text = `${type} ${name} ${summary} ${details}`;

      if (text.includes('basement') && text.includes('ceiling')) return 'basement ceiling';
      if (text.includes('ceiling') && text.includes('light')) return 'ceiling lighting';
      if (text.includes('ceiling')) return 'ceiling';
  if (text.includes('vanity')) return 'vanity';
  if (text.includes('mirror')) return 'mirror';
  if (text.includes('toilet')) return 'toilet';
  if (text.includes('countertop') || text.includes('counter top')) return text.includes('bathroom') ? 'bathroom countertop' : 'countertop';
  if (text.includes('cabinet')) return text.includes('kitchen') ? 'kitchen cabinet' : 'cabinet';
  if (text.includes('faucet')) return text.includes('kitchen') ? 'kitchen faucet' : 'faucet';
  if (text.includes('sink')) return text.includes('kitchen') ? 'kitchen sink' : 'sink';
  if (text.includes('shower')) return 'shower';
  if (text.includes('bathtub') || text.includes('tub')) return 'bathtub';
  if (text.includes('exhaust')) return 'bathroom exhaust';
      if (text.includes('hardwood') && (text.includes('refinish') || text.includes('refinishing'))) return 'hardwood flooring';
      if (text.includes('floor') || text.includes('lvp') || text.includes('vinyl plank') || text.includes('carpet')) return 'flooring';
      if (text.includes('paint')) return text.includes('exterior') ? 'paint exterior' : 'paint interior';
      if (text.includes('bathroom')) return text.includes('tile') ? 'bathroom tile' : 'bathroom';
      if (text.includes('kitchen')) return 'kitchen';
      if (text.includes('window')) return 'windows';
      if (text.includes('roof')) return 'roof';
      if (text.includes('siding')) return 'siding';
      if (text.includes('deck') || text.includes('patio')) return 'deck patio';
      if (text.includes('landscap') || text.includes('yard') || text.includes('curb appeal')) return 'landscaping';
      if (text.includes('hvac') || text.includes('furnace') || text.includes('air conditioning')) return 'hvac';
      if (text.includes('light') || text.includes('electrical')) return 'lighting';
      return type || name || 'general';
    };

    const getSuggestedRoomHints = (suggestion) => {
      const text = `${String(suggestion?.type || '')} ${String(suggestion?.name || '')} ${String(suggestion?.summary || '')} ${String(suggestion?.details || '')}`.toLowerCase();
      const hints = new Set();
      const keywordMap = {
        basement: 'basement',
        kitchen: 'kitchen',
        bathroom: 'bathroom',
        bedroom: 'bedroom',
        living: 'living_room',
        dining: 'dining_room',
        hallway: 'hallway',
        foyer: 'foyer',
        laundry: 'laundry',
        utility: 'utility',
        office: 'office',
        exterior: 'exterior',
        garage: 'garage',
      };

      for (const [keyword, roomType] of Object.entries(keywordMap)) {
        if (text.includes(keyword)) hints.add(roomType);
      }

      return [...hints];
    };

    const normalizeRegionalType = (value = '') => value.toLowerCase().replace(/[_\s-]+/g, ' ').trim();

    const mapSuggestionToRegionalCandidates = (suggestion) => {
      const normalizedType = normalizeSuggestionType(suggestion);
      const text = normalizeRegionalType(`${normalizedType} ${suggestion?.name || ''} ${suggestion?.summary || ''}`);
      const candidates = new Set();

      const push = (...values) => values.filter(Boolean).forEach(v => candidates.add(normalizeRegionalType(v)));

      if (text.includes('kitchen')) push('kitchen', 'kitchen full', 'kitchen cosmetic');
      if (text.includes('bathroom')) push('bathroom master', 'bathroom secondary', 'bathroom full', 'bathroom cosmetic');
      if (text.includes('floor') || text.includes('hardwood') || text.includes('tile') || text.includes('carpet')) push('flooring');
      if (text.includes('paint') && text.includes('exterior')) push('paint exterior');
      if (text.includes('paint')) push('paint interior');
      if (text.includes('window')) push('windows');
      if (text.includes('roof')) push('roof');
      if (text.includes('siding')) push('siding');
      if (text.includes('landscap') || text.includes('yard')) push('landscaping');
      if (text.includes('deck') || text.includes('patio')) push('deck patio');
      if (text.includes('hvac') || text.includes('furnace') || text.includes('air conditioning')) push('hvac');
      if (text.includes('door')) push('doors');
      if (text.includes('basement')) push('basement');

      push(normalizedType);
      return [...candidates];
    };

    const findRegionalMatchForSuggestion = (suggestion) => {
      const bestRoiRenovations = regionalAreaSummary?.bestROIRenovations || [];
      if (!bestRoiRenovations.length) return null;

      const candidates = mapSuggestionToRegionalCandidates(suggestion);
      return bestRoiRenovations.find((entry) => {
        const regionalType = normalizeRegionalType(entry?.renovationType || '');
        return candidates.some(candidate => regionalType === candidate || regionalType.includes(candidate) || candidate.includes(regionalType));
      }) || null;
    };

    const getRegionalRentMetrics = (regionalType) => {
      const rentalByType = regionalRentalSummary?.byRenovationType || regionalAreaSummary?.rentalAnalysis?.byRenovationType || {};
      if (!regionalType || !rentalByType) return null;

      const normalizedTarget = normalizeRegionalType(regionalType);
      return Object.entries(rentalByType).find(([key]) => normalizeRegionalType(key) === normalizedTarget)?.[1]
        || Object.entries(rentalByType).find(([key]) => {
          const normalizedKey = normalizeRegionalType(key);
          return normalizedKey.includes(normalizedTarget) || normalizedTarget.includes(normalizedKey);
        })?.[1]
        || null;
    };

    function isMeasurementTrustedForPricing(measurements) {
      return Boolean(measurements?.trustedForPricing || measurements?.measurementTrust?.trustedForPricing);
    }

    function getRoomTrust(room) {
      return room?.measurementTrust || {
        trustedForPricing: Boolean(room?.trustedForPricing),
        reasons: room?.trustedForPricing ? [] : ['measurement_not_trusted'],
      };
    }

    function getMeasurementsForSuggestion(suggestion) {
      if (!photoMeasurements?.ok || !photoMeasurements.rooms?.length) return null;

      const measurementType = normalizeSuggestionType(suggestion);
      const roomHints = getSuggestedRoomHints(suggestion);

      const typeToRoom = {
        'kitchen': ['kitchen'],
        'kitchen_update': ['kitchen'],
        'kitchen_refresh': ['kitchen'],
        'kitchen cabinet': ['kitchen'],
        'kitchen faucet': ['kitchen'],
        'kitchen sink': ['kitchen'],
        'bathroom': ['bathroom'],
        'bathroom_update': ['bathroom'],
        'bathroom_master': ['bathroom'],
        'bathroom_secondary': ['bathroom'],
        'bathroom countertop': ['bathroom'],
        'vanity': ['bathroom'],
        'mirror': ['bathroom'],
        'toilet': ['bathroom'],
        'faucet': ['bathroom'],
        'sink': ['bathroom', 'kitchen'],
        'shower': ['bathroom'],
        'bathtub': ['bathroom'],
        'bathroom exhaust': ['bathroom'],
        'countertop': ['kitchen', 'bathroom'],
        'cabinet': ['kitchen', 'bathroom'],
        'flooring': ['kitchen', 'bathroom', 'bedroom', 'living_room', 'dining_room', 'hallway', 'foyer', 'basement', 'office', 'laundry'],
        'paint': ['kitchen', 'bathroom', 'bedroom', 'living_room', 'dining_room', 'hallway', 'foyer', 'basement', 'office', 'laundry'],
        'interior_paint': ['kitchen', 'bathroom', 'bedroom', 'living_room', 'dining_room', 'hallway', 'foyer', 'basement', 'office', 'laundry'],
        'paint_interior': ['kitchen', 'bathroom', 'bedroom', 'living_room', 'dining_room', 'hallway', 'foyer', 'basement', 'office', 'laundry'],
        'paint_exterior': ['exterior', 'garage'],
        'exterior': ['exterior', 'garage'],
        'interior': ['kitchen', 'bathroom', 'bedroom', 'living_room', 'dining_room', 'hallway', 'foyer', 'basement', 'office'],
        'tile': ['bathroom', 'kitchen'],
        'cabinets': ['kitchen', 'bathroom'],
        'countertops': ['kitchen', 'bathroom'],
        'appliances': ['kitchen'],
        'vanity': ['bathroom'],
        'hvac': ['utility', 'basement', 'garage', 'kitchen'],
        'windows': ['living_room', 'bedroom', 'kitchen', 'dining_room'],
        'roof': ['exterior'],
        'roofing': ['exterior'],
        'siding': ['exterior'],
        'doors': ['foyer', 'hallway', 'living_room', 'bedroom'],
        'deck': ['exterior', 'patio'],
        'deck_patio': ['exterior', 'patio'],
        'patio': ['exterior', 'patio'],
        'landscaping': ['exterior'],
        'landscape': ['exterior'],
        'lighting': ['kitchen', 'bathroom', 'living_room', 'dining_room', 'bedroom', 'hallway', 'foyer', 'basement'],
        'ceiling': ['kitchen', 'bathroom', 'living_room', 'dining_room', 'bedroom', 'hallway', 'foyer', 'basement'],
        'basement': ['basement'],
        'trim': ['living_room', 'dining_room', 'bedroom', 'hallway'],
        'general': ['kitchen', 'bathroom', 'bedroom', 'living_room'],
      };

      const sType = (suggestion.type || '').toLowerCase();
      const sName = (suggestion.name || '').toLowerCase();
      const baseTargetRooms = typeToRoom[sType] || typeToRoom[measurementType] || [];
      const targetRooms = [...new Set([...baseTargetRooms, ...roomHints])];

      // ── Determine relevant material CATEGORIES for this specific renovation ──
      // Prevents "Flooring Replacement" from showing shower tile, plumbing, vanity, etc.
      function getRelevantMaterialCategories() {
        if (sType.includes('vanity') || sName.includes('vanity')) {
          return new Set(['vanity', 'countertops', 'plumbing', 'lighting']);
        }
        if (sType.includes('toilet') || sName.includes('toilet')) {
          return new Set(['plumbing']);
        }
        if (sType.includes('mirror') || sName.includes('mirror')) {
          return new Set(['vanity', 'bathroom']);
        }
        if (sType.includes('faucet') || sName.includes('faucet')) {
          return new Set(['plumbing']);
        }
        if (sType.includes('sink') || sName.includes('sink')) {
          return new Set(['plumbing', 'vanity']);
        }
        if (sType.includes('countertop') || sName.includes('countertop')) {
          return new Set(['countertops', 'plumbing', 'vanity']);
        }
        if (sType.includes('cabinet') || sName.includes('cabinet')) {
          return new Set(['cabinets', 'vanity']);
        }
        if (sType.includes('shower') || sName.includes('shower') || sType.includes('bathtub') || sName.includes('bathtub') || sName.includes('tub')) {
          return new Set(['tile', 'plumbing', 'bathroom']);
        }
        if (sType.includes('lighting') || sName.includes('lighting') || sName.includes('light fixture') || sType.includes('exhaust') || sName.includes('exhaust')) {
          return new Set(['lighting', 'electrical']);
        }
        // Full room remodels → return ALL materials for the room
        if (['bathroom', 'bathroom_update', 'bathroom_master', 'bathroom_secondary',
             'kitchen', 'kitchen_update', 'kitchen_refresh'].includes(sType)) {
          return null; // no filter
        }
        // Flooring-specific: only flooring + trim materials
        if (sType.includes('flooring') || sType.includes('floor') ||
            sName.includes('flooring') || sName.includes('floor replacement')) {
          return new Set(['flooring', 'trim']);
        }
        // Paint-specific: only paint materials
        if (measurementType.includes('paint') || sType.includes('paint') || sName.includes('paint refresh') || sName.includes('paint interior')) {
          return new Set(['paint']);
        }
        if (measurementType.includes('ceiling') || sName.includes('ceiling')) {
          return new Set(['ceiling', 'lighting', 'paint', 'drywall']);
        }
        // Tile: if combined with fixtures (e.g. "Bathroom Tile and Fixture Upgrade"), include plumbing too
        if (sType.includes('tile') || sName.includes('tile')) {
          if (sName.includes('fixture') || sName.includes('bathroom')) {
            return new Set(['tile', 'plumbing', 'electrical', 'lighting', 'vanity', 'bathroom']);
          }
          return new Set(['tile']);
        }
        if (sType.includes('cabinet') || sName.includes('cabinet')) {
          return new Set(['cabinets']);
        }
        if (sType.includes('countertop') || sName.includes('countertop')) {
          return new Set(['countertops']);
        }
        if (sType.includes('window') || sName.includes('window')) {
          return new Set(['windows', 'trim']);
        }
        if (sType.includes('lighting') || sName.includes('lighting')) {
          return new Set(['lighting', 'electrical']);
        }
        return null; // default: no filter (full remodel assumed)
      }

      // ── Filter labor items by renovation-relevant keywords ──
      function filterLaborForRenovation(laborItems) {
        if (!laborItems || !laborItems.length) return laborItems;
        const categories = getRelevantMaterialCategories();
        if (!categories) return laborItems; // full remodel — keep all

        // Always include general prep/demo
        const generalKeywords = ['demo', 'debris', 'prep', 'cleanup', 'surface'];
        const renoKeywords = [...generalKeywords];

        if (categories.has('flooring')) renoKeywords.push('floor', 'lvp', 'hardwood', 'carpet', 'vinyl', 'baseboard', 'trim');
        if (categories.has('paint')) renoKeywords.push('paint', 'primer', 'wall paint', 'ceiling');
        if (categories.has('tile')) renoKeywords.push('tile', 'grout', 'thinset', 'waterproof', 'cement board', 'backer');
        if (categories.has('plumbing')) renoKeywords.push('toilet', 'vanity', 'faucet', 'plumb', 'shower', 'supply', 'drain', 'valve');
        if (categories.has('electrical') || categories.has('lighting')) renoKeywords.push('exhaust', 'gfci', 'wiring', 'light', 'electric');
        if (categories.has('ceiling')) renoKeywords.push('ceiling', 'grid', 'acoustic', 'tile', 'suspended');
        if (categories.has('bathroom') || categories.has('vanity')) renoKeywords.push('accessor', 'mirror', 'towel');
        if (categories.has('vanity')) renoKeywords.push('vanity', 'mirror', 'sink', 'faucet', 'countertop');
        if (categories.has('cabinets')) renoKeywords.push('cabinet');
        if (categories.has('countertops')) renoKeywords.push('counter', 'fabricat', 'template', 'sink reconnect');
        if (categories.has('windows')) renoKeywords.push('window', 'casing', 'sill');

        return laborItems.filter(l => {
          const task = (l.task || l.description || '').toLowerCase();
          return renoKeywords.some(k => task.includes(k));
        });
      }

      function filterObjectsForSuggestion(objectMeasurements) {
        if (!objectMeasurements?.length) return objectMeasurements;

        const keywords = sType.includes('vanity') || sName.includes('vanity')
          ? ['vanity', 'sink', 'mirror', 'faucet', 'counter']
          : sType.includes('toilet') || sName.includes('toilet')
            ? ['toilet']
            : sType.includes('mirror') || sName.includes('mirror')
              ? ['mirror']
              : sType.includes('faucet') || sName.includes('faucet')
                ? ['faucet', 'sink']
                : sType.includes('sink') || sName.includes('sink')
                  ? ['sink', 'vanity']
                  : sType.includes('countertop') || sName.includes('countertop')
                    ? ['counter', 'vanity', 'sink']
                    : sType.includes('lighting') || sName.includes('lighting') || sName.includes('light fixture') || sType.includes('exhaust') || sName.includes('exhaust')
                      ? ['light', 'fixture', 'fan', 'exhaust']
                      : sType.includes('shower') || sName.includes('shower') || sType.includes('bathtub') || sName.includes('bathtub') || sName.includes('tub')
                        ? ['shower', 'tub', 'bathtub']
                        : null;

        if (!keywords) return objectMeasurements;

        const filtered = objectMeasurements.filter((objectMeasurement) => {
          const searchable = `${objectMeasurement?.type || ''} ${objectMeasurement?.description || ''}`.toLowerCase();
          return keywords.some((keyword) => searchable.includes(keyword));
        });

        return filtered.length > 0 ? filtered : objectMeasurements;
      }

      const relevantCategories = getRelevantMaterialCategories();

      // ── Determine whether this is a whole-house renovation that spans multiple rooms ──
      const isWholeHouseReno = ['flooring', 'paint', 'interior_paint', 'paint_interior', 'paint_refresh',
        'flooring_update', 'floor', 'hardwood', 'lvp', 'carpet'].some(t => measurementType.includes(t) || sType.includes(t) || sName.includes(t));

      // ── Match to measured rooms ──
      // For whole-house renovations (flooring, paint): aggregate ALL matching rooms.
      // For room-specific renovations (kitchen, bathroom): use the single best match.
      const allMatchedRooms = photoMeasurements.rooms.filter(r =>
        targetRooms.includes(r.roomType) || sName.includes(r.roomType)
      );

      if (allMatchedRooms.length === 0) return null;

      if (isWholeHouseReno && allMatchedRooms.length > 1) {
        // ── WHOLE-HOUSE: Aggregate materials/labor/dimensions across all measured rooms ──
        console.log(`[AI Renovation] 🏠 Whole-house "${sName}": aggregating ${allMatchedRooms.length} rooms (${allMatchedRooms.map(r => r.roomType).join(', ')})`);

        let aggMaterials = [];
        let aggLabor = [];
        let totalFloorSqFt = 0;
        let totalWallSqFt = 0;
        let totalPerimeterFt = 0;
        const aggSourcePhotoIndexes = [];

        for (const room of allMatchedRooms) {
          let rMaterials = buildMeasuredMaterials
            ? buildMeasuredMaterials(room.dimensions, room.roomType, measurementType)
            : (room.materialItems || (photoMeasurements.measuredMaterials || []).filter(m => m.room === room.roomType));
          let rLabor = buildMeasuredLabor
            ? buildMeasuredLabor(room.dimensions, room.roomType, measurementType)
            : (room.laborItems || (photoMeasurements.measuredLabor || []).filter(l => l.room === room.roomType));
          if (relevantCategories) {
            rMaterials = rMaterials.filter(m => relevantCategories.has(m.category));
          }
          rLabor = filterLaborForRenovation(rLabor);
          aggMaterials.push(...rMaterials);
          aggLabor.push(...rLabor);
          totalFloorSqFt += room.dimensions?.floorAreaSqFt || 0;
          totalWallSqFt += room.dimensions?.wallAreaSqFt || 0;
          totalPerimeterFt += room.dimensions?.perimeterFt || 0;
          if (room.sourcePhotoIndexes) aggSourcePhotoIndexes.push(...room.sourcePhotoIndexes);
        }

        // Use the best room's height (they should all be similar)
        const referenceRoom = allMatchedRooms[0];
        const heightFt = referenceRoom.dimensions?.heightFt || 8;

        // Build an aggregate dimension envelope
        const aggDimensions = {
          floorAreaSqFt: Math.round(totalFloorSqFt),
          ceilingAreaSqFt: Math.round(totalFloorSqFt),
          wallAreaSqFt: Math.round(totalWallSqFt),
          perimeterFt: Math.round(totalPerimeterFt),
          heightFt,
          widthFt: null,
          lengthFt: null,
          aggregatedRooms: allMatchedRooms.length,
          scopeType: 'aggregated',
          scopeLabel: `${allMatchedRooms.length} rooms combined`,
        };

        // Lowest confidence across rooms
        const confidenceLevels = { high: 3, medium: 2, low: 1 };
        const worstConfidence = allMatchedRooms.reduce((worst, r) =>
          (confidenceLevels[r.confidence] || 1) < (confidenceLevels[worst] || 1) ? r.confidence : worst,
          'high'
        );

        const relevantObjects = filterObjectsForSuggestion(photoMeasurements.objects.filter(o =>
          allMatchedRooms.some(r => r.roomType === o.roomType)
        ));
        const trustReasons = [...new Set(allMatchedRooms.flatMap(room => getRoomTrust(room).reasons || []))];
        const trustedForPricing = allMatchedRooms.every(room => getRoomTrust(room).trustedForPricing);

        return {
          roomDimensions: aggDimensions,
          materialQuantities: {}, // aggregated items contain quantities already
          materialItems: aggMaterials,
          laborItems: aggLabor,
          measuredMaterials: aggMaterials,
          measuredLabor: aggLabor,
          objectMeasurements: relevantObjects,
          confidence: worstConfidence,
          roomType: `${allMatchedRooms.map(r => r.roomType).join('+')} (${allMatchedRooms.length} rooms)`,
          uncertainty: referenceRoom.uncertainty || null,
          captureProtocol: photoMeasurements.captureProtocol || null,
          sourcePhotoIndexes: [...new Set(aggSourcePhotoIndexes)],
          isAggregated: true,
          trustedForPricing,
          measurementTrust: {
            trustedForPricing,
            reasons: trustedForPricing ? [] : trustReasons,
            scope: 'aggregated_rooms',
          },
        };
      }

      // ── SINGLE-ROOM: use the first matching room (original behavior) ──
      const matchedRoom = allMatchedRooms[0];

      // Find any object measurements relevant to this suggestion
      const relevantObjects = filterObjectsForSuggestion(photoMeasurements.objects.filter(o =>
        o.roomType === matchedRoom.roomType
      ));

      // Get base materials/labor for the matched room
      let roomMaterials = buildMeasuredMaterials
        ? buildMeasuredMaterials(matchedRoom.dimensions, matchedRoom.roomType, measurementType)
        : (matchedRoom.materialItems || (photoMeasurements.measuredMaterials || []).filter(m => m.room === matchedRoom.roomType));
      let roomLabor = buildMeasuredLabor
        ? buildMeasuredLabor(matchedRoom.dimensions, matchedRoom.roomType, measurementType)
        : (matchedRoom.laborItems || (photoMeasurements.measuredLabor || []).filter(l => l.room === matchedRoom.roomType));

      // Filter materials to only those relevant to THIS renovation type
      // e.g., "Flooring Replacement" in bathroom gets only flooring+trim, not shower tile + plumbing
      if (relevantCategories) {
        const beforeCount = roomMaterials.length;
        roomMaterials = roomMaterials.filter(m => relevantCategories.has(m.category));
        console.log(`[AI Renovation] Filtered "${sName}" materials: ${beforeCount} → ${roomMaterials.length} (categories: ${[...relevantCategories].join(', ')})`);
      }
      roomLabor = filterLaborForRenovation(roomLabor);

      return {
        roomDimensions: {
          ...matchedRoom.dimensions,
          ceilingAreaSqFt: matchedRoom.dimensions?.floorAreaSqFt || null,
          scopeType: 'room',
        },
        materialQuantities: matchedRoom.materialQuantities,
        materialItems: roomMaterials,
        laborItems: roomLabor,
        measuredMaterials: roomMaterials,
        measuredLabor: roomLabor,
        objectMeasurements: relevantObjects,
        confidence: matchedRoom.confidence,
        roomType: matchedRoom.roomType,
        uncertainty: matchedRoom.uncertainty || null,
        captureProtocol: photoMeasurements.captureProtocol || null,
        sourcePhotoIndexes: matchedRoom.sourcePhotoIndexes || [],
        trustedForPricing: getRoomTrust(matchedRoom).trustedForPricing,
        measurementTrust: getRoomTrust(matchedRoom),
      };
    }

    // STEP 3: Enhance suggestions with IMPROVED cost estimator
    // Uses local database first, then validates with web search
    // NOW POWERED BY REAL MEASUREMENTS when available
    console.log('[AI Renovation] Enhancing', suggestions.length, 'suggestions with IMPROVED cost estimator...');
    updateRenovationAnalysisMonitor({ stage: 'enhancing_suggestions' });
    
    // Import the IMPROVED cost estimator (database-first approach)
    const improvedEstimator = await import('./improved-cost-estimator.js');
    const zipCostEstimator = await import('./zip-cost-estimator.js');
    const productSearch = await import('./product-search.js');
    
    const enhancedSuggestions = await Promise.all(
      suggestions.map(async (s, idx) => {
        try {
          // Extract zip code from property address
          const zipCode = extractZipCode(propertyData?.address || '');

          // ========================================================================
          // Match this suggestion to measured room dimensions
          // ========================================================================
          const suggestionMeasurements = getMeasurementsForSuggestion(s);
          if (suggestionMeasurements) {
            console.log(`[AI Renovation] ✓ Matched "${s.name}" to measured ${suggestionMeasurements.roomType} (${suggestionMeasurements.roomDimensions.floorAreaSqFt} sq ft)`);
          }
          const pricingMeasurements = isMeasurementTrustedForPricing(suggestionMeasurements) ? suggestionMeasurements : null;
          if (suggestionMeasurements && !pricingMeasurements) {
            console.warn(`[AI Renovation] Measurement match for "${s.name}" kept for explainability but excluded from pricing: ${(suggestionMeasurements.measurementTrust?.reasons || ['untrusted']).join(', ')}`);
          }
          
          // ========================================================================
          // NEW: Use IMPROVED estimator as PRIMARY cost source
          // This uses our structured database with 2024-2025 industry costs
          // NOW WITH REAL MEASUREMENTS when available
          // ========================================================================
          let improvedCosts = null;
          
          console.log(`[AI Renovation] Getting IMPROVED costs for: ${s.name} in ${zipCode || 'default'}`);
          
          improvedCosts = await improvedEstimator.getComprehensiveCostEstimate({
            projectType: s.type || 'general',
            projectName: s.name,
            zipCode: zipCode || '20001',
            locationContext: marketData.ok
              ? (marketData.locationContext || {
                  address: propertyData?.address || '',
                  zipCode: zipCode || '',
                  city: marketData.city || '',
                  state: marketData.state || '',
                  county: marketData.county || '',
                  metro: marketData.metro || '',
                })
              : {
                  address: propertyData?.address || '',
                  zipCode: zipCode || '',
                  city: '',
                  state: '',
                  county: '',
                  metro: '',
                },
            scope: {}, // Will be overridden by measurements if available
            qualityLevel: 'midRange',
            validateWithWeb: true,
            measurements: pricingMeasurements // Only trusted calibrated measurements may drive pricing
          });
          
          if (improvedCosts.ok) {
            console.log(`[AI Renovation] ✓ IMPROVED estimate: $${improvedCosts.summary.totalCost} (${improvedCosts.summary.confidence.level} confidence)`);
          } else {
            console.log(`[AI Renovation] ⚠ IMPROVED estimate failed: ${improvedCosts.error}`);
          }
          
          // FALLBACK: Use old estimator if improved fails
          let detailedCosts = null;
          if (!improvedCosts?.ok) {
            console.log(`[AI Renovation] Falling back to zip-cost-estimator for: ${s.name}`);
            
            if (zipCode && s.details && s.details.length > 50) {
              const specifications = {
                projectDescription: s.details,
                estimatedScope: s.name,
                aiEstimate: s.estimatedCost,
                materialQuality: 'mid-range'
              };
              
              detailedCosts = await zipCostEstimator.getDetailedCostEstimate({
                projectType: s.type || 'general renovation',
                zipCode: zipCode,
                specifications: specifications
              });
            }
            
            if (!detailedCosts?.ok) {
              const quickEstimate = await zipCostEstimator.getZipCodeCostEstimate(
                s.name,
                zipCode || '20001',
                { projectSize: 'medium' }
              );
              
              if (quickEstimate.ok) {
                detailedCosts = {
                  ok: true,
                  summary: {
                    grandTotal: quickEstimate.costRange.average,
                    lowEstimate: quickEstimate.costRange.low,
                    highEstimate: quickEstimate.costRange.high
                  },
                  confidence: quickEstimate.confidence,
                  materials: [],
                  labor: []
                };
              }
            }
          }
          
          // Search for real contractor costs using Google (keep as additional validation)
          const contractorCosts = await marketDataModule.searchContractorCosts(
            s.name,
            propertyData?.location || marketData.location || 'United States'
          );

          const primaryCostSummary = improvedCosts?.ok
            ? {
                totalCost: improvedCosts.summary.totalCost,
                costRange: improvedCosts.summary.costRange,
                confidence: improvedCosts.summary.confidence?.level || 'medium',
                source: improvedCosts.primaryEstimate?.method || 'IMPROVED_ESTIMATOR',
              }
            : detailedCosts?.ok
              ? {
                  totalCost: detailedCosts.summary.grandTotal,
                  costRange: {
                    low: detailedCosts.summary.lowEstimate,
                    high: detailedCosts.summary.highEstimate,
                  },
                  confidence: detailedCosts.confidence || 'medium',
                  source: 'ZIP_COST_ESTIMATOR',
                }
              : null;

          const finalCost = primaryCostSummary?.totalCost
            || (contractorCosts.ok ? contractorCosts.costData?.avgEstimate : s.estimatedCost || 0);

          const costRange = primaryCostSummary?.costRange || {
            low: Math.round(finalCost * 0.85),
            high: Math.round(finalCost * 1.15)
          };

          const marketCostValidation = improvedCosts?.ok
            ? {
                ok: true,
                costData: {
                  avgEstimate: improvedCosts.summary.totalCost,
                  confidence: improvedCosts.summary.confidence?.level || 'medium',
                  lowEstimate: improvedCosts.summary.costRange?.low || null,
                  highEstimate: improvedCosts.summary.costRange?.high || null,
                  source: improvedCosts.primaryEstimate?.method || 'IMPROVED_ESTIMATOR',
                },
                sources: contractorCosts.ok ? (contractorCosts.sources || []) : [],
              }
            : contractorCosts.ok
              ? contractorCosts
              : {
                  costData: { avgEstimate: finalCost, confidence: primaryCostSummary?.confidence || 'medium' },
                  sources: []
                };

          // Calculate accurate metrics using ATTOM market data + actual costs
          const metrics = await marketDataModule.calculateRenovationMetrics(
            {
              type: s.type || 'general',
              estimatedCost: finalCost,
              details: s.details || '',
              materialQuality: s.qualityLevel || 'mid-range',
              qualityLevel: s.qualityLevel || 'mid-range',
              preRenovationCondition: s.preRenovationCondition || 'average',
              scope: s.scope || 'refresh',
              marketFit: s.marketFit || 'neutral',
            },
            marketData.ok ? marketData : {
              propertyValue: effectivePropertyValue,
              estimatedRent: effectiveRent,
              yearBuilt: propertyData?.yearBuilt || 2000,
              propertyType: 'single_family',
              marketAppreciationRate: 0.03,
              locationContext: {
                address: propertyData?.address || '',
                zipCode: zipCode || '',
                city: '',
                state: '',
                county: '',
                metro: '',
              }
            },
            marketCostValidation,
            {
              rentcastData,
              macroData,
            }
          );

          const regionalMatch = findRegionalMatchForSuggestion(s);
          const regionalRentMetrics = regionalMatch ? getRegionalRentMetrics(regionalMatch.renovationType) : null;

          const blendedValueIncrease = regionalMatch?.sampleSize >= 3
            ? Math.round(((regionalMatch.avgValueUplift || regionalMatch.medianValueUplift || 0) * 0.75) + ((metrics?.valueIncrease || 0) * 0.25))
            : (metrics?.valueIncrease || 0);
          const blendedRentIncrease = regionalMatch?.sampleSize >= 3
            ? Math.round(((regionalMatch.avgRentIncrease || regionalRentMetrics?.avgMonthlyRentIncrease || 0) * 0.70) + ((metrics?.rentIncreaseDollar || 0) * 0.30))
            : (metrics?.rentIncreaseDollar || 0);
          const blendedRoi = (improvedCosts?.ok ? improvedCosts.summary.totalCost : (metrics?.cost || Math.round(finalCost))) > 0
            ? (((blendedValueIncrease || 0) + ((blendedRentIncrease || 0) * 12 * 5)) / (improvedCosts?.ok ? improvedCosts.summary.totalCost : (metrics?.cost || Math.round(finalCost)))) * 100
            : 0;
          const blendedPaybackMonths = blendedRentIncrease > 0
            ? Math.ceil((improvedCosts?.ok ? improvedCosts.summary.totalCost : (metrics?.cost || Math.round(finalCost))) / blendedRentIncrease)
            : (metrics?.paybackMonths || null);

          // ========================================================================
          // NEW: Get shoppable product recommendations for DIY renovators
          // Search for actual products with live pricing from retailers
          // ========================================================================
          let shoppableProducts = null;
          try {
            // Map renovation type to product search project type
            const normalizedSearchType = normalizeSuggestionType(s);
            const productProjectMap = {
              'bathroom': 'bathroom_full_remodel',
              'bathroom_update': 'bathroom_refresh',
              'bathroom_vanity': 'bathroom_vanity_replace',
              'vanity': 'bathroom_vanity_replace',
              'toilet': 'bathroom_toilet_replace',
              'mirror': 'bathroom_mirror_replace',
              'faucet': 'bathroom_faucet_replace',
              'bathroom countertop': 'bathroom_countertop_replace',
              'bathroom exhaust': 'bathroom_exhaust_update',
              'shower': 'bathroom_shower_update',
              'bathtub': 'bathroom_tub_replace',
              'kitchen': 'kitchen_full_remodel',
              'kitchen_update': 'kitchen_full_remodel',
              'countertop': 'kitchen_countertop_replace',
              'cabinet': 'kitchen_cabinet_replace',
              'kitchen cabinet': 'kitchen_cabinet_replace',
              'kitchen faucet': 'kitchen_faucet_replace',
              'kitchen sink': 'kitchen_sink_replace',
              'flooring': 'flooring_lvp',
              'hardwood': 'flooring_hardwood',
              'tile': 'flooring_tile',
              'hvac': 'hvac_update',
              'windows': 'window_replace',
              'lighting': 'lighting_update'
            };
            
            const searchType = normalizedSearchType || s.type?.toLowerCase() || 'general';
            const roomType = suggestionMeasurements?.roomType || '';
            let projectType = null;

            if (searchType === 'faucet' && roomType.includes('kitchen')) {
              projectType = 'kitchen_faucet_replace';
            } else if (searchType === 'sink' && roomType.includes('kitchen')) {
              projectType = 'kitchen_sink_replace';
            } else if (searchType === 'countertop' && roomType.includes('bathroom')) {
              projectType = 'bathroom_countertop_replace';
            } else if (searchType === 'lighting' && roomType.includes('bathroom')) {
              projectType = 'bathroom_lighting_update';
            } else {
              projectType = productProjectMap[searchType]
                || productProjectMap[s.type?.toLowerCase()]
                || Object.keys(productProjectMap).find(k => s.name?.toLowerCase().includes(k));
            }
            
            if (projectType) {
              console.log(`[AI Renovation] Getting shoppable products for: ${projectType}`);
              const productRecs = await productSearch.getProductRecommendations({
                projectType,
                qualityLevel: 'midRange',
                zipCode: zipCode,
                room: suggestionMeasurements?.roomType || null,
                measurements: suggestionMeasurements,
                materialBreakdown: improvedCosts?.ok
                  ? (improvedCosts.primaryEstimate?.materials || [])
                  : (detailedCosts?.materials || []),
                suggestionName: s.name,
                projectName: s.name,
              });
              
              if (productRecs.ok) {
                shoppableProducts = {
                  totalMaterialEstimate: productRecs.totalMaterialEstimate,
                  recommendations: productRecs.recommendations,
                  localStoreLinks: productRecs.localStoreLinks,
                  note: productRecs.scopeNote || 'Live pricing from Home Depot, Lowe\'s, Amazon, Wayfair'
                };
                console.log(`[AI Renovation] ✓ Found ${Object.keys(productRecs.recommendations).length} product categories`);
              }
            }
          } catch (productError) {
            console.warn('[AI Renovation] Product search failed (non-critical):', productError.message);
          }

          const materialCostTotal = improvedCosts?.ok
            ? Number(improvedCosts.summary.materialCost || 0)
            : (detailedCosts?.materials || []).reduce((sum, material) => sum + Number(material?.totalCost || 0), 0);
          const laborCostTotal = improvedCosts?.ok
            ? Number(improvedCosts.summary.laborCost || 0)
            : (detailedCosts?.labor || []).reduce((sum, labor) => sum + Number(labor?.totalCost || 0), 0);
          const pricedFromMeasurements = improvedCosts?.primaryEstimate?.breakdownSource === 'photo_measured';
          const finalTotalCost = improvedCosts?.ok ? improvedCosts.summary.totalCost : (metrics?.cost || Math.round(finalCost));
          const costComposition = {
            pricingSource: primaryCostSummary?.source || (contractorCosts.ok ? 'CONTRACTOR_SEARCH' : 'AI_ESTIMATE'),
            pricingMethod: improvedCosts?.primaryEstimate?.method || primaryCostSummary?.source || 'FALLBACK',
            pricingConfidence: primaryCostSummary?.confidence || metrics?.confidence || 'medium',
            breakdownSource: improvedCosts?.primaryEstimate?.breakdownSource || (detailedCosts?.ok ? 'zip_cost_estimator' : 'fallback'),
            measurementDriven: pricedFromMeasurements,
            materialCost: Math.round(materialCostTotal),
            laborCost: Math.round(laborCostTotal),
            materialShare: finalTotalCost > 0 ? Math.round((materialCostTotal / finalTotalCost) * 100) : null,
            laborShare: finalTotalCost > 0 ? Math.round((laborCostTotal / finalTotalCost) * 100) : null,
          };

          return {
            id: `renovation-${Date.now()}-${idx}`,
            name: s.name || 'Unnamed Renovation',
            type: s.type || 'general',
            summary: s.summary || '',
            details: s.details || '',
            
            // Real market-based costs — prefer improved estimator
            cost: finalTotalCost,
            costRange: improvedCosts?.ok ? improvedCosts.summary.costRange : costRange,
            costComposition,
            
            // Detailed breakdown — prefer improved estimator (which uses measured materials directly)
            materialBreakdown: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.materials || null) : (detailedCosts?.ok ? detailedCosts.materials : null),
            laborBreakdown: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.labor || null) : (detailedCosts?.ok ? detailedCosts.labor : null),
            
            // NEW: Shoppable products with live pricing for DIY
            shoppableProducts: shoppableProducts,
            
            // ================================================================
            // Photo-based measurements
            // ================================================================
            measurements: suggestionMeasurements ? {
              roomDimensions: suggestionMeasurements.roomDimensions,
              roomType: suggestionMeasurements.roomType,
              materialQuantities: suggestionMeasurements.materialQuantities,
              uncertainty: suggestionMeasurements.uncertainty || null,
              captureProtocol: suggestionMeasurements.captureProtocol || null,
              objectMeasurements: suggestionMeasurements.objectMeasurements?.map(o => ({
                type: o.type,
                description: o.description,
                dimensions: o.dimensions,
                applianceFit: o.applianceFit,
                confidence: o.confidence,
                sanityClamped: o.sanityClamped || false,
                trustedForPricing: o.trustedForPricing || false,
                trustReasons: o.measurementTrust?.reasons || [],
              })),
              sourcePhotoIndexes: suggestionMeasurements.sourcePhotoIndexes || [],
              confidence: suggestionMeasurements.confidence,
              trustedForPricing: isMeasurementTrustedForPricing(suggestionMeasurements),
              trustReasons: suggestionMeasurements.measurementTrust?.reasons || [],
              audit: suggestionMeasurements.measurementTrust || null,
              note: isMeasurementTrustedForPricing(suggestionMeasurements)
                ? undefined
                : 'Measurements are shown for explainability only and did not drive pricing because calibration/intrinsics trust checks failed.',
              measured: true,
            } : {
              measured: false,
              note: 'No matching room measurements — costs estimated from project type',
            },
            
            // Accurate value lift based on property age, type, and market
            valueIncrease: blendedValueIncrease,
            afterRepairValue: Math.round(effectivePropertyValue + blendedValueIncrease),
            
            // Data-driven rent increase
            rentIncreaseDollar: blendedRentIncrease,
            rentIncreasePercent: effectiveRent > 0 ? Number(((blendedRentIncrease / effectiveRent) * 100).toFixed(1)) : (metrics?.rentIncreasePercent || 0),
            marketRentBenchmark: metrics?.marketRentBenchmark || rentcastMarketRent || effectiveRent,
            marketSaleBenchmark: metrics?.marketSaleBenchmark || rentcastMarketSale || effectivePropertyValue,
            
            // Financial metrics
            roi: Number(blendedRoi.toFixed(1)),
            paybackMonths: blendedPaybackMonths,
            
            // Metadata
            currentRent: metrics?.currentRent || effectiveRent,
            maxPostRenovationRent: metrics?.maxPostRenovationRent || effectiveRent,
            priority: s.priority || 'medium',
            timeframe: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.timeline || 'TBD') : (detailedCosts?.timeline || s.timeframe || 'TBD'),
            confidence: improvedCosts?.ok ? improvedCosts.summary.confidence?.level : (detailedCosts?.confidence || metrics?.confidence || 'medium'),
            valuationModel: metrics?.valueModel || null,
            rentcastModel: metrics?.rentcastModel || null,
            macroModel: metrics?.macroModel || null,
            regionalModel: regionalMatch ? {
              renovationType: regionalMatch.renovationType,
              avgValueUplift: regionalMatch.avgValueUplift || null,
              avgRentIncrease: regionalMatch.avgRentIncrease || regionalRentMetrics?.avgMonthlyRentIncrease || null,
              sampleSize: regionalMatch.sampleSize || 0,
              confidenceLevel: regionalMatch.confidenceLevel || 'medium',
              source: regionalAreaSummary?.zipCode ? 'regional_uplift_analysis' : 'unavailable',
            } : null,
            
            // Data sources
            dataSource: {
              detailedBreakdown: improvedCosts?.ok || detailedCosts?.ok || false,
              breakdownSource: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.breakdownSource || 'database') : 'fallback',
              materialItems: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.materials?.length || 0) : (detailedCosts?.materials?.length || 0),
              laborItems: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.labor?.length || 0) : (detailedCosts?.labor?.length || 0),
              contractorCosts: contractorCosts.ok ? contractorCosts.sources?.length || 0 : 0,
              liveProductPricing: !!shoppableProducts,
              photoMeasurements: !!suggestionMeasurements,
              measurementConfidence: suggestionMeasurements?.confidence || null,
              measurementTrustedForPricing: isMeasurementTrustedForPricing(suggestionMeasurements),
              measurementTrustReasons: suggestionMeasurements?.measurementTrust?.reasons || null,
              measurementUncertainty: suggestionMeasurements?.uncertainty?.percent || null,
              regionalCostFactors: improvedCosts?.summary?.regionalPricing || improvedCosts?.regionalPricing || null,
              regionalUplift: !!regionalMatch,
              regionalComparableCount: regionalMatch?.sampleSize || 0,
              rentcast: !!rentcastData,
              macro: !!macroData,
              marketData: marketData.ok ? 'ATTOM' : 'user-provided',
              pricingSource: costComposition.pricingSource,
              pricingMethod: costComposition.pricingMethod,
              pricingConfidence: costComposition.pricingConfidence,
              measurementDrivenPricing: costComposition.measurementDriven,
              productSearchScope: shoppableProducts?.note || null,
              aiAnalysis: 'GPT-4o',
              depthModel: photoMeasurements?.depthModel || 'depth_anything_v3_metric + gpt_4o_vision',
              zipCode: zipCode || 'unknown'
            }
          };
        } catch (error) {
          console.error('[AI Renovation] Error enhancing suggestion:', s.name, error);
          // Fallback to AI estimates
          return {
            id: `renovation-${Date.now()}-${idx}`,
            name: s.name || 'Unnamed Renovation',
            type: s.type || 'general',
            summary: s.summary || '',
            details: s.details || '',
            cost: Math.round(s.estimatedCost || 0),
            costRange: {
              low: Math.round((s.estimatedCost || 0) * 0.85),
              high: Math.round((s.estimatedCost || 0) * 1.15)
            },
            valueIncrease: 0,
            rentIncreaseDollar: 0,
            rentIncreasePercent: 0,
            roi: 0,
            currentRent: effectiveRent || 0,
            maxPostRenovationRent: effectiveRent || 0,
            priority: s.priority || 'medium',
            timeframe: s.timeframe || 'TBD',
            confidence: 'low',
            dataSource: {
              contractorCosts: 0,
              marketData: 'unavailable',
              aiAnalysis: 'GPT-4o'
            }
          };
        }
      })
    );

    // Filter to only return suggestions with POSITIVE ROI for investment properties
    const positiveROISuggestions = enhancedSuggestions.filter(s => {
      const hasPositiveROI = s.roi && s.roi > 0;
      if (!hasPositiveROI) {
        console.log(`[AI Renovation] Filtering out: ${s.name} (ROI: ${s.roi?.toFixed(1)}%)`);
      }
      return hasPositiveROI;
    });

    // When ATTOM is partial/rate-limited, ROI can be conservative and filter everything.
    // Return best available suggestions rather than an empty list so UI still renders results.
    const fallbackSuggestions = enhancedSuggestions
      .slice()
      .sort((a, b) => (Number(b.roi) || 0) - (Number(a.roi) || 0))
      .slice(0, Math.min(3, enhancedSuggestions.length));

    const returnedSuggestions = positiveROISuggestions.length > 0 ? positiveROISuggestions : fallbackSuggestions;

    console.log(`[AI Renovation] Filtered ${enhancedSuggestions.length} suggestions -> ${positiveROISuggestions.length} with positive ROI`);
    if (positiveROISuggestions.length === 0 && returnedSuggestions.length > 0) {
      console.warn(`[AI Renovation] No positive ROI suggestions available; returning ${returnedSuggestions.length} fallback suggestions`);
    }

    updateRenovationAnalysisMonitor({
      running: false,
      stage: 'completed',
      finishedAt: new Date().toISOString(),
      suggestionCount: returnedSuggestions.length,
      positiveRoiCount: positiveROISuggestions.length,
      fallbackSuggestionsUsed: positiveROISuggestions.length === 0,
      lastError: null,
    });

    res.json({
      ok: true,
      suggestions: returnedSuggestions,
      analyzed: imagesForAnalysis.length,
      model: 'gpt-4o',
      marketDataUsed: marketData.ok,
      marketDataDiagnostics: marketData?.diagnostics || null,
      rentcastUsed: !!rentcastData,
      macroDataUsed: !!macroData,
      droppedImageCount,
      imageDetail: visionDetail,
      propertyValue: effectivePropertyValue,
      estimatedRent: effectiveRent,
      totalSuggestionsAnalyzed: enhancedSuggestions.length,
      positiveRoiCount: positiveROISuggestions.length,
      positivROICount: positiveROISuggestions.length,
      fallbackSuggestionsUsed: positiveROISuggestions.length === 0,
      // NEW: Measurement summary
      measurements: photoMeasurements?.ok ? {
        enabled: true,
        roomsMeasured: photoMeasurements.rooms.length,
        objectsMeasured: photoMeasurements.objects.length,
        appliancesFit: photoMeasurements.appliances.length,
        processingTime: photoMeasurements.processingTime,
        captureProtocol: photoMeasurements.captureProtocol || null,
        globalCalibration: photoMeasurements.globalCalibration || null,
        trustSummary: photoMeasurements.trustSummary || photoMeasurements.measurementAudit?.trustSummary || null,
        autoInferredReferenceAnchors: photoMeasurements.measurementAudit?.autoInferredReferenceAnchors || null,
        knownSceneAnchors: photoMeasurements.measurementAudit?.knownSceneAnchors || {
          specs: knownSceneAnchors.length,
          candidates: 0,
          added: 0,
          source: knownSceneAnchors.length ? 'request_supplied' : null,
        },
        audit: photoMeasurements.measurementAudit || null,
        rooms: photoMeasurements.rooms.map(r => ({
          type: r.roomType,
          dimensions: `${r.dimensions.widthFt}'×${r.dimensions.lengthFt}'`,
          floorArea: `${r.dimensions.floorAreaSqFt} sq ft`,
          confidence: r.confidence,
          trustedForPricing: r.trustedForPricing || false,
          trustReasons: r.measurementTrust?.reasons || [],
        })),
        crossValidation: photoMeasurements.crossValidation || null,
      } : {
        enabled: false,
        reason: photoMeasurements?.error || 'Measurement service unavailable',
      },
    });

  } catch (error) {
    console.error('[AI Renovation] Error:', error);
    updateRenovationAnalysisMonitor({
      running: false,
      stage: 'failed',
      finishedAt: new Date().toISOString(),
      lastError: error?.message || 'Analysis failed',
    });
    res.status(500).json({
      ok: false,
      error: error.message || 'Analysis failed'
    });
  }
});

// ==================== HOUSEYIELD-2 AI INVESTMENT ANALYSIS ENDPOINT ====================
// POST /api/houseyield-analysis
// Body: { address: string, listPrice: number, images: string[] (base64) }
// Returns: { ok: true, analysis: {...}, roomScores: {...}, marketData: {...} }
app.post('/api/houseyield-analysis', async (req, res) => {
  try {
    const { address, listPrice, images } = req.body;
    
    if (!address || !listPrice || !images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Missing required fields: address, listPrice, and images are required' 
      });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
    }

    console.log('[HouseYield-2] Analyzing property:', address, 'List Price:', listPrice);

    // STEP 1: Fetch ATTOM property data
    console.log('[HouseYield-2] Step 1: Fetching ATTOM property data...');
    const attomData = await fetchPropertyDashboard({ address });
    
    if (!attomData.summary) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Property not found in ATTOM database' 
      });
    }

    // STEP 2: Analyze images with OpenAI Vision to get room condition scores
    console.log('[HouseYield-2] Step 2: Analyzing', images.length, 'images with Vision AI...');
    
    const imageMessages = images.map(img => ({
      type: 'image_url',
      image_url: {
        url: img,
        detail: 'high'
      }
    }));

    const visionPrompt = `You are a professional property inspector analyzing images to assess room conditions.

Analyze these property images and provide condition scores for:
- Kitchen (0.0 = unusable, 0.5 = dated/functional, 1.0 = modern/excellent)
- Bathrooms (average if multiple)
- Flooring
- Curb appeal / Exterior

Return ONLY a valid JSON object (no markdown, no code blocks):
{
  "kitchen": 0.75,
  "bath": 0.68,
  "flooring": 0.72,
  "curb_appeal": 0.65,
  "overall": 0.70,
  "notes": "Brief assessment of overall property condition"
}`;

    const visionResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: visionPrompt },
              ...imageMessages
            ]
          }
        ],
        max_tokens: 500,
        temperature: 0.3
      })
    });

    if (!visionResponse.ok) {
      throw new Error(`Vision API failed: ${visionResponse.status}`);
    }

    const visionResult = await visionResponse.json();
    const visionContent = visionResult.choices?.[0]?.message?.content;
    
    let roomScores;
    try {
      const jsonMatch = visionContent.match(/\{[\s\S]*\}/);
      roomScores = JSON.parse(jsonMatch ? jsonMatch[0] : visionContent);
    } catch (e) {
      console.error('[HouseYield-2] Failed to parse vision response:', e);
      // Fallback scores
      roomScores = {
        kitchen: 0.65,
        bath: 0.65,
        flooring: 0.65,
        curb_appeal: 0.65,
        overall: 0.65,
        notes: 'Unable to parse detailed scores'
      };
    }

    console.log('[HouseYield-2] Room scores:', roomScores);

    // STEP 3: Get renovation cost estimates and Google Search contractor data
    console.log('[HouseYield-2] Step 3: Fetching market data and Google Search renovation costs...');
    const marketDataModule = await import('./renovation-market-data.js');
    const renovationData = await marketDataModule.getLocalMarketData(address);
    
    // Fetch Google Search contractor costs for common renovation types
    const renovationTypes = ['kitchen remodel', 'bathroom renovation', 'flooring replacement', 'roof repair'];
    const contractorCostPromises = renovationTypes.map(type => 
      marketDataModule.searchContractorCosts(type, address).catch(err => {
        console.warn(`[HouseYield-2] Google Search failed for ${type}:`, err.message);
        return { ok: false, type, error: err.message };
      })
    );
    
    const contractorCosts = await Promise.all(contractorCostPromises);
    const validContractorCosts = contractorCosts.filter(c => c.ok);
    
    console.log('[HouseYield-2] Retrieved', validContractorCosts.length, 'contractor cost estimates from Google Search');

    // STEP 3.5: Analyze mortgage assumability
    console.log('[HouseYield-2] Step 3.5: Analyzing mortgage assumability...');
    const { analyzeMortgageAssumability } = await import('../analyze-assumability.js');
    const mortgages = attomData.mortgage || [];
    let assumabilityData = null;
    
    if (mortgages && mortgages.length > 0) {
      // Find most recent/largest mortgage
      const primaryMortgage = mortgages.sort((a, b) => {
        const dateA = new Date(a.date || 0);
        const dateB = new Date(b.date || 0);
        return dateB - dateA; // Most recent first
      })[0];
      
      assumabilityData = analyzeMortgageAssumability(primaryMortgage);
      console.log('[HouseYield-2] Assumability analysis:', assumabilityData.assumable, '|', assumabilityData.reason);
    } else {
      console.log('[HouseYield-2] No mortgage data available');
    }

    // STEP 4: Build comprehensive prompt for HouseYield-2 fine-tuned model
    console.log('[HouseYield-2] Step 4: Building training data format with all required fields...');
    
    const propertyData = attomData.summary;
    const fv50 = propertyData.avm || propertyData.assessment?.total || listPrice;
    const fv10 = Math.round(fv50 * 0.90);
    const fv90 = Math.round(fv50 * 1.10);

    // Extract zip code from address
    const zipMatch = address.match(/\b(\d{5})\b/);
    const zipCode = zipMatch ? zipMatch[1] : '00000';

    // Calculate comprehensive financial metrics
    const ppsqft = propertyData.living_sqft ? Math.round(fv50 / propertyData.living_sqft) : 0;
    const rentEstimate = renovationData.estimatedRent || 0;
    const propertyTaxAnnual = propertyData.assessment?.tax || Math.round(fv50 * 0.012); // 1.2% fallback
    const insuranceAnnual = Math.round(fv50 * 0.004); // 0.4% of value
    
    // Calculate NOI and DSCR (for 20% down, 6.75% rate scenario)
    const downPayment20 = Math.round(listPrice * 0.20);
    const loanAmount = listPrice - downPayment20;
    const monthlyPI = loanAmount > 0 ? Math.round(loanAmount * 0.006458) : 0; // 6.75% 30yr ≈ 0.006458
    
    const monthlyTaxes = Math.round(propertyTaxAnnual / 12);
    const monthlyInsurance = Math.round(insuranceAnnual / 12);
    const monthlyMaintenance = Math.round((fv50 * 0.01) / 12); // 1% of value
    const monthlyManagement = Math.round(rentEstimate * 0.08); // 8% of rent
    const monthlyVacancy = Math.round(rentEstimate * 0.05); // 5% vacancy
    const monthlyCapEx = 150;
    
    const totalOPEX = monthlyTaxes + monthlyInsurance + monthlyMaintenance + monthlyManagement + monthlyVacancy + monthlyCapEx;
    const monthlyNOI = rentEstimate - totalOPEX;
    const dscr = monthlyPI > 0 ? (monthlyNOI / monthlyPI) : 0;
    const monthlyFCF = monthlyNOI - monthlyPI;
    const cashOnCash = downPayment20 > 0 ? ((monthlyFCF * 12) / downPayment20) : 0;

    // Build the comprehensive JSON input format the model expects
    const inputDataFormat = {
      id: `user_property_${Date.now()}`,
      list_price: listPrice,
      list_date: new Date().toISOString().split('T')[0],
      geo: {
        lat: propertyData.location?.latitude || 0,
        lon: propertyData.location?.longitude || 0,
        zip: zipCode,
        metro: renovationData.location || 'Unknown'
      },
      structure: {
        prop_type: propertyData.property_type || 'SFR',
        beds: propertyData.beds || 0,
        baths_total: propertyData.baths || 0,
        living_sqft: propertyData.living_sqft || 0,
        lot_sqft: propertyData.lot_sqft || 0,
        year_built: propertyData.year_built || 2000,
        levels: propertyData.stories || 1,
        parking_type: propertyData.parking || 'unknown'
      },
      market: {
        mortgage30: 6.75,
        hpi_1m: 0.0,
        hpi_6m: renovationData.marketAppreciationRate ? renovationData.marketAppreciationRate * 6 : 0.02,
        hpi_12m: renovationData.marketAppreciationRate || 0.03,
        month: new Date().getMonth() + 1
      },
      images: {
        image_urls: images.map((_, i) => `user_upload_${i + 1}.jpg`),
        condition_scores: {
          kitchen_condition_score: roomScores.kitchen,
          bath_condition_score: roomScores.bath,
          flooring_condition_score: roomScores.flooring,
          curb_appeal: roomScores.curb_appeal,
          primary_bedroom_score: roomScores.overall,
          secondary_bedroom_score: roomScores.overall * 0.9,
          living_room_score: roomScores.overall,
          dining_room_score: roomScores.overall,
          basement_condition_score: roomScores.overall * 0.8,
          roof_condition_score: roomScores.overall * 0.85,
          exterior_paint_score: roomScores.curb_appeal,
          landscaping_quality_score: roomScores.curb_appeal
        }
      },
      rental_analysis: {
        rent_estimate: rentEstimate,
        rent_range_low: Math.round(rentEstimate * 0.90),
        rent_range_high: Math.round(rentEstimate * 1.15),
        attom_rent_avm: renovationData.estimatedRent || 0,
        rental_comps_count: 6, // Could fetch actual comps
        rental_comps_median: rentEstimate,
        monthly_opex: {
          property_taxes: monthlyTaxes,
          insurance: monthlyInsurance,
          maintenance: monthlyMaintenance,
          management: monthlyManagement,
          vacancy_reserve: monthlyVacancy,
          capex_reserve: monthlyCapEx,
          utilities: 0,
          total: totalOPEX
        },
        monthly_noi: monthlyNOI,
        financing_scenarios: {
          conventional_20_down: {
            down_payment: downPayment20,
            loan_amount: loanAmount,
            rate: 6.75,
            term_years: 30,
            monthly_pi: monthlyPI,
            monthly_fcf: monthlyFCF,
            dscr: dscr,
            cash_on_cash: cashOnCash,
            viable: dscr >= 1.10
          },
          assumable_loan: assumabilityData && assumabilityData.assumable === 'likely' ? {
            available: true,
            loan_type: assumabilityData.loanType,
            estimated_rate: assumabilityData.estimatedRate,
            rate_advantage: assumabilityData.estimatedRate ? (6.75 - assumabilityData.estimatedRate) : 0,
            attractiveness: assumabilityData.attractiveness
          } : {
            available: false
          }
        }
      },
      sales_comps: {
        count: 15,
        median_ppsqft: ppsqft,
        iqr_ppsqft: Math.round(ppsqft * 0.15),
        avg_recency_days: 30,
        price_range_low: fv10,
        price_range_high: fv90
      },
      schools: attomData.schools && attomData.schools.length > 0 ? {
        elementary: attomData.schools.find(s => s.level === 'Elementary'),
        middle: attomData.schools.find(s => s.level === 'Middle'),
        high: attomData.schools.find(s => s.level === 'High'),
        avg_rating: attomData.schools.reduce((sum, s) => {
          const rating = s.rating?.replace(/[^0-9.]/g, '') || '0';
          return sum + parseFloat(rating);
        }, 0) / attomData.schools.length / 10 // Normalize to 0-1
      } : null,
      features_dynamic: {
        comps: {
          median_ppsqft: propertyData.living_sqft ? Math.round(fv50 / propertyData.living_sqft) : 0,
          iqr_ppsqft: 50,
          comps_count: 15,
          avg_recency_days: 30
        },
        oof_geo: {
          h3_8_ppsqft_median: propertyData.living_sqft ? Math.round(fv50 / propertyData.living_sqft) : 0,
          zip_ppsqft_median: propertyData.living_sqft ? Math.round(fv50 / propertyData.living_sqft) : 0,
          tract_ppsqft_median: propertyData.living_sqft ? Math.round(fv50 / propertyData.living_sqft) : 0,
          zip_sale_to_list_mean: 0.98
        },
        coverage_score: images.length >= 15 ? 0.90 : (images.length >= 8 ? 0.75 : 0.60)
      },
      env: {
        flood_zone: propertyData.flood_zone || 'X',
        elevation_ft: propertyData.elevation || 100,
        wildfire_risk_0_1: 0.1,
        seismic_zone: 'low',
        wind_hail_score: 0.2,
        air_quality_index: 50,
        heat_risk_days: 10,
        noise: {
          road: 0.3,
          rail: 0.1,
          airport: 0.2
        },
        env_risk_score: 0.2
      },
      community: {
        school_rating_avg: attomData.schools && attomData.schools.length > 0 
          ? attomData.schools.reduce((sum, s) => {
              const rating = s.rating?.replace(/[^0-9.]/g, '') || '0';
              return sum + parseFloat(rating);
            }, 0) / attomData.schools.length / 10
          : 0.7,
        crime_index_0_100: 50,
        walk_score: 60,
        transit_score: 50,
        rent_control_flag: false,
        str_restriction_flag: false,
        local_vacancy_rate: 0.05,
        median_income: 80000,
        pop_growth_1y: 0.01,
        community_score: 0.5
      },
      renovation_opportunities: validContractorCosts.length > 0 ? validContractorCosts.map(cost => ({
        type: cost.sources?.[0]?.title?.toLowerCase().includes('kitchen') ? 'kitchen' : 
              cost.sources?.[0]?.title?.toLowerCase().includes('bath') ? 'bathroom' :
              cost.sources?.[0]?.title?.toLowerCase().includes('floor') ? 'flooring' : 
              cost.sources?.[0]?.title?.toLowerCase().includes('roof') ? 'roof' : 'general',
        low_cost: cost.costData?.lowEstimate || 0,
        avg_cost: cost.costData?.avgEstimate || 0,
        high_cost: cost.costData?.highEstimate || 0,
        confidence: cost.costData?.confidence || 'low',
        data_source: 'google_search',
        notes: cost.costData?.notes || ''
      })) : [],
      renovation_costs: {
        google_search_data: validContractorCosts.map(cost => ({
          type: cost.sources?.[0]?.title?.toLowerCase().includes('kitchen') ? 'kitchen' : 
                cost.sources?.[0]?.title?.toLowerCase().includes('bath') ? 'bathroom' :
                cost.sources?.[0]?.title?.toLowerCase().includes('floor') ? 'flooring' : 'general',
          low_estimate: cost.costData?.lowEstimate || 0,
          avg_estimate: cost.costData?.avgEstimate || 0,
          high_estimate: cost.costData?.highEstimate || 0,
          confidence: cost.costData?.confidence || 'low',
          sources: cost.sources?.slice(0, 2).map(s => ({ title: s.title, snippet: s.snippet })) || []
        })),
        market_context: {
          location: renovationData.location || address,
          avg_property_value: renovationData.propertyValue || fv50,
          neighborhood_tier: fv50 > 600000 ? 'premium' : fv50 > 350000 ? 'mid' : 'value'
        }
      },
      financing: assumabilityData ? {
        has_assumable_mortgage: assumabilityData.assumable === 'likely',
        assumable_status: assumabilityData.assumable,
        loan_type: assumabilityData.loanType,
        loan_date: assumabilityData.loanDate,
        estimated_rate: assumabilityData.estimatedRate || null,
        current_market_rate: 6.75,
        rate_advantage: assumabilityData.estimatedRate ? (6.75 - assumabilityData.estimatedRate) : 0,
        attractiveness: assumabilityData.attractiveness,
        confidence: assumabilityData.confidence,
        reason: assumabilityData.reason,
        assumptions: assumabilityData.assumptions || [],
        red_flags: assumabilityData.redFlags || []
      } : {
        has_assumable_mortgage: false,
        assumable_status: 'unknown',
        reason: 'No mortgage data available'
      }
    };

    console.log('[HouseYield-2] Input data format prepared:', JSON.stringify(inputDataFormat).substring(0, 500) + '...');

    // Call HouseYield-2 fine-tuned model with properly formatted data
    const analysisResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'ft:gpt-4.1-2025-04-14:personal:houseyield-2:Cf8tqYDZ', // Your fine-tuned HouseYield-2 model
        messages: [
          {
            role: 'system',
            content: 'You are a real estate AI assistant specialized in fair-value pricing, wedge detection, renovation ROI analysis, and rental viability assessment. You analyze properties using multimodal data (tabular features, images, market conditions) to provide accurate valuations and investment recommendations.'
          },
          {
            role: 'user',
            content: JSON.stringify(inputDataFormat)
          }
        ],
        max_tokens: 4000,
        temperature: 0.7
      })
    });

    if (!analysisResponse.ok) {
      const errorText = await analysisResponse.text();
      console.error('[HouseYield-2] Analysis API error:', errorText);
      throw new Error(`HouseYield-2 API failed: ${analysisResponse.status}`);
    }

    const analysisResult = await analysisResponse.json();
    const analysisContent = analysisResult.choices?.[0]?.message?.content;

    console.log('[HouseYield-2] Analysis complete, length:', analysisContent?.length);

    // Try to parse as JSON if the model returned structured data
    let parsedAnalysis;
    try {
      parsedAnalysis = JSON.parse(analysisContent);
      console.log('[HouseYield-2] Model returned structured JSON data');
    } catch (e) {
      // If not JSON, treat as text analysis
      parsedAnalysis = { analysis_text: analysisContent };
      console.log('[HouseYield-2] Model returned text analysis');
    }

    // Return comprehensive results
    res.json({
      ok: true,
      analysis: parsedAnalysis,
      analysisText: analysisContent,
      roomScores: roomScores,
      inputDataFormat: inputDataFormat,
      contractorCosts: validContractorCosts, // Include Google Search contractor costs
      assumability: assumabilityData, // Include mortgage assumability analysis
      marketData: {
        address: address,
        listPrice: listPrice,
        fv50: fv50,
        fv10: fv10,
        fv90: fv90,
        beds: propertyData.beds,
        baths: propertyData.baths,
        sqft: propertyData.living_sqft,
        yearBuilt: propertyData.year_built,
        propertyType: propertyData.property_type,
        estimatedRent: rentEstimate,
        propertyTax: propertyTaxAnnual,
        monthlyNOI: monthlyNOI,
        monthlyFCF: monthlyFCF,
        dscr: dscr,
        cashOnCash: cashOnCash,
        googleSearchEnabled: validContractorCosts.length > 0,
        assumableMortgage: assumabilityData?.assumable === 'likely'
      },
      attomData: attomData,
      model: 'HouseYield-2',
      imagesAnalyzed: images.length
    });

  } catch (error) {
    console.error('[HouseYield-2] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Analysis failed'
    });
  }
});
// ==================== END HOUSEYIELD-2 ENDPOINT ====================

// ==================== FRED API ENDPOINTS ====================

// Historical Mortgage Rate - Get 30-year fixed rate for a specific date
app.get('/api/fred/mortgage-rate', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ ok: false, error: 'missing_date' });
    }
    
    const FRED_API_KEY = process.env.FRED_API_KEY;
    if (!FRED_API_KEY) {
      return res.status(500).json({ ok: false, error: 'FRED API key not configured' });
    }
    
    // Get 30-year fixed mortgage rate (MORTGAGE30US) near the specified date
    const targetDate = new Date(date);
    const startDate = new Date(targetDate);
    startDate.setDate(startDate.getDate() - 14); // Look back 2 weeks
    
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=MORTGAGE30US&api_key=${FRED_API_KEY}&file_type=json&observation_start=${startDate.toISOString().split('T')[0]}&observation_end=${date}&sort_order=desc&limit=1`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.observations && data.observations.length > 0) {
      const rate = parseFloat(data.observations[0].value);
      res.json({ 
        ok: true, 
        rate,
        date: data.observations[0].date,
        source: 'FRED MORTGAGE30US'
      });
    } else {
      res.status(404).json({ ok: false, error: 'Rate not found for date' });
    }
  } catch (error) {
    console.error('[FRED] /mortgage-rate error:', error);
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

function buildOkDataCachePayload(data, metadata = {}) {
  return { ok: true, data, ...metadata };
}

async function resolveFirestoreCachedPayload({
  cacheKey,
  forceRefresh = false,
  loadData,
  formatPayload = buildOkDataCachePayload,
}) {
  if (!forceRefresh) {
    const cached = await getCachedFredData(cacheKey).catch(() => null);
    if (cached && !cached.stale) {
      return formatPayload(cached.data, { cached: true, cachedAt: cached.updatedAt });
    }

    if (cached?.data) {
      try {
        const fresh = await loadData();
        setCachedFredData(cacheKey, fresh).catch((error) => console.warn(`[Cache] write error for ${cacheKey}:`, error.message));
        return formatPayload(fresh, { refreshedFromStaleCache: true, previousCachedAt: cached.updatedAt });
      } catch (refreshError) {
        console.warn(`[Cache] ${cacheKey} synchronous refresh failed:`, refreshError.message);
        return formatPayload(cached.data, { cached: true, stale: true, cachedAt: cached.updatedAt });
      }
    }
  }

  const data = await loadData();
  setCachedFredData(cacheKey, data).catch((error) => console.warn(`[Cache] write error for ${cacheKey}:`, error.message));
  return formatPayload(data);
}

// Housing Market Data - Combined overview and trends
app.get('/api/fred/housing-market', async (req, res) => {
  const cacheKey = 'housing-market';
  const forceRefresh = req.query.refresh === 'true';
  try {
    // Try Firestore cache first
    if (!forceRefresh) {
      const cached = await getCachedFredData(cacheKey);
      if (cached && !cached.stale) {
        return res.json({ ok: true, data: cached.data, cached: true, cachedAt: cached.updatedAt });
      }
      if (cached?.data) {
        try {
          const fresh = await getHousingMarketData();
          res.json({ ok: true, data: fresh, refreshedFromStaleCache: true, previousCachedAt: cached.updatedAt });
          setCachedFredData(cacheKey, fresh).catch(e => console.warn('[Cache] write error:', e.message));
          return;
        } catch (refreshError) {
          console.warn('[Cache] housing-market synchronous refresh failed:', refreshError.message);
          return res.json({ ok: true, data: cached.data, cached: true, stale: true, cachedAt: cached.updatedAt });
        }
      }
    }
    // Live fetch from FRED
    const data = await getHousingMarketData();
    res.json({ ok: true, data });
    // Store in Firestore asynchronously
    setCachedFredData(cacheKey, data).catch(e => console.warn('[Cache] write error:', e.message));
  } catch (error) {
    console.error('[FRED] /housing-market error:', error);
    // Last resort: try stale cache
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) {
      return res.json({ ok: true, data: stale.data, cached: true, stale: true, cachedAt: stale.updatedAt });
    }
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// Federal Reserve Meeting Summary - Latest FOMC insights
app.get('/api/fred/fed-meeting-summary', async (req, res) => {
  const cacheKey = 'fed-meeting';
  const forceRefresh = req.query.refresh === 'true';
  try {
    if (!forceRefresh) {
      const cached = await getCachedFredData(cacheKey);
      if (cached && !cached.stale) {
        return res.json({ ok: true, data: cached.data, cached: true, cachedAt: cached.updatedAt });
      }
      if (cached?.data) {
        try {
          const fresh = await getFedMeetingSummary();
          res.json({ ok: true, data: fresh, refreshedFromStaleCache: true, previousCachedAt: cached.updatedAt });
          setCachedFredData(cacheKey, fresh).catch(e => console.warn('[Cache] write error:', e.message));
          return;
        } catch (refreshError) {
          console.warn('[Cache] fed-meeting synchronous refresh failed:', refreshError.message);
          return res.json({ ok: true, data: cached.data, cached: true, stale: true, cachedAt: cached.updatedAt });
        }
      }
    }
    const data = await getFedMeetingSummary();
    res.json({ ok: true, data });
    setCachedFredData(cacheKey, data).catch(e => console.warn('[Cache] write error:', e.message));
  } catch (error) {
    console.error('[FRED] /fed-meeting-summary error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) return res.json({ ok: true, data: stale.data, cached: true, stale: true });
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// FOMC Meeting Calendar - upcoming meeting dates and context
app.get('/api/fred/fomc-calendar', async (req, res) => {
  const cacheKey = 'fomc-calendar';
  const forceRefresh = req.query.refresh === 'true';
  try {
    const payload = await resolveFirestoreCachedPayload({
      cacheKey,
      forceRefresh,
      loadData: async () => getFomcCalendar(),
    });
    res.json(payload);
  } catch (error) {
    console.error('[FRED] /fomc-calendar error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) return res.json({ ok: true, data: stale.data, cached: true, stale: true, cachedAt: stale.updatedAt });
    res.status(500).json({ ok: false, error: error.message || 'fomc_calendar_failed' });
  }
});

// Treasury Yields - Optimized for real estate investors
app.get('/api/fred/treasury-yields', async (req, res) => {
  const { days, startDate, endDate, refresh } = req.query;
  const cacheKey = `treasury-yields:${days || 365}`;
  const forceRefresh = refresh === 'true';
  try {
    if (!forceRefresh && !startDate && !endDate) {
      const cached = await getCachedFredData(cacheKey);
      if (cached && !cached.stale) {
        return res.json({ ok: true, data: cached.data, cached: true, cachedAt: cached.updatedAt });
      }
      if (cached?.data) {
        try {
          const fresh = await getTreasuryYields({ days: days ? parseInt(days) : undefined });
          res.json({ ok: true, data: fresh, refreshedFromStaleCache: true, previousCachedAt: cached.updatedAt });
          setCachedFredData(cacheKey, fresh).catch(e => console.warn('[Cache] write error:', e.message));
          return;
        } catch (refreshError) {
          console.warn('[Cache] treasury-yields synchronous refresh failed:', refreshError.message);
          return res.json({ ok: true, data: cached.data, cached: true, stale: true, cachedAt: cached.updatedAt });
        }
      }
    }
    const options = {};
    if (days) options.days = parseInt(days);
    if (startDate) options.startDate = startDate;
    if (endDate) options.endDate = endDate;
    const data = await getTreasuryYields(options);
    res.json({ ok: true, data });
    if (!startDate && !endDate) {
      setCachedFredData(cacheKey, data).catch(e => console.warn('[Cache] write error:', e.message));
    }
  } catch (error) {
    console.error('[FRED] /treasury-yields error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) return res.json({ ok: true, data: stale.data, cached: true, stale: true });
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// Additional Macroeconomic Indicators
app.get('/api/fred/macro-indicators', async (req, res) => {
  const cacheKey = 'macro-indicators:v2';
  const forceRefresh = req.query.refresh === 'true';
  try {
    if (!forceRefresh) {
      const cached = await getCachedFredData(cacheKey);
      if (cached && !cached.stale) {
        return res.json({ ok: true, data: cached.data, cached: true, cachedAt: cached.updatedAt });
      }
      if (cached?.data) {
        try {
          const fresh = await getAdditionalMacroData();
          res.json({ ok: true, data: fresh, refreshedFromStaleCache: true, previousCachedAt: cached.updatedAt });
          setCachedFredData(cacheKey, fresh).catch(e => console.warn('[Cache] write error:', e.message));
          return;
        } catch (refreshError) {
          console.warn('[Cache] macro-indicators synchronous refresh failed:', refreshError.message);
          return res.json({ ok: true, data: cached.data, cached: true, stale: true, cachedAt: cached.updatedAt });
        }
      }
    }
    const data = await getAdditionalMacroData();
    res.json({ ok: true, data });
    setCachedFredData(cacheKey, data).catch(e => console.warn('[Cache] write error:', e.message));
  } catch (error) {
    console.error('[FRED] /macro-indicators error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) return res.json({ ok: true, data: stale.data, cached: true, stale: true });
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// Regional Market Data - Top metro areas
app.get('/api/fred/regional-market', async (req, res) => {
  const cacheKey = 'regional-market';
  const forceRefresh = req.query.refresh === 'true';
  try {
    const payload = await resolveFirestoreCachedPayload({
      cacheKey,
      forceRefresh,
      loadData: getRegionalMarketData,
    });
    res.json(payload);
  } catch (error) {
    console.error('[FRED] /regional-market error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) return res.json({ ok: true, data: stale.data, cached: true, stale: true });
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// Search for regions
app.get('/api/fred/regions/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ ok: false, error: 'missing_query' });
    }
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = `regions-search:${String(q).trim().toLowerCase()}`;
    const payload = await resolveFirestoreCachedPayload({
      cacheKey,
      forceRefresh,
      loadData: () => searchRegions(q),
    });
    res.json(payload);
  } catch (error) {
    console.error('[FRED] /regions/search error:', error);
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// Get detailed regional data
app.get('/api/fred/regions/:regionCode', async (req, res) => {
  const { regionCode } = req.params;
  const cacheKey = `regional-detail:${regionCode}`;
  const forceRefresh = req.query.refresh === 'true';
  try {
    const payload = await resolveFirestoreCachedPayload({
      cacheKey,
      forceRefresh,
      loadData: () => getRegionalDetail(regionCode),
    });
    res.json(payload);
  } catch (error) {
    console.error('[FRED] /regions/:regionCode error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) return res.json({ ok: true, data: stale.data, cached: true, stale: true });
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// Get county FIPS from lat/lng coordinates (dynamic lookup)
app.get('/api/fred/county-lookup', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ ok: false, error: 'missing_coordinates' });
    }
    const data = await getCountyFipsFromCoords(parseFloat(lat), parseFloat(lng));
    if (!data) {
      return res.status(404).json({ ok: false, error: 'county_not_found' });
    }
    res.json({ ok: true, data });
  } catch (error) {
    console.error('[FRED] /county-lookup error:', error);
    res.status(500).json({ ok: false, error: error.message || 'lookup_failed' });
  }
});

// Get county-level economic data by FIPS code (dynamic - no hardcoding needed)

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestCbsa(lat, lng, stateCode) {
  const entries = Object.entries(CBSA_CATALOG || {});
  if (!entries.length) return null;

  const pickNearest = (catalogEntries) => {
    let nearest = null;
    for (const [cbsaCode, info] of catalogEntries) {
      if (!Number.isFinite(info?.lat) || !Number.isFinite(info?.lng)) continue;
      const distanceMiles = haversineMiles(lat, lng, info.lat, info.lng);
      if (!nearest || distanceMiles < nearest.distanceMiles) {
        nearest = { cbsaCode, cbsaName: info.n, distanceMiles };
      }
    }
    return nearest;
  };

  const sameStateEntries = stateCode
    ? entries.filter(([, info]) => info?.st === stateCode)
    : [];

  const nearest = pickNearest(sameStateEntries.length ? sameStateEntries : entries);
  if (!nearest || nearest.distanceMiles > 90) {
    return null;
  }

  return nearest;
}
app.get('/api/fred/county/:fips', async (req, res) => {
  const { fips } = req.params;
  const { name } = req.query; // Optional county name for logging
  const forceRefresh = req.query.refresh === 'true';
  const cacheKey = `county-data:${fips}`;
  try {
    if (!fips || fips.length !== 5) {
      return res.status(400).json({ ok: false, error: 'invalid_fips_code' });
    }

    const payload = await resolveFirestoreCachedPayload({
      cacheKey,
      forceRefresh,
      loadData: () => getCountyData(fips, name || 'Unknown'),
    });
    res.json(payload);
  } catch (error) {
    console.error('[FRED] /county/:fips error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) return res.json({ ok: true, data: stale.data, cached: true, stale: true, cachedAt: stale.updatedAt });
    res.status(500).json({ ok: false, error: error.message || 'county_data_failed' });
  }
});

// Get county data from coordinates (combines lookup + data fetch + ZIP code detection)
app.get('/api/fred/county-by-coords', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';
  try {
    const { lat, lng, zipCode } = req.query;
    const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
    let resolvedLat = lat ? parseFloat(lat) : null;
    let resolvedLng = lng ? parseFloat(lng) : null;
    let resolvedZipCode = typeof zipCode === 'string' && /^\d{5}$/.test(zipCode) ? zipCode : null;
    const locationKey = resolvedZipCode
      ? `county-by-coords:zip:${resolvedZipCode}`
      : Number.isFinite(resolvedLat) && Number.isFinite(resolvedLng)
        ? `county-by-coords:${resolvedLat.toFixed(3)}:${resolvedLng.toFixed(3)}`
        : null;

    const loadCountyByCoordsPayload = async () => {
      let nextLat = resolvedLat;
      let nextLng = resolvedLng;
      let nextZipCode = resolvedZipCode;

      if ((!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) && nextZipCode) {
        if (!GOOGLE_MAPS_KEY) {
          throw new Error('zip_lookup_unavailable');
        }

        const zipLookup = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${nextZipCode}&key=${GOOGLE_MAPS_KEY}&components=country:US|postal_code:${nextZipCode}`)
          .then((r) => r.json())
          .catch(() => null);

        const zipResult = zipLookup?.results?.[0];
        const zipLocation = zipResult?.geometry?.location;
        if (!zipLocation || typeof zipLocation.lat !== 'number' || typeof zipLocation.lng !== 'number') {
          throw new Error('zip_not_found');
        }

        nextLat = zipLocation.lat;
        nextLng = zipLocation.lng;
      }

      if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) {
        throw new Error('missing_coordinates');
      }

      const [countyResult, zipResult] = await Promise.allSettled([
        getCountyFipsFromCoords(nextLat, nextLng),
        GOOGLE_MAPS_KEY
          ? fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${nextLat},${nextLng}&key=${GOOGLE_MAPS_KEY}&result_type=postal_code`)
              .then(r => r.json())
              .catch(() => null)
          : Promise.resolve(null),
      ]);

      const countyInfo = countyResult.status === 'fulfilled' ? countyResult.value : null;
      if (!countyInfo) {
        throw new Error('county_not_found');
      }

      let detectedZipCode = nextZipCode;
      if (zipResult.status === 'fulfilled' && zipResult.value?.results?.length) {
        for (const gResult of zipResult.value.results) {
          const postalComp = gResult.address_components?.find((c) => c.types?.includes('postal_code'));
          if (postalComp) {
            detectedZipCode = postalComp.short_name;
            break;
          }
        }
      }

      const nearestCbsa = findNearestCbsa(nextLat, nextLng, countyInfo.stateCode);
      const countyData = await getCountyData(countyInfo.countyFips, countyInfo.countyName);

      return {
        lat: nextLat,
        lng: nextLng,
        zipCode: detectedZipCode,
        fips: countyInfo.countyFips,
        countyName: countyInfo.countyName,
        state: countyInfo.stateName,
        stateCode: countyInfo.stateCode,
        stateName: countyInfo.stateName,
        cbsaCode: nearestCbsa?.cbsaCode || null,
        cbsaName: nearestCbsa?.cbsaName || null,
        data: {
          ...countyData,
          cbsaCode: nearestCbsa?.cbsaCode || null,
          cbsaName: nearestCbsa?.cbsaName || null,
          stateCode: countyInfo.stateCode,
          stateName: countyInfo.stateName,
        },
      };
    };

    if (locationKey && !forceRefresh) {
      const cached = await getCachedFredData(locationKey).catch(() => null);
      if (cached && !cached.stale) {
        return res.json({ ok: true, ...cached.data, cached: true, cachedAt: cached.updatedAt });
      }

      if (cached?.data) {
        try {
          const fresh = await loadCountyByCoordsPayload();
          setCachedFredData(locationKey, fresh).catch((error) => console.warn(`[Cache] write error for ${locationKey}:`, error.message));
          return res.json({ ok: true, ...fresh, refreshedFromStaleCache: true, previousCachedAt: cached.updatedAt });
        } catch (refreshError) {
          console.warn(`[Cache] ${locationKey} synchronous refresh failed:`, refreshError.message);
          return res.json({ ok: true, ...cached.data, cached: true, stale: true, cachedAt: cached.updatedAt });
        }
      }
    }

    const payload = await loadCountyByCoordsPayload();
    if (locationKey) {
      setCachedFredData(locationKey, payload).catch((error) => console.warn(`[Cache] write error for ${locationKey}:`, error.message));
    }
    res.json({ ok: true, ...payload });
  } catch (error) {
    console.error('[FRED] /county-by-coords error:', error);
    const status = error.message === 'missing_coordinates'
      ? 400
      : error.message === 'zip_not_found' || error.message === 'county_not_found'
        ? 404
        : error.message === 'zip_lookup_unavailable'
          ? 503
          : 500;
    res.status(status).json({ ok: false, error: error.message || 'county_data_failed' });
  }
});

// Heat map data - metric growth across all metros
app.get('/api/fred/heat-map', async (req, res) => {
  const metric = req.query.metric || 'housing';
  const cacheKey = `heat-map:${metric}`;
  const forceRefresh = req.query.refresh === 'true';
  try {
    if (forceRefresh) {
      clearHeatMapMemoryCache(metric);          // also clear in-memory cache
    }
    const payload = await resolveFirestoreCachedPayload({
      cacheKey,
      forceRefresh,
      loadData: () => getHeatMapData(metric),
    });
    res.json(payload);
  } catch (error) {
    console.error('[FRED] /heat-map error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) return res.json({ ok: true, data: stale.data, cached: true, stale: true });
    res.status(500).json({ ok: false, error: error.message || 'heat_map_failed' });
  }
});

// Metro history – time-series data for a single metro's economic metrics
app.get('/api/fred/metro-history', async (req, res) => {
  const { cbsa } = req.query;
  if (!cbsa) return res.status(400).json({ ok: false, error: 'missing_cbsa', hint: 'Pass ?cbsa=12060' });
  const cacheKey = `metro-history:${cbsa}`;
  const forceRefresh = req.query.refresh === 'true';
  try {
    const payload = await resolveFirestoreCachedPayload({
      cacheKey,
      forceRefresh,
      loadData: () => getMetroHistory(cbsa),
    });
    res.json(payload);
  } catch (error) {
    console.error('[FRED] /metro-history error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) return res.json({ ok: true, data: stale.data, cached: true, stale: true });
    res.status(500).json({ ok: false, error: error.message || 'metro_history_failed' });
  }
});

app.get('/api/rentcast/markets', async (req, res) => {
  const { zipCode } = req.query;
  if (!zipCode) {
    return res.status(400).json({ ok: false, error: 'missing_zip_code' });
  }

  const cacheKey = `rentcast-market:${String(zipCode).trim()}`;
  const forceRefresh = req.query.refresh === 'true';

  try {
    const payload = await resolveFirestoreCachedPayload({
      cacheKey,
      forceRefresh,
      loadData: () => getZipMarketData(zipCode),
    });
    res.json(payload);
  } catch (error) {
    console.error('[RentCast] /markets error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) {
      return res.json({ ok: true, data: stale.data, cached: true, stale: true });
    }

    const message = error.message || 'rentcast_failed';
    const status = message === 'missing_zip_code' || message === 'invalid_zip_code'
      ? 400
      : message === 'zip_market_not_found'
        ? 404
        : message === 'rentcast_not_configured'
          ? 503
          : 500;

    res.status(status).json({ ok: false, error: message });
  }
});

app.get('/api/rentcast/metro-zips', async (req, res) => {
  const metro = String(req.query.metro || '').trim();
  if (!metro) {
    return res.status(400).json({ ok: false, error: 'missing_metro_identifier' });
  }

  const cacheKey = `rentcast-metro-zips:${metro.toLowerCase()}`;
  const forceRefresh = req.query.refresh === 'true';

  try {
    const payload = await resolveFirestoreCachedPayload({
      cacheKey,
      forceRefresh,
      loadData: () => getMetroZipMarketData(metro),
    });
    res.json(payload);
  } catch (error) {
    console.error('[RentCast] /metro-zips error:', error);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) {
      return res.json({ ok: true, data: stale.data, cached: true, stale: true });
    }

    const message = error.message || 'rentcast_metro_zip_failed';
    const status = message === 'missing_metro_identifier'
      ? 400
      : message === 'metro_zip_market_not_supported'
        ? 404
        : message === 'rentcast_not_configured'
          ? 503
          : 500;

    res.status(status).json({ ok: false, error: message });
  }
});

// RentCast: ZIP radius market data — finds nearby ZIPs from metro profiles
app.get('/api/rentcast/zip-radius', async (req, res) => {
  try {
    const { lat, lng, radiusMiles } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ ok: false, error: 'missing lat and lng query params' });
    }
    const forceRefresh = req.query.refresh === 'true';
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    const parsedRadius = radiusMiles ? parseFloat(radiusMiles) : 10;
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      return res.status(400).json({ ok: false, error: 'invalid_coordinates' });
    }

    const cacheKey = `rentcast-zip-radius:${parsedLat.toFixed(3)}:${parsedLng.toFixed(3)}:${parsedRadius.toFixed(1)}`;
    const payload = await resolveFirestoreCachedPayload({
      cacheKey,
      forceRefresh,
      loadData: () => getZipRadiusMarkets(parsedLat, parsedLng, parsedRadius),
      formatPayload: (data, metadata = {}) => ({ ...data, ...metadata }),
    });
    res.json(payload);
  } catch (error) {
    console.error('[RentCast] /zip-radius error:', error);
    res.status(500).json({ ok: false, error: error.message || 'zip_radius_failed' });
  }
});

// Search for series
app.get('/api/fred/series/search', async (req, res) => {
  try {
    const { q, limit } = req.query;
    if (!q) {
      return res.status(400).json({ ok: false, error: 'missing_query' });
    }
    const data = await searchSeries(q, limit ? parseInt(limit) : 10);
    res.json({ ok: true, data });
  } catch (error) {
    console.error('[FRED] /series/search error:', error);
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// ── FRED Cache Admin Endpoints ──

// List all cached FRED data with staleness info
app.get('/api/fred/cache/status', async (req, res) => {
  try {
    const entries = await listFredCache();
    res.json({ ok: true, entries, count: entries.length });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Force-refresh a specific cache key (e.g. ?key=housing-market)
app.post('/api/fred/cache/refresh', async (req, res) => {
  const key = req.query.key || req.body?.key;
  if (!key) {
    return res.status(400).json({ ok: false, error: 'missing_key', hint: 'Pass ?key=housing-market or heat-map:housing' });
  }
  try {
    // Invalidate the cache entry first
    await invalidateFredCache(key);
    
    // Trigger a live fetch for known keys
    let data = null;
    if (key === 'housing-market') {
      data = await getHousingMarketData();
    } else if (key === 'regional-market') {
      data = await getRegionalMarketData();
    } else if (key.startsWith('treasury-yields')) {
      data = await getTreasuryYields({});
    } else if (key.startsWith('heat-map:')) {
      const metric = key.split(':')[1] || 'housing';
      data = await getHeatMapData(metric);
    } else if (key.startsWith('regional-detail:')) {
      const regionCode = key.split(':')[1];
      data = await getRegionalDetail(regionCode);
    } else if (key === 'fed-meeting') {
      data = await getFedMeetingSummary();
    }
    
    if (data) {
      await setCachedFredData(key, data);
      res.json({ ok: true, message: `Refreshed and cached "${key}"`, data });
    } else {
      res.json({ ok: true, message: `Invalidated "${key}" — will refetch on next request` });
    }
  } catch (error) {
    console.error('[FRED Cache] Refresh error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Refresh ALL cached data (useful after new data releases)
app.post('/api/fred/cache/refresh-all', async (req, res) => {
  try {
    const keys = ['housing-market', 'regional-market', 'treasury-yields:365', 'fed-meeting', 'macro-indicators'];
    const metrics = ['housing', 'unemployment', 'income', 'wages', 'permits', 'listings', 'gdp'];
    metrics.forEach(m => keys.push(`heat-map:${m}`));
    
    const results = [];
    for (const key of keys) {
      try {
        await invalidateFredCache(key);
        let data = null;
        if (key === 'housing-market') data = await getHousingMarketData();
        else if (key === 'regional-market') data = await getRegionalMarketData();
        else if (key.startsWith('treasury-yields')) data = await getTreasuryYields({});
        else if (key.startsWith('heat-map:')) data = await getHeatMapData(key.split(':')[1]);
        else if (key === 'fed-meeting') data = await getFedMeetingSummary();
        else if (key === 'macro-indicators') data = await getAdditionalMacroData();

        if (data) {
          await setCachedFredData(key, data);
          results.push({ key, status: 'refreshed' });
        }
      } catch (err) {
        results.push({ key, status: 'failed', error: err.message });
      }
    }
    res.json({ ok: true, results });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Clear all cached FRED data
app.delete('/api/fred/cache', async (req, res) => {
  try {
    const count = await clearFredCache();
    res.json({ ok: true, message: `Cleared ${count} cached entries` });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get series observations
app.get('/api/fred/series/:seriesId/observations', async (req, res) => {
  try {
    const { seriesId } = req.params;
    const { limit } = req.query;
    const data = await getSeriesObservations(seriesId, limit ? parseInt(limit) : 100);
    res.json({ ok: true, data });
  } catch (error) {
    console.error('[FRED] /series/observations error:', error);
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// Get series info
app.get('/api/fred/series/:seriesId', async (req, res) => {
  try {
    const { seriesId } = req.params;
    const data = await getSeriesInfo(seriesId);
    res.json({ ok: true, data });
  } catch (error) {
    console.error('[FRED] /series info error:', error);
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// Get all releases
app.get('/api/fred/releases', async (req, res) => {
  try {
    const data = await getReleases();
    res.json({ ok: true, data });
  } catch (error) {
    console.error('[FRED] /releases error:', error);
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// Get category
app.get('/api/fred/category/:categoryId?', async (req, res) => {
  try {
    const categoryId = req.params.categoryId ? parseInt(req.params.categoryId) : 0;
    const data = await getCategory(categoryId);
    res.json({ ok: true, data });
  } catch (error) {
    console.error('[FRED] /category error:', error);
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});

// Get category series
app.get('/api/fred/category/:categoryId/series', async (req, res) => {
  try {
    const categoryId = parseInt(req.params.categoryId);
    if (isNaN(categoryId)) {
      return res.status(400).json({ ok: false, error: 'invalid_category_id' });
    }
    const data = await getCategorySeries(categoryId);
    res.json({ ok: true, data });
  } catch (error) {
    console.error('[FRED] /category/series error:', error);
    res.status(500).json({ ok: false, error: error.message || 'fred_failed' });
  }
});
// ==================== END FRED API ENDPOINTS ====================

// ==================== NATIVE BOOKKEEPING API ENDPOINTS ====================
// Native bookkeeping system - always available, no external accounts required
app.use('/api/bookkeeping', bookkeepingRouter);
console.log('✅ [Bookkeeping] Native API endpoints mounted at /api/bookkeeping');

// Firestore bookkeeping (per-user, production-ready)
if (bookkeepingFirestoreRouter) {
  app.use('/api/bookkeeping/firestore', bookkeepingFirestoreRouter);
  console.log('✅ [Bookkeeping Firestore] API endpoints mounted at /api/bookkeeping/firestore');
}

app.use('/api/voice-identity', voiceIdentityRouter);
console.log('✅ [Voice Identity] Endpoints mounted at /api/voice-identity');

app.use('/api/assistant', assistantContextRouter);
console.log('✅ [Assistant Context] Endpoints mounted at /api/assistant');

try {
  const financeAuditAssistantModule = await import('./finance-audit-assistant.js');
  app.use('/api/finance-audit', financeAuditAssistantModule.default);
  console.log('✅ [Finance Audit Assistant] Endpoints mounted at /api/finance-audit');
} catch (error) {
  console.warn('⚠️  [Finance Audit Assistant] Routes not available:', error.message);
}

try {
  const sensorInsightsModule = await import('./routes/sensor-insights.js');
  app.use('/api/sensor-insights', sensorInsightsModule.default);
  console.log('✅ [Sensor Insights] Endpoints mounted at /api/sensor-insights');
} catch (error) {
  console.warn('⚠️  [Sensor Insights] Routes not available:', error.message);
}

try {
  const maintenancePaymentsModule = await import('./routes/maintenancePayments.js');
  app.use('/api/maintenance/payments', maintenancePaymentsModule.default);
  console.log('✅ [Maintenance Payments] API endpoints mounted at /api/maintenance/payments');
} catch (error) {
  console.warn('⚠️  [Maintenance Payments] Routes not available:', error.message);
}

// Mounted before the scheduler router so /api/maintenance/ops/* is not shadowed.
try {
  const maintenanceOpsModule = await import('./routes/maintenanceOps.js');
  app.use('/api/maintenance/ops', maintenanceOpsModule.default);
  console.log('✅ [Maintenance Ops] Staff console endpoints mounted at /api/maintenance/ops');
} catch (error) {
  console.warn('⚠️  [Maintenance Ops] Routes not available:', error.message);
}

try {
  const maintenanceSchedulerModule = await import('./routes/maintenanceScheduler.js');
  app.use('/api/maintenance', maintenanceSchedulerModule.default);
  console.log('✅ [Maintenance Scheduler] API endpoints mounted at /api/maintenance');
} catch (error) {
  console.warn('⚠️  [Maintenance Scheduler] Routes not available:', error.message);
}
// ==================== END NATIVE BOOKKEEPING ENDPOINTS ====================

// ==================== OWNER ONBOARDING + SUBSCRIPTION ENDPOINTS ====================
try {
  const onboardingModule = await import('./routes/onboarding.js');
  app.use('/api/onboarding', onboardingModule.default);
  console.log('✅ [Onboarding] Owner onboarding endpoints mounted at /api/onboarding');
} catch (error) {
  console.warn('⚠️  [Onboarding] Routes not available:', error.message);
}

try {
  const subscriptionsModule = await import('./routes/subscriptions.js');
  app.use('/api/subscriptions', subscriptionsModule.default);
  console.log('✅ [Subscriptions] Platform billing endpoints mounted at /api/subscriptions');
} catch (error) {
  console.warn('⚠️  [Subscriptions] Routes not available:', error.message);
}
// ==================== END ONBOARDING + SUBSCRIPTION ENDPOINTS ====================

// ==================== AI FINANCIAL PLANNER ENDPOINTS ====================
app.use('/api/ai-financial-planner', aiFinancialPlannerRouter);
console.log('✅ [AI Financial Planner] Endpoints mounted at /api/ai-financial-planner');

// ==================== MARKET ANALYSIS ENDPOINTS ====================
app.use('/api', marketAnalysisRouter);
console.log('✅ [Market Analysis] Endpoints mounted at /api/market, /api/regional, /api/my-region');
// ==================== END AI FINANCIAL PLANNER ENDPOINTS ====================

// ==================== DEAL ANALYSIS ENGINE (v2) ====================
try {
  const analysisEngineModule = await import('./routes/analysisEngine.js');
  app.use('/api/v2', analysisEngineModule.default);
  console.log('✅ [Deal Engine v2] Endpoints mounted at /api/v2 (analysis, screener, coverage, flags, streetview)');
} catch (err) {
  console.error('❌ [Deal Engine v2] Failed to mount:', err.message);
}
// ==================== END DEAL ANALYSIS ENGINE ====================

// ==================== IOT SENSORS & INSURANCE INTEGRATION ====================
// IoT sensor monitoring and insurance discount submission system
let iotInsuranceRouter = null;
try {
  const iotModule = await import('./iot-insurance.js');
  iotInsuranceRouter = iotModule.default;
  console.log('✅ [IoT Insurance] Sensor monitoring and insurance discount endpoints loaded');
} catch (error) {
  console.warn('⚠️  [IoT Insurance] IoT module not available:', error.message);
}

if (iotInsuranceRouter) {
  app.use(iotInsuranceRouter);
  console.log('✅ [IoT Insurance] Endpoints mounted');
  
  // Mount Shelly OAuth routes
  try {
    const shellyOAuthModule = await import('./routes/shelly-oauth.js');
    app.use(shellyOAuthModule.default);
    console.log('✅ [Shelly OAuth] Customer self-service connection endpoints loaded');
  } catch (error) {
    console.warn('⚠️  [Shelly OAuth] OAuth routes not available:', error.message);
  }
  
  // Start Shelly device polling if configured (Cloud-based)
  try {
    const shellyPollerModule = await import('./services/shellyPoller.js');
    const shellyPoller = shellyPollerModule.default;
    const shellyCloudEnabled = process.env.SHELLY_CLOUD_ENABLED !== 'false';
    
    if (shellyCloudEnabled && process.env.SHELLY_CLOUD_AUTH_KEY) {
      // Register alert callback to store in mockAlerts
      shellyPoller.onAlert((alert) => {
        console.log('📥 Alert from poller:', alert);
        // You can push to a database or in-memory array here
      });
      
      shellyPoller.start(30); // Poll every 30 seconds
      console.log('✅ [Shelly] Device polling started');
    } else if (!shellyCloudEnabled) {
      console.log('ℹ️  [Shelly] Polling not started - Shelly Cloud disabled');
    } else {
      console.log('ℹ️  [Shelly] Polling not started - SHELLY_CLOUD_AUTH_KEY not set');
    }
  } catch (error) {
    console.log('ℹ️  [Shelly] Poller not available:', error.message);
  }

  // Mount Shelly Direct Integration routes (no cloud required)
  try {
    const shellyDirectModule = await import('./routes/shellyDirect.js');
    const waterShutoffModule = await import('./services/waterShutoffAutomation.js');
    if (typeof shellyDirectModule.setSensorMaintenanceDispatchHandler === 'function') {
      shellyDirectModule.setSensorMaintenanceDispatchHandler(dispatchOwnerMaintenanceFromSensorAlert);
    }
    if (typeof waterShutoffModule.setSensorMaintenanceDispatchHandler === 'function') {
      waterShutoffModule.setSensorMaintenanceDispatchHandler(dispatchOwnerMaintenanceFromSensorAlert);
    }
    app.use('/api/shelly', shellyDirectModule.default);
    console.log('✅ [Shelly Direct] Local/WebSocket/MQTT integration endpoints loaded');
  } catch (error) {
    console.warn('⚠️  [Shelly Direct] Direct integration routes not available:', error.message);
  }

  try {
    const propertyWeatherModule = await import('./routes/propertyWeather.js');
    app.use('/api/property-weather', propertyWeatherModule.default);
    console.log('✅ [Property Weather] Extreme weather assessment endpoints loaded');
  } catch (error) {
    console.warn('⚠️  [Property Weather] Routes not available:', error.message);
  }

} else {
  // Fallback endpoints if IoT module not available
  app.get('/api/iot/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'iot_not_configured',
      message: 'IoT sensor system is not configured.'
    });
  });
  app.get('/api/insurance/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'insurance_not_configured',
      message: 'Insurance integration is not configured.'
    });
  });

  app.get('/api/rentcast/supported-metros', async (_req, res) => {
    try {
      const data = getSupportedMetroZipProfilesSummary();
      res.json({ ok: true, data });
    } catch (error) {
      console.error('[RentCast] /supported-metros error:', error);
      res.status(500).json({ ok: false, error: error.message || 'rentcast_supported_metros_failed' });
    }
  });
}
// ==================== END IOT INSURANCE ENDPOINTS ====================

// ==================== PLAID BANK INTEGRATION ENDPOINTS ====================
// Plaid integration - auto-populate bookkeeping from connected bank accounts
if (plaidRouter) {
  app.use('/api/plaid', plaidRouter);
  console.log('✅ [Plaid] Bank integration endpoints mounted at /api/plaid');
} else {
  // Fallback endpoints if Plaid module not available
  app.get('/api/plaid/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'plaid_not_configured',
      message: 'Plaid bank integration is not configured.'
    });
  });
}
// ==================== END PLAID ENDPOINTS ====================

// ==================== STRIPE CONNECT PAYMENT ENDPOINTS ====================
// Stripe Connect - landlord-tenant payment processing with bank accounts
if (stripeConnectRouter) {
  app.use('/api/stripe-connect', stripeConnectRouter);
  console.log('✅ [Stripe Connect] Payment endpoints mounted at /api/stripe-connect');
} else {
  app.get('/api/stripe-connect/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'stripe_connect_not_configured',
      message: 'Stripe Connect payment system is not configured.'
    });
  });
}
// ==================== END STRIPE CONNECT ENDPOINTS ====================

// ==================== 3D ROOM SCANNER ENDPOINTS ====================
// Room Scanner - 3D room capture with Luma AI, DepthPro, and OpenAI guidance
if (roomScannerRouter) {
  app.use('/api/room-scanner', roomScannerRouter);
  console.log('✅ [Room Scanner] 3D scanning endpoints mounted at /api/room-scanner');
} else {
  app.use('/api/room-scanner/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'room_scanner_not_configured',
      message: 'Room scanner module is not configured.'
    });
  });
}
// ==================== END ROOM SCANNER ENDPOINTS ====================

// ==================== IMAGE STITCHING ENDPOINTS ====================
// Image Stitching - OpenCV panorama stitching for 26-photo spherical scans
if (imageStitchingRouter) {
  app.use('/api/image-stitching', imageStitchingRouter);
  console.log('✅ [Image Stitching] Panorama stitching endpoints mounted at /api/image-stitching');
} else {
  app.use('/api/image-stitching/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'image_stitching_not_configured',
      message: 'Image stitching module is not configured.'
    });
  });
}
// ==================== END IMAGE STITCHING ENDPOINTS ====================

// ==================== ROOM TOUR ENDPOINTS ====================
// Room Tours - video-first 3D home tours with Gaussian splats
if (roomToursRouter) {
  app.use('/api/room-tours', roomToursRouter);
  console.log('✅ [Room Tours] Room tour endpoints mounted at /api/room-tours');
} else {
  app.use('/api/room-tours/*', (req, res) => {
    res.status(503).json({
      ok: false,
      error: 'room_tours_not_configured',
      message: 'Room tour pipeline is not configured.',
    });
  });
}
// ==================== END ROOM TOUR ENDPOINTS ====================

// ==================== MASTER RECONSTRUCTION ENDPOINTS ====================
// Master Reconstruction - canonical mesh-first editable GLB pipeline
if (masterReconstructionRouter) {
  app.use('/api/master-reconstruction', masterReconstructionRouter);
  console.log('✅ [Master Reconstruction] Canonical endpoints mounted at /api/master-reconstruction');
} else {
  app.use('/api/master-reconstruction/*', (req, res) => {
    res.status(503).json({
      ok: false,
      error: 'master_reconstruction_not_configured',
      message: 'The master_v1 reconstruction pipeline is not configured.',
    });
  });
}
// ==================== END MASTER RECONSTRUCTION ENDPOINTS ====================

// ==================== PHOTOGRAMMETRY ENDPOINTS ====================
// Photogrammetry - 3D mesh reconstruction from multi-view photos
if (photogrammetryRouter) {
  app.use('/api/photogrammetry', photogrammetryRouter);
  console.log('✅ [Photogrammetry] 3D mesh reconstruction endpoints mounted at /api/photogrammetry');
} else {
  app.use('/api/photogrammetry/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'photogrammetry_not_configured',
      message: 'Photogrammetry pipeline is not configured.'
    });
  });
}
// ==================== END PHOTOGRAMMETRY ENDPOINTS ====================

// ==================== RENOVATION DETECTION ENDPOINTS ====================
// AI-powered renovation detection from 3D scans
if (renovationDetectionRouter) {
  app.use('/api/renovation', renovationDetectionRouter);
  console.log('✅ [Renovation Detection] AI renovation endpoints mounted at /api/renovation');
} else {
  app.use('/api/renovation/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'renovation_detection_not_configured',
      message: 'Renovation detection system is not configured.'
    });
  });
}

// Live Renovation Scanner (Real-time AI-guided renovation assessment)
if (liveRenovationRouter) {
  app.use('/api/renovation', liveRenovationRouter);
  console.log('✅ [Live Renovation] Real-time renovation scanner endpoints mounted at /api/renovation');
}
// ==================== END RENOVATION DETECTION ENDPOINTS ====================

// ==================== CALIBRATION ENDPOINTS ====================
// AI-powered mesh calibration for accurate measurements
if (calibrationRouter) {
  app.use('/api/calibration', calibrationRouter);
  console.log('✅ [Calibration] Mesh calibration endpoints mounted at /api/calibration');
} else {
  app.use('/api/calibration/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'calibration_not_configured',
      message: 'Calibration system is not configured.'
    });
  });
}
// ==================== END CALIBRATION ENDPOINTS ====================

// ==================== RENOVATION PREVIEW ENDPOINTS ====================
// Gemini-powered renovation visualization
if (renovationPreviewRouter) {
  app.use('/api/renovation-preview', renovationPreviewRouter);
  console.log('✅ [Renovation Preview] Endpoints mounted at /api/renovation-preview');
} else {
  app.use('/api/renovation-preview/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'renovation_preview_not_configured',
      message: 'Renovation preview system is not configured.'
    });
  });
}
// ==================== END RENOVATION PREVIEW ENDPOINTS ====================

// ==================== MESH EDITOR ENDPOINTS ====================
// Open3D/Trimesh for furniture removal, CSG operations, mesh repair
if (meshEditorRouter) {
  app.use('/api/mesh-editor', meshEditorRouter);
  console.log('✅ [Mesh Editor] Endpoints mounted at /api/mesh-editor');
} else {
  app.use('/api/mesh-editor/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'mesh_editor_not_configured',
      message: 'Mesh editor system is not configured.'
    });
  });
}
// ==================== END MESH EDITOR ENDPOINTS ====================

// ==================== MESH SEGMENTATION ENDPOINTS ====================
// Trimesh + AI for segmenting meshes into floor/walls/ceiling/countertops
if (meshSegmentationRouter) {
  app.use('/api/mesh', meshSegmentationRouter);
  console.log('✅ [Mesh Segmentation] Endpoints mounted at /api/mesh');
} else {
  app.use('/api/mesh/segment*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'mesh_segmentation_not_configured',
      message: 'Mesh segmentation requires trimesh Python package.'
    });
  });
}
// ==================== END MESH SEGMENTATION ENDPOINTS ====================

// ==================== MESH PREPROCESSING ENDPOINTS ====================
// Fix photogrammetry scans before Meshy AI (normals, decimation, holes, degenerates)
if (meshPreprocessingRouter) {
  app.use('/api/mesh/preprocess', meshPreprocessingRouter);
  console.log('✅ [Mesh Preprocessing] Endpoints mounted at /api/mesh/preprocess');
} else {
  app.use('/api/mesh/preprocess*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'mesh_preprocessing_not_configured',
      message: 'Mesh preprocessing requires trimesh Python package. Run: pip install trimesh[all]'
    });
  });
}
// ==================== END MESH PREPROCESSING ENDPOINTS ====================

// ==================== SEAMLESS TEXTURE GENERATION ENDPOINTS ====================
// Gemini Nano Banana Pro for seamless tileable texture generation
if (seamlessTextureRouter) {
  app.use('/api/seamless-textures', seamlessTextureRouter);
  console.log('✅ [Seamless Texture] Endpoints mounted at /api/seamless-textures');
}
// ==================== END SEAMLESS TEXTURE GENERATION ENDPOINTS ====================

// ==================== FLOOR OVERLAY GENERATION ENDPOINTS ====================
// Gemini + Meshy Image-to-3D for simple floor renovation
if (floorOverlayRouter) {
  app.use('/api/floor-overlay', floorOverlayRouter);
  console.log('✅ [Floor Overlay] Endpoints mounted at /api/floor-overlay');
}
// ==================== END FLOOR OVERLAY GENERATION ENDPOINTS ====================

// ==================== AI TEXTURE GENERATION ENDPOINTS ====================
// Gemini Nano Banana for 3D mesh texture generation
if (aiTextureRouter) {
  app.use('/api/textures', aiTextureRouter);
  console.log('✅ [AI Texture] 3D texture generation endpoints mounted at /api/textures');
} else {
  app.use('/api/textures/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'ai_texture_not_configured',
      message: 'AI texture generation system is not configured.'
    });
  });
}
// ==================== END AI TEXTURE GENERATION ENDPOINTS ====================

// ==================== MESHY AI RETEXTURE ENDPOINTS ====================
// Meshy AI for mesh retexturing (apply new textures like hardwood to 3D scans)
if (meshyRetextureRouter) {
  app.use('/api/meshy', meshyRetextureRouter);
  console.log('✅ [Meshy Retexture] AI mesh retexturing endpoints mounted at /api/meshy');
} else {
  app.use('/api/meshy/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'meshy_retexture_not_configured',
      message: 'Meshy AI retexturing is not configured. Set Meshy_API_Key in .env'
    });
  });
}
// ==================== END MESHY AI RETEXTURE ENDPOINTS ====================

// ==================== MESHY TEXT-TO-3D ENDPOINTS ====================
// Meshy AI for generating 3D objects from text prompts (furniture, fixtures, etc.)
if (meshyTextTo3DRouter) {
  app.use('/api/meshy/text-to-3d', meshyTextTo3DRouter);
  console.log('✅ [Meshy Text-to-3D] AI 3D object generation endpoints mounted at /api/meshy/text-to-3d');
}
// ==================== END MESHY TEXT-TO-3D ENDPOINTS ====================

// ==================== MESHY IMAGE-TO-3D ENDPOINTS ====================
// Meshy AI for generating 3D objects from viewport captures (look at something, recreate it)
if (meshyImageTo3DRouter) {
  app.use('/api/meshy/image-to-3d', meshyImageTo3DRouter);
  console.log('✅ [Meshy Image-to-3D] Viewport capture to 3D endpoints mounted at /api/meshy/image-to-3d');
}
// ==================== END MESHY IMAGE-TO-3D ENDPOINTS ====================

// ==================== MESHY TEXT-TO-IMAGE ENDPOINTS ====================
// Meshy AI Text-to-Image with Nano Banana Pro for generating concept images
if (meshyTextToImageRouter) {
  app.use('/api/meshy/text-to-image', meshyTextToImageRouter);
  console.log('✅ [Meshy Text-to-Image] Nano Banana Pro concept generation mounted at /api/meshy/text-to-image');
}
// ==================== END MESHY TEXT-TO-IMAGE ENDPOINTS ====================

// ==================== RENOVATION PLANNER ENDPOINTS ====================
// Professional renovation planning with room context, dimensions, and cost estimation
if (renovationPlannerRouter) {
  app.use('/api/renovation-planner', renovationPlannerRouter);
  console.log('✅ [Renovation Planner] Endpoints mounted at /api/renovation-planner');
}
// ==================== END RENOVATION PLANNER ENDPOINTS ====================

// ==================== CONTRACTOR MARKETPLACE SERVICES ====================
if (dunsVerificationRouter) {
  app.use('/api/duns', dunsVerificationRouter);
  console.log('✅ [DUNS] Endpoints mounted at /api/duns');
}
if (bidAnalysisRouter) {
  app.use('/api/bid-analysis', bidAnalysisRouter);
  console.log('✅ [BidAnalysis] Endpoints mounted at /api/bid-analysis');
}
if (listingAIRouter) {
  app.use('/api/listing-ai', listingAIRouter);
  console.log('✅ [ListingAI] Endpoints mounted at /api/listing-ai');
}
// ==================== END CONTRACTOR MARKETPLACE SERVICES ====================

// ==================== INCOME VERIFICATION ENDPOINTS ====================
// Income Verification - analyze tenant bank account data via Stripe Financial Connections
if (incomeVerificationRouter) {
  app.use('/api/income-verification', incomeVerificationRouter);
  console.log('✅ [Income Verification] Endpoints mounted at /api/income-verification');
} else {
  app.post('/api/income-verification/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'income_verification_not_configured',
      message: 'Income verification system is not configured.'
    });
  });
}
// ==================== END INCOME VERIFICATION ENDPOINTS ====================
// ==================== END STRIPE CONNECT ENDPOINTS ====================

// ==================== TENANT SCREENING REQUEST ENDPOINTS ====================
// Send screening request email to applicant
app.post('/api/screening/send-request', strictRateLimiter, async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();
    const { applicantEmail, applicantName, applicantPhone, propertyAddress, ownerName, ownerId, propertyId } = req.body;
    
    if (!applicantEmail || !applicantName) {
      return res.status(400).json({
        ok: false,
        error: 'applicantEmail and applicantName are required'
      });
    }
    
    // Generate a unique screening token
    const screeningToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    
    // Store screening request in database
    const result = db.prepare(`
      INSERT INTO screening_requests (
        token, owner_id, property_id, applicant_email, applicant_phone, applicant_name,
        property_address, owner_name, expires_at, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      screeningToken,
      ownerId || null,
      propertyId || null,
      applicantEmail,
      applicantPhone || null,
      applicantName,
      propertyAddress || '',
      ownerName || '',
      expiresAt.toISOString()
    );
    
    // Build screening link
    const baseUrl = process.env.VITE_PUSH_SERVER_URL || 'http://localhost:5173';
    const screeningLink = `${baseUrl}/screening/${screeningToken}`;
    
    // Send email
    const emailResult = await sendScreeningRequestEmail({
      to: applicantEmail,
      applicantName,
      propertyAddress,
      ownerName,
      screeningLink,
      expiresAt
    });
    
    if (!emailResult.ok && !emailResult.skipped) {
      return res.status(500).json({
        ok: false,
        error: 'Failed to send email',
        details: emailResult.error
      });
    }
    
    console.log(`[Screening] Request sent to ${applicantEmail} for ${applicantName}`);
    
    res.json({
      ok: true,
      message: 'Screening request sent',
      screeningId: result.lastInsertRowid,
      emailSent: emailResult.ok,
      screeningLink // For testing purposes
    });
    
  } catch (error) {
    console.error('[Screening] Error sending request:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Create or retrieve a reusable public application link for a property
app.post('/api/screening/application-link', async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();
    const { ownerId, ownerName, propertyAddress, propertyId } = req.body || {};

    if (!ownerId || !propertyAddress) {
      return res.status(400).json({ ok: false, error: 'ownerId and propertyAddress are required' });
    }

    const existing = db.prepare(`
      SELECT * FROM application_links
      WHERE owner_id = ? AND property_address = ? AND is_active = 1
      ORDER BY created_at DESC
      LIMIT 1
    `).get(ownerId, propertyAddress);

    const applicationToken = existing?.token || crypto.randomBytes(24).toString('hex');

    if (!existing) {
      db.prepare(`
        INSERT INTO application_links (token, owner_id, owner_name, property_id, property_address, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(applicationToken, ownerId, ownerName || '', propertyId || null, propertyAddress);
    } else {
      db.prepare(`
        UPDATE application_links
        SET owner_name = ?, property_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE token = ?
      `).run(ownerName || existing.owner_name || '', propertyId || existing.property_id || null, applicationToken);
    }

    const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_PUSH_SERVER_URL || 'http://localhost:5173';
    const applicationLink = `${frontendUrl}/apply/${applicationToken}`;

    res.json({
      ok: true,
      token: applicationToken,
      applicationLink,
      propertyAddress,
      ownerId
    });
  } catch (error) {
    console.error('[Application Link] Error creating link:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get public application link metadata
app.get('/api/applications/public/:token', async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();
    const record = db.prepare(`
      SELECT token, owner_id, owner_name, property_id, property_address, is_active
      FROM application_links
      WHERE token = ? AND is_active = 1
      LIMIT 1
    `).get(req.params.token);

    if (!record) {
      return res.status(404).json({ ok: false, error: 'Application link not found or inactive' });
    }

    res.json({
      ok: true,
      application: {
        token: record.token,
        ownerId: record.owner_id,
        ownerName: record.owner_name,
        propertyId: record.property_id,
        propertyAddress: record.property_address
      }
    });
  } catch (error) {
    console.error('[Application Link] Error loading public application:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Start a public application and redirect the applicant into the screening flow
app.post('/api/applications/public/:token/start', strictRateLimiter, async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();
    const applicationLink = db.prepare(`
      SELECT * FROM application_links
      WHERE token = ? AND is_active = 1
      LIMIT 1
    `).get(req.params.token);

    if (!applicationLink) {
      return res.status(404).json({ ok: false, error: 'Application link not found or inactive' });
    }

    const { applicantName, applicantEmail, applicantPhone } = req.body || {};
    if (!applicantName || !applicantEmail || !applicantPhone) {
      return res.status(400).json({ ok: false, error: 'applicantName, applicantEmail, and applicantPhone are required' });
    }

    const screeningToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    db.prepare(`
      INSERT INTO screening_requests (
        token, owner_id, property_id, applicant_email, applicant_phone, applicant_name,
        property_address, owner_name, expires_at, status, application_link_token
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      screeningToken,
      applicationLink.owner_id,
      applicationLink.property_id || null,
      applicantEmail,
      applicantPhone,
      applicantName,
      applicationLink.property_address,
      applicationLink.owner_name || '',
      expiresAt.toISOString(),
      applicationLink.token
    );

    const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_PUSH_SERVER_URL || 'http://localhost:5173';
    const screeningLink = `${frontendUrl}/screening/${screeningToken}`;

    res.json({
      ok: true,
      screeningToken,
      screeningLink,
      propertyAddress: applicationLink.property_address
    });
  } catch (error) {
    console.error('[Application Link] Error starting application:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get screening request by token (for applicant form)
app.get('/api/screening/:token', async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();
    const { token } = req.params;
    
    const request = db.prepare(`
      SELECT * FROM screening_requests WHERE token = ? AND status = 'pending'
    `).get(token);
    
    if (!request) {
      return res.status(404).json({
        ok: false,
        error: 'Screening request not found or expired'
      });
    }
    
    // Check if expired
    if (new Date(request.expires_at) < new Date()) {
      return res.status(410).json({
        ok: false,
        error: 'This screening request has expired'
      });
    }
    
    res.json({
      ok: true,
      request: {
        applicantName: request.applicant_name,
        applicantEmail: request.applicant_email,
        propertyAddress: request.property_address,
        ownerName: request.owner_name,
        expiresAt: request.expires_at
      }
    });
    
  } catch (error) {
    console.error('[Screening] Error fetching request:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Submit screening data (SSN, DOB, address, and initiate bank verification)
app.post('/api/screening/:token/submit', strictRateLimiter, async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();
    const { token } = req.params;
    const { firstName, lastName, ssn, dateOfBirth, address, phone } = req.body;
    
    // Validate required fields
    if (!firstName || !lastName || !ssn || !dateOfBirth || !address) {
      return res.status(400).json({
        ok: false,
        error: 'All fields are required: firstName, lastName, ssn, dateOfBirth, address'
      });
    }
    
    // Get screening request
    const request = db.prepare(`
      SELECT * FROM screening_requests WHERE token = ? AND status = 'pending'
    `).get(token);
    
    if (!request) {
      return res.status(404).json({
        ok: false,
        error: 'Screening request not found'
      });
    }
    
    // Update request with submitted data (store encrypted in production)
    db.prepare(`
      UPDATE screening_requests 
      SET status = 'submitted',
          applicant_phone = COALESCE(?, applicant_phone),
          submitted_first_name = ?,
          submitted_last_name = ?,
          submitted_dob = ?,
          submitted_address = ?,
          updated_at = ?
      WHERE token = ?
    `).run(phone || null, firstName, lastName, dateOfBirth, JSON.stringify(address), new Date().toISOString(), token);
    
    // Run credit check via Equifax
    let creditResult = { ok: false, error: 'Credit check not available' };
    if (equifaxModule) {
      creditResult = await equifaxModule.getCreditReport({
        firstName,
        lastName,
        ssn,
        dateOfBirth,
        address
      });
      
      // Store credit result
    }

    // Run background check via Equifax SmartScreen
    let backgroundResult = { ok: false, error: 'Background check not available' };
    if (equifaxBackgroundModule) {
      backgroundResult = await equifaxBackgroundModule.runBackgroundCheck({
        firstName,
        lastName,
        ssn,
        dateOfBirth,
        address
      });
    }

    db.prepare(`
      UPDATE screening_requests 
      SET credit_score = ?,
          credit_status = ?,
          credit_report = ?,
          background_status = ?,
          background_report = ?,
          updated_at = ?
      WHERE token = ?
    `).run(
      creditResult.report?.score || null,
      creditResult.report?.status || (creditResult.ok ? 'clear' : 'pending'),
      JSON.stringify(creditResult.report || { error: creditResult.error }),
      backgroundResult.report?.status || (backgroundResult.ok ? 'clear' : 'pending'),
      JSON.stringify(backgroundResult.report || { error: backgroundResult.error }),
      new Date().toISOString(),
      token
    );

    // Create the phone interview workflow once screening has been submitted
    let interviewPayload = null;
    if (tenantInterviewModule && (phone || request.applicant_phone) && request.owner_id) {
      const applicantPhone = phone || request.applicant_phone;
      const existingInterviewId = request.interview_id;

      if (!existingInterviewId) {
        const interviewResult = await tenantInterviewModule.scheduleInterview({
          applicantId: `screening_${request.id}`,
          applicantName: `${firstName} ${lastName}`.trim(),
          applicantEmail: request.applicant_email,
          applicantPhone,
          propertyAddress: request.property_address,
          ownerId: request.owner_id,
          monthlyRent: null
        });

        if (interviewResult.ok) {
          db.prepare(`
            UPDATE screening_requests
            SET interview_id = ?, interview_booking_token = ?, updated_at = ?
            WHERE token = ?
          `).run(interviewResult.interviewId, interviewResult.bookingToken, new Date().toISOString(), token);

          const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_PUSH_SERVER_URL || 'http://localhost:5173';
          interviewPayload = {
            interviewId: interviewResult.interviewId,
            bookingToken: interviewResult.bookingToken,
            bookingLink: `${frontendUrl}/interview/book?token=${interviewResult.bookingToken}`,
            status: interviewResult.interview?.status || 'pending_booking'
          };
        }
      } else if (request.interview_booking_token) {
        const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_PUSH_SERVER_URL || 'http://localhost:5173';
        interviewPayload = {
          interviewId: existingInterviewId,
          bookingToken: request.interview_booking_token,
          bookingLink: `${frontendUrl}/interview/book?token=${request.interview_booking_token}`,
          status: 'pending_booking'
        };
      }
    }
    
    console.log(`[Screening] Submitted for ${firstName} ${lastName}, credit: ${creditResult.report?.score || 'N/A'}`);
    
    res.json({
      ok: true,
      message: 'Screening submitted successfully',
      creditCheck: creditResult.ok ? {
        score: creditResult.report?.score,
        status: creditResult.report?.status
      } : null,
      backgroundCheck: backgroundResult.ok ? {
        status: backgroundResult.report?.status,
        summary: backgroundResult.report?.summary,
        criminalRecords: backgroundResult.report?.criminalRecords?.count || 0,
        evictions: backgroundResult.report?.evictions?.count || 0
      } : null,
      interview: interviewPayload,
      nextStep: 'income_verification'
    });
    
  } catch (error) {
    console.error('[Screening] Error submitting:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get all screening requests (for property manager dashboard)
app.get('/api/screening/requests/all', async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();
    const { ownerId, propertyAddress, propertyId } = req.query;
    const whereClauses = [];
    const values = [];

    if (ownerId) {
      whereClauses.push('owner_id = ?');
      values.push(ownerId);
    }
    if (propertyAddress) {
      whereClauses.push('property_address = ?');
      values.push(propertyAddress);
    }
    if (propertyId) {
      whereClauses.push('property_id = ?');
      values.push(propertyId);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const requests = db.prepare(`
      SELECT 
        id, token, owner_id, property_id, applicant_email, applicant_phone, applicant_name, property_address, owner_name,
        status, credit_score, credit_status, credit_report, background_status, background_report,
        income_verified, income_data, interview_id, interview_booking_token, application_link_token,
        submitted_first_name, submitted_last_name, submitted_dob, submitted_address,
        updated_at, created_at
      FROM screening_requests 
      ${whereSql}
      ORDER BY created_at DESC 
      LIMIT 50
    `).all(...values);
    
    res.json({
      ok: true,
      requests: requests.map(r => ({
        id: r.id,
        token: r.token,
        ownerId: r.owner_id,
        propertyId: r.property_id,
        applicantEmail: r.applicant_email,
        applicantPhone: r.applicant_phone,
        applicantName: r.applicant_name,
        propertyAddress: r.property_address,
        status: r.status,
        creditScore: r.credit_score,
        creditStatus: r.credit_status,
        creditReport: r.credit_report ? JSON.parse(r.credit_report) : null,
        backgroundStatus: r.background_status,
        backgroundReport: r.background_report ? JSON.parse(r.background_report) : null,
        incomeVerified: r.income_verified === 1,
        incomeData: r.income_data ? JSON.parse(r.income_data) : null,
        interviewId: r.interview_id,
        interviewBookingToken: r.interview_booking_token,
        applicationLinkToken: r.application_link_token,
        submittedFirstName: r.submitted_first_name,
        submittedLastName: r.submitted_last_name,
        submittedDob: r.submitted_dob,
        submittedAddress: r.submitted_address ? JSON.parse(r.submitted_address) : null,
        updatedAt: r.updated_at,
        createdAt: r.created_at
      }))
    });
    
  } catch (error) {
    console.error('[Screening] Error fetching requests:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Update screening request with income verification status
app.post('/api/screening/:token/income-verified', async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();
    const { token } = req.params;
    const { sessionId, accounts } = req.body;
    
    // Try to fetch actual income data from the connected accounts
    let incomeAnalysis = {
      accounts: accounts || [],
      accountCount: accounts?.length || 0,
      verifiedAt: new Date().toISOString(),
      monthlyIncome: 0,
      totalBalance: 0,
      incomeTransactions: []
    };
    
    // If we have connected accounts with IDs, try to fetch transaction data
    if (accounts && accounts.length > 0) {
      try {
        const stripe = (await import('stripe')).default;
        const stripeClient = new stripe(process.env.STRIPE_SECRET_KEY);
        
        for (const account of accounts) {
          // Try to get balance
          try {
            const fcAccount = await stripeClient.financialConnections.accounts.retrieve(account.id);
            if (fcAccount.balance) {
              const cashBalance = fcAccount.balance.cash?.usd || 0;
              incomeAnalysis.totalBalance += cashBalance / 100;
              account.balance = cashBalance / 100;
            }
          } catch (balErr) {
            console.log('[Screening] Could not fetch balance:', balErr.message);
          }
          
          // Try to get transactions and identify income
          try {
            const transactions = await stripeClient.financialConnections.transactions.list({
              account: account.id,
              limit: 100
            });
            
            // Filter for income transactions (credits/deposits)
            const incomeTransactions = transactions.data.filter(txn => 
              txn.amount > 0 && 
              (txn.description?.toLowerCase().includes('payroll') ||
               txn.description?.toLowerCase().includes('salary') ||
               txn.description?.toLowerCase().includes('direct dep') ||
               txn.description?.toLowerCase().includes('deposit') ||
               txn.amount > 50000) // Over $500 likely income
            );
            
            // Calculate total income over the transaction period
            const totalIncome = incomeTransactions.reduce((sum, txn) => sum + txn.amount, 0) / 100;
            
            // Estimate monthly income based on date range
            if (transactions.data.length > 0) {
              const dates = transactions.data.map(t => t.transacted_at).sort();
              const oldestTxn = dates[0];
              const newestTxn = dates[dates.length - 1];
              const daysCovered = Math.max(1, (newestTxn - oldestTxn) / (60 * 60 * 24));
              const monthsCovered = daysCovered / 30;
              
              if (monthsCovered > 0) {
                incomeAnalysis.monthlyIncome += totalIncome / monthsCovered;
              }
              
              incomeAnalysis.incomeTransactions.push(...incomeTransactions.slice(0, 5).map(txn => ({
                amount: txn.amount / 100,
                description: txn.description,
                date: new Date(txn.transacted_at * 1000).toISOString().split('T')[0]
              })));
            }
            
            account.transactionCount = transactions.data.length;
            account.incomeTransactionCount = incomeTransactions.length;
            
          } catch (txnErr) {
            console.log('[Screening] Could not fetch transactions (may still be syncing):', txnErr.message);
            account.transactionsStatus = 'syncing';
          }
        }
        
        incomeAnalysis.monthlyIncome = Math.round(incomeAnalysis.monthlyIncome);
        incomeAnalysis.totalBalance = Math.round(incomeAnalysis.totalBalance);
        incomeAnalysis.accounts = accounts;
        
      } catch (stripeErr) {
        console.error('[Screening] Error fetching income from Stripe:', stripeErr);
      }
    }
    
    // Update the screening request with income verification status
    db.prepare(`
      UPDATE screening_requests 
      SET income_verified = 1,
          income_data = ?,
          stripe_session_id = ?,
          updated_at = ?
      WHERE token = ?
    `).run(
      JSON.stringify(incomeAnalysis),
      sessionId,
      new Date().toISOString(),
      token
    );
    
    console.log(`[Screening] Income verified for token ${token.slice(0, 8)}... with ${accounts?.length || 0} accounts, estimated monthly: $${incomeAnalysis.monthlyIncome}`);
    
    res.json({
      ok: true,
      message: 'Income verification recorded',
      incomeAnalysis
    });
    
  } catch (error) {
    console.error('[Screening] Error updating income verification:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Refresh income data for a screening request (fetch latest transactions)
app.post('/api/screening/:token/refresh-income', async (req, res) => {
  try {
    const { getDb } = await import('./db/connection.js');
    const db = getDb();
    const { token } = req.params;
    
    // Get the screening request
    const row = db.prepare('SELECT * FROM screening_requests WHERE token = ?').get(token);
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Screening request not found' });
    }
    
    if (!row.income_verified || !row.income_data) {
      return res.status(400).json({ ok: false, error: 'No income data to refresh' });
    }
    
    let incomeData = JSON.parse(row.income_data);
    const accounts = incomeData.accounts || [];
    
    if (accounts.length === 0) {
      return res.status(400).json({ ok: false, error: 'No connected accounts found' });
    }
    
    const stripe = (await import('stripe')).default;
    const stripeClient = new stripe(process.env.STRIPE_SECRET_KEY);
    
    let totalMonthlyIncome = 0;
    let totalBalance = 0;
    const incomeTransactions = [];
    
    for (const account of accounts) {
      if (!account.id) continue;
      
      // First, try to subscribe to transactions if not already done
      try {
        const fcAccount = await stripeClient.financialConnections.accounts.retrieve(account.id);
        
        // Check if we need to subscribe to transactions
        if (!fcAccount.subscriptions || fcAccount.subscriptions.length === 0) {
          console.log('[Screening] Subscribing to transactions for account:', account.id);
          try {
            await stripeClient.financialConnections.accounts.subscribe(account.id, {
              features: ['transactions']
            });
          } catch (subErr) {
            console.log('[Screening] Subscription error (may already exist):', subErr.message);
          }
        }
        
        // Check if balance refresh is needed
        if (!fcAccount.balance || fcAccount.balance_refresh?.status !== 'succeeded') {
          console.log('[Screening] Requesting balance refresh for account:', account.id);
          try {
            await stripeClient.financialConnections.accounts.refresh(account.id, {
              features: ['balance']
            });
          } catch (refErr) {
            console.log('[Screening] Balance refresh error:', refErr.message);
          }
        }
        
        // Get the balance
        if (fcAccount.balance?.cash?.usd) {
          account.balance = fcAccount.balance.cash.usd / 100;
          totalBalance += account.balance;
        } else if (fcAccount.balance?.current?.usd) {
          account.balance = fcAccount.balance.current.usd / 100;
          totalBalance += account.balance;
        }
        
        // Check transaction refresh status
        if (fcAccount.transaction_refresh?.status === 'pending') {
          account.transactionsStatus = 'syncing';
          console.log('[Screening] Transactions still syncing for account:', account.id);
        }
        
      } catch (e) { 
        console.log('[Screening] Account fetch error:', e.message); 
      }
      
      // Fetch transactions
      try {
        const transactions = await stripeClient.financialConnections.transactions.list({
          account: account.id,
          limit: 100
        });
        
        const incomeTxns = transactions.data.filter(txn => 
          txn.amount > 0 && 
          (txn.description?.toLowerCase().includes('payroll') ||
           txn.description?.toLowerCase().includes('salary') ||
           txn.description?.toLowerCase().includes('direct dep') ||
           txn.description?.toLowerCase().includes('deposit') ||
           txn.amount > 50000)
        );
        
        const totalIncome = incomeTxns.reduce((sum, txn) => sum + txn.amount, 0) / 100;
        
        if (transactions.data.length > 0) {
          const dates = transactions.data.map(t => t.transacted_at).sort();
          const daysCovered = Math.max(1, (dates[dates.length - 1] - dates[0]) / (60 * 60 * 24));
          const monthsCovered = daysCovered / 30;
          if (monthsCovered > 0) {
            totalMonthlyIncome += totalIncome / monthsCovered;
          }
          
          incomeTransactions.push(...incomeTxns.slice(0, 5).map(txn => ({
            amount: txn.amount / 100,
            description: txn.description,
            date: new Date(txn.transacted_at * 1000).toISOString().split('T')[0]
          })));
        }
        
        account.transactionCount = transactions.data.length;
        account.incomeTransactionCount = incomeTxns.length;
        account.transactionsStatus = 'ready';
        
      } catch (e) {
        console.log('[Screening] Transaction fetch error:', e.message);
        account.transactionsStatus = 'syncing';
      }
    }
    
    // Update income analysis
    incomeData.monthlyIncome = Math.round(totalMonthlyIncome);
    incomeData.totalBalance = Math.round(totalBalance);
    incomeData.incomeTransactions = incomeTransactions;
    incomeData.accounts = accounts;
    incomeData.lastRefreshed = new Date().toISOString();
    
    // Save updated data
    db.prepare(`
      UPDATE screening_requests 
      SET income_data = ?, updated_at = ?
      WHERE token = ?
    `).run(JSON.stringify(incomeData), new Date().toISOString(), token);
    
    res.json({
      ok: true,
      incomeAnalysis: incomeData
    });
    
  } catch (error) {
    console.error('[Screening] Error refreshing income:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

console.log('✅ [Screening] Tenant screening request endpoints mounted at /api/screening');
// ==================== END TENANT SCREENING REQUEST ENDPOINTS ====================

// ==================== EQUIFAX CREDIT CHECK ENDPOINTS ====================
// Equifax integration - tenant credit screening
if (equifaxModule) {
  // POST /api/equifax/credit-check
  // Request body: { firstName, lastName, ssn, dateOfBirth, address: { street, city, state, zipCode } }
  // Returns: { ok, report: { score, scoreRange, status, details, summary } }
  app.post('/api/equifax/credit-check', strictRateLimiter, async (req, res) => {
    try {
      const { firstName, lastName, ssn, dateOfBirth, address, middleName, suffix } = req.body;

      // Validate required fields
      if (!firstName || !lastName || !ssn || !dateOfBirth || !address) {
        return res.status(400).json({
          ok: false,
          error: 'missing_required_fields',
          message: 'firstName, lastName, ssn, dateOfBirth, and address are required'
        });
      }

      // Validate address fields
      if (!address.street || !address.city || !address.state || !address.zipCode) {
        return res.status(400).json({
          ok: false,
          error: 'incomplete_address',
          message: 'Address must include street, city, state, and zipCode'
        });
      }

      console.log('[Equifax] Processing credit check request for:', firstName, lastName);

      const result = await equifaxModule.getCreditReport({
        firstName,
        lastName,
        middleName,
        suffix,
        ssn,
        dateOfBirth,
        address
      });

      if (!result.ok) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (error) {
      console.error('[Equifax] Credit check error:', error);
      res.status(500).json({
        ok: false,
        error: 'internal_error',
        message: 'Failed to process credit check'
      });
    }
  });

  // POST /api/equifax/quick-check
  // Lightweight credit check - returns just score and status
  app.post('/api/equifax/quick-check', strictRateLimiter, async (req, res) => {
    try {
      const { firstName, lastName, ssn, dateOfBirth, address, middleName, suffix } = req.body;

      if (!firstName || !lastName || !ssn || !dateOfBirth || !address) {
        return res.status(400).json({
          ok: false,
          error: 'missing_required_fields'
        });
      }

      const result = await equifaxModule.quickCreditCheck({
        firstName,
        lastName,
        middleName,
        suffix,
        ssn,
        dateOfBirth,
        address
      });

      res.json(result);
    } catch (error) {
      console.error('[Equifax] Quick check error:', error);
      res.status(500).json({
        ok: false,
        error: 'internal_error',
        message: 'Failed to process quick check'
      });
    }
  });

  // GET /api/equifax/status
  // Check if Equifax is configured and credentials are valid
  app.get('/api/equifax/status', async (req, res) => {
    try {
      const isConfigured = equifaxModule.isConfigured();
      
      if (!isConfigured) {
        return res.json({
          ok: false,
          configured: false,
          message: 'Equifax credentials not configured'
        });
      }

      const validation = await equifaxModule.validateCredentials();
      
      res.json({
        ok: validation.ok,
        configured: true,
        valid: validation.ok,
        message: validation.message
      });
    } catch (error) {
      console.error('[Equifax] Status check error:', error);
      res.status(500).json({
        ok: false,
        error: 'status_check_failed'
      });
    }
  });

  console.log('✅ [Equifax] Credit check endpoints mounted at /api/equifax');
} else {
  // Fallback endpoints if Equifax module not available
  app.post('/api/equifax/*', (req, res) => {
    res.status(503).json({
      ok: false,
      error: 'equifax_not_configured',
      message: 'Equifax credit check integration is not configured.'
    });
  });
  app.get('/api/equifax/*', (req, res) => {
    res.status(503).json({
      ok: false,
      error: 'equifax_not_configured',
      message: 'Equifax credit check integration is not configured.'
    });
  });
}
// ==================== END EQUIFAX ENDPOINTS ====================

// ==================== EQUIFAX BACKGROUND CHECK ENDPOINTS ====================
// Equifax SmartScreen Advanced Tenant Check - criminal records, evictions, sex offender registry
if (equifaxBackgroundModule) {
  // POST /api/equifax/background-check
  // Request body: { firstName, lastName, ssn, dateOfBirth, address: { street, city, state, zipCode } }
  // Returns: { ok, report: { status, risk, criminalRecords, evictions, sexOffenderStatus, identityVerification, summary } }
  app.post('/api/equifax/background-check', strictRateLimiter, async (req, res) => {
    try {
      const { firstName, lastName, ssn, dateOfBirth, address, middleName } = req.body;

      // Validate required fields
      if (!firstName || !lastName || !ssn || !dateOfBirth || !address) {
        return res.status(400).json({
          ok: false,
          error: 'missing_required_fields',
          message: 'firstName, lastName, ssn, dateOfBirth, and address are required'
        });
      }

      // Validate address fields
      if (!address.street || !address.city || !address.state || !address.zipCode) {
        return res.status(400).json({
          ok: false,
          error: 'incomplete_address',
          message: 'Address must include street, city, state, and zipCode'
        });
      }

      console.log('[Equifax Background] Processing background check request for:', firstName, lastName);

      const result = await equifaxBackgroundModule.runBackgroundCheck({
        firstName,
        lastName,
        middleName,
        ssn,
        dateOfBirth,
        address
      });

      if (!result.ok) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (error) {
      console.error('[Equifax Background] Check error:', error);
      res.status(500).json({
        ok: false,
        error: 'internal_error',
        message: 'Failed to process background check'
      });
    }
  });

  // GET /api/equifax/background-status
  // Check if Equifax background check is configured
  app.get('/api/equifax/background-status', async (req, res) => {
    try {
      const validation = await equifaxBackgroundModule.validateBackgroundCheckCredentials();
      
      res.json({
        ok: validation.ok,
        configured: equifaxBackgroundModule.isConfigured(),
        message: validation.message,
        endpoint: validation.endpoint
      });
    } catch (error) {
      console.error('[Equifax Background] Status check error:', error);
      res.status(500).json({
        ok: false,
        error: 'status_check_failed'
      });
    }
  });

  console.log('✅ [Equifax Background] Tenant screening endpoints mounted at /api/equifax/background-*');
} else {
  // Fallback endpoints if background check module not available
  app.post('/api/equifax/background-*', (req, res) => {
    res.status(503).json({
      ok: false,
      error: 'equifax_background_not_configured',
      message: 'Equifax background check integration is not configured.'
    });
  });
  app.get('/api/equifax/background-*', (req, res) => {
    res.status(503).json({
      ok: false,
      error: 'equifax_background_not_configured',
      message: 'Equifax background check integration is not configured.'
    });
  });
}
// ==================== END EQUIFAX BACKGROUND CHECK ENDPOINTS ====================

// ==================== QUICKBOOKS SYNC ENDPOINTS (OPTIONAL) ====================
// QuickBooks sync - only for users who already have QuickBooks accounts
if (quickbooksRouter) {
  app.use('/api/quickbooks', quickbooksRouter);
  console.log('✅ [QuickBooks] Optional sync endpoints mounted at /api/quickbooks');
  
  // Mount monthly summary sync endpoints
  if (quickbooksSyncRouter) {
    app.use('/api/quickbooks/sync', quickbooksSyncRouter);
    console.log('✅ [QuickBooks Sync] Monthly summary push endpoints mounted at /api/quickbooks/sync');
  }
} else {
  // Fallback endpoints if QuickBooks module not available
  app.get('/api/quickbooks/*', (req, res) => {
    res.status(503).json({ 
      ok: false, 
      error: 'quickbooks_not_configured',
      message: 'QuickBooks sync is not configured. Use /api/bookkeeping instead.'
    });
  });
}
// ==================== END QUICKBOOKS SYNC ENDPOINTS ====================

// ==================== STRIPE TENANT PAYMENT ENDPOINT ====================
// Simple Stripe checkout for tenant rent payments
app.post('/api/tenant-payment/create-checkout', async (req, res) => {
  try {
    const { tenantName, tenantEmail, amount, propertyAddress, description } = req.body;

    // Validation
    if (!tenantName || !tenantEmail || !amount) {
      return res.status(400).json({
        ok: false,
        error: 'tenantName, tenantEmail, and amount are required'
      });
    }

    // Check if Stripe is configured
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_SECRET_KEY) {
      return res.status(503).json({
        ok: false,
        error: 'stripe_not_configured',
        message: 'Stripe payment processing is not configured. Please add STRIPE_SECRET_KEY to your environment variables.'
      });
    }

    // Initialize Stripe
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: '2024-12-18.acacia'
    });

    const { buildTenantCheckoutSessionParams } = await import('./stripe-tenant-payment-config.js');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    // Create a checkout session with card + ACH support and automatic ACH verification fallback.
    const session = await stripe.checkout.sessions.create(
      buildTenantCheckoutSessionParams({
        amount,
        tenantEmail,
        description,
        propertyAddress,
        successUrl: `${frontendUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${frontendUrl}/portfolio`,
        metadata: {
          tenantName,
          tenantEmail,
          propertyAddress: propertyAddress || '',
          paymentType: 'rent'
        }
      })
    );

    console.log('[Stripe] Created checkout session:', session.id, 'for', tenantEmail, '-', amount);

    res.json({
      ok: true,
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('[Stripe] Error creating checkout session:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to create payment session'
    });
  }
});

// Get Stripe payment status
app.get('/api/tenant-payment/status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_SECRET_KEY) {
      return res.status(503).json({ ok: false, error: 'stripe_not_configured' });
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: '2024-12-18.acacia'
    });

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    res.json({
      ok: true,
      status: session.payment_status,
      amount: session.amount_total / 100,
      currency: session.currency,
      customerEmail: session.customer_email,
      metadata: session.metadata
    });

  } catch (error) {
    console.error('[Stripe] Error retrieving session:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to retrieve payment status'
    });
  }
});
// ==================== END STRIPE TENANT PAYMENT ENDPOINT ====================

// Tenant Message Summary Endpoint - Proxies OpenAI API call to avoid CORS issues
app.post('/api/tenant-summary', async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: 'Messages array required' });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
    }

    // Get last 4 messages
    const recentMessages = messages.slice(-4);
    const messagesText = recentMessages.map((msg, idx) => 
      `Message ${idx + 1} (${msg.type}): ${msg.content}`
    ).join('\n\n');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a property management assistant analyzing tenant correspondence. Create 3-5 concise bullet points that: 1) Summarize the main topics/content of the messages, 2) Identify any requests, concerns, or issues raised, 3) Clearly state if any action is needed and what that action should be. Be specific and actionable. Format each bullet point to start with a dash (-).'
          },
          {
            role: 'user',
            content: `Analyze and summarize these recent tenant messages:\n\n${messagesText}\n\nProvide a summary that captures the content of the correspondence and identifies any action items.`
          }
        ],
        temperature: 0.7,
        max_tokens: 400
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('OpenAI API error:', response.status, errorData);
      return res.status(response.status).json({ 
        ok: false, 
        error: errorData.error?.message || 'OpenAI API request failed' 
      });
    }

    const data = await response.json();
    const summaryText = data.choices[0]?.message?.content || '';
    
    // Parse bullet points from the response
    const bullets = summaryText
      .split('\n')
      .filter(line => line.trim().match(/^[-•*]/))
      .map(line => line.replace(/^[-•*]\s*/, '').trim())
      .filter(line => line.length > 0);

    const finalSummary = bullets.length > 0 ? bullets : [summaryText];
    
    res.json({ ok: true, summary: finalSummary });
  } catch (error) {
    console.error('Error in tenant-summary endpoint:', error);
    res.status(500).json({ ok: false, error: error.message || 'Internal server error' });
  }
});

// NOTE: Fetch is global in Node 18+. If using <18, install node-fetch and import here.

// --- Existing routes below (original content) ---

// Reconstructed helper endpoint: Accepts raw search result objects and returns AI ranking.
// This was originally partially inlined at top due to file corruption.
app.post('/api/rank-search', async (req, res) => {
  try {
    const { results = [], analyze = false, q = '' } = req.body || {};
    if (!Array.isArray(results) || !results.length) {
      return res.status(400).json({ ok:false, error:'Missing results array' });
    }
    const signals = [];
    if (analyze && OPENAI_API_KEY) {
      for (const rItem of results.slice(0, Math.min(5, results.length))) {
        try {
          const pageResp = await fetch(rItem.link, { headers:{ 'User-Agent':'RenaissanceRealtyBot/1.0' }, redirect:'follow' });
          const html = await pageResp.text();
          const text = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ');
          const ratingMatch = text.match(/(\b[4-5]\.[0-9]\s*stars?\b|★★★★★|★{3,5})/i);
          const priceMatch = text.match(/\b\$+\b/);
          const yearsMatch = text.match(/(\b\d{1,2}\+? years? in business\b|est\.? ?\d{4})/i);
          const warrantyMatch = text.match(/warrant(y|ies)|guarantee/i);
          signals.push({
            index: rItem.index,
            link: rItem.link,
            title: rItem.title,
            ratingSnippet: ratingMatch?.[0] || null,
            priceSnippet: priceMatch?.[0] || null,
            experienceSnippet: yearsMatch?.[0] || null,
            warranty: !!warrantyMatch,
            snippet: rItem.snippet?.slice(0, 160) || ''
          });
        } catch (e) {
          signals.push({ index: rItem.index, link: rItem.link, title: rItem.title, error: (e && e.message) || 'fetch_failed' });
        }
      }
    }
    if (!OPENAI_API_KEY) {
      return res.json({ ok:true, ranked:false, analyzed:analyze, results, signals, warning:'openai_not_configured' });
    }
    try {
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const basePrompt = `Rank these service provider search results for: "${q}". Focus on suitability for the job, reputation, value, and reliability.`;
      const userContent = [
        basePrompt,
        '\nRaw Results:',
        results.map(r => `#${r.index} ${r.title} (${r.displayLink}) - ${r.snippet}`).join('\n'),
      ];
      if (analyze) {
        userContent.push('\nExtracted Signals (subset pages):');
        userContent.push(signals.map(s => `#${s.index} rating=${s.ratingSnippet || 'n/a'} price=${s.priceSnippet || 'n/a'} experience=${s.experienceSnippet || 'n/a'} warranty=${s.warranty ? 'yes' : 'no'} title=${s.title}`).join('\n'));
      }
      userContent.push('\nReturn JSON ONLY: [{ index, score (0-100), reason, (optional) serviceType, (optional) estCostTier }]');
      const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' },
        body: JSON.stringify({
          model,
            messages: [
              { role: 'system', content: 'You are an analytical assistant that ranks local service providers using provided signals only. Do not fabricate data.' },
              { role: 'user', content: userContent.join('\n') }
            ],
          temperature: 0.1
        })
      });
      const aiJson = await aiResp.json();
      const text = aiJson?.choices?.[0]?.message?.content || '';
      let ranking; try { ranking = JSON.parse(text); } catch { ranking = null; }
      if (!Array.isArray(ranking)) return res.json({ ok:true, ranked:false, analyzed:analyze, results, signals });
      const order = ranking.map(x => x.index).filter(i => Number.isInteger(i));
      const ranked = results.slice().sort((a,b)=> order.indexOf(a.index) - order.indexOf(b.index));
      return res.json({ ok:true, ranked:true, analyzed:analyze, model, results: ranked, signals: analyze?signals:undefined, aiRanking: ranking });
    } catch (e) {
      return res.json({ ok:true, ranked:false, analyzed:analyze, results, signals: analyze?signals:undefined, error:'ai_ranking_failed' });
    }
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || 'rank_search_failed' });
  }
});

// --- Structured Local Service Provider Search ---
// Query params:
//   issue: (string) plain-language problem e.g. "leaky pipe" (optional if q provided)
//   location: (string) location e.g. "Potomac Maryland"
//   q: explicit query override (skips AI refinement)
//   full: if 'true' returns all candidate providers else only best
//   service=true (flag for clarity)
// This endpoint attempts to build a high-intent local service query, fetch Google CSE results,
// filter to likely provider sites (exclude forums/aggregators), fetch pages, extract phone & address,
// and optionally use OpenAI to pick the best provider.
app.get('/service-search', async (req, res) => {
  console.log('[service-search] Request received:', req.query);
  try {
    const isService = (req.query.service || 'true').toString() === 'true';
    let rawIssue = (req.query.issue || '').toString().trim().slice(0, 500); // Limit length
    let location = (req.query.location || '').toString().trim().slice(0, 200);
    const description = (req.query.description || '').toString().trim().slice(0, 1000);
    const explicitQ = (req.query.q || '').toString().trim().slice(0, 500);
    const wantFull = (req.query.full || '').toString() === 'true';
    const num = Math.min(10, Math.max(3, parseInt(req.query.num || '8', 10)));
    
    // Basic input validation
    if (!description && !rawIssue && !explicitQ) {
      return res.status(400).json({ ok: false, error: 'missing_search_query' });
    }

    // Allow single free-form description; extract issue + location via AI or heuristics
    if (description && (!rawIssue || !location)) {
      try {
        if (OPENAI_API_KEY) {
          const sys = 'Analyze this maintenance request and extract: 1) specific issue/problem, 2) location if mentioned, 3) determine the appropriate service category (plumbing, electrical, HVAC, roofing, pest control, general repair, etc.). Return JSON {"issue":"...","location":"...","serviceCategory":"...","searchStrategy":"targeted keywords for finding local service providers"}';
          const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: description }
              ],
              response_format: { type: 'json_object' },
              temperature: 0
            })
          });
          const data = await resp.json();
          const content = data?.choices?.[0]?.message?.content;
          if (content) {
            try {
              const parsed = JSON.parse(content);
              if (!rawIssue && parsed.issue) rawIssue = parsed.issue;
              if (!location && parsed.location) location = parsed.location;
              // Store AI analysis for later use in query building
              req.aiAnalysis = parsed;
            } catch {}
          }
        }
      } catch (e) { console.warn('description AI parse failed', e?.message); }
      // Heuristic fallback
      if (!rawIssue) rawIssue = description.replace(/in\s+[A-Z][a-zA-Z]+(?:,?\s+[A-Z]{2}|\s+[A-Z][a-zA-Z]+){0,2}/,'').trim();
      if (!location) {
        const m = description.match(/in\s+([A-Z][a-zA-Z]+(?:,?\s+[A-Z]{2}|\s+[A-Z][a-zA-Z]+){0,2})/i);
        if (m) location = m[1];
      }
    }

    if (!explicitQ && !rawIssue) {
      return res.status(400).json({ ok: false, error: 'Missing issue or q', received: { rawIssue, location, description } });
    }

    // 1. AI-powered intelligent query building
    let baseQuery;
    
    // If explicitQ provided (e.g., from email analysis with AI-generated search query),
    // use it directly without any modification
    if (explicitQ) {
      baseQuery = explicitQ;
      console.log('[service-search] Using explicit query from caller (likely from email analysis):', explicitQ);
    } else {
      // Build query from scratch
      baseQuery = [rawIssue, location].filter(Boolean).join(' ').trim();
      if (!baseQuery) baseQuery = rawIssue;
      
      // Use AI analysis to create optimal search query if available
      if (OPENAI_API_KEY && req.aiAnalysis) {
        try {
          const analysisPrompt = `Based on this maintenance issue analysis, create the most effective Google search query to find LOCAL SERVICE COMPANIES (not articles/guides):

Issue: ${rawIssue}
Location: ${location || 'unspecified'}
Service Category: ${req.aiAnalysis.serviceCategory || 'general repair'}
AI Search Strategy: ${req.aiAnalysis.searchStrategy || 'local contractors'}

Requirements:
- Find actual service companies/contractors, NOT how-to articles
- Prioritize local businesses in the specified area
- Include professional/licensed terms
- Avoid generic advice sites

Create a targeted search query:`;

          const queryResp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              messages: [
                { role: 'system', content: 'You are an expert at creating Google search queries that find local service businesses. Always prioritize professional contractors over DIY content. Output ONLY the search query, no explanations.' },
                { role: 'user', content: analysisPrompt }
              ],
              temperature: 0.0,
              max_tokens: 60
            })
          });
          const queryJson = await queryResp.json();
          const aiQuery = queryJson?.choices?.[0]?.message?.content?.trim();
          if (aiQuery && aiQuery.length > 10 && aiQuery.length < 150) {
            baseQuery = aiQuery.replace(/["']/g,'');
          }
        } catch (e) {
          console.warn('AI query generation failed', e?.message);
        }
      }
      
      // Fallback heuristic enhancements if AI didn't work
      if (baseQuery === ([rawIssue, location].filter(Boolean).join(' ').trim())) {
      const lower = baseQuery.toLowerCase();
      
      // Service-specific query improvements (ordering matters)
      let serviceType = '';
      const issueLower = rawIssue.toLowerCase();
      // Plumbing first: many user issues mention generic 'leak' which should default to plumbing unless roof keywords explicitly present
      const plumbingRx = /(plumb|toilet|pipe|drain|faucet|sink|garbage disposal|disposal|shut ?off valve|water heater|sewer|clog|leak)/i;
      const roofingRx = /(roof|shingle|gutter|soffit|ridge cap)/i; // exclude generic 'leak' here
      if (/animal|pest|rodent|mouse|rat|squirrel|raccoon|burrow|exterminat/i.test(rawIssue)) {
        serviceType = 'pest control exterminator';
      } else if (plumbingRx.test(rawIssue) && !roofingRx.test(rawIssue)) {
        serviceType = 'plumber';
      } else if (roofingRx.test(rawIssue) || /roof leak/i.test(rawIssue)) {
        serviceType = 'roofing contractor';
      } else if (/hvac|heat|cool|air|furnace|ac|a\/c|thermostat/i.test(rawIssue)) {
        serviceType = 'HVAC contractor';
      } else if (/electric|outlet|wiring|power|breaker|panel|light switch|lighting/i.test(rawIssue)) {
        serviceType = 'electrician';
      } else if (/window|glass|glazier/i.test(rawIssue)) {
        serviceType = 'window repair';
      } else {
        // Generic leak fallback -> plumber (common user phrasing: "leak" w/out context)
        if (/leak/.test(issueLower)) serviceType = 'plumber'; else serviceType = 'repair service';
      }
      if (process.env.DEBUG_SEARCH === '1') console.log('[heuristic-serviceType]', { rawIssue, serviceType });
      
      // Build location-specific service query
      if (location) {
        baseQuery = `${serviceType} near ${location} licensed professional`;
      } else {
        baseQuery = `${serviceType} licensed professional`;
      }
      
      // Add specific terms for pest control to avoid articles
      if (serviceType.includes('pest')) {
        baseQuery += ' company removal service';
      }
      }

      // Optional AI refinement for final query optimization (now redundant but kept as backup)
      if (OPENAI_API_KEY && !req.aiAnalysis) {
        try {
          const refineResp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              messages: [
                { role: 'system', content: 'Create Google search queries that find LOCAL SERVICE COMPANIES, not DIY articles or guides. Focus on licensed contractors and professional services in the specified area. Always include location and business-focused terms.' },
                { role: 'user', content: `Issue: ${rawIssue}\nLocation: ${location || 'unspecified'}\nDraft Query: ${baseQuery}\n\nRefine this to find actual service companies, not how-to articles.` }
              ],
              temperature: 0.0,
              max_tokens: 50
            })
          });
          const refineJson = await refineResp.json();
          const candidate = refineJson?.choices?.[0]?.message?.content?.trim();
          if (candidate && candidate.length < 120) baseQuery = candidate.replace(/["']/g,'');
        } catch {}
      }
    }

    // 2. Google CSE Search
    const key = GOOGLE_API_KEY;
    const cx = GOOGLE_CSE_CX;
    if (!key || !cx) {
      return res.json({ ok: true, service: isService, queryUsed: baseQuery, providers: [], bestProvider: null, bestMeta: null, warning: 'google_search_not_configured' });
    }
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', key);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', baseQuery);
    url.searchParams.set('num', String(num));
    url.searchParams.set('gl', 'us');
    url.searchParams.set('hl', 'en');
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await r.json();
    if (data?.error) return res.status(502).json({ ok: false, error: data.error?.message || 'Upstream Google CSE error' });
    const items = Array.isArray(data?.items) ? data.items : [];
    const initial = items.map((it, idx) => ({
      index: idx,
      title: it.title,
      link: it.link,
      displayLink: it.displayLink,
      snippet: it.snippet,
    }));

    // 3. AI-enhanced provider filtering
    const EXCLUDE_HOST_PATTERNS = /(reddit|quora|angi|yelp|facebook|instagram|ask|wiki|news|blog|forbes|usatoday|nytimes|homedepot|lowes|amazon|youtube|diy|howto|tips|guide|crittercontrol\.com)/i;
    const EXCLUDE_TITLE_PATTERNS = /(how to|tips|guide|diy|do it yourself|^get rid of|^remove|^prevent|article|blog|forum)/i;
    
    const providerCandidates = initial.filter(rItem => {
      // Exclude known content/advice sites
      if (EXCLUDE_HOST_PATTERNS.test(rItem.displayLink)) return false;
      // Exclude how-to/advice article titles
      if (EXCLUDE_TITLE_PATTERNS.test(rItem.title)) return false;
      
      // AI-informed filtering based on service category
      if (req.aiAnalysis?.serviceCategory) {
        const category = req.aiAnalysis.serviceCategory.toLowerCase();
        const titleLower = rItem.title.toLowerCase();
        const snippetLower = rItem.snippet.toLowerCase();
        
        // Service-specific positive indicators
        const serviceIndicators = {
          'pest control': ['pest', 'exterminator', 'rodent', 'animal', 'removal', 'control', 'wildlife'],
          'plumbing': ['plumber', 'plumbing', 'pipe', 'drain', 'water', 'leak'],
          'roofing': ['roof', 'roofing', 'shingle', 'gutter', 'contractor'],
          'electrical': ['electric', 'electrician', 'wiring', 'outlet', 'power'],
          'hvac': ['hvac', 'heating', 'cooling', 'air', 'furnace', 'ac'],
          'window repair': ['window', 'glass', 'glazing', 'replacement', 'installation', 'repair'],
          'general repair': ['repair', 'contractor', 'handyman', 'maintenance', 'service']
        };
        
        const indicators = serviceIndicators[category] || serviceIndicators['general repair'];
        const hasServiceMatch = indicators.some(term => titleLower.includes(term) || snippetLower.includes(term));
        
        if (!hasServiceMatch) return false;
      }
      
      // Prefer titles with business indicators
      const hasBusinessIndicators = /\b(services?|company|contractor|professional|licensed|certified|local|repair|removal|control|exterminator)\b/i.test(rItem.title);
      const hasLocationMatch = location ? new RegExp(location.replace(/\s+/g, '|'), 'i').test(rItem.title + ' ' + rItem.snippet) : true;
      return hasBusinessIndicators || hasLocationMatch;
    });
    
    if (!providerCandidates.length) {
      // Fallback with less strict filtering if no providers found
      const fallbackCandidates = initial.filter(rItem => !EXCLUDE_HOST_PATTERNS.test(rItem.displayLink));
      if (!fallbackCandidates.length) {
        return res.json({ ok: true, service: isService, queryUsed: baseQuery, providers: [], bestProvider: null, bestMeta: { reason: 'No local service providers found', confidence: 0 } });
      }
      return res.json({ ok: true, service: isService, queryUsed: baseQuery, providers: fallbackCandidates.slice(0, 3), bestProvider: null, bestMeta: { reason: 'Limited results - consider refining location or service type', confidence: 0.2 } });
    }

    // 4. Fetch each candidate page (limit 8) & extract details
    const toFetch = providerCandidates.slice(0, 8);
    const phoneRx = /(\+?1[-\.\s]?)?\(?(\d{3})\)?[-\.\s]?(\d{3})[-\.\s]?(\d{4})/g;
    // Crude US address (number + street + suffix) optionally followed by city/state zip
    const addrRx = /\b\d{3,6}[^\n]{0,40}\b(street|st|road|rd|avenue|ave|blvd|lane|ln|drive|dr|court|ct|way)\b[^\n]{0,80}\b([A-Z][a-zA-Z]+,?\s+[A-Z]{2})?\s*(\d{5})(-\d{4})?/i;
    const providers = [];
    for (const cand of toFetch) {
      try {
        const pageResp = await fetch(cand.link, { headers: { 'User-Agent': 'RenaissanceRealtyBot/1.0' }, redirect: 'follow' });
        const html = await pageResp.text();
        const text = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ');
        let phone = null; const phones = new Set();
        let m; while ((m = phoneRx.exec(text)) && phones.size < 3) { phones.add(m[0].trim()); }
        if (phones.size) phone = Array.from(phones)[0];
        const addrMatch = text.match(addrRx);
        const address = addrMatch ? addrMatch[0].replace(/\s{2,}/g,' ').trim() : null;
        
        // Extract actual company name - prioritize domain name conversion
        let companyName = cand.title;
        
        // Convert domain name to readable company name
        const domainName = cand.displayLink.replace(/^www\./, '').replace(/\.(com|net|org|biz)$/, '');
        if (domainName.length > 5 && domainName.includes('custom') || domainName.includes('remodel') || domainName.includes('roof') || domainName.includes('plumb') || domainName.includes('hvac')) {
          // Split camelCase and join with spaces, capitalize
          const words = domainName.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-zA-Z]+/).filter(w => w.length > 2);
          if (words.length >= 2) {
            companyName = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
          }
        }
        
        // If domain approach didn't work, clean up original title by removing page-specific text
        if (companyName === cand.title) {
          companyName = cand.title
            .replace(/\s*\|\s*.*$/, '')           // Remove everything after |
            .replace(/\s*-\s*.*$/, '')            // Remove everything after -
            .replace(/\s*\.\.\.$/, '')            // Remove trailing ...
            .replace(/\s+in\s+[A-Z][a-zA-Z\s,]+$/i, '') // Remove location suffixes
            .trim();
        }
        
        // Tagline heuristic: first sentence containing 'service' or 'repair'
        const tagline = (text.match(/[^\.]*\b(service|repair|licensed|bonded|insured|emergency)\b[^\.]*\./i) || [null])[0];
        const emailRx = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
        const emails = [];
        let em;
        while ((em = emailRx.exec(text)) && emails.length < 3) {
          const val = em[0].toLowerCase();
            if (!/example\.com|wix\.com|squareupemail/.test(val) && !emails.includes(val)) emails.push(val);
        }
        providers.push({ ...cand, title: companyName, originalTitle: cand.title, phone, address, tagline: tagline?.trim() || null, emails });
      } catch (e) {
        providers.push({ ...cand, error: (e && e.message) || 'fetch_failed' });
      }
    }

    // 5. Rank / choose best provider
    let best = null;
    if (OPENAI_API_KEY && providers.length) {
      try {
        const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
        const summaryLines = providers.map(p => `#${p.index} ${p.title} | host:${p.displayLink} | phone:${p.phone||'n/a'} | address:${p.address? p.address.slice(0,80):'n/a'} | tagline:${(p.tagline||'').slice(0,90)}`);
        const rankResp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'Select the single best LOCAL SERVICE COMPANY for this maintenance issue. Prioritize: 1) Local businesses over national chains, 2) Complete contact info (phone + address), 3) Professional service providers over advice/DIY sites, 4) Companies that specifically serve the requested location. Avoid how-to articles, forums, or general advice sites. Return strict JSON {index, reason, confidence (0-1)}.' },
              { role: 'user', content: `Issue: ${rawIssue}\nLocation: ${location}\nProviders:\n${summaryLines.join('\n')}\n\nSelect the best LOCAL service company (not article/guide):` }
            ],
            temperature: 0.1,
            max_tokens: 200
          })
        });
        const rankJson = await rankResp.json();
        const textOut = rankJson?.choices?.[0]?.message?.content || '';
        try { const parsed = JSON.parse(textOut); if (Number.isInteger(parsed?.index)) best = parsed; } catch {}
      } catch {}
    }
    if (!best && providers.length) {
      // heuristic fallback: provider with both phone & address else first
      const withContact = providers.filter(p => p.phone && p.address);
      const chosen = withContact[0] || providers[0];
      best = { index: chosen.index, reason: 'Heuristic fallback (contact info present)', confidence: 0.4 };
    }
    // Email inference for best provider if no email already
    let primaryEmail = null; let primaryEmailSource = null; let emailGuessed = false;
    let bestProviderObj = best ? providers.find(p => p.index === best.index) || null : null;
    if (bestProviderObj) {
      if (bestProviderObj.emails && bestProviderObj.emails.length) {
        primaryEmail = bestProviderObj.emails[0];
        primaryEmailSource = 'scraped';
      } else {
        try {
          const inferred = await inferEmailForProvider(bestProviderObj);
            if (inferred) {
              primaryEmail = inferred.email;
              primaryEmailSource = inferred.source;
              emailGuessed = inferred.guessed || false;
            }
        } catch(e) {
          console.warn('[service-search] email inference failed', e?.message);
        }
      }
      if (primaryEmail) {
        bestProviderObj.primaryEmail = primaryEmail;
        bestProviderObj.primaryEmailSource = primaryEmailSource;
        bestProviderObj.emailGuessed = emailGuessed;
      }
    }

    const response = { ok: true, service: isService, queryUsed: baseQuery, issueExtracted: rawIssue, locationExtracted: location, providers: wantFull ? providers : undefined, bestProvider: bestProviderObj, bestMeta: best, primaryEmail, primaryEmailSource, emailGuessed };
    return res.json(response);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Service search failed' });
  }
});

// --- AI-Enhanced Service Provider Search with Review Analysis ---
// Uses Google Places API + AI to find and analyze repair service companies
// Query params:
//   repairType: (string) specific repair description e.g. "kitchen sink leak"
//   serviceCategory: (string) category like plumbing, electrical, hvac, etc.
//   location: (string) property address or city/state
//   urgency: (string) emergency|high|medium|low (default: medium)
//   quick: (boolean) if true, returns quick results without deep review analysis
app.get('/api/smart-provider-search', async (req, res) => {
  console.log('[smart-provider-search] Request received:', req.query);
  
  try {
    if (!aiProviderSelector) {
      return res.status(503).json({ 
        ok: false, 
        error: 'AI Provider Selector not available',
        fallback: 'Use /service-search endpoint instead'
      });
    }

    const repairType = (req.query.repairType || req.query.issue || '').toString().trim();
    const serviceCategory = (req.query.serviceCategory || req.query.category || 'general').toString().trim();
    const location = (req.query.location || req.query.address || '').toString().trim();
    const urgency = (req.query.urgency || 'medium').toString().trim();
    const quickSearch = (req.query.quick || '').toString() === 'true';

    if (!location) {
      return res.status(400).json({ ok: false, error: 'Location is required' });
    }

    if (!repairType && !serviceCategory) {
      return res.status(400).json({ ok: false, error: 'Either repairType or serviceCategory is required' });
    }

    console.log('[smart-provider-search] Searching for:', {
      repairType,
      serviceCategory,
      location,
      urgency,
      quickSearch
    });

    let result;
    
    if (quickSearch) {
      // Quick search - just get providers without deep analysis
      const maxCandidates = Math.max(1, Math.min(parseInt(req.query.limit || '6', 10) || 6, 8));
      result = await aiProviderSelector.quickProviderSearch(
        serviceCategory || 'general',
        location,
        { maxCandidates, issueDescription: repairType }
      );
    } else {
      // Full AI analysis with review evaluation
      result = await aiProviderSelector.findBestRepairService({
        repairType: repairType || `${serviceCategory} repair`,
        serviceCategory: serviceCategory || 'general',
        location,
        urgency,
        maxCandidates: 5,
        includeDetailedReviews: true
      });
    }

    if (!result.ok) {
      return res.status(404).json({
        ok: false,
        error: result.error || 'No providers found',
        searchCriteria: { repairType, serviceCategory, location, urgency }
      });
    }

    // For full search, format the response for voice call integration
    if (!quickSearch && result.selected) {
      result.voiceCallReady = {
        providerName: result.selected.name,
        providerPhone: result.selected.phone,
        providerAddress: result.selected.address,
        selectionConfidence: result.selected.selectionConfidence,
        callScript: result.callScript,
        reviewSummary: result.selected.reviewAnalysis?.summary || result.selected.selectionReasoning
      };
    }

    return res.json(result);

  } catch (error) {
    console.error('[smart-provider-search] Error:', error);
    return res.status(500).json({ 
      ok: false, 
      error: error.message || 'Smart provider search failed'
    });
  }
});

// --- Get Provider Details with Review Analysis ---
// Fetches detailed info for a specific provider including AI review analysis
app.get('/api/provider-details/:placeId', async (req, res) => {
  console.log('[provider-details] Request for:', req.params.placeId);
  
  try {
    if (!aiProviderSelector) {
      return res.status(503).json({ 
        ok: false, 
        error: 'AI Provider Selector not available'
      });
    }

    const placeId = req.params.placeId;
    const repairType = (req.query.repairType || req.query.issue || '').toString().trim();
    const urgency = (req.query.urgency || 'medium').toString().trim();
    const analyzeReviews = (req.query.analyze || 'true').toString() !== 'false';

    // Get provider details
    const detailsResult = await aiProviderSelector.getProviderDetails(placeId);
    
    if (!detailsResult.ok || !detailsResult.details) {
      return res.status(404).json({
        ok: false,
        error: detailsResult.error || 'Provider not found'
      });
    }

    // Optionally analyze reviews if repairType provided
    let reviewAnalysis = null;
    if (analyzeReviews && repairType && detailsResult.details.reviews?.length > 0) {
      const analysisResult = await aiProviderSelector.analyzeProviderReviews(
        detailsResult.details,
        repairType,
        urgency
      );
      if (analysisResult.ok) {
        reviewAnalysis = analysisResult.analysis;
      }
    }

    return res.json({
      ok: true,
      provider: detailsResult.details,
      reviewAnalysis,
      voiceCallReady: detailsResult.details.phone ? {
        providerName: detailsResult.details.name,
        providerPhone: detailsResult.details.phone,
        providerAddress: detailsResult.details.address
      } : null
    });

  } catch (error) {
    console.error('[provider-details] Error:', error);
    return res.status(500).json({ 
      ok: false, 
      error: error.message || 'Failed to get provider details'
    });
  }
});

// --- Compare Multiple Providers ---
// Compare and rank multiple providers for a specific repair
app.post('/api/compare-providers', async (req, res) => {
  console.log('[compare-providers] Request received');
  
  try {
    if (!aiProviderSelector) {
      return res.status(503).json({ 
        ok: false, 
        error: 'AI Provider Selector not available'
      });
    }

    const { placeIds, repairType, urgency = 'medium' } = req.body || {};

    if (!placeIds || !Array.isArray(placeIds) || placeIds.length < 2) {
      return res.status(400).json({ 
        ok: false, 
        error: 'At least 2 placeIds are required for comparison' 
      });
    }

    if (!repairType) {
      return res.status(400).json({ 
        ok: false, 
        error: 'repairType is required for comparison' 
      });
    }

    // Fetch details for all providers
    const candidatesWithDetails = [];
    for (const placeId of placeIds.slice(0, 5)) { // Limit to 5
      const detailsResult = await aiProviderSelector.getProviderDetails(placeId);
      if (detailsResult.ok && detailsResult.details) {
        candidatesWithDetails.push(detailsResult.details);
      }
    }

    if (candidatesWithDetails.length < 2) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Could not fetch details for enough providers' 
      });
    }

    // Use AI to select best provider
    const selectionResult = await aiProviderSelector.selectBestProvider(
      candidatesWithDetails,
      repairType,
      urgency
    );

    return res.json({
      ok: true,
      ...selectionResult,
      candidatesAnalyzed: candidatesWithDetails.length
    });

  } catch (error) {
    console.error('[compare-providers] Error:', error);
    return res.status(500).json({ 
      ok: false, 
      error: error.message || 'Provider comparison failed'
    });
  }
});

// --- Appointment Scheduling API (MVP) ---
app.post('/api/appointments', async (req, res) => {
  try {
    const { address, issueDescription, providerId, providerEmail } = req.body || {};
    if (!address || !issueDescription) return res.status(400).json({ ok:false, error:'Missing address or issueDescription' });
    // Generate initial slots
    const slots = generateInitialSlots();
    const apt = newAppointmentRequest({ address, issueDescription, providerId: providerId || null, preferredSlots: slots });
    insertAppointment(apt);
    if (providerEmail) {
      apt.channelSelected = 'email';
      apt.status = AppointmentStatus.OUTBOUND_SENT;
      apt.updatedAt = new Date().toISOString();
      const attempt = newAttempt({ requestId: apt.id, channel:'email', providerId: providerId || 'unknown', payloadSnapshot: { providerEmail } });
      insertAttempt(attempt);
      const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3001';
      const email = composeSchedulingEmail({ request: apt, provider: { email: providerEmail }, slots, baseUrl });
      const dispatch = await sendGmailHtml({ to: providerEmail, subject: email.subject, html: email.html });
      if (!dispatch.ok) {
        console.log('[appointment-email-fallback-log] To:', providerEmail, email.subject);
      }
      attempt.status = dispatch.ok ? 'success' : 'failed';
      attempt.completedAt = new Date().toISOString();
      attempt.responseRaw = dispatch;
      updateAttempt(attempt);
      apt.attempts.push(attempt.id);
      updateAppointment(apt);
      return res.json({ ok:true, appointment: apt, emailPreview: { subject: email.subject, snippet: email.html.substring(0,140) }, dispatch });
    } else {
      apt.status = AppointmentStatus.PROVIDER_SELECTED;
      updateAppointment(apt);
      return res.json({ ok:true, appointment: apt, warning:'No providerEmail supplied - awaiting contact channel' });
    }
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/api/appointments', (req,res)=>{
  res.json({ ok:true, appointments: listAppointments() });
});

app.get('/api/appointments/:id', (req,res)=>{
  const apt = getAppointment(req.params.id);
  if (!apt) return res.status(404).json({ ok:false, error:'Not found' });
  res.json({ ok:true, appointment: apt });
});

app.get('/api/appointments/confirm', (req,res)=>{
  const { token } = req.query;
  const payload = verifyToken((token||'').toString());
  if (!payload) return res.status(400).send('Invalid or expired token');
  const apt = getAppointment(payload.requestId);
  if (!apt) return res.status(404).send('Appointment not found');
  if (apt.status === AppointmentStatus.CONFIRMED) return res.send('Already confirmed');
  // Mark selected slot
  const slot = apt.preferredSlots.find(s=>s.id === payload.slotId);
  if (!slot) return res.status(400).send('Slot not found');
  slot.status = 'accepted';
  apt.confirmedSlotId = slot.id;
  apt.status = AppointmentStatus.CONFIRMED;
  apt.updatedAt = new Date().toISOString();
  updateAppointment(apt);
  res.send('Appointment confirmed. Thank you!');
});

app.get('/api/appointments/propose', (req,res)=>{
  const { token } = req.query;
  const payload = verifyToken((token||'').toString());
  if (!payload) return res.status(400).send('Invalid or expired token');
  const apt = getAppointment(payload.requestId);
  if (!apt) return res.status(404).send('Appointment not found');
  const newToken = newActionToken({ requestId: apt.id, action:'confirm', slotId: null, ttlMs: 1000*60*60 });
  res.send(`<html><body><h3>Suggest a Different Time</h3><form method='POST' action='/api/appointments/${apt.id}/provider-slot'><input type='hidden' name='token' value='${newToken}'/><label>Start (ISO): <input name='start'/></label><br/><label>End (ISO): <input name='end'/></label><br/><button type='submit'>Submit</button></form></body></html>`);
});

app.post('/api/appointments/:id/provider-slot', express.urlencoded({ extended:true }), (req,res)=>{
  const { token, start, end } = req.body || {};
  const payload = verifyToken((token||'').toString());
  if (!payload) return res.status(400).send('Invalid token');
  const apt = getAppointment(req.params.id);
  if (!apt) return res.status(404).send('Not found');
  if (!start || !end) return res.status(400).send('Missing start/end');
  const proposed = { id:'slot_'+Date.now(), start, end, score:0.5, source:'provider', status:'proposed' };
  apt.preferredSlots.push(proposed);
  apt.status = AppointmentStatus.RESCHEDULE_REQUESTED;
  apt.updatedAt = new Date().toISOString();
  updateAppointment(apt);
  res.send('Alternative time submitted. We will review.');
});

// Helper function to extract zip code from address string
function extractZipCode(address) {
  if (!address) return null;
  
  // Strategy 1: Look for zip code after state abbreviation (most common pattern)
  // Matches: "MD 20854" or "MD20854" or "Maryland 20854"
  const stateZipMatch = address.match(/\b[A-Z]{2}\s*(\d{5})(?:-\d{4})?\b/);
  if (stateZipMatch) return stateZipMatch[1];
  
  // Strategy 2: Look for zip code at the end of the address
  const endZipMatch = address.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (endZipMatch) return endZipMatch[1];
  
  // Strategy 3: Look for any 5-digit number that's not at the beginning (to avoid street numbers)
  // Must be preceded by a comma or space
  const anyZipMatch = address.match(/[,\s](\d{5})(?:-\d{4})?\b/);
  if (anyZipMatch) return anyZipMatch[1];
  
  return null;
}

// Helper function to create and dispatch an appointment
async function createAndDispatchAppointment({ address, issueDescription, providerEmail, providerId, extractedIssue, extractedCategory, isGuessedEmail }) {
  const slots = generateInitialSlots();
  const apt = newAppointmentRequest({ address, issueDescription, providerId: providerId || null, preferredSlots: slots });
  if (extractedIssue) apt.extractedIssue = extractedIssue;
  if (extractedCategory) apt.extractedCategory = extractedCategory;
  insertAppointment(apt);
  if (providerEmail) {
    apt.channelSelected = 'email';
    apt.status = AppointmentStatus.OUTBOUND_SENT;
    apt.updatedAt = new Date().toISOString();
  const attempt = newAttempt({ requestId: apt.id, channel:'email', providerId: providerId || 'unknown', payloadSnapshot: { providerEmail, isGuessedEmail: !!isGuessedEmail } });
    insertAttempt(attempt);
    const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3001';
    const email = composeSchedulingEmail({ request: apt, provider: { email: providerEmail }, slots, baseUrl });
    const dispatch = await sendGmailHtml({ to: providerEmail, subject: email.subject, html: email.html });
    if (!dispatch.ok) console.log('[appointment-email-fallback-log] To:', providerEmail, email.subject);
    attempt.status = dispatch.ok ? 'success' : 'failed';
    attempt.completedAt = new Date().toISOString();
    attempt.responseRaw = dispatch;
    updateAttempt(attempt);
    apt.attempts.push(attempt.id);
    updateAppointment(apt);
    return { appointment: apt, dispatch, email };
  } else {
    apt.status = AppointmentStatus.PROVIDER_SELECTED;
    updateAppointment(apt);
    return { appointment: apt, dispatch: { ok:false, error:'no_provider_email' } };
  }
}

// Attempt to discover or infer an email for a provider result when none was scraped on the main page.
// Strategy:
// 1. If provider already has emails array -> return first.
// 2. Try fetching common contact paths: /contact, /contact-us, /about, /about-us
// 3. Extract emails with existing regex (duplicate logic kept local to avoid refactor)
// 4. If still none, pattern-generate guesses using domain (info@, support@, service@, office@)
// 5. Return first candidate with flag { guessed: boolean }
async function inferEmailForProvider(provider) {
  try {
    if (!provider) return null;
    if (provider.emails && provider.emails.length) return { email: provider.emails[0], guessed:false, source:'scraped' };
    const domain = (provider.displayLink || provider.link || '').replace(/^https?:\/\//,'').replace(/\/.*$/,'');
    if (!domain) return null;
    const base = provider.link && provider.link.startsWith('http') ? new URL(provider.link).origin : `https://${domain}`;
    const paths = ['/contact','/contact-us','/about','/about-us'];
    const emailRx = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
    const found = new Set();
    for (const p of paths) {
      try {
        const u = base + p;
        const resp = await fetch(u, { headers:{ 'User-Agent':'RenaissanceRealtyBot/1.0' }, redirect:'follow' });
        if (!resp.ok) continue;
        const html = await resp.text();
        let m; while ((m = emailRx.exec(html)) && found.size < 5) {
          const val = m[0].toLowerCase();
          if (!/example\.com|wix\.com|squareupemail/.test(val)) found.add(val);
        }
        if (found.size) {
          return { email: Array.from(found)[0], guessed:false, source:'contact-page' };
        }
      } catch {}
    }
    // Pattern guesses
    const guessLocalParts = ['info','contact','support','service','services','office'];
    const guesses = guessLocalParts.map(lp => `${lp}@${domain}`);
    if (guesses.length) {
      return { email: guesses[0], guessed:true, source:'pattern' };
    }
  } catch (e) {
    console.warn('[inferEmail] failed', e?.message);
  }
  return null;
}

app.post('/api/auto-appointment', async (req,res)=>{
  console.log('[auto-appointment] incoming body:', req.body);
  try {
    const { description, address } = req.body || {};
    if (!description || !address) {
      console.log('[auto-appointment] missing params');
      return res.status(400).json({ ok:false, error:'Missing description or address' });
    }
    // Reuse service-search logic by calling internal fetch to /service-search
    const url = new URL(`http://localhost:${PORT}/service-search`);
    url.searchParams.set('description', description);
    url.searchParams.set('full','true');
    console.log('[auto-appointment] fetching service-search:', url.toString());
    const searchResp = await fetch(url.toString());
    console.log('[auto-appointment] service-search status:', searchResp.status);
    const searchJson = await searchResp.json();
    console.log('[auto-appointment] service-search json keys:', Object.keys(searchJson));
    if (!searchJson.ok) {
      console.log('[auto-appointment] service-search failed payload:', searchJson);
      return res.status(500).json({ ok:false, error:'Service search failed', detail: searchJson });
    }
    const providers = searchJson.providers || [];
    console.log('[auto-appointment] providers count:', providers.length);
    // Pick provider with email first; else phone only (still create record but flagged)
    let chosen = null;
    let email = null;
    for (const p of providers) {
      if (p.emails && p.emails.length) { chosen = p; email = p.emails[0]; break; }
    }
    if (!chosen && providers.length) { chosen = providers[0]; }
    if (!chosen) {
      console.log('[auto-appointment] no providers found');
      return res.status(404).json({ ok:false, error:'No providers found to schedule with' });
    }
    let inferredMeta = null;
    if (!email) {
      inferredMeta = await inferEmailForProvider(chosen);
      if (inferredMeta) {
        email = inferredMeta.email;
      }
    }
    console.log('[auto-appointment] chosen provider:', { title: chosen.title, displayLink: chosen.displayLink, email, phone: chosen.phone, inferred: inferredMeta });
  const { appointment, dispatch } = await createAndDispatchAppointment({ address, issueDescription: description, providerEmail: email, providerId: chosen.displayLink, extractedIssue: searchJson.issueExtracted, extractedCategory: searchJson.bestMeta?.serviceCategory || null, isGuessedEmail: inferredMeta?.guessed });
    console.log('[auto-appointment] appointment created id:', appointment.id, 'dispatch ok:', dispatch.ok);
    res.json({ ok:true, appointment, providerChosen: { title: chosen.title, email, phone: chosen.phone, inferred: inferredMeta }, dispatched: dispatch });
  } catch (e) {
    console.error('[auto-appointment] error:', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// --- Form automation endpoints removed ---
// Playwright, Puppeteer, and Cheerio-based form automation has been removed.
app.get('/api/form-discovery', async (req,res)=>{
  res.status(410).json({ ok:false, error:'form_automation_removed', message:'Form discovery and automation features have been removed from this server.' });
});

app.post('/api/form-schedule', strictRateLimiter, async (req,res)=>{
  res.status(410).json({ ok:false, error:'form_automation_removed', message:'Form scheduling automation features have been removed from this server.' });
});

const STOCK_QUOTE_TTL_DAYS = 15 / (24 * 60);
const STOCK_HISTORY_PAST_TTL_DAYS = 7;
const STOCK_HISTORY_TODAY_TTL_DAYS = 12 / 24;
const STOCK_NEWS_TTL_DAYS = 1 / 24;

function normalizeStockTicker(ticker) {
  return String(ticker || '').trim().toUpperCase();
}

function normalizeStockTickerList(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(',')
        .map((ticker) => normalizeStockTicker(ticker))
        .filter(Boolean)
    )
  );
}

function getStockHistoryTtlDays(toDate) {
  const today = new Date().toISOString().split('T')[0];
  return toDate && toDate < today ? STOCK_HISTORY_PAST_TTL_DAYS : STOCK_HISTORY_TODAY_TTL_DAYS;
}

async function loadPolygonCachedData({ cacheKey, ttlDays, forceRefresh, fetcher }) {
  if (!forceRefresh) {
    const cached = await getCachedPolygonData(cacheKey, ttlDays).catch(() => null);
    if (cached && !cached.stale) {
      return { data: cached.data, cached: true, stale: false, cachedAt: cached.updatedAt };
    }

    if (cached?.data !== undefined) {
      fetcher()
        .then((fresh) => {
          if (fresh !== null && fresh !== undefined) {
            return setCachedPolygonData(cacheKey, fresh, ttlDays);
          }
          return null;
        })
        .catch((error) => console.warn(`[Polygon Cache] ${cacheKey} background refresh failed:`, error.message));

      return { data: cached.data, cached: true, stale: true, cachedAt: cached.updatedAt };
    }
  }

  const data = await fetcher();
  if (data !== null && data !== undefined) {
    setCachedPolygonData(cacheKey, data, ttlDays).catch((error) => console.warn('[Polygon Cache] write error:', error.message));
  }

  return { data, cached: false, stale: false, cachedAt: null };
}

async function respondWithPolygonCache(req, res, { cacheKey, ttlDays, fetcher, notFoundError = 'stock_data_not_found' }) {
  const forceRefresh = req.query.refresh === 'true';

  try {
    const result = await loadPolygonCachedData({ cacheKey, ttlDays, forceRefresh, fetcher });
    if (result.data === null || result.data === undefined) {
      return res.status(404).json({ ok: false, error: notFoundError });
    }

    return res.json({ ok: true, data: result.data, cached: result.cached, stale: result.stale, cachedAt: result.cachedAt });
  } catch (error) {
    console.error(`[Polygon Cache] ${cacheKey} error:`, error.message);
    const stale = await getCachedPolygonData(cacheKey, ttlDays).catch(() => null);
    if (stale?.data !== undefined) {
      return res.json({ ok: true, data: stale.data, cached: true, stale: true, cachedAt: stale.updatedAt });
    }

    return res.status(500).json({ ok: false, error: error.message || 'polygon_failed' });
  }
}

// =============================================================================
// STOCK MARKET DATA API (Polygon via backend cache)
// =============================================================================

app.get('/api/stocks/basic/:ticker', async (req, res) => {
  const ticker = normalizeStockTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'missing_ticker' });

  return respondWithPolygonCache(req, res, {
    cacheKey: `basic:${ticker}`,
    ttlDays: STOCK_QUOTE_TTL_DAYS,
    fetcher: () => getPolygonBasicInfo(ticker),
    notFoundError: 'basic_info_not_found',
  });
});

app.get('/api/stocks/company/:ticker', async (req, res) => {
  const ticker = normalizeStockTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'missing_ticker' });

  return respondWithPolygonCache(req, res, {
    cacheKey: `company:${ticker}`,
    ttlDays: 7,
    fetcher: () => getPolygonCompanyDetails(ticker),
    notFoundError: 'company_not_found',
  });
});

app.get('/api/stocks/quote/:ticker', async (req, res) => {
  const ticker = normalizeStockTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'missing_ticker' });

  return respondWithPolygonCache(req, res, {
    cacheKey: `quote:${ticker}`,
    ttlDays: STOCK_QUOTE_TTL_DAYS,
    fetcher: () => getPolygonQuote(ticker),
    notFoundError: 'quote_not_found',
  });
});

app.get('/api/stocks/dividends/:ticker', async (req, res) => {
  const ticker = normalizeStockTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'missing_ticker' });

  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '20', 10) || 20));
  return respondWithPolygonCache(req, res, {
    cacheKey: `dividends:${ticker}:${limit}`,
    ttlDays: 1,
    fetcher: () => getPolygonDividends(ticker, limit),
  });
});

app.get('/api/stocks/historical-dividends/:ticker', async (req, res) => {
  const ticker = normalizeStockTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'missing_ticker' });

  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '100', 10) || 100));

  if (!from || !to) {
    return res.status(400).json({ ok: false, error: 'missing_date_range' });
  }

  return respondWithPolygonCache(req, res, {
    cacheKey: `historical-dividends:${ticker}:${from}:${to}:${limit}`,
    ttlDays: 7,
    fetcher: () => getPolygonHistoricalDividends(ticker, from, to, limit),
  });
});

app.get('/api/stocks/splits/:ticker', async (req, res) => {
  const ticker = normalizeStockTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'missing_ticker' });

  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '10', 10) || 10));
  return respondWithPolygonCache(req, res, {
    cacheKey: `splits:${ticker}:${limit}`,
    ttlDays: 30,
    fetcher: () => getPolygonStockSplits(ticker, limit),
  });
});

app.get('/api/stocks/historical-prices/:ticker', async (req, res) => {
  const ticker = normalizeStockTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'missing_ticker' });

  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const timespan = ['day', 'week', 'month'].includes(String(req.query.timespan || 'day'))
    ? String(req.query.timespan)
    : 'day';

  if (!from || !to) {
    return res.status(400).json({ ok: false, error: 'missing_date_range' });
  }

  return respondWithPolygonCache(req, res, {
    cacheKey: `history:${ticker}:${from}:${to}:${timespan}`,
    ttlDays: getStockHistoryTtlDays(to),
    fetcher: () => getPolygonHistoricalPrices(ticker, from, to, timespan),
  });
});

app.get('/api/stocks/financials/:ticker', async (req, res) => {
  const ticker = normalizeStockTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'missing_ticker' });

  const timeframe = req.query.timeframe === 'annual' ? 'annual' : 'quarterly';
  const fallbackLimit = timeframe === 'annual' ? 5 : 20;
  const limit = Math.max(1, Math.min(40, parseInt(req.query.limit || String(fallbackLimit), 10) || fallbackLimit));

  return respondWithPolygonCache(req, res, {
    cacheKey: `financials:${ticker}:${timeframe}:${limit}`,
    ttlDays: 7,
    fetcher: () => getPolygonFinancials(ticker, timeframe, limit),
  });
});

app.get('/api/stocks/news/:ticker', async (req, res) => {
  const ticker = normalizeStockTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'missing_ticker' });

  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '10', 10) || 10));
  return respondWithPolygonCache(req, res, {
    cacheKey: `news:${ticker}:${limit}`,
    ttlDays: STOCK_NEWS_TTL_DAYS,
    fetcher: () => getPolygonStockNews(ticker, limit),
  });
});

app.get('/api/stocks/income-data', async (req, res) => {
  const tickers = normalizeStockTickerList(req.query.tickers);
  const forceRefresh = req.query.refresh === 'true';

  if (!tickers.length) {
    return res.status(400).json({ ok: false, error: 'missing_tickers' });
  }

  try {
    const entries = await Promise.all(
      tickers.map(async (ticker) => {
        const [basicInfo, dividends, splits] = await Promise.all([
          loadPolygonCachedData({
            cacheKey: `basic:${ticker}`,
            ttlDays: STOCK_QUOTE_TTL_DAYS,
            forceRefresh,
            fetcher: () => getPolygonBasicInfo(ticker),
          }),
          loadPolygonCachedData({
            cacheKey: `dividends:${ticker}:20`,
            ttlDays: 1,
            forceRefresh,
            fetcher: () => getPolygonDividends(ticker, 20),
          }),
          loadPolygonCachedData({
            cacheKey: `splits:${ticker}:10`,
            ttlDays: 30,
            forceRefresh,
            fetcher: () => getPolygonStockSplits(ticker, 10),
          }),
        ]);

        return {
          ticker,
          basicInfo: basicInfo.data,
          dividends: dividends.data || [],
          splits: splits.data || [],
        };
      })
    );

    const data = {
      basicInfo: {},
      dividends: {},
      splits: {},
    };

    entries.forEach((entry) => {
      if (entry.basicInfo) {
        data.basicInfo[entry.ticker] = entry.basicInfo;
      }
      data.dividends[entry.ticker] = entry.dividends;
      data.splits[entry.ticker] = entry.splits;
    });

    return res.json({ ok: true, data });
  } catch (error) {
    console.error('[Polygon Cache] income-data error:', error.message);
    return res.status(500).json({ ok: false, error: error.message || 'polygon_failed' });
  }
});

// =============================================================================
// POLYMARKET PREDICTION MARKETS API (Public Data - No Auth Required)
// =============================================================================

/**
 * GET /api/polymarket/predictions
 * Returns Fed rate cut and mortgage rate predictions
 * Perfect for displaying in your housing market dashboard
 */
app.get('/api/polymarket/predictions', async (req, res) => {
  const cacheKey = 'polymarket-predictions';
  const forceRefresh = req.query.refresh === 'true';
  try {
    if (!forceRefresh) {
      const cached = await getCachedFredData(cacheKey).catch(() => null);
      if (cached && !cached.stale) {
        return res.json({ ...cached.data, cached: true, cachedAt: cached.updatedAt });
      }
      if (cached?.data) {
        res.json({ ...cached.data, cached: true, stale: true, cachedAt: cached.updatedAt });
        getHousingMarketPredictions()
          .then((fresh) => {
            if (fresh?.ok) {
              return setCachedFredData(cacheKey, fresh);
            }
            return null;
          })
          .catch((error) => console.warn('[Cache] polymarket-predictions background refresh failed:', error.message));
        return;
      }
    }

    const result = await getHousingMarketPredictions();
    if (result?.ok) {
      setCachedFredData(cacheKey, result).catch((error) => console.warn('[Cache] write error:', error.message));
    }
    res.json(result);
  } catch (error) {
    console.error('[polymarket] Predictions error:', error.name);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) {
      return res.json({ ...stale.data, cached: true, stale: true, cachedAt: stale.updatedAt });
    }
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to fetch predictions'
    });
  }
});

/**
 * GET /api/polymarket/economic
 * Returns all economic-related markets (Fed, mortgage, interest rates)
 */
app.get('/api/polymarket/economic', async (req, res) => {
  const cacheKey = 'polymarket-economic';
  const forceRefresh = req.query.refresh === 'true';
  try {
    if (!forceRefresh) {
      const cached = await getCachedFredData(cacheKey).catch(() => null);
      if (cached && !cached.stale) {
        return res.json({ ...cached.data, cached: true, cachedAt: cached.updatedAt });
      }
      if (cached?.data) {
        res.json({ ...cached.data, cached: true, stale: true, cachedAt: cached.updatedAt });
        getEconomicPredictions()
          .then((fresh) => {
            if (fresh?.ok) {
              return setCachedFredData(cacheKey, fresh);
            }
            return null;
          })
          .catch((error) => console.warn('[Cache] polymarket-economic background refresh failed:', error.message));
        return;
      }
    }

    const result = await getEconomicPredictions();
    if (result?.ok) {
      setCachedFredData(cacheKey, result).catch((error) => console.warn('[Cache] write error:', error.message));
    }
    res.json(result);
  } catch (error) {
    console.error('[polymarket] Economic markets error:', error.name);
    const stale = await getCachedFredData(cacheKey).catch(() => null);
    if (stale?.data) {
      return res.json({ ...stale.data, cached: true, stale: true, cachedAt: stale.updatedAt });
    }
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to fetch economic markets'
    });
  }
});

/**
 * GET /api/polymarket/market/:id
 * Get details and live odds for a specific market
 */
app.get('/api/polymarket/market/:id', async (req, res) => {
  try {
    const marketId = req.params.id;
    const result = await getMarketWithOdds(marketId);
    res.json(result);
  } catch (error) {
    console.error('[polymarket] Market details error:', error.name);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to fetch market details' 
    });
  }
});

// ===================================================================
// TENANT EMAIL MONITORING ENDPOINTS (Optional - only if module loaded)
// ===================================================================

if (emailMonitorModule) {
  // API: Check for new tenant emails and analyze them
  // POST /api/tenant-emails/check
  // Body: { 
  //   tenantEmails?: "email1@example.com,email2@example.com", 
  //   searchQuery?: "custom Gmail query", 
  //   maxEmails?: 20, 
  //   autoTriggerSearch?: false,
  //   checkUnresolved?: true,
  //   unresolvedOnly?: false  // Only trigger searches for unresolved issues
  // }
  app.post('/api/tenant-emails/check', async (req, res) => {
    try {
      const { tenantEmails, searchQuery, maxEmails, autoTriggerSearch, checkUnresolved, unresolvedOnly } = req.body || {};
      
      console.log('[Email Monitor] Check request:', { tenantEmails, searchQuery, maxEmails, autoTriggerSearch, checkUnresolved, unresolvedOnly });
      
      const result = await emailMonitorModule.checkTenantEmails({
        tenantEmails,
        searchQuery,
        maxEmails,
        autoTriggerSearch: false, // Will handle manually below
        checkUnresolved: checkUnresolved !== false // Default to true
      });

      if (!result.ok) {
        return res.status(500).json(result);
      }

      // If auto-trigger is enabled and maintenance issues were found, trigger provider searches
      if (autoTriggerSearch && result.results) {
        const triggeredSearches = [];
        
        for (const emailRecord of result.results) {
          const analysis = emailRecord.analysis;
          
          // Check if this issue should trigger a search
          const isMaintenanceIssue = analysis?.isMaintenanceIssue && analysis.confidence >= 60;
          const isUnresolved = !emailRecord.resolutionStatus?.resolved;
          const shouldTrigger = isMaintenanceIssue && (!unresolvedOnly || isUnresolved);
          
          if (shouldTrigger) {
            // Use the AI-generated search query from the email analysis
            const searchQuery = analysis.searchQuery || analysis.issue;
            
            // Build search parameters from email analysis
            const searchParams = {
              description: `${analysis.issue}${analysis.location ? ' in ' + analysis.location : ''}`,
              location: analysis.location || '',
              issue: analysis.issue,
              q: searchQuery, // Use the AI-optimized search query
              service: true,
              num: 5
            };

            console.log(`🔍 [Email Monitor] Auto-triggering provider search...`);
            console.log(`   Issue: ${analysis.issue}`);
            console.log(`   Category: ${analysis.serviceCategory}`);
            console.log(`   Urgency: ${analysis.urgency}`);
            console.log(`   Search Query: ${searchQuery}`);
            console.log(`   Status: ${isUnresolved ? 'UNRESOLVED ⚠️' : 'Recent issue'}`);
            
            try {
              // Call the existing service-search endpoint internally
              const searchUrl = new URL('http://localhost:' + PORT + '/service-search');
              Object.entries(searchParams).forEach(([key, value]) => {
                if (value) searchUrl.searchParams.set(key, String(value));
              });

              const searchResponse = await fetch(searchUrl.toString());
              const searchResult = await searchResponse.json();
              
              const searchSummary = {
                emailId: emailRecord.id,
                threadId: emailRecord.threadId,
                subject: emailRecord.subject,
                from: emailRecord.from,
                issue: analysis.issue,
                serviceCategory: analysis.serviceCategory,
                urgency: analysis.urgency,
                location: analysis.location,
                confidence: analysis.confidence,
                isUnresolved: isUnresolved,
                resolutionConfidence: emailRecord.resolutionStatus?.confidence || 0,
                searchQuery: searchQuery,
                aiSearchQuery: searchResult.queryUsed,
                timestamp: new Date().toISOString()
              };

              if (searchResult.ok) {
                searchSummary.success = true;
                searchSummary.providersFound = searchResult.providers?.length || 0;
                searchSummary.bestProvider = searchResult.bestProvider ? {
                  title: searchResult.bestProvider.title,
                  link: searchResult.bestProvider.link,
                  phone: searchResult.bestProvider.phone,
                  address: searchResult.bestProvider.address,
                  email: searchResult.bestProvider.primaryEmail,
                  confidence: searchResult.bestMeta?.confidence
                } : null;
              } else {
                searchSummary.success = false;
                searchSummary.error = searchResult.error;
              }

              triggeredSearches.push(searchSummary);

              // Log the auto-triggered search
              console.log(`✅ [Email Monitor] Provider search completed`);
              if (searchResult.bestProvider) {
                console.log(`   Best match: ${searchResult.bestProvider.title}`);
                console.log(`   Phone: ${searchResult.bestProvider.phone || 'N/A'}`);
                console.log(`   Email: ${searchResult.bestProvider.primaryEmail || 'N/A'}`);
              } else {
                console.log(`   No suitable providers found`);
              }
            } catch (searchError) {
              console.error(`❌ [Email Monitor] Failed to trigger search:`, searchError.message);
              triggeredSearches.push({
                emailId: emailRecord.id,
                threadId: emailRecord.threadId,
                issue: analysis.issue,
                success: false,
                error: searchError.message,
                timestamp: new Date().toISOString()
              });
            }
          }
        }

        result.triggeredSearches = triggeredSearches;
        result.searchesTriggered = triggeredSearches.length;
        result.successfulSearches = triggeredSearches.filter(s => s.success).length;
      }

      res.json(result);
    } catch (error) {
      console.error('[Email Monitor] Check error:', error);
      res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });

  // API: Analyze a specific email text (for testing/manual use)
  // POST /api/tenant-emails/analyze
  // Body: { emailContent: "...", subject?: "...", from?: "..." }
  app.post('/api/tenant-emails/analyze', async (req, res) => {
    try {
      const { emailContent, subject, from } = req.body || {};
      
      if (!emailContent) {
        return res.status(400).json({ 
          ok: false, 
          error: 'emailContent is required' 
        });
      }

      const analysis = await emailMonitorModule.analyzeTenantEmail(
        emailContent,
        subject || '',
        from || ''
      );

      res.json(analysis);
    } catch (error) {
      console.error('[Email Monitor] Analysis error:', error);
      res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });

  // API: Get processed emails history
  // GET /api/tenant-emails/history?limit=20
  app.get('/api/tenant-emails/history', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit || '20', 10);
      const result = await emailMonitorModule.getProcessedEmailsHistory(limit);
      res.json(result);
    } catch (error) {
      console.error('[Email Monitor] History error:', error);
      res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });

  // API: Get monitor state (last check time, stats, etc.)
  // GET /api/tenant-emails/state
  app.get('/api/tenant-emails/state', async (req, res) => {
    try {
      const result = await emailMonitorModule.getMonitorState();
      res.json(result);
    } catch (error) {
      console.error('[Email Monitor] State error:', error);
      res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });

  // API: Reset monitor state (for testing)
  // POST /api/tenant-emails/reset
  app.post('/api/tenant-emails/reset', async (req, res) => {
    try {
      const result = await emailMonitorModule.resetMonitorState();
      res.json(result);
    } catch (error) {
      console.error('[Email Monitor] Reset error:', error);
      res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });

  // API: Analyze tenant message list for maintenance issues (SIMPLIFIED)
  // POST /api/tenant-messages/analyze
  // Body: { messages: [{ content, date, from, subject }], propertyAddress?: string }
  // Simply analyzes messages and returns detected maintenance issues with property location
  app.post('/api/tenant-messages/analyze', async (req, res) => {
    try {
      const { messages, propertyAddress } = req.body || {};
      
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ 
          ok: false, 
          error: 'messages array is required' 
        });
      }

      console.log(`🔍 [Message Analyzer] Analyzing ${messages.length} tenant messages...`);
      console.log(`📍 [Message Analyzer] Property address: ${propertyAddress || 'Not provided'}`);
      
      const maintenanceIssues = [];

      // Analyze each message
      for (const msg of messages) {
        const emailContent = msg.content || msg.text || '';
        const subject = msg.subject || '';
        const from = msg.from || 'tenant';

        console.log(`📧 [Message ${msg.id}] Subject: ${subject}`);
        console.log(`📝 [Message ${msg.id}] Content length: ${emailContent.length} chars`);
        console.log(`📝 [Message ${msg.id}] Content preview: ${emailContent.substring(0, 150)}...`);

        if (!emailContent) continue;

        // Use the existing AI analysis function
        const analysis = await emailMonitorModule.analyzeTenantEmail(
          emailContent,
          subject,
          from
        );

        if (analysis.isMaintenanceIssue && analysis.confidence >= 60) {
          // Override location with property address if provided
          const location = propertyAddress || analysis.location || 'Potomac MD';
          
          maintenanceIssues.push({
            messageId: msg.id,
            date: msg.date,
            subject,
            from,
            issue: {
              issue: analysis.issue,
              description: analysis.issue,
              serviceCategory: analysis.serviceCategory,
              urgency: analysis.urgency,
              location: location,
              searchQuery: `${analysis.issue} in ${location}`
            }
          });

          console.log(`🔧 Maintenance issue detected: ${analysis.issue}`);
          console.log(`   Category: ${analysis.serviceCategory}, Urgency: ${analysis.urgency}`);
          console.log(`   Location: ${location}`);
          console.log(`   Frontend will trigger provider search...`);
        }
      }

      res.json({
        ok: true,
        messagesAnalyzed: messages.length,
        maintenanceIssues: maintenanceIssues.length,
        issues: maintenanceIssues
      });

    } catch (error) {
      console.error('[Message Analyzer] Error:', error);
      res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });

  // API: Check for unresolved maintenance issues only and auto-search providers
  // POST /api/tenant-emails/check-unresolved
  // Body: { tenantEmails?: "...", searchQuery?: "...", maxEmails?: 30, autoSearch?: true }
  app.post('/api/tenant-emails/check-unresolved', async (req, res) => {
    try {
      const { tenantEmails, searchQuery, maxEmails, autoSearch } = req.body || {};
      
      console.log('🔍 [Email Monitor] Checking for UNRESOLVED maintenance issues...');
      
      // Check emails with unresolved detection enabled
      const result = await emailMonitorModule.checkTenantEmails({
        tenantEmails,
        searchQuery,
        maxEmails: maxEmails || 30,
        autoTriggerSearch: autoSearch !== false, // Default to true
        checkUnresolved: true
      });

      if (!result.ok) {
        return res.status(500).json(result);
      }

      // Filter to only unresolved issues
      const unresolvedIssues = result.results?.filter(email => 
        email.analysis?.isMaintenanceIssue && 
        email.analysis.confidence >= 60 &&
        !email.resolutionStatus?.resolved
      ) || [];

      // If autoSearch is enabled, trigger provider searches for all unresolved issues
      if (autoSearch !== false && unresolvedIssues.length > 0) {
        const triggeredSearches = [];
        
        console.log(`📋 [Email Monitor] Found ${unresolvedIssues.length} unresolved issue(s), triggering searches...`);
        
        for (const emailRecord of unresolvedIssues) {
          const analysis = emailRecord.analysis;
          const searchQuery = analysis.searchQuery || analysis.issue;
          
          const searchParams = {
            description: `${analysis.issue}${analysis.location ? ' in ' + analysis.location : ''}`,
            location: analysis.location || '',
            issue: analysis.issue,
            q: searchQuery,
            service: true,
            num: 5
          };

          console.log(`🔧 [Email Monitor] Unresolved: ${analysis.issue} (${analysis.urgency})`);
          
          try {
            const searchUrl = new URL('http://localhost:' + PORT + '/service-search');
            Object.entries(searchParams).forEach(([key, value]) => {
              if (value) searchUrl.searchParams.set(key, String(value));
            });

            const searchResponse = await fetch(searchUrl.toString());
            const searchResult = await searchResponse.json();
            
            const searchSummary = {
              emailId: emailRecord.id,
              threadId: emailRecord.threadId,
              subject: emailRecord.subject,
              from: emailRecord.from,
              date: emailRecord.date,
              issue: analysis.issue,
              serviceCategory: analysis.serviceCategory,
              urgency: analysis.urgency,
              location: analysis.location,
              confidence: analysis.confidence,
              resolutionConfidence: emailRecord.resolutionStatus?.confidence || 0,
              searchQuery: searchQuery,
              aiSearchQuery: searchResult.queryUsed,
              timestamp: new Date().toISOString()
            };

            if (searchResult.ok && searchResult.bestProvider) {
              searchSummary.success = true;
              searchSummary.providersFound = searchResult.providers?.length || 0;
              searchSummary.bestProvider = {
                title: searchResult.bestProvider.title,
                link: searchResult.bestProvider.link,
                phone: searchResult.bestProvider.phone,
                address: searchResult.bestProvider.address,
                email: searchResult.bestProvider.primaryEmail,
                confidence: searchResult.bestMeta?.confidence
              };
              console.log(`   ✅ Found: ${searchResult.bestProvider.title}`);
            } else {
              searchSummary.success = false;
              searchSummary.error = searchResult.error || 'No providers found';
              console.log(`   ⚠️  No providers found`);
            }

            triggeredSearches.push(searchSummary);
          } catch (searchError) {
            console.error(`   ❌ Search failed:`, searchError.message);
            triggeredSearches.push({
              emailId: emailRecord.id,
              issue: analysis.issue,
              success: false,
              error: searchError.message,
              timestamp: new Date().toISOString()
            });
          }
        }

        result.triggeredSearches = triggeredSearches;
        result.searchesTriggered = triggeredSearches.length;
        result.successfulSearches = triggeredSearches.filter(s => s.success).length;
      }

      // Summary for unresolved issues
      const summary = {
        ok: true,
        totalEmailsChecked: result.checked,
        totalMaintenanceIssues: result.maintenanceIssues,
        unresolvedIssues: unresolvedIssues.length,
        unresolvedDetails: unresolvedIssues.map(e => ({
          subject: e.subject,
          from: e.from,
          date: e.date,
          issue: e.analysis.issue,
          category: e.analysis.serviceCategory,
          urgency: e.analysis.urgency,
          confidence: e.analysis.confidence,
          resolutionConfidence: e.resolutionStatus?.confidence || 0
        })),
        triggeredSearches: result.triggeredSearches || [],
        searchesTriggered: result.searchesTriggered || 0,
        successfulSearches: result.successfulSearches || 0,
        state: result.state
      };

      res.json(summary);
    } catch (error) {
      console.error('[Email Monitor] Check unresolved error:', error);
      res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });

  console.log('[Email Monitor] API endpoints registered:');
  console.log('  POST /api/tenant-emails/check');
  console.log('  POST /api/tenant-emails/check-unresolved');
  console.log('  POST /api/tenant-emails/analyze');
  console.log('  GET  /api/tenant-emails/history');
  console.log('  GET  /api/tenant-emails/state');
  console.log('  POST /api/tenant-emails/reset');

  // ===================================================================
  // AUTOMATIC MONITORING - Runs every 15 minutes
  // ===================================================================
  
  // Check if automatic monitoring is enabled (default: true)
  const AUTO_MONITOR_ENABLED = process.env.AUTO_MONITOR_EMAILS !== 'false';
  const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL_MINUTES || '15', 10);
  
  if (AUTO_MONITOR_ENABLED) {
    // Dynamic import of node-cron (only if auto-monitoring is enabled)
    import('node-cron').then(async ({ default: cron }) => {
      
      // Shared function for checking emails
      const performEmailCheck = async (isInitial = false) => {
        const checkType = isInitial ? 'INITIAL' : 'SCHEDULED';
        console.log(`🔍 [Auto-Monitor] Running ${checkType} check for unresolved maintenance issues...`);
        
        try {
          const result = await emailMonitorModule.checkTenantEmails({
            autoTriggerSearch: true,      // Automatically search for providers
            checkUnresolved: true,         // Check resolution status
            maxEmails: 30                  // Check last 30 emails
          });
          
          if (result.ok) {
            console.log(`✅ [Auto-Monitor] ${checkType} check complete:`);
            console.log(`   - Checked: ${result.checked} emails`);
            console.log(`   - Maintenance issues: ${result.maintenanceIssues}`);
            console.log(`   - Unresolved: ${result.unresolvedIssues || 0}`);
            
            // If unresolved issues found with providers
            if (result.triggeredSearches && result.triggeredSearches.length > 0) {
              console.log(`   - Provider searches: ${result.searchesTriggered}`);
              console.log(`   - Successful matches: ${result.successfulSearches}`);
              
              // Log each unresolved issue with its matched provider
              result.triggeredSearches.forEach(search => {
                if (search.success && search.bestProvider) {
                  console.log(`   📞 ${search.issue} → ${search.bestProvider.title}`);
                  console.log(`      Phone: ${search.bestProvider.phone || 'N/A'}`);
                  console.log(`      Email: ${search.bestProvider.email || 'N/A'}`);
                }
              });
              
              // TODO: Add notification system here
              // - Send email to property manager with issue summary
              // - Send SMS for high-urgency issues
              // - Create dashboard notifications
              console.log(`\n⚠️  [Auto-Monitor] ${result.unresolvedIssues} unresolved issue(s) need attention!`);
            } else if (result.unresolvedIssues > 0) {
              console.log(`   ⚠️  ${result.unresolvedIssues} unresolved issue(s) (provider search failed)`);
            }
          } else {
            console.error(`❌ [Auto-Monitor] ${checkType} check failed: ${result.error}`);
          }
        } catch (error) {
          console.error(`❌ [Auto-Monitor] Error during ${checkType} check:`, error.message);
        }
      };
      
      // Run IMMEDIATE check on startup
      console.log('🚀 [Auto-Monitor] Running immediate check on startup...');
      setTimeout(() => performEmailCheck(true), 3000); // Wait 3 seconds for server to fully initialize
      
      // Schedule automatic checks every N minutes
      const schedule = `*/${MONITOR_INTERVAL} * * * *`;
      
      cron.schedule(schedule, () => performEmailCheck(false));
      
      console.log(`✅ [Auto-Monitor] Automatic monitoring enabled`);
      console.log(`   - Initial check: In 3 seconds (on startup)`);
      console.log(`   - Recurring checks: Every ${MONITOR_INTERVAL} minutes`);
      console.log(`   - Schedule: ${schedule}`);
      console.log(`   - To disable: Set AUTO_MONITOR_EMAILS=false in .env`);
    }).catch(error => {
      console.warn('⚠️  [Auto-Monitor] node-cron not installed. Run: npm install node-cron');
      console.log('   Automatic monitoring disabled. Use API endpoints manually.');
    });
  } else {
    console.log('ℹ️  [Auto-Monitor] Automatic monitoring disabled');
    console.log('   To enable: Remove AUTO_MONITOR_EMAILS=false from .env');
  }
}

// ===================================================================
// VOICE CALL ENDPOINTS (Optional - only if voice module loaded)
// ===================================================================

function normalizeVoiceWebhookBaseUrl(candidate) {
  if (!candidate || typeof candidate !== 'string') {
    return null;
  }

  try {
    const normalized = new URL(candidate.trim());
    normalized.pathname = '';
    normalized.search = '';
    normalized.hash = '';
    return normalized.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isLoopbackVoiceWebhookUrl(candidate) {
  const normalized = normalizeVoiceWebhookBaseUrl(candidate);
  if (!normalized) {
    return false;
  }

  try {
    const { hostname } = new URL(normalized);
    const lower = hostname.toLowerCase();
    if (
      lower === 'localhost'
      || lower === '0.0.0.0'
      || lower === '::1'
      || lower.endsWith('.localhost')
      || lower.endsWith('.local')
      || /^127\./.test(lower)
      || /^10\./.test(lower)
      || /^192\.168\./.test(lower)
    ) {
      return true;
    }

    const private172 = lower.match(/^172\.(\d{1,3})\./);
    if (private172) {
      const secondOctet = Number(private172[1]);
      return secondOctet >= 16 && secondOctet <= 31;
    }

    return false;
  } catch {
    return false;
  }
}

function resolveVoiceWebhookBaseUrl(req) {
  return pickPublicWebhookUrl(buildVoiceWebhookCandidateList(req));
}

function buildVoiceWebhookUrlError(publicUrl) {
  const resolvedUrl = normalizeVoiceWebhookBaseUrl(publicUrl) || String(publicUrl || 'not set');
  return `Phone calls need a public webhook URL that Twilio can reach. Resolved ${resolvedUrl}. Start the app with a tunnel (for example npm run dev:tunnel) or set CLOUDFLARE_TUNNEL_URL, NGROK_URL, or PUBLIC_URL to a public HTTPS URL.`;
}

if (voiceModule) {
  // TwiML Voice Webhook
  app.all('/twiml/voice', (req, res) => {
    try {
      const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
      const publicUrl = resolveVoiceWebhookBaseUrl(req) || `${protocol}://localhost:${PORT}`;
      const twiml = voiceModule.generateTwiML(req, publicUrl);
      res.type('text/xml');
      res.send(twiml);
      console.log('[Voice] TwiML generated for call with publicUrl:', publicUrl);
    } catch (error) {
      console.error('[Voice] TwiML error:', error);
      res.status(500).send('Error generating TwiML');
    }
  });

  // Call status callback - SECURED with Twilio signature verification
  const twilioWebhookAuth = authModule && TWILIO_AUTH_TOKEN 
    ? authModule.createTwilioWebhookAuth(TWILIO_AUTH_TOKEN)
    : (req, res, next) => {
        console.warn('[TWILIO] Webhook auth disabled - no auth token configured');
        next();
      };

  app.post('/twilio/call-status', twilioWebhookAuth, async (req, res) => {
    const { CallSid, CallStatus, From, To, Duration, CallDuration, AnsweredBy } = req.body;
    console.log('[Voice] Call status:', { CallSid, CallStatus, From, To, Duration: Duration || CallDuration, AnsweredBy });
    
    if (CallSid && AnsweredBy && voiceModule?.setCallAnsweredBy) {
      voiceModule.setCallAnsweredBy(CallSid, AnsweredBy);
    }

    const normalizedStatus = String(CallStatus || '').toLowerCase();
    if (CallSid && ['no-answer', 'busy', 'failed', 'canceled'].includes(normalizedStatus) && maintenanceCallScheduler?.scheduleMaintenanceCallRetry) {
      try {
        const { loadVoiceCallContext } = await import('./voice-call-context-store.js');
        const maintenanceContext = await loadVoiceCallContext(CallSid);
        if (maintenanceContext) {
          await maintenanceCallScheduler.scheduleMaintenanceCallRetry({
            voiceModule,
            callOptions: {
              repairType: maintenanceContext.serviceCategory || maintenanceContext.category || 'general repair',
              serviceCategory: maintenanceContext.serviceCategory || maintenanceContext.category || 'general',
              location: maintenanceContext.propertyAddress,
              urgency: maintenanceContext.urgency || 'medium',
              maintenanceContext,
              publicUrl: process.env.PUBLIC_URL || process.env.BACKEND_PUBLIC_URL || process.env.NGROK_URL,
              skipProviderSearch: true,
              preSelectedProvider: {
                name: maintenanceContext.providerName,
                phone: maintenanceContext.providerPhone,
                formatted_phone_number: maintenanceContext.providerPhone
              }
            },
            propertyAddress: maintenanceContext.propertyAddress,
            provider: {
              name: maintenanceContext.providerName,
              phone: maintenanceContext.providerPhone
            },
            maintenanceRequest: maintenanceContext.firestoreId ? { id: maintenanceContext.firestoreId, firestoreId: maintenanceContext.firestoreId } : null,
            reason: normalizedStatus
          });
          console.log('[Voice] Scheduled retry after', normalizedStatus, 'for call:', CallSid);
        }
      } catch (error) {
        console.warn('[Voice] Failed to schedule maintenance call retry:', error.message);
      }
    }
    
    // MONITORING: Alert on long calls
    const duration = parseInt(Duration || CallDuration || 0);
    if (duration > 600) { // 10 minutes
      console.warn('[MONITOR] ALERT: Long call detected!', { CallSid, Duration: duration });
    }

    if (CallSid && String(CallStatus).toLowerCase() === 'completed') {
      try {
        const { processCompletedMaintenanceCall } = await import('./maintenance-visit-scheduler.js');
        const result = await processCompletedMaintenanceCall({
          callSid: CallSid,
          callStatus: CallStatus,
          durationSeconds: duration
        });
        if (result?.visitScheduled) {
          console.log('[Voice] Maintenance visit scheduled after call:', CallSid);
        }
      } catch (error) {
        console.warn('[Voice] Post-call maintenance scheduling failed:', error.message);
      }
    }
    
    res.sendStatus(200);
  });

  // Inbound SMS from property owners confirming maintenance requests
  app.post('/twilio/sms/inbound', twilioWebhookAuth, async (req, res) => {
    try {
      const from = req.body?.From || '';
      const body = req.body?.Body || '';

      let replyMessage = 'Thanks for your message.';
      if (maintenanceOwnerSmsService?.handleMaintenanceOwnerInboundSms) {
        const result = await maintenanceOwnerSmsService.handleMaintenanceOwnerInboundSms({ from, body });
        replyMessage = result.replyMessage || replyMessage;

        if (result.shouldResumeAutomation && result.requestId) {
          try {
            await resumeMaintenanceDispatchAfterOwnerConfirm(result.requestId);
          } catch (resumeError) {
            console.error('[MaintenanceOwnerSMS] Failed to resume dispatch after owner confirmation:', resumeError);
            replyMessage = `${replyMessage} We hit a snag starting provider search — please try again in a moment.`;
          }
        }

        if (result.shouldBookProvider && result.requestId) {
          try {
            const bookResult = await bookMaintenanceAfterProviderApproval(
              result.requestId,
              result.alternateProvider || null,
            );
            const callResult = bookResult?.callResult || {};
            if (callResult.scheduled) {
              replyMessage = `${replyMessage} Practice call queued for ${callResult.scheduledFor || 'the next business window'}.`;
            } else if (callResult.ok) {
              replyMessage = `${replyMessage} Watch for an incoming call from ${process.env.TWILIO_FROM_NUMBER?.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') || 'HouseYield'}.`;
            } else {
              const callError = callResult.error || bookResult.error || 'Call could not be started';
              replyMessage = `${replyMessage} We could not place the call yet: ${callError}`;
              console.error('[MaintenanceOwnerSMS] Provider booking call failed:', callError, result.requestId);
            }
          } catch (bookError) {
            console.error('[MaintenanceOwnerSMS] Failed to book provider after owner approval:', bookError);
            replyMessage = `${replyMessage} We could not start the booking call right now. Please try again shortly.`;
          }
        }

        if (result.shouldReselectProvider && result.requestId) {
          try {
            await reselectMaintenanceProviderAfterOwnerDecline(result.requestId);
          } catch (reselectError) {
            console.error('[MaintenanceOwnerSMS] Failed to reselect provider after owner decline:', reselectError);
            replyMessage = `${replyMessage} We could not find another provider right now — please try again shortly.`;
          }
        }
      } else {
        replyMessage = 'HouseYield SMS confirmations are not configured on this server.';
      }

      console.log('[MaintenanceOwnerSMS] Inbound reply', { from, body: String(body).slice(0, 40), replyMessage });

      res.type('text/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${replyMessage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Message></Response>`);
    } catch (error) {
      console.error('[MaintenanceOwnerSMS] Inbound SMS error:', error);
      res.type('text/xml');
      res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Sorry, HouseYield could not process your reply right now.</Message></Response>');
    }
  });

  // API: Make outbound call - SECURED with API key + rate limiting + monitoring
  const voiceMiddleware = [voiceCallRateLimiter];
  
  // Add authentication if configured
  if (authModule?.apiKeyAuth) {
    voiceMiddleware.push(authModule.apiKeyAuth);
  }
  
  // Add logging
  if (authModule?.voiceCallLogger) {
    voiceMiddleware.push(authModule.voiceCallLogger);
  }
  
  // Add monitoring
  if (authModule?.callMonitor) {
    voiceMiddleware.push(authModule.callMonitor);
  }

  app.post('/api/voice/call', ...voiceMiddleware, async (req, res) => {
    try {
      const { to, issue, providerName, maintenanceContext, voice: requestedVoice } = req.body;
      
      // Validate required fields
      if (!to) {
        return res.status(400).json({ ok: false, error: 'Phone number required' });
      }

      // Validate and sanitize phone number (E.164 format)
      const phoneRegex = /^\+?[1-9]\d{1,14}$/;
      const sanitizedPhone = to.replace(/[^\d+]/g, ''); // Remove everything except digits and +
      
      if (!phoneRegex.test(sanitizedPhone)) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Invalid phone number format. Use E.164 format (e.g., +1234567890)' 
        });
      }

      // Prevent international calls unless explicitly allowed
      if (!sanitizedPhone.startsWith('+1')) {
        return res.status(403).json({ 
          ok: false, 
          error: 'Only US/Canada calls allowed (+1 country code)' 
        });
      }

      // Sanitize text inputs to prevent injection
      const sanitizedIssue = (issue || '').toString().trim().slice(0, 500);
      const sanitizedProviderName = (providerName || '').toString().trim().slice(0, 100);

      // Process and sanitize maintenance context if provided
      let sanitizedContext = null;
      if (maintenanceContext) {
        sanitizedContext = {
          issue: (maintenanceContext.issue || sanitizedIssue || '').toString().trim().slice(0, 500),
          urgency: (maintenanceContext.urgency || 'medium').toString().trim().slice(0, 20),
          location: maintenanceContext.location ? maintenanceContext.location.toString().trim().slice(0, 200) : null,
          serviceCategory: (maintenanceContext.serviceCategory || 'general').toString().trim().slice(0, 50),
          tenantAvailability: maintenanceContext.tenantAvailability ? maintenanceContext.tenantAvailability.toString().trim().slice(0, 500) : null,
          tenantName: maintenanceContext.tenantName ? maintenanceContext.tenantName.toString().trim().slice(0, 100) : null,
          tenantEmail: maintenanceContext.tenantEmail ? maintenanceContext.tenantEmail.toString().trim().slice(0, 100) : null,
          propertyAddress: maintenanceContext.propertyAddress ? maintenanceContext.propertyAddress.toString().trim().slice(0, 200) : null,
          unitNumber: maintenanceContext.unitNumber ? maintenanceContext.unitNumber.toString().trim().slice(0, 50) : null,
          tenantPhone: maintenanceContext.tenantPhone ? maintenanceContext.tenantPhone.toString().trim().slice(0, 20) : null
        };
      }

      const publicUrl = resolveVoiceWebhookBaseUrl(req);

      if (!publicUrl || isLoopbackVoiceWebhookUrl(publicUrl)) {
        return res.status(503).json({
          ok: false,
          error: buildVoiceWebhookUrlError(publicUrl),
        });
      }

      console.log('[Voice] Making call with publicUrl:', publicUrl);
      console.log('[Voice] Request details (sanitized):', { 
        to: sanitizedPhone, 
        issue: sanitizedIssue, 
        providerName: sanitizedProviderName,
        hasContext: !!sanitizedContext
      });

      if (sanitizedContext) {
        console.log('[Voice] Maintenance context:', sanitizedContext);
      }

      const result = await voiceModule.makeOutboundCall(sanitizedPhone, { 
        publicUrl,
        voice: requestedVoice,
        maintenanceContext: sanitizedContext,
        context: { 
          issue: sanitizedIssue, 
          providerName: sanitizedProviderName 
        }
      });

      console.log('[Voice] Call result:', result);

      res.json({ 
        ok: true, 
        ...result 
      });

      console.log('[Voice] Outbound call initiated:', result.callSid);
    } catch (error) {
      console.error('[Voice] Outbound call error:', error);
      res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });

  // API: Get voice call status
  app.get('/api/voice/status', (req, res) => {
    res.json({
      ok: true,
      configured: true,
      activeCalls: voiceModule.activeSockets?.size || 0
    });
  });

  // API: Smart Provider Search + Voice Call Automation
  // This endpoint finds the best provider using AI analysis and initiates a voice call
  app.post('/api/voice/smart-call', ...voiceMiddleware, async (req, res) => {
    console.log('[Smart Voice Call] Request received');
    
    try {
      const { 
        repairType,
        serviceCategory,
        location,
        urgency,
        maintenanceContext
      } = req.body;

      // Validate required fields
      if (!location) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Location is required to find providers' 
        });
      }

      if (!repairType && !serviceCategory) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Either repairType or serviceCategory is required' 
        });
      }

      // Sanitize inputs
      const sanitizedRepairType = (repairType || '').toString().trim().slice(0, 500);
      const sanitizedCategory = (serviceCategory || 'general').toString().trim().slice(0, 50);
      const sanitizedLocation = location.toString().trim().slice(0, 300);
      const sanitizedUrgency = (urgency || 'medium').toString().trim().slice(0, 20);

      // Process and sanitize maintenance context if provided
      let sanitizedContext = null;
      if (maintenanceContext) {
        sanitizedContext = {
          issue: (maintenanceContext.issue || sanitizedRepairType || '').toString().trim().slice(0, 500),
          urgency: (maintenanceContext.urgency || sanitizedUrgency).toString().trim().slice(0, 20),
          location: maintenanceContext.location ? maintenanceContext.location.toString().trim().slice(0, 200) : null,
          serviceCategory: (maintenanceContext.serviceCategory || sanitizedCategory).toString().trim().slice(0, 50),
          tenantAvailability: maintenanceContext.tenantAvailability ? maintenanceContext.tenantAvailability.toString().trim().slice(0, 500) : null,
          tenantName: maintenanceContext.tenantName ? maintenanceContext.tenantName.toString().trim().slice(0, 100) : null,
          tenantEmail: maintenanceContext.tenantEmail ? maintenanceContext.tenantEmail.toString().trim().slice(0, 100) : null,
          propertyAddress: maintenanceContext.propertyAddress ? maintenanceContext.propertyAddress.toString().trim().slice(0, 200) : sanitizedLocation,
          unitNumber: maintenanceContext.unitNumber ? maintenanceContext.unitNumber.toString().trim().slice(0, 50) : null,
          tenantPhone: maintenanceContext.tenantPhone ? maintenanceContext.tenantPhone.toString().trim().slice(0, 20) : null
        };
      }

      const publicUrl = resolveVoiceWebhookBaseUrl(req);

      if (!publicUrl || isLoopbackVoiceWebhookUrl(publicUrl)) {
        return res.status(503).json({
          ok: false,
          error: buildVoiceWebhookUrlError(publicUrl),
        });
      }

      console.log('[Smart Voice Call] Finding best provider and initiating call...');
      console.log('[Smart Voice Call] Repair Type:', sanitizedRepairType);
      console.log('[Smart Voice Call] Category:', sanitizedCategory);
      console.log('[Smart Voice Call] Location:', sanitizedLocation);
      console.log('[Smart Voice Call] Urgency:', sanitizedUrgency);

      // Check if findProviderAndCall is available
      if (!voiceModule.findProviderAndCall) {
        // Fallback: just do provider search without call
        console.log('[Smart Voice Call] findProviderAndCall not available, using search only');
        
        if (aiProviderSelector) {
          const searchResult = await aiProviderSelector.findBestRepairService({
            repairType: sanitizedRepairType || `${sanitizedCategory} repair`,
            serviceCategory: sanitizedCategory,
            location: sanitizedLocation,
            urgency: sanitizedUrgency,
            maxCandidates: 5,
            includeDetailedReviews: true
          });

          return res.json({
            ok: searchResult.ok,
            callInitiated: false,
            message: 'Provider found but voice call module not fully available',
            ...searchResult
          });
        }

        return res.status(503).json({ 
          ok: false, 
          error: 'Smart voice call not fully available' 
        });
      }

      const result = await voiceModule.findProviderAndCall({
        repairType: sanitizedRepairType,
        serviceCategory: sanitizedCategory,
        location: sanitizedLocation,
        urgency: sanitizedUrgency,
        maintenanceContext: sanitizedContext,
        publicUrl
      });

      if (!result.ok) {
        return res.status(result.step === 'provider_selection' ? 404 : 500).json(result);
      }

      console.log('[Smart Voice Call] ✅ Call initiated successfully');
      console.log('[Smart Voice Call] Provider:', result.selectedProvider?.name);
      console.log('[Smart Voice Call] Call SID:', result.call?.callSid);

      return res.json({
        ok: true,
        callInitiated: true,
        ...result
      });

    } catch (error) {
      console.error('[Smart Voice Call] Error:', error);
      return res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });

  // API: Process maintenance email and prepare for voice call
  // Full automation: analyze email -> find provider -> prepare call context
  app.post('/api/voice/process-email', ...voiceMiddleware, async (req, res) => {
    console.log('[Voice Process Email] Request received');
    
    try {
      const { 
        emailContent,
        subject,
        from,
        propertyLocation,
        tenantName,
        autoCall = false
      } = req.body;

      // Validate required fields
      if (!emailContent) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Email content is required' 
        });
      }

      // Sanitize inputs
      const sanitizedContent = emailContent.toString().trim().slice(0, 5000);
      const sanitizedSubject = (subject || '').toString().trim().slice(0, 200);
      const sanitizedFrom = (from || '').toString().trim().slice(0, 100);
      const sanitizedLocation = propertyLocation ? propertyLocation.toString().trim().slice(0, 300) : null;
      const sanitizedTenantName = tenantName ? tenantName.toString().trim().slice(0, 100) : null;

      // Check if email monitor module is available
      if (!emailMonitorModule?.processMaintenanceEmailFull) {
        return res.status(503).json({ 
          ok: false, 
          error: 'Email processing module not available' 
        });
      }

      console.log('[Voice Process Email] Processing email...');
      
      const result = await emailMonitorModule.processMaintenanceEmailFull(
        sanitizedContent,
        sanitizedSubject,
        sanitizedFrom,
        sanitizedLocation,
        sanitizedTenantName
      );

      if (!result.ok) {
        return res.status(400).json(result);
      }

      if (!result.isMaintenanceIssue) {
        return res.json({
          ok: true,
          isMaintenanceIssue: false,
          message: 'Email does not appear to be a maintenance request',
          analysis: result.analysis
        });
      }

      // If autoCall is enabled and we have a phone number, initiate the call
      if (autoCall && result.voiceCallReady && result.selectedProvider?.phone) {
        console.log('[Voice Process Email] Auto-initiating voice call...');
        
        const publicUrl = resolveVoiceWebhookBaseUrl(req);

        if (!publicUrl || isLoopbackVoiceWebhookUrl(publicUrl)) {
          return res.status(503).json({
            ok: false,
            error: buildVoiceWebhookUrlError(publicUrl),
          });
        }

        try {
          const callResult = await voiceModule.makeOutboundCall(
            result.selectedProvider.phone,
            {
              publicUrl,
              maintenanceContext: result.callContext
            }
          );

          return res.json({
            ...result,
            callInitiated: true,
            call: callResult
          });

        } catch (callError) {
          console.error('[Voice Process Email] Auto-call failed:', callError);
          return res.json({
            ...result,
            callInitiated: false,
            callError: callError.message,
            message: 'Provider found but auto-call failed. You can manually call the provider.'
          });
        }
      }

      return res.json({
        ...result,
        callInitiated: false,
        message: autoCall ? 'Provider found but no phone number available' : 'Ready for voice call - set autoCall=true to auto-initiate'
      });

    } catch (error) {
      console.error('[Voice Process Email] Error:', error);
      return res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });
}

// ===================================================================
// GROQ VOICE CALL ENDPOINTS (Ultra-low latency LPU-powered voice)
// ===================================================================

if (groqVoiceModule) {
  // GROQ TwiML Voice Webhook
  app.all('/twiml/groq-voice', (req, res) => {
    try {
      const publicUrl = process.env.CLOUDFLARE_TUNNEL_URL || process.env.NGROK_URL || process.env.PUBLIC_URL || (() => {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        return `${protocol}://${host}`;
      })();
      const twiml = groqVoiceModule.generateGroqTwiML(req, publicUrl);
      res.type('text/xml');
      res.send(twiml);
      console.log('[GROQ-Voice] TwiML generated for call');
    } catch (error) {
      console.error('[GROQ-Voice] TwiML error:', error);
      res.status(500).send('Error generating GROQ TwiML');
    }
  });

  // GROQ Call status callback
  const twilioWebhookAuthGroq = authModule && TWILIO_AUTH_TOKEN 
    ? authModule.createTwilioWebhookAuth(TWILIO_AUTH_TOKEN)
    : (req, res, next) => next();

  app.post('/twilio/groq-call-status', twilioWebhookAuthGroq, (req, res) => {
    const { CallSid, CallStatus, From, To, Duration } = req.body;
    console.log('[GROQ-Voice] Call status:', { CallSid, CallStatus, From, To, Duration });
    res.sendStatus(200);
  });

  // GROQ Stream status callback - captures stream events and errors
  app.post('/twilio/groq-stream-status', twilioWebhookAuthGroq, (req, res) => {
    const { AccountSid, CallSid, StreamSid, StreamName, StreamEvent, StreamError, Timestamp } = req.body;
    console.log('[GROQ-Voice] 📡 Stream status:', { 
      CallSid, 
      StreamSid, 
      StreamEvent, 
      StreamError: StreamError || 'none',
      Timestamp 
    });
    if (StreamError) {
      console.error('[GROQ-Voice] ❌ Stream error from Twilio:', StreamError);
    }
    res.sendStatus(200);
  });

  // API: Get GROQ voice status
  app.get('/api/voice/groq-status', (req, res) => {
    const status = groqVoiceModule.getGroqVoiceStatus();
    res.json({
      ok: true,
      ...status
    });
  });

  // API: Make outbound GROQ-powered call
  const groqVoiceMiddleware = [voiceCallRateLimiter];
  if (authModule?.apiKeyAuth) groqVoiceMiddleware.push(authModule.apiKeyAuth);
  if (authModule?.voiceCallLogger) groqVoiceMiddleware.push(authModule.voiceCallLogger);

  app.post('/api/voice/groq-call', ...groqVoiceMiddleware, async (req, res) => {
    try {
      const { to, issue, providerName, maintenanceContext } = req.body;
      
      if (!to) {
        return res.status(400).json({ ok: false, error: 'Phone number required' });
      }

      // Validate phone number
      const phoneRegex = /^\+?[1-9]\d{1,14}$/;
      const sanitizedPhone = to.replace(/[^\d+]/g, '');
      
      if (!phoneRegex.test(sanitizedPhone)) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Invalid phone number format. Use E.164 format.' 
        });
      }

      if (!sanitizedPhone.startsWith('+1')) {
        return res.status(403).json({ 
          ok: false, 
          error: 'Only US/Canada calls allowed (+1 country code)' 
        });
      }

      // Sanitize maintenance context
      let sanitizedContext = null;
      if (maintenanceContext) {
        sanitizedContext = {
          issue: (maintenanceContext.issue || issue || '').toString().trim().slice(0, 500),
          urgency: (maintenanceContext.urgency || 'medium').toString().trim().slice(0, 20),
          location: maintenanceContext.location ? maintenanceContext.location.toString().trim().slice(0, 200) : null,
          serviceCategory: (maintenanceContext.serviceCategory || 'general').toString().trim().slice(0, 50),
          tenantAvailability: maintenanceContext.tenantAvailability ? maintenanceContext.tenantAvailability.toString().trim().slice(0, 500) : null,
          tenantName: maintenanceContext.tenantName ? maintenanceContext.tenantName.toString().trim().slice(0, 100) : null,
          tenantEmail: maintenanceContext.tenantEmail ? maintenanceContext.tenantEmail.toString().trim().slice(0, 100) : null,
          propertyAddress: maintenanceContext.propertyAddress ? maintenanceContext.propertyAddress.toString().trim().slice(0, 200) : null,
          unitNumber: maintenanceContext.unitNumber ? maintenanceContext.unitNumber.toString().trim().slice(0, 50) : null,
          tenantPhone: maintenanceContext.tenantPhone ? maintenanceContext.tenantPhone.toString().trim().slice(0, 20) : null
        };
      }

      const publicUrl = process.env.CLOUDFLARE_TUNNEL_URL || process.env.NGROK_URL || process.env.PUBLIC_URL || (() => {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        return `${protocol}://${host}`;
      })();

      console.log('[GROQ-Voice] Making call with publicUrl:', publicUrl);
      console.log('[GROQ-Voice] Phone:', sanitizedPhone);

      const result = await groqVoiceModule.makeGroqOutboundCall(sanitizedPhone, { 
        publicUrl,
        maintenanceContext: sanitizedContext
      });

      console.log('[GROQ-Voice] ✅ Call initiated:', result.callSid);

      res.json({ 
        ok: true, 
        ...result 
      });

    } catch (error) {
      console.error('[GROQ-Voice] Call error:', error);
      res.status(500).json({ 
        ok: false, 
        error: error.message 
      });
    }
  });

  console.log('✅ [GROQ-Voice] Endpoints registered: /api/voice/groq-call, /api/voice/groq-status');
}

// ============================================================================
// GROQ + ELEVENLABS PHONE CALL SYSTEM (Best quality voice for phone calls)
// ============================================================================

if (groqElevenLabsPhoneModule) {
  const sendGroqElevenLabsPhoneTwiML = (req, res, options = {}) => {
    try {
      const publicUrl = resolveVoiceWebhookBaseUrl(req) || process.env.PUBLIC_URL;
      if (!publicUrl) {
        res.type('text/xml');
        res.status(503).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, our phone assistant is temporarily unavailable. Please try again later.</Say>
  <Hangup />
</Response>`);
        return;
      }

      const twiml = groqElevenLabsPhoneModule.generateGroqElevenLabsPhoneTwiML(req, publicUrl, options);
      res.type('text/xml');
      res.send(twiml);
      console.log('[GROQ-ElevenLabs-Phone] TwiML generated:', {
        publicUrl,
        direction: options.direction || req.body?.Direction || 'outbound',
        from: options.from || req.body?.From || ''
      });
    } catch (error) {
      console.error('[GROQ-ElevenLabs-Phone] TwiML error:', error);
      res.type('text/xml');
      res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, we could not connect your call. Please try again later.</Say>
  <Hangup />
</Response>`);
    }
  };

  // TwiML endpoint for GROQ+ElevenLabs phone calls (outbound + inbound fallback)
  app.all('/twiml/groq-elevenlabs-phone', (req, res) => {
    const direction = String(req.body?.Direction || req.query?.Direction || 'outbound').toLowerCase();
    sendGroqElevenLabsPhoneTwiML(req, res, {
      direction,
      from: req.body?.From || req.query?.From || '',
      callSid: req.body?.CallSid || req.query?.CallSid || ''
    });
  });

  // TwiML endpoint for inbound calls to the Twilio number (configure in Twilio console)
  app.all('/twiml/inbound-voice', (req, res) => {
    if (voiceModule?.generateTwiML) {
      try {
        const publicUrl = resolveVoiceWebhookBaseUrl(req) || process.env.PUBLIC_URL;
        if (!publicUrl) {
          res.type('text/xml');
          res.status(503).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, our phone assistant is temporarily unavailable. Please try again later.</Say>
  <Hangup />
</Response>`);
          return;
        }

        const twiml = voiceModule.generateTwiML(req, publicUrl);
        res.type('text/xml');
        res.send(twiml);
        console.log('[Voice] Inbound TwiML generated with publicUrl:', publicUrl);
        return;
      } catch (error) {
        console.error('[Voice] Inbound TwiML error:', error);
      }
    }

    sendGroqElevenLabsPhoneTwiML(req, res, {
      direction: 'inbound',
      from: req.body?.From || req.query?.From || '',
      callSid: req.body?.CallSid || req.query?.CallSid || ''
    });
  });

  // Call status callback
  const twilioWebhookAuthGroqEL = authModule && TWILIO_AUTH_TOKEN 
    ? authModule.createTwilioWebhookAuth(TWILIO_AUTH_TOKEN)
    : (req, res, next) => next();

  app.post('/twilio/groq-elevenlabs-phone-status', twilioWebhookAuthGroqEL, (req, res) => {
    const { CallSid, CallStatus, From, To, Duration, AnsweredBy } = req.body;
    console.log('[GROQ-ElevenLabs-Phone] Call status:', { CallSid, CallStatus, From, To, Duration, AnsweredBy });

    if (CallSid && AnsweredBy && groqElevenLabsPhoneModule?.setGroqElevenLabsPhoneCallAnsweredBy) {
      groqElevenLabsPhoneModule.setGroqElevenLabsPhoneCallAnsweredBy(CallSid, AnsweredBy);
    }

    res.sendStatus(200);
  });

  // Stream status callback
  app.post('/twilio/groq-elevenlabs-phone-stream-status', twilioWebhookAuthGroqEL, (req, res) => {
    const { CallSid, StreamSid, StreamEvent, StreamError } = req.body;
    console.log('[GROQ-ElevenLabs-Phone] Stream status:', { CallSid, StreamSid, StreamEvent, StreamError: StreamError || 'none' });
    if (StreamError) {
      console.error('[GROQ-ElevenLabs-Phone] ❌ Stream error:', StreamError);
    }
    res.sendStatus(200);
  });

  // API: Get status
  app.get('/api/voice/groq-elevenlabs-phone-status', (req, res) => {
    const status = groqElevenLabsPhoneModule.getGroqElevenLabsPhoneStatus();
    const publicUrl = resolveVoiceWebhookBaseUrl(req)
      || process.env.BACKEND_PUBLIC_URL
      || process.env.PUBLIC_URL
      || '';
    const inboundWebhookPath = groqElevenLabsPhoneModule.getInboundVoiceWebhookPath?.() || '/twiml/inbound-voice';
    res.json({
      ok: true,
      ...status,
      inboundWebhookUrl: publicUrl ? `${publicUrl.replace(/\/$/, '')}${inboundWebhookPath}` : null
    });
  });

  // API: Make outbound call with GROQ+ElevenLabs
  const groqELPhoneMiddleware = [voiceCallRateLimiter];
  if (authModule?.apiKeyAuth) groqELPhoneMiddleware.push(authModule.apiKeyAuth);
  if (authModule?.voiceCallLogger) groqELPhoneMiddleware.push(authModule.voiceCallLogger);

  app.post('/api/voice/groq-elevenlabs-call', ...groqELPhoneMiddleware, async (req, res) => {
    try {
      const { to, issue, providerName, maintenanceContext } = req.body;
      
      if (!to) {
        return res.status(400).json({ ok: false, error: 'Phone number required' });
      }

      const phoneRegex = /^\+?[1-9]\d{1,14}$/;
      const sanitizedPhone = to.replace(/[^\d+]/g, '');
      
      if (!phoneRegex.test(sanitizedPhone)) {
        return res.status(400).json({ ok: false, error: 'Invalid phone number format' });
      }

      // Ensure US/Canada format
      let formattedPhone = sanitizedPhone;
      if (!formattedPhone.startsWith('+1')) {
        if (formattedPhone.startsWith('1') && formattedPhone.length === 11) {
          formattedPhone = '+' + formattedPhone;
        } else if (formattedPhone.length === 10) {
          formattedPhone = '+1' + formattedPhone;
        } else {
          formattedPhone = '+' + formattedPhone;
        }
      }

      // Sanitize context
      let sanitizedContext = null;
      if (maintenanceContext) {
        sanitizedContext = {
          issue: maintenanceContext.issue?.toString().trim().slice(0, 500) || issue || 'General maintenance',
          urgency: maintenanceContext.urgency?.toString().trim().slice(0, 20) || 'normal',
          location: maintenanceContext.location?.toString().trim().slice(0, 100) || null,
          serviceCategory: maintenanceContext.serviceCategory?.toString().trim().slice(0, 50) || 'general',
          propertyAddress: maintenanceContext.propertyAddress?.toString().trim().slice(0, 200) || null,
          tenantAvailability: maintenanceContext.tenantAvailability?.toString().trim().slice(0, 200) || null,
          tenantName: maintenanceContext.tenantName?.toString().trim().slice(0, 100) || null
        };
      }

      const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
      const publicUrl = process.env.PUBLIC_URL || `${protocol}://localhost:${PORT}`;

      console.log('[GROQ-ElevenLabs-Phone] Making call to:', formattedPhone);
      console.log('[GROQ-ElevenLabs-Phone] Using publicUrl:', publicUrl);

      const result = await groqElevenLabsPhoneModule.makeGroqElevenLabsPhoneCall(formattedPhone, { 
        publicUrl,
        maintenanceContext: sanitizedContext
      });

      console.log('[GROQ-ElevenLabs-Phone] ✅ Call initiated:', result.callSid);

      res.json({ ok: true, ...result });

    } catch (error) {
      console.error('[GROQ-ElevenLabs-Phone] Call error:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  console.log('✅ [GROQ-ElevenLabs-Phone] Endpoints registered: /api/voice/groq-elevenlabs-call, /twiml/inbound-voice, /api/voice/groq-elevenlabs-phone-status');
}

// ============================================================================
// NEW PHONE CALL SYSTEM (Fresh GROQ Implementation)
// ============================================================================

if (phoneModule) {
  // TwiML endpoint for phone calls
  app.all('/twiml/phone-call', (req, res) => {
    try {
      const publicUrl = process.env.CLOUDFLARE_TUNNEL_URL || process.env.NGROK_URL || process.env.PUBLIC_URL || (() => {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        return `${protocol}://${host}`;
      })();

      const twiml = phoneModule.generateTwiML(req, publicUrl);
      res.type('text/xml');
      res.send(twiml);
      console.log('[Phone] TwiML generated');
    } catch (error) {
      console.error('[Phone] TwiML error:', error);
      res.status(500).send('<Response><Say>Error setting up call</Say></Response>');
    }
  });

  // Call status webhook
  app.post('/phone/call-status', (req, res) => {
    const { CallSid, CallStatus, From, To, Duration } = req.body;
    console.log('[Phone] 📞 Call status:', { CallSid, CallStatus, From, To, Duration });
    res.sendStatus(200);
  });

  // Stream status webhook
  app.post('/phone/stream-status', (req, res) => {
    const { CallSid, StreamSid, StreamEvent, StreamError } = req.body;
    console.log('[Phone] 📡 Stream status:', { CallSid, StreamSid, StreamEvent, StreamError: StreamError || 'none' });
    if (StreamError) {
      console.error('[Phone] ❌ Stream error:', StreamError);
    }
    res.sendStatus(200);
  });

  // Get phone system status
  app.get('/api/phone/status', (req, res) => {
    const status = phoneModule.getStatus();
    res.json({ ok: true, ...status });
  });

  // Make outbound call
  app.post('/api/phone/call', async (req, res) => {
    try {
      const { to, issue, maintenanceContext } = req.body;

      if (!to) {
        return res.status(400).json({ ok: false, error: 'Phone number required' });
      }

      // Validate phone number
      const phone = to.replace(/[^\d+]/g, '');
      if (!/^\+?[1-9]\d{1,14}$/.test(phone)) {
        return res.status(400).json({ ok: false, error: 'Invalid phone number format (use E.164)' });
      }

      // Only allow US/Canada
      if (!phone.startsWith('+1') && !phone.startsWith('1')) {
        return res.status(403).json({ ok: false, error: 'Only US/Canada calls allowed' });
      }

      const publicUrl = process.env.CLOUDFLARE_TUNNEL_URL || process.env.NGROK_URL || process.env.PUBLIC_URL || (() => {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        return `${protocol}://${host}`;
      })();

      // Build context
      let context = null;
      if (maintenanceContext || issue) {
        context = {
          issue: maintenanceContext?.issue || issue || '',
          urgency: maintenanceContext?.urgency || 'medium',
          serviceCategory: maintenanceContext?.serviceCategory || 'general',
          propertyAddress: maintenanceContext?.propertyAddress || null,
          tenantAvailability: maintenanceContext?.tenantAvailability || null,
          tenantName: maintenanceContext?.tenantName || null
        };
      }

      console.log('[Phone] Making call to:', phone);

      const result = await phoneModule.makeCall(phone.startsWith('+') ? phone : `+${phone}`, {
        publicUrl,
        context
      });

      console.log('[Phone] ✅ Call initiated:', result.callSid);
      res.json({ ok: true, ...result });

    } catch (error) {
      console.error('[Phone] Call error:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  console.log('✅ [Phone] Endpoints registered: /api/phone/call, /api/phone/status, /twiml/phone-call');
}

// ============================================================================
// GROQ Voice AI Support Chat (Live Browser-Based Voice Assistant)
// ============================================================================

// Import Groq SDK
import Groq from 'groq-sdk';

const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Voice AI Support endpoint - handles text chat with GROQ
app.post('/api/voice/support', async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ 
        ok: false, 
        error: 'Message is required' 
      });
    }

    // Build conversation context from history
    const messages = [
      {
        role: 'system',
        content: `You are a friendly AI assistant for HouseYield property management. Keep responses brief and natural.

YOU HAVE FULL CONTROL of the website. The system automatically handles navigation, clicking, and highlighting.

KEY PAGE STRUCTURE:
- NET WORTH: Has "Portfolio Value" tab and "Allocation" tab (pie chart of assets). Say "switching to allocation tab" when asked.
- PORTFOLIO: Has Personal/Investment/Combined filter buttons, property cards, tenant section, maintenance section
- SEARCH: Property analysis with address input, street view, environmental data
- RENOVATIONS: AI analysis of property images, export, contractor marketplace
- MARKET DATA: Mortgage rates, treasury yields, Fed meetings
- SENSORS: IoT/smart home devices

When users ask to see/show/go to something:
- "allocation" / "allocation section" → Say "Switching to allocation tab"
- "portfolio value" → Say "Switching to portfolio view"
- "personal properties" → Say "Filtering to personal"
- Any page navigation → Confirm naturally like "Taking you there now"

Always confirm actions briefly. Example: "Sure, switching to the allocation view now!"`
      }
    ];

    // Add conversation history (last 4 messages for speed)
    if (conversationHistory && Array.isArray(conversationHistory)) {
      conversationHistory.slice(-4).forEach(msg => {
        if (msg.role && msg.content) {
          messages.push({
            role: msg.role,
            content: msg.content
          });
        }
      });
    }

    // Add current user message
    messages.push({
      role: 'user',
      content: message
    });

    console.log('[Voice-Support] Processing message with GROQ...');

    // Call GROQ API - FASTEST MODEL
    const completion = await groqClient.chat.completions.create({
      model: 'llama-3.1-8b-instant', // FASTEST model for low latency
      messages: messages,
      temperature: 0.5,
      max_tokens: 100, // Shorter responses = faster
      stream: false
    });

    const reply = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.';

    console.log('[Voice-Support] ✅ Response generated');

    res.json({
      ok: true,
      reply: reply,
      model: completion.model,
      usage: {
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        totalTokens: completion.usage?.total_tokens
      }
    });

  } catch (error) {
    console.error('[Voice-Support] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to process message'
    });
  }
});

console.log('✅ [Voice-Support] Live voice AI support endpoint registered: /api/voice/support');


async function requestOpenAIChatCompletion({
  openaiApiKey,
  model,
  messages,
  temperature,
  max_tokens,
  response_format,
  tools,
}) {
  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens,
      ...(response_format ? { response_format } : {}),
      ...(Array.isArray(tools) && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    }),
  });

  if (!openaiRes.ok) {
    const errorText = await openaiRes.text();
    console.error('[AI Chat] OpenAI error:', errorText);
    const error = new Error('OpenAI API error');
    error.statusCode = openaiRes.status;
    throw error;
  }

  return openaiRes.json();
}

async function runCanonicalAssistantChatWithLookup({
  openaiApiKey,
  model,
  messages,
  temperature,
  max_tokens,
  response_format,
  userId,
}) {
  const tools = [
    getAssistantDataLookupToolDefinition(),
    getAssistantComputedAnalyticsToolDefinition(),
  ];
  let conversation = [...messages];

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const data = await requestOpenAIChatCompletion({
      openaiApiKey,
      model,
      messages: conversation,
      temperature,
      max_tokens,
      response_format,
      tools,
    });

    const choice = data?.choices?.[0];
    const assistantMessage = choice?.message;
    const toolCalls = Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls : [];

    if (toolCalls.length === 0) {
      return data;
    }

    conversation.push({
      role: 'assistant',
      content: assistantMessage?.content ?? '',
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      let toolResult;

      try {
        const args = JSON.parse(toolCall.function.arguments || '{}');

        if (toolCall?.function?.name === 'lookup_platform_data') {
          toolResult = await executeAssistantDataLookup({
            userId,
            action: args.action,
            documentPath: args.documentPath,
            fieldPath: args.fieldPath,
            collectionPath: args.collectionPath,
            collectionGroup: args.collectionGroup,
            filters: args.filters,
            orderBy: args.orderBy,
            limit: args.limit,
            propertyId: args.propertyId || null,
            propertyAddress: args.propertyAddress || args.address || null,
            address: args.address || null,
            year: args.year || args.taxYear || null,
            taxYear: args.taxYear || null,
            startDate: args.startDate || null,
            endDate: args.endDate || null,
            category: args.category || null,
          });
        } else if (toolCall?.function?.name === 'compute_portfolio_metric') {
          toolResult = await computeAssistantAnalytics({
            userId,
            metric: args.metric,
            propertyId: args.propertyId || null,
            year: args.year || args.taxYear || null,
            startDate: args.startDate || null,
            endDate: args.endDate || null,
          });
        } else {
          throw new Error(`Unsupported tool: ${toolCall?.function?.name || 'unknown'}`);
        }
      } catch (error) {
        toolResult = {
          ok: false,
          error: error.message || 'assistant_data_lookup_failed',
        };
      }

      conversation.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  throw new Error('assistant_lookup_tool_loop_exhausted');
}

// Generic AI Chat endpoint (for scenario analysis, etc.)
app.post('/api/ai/chat', async (req, res) => {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
  }

  try {
    const {
      messages,
      model = 'gpt-4o',
      temperature = 0.4,
      max_tokens = 2000,
      response_format,
      assistantContext,
    } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ ok: false, error: 'messages array is required' });
    }

    if (typeof max_tokens !== 'number' || max_tokens <= 0 || max_tokens > 5000) {
      return res.status(400).json({ ok: false, error: 'max_tokens must be a number between 1 and 5000' });
    }

    let outboundMessages = messages;
    let canonicalUserId = null;
    if (assistantContext?.mode === 'canonical') {
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ ok: false, error: 'authorization required for canonical assistant context' });
      }

      const decodedToken = await verifyIdToken(authHeader.split('Bearer ')[1]);
      if (!decodedToken?.uid) {
        return res.status(401).json({ ok: false, error: 'invalid token for canonical assistant context' });
      }

      canonicalUserId = decodedToken.uid;

      const canonicalContext = await buildAssistantCanonicalContext({
        userId: canonicalUserId,
        includeFinancialDetails: assistantContext.includeFinancialDetails === true,
        includeGlobalContext: assistantContext.includeGlobalContext !== false,
      });

      outboundMessages = [
        {
          role: 'system',
          content: `${canonicalContext.promptContext}\n\nCANONICAL CONTEXT USAGE:\n- Treat the canonical HouseYield platform context above as the shared source of truth for this authenticated account plus global market context.\n- Do not invent missing facts and never claim financial data is locked. If a precise value is not in context, fetch or compute it with a scoped tool.\n- For broad account questions, call lookup_platform_data with action summarize_account_data before answering so you know which scoped data families are available.\n- When the user asks for NOI, cash flow, cap rate, rent, expenses, debt service, equity, or a portfolio summary, call compute_portfolio_metric and explain the derivation from the returned components.\n- When the user asks for an exact raw field, exact balance, exact date, exact document value, or individual Firestore data point that is not already present in the summarized context, call lookup_platform_data.
- When the user asks for mortgage interest, management fees, or other Azure ledger category totals by year/property, call lookup_platform_data with action query_azure_ledger (or execute show-bookkeeping-expenses). Never claim bookkeeping is inaccessible.\n- Prefer get_field over get_document when the user is asking for one exact value.\n- Use list_accessible_collections, query_collection, or query_collection_group only inside the authenticated user's account scope. Never ask for or infer another user's records.`,
        },
        ...messages,
      ];
    }

    const data = assistantContext?.mode === 'canonical'
      ? await runCanonicalAssistantChatWithLookup({
          openaiApiKey: OPENAI_API_KEY,
          model,
          messages: outboundMessages,
          temperature,
          max_tokens,
          response_format,
          userId: canonicalUserId,
        })
      : await requestOpenAIChatCompletion({
          openaiApiKey: OPENAI_API_KEY,
          model,
          messages: outboundMessages,
          temperature,
          max_tokens,
          response_format,
        });

    res.json(data);
  } catch (e) {
    console.error('[AI Chat] Error:', e);
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || 'ai_chat_failed' });
  }
});

// OpenAI Realtime API - Get ephemeral token for WebSocket connection
app.post('/api/openai/realtime-token', requireAuth, async (req, res) => {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
  }

  try {
    // Request ephemeral token from OpenAI GA API using client_secrets endpoint
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        expires_after: {
          anchor: 'created_at',
          seconds: 600
        },
        session: {
          type: 'realtime',
          model: 'gpt-realtime-2',
          output_modalities: ['text'],
          instructions: 'You are a warm, friendly AI assistant for HouseYield, a property management platform. Keep responses short and punchy - aim for 2-3 sentences. Use contractions and casual language. This websocket session is text-only, so always answer in plain text and do not rely on spoken audio output. Only discuss sensitive financial details when the app session explicitly marks financial voice access as verified for the enrolled speaker.'
        }
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('[OpenAI Realtime] Token error:', error);
      return res.status(response.status).json({ 
        ok: false, 
        error: error.error?.message || 'Failed to get realtime token' 
      });
    }

    const data = await response.json();
    console.log('[OpenAI Realtime] ✅ Ephemeral token generated');
    
    res.json({
      ok: true,
      token: data.value,
      url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2'
    });

  } catch (error) {
    console.error('[OpenAI Realtime] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

console.log('✅ [OpenAI Realtime] Token endpoint registered: /api/openai/realtime-token');

// OpenAI Realtime API - Get ephemeral token for WebRTC browser connection
// Uses the same voice parameters as phone calls (Marin voice, same VAD settings)
app.post('/api/openai/realtime-webrtc-token', requireAuth, async (req, res) => {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
  }

  // Get context from request body (passed from frontend)
  const { context, voice: requestedVoice } = req.body || {};
  
  // Validate voice selection
  const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
  const selectedVoice = validVoices.includes(requestedVoice) ? requestedVoice : 'marin';
  
  // Available pages for navigation
  const availablePages = [
    'dashboard', 'portfolio', 'properties', 'search', 'net-worth', 'market-data', 
    'renovations', 'sensors', 'profile', 'saved', 'room-scanner',
    'absentee-search', 'flood-sensors', 'insurance-discount', 'documents'
  ];

  try {
    // Request ephemeral token from OpenAI GA API using client_secrets endpoint.
    // The browser will then establish WebRTC via /v1/realtime/calls.
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        expires_after: {
          anchor: 'created_at',
          seconds: 600
        },
        session: {
          type: 'realtime',
          model: 'gpt-realtime-2',
          output_modalities: ['audio'],
          reasoning: {
            effort: 'low'
          },
          instructions: `You're a friendly AI assistant for HouseYield, a property management platform. You sound like a real person having a natural conversation.

CONVERSATION STYLE:
- Be warm, helpful, and conversational - like talking to a knowledgeable friend
- Keep responses short and punchy - aim for 2-3 sentences max
- Use contractions (I'm, you're, that's) and casual language
- Be enthusiastic but not over the top
- Ask clarifying questions when needed
- When referring to stocks aloud, prefer the natural company name like Apple or Microsoft instead of spelling out ticker letters
- Mention ticker symbols only if the user explicitly asks for them or if they are needed to disambiguate two companies

CAPABILITIES:
- You can NAVIGATE users to different pages using the navigate_to_page function
- When a user asks to "go to", "show me", "take me to", or "navigate to" something, USE the navigate_to_page function
- Sensitive financial details can only be discussed if the app session explicitly marks financial voice access as verified for the enrolled speaker

AVAILABLE PAGES: ${availablePages.join(', ')}

${context || ''}

IMPORTANT: When the user asks to go somewhere, ALWAYS call the navigate_to_page function. Don't just describe the page.`,
          audio: {
            input: {
              transcription: {
                model: 'whisper-1'
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.72,
                prefix_padding_ms: 300,
                silence_duration_ms: 800
              }
            },
            output: {
              voice: selectedVoice
            }
          },
          tools: [
            {
              type: 'function',
              name: 'navigate_to_page',
              description: 'Navigate the user to a different page in the HouseYield app. ALWAYS use this when the user asks to go somewhere, see something, or navigate.',
              parameters: {
                type: 'object',
                properties: {
                  page: {
                    type: 'string',
                    description: 'The page to navigate to',
                    enum: availablePages
                  }
                },
                required: ['page']
              }
            },
            {
              type: 'function',
              name: 'highlight_element',
              description: 'Highlight a UI element to help the user find it on screen',
              parameters: {
                type: 'object',
                properties: {
                  element_id: {
                    type: 'string',
                    description: 'The ID of the element to highlight'
                  }
                },
                required: ['element_id']
              }
            }
          ],
          tool_choice: 'auto'
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[OpenAI Realtime WebRTC] Token error:', errorText);
      return res.status(response.status).json({ 
        ok: false, 
        error: errorText || 'Failed to get realtime token' 
      });
    }

    const data = await response.json();
    console.log(
      '[OpenAI Realtime WebRTC] ✅ Ephemeral token generated for browser, has tools:',
      Array.isArray(data.session?.tools) && data.session.tools.length > 0
    );
    
    // The sessions endpoint returns client_secret.value for the token
    res.json({
      ok: true,
      token: data.client_secret?.value || data.value
    });

  } catch (error) {
    console.error('[OpenAI Realtime WebRTC] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

console.log('✅ [OpenAI Realtime WebRTC] Browser token endpoint registered: /api/openai/realtime-webrtc-token');

// Sidebar assistant uses OpenAI Realtime only. Phone-call ElevenLabs/Groq routes remain elsewhere.

// OPTIMIZED: Streaming Voice AI TTS endpoint with Server-Sent Events
// Sends each audio chunk as it's ready for lower time-to-first-audio
app.get('/api/voice/tts-stream', async (req, res) => {
  const { text, voice = 'autumn', style = 'none' } = req.query;
  
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ ok: false, error: 'Text is required' });
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return res.status(500).json({ ok: false, error: 'Groq API key not configured' });
  }

  // Set up Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const validGroqVoices = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'];
  const selectedVoice = validGroqVoices.includes(voice) ? voice : 'autumn';
  const stylePrefix = style && style !== 'none' ? `[${style}] ` : '';
  
  // Split into sentences for streaming
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  
  console.log('[Voice-TTS-Stream] Starting SSE stream, sentences:', sentences.length);

  try {
    // Process each sentence and stream as ready
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i].trim();
      if (!sentence) continue;
      
      const chunkText = stylePrefix + sentence;
      
      const response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'canopylabs/orpheus-v1-english',
          input: chunkText.slice(0, 200), // Orpheus 200 char limit
          voice: selectedVoice,
          response_format: 'wav'
        })
      });

      if (!response.ok) {
        console.error('[Voice-TTS-Stream] Groq error:', await response.text());
        continue;
      }

      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      
      // Send this chunk immediately via SSE
      res.write(`data: ${JSON.stringify({ index: i, audio: base64, done: false })}\n\n`);
      
      console.log(`[Voice-TTS-Stream] Sent chunk ${i + 1}/${sentences.length}`);
    }
    
    // Signal completion
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    
  } catch (error) {
    console.error('[Voice-TTS-Stream] Error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

// Voice AI TTS endpoint - Groq Orpheus only (Ultra-fast LPU-powered)
app.post('/api/voice/tts', async (req, res) => {
  try {
    const { text, voice = 'autumn', style = 'none' } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ 
        ok: false, 
        error: 'Text is required' 
      });
    }

    const GROQ_API_KEY = process.env.GROQ_API_KEY;

    if (!GROQ_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Groq API key not configured. Add GROQ_API_KEY to .env'
      });
    }

    // Valid Groq Orpheus voices
    const validGroqVoices = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'];
    const selectedVoice = validGroqVoices.includes(voice) ? voice : 'autumn';

    // Apply vocal style direction (Orpheus supports emotional tags)
    let styledText = text;
    if (style && style !== 'none') {
      // Prepend the vocal direction tag
      styledText = `[${style}] ${text}`;
    }

    // Groq Orpheus has a 200 character limit - split text into chunks
    // Account for style tag in chunk size
    const stylePrefix = style && style !== 'none' ? `[${style}] ` : '';
    const MAX_CHUNK_SIZE = 180 - stylePrefix.length; // Leave margin for style tag
    const chunks = [];
    
    // Split by sentences first, then by chunk size if needed
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    let currentChunk = '';
    
    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (!trimmedSentence) continue;
      
      if (currentChunk.length + trimmedSentence.length + 1 <= MAX_CHUNK_SIZE) {
        currentChunk += (currentChunk ? ' ' : '') + trimmedSentence;
      } else {
        if (currentChunk) chunks.push(stylePrefix + currentChunk);
        
        // If single sentence is too long, split by words
        if (trimmedSentence.length > MAX_CHUNK_SIZE) {
          const words = trimmedSentence.split(' ');
          currentChunk = '';
          for (const word of words) {
            if (currentChunk.length + word.length + 1 <= MAX_CHUNK_SIZE) {
              currentChunk += (currentChunk ? ' ' : '') + word;
            } else {
              if (currentChunk) chunks.push(stylePrefix + currentChunk);
              currentChunk = word;
            }
          }
        } else {
          currentChunk = trimmedSentence;
        }
      }
    }
    if (currentChunk) chunks.push(stylePrefix + currentChunk);

    console.log('[Voice-TTS] Generating speech with Groq Orpheus LPU (voice:', selectedVoice, ', style:', style, ', chunks:', chunks.length, ')...');

    // Generate audio for ALL chunks in PARALLEL for maximum speed
    const chunkPromises = chunks.map(async (chunk, i) => {
      console.log('[Voice-TTS] Processing chunk', i + 1, '/', chunks.length, '(', chunk.length, 'chars)');
      
      const response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'canopylabs/orpheus-v1-english',
          input: chunk,
          voice: selectedVoice,
          response_format: 'wav'
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        console.error('[Voice-TTS] Groq Orpheus error on chunk', i + 1, ':', errorData);
        throw new Error('Groq Orpheus TTS failed: ' + errorData);
      }

      const buffer = await response.arrayBuffer();
      return { index: i, data: Buffer.from(buffer).toString('base64') };
    });

    // Wait for all chunks to complete in parallel
    const results = await Promise.all(chunkPromises);
    
    // Sort by index to ensure correct order
    results.sort((a, b) => a.index - b.index);
    const audioChunks = results.map(r => r.data);

    console.log('[Voice-TTS] ✅ Groq Orpheus audio generated (', chunks.length, 'chunks in parallel)');

    // Return as JSON with base64 audio chunks for sequential playback
    res.json({
      ok: true,
      chunks: audioChunks,
      contentType: 'audio/wav'
    });

  } catch (error) {
    console.error('[Voice-TTS] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to generate speech'
    });
  }
});

console.log('✅ [Voice-TTS] TTS endpoint registered: /api/voice/tts (Groq Orpheus LPU)');

// ============================================================================
// ElevenLabs V3 Alpha TTS Endpoints (Best Quality Voice)
// ============================================================================

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// ElevenLabs V3 Alpha recommended voices
const ELEVENLABS_VOICES = {
  'elevenlabs-liam': { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam', description: 'Young American male, conversational' },
  'elevenlabs-jessica': { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', description: 'Young American female, friendly' },
  'elevenlabs-charlie': { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', description: 'Australian male, casual' },
  'elevenlabs-matilda': { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', description: 'Professional female' },
  'elevenlabs-brian': { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', description: 'American male, authoritative' },
  'elevenlabs-sarah': { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'Female, neutral' },
  'elevenlabs-roger': { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger', description: 'Male, neutral' }
};

// ElevenLabs TTS streaming endpoint for browser voice assistant
app.get('/api/voice/elevenlabs-tts-stream', async (req, res) => {
  const { text, voice = 'elevenlabs-liam' } = req.query;
  
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text is required' });
  }
  
  if (!ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'ElevenLabs API key not configured' });
  }
  
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  
  try {
    const voiceConfig = ELEVENLABS_VOICES[voice] || ELEVENLABS_VOICES['elevenlabs-liam'];
    const voiceId = voiceConfig.id;
    
    console.log(`[ElevenLabs-TTS] 🎙️ Streaming TTS request: voice=${voiceConfig.name}, text="${text.substring(0, 50)}..."`);
    
    // Call ElevenLabs streaming API with highest quality
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_192`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_v3',
        apply_text_normalization: 'on',
        should_enhance: true,
        voice_settings: {
          stability: 1.0,
          similarity_boost: 0.85,
          style: 0.0,
          use_speaker_boost: true
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ElevenLabs-TTS] API error: ${response.status} ${errorText}`);
      res.write(`data: ${JSON.stringify({ error: `ElevenLabs error: ${response.status}` })}\n\n`);
      res.end();
      return;
    }
    
    // Stream chunks to client
    const reader = response.body.getReader();
    let totalBytes = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      totalBytes += value.length;
      const base64 = Buffer.from(value).toString('base64');
      res.write(`data: ${JSON.stringify({ audio: base64, contentType: 'audio/mpeg' })}\n\n`);
    }
    
    console.log(`[ElevenLabs-TTS] ✅ Streaming complete: ${totalBytes} bytes`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    
  } catch (error) {
    console.error('[ElevenLabs-TTS] Error:', error.message);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

// Non-streaming ElevenLabs TTS endpoint
app.post('/api/voice/elevenlabs-tts', async (req, res) => {
  try {
    const { text, voice = 'elevenlabs-liam' } = req.body;
    
    if (!text) {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }
    
    if (!ELEVENLABS_API_KEY) {
      return res.status(500).json({ ok: false, error: 'ElevenLabs API key not configured' });
    }
    
    const voiceConfig = ELEVENLABS_VOICES[voice] || ELEVENLABS_VOICES['elevenlabs-liam'];
    const voiceId = voiceConfig.id;
    
    console.log(`[ElevenLabs-TTS] 🎙️ TTS request: voice=${voiceConfig.name}`);
    
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_192`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_v3',
        apply_text_normalization: 'on',
        should_enhance: true,
        voice_settings: {
          stability: 1.0,
          similarity_boost: 0.85,
          style: 0.0,
          use_speaker_boost: true
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
    }
    
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const base64Audio = audioBuffer.toString('base64');
    
    res.json({
      ok: true,
      chunks: [base64Audio],
      contentType: 'audio/mpeg',
      voice: voiceConfig.name
    });
    
  } catch (error) {
    console.error('[ElevenLabs-TTS] Error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get available ElevenLabs voices
app.get('/api/voice/elevenlabs-voices', (req, res) => {
  res.json({
    ok: true,
    voices: Object.entries(ELEVENLABS_VOICES).map(([key, config]) => ({
      id: key,
      voiceId: config.id,
      name: config.name,
      description: config.description
    })),
    configured: !!ELEVENLABS_API_KEY
  });
});

console.log('✅ [ElevenLabs-TTS] ElevenLabs V3 Alpha TTS endpoints registered');

// ============================================================================
// Lease Agreement Generation API
// ============================================================================
import {
  LEASE_TEMPLATE_SECTIONS,
  generateCustomSection,
  generateCompleteLease,
  generateLeaseSummary,
  validateCustomRequirements
} from './lease-generator.js';

// Get lease template sections (baseline templates)
app.get('/api/lease/template', (req, res) => {
  res.json({
    ok: true,
    sections: LEASE_TEMPLATE_SECTIONS
  });
});

// Validate custom requirements for a section
app.post('/api/lease/validate', async (req, res) => {
  try {
    const { sectionKey, customText } = req.body;

    if (!sectionKey || !customText) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: sectionKey, customText'
      });
    }

    const validation = await validateCustomRequirements(sectionKey, customText);

    res.json({
      ok: true,
      ...validation
    });
  } catch (error) {
    console.error('[Lease] Validation error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Generate a single customized section
app.post('/api/lease/section', async (req, res) => {
  try {
    const { sectionKey, customRequirements, variables } = req.body;

    if (!sectionKey) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: sectionKey'
      });
    }

    const section = LEASE_TEMPLATE_SECTIONS[sectionKey];
    if (!section) {
      return res.status(404).json({
        ok: false,
        error: `Section not found: ${sectionKey}`
      });
    }

    const content = await generateCustomSection(
      sectionKey,
      section.baseline,
      customRequirements,
      variables || {}
    );

    res.json({
      ok: true,
      section: {
        key: sectionKey,
        title: section.title,
        content
      }
    });
  } catch (error) {
    console.error('[Lease] Section generation error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Generate complete lease agreement
app.post('/api/lease/generate', async (req, res) => {
  try {
    const config = req.body;

    // Validate required fields
    const required = ['propertyAddress', 'landlordName', 'tenantName', 'startDate', 'duration', 'rentAmount', 'securityDeposit'];
    const missing = required.filter(field => !config[field]);

    if (missing.length > 0) {
      return res.status(400).json({
        ok: false,
        error: `Missing required fields: ${missing.join(', ')}`
      });
    }

    const result = await generateCompleteLease(config);

    if (!result.success) {
      return res.status(500).json({
        ok: false,
        error: result.error
      });
    }

    res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    console.error('[Lease] Generation error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Generate lease summary
app.post('/api/lease/summary', async (req, res) => {
  try {
    const { lease } = req.body;

    if (!lease) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: lease'
      });
    }

    const result = await generateLeaseSummary(lease);

    if (!result.success) {
      return res.status(500).json({
        ok: false,
        error: result.error
      });
    }

    res.json({
      ok: true,
      summary: result.summary
    });
  } catch (error) {
    console.error('[Lease] Summary generation error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Parse Certificate of Insurance (COI) for renter's insurance
app.post('/api/lease/parse-insurance', async (req, res) => {
  try {
    const { imageData } = req.body;

    if (!imageData) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: imageData (base64 encoded image)'
      });
    }

    console.log('[Insurance] Parsing COI with Gemini Vision...');

    // Initialize Gemini for document parsing (supports both images and PDFs)
    const genAI = new GoogleGenerativeAI(process.env.Gemini_API_Key || process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are an insurance document parser. Extract the following information from this Certificate of Insurance (COI) or insurance declaration page:

EXTRACT:
1. Insurance Company Name
2. Policy Number
3. Policy Holder Name
4. Coverage Amounts:
   - Personal Property Coverage
   - Liability Coverage
   - Medical Payments Coverage
5. Policy Effective Date
6. Policy Expiration Date
7. Is the landlord/property owner listed as an additional interested party or certificate holder? (Yes/No)

Return ONLY a JSON object with this exact structure:
{
  "insuranceCompany": "string",
  "policyNumber": "string",
  "policyHolder": "string",
  "coverageAmount": {
    "personalProperty": number or null,
    "liability": number or null,
    "medicalPayments": number or null
  },
  "effectiveDate": "YYYY-MM-DD",
  "expirationDate": "YYYY-MM-DD",
  "landlordListedAsInterested": boolean,
  "confidence": "high" | "medium" | "low"
}

If any field cannot be found, use null. Set confidence based on document clarity.`;

    // Extract mime type and base64 data from the data URL
    const mimeMatch = imageData.match(/^data:([^;]+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const base64Data = imageData.replace(/^data:[^;]+;base64,/, '');

    // Call Gemini Vision API
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: mimeType,
          data: base64Data
        }
      }
    ]);

    const responseText = result.response.text().trim();
    
    // Parse the JSON response
    let parsedPolicy;
    try {
      // Remove any markdown code blocks if present
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) || responseText.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : responseText;
      parsedPolicy = JSON.parse(jsonString);
    } catch (parseError) {
      console.error('[Insurance] Failed to parse JSON:', responseText);
      return res.status(500).json({
        ok: false,
        error: 'Failed to parse insurance information',
        rawResponse: responseText
      });
    }

    console.log('[Insurance] Successfully parsed COI:', parsedPolicy.policyNumber);

    res.json({
      ok: true,
      policy: {
        ...parsedPolicy,
        parsedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[Insurance] COI parsing error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ============================================================================
// Document Management & E-Signature API
// ============================================================================
import documentService from './document-service.js';
import {
  buildDigitizedReplicaArtifacts,
  buildNativeDigitalSkipResult,
  digitizeDocumentFromBytes,
  digitizeDocumentFromStorage,
  digitizeDocumentFromUrl,
  fetchRemoteDocumentBuffer,
  fetchFirebaseStorageFileByPath,
  resolveDocumentMimeType,
  shouldDigitizeUploadedDocument,
  summarizeDigitizationForStorage
} from './services/documentDigitizationService.js';

// Get all documents for a user/property/tenant
app.get('/api/documents', async (req, res) => {
  try {
    const { ownerId, propertyId, tenantId, status, documentType } = req.query;
    
    const result = await documentService.getDocuments({
      ownerId,
      propertyId,
      tenantId,
      status,
      documentType
    });

    // Log metadata for insurance/uploaded documents
    const uploadedDocs = result.documents.filter(d => d.metadata?.isUploaded || d.documentType === 'RENTERS_INSURANCE');
    if (uploadedDocs.length > 0) {
      console.log('[Documents API] Found', uploadedDocs.length, 'uploaded documents');
      uploadedDocs.forEach(doc => {
        console.log(`[Documents API] Doc ${doc.id} metadata:`, JSON.stringify(doc.metadata, null, 2));
      });
    }

    res.json({
      ok: result.success,
      documents: result.documents,
      error: result.error
    });
  } catch (error) {
    console.error('[Documents] Error fetching documents:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Get document types
app.get('/api/documents/types', (req, res) => {
  res.json({
    ok: true,
    types: documentService.DOCUMENT_TYPES
  });
});

// Get document templates
app.get('/api/documents/templates', (req, res) => {
  res.json({
    ok: true,
    templates: documentService.DOCUMENT_TEMPLATES
  });
});

// Get a single document
app.get('/api/documents/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const result = await documentService.getDocumentById(documentId);

    if (!result.success) {
      return res.status(404).json({
        ok: false,
        error: result.error
      });
    }

    res.json({
      ok: true,
      document: result.document
    });
  } catch (error) {
    console.error('[Documents] Error fetching document:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Create a new document
app.post('/api/documents', async (req, res) => {
  try {
    const { ownerId, propertyId, tenantId, documentType, title, content, metadata } = req.body;

    if (!ownerId || !documentType || !content) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: ownerId, documentType, content'
      });
    }

    const document = await documentService.createDocument({
      ownerId,
      propertyId,
      tenantId,
      documentType,
      title,
      content,
      metadata
    });

    // Generate PDF file for the text-based document
    try {
      const pdfBytes = await generateDocumentPDF(document.title, document.content, document.signatureRequests || []);
      const uploadsDir = path.join(process.cwd(), 'server', 'uploads', 'documents', ownerId, 'generated');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      const pdfFileName = `${document.id}.pdf`;
      const pdfPath = path.join(uploadsDir, pdfFileName);
      fs.writeFileSync(pdfPath, Buffer.from(pdfBytes));
      console.log(`[Documents] ✅ Generated PDF for document ${document.id}`);

      // Update metadata with PDF path
      if (db) {
        await db.collection('documents').doc(document.id).update({
          'metadata.pdfPath': `/api/documents/${document.id}/pdf`,
          'metadata.hasPdf': true
        });
        document.metadata.pdfPath = `/api/documents/${document.id}/pdf`;
        document.metadata.hasPdf = true;
      }
    } catch (pdfErr) {
      console.warn(`[Documents] ⚠️ PDF generation skipped for ${document.id}:`, pdfErr.message);
    }

    console.log(`[Documents] Created document ${document.id}`);

    res.json({
      ok: true,
      document
    });
  } catch (error) {
    console.error('[Documents] Error creating document:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * Generate a professional PDF from document text content using pdf-lib
 */
async function generateDocumentPDF(title, content, signatures = []) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const fontBoldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  
  const PAGE_WIDTH = 612; // Letter
  const PAGE_HEIGHT = 792;
  const MARGIN_LEFT = 72;  // 1-inch margins for legal documents
  const MARGIN_RIGHT = 72;
  const MARGIN_TOP = 72;
  const MARGIN_BOTTOM = 72;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const LINE_HEIGHT = 13.5;
  const PARAGRAPH_SPACING = 7;
  
  const darkText = rgb(0.08, 0.08, 0.08);
  const headerColor = rgb(0.10, 0.30, 0.52);
  const sectionHeaderColor = rgb(0.12, 0.12, 0.12);
  const subHeaderColor = rgb(0.18, 0.18, 0.18);
  const mutedText = rgb(0.45, 0.45, 0.45);
  const accentLine = rgb(0.10, 0.38, 0.62);
  const lightLine = rgb(0.82, 0.82, 0.82);
  
  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN_TOP;
  let pageNum = 0;
  
  function ensureSpace(needed) {
    if (y - needed < MARGIN_BOTTOM) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN_TOP;
      pageNum++;
    }
  }
  
  /**
   * Draw text with inline **bold** support.
   * Splits on ** markers and alternates between normal and bold font.
   */
  function drawWrappedText(text, options = {}) {
    const {
      size = 9.5,
      currentFont = font,
      boldFont = fontBold,
      color = darkText,
      indent = 0,
      lineSpacing = LINE_HEIGHT
    } = options;
    
    const maxWidth = CONTENT_WIDTH - indent;
    
    // Parse inline bold segments: split by ** markers
    const segments = [];
    const parts = text.split('**');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].length > 0) {
        segments.push({
          text: parts[i],
          bold: i % 2 === 1 // Odd indices are inside ** markers
        });
      }
    }
    
    // If no segments (empty text), skip
    if (segments.length === 0) return;
    
    // Flatten segments into words with font info
    const words = [];
    for (const seg of segments) {
      const segFont = seg.bold ? boldFont : currentFont;
      const segWords = seg.text.split(' ').filter(w => w.length > 0);
      for (const w of segWords) {
        words.push({ text: w, font: segFont });
      }
    }
    
    // Word-wrap with mixed fonts
    let currentLineWords = [];
    let currentLineWidth = 0;
    
    const flushLine = () => {
      if (currentLineWords.length === 0) return;
      ensureSpace(lineSpacing);
      let xPos = MARGIN_LEFT + indent;
      for (let i = 0; i < currentLineWords.length; i++) {
        const w = currentLineWords[i];
        page.drawText(w.text, {
          x: xPos,
          y,
          size,
          font: w.font,
          color
        });
        xPos += w.font.widthOfTextAtSize(w.text, size);
        // Add space between words
        if (i < currentLineWords.length - 1) {
          xPos += font.widthOfTextAtSize(' ', size);
        }
      }
      y -= lineSpacing;
      currentLineWords = [];
      currentLineWidth = 0;
    };
    
    for (const word of words) {
      const wordWidth = word.font.widthOfTextAtSize(word.text, size);
      const spaceWidth = currentLineWords.length > 0 ? font.widthOfTextAtSize(' ', size) : 0;
      
      if (currentLineWidth + spaceWidth + wordWidth > maxWidth && currentLineWords.length > 0) {
        flushLine();
      }
      
      if (currentLineWords.length > 0) {
        currentLineWidth += font.widthOfTextAtSize(' ', size);
      }
      currentLineWords.push(word);
      currentLineWidth += wordWidth;
    }
    
    flushLine();
  }
  
  /**
   * Draw a simple unwrapped text line (no bold parsing)
   */
  function drawSimpleText(text, x, yPos, options = {}) {
    const { size = 9.5, textFont = font, textColor = darkText } = options;
    page.drawText(text, { x, y: yPos, size, font: textFont, color: textColor });
  }
  
  // === Document Header ===
  // Top accent line (thicker for legal docs)
  page.drawRectangle({
    x: MARGIN_LEFT,
    y: PAGE_HEIGHT - MARGIN_TOP + 18,
    width: CONTENT_WIDTH,
    height: 3,
    color: accentLine
  });
  
  // Document title
  const titleSize = 16;
  const titleText = title.toUpperCase();
  ensureSpace(titleSize + 10);
  
  // Word-wrap the title
  const titleWords = titleText.split(' ');
  let titleLine = '';
  for (const word of titleWords) {
    const testLine = titleLine ? `${titleLine} ${word}` : word;
    const testWidth = fontBold.widthOfTextAtSize(testLine, titleSize);
    if (testWidth > CONTENT_WIDTH && titleLine) {
      page.drawText(titleLine, {
        x: MARGIN_LEFT,
        y,
        size: titleSize,
        font: fontBold,
        color: headerColor
      });
      y -= titleSize + 4;
      titleLine = word;
    } else {
      titleLine = testLine;
    }
  }
  if (titleLine) {
    page.drawText(titleLine, {
      x: MARGIN_LEFT,
      y,
      size: titleSize,
      font: fontBold,
      color: headerColor
    });
    y -= titleSize + 4;
  }
  
  // Date line
  y -= 3;
  page.drawText(`Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, {
    x: MARGIN_LEFT,
    y,
    size: 8,
    font: fontItalic,
    color: mutedText
  });
  y -= 16;
  
  // Double line separator (legal document style)
  page.drawRectangle({ x: MARGIN_LEFT, y: y + 2, width: CONTENT_WIDTH, height: 1.2, color: accentLine });
  page.drawRectangle({ x: MARGIN_LEFT, y: y - 2, width: CONTENT_WIDTH, height: 0.4, color: accentLine });
  y -= 18;
  
  // === Document Body ===
  const lines = content.split('\n');
  let pendingSignedDate = null; // Stores date from signature block to fill in the next "Date: ____" line
  
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trim();
    
    // Empty line = paragraph break
    if (!trimmed) {
      y -= PARAGRAPH_SPACING;
      continue;
    }
    
    // === Markdown headers ===
    
    // ### Subsection header (e.g., ### Kitchen)
    if (trimmed.startsWith('### ')) {
      ensureSpace(22);
      y -= 5;
      const headerText = trimmed.replace(/^###\s*/, '').replace(/\*\*/g, '');
      drawWrappedText(headerText, {
        size: 10,
        currentFont: fontBold,
        boldFont: fontBold,
        color: subHeaderColor
      });
      y -= 2;
      continue;
    }
    
    // ## Section header (e.g., ## 1. PARTIES AND PROPERTY)
    if (trimmed.startsWith('## ')) {
      ensureSpace(30);
      y -= 10;
      const headerText = trimmed.replace(/^##\s*/, '').replace(/\*\*/g, '');
      
      // Draw section header with underline
      drawWrappedText(headerText, {
        size: 12,
        currentFont: fontBold,
        boldFont: fontBold,
        color: sectionHeaderColor
      });
      
      // Underline the section header
      y -= 1;
      page.drawRectangle({
        x: MARGIN_LEFT,
        y,
        width: CONTENT_WIDTH,
        height: 0.6,
        color: lightLine
      });
      y -= 6;
      continue;
    }
    
    // # Document title header
    if (trimmed.startsWith('# ')) {
      ensureSpace(36);
      y -= 12;
      const headerText = trimmed.replace(/^#\s*/, '').replace(/\*\*/g, '');
      
      // Center the main title
      const titleWidth = fontBold.widthOfTextAtSize(headerText, 14);
      const titleX = titleWidth < CONTENT_WIDTH 
        ? MARGIN_LEFT + (CONTENT_WIDTH - titleWidth) / 2 
        : MARGIN_LEFT;
      
      page.drawText(headerText, {
        x: titleX,
        y,
        size: 14,
        font: fontBold,
        color: headerColor
      });
      y -= 14 + 6;
      continue;
    }
    
    // Bold-only lines (entire line is **bold**)
    if (trimmed.startsWith('**') && trimmed.endsWith('**') && !trimmed.includes('**', 2)) {
      ensureSpace(LINE_HEIGHT + 4);
      y -= 4;
      drawWrappedText(trimmed.replace(/^\*\*|\*\*$/g, ''), {
        size: 10,
        currentFont: fontBold,
        boldFont: fontBold,
        color: darkText
      });
      y -= 2;
      continue;
    }
    
    // Section separators (--- or ===)
    if (/^[-=]{3,}$/.test(trimmed)) {
      ensureSpace(12);
      y -= 4;
      page.drawRectangle({
        x: MARGIN_LEFT,
        y,
        width: CONTENT_WIDTH,
        height: 0.5,
        color: lightLine
      });
      y -= 8;
      continue;
    }
    
    // === DocuSign-style Signature Handling ===
    // Detect "Signature:" label and look ahead for [SIGNED ELECTRONICALLY] + ![Signature](base64)
    // If found, overlay the signature image directly on the signature line
    if (/^Signature:/i.test(trimmed.replace(/\*\*/g, ''))) {
      // Look ahead up to 5 lines for signature image data
      let sigImageData = null;
      let signedDateText = null;
      let linesToSkip = 0;
      for (let ahead = 1; ahead <= 5 && (lineIdx + ahead) < lines.length; ahead++) {
        const aheadLine = lines[lineIdx + ahead].trim();
        // Find the base64 signature image
        const aheadImgMatch = aheadLine.match(/!\[.*?\]\((data:image\/png;base64,[^)]+)\)/);
        if (aheadImgMatch) {
          sigImageData = aheadImgMatch[1];
          linesToSkip = Math.max(linesToSkip, ahead);
        }
        // Find signed date
        const dateMatch = aheadLine.match(/\*\*Signed:\*\*\s*(.*)/);
        if (dateMatch) {
          signedDateText = dateMatch[1];
          linesToSkip = Math.max(linesToSkip, ahead);
        }
        // Mark [SIGNED ELECTRONICALLY] for skipping too
        if (aheadLine === '[SIGNED ELECTRONICALLY]') {
          linesToSkip = Math.max(linesToSkip, ahead);
        }
        // Stop lookahead if we hit a blank line or the next section
        if (aheadLine === '' || /^(Print Name|Date:|TENANT|LANDLORD|\*\*TENANT|\*\*LANDLORD|#{1,3}\s)/i.test(aheadLine)) {
          break;
        }
      }

      if (sigImageData) {
        // DocuSign-style: draw "Signature:" label, then signature line with image overlaid
        ensureSpace(60);
        const labelText = 'Signature:';
        const labelWidth = font.widthOfTextAtSize(labelText + ' ', 9.5);
        
        page.drawText(labelText, {
          x: MARGIN_LEFT,
          y,
          size: 9.5,
          font: font,
          color: darkText
        });
        
        // Draw the signature line
        const lineStart = MARGIN_LEFT + labelWidth;
        const lineEnd = MARGIN_LEFT + CONTENT_WIDTH * 0.75;
        const lineWidth = Math.max(lineEnd - lineStart, 200);
        page.drawRectangle({
          x: lineStart,
          y: y - 1,
          width: lineWidth,
          height: 0.5,
          color: rgb(0.3, 0.3, 0.3)
        });

        // Embed the signature image overlaid ON the line (like DocuSign)
        try {
          const base64Data = sigImageData.replace('data:image/png;base64,', '');
          const imgBytes = Buffer.from(base64Data, 'base64');
          const pngImage = await doc.embedPng(imgBytes);
          // Scale to fit on the signature line area
          const maxW = lineWidth - 10;
          const maxH = 38;
          const scale = Math.min(maxW / pngImage.width, maxH / pngImage.height, 1);
          const imgWidth = pngImage.width * scale;
          const imgHeight = pngImage.height * scale;
          
          // Position: signature sits ON the line, bottom edge resting on the line
          page.drawImage(pngImage, {
            x: lineStart + 8,
            y: y, // bottom of image sits on the signature line
            width: imgWidth,
            height: imgHeight
          });
          
          // Move y down past the signature line with proper clearance
          y -= LINE_HEIGHT;
          // Store the signed date so it gets written on the upcoming "Date: ____" line
          if (signedDateText) {
            pendingSignedDate = signedDateText;
          }
        } catch (sigErr) {
          console.warn('[PDF] Could not embed inline signature:', sigErr.message);
          // Fallback: just show text
          y -= 14;
          page.drawText('[Signature Applied Electronically]', {
            x: lineStart + 5,
            y,
            size: 8,
            font: fontItalic,
            color: rgb(0.13, 0.55, 0.13)
          });
          y -= 10;
        }
        
        // Skip the consumed look-ahead lines (image data, signed date, etc.)
        lineIdx += linesToSkip;
        continue;
      } else {
        // No signature found ahead — just render "Signature:" with blank line
        ensureSpace(LINE_HEIGHT + 2);
        const labelText = trimmed.replace(/\*\*/g, '');
        const parts = labelText.split(/_{3,}/);
        const cleanLabel = (parts[0] || '').trim();
        
        if (cleanLabel) {
          const lblWidth = font.widthOfTextAtSize(cleanLabel + ' ', 9.5);
          page.drawText(cleanLabel, {
            x: MARGIN_LEFT,
            y,
            size: 9.5,
            font: font,
            color: darkText
          });
          const ls = MARGIN_LEFT + lblWidth;
          const le = MARGIN_LEFT + CONTENT_WIDTH * 0.75;
          page.drawRectangle({
            x: ls,
            y: y - 1,
            width: Math.max(le - ls, 150),
            height: 0.5,
            color: rgb(0.3, 0.3, 0.3)
          });
        }
        y -= LINE_HEIGHT;
        continue;
      }
    }
    
    // Skip standalone [SIGNED ELECTRONICALLY] lines (already consumed by signature look-ahead)
    if (trimmed === '[SIGNED ELECTRONICALLY]') {
      continue;
    }
    
    // Skip standalone signature image markdown lines (already consumed by look-ahead)
    if (/^!\[.*?\]\(data:image\/png;base64,/.test(trimmed)) {
      continue;
    }

    // Signature lines (underscores) — for non-signature-label lines like "Date: _____"
    if (trimmed.includes('_____')) {
      ensureSpace(LINE_HEIGHT + 2);
      const beforeUnderscore = trimmed.split(/_{3,}/)[0] || '';
      const cleanBefore = beforeUnderscore.replace(/\*\*/g, '').trim();
      
      // Check if this is a "Date:" line and we have a pending signed date to fill in
      const isDateLine = /^Date:?$/i.test(cleanBefore);
      
      if (cleanBefore) {
        const labelWidth = font.widthOfTextAtSize(cleanBefore + ' ', 9.5);
        page.drawText(cleanBefore, {
          x: MARGIN_LEFT,
          y,
          size: 9.5,
          font: font,
          color: darkText
        });
        const lineStart = MARGIN_LEFT + labelWidth;
        const lineEnd = MARGIN_LEFT + CONTENT_WIDTH * 0.75;
        const ulWidth = Math.max(lineEnd - lineStart, 150);
        // Draw the line
        page.drawRectangle({
          x: lineStart,
          y: y - 1,
          width: ulWidth,
          height: 0.5,
          color: rgb(0.3, 0.3, 0.3)
        });
        // If this is a Date line and we have a pending signed date, write it on the line
        if (isDateLine && pendingSignedDate) {
          page.drawText(pendingSignedDate, {
            x: lineStart + 5,
            y: y + 1,
            size: 9.5,
            font: font,
            color: darkText
          });
          pendingSignedDate = null;
        }
      } else {
        // Just a standalone signature line
        page.drawRectangle({
          x: MARGIN_LEFT,
          y: y - 1,
          width: CONTENT_WIDTH * 0.6,
          height: 0.5,
          color: rgb(0.3, 0.3, 0.3)
        });
      }
      y -= LINE_HEIGHT;
      continue;
    }
    
    // Bullet points (with indent)
    if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      ensureSpace(LINE_HEIGHT);
      page.drawText('\u2022', {
        x: MARGIN_LEFT + 10,
        y,
        size: 8,
        font: font,
        color: darkText
      });
      drawWrappedText(trimmed.replace(/^[-•*]\s*/, ''), {
        indent: 24
      });
      continue;
    }
    
    // Lettered subsections like (a), (b), (c)
    const letterMatch = trimmed.match(/^\(([a-z])\)\s+(.*)/);
    if (letterMatch) {
      ensureSpace(LINE_HEIGHT + 2);
      y -= 2;
      page.drawText(`(${letterMatch[1]})`, {
        x: MARGIN_LEFT + 8,
        y,
        size: 9.5,
        font: fontBold,
        color: darkText
      });
      drawWrappedText(letterMatch[2], {
        indent: 30
      });
      continue;
    }
    
    // Roman numeral items like (i), (ii), (iii)
    const romanMatch = trimmed.match(/^\(([ivxlc]+)\)\s+(.*)/i);
    if (romanMatch && !letterMatch) {
      ensureSpace(LINE_HEIGHT);
      page.drawText(`(${romanMatch[1]})`, {
        x: MARGIN_LEFT + 24,
        y,
        size: 9.5,
        font: font,
        color: darkText
      });
      drawWrappedText(romanMatch[2], {
        indent: 48
      });
      continue;
    }
    
    // Numbered items (e.g., "1. Section Title")
    const numberedMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
    if (numberedMatch) {
      ensureSpace(LINE_HEIGHT + 2);
      const numText = `${numberedMatch[1]}.`;
      page.drawText(numText, {
        x: MARGIN_LEFT + 4,
        y,
        size: 9.5,
        font: fontBold,
        color: darkText
      });
      drawWrappedText(numberedMatch[2], {
        indent: 24
      });
      continue;
    }
    
    // Regular paragraph text (with inline **bold** support)
    drawWrappedText(trimmed);
  }
  
  // === Digital Signatures section (if any) ===
  if (signatures && signatures.length > 0) {
    ensureSpace(60);
    y -= 20;
    page.drawRectangle({
      x: MARGIN_LEFT,
      y,
      width: CONTENT_WIDTH,
      height: 0.5,
      color: lightLine
    });
    y -= 20;
    
    page.drawText('DIGITAL SIGNATURES', {
      x: MARGIN_LEFT,
      y,
      size: 11,
      font: fontBold,
      color: headerColor
    });
    y -= 18;
    
    for (const sig of signatures) {
      ensureSpace(80);
      const statusText = sig.status === 'signed' 
        ? `Signed ${sig.signedAt ? new Date(sig.signedAt).toLocaleDateString() : ''}` 
        : 'Pending';
      const statusIcon = sig.status === 'signed' ? 'SIGNED' : 'PENDING';
      const statusColor = sig.status === 'signed' ? rgb(0.13, 0.55, 0.13) : mutedText;
      
      page.drawText(`${sig.signerName || 'Unknown'}`, {
        x: MARGIN_LEFT,
        y,
        size: 10,
        font: fontBold,
        color: darkText
      });
      
      const roleText = sig.signerRole ? ` (${sig.signerRole.charAt(0).toUpperCase() + sig.signerRole.slice(1)})` : '';
      const nameWidth = fontBold.widthOfTextAtSize(sig.signerName || 'Unknown', 10);
      page.drawText(roleText, {
        x: MARGIN_LEFT + nameWidth,
        y,
        size: 9,
        font: font,
        color: mutedText
      });
      y -= 14;
      
      // Embed actual signature image if available
      if (sig.signature && sig.status === 'signed') {
        try {
          const sigBase64 = sig.signature.replace(/^data:image\/png;base64,/, '');
          const sigImgBytes = Buffer.from(sigBase64, 'base64');
          const sigPngImage = await doc.embedPng(sigImgBytes);
          // Scale signature to fit (max 180px wide, 50px tall)
          const sigMaxW = 180;
          const sigMaxH = 50;
          const sigScale = Math.min(sigMaxW / sigPngImage.width, sigMaxH / sigPngImage.height, 1);
          const sigImgWidth = sigPngImage.width * sigScale;
          const sigImgHeight = sigPngImage.height * sigScale;
          ensureSpace(sigImgHeight + 20);
          
          // Draw a light background box behind the signature
          page.drawRectangle({
            x: MARGIN_LEFT + 4,
            y: y - sigImgHeight - 2,
            width: sigImgWidth + 16,
            height: sigImgHeight + 4,
            color: rgb(0.97, 0.97, 0.97),
            borderColor: rgb(0.85, 0.85, 0.85),
            borderWidth: 0.5
          });
          
          page.drawImage(sigPngImage, {
            x: MARGIN_LEFT + 12,
            y: y - sigImgHeight,
            width: sigImgWidth,
            height: sigImgHeight
          });
          y -= sigImgHeight + 10;
        } catch (sigImgErr) {
          console.warn('[PDF] Could not embed signature image in footer:', sigImgErr.message);
        }
      }
      
      page.drawText(`[${statusIcon}] ${statusText}`, {
        x: MARGIN_LEFT + 4,
        y,
        size: 8.5,
        font: fontItalic,
        color: statusColor
      });
      y -= 20;
    }
  }
  
  // === Footer on every page ===
  const pages = doc.getPages();
  const totalPages = pages.length;
  pages.forEach((p, i) => {
    // Bottom separator line
    p.drawRectangle({
      x: MARGIN_LEFT,
      y: MARGIN_BOTTOM - 12,
      width: CONTENT_WIDTH,
      height: 0.5,
      color: lightLine
    });
    
    // HouseYield branding (left)
    p.drawText('HouseYield Document', {
      x: MARGIN_LEFT,
      y: MARGIN_BOTTOM - 24,
      size: 7,
      font: fontItalic,
      color: mutedText
    });
    
    // Page number (center)
    const pageText = `Page ${i + 1} of ${totalPages}`;
    const pageTextWidth = fontItalic.widthOfTextAtSize(pageText, 7);
    p.drawText(pageText, {
      x: (PAGE_WIDTH - pageTextWidth) / 2,
      y: MARGIN_BOTTOM - 24,
      size: 7,
      font: fontItalic,
      color: mutedText
    });
    
    // Confidential notice (right)
    const confText = 'Confidential';
    const confWidth = fontItalic.widthOfTextAtSize(confText, 7);
    p.drawText(confText, {
      x: PAGE_WIDTH - MARGIN_RIGHT - confWidth,
      y: MARGIN_BOTTOM - 24,
      size: 7,
      font: fontItalic,
      color: mutedText
    });
  });
  
  return await doc.save();
}

function getDigitizedReplicaPaths(document) {
  const ownerId = document.ownerId || '_general';
  const propertyId = document.propertyId || '_general';
  const digitizedDir = path.join(process.cwd(), 'server', 'uploads', 'documents', ownerId, propertyId, 'digitized');

  return {
    digitizedDir,
    replicaHtmlPath: document.metadata?.replicaStoredFileName
      ? path.join(digitizedDir, document.metadata.replicaStoredFileName)
      : '',
    replicaLayoutPath: document.metadata?.replicaLayoutStoredFileName
      ? path.join(digitizedDir, document.metadata.replicaLayoutStoredFileName)
      : ''
  };
}

app.get('/api/documents/:documentId/replica', async (req, res) => {
  try {
    const { documentId } = req.params;
    const result = await documentService.getDocumentById(documentId);
    if (!result.success) {
      return res.status(404).json({ ok: false, error: 'Document not found' });
    }

    const document = result.document;
    if (!document.metadata?.replicaStoredFileName) {
      return res.status(404).json({ ok: false, error: 'Digitized replica not available' });
    }

    const { replicaHtmlPath } = getDigitizedReplicaPaths(document);
    if (!replicaHtmlPath || !fs.existsSync(replicaHtmlPath)) {
      return res.status(404).json({ ok: false, error: 'Digitized replica file not found' });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(replicaHtmlPath);
  } catch (error) {
    console.error('[Documents] Error serving digitized replica:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/documents/:documentId/layout', async (req, res) => {
  try {
    const { documentId } = req.params;
    const result = await documentService.getDocumentById(documentId);
    if (!result.success) {
      return res.status(404).json({ ok: false, error: 'Document not found' });
    }

    const document = result.document;
    if (!document.metadata?.replicaLayoutStoredFileName) {
      return res.status(404).json({ ok: false, error: 'Digitized layout not available' });
    }

    const { replicaLayoutPath } = getDigitizedReplicaPaths(document);
    if (!replicaLayoutPath || !fs.existsSync(replicaLayoutPath)) {
      return res.status(404).json({ ok: false, error: 'Digitized layout file not found' });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(replicaLayoutPath);
  } catch (error) {
    console.error('[Documents] Error serving digitized layout:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// Get PDF for a document (generates on-the-fly if no cached PDF)
app.get('/api/documents/:documentId/pdf', async (req, res) => {
  try {
    const { documentId } = req.params;
    const result = await documentService.getDocumentById(documentId);
    
    if (!result.success) {
      return res.status(404).json({ ok: false, error: 'Document not found' });
    }
    
    const document = result.document;
    
    // If it's an uploaded file with its own path, redirect to that
    if (document.metadata?.isUploaded && document.metadata?.storageType === 'firebase' && document.metadata?.storagePath) {
      try {
        const fetched = await fetchFirebaseStorageFileByPath(document.metadata.storagePath);
        const contentType = fetched.mimeType || document.metadata?.fileType || 'application/octet-stream';
        const downloadName = (document.metadata?.fileName || document.title || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
        return res.send(fetched.buffer);
      } catch (storageError) {
        console.warn('[Documents] Firebase preview fallback:', storageError.message);
      }
    }

    if (document.metadata?.isUploaded && document.metadata?.filePath) {
      return res.redirect(document.metadata.filePath);
    }
    
    // Check for cached PDF on disk
    const cachedPath = path.join(process.cwd(), 'server', 'uploads', 'documents', document.ownerId || '_general', 'generated', `${documentId}.pdf`);
    if (fs.existsSync(cachedPath)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${document.title.replace(/[^a-zA-Z0-9.-]/g, '_')}.pdf"`);
      return fs.createReadStream(cachedPath).pipe(res);
    }
    
    // Generate PDF on the fly
    const pdfBytes = await generateDocumentPDF(
      document.title,
      document.content,
      document.signatureRequests || []
    );
    
    // Cache it to disk for next time
    try {
      const cacheDir = path.dirname(cachedPath);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      fs.writeFileSync(cachedPath, Buffer.from(pdfBytes));
    } catch (cacheErr) {
      console.warn('[Documents] Could not cache PDF:', cacheErr.message);
    }
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${document.title.replace(/[^a-zA-Z0-9.-]/g, '_')}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error('[Documents] Error generating PDF:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Upload document - saves file to disk, metadata to Firestore
// LEGACY: Kept for backward compatibility, new uploads should use /api/documents/save-metadata
app.post('/api/documents/upload', async (req, res) => {
  try {
    const { ownerId, propertyId, title, fileName, fileType, fileExtension, fileSize, fileData } = req.body;

    if (!ownerId || !propertyId || !fileData) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: ownerId, propertyId, fileData'
      });
    }

    // Check file size - 10MB limit
    const MAX_SIZE = 10 * 1024 * 1024;
    if (fileSize > MAX_SIZE) {
      return res.status(400).json({
        ok: false,
        error: 'File size exceeds 10MB limit'
      });
    }

    // Create uploads directory structure
    const uploadsDir = path.join(process.cwd(), 'server', 'uploads', 'documents', ownerId, propertyId);
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFileName = `${timestamp}_${sanitizedFileName}`;
    const filePath = path.join(uploadsDir, storedFileName);

    // Extract base64 data and save to disk
    const base64Data = fileData.replace(/^data:[^;]+;base64,/, '');
    const fileBuffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, fileBuffer);

    // Create document with file path (not the file data itself)
    const document = await documentService.createDocument({
      ownerId,
      propertyId,
      documentType: 'UPLOADED_DOCUMENT',
      title: title || fileName || 'Uploaded Document',
      content: `[Uploaded Document]\n\nFile: ${fileName}\nType: ${fileType}\nSize: ${(fileSize / 1024).toFixed(2)} KB`,
      metadata: {
        isUploaded: true,
        fileName: fileName,
        fileType: fileType,
        fileExtension: fileExtension,
        fileSize: fileSize,
        storedFileName: storedFileName,
        filePath: `/api/documents/file/${ownerId}/${propertyId}/${storedFileName}`,
        uploadedAt: new Date().toISOString()
      }
    });

    console.log(`[Documents] Saved file to disk: ${filePath} (${(fileSize / 1024).toFixed(2)} KB)`);

    res.json({
      ok: true,
      document
    });
  } catch (error) {
    console.error('[Documents] Error saving uploaded document:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ============================================================================
// NEW: Save document metadata when file is already in Firebase Storage
// This is the preferred endpoint - client uploads to Storage, then saves metadata here
// ============================================================================
app.post('/api/documents/save-metadata', async (req, res) => {
  try {
    const { ownerId, propertyId, title, fileName, fileType, fileExtension, fileSize, fileUrl, storagePath, fileData } = req.body;

    if (!ownerId || !propertyId || (!fileUrl && !storagePath && !fileData)) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: ownerId, propertyId, and a document source'
      });
    }

    console.log(`[Documents] Saving metadata for ${fileName} (file in Firebase Storage)`);

    const resolvedMimeType = resolveDocumentMimeType(fileName, fileType);
    const needsDigitization = shouldDigitizeUploadedDocument(fileType, fileName);
    const isPdf = resolvedMimeType === 'application/pdf' || String(fileExtension || '').toLowerCase() === 'pdf';

    let sourceBuffer = null;
    let sourceMimeType = resolvedMimeType;

    if (needsDigitization) {
      if (fileData) {
        try {
          const base64Data = String(fileData).replace(/^data:[^;]+;base64,/, '');
          sourceBuffer = Buffer.from(base64Data, 'base64');
        } catch (error) {
          console.warn('[Documents] Direct upload buffer fallback:', error.message);
        }
      }

      if (!sourceBuffer && storagePath) {
        try {
          const fetched = await fetchFirebaseStorageFileByPath(storagePath);
          sourceBuffer = fetched.buffer;
          sourceMimeType = fetched.mimeType || resolvedMimeType;
        } catch (error) {
          console.warn('[Documents] Firebase source buffer fallback:', error.message);
        }
      }

      if (!sourceBuffer && fileUrl) {
        try {
          const fetched = await fetchRemoteDocumentBuffer(fileUrl);
          sourceBuffer = fetched.buffer;
          sourceMimeType = fetched.mimeType || resolvedMimeType;
        } catch (error) {
          console.warn('[Documents] Remote source buffer fallback:', error.message);
        }
      }
    }

    let digitization = null;
    if (needsDigitization) {
      if (sourceBuffer) {
        digitization = await digitizeDocumentFromBytes({
          buffer: sourceBuffer,
          mimeType: sourceMimeType,
          fileName,
          title
        });
      } else {
        digitization = await digitizeDocumentFromStorage({
          storagePath,
          fileUrl,
          mimeType: fileType,
          fileName,
          title
        });
      }
    } else {
      console.log(`[Documents] Skipping AI digitization for native digital file: ${fileName}`);
      digitization = buildNativeDigitalSkipResult(fileType, fileName);
    }

    const digitizationSummary = summarizeDigitizationForStorage(digitization);

    let replicaStoredFileName = '';
    let replicaLayoutStoredFileName = '';
    let replicaGeneratedAt = '';
    if (needsDigitization && digitization?.ok && sourceBuffer) {
      try {
        const replicaArtifacts = await buildDigitizedReplicaArtifacts({
          digitization,
          sourceBuffer,
          sourceMimeType: sourceMimeType || fileType,
          fileName,
          title
        });

        if (replicaArtifacts?.html) {
          const digitizedDir = path.join(process.cwd(), 'server', 'uploads', 'documents', ownerId, propertyId, 'digitized');
          if (!fs.existsSync(digitizedDir)) {
            fs.mkdirSync(digitizedDir, { recursive: true });
          }

          const replicaBaseName = `${Date.now()}_${(fileName || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[^.]+$/, '')}`;
          replicaStoredFileName = `${replicaBaseName}.html`;
          replicaLayoutStoredFileName = `${replicaBaseName}.layout.json`;
          replicaGeneratedAt = new Date().toISOString();

          fs.writeFileSync(path.join(digitizedDir, replicaStoredFileName), replicaArtifacts.html, 'utf8');
          fs.writeFileSync(path.join(digitizedDir, replicaLayoutStoredFileName), JSON.stringify(replicaArtifacts.layout, null, 2), 'utf8');
        }
      } catch (replicaError) {
        console.warn('[Documents] Replica artifact generation skipped:', replicaError.message);
      }
    }

    // Create document with Firebase Storage URL (not the file data itself)
    const documentMetadata = {
      isUploaded: true,
      fileName: fileName,
      fileType: resolvedMimeType || fileType,
      fileExtension: fileExtension,
      fileSize: fileSize,
      uploadedAt: new Date().toISOString(),
      icon: '📄',
      description: `Uploaded document: ${fileName}`,
      ...(isPdf ? { hasPdf: true } : {}),
      ...digitizationSummary.metadata,
      ...(replicaStoredFileName
        ? {
            hasReplica: true,
            replicaStoredFileName,
            replicaLayoutStoredFileName,
            replicaGeneratedAt
          }
        : {}),
      ...(storagePath ? { storagePath, storageType: 'firebase' } : {}),
      ...(fileUrl ? { filePath: fileUrl } : {})
    };

    const document = await documentService.createDocument({
      ownerId,
      propertyId,
      documentType: 'UPLOADED_DOCUMENT',
      title: title || digitization?.title || fileName || 'Uploaded Document',
      content: digitizationSummary.content || `[Uploaded Document]\n\nFile: ${fileName}\nType: ${fileType || 'unknown'}\nSize: ${((fileSize || 0) / 1024).toFixed(2)} KB`,
      metadata: documentMetadata
    });

    if (document?.success === false) {
      throw new Error(document.error || 'Failed to save uploaded document metadata');
    }

    console.log(`[Documents] Created document ${document.id} (Firebase Storage: ${storagePath})`);

    res.json({
      ok: true,
      document,
      digitization: digitization?.ok
        ? {
            status: digitization.status,
            documentType: digitization.documentType,
            confidence: digitization.classificationConfidence,
            summary: digitization.summary
          }
        : {
            status: digitization?.status || 'failed',
            error: digitization?.error || null
          }
    });
  } catch (error) {
    console.error('[Documents] Error saving document metadata:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ============================================================================
// RENTER'S INSURANCE UPLOAD API - For tenants to upload their insurance
// ============================================================================

// Upload insurance document from tenant - saves to both tenant and owner accounts
app.post('/api/insurance/upload', async (req, res) => {
  try {
    const { tenantId, propertyId, ownerId, fileName, fileType, fileSize, fileData, policy } = req.body;

    if (!tenantId || !propertyId || !ownerId || !fileData || !policy) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: tenantId, propertyId, ownerId, fileData, policy'
      });
    }

    console.log(`[Insurance] Tenant ${tenantId} uploading insurance for property ${propertyId}`);

    // Check file size - 5MB limit
    const MAX_SIZE = 5 * 1024 * 1024;
    if (fileSize > MAX_SIZE) {
      return res.status(400).json({
        ok: false,
        error: 'File size exceeds 5MB limit'
      });
    }

    // Create uploads directory structure for insurance documents
    const uploadsDir = path.join(process.cwd(), 'server', 'uploads', 'insurance', ownerId, propertyId, tenantId);
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const sanitizedFileName = (fileName || 'insurance_certificate').replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFileName = `${timestamp}_${sanitizedFileName}`;
    const diskFilePath = path.join(uploadsDir, storedFileName);

    // Extract base64 data and save to disk
    const base64Data = fileData.replace(/^data:[^;]+;base64,/, '');
    const fileBuffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(diskFilePath, fileBuffer);

    const fileUrl = `/api/insurance/file/${ownerId}/${propertyId}/${tenantId}/${storedFileName}`;

    // Create insurance document record
    const insuranceDocId = `ins_${timestamp}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    
    // Check if policy is expired
    const isExpired = policy.expirationDate && new Date(policy.expirationDate) < new Date();
    
    const insuranceDocument = {
      id: insuranceDocId,
      tenantId,
      propertyId,
      ownerId,
      documentType: 'renters_insurance',
      policy: {
        ...policy,
        uploadedDocument: fileUrl,
        parsedAt: now
      },
      fileName,
      fileType,
      fileSize,
      fileUrl,
      storedFileName,
      status: isExpired ? 'expired' : 'active',
      uploadedAt: now,
      uploadedBy: 'tenant'
    };

    // Save to Firestore insurance collection
    if (signatureDb) {
      await signatureDb.collection('insurance_documents').doc(insuranceDocId).set(insuranceDocument);
      console.log(`[Insurance] ✅ Insurance document ${insuranceDocId} saved to Firestore`);
    }

    // Also create a document entry in the main documents collection so it appears in DocumentManager
    const document = await documentService.createDocument({
      ownerId,
      propertyId,
      tenantId,
      documentType: 'RENTERS_INSURANCE',
      title: `Renter's Insurance - ${policy.insuranceCompany || 'Certificate'}`,
      content: `[Renter's Insurance Certificate]\n\nInsurance Company: ${policy.insuranceCompany || 'N/A'}\nPolicy Number: ${policy.policyNumber || 'N/A'}\nPolicy Holder: ${policy.policyHolder || 'N/A'}\nLiability Coverage: $${policy.coverageAmount?.liability || 'N/A'}\nPersonal Property: $${policy.coverageAmount?.personalProperty || 'N/A'}\nMedical Payments: $${policy.coverageAmount?.medicalPayments || 'N/A'}\nEffective Date: ${policy.effectiveDate || 'N/A'}\nExpiration Date: ${policy.expirationDate || 'N/A'}\nLandlord Listed: ${policy.landlordListedAsInterested ? 'Yes' : 'No'}\n\nUploaded by tenant on ${now}`,
      metadata: {
        isUploaded: true,
        isInsurance: true,
        insuranceDocId: insuranceDocId,
        fileName: fileName,
        fileType: fileType,
        fileSize: fileSize,
        storedFileName: storedFileName,
        filePath: fileUrl,
        uploadedAt: now,
        uploadedBy: 'tenant',
        icon: '🛡️',
        description: `Renter's insurance from ${policy.insuranceCompany || 'tenant'}`,
        insurancePolicy: policy
      }
    });

    console.log(`[Insurance] Created document ${document.id} for owner's document manager with metadata:`, JSON.stringify(document.metadata, null, 2));

    // Update tenant record with insurance info
    if (signatureDb) {
      try {
        await signatureDb.collection('tenants').doc(tenantId).update({
          rentersInsurance: {
            hasInsurance: true,
            documentId: insuranceDocId,
            policy: policy,
            uploadedAt: now,
            status: isExpired ? 'expired' : 'active'
          }
        });
        console.log(`[Insurance] Updated tenant ${tenantId} with insurance info`);
      } catch (updateErr) {
        // Tenant doc might not exist, log but don't fail
        console.warn(`[Insurance] Could not update tenant record:`, updateErr.message);
      }
    }

    res.json({
      ok: true,
      insuranceDocument,
      document,
      message: 'Insurance uploaded successfully and shared with property owner'
    });

  } catch (error) {
    console.error('[Insurance] Error uploading insurance:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ============================================================================
// NEW: Save insurance metadata when file is already in Firebase Storage
// This is the preferred endpoint - client uploads to Storage, then saves metadata here
// ============================================================================
app.post('/api/insurance/save-metadata', async (req, res) => {
  try {
    const { tenantId, propertyId, ownerId, fileName, fileType, fileSize, fileUrl, storagePath, policy } = req.body;

    if (!tenantId || !propertyId || !ownerId || !fileUrl || !policy) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: tenantId, propertyId, ownerId, fileUrl, policy'
      });
    }

    console.log(`[Insurance] Saving metadata for tenant ${tenantId} (file in Firebase Storage)`);

    const now = new Date().toISOString();
    const insuranceDocId = `ins_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    // Check if policy is expired
    const isExpired = policy.expirationDate && new Date(policy.expirationDate) < new Date();
    
    const insuranceDocument = {
      id: insuranceDocId,
      tenantId,
      propertyId,
      ownerId,
      documentType: 'renters_insurance',
      policy: {
        ...policy,
        uploadedDocument: fileUrl,
        parsedAt: now
      },
      fileName: fileName || 'insurance_document',
      fileType: fileType || 'application/pdf',
      fileSize: fileSize || 0,
      fileUrl,                   // Firebase Storage URL
      storagePath: storagePath,  // Firebase Storage path for deletion if needed
      storageType: 'firebase',   // Indicates file is in Firebase Storage (not local disk)
      status: isExpired ? 'expired' : 'active',
      uploadedAt: now,
      uploadedBy: 'tenant'
    };

    // Save to Firestore insurance collection
    if (signatureDb) {
      await signatureDb.collection('insurance_documents').doc(insuranceDocId).set(insuranceDocument);
      console.log(`[Insurance] ✅ Insurance document ${insuranceDocId} saved to Firestore (Firebase Storage)`);
    }

    // Also create a document entry in the main documents collection so it appears in DocumentManager
    const document = await documentService.createDocument({
      ownerId,
      propertyId,
      tenantId,
      documentType: 'RENTERS_INSURANCE',
      title: `Renter's Insurance - ${policy.insuranceCompany || 'Certificate'}`,
      content: `[Renter's Insurance Certificate]\n\nInsurance Company: ${policy.insuranceCompany || 'N/A'}\nPolicy Number: ${policy.policyNumber || 'N/A'}\nPolicy Holder: ${policy.policyHolder || 'N/A'}\nLiability Coverage: $${policy.coverageAmount?.liability || 'N/A'}\nPersonal Property: $${policy.coverageAmount?.personalProperty || 'N/A'}\nMedical Payments: $${policy.coverageAmount?.medicalPayments || 'N/A'}\nEffective Date: ${policy.effectiveDate || 'N/A'}\nExpiration Date: ${policy.expirationDate || 'N/A'}\nLandlord Listed: ${policy.landlordListedAsInterested ? 'Yes' : 'No'}\n\nUploaded by tenant on ${now}`,
      metadata: {
        isUploaded: true,
        isInsurance: true,
        insuranceDocId: insuranceDocId,
        fileName: fileName,
        fileType: fileType,
        fileSize: fileSize,
        storagePath: storagePath,
        storageType: 'firebase',
        filePath: fileUrl,  // Firebase Storage download URL
        uploadedAt: now,
        uploadedBy: 'tenant',
        icon: '🛡️',
        description: `Renter's insurance from ${policy.insuranceCompany || 'tenant'}`,
        insurancePolicy: policy
      }
    });

    console.log(`[Insurance] Created document ${document.id} for owner's document manager`);

    // Update tenant record with insurance info
    if (signatureDb) {
      try {
        await signatureDb.collection('tenants').doc(tenantId).update({
          rentersInsurance: {
            hasInsurance: true,
            documentId: insuranceDocId,
            policy: policy,
            uploadedAt: now,
            status: isExpired ? 'expired' : 'active'
          }
        });
        console.log(`[Insurance] Updated tenant ${tenantId} with insurance info`);
      } catch (updateErr) {
        console.warn(`[Insurance] Could not update tenant record:`, updateErr.message);
      }
    }

    res.json({
      ok: true,
      insuranceDocument,
      document,
      message: 'Insurance saved successfully (file in Firebase Storage)'
    });

  } catch (error) {
    console.error('[Insurance] Error saving insurance metadata:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Get tenant's insurance documents
app.get('/api/insurance/tenant/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { propertyId } = req.query;

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: 'Missing tenantId'
      });
    }

    console.log(`[Insurance] Fetching insurance for tenant ${tenantId}`);

    if (!signatureDb) {
      return res.json({ ok: true, insuranceDocuments: [] });
    }

    let query = signatureDb.collection('insurance_documents').where('tenantId', '==', tenantId);
    
    if (propertyId) {
      query = query.where('propertyId', '==', propertyId);
    }

    let snapshot;
    try {
      snapshot = await query.orderBy('uploadedAt', 'desc').get();
    } catch (indexError) {
      console.warn('[Insurance] Index not available, querying without order:', indexError.message);
      snapshot = await query.get();
    }
    
    const insuranceDocuments = snapshot.docs.map(doc => doc.data());
    console.log(`[Insurance] Found ${insuranceDocuments.length} insurance documents for tenant`);

    res.json({
      ok: true,
      insuranceDocuments
    });

  } catch (error) {
    console.error('[Insurance] Error fetching tenant insurance:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Get insurance documents for a property (for landlords)
app.get('/api/insurance/property/:propertyId', async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { ownerId } = req.query;

    if (!propertyId) {
      return res.status(400).json({
        ok: false,
        error: 'Missing propertyId'
      });
    }

    console.log(`[Insurance] Fetching insurance for property ${propertyId}`);

    if (!signatureDb) {
      return res.json({ ok: true, insuranceDocuments: [] });
    }

    let query = signatureDb.collection('insurance_documents').where('propertyId', '==', propertyId);
    
    if (ownerId) {
      query = query.where('ownerId', '==', ownerId);
    }

    let snapshot;
    try {
      snapshot = await query.orderBy('uploadedAt', 'desc').get();
    } catch (indexError) {
      console.warn('[Insurance] Index not available, querying without order:', indexError.message);
      snapshot = await query.get();
    }
    
    const insuranceDocuments = snapshot.docs.map(doc => doc.data());
    console.log(`[Insurance] Found ${insuranceDocuments.length} insurance documents for property`);

    res.json({
      ok: true,
      insuranceDocuments
    });

  } catch (error) {
    console.error('[Insurance] Error fetching property insurance:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Serve insurance files
app.get('/api/insurance/file/:ownerId/:propertyId/:tenantId/:fileName', (req, res) => {
  const { ownerId, propertyId, tenantId, fileName } = req.params;
  const filePath = path.join(process.cwd(), 'server', 'uploads', 'insurance', ownerId, propertyId, tenantId, fileName);
  
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ ok: false, error: 'File not found' });
  }
});

// Handle scanned documents from mobile scanner
app.post('/api/documents/scanned', async (req, res) => {
  try {
    const { ownerId, propertyId, sessionToken, title, documentType, scannedPages, metadata } = req.body;

    if (!ownerId || !propertyId || !title || !scannedPages || scannedPages.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: ownerId, propertyId, title, scannedPages'
      });
    }

    console.log(`[Documents] Processing scanned document: ${title} with ${scannedPages.length} page(s)`);

    const uploadsDir = path.join(process.cwd(), 'server', 'uploads', 'documents', ownerId, propertyId, 'scans');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const savedPages = [];
    const timestamp = Date.now();

    for (let index = 0; index < scannedPages.length; index += 1) {
      const page = scannedPages[index];
      const pageFileName = `scan_${timestamp}_page_${index + 1}.jpg`;
      const pagePath = path.join(uploadsDir, pageFileName);
      const base64Data = page.dataUrl.replace(/^data:[^;]+;base64,/, '');
      const fileBuffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(pagePath, fileBuffer);

      savedPages.push({
        pageNumber: index + 1,
        fileName: pageFileName,
        filePath: `/api/documents/file/${ownerId}/${propertyId}/scans/${pageFileName}`,
        scannedAt: page.scannedAt
      });
    }

    let pdfBytes = null;
    let pdfUrl = null;
    try {
      console.log(`[Documents] Generating PDF from ${savedPages.length} page(s)...`);
      const pdfDoc = await PDFDocument.create();

      for (let index = 0; index < scannedPages.length; index += 1) {
        const page = scannedPages[index];
        const base64Data = page.dataUrl.replace(/^data:[^;]+;base64,/, '');
        const imageBytes = Buffer.from(base64Data, 'base64');

        let image;
        if (page.dataUrl.includes('image/png')) {
          image = await pdfDoc.embedPng(imageBytes);
        } else {
          image = await pdfDoc.embedJpg(imageBytes);
        }

        const { width, height } = image.scale(1);
        const maxWidth = 612;
        const maxHeight = 792;
        let scaledWidth = width;
        let scaledHeight = height;

        if (width > maxWidth || height > maxHeight) {
          const widthRatio = maxWidth / width;
          const heightRatio = maxHeight / height;
          const scale = Math.min(widthRatio, heightRatio);
          scaledWidth = width * scale;
          scaledHeight = height * scale;
        }

        const pdfPage = pdfDoc.addPage([scaledWidth, scaledHeight]);
        pdfPage.drawImage(image, {
          x: 0,
          y: 0,
          width: scaledWidth,
          height: scaledHeight
        });
      }

      pdfBytes = await pdfDoc.save();
      const pdfFileName = `scan_${timestamp}.pdf`;
      const pdfPath = path.join(uploadsDir, pdfFileName);
      fs.writeFileSync(pdfPath, pdfBytes);
      pdfUrl = `/api/documents/file/${ownerId}/${propertyId}/scans/${pdfFileName}`;
      console.log(`[Documents] PDF generated: ${pdfFileName} (${(pdfBytes.length / 1024).toFixed(1)} KB)`);
    } catch (pdfError) {
      console.warn('[Documents] PDF generation failed:', pdfError.message);
    }

    const digitization = pdfBytes
      ? await digitizeDocumentFromBytes({
          buffer: Buffer.from(pdfBytes),
          mimeType: 'application/pdf',
          fileName: `${title || 'scanned-document'}.pdf`,
          title
        })
      : {
          ok: false,
          status: 'failed',
          error: 'Could not generate a PDF for Azure digitization',
          mimeType: 'application/pdf'
        };
    const digitizationSummary = summarizeDigitizationForStorage(digitization);

    const pageTextMap = new Map(
      (digitization.ok ? digitization.pages : []).map((page) => [page.pageNumber, page.text])
    );

    const savedPagesWithText = savedPages.map((page) => ({
      ...page,
      extractedText: pageTextMap.get(page.pageNumber) || ''
    }));

    const classifiedType = digitizationSummary.classifiedType || documentType || 'scanned_document';
    const classificationConfidence = digitizationSummary.classificationConfidence || 0;
    const extractedFields = digitizationSummary.extractedFields || {};
    const fullText = digitizationSummary.content || `[Scanned Document]\n\nTitle: ${title}`;

    const typeIcons = {
      lease_agreement: '📝',
      rental_application: '📋',
      insurance_certificate: '🛡️',
      invoice: '🧾',
      receipt: '🧾',
      utility_bill: '💡',
      tax_document: '📊',
      repair_estimate: '🔧',
      inspection_report: '🔍',
      notice: '📨',
      correspondence: '✉️',
      id_document: '🪪',
      bank_statement: '🏦',
      pay_stub: '💰',
      other: '📄'
    };

    const document = await documentService.createDocument({
      ownerId,
      propertyId,
      documentType: classifiedType,
      title,
      content: fullText,
      metadata: {
        ...metadata,
        icon: typeIcons[classifiedType] || '📄',
        description: `Scanned ${classifiedType.replace(/_/g, ' ')}`,
        isScanned: true,
        scanSource: 'mobile',
        pageCount: scannedPages.length,
        pages: savedPagesWithText,
        sessionToken,
        scannedAt: new Date().toISOString(),
        ...digitizationSummary.metadata,
        pdfGenerated: !!pdfUrl,
        pdfUrl
      }
    });

    console.log(`[Documents] ✅ Scanned document saved: ${document.id} with digitization (${fullText.length} chars), classified as ${classifiedType}`);

    res.json({
      ok: true,
      document,
      ocr: {
        processed: !!digitization.ok,
        textLength: fullText.length,
        pageCount: savedPages.length
      },
      classification: {
        type: classifiedType,
        confidence: classificationConfidence,
        extractedFields
      },
      digitization: digitization?.ok
        ? {
            status: digitization.status,
            summary: digitization.summary,
            documentType: digitization.documentType,
            confidence: digitization.classificationConfidence
          }
        : {
            status: digitization?.status || 'failed',
            error: digitization?.error || null
          },
      pdf: {
        generated: !!pdfUrl,
        url: pdfUrl
      },
      message: `Document "${title}" saved with Azure digitization and ${digitization?.providers?.interpretation ? 'Claude interpretation' : 'structured extraction'}`
    });
  } catch (error) {
    console.error('[Documents] Error saving scanned document:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Serve uploaded document files
app.get('/api/documents/file/:ownerId/:propertyId/:fileName', (req, res) => {
  try {
    const { ownerId, propertyId, fileName } = req.params;
    const filePath = path.join(process.cwd(), 'server', 'uploads', 'documents', ownerId, propertyId, fileName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: 'File not found' });
    }

    // Determine content type from extension
    const ext = path.extname(fileName).toLowerCase();
    const contentTypes = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt': 'text/plain',
      '.csv': 'text/csv'
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('[Documents] Error serving file:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Serve scanned document files (in subdirectory)
app.get('/api/documents/file/:ownerId/:propertyId/scans/:fileName', (req, res) => {
  try {
    const { ownerId, propertyId, fileName } = req.params;
    const filePath = path.join(process.cwd(), 'server', 'uploads', 'documents', ownerId, propertyId, 'scans', fileName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: 'Scanned file not found' });
    }

    const ext = path.extname(fileName).toLowerCase();
    const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('[Documents] Error serving scanned file:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Generate document content with AI
app.post('/api/documents/generate', async (req, res) => {
  try {
    const { documentType, propertyAddress, landlordName, tenantName, customInstructions, additionalData } = req.body;

    if (!documentType) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: documentType'
      });
    }

    console.log(`[Documents] Generating ${documentType} for "${propertyAddress || 'NO ADDRESS'}" with legal compliance...`);
    console.log(`[Documents] additionalData keys:`, Object.keys(additionalData || {}), 'propertyState:', additionalData?.propertyState, 'propertyCity:', additionalData?.propertyCity);

    const result = await documentService.generateDocumentContent({
      documentType,
      propertyAddress,
      landlordName,
      tenantName,
      customInstructions,
      additionalData
    });

    if (!result.success) {
      return res.status(500).json({
        ok: false,
        error: result.error
      });
    }

    console.log(`[Documents] ✅ Generated ${documentType} (${result.content?.length || 0} chars, compliance: ${result.compliance?.stateCode || 'N/A'})`);

    res.json({
      ok: true,
      content: result.content,
      complianceMetadata: result.compliance || null
    });
  } catch (error) {
    console.error('[Documents] Error generating document:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Quick compliance check endpoint - validate lease terms against state law
app.post('/api/documents/compliance-check', async (req, res) => {
  try {
    const { propertyAddress, stateCode, securityDeposit, monthlyRent, lateFee, noticePeriod } = req.body;

    if (!propertyAddress && !stateCode) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: propertyAddress or stateCode'
      });
    }

    const result = await documentService.quickComplianceCheck({
      propertyAddress,
      stateCode,
      securityDeposit: securityDeposit ? parseFloat(securityDeposit) : undefined,
      monthlyRent: monthlyRent ? parseFloat(monthlyRent) : undefined,
      lateFee: lateFee ? parseFloat(lateFee) : undefined,
      noticePeriod: noticePeriod ? parseInt(noticePeriod) : undefined
    });

    console.log(`[Documents] Compliance check for ${stateCode || propertyAddress}: ${result.issues?.length || 0} issues found`);

    res.json({
      ok: true,
      compliance: result
    });
  } catch (error) {
    console.error('[Documents] Error running compliance check:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Get supported states and their compliance info
app.get('/api/documents/compliance/states', async (req, res) => {
  try {
    // Import dynamically to avoid circular deps
    const { getSupportedStates, getStateLaws } = await import('./legal-compliance-data.js');
    const states = getSupportedStates();
    const stateInfo = {};
    for (const code of states) {
      const laws = getStateLaws(code);
      if (laws) {
        stateInfo[code] = {
          name: laws.name,
          statutes: laws.statutes,
          securityDeposit: laws.securityDeposit,
          requiredDisclosures: laws.requiredDisclosures?.map(d => d.name || d) || []
        };
      }
    }
    res.json({ ok: true, states: stateInfo });
  } catch (error) {
    console.error('[Documents] Error getting compliance states:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Update document status
app.patch('/api/documents/:documentId/status', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: status'
      });
    }

    const result = await documentService.updateDocumentStatus(documentId, status);

    res.json({
      ok: result.success,
      error: result.error
    });
  } catch (error) {
    console.error('[Documents] Error updating status:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Delete a document
app.delete('/api/documents/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const result = await documentService.deleteDocument(documentId);

    res.json({
      ok: result.success,
      error: result.error
    });
  } catch (error) {
    console.error('[Documents] Error deleting document:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Rename a document
app.patch('/api/documents/:documentId/title', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { title } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ ok: false, error: 'Title is required' });
    }
    const result = await documentService.renameDocument(documentId, title.trim());
    res.json({ ok: result.success, error: result.error });
  } catch (error) {
    console.error('[Documents] Error renaming document:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Update editable document text
app.patch('/api/documents/:documentId/content', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { content, extractedText, summary } = req.body || {};

    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ ok: false, error: 'Content is required' });
    }

    const result = await documentService.updateDocumentContent(documentId, content, {
      ...(typeof extractedText === 'string' ? { extractedText } : {}),
      ...(typeof summary === 'string' ? { summary } : {})
    });

    if (!result.success) {
      return res.status(result.error === 'Document not found' ? 404 : 400).json({
        ok: false,
        error: result.error
      });
    }

    try {
      const cachedPath = path.join(
        process.cwd(),
        'server',
        'uploads',
        'documents',
        result.document?.ownerId || '_general',
        'generated',
        `${documentId}.pdf`
      );
      if (fs.existsSync(cachedPath)) {
        fs.unlinkSync(cachedPath);
      }
    } catch (cacheError) {
      console.warn('[Documents] Could not clear cached PDF after content edit:', cacheError.message);
    }

    res.json({
      ok: true,
      document: result.document
    });
  } catch (error) {
    console.error('[Documents] Error updating document content:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Create signature request
app.post('/api/documents/signature-request', async (req, res) => {
  try {
    const { documentId, signers } = req.body;

    if (!documentId || !signers || !Array.isArray(signers)) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: documentId, signers (array)'
      });
    }

    const result = await documentService.createSignatureRequest({
      documentId,
      signers
    });

    if (!result.success) {
      return res.status(500).json({
        ok: false,
        error: result.error
      });
    }

    console.log(`[Documents] Signature request created for ${signers.length} signers`);

    res.json({
      ok: true,
      signingLinks: result.signingLinks
    });
  } catch (error) {
    console.error('[Documents] Error creating signature request:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Verify signing token
app.get('/api/documents/sign/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: 'Missing signing token'
      });
    }

    const result = await documentService.verifySigningToken(documentId, token);

    if (!result.valid) {
      return res.status(403).json({
        ok: false,
        error: result.error
      });
    }

    res.json({
      ok: true,
      document: result.document,
      signer: result.signer
    });
  } catch (error) {
    console.error('[Documents] Error verifying token:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Apply signature (rate-limited to prevent brute-force token guessing)
app.post('/api/documents/sign/:documentId', signingRateLimiter, async (req, res) => {
  try {
    const { documentId } = req.params;
    const { token, signatureData, ersdConsentTimestamp } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!token || !signatureData) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: token, signatureData'
      });
    }

    const result = await documentService.applySignature({
      documentId,
      token,
      signatureData,
      ipAddress,
      userAgent,
      ersdConsentTimestamp
    });

    if (!result.success) {
      return res.status(500).json({
        ok: false,
        error: result.error
      });
    }

    console.log(`[Documents] Signature applied to ${documentId} - All signed: ${result.allSigned}`);

    // Invalidate cached PDF so next generation includes the new signature
    try {
      const docResult = await documentService.getDocumentById(documentId);
      if (docResult.success) {
        const cachedPdfPath = path.join(
          process.cwd(), 'server', 'uploads', 'documents',
          docResult.document.ownerId || '_general', 'generated', `${documentId}.pdf`
        );
        if (fs.existsSync(cachedPdfPath)) {
          fs.unlinkSync(cachedPdfPath);
          console.log(`[Documents] Invalidated cached PDF for ${documentId}`);
        }
      }
    } catch (cacheErr) {
      console.warn('[Documents] Could not invalidate cached PDF:', cacheErr.message);
    }

    // Auto-generate signing receipt when all parties have signed
    let receiptId = null;
    if (result.allSigned) {
      try {
        const receiptResult = await documentService.generateSigningReceipt(documentId);
        if (receiptResult.success) {
          receiptId = receiptResult.receipt.id;
          console.log(`[Documents] ✅ Signing receipt auto-generated: ${receiptId}`);
        }
      } catch (receiptErr) {
        console.error('[Documents] Receipt auto-generation failed (non-blocking):', receiptErr.message);
      }
    }

    res.json({
      ok: true,
      allSigned: result.allSigned,
      newStatus: result.newStatus,
      message: result.message,
      receiptId
    });
  } catch (error) {
    console.error('[Documents] Error applying signature:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Send signature reminder
app.post('/api/documents/:documentId/remind', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { signerId } = req.body;

    if (!signerId) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: signerId'
      });
    }

    const result = await documentService.sendSignatureReminder(documentId, signerId);

    res.json({
      ok: result.success,
      message: result.message
    });
  } catch (error) {
    console.error('[Documents] Error sending reminder:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Get signed document with embedded signatures for viewing
app.get('/api/documents/:documentId/signed', async (req, res) => {
  try {
    const { documentId } = req.params;
    const result = await documentService.getSignedDocumentWithSignatures(documentId);

    if (!result.success) {
      return res.status(404).json({
        ok: false,
        error: result.error
      });
    }

    res.json({
      ok: true,
      document: result.document,
      signatures: result.signatures
    });
  } catch (error) {
    console.error('[Documents] Error fetching signed document:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Generate a signing receipt / Certificate of Completion for a document
app.post('/api/documents/:documentId/receipt', async (req, res) => {
  try {
    const { documentId } = req.params;
    const result = await documentService.generateSigningReceipt(documentId);

    if (!result.success) {
      return res.status(result.error === 'Document not found' ? 404 : 400).json({
        ok: false,
        error: result.error
      });
    }

    console.log(`[Documents] Signing receipt generated for ${documentId}`);

    res.json({
      ok: true,
      receipt: result.receipt
    });
  } catch (error) {
    console.error('[Documents] Error generating signing receipt:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Get signing receipt / Certificate of Completion for a document
app.get('/api/documents/:documentId/receipt', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { receiptId } = req.query;
    const result = await documentService.getSigningReceipt(documentId, receiptId || null);

    if (!result.success) {
      return res.status(404).json({
        ok: false,
        error: result.error
      });
    }

    res.json({
      ok: true,
      receipt: result.receipt
    });
  } catch (error) {
    console.error('[Documents] Error fetching signing receipt:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Verify document integrity (tamper detection)
app.get('/api/documents/:documentId/verify', async (req, res) => {
  try {
    const { documentId } = req.params;
    const result = await documentService.getDocumentById(documentId);
    
    if (!result.success) {
      return res.status(404).json({ ok: false, error: result.error });
    }
    
    const doc = result.document;
    const integrityVerification = documentService.evaluateDocumentIntegrity(doc);
    const integrityValid = integrityVerification.status === 'NOT_SEALED'
      ? null
      : !integrityVerification.tamperDetected;
    const details = integrityVerification.status === 'NOT_SEALED'
      ? { message: integrityVerification.explanation }
      : {
          sealedAt: integrityVerification.sealedAt,
          sealedHash: integrityVerification.sealedHash,
          currentHash: integrityVerification.currentHash,
          tamperDetected: integrityVerification.tamperDetected,
          verifiedWith: integrityVerification.verifiedWith,
          verifiedWithLabel: integrityVerification.verifiedWithLabel,
          verificationScope: integrityVerification.verificationScope,
          explanation: integrityVerification.explanation
        };
    
    res.json({
      ok: true,
      documentId,
      status: doc.status,
      integrityValid,
      details
    });
  } catch (error) {
    console.error('[Documents] Error verifying document:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Withdraw e-signature consent (ESIGN Act requirement)
app.post('/api/documents/withdraw-consent', strictRateLimiter, async (req, res) => {
  try {
    const { userId, userName, userEmail, reason } = req.body;
    
    if (!userId || !userEmail) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: userId and userEmail'
      });
    }
    
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    // Log the consent withdrawal in Firestore
    const admin = (await import('./firebase-admin.js')).initializeFirebaseAdmin();
    const db = admin.firestore();
    
    const withdrawalRecord = {
      id: `consent_withdrawal_${Date.now()}`,
      userId,
      userName: userName || 'Unknown',
      userEmail,
      reason: reason || 'No reason provided',
      action: 'esign_consent_withdrawn',
      timestamp: new Date().toISOString(),
      ipAddress,
      userAgent,
      legalBasis: 'ESIGN Act 15 U.S.C. §7001(c)(1)(B) - Consumer right to withdraw consent'
    };
    
    await db.collection('consent_withdrawals').add(withdrawalRecord);
    
    console.log(`[Documents] E-sign consent withdrawn by ${userEmail} (${userId})`);
    
    res.json({
      ok: true,
      message: 'Your consent to use electronic signatures has been withdrawn. Future documents will need to be signed in paper form. Note: This does not affect the validity of any documents you have already signed electronically.',
      withdrawalId: withdrawalRecord.id
    });
  } catch (error) {
    console.error('[Documents] Error processing consent withdrawal:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// SAVED SIGNATURES (Auto-Sign Feature)
// ============================================================================

// Save user's signature for auto-sign
app.post('/api/signatures/save', async (req, res) => {
  try {
    const { userId, signatureData, name } = req.body;

    if (!userId || !signatureData) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: userId, signatureData'
      });
    }

    if (!signatureDb) {
      return res.status(503).json({
        ok: false,
        error: 'Signature storage unavailable'
      });
    }

    // Store in Firestore under user_signatures collection
    const signatureDoc = {
      userId,
      signatureData,
      name: name || 'Default Signature',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await signatureDb.collection('user_signatures').doc(userId).set(signatureDoc);

    console.log(`[Signatures] Saved signature for user ${userId}`);

    res.json({
      ok: true,
      message: 'Signature saved successfully'
    });
  } catch (error) {
    console.error('[Signatures] Error saving signature:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Get user's saved signature
app.get('/api/signatures/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!signatureDb) {
      return res.json({
        ok: true,
        hasSignature: false,
        signature: null
      });
    }

    const docRef = await signatureDb.collection('user_signatures').doc(userId).get();

    if (!docRef.exists) {
      return res.json({
        ok: true,
        hasSignature: false,
        signature: null
      });
    }

    const data = docRef.data();

    res.json({
      ok: true,
      hasSignature: true,
      signature: {
        signatureData: data.signatureData,
        name: data.name,
        createdAt: data.createdAt
      }
    });
  } catch (error) {
    console.error('[Signatures] Error fetching signature:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Delete user's saved signature
app.delete('/api/signatures/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!signatureDb) {
      return res.status(503).json({
        ok: false,
        error: 'Signature storage unavailable'
      });
    }

    await signatureDb.collection('user_signatures').doc(userId).delete();

    console.log(`[Signatures] Deleted signature for user ${userId}`);

    res.json({
      ok: true,
      message: 'Signature deleted successfully'
    });
  } catch (error) {
    console.error('[Signatures] Error deleting signature:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

console.log('✅ [Documents] Document management and e-signature endpoints registered');

// Create HTTP server
const server = http.createServer(app);

// Setup WebSocket server for voice calls if module available
if (voiceModule) {
  try {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const publicUrl = process.env.PUBLIC_URL || `${protocol}://localhost:${PORT}`;
    voiceModule.setupWebSocketServer(server, publicUrl);
    console.log('[Voice] ✅ OpenAI Realtime WebSocket server initialized');
  } catch (error) {
    console.error('[Voice] WebSocket setup error:', error.message);
  }
}

// Setup GROQ WebSocket server for ultra-low latency voice calls
if (groqVoiceModule) {
  try {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const publicUrl = process.env.PUBLIC_URL || `${protocol}://localhost:${PORT}`;
    groqVoiceModule.setupGroqWebSocketServer(server, publicUrl);
  } catch (error) {
    console.error('[GROQ-Voice] WebSocket setup error:', error.message);
  }
}

// Setup ElevenLabs + GROQ Hybrid Voice (best quality V3 Alpha + LPU speed)
if (elevenLabsGroqModule) {
  try {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const publicUrl = process.env.PUBLIC_URL || process.env.NGROK_URL || process.env.CLOUDFLARE_TUNNEL_URL || `${protocol}://localhost:${PORT}`;
    elevenLabsGroqModule.setupElevenLabsGroqWebSocketServer(server, publicUrl);
    elevenLabsGroqModule.setupElevenLabsGroqRoutes(app, publicUrl);
    console.log('[ElevenLabs-GROQ] ✅ ElevenLabs V3 Alpha + GROQ LPU WebSocket server initialized');
  } catch (error) {
    console.error('[ElevenLabs-GROQ] WebSocket setup error:', error.message);
  }
}

// Setup new Phone Call WebSocket server (fresh GROQ implementation)
if (phoneModule) {
  try {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const publicUrl = process.env.PUBLIC_URL || process.env.NGROK_URL || process.env.CLOUDFLARE_TUNNEL_URL || `${protocol}://localhost:${PORT}`;
    phoneModule.setupPhoneWebSocket(server, publicUrl);
  } catch (error) {
    console.error('[Phone] WebSocket setup error:', error.message);
  }
}

// Setup GROQ + ElevenLabs Phone Call WebSocket server (best quality voice for phone calls)
if (groqElevenLabsPhoneModule) {
  try {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const publicUrl = process.env.PUBLIC_URL || process.env.NGROK_URL || process.env.CLOUDFLARE_TUNNEL_URL || `${protocol}://localhost:${PORT}`;
    groqElevenLabsPhoneModule.setupGroqElevenLabsPhoneWebSocketServer(server, publicUrl);
    console.log('[GROQ-ElevenLabs-Phone] ✅ WebSocket server initialized with ElevenLabs Liam voice');
  } catch (error) {
    console.error('[GROQ-ElevenLabs-Phone] WebSocket setup error:', error.message);
  }
}

// Setup Tenant Interview WebSocket server (AI phone interviews for screening)
if (tenantInterviewModule) {
  try {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const publicUrl = process.env.PUBLIC_URL || process.env.NGROK_URL || process.env.CLOUDFLARE_TUNNEL_URL || `${protocol}://localhost:${PORT}`;
    tenantInterviewModule.setupInterviewWebSocket(server, publicUrl);
    console.log('[Interview] ✅ Tenant Interview WebSocket server initialized');
  } catch (error) {
    console.error('[Interview] WebSocket setup error:', error.message);
  }
}

// Setup Shelly Direct WebSocket server (devices connect to us - no cloud needed)
try {
  const shellyManagerModule = await import('./services/shellyManager.js');
  const shellyManager = shellyManagerModule.default;
  
  await shellyManager.initialize(server, {
    enableWebSocket: true,
    enableMqtt: process.env.SHELLY_ENABLE_MQTT === 'true'
  });
  
  // Initialize sensor alert automation with required modules
  try {
    const sensorAlertModule = await import('./services/sensorAlertAutomation.js');
    const sensorAlertAutomation = sensorAlertModule.sensorAlertAutomation;
    
    // Initialize with voice module
    // Note: Email notifications now use the centralized email-service.js (Nodemailer)
    // instead of the Gmail module, matching tenant onboarding and interview scheduling
    sensorAlertAutomation.initialize({
      voiceModule: voiceModule,
      firestoreService: null // Will load dynamically if available
    });
    
    // Listen for maintenance requests created from alerts
    sensorAlertAutomation.on('maintenanceRequest:created', (request) => {
      console.log(`[SensorAlert] 📋 Maintenance request created: ${request.id}`);
      maintenanceAutomationStatus.set(request.id, request);
    });
    
    console.log('✅ [SensorAlert] Automation service initialized with email/SMS/voice capabilities');
  } catch (alertError) {
    console.log('[SensorAlert] Automation not available:', alertError.message);
  }
  
  // Forward alerts to console and any connected clients
  shellyManager.on('alert', (alert) => {
    console.log(`🚨 [Shelly] ${alert.type.toUpperCase()} ALERT: ${alert.message}`);
  });
  
  // Log when automated notifications are sent
  shellyManager.on('alert:automated', (result) => {
    console.log(`📧 [Shelly] Alert automation complete:`, {
      alertId: result.alertId,
      email: result.notifications.email?.ok ? 'sent' : 'skipped',
      sms: result.notifications.sms?.ok ? 'sent' : 'skipped', 
      call: result.notifications.phoneCall?.ok ? 'initiated' : 'skipped'
    });
  });
  
  console.log('✅ [Shelly Direct] WebSocket server ready for device connections');
} catch (error) {
  console.log('ℹ️  [Shelly Direct] WebSocket server not started:', error.message);
}

// ============================================================================
// TENANT MANAGEMENT API
// ============================================================================

// Store for invite tokens (in production, use Redis or database)
const tenantInviteTokens = new Map();

// Generate secure tenant invite token and send email
app.post('/api/tenants/invite', async (req, res) => {
  try {
    const { ownerId, ownerEmail, ownerName, propertyId, propertyAddress, unit, tenantEmail, tenantName, leaseStart, leaseEnd, monthlyRent } = req.body;
    
    if (!ownerId || !propertyId || !propertyAddress || !tenantEmail) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: ownerId, propertyId, propertyAddress, tenantEmail'
      });
    }

    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + (48 * 60 * 60 * 1000); // 48 hours

    // Store invite token in memory (fallback)
    tenantInviteTokens.set(token, {
      ownerId,
      ownerEmail: ownerEmail || 'owner@example.com',
      ownerName: ownerName || 'Property Owner',
      propertyId,
      propertyAddress,
      unit: unit || '',
      tenantEmail,
      tenantName: tenantName || 'Tenant',
      leaseStart: leaseStart || null,
      leaseEnd: leaseEnd || null,
      monthlyRent: monthlyRent || null,
      expiresAt,
      used: false,
      createdAt: new Date().toISOString()
    });

    // Also save to Firestore (primary storage)
    if (createTenantInvite) {
      const firestoreResult = await createTenantInvite({
        token,
        ownerId,
        ownerEmail,
        ownerName,
        propertyId,
        propertyAddress,
        unit,
        tenantEmail,
        tenantName,
        leaseStart,
        leaseEnd,
        monthlyRent,
        expiresAt
      });
      if (firestoreResult.ok) {
        console.log(`[Tenants] ✅ Invite saved to Firestore: ${token.substring(0, 8)}...`);
      } else {
        console.warn('[Tenants] ⚠️ Firestore save failed, using in-memory:', firestoreResult.error);
      }
    }

    // Clean up expired token after 48 hours
    setTimeout(() => {
      if (tenantInviteTokens.has(token) && !tenantInviteTokens.get(token).used) {
        tenantInviteTokens.delete(token);
        console.log(`[Tenants] Deleted expired invite token for ${tenantEmail}`);
      }
    }, 48 * 60 * 60 * 1000);

    // Generate invite link - use FRONTEND_URL for the React app
    // NOTE: PUBLIC_URL is for the backend (Twilio webhooks), FRONTEND_URL is for the React app
    const frontendUrl = process.env.FRONTEND_URL || process.env.PUBLIC_URL || 'http://localhost:5173';
    const inviteLink = `${frontendUrl}/login/tenant?invite=${token}`;
    console.log(`[Tenants] Generated invite link using frontend URL: ${frontendUrl}`);

    // Send email invitation using Nodemailer email service
    let emailSent = false;
    try {
      const emailResponse = await sendTenantInviteEmail({
        to: tenantEmail,
        tenantName: tenantName || 'Tenant',
        ownerName: ownerName || 'Property Owner',
        ownerEmail: ownerEmail || '',
        propertyAddress,
        unit: unit || '',
        inviteLink,
        expiresAt
      });
      
      if (!emailResponse.ok) {
        console.warn('[Tenants] Email failed, but invite created:', emailResponse.error);
        if (emailResponse.skipped) {
          console.log('[Tenants] ℹ️  Email skipped - configure HOUSEYIELD_EMAIL_ADDRESS and complete Gmail OAuth at /auth/gmail');
        }
      } else {
        emailSent = true;
        console.log(`[Tenants] ✅ Email sent successfully to ${tenantEmail}`);
      }
    } catch (emailError) {
      console.warn('[Tenants] Email send failed:', emailError.message);
    }

    console.log(`[Tenants] Generated invite for ${tenantEmail} at ${propertyAddress}, expires in 48 hours`);

    res.json({
      ok: true,
      inviteToken: token,
      inviteLink,
      expiresAt: new Date(expiresAt).toISOString(),
      emailSent
    });
  } catch (error) {
    console.error('[Tenants] Error generating invite:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Validate tenant invite token
app.get('/api/tenants/invite/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      return res.status(400).json({
        ok: false,
        error: 'Invite token required'
      });
    }

    // Try Firestore first, then fall back to in-memory
    let invite = null;
    
    if (getTenantInvite) {
      const firestoreResult = await getTenantInvite(token);
      if (firestoreResult.ok) {
        invite = firestoreResult.invite;
        console.log('[Tenants] ✅ Found invite in Firestore');
      }
    }
    
    // Fall back to in-memory if not found in Firestore
    if (!invite) {
      invite = tenantInviteTokens.get(token);
    }

    if (!invite) {
      return res.status(404).json({
        ok: false,
        error: 'Invalid invite link'
      });
    }

    if (invite.used) {
      return res.status(400).json({
        ok: false,
        error: 'This invite has already been used'
      });
    }

    const expiresAtMs = typeof invite.expiresAt === 'string' 
      ? new Date(invite.expiresAt).getTime() 
      : invite.expiresAt;
      
    if (Date.now() > expiresAtMs) {
      tenantInviteTokens.delete(token);
      return res.status(400).json({
        ok: false,
        error: 'This invite link has expired'
      });
    }

    res.json({
      ok: true,
      invite: {
        propertyId: invite.propertyId,
        propertyAddress: invite.propertyAddress,
        unit: invite.unit,
        landlordName: invite.ownerName,
        ownerId: invite.ownerId,
        tenantEmail: invite.tenantEmail,
        tenantName: invite.tenantName,
        leaseStart: invite.leaseStart,
        leaseEnd: invite.leaseEnd,
        monthlyRent: invite.monthlyRent
      }
    });
  } catch (error) {
    console.error('[Tenants] Error validating invite:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Complete tenant registration with invite token
app.post('/api/tenants/register', async (req, res) => {
  try {
    const { token, firebaseUid, tenantEmail, tenantName, phone, photoURL } = req.body;
    
    if (!token) {
      return res.status(400).json({
        ok: false,
        error: 'Invite token required'
      });
    }

    // Try Firestore-based registration first
    if (consumeInviteAndCreateTenant) {
      const result = await consumeInviteAndCreateTenant(token, {
        firebaseUid,
        email: tenantEmail,
        name: tenantName,
        phone,
        photoURL // Include Google profile photo or custom photo
      });
      
      if (result.ok) {
        console.log(`[Tenants] ✅ Tenant ${result.tenantId} registered via Firestore`);
        
        // Link tenant to property in Firestore
        if (linkTenantToProperty && result.tenant.propertyId) {
          try {
            await linkTenantToProperty(result.tenant.propertyId, result.tenantId);
            console.log(`[Tenants] ✅ Tenant ${result.tenantId} linked to property ${result.tenant.propertyId}`);
          } catch (linkError) {
            console.warn(`[Tenants] ⚠️ Failed to link tenant to property:`, linkError.message);
            // Don't fail the registration if linking fails - tenant still registered
          }
        }
        
        // Also mark in-memory as used (if exists)
        const memInvite = tenantInviteTokens.get(token);
        if (memInvite) {
          memInvite.used = true;
        }
        
        return res.json({
          ok: true,
          tenantId: result.tenantId,
          tenantData: {
            landlordAccountId: result.tenant.ownerId,
            propertyId: result.tenant.propertyId,
            propertyAddress: result.tenant.propertyAddress,
            unit: result.tenant.unit,
            leaseStart: result.tenant.leaseStart,
            leaseEnd: result.tenant.leaseEnd,
            monthlyRent: result.tenant.monthlyRent
          }
        });
      } else {
        return res.status(400).json({
          ok: false,
          error: result.error || 'Failed to register tenant'
        });
      }
    }

    // Fall back to in-memory registration
    const invite = tenantInviteTokens.get(token);

    if (!invite || invite.used || Date.now() > invite.expiresAt) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid or expired invite link'
      });
    }

    // Mark as used
    invite.used = true;
    invite.tenantId = firebaseUid || `tenant_${Date.now()}`;
    invite.registeredTenantEmail = tenantEmail;
    invite.registeredTenantName = tenantName;
    invite.registeredAt = new Date().toISOString();

    console.log(`[Tenants] Tenant ${tenantName} registered for ${invite.propertyAddress} (in-memory)`);

    res.json({
      ok: true,
      tenantId: invite.tenantId,
      tenantData: {
        landlordAccountId: invite.ownerId,
        propertyId: invite.propertyId,
        propertyAddress: invite.propertyAddress,
        unit: invite.unit,
        landlordName: invite.ownerName,
        landlordEmail: invite.ownerEmail,
        leaseStart: invite.leaseStart,
        leaseEnd: invite.leaseEnd,
        monthlyRent: invite.monthlyRent
      }
    });

    // Clean up after 7 days (keep for records)
    setTimeout(() => {
      tenantInviteTokens.delete(token);
    }, 7 * 24 * 60 * 60 * 1000);

  } catch (error) {
    console.error('[Tenants] Error completing registration:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get('/api/tenants', async (req, res) => {
  try {
    const { ownerId, propertyId } = req.query;
    
    // Use Firestore tenant service for real data
    if (getTenantsByOwner && ownerId) {
      const result = await getTenantsByOwner(ownerId, propertyId || null);
      if (result.ok) {
        // Map tenant data to ensure consistent format with name field
        const formattedTenants = result.tenants.map(tenant => ({
          ...tenant,
          id: tenant.id,
          name: tenant.name || `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Unknown',
          email: tenant.email,
          propertyId: tenant.propertyId,
          propertyAddress: tenant.propertyAddress
        }));
        return res.json({ ok: true, tenants: formattedTenants });
      }
    }
    
    // Fallback to demo data if no Firestore or no ownerId
    const tenants = [
      {
        id: 'tenant-1',
        name: 'Griffin White',
        email: 'griffin@tenant.com',
        propertyId: 'property-1',
        propertyAddress: '123 Main St',
        unit: 'Unit 1A',
        landlordId: ownerId || 'owner-1',
        leaseStart: '2024-01-01',
        leaseEnd: '2025-01-01'
      }
    ];

    res.json({
      ok: true,
      tenants
    });
  } catch (error) {
    console.error('[Tenants] Error fetching tenants:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Get a single tenant by ID (Firebase UID)
app.get('/api/tenants/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    
    console.log(`[Tenants] GET /api/tenants/${tenantId}`);
    
    if (getTenantByFirebaseUid) {
      const result = await getTenantByFirebaseUid(tenantId);
      console.log(`[Tenants] getTenantByFirebaseUid result:`, result);
      
      if (result.ok && result.tenant) {
        const tenantData = {
          ...result.tenant,
          name: result.tenant.name || `${result.tenant.firstName || ''} ${result.tenant.lastName || ''}`.trim() || 'Unknown'
        };
        console.log(`[Tenants] Returning tenant with photoURL:`, tenantData.photoURL);
        return res.json({
          ok: true,
          tenant: tenantData
        });
      }
    }
    
    console.log(`[Tenants] ❌ Tenant not found: ${tenantId}`);
    res.status(404).json({ ok: false, error: 'Tenant not found' });
  } catch (error) {
    console.error('[Tenants] ❌ Error fetching tenant:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Update tenant profile photo
app.put('/api/tenants/:tenantId/photo', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { photoURL } = req.body;
    
    console.log(`[Tenants] PUT /api/tenants/${tenantId}/photo - Received photoURL:`, photoURL);
    
    if (typeof photoURL !== 'string') {
      console.log('[Tenants] ❌ Invalid photoURL type:', typeof photoURL);
      return res.status(400).json({ ok: false, error: 'photoURL is required' });
    }
    
    // Update tenant document in Firestore
    const admin = await import('./firebase-admin.js');
    const db = admin.getFirestore();
    
    // Find tenant by Firebase UID
    console.log(`[Tenants] Searching for tenant with firebaseUid: ${tenantId}`);
    const tenantsSnapshot = await db.collection('tenants')
      .where('firebaseUid', '==', tenantId)
      .limit(1)
      .get();
    
    if (tenantsSnapshot.empty) {
      console.log(`[Tenants] ❌ Tenant not found with firebaseUid: ${tenantId}`);
      return res.status(404).json({ ok: false, error: 'Tenant not found' });
    }
    
    const tenantDoc = tenantsSnapshot.docs[0];
    console.log(`[Tenants] Found tenant document ID: ${tenantDoc.id}`);
    
    await tenantDoc.ref.update({
      photoURL,
      updatedAt: new Date()
    });
    
    console.log(`[Tenants] ✅ Updated photo for tenant ${tenantId} (doc: ${tenantDoc.id})`);
    
    res.json({ ok: true, message: 'Photo updated successfully', tenantDocId: tenantDoc.id });
  } catch (error) {
    console.error('[Tenants] ❌ Error updating photo:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Update tenant unit number
app.patch('/api/tenants/:tenantId/unit', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { unit } = req.body;
    
    console.log(`[Tenants] PATCH /api/tenants/${tenantId}/unit - Updating to: "${unit}"`);
    
    if (typeof unit !== 'string') {
      return res.status(400).json({ ok: false, error: 'unit is required as a string' });
    }
    
    if (updateTenantUnit) {
      const result = await updateTenantUnit(tenantId, unit);
      if (result.ok) {
        return res.json({ ok: true, message: 'Unit updated successfully' });
      }
      return res.status(400).json({ ok: false, error: result.error });
    }
    
    res.status(503).json({ ok: false, error: 'Tenant service not available' });
  } catch (error) {
    console.error('[Tenants] ❌ Error updating unit:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// TENANT INTERVIEW API (AI Phone Screening)
// ============================================================================

// Get interview system status
app.get('/api/interviews/status', (req, res) => {
  if (!tenantInterviewModule) {
    return res.json({
      configured: false,
      error: 'Interview module not loaded'
    });
  }
  
  const status = tenantInterviewModule.getInterviewSystemStatus();
  res.json(status);
});

// Schedule a new interview
app.post('/api/interviews/schedule', async (req, res) => {
  try {
    if (!tenantInterviewModule) {
      return res.status(503).json({ ok: false, error: 'Interview system not available' });
    }
    
    const { 
      applicantId, applicantName, applicantEmail, applicantPhone,
      propertyAddress, ownerId, ownerName, monthlyRent, scheduledTime 
    } = req.body;
    
    if (!applicantName || !applicantEmail || !applicantPhone || !propertyAddress || !ownerId) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: applicantName, applicantEmail, applicantPhone, propertyAddress, ownerId'
      });
    }
    
    // Schedule the interview
    const result = await tenantInterviewModule.scheduleInterview({
      applicantId: applicantId || `applicant_${Date.now()}`,
      applicantName,
      applicantEmail,
      applicantPhone,
      propertyAddress,
      ownerId,
      monthlyRent,
      scheduledTime
    });
    
    if (!result.ok) {
      return res.status(500).json(result);
    }
    
    // Send scheduling email to applicant
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const bookingLink = `${frontendUrl}/interview/book?token=${result.bookingToken}`;
    const expiresAt = Date.now() + (48 * 60 * 60 * 1000); // 48 hours
    
    let emailSent = false;
    try {
      const emailResult = await sendInterviewSchedulingEmail({
        to: applicantEmail,
        applicantName,
        propertyAddress,
        ownerName: ownerName || 'Property Manager',
        bookingLink,
        expiresAt
      });
      
      if (emailResult.ok) {
        emailSent = true;
        console.log(`[Interview] ✅ Scheduling email sent to ${applicantEmail}`);
      } else {
        console.warn(`[Interview] ⚠️ Email failed:`, emailResult.error);
      }
    } catch (emailError) {
      console.warn(`[Interview] ⚠️ Email error:`, emailError.message);
    }
    
    res.json({
      ok: true,
      interviewId: result.interviewId,
      bookingLink,
      emailSent,
      interview: result.interview
    });
  } catch (error) {
    console.error('[Interview] Error scheduling:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get available time slots for booking
app.get('/api/interviews/slots', (req, res) => {
  if (!tenantInterviewModule) {
    return res.status(503).json({ ok: false, error: 'Interview system not available' });
  }
  
  const { startDate, days } = req.query;
  const slots = tenantInterviewModule.getAvailableSlots(
    startDate ? new Date(startDate) : new Date(),
    parseInt(days) || 7
  );
  
  res.json({ ok: true, slots });
});

// Get interview by booking token (for booking page)
app.get('/api/interviews/booking/:token', (req, res) => {
  if (!tenantInterviewModule) {
    return res.status(503).json({ ok: false, error: 'Interview system not available' });
  }
  
  const { token } = req.params;
  const interview = tenantInterviewModule.getInterviewByToken(token);
  
  if (!interview) {
    return res.status(404).json({ ok: false, error: 'Invalid booking token' });
  }
  
  if (interview.status !== 'pending_booking') {
    return res.status(400).json({ ok: false, error: 'Interview already scheduled' });
  }
  
  res.json({
    ok: true,
    interview: {
      applicantName: interview.applicantName,
      propertyAddress: interview.propertyAddress,
      status: interview.status
    }
  });
});

// Book an interview time slot
app.post('/api/interviews/book', async (req, res) => {
  try {
    if (!tenantInterviewModule) {
      return res.status(503).json({ ok: false, error: 'Interview system not available' });
    }
    
    const { bookingToken, selectedTime } = req.body;
    
    if (!bookingToken || !selectedTime) {
      return res.status(400).json({ ok: false, error: 'bookingToken and selectedTime required' });
    }
    
    const result = await tenantInterviewModule.bookInterviewSlot(bookingToken, selectedTime);
    
    if (!result.ok) {
      return res.status(400).json(result);
    }
    
    // Send confirmation email
    const interview = tenantInterviewModule.getInterviewByToken(bookingToken);
    if (interview) {
      try {
        await sendInterviewConfirmationEmail({
          to: interview.applicantEmail,
          applicantName: interview.applicantName,
          propertyAddress: interview.propertyAddress,
          scheduledTime: interview.scheduledTime,
          applicantPhone: interview.applicantPhone
        });
        console.log(`[Interview] ✅ Confirmation email sent to ${interview.applicantEmail}`);
      } catch (emailError) {
        console.warn(`[Interview] ⚠️ Confirmation email failed:`, emailError.message);
      }
    }
    
    res.json(result);
  } catch (error) {
    console.error('[Interview] Error booking:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Book and start an interview immediately for applicants already in the flow
app.post('/api/interviews/book-now', async (req, res) => {
  try {
    if (!tenantInterviewModule) {
      return res.status(503).json({ ok: false, error: 'Interview system not available' });
    }

    const { bookingToken } = req.body || {};
    if (!bookingToken) {
      return res.status(400).json({ ok: false, error: 'bookingToken required' });
    }

    const publicUrl = process.env.PUBLIC_URL || (() => {
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}`;
    })();

    const result = await tenantInterviewModule.bookInterviewNow(bookingToken, publicUrl);
    if (!result.ok) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('[Interview] Error booking immediate interview:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get all interviews for an owner
app.get('/api/interviews', async (req, res) => {
  if (!tenantInterviewModule) {
    return res.status(503).json({ ok: false, error: 'Interview system not available' });
  }
  
  const { ownerId } = req.query;
  
  if (!ownerId) {
    return res.status(400).json({ ok: false, error: 'ownerId required' });
  }
  
  const scheduled = await tenantInterviewModule.getScheduledInterviews(ownerId);
  const completed = await tenantInterviewModule.getCompletedInterviews(ownerId);
  
  res.json({
    ok: true,
    interviews: [...scheduled, ...completed]
  });
});

// Get all interviews for a property
app.get('/api/interviews/property/:propertyAddress', async (req, res) => {
  if (!tenantInterviewModule) {
    return res.status(503).json({ ok: false, error: 'Interview system not available' });
  }
  
  const { propertyAddress } = req.params;
  const interviews = await tenantInterviewModule.getPropertyInterviews(decodeURIComponent(propertyAddress));
  
  res.json({ ok: true, interviews });
});

// Get a specific interview
app.get('/api/interviews/:interviewId', async (req, res) => {
  if (!tenantInterviewModule) {
    return res.status(503).json({ ok: false, error: 'Interview system not available' });
  }
  
  const { interviewId } = req.params;
  const interview = await tenantInterviewModule.getInterview(interviewId);
  
  if (!interview) {
    return res.status(404).json({ ok: false, error: 'Interview not found' });
  }
  
  res.json({ ok: true, interview });
});

// Manually initiate an interview call
app.post('/api/interviews/:interviewId/call', async (req, res) => {
  try {
    if (!tenantInterviewModule) {
      return res.status(503).json({ ok: false, error: 'Interview system not available' });
    }
    
    const { interviewId } = req.params;
    
    // Construct publicUrl from request headers (for ngrok/tunnel support)
    const publicUrl = process.env.PUBLIC_URL || (() => {
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}`;
    })();
    
    console.log('[Interview] Making call with publicUrl:', publicUrl);
    
    const result = await tenantInterviewModule.initiateInterviewCall(interviewId, publicUrl);
    
    res.json(result);
  } catch (error) {
    console.error('[Interview] Error initiating call:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Cancel an interview
app.delete('/api/interviews/:interviewId', async (req, res) => {
  if (!tenantInterviewModule) {
    return res.status(503).json({ ok: false, error: 'Interview system not available' });
  }
  
  const { interviewId } = req.params;
  const result = await tenantInterviewModule.cancelInterview(interviewId);
  
  res.json(result);
});

// TwiML endpoint for interview calls
app.post('/twiml/tenant-interview', (req, res) => {
  if (!tenantInterviewModule) {
    return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response><Say>Interview system not available.</Say><Hangup /></Response>`);
  }
  
  const { interviewId } = req.query;
  const publicUrl = process.env.PUBLIC_URL || process.env.NGROK_URL || `http://localhost:${PORT}`;
  
  const twiml = tenantInterviewModule.generateInterviewTwiML(interviewId, publicUrl);
  res.type('text/xml').send(twiml);
});

// Interview call status callback
app.post('/twilio/interview-status', (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(`[Interview] Call ${CallSid} status: ${CallStatus}, duration: ${CallDuration}s`);
  res.sendStatus(200);
});

// ============================================
// ZILLOW MLS PROPERTY DATA API (was Snowflake)
// ============================================
let snowflakeService = null;
(async () => {
  try {
    snowflakeService = await import('./zillowApi.js');
    console.log('✅ [Zillow] MLS property data integration loaded');
  } catch (error) {
    console.warn('⚠️  [Zillow] MLS integration not available:', error.message);
  }
})();

// ============================================
// FIRESTORE PROPERTY MANAGEMENT ENDPOINTS
// ============================================

// Save a property to Firestore
app.post('/api/owner-properties', async (req, res) => {
  try {
    if (!savePropertyToFirestore) {
      return res.status(503).json({ ok: false, error: 'Property service not available' });
    }
    
    const { ownerId, address, propertyData, financials, tenantId, image } = req.body;
    
    if (!ownerId || !address) {
      return res.status(400).json({ ok: false, error: 'ownerId and address are required' });
    }
    
    const result = await savePropertyToFirestore({
      ownerId,
      address,
      propertyData,
      financials,
      tenantId,
      image
    });
    
    // Also populate the ATTOM Firestore cache when a user saves a property
    // that includes ATTOM dashboard data — avoids re-fetching on next load
    if (propertyData && address) {
      cacheAttomData(address, propertyData).catch(err =>
        console.warn('[Properties] ATTOM cache write on save failed:', err.message)
      );
    }
    
    res.json(result);
  } catch (error) {
    console.error('[Properties] Error saving property:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get all properties for an owner from Firestore
app.get('/api/owner-properties', async (req, res) => {
  try {
    if (!getOwnerProperties) {
      return res.status(503).json({ ok: false, error: 'Property service not available' });
    }
    
    const { ownerId, withTenants } = req.query;
    
    if (!ownerId) {
      return res.status(400).json({ ok: false, error: 'ownerId is required' });
    }
    
    let result;
    if (withTenants === 'true' && getPropertiesWithTenants) {
      result = await getPropertiesWithTenants(ownerId);
    } else {
      result = await getOwnerProperties(ownerId);
    }

    if (result?.ok && Array.isArray(result.properties)) {
      result = {
        ...result,
        properties: await hydratePropertiesFromAttomCache(result.properties),
      };
    }
    
    res.json(result);
  } catch (error) {
    console.error('[Properties] Error getting properties:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get a single property by ID
app.get('/api/owner-properties/:propertyId', async (req, res) => {
  try {
    if (!getPropertyById) {
      return res.status(503).json({ ok: false, error: 'Property service not available' });
    }
    
    const { propertyId } = req.params;
    let result = await getPropertyById(propertyId);
    
    if (!result.ok) {
      return res.status(404).json(result);
    }

    if (result.property) {
      result = {
        ...result,
        property: await hydratePropertyFromAttomCache(result.property),
      };
    }
    
    res.json(result);
  } catch (error) {
    console.error('[Properties] Error getting property:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Link a tenant to a property
app.post('/api/owner-properties/:propertyId/tenant', async (req, res) => {
  try {
    if (!linkTenantToProperty) {
      return res.status(503).json({ ok: false, error: 'Property service not available' });
    }
    
    const { propertyId } = req.params;
    const { tenantId } = req.body;
    
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenantId is required' });
    }
    
    const result = await linkTenantToProperty(propertyId, tenantId);
    res.json(result);
  } catch (error) {
    console.error('[Properties] Error linking tenant:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Clear tenant from a property (supports clearing specific tenant for multifamily)
app.delete('/api/owner-properties/:propertyId/tenant', async (req, res) => {
  try {
    if (!clearTenantFromProperty) {
      return res.status(503).json({ ok: false, error: 'Property service not available' });
    }
    
    const { propertyId } = req.params;
    const { tenantId } = req.query; // Optional: specific tenant to remove
    
    const result = await clearTenantFromProperty(propertyId, tenantId || null);
    res.json(result);
  } catch (error) {
    console.error('[Properties] Error clearing tenant:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Replace property health / component inventory for a property
app.put('/api/owner-properties/:propertyId/health-assets', async (req, res) => {
  try {
    if (!updatePropertyHealthAssets) {
      return res.status(503).json({ ok: false, error: 'Property service not available' });
    }

    const { propertyId } = req.params;
    const ownerId = req.body?.ownerId || req.query?.ownerId;
    const healthAssets = req.body?.healthAssets;

    if (!ownerId) {
      return res.status(400).json({ ok: false, error: 'ownerId is required' });
    }

    if (!Array.isArray(healthAssets)) {
      return res.status(400).json({ ok: false, error: 'healthAssets must be an array' });
    }

    const result = await updatePropertyHealthAssets(propertyId, ownerId, healthAssets);
    if (!result.ok) {
      const status = result.error === 'Property not found'
        ? 404
        : result.error === 'Not authorized to update this property'
          ? 403
          : 400;
      return res.status(status).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('[Properties] Error updating health assets:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/*
 * Read a maintenance receipt or home record into property-health proposals.
 *
 * Returns proposals only. Applying them to the inventory is a separate,
 * owner-reviewed write through the health-assets endpoint above, because a
 * document naming a component may be describing a repair rather than a
 * replacement and dating the component from it would corrupt every age and
 * forecast figure derived from it.
 *
 * The file is expected to already be in Storage: the client uploads with
 * `uploadPropertyDocument` and sends the resulting path, matching how
 * /api/documents/save-metadata works.
 */
app.post('/api/property-health/ingest-document', async (req, res) => {
  try {
    const {
      ownerId,
      propertyId,
      storagePath,
      fileUrl,
      fileName,
      mimeType,
      documentId,
      fileData
    } = req.body || {};

    if (!ownerId || !propertyId) {
      return res.status(400).json({ ok: false, error: 'ownerId and propertyId are required' });
    }

    if (!storagePath && !fileUrl && !fileData) {
      return res.status(400).json({
        ok: false,
        error: 'One of storagePath, fileUrl or fileData is required'
      });
    }

    const { ingestHealthDocument } = await import('./services/propertyHealthDocumentIngest.js');

    const buffer = fileData
      ? Buffer.from(String(fileData).replace(/^data:[^;]+;base64,/, ''), 'base64')
      : null;

    const result = await ingestHealthDocument({
      buffer,
      storagePath,
      fileUrl,
      fileName,
      mimeType,
      documentId,
      title: fileName
    });

    if (!result.ok) {
      // A document we cannot read is a handled outcome, not a server fault: the
      // upload is already stored and the owner can still file it by hand.
      return res.status(200).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('[PropertyHealth] Document ingest failed:', error);
    res.status(500).json({ ok: false, error: error.message, proposals: [] });
  }
});

/*
 * Look up reliability research for an identified component.
 *
 * The service caches globally by category/make/model. Property-specific data is
 * deliberately not stored there: install date, repairs, exposure, and owner notes
 * remain on the property health asset, while recalls and model failure patterns
 * are reusable across every property with the same unit.
 */
app.post('/api/property-health/component-model', async (req, res) => {
  try {
    const { category, make, model, force } = req.body || {};
    if (!make || !model) {
      return res.status(400).json({
        ok: false,
        status: 'missing_identity',
        error: 'make and model are required',
        profile: null
      });
    }

    const { getOrResearchComponentModel } = await import('./services/componentModelRegistry.js');
    const result = await getOrResearchComponentModel({
      category,
      make,
      model,
      force: force === true
    });

    // Search/model configuration failures are handled outcomes. The client can
    // continue with category-level useful life and try research again later.
    res.json(result);
  } catch (error) {
    console.error('[PropertyHealth] Component model research failed:', error);
    res.status(500).json({
      ok: false,
      status: 'failed',
      error: error.message,
      profile: null
    });
  }
});

/*
 * Read a component photo into owner-reviewable identity and condition evidence.
 *
 * Like document ingestion, this does not write the inventory directly. A photo can
 * identify a data plate and show visible wear, but it cannot prove installation
 * date or hidden failure; the owner reviews the analysis before stronger photo
 * evidence replaces an inferred field.
 */
app.post('/api/property-health/analyze-photo', async (req, res) => {
  try {
    const {
      ownerId,
      propertyId,
      storagePath,
      fileUrl,
      fileData,
      category,
      name,
      make,
      model,
      sourceKind
    } = req.body || {};

    if (!ownerId || !propertyId) {
      return res.status(400).json({ ok: false, error: 'ownerId and propertyId are required' });
    }
    if (!storagePath && !fileUrl && !fileData) {
      return res.status(400).json({
        ok: false,
        error: 'One of storagePath, fileUrl or fileData is required'
      });
    }

    const { analyzePropertyHealthPhoto } = await import('./services/propertyHealthPhotoAnalysis.js');
    const buffer = fileData
      ? Buffer.from(String(fileData).replace(/^data:[^;]+;base64,/, ''), 'base64')
      : null;
    const result = await analyzePropertyHealthPhoto({
      buffer,
      storagePath,
      fileUrl,
      category,
      name,
      make,
      model,
      sourceKind
    });
    res.json(result);
  } catch (error) {
    console.error('[PropertyHealth] Photo analysis failed:', error);
    res.status(500).json({
      ok: false,
      status: 'failed',
      error: error.message,
      analysis: null
    });
  }
});

// Delete a property
app.delete('/api/owner-properties/:propertyId', async (req, res) => {
  try {
    if (!deletePropertyFromFirestore) {
      return res.status(503).json({ ok: false, error: 'Property service not available' });
    }
    
    const { propertyId } = req.params;
    const { ownerId } = req.query;
    
    if (!ownerId) {
      return res.status(400).json({ ok: false, error: 'ownerId is required' });
    }
    
    const result = await deletePropertyFromFirestore(propertyId, ownerId);
    
    if (!result.ok) {
      return res.status(404).json(result);
    }
    
    res.json(result);
  } catch (error) {
    console.error('[Properties] Error deleting property:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get available markets/cities (dynamically from Snowflake)
app.get('/api/mls/markets', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const minListings = parseInt(req.query.minListings) || 5;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    
    const marketsData = await snowflakeService.getAvailableMarkets({ minListings, limit });
    const markets = marketsData.map(m => ({
      city: m.CITY,
      state: m.STATEORPROVINCE,
      zip: m.POSTALCODE,
      listingCount: m.LISTING_COUNT,
      activeCount: m.ACTIVE_COUNT
    }));
    res.json({ ok: true, markets });
  } catch (error) {
    console.error('[MLS] Error fetching markets:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get available states
app.get('/api/mls/states', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const states = await snowflakeService.getAvailableStates();
    res.json({ ok: true, states: states.map(s => ({ state: s.STATEORPROVINCE, count: s.CNT })) });
  } catch (error) {
    console.error('[MLS] Error fetching states:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get property subtypes
app.get('/api/mls/subtypes', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { propertyType } = req.query;
    const subtypes = await snowflakeService.getPropertySubtypes(propertyType || null);
    res.json({ ok: true, subtypes: subtypes.map(s => ({ subtype: s.PROPERTYSUBTYPE, count: s.CNT })) });
  } catch (error) {
    console.error('[MLS] Error fetching subtypes:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Search MLS properties (expanded MultiClass filters)
app.get('/api/mls/search', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { city, state, zip, minPrice, maxPrice, minBeds, maxBeds, minBaths, maxBaths, 
            propertyType, propertySubtype, status, minSqft, maxSqft, 
            minYearBuilt, maxYearBuilt, minLotSize, maxLotSize,
            limit = 50, offset = 0 } = req.query;
    
    const properties = await snowflakeService.searchMLSPropertiesWithImages({
      city: city || null,
      state: state || null,
      zip: zip || null,
      minPrice: minPrice ? parseInt(minPrice) : null,
      maxPrice: maxPrice ? parseInt(maxPrice) : null,
      minBeds: minBeds ? parseInt(minBeds) : null,
      maxBeds: maxBeds ? parseInt(maxBeds) : null,
      minBaths: minBaths ? parseInt(minBaths) : null,
      maxBaths: maxBaths ? parseInt(maxBaths) : null,
      propertyType: propertyType || null,
      propertySubtype: propertySubtype || null,
      status: status || null,
      minSqft: minSqft ? parseInt(minSqft) : null,
      maxSqft: maxSqft ? parseInt(maxSqft) : null,
      minYearBuilt: minYearBuilt ? parseInt(minYearBuilt) : null,
      maxYearBuilt: maxYearBuilt ? parseInt(maxYearBuilt) : null,
      minLotSize: minLotSize ? parseInt(minLotSize) : null,
      maxLotSize: maxLotSize ? parseInt(maxLotSize) : null,
      limit: Math.min(parseInt(limit) || 50, 100),
      offset: parseInt(offset) || 0
    });
    
    res.json({ ok: true, properties, count: properties.length });
  } catch (error) {
    console.error('[MLS] Search error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get single property with all images
app.get('/api/mls/property/:listingKey', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { listingKey } = req.params;
    const property = await snowflakeService.getMLSPropertyWithImages(listingKey);
    
    if (!property) {
      return res.status(404).json({ ok: false, error: 'Property not found' });
    }
    
    res.json({ ok: true, property });
  } catch (error) {
    console.error('[MLS] Property fetch error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get property media/photos
app.get('/api/mls/property/:listingKey/media', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { listingKey } = req.params;
    const media = await snowflakeService.getPropertyMedia(listingKey);
    res.json({ ok: true, media });
  } catch (error) {
    console.error('[MLS] Media fetch error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get property open houses
app.get('/api/mls/property/:listingKey/openhouses', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { listingKey } = req.params;
    const openHouses = await snowflakeService.getPropertyOpenHouses(listingKey);
    res.json({ ok: true, openHouses });
  } catch (error) {
    console.error('[MLS] Open houses fetch error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get property rooms
app.get('/api/mls/property/:listingKey/rooms', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { listingKey } = req.params;
    const rooms = await snowflakeService.getPropertyRooms(listingKey);
    res.json({ ok: true, rooms });
  } catch (error) {
    console.error('[MLS] Rooms fetch error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get full property detail with all MultiClass data (images, rooms, open houses, unit types, history)
app.get('/api/mls/property/:listingKey/full', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { listingKey } = req.params;
    const property = await snowflakeService.getMLSPropertyFullDetail(listingKey);
    if (!property) {
      return res.status(404).json({ ok: false, error: 'Property not found' });
    }
    res.json({ ok: true, property });
  } catch (error) {
    console.error('[MLS] Full detail fetch error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get property unit types (multi-family)
app.get('/api/mls/property/:listingKey/units', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { listingKey } = req.params;
    const unitTypes = await snowflakeService.getPropertyUnitTypes(listingKey);
    res.json({ ok: true, unitTypes });
  } catch (error) {
    console.error('[MLS] Unit types fetch error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get property price/listing history
app.get('/api/mls/property/:listingKey/history', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { listingKey } = req.params;
    const history = await snowflakeService.getPropertyBusinessHistory(listingKey);
    res.json({ ok: true, history });
  } catch (error) {
    console.error('[MLS] History fetch error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== HISTORICAL LISTING DATA ====================

// GET /api/mls/history/address - All listings at the same address over time
app.get('/api/mls/history/address', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { streetNumber, streetName, city, state, postalCode, parcelnumber } = req.query;
    if (!streetName && !parcelnumber) {
      return res.status(400).json({ ok: false, error: 'streetName or parcelnumber is required' });
    }
    const listings = await snowflakeService.getAddressListingHistory({
      streetNumber: streetNumber || null,
      streetName: streetName || null,
      city: city || null,
      state: state || null,
      postalCode: postalCode || null,
      parcelnumber: parcelnumber || null
    });
    res.json({ ok: true, listings, count: listings.length });
  } catch (error) {
    console.error('[MLS History] Address history error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/mls/history/search - Search historical listings with date filters
app.get('/api/mls/history/search', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
        const { city, state, zip, minPrice, maxPrice, minBeds, minBaths,
          propertyType, status, onMarketAfter, onMarketBefore,
          closedAfter, closedBefore, minPriceChange, multiListingOnly,
          relistedOnly, minRelistGapDays,
          limit = 50, offset = 0 } = req.query;

    const results = await snowflakeService.searchHistoricalListings({
      city: city || null,
      state: state || null,
      zip: zip || null,
      minPrice: minPrice ? parseInt(minPrice) : null,
      maxPrice: maxPrice ? parseInt(maxPrice) : null,
      minBeds: minBeds ? parseInt(minBeds) : null,
      minBaths: minBaths ? parseInt(minBaths) : null,
      propertyType: propertyType || null,
      status: status || null,
      onMarketAfter: onMarketAfter || null,
      onMarketBefore: onMarketBefore || null,
      closedAfter: closedAfter || null,
      closedBefore: closedBefore || null,
      minPriceChange: minPriceChange ? parseFloat(minPriceChange) : null,
      multiListingOnly: multiListingOnly === 'true' || multiListingOnly === '1',
      relistedOnly: relistedOnly === 'true' || relistedOnly === '1',
      minRelistGapDays: minRelistGapDays ? parseInt(minRelistGapDays) : null,
      limit: Math.min(parseInt(limit) || 50, 200),
      offset: parseInt(offset) || 0
    });

    res.json({ ok: true, properties: results, count: results.length });
  } catch (error) {
    console.error('[MLS History] Search error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/mls/history/timeline/:listingKey - Price timeline for a single listing
app.get('/api/mls/history/timeline/:listingKey', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { listingKey } = req.params;
    const timeline = await snowflakeService.getPropertyPriceTimeline(listingKey);
    res.json({ ok: true, timeline, count: timeline.length });
  } catch (error) {
    console.error('[MLS History] Timeline error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/mls/history/address-timeline - Merged price timeline across all listings at an address
app.get('/api/mls/history/address-timeline', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { streetNumber, streetName, city, state, parcelnumber } = req.query;
    if (!streetName && !parcelnumber) {
      return res.status(400).json({ ok: false, error: 'streetName or parcelnumber is required' });
    }
    const timeline = await snowflakeService.getAddressPriceTimeline({
      streetNumber: streetNumber || null,
      streetName: streetName || null,
      city: city || null,
      state: state || null,
      parcelnumber: parcelnumber || null
    });
    res.json({ ok: true, timeline, count: timeline.length });
  } catch (error) {
    console.error('[MLS History] Address timeline error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/mls/history/market-appreciation - Area-level year-over-year price stats
app.get('/api/mls/history/market-appreciation', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    const { city, state, zip, propertyType } = req.query;
    if (!city && !zip) {
      return res.status(400).json({ ok: false, error: 'city or zip is required' });
    }
    const stats = await snowflakeService.getMarketAppreciation({
      city: city || null,
      state: state || null,
      zip: zip || null,
      propertyType: propertyType || null
    });
    res.json({ ok: true, stats, count: stats.length });
  } catch (error) {
    console.error('[MLS History] Market appreciation error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/mls/history/images - Images for multiple listings (before/after comparison)
app.get('/api/mls/history/images', async (req, res) => {
  try {
    if (!snowflakeService) {
      return res.status(503).json({ ok: false, error: 'Snowflake service not available' });
    }
    let { listingKeys } = req.query;
    if (!listingKeys) {
      return res.status(400).json({ ok: false, error: 'listingKeys query parameter is required (comma-separated)' });
    }
    // Accept comma-separated or array
    const keys = Array.isArray(listingKeys) ? listingKeys : listingKeys.split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) {
      return res.status(400).json({ ok: false, error: 'At least one listingKey is required' });
    }
    if (keys.length > 20) {
      return res.status(400).json({ ok: false, error: 'Maximum 20 listing keys per request' });
    }
    const images = await snowflakeService.getHistoricalListingImages(keys);
    res.json({ ok: true, images, listingCount: Object.keys(images).length });
  } catch (error) {
    console.error('[MLS History] Images error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== FRONTEND ROUTE FALLBACK ====================
// Handle frontend routes when accessed via backend (e.g., via ngrok tunnel)
// This returns HTML that redirects or shows the proper frontend link
const FRONTEND_ROUTES = ['/login', '/portfolio', '/documents', '/dashboard', '/settings', '/property', '/tenant', '/bookkeeping', '/payment'];

app.get('*', (req, res, next) => {
  // Check if this is a frontend route
  const isFrontendRoute = FRONTEND_ROUTES.some(route => req.path.startsWith(route));
  
  if (isFrontendRoute) {
    // Get the frontend URL
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const fullFrontendUrl = `${frontendUrl}${req.originalUrl}`;
    
    console.log(`[Router] Frontend route detected: ${req.originalUrl}`);
    console.log(`[Router] Redirect to: ${fullFrontendUrl}`);
    
    // Return HTML with auto-redirect and manual link
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta http-equiv="refresh" content="0;url=${fullFrontendUrl}">
          <title>Redirecting...</title>
          <style>
            body { font-family: -apple-system, system-ui, sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; }
            .container { text-align: center; }
            h1 { color: #2563eb; }
            a { color: #2563eb; font-size: 18px; }
            .note { color: #6b7280; margin-top: 20px; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🏠 Redirecting to HouseYield...</h1>
            <p>If you're not redirected automatically, <a href="${fullFrontendUrl}">click here</a></p>
            <p class="note">Frontend URL: ${fullFrontendUrl}</p>
          </div>
        </body>
      </html>
    `);
  }
  
  // Not a frontend route, let it fall through to 404
  next();
});

// 404 handler for API routes
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not found',
    path: req.path,
    hint: 'If you meant to access the frontend app, it runs on port 5173 (Vite dev server)'
  });
});

server.listen(PORT, () => {
  console.log(`[push-server] listening on http://localhost:${PORT}`);
  if (voiceModule) {
    console.log(`[Voice] Voice call endpoints available`);
    console.log(`[Voice] WebSocket ready at ws://localhost:${PORT}/twilio-media`);
  }
  if (groqVoiceModule) {
    console.log(`[GROQ-Voice] GROQ voice call endpoints available`);
    console.log(`[GROQ-Voice] WebSocket ready at ws://localhost:${PORT}/groq-twilio-media`);
  }
  if (phoneModule) {
    console.log(`[Phone] 📞 Phone call system ready at ws://localhost:${PORT}/phone-media`);
  }
  
  // ── ATTOM compliance: purge cached data >90 days old on startup ──
  purgeExpiredAttomCache()
    .then(count => {
      if (count > 0) console.log(`[ATTOM Cache] 🗑️  Startup purge removed ${count} expired entries`);
      else console.log('[ATTOM Cache] ✅ No expired entries to purge');
    })
    .catch(err => console.warn('[ATTOM Cache] Startup purge failed:', err.message));
  
  // Re-run purge every 24 hours to stay in compliance
  setInterval(() => {
    purgeExpiredAttomCache()
      .then(count => { if (count > 0) console.log(`[ATTOM Cache] 🗑️  Scheduled purge removed ${count} expired entries`); })
      .catch(err => console.warn('[ATTOM Cache] Scheduled purge failed:', err.message));
  }, 24 * 60 * 60 * 1000);

  // ── FRED market data: scheduled auto-refresh based on release calendars ──
  // Treasury yields and mortgage rates are released every Thursday by FRED.
  // CPI, PCE, housing starts, and other monthly indicators publish mid-month.
  // FOMC statements publish on Wednesday afternoons every ~6 weeks.
  // We use node-cron to keep Firestore cache fresh without user interaction.
  import('node-cron').then(({ default: cron }) => {
    // Treasury yields + mortgage rate: refresh every Thursday at 5 PM ET (22:00 UTC)
    cron.schedule('0 22 * * 4', async () => {
      console.log('[FRED Scheduler] 📅 Thursday — refreshing treasury yields...');
      try {
        const data = await getTreasuryYields({});
        await setCachedFredData('treasury-yields:365', data);
        console.log('[FRED Scheduler] ✅ treasury-yields refreshed');
      } catch (e) {
        console.warn('[FRED Scheduler] ⚠️ treasury-yields refresh failed:', e.message);
      }
    });

    // Housing market + macro indicators: refresh on the 2nd and 16th of each month
    // (catches NAR existing sales, housing starts, CPI, PCE, unemployment releases)
    cron.schedule('0 14 2,16 * *', async () => {
      console.log('[FRED Scheduler] 📅 Monthly mid-cycle — refreshing housing & macro data...');
      const jobs = [
        { key: 'housing-market', fn: getHousingMarketData },
        { key: 'macro-indicators', fn: getAdditionalMacroData },
        { key: 'regional-market', fn: getRegionalMarketData },
      ];
      for (const { key, fn } of jobs) {
        try {
          const data = await fn();
          await setCachedFredData(key, data);
          console.log(`[FRED Scheduler] ✅ ${key} refreshed`);
        } catch (e) {
          console.warn(`[FRED Scheduler] ⚠️ ${key} refresh failed:`, e.message);
        }
      }
    });

    // Fed meeting summary: refresh every Wednesday at 3 PM ET (20:00 UTC)
    // FOMC statements are released on Wednesdays at ~2 PM ET
    cron.schedule('0 20 * * 3', async () => {
      console.log('[FRED Scheduler] 📅 Wednesday — checking for new FOMC data...');
      try {
        const data = await getFedMeetingSummary();
        await setCachedFredData('fed-meeting', data);
        console.log('[FRED Scheduler] ✅ fed-meeting refreshed');
      } catch (e) {
        console.warn('[FRED Scheduler] ⚠️ fed-meeting refresh failed:', e.message);
      }
    });

    // Scheduler runs by default: per-user sends are still gated by each user's
    // weekly-digest "enabled" preference, so the cron itself is safe to run.
    // Set ASSISTANT_WEEKLY_DIGEST_SCHEDULER_ENABLED=false to opt out.
    const digestSchedulerDisabled = ['0', 'false', 'no', 'off'].includes(
      String(process.env.ASSISTANT_WEEKLY_DIGEST_SCHEDULER_ENABLED || process.env.ASSISTANT_WEEKLY_DIGEST_SCHEDULER_ENABLE || '')
        .trim()
        .toLowerCase(),
    );
    if (!digestSchedulerDisabled) {
      const digestSchedule = String(process.env.ASSISTANT_WEEKLY_DIGEST_SCHEDULER_CRON || '*/15 * * * *').trim() || '*/15 * * * *';
      cron.schedule(digestSchedule, async () => {
        try {
          const { runAssistantWeeklyDigestBatch } = await import('./services/assistantWeeklyDigestService.js');
          const summary = await runAssistantWeeklyDigestBatch({ reason: 'scheduler' });
          if (summary.matched > 0 || summary.sent > 0 || summary.failed > 0) {
            console.log('[WeeklyDigest Scheduler] Batch result:', JSON.stringify({
              matched: summary.matched,
              attempted: summary.attempted,
              sent: summary.sent,
              failed: summary.failed,
            }));
          }
        } catch (error) {
          console.warn('[WeeklyDigest Scheduler] Batch run failed:', error.message);
        }
      });
      console.log(`[WeeklyDigest Scheduler] ✅ Active on ${digestSchedule}`);
    }

    const scheduledTasksDisabled = ['0', 'false', 'no', 'off'].includes(
      String(process.env.ASSISTANT_SCHEDULED_TASKS_SCHEDULER_ENABLED || '')
        .trim()
        .toLowerCase(),
    );
    if (!scheduledTasksDisabled) {
      const scheduledTasksCron = String(process.env.ASSISTANT_SCHEDULED_TASKS_SCHEDULER_CRON || '*/2 * * * *').trim() || '*/2 * * * *';
      cron.schedule(scheduledTasksCron, async () => {
        try {
          const { runAssistantScheduledTaskBatch } = await import('./services/assistantScheduledTaskService.js');
          const summary = await runAssistantScheduledTaskBatch({ reason: 'scheduler' });
          if (summary.due > 0 || summary.completed > 0 || summary.failed > 0) {
            console.log('[AssistantScheduledTasks] Batch result:', JSON.stringify(summary));
          }
        } catch (error) {
          console.warn('[AssistantScheduledTasks] Batch run failed:', error.message);
        }
      });
      console.log(`[AssistantScheduledTasks] ✅ Active on ${scheduledTasksCron}`);
    }

    console.log('[FRED Scheduler] ✅ Scheduled market data refreshes active');
  }).catch(() => {
    console.warn('[FRED Scheduler] ⚠️ node-cron not available — scheduled refreshes disabled. Run: npm install node-cron');
  });
});
