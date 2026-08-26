/**
 * Photo Measurement Service — Depth Anything V3 Metric Edition
 * 
 * Extracts real-world measurements from property photos using:
 * 1. Depth Anything V3 Metric (via Replicate) — true metric depth in meters
 * 2. GPT-4o Vision for reference object detection + bounding boxes
 * 3. EXIF data for camera intrinsics (focal length)
 * 4. Reference object calibration for scale correction
 * 5. Per-pixel depth sampling for accurate room/object dimensions
 * 
 * Key advantage over old Metric3D approach:
 * - DAv3-Metric returns JSON arrays of per-pixel depth in meters
 * - Batch processing (all images in one API call)
 * - No PNG-to-depth heuristics needed — real numeric depth values
 * 
 * Accuracy targets:
 * - Room dimensions: ±5-8% (calibrated multi-photo)
 * - Object/appliance openings: ±1-2 inches with reference calibration
 * - Material quantities: derived from measured area
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Replicate from 'replicate';
import exifr from 'exifr';
import sharp from 'sharp';
import heicConvert from 'heic-convert';

import { getGcpGpuWorker } from './gcpGpuWorker.js';
import { calculateLaborItems, calculateMaterialQuantities } from './renovationMeasurementScopeCalculator.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '';
const FACEPLATE_DETECTOR_URL = process.env.FACEPLATE_DETECTOR_URL || process.env.ROBOFLOW_FACEPLATE_MODEL_URL || '';
const FACEPLATE_DETECTOR_API_KEY = process.env.FACEPLATE_DETECTOR_API_KEY || process.env.ROBOFLOW_API_KEY || '';
const FACEPLATE_DETECTOR_PROTOCOL = (process.env.FACEPLATE_DETECTOR_PROTOCOL || 'roboflow').toLowerCase();
const FACEPLATE_DETECTOR_MIN_CONFIDENCE = Number(process.env.FACEPLATE_DETECTOR_MIN_CONFIDENCE || 0.45);
const FACEPLATE_DETECTOR_TIMEOUT_MS = Number(process.env.FACEPLATE_DETECTOR_TIMEOUT_MS || 9000);
const MEASUREMENT_TARGET_DETECTOR_URL = process.env.MEASUREMENT_TARGET_DETECTOR_URL || process.env.ROBOFLOW_MEASUREMENT_TARGET_MODEL_URL || '';
const MEASUREMENT_TARGET_DETECTOR_API_KEY = process.env.MEASUREMENT_TARGET_DETECTOR_API_KEY || process.env.ROBOFLOW_MEASUREMENT_TARGET_API_KEY || process.env.ROBOFLOW_API_KEY || '';
const MEASUREMENT_TARGET_DETECTOR_PROTOCOL = (process.env.MEASUREMENT_TARGET_DETECTOR_PROTOCOL || 'json').toLowerCase();
const MEASUREMENT_TARGET_DETECTOR_MIN_CONFIDENCE = Number(process.env.MEASUREMENT_TARGET_DETECTOR_MIN_CONFIDENCE || 0.4);
const MEASUREMENT_TARGET_DETECTOR_TIMEOUT_MS = Number(process.env.MEASUREMENT_TARGET_DETECTOR_TIMEOUT_MS || 9000);
const MEASUREMENT_TARGET_SEGMENTATION_URL = process.env.MEASUREMENT_TARGET_SEGMENTATION_URL || process.env.SAM2_SEGMENTER_URL || '';
const MEASUREMENT_TARGET_SEGMENTATION_API_KEY = process.env.MEASUREMENT_TARGET_SEGMENTATION_API_KEY || process.env.SAM2_SEGMENTER_API_KEY || MEASUREMENT_TARGET_DETECTOR_API_KEY || '';
const MEASUREMENT_TARGET_SEGMENTATION_PROTOCOL = (process.env.MEASUREMENT_TARGET_SEGMENTATION_PROTOCOL || 'json').toLowerCase();
const MEASUREMENT_TARGET_SEGMENTATION_MIN_CONFIDENCE = Number(process.env.MEASUREMENT_TARGET_SEGMENTATION_MIN_CONFIDENCE || 0.35);
const MEASUREMENT_TARGET_SEGMENTATION_TIMEOUT_MS = Number(process.env.MEASUREMENT_TARGET_SEGMENTATION_TIMEOUT_MS || 12000);
const ROOM_GEOMETRY_ASSIST_URL = process.env.ROOM_GEOMETRY_ASSIST_URL || '';
const ROOM_GEOMETRY_ASSIST_API_KEY = process.env.ROOM_GEOMETRY_ASSIST_API_KEY || '';
const ROOM_GEOMETRY_ASSIST_TIMEOUT_MS = Number(process.env.ROOM_GEOMETRY_ASSIST_TIMEOUT_MS || 45000);
const ROOM_GEOMETRY_GCP_ASSIST_ENABLE = process.env.ROOM_GEOMETRY_GCP_ASSIST_ENABLE === 'true';
const ROOM_GEOMETRY_GCP_ASSIST_MIN_IMAGES = Number(process.env.ROOM_GEOMETRY_GCP_ASSIST_MIN_IMAGES || 5);
const ROOM_GEOMETRY_GCP_ASSIST_METRIC3D_MODEL = process.env.ROOM_GEOMETRY_GCP_ASSIST_METRIC3D_MODEL || 'vit-small';
const ROOM_GEOMETRY_GCP_ASSIST_VOXEL_SIZE = Number(process.env.ROOM_GEOMETRY_GCP_ASSIST_VOXEL_SIZE || 0.02);

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });
const CALIBRATION_SCALE_MIN = 0.35;
const CALIBRATION_SCALE_MAX = 2.75;
const FULL_FRAME_35MM_DIAGONAL_MM = Math.sqrt(36 ** 2 + 24 ** 2);
const EXIF_PICK_FIELDS = [
  'FocalLength', 'FocalLengthIn35mmFormat', 'ExifImageWidth', 'ExifImageHeight',
  'ImageWidth', 'ImageHeight', 'Make', 'Model', 'FocalPlaneXResolution',
  'FocalPlaneYResolution', 'SensorWidth', 'SensorHeight', 'Orientation',
];
const SPECIALIST_MEASUREMENT_TARGET_TYPES = new Set([
  'existing_vanity',
  'vanity_space',
  'existing_toilet',
  'bathroom_mirror',
  'shower_door_opening',
  'existing_bathtub',
  'door',
  'window',
]);
const LARGE_OPEN_ROOM_TYPES = new Set(['home_gym', 'basement', 'rec_room', 'family_room', 'media_room', 'bonus_room']);
const ROOM_GEOMETRY_ASSIST_ROOM_TYPES = new Set(
  String(process.env.ROOM_GEOMETRY_ASSIST_ROOM_TYPES || '')
    .split(',')
    .map(value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
);

function normalizeRoomTypeKey(roomType = '') {
  return String(roomType || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isRoomGeometryAssistEligible(roomTypeKey = '') {
  return LARGE_OPEN_ROOM_TYPES.has(roomTypeKey) || ROOM_GEOMETRY_ASSIST_ROOM_TYPES.has(roomTypeKey);
}

function parseDataUrl(imageInput) {
  const match = String(imageInput || '').match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s);
  if (!match) return null;
  return {
    mimeType: (match[1] || '').toLowerCase(),
    base64Data: match[2] || '',
  };
}

function bufferToDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
}

function isHeicMime(mimeType) {
  return /image\/(heic|heif|heic-sequence|heif-sequence)/i.test(mimeType || '');
}

function sniffImageMime(buffer, declaredMimeType = '') {
  const declared = String(declaredMimeType || '').toLowerCase();
  if (isHeicMime(declared)) return declared;
  if (!buffer || buffer.length < 12) return declared || 'application/octet-stream';

  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';

  const ftyp = buffer.slice(4, 32).toString('ascii');
  if (ftyp.includes('ftyp') && /(heic|heix|hevc|hevx|heif|mif1|msf1)/i.test(ftyp)) {
    return 'image/heic';
  }

  return declared || 'application/octet-stream';
}

async function parseImageExif(buffer) {
  try {
    return await exifr.parse(buffer, { pick: EXIF_PICK_FIELDS });
  } catch (error) {
    return null;
  }
}

async function probeImageDimensionsFromBuffer(buffer, source) {
  try {
    const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
    if (metadata?.width && metadata?.height) {
      return { width: metadata.width, height: metadata.height, source };
    }
  } catch (error) {
    console.warn(`[PhotoMeasurement] ${source} dimension probe failed:`, error.message);
  }
  return null;
}

function summarizeExif(exif) {
  if (!exif) return null;
  return {
    make: exif.Make || null,
    model: exif.Model || null,
    focalLengthMm: typeof exif.FocalLength === 'number' ? exif.FocalLength : null,
    focalLength35mm: typeof exif.FocalLengthIn35mmFormat === 'number' ? exif.FocalLengthIn35mmFormat : null,
    orientation: exif.Orientation || null,
    exifImageWidth: exif.ExifImageWidth || exif.ImageWidth || null,
    exifImageHeight: exif.ExifImageHeight || exif.ImageHeight || null,
  };
}

async function normalizeMeasurementImageInput(imageInput, photoIndex) {
  const dataUrl = parseDataUrl(imageInput);
  const isRemote = String(imageInput || '').startsWith('http://') || String(imageInput || '').startsWith('https://');

  try {
    const originalBuffer = await imageInputToBuffer(imageInput);
    const originalMimeType = sniffImageMime(originalBuffer, dataUrl?.mimeType || '');
    const originalExif = await parseImageExif(originalBuffer);
    const originalDimensions = isHeicMime(originalMimeType)
      ? (
          (originalExif?.ExifImageWidth || originalExif?.ImageWidth) && (originalExif?.ExifImageHeight || originalExif?.ImageHeight)
            ? {
                width: originalExif.ExifImageWidth || originalExif.ImageWidth,
                height: originalExif.ExifImageHeight || originalExif.ImageHeight,
                source: 'original_exif_dimensions',
              }
            : null
        )
      : await probeImageDimensionsFromBuffer(originalBuffer, 'original_image_metadata');

    let normalizedBuffer = originalBuffer;
    let normalizedMimeType = originalMimeType;
    let modelInput = isRemote
      ? imageInput
      : (dataUrl ? imageInput : bufferToDataUrl(originalBuffer, originalMimeType.startsWith('image/') ? originalMimeType : 'image/jpeg'));
    let converted = false;
    let conversion = null;

    if (isHeicMime(originalMimeType)) {
      const convertedBuffer = await heicConvert({
        buffer: originalBuffer,
        format: 'JPEG',
        quality: 0.92,
      });
      normalizedBuffer = Buffer.from(convertedBuffer);
      normalizedMimeType = 'image/jpeg';
      modelInput = bufferToDataUrl(normalizedBuffer, normalizedMimeType);
      converted = true;
      conversion = { from: originalMimeType, to: normalizedMimeType, exifCarriedForward: Boolean(originalExif) };
      console.log(`[PhotoMeasurement] Converted HEIC photo ${photoIndex} to JPEG for model ingestion`);
    }

    const normalizedDimensions = await probeImageDimensionsFromBuffer(normalizedBuffer, converted ? 'converted_image_metadata' : 'image_metadata');

    return {
      ok: true,
      photoIndex,
      modelInput,
      originalMimeType,
      normalizedMimeType,
      converted,
      conversion,
      originalExif,
      originalExifSummary: summarizeExif(originalExif),
      originalDimensions,
      pixelDimensions: normalizedDimensions || originalDimensions,
      normalizationSource: converted ? 'heic_to_jpeg_backend' : 'original_image',
    };
  } catch (error) {
    console.warn(`[PhotoMeasurement] Image normalization failed for photo ${photoIndex}:`, error.message);
    return {
      ok: false,
      photoIndex,
      modelInput: imageInput,
      originalMimeType: dataUrl?.mimeType || 'unknown',
      normalizedMimeType: dataUrl?.mimeType || 'unknown',
      converted: false,
      conversion: null,
      originalExif: null,
      originalExifSummary: null,
      originalDimensions: null,
      pixelDimensions: null,
      normalizationSource: 'failed_original_passthrough',
      error: error.message,
    };
  }
}

export async function normalizeVisionModelImages(images = []) {
  if (!Array.isArray(images) || images.length === 0) return [];
  return Promise.all(images.map((imageInput, photoIndex) => normalizeMeasurementImageInput(imageInput, photoIndex)));
}

function summarizeImageAudit(imageRecord) {
  return {
    photoIndex: imageRecord.photoIndex,
    normalizationOk: imageRecord.ok,
    originalMimeType: imageRecord.originalMimeType,
    normalizedMimeType: imageRecord.normalizedMimeType,
    converted: imageRecord.converted,
    conversion: imageRecord.conversion,
    originalDimensions: imageRecord.originalDimensions,
    pixelDimensions: imageRecord.pixelDimensions,
    exif: imageRecord.originalExifSummary,
    normalizationSource: imageRecord.normalizationSource,
    error: imageRecord.error || null,
  };
}

function summarizeDepthAudit(depthInfo) {
  return {
    photoIndex: depthInfo?.photoIndex,
    ok: Boolean(depthInfo?.ok),
    width: depthInfo?.width || null,
    height: depthInfo?.height || null,
    depthShapeSource: depthInfo?.depthShapeSource || null,
    depthShapeUnusedValues: depthInfo?.depthShapeUnusedValues || 0,
    stats: depthInfo?.stats || null,
    error: depthInfo?.error || null,
  };
}

function summarizeIntrinsicsAudit(intrinsics, photoIndex) {
  return {
    photoIndex,
    source: intrinsics?.source || 'unknown',
    trusted: isIntrinsicsTrusted(intrinsics),
    camera: intrinsics?.camera || 'unknown',
    focalLength35mm: intrinsics?.focalLength35mm || null,
    fx: intrinsics?.fx ? Math.round(intrinsics.fx) : null,
    fy: intrinsics?.fy ? Math.round(intrinsics.fy) : null,
    metadataSource: intrinsics?.metadataSource || null,
    focalLength35mmConversion: intrinsics?.focalLength35mmConversion || null,
    focalLengthCandidates: Array.isArray(intrinsics?.focalLengthCandidates)
      ? intrinsics.focalLengthCandidates.map(candidate => ({
          model: candidate.model,
          fx: Math.round(candidate.fx),
        }))
      : [],
  };
}

function summarizeCalibrationAudit(calibration, photoIndex) {
  return {
    photoIndex,
    calibrated: Boolean(calibration?.calibrated),
    source: calibration?.source || (calibration?.calibrated ? 'reference_objects' : 'none'),
    scaleFactor: calibration?.scaleFactor || 1,
    candidateScaleFactor: calibration?.candidateScaleFactor || null,
    consistency: calibration?.consistency || 'unknown',
    consensus: calibration?.consensus || null,
    referenceCount: calibration?.references?.length || calibration?.count || 0,
    rejected: Boolean(calibration?.rejected),
    rejectionReason: calibration?.rejectionReason || null,
    references: calibration?.references || [],
    rejectedAnchors: calibration?.rejectedAnchors || [],
  };
}

function isIntrinsicsTrusted(intrinsics) {
  return ['exif', 'original_exif'].includes(intrinsics?.source);
}

function getPreferredWallPlaneMeasurementMethods(targetType) {
  if (targetType === 'bathroom_mirror') {
    return ['local_wall_plane_rectified', 'surrounding_wall_depth_pinhole', 'front_face_depth_pinhole'];
  }
  return ['local_wall_plane_rectified', 'surrounding_wall_depth_pinhole'];
}

function supportsFrontFaceObjectMeasurement(targetType) {
  return FRONT_FACE_TARGET_TYPES.has(targetType) || targetType === 'bathroom_mirror';
}

function hasCoverageConsensusRefinement(target) {
  if (!['existing_vanity', 'bathroom_mirror'].includes(target?.targetType)) return false;
  if (!target?.consensusStable || target?.consensusBoxStrategy !== 'coverage_union' || (target?.consensusBoxSupportCount || 0) < 2) return false;
  if (!isValidNormalizedBox(target?.boundingBox) || !isValidNormalizedBox(target?.consensusMergedBox)) return false;

  const finalArea = Number(target.boundingBox.width || 0) * Number(target.boundingBox.height || 0);
  const mergedArea = Number(target.consensusMergedBox.width || 0) * Number(target.consensusMergedBox.height || 0);
  return mergedArea > 0 && finalArea >= mergedArea * 1.12;
}

function hasLocalTargetReferenceEvidence(target) {
  return Boolean(
    target?.referenceAligned
    || target?.referenceBackfilled
    || target?.sourceReferenceType
    || target?.referenceKnownDimensions
  );
}

function hasLocalTargetBoxRefinement(target) {
  return Boolean(
    target?.edgeRefined
    || target?.cropRefined
    || target?.deterministicRefined
    || hasCoverageConsensusRefinement(target)
  );
}

function isWeakLocalGeometryTarget(target) {
  return Boolean(target?.targetType)
    && (WALL_PLANE_TARGET_TYPES.has(target.targetType) || FRONT_FACE_TARGET_TYPES.has(target.targetType))
    && !hasLocalTargetReferenceEvidence(target)
    && !hasLocalTargetBoxRefinement(target);
}

function shouldSuppressRoomLocalCalibrationHintForTarget(target, calibration) {
  if (calibration?.source !== 'room_local_calibration_hint') return false;
  return isWeakLocalGeometryTarget(target);
}

function evaluateObjectMeasurementTrust({ calibration, intrinsics, depthInfo, depthStats, targetType, targetConfidence, sanityClamped, measurementMethod, bboxRefined }) {
  const reasons = [];
  if (!depthInfo?.ok) reasons.push('depth_unavailable');
  if (depthStats?.source === 'position_heuristic') reasons.push('depth_bbox_fallback');
  if (!calibration?.calibrated) reasons.push('calibration_untrusted');
  if (!isIntrinsicsTrusted(intrinsics)) reasons.push('intrinsics_estimated');
  if (sanityClamped) reasons.push('object_sanity_clamped');
  if ((targetConfidence || 0) < 0.7) reasons.push('low_detection_confidence');
  if (WALL_PLANE_TARGET_TYPES.has(targetType) && !getPreferredWallPlaneMeasurementMethods(targetType).includes(measurementMethod)) {
    reasons.push('object_plane_geometry_unverified');
  }
  if (FRONT_FACE_TARGET_TYPES.has(targetType) && measurementMethod !== 'front_face_depth_pinhole') {
    reasons.push('object_front_face_geometry_unverified');
  }
  if ((WALL_PLANE_TARGET_TYPES.has(targetType) || FRONT_FACE_TARGET_TYPES.has(targetType)) && !bboxRefined) {
    reasons.push('object_bbox_not_refined');
  }

  return {
    trustedForPricing: reasons.length === 0,
    reasons,
    calibrationSource: calibration?.source || (calibration?.calibrated ? 'reference_objects' : 'none'),
    intrinsicsSource: intrinsics?.source || 'unknown',
    depthOk: Boolean(depthInfo?.ok),
    measurementMethod: measurementMethod || 'unknown',
  };
}

function evaluateRoomMeasurementTrust({ roomType, roomDimensions, confidence, photos, captureProtocol }) {
  const reasons = [];
  const calibratedPhotoCount = photos.filter(p => p.calibration?.calibrated).length;
  const trustedIntrinsicPhotoCount = photos.filter(p => isIntrinsicsTrusted(p.intrinsics)).length;
  const depthPhotoCount = photos.filter(p => p.depthInfo?.ok).length;
  const requiredCalibratedPhotoCount = Math.min(2, Math.max(1, photos.length || 1));
  const minExpectedArea = {
    bathroom: 25,
    kitchen: 70,
    bedroom: 80,
    living_room: 100,
    dining_room: 70,
    hallway: 18,
    foyer: 25,
    laundry: 20,
  }[roomType] || 30;

  if (!depthPhotoCount) reasons.push('depth_unavailable');
  if (!calibratedPhotoCount) reasons.push('calibration_untrusted');
  if ((photos.length || 0) > 1 && calibratedPhotoCount < requiredCalibratedPhotoCount) reasons.push('calibration_insufficient_consensus');
  if (!trustedIntrinsicPhotoCount) reasons.push('intrinsics_estimated');
  if (confidence === 'low') reasons.push('low_measurement_confidence');
  if ((roomDimensions?.floorAreaSqFt || 0) < minExpectedArea) reasons.push('room_size_plausibility_failed');
  if (roomDimensions?.sanityClamped) reasons.push('room_sanity_clamped');
  const automatedBathroomEnvelopeEligible = roomType === 'bathroom' &&
    roomDimensions?.visionFallbackUsed &&
    calibratedPhotoCount >= requiredCalibratedPhotoCount &&
    depthPhotoCount >= requiredCalibratedPhotoCount &&
    trustedIntrinsicPhotoCount >= requiredCalibratedPhotoCount &&
    roomDimensions?.roomEnvelopeConfidence !== 'low' &&
    (roomDimensions?.floorAreaSqFt || 0) >= 28;
  if (roomDimensions?.visionFallbackUsed && !automatedBathroomEnvelopeEligible) reasons.push('vision_room_envelope_fallback');
  if (!captureProtocol?.pass) reasons.push('capture_protocol_failed');

  return {
    trustedForPricing: reasons.length === 0,
    reasons,
    calibratedPhotoCount,
    trustedIntrinsicPhotoCount,
    depthPhotoCount,
    photoCount: photos.length,
    confidence,
    methodology: roomDimensions?.methodology || 'unknown',
    captureProtocolPass: Boolean(captureProtocol?.pass),
    sanityClamped: Boolean(roomDimensions?.sanityClamped),
  };
}

async function imageInputToBuffer(imageInput) {
  if (imageInput.startsWith('https://') || imageInput.startsWith('http://')) {
    const resp = await fetch(imageInput);
    return Buffer.from(await resp.arrayBuffer());
  }
  const base64Data = imageInput.replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

async function getImagePixelDimensions(imageInput) {
  try {
    const buffer = await imageInputToBuffer(imageInput);
    const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
    if (metadata?.width && metadata?.height) {
      return { width: metadata.width, height: metadata.height, source: 'image_metadata' };
    }
  } catch (error) {
    console.warn('[PhotoMeasurement] Image dimension probe failed:', error.message);
  }
  return null;
}

function inferDepthDimensions(valueCount, shape, sourceDimensions) {
  const candidates = [];
  const expectedAspect = sourceDimensions?.width && sourceDimensions?.height
    ? sourceDimensions.width / sourceDimensions.height
    : null;

  const addCandidate = (width, height, source) => {
    width = Math.floor(width);
    height = Math.floor(height);
    if (width <= 0 || height <= 0) return;
    const usedValues = width * height;
    if (usedValues <= 0 || usedValues > valueCount) return;
    const aspect = width / height;
    const aspectError = expectedAspect
      ? Math.abs(Math.log(aspect / expectedAspect))
      : 0;
    candidates.push({ width, height, source, usedValues, unusedValues: valueCount - usedValues, aspectError });
  };

  if (Array.isArray(shape) && shape.length >= 2) {
    const first = Number(shape[0]);
    const second = Number(shape[1]);
    if (Number.isFinite(first) && Number.isFinite(second)) {
      addCandidate(second, first, 'model_shape_h_w');
      addCandidate(first, second, 'model_shape_w_h');
    }
  }

  if (expectedAspect && Number.isFinite(expectedAspect) && expectedAspect > 0) {
    const height = Math.round(Math.sqrt(valueCount / expectedAspect));
    const width = Math.floor(valueCount / Math.max(1, height));
    addCandidate(width, height, 'input_aspect_inferred');
  }

  if (candidates.length === 0) {
    const height = Math.round(Math.sqrt(valueCount * 9 / 16));
    const width = Math.floor(valueCount / Math.max(1, height));
    addCandidate(width, height, 'fallback_16_9_inferred');
  }

  candidates.sort((a, b) => {
    if (expectedAspect) return a.aspectError - b.aspectError || a.unusedValues - b.unusedValues;
    return a.unusedValues - b.unusedValues;
  });

  return candidates[0] || { width: valueCount, height: 1, source: 'flat_fallback', usedValues: valueCount, unusedValues: 0, aspectError: null };
}

function trustCalibration(scale, consistency) {
  if (!Number.isFinite(scale) || scale < CALIBRATION_SCALE_MIN || scale > CALIBRATION_SCALE_MAX) {
    return { trusted: false, reason: `scale_out_of_range_${scale?.toFixed?.(3) || scale}` };
  }
  if (consistency === 'low') {
    return { trusted: false, reason: 'low_consistency' };
  }
  return { trusted: true, reason: null };
}

// ============================================================================
// Reference Objects — known real-world dimensions for scale calibration
// ============================================================================
const REFERENCE_OBJECTS = {
  'standard_door':        { width: 36, height: 80, unit: 'in' },
  'entry_door':           { width: 36, height: 80, unit: 'in' },
  'closet_door':          { width: 30, height: 80, unit: 'in' },
  'double_door':          { width: 60, height: 80, unit: 'in' },
  'sliding_glass_door':   { width: 72, height: 80, unit: 'in' },
  'electrical_outlet':    { width: 2.75, height: 4.5, unit: 'in' },
  'light_switch':         { width: 2.75, height: 4.5, unit: 'in' },
  'double_outlet':        { width: 4.56, height: 4.5, unit: 'in' },
  'standard_countertop':  { width: null, height: 36, unit: 'in' },
  'upper_cabinet':        { width: null, height: 30, unit: 'in' },
  'standard_fridge':      { width: 36, height: 70, unit: 'in' },
  'standard_range':       { width: 30, height: 36, unit: 'in' },
  'standard_dishwasher':  { width: 24, height: 34, unit: 'in' },
  'standard_microwave':   { width: 30, height: 17, unit: 'in' },
  'kitchen_sink':         { width: 33, height: 22, unit: 'in' },
  'standard_toilet':      { width: 18, height: 28, unit: 'in' },
  'toilet':               { width: 16.5, height: 30, unit: 'in' },
  'standard_bathtub':     { width: 30, height: 60, unit: 'in' },
  'bathtub':              { width: 30, height: 60, unit: 'in' },
  'bathroom_vanity_24':   { width: 24, height: 34, unit: 'in' },
  'bathroom_vanity_30':   { width: 30, height: 34, unit: 'in' },
  'bathroom_vanity_32':   { width: 32, height: 31, unit: 'in' },
  'bathroom_vanity_36':   { width: 36, height: 34, unit: 'in' },
  'bathroom_vanity_48':   { width: 48, height: 34, unit: 'in' },
  'bathroom_vanity_60':   { width: 60, height: 31, unit: 'in' },
  'bathroom_vanity_72':   { width: 72, height: 34, unit: 'in' },
  'bathroom_vanity_auto': { width: null, height: 34, unit: 'in' },
  'medicine_cabinet':     { width: 20, height: 26, unit: 'in' },
  'bathroom_mirror':      { width: 36, height: 30, unit: 'in' },
  'bathroom_mirror_auto': { width: null, height: 30, unit: 'in' },
  'floor_tile_12':        { width: 12, height: 12, unit: 'in' },
  'floor_tile_18':        { width: 18, height: 18, unit: 'in' },
  'floor_tile_24':        { width: 24, height: 24, unit: 'in' },
  'standard_window':      { width: 36, height: 48, unit: 'in' },
  'double_window':        { width: 72, height: 48, unit: 'in' },
  'ceiling_height_8':     { width: null, height: 96, unit: 'in' },
  'ceiling_height_9':     { width: null, height: 108, unit: 'in' },
  'baseboard':            { width: null, height: 5.5, unit: 'in' },
  'subway_tile':          { width: 6, height: 3, unit: 'in' },
  'twin_mattress':        { width: 38, height: 75, unit: 'in' },
  'full_mattress':        { width: 54, height: 75, unit: 'in' },
  'queen_mattress':       { width: 60, height: 80, unit: 'in' },
  'king_mattress':        { width: 76, height: 80, unit: 'in' },
};

const STANDARD_SIZES = {
  fridge: [28, 30, 33, 36],
  range: [24, 30, 36],
  dishwasher: [18, 24],
  vanity: [24, 30, 32, 36, 48, 60, 72],
  shower_door: [32, 36, 48, 56, 60],
};

const REFERENCE_ANCHOR_RELIABILITY = {
  standard_door: { height: 0.96, width: 0.58 },
  entry_door: { height: 0.96, width: 0.58 },
  closet_door: { height: 0.94, width: 0.45 },
  double_door: { height: 0.92, width: 0.50 },
  sliding_glass_door: { height: 0.86, width: 0.42 },
  electrical_outlet: { height: 0.78, width: 0.78 },
  light_switch: { height: 0.78, width: 0.78 },
  double_outlet: { height: 0.76, width: 0.76 },
  standard_countertop: { height: 0.88, width: 0.20 },
  upper_cabinet: { height: 0.58, width: 0.20 },
  standard_fridge: { height: 0.55, width: 0.45 },
  standard_range: { height: 0.62, width: 0.82 },
  standard_dishwasher: { height: 0.76, width: 0.90 },
  standard_microwave: { height: 0.45, width: 0.45 },
  kitchen_sink: { height: 0.35, width: 0.55 },
  standard_toilet: { height: 0.45, width: 0.45 },
  toilet: { height: 0.58, width: 0.52 },
  standard_bathtub: { height: 0.42, width: 0.55 },
  bathtub: { height: 0.42, width: 0.55 },
  bathroom_vanity_24: { height: 0.72, width: 0.88 },
  bathroom_vanity_30: { height: 0.72, width: 0.90 },
  bathroom_vanity_32: { height: 0.76, width: 0.92 },
  bathroom_vanity_36: { height: 0.72, width: 0.88 },
  bathroom_vanity_48: { height: 0.72, width: 0.88 },
  bathroom_vanity_60: { height: 0.68, width: 0.86 },
  bathroom_vanity_72: { height: 0.64, width: 0.82 },
  bathroom_vanity_auto: { height: 0.42, width: 0.88 },
  medicine_cabinet: { height: 0.60, width: 0.55 },
  bathroom_mirror: { height: 0.45, width: 0.42 },
  bathroom_mirror_auto: { height: 0.38, width: 0.40 },
  floor_tile_12: { height: 0.70, width: 0.70 },
  floor_tile_18: { height: 0.74, width: 0.74 },
  floor_tile_24: { height: 0.76, width: 0.76 },
  standard_window: { height: 0.38, width: 0.35 },
  double_window: { height: 0.38, width: 0.35 },
  ceiling_height_8: { height: 0.82, width: 0.10 },
  ceiling_height_9: { height: 0.82, width: 0.10 },
  baseboard: { height: 0.65, width: 0.10 },
  subway_tile: { height: 0.72, width: 0.72 },
  twin_mattress: { height: 0.46, width: 0.52 },
  full_mattress: { height: 0.46, width: 0.52 },
  queen_mattress: { height: 0.46, width: 0.52 },
  king_mattress: { height: 0.46, width: 0.52 },
};

const SMALL_FIXTURE_ANCHOR_TYPES = new Set(['electrical_outlet', 'light_switch', 'double_outlet', 'subway_tile']);
const FLOOR_TILE_ANCHOR_TYPES = new Set(['floor_tile_12', 'floor_tile_18', 'floor_tile_24']);
const VARIABLE_STANDARD_ANCHOR_TYPES = new Set(['standard_window', 'double_window', 'bathroom_mirror', 'bathroom_vanity_auto', 'bathroom_mirror_auto', 'kitchen_sink', 'standard_fridge', 'standard_microwave', 'twin_mattress', 'full_mattress', 'queen_mattress', 'king_mattress']);
const DOOR_ANCHOR_TYPES = new Set(['standard_door', 'entry_door', 'closet_door', 'double_door', 'sliding_glass_door']);

const AUTO_FIXTURE_REFERENCE_TARGETS = {
  existing_vanity: {
    roomTypes: new Set(['bathroom']),
    referenceType: 'bathroom_vanity_auto',
    widths: [24, 30, 32, 36, 48, 60, 72],
    heights: [30, 31, 34, 36],
    scaleDimensions: ['width'],
    maxRelativeError: 0.22,
  },
  bathroom_mirror: {
    roomTypes: new Set(['bathroom']),
    referenceType: 'bathroom_mirror_auto',
    widths: [18, 20, 22, 24, 30, 36, 42],
    heights: [20, 24, 26, 30, 36, 42],
    scaleDimensions: [],
    maxRelativeError: 0.18,
  },
};

const WALL_PLANE_TARGET_TYPES = new Set([
  'fridge_opening', 'range_opening', 'dishwasher_opening', 'vanity_space', 'shower_door_opening',
  'window', 'door', 'bathroom_mirror',
]);

const FRONT_FACE_TARGET_TYPES = new Set([
  'existing_fridge', 'existing_range', 'existing_dishwasher', 'existing_microwave',
  'existing_vanity', 'existing_bathtub', 'existing_toilet', 'cabinet_run_upper', 'cabinet_run_lower',
]);

const EDGE_REFINED_TARGET_TYPES = new Set([
  ...WALL_PLANE_TARGET_TYPES,
  ...FRONT_FACE_TARGET_TYPES,
  'countertop_run', 'cabinet_run',
]);

const SUPPORTED_MEASUREMENT_TARGET_TYPES = new Set([...EDGE_REFINED_TARGET_TYPES]);
const MIRROR_REFERENCE_PROFILE_TYPES = new Set(['bathroom_mirror', 'bathroom_mirror_auto', 'medicine_cabinet']);

const OBJECT_DIMENSION_LIMITS = {
  cabinet_run:          { minH: 24, maxH: 96, minW: 12, maxW: 300 },
  cabinet_run_lower:    { minH: 28, maxH: 42, minW: 24, maxW: 300 },
  cabinet_run_upper:    { minH: 12, maxH: 48, minW: 24, maxW: 300 },
  countertop_run:       { minH: 1,  maxH: 8,  minW: 24, maxW: 300 },
  fridge_opening:       { minH: 60, maxH: 84, minW: 28, maxW: 48 },
  range_opening:        { minH: 30, maxH: 48, minW: 24, maxW: 48 },
  dishwasher_opening:   { minH: 32, maxH: 38, minW: 22, maxW: 30 },
  vanity_space:         { minH: 28, maxH: 42, minW: 18, maxW: 96 },
  shower_door_opening:  { minH: 48, maxH: 78, minW: 24, maxW: 96 },
  window:               { minH: 18, maxH: 84, minW: 18, maxW: 120 },
  door:                 { minH: 72, maxH: 96, minW: 24, maxW: 48 },
  bathroom_mirror:      { minH: 18, maxH: 42, minW: 18, maxW: 42 },
  existing_fridge:      { minH: 60, maxH: 84, minW: 28, maxW: 48 },
  existing_range:       { minH: 30, maxH: 48, minW: 24, maxW: 48 },
  existing_dishwasher:  { minH: 32, maxH: 38, minW: 22, maxW: 30 },
  existing_microwave:   { minH: 10, maxH: 24, minW: 18, maxW: 36 },
  existing_vanity:      { minH: 28, maxH: 42, minW: 18, maxW: 96 },
  existing_bathtub:     { minH: 20, maxH: 72, minW: 24, maxW: 84 },
  existing_toilet:      { minH: 24, maxH: 40, minW: 12, maxW: 24 },
};

const MEASUREMENT_TARGET_REFERENCE_ANCHORS = {
  existing_range:      { type: 'standard_range', standardSizeConfidence: 0.86, anchorQuality: 'medium', useForScale: true, scaleDimensions: ['width'], rationale: 'visible range face/opening is commonly standardized' },
  range_opening:       { type: 'standard_range', standardSizeConfidence: 0.82, anchorQuality: 'medium', useForScale: true, scaleDimensions: ['width'], rationale: 'range opening is commonly 30 inches wide' },
  existing_dishwasher: { type: 'standard_dishwasher', standardSizeConfidence: 0.90, anchorQuality: 'high', useForScale: true, scaleDimensions: ['width'], rationale: 'dishwasher front/opening is highly standardized' },
  dishwasher_opening:  { type: 'standard_dishwasher', standardSizeConfidence: 0.88, anchorQuality: 'high', useForScale: true, scaleDimensions: ['width'], rationale: 'dishwasher opening is highly standardized' },
  existing_bathtub:    { type: 'standard_bathtub', standardSizeConfidence: 0.66, anchorQuality: 'low', useForScale: false, scaleDimensions: ['width'], rationale: 'bathtub orientation varies; keep for audit unless corroborated' },
  existing_toilet:     { type: 'toilet', standardSizeConfidence: 0.62, anchorQuality: 'medium', useForScale: true, scaleDimensions: ['height'], rationale: 'full toilet body can provide a bounded local bathroom height ruler; exclude from global calibration' },
  existing_fridge:     { type: 'standard_fridge', standardSizeConfidence: 0.58, anchorQuality: 'low', useForScale: false, rationale: 'fridges vary; keep for audit unless detector/corroboration proves size' },
  fridge_opening:      { type: 'standard_fridge', standardSizeConfidence: 0.62, anchorQuality: 'low', useForScale: false, rationale: 'fridge openings vary; keep for audit unless corroborated' },
  existing_microwave:  { type: 'standard_microwave', standardSizeConfidence: 0.56, anchorQuality: 'low', useForScale: false, rationale: 'microwave sizes vary; audit only by default' },
  window:              { type: 'standard_window', standardSizeConfidence: 0.62, anchorQuality: 'low', useForScale: false, rationale: 'windows vary; audit only unless exact standard size is clear' },
  door:                { type: 'standard_door', standardSizeConfidence: 0.82, anchorQuality: 'medium', useForScale: true, scaleDimensions: ['height'], rationale: 'visible full-height interior door target promoted to scale anchor' },
};

const ANCHOR_DIMENSION_PRIORITY = {
  standard_door: { height: 1.65, width: 0.55 },
  entry_door: { height: 1.65, width: 0.55 },
  closet_door: { height: 1.45, width: 0.45 },
  standard_countertop: { height: 1.45, width: 0.15 },
  standard_dishwasher: { height: 1.25, width: 1.35 },
  standard_range: { height: 1.05, width: 1.25 },
  standard_bathtub: { height: 0.55, width: 1.15 },
  bathtub: { height: 0.55, width: 1.15 },
  bathroom_vanity_24: { height: 0.90, width: 1.15 },
  bathroom_vanity_30: { height: 0.94, width: 1.20 },
  bathroom_vanity_32: { height: 0.98, width: 1.24 },
  bathroom_vanity_36: { height: 0.90, width: 1.15 },
  bathroom_vanity_48: { height: 0.90, width: 1.15 },
  bathroom_vanity_60: { height: 0.82, width: 1.10 },
  bathroom_vanity_72: { height: 0.78, width: 1.04 },
  bathroom_vanity_auto: { height: 0.42, width: 1.28 },
  bathroom_mirror_auto: { height: 0.28, width: 0.42 },
  floor_tile_12: { height: 1.12, width: 1.12 },
  floor_tile_18: { height: 1.18, width: 1.18 },
  floor_tile_24: { height: 1.20, width: 1.20 },
  electrical_outlet: { height: 0.85, width: 0.80 },
  light_switch: { height: 0.85, width: 0.80 },
  double_outlet: { height: 0.82, width: 0.82 },
  subway_tile: { height: 1.05, width: 1.05 },
  ceiling_height_8: { height: 1.55, width: 0.05 },
  ceiling_height_9: { height: 1.45, width: 0.05 },
  standard_window: { height: 0.38, width: 0.35 },
  double_window: { height: 0.38, width: 0.35 },
  queen_mattress: { height: 0.48, width: 0.55 },
  king_mattress: { height: 0.48, width: 0.55 },
  full_mattress: { height: 0.48, width: 0.55 },
  twin_mattress: { height: 0.48, width: 0.55 },
};

function clamp01(value, fallback = 0.5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function getReferenceProfileType(ref) {
  return ref?.referenceProfileType || ref?.type || 'unknown';
}

function getReferenceKnownDimensions(ref) {
  const width = Number(ref?.knownDimensions?.width || ref?.knownWidth || 0);
  const height = Number(ref?.knownDimensions?.height || ref?.knownHeight || 0);
  if (width > 0 || height > 0) {
    return {
      width: width > 0 ? width : null,
      height: height > 0 ? height : null,
      unit: 'in',
    };
  }

  const profileType = getReferenceProfileType(ref);
  return REFERENCE_OBJECTS[profileType] || REFERENCE_OBJECTS[ref?.type] || null;
}

function inferKnownSceneAnchorProfileType(anchor) {
  const explicit = anchor?.referenceProfileType || anchor?.referenceType || anchor?.type;
  if (explicit) return explicit;

  const targetType = String(anchor?.targetType || '').toLowerCase();
  const width = Number(anchor?.knownDimensions?.width || anchor?.width || 0);

  if (targetType === 'existing_vanity' || targetType === 'vanity_space') {
    const sizes = [24, 30, 32, 36, 48, 60, 72];
    const nearest = sizes.reduce((best, candidate) => (
      Math.abs(candidate - width) < Math.abs(best - width) ? candidate : best
    ), sizes[0]);
    return `bathroom_vanity_${nearest}`;
  }
  if (targetType === 'bathroom_mirror') return 'bathroom_mirror';
  if (targetType === 'existing_bathtub') return 'standard_bathtub';
  if (targetType === 'existing_dishwasher' || targetType === 'dishwasher_opening') return 'standard_dishwasher';
  if (targetType === 'existing_range' || targetType === 'range_opening') return 'standard_range';
  if (targetType === 'door') return 'standard_door';
  if (targetType === 'window') return 'standard_window';

  return 'unknown_reference';
}

function normalizeKnownSceneAnchors(sceneAnchors = []) {
  if (!Array.isArray(sceneAnchors)) return [];

  return sceneAnchors
    .map((anchor, index) => {
      const width = Number(anchor?.knownDimensions?.width || anchor?.width || 0);
      const height = Number(anchor?.knownDimensions?.height || anchor?.height || 0);
      if (width <= 0 && height <= 0) return null;

      const referenceProfileType = inferKnownSceneAnchorProfileType(anchor);
      const scaleDimensions = Array.isArray(anchor?.scaleDimensions) && anchor.scaleDimensions.length > 0
        ? anchor.scaleDimensions.filter(dimension => dimension === 'width' || dimension === 'height')
        : [width > 0 ? 'width' : null, height > 0 ? 'height' : null].filter(Boolean);

      return {
        id: anchor?.id || `known_scene_anchor_${index}`,
        label: anchor?.label || anchor?.description || anchor?.id || `known scene anchor ${index + 1}`,
        targetType: anchor?.targetType || null,
        referenceType: anchor?.referenceType || null,
        referenceProfileType,
        knownDimensions: {
          width: width > 0 ? width : null,
          height: height > 0 ? height : null,
          unit: 'in',
        },
        scaleDimensions,
        useForScale: anchor?.useForScale !== false,
        anchorQuality: anchor?.anchorQuality || 'high',
        standardSizeConfidence: clamp01(anchor?.standardSizeConfidence, 0.99),
        confidence: clamp01(anchor?.confidence, 0.98),
        visibility: anchor?.visibility || null,
        perspective: anchor?.perspective || null,
      };
    })
    .filter(Boolean);
}

function buildInternalRoomFixtureAnchors(roomObjects = [], roomType = 'unknown') {
  if (!Array.isArray(roomObjects) || !roomObjects.length) return [];

  const anchors = [];
  const pushAnchor = anchor => {
    const width = Number(anchor?.knownDimensions?.width || anchor?.width || 0);
    const height = Number(anchor?.knownDimensions?.height || anchor?.height || 0);
    if (!(width > 0 || height > 0)) return;
    anchors.push(anchor);
  };

  const grouped = new Map();
  for (const object of roomObjects) {
    if (!object?.type || !object?.dimensions) continue;
    const key = object.type;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(object);
  }

  const median = values => {
    const numeric = values.map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    if (!numeric.length) return null;
    const middle = Math.floor(numeric.length / 2);
    return numeric.length % 2 === 1 ? numeric[middle] : (numeric[middle - 1] + numeric[middle]) / 2;
  };

  const chooseRepresentative = type => {
    const candidates = grouped.get(type) || [];
    if (!candidates.length) return null;
    const trusted = candidates.filter(candidate => candidate.trustedForPricing);
    const source = trusted.length ? trusted : candidates;
    const width = median(source.map(candidate => candidate.dimensions?.widthInches));
    const height = median(source.map(candidate => candidate.dimensions?.heightInches));
    if (!(width > 0 || height > 0)) return null;
    return { width, height };
  };

  if (roomType === 'bathroom') {
    const vanity = chooseRepresentative('existing_vanity');
    if (vanity?.width) {
      pushAnchor({
        id: 'internal_room_vanity',
        label: `Measured vanity ${Math.round(vanity.width)}\" wide`,
        targetType: 'existing_vanity',
        width: vanity.width,
        height: vanity.height,
        useForScale: true,
        anchorQuality: 'high',
        standardSizeConfidence: 0.96,
        confidence: 0.96,
        scaleDimensions: ['width'],
      });
    }

    const toilet = chooseRepresentative('existing_toilet');
    if (toilet?.height) {
      pushAnchor({
        id: 'internal_room_toilet',
        label: `Measured toilet ${Math.round(toilet.height)}\" tall`,
        targetType: 'existing_toilet',
        width: toilet.width,
        height: toilet.height,
        useForScale: true,
        anchorQuality: 'medium',
        standardSizeConfidence: 0.88,
        confidence: 0.88,
        scaleDimensions: ['height'],
      });
    }

    const tub = chooseRepresentative('existing_bathtub');
    if (tub?.width) {
      pushAnchor({
        id: 'internal_room_tub',
        label: `Measured bathtub ${Math.round(tub.width)}\" wide`,
        targetType: 'existing_bathtub',
        width: tub.width,
        height: tub.height,
        useForScale: true,
        anchorQuality: 'medium',
        standardSizeConfidence: 0.9,
        confidence: 0.9,
        scaleDimensions: ['width'],
      });
    }

    const shower = chooseRepresentative('shower_door_opening');
    if (shower?.width) {
      pushAnchor({
        id: 'internal_room_shower',
        label: `Measured shower opening ${Math.round(shower.width)}\" wide`,
        targetType: 'shower_door_opening',
        width: shower.width,
        height: shower.height,
        useForScale: true,
        anchorQuality: 'medium',
        standardSizeConfidence: 0.86,
        confidence: 0.86,
        scaleDimensions: ['width'],
      });
    }
  }

  return anchors;
}

function categoricalScaleAnchorScore(value, scores, fallback) {
  const normalized = String(value || '').toLowerCase().replace(/\s+/g, '_');
  return scores[normalized] ?? fallback;
}

function getAnchorCandidateWeight(ref, dimension, quality) {
  const priority = ANCHOR_DIMENSION_PRIORITY[getReferenceProfileType(ref)]?.[dimension] ?? 0.75;
  const refinedBoost = ref?.deterministicRefined ? 1.25 : ref?.cropRefined ? 1.1 : 1;
  return Math.max(0.04, quality * priority * refinedBoost);
}

function isReferenceDimensionEnabled(ref, dimension) {
  const profileType = getReferenceProfileType(ref);
  const isExactKnownSceneAnchor = Boolean(ref?.knownSceneAnchorId) || ref?.source === 'known_scene_anchor';
  // GPT vanity family guesses often get the width family wrong (24 vs 30/32), which
  // destabilizes calibration. Keep exact user anchors and depth-backed auto vanity
  // widths, but suppress guessed fixed-family vanity widths from scale calibration.
  if (dimension === 'width' && /^bathroom_vanity_\d+$/i.test(profileType) && !isExactKnownSceneAnchor) {
    return false;
  }
  if (!Array.isArray(ref?.scaleDimensions) || ref.scaleDimensions.length === 0) return true;
  return ref.scaleDimensions.includes(dimension);
}

function scoreReferenceAnchor(ref, dimension) {
  if (ref?.useForScale === false) {
    return { usable: false, quality: 0, reason: 'vision_marked_not_for_scale' };
  }

  const profileType = getReferenceProfileType(ref);

  const bbox = ref?.boundingBox || {};
  const bboxArea = Math.max(0, Number(bbox.width || 0) * Number(bbox.height || 0));
  if (bboxArea <= 0) {
    return { usable: false, quality: 0, reason: 'missing_bbox' };
  }

  if (SMALL_FIXTURE_ANCHOR_TYPES.has(ref.type) && !ref?.geometryRefined && !ref?.deterministicRefined && !ref?.learnedDetectorRefined) {
    return { usable: false, quality: 0.12, reason: 'small_fixture_not_geometry_refined' };
  }

  const baseConfidence = clamp01(ref.confidence, 0.7);
  const standardSizeFallback = VARIABLE_STANDARD_ANCHOR_TYPES.has(profileType) ? 0.52 : 0.72;
  const standardSizeConfidence = clamp01(ref.standardSizeConfidence ?? ref.dimensionCertainty, standardSizeFallback);
  const anchorQualityScore = categoricalScaleAnchorScore(ref.anchorQuality || ref.scaleAnchorQuality, {
    high: 1,
    medium: 0.78,
    low: 0.42,
    reject: 0.12,
  }, 0.82);
  const visibilityScore = categoricalScaleAnchorScore(ref.visibility, {
    full: 1,
    full_visible: 1,
    mostly_visible: 0.86,
    partial: 0.48,
    partially_visible: 0.48,
    occluded: 0.25,
    cropped: 0.18,
  }, 0.75);
  const perspectiveScore = categoricalScaleAnchorScore(ref.perspective, {
    front_facing: 1,
    mild_angle: 0.82,
    angled: 0.65,
    strong_angle: 0.42,
    severe_angle: 0.25,
  }, 0.78);
  const profileScore = REFERENCE_ANCHOR_RELIABILITY[profileType]?.[dimension] ?? 0.45;
  let bboxScore = bboxArea < 0.0015 ? 0.35 : bboxArea < 0.004 ? 0.62 : bboxArea > 0.65 ? 0.55 : 1;
  if (SMALL_FIXTURE_ANCHOR_TYPES.has(ref.type)) {
    const width = Number(bbox.width || 0);
    const height = Number(bbox.height || 0);
    const plausibleSmallFixture = width >= 0.006 && width <= 0.08 && height >= 0.008 && height <= 0.12;
    bboxScore = plausibleSmallFixture ? 1 : Math.max(bboxScore, 0.55);
  }
  const dimensionBoost = dimension === 'height' ? 1.08 : 1;
  const quality = Math.min(1, baseConfidence * standardSizeConfidence * anchorQualityScore * visibilityScore * perspectiveScore * profileScore * bboxScore * dimensionBoost);

  if (quality < 0.22) {
    return { usable: false, quality, reason: 'low_anchor_quality' };
  }

  return {
    usable: true,
    quality,
    reason: null,
    components: {
      baseConfidence,
      standardSizeConfidence,
      anchorQualityScore,
      visibilityScore,
      perspectiveScore,
      profileScore,
      bboxScore,
    },
  };
}

function validateReferenceAspect(ref, known, measured) {
  if (!known?.width || !known?.height) {
    return { ok: true };
  }

  if (!measured?.widthInches || !measured?.heightInches) {
    return { ok: false, reason: 'fixture_dimension_missing' };
  }

  const widthScale = known.width / measured.widthInches;
  const heightScale = known.height / measured.heightInches;
  const scaleDisagreement = Math.max(widthScale, heightScale) / Math.max(0.001, Math.min(widthScale, heightScale));
  const perspectiveScore = categoricalScaleAnchorScore(ref.perspective, {
    front_facing: 1,
    mild_angle: 0.82,
    angled: 0.65,
    strong_angle: 0.42,
    severe_angle: 0.25,
  }, 0.78);
  let maxDisagreement = 1.65;
  if (SMALL_FIXTURE_ANCHOR_TYPES.has(ref?.type)) {
    maxDisagreement = perspectiveScore >= 0.82 ? 1.35 : 1.55;
  } else if ((ref?.type || '').includes('door')) {
    maxDisagreement = perspectiveScore >= 0.82 ? 1.55 : 1.75;
  } else if (VARIABLE_STANDARD_ANCHOR_TYPES.has(ref?.type)) {
    maxDisagreement = 1.85;
  }

  if (scaleDisagreement > maxDisagreement) {
    if (DOOR_ANCHOR_TYPES.has(ref?.type)) {
      return {
        ok: true,
        reason: 'door_width_aspect_inconsistent_height_only',
        widthScale,
        heightScale,
        scaleDisagreement,
        dimensionValidity: { height: true, width: false },
      };
    }

    return {
      ok: false,
      reason: SMALL_FIXTURE_ANCHOR_TYPES.has(ref?.type) ? 'fixture_aspect_inconsistent' : 'anchor_aspect_inconsistent',
      widthScale,
      heightScale,
      scaleDisagreement,
    };
  }

  return { ok: true, widthScale, heightScale, scaleDisagreement, dimensionValidity: { height: true, width: true } };
}

function validateReferencePhysicalPlausibility(ref, measured) {
  const type = ref?.type || '';
  const height = Number(measured?.heightInches || 0);
  const width = Number(measured?.widthInches || 0);
  const knownDimensions = getReferenceKnownDimensions(ref);

  if (type.startsWith('ceiling_height_')) {
    if (height < 72 || height > 132) {
      return { ok: false, reason: 'ceiling_height_projection_implausible', measuredHeightInches: height };
    }
  }

  if (SMALL_FIXTURE_ANCHOR_TYPES.has(type)) {
    if (height < 2 || height > 8 || width < 1.2 || width > 6.5) {
      return { ok: false, reason: 'small_fixture_size_implausible', measuredWidthInches: width, measuredHeightInches: height };
    }
  }

  if (DOOR_ANCHOR_TYPES.has(type) && height) {
    const knownHeight = knownDimensions?.height || REFERENCE_OBJECTS[type]?.height || 80;
    const impliedScale = knownHeight / Math.max(0.001, height);
    const surfaceMeasured = measured?.measurementMethod === 'door_surface_plane_rectified';
    if (surfaceMeasured && height >= 45 && height <= 260 && impliedScale >= CALIBRATION_SCALE_MIN && impliedScale <= CALIBRATION_SCALE_MAX) {
      return { ok: true, impliedScale };
    }
    if (height < 55 || height > 115) {
      return { ok: false, reason: 'door_height_projection_implausible', measuredHeightInches: height, impliedScale };
    }
  }

  return { ok: true };
}

function buildReferenceAnchorKey(ref, photoIndex = 'local') {
  const bbox = ref?.boundingBox || {};
  const centerX = Math.round(((Number(bbox.x || 0) + Number(bbox.width || 0) / 2) || 0) * 1000);
  const centerY = Math.round(((Number(bbox.y || 0) + Number(bbox.height || 0) / 2) || 0) * 1000);
  return `${photoIndex}:${ref?.type || 'unknown'}:${centerX}:${centerY}`;
}

function isReliableConsensusAnchor(item) {
  const type = item?.type || item?.ref || 'unknown';
  const quality = Number(item?.quality || 0);
  if (type === 'bathroom_vanity_auto') return quality >= 0.45;
  if (type === 'bathroom_mirror_auto') return quality >= 0.50;
  return quality >= 0.68;
}

function summarizeScaleConsensus(cluster) {
  const anchorKeys = new Set(cluster.map(item => item.anchorKey || `${item.photoIndex ?? 'local'}:${item.type || item.ref}:${item.dimension}`));
  const types = new Set(cluster.map(item => item.type || item.ref).filter(Boolean));
  const photos = new Set(cluster.map(item => item.photoIndex).filter(value => value !== undefined && value !== null));
  const dimensions = new Set(cluster.map(item => item.dimension).filter(Boolean));
  const fixtureOnly = cluster.every(item => SMALL_FIXTURE_ANCHOR_TYPES.has(item.type || item.ref));
  const reliableNonFixtureKeys = new Set(cluster
    .filter(item => !SMALL_FIXTURE_ANCHOR_TYPES.has(item.type || item.ref) && isReliableConsensusAnchor(item))
    .map(item => item.anchorKey || `${item.photoIndex ?? 'local'}:${item.type || item.ref}:${item.dimension}`));

  return {
    independentAnchorCount: anchorKeys.size,
    typeCount: types.size,
    photoCount: photos.size,
    dimensionCount: dimensions.size,
    fixtureOnly,
    reliableNonFixtureAnchorCount: reliableNonFixtureKeys.size,
    anchorTypes: [...types],
  };
}

function chooseRobustScaleCandidate(scaleFactors) {
  if (!scaleFactors.length) return null;

  const sorted = [...scaleFactors].sort((a, b) => a.scale - b.scale);
  let bestCluster = [];
  let bestWeight = -1;

  for (const candidate of sorted) {
    const cluster = sorted.filter(other => Math.abs(other.scale - candidate.scale) / Math.max(0.1, candidate.scale) <= 0.22);
    const clusterWeight = cluster.reduce((sum, item) => sum + item.weight, 0);
    if (clusterWeight > bestWeight || (clusterWeight === bestWeight && cluster.length > bestCluster.length)) {
      bestCluster = cluster;
      bestWeight = clusterWeight;
    }
  }

  if (!bestCluster.length) return null;

  const weightTotal = bestCluster.reduce((sum, item) => sum + item.weight, 0) || 1;
  const scale = bestCluster.reduce((sum, item) => sum + item.scale * item.weight, 0) / weightTotal;
  const vals = bestCluster.map(item => item.scale);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const spread = (max - min) / Math.max(0.1, scale);
  const consensus = summarizeScaleConsensus(bestCluster);
  let consistency = bestCluster.length < 2
    ? 'low'
    : spread < 0.15 ? 'high' : spread < 0.30 ? 'medium' : 'low';

  if (consensus.independentAnchorCount < 2) {
    consistency = 'low';
  }
  if (consensus.fixtureOnly) {
    consistency = 'low';
  }
  if (!consensus.fixtureOnly && consensus.reliableNonFixtureAnchorCount < 1 && consensus.independentAnchorCount < 3) {
    consistency = 'low';
  }

  return {
    scale,
    consistency,
    spread,
    consensus,
    cluster: bestCluster,
    rejectedOutliers: sorted.filter(item => !bestCluster.includes(item)),
  };
}

// ============================================================================
// EXIF Intrinsics Extraction
// ============================================================================
async function extractCameraIntrinsics(imageInput, imageWidth, imageHeight, imageRecord = null) {
  try {
    let exif = imageRecord?.originalExif || null;
    let metadataSource = exif ? 'original_exif' : null;

    if (!exif) {
      const buffer = await imageInputToBuffer(imageInput);
      exif = await exifr.parse(buffer, { pick: EXIF_PICK_FIELDS });
      metadataSource = exif ? 'exif' : null;
    }

    if (exif) {
      let focalLengthPx = null;
      let focalLength35mmConversion = null;
      let focalLengthCandidates = [];

      if (exif.FocalLengthIn35mmFormat) {
        const widthBasedPx = (exif.FocalLengthIn35mmFormat / 36) * imageWidth;
        const imageDiagonalPx = Math.sqrt(imageWidth ** 2 + imageHeight ** 2);
        const diagonalBasedPx = (exif.FocalLengthIn35mmFormat / FULL_FRAME_35MM_DIAGONAL_MM) * imageDiagonalPx;
        const longSideBasedPx = (exif.FocalLengthIn35mmFormat / 36) * Math.max(imageWidth, imageHeight);
        focalLengthPx = widthBasedPx;
        focalLength35mmConversion = 'image_width_36mm_model_aligned';
        focalLengthCandidates = [
          { model: 'image_width_36mm_model_aligned', fx: widthBasedPx },
          { model: 'image_diagonal_43mm_physical', fx: diagonalBasedPx },
          { model: 'long_side_36mm_physical_portrait', fx: longSideBasedPx },
        ];
        console.log(`[PhotoMeasurement] EXIF 35mm equiv: ${exif.FocalLengthIn35mmFormat}mm model-aligned → fx=${Math.round(focalLengthPx)}px`);
      } else if (exif.FocalLength && exif.FocalPlaneXResolution) {
        const sensorWidthMm = imageWidth / exif.FocalPlaneXResolution * 25.4;
        focalLengthPx = (exif.FocalLength / sensorWidthMm) * imageWidth;
        focalLength35mmConversion = 'focal_plane_resolution';
      } else if (exif.FocalLength && exif.Make) {
        const sensorWidth = estimateSensorWidth(exif.Make, exif.Model);
        if (sensorWidth) {
          focalLengthPx = (exif.FocalLength / sensorWidth) * imageWidth;
          focalLength35mmConversion = 'estimated_sensor_width';
        }
      }

      if (focalLengthPx && focalLengthPx > 100 && focalLengthPx < imageWidth * 5) {
        return {
          fx: focalLengthPx, fy: focalLengthPx,
          cx: imageWidth / 2, cy: imageHeight / 2,
          source: metadataSource || 'exif',
          metadataSource: imageRecord?.converted ? 'original_exif_after_backend_conversion' : metadataSource,
          camera: exif.Make ? `${exif.Make} ${exif.Model || ''}`.trim() : 'unknown',
          focalLength35mm: exif.FocalLengthIn35mmFormat || null,
          focalLengthMm: exif.FocalLength || null,
          orientation: exif.Orientation || null,
          focalLength35mmConversion,
          focalLengthCandidates,
        };
      }
    }
  } catch (err) {
    console.warn('[PhotoMeasurement] EXIF extraction failed:', err.message);
  }

  const assumed35mm = 26;
  const focalLengthPx = (assumed35mm / 36) * imageWidth;
  return {
    fx: focalLengthPx,
    fy: focalLengthPx,
    cx: imageWidth / 2,
    cy: imageHeight / 2,
    source: 'estimated',
    metadataSource: null,
    camera: 'unknown',
    focalLength35mm: assumed35mm,
  };
}

function estimateSensorWidth(make, model) {
  const m = (make || '').toLowerCase();
  const md = (model || '').toLowerCase();
  if (m.includes('apple')) {
    if (md.includes('15 pro') || md.includes('16')) return 9.8;
    if (md.includes('14 pro') || md.includes('15')) return 9.8;
    if (md.includes('13') || md.includes('14')) return 7.6;
    return 6.17;
  }
  if (m.includes('samsung')) return 8.0;
  if (m.includes('google'))  return 8.0;
  if (m.includes('canon'))   return 22.3;
  if (m.includes('nikon'))   return 23.5;
  if (m.includes('sony'))    return 23.5;
  return null;
}

// ============================================================================
// Depth Anything V3 Metric — Batch depth estimation (replaces old Metric3D)
// ============================================================================

/**
 * Run Depth Anything V3 Metric on all images in a single batch call.
 * Returns per-pixel depth arrays in meters for each image.
 */
async function runDepthEstimation(images, sourceDimensions = []) {
  const startTime = Date.now();
  const depthModelVersion = 'vufinder/depth-anything-v3-metric:d2ef7653aa75f87e3b502738a3f57ca2b09ba92f6f286075c8929a69937a013f';
  const normalizeDepthErrorMessage = (error) => String(error?.message || error || 'Unknown depth estimation error');
  const isRetryableDepthError = (error) => /prediction interrupted|code:\s*PA|502|503|504|bad gateway|gateway timeout|service unavailable|temporarily unavailable|econnreset|etimedout|socket hang up/i.test(normalizeDepthErrorMessage(error));
  const createFailedDepthResult = (photoIndex, error) => ({ ok: false, photoIndex, error });

  if (!REPLICATE_API_TOKEN) {
    console.warn('[PhotoMeasurement] No Replicate API token — skipping depth estimation');
    return { ok: false, error: 'No Replicate API token', perImage: [] };
  }

  try {
    // Prepare image URIs for the batch call
    const imageUris = images.map(img => {
      if (img.startsWith('https://') || img.startsWith('http://')) return img;
      if (img.startsWith('data:')) return img;
      return `data:image/jpeg;base64,${img}`;
    });

    const parseBatchOutput = async (output, batchDimensions, indexOffset = 0) => {
      const perImage = Array.from({ length: batchDimensions.length }, (_, localIndex) => (
        createFailedDepthResult(indexOffset + localIndex, 'No output for image')
      ));

      const parseDepthJsonUrl = async (jsonUrl, localIndex) => {
        const resp = await fetch(jsonUrl);
        const depthData = await resp.json();

        let depthArray = null;
        let height = 0;
        let width = 0;

        if (depthData.depth) {
          const b64 = typeof depthData.depth === 'string' ? depthData.depth : (depthData.depth.data || depthData.depth);
          const buf = Buffer.from(b64, 'base64');
          depthArray = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          height = depthData.shape?.[0] || 0;
          width = depthData.shape?.[1] || (height > 0 ? depthArray.length / height : 0);
        } else if (depthData.data) {
          const buf = Buffer.from(depthData.data, 'base64');
          depthArray = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          height = depthData.shape?.[0] || 0;
          width = depthData.shape?.[1] || 0;
        }

        if (!depthArray || depthArray.length === 0) {
          throw new Error('No depth array decoded');
        }

        const inferredShape = inferDepthDimensions(depthArray.length, depthData.shape, batchDimensions[localIndex]);
        height = inferredShape.height;
        width = inferredShape.width;

        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        let count = 0;
        for (let j = 0; j < depthArray.length; j++) {
          const v = depthArray[j];
          if (isFinite(v) && v > 0.1 && v < 20) {
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
            count++;
          }
        }
        const mean = count > 0 ? sum / count : 3.5;
        const globalPhotoIndex = indexOffset + localIndex;

        console.log(`[PhotoMeasurement] Image ${globalPhotoIndex}: ${width}×${height} (${inferredShape.source}), depth ${min.toFixed(2)}-${max.toFixed(2)}m, mean ${mean.toFixed(2)}m`);

        return {
          ok: true,
          photoIndex: globalPhotoIndex,
          depthArray,
          width,
          height,
          depthShapeSource: inferredShape.source,
          depthShapeUnusedValues: inferredShape.unusedValues,
          stats: { min, max, mean, count },
        };
      };

      if (output && output.data && Array.isArray(output.data)) {
        for (let localIndex = 0; localIndex < batchDimensions.length; localIndex++) {
          const jsonUrl = output.data[localIndex];
          if (!jsonUrl) {
            perImage[localIndex] = createFailedDepthResult(indexOffset + localIndex, 'Missing depth output URL');
            continue;
          }

          try {
            perImage[localIndex] = await parseDepthJsonUrl(jsonUrl, localIndex);
          } catch (parseErr) {
            console.warn(`[PhotoMeasurement] Image ${indexOffset + localIndex} parse error:`, parseErr.message);
            perImage[localIndex] = createFailedDepthResult(indexOffset + localIndex, parseErr.message);
          }
        }

        return perImage;
      }

      if (output && typeof output === 'object') {
        console.warn('[PhotoMeasurement] Unexpected DAv3 output structure:', JSON.stringify(output).substring(0, 500));
        const urls = Array.isArray(output) ? output : [];

        for (let localIndex = 0; localIndex < batchDimensions.length; localIndex++) {
          const url = typeof urls[localIndex] === 'string' ? urls[localIndex] : null;
          if (!url) {
            perImage[localIndex] = createFailedDepthResult(indexOffset + localIndex, 'Missing depth output URL');
            continue;
          }

          try {
            const resp = await fetch(url);
            const text = await resp.text();
            const depthData = JSON.parse(text);
            const b64 = depthData.depth || depthData.data;
            if (!b64) {
              throw new Error('Parse failed');
            }

            const buf = Buffer.from(b64, 'base64');
            const depthArray = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
            const inferredShape = inferDepthDimensions(depthArray.length, depthData.shape, batchDimensions[localIndex]);
            perImage[localIndex] = {
              ok: true,
              photoIndex: indexOffset + localIndex,
              depthArray,
              width: inferredShape.width,
              height: inferredShape.height,
              depthShapeSource: inferredShape.source,
              depthShapeUnusedValues: inferredShape.unusedValues,
              stats: {},
            };
          } catch (parseErr) {
            perImage[localIndex] = createFailedDepthResult(indexOffset + localIndex, parseErr.message || 'Parse failed');
          }
        }

        return perImage;
      }

      console.warn('[PhotoMeasurement] DAv3 returned no usable output');
      return batchDimensions.map((_, localIndex) => createFailedDepthResult(indexOffset + localIndex, 'No output from depth model'));
    };

    const runReplicateBatch = async (batchImageUris, batchDimensions, label = null) => {
      const labelSuffix = label ? ` (${label})` : '';
      console.log(`[PhotoMeasurement] Calling DAv3-Metric for ${batchImageUris.length} images${labelSuffix}...`);

      let output = null;
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const batchStartTime = Date.now();
          output = await replicate.run(
            depthModelVersion,
            {
              input: {
                images: batchImageUris,
                output_format: 'json',
                return_depth: true,
                to_base64: true,
              }
            }
          );
          console.log(`[PhotoMeasurement] DAv3-Metric returned in ${Date.now() - batchStartTime}ms${labelSuffix}`);
          return await parseBatchOutput(output, batchDimensions);
        } catch (error) {
          lastError = error;
          if (attempt < 2 && isRetryableDepthError(error)) {
            console.warn(`[PhotoMeasurement] DAv3-Metric transient failure on attempt ${attempt}${labelSuffix}: ${normalizeDepthErrorMessage(error)}. Retrying once...`);
            continue;
          }
          throw error;
        }
      }

      throw lastError || new Error('Unknown depth estimation error');
    };

    const estimateDepthBatch = async (batchImageUris, batchDimensions, indexOffset = 0) => {
      const batchLabel = batchImageUris.length === imageUris.length
        ? 'full batch'
        : `images ${indexOffset + 1}-${indexOffset + batchImageUris.length}`;

      try {
        const batchResults = await runReplicateBatch(batchImageUris, batchDimensions, batchLabel);
        return batchResults.map((entry, localIndex) => ({
          ...entry,
          photoIndex: indexOffset + localIndex,
        }));
      } catch (error) {
        const errorMessage = normalizeDepthErrorMessage(error);
        if (!isRetryableDepthError(error) || batchImageUris.length === 1) {
          if (batchImageUris.length === 1) {
            console.warn(`[PhotoMeasurement] DAv3-Metric single-image fallback failed for photo ${indexOffset}: ${errorMessage}`);
            return [createFailedDepthResult(indexOffset, errorMessage)];
          }
          throw error;
        }

        const splitPoint = Math.ceil(batchImageUris.length / 2);
        console.warn(`[PhotoMeasurement] DAv3-Metric batch ${indexOffset + 1}-${indexOffset + batchImageUris.length} failed (${errorMessage}); retrying as ${splitPoint}+${batchImageUris.length - splitPoint} image sub-batches...`);

        const leftResults = await estimateDepthBatch(
          batchImageUris.slice(0, splitPoint),
          batchDimensions.slice(0, splitPoint),
          indexOffset,
        );
        const rightResults = await estimateDepthBatch(
          batchImageUris.slice(splitPoint),
          batchDimensions.slice(splitPoint),
          indexOffset + splitPoint,
        );

        return [...leftResults, ...rightResults];
      }
    };

    const perImage = await estimateDepthBatch(imageUris, sourceDimensions, 0);
    return {
      ok: perImage.some(p => p.ok),
      perImage,
      processingTime: Date.now() - startTime,
      model: 'depth-anything-v3-metric',
    };
  } catch (error) {
    console.error('[PhotoMeasurement] DAv3-Metric error:', error.message);
    return { ok: false, error: error.message, perImage: [], processingTime: Date.now() - startTime };
  }
}

// ============================================================================
// Real per-pixel depth sampling (replaces old position-based heuristic)
// ============================================================================

/**
 * Sample REAL metric depth values at a bounding box region from the depth array.
 * Returns depth statistics in meters (median, min, max, mean).
 */
function sampleDepthAtBBox(depthResult, bbox, imageWidth, imageHeight) {
  if (!depthResult?.ok || !depthResult.depthArray) {
    // Fallback: position-based heuristic (when depth model fails)
    return fallbackDepthEstimate(bbox);
  }

  const da = depthResult.depthArray;
  const dW = depthResult.width;
  const dH = depthResult.height;

  // Map normalized bbox coords [0-1] to depth array pixel coords
  const x1 = Math.max(0, Math.floor(bbox.x * dW));
  const y1 = Math.max(0, Math.floor(bbox.y * dH));
  const x2 = Math.min(dW - 1, Math.floor((bbox.x + bbox.width) * dW));
  const y2 = Math.min(dH - 1, Math.floor((bbox.y + bbox.height) * dH));

  // Sample the center 60% of the bbox (avoid edge artifacts at boundaries)
  const padX = Math.floor((x2 - x1) * 0.2);
  const padY = Math.floor((y2 - y1) * 0.2);
  const sx1 = x1 + padX, sx2 = x2 - padX;
  const sy1 = y1 + padY, sy2 = y2 - padY;

  const samples = [];
  for (let y = sy1; y <= sy2; y++) {
    for (let x = sx1; x <= sx2; x++) {
      const idx = y * dW + x;
      if (idx >= 0 && idx < da.length) {
        const v = da[idx];
        if (isFinite(v) && v > 0.1 && v < 20) samples.push(v);
      }
    }
  }

  if (samples.length === 0) return fallbackDepthEstimate(bbox);

  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const min = samples[0];
  const max = samples[samples.length - 1];
  const p10 = samples[Math.floor(samples.length * 0.10)];
  const p25 = samples[Math.floor(samples.length * 0.25)];
  const p75 = samples[Math.floor(samples.length * 0.75)];
  const p90 = samples[Math.floor(samples.length * 0.90)];
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;

  return { medianDepth: median, minDepth: min, maxDepth: max, p10Depth: p10, p25Depth: p25, p75Depth: p75, p90Depth: p90, meanDepth: mean, sampleCount: samples.length, source: 'dav3_metric' };
}

/**
 * Fallback depth estimate using position-based heuristic.
 * Only used when the depth model completely fails for an image.
 */
function fallbackDepthEstimate(bbox) {
  const centerY = bbox.y + bbox.height / 2;
  const centerX = bbox.x + bbox.width / 2;
  const baseDepth = 3.5;
  const yFactor = Math.abs(centerY - 0.5) * 2;
  const xFactor = Math.abs(centerX - 0.5) * 2;
  const positionFactor = Math.max(yFactor, xFactor);
  const estimatedDepth = baseDepth * (1 - positionFactor * 0.6);
  return {
    medianDepth: Math.max(0.5, estimatedDepth),
    minDepth: Math.max(0.3, estimatedDepth * 0.8),
    maxDepth: estimatedDepth * 1.2,
    meanDepth: Math.max(0.5, estimatedDepth),
    sampleCount: 0,
    source: 'position_heuristic',
  };
}

/**
 * Sample depth across key regions of the image for room dimension extraction.
 * Returns depth-to-wall estimates for far wall, side walls, and floor.
 */
function sampleRoomDepths(depthResult) {
  if (!depthResult?.ok || !depthResult.depthArray) return null;

  const da = depthResult.depthArray;
  const W = depthResult.width;
  const H = depthResult.height;

  const collectSamples = (yStart, yEnd, xStart, xEnd) => {
    const s = [];
    for (let y = Math.floor(H * yStart); y < Math.floor(H * yEnd); y++) {
      for (let x = Math.floor(W * xStart); x < Math.floor(W * xEnd); x++) {
        const v = da[y * W + x];
        if (isFinite(v) && v > 0.3 && v < 15) s.push(v);
      }
    }
    return s;
  };

  const median = arr => { if (!arr.length) return null; arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)]; };

  // Far wall: center horizontal band (35-65% height, 25-75% width)
  const farWallSamples = collectSamples(0.35, 0.65, 0.25, 0.75);
  // Left wall: left 10% of frame, middle 60% of height
  const leftWallSamples = collectSamples(0.2, 0.8, 0.0, 0.1);
  // Right wall: right 10% of frame
  const rightWallSamples = collectSamples(0.2, 0.8, 0.9, 1.0);
  // Floor: bottom 20%, center 40%
  const floorSamples = collectSamples(0.8, 1.0, 0.3, 0.7);
  // Ceiling: top 15%, center 40%
  const ceilingSamples = collectSamples(0.0, 0.15, 0.3, 0.7);

  return {
    farWallDepth: median(farWallSamples),
    leftWallDepth: median(leftWallSamples),
    rightWallDepth: median(rightWallSamples),
    floorDepth: median(floorSamples),
    ceilingDepth: median(ceilingSamples),
    farWallCount: farWallSamples.length,
    leftWallCount: leftWallSamples.length,
    rightWallCount: rightWallSamples.length,
    floorCount: floorSamples.length,
    ceilingCount: ceilingSamples.length,
  };
}

function percentile(values, p) {
  if (!values?.length) return null;
  const arr = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(arr.length - 1, Math.floor((arr.length - 1) * p)));
  return arr[idx];
}

function backProjectToCamera(u, v, z, intrinsics) {
  const x = ((u - intrinsics.cx) * z) / intrinsics.fx;
  const y = ((v - intrinsics.cy) * z) / intrinsics.fy;
  return { x, y, z };
}

function collectRegionPoints(depthResult, intrinsics, yStart, yEnd, xStart, xEnd, stride = 2) {
  if (!depthResult?.ok || !depthResult.depthArray) return [];

  const pts = [];
  const da = depthResult.depthArray;
  const W = depthResult.width;
  const H = depthResult.height;
  const ys = Math.max(0, Math.floor(H * yStart));
  const ye = Math.min(H, Math.floor(H * yEnd));
  const xs = Math.max(0, Math.floor(W * xStart));
  const xe = Math.min(W, Math.floor(W * xEnd));

  for (let y = ys; y < ye; y += stride) {
    for (let x = xs; x < xe; x += stride) {
      const z = da[y * W + x];
      if (!isFinite(z) || z <= 0.3 || z >= 15) continue;
      pts.push(backProjectToCamera(x, y, z, intrinsics));
    }
  }
  return pts;
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(v) {
  const n = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function planeFromThreePoints(p1, p2, p3) {
  const v1 = subtract(p2, p1);
  const v2 = subtract(p3, p1);
  let n = cross(v1, v2);
  const mag = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
  if (!isFinite(mag) || mag < 1e-6) return null;
  n = normalize(n);
  const d = -(n.x * p1.x + n.y * p1.y + n.z * p1.z);
  return { normal: n, d };
}

function pointPlaneDistance(point, plane) {
  return Math.abs(dot(plane.normal, point) + plane.d);
}

function fitPlaneRansac(points, { iterations = 80, threshold = 0.08, minInliers = 40 } = {}) {
  if (!points || points.length < 3) return null;

  let best = null;
  for (let i = 0; i < iterations; i++) {
    const a = points[Math.floor(Math.random() * points.length)];
    const b = points[Math.floor(Math.random() * points.length)];
    const c = points[Math.floor(Math.random() * points.length)];
    const plane = planeFromThreePoints(a, b, c);
    if (!plane) continue;

    const inliers = [];
    for (const p of points) {
      if (pointPlaneDistance(p, plane) <= threshold) inliers.push(p);
    }
    if (!best || inliers.length > best.inliers.length) {
      best = { ...plane, inliers };
    }
  }

  if (!best || best.inliers.length < minInliers) return null;
  return {
    normal: best.normal,
    d: best.d,
    inlierCount: best.inliers.length,
    inliers: best.inliers,
  };
}

function estimateRoomGeometryFromPlanes(depthResult, intrinsics, scaleFactor) {
  if (!depthResult?.ok || !depthResult.depthArray) return null;

  const floorPts = collectRegionPoints(depthResult, intrinsics, 0.72, 0.98, 0.2, 0.8, 2);
  const ceilingPts = collectRegionPoints(depthResult, intrinsics, 0.02, 0.20, 0.2, 0.8, 2);
  const farWallPts = collectRegionPoints(depthResult, intrinsics, 0.30, 0.70, 0.2, 0.8, 2);

  const floorPlane = fitPlaneRansac(floorPts, { threshold: 0.10, minInliers: 60 });
  const ceilingPlane = fitPlaneRansac(ceilingPts, { threshold: 0.10, minInliers: 60 });
  const farWallPlane = fitPlaneRansac(farWallPts, { threshold: 0.12, minInliers: 80 });

  let heightM = null;
  if (floorPlane && ceilingPlane) {
    const floorN = floorPlane.normal.y > 0 ? { x: -floorPlane.normal.x, y: -floorPlane.normal.y, z: -floorPlane.normal.z } : floorPlane.normal;
    const ceilN = ceilingPlane.normal.y > 0 ? ceilingPlane.normal : { x: -ceilingPlane.normal.x, y: -ceilingPlane.normal.y, z: -ceilingPlane.normal.z };
    const parallelScore = Math.abs(dot(floorN, ceilN));
    if (parallelScore > 0.85) {
      const n = normalize({
        x: (floorN.x + ceilN.x) / 2,
        y: (floorN.y + ceilN.y) / 2,
        z: (floorN.z + ceilN.z) / 2,
      });
      const d1 = floorPlane.d;
      const d2 = ceilingPlane.d;
      heightM = Math.abs((d2 - d1) / Math.max(1e-6, Math.sqrt(dot(n, n))));
    }
  }

  let widthM = null;
  let lengthM = null;

  if (farWallPlane && farWallPlane.inliers.length > 80) {
    const zVals = farWallPlane.inliers.map(p => p.z);
    const xVals = farWallPlane.inliers.map(p => p.x);
    const farZ = percentile(zVals, 0.5);
    const xLow = percentile(xVals, 0.10);
    const xHigh = percentile(xVals, 0.90);
    if (farZ) lengthM = farZ * scaleFactor;
    if (xLow != null && xHigh != null) widthM = Math.max(0, (xHigh - xLow) * scaleFactor);
  }

  return {
    widthFt: widthM ? widthM * 3.28084 : null,
    lengthFt: lengthM ? lengthM * 3.28084 : null,
    heightFt: heightM ? heightM * 3.28084 : null,
    diagnostics: {
      floorInliers: floorPlane?.inlierCount || 0,
      ceilingInliers: ceilingPlane?.inlierCount || 0,
      farWallInliers: farWallPlane?.inlierCount || 0,
    },
  };
}

// ============================================================================
// Pinhole camera model — convert pixel + depth → real-world size
// ============================================================================
function calculateBBoxDimensions(depthStats, bbox, imageWidth, imageHeight, intrinsics) {
  const pixelWidth = bbox.width * imageWidth;
  const pixelHeight = bbox.height * imageHeight;
  const depthMeters = depthStats.medianDepth;
  if (!depthMeters || depthMeters <= 0) return null;

  const realWidthM = (pixelWidth * depthMeters) / intrinsics.fx;
  const realHeightM = (pixelHeight * depthMeters) / intrinsics.fy;

  // Estimate object physical depth (front-to-back) from depth variance within bbox.
  // Objects protruding from a wall (cabinets, appliances) show a depth range where
  // the front face is closer to camera than the wall behind. The difference = object depth.
  let objectDepthInches = null;
  if (depthStats.minDepth && depthStats.maxDepth && depthStats.maxDepth > depthStats.minDepth) {
    const depthDiffM = depthStats.maxDepth - depthStats.minDepth;
    // Only report if the depth range is physically reasonable (2-40 inches)
    const depthDiffInches = depthDiffM * 39.3701;
    if (depthDiffInches >= 2 && depthDiffInches <= 40) {
      objectDepthInches = Math.round(depthDiffInches * 10) / 10;
    }
  }

  return {
    widthInches: Math.round(realWidthM * 39.3701 * 10) / 10,
    heightInches: Math.round(realHeightM * 39.3701 * 10) / 10,
    widthFeet: Math.round(realWidthM * 3.28084 * 10) / 10,
    heightFeet: Math.round(realHeightM * 3.28084 * 10) / 10,
    depthMeters: Math.round(depthMeters * 100) / 100,
    depthInches: objectDepthInches,
  };
}

function expandNormalizedBox(bbox, padX, padY) {
  const x = Math.max(0, Number(bbox.x || 0) - padX);
  const y = Math.max(0, Number(bbox.y || 0) - padY);
  const right = Math.min(1, Number(bbox.x || 0) + Number(bbox.width || 0) + padX);
  const bottom = Math.min(1, Number(bbox.y || 0) + Number(bbox.height || 0) + padY);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function collectLocalWallPointsAroundBBox(depthResult, intrinsics, bbox) {
  if (!depthResult?.ok || !depthResult.depthArray) return [];

  const W = depthResult.width;
  const H = depthResult.height;
  const da = depthResult.depthArray;
  const padX = Math.max(0.08, Number(bbox.width || 0) * 4.5);
  const padY = Math.max(0.08, Number(bbox.height || 0) * 4.5);
  const region = expandNormalizedBox(bbox, padX, padY);
  const exclude = expandNormalizedBox(bbox, Math.max(0.01, Number(bbox.width || 0) * 0.8), Math.max(0.01, Number(bbox.height || 0) * 0.8));
  const x1 = Math.max(0, Math.floor(region.x * W));
  const y1 = Math.max(0, Math.floor(region.y * H));
  const x2 = Math.min(W - 1, Math.ceil((region.x + region.width) * W));
  const y2 = Math.min(H - 1, Math.ceil((region.y + region.height) * H));
  const ex1 = Math.max(0, Math.floor(exclude.x * W));
  const ey1 = Math.max(0, Math.floor(exclude.y * H));
  const ex2 = Math.min(W - 1, Math.ceil((exclude.x + exclude.width) * W));
  const ey2 = Math.min(H - 1, Math.ceil((exclude.y + exclude.height) * H));
  const points = [];
  const stride = Math.max(1, Math.floor(Math.min(x2 - x1, y2 - y1) / 55));

  for (let y = y1; y <= y2; y += stride) {
    for (let x = x1; x <= x2; x += stride) {
      if (x >= ex1 && x <= ex2 && y >= ey1 && y <= ey2) continue;
      const z = da[y * W + x];
      if (!isFinite(z) || z <= 0.3 || z >= 12) continue;
      points.push(backProjectToCamera(x, y, z, intrinsics));
    }
  }
  return points;
}

function fitLocalWallPlaneAroundBBox(depthResult, intrinsics, bbox) {
  const points = collectLocalWallPointsAroundBBox(depthResult, intrinsics, bbox);
  if (points.length < 35) return null;
  const plane = fitPlaneRansac(points, { iterations: 100, threshold: 0.07, minInliers: Math.min(45, Math.max(25, Math.floor(points.length * 0.35))) });
  if (!plane) return null;
  if (Math.abs(plane.normal.y) > 0.70) return null;
  return {
    ...plane,
    pointCount: points.length,
    inlierRatio: plane.inlierCount / points.length,
  };
}

function collectPlanarSurfacePointsInsideBBox(depthResult, intrinsics, bbox) {
  if (!depthResult?.ok || !depthResult.depthArray) return [];

  const W = depthResult.width;
  const H = depthResult.height;
  const da = depthResult.depthArray;
  const box = clampNormalizedBox(bbox || {});
  const x1 = Math.max(0, Math.floor((box.x + box.width * 0.12) * W));
  const y1 = Math.max(0, Math.floor((box.y + box.height * 0.08) * H));
  const x2 = Math.min(W - 1, Math.ceil((box.x + box.width * 0.88) * W));
  const y2 = Math.min(H - 1, Math.ceil((box.y + box.height * 0.92) * H));
  const points = [];
  const stride = Math.max(1, Math.floor(Math.min(Math.max(1, x2 - x1), Math.max(1, y2 - y1)) / 70));

  for (let y = y1; y <= y2; y += stride) {
    for (let x = x1; x <= x2; x += stride) {
      const z = da[y * W + x];
      if (!isFinite(z) || z <= 0.3 || z >= 15) continue;
      points.push(backProjectToCamera(x, y, z, intrinsics));
    }
  }
  return points;
}

function fitPlanarSurfaceInsideBBox(depthResult, intrinsics, bbox) {
  const points = collectPlanarSurfacePointsInsideBBox(depthResult, intrinsics, bbox);
  if (points.length < 40) return null;
  const minInliers = Math.min(120, Math.max(35, Math.floor(points.length * 0.38)));
  const plane = fitPlaneRansac(points, { iterations: 120, threshold: 0.075, minInliers });
  if (!plane) return null;
  if (Math.abs(plane.normal.y) > 0.78) return null;
  return {
    ...plane,
    pointCount: points.length,
    inlierRatio: plane.inlierCount / points.length,
  };
}

function fitHorizontalSurfaceInsideBBox(depthResult, intrinsics, bbox) {
  const points = collectPlanarSurfacePointsInsideBBox(depthResult, intrinsics, bbox);
  if (points.length < 35) return null;
  const minInliers = Math.min(120, Math.max(30, Math.floor(points.length * 0.34)));
  const plane = fitPlaneRansac(points, { iterations: 120, threshold: 0.06, minInliers });
  if (!plane) return null;
  if (Math.abs(plane.normal.y) < 0.55) return null;
  return {
    ...plane,
    pointCount: points.length,
    inlierRatio: plane.inlierCount / points.length,
  };
}

function sampleSurroundingWallDepthAtBBox(depthResult, bbox) {
  if (!depthResult?.ok || !depthResult.depthArray) return null;
  const W = depthResult.width;
  const H = depthResult.height;
  const da = depthResult.depthArray;
  const padX = Math.max(0.07, Number(bbox.width || 0) * 5);
  const padY = Math.max(0.06, Number(bbox.height || 0) * 4);
  const region = expandNormalizedBox(bbox, padX, padY);
  const exclude = expandNormalizedBox(bbox, Math.max(0.012, Number(bbox.width || 0) * 0.9), Math.max(0.012, Number(bbox.height || 0) * 0.9));
  const x1 = Math.max(0, Math.floor(region.x * W));
  const y1 = Math.max(0, Math.floor(region.y * H));
  const x2 = Math.min(W - 1, Math.ceil((region.x + region.width) * W));
  const y2 = Math.min(H - 1, Math.ceil((region.y + region.height) * H));
  const ex1 = Math.max(0, Math.floor(exclude.x * W));
  const ey1 = Math.max(0, Math.floor(exclude.y * H));
  const ex2 = Math.min(W - 1, Math.ceil((exclude.x + exclude.width) * W));
  const ey2 = Math.min(H - 1, Math.ceil((exclude.y + exclude.height) * H));
  const lowerWallLimit = Math.min(H - 1, Math.ceil((Number(bbox.y || 0) + Number(bbox.height || 0) * 1.5 + 0.012) * H));
  const samples = [];

  for (let y = y1; y <= Math.min(y2, lowerWallLimit); y++) {
    for (let x = x1; x <= x2; x++) {
      if (x >= ex1 && x <= ex2 && y >= ey1 && y <= ey2) continue;
      const v = da[y * W + x];
      if (isFinite(v) && v > 0.3 && v < 12) samples.push(v);
    }
  }

  if (samples.length < 12) return null;
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const low = samples[Math.floor(samples.length * 0.15)];
  const high = samples[Math.floor(samples.length * 0.85)];
  return {
    medianDepth: median,
    minDepth: low,
    maxDepth: high,
    meanDepth: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    sampleCount: samples.length,
    source: 'surrounding_wall_depth',
  };
}

function intersectImageRayWithPlane(u, v, intrinsics, plane) {
  const ray = backProjectToCamera(u, v, 1, intrinsics);
  const denom = dot(plane.normal, ray);
  if (!isFinite(denom) || Math.abs(denom) < 1e-6) return null;
  const t = -plane.d / denom;
  if (!isFinite(t) || t <= 0) return null;
  return { x: ray.x * t, y: ray.y * t, z: ray.z * t };
}

function distance3d(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function calculateBBoxDimensionsOnPlane(bbox, imageWidth, imageHeight, intrinsics, plane) {
  const left = Number(bbox.x || 0) * imageWidth;
  const top = Number(bbox.y || 0) * imageHeight;
  const right = (Number(bbox.x || 0) + Number(bbox.width || 0)) * imageWidth;
  const bottom = (Number(bbox.y || 0) + Number(bbox.height || 0)) * imageHeight;
  const tl = intersectImageRayWithPlane(left, top, intrinsics, plane);
  const tr = intersectImageRayWithPlane(right, top, intrinsics, plane);
  const bl = intersectImageRayWithPlane(left, bottom, intrinsics, plane);
  const br = intersectImageRayWithPlane(right, bottom, intrinsics, plane);
  if (!tl || !tr || !bl || !br) return null;

  const widthM = (distance3d(tl, tr) + distance3d(bl, br)) / 2;
  const heightM = (distance3d(tl, bl) + distance3d(tr, br)) / 2;
  const center = intersectImageRayWithPlane((left + right) / 2, (top + bottom) / 2, intrinsics, plane);
  if (!isFinite(widthM) || !isFinite(heightM) || widthM <= 0 || heightM <= 0) return null;

  return {
    widthInches: Math.round(widthM * 39.3701 * 10) / 10,
    heightInches: Math.round(heightM * 39.3701 * 10) / 10,
    widthFeet: Math.round(widthM * 3.28084 * 10) / 10,
    heightFeet: Math.round(heightM * 3.28084 * 10) / 10,
    depthMeters: center?.z ? Math.round(center.z * 100) / 100 : null,
    depthInches: null,
    measurementMethod: 'local_wall_plane_rectified',
    wallPlaneDiagnostics: {
      inliers: plane.inlierCount,
      pointCount: plane.pointCount,
      inlierRatio: Math.round(plane.inlierRatio * 100) / 100,
    },
  };
}

function shouldMeasureOnLocalWallPlane(ref) {
  return SMALL_FIXTURE_ANCHOR_TYPES.has(ref?.type) || DOOR_ANCHOR_TYPES.has(ref?.type) || ref?.type === 'baseboard' || ref?.type === 'standard_window' || ref?.type === 'double_window';
}

function measureReferenceObject(ref, depthResult, imageWidth, imageHeight, intrinsics) {
  const depthStats = sampleDepthAtBBox(depthResult, ref.boundingBox, imageWidth, imageHeight);
  if (!depthStats) return null;

  let measured = calculateBBoxDimensions(depthStats, ref.boundingBox, imageWidth, imageHeight, intrinsics);
  let measurementDepthStats = depthStats;

  if (ref?.sourceTargetType) {
    const targetMeasurement = measureTargetObject({
      targetType: ref.sourceTargetType,
      boundingBox: ref.boundingBox,
    }, depthResult, imageWidth, imageHeight, intrinsics, 1);
    if (targetMeasurement?.dimensions) {
      measured = targetMeasurement.dimensions;
      measurementDepthStats = targetMeasurement.depthStats || depthStats;
    }
  }

  if (FLOOR_TILE_ANCHOR_TYPES.has(ref?.type)) {
    const floorPlane = fitHorizontalSurfaceInsideBBox(depthResult, intrinsics, ref.boundingBox);
    const floorMeasured = floorPlane ? calculateBBoxDimensionsOnPlane(ref.boundingBox, imageWidth, imageHeight, intrinsics, floorPlane) : null;
    if (floorMeasured) {
      measured = {
        ...floorMeasured,
        measurementMethod: 'floor_surface_plane_rectified',
        wallPlaneDiagnostics: floorMeasured.wallPlaneDiagnostics,
      };
      measurementDepthStats = {
        ...depthStats,
        source: 'floor_surface_plane',
        medianDepth: floorMeasured.depthMeters || depthStats.medianDepth,
        wallPlaneDiagnostics: floorMeasured.wallPlaneDiagnostics,
      };
    }
  }

  if (DOOR_ANCHOR_TYPES.has(ref?.type)) {
    const surfacePlane = fitPlanarSurfaceInsideBBox(depthResult, intrinsics, ref.boundingBox);
    const surfaceMeasured = surfacePlane ? calculateBBoxDimensionsOnPlane(ref.boundingBox, imageWidth, imageHeight, intrinsics, surfacePlane) : null;
    if (surfaceMeasured) {
      measured = {
        ...surfaceMeasured,
        measurementMethod: 'door_surface_plane_rectified',
        wallPlaneDiagnostics: surfaceMeasured.wallPlaneDiagnostics,
      };
      measurementDepthStats = {
        ...depthStats,
        source: 'door_surface_plane',
        medianDepth: surfaceMeasured.depthMeters || depthStats.medianDepth,
        wallPlaneDiagnostics: surfaceMeasured.wallPlaneDiagnostics,
      };
    }
  }

  if (shouldMeasureOnLocalWallPlane(ref)) {
    const surroundingDepth = sampleSurroundingWallDepthAtBBox(depthResult, ref.boundingBox);
    const surroundingMeasured = surroundingDepth
      ? calculateBBoxDimensions(surroundingDepth, ref.boundingBox, imageWidth, imageHeight, intrinsics)
      : null;
    const plane = fitLocalWallPlaneAroundBBox(depthResult, intrinsics, ref.boundingBox);
    const planar = plane ? calculateBBoxDimensionsOnPlane(ref.boundingBox, imageWidth, imageHeight, intrinsics, plane) : null;
    const known = REFERENCE_OBJECTS[ref.type];
    const planarAspectCheck = planar && known?.width && known?.height
      ? validateReferenceAspect(ref, known, planar)
      : { ok: true };

    const hasDoorSurfaceMeasurement = DOOR_ANCHOR_TYPES.has(ref?.type) && measured?.measurementMethod?.includes('door_surface');
    if (!hasDoorSurfaceMeasurement && planar && planarAspectCheck.ok) {
      measured = planar;
      measurementDepthStats = {
        ...depthStats,
        source: 'local_wall_plane',
        medianDepth: planar.depthMeters || depthStats.medianDepth,
        wallPlaneDiagnostics: planar.wallPlaneDiagnostics,
      };
    } else if (!hasDoorSurfaceMeasurement && surroundingMeasured) {
      measured = {
        ...surroundingMeasured,
        measurementMethod: 'surrounding_wall_depth_pinhole',
      };
      measurementDepthStats = surroundingDepth;
    }
  }

  return measured ? { depthStats: measurementDepthStats, measured } : null;
}

function roundTenth(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function scaleObjectDimensions(dimensions, scaleFactor = 1) {
  const scale = Number.isFinite(Number(scaleFactor)) && Number(scaleFactor) > 0 ? Number(scaleFactor) : 1;
  return {
    ...dimensions,
    widthInches: roundTenth((dimensions.widthInches || 0) * scale),
    heightInches: roundTenth((dimensions.heightInches || 0) * scale),
    widthFeet: roundTenth((dimensions.widthFeet || 0) * scale),
    heightFeet: roundTenth((dimensions.heightFeet || 0) * scale),
    depthInches: dimensions.depthInches ? roundTenth(dimensions.depthInches * scale) : dimensions.depthInches,
  };
}

function buildFrontFaceDepthStats(depthStats) {
  if (!depthStats?.medianDepth) return null;
  const p25 = depthStats.p25Depth || depthStats.medianDepth;
  const p10 = depthStats.p10Depth || depthStats.minDepth || p25;
  const p90 = depthStats.p90Depth || depthStats.maxDepth || depthStats.medianDepth;
  const spread = Math.max(0, p90 - p10);
  const selectedDepth = spread >= 0.18 ? p25 : depthStats.medianDepth;
  if (!selectedDepth || selectedDepth <= 0) return null;

  return {
    ...depthStats,
    medianDepth: selectedDepth,
    source: 'front_face_depth',
    selectedDepthPercentile: spread >= 0.18 ? 'p25' : 'median',
    originalMedianDepth: depthStats.medianDepth,
    depthSpreadMeters: roundTenth(spread),
  };
}

function isObjectCandidateBroadlyPlausible(targetType, dimensions) {
  const width = Number(dimensions?.widthInches || 0);
  const height = Number(dimensions?.heightInches || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0.5 || height <= 0.5) return false;

  const limits = OBJECT_DIMENSION_LIMITS[targetType];
  if (!limits) return true;
  if (limits.minW && width < limits.minW * 0.35) return false;
  if (limits.maxW && width > limits.maxW * 2.25) return false;
  if (limits.minH && height < limits.minH * 0.35) return false;
  if (limits.maxH && height > limits.maxH * 2.25) return false;
  return true;
}

function applyObjectDimensionSanity(targetType, dimensions) {
  const limits = OBJECT_DIMENSION_LIMITS[targetType];
  const adjusted = { ...dimensions };
  const reasons = [];

  if (!limits) {
    return { dimensions: adjusted, sanityClamped: false, reasons };
  }

  if (limits.minH && adjusted.heightInches < limits.minH) {
    adjusted.heightInches = limits.minH;
    adjusted.heightFeet = roundTenth(limits.minH / 12);
    reasons.push('height_below_expected');
  }
  if (limits.maxH && adjusted.heightInches > limits.maxH) {
    adjusted.heightInches = limits.maxH;
    adjusted.heightFeet = roundTenth(limits.maxH / 12);
    reasons.push('height_above_expected');
  }
  if (limits.minW && adjusted.widthInches < limits.minW) {
    adjusted.widthInches = limits.minW;
    adjusted.widthFeet = roundTenth(limits.minW / 12);
    reasons.push('width_below_expected');
  }
  if (limits.maxW && adjusted.widthInches > limits.maxW) {
    adjusted.widthInches = limits.maxW;
    adjusted.widthFeet = roundTenth(limits.maxW / 12);
    reasons.push('width_above_expected');
  }

  return { dimensions: adjusted, sanityClamped: reasons.length > 0, reasons };
}

function buildObjectMeasurementCandidate(method, dimensions, depthStats, extra = {}, scaleFactor = 1) {
  if (!dimensions) return null;
  return {
    method,
    dimensions: {
      ...scaleObjectDimensions(dimensions, scaleFactor),
      measurementMethod: method,
    },
    depthStats,
    ...extra,
  };
}

function isUnrefinedUnanchoredMirrorTarget(target) {
  return target?.targetType === 'bathroom_mirror' && isWeakLocalGeometryTarget(target);
}

function shouldUseSoftLocalBathroomScaleHint(target, photo, calibration) {
  if (calibration?.calibrated) return false;
  if (!(calibration?.softLocalToiletScaleHint?.scaleFactor > 0)) return false;
  if (String(photo?.roomType || '').toLowerCase() !== 'bathroom') return false;
  return ['bathroom_mirror', 'existing_vanity', 'shower_door_opening', 'existing_bathtub'].includes(target?.targetType);
}

function getObjectCandidateSanityPenalty(targetType, dimensions) {
  if (!dimensions) return { score: Number.POSITIVE_INFINITY, sanityClamped: true, reasons: [] };

  const sanity = applyObjectDimensionSanity(targetType, dimensions);
  let score = sanity.reasons.length * 1.6;
  const originalWidth = Number(dimensions.widthInches || 0);
  const originalHeight = Number(dimensions.heightInches || 0);
  const adjustedWidth = Number(sanity.dimensions.widthInches || originalWidth || 0);
  const adjustedHeight = Number(sanity.dimensions.heightInches || originalHeight || 0);

  if (originalWidth > 0 && adjustedWidth > 0) {
    score += Math.abs(adjustedWidth - originalWidth) / Math.max(originalWidth, adjustedWidth, 1);
  }
  if (originalHeight > 0 && adjustedHeight > 0) {
    score += Math.abs(adjustedHeight - originalHeight) / Math.max(originalHeight, adjustedHeight, 1);
  }

  const limits = OBJECT_DIMENSION_LIMITS[targetType];
  if (limits) {
    if (limits.maxW && originalWidth >= limits.maxW * 0.95) {
      score += Math.min(1, (originalWidth - limits.maxW * 0.95) / Math.max(limits.maxW * 0.05, 1)) * 0.75;
    }
    if (limits.minW && originalWidth <= limits.minW * 1.05) {
      score += Math.min(1, (limits.minW * 1.05 - originalWidth) / Math.max(limits.minW * 0.05, 1)) * 0.55;
    }
    if (limits.maxH && originalHeight >= limits.maxH * 0.95) {
      score += Math.min(1, (originalHeight - limits.maxH * 0.95) / Math.max(limits.maxH * 0.05, 1)) * 0.75;
    }
    if (limits.minH && originalHeight <= limits.minH * 1.05) {
      score += Math.min(1, (limits.minH * 1.05 - originalHeight) / Math.max(limits.minH * 0.05, 1)) * 0.55;
    }
  }

  return {
    score,
    sanityClamped: sanity.sanityClamped,
    reasons: sanity.reasons,
  };
}

function measureTargetObject(target, depthResult, imageWidth, imageHeight, intrinsics, scaleFactor = 1) {
  const bbox = clampNormalizedBox(target?.boundingBox || {});
  if (!isValidNormalizedBox(bbox)) return null;

  const depthStats = sampleDepthAtBBox(depthResult, bbox, imageWidth, imageHeight);
  if (!depthStats) return null;

  const baseDimensions = calculateBBoxDimensions(depthStats, bbox, imageWidth, imageHeight, intrinsics);
  const baseCandidate = buildObjectMeasurementCandidate('bbox_center_depth_pinhole', baseDimensions, depthStats, {}, scaleFactor);
  if (!baseCandidate) return null;

  const candidates = [baseCandidate];
  const targetType = target?.targetType;

  if (supportsFrontFaceObjectMeasurement(targetType)) {
    const frontStats = buildFrontFaceDepthStats(depthStats);
    const frontDimensions = frontStats ? calculateBBoxDimensions(frontStats, bbox, imageWidth, imageHeight, intrinsics) : null;
    const frontCandidate = buildObjectMeasurementCandidate('front_face_depth_pinhole', frontDimensions, frontStats, {
      geometryDiagnostics: {
        selectedDepthPercentile: frontStats?.selectedDepthPercentile || null,
        originalMedianDepth: frontStats?.originalMedianDepth ? Math.round(frontStats.originalMedianDepth * 100) / 100 : null,
        selectedDepth: frontStats?.medianDepth ? Math.round(frontStats.medianDepth * 100) / 100 : null,
        depthSpreadMeters: frontStats?.depthSpreadMeters || null,
      },
    }, scaleFactor);
    if (frontCandidate && isObjectCandidateBroadlyPlausible(targetType, frontCandidate.dimensions)) {
      candidates.push(frontCandidate);
    }
  }

  if (WALL_PLANE_TARGET_TYPES.has(targetType)) {
    const surroundingDepth = sampleSurroundingWallDepthAtBBox(depthResult, bbox);
    const surroundingDimensions = surroundingDepth ? calculateBBoxDimensions(surroundingDepth, bbox, imageWidth, imageHeight, intrinsics) : null;
    const surroundingCandidate = buildObjectMeasurementCandidate('surrounding_wall_depth_pinhole', surroundingDimensions, surroundingDepth, {}, scaleFactor);
    if (surroundingCandidate && isObjectCandidateBroadlyPlausible(targetType, surroundingCandidate.dimensions)) {
      candidates.push(surroundingCandidate);
    }

    const plane = fitLocalWallPlaneAroundBBox(depthResult, intrinsics, bbox);
    const planarDimensions = plane ? calculateBBoxDimensionsOnPlane(bbox, imageWidth, imageHeight, intrinsics, plane) : null;
    const planarCandidate = buildObjectMeasurementCandidate('local_wall_plane_rectified', planarDimensions, {
      ...depthStats,
      source: 'local_wall_plane',
      wallPlaneDiagnostics: planarDimensions?.wallPlaneDiagnostics || null,
    }, {
      geometryDiagnostics: planarDimensions?.wallPlaneDiagnostics || null,
    }, scaleFactor);
    if (planarCandidate && isObjectCandidateBroadlyPlausible(targetType, planarCandidate.dimensions)) {
      candidates.push(planarCandidate);
    }
  }

  let selected = baseCandidate;
  if (WALL_PLANE_TARGET_TYPES.has(targetType)) {
    const planarCandidate = candidates.find(candidate => candidate.method === 'local_wall_plane_rectified') || null;
    const surroundingCandidate = candidates.find(candidate => candidate.method === 'surrounding_wall_depth_pinhole') || null;
    const frontFaceCandidate = targetType === 'bathroom_mirror'
      ? candidates.find(candidate => candidate.method === 'front_face_depth_pinhole') || null
      : null;

    if (isUnrefinedUnanchoredMirrorTarget(target) && planarCandidate) {
      const planarSanity = applyObjectDimensionSanity(targetType, planarCandidate.dimensions);
      const fallbackCandidate = [surroundingCandidate, frontFaceCandidate, baseCandidate]
        .find(candidate => candidate && !applyObjectDimensionSanity(targetType, candidate.dimensions).sanityClamped)
        || null;
      const nearMirrorSizeCeiling = Number(planarCandidate?.dimensions?.widthInches || 0) >= 40
        || Number(planarCandidate?.dimensions?.heightInches || 0) >= 40;
      const inflatedVsFallback = fallbackCandidate && (
        (relativeDimensionDifference(planarCandidate?.dimensions?.widthInches, fallbackCandidate?.dimensions?.widthInches) || 0) >= 0.22
        || (relativeDimensionDifference(planarCandidate?.dimensions?.heightInches, fallbackCandidate?.dimensions?.heightInches) || 0) >= 0.22
      );

      if (planarSanity.sanityClamped || (nearMirrorSizeCeiling && inflatedVsFallback)) {
        selected = fallbackCandidate || planarCandidate;
      } else {
        selected = planarCandidate || surroundingCandidate || frontFaceCandidate || baseCandidate;
      }
    } else {
      selected = planarCandidate
        || surroundingCandidate
        || frontFaceCandidate
        || baseCandidate;
    }
  } else if (FRONT_FACE_TARGET_TYPES.has(targetType)) {
    selected = candidates.find(candidate => candidate.method === 'front_face_depth_pinhole') || baseCandidate;
  }

  if (isWeakLocalGeometryTarget(target) && candidates.length > 1) {
    const candidatePriority = new Map(candidates.map((candidate, index) => [candidate.method, index]));
    const candidateScores = candidates.map(candidate => ({
      candidate,
      penalty: getObjectCandidateSanityPenalty(targetType, candidate.dimensions),
      priority: candidatePriority.get(candidate.method) ?? 99,
    })).sort((first, second) => (
      first.penalty.score - second.penalty.score || first.priority - second.priority
    ));
    const selectedPenalty = getObjectCandidateSanityPenalty(targetType, selected?.dimensions);
    const bestPenaltyCandidate = candidateScores[0] || null;
    if (bestPenaltyCandidate && bestPenaltyCandidate.candidate && bestPenaltyCandidate.penalty.score + 0.35 < selectedPenalty.score) {
      selected = bestPenaltyCandidate.candidate;
    }
  }

  return {
    ...selected,
    boundingBox: bbox,
    candidateMethods: candidates.map(candidate => candidate.method),
  };
}

function selectSoftLocalToiletScaleHint(scaleFactors = []) {
  const candidates = scaleFactors.filter(scaleFactor => (
    (scaleFactor?.type === 'standard_toilet' || scaleFactor?.type === 'toilet')
    && scaleFactor?.dimension === 'height'
    && Number.isFinite(scaleFactor?.scale)
    && scaleFactor.scale >= 0.72
    && scaleFactor.scale <= 1.35
    && Number.isFinite(scaleFactor?.quality)
    && scaleFactor.quality >= 0.58
  ));
  if (!candidates.length) return null;

  const best = [...candidates].sort((first, second) => (
    second.quality - first.quality || second.weight - first.weight
  ))[0];
  const agreeing = candidates.filter(candidate => (
    Math.abs(candidate.scale - best.scale) / Math.max(0.1, best.scale) <= 0.08
  ));
  if (!agreeing.length) return null;

  const totalWeight = agreeing.reduce((sum, candidate) => sum + Math.max(0.1, candidate.weight || 0), 0) || 1;
  const weightedScale = agreeing.reduce((sum, candidate) => (
    sum + candidate.scale * Math.max(0.1, candidate.weight || 0)
  ), 0) / totalWeight;

  return {
    scaleFactor: Math.round(weightedScale * 1000) / 1000,
    source: 'soft_local_toilet_height_anchor',
    anchorType: best.type,
    dimension: 'height',
    candidateCount: agreeing.length,
    quality: Math.round(best.quality * 1000) / 1000,
  };
}

// ============================================================================
// Reference object calibration
// ============================================================================
function calibrateScaleFromReferences(refObjects, depthResult, imageWidth, imageHeight, intrinsics) {
  const scaleFactors = [];
  const rejectedAnchors = [];

  for (const ref of refObjects) {
    const known = getReferenceKnownDimensions(ref);
    if (!known) {
      rejectedAnchors.push({ type: ref.type, reason: 'unknown_reference_type' });
      continue;
    }

    const referenceMeasurement = measureReferenceObject(ref, depthResult, imageWidth, imageHeight, intrinsics);
    if (!referenceMeasurement) {
      rejectedAnchors.push({ type: ref.type, reason: 'depth_unavailable' });
      continue;
    }
    const { measured } = referenceMeasurement;

    const physicalCheck = validateReferencePhysicalPlausibility(ref, measured);
    if (!physicalCheck.ok) {
      rejectedAnchors.push({
        type: ref.type,
        reason: physicalCheck.reason,
        measurementMethod: measured.measurementMethod || referenceMeasurement.depthStats?.source || null,
        impliedScale: physicalCheck.impliedScale ? Math.round(physicalCheck.impliedScale * 1000) / 1000 : null,
        measuredWidthInches: physicalCheck.measuredWidthInches ? Math.round(physicalCheck.measuredWidthInches * 10) / 10 : null,
        measuredHeightInches: physicalCheck.measuredHeightInches ? Math.round(physicalCheck.measuredHeightInches * 10) / 10 : null,
      });
      continue;
    }

    const aspectCheck = validateReferenceAspect(ref, known, measured);
    if (!aspectCheck.ok) {
      rejectedAnchors.push({
        type: ref.type,
        reason: aspectCheck.reason,
        widthScale: aspectCheck.widthScale ? aspectCheck.widthScale.toFixed(3) : null,
        heightScale: aspectCheck.heightScale ? aspectCheck.heightScale.toFixed(3) : null,
        scaleDisagreement: aspectCheck.scaleDisagreement ? Math.round(aspectCheck.scaleDisagreement * 100) / 100 : null,
      });
      continue;
    }

    const anchorKey = buildReferenceAnchorKey(ref);
    const dimensionValidity = aspectCheck.dimensionValidity || { height: true, width: true };

    if (known.height && dimensionValidity.height !== false && isReferenceDimensionEnabled(ref, 'height')) {
      const anchorScore = scoreReferenceAnchor(ref, 'height');
      if (anchorScore.usable && measured.heightInches > 0.1) {
        scaleFactors.push({
          ref: ref.type,
          dimension: 'height',
          known: known.height,
          measured: measured.heightInches,
          scale: known.height / measured.heightInches,
          confidence: ref.confidence || 0.8,
          quality: anchorScore.quality,
          weight: getAnchorCandidateWeight(ref, 'height', anchorScore.quality),
          anchorScore,
          type: ref.type,
          anchorKey,
        });
      } else {
        rejectedAnchors.push({ type: ref.type, dimension: 'height', reason: anchorScore.reason || 'invalid_height_measurement', quality: anchorScore.quality });
      }
    }
    if (known.height && dimensionValidity.height !== false && !isReferenceDimensionEnabled(ref, 'height')) {
      rejectedAnchors.push({ type: ref.type, dimension: 'height', reason: 'dimension_not_enabled_for_scale' });
    }
    if (known.height && dimensionValidity.height === false) {
      rejectedAnchors.push({ type: ref.type, dimension: 'height', reason: aspectCheck.reason || 'dimension_aspect_rejected' });
    }
    if (known.width && dimensionValidity.width !== false && isReferenceDimensionEnabled(ref, 'width')) {
      const anchorScore = scoreReferenceAnchor(ref, 'width');
      if (anchorScore.usable && measured.widthInches > 0.1) {
        scaleFactors.push({
          ref: ref.type,
          dimension: 'width',
          known: known.width,
          measured: measured.widthInches,
          scale: known.width / measured.widthInches,
          confidence: ref.confidence || 0.8,
          quality: anchorScore.quality,
          weight: getAnchorCandidateWeight(ref, 'width', anchorScore.quality),
          anchorScore,
          type: ref.type,
          anchorKey,
        });
      } else {
        rejectedAnchors.push({ type: ref.type, dimension: 'width', reason: anchorScore.reason || 'invalid_width_measurement', quality: anchorScore.quality });
      }
    }
    if (known.width && dimensionValidity.width !== false && !isReferenceDimensionEnabled(ref, 'width')) {
      rejectedAnchors.push({ type: ref.type, dimension: 'width', reason: 'dimension_not_enabled_for_scale' });
    }
    if (known.width && dimensionValidity.width === false) {
      rejectedAnchors.push({
        type: ref.type,
        dimension: 'width',
        reason: aspectCheck.reason || 'dimension_aspect_rejected',
        widthScale: aspectCheck.widthScale ? aspectCheck.widthScale.toFixed(3) : null,
        heightScale: aspectCheck.heightScale ? aspectCheck.heightScale.toFixed(3) : null,
        scaleDisagreement: aspectCheck.scaleDisagreement ? Math.round(aspectCheck.scaleDisagreement * 100) / 100 : null,
      });
    }
  }

  if (scaleFactors.length === 0) {
    return { scaleFactor: 1.0, calibrated: false, references: [], rejectedAnchors };
  }

  const robust = chooseRobustScaleCandidate(scaleFactors);
  const avgScale = robust?.scale || 1.0;
  const consistency = robust?.consistency || 'low';
  const trust = trustCalibration(avgScale, consistency);
  const softLocalToiletScaleHint = trust.trusted ? null : selectSoftLocalToiletScaleHint(scaleFactors);

  console.log(`[PhotoMeasurement] Calibration: scale=${avgScale.toFixed(3)} from ${robust?.cluster?.length || 0}/${scaleFactors.length} anchor dimensions (${consistency})`);
  if (!trust.trusted) {
    console.warn(`[PhotoMeasurement] Rejecting reference calibration: ${trust.reason}`);
  }

  return {
    scaleFactor: trust.trusted ? avgScale : 1.0,
    candidateScaleFactor: avgScale,
    calibrated: trust.trusted,
    rejected: !trust.trusted,
    rejectionReason: trust.reason,
    consistency,
    softLocalToiletScaleHint,
    consensus: robust?.consensus || null,
    spread: Math.round((robust?.spread || 0) * 100) / 100,
    references: (robust?.cluster || scaleFactors).map(sf => ({
      type: sf.ref,
      dimension: sf.dimension,
      known: `${sf.known}"`,
      measured: `${sf.measured.toFixed(1)}"`,
      scale: sf.scale.toFixed(3),
      quality: Math.round(sf.quality * 100) / 100,
      anchorKey: sf.anchorKey || null,
    })),
    rejectedAnchors: [
      ...rejectedAnchors,
      ...(robust?.rejectedOutliers || []).map(sf => ({ type: sf.ref, dimension: sf.dimension, reason: 'scale_outlier', scale: sf.scale.toFixed(3), quality: Math.round(sf.quality * 100) / 100, anchorKey: sf.anchorKey || null })),
    ],
  };
}

// ============================================================================
// Room dimension extraction from real depth data
// ============================================================================
function extractRoomDimensions(depthResult, photoAnalysis, intrinsics, scaleFactor, imageWidth, imageHeight, calibrationMeta = null) {
  const { roomGeometry, wallsVisible, cornerVisible, estimatedCeilingHeightFt } = photoAnalysis || {};
  const roomType = photoAnalysis?.roomType || 'unknown';

  let widthFt = roomGeometry?.estimatedWidthFt || null;
  let lengthFt = roomGeometry?.estimatedLengthFt || null;
  let heightFt = estimatedCeilingHeightFt || 8;
  let methodology = 'gpt_visual_estimate';
  let geometryDiagnostics = null;

  // If we have REAL depth data from DAv3-Metric, use it to derive room length
  if (depthResult?.ok && depthResult.depthArray) {
    const roomDepths = sampleRoomDepths(depthResult);
    const planeGeometry = estimateRoomGeometryFromPlanes(depthResult, intrinsics, scaleFactor);

    if (planeGeometry) {
      geometryDiagnostics = planeGeometry.diagnostics || null;
      if (planeGeometry.lengthFt) lengthFt = planeGeometry.lengthFt;
      if (planeGeometry.widthFt) widthFt = planeGeometry.widthFt;
      if (planeGeometry.heightFt) heightFt = planeGeometry.heightFt;
      methodology = 'dav3_metric_plane_fit';
    }

    if (roomDepths?.farWallDepth) {
      if (!planeGeometry) methodology = 'dav3_metric_calibrated';

      // Far wall depth = room length along camera axis (in meters), scaled by calibration
      const farWallM = roomDepths.farWallDepth * scaleFactor;
      let depthDimensionFt = farWallM * 3.28084;

      // If scale was NOT calibrated from reference objects, depth can drift.
      // Blend depth estimate with GPT visual geometry to reduce major over/under-shoot.
      const hasCalibratedScale = !!(calibrationMeta?.calibrated || calibrationMeta?.displayCalibrated);
      const gptLen = roomGeometry?.estimatedLengthFt || null;
      if (!hasCalibratedScale && gptLen) {
        depthDimensionFt = depthDimensionFt * 0.45 + gptLen * 0.55;
      } else if (hasCalibratedScale && roomType === 'bathroom' && gptLen) {
        const visionInflation = gptLen / Math.max(depthDimensionFt, 0.1);
        if (visionInflation > 1.12) {
          const cappedVisionLen = Math.min(gptLen, depthDimensionFt * 1.55);
          const calibratedBlend = visionInflation >= 1.35 ? 0.32 : 0.18;
          depthDimensionFt = depthDimensionFt * (1 - calibratedBlend) + cappedVisionLen * calibratedBlend;
          geometryDiagnostics = {
            ...(geometryDiagnostics || {}),
            calibratedVisionPriorBlend: {
              applied: true,
              roomType,
              depthLengthFt: Math.round((roomDepths.farWallDepth * scaleFactor * 3.28084) * 10) / 10,
              gptLengthFt: Math.round(gptLen * 10) / 10,
              blendedLengthFt: Math.round(depthDimensionFt * 10) / 10,
              blendWeight: calibratedBlend,
            },
          };
        }
      }

      // Use GPT proportions to derive the perpendicular dimension
      if (!lengthFt || !widthFt) {
        if (roomGeometry?.estimatedWidthFt && roomGeometry?.estimatedLengthFt) {
          const aspect = roomGeometry.estimatedWidthFt / roomGeometry.estimatedLengthFt;
          if (aspect < 1) {
            lengthFt = lengthFt || depthDimensionFt;
            widthFt = widthFt || (depthDimensionFt * aspect);
          } else {
            widthFt = widthFt || depthDimensionFt;
            lengthFt = lengthFt || (depthDimensionFt / aspect);
          }
        } else {
          lengthFt = lengthFt || depthDimensionFt;
          widthFt = widthFt || (depthDimensionFt / 1.2);
        }
      } else if (roomGeometry?.estimatedWidthFt && roomGeometry?.estimatedLengthFt) {
        const aspect = roomGeometry.estimatedWidthFt / roomGeometry.estimatedLengthFt;
        if (aspect < 1) {
          lengthFt = lengthFt * 0.70 + depthDimensionFt * 0.30;
          widthFt = widthFt * 0.70 + (depthDimensionFt * aspect) * 0.30;
        } else {
          widthFt = widthFt * 0.70 + depthDimensionFt * 0.30;
          lengthFt = lengthFt * 0.70 + (depthDimensionFt / aspect) * 0.30;
        }
      }

      // Cross-check with side wall depths for width estimate
      const hasReliableSideWalls = (cornerVisible === true || (wallsVisible || 0) >= 2) && (roomDepths.farWallCount || 0) >= 1500;
      if (hasReliableSideWalls && roomDepths.leftWallDepth && roomDepths.rightWallDepth) {
        const halfFovRad = Math.atan((imageWidth / 2) / intrinsics.fx);
        const leftEdgeWidth = roomDepths.leftWallDepth * Math.tan(halfFovRad) * 2 * scaleFactor;
        const rightEdgeWidth = roomDepths.rightWallDepth * Math.tan(halfFovRad) * 2 * scaleFactor;
        const sideBasedWidthFt = ((leftEdgeWidth + rightEdgeWidth) / 2) * 3.28084;

        // Keep side-wall correction bounded to avoid dramatic jumps from occlusions/furniture.
        if (widthFt) {
          const minAllowed = widthFt * 0.70;
          const maxAllowed = widthFt * 1.30;
          const clampedSide = Math.max(minAllowed, Math.min(maxAllowed, sideBasedWidthFt));
          widthFt = widthFt * 0.75 + clampedSide * 0.25;
        } else {
          widthFt = sideBasedWidthFt;
        }
      }
    }
  }

  // Clamp to residential bounds, but allow narrow bathrooms below 5 ft.
  const minHorizontalDimensionFt = roomType === 'bathroom' ? 4 : 5;
  widthFt = Math.max(minHorizontalDimensionFt, Math.min(40, widthFt || 10));
  lengthFt = Math.max(minHorizontalDimensionFt, Math.min(40, lengthFt || 12));
  heightFt = Math.max(7, Math.min(14, heightFt));

  const floorAreaSqFt = Math.round(widthFt * lengthFt);
  const wallAreaSqFt = Math.round(2 * (widthFt + lengthFt) * heightFt);
  const perimeterFt = Math.round(2 * (widthFt + lengthFt));

  return {
    widthFt: Math.round(widthFt * 10) / 10,
    lengthFt: Math.round(lengthFt * 10) / 10,
    heightFt,
    floorAreaSqFt,
    wallAreaSqFt,
    perimeterFt,
    methodology,
    geometryDiagnostics,
  };
}

// ============================================================================
// Appliance fit classification
// ============================================================================
function classifyApplianceFit(measuredWidthInches, applianceType) {
  const sizes = STANDARD_SIZES[applianceType];
  if (!sizes) return null;

  const fittingSizes = sizes.filter(s => s <= measuredWidthInches + 0.5);
  const recommendedSize = fittingSizes.length > 0 ? Math.max(...fittingSizes) : null;
  const nextSizeUp = sizes.find(s => s > measuredWidthInches + 0.5) || null;

  return {
    measuredWidth: Math.round(measuredWidthInches * 10) / 10,
    recommendedSize,
    nextSizeUp,
    fittingSizes,
    fitConfidence: !recommendedSize ? 'none' : (measuredWidthInches - recommendedSize) < 1.5 ? 'moderate' : 'high',
    note: !recommendedSize
      ? 'Opening too narrow for standard sizes — verify on-site'
      : (measuredWidthInches - recommendedSize) < 1.5
        ? 'Tight fit — verify dimensions before ordering'
        : `Standard ${recommendedSize}" ${applianceType} fits with clearance`,
  };
}

export { calculateMaterialQuantities, calculateLaborItems };

// ============================================================================
// GPT-4o Object Detection
// ============================================================================
async function detectObjectsAndMeasurementTargets(images) {
  if (!OPENAI_API_KEY) return { ok: false, error: 'OpenAI API key not configured' };

  const imageMessages = images.map(img => ({
    type: 'image_url',
    image_url: {
      url: img.startsWith('data:') || img.startsWith('http') ? img : `data:image/jpeg;base64,${img}`,
      detail: 'high',
    },
  }));

  const prompt = `You are an expert construction estimator analyzing property photos for renovation measurement.

For each photo, identify:

1. **REFERENCE OBJECTS** — items with known standard dimensions for scale calibration:
   - Doors (interior=80"H×30-36"W), electrical outlets (4.5"×2.75")
   - Standard countertop height (36"), upper cabinets (30"H)
  - Windows, bathtubs (60"L×30"W), toilets (~28-31"H×15-18"W)
  - Floor-to-ceiling wall strips (8 ft or 9 ft ceiling) when both ceiling line and floor/baseboard line are visible
  - Standard mattress/bed footprints (twin/full/queen/king) only when enough edges/corners are visible to classify size confidently
  - Before returning, do a wall-fixture sweep: scan every visible wall for small US outlet faceplates and light-switch faceplates. They are high-value scale anchors even when they occupy a tiny part of the photo.
  - For outlets and switches, draw the tight box around the rectangular faceplate only, not the surrounding wall or shadow.
  - For ceiling-height anchors, draw a narrow vertical wall strip from baseboard/floor to ceiling and use type ceiling_height_8 or ceiling_height_9.
  - Only use a reference object for scale when the whole object extent is visible, the object is not cropped, and the standard size is likely.
  - For each reference object include:
    useForScale: true/false,
    visibility: "full" | "mostly_visible" | "partial" | "occluded" | "cropped",
    perspective: "front_facing" | "mild_angle" | "strong_angle",
    standardSizeConfidence: 0.0-1.0,
    scaleRationale: short explanation.
  - Prefer ceiling-height wall strips, full-height doors, standard range/dishwasher fronts, countertop height, unobstructed front-facing outlets/switches, and clearly visible tile modules.
  - Do NOT mark windows, partial furniture, cropped doors, bedding-covered mattress edges, rugs, or unknown decor as useForScale=true unless the exact standard size is very clear.

2. **ROOM TYPE** and visible walls/corners

3. **MEASUREMENT TARGETS** — objects and spaces that need measuring:
   - **Existing appliances** (fridge, range, dishwasher, microwave) — draw bbox around EACH visible appliance
   - **Openings** for appliances (space between cabinets), vanity spaces, shower door openings
   - **Cabinet runs** — draw bbox around full run of upper and lower cabinets separately
   - **Countertop runs** — draw bbox around visible countertop surface
   - **Vanity** — draw bbox around bathroom vanity
  - **Toilet** — draw bbox around the full visible toilet body when visible
  - **Bathroom mirror / mirrored medicine cabinet** — draw bbox around the outer mirror or cabinet frame when visible
   - **Bathtub/shower** — draw bbox if visible

  Bathroom-specific target rules:
  - For existing_vanity, box the FULL visible vanity front face and countertop span, not a single drawer, door, side panel, or sink cutout.
  - For existing_toilet, box the FULL visible toilet body: tank, bowl, and seat outline when visible. Do not box just the tank lid, just the bowl opening, or only the toilet base.
  - For bathroom_mirror, box the OUTER frame or mirror edges only. Do not box a reflected doorway, reflected wall area, light fixture, or just the center reflective patch.
  - For bathroom_mirror descriptions, explicitly say whether it is a wall mirror or a mirrored medicine cabinet.
  - For shower_door_opening, use this target only when the shower/tub entry opening is visible and at least one jamb/edge is clear. Box the opening span between the entry edges, not the whole tiled surround or bathtub alcove.
  - For existing_bathtub, use this only when the tub body or front apron is directly visible. Do NOT label a shower wall, shower curtain area, glass opening, or tiled alcove as existing_bathtub if the tub itself is not clearly visible.
  - If a bathroom target is too partial to box confidently, omit it rather than returning a tight crop around one subcomponent.

  For targetType, use: fridge_opening, range_opening, dishwasher_opening, vanity_space, shower_door_opening, window, door,
   existing_fridge, existing_range, existing_dishwasher, existing_microwave,
  cabinet_run_upper, cabinet_run_lower, countertop_run, existing_bathtub, existing_vanity, existing_toilet, bathroom_mirror

4. **ROOM GEOMETRY** (width × length in feet — be conservative)

Bounding boxes: normalized 0-1 coordinates { x, y, width, height } from top-left.
Draw TIGHT bounding boxes that exactly frame each object.

Return ONLY valid JSON (no markdown):
{
  "photos": [
    {
      "photoIndex": 0,
      "roomType": "kitchen",
      "wallsVisible": 2,
      "cornerVisible": true,
      "estimatedCeilingHeightFt": 8,
      "referenceObjects": [
        { "type": "standard_door", "boundingBox": { "x": 0.15, "y": 0.05, "width": 0.12, "height": 0.85 }, "confidence": 0.95, "useForScale": true, "visibility": "full", "perspective": "front_facing", "standardSizeConfidence": 0.92, "scaleRationale": "full visible interior door with standard height" }
      ],
      "measurementTargets": [
        { "targetType": "existing_fridge", "boundingBox": { "x": 0.05, "y": 0.08, "width": 0.14, "height": 0.75 }, "description": "Black fridge between cabinets", "confidence": 0.9 },
        { "targetType": "existing_range", "boundingBox": { "x": 0.25, "y": 0.3, "width": 0.12, "height": 0.45 }, "description": "Gas range with oven", "confidence": 0.9 },
        { "targetType": "cabinet_run_lower", "boundingBox": { "x": 0.4, "y": 0.4, "width": 0.55, "height": 0.35 }, "description": "Lower cabinet run along right wall", "confidence": 0.8 },
        { "targetType": "cabinet_run_upper", "boundingBox": { "x": 0.4, "y": 0.05, "width": 0.55, "height": 0.3 }, "description": "Upper cabinets", "confidence": 0.8 }
      ],
      "roomGeometry": { "estimatedWidthFt": 10, "estimatedLengthFt": 12 }
    }
  ]
}

CRITICAL: Draw bounding boxes around EVERY visible appliance, cabinet run, and fixture. These are measured by our depth sensor.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imageMessages] }],
        max_tokens: 3000,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: 'No response from GPT-4o' };

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, error: 'Failed to parse detection response' };

    return { ok: true, ...JSON.parse(jsonMatch[0]) };
  } catch (error) {
    console.error('[PhotoMeasurement] Object detection error:', error.message);
    return { ok: false, error: error.message };
  }
}

async function detectScaleAnchors(images) {
  if (!OPENAI_API_KEY) return { ok: false, error: 'OpenAI API key not configured' };

  const imageMessages = images.map(img => ({
    type: 'image_url',
    image_url: {
      url: img.startsWith('data:') || img.startsWith('http') ? img : `data:image/jpeg;base64,${img}`,
      detail: 'high',
    },
  }));

  const prompt = `You are doing ONLY scale-anchor detection for real-estate room measurement.

For each photo, scan the entire image for objects with known or highly standardized real-world dimensions. Find all viable anchors, not only outlets.

High-priority anchor classes:
- Full-height doors: standard_door, entry_door, closet_door, double_door, sliding_glass_door
- Wall fixtures: electrical_outlet, double_outlet, light_switch
- Architectural surfaces: baseboard, subway_tile, floor_tile_12, floor_tile_18, floor_tile_24, ceiling_height_8, ceiling_height_9
- Kitchen anchors when visible: standard_countertop, standard_dishwasher, standard_range, standard_fridge, standard_microwave, kitchen_sink
- Bathroom anchors when visible: standard_toilet, toilet, standard_bathtub, bathtub, bathroom_vanity_24, bathroom_vanity_30, bathroom_vanity_32, bathroom_vanity_36, bathroom_vanity_48, bathroom_vanity_60, bathroom_vanity_72, medicine_cabinet
- Window anchors only when the full frame is visible and the standard size is very likely: standard_window, double_window
- Mattress anchors only when the actual mattress edges are visible and not hidden by bedding: twin_mattress, full_mattress, queen_mattress, king_mattress
- Room-height anchors: if a vertical wall segment shows both the ceiling line and floor/baseboard line, draw a narrow vertical box from floor/baseboard to ceiling and classify it as ceiling_height_8 or ceiling_height_9. For typical residential bedrooms, ceiling_height_8 is usually the better default unless the room visibly has tall ceilings.

Rules:
- For outlets/switches, draw the tight bounding box around the rectangular faceplate only, not the surrounding wall, shadow, or cover plate screw area outside the plate.
- For doors, box the visible door slab or full frame from top to bottom. Mark useForScale=true only when full height is visible or nearly full height is inferable with high confidence.
- For room-height anchors, box only a flat wall strip from floor/baseboard to ceiling. Do not include furniture, bed, open doors, or angled closet interiors.
- For floor tiles, box a SINGLE full floor tile module only when grout lines make the tile boundaries clear. Use floor_tile_12, floor_tile_18, or floor_tile_24. Do not box multiple tiles together.
- For bathroom vanities, prefer the visible vanity or cabinet front only. If the width appears closer to 30, 32, 36, 48, 60, or 72 inches than 24 inches, choose the closer vanity type instead of defaulting to bathroom_vanity_24.
- For windows, appliances, vanities, mattresses, and mirrors, mark useForScale=true only when the exact standard size is likely. Otherwise include the anchor with useForScale=false for audit.
- For beds/mattresses, include an approximate mattress anchor only if at least two long edges/corners are visible enough to classify twin/full/queen/king with high confidence; otherwise mark useForScale=false.
- Mark cropped/partial anchors, hidden mattress edges, rugs, lamps, decor, bedding, and generic furniture useForScale=false.
- Use only known types from the high-priority list above.
- Bounding boxes use normalized 0-1 coordinates { x, y, width, height } from top-left.
- For every anchor include confidence, useForScale, visibility, perspective, standardSizeConfidence, anchorQuality (high|medium|low), and scaleRationale.
- Return multiple anchors when visible. Agreement across multiple independent anchors is more valuable than one anchor.

Return ONLY valid JSON, no markdown:
{
  "photos": [
    {
      "photoIndex": 0,
      "referenceObjects": [
        { "type": "electrical_outlet", "boundingBox": { "x": 0.50, "y": 0.50, "width": 0.03, "height": 0.04 }, "confidence": 0.9, "useForScale": true, "visibility": "full", "perspective": "front_facing", "standardSizeConfidence": 0.95, "anchorQuality": "high", "scaleRationale": "visible unobstructed US outlet faceplate" },
        { "type": "standard_door", "boundingBox": { "x": 0.10, "y": 0.06, "width": 0.16, "height": 0.82 }, "confidence": 0.88, "useForScale": true, "visibility": "full", "perspective": "mild_angle", "standardSizeConfidence": 0.92, "anchorQuality": "high", "scaleRationale": "full interior door height visible" },
        { "type": "ceiling_height_8", "boundingBox": { "x": 0.62, "y": 0.05, "width": 0.04, "height": 0.82 }, "confidence": 0.82, "useForScale": true, "visibility": "full", "perspective": "front_facing", "standardSizeConfidence": 0.9, "anchorQuality": "high", "scaleRationale": "visible flat wall strip from baseboard/floor to ceiling" }
      ]
    }
  ]
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imageMessages] }],
        max_tokens: 2200,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: 'No response from GPT-4o scale-anchor pass' };

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, error: 'Failed to parse scale-anchor response' };

    return { ok: true, ...JSON.parse(jsonMatch[0]) };
  } catch (error) {
    console.error('[PhotoMeasurement] Scale-anchor detection error:', error.message);
    return { ok: false, error: error.message };
  }
}

function isValidNormalizedBox(box) {
  return Number.isFinite(Number(box?.x)) &&
    Number.isFinite(Number(box?.y)) &&
    Number.isFinite(Number(box?.width)) &&
    Number.isFinite(Number(box?.height)) &&
    Number(box.width) > 0 &&
    Number(box.height) > 0;
}

function clampNormalizedBox(box) {
  const x = Math.max(0, Math.min(1, Number(box.x || 0)));
  const y = Math.max(0, Math.min(1, Number(box.y || 0)));
  const width = Math.max(0, Math.min(1 - x, Number(box.width || 0)));
  const height = Math.max(0, Math.min(1 - y, Number(box.height || 0)));
  return { x, y, width, height };
}

function buildIntegralImage(values, width, height) {
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      rowSum += values[(y - 1) * width + (x - 1)] || 0;
      integral[y * (width + 1) + x] = integral[(y - 1) * (width + 1) + x] + rowSum;
    }
  }
  return integral;
}

function sumIntegral(integral, width, height, x1, y1, x2, y2) {
  x1 = Math.max(0, Math.min(width, Math.floor(x1)));
  y1 = Math.max(0, Math.min(height, Math.floor(y1)));
  x2 = Math.max(0, Math.min(width, Math.ceil(x2)));
  y2 = Math.max(0, Math.min(height, Math.ceil(y2)));
  if (x2 <= x1 || y2 <= y1) return { sum: 0, count: 0 };
  const stride = width + 1;
  const sum = integral[y2 * stride + x2] - integral[y1 * stride + x2] - integral[y2 * stride + x1] + integral[y1 * stride + x1];
  return { sum, count: (x2 - x1) * (y2 - y1) };
}

function rectMean(integral, width, height, x1, y1, x2, y2) {
  const result = sumIntegral(integral, width, height, x1, y1, x2, y2);
  return result.count ? result.sum / result.count : 0;
}

function rectStats(grayIntegral, graySqIntegral, width, height, x1, y1, x2, y2) {
  const gray = sumIntegral(grayIntegral, width, height, x1, y1, x2, y2);
  if (!gray.count) return { mean: 0, std: 0 };
  const graySq = sumIntegral(graySqIntegral, width, height, x1, y1, x2, y2);
  const mean = gray.sum / gray.count;
  const variance = Math.max(0, graySq.sum / gray.count - mean * mean);
  return { mean, std: Math.sqrt(variance) };
}

function estimateEdgeMap(gray, width, height) {
  const edges = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] + gray[i - width + 1] +
        -2 * gray[i - 1] + 2 * gray[i + 1] +
        -gray[i + width - 1] + gray[i + width + 1];
      const gy =
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
        gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
      edges[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return edges;
}

function faceplateAspectForType(type) {
  if (type === 'double_outlet') return 4.56 / 4.5;
  return 2.75 / 4.5;
}

function scoreFaceplateDetectorCandidate(candidate, expectedAspect) {
  const box = candidate?.box;
  if (!isValidNormalizedBox(box)) return -Infinity;
  const aspect = Number(box.width || 0) / Math.max(0.001, Number(box.height || 0));
  const aspectError = Math.abs(Math.log(Math.max(0.001, aspect) / expectedAspect));
  const confidence = clamp01(candidate.confidence, 0.5);
  const edgeScore = candidate.diagnostics?.borderEdge
    ? clamp01((candidate.diagnostics.borderEdge - 12) / 42, 0)
    : clamp01((candidate.diagnostics?.foundLines || 0) / 4, 0);
  const contrastScore = candidate.diagnostics?.contrast
    ? clamp01(candidate.diagnostics.contrast / 42, 0)
    : 0.45;
  const area = Number(box.width || 0) * Number(box.height || 0);
  const areaScore = area > 0.0008 && area < 0.35 ? 0.55 : 0.15;
  const sourceBoost = candidate.source === 'learned_faceplate_detector'
    ? 0.12
    : candidate.source === 'line_profile_snap' ? 0.08 : 0;
  return confidence * 0.48 + edgeScore * 0.26 + contrastScore * 0.16 + areaScore * 0.10 + sourceBoost - aspectError * 0.55;
}

function normalizedBoxCorners(box) {
  const b = clampNormalizedBox(box || {});
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height },
  ].map(point => ({ x: Math.round(point.x * 10000) / 10000, y: Math.round(point.y * 10000) / 10000 }));
}

function shouldCropRefineScaleAnchor(anchor) {
  return SMALL_FIXTURE_ANCHOR_TYPES.has(anchor?.type) || FLOOR_TILE_ANCHOR_TYPES.has(anchor?.type) || DOOR_ANCHOR_TYPES.has(anchor?.type) || anchor?.type === 'standard_window' || anchor?.type === 'double_window';
}

function scaleAnchorCropTargetType(type) {
  if (DOOR_ANCHOR_TYPES.has(type)) return 'door';
  if (type === 'standard_window' || type === 'double_window') return 'window';
  if (FLOOR_TILE_ANCHOR_TYPES.has(type)) return 'floor_tile';
  return type;
}

function scaleAnchorCropSize(bbox, anchorType) {
  if (SMALL_FIXTURE_ANCHOR_TYPES.has(anchorType)) {
    return {
      width: Math.min(0.46, Math.max(0.22, bbox.width * 8)),
      height: Math.min(0.52, Math.max(0.28, bbox.height * 8)),
    };
  }
  if (DOOR_ANCHOR_TYPES.has(anchorType)) {
    return {
      width: Math.min(0.72, Math.max(0.24, bbox.width * 2.4)),
      height: Math.min(0.98, Math.max(0.62, bbox.height * 1.28)),
    };
  }
  return {
    width: Math.min(0.82, Math.max(0.28, bbox.width * 2.1)),
    height: Math.min(0.82, Math.max(0.28, bbox.height * 2.1)),
  };
}

function detectorClassMatchesAnchor(prediction, anchorType) {
  const label = String(prediction?.class || prediction?.label || prediction?.name || prediction?.category || '').toLowerCase();
  if (!label) return true;
  if (anchorType === 'light_switch') return /switch|faceplate|plate/.test(label);
  if (anchorType === 'double_outlet') return /double|outlet|receptacle|socket|faceplate|plate/.test(label);
  if (anchorType === 'electrical_outlet') return /outlet|receptacle|socket|faceplate|plate/.test(label);
  return true;
}

function measurementTargetDetectorClassHints(targetType) {
  switch (targetType) {
    case 'existing_vanity':
    case 'vanity_space':
      return ['vanity', 'bathroom vanity', 'sink cabinet', 'bathroom cabinet'];
    case 'existing_toilet':
      return ['toilet', 'bathroom toilet'];
    case 'bathroom_mirror':
      return ['mirror', 'bathroom mirror', 'medicine cabinet', 'mirrored cabinet'];
    case 'shower_door_opening':
      return ['shower opening', 'shower door opening', 'shower entry', 'bathtub opening'];
    case 'existing_bathtub':
      return ['bathtub', 'tub'];
    case 'door':
      return ['door', 'door opening'];
    case 'window':
      return ['window'];
    default:
      return [targetType];
  }
}

function detectorClassMatchesMeasurementTarget(prediction, targetType) {
  const label = String(prediction?.class || prediction?.label || prediction?.name || prediction?.category || '').toLowerCase();
  if (!label) return true;

  switch (targetType) {
    case 'existing_vanity':
    case 'vanity_space':
      return /(vanity|sink cabinet|bathroom cabinet|cabinet)/.test(label) && !/(mirror|toilet|bathtub|shower)/.test(label);
    case 'existing_toilet':
      return /toilet|commode/.test(label);
    case 'bathroom_mirror':
      return /(mirror|medicine cabinet|mirrored cabinet)/.test(label) && !/(vanity|sink|window)/.test(label);
    case 'shower_door_opening':
      return /(shower|bathtub|tub|door opening|entry)/.test(label);
    case 'existing_bathtub':
      return /(bathtub|tub)/.test(label) && !/(door opening|entry)/.test(label);
    case 'door':
      return /door/.test(label);
    case 'window':
      return /window/.test(label);
    default:
      return true;
  }
}

function normalizeDetectorPredictionBox(prediction, imageWidth, imageHeight) {
  let box = prediction?.box || prediction?.bbox || prediction?.boundingBox || null;
  const points = prediction?.points || prediction?.corners || prediction?.polygon || prediction?.mask;

  if (Array.isArray(points) && points.length >= 4) {
    const xs = points.map(point => Number(point.x ?? point[0])).filter(Number.isFinite);
    const ys = points.map(point => Number(point.y ?? point[1])).filter(Number.isFinite);
    if (xs.length && ys.length) {
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
  }

  if (Array.isArray(box)) {
    if (box.length >= 4) box = { x: box[0], y: box[1], width: box[2], height: box[3] };
    else box = null;
  }

  if (!box && prediction?.x != null && prediction?.y != null && prediction?.width != null && prediction?.height != null) {
    const centerBased = prediction.x > 1 || prediction.y > 1 || prediction.width > 1 || prediction.height > 1;
    box = centerBased
      ? {
          x: Number(prediction.x) - Number(prediction.width) / 2,
          y: Number(prediction.y) - Number(prediction.height) / 2,
          width: Number(prediction.width),
          height: Number(prediction.height),
        }
      : {
          x: Number(prediction.x) - Number(prediction.width) / 2,
          y: Number(prediction.y) - Number(prediction.height) / 2,
          width: Number(prediction.width),
          height: Number(prediction.height),
        };
  }

  if (!box) return null;
  let x = Number(box.x ?? box.left ?? 0);
  let y = Number(box.y ?? box.top ?? 0);
  let width = Number(box.width ?? (box.right != null ? Number(box.right) - x : 0));
  let height = Number(box.height ?? (box.bottom != null ? Number(box.bottom) - y : 0));
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;

  const normalized = x <= 1 && y <= 1 && width <= 1 && height <= 1;
  if (!normalized) {
    x /= Math.max(1, imageWidth);
    width /= Math.max(1, imageWidth);
    y /= Math.max(1, imageHeight);
    height /= Math.max(1, imageHeight);
  }

  return clampNormalizedBox({ x, y, width, height });
}

function collectDetectorPredictions(responseJson) {
  if (!responseJson) return [];
  const direct = responseJson.predictions || responseJson.detections || responseJson.objects || responseJson.results || [];
  if (Array.isArray(direct)) return direct.flatMap(item => Array.isArray(item?.predictions) ? item.predictions : [item]);
  if (Array.isArray(direct.predictions)) return direct.predictions;
  return [];
}

function appendDetectorApiKey(url, apiKey = '') {
  const parsed = new URL(url);
  if (apiKey && /roboflow/i.test(parsed.hostname) && !parsed.searchParams.has('api_key')) {
    parsed.searchParams.set('api_key', apiKey);
  }
  return parsed;
}

function calculateNormalizedRangePct(values = []) {
  const numeric = values.map(value => Number(value)).filter(Number.isFinite);
  if (numeric.length < 2) return 0;
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const avg = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
  if (!Number.isFinite(avg) || avg <= 0) return 0;
  return Math.round(((max - min) / avg) * 1000) / 10;
}

function measurementTargetCandidateSourceBoost(source) {
  if (source === 'segmenter_mask') return 0.18;
  if (source === 'learned_measurement_detector') return 0.14;
  if (source === 'deterministic_edge_snap') return 0.12;
  return 0;
}

function scoreMeasurementTargetSpecialistCandidate(candidate, targetType, roughBox, candidates = []) {
  const box = candidate?.box;
  if (!isValidNormalizedBox(box)) return -Infinity;

  const confidence = clamp01(candidate?.confidence, 0.5);
  const overlap = isValidNormalizedBox(roughBox)
    ? bboxIntersectionOverUnion(box, roughBox)
    : 0.22;
  const centerAlignment = isValidNormalizedBox(roughBox)
    ? 1 - Math.min(1, bboxCenterDistance(box, roughBox) / 0.22)
    : 0.5;
  const area = Number(box.width || 0) * Number(box.height || 0);
  const roughArea = isValidNormalizedBox(roughBox)
    ? Math.max(0.0001, Number(roughBox.width || 0) * Number(roughBox.height || 0))
    : area;
  const areaScore = roughArea > 0
    ? Math.min(area, roughArea) / Math.max(area, roughArea)
    : 0.5;
  const supportCount = candidates.filter(other => other !== candidate && isValidNormalizedBox(other?.box)).filter(other => (
    bboxIntersectionOverUnion(box, other.box) >= 0.16 || bboxCenterDistance(box, other.box) <= 0.08
  )).length;
  const supportScore = candidates.length > 1 ? supportCount / (candidates.length - 1) : 0.5;

  const aspect = Number(box.width || 0) / Math.max(0.001, Number(box.height || 0));
  const [minAspect, maxAspect] = targetAspectRange(targetType);
  const boundedAspect = Math.min(maxAspect, Math.max(minAspect, aspect));
  const aspectPenalty = Math.abs(Math.log(Math.max(0.001, aspect) / Math.max(0.001, boundedAspect)));

  return confidence * 0.34
    + overlap * 0.17
    + centerAlignment * 0.12
    + areaScore * 0.09
    + supportScore * 0.18
    + measurementTargetCandidateSourceBoost(candidate?.source) * 0.10
    - aspectPenalty * 0.18;
}

function arbitrateMeasurementTargetCandidates(targetType, roughBox, candidates = []) {
  const validCandidates = candidates.filter(candidate => isValidNormalizedBox(candidate?.box));
  if (!validCandidates.length) {
    return {
      selected: null,
      ambiguous: false,
      diagnostics: {
        candidateCount: 0,
        disagreementScorePct: 0,
        selectedSource: null,
        candidates: [],
      },
    };
  }

  const scored = validCandidates
    .map(candidate => {
      const supportCount = validCandidates.filter(other => other !== candidate && isValidNormalizedBox(other?.box)).filter(other => (
        bboxIntersectionOverUnion(candidate.box, other.box) >= 0.16 || bboxCenterDistance(candidate.box, other.box) <= 0.08
      )).length;
      return {
        ...candidate,
        supportCount,
        arbitrationScore: Math.round(scoreMeasurementTargetSpecialistCandidate(candidate, targetType, roughBox, validCandidates) * 1000) / 1000,
      };
    })
    .sort((first, second) => second.arbitrationScore - first.arbitrationScore);

  const disagreementScorePct = Math.max(
    calculateNormalizedRangePct(scored.map(candidate => Number(candidate?.box?.width || 0))),
    calculateNormalizedRangePct(scored.map(candidate => Number(candidate?.box?.height || 0))),
    calculateNormalizedRangePct(scored.map(candidate => Number(candidate?.box?.width || 0) * Number(candidate?.box?.height || 0))),
  );

  const top = scored[0] || null;
  const second = scored[1] || null;
  const deterministicFallback = scored.find(candidate => candidate.source === 'deterministic_edge_snap') || null;
  const ambiguous = Boolean(top) && scored.length > 1 && (
    (top.supportCount === 0 && disagreementScorePct >= 22)
    || (second && Math.abs(top.arbitrationScore - second.arbitrationScore) < 0.08 && disagreementScorePct >= 18)
  );

  const selected = ambiguous && deterministicFallback
    ? deterministicFallback
    : top;

  return {
    selected,
    ambiguous,
    diagnostics: {
      candidateCount: scored.length,
      disagreementScorePct,
      selectedSource: selected?.source || null,
      selectedSupportCount: selected?.supportCount || 0,
      candidates: scored.map(candidate => ({
        source: candidate.source || 'unknown',
        confidence: Math.round(clamp01(candidate.confidence, 0.5) * 1000) / 1000,
        supportCount: candidate.supportCount,
        arbitrationScore: candidate.arbitrationScore,
        box: normalizedBoxCorners(candidate.box),
      })),
    },
  };
}

async function detectFaceplateWithExternalDetector(cropBuffer, anchorType) {
  if (!FACEPLATE_DETECTOR_URL) return null;

  try {
    const metadata = await sharp(cropBuffer, { limitInputPixels: false }).metadata();
    const imageWidth = metadata?.width || 1;
    const imageHeight = metadata?.height || 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FACEPLATE_DETECTOR_TIMEOUT_MS);
    const url = appendDetectorApiKey(FACEPLATE_DETECTOR_URL, FACEPLATE_DETECTOR_API_KEY);
    const base64 = Buffer.from(cropBuffer).toString('base64');
    const headers = FACEPLATE_DETECTOR_PROTOCOL === 'json'
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (FACEPLATE_DETECTOR_API_KEY && !/roboflow/i.test(url.hostname)) {
      headers.Authorization = `Bearer ${FACEPLATE_DETECTOR_API_KEY}`;
    }

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: FACEPLATE_DETECTOR_PROTOCOL === 'json'
          ? JSON.stringify({ image: base64, anchorType, classes: ['faceplate', 'outlet', 'switch'] })
          : base64,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`external detector ${response.status}: ${errorText.slice(0, 180)}`);
    }

    const responseJson = await response.json();
    const predictions = collectDetectorPredictions(responseJson)
      .filter(prediction => detectorClassMatchesAnchor(prediction, anchorType))
      .filter(prediction => clamp01(prediction.confidence ?? prediction.score ?? prediction.probability, 0) >= FACEPLATE_DETECTOR_MIN_CONFIDENCE)
      .map(prediction => {
        const box = normalizeDetectorPredictionBox(prediction, imageWidth, imageHeight);
        if (!box) return null;
        return {
          box,
          confidence: clamp01(prediction.confidence ?? prediction.score ?? prediction.probability, 0.5),
          source: 'learned_faceplate_detector',
          diagnostics: {
            class: prediction.class || prediction.label || prediction.name || null,
            rawConfidence: Math.round(clamp01(prediction.confidence ?? prediction.score ?? prediction.probability, 0.5) * 100) / 100,
            detectorProtocol: FACEPLATE_DETECTOR_PROTOCOL,
            corners: normalizedBoxCorners(box),
          },
        };
      })
      .filter(Boolean);

    if (!predictions.length) return null;
    const expectedAspect = faceplateAspectForType(anchorType);
    return predictions
      .map(candidate => ({ ...candidate, detectorScore: scoreFaceplateDetectorCandidate(candidate, expectedAspect) }))
      .sort((a, b) => b.detectorScore - a.detectorScore)[0];
  } catch (error) {
    console.warn('[PhotoMeasurement] External faceplate detector failed:', error.message);
    return null;
  }
}

async function detectMeasurementTargetWithExternalDetector(cropBuffer, targetType, roughBoxInCrop = null) {
  if (!MEASUREMENT_TARGET_DETECTOR_URL || !SPECIALIST_MEASUREMENT_TARGET_TYPES.has(targetType)) return null;

  try {
    const metadata = await sharp(cropBuffer, { limitInputPixels: false }).metadata();
    const imageWidth = metadata?.width || 1;
    const imageHeight = metadata?.height || 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEASUREMENT_TARGET_DETECTOR_TIMEOUT_MS);
    const url = appendDetectorApiKey(MEASUREMENT_TARGET_DETECTOR_URL, MEASUREMENT_TARGET_DETECTOR_API_KEY);
    const base64 = Buffer.from(cropBuffer).toString('base64');
    const headers = MEASUREMENT_TARGET_DETECTOR_PROTOCOL === 'json'
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (MEASUREMENT_TARGET_DETECTOR_API_KEY && !/roboflow/i.test(url.hostname)) {
      headers.Authorization = `Bearer ${MEASUREMENT_TARGET_DETECTOR_API_KEY}`;
    }

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: MEASUREMENT_TARGET_DETECTOR_PROTOCOL === 'json'
          ? JSON.stringify({
              image: base64,
              targetType,
              roughBox: roughBoxInCrop,
              classes: measurementTargetDetectorClassHints(targetType),
            })
          : base64,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`measurement detector ${response.status}: ${errorText.slice(0, 180)}`);
    }

    const responseJson = await response.json();
    const predictions = collectDetectorPredictions(responseJson)
      .filter(prediction => detectorClassMatchesMeasurementTarget(prediction, targetType))
      .filter(prediction => clamp01(prediction.confidence ?? prediction.score ?? prediction.probability, 0) >= MEASUREMENT_TARGET_DETECTOR_MIN_CONFIDENCE)
      .map(prediction => {
        const box = normalizeDetectorPredictionBox(prediction, imageWidth, imageHeight);
        if (!box) return null;
        return {
          box,
          confidence: clamp01(prediction.confidence ?? prediction.score ?? prediction.probability, 0.5),
          source: 'learned_measurement_detector',
          diagnostics: {
            class: prediction.class || prediction.label || prediction.name || null,
            roughBox: roughBoxInCrop ? normalizedBoxCorners(roughBoxInCrop) : null,
            detectorProtocol: MEASUREMENT_TARGET_DETECTOR_PROTOCOL,
          },
        };
      })
      .filter(Boolean);

    if (!predictions.length) return null;

    return predictions
      .map(candidate => ({
        ...candidate,
        detectorScore: scoreMeasurementTargetSpecialistCandidate(candidate, targetType, roughBoxInCrop, predictions),
      }))
      .sort((first, second) => second.detectorScore - first.detectorScore)[0];
  } catch (error) {
    console.warn('[PhotoMeasurement] External measurement detector failed:', error.message);
    return null;
  }
}

async function segmentMeasurementTargetWithExternalSegmenter(cropBuffer, targetType, roughBoxInCrop = null) {
  if (!MEASUREMENT_TARGET_SEGMENTATION_URL || !SPECIALIST_MEASUREMENT_TARGET_TYPES.has(targetType)) return null;

  try {
    const metadata = await sharp(cropBuffer, { limitInputPixels: false }).metadata();
    const imageWidth = metadata?.width || 1;
    const imageHeight = metadata?.height || 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEASUREMENT_TARGET_SEGMENTATION_TIMEOUT_MS);
    const base64 = Buffer.from(cropBuffer).toString('base64');
    const headers = MEASUREMENT_TARGET_SEGMENTATION_PROTOCOL === 'json'
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (MEASUREMENT_TARGET_SEGMENTATION_API_KEY) {
      headers.Authorization = `Bearer ${MEASUREMENT_TARGET_SEGMENTATION_API_KEY}`;
    }

    let response;
    try {
      response = await fetch(MEASUREMENT_TARGET_SEGMENTATION_URL, {
        method: 'POST',
        headers,
        body: MEASUREMENT_TARGET_SEGMENTATION_PROTOCOL === 'json'
          ? JSON.stringify({
              image: base64,
              targetType,
              roughBox: roughBoxInCrop,
            })
          : base64,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`measurement segmenter ${response.status}: ${errorText.slice(0, 180)}`);
    }

    const responseJson = await response.json();
    const directBox = normalizeDetectorPredictionBox(responseJson, imageWidth, imageHeight);
    const rawCandidates = [
      ...(directBox ? [{ box: directBox, confidence: responseJson.confidence ?? responseJson.maskConfidence ?? responseJson.score ?? 0.7 }] : []),
      ...collectDetectorPredictions(responseJson)
        .map(prediction => ({
          box: normalizeDetectorPredictionBox(prediction, imageWidth, imageHeight),
          confidence: prediction.confidence ?? prediction.score ?? prediction.probability ?? 0.6,
          label: prediction.class || prediction.label || prediction.name || null,
        })),
    ].filter(candidate => isValidNormalizedBox(candidate?.box));

    const predictions = rawCandidates
      .filter(candidate => clamp01(candidate.confidence, 0.5) >= MEASUREMENT_TARGET_SEGMENTATION_MIN_CONFIDENCE)
      .map(candidate => ({
        box: candidate.box,
        confidence: clamp01(candidate.confidence, 0.5),
        source: 'segmenter_mask',
        diagnostics: {
          label: candidate.label || responseJson.class || responseJson.label || null,
          roughBox: roughBoxInCrop ? normalizedBoxCorners(roughBoxInCrop) : null,
          segmenterProtocol: MEASUREMENT_TARGET_SEGMENTATION_PROTOCOL,
        },
      }));

    if (!predictions.length) return null;

    return predictions
      .map(candidate => ({
        ...candidate,
        segmenterScore: scoreMeasurementTargetSpecialistCandidate(candidate, targetType, roughBoxInCrop, predictions) + 0.04,
      }))
      .sort((first, second) => second.segmenterScore - first.segmenterScore)[0];
  } catch (error) {
    console.warn('[PhotoMeasurement] External measurement segmenter failed:', error.message);
    return null;
  }
}

async function detectFaceplateRectInCrop(cropBuffer, anchorType, roughBoxInCrop) {
  const image = sharp(cropBuffer, { limitInputPixels: false })
    .resize({ width: 760, height: 760, fit: 'inside', withoutEnlargement: true })
    .greyscale();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  if (!width || !height || data.length < width * height) return null;

  const gray = new Float32Array(width * height);
  const graySq = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = data[i];
    graySq[i] = data[i] * data[i];
  }
  const edges = estimateEdgeMap(gray, width, height);
  const grayIntegral = buildIntegralImage(gray, width, height);
  const graySqIntegral = buildIntegralImage(graySq, width, height);
  const edgeIntegral = buildIntegralImage(edges, width, height);

  const rough = clampNormalizedBox(roughBoxInCrop || { x: 0.35, y: 0.35, width: 0.3, height: 0.3 });
  const roughCenterX = (rough.x + rough.width / 2) * width;
  const roughCenterY = (rough.y + rough.height / 2) * height;
  const roughHeight = Math.max(12, rough.height * height);
  const aspect = faceplateAspectForType(anchorType);
  const minHeight = Math.max(12, Math.min(height * 0.10, roughHeight * 0.85));
  const maxHeight = Math.min(height * 0.55, Math.max(roughHeight * 2.6, height * 0.22));
  const centerRadiusX = Math.max(width * 0.28, rough.width * width * 2.8);
  const centerRadiusY = Math.max(height * 0.28, rough.height * height * 2.8);
  const aspectScales = anchorType === 'double_outlet' ? [0.82, 0.95, 1.08, 1.22] : [0.76, 0.9, 1, 1.12, 1.28];

  let best = null;
  for (let candidateHeight = minHeight; candidateHeight <= maxHeight; candidateHeight *= 1.13) {
    for (const aspectScale of aspectScales) {
      const candidateWidth = candidateHeight * aspect * aspectScale;
      if (candidateWidth < 8 || candidateWidth > width * 0.45) continue;
      const step = Math.max(2, Math.round(Math.min(candidateWidth, candidateHeight) / 5));
      const minCx = Math.max(candidateWidth / 2, roughCenterX - centerRadiusX);
      const maxCx = Math.min(width - candidateWidth / 2, roughCenterX + centerRadiusX);
      const minCy = Math.max(candidateHeight / 2, roughCenterY - centerRadiusY);
      const maxCy = Math.min(height - candidateHeight / 2, roughCenterY + centerRadiusY);

      for (let cy = minCy; cy <= maxCy; cy += step) {
        for (let cx = minCx; cx <= maxCx; cx += step) {
          const x1 = cx - candidateWidth / 2;
          const y1 = cy - candidateHeight / 2;
          const x2 = cx + candidateWidth / 2;
          const y2 = cy + candidateHeight / 2;
          const border = Math.max(1, Math.round(Math.min(candidateWidth, candidateHeight) * 0.08));
          const pad = Math.max(3, Math.round(Math.min(candidateWidth, candidateHeight) * 0.18));

          const topEdge = rectMean(edgeIntegral, width, height, x1, y1, x2, y1 + border);
          const bottomEdge = rectMean(edgeIntegral, width, height, x1, y2 - border, x2, y2);
          const leftEdge = rectMean(edgeIntegral, width, height, x1, y1, x1 + border, y2);
          const rightEdge = rectMean(edgeIntegral, width, height, x2 - border, y1, x2, y2);
          const borderEdge = (topEdge + bottomEdge + leftEdge + rightEdge) / 4;
          const interior = rectStats(grayIntegral, graySqIntegral, width, height, x1 + border, y1 + border, x2 - border, y2 - border);
          const outerX1 = Math.max(0, x1 - pad);
          const outerY1 = Math.max(0, y1 - pad);
          const outerX2 = Math.min(width, x2 + pad);
          const outerY2 = Math.min(height, y2 + pad);
          const outerMean = rectMean(grayIntegral, width, height, outerX1, outerY1, outerX2, outerY2);
          const contrast = Math.abs(interior.mean - outerMean);
          const centerDistance = Math.hypot((cx - roughCenterX) / Math.max(1, centerRadiusX), (cy - roughCenterY) / Math.max(1, centerRadiusY));
          const aspectPenalty = Math.abs(Math.log((candidateWidth / candidateHeight) / aspect));
          const score = borderEdge * 0.62 + contrast * 1.15 - interior.std * 0.42 - centerDistance * 18 - aspectPenalty * 8;

          if (!best || score > best.score) {
            best = { x: x1, y: y1, width: candidateWidth, height: candidateHeight, score, borderEdge, contrast, interiorStd: interior.std };
          }
        }
      }
    }
  }

  const scannedConfidence = best ? Math.max(0, Math.min(1, (best.score - 14) / 34)) : 0;
  const scannedCandidate = best && scannedConfidence >= 0.34 && best.borderEdge >= 18 ? {
    box: {
      x: best.x / width,
      y: best.y / height,
      width: best.width / width,
      height: best.height / height,
    },
    confidence: scannedConfidence,
    source: 'rectangle_scan',
    diagnostics: {
      score: Math.round(best.score * 10) / 10,
      borderEdge: Math.round(best.borderEdge * 10) / 10,
      contrast: Math.round(best.contrast * 10) / 10,
      interiorStd: Math.round(best.interiorStd * 10) / 10,
    },
  } : null;

  const lineCandidates = [];
  const roughSnap = await snapMeasurementTargetRectInCrop(cropBuffer, anchorType, rough);
  if (roughSnap) lineCandidates.push({ ...roughSnap, source: 'line_profile_snap', diagnostics: { ...(roughSnap.diagnostics || {}), snapSeed: 'rough_box' } });
  if (scannedCandidate) {
    const scannedSnap = await snapMeasurementTargetRectInCrop(cropBuffer, anchorType, scannedCandidate.box);
    if (scannedSnap) lineCandidates.push({ ...scannedSnap, source: 'line_profile_snap', diagnostics: { ...(scannedSnap.diagnostics || {}), snapSeed: 'rectangle_scan' } });
  }

  const learnedCandidate = await detectFaceplateWithExternalDetector(cropBuffer, anchorType);

  const candidates = [learnedCandidate, scannedCandidate, ...lineCandidates].filter(Boolean).map(candidate => ({
    ...candidate,
    detectorScore: scoreFaceplateDetectorCandidate(candidate, aspect),
  })).sort((a, b) => b.detectorScore - a.detectorScore);

  const selected = candidates[0];
  if (!selected || selected.detectorScore < 0.20) return null;

  return {
    box: selected.box,
    confidence: clamp01(selected.confidence, 0.5),
    source: selected.source || 'deterministic_faceplate_detector',
    diagnostics: {
      ...(selected.diagnostics || {}),
      detectorScore: Math.round(selected.detectorScore * 100) / 100,
      candidateCount: candidates.length,
      expectedAspect: Math.round(aspect * 100) / 100,
      corners: selected.diagnostics?.corners || normalizedBoxCorners(selected.box),
    },
  };
}

async function refineSmallScaleAnchorsWithCrops(images, scaleAnchors) {
  if (!scaleAnchors?.ok || !Array.isArray(scaleAnchors.photos)) {
    return { ...scaleAnchors, refinedCount: 0, cropRefinementOk: false };
  }

  const sanitizedScaleAnchors = {
    ...scaleAnchors,
    photos: scaleAnchors.photos.filter(photo => {
      const photoIndex = Number(photo.photoIndex);
      return Number.isInteger(photoIndex) && photoIndex >= 0 && photoIndex < images.length;
    }),
  };

  const cropRequests = [];

  try {
    for (const photo of sanitizedScaleAnchors.photos) {
      const photoIndex = Number(photo.photoIndex);
      if (!Number.isInteger(photoIndex) || !images[photoIndex]) continue;

      const buffer = await imageInputToBuffer(images[photoIndex]);
      const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
      if (!metadata?.width || !metadata?.height) continue;

      for (const anchor of (photo.referenceObjects || [])) {
        if (!shouldCropRefineScaleAnchor(anchor) || anchor.useForScale === false || !isValidNormalizedBox(anchor.boundingBox)) continue;
        if (cropRequests.length >= 10) break;

        const bbox = clampNormalizedBox(anchor.boundingBox);
        const centerX = bbox.x + bbox.width / 2;
        const centerY = bbox.y + bbox.height / 2;
        const cropSize = scaleAnchorCropSize(bbox, anchor.type);
        const cropNormWidth = cropSize.width;
        const cropNormHeight = cropSize.height;
        const cropX = Math.max(0, Math.min(1 - cropNormWidth, centerX - cropNormWidth / 2));
        const cropY = Math.max(0, Math.min(1 - cropNormHeight, centerY - cropNormHeight / 2));
        const left = Math.max(0, Math.floor(cropX * metadata.width));
        const top = Math.max(0, Math.floor(cropY * metadata.height));
        const width = Math.max(8, Math.min(metadata.width - left, Math.ceil(cropNormWidth * metadata.width)));
        const height = Math.max(8, Math.min(metadata.height - top, Math.ceil(cropNormHeight * metadata.height)));
        if (width < 16 || height < 16) continue;

        const cropBuffer = await sharp(buffer, { limitInputPixels: false })
          .extract({ left, top, width, height })
          .jpeg({ quality: 92 })
          .toBuffer();

        cropRequests.push({
          cropIndex: cropRequests.length,
          photoIndex,
          anchor,
          imageWidth: metadata.width,
          imageHeight: metadata.height,
          cropKind: SMALL_FIXTURE_ANCHOR_TYPES.has(anchor.type) ? 'small_fixture' : 'planar_anchor',
          crop: { left, top, width, height },
          roughBoxInCrop: {
            x: (bbox.x * metadata.width - left) / width,
            y: (bbox.y * metadata.height - top) / height,
            width: (bbox.width * metadata.width) / width,
            height: (bbox.height * metadata.height) / height,
          },
          dataUrl: bufferToDataUrl(cropBuffer, 'image/jpeg'),
          cropBuffer,
        });
      }
    }

    if (!cropRequests.length) {
      return { ...sanitizedScaleAnchors, refinedCount: 0, cropRefinementOk: true };
    }

    let refinedCount = 0;
    for (const request of cropRequests) {
      const deterministic = request.cropKind === 'small_fixture'
        ? await detectFaceplateRectInCrop(request.cropBuffer, request.anchor.type, request.roughBoxInCrop)
        : await snapMeasurementTargetRectInCrop(request.cropBuffer, scaleAnchorCropTargetType(request.anchor.type), request.roughBoxInCrop);
      if (!deterministic) continue;

      const box = clampNormalizedBox(deterministic.box);
      const globalBox = {
        x: (request.crop.left + box.x * request.crop.width) / request.imageWidth,
        y: (request.crop.top + box.y * request.crop.height) / request.imageHeight,
        width: (box.width * request.crop.width) / request.imageWidth,
        height: (box.height * request.crop.height) / request.imageHeight,
      };

      request.anchor.roughBoundingBox = request.anchor.boundingBox;
      request.anchor.boundingBox = clampNormalizedBox(globalBox);
      request.anchor.confidence = Math.max(clamp01(request.anchor.confidence, 0.8), deterministic.confidence);
      request.anchor.cropRefined = true;
      request.anchor.deterministicRefined = true;
      request.anchor.geometryRefined = true;
      request.anchor.learnedDetectorRefined = deterministic.source === 'learned_faceplate_detector';
      request.anchor.cropRefinementReason = request.cropKind === 'small_fixture'
        ? `faceplate_${deterministic.source || 'rectangle'}`
        : 'deterministic_planar_anchor_edges';
      request.anchor.deterministicDiagnostics = deterministic.diagnostics;
      request.anchor.source = request.cropKind === 'small_fixture'
        ? `deterministic_faceplate_detector:${deterministic.source || 'rectangle_scan'}`
        : 'deterministic_planar_anchor_detector';
      request.deterministicallyRefined = true;
      refinedCount++;
    }

    const gptCropRequests = cropRequests.filter(request => !request.deterministicallyRefined && request.cropKind === 'small_fixture');
    if (!gptCropRequests.length) {
      return { ...sanitizedScaleAnchors, refinedCount, cropRefinementOk: true };
    }

    const prompt = `You are refining scale-anchor bounding boxes from cropped real-estate photos.

Each crop is centered near a small standard fixture, but the rough detector can be off. Search the whole crop. For each crop, locate the exact outer rectangle of the visible faceplate only.

Rules:
- For electrical outlets and light switches, box the rectangular faceplate edge-to-edge.
- Exclude shadows, wall area, screws outside the plate, door trim, and surrounding paint.
- If a faceplate is visible anywhere in the crop, return usable=true even if it is not centered.
- If the faceplate is not clearly visible anywhere in the crop, return usable=false.
- Coordinates are normalized 0-1 inside that crop image.

Return ONLY valid JSON:
{
  "crops": [
    { "cropIndex": 0, "usable": true, "refinedBox": { "x": 0.34, "y": 0.28, "width": 0.20, "height": 0.32 }, "confidence": 0.92, "reason": "tight faceplate bounds" }
  ]
}`;

    const content = [{ type: 'text', text: prompt }];
    for (const request of gptCropRequests) {
      content.push({ type: 'text', text: `cropIndex ${request.cropIndex}: ${request.anchor.type}` });
      content.push({ type: 'image_url', image_url: { url: request.dataUrl, detail: 'high' } });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content }],
        max_tokens: 1800,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI crop refinement error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    const message = result.choices?.[0]?.message?.content || '';
    const jsonMatch = message.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse scale-anchor crop refinement response');

    const refined = JSON.parse(jsonMatch[0]);
    const refinedByIndex = new Map((refined.crops || []).map(crop => [Number(crop.cropIndex), crop]));

    for (const request of gptCropRequests) {
      const cropResult = refinedByIndex.get(request.cropIndex);
      const refinedBox = cropResult?.refinedBox || cropResult?.boundingBox || cropResult?.box;
      if (cropResult?.usable === false || !isValidNormalizedBox(refinedBox)) continue;

      const box = clampNormalizedBox(refinedBox);
      const globalBox = {
        x: (request.crop.left + box.x * request.crop.width) / request.imageWidth,
        y: (request.crop.top + box.y * request.crop.height) / request.imageHeight,
        width: (box.width * request.crop.width) / request.imageWidth,
        height: (box.height * request.crop.height) / request.imageHeight,
      };

      request.anchor.roughBoundingBox = request.anchor.boundingBox;
      request.anchor.boundingBox = clampNormalizedBox(globalBox);
      request.anchor.confidence = Math.max(clamp01(request.anchor.confidence, 0.8), clamp01(cropResult.confidence, 0.85));
      request.anchor.cropRefined = true;
      request.anchor.cropRefinementReason = cropResult.reason || null;
      request.anchor.source = 'scale_anchor_crop_refined';
      refinedCount++;
    }

    return { ...sanitizedScaleAnchors, refinedCount, cropRefinementOk: true };
  } catch (error) {
    console.warn('[PhotoMeasurement] Scale-anchor crop refinement failed:', error.message);
    return { ...sanitizedScaleAnchors, refinedCount: 0, cropRefinementOk: false, cropRefinementError: error.message };
  }
}

function targetAspectRange(targetType) {
  if (targetType === 'electrical_outlet' || targetType === 'light_switch') return [0.46, 0.78];
  if (targetType === 'double_outlet') return [0.82, 1.25];
  if (targetType === 'subway_tile') return [1.65, 2.35];
  if (targetType === 'floor_tile') return [0.70, 1.45];
  if (['fridge_opening', 'existing_fridge'].includes(targetType)) return [0.25, 0.95];
  if (['range_opening', 'dishwasher_opening', 'existing_range', 'existing_dishwasher'].includes(targetType)) return [0.40, 1.25];
  if (targetType === 'existing_microwave') return [0.85, 3.40];
  if (['vanity_space', 'existing_vanity'].includes(targetType)) return [0.45, 3.80];
  if (targetType === 'existing_toilet') return [0.35, 1.45];
  if (targetType === 'bathroom_mirror') return [0.50, 2.35];
  if (targetType === 'shower_door_opening') return [0.28, 1.60];
  if (targetType === 'door') return [0.20, 0.85];
  if (targetType === 'window') return [0.35, 4.20];
  if (targetType === 'existing_bathtub') return [0.35, 3.40];
  if (['cabinet_run', 'cabinet_run_lower', 'cabinet_run_upper'].includes(targetType)) return [0.85, 14.0];
  if (targetType === 'countertop_run') return [1.40, 24.0];
  return [0.20, 16.0];
}

function measurementTargetCropSize(targetType, bbox) {
  if (['vanity_space', 'existing_vanity'].includes(targetType)) {
    return {
      width: Math.min(0.98, Math.max(0.24, bbox.width * 3.0)),
      height: Math.min(0.96, Math.max(0.22, bbox.height * 2.2)),
    };
  }

  if (targetType === 'existing_toilet') {
    return {
      width: Math.min(0.98, Math.max(0.24, bbox.width * 2.6)),
      height: Math.min(0.96, Math.max(0.24, bbox.height * 2.5)),
    };
  }

  if (targetType === 'bathroom_mirror') {
    return {
      width: Math.min(0.98, Math.max(0.26, bbox.width * 3.0)),
      height: Math.min(0.96, Math.max(0.24, bbox.height * 2.6)),
    };
  }

  if (targetType === 'shower_door_opening') {
    return {
      width: Math.min(0.98, Math.max(0.24, bbox.width * 2.4)),
      height: Math.min(0.96, Math.max(0.24, bbox.height * 2.15)),
    };
  }

  if (targetType === 'existing_bathtub') {
    return {
      width: Math.min(0.98, Math.max(0.28, bbox.width * 2.8)),
      height: Math.min(0.98, Math.max(0.28, bbox.height * 2.8)),
    };
  }

  return {
    width: Math.min(0.96, Math.max(0.18, bbox.width * 1.75)),
    height: Math.min(0.96, Math.max(0.18, bbox.height * 1.75)),
  };
}

function targetSnapExpansionLimits(targetType, roughWidth, roughHeight) {
  if (['vanity_space', 'existing_vanity'].includes(targetType)) {
    return {
      radiusX: Math.max(12, roughWidth * 0.85),
      radiusY: Math.max(10, roughHeight * 0.45),
      minWidthScale: 0.65,
      maxWidthScale: 3.0,
      minHeightScale: 0.52,
      maxHeightScale: 1.9,
    };
  }

  if (targetType === 'existing_toilet') {
    return {
      radiusX: Math.max(12, roughWidth * 0.70),
      radiusY: Math.max(12, roughHeight * 0.65),
      minWidthScale: 0.62,
      maxWidthScale: 2.1,
      minHeightScale: 0.60,
      maxHeightScale: 2.15,
    };
  }

  if (targetType === 'bathroom_mirror') {
    return {
      radiusX: Math.max(14, roughWidth * 0.92),
      radiusY: Math.max(12, roughHeight * 0.72),
      minWidthScale: 0.42,
      maxWidthScale: 3.1,
      minHeightScale: 0.42,
      maxHeightScale: 2.5,
    };
  }

  if (targetType === 'shower_door_opening') {
    return {
      radiusX: Math.max(14, roughWidth * 0.88),
      radiusY: Math.max(12, roughHeight * 0.58),
      minWidthScale: 0.60,
      maxWidthScale: 2.5,
      minHeightScale: 0.55,
      maxHeightScale: 2.0,
    };
  }

  if (targetType === 'existing_bathtub') {
    return {
      radiusX: Math.max(16, roughWidth * 0.96),
      radiusY: Math.max(16, roughHeight * 0.96),
      minWidthScale: 0.58,
      maxWidthScale: 3.25,
      minHeightScale: 0.58,
      maxHeightScale: 3.25,
    };
  }

  return {
    radiusX: Math.max(10, roughWidth * 0.28),
    radiusY: Math.max(10, roughHeight * 0.28),
    minWidthScale: 0.45,
    maxWidthScale: 1.85,
    minHeightScale: 0.45,
    maxHeightScale: 1.85,
  };
}

function findStrongProfileLine(profile, expectedIndex, radius, minIndex, maxIndex) {
  const lo = Math.max(0, Math.min(profile.length - 1, Math.floor(minIndex)));
  const hi = Math.max(lo, Math.min(profile.length - 1, Math.ceil(maxIndex)));
  if (hi <= lo) return null;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = lo; i <= hi; i++) {
    const value = profile[i] || 0;
    sum += value;
    sumSq += value * value;
    count++;
  }
  const mean = count ? sum / count : 0;
  const variance = Math.max(0, count ? sumSq / count - mean * mean : 0);
  const std = Math.sqrt(variance) || 1;

  let best = null;
  for (let i = lo; i <= hi; i++) {
    const closeness = 1 - Math.min(1, Math.abs(i - expectedIndex) / Math.max(1, radius));
    const value = profile[i] || 0;
    const score = value * (0.68 + closeness * 0.32);
    if (!best || score > best.score) {
      best = { index: i, value, score, closeness };
    }
  }

  if (!best) return null;
  const strength = (best.value - mean) / std;
  const confidence = clamp01((strength - 0.85) / 2.8, 0);
  if (strength < 1.25 || confidence < 0.18) return null;
  return { index: best.index, confidence, strength: Math.round(strength * 100) / 100 };
}

async function snapMeasurementTargetRectInCrop(cropBuffer, targetType, roughBoxInCrop) {
  const image = sharp(cropBuffer, { limitInputPixels: false })
    .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
    .greyscale();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  if (!width || !height || data.length < width * height) return null;

  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) gray[i] = data[i];
  const edges = estimateEdgeMap(gray, width, height);
  const rough = clampNormalizedBox(roughBoxInCrop || { x: 0.2, y: 0.2, width: 0.6, height: 0.6 });

  const roughLeft = rough.x * width;
  const roughTop = rough.y * height;
  const roughRight = (rough.x + rough.width) * width;
  const roughBottom = (rough.y + rough.height) * height;
  const roughWidth = Math.max(4, roughRight - roughLeft);
  const roughHeight = Math.max(4, roughBottom - roughTop);
  if (roughWidth < 8 || roughHeight < 8) return null;

  const yStart = Math.max(0, Math.floor(roughTop + roughHeight * 0.08));
  const yEnd = Math.min(height - 1, Math.ceil(roughBottom - roughHeight * 0.08));
  const xStart = Math.max(0, Math.floor(roughLeft + roughWidth * 0.08));
  const xEnd = Math.min(width - 1, Math.ceil(roughRight - roughWidth * 0.08));
  const verticalProfile = new Float32Array(width);
  const horizontalProfile = new Float32Array(height);

  for (let y = yStart; y <= yEnd; y++) {
    for (let x = 0; x < width; x++) verticalProfile[x] += edges[y * width + x] || 0;
  }
  for (let x = xStart; x <= xEnd; x++) {
    for (let y = 0; y < height; y++) horizontalProfile[y] += edges[y * width + x] || 0;
  }
  const vCount = Math.max(1, yEnd - yStart + 1);
  const hCount = Math.max(1, xEnd - xStart + 1);
  for (let x = 0; x < width; x++) verticalProfile[x] /= vCount;
  for (let y = 0; y < height; y++) horizontalProfile[y] /= hCount;

  const expansionLimits = targetSnapExpansionLimits(targetType, roughWidth, roughHeight);
  const radiusX = expansionLimits.radiusX;
  const radiusY = expansionLimits.radiusY;
  const leftLine = findStrongProfileLine(verticalProfile, roughLeft, radiusX, roughLeft - radiusX, Math.min(roughLeft + radiusX, roughRight - 5));
  const rightLine = findStrongProfileLine(verticalProfile, roughRight, radiusX, Math.max(roughRight - radiusX, roughLeft + 5), roughRight + radiusX);
  const topLine = findStrongProfileLine(horizontalProfile, roughTop, radiusY, roughTop - radiusY, Math.min(roughTop + radiusY, roughBottom - 5));
  const bottomLine = findStrongProfileLine(horizontalProfile, roughBottom, radiusY, Math.max(roughBottom - radiusY, roughTop + 5), roughBottom + radiusY);

  const foundLines = [leftLine, rightLine, topLine, bottomLine].filter(Boolean);
  if (foundLines.length < 2) return null;

  const newLeft = leftLine?.index ?? roughLeft;
  const newRight = rightLine?.index ?? roughRight;
  const newTop = topLine?.index ?? roughTop;
  const newBottom = bottomLine?.index ?? roughBottom;
  const newWidth = newRight - newLeft;
  const newHeight = newBottom - newTop;
  if (newWidth < roughWidth * expansionLimits.minWidthScale || newWidth > roughWidth * expansionLimits.maxWidthScale) return null;
  if (newHeight < roughHeight * expansionLimits.minHeightScale || newHeight > roughHeight * expansionLimits.maxHeightScale) return null;

  const aspect = newWidth / Math.max(1, newHeight);
  const [minAspect, maxAspect] = targetAspectRange(targetType);
  if (aspect < minAspect || aspect > maxAspect) return null;

  const confidence = foundLines.reduce((sum, line) => sum + line.confidence, 0) / foundLines.length;
  if (confidence < 0.26) return null;

  return {
    box: {
      x: newLeft / width,
      y: newTop / height,
      width: newWidth / width,
      height: newHeight / height,
    },
    source: 'deterministic_edge_snap',
    confidence,
    diagnostics: {
      foundLines: foundLines.length,
      aspect: Math.round(aspect * 100) / 100,
      lineStrengths: foundLines.map(line => line.strength),
    },
  };
}

async function refineMeasurementTargetsWithCrops(images, detections) {
  if (!detections?.ok || !Array.isArray(detections.photos)) {
    return { detections, refinedCount: 0, attemptedCount: 0, ok: false };
  }

  let refinedCount = 0;
  let attemptedCount = 0;
  let specialistRefinedCount = 0;
  let ambiguousCount = 0;

  try {
    for (const photo of detections.photos) {
      const photoIndex = Number(photo.photoIndex);
      if (!Number.isInteger(photoIndex) || photoIndex < 0 || photoIndex >= images.length) continue;
      if (!Array.isArray(photo.measurementTargets) || !photo.measurementTargets.length) continue;

      const buffer = await imageInputToBuffer(images[photoIndex]);
      const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
      if (!metadata?.width || !metadata?.height) continue;

      for (const target of photo.measurementTargets) {
        if (attemptedCount >= 24) break;
        if (!EDGE_REFINED_TARGET_TYPES.has(target?.targetType) || !isValidNormalizedBox(target.boundingBox)) continue;

        const bbox = clampNormalizedBox(target.boundingBox);
        const centerX = bbox.x + bbox.width / 2;
        const centerY = bbox.y + bbox.height / 2;
        const cropSize = measurementTargetCropSize(target.targetType, bbox);
        const cropNormWidth = cropSize.width;
        const cropNormHeight = cropSize.height;
        const cropX = Math.max(0, Math.min(1 - cropNormWidth, centerX - cropNormWidth / 2));
        const cropY = Math.max(0, Math.min(1 - cropNormHeight, centerY - cropNormHeight / 2));
        const left = Math.max(0, Math.floor(cropX * metadata.width));
        const top = Math.max(0, Math.floor(cropY * metadata.height));
        const width = Math.max(16, Math.min(metadata.width - left, Math.ceil(cropNormWidth * metadata.width)));
        const height = Math.max(16, Math.min(metadata.height - top, Math.ceil(cropNormHeight * metadata.height)));
        if (width < 32 || height < 32) continue;

        attemptedCount++;
        const cropBuffer = await sharp(buffer, { limitInputPixels: false })
          .extract({ left, top, width, height })
          .jpeg({ quality: 92 })
          .toBuffer();

        const roughBoxInCrop = {
          x: (bbox.x * metadata.width - left) / width,
          y: (bbox.y * metadata.height - top) / height,
          width: (bbox.width * metadata.width) / width,
          height: (bbox.height * metadata.height) / height,
        };
        const candidates = [];
        const snapped = await snapMeasurementTargetRectInCrop(cropBuffer, target.targetType, roughBoxInCrop);
        if (snapped) candidates.push(snapped);

        const learnedDetectorCandidate = await detectMeasurementTargetWithExternalDetector(cropBuffer, target.targetType, roughBoxInCrop);
        if (learnedDetectorCandidate) candidates.push(learnedDetectorCandidate);

        const segmenterCandidate = await segmentMeasurementTargetWithExternalSegmenter(cropBuffer, target.targetType, roughBoxInCrop);
        if (segmenterCandidate) candidates.push(segmenterCandidate);

        if (!candidates.length) continue;

        const arbitration = arbitrateMeasurementTargetCandidates(target.targetType, roughBoxInCrop, candidates);
        const selected = arbitration.selected;
        target.specialistRefinementDiagnostics = arbitration.diagnostics;
        target.specialistAmbiguous = Boolean(arbitration.ambiguous);
        target.specialistSelectedSource = selected?.source || null;
        target.specialistSupportCount = arbitration.diagnostics?.selectedSupportCount || 0;
        target.specialistRefinementReason = selected?.source || null;
        if (arbitration.ambiguous) ambiguousCount++;
        if (!selected) continue;

        const box = clampNormalizedBox(selected.box);
        const globalBox = clampNormalizedBox({
          x: (left + box.x * width) / metadata.width,
          y: (top + box.y * height) / metadata.height,
          width: (box.width * width) / metadata.width,
          height: (box.height * height) / metadata.height,
        });
        if (!isValidNormalizedBox(globalBox)) continue;

        target.roughBoundingBox = target.boundingBox;
        target.boundingBox = globalBox;
        target.edgeRefined = selected.source === 'deterministic_edge_snap' || selected.source === 'segmenter_mask';
        target.cropRefined = selected.source === 'segmenter_mask';
        target.learnedDetectorRefined = selected.source === 'learned_measurement_detector';
        target.segmenterRefined = selected.source === 'segmenter_mask';
        target.specialistRefined = selected.source !== 'deterministic_edge_snap';
        target.edgeRefinementReason = selected.source;
        target.edgeRefinementDiagnostics = {
          ...(selected.diagnostics || {}),
          arbitration: arbitration.diagnostics,
        };
        target.confidence = Math.max(clamp01(target.confidence, 0.72), clamp01(selected.confidence, 0.75));
        refinedCount++;
        if (target.specialistRefined) specialistRefinedCount++;
      }
    }

    return {
      detections,
      refinedCount,
      attemptedCount,
      specialistRefinedCount,
      ambiguousCount,
      specialistDetectorEnabled: Boolean(MEASUREMENT_TARGET_DETECTOR_URL),
      segmenterEnabled: Boolean(MEASUREMENT_TARGET_SEGMENTATION_URL),
      ok: true,
    };
  } catch (error) {
    console.warn('[PhotoMeasurement] Object target crop refinement failed:', error.message);
    return {
      detections,
      refinedCount,
      attemptedCount,
      specialistRefinedCount,
      ambiguousCount,
      specialistDetectorEnabled: Boolean(MEASUREMENT_TARGET_DETECTOR_URL),
      segmenterEnabled: Boolean(MEASUREMENT_TARGET_SEGMENTATION_URL),
      ok: false,
      error: error.message,
    };
  }
}

function bboxCenterDistance(firstBox, secondBox) {
  const firstCenterX = Number(firstBox?.x || 0) + Number(firstBox?.width || 0) / 2;
  const firstCenterY = Number(firstBox?.y || 0) + Number(firstBox?.height || 0) / 2;
  const secondCenterX = Number(secondBox?.x || 0) + Number(secondBox?.width || 0) / 2;
  const secondCenterY = Number(secondBox?.y || 0) + Number(secondBox?.height || 0) / 2;
  return Math.hypot(firstCenterX - secondCenterX, firstCenterY - secondCenterY);
}

function bboxIntersectionOverUnion(firstBox, secondBox) {
  const a = clampNormalizedBox(firstBox || {});
  const b = clampNormalizedBox(secondBox || {});
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const intersection = ix * iy;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function referencePriority(ref) {
  return clamp01(ref?.confidence, 0.7) +
    clamp01(ref?.standardSizeConfidence, VARIABLE_STANDARD_ANCHOR_TYPES.has(getReferenceProfileType(ref)) ? 0.52 : 0.72) +
    (ref?.useForScale === true ? 0.35 : 0) +
    (ref?.cropRefined ? 0.5 : 0) +
    (String(ref?.source || '').includes('scale_anchor') ? 0.2 : 0) +
    (String(ref?.source || '').includes('known_scene_anchor') ? 0.45 : 0);
}

function areDuplicateReferenceAnchors(first, second) {
  if (!first?.type || first.type !== second?.type) return false;
  const distance = bboxCenterDistance(first.boundingBox, second.boundingBox);
  const iou = bboxIntersectionOverUnion(first.boundingBox, second.boundingBox);
  const smallFixture = SMALL_FIXTURE_ANCHOR_TYPES.has(first.type);
  return iou >= 0.18 || distance <= (smallFixture ? 0.10 : 0.06);
}

function dedupeReferenceObjects(referenceObjects = []) {
  const deduped = [];
  for (const ref of referenceObjects) {
    if (!ref?.type || !isValidNormalizedBox(ref.boundingBox)) continue;
    const existingIndex = deduped.findIndex(existing => areDuplicateReferenceAnchors(existing, ref));
    if (existingIndex === -1) {
      deduped.push(ref);
      continue;
    }
    if (referencePriority(ref) > referencePriority(deduped[existingIndex])) {
      deduped[existingIndex] = ref;
    }
  }
  return deduped;
}

function medianNumeric(values = [], fallback = null) {
  const numeric = values.map(value => Number(value)).filter(Number.isFinite).sort((first, second) => first - second);
  if (!numeric.length) return fallback;
  const middle = Math.floor(numeric.length / 2);
  if (numeric.length % 2 === 1) return numeric[middle];
  return (numeric[middle - 1] + numeric[middle]) / 2;
}

function chooseMajorityValue(values = [], fallback = null) {
  const filtered = values.filter(value => value !== undefined && value !== null && value !== '');
  if (!filtered.length) return fallback;
  const counts = new Map();
  for (const value of filtered) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1])
    .map(entry => entry[0])[0] ?? fallback;
}

function mergeConsensusBoxes(items = []) {
  const validItems = items.filter(item => isValidNormalizedBox(item?.boundingBox));
  if (!validItems.length) return null;

  let totalWeight = 0;
  let x = 0;
  let y = 0;
  let width = 0;
  let height = 0;

  for (const item of validItems) {
    const box = clampNormalizedBox(item.boundingBox);
    const weight = Math.max(0.2, clamp01(item.confidence, 0.6));
    totalWeight += weight;
    x += box.x * weight;
    y += box.y * weight;
    width += box.width * weight;
    height += box.height * weight;
  }

  return clampNormalizedBox({
    x: x / Math.max(totalWeight, 1),
    y: y / Math.max(totalWeight, 1),
    width: width / Math.max(totalWeight, 1),
    height: height / Math.max(totalWeight, 1),
  });
}

function getReferenceConsensusGroup(ref) {
  const profileType = getReferenceProfileType(ref);
  if (/^bathroom_vanity_/i.test(profileType || '') && profileType !== 'bathroom_vanity_auto') return 'bathroom_vanity_family';
  if (profileType === 'standard_toilet' || profileType === 'toilet') return 'toilet_family';
  if (profileType === 'standard_bathtub' || profileType === 'bathtub') return 'bathtub_family';
  return profileType;
}

function areConsensusReferenceAnchors(first, second) {
  if (!first?.type || !second?.type) return false;
  if (getReferenceConsensusGroup(first) !== getReferenceConsensusGroup(second)) return false;
  const distance = bboxCenterDistance(first.boundingBox, second.boundingBox);
  const iou = bboxIntersectionOverUnion(first.boundingBox, second.boundingBox);
  return iou >= 0.16 || distance <= 0.10;
}

function targetPriority(target) {
  return clamp01(target?.confidence, 0.68) +
    (target?.edgeRefined ? 0.35 : 0) +
    (target?.cropRefined ? 0.18 : 0);
}

function areDuplicateMeasurementTargets(first, second) {
  if (!first?.targetType || first.targetType !== second?.targetType) return false;
  if (first.targetType === 'bathroom_mirror') {
    const firstFamily = getBathroomMirrorFamilyKey(first);
    const secondFamily = getBathroomMirrorFamilyKey(second);
    if (firstFamily && secondFamily && firstFamily !== secondFamily) return false;
  }
  const firstBox = clampNormalizedBox(first.boundingBox || {});
  const secondBox = clampNormalizedBox(second.boundingBox || {});
  const distance = bboxCenterDistance(first.boundingBox, second.boundingBox);
  const iou = bboxIntersectionOverUnion(first.boundingBox, second.boundingBox);
  if (COVERAGE_CONSENSUS_TARGET_TYPES.has(first.targetType)) {
    const firstArea = Math.max(0.0001, firstBox.width * firstBox.height);
    const secondArea = Math.max(0.0001, secondBox.width * secondBox.height);
    const areaRatio = Math.min(firstArea, secondArea) / Math.max(firstArea, secondArea);
    const firstContainsSecondCenter = (
      (secondBox.x + secondBox.width / 2) >= firstBox.x
      && (secondBox.x + secondBox.width / 2) <= firstBox.x + firstBox.width
      && (secondBox.y + secondBox.height / 2) >= firstBox.y
      && (secondBox.y + secondBox.height / 2) <= firstBox.y + firstBox.height
    );
    const secondContainsFirstCenter = (
      (firstBox.x + firstBox.width / 2) >= secondBox.x
      && (firstBox.x + firstBox.width / 2) <= secondBox.x + secondBox.width
      && (firstBox.y + firstBox.height / 2) >= secondBox.y
      && (firstBox.y + firstBox.height / 2) <= secondBox.y + secondBox.height
    );
    return iou >= 0.08 || distance <= 0.15 || ((firstContainsSecondCenter || secondContainsFirstCenter) && areaRatio >= 0.18);
  }
  return iou >= 0.16 || distance <= 0.09;
}

function dedupeMeasurementTargets(measurementTargets = []) {
  const deduped = [];
  for (const target of measurementTargets) {
    const normalizedTarget = normalizeMeasurementTargetForFamily(target);
    if (!normalizedTarget?.targetType || !SUPPORTED_MEASUREMENT_TARGET_TYPES.has(normalizedTarget.targetType) || !isValidNormalizedBox(normalizedTarget.boundingBox)) continue;
    const existingIndex = deduped.findIndex(existing => areDuplicateMeasurementTargets(existing, normalizedTarget));
    if (existingIndex === -1) {
      deduped.push(normalizedTarget);
      continue;
    }
    if (targetPriority(normalizedTarget) > targetPriority(deduped[existingIndex])) {
      deduped[existingIndex] = normalizedTarget;
    }
  }
  return deduped;
}

const COVERAGE_CONSENSUS_TARGET_TYPES = new Set(['existing_vanity', 'bathroom_mirror']);

function mergeMeasurementTargetConsensusBox(clusterItems = []) {
  const validTargets = clusterItems
    .map(item => item?.target)
    .filter(target => target?.targetType && isValidNormalizedBox(target?.boundingBox));
  if (!validTargets.length) {
    return { boundingBox: null, mergedBox: null, strategy: 'none', supportCount: 0 };
  }

  const base = [...validTargets].sort((first, second) => targetPriority(second) - targetPriority(first))[0];
  const mergedBox = mergeConsensusBoxes(validTargets);
  if (!mergedBox) {
    return {
      boundingBox: clampNormalizedBox(base.boundingBox),
      mergedBox: null,
      strategy: 'base_box',
      supportCount: validTargets.length,
    };
  }

  if (!COVERAGE_CONSENSUS_TARGET_TYPES.has(base.targetType) || validTargets.length < 2) {
    return {
      boundingBox: mergedBox,
      mergedBox,
      strategy: 'weighted_average',
      supportCount: validTargets.length,
    };
  }

  const refinedTargets = validTargets.filter(target => Boolean(target?.edgeRefined || target?.cropRefined));
  const supportTargets = refinedTargets.length ? refinedTargets : validTargets;
  const supportBoxes = supportTargets.map(target => clampNormalizedBox(target.boundingBox));
  const unionBounds = supportBoxes.reduce((acc, box) => ({
    minX: Math.min(acc.minX, box.x),
    minY: Math.min(acc.minY, box.y),
    maxX: Math.max(acc.maxX, box.x + box.width),
    maxY: Math.max(acc.maxY, box.y + box.height),
  }), { minX: 1, minY: 1, maxX: 0, maxY: 0 });

  const unionBox = clampNormalizedBox({
    x: unionBounds.minX,
    y: unionBounds.minY,
    width: Math.max(0.001, unionBounds.maxX - unionBounds.minX),
    height: Math.max(0.001, unionBounds.maxY - unionBounds.minY),
  });
  const scaleLimits = base.targetType === 'existing_vanity'
    ? { width: 1.85, height: 1.45 }
    : { width: 1.55, height: 1.35 };

  if (base.targetType === 'existing_vanity' && supportTargets.length >= 3) {
    const supportWidths = supportBoxes
      .map(box => Number(box.width || 0))
      .filter(value => Number.isFinite(value) && value > 0)
      .sort((first, second) => first - second);
    const supportAreas = supportBoxes
      .map(box => Number(box.width || 0) * Number(box.height || 0))
      .filter(value => Number.isFinite(value) && value > 0)
      .sort((first, second) => first - second);
    const compactWidthSeed = supportWidths.length
      ? supportWidths[Math.floor((supportWidths.length - 1) * 0.35)]
      : null;
    const broadWidthSeed = supportWidths.length
      ? supportWidths[Math.min(supportWidths.length - 1, Math.floor((supportWidths.length - 1) * 0.8))]
      : null;
    const compactAreaSeed = supportAreas.length
      ? supportAreas[Math.floor((supportAreas.length - 1) * 0.35)]
      : null;
    const broadAreaSeed = supportAreas.length
      ? supportAreas[Math.min(supportAreas.length - 1, Math.floor((supportAreas.length - 1) * 0.8))]
      : null;
    const splitCoverageCluster = Number.isFinite(compactWidthSeed)
      && Number.isFinite(broadWidthSeed)
      && Number.isFinite(compactAreaSeed)
      && Number.isFinite(broadAreaSeed)
      && broadWidthSeed >= compactWidthSeed * 1.35
      && broadAreaSeed >= compactAreaSeed * 1.7;

    if (splitCoverageCluster) {
      const compactCandidates = supportTargets.filter(target => {
        const box = clampNormalizedBox(target?.boundingBox || {});
        const area = Number(box.width || 0) * Number(box.height || 0);
        return box.width <= compactWidthSeed * 1.22 && area <= compactAreaSeed * 1.45;
      });
      const compactRefinedCandidates = compactCandidates.filter(target => Boolean(target?.edgeRefined || target?.cropRefined));
      const compactSupportTargets = compactRefinedCandidates.length >= 2 ? compactRefinedCandidates : compactCandidates;

      if (compactSupportTargets.length >= 2) {
        const compactMergedBox = mergeConsensusBoxes(compactSupportTargets);
        const compactBoxes = compactSupportTargets.map(target => clampNormalizedBox(target.boundingBox));
        const compactUnionBounds = compactBoxes.reduce((acc, box) => ({
          minX: Math.min(acc.minX, box.x),
          minY: Math.min(acc.minY, box.y),
          maxX: Math.max(acc.maxX, box.x + box.width),
          maxY: Math.max(acc.maxY, box.y + box.height),
        }), { minX: 1, minY: 1, maxX: 0, maxY: 0 });
        const compactUnionBox = clampNormalizedBox({
          x: compactUnionBounds.minX,
          y: compactUnionBounds.minY,
          width: Math.max(0.001, compactUnionBounds.maxX - compactUnionBounds.minX),
          height: Math.max(0.001, compactUnionBounds.maxY - compactUnionBounds.minY),
        });
        const compactCenterX = compactMergedBox.x + compactMergedBox.width / 2;
        const compactCenterY = compactMergedBox.y + compactMergedBox.height / 2;
        const compactExpandedWidth = Math.max(compactMergedBox.width, Math.min(compactUnionBox.width, compactMergedBox.width * 1.22));
        const compactExpandedHeight = Math.max(compactMergedBox.height, Math.min(compactUnionBox.height, compactMergedBox.height * 1.18));

        return {
          boundingBox: clampNormalizedBox({
            x: compactCenterX - compactExpandedWidth / 2,
            y: compactCenterY - compactExpandedHeight / 2,
            width: compactExpandedWidth,
            height: compactExpandedHeight,
          }),
          mergedBox: compactMergedBox,
          strategy: 'coverage_preserving_existing_vanity_compact_cluster',
          supportCount: compactSupportTargets.length,
        };
      }
    }
  }

  const mergedCenterX = mergedBox.x + mergedBox.width / 2;
  const mergedCenterY = mergedBox.y + mergedBox.height / 2;
  const expandedWidth = Math.max(mergedBox.width, Math.min(unionBox.width, mergedBox.width * scaleLimits.width));
  const expandedHeight = Math.max(mergedBox.height, Math.min(unionBox.height, mergedBox.height * scaleLimits.height));

  return {
    boundingBox: clampNormalizedBox({
      x: mergedCenterX - expandedWidth / 2,
      y: mergedCenterY - expandedHeight / 2,
      width: expandedWidth,
      height: expandedHeight,
    }),
    mergedBox,
    strategy: `coverage_preserving_${base.targetType}`,
    supportCount: supportTargets.length,
  };
}

function mergeReferenceObjectsFromPasses(referenceObjectPasses = [], passCount = 1) {
  const clusters = [];

  referenceObjectPasses.forEach((referenceObjects, passIndex) => {
    const dedupedPass = dedupeReferenceObjects(referenceObjects || []);
    for (const ref of dedupedPass) {
      if (!ref?.type || !isValidNormalizedBox(ref.boundingBox)) continue;
      const cluster = clusters.find(existing => existing.items.some(item => areConsensusReferenceAnchors(item.ref, ref)));
      if (cluster) {
        cluster.items.push({ ref, passIndex });
      } else {
        clusters.push({ items: [{ ref, passIndex }] });
      }
    }
  });

  return dedupeReferenceObjects(clusters.map(cluster => {
    const base = [...cluster.items]
      .sort((first, second) => referencePriority(second.ref) - referencePriority(first.ref))[0]?.ref;
    const voteCount = new Set(cluster.items.map(item => item.passIndex)).size;
    const requiredConsensusVotes = passCount <= 1 ? 1 : Math.floor(passCount / 2) + 1;
    const passRate = voteCount / Math.max(1, passCount);
    const mergedBox = mergeConsensusBoxes(cluster.items.map(item => item.ref));
    const avgConfidence = medianNumeric(cluster.items.map(item => item.ref.confidence), base?.confidence || 0.7);
    const avgStandardSizeConfidence = medianNumeric(cluster.items.map(item => item.ref.standardSizeConfidence), base?.standardSizeConfidence ?? null);
    const useForScaleVotes = new Set(cluster.items.filter(item => item.ref.useForScale === true).map(item => item.passIndex)).size;
    const consensusStable = voteCount >= requiredConsensusVotes;
    return {
      ...base,
      boundingBox: mergedBox || base.boundingBox,
      confidence: clamp01(
        consensusStable
          ? Math.max(Number(base?.confidence || 0.7), avgConfidence + (voteCount > 1 ? 0.06 : 0))
          : Math.min(Number(base?.confidence || 0.7), avgConfidence),
        base?.confidence || 0.7
      ),
      standardSizeConfidence: avgStandardSizeConfidence == null
        ? base?.standardSizeConfidence
        : clamp01(
            consensusStable
              ? Math.max(Number(base?.standardSizeConfidence || 0.52), avgStandardSizeConfidence + (voteCount > 1 ? 0.04 : 0))
              : Math.min(Number(base?.standardSizeConfidence || 0.52), avgStandardSizeConfidence),
            base?.standardSizeConfidence || 0.52
          ),
      useForScale: useForScaleVotes >= requiredConsensusVotes,
      consensusVotes: voteCount,
      consensusPassCount: passCount,
      consensusPassRate: Math.round(passRate * 100) / 100,
      consensusStable,
      source: passCount > 1 && !String(base?.source || '').includes('consensus') ? `${base?.source || 'vision'}_consensus` : base?.source,
    };
  }));
}

function mergeMeasurementTargetsFromPasses(targetPasses = [], passCount = 1) {
  const clusters = [];

  targetPasses.forEach((targets, passIndex) => {
    const dedupedPass = dedupeMeasurementTargets(targets || []);
    for (const target of dedupedPass) {
      if (!target?.targetType || !SUPPORTED_MEASUREMENT_TARGET_TYPES.has(target.targetType) || !isValidNormalizedBox(target.boundingBox)) continue;
      const cluster = clusters.find(existing => existing.items.some(item => areDuplicateMeasurementTargets(item.target, target)));
      if (cluster) {
        cluster.items.push({ target, passIndex });
      } else {
        clusters.push({ items: [{ target, passIndex }] });
      }
    }
  });

  return dedupeMeasurementTargets(clusters.map(cluster => {
    const base = [...cluster.items]
      .sort((first, second) => targetPriority(second.target) - targetPriority(first.target))[0]?.target;
    const voteCount = new Set(cluster.items.map(item => item.passIndex)).size;
    const passRate = voteCount / Math.max(1, passCount);
    const consensusBox = mergeMeasurementTargetConsensusBox(cluster.items);
    const avgConfidence = medianNumeric(cluster.items.map(item => item.target.confidence), base?.confidence || 0.7);
    const targetFamily = base?.targetType === 'bathroom_mirror'
      ? chooseMajorityValue(cluster.items.map(item => getBathroomMirrorFamilyKey(item.target)), getBathroomMirrorFamilyKey(base))
      : null;
    const description = base?.targetType === 'bathroom_mirror'
      ? chooseMajorityValue(cluster.items.map(item => String(item.target?.description || '').trim()).filter(Boolean), base?.description || null)
      : base?.description;
    return {
      ...base,
      description,
      targetFamily: targetFamily || base?.targetFamily || null,
      boundingBox: consensusBox.boundingBox || base.boundingBox,
      confidence: clamp01(Math.max(Number(base?.confidence || 0.7), avgConfidence + (voteCount > 1 ? 0.05 : 0)), base?.confidence || 0.7),
      consensusVotes: voteCount,
      consensusPassCount: passCount,
      consensusPassRate: Math.round(passRate * 100) / 100,
      consensusStable: voteCount >= Math.max(1, Math.ceil(passCount / 2)),
      consensusBoxStrategy: consensusBox.strategy,
      consensusBoxSupportCount: consensusBox.supportCount,
      consensusMergedBox: consensusBox.mergedBox || null,
    };
  }));
}

function buildUnionConsensusBox(boxes = []) {
  const validBoxes = boxes.filter(box => isValidNormalizedBox(box));
  if (!validBoxes.length) return null;

  const bounds = validBoxes.reduce((acc, box) => {
    const current = clampNormalizedBox(box);
    return {
      minX: Math.min(acc.minX, current.x),
      minY: Math.min(acc.minY, current.y),
      maxX: Math.max(acc.maxX, current.x + current.width),
      maxY: Math.max(acc.maxY, current.y + current.height),
    };
  }, { minX: 1, minY: 1, maxX: 0, maxY: 0 });

  return clampNormalizedBox({
    x: bounds.minX,
    y: bounds.minY,
    width: Math.max(0.001, bounds.maxX - bounds.minX),
    height: Math.max(0.001, bounds.maxY - bounds.minY),
  });
}

function isExactKnownSceneAnchorRef(ref) {
  return Boolean(ref?.knownSceneAnchorId) || ref?.source === 'known_scene_anchor';
}

function isFixedVanityReferenceProfile(profileType) {
  return /^bathroom_vanity_\d+$/i.test(profileType || '') && profileType !== 'bathroom_vanity_auto';
}

function filterVanityReferenceCandidates(candidates = [], target = null) {
  if (!Array.isArray(candidates) || !candidates.length) return [];

  const targetBox = isValidNormalizedBox(target?.boundingBox)
    ? target.boundingBox
    : (isValidNormalizedBox(target) ? target : null);

  const autoCandidates = candidates.filter(ref => {
    const profileType = getReferenceProfileType(ref);
    if (profileType !== 'bathroom_vanity_auto' || !isValidNormalizedBox(ref?.boundingBox)) return false;
    if (!targetBox) return true;
    return bboxIntersectionOverUnion(targetBox, ref.boundingBox) >= 0.08
      || bboxCenterDistance(targetBox, ref.boundingBox) <= 0.10;
  });

  return candidates.filter(ref => {
    const profileType = getReferenceProfileType(ref);
    if (profileType === 'bathroom_vanity_auto') {
      if (!autoCandidates.length) return true;
      if (!targetBox || !isValidNormalizedBox(ref?.boundingBox)) return true;
      return bboxIntersectionOverUnion(targetBox, ref.boundingBox) >= 0.08
        || bboxCenterDistance(targetBox, ref.boundingBox) <= 0.10;
    }
    if (isExactKnownSceneAnchorRef(ref)) return true;
    return !isFixedVanityReferenceProfile(profileType);
  });
}

function getTargetRepairReferenceCandidates(targetType, referenceObjects = [], target = null) {
  if (!Array.isArray(referenceObjects) || !referenceObjects.length) return [];

  const candidates = referenceObjects.filter(ref => {
    if (!isValidNormalizedBox(ref?.boundingBox)) return false;
    const profileType = getReferenceProfileType(ref);
    if (targetType === 'existing_vanity') {
      return profileType === 'bathroom_vanity_auto' || /^bathroom_vanity_/i.test(profileType || '') || ref?.sourceTargetType === 'existing_vanity';
    }
    if (targetType === 'bathroom_mirror') {
      return MIRROR_REFERENCE_PROFILE_TYPES.has(profileType) || ref?.sourceTargetType === 'bathroom_mirror';
    }
    if (targetType === 'existing_bathtub') {
      return profileType === 'standard_bathtub' || profileType === 'bathtub';
    }
    return false;
  });

  if (targetType === 'existing_vanity') {
    return filterVanityReferenceCandidates(candidates, target);
  }

  return candidates;
}

function scoreTargetRepairReference(target, ref) {
  return referencePriority(ref)
    + bboxIntersectionOverUnion(target?.boundingBox, ref?.boundingBox) * 1.35
    - bboxCenterDistance(target?.boundingBox, ref?.boundingBox) * 1.4;
}

function shouldRepairTargetWithReference(target, ref) {
  if (!target?.targetType || !isValidNormalizedBox(target?.boundingBox) || !isValidNormalizedBox(ref?.boundingBox)) return false;
  const targetBox = clampNormalizedBox(target.boundingBox);
  const refBox = clampNormalizedBox(ref.boundingBox);
  if (target.targetType === 'bathroom_mirror') {
    const targetFamily = getBathroomMirrorFamilyKey(target);
    const referenceFamily = getBathroomMirrorFamilyKey(ref);
    if (targetFamily && referenceFamily && targetFamily !== referenceFamily) return false;
  }
  const overlap = bboxIntersectionOverUnion(targetBox, refBox);
  const distance = bboxCenterDistance(targetBox, refBox);
  if (overlap < 0.05 && distance > 0.12) return false;

  const widthRatio = targetBox.width / Math.max(0.001, refBox.width);
  const heightRatio = targetBox.height / Math.max(0.001, refBox.height);
  const areaRatio = (targetBox.width * targetBox.height) / Math.max(0.001, refBox.width * refBox.height);

  if (target.targetType === 'existing_vanity') {
    return widthRatio < 0.84 || areaRatio < 0.74 || (!target.edgeRefined && widthRatio < 1.04);
  }
  if (target.targetType === 'bathroom_mirror') {
    return widthRatio < 0.84 || heightRatio < 0.84 || areaRatio < 0.78 || (!target.edgeRefined && areaRatio < 1.10);
  }

  return false;
}

function buildMeasurementTargetFromReference(ref, targetType) {
  const bbox = clampNormalizedBox(ref.boundingBox);
  const mirrorFamily = targetType === 'bathroom_mirror' ? getBathroomMirrorFamilyKey(ref) : null;
  return {
    targetType,
    boundingBox: bbox,
    roughBoundingBox: ref.roughBoundingBox || null,
    description: targetType === 'existing_vanity'
      ? 'Reference-backed bathroom vanity'
      : targetType === 'bathroom_mirror'
        ? (mirrorFamily === 'medicine_cabinet' ? 'Reference-backed mirrored medicine cabinet' : 'Reference-backed bathroom mirror')
        : 'Reference-backed target',
    targetFamily: mirrorFamily,
    confidence: Math.max(clamp01(ref.confidence, 0.78), clamp01(ref.standardSizeConfidence, 0.72)),
    edgeRefined: Boolean(ref.cropRefined || ref.geometryRefined || ref.deterministicRefined),
    cropRefined: Boolean(ref.cropRefined),
    deterministicRefined: Boolean(ref.deterministicRefined),
    edgeRefinementReason: ref.cropRefinementReason || 'reference_anchor_backfill',
    edgeRefinementDiagnostics: ref.deterministicDiagnostics || null,
    visibility: ref.visibility || 'mostly_visible',
    perspective: ref.perspective || 'front_facing',
    sourceReferenceType: getReferenceProfileType(ref),
    referenceKnownDimensions: getReferenceKnownDimensions(ref),
    referenceKnownSceneAnchorId: ref?.knownSceneAnchorId || null,
    referenceStandardSizeConfidence: clamp01(ref?.standardSizeConfidence, 0.72),
    referenceAnchorQuality: ref?.anchorQuality || 'unknown',
    referenceAligned: true,
    referenceBackfilled: true,
  };
}

function isStrongReferenceAlignedTarget(target) {
  if (!target?.referenceAligned) return false;
  if (!['existing_vanity', 'bathroom_mirror'].includes(target?.targetType)) return false;
  const quality = String(target?.referenceAnchorQuality || '').toLowerCase();
  const confidence = clamp01(target?.referenceStandardSizeConfidence, 0);
  return confidence >= 0.68 || quality === 'high' || quality === 'medium';
}

function repairMeasurementTargetsWithReferences(detections) {
  if (!Array.isArray(detections?.photos)) {
    return { detections, repairedCount: 0, backfilledCount: 0, droppedCount: 0 };
  }

  let repairedCount = 0;
  let backfilledCount = 0;
  let droppedCount = 0;

  for (const photo of detections.photos) {
    if (!Array.isArray(photo.measurementTargets)) photo.measurementTargets = [];
    if (!Array.isArray(photo.referenceObjects)) photo.referenceObjects = [];

    const showerTargets = photo.measurementTargets.filter(target => target?.targetType === 'shower_door_opening' && isValidNormalizedBox(target?.boundingBox));
    photo.measurementTargets = photo.measurementTargets.filter(target => {
      if (target?.targetType !== 'existing_bathtub' || !isValidNormalizedBox(target?.boundingBox)) return true;
      const hasBathtubReference = getTargetRepairReferenceCandidates('existing_bathtub', photo.referenceObjects).length > 0;
      const overlapsShower = showerTargets.some(shower => (
        bboxIntersectionOverUnion(target.boundingBox, shower.boundingBox) >= 0.16
        || bboxCenterDistance(target.boundingBox, shower.boundingBox) <= 0.11
      ));
      const weakConsensus = (target.consensusVotes || 1) < 2;
      const weakBathtub = overlapsShower && !hasBathtubReference && (!target.edgeRefined || weakConsensus);
      if (weakBathtub) droppedCount++;
      return !weakBathtub;
    });

    for (const target of photo.measurementTargets) {
      if (!['existing_vanity', 'bathroom_mirror'].includes(target?.targetType) || !isValidNormalizedBox(target?.boundingBox)) continue;
      const repairReferences = getTargetRepairReferenceCandidates(target.targetType, photo.referenceObjects, target)
        .sort((first, second) => scoreTargetRepairReference(target, second) - scoreTargetRepairReference(target, first));
      const bestReference = repairReferences[0] || null;
      if (!bestReference || !shouldRepairTargetWithReference(target, bestReference)) continue;

      const repairedBox = buildUnionConsensusBox([target.boundingBox, bestReference.boundingBox]);
      if (!repairedBox) continue;

      target.roughBoundingBox = target.roughBoundingBox || target.boundingBox;
      target.boundingBox = repairedBox;
      target.edgeRefined = Boolean(target.edgeRefined || bestReference.cropRefined || bestReference.geometryRefined || bestReference.deterministicRefined);
      target.cropRefined = Boolean(target.cropRefined || bestReference.cropRefined);
      target.deterministicRefined = Boolean(target.deterministicRefined || bestReference.deterministicRefined);
      target.edgeRefinementReason = target.edgeRefinementReason || 'reference_anchor_repair';
      target.referenceAligned = true;
      target.targetFamily = target.targetFamily || getBathroomMirrorFamilyKey(bestReference) || getBathroomMirrorFamilyKey(target);
      target.sourceReferenceType = getReferenceProfileType(bestReference);
      target.referenceKnownDimensions = getReferenceKnownDimensions(bestReference);
      target.referenceKnownSceneAnchorId = bestReference?.knownSceneAnchorId || null;
      target.referenceStandardSizeConfidence = clamp01(bestReference?.standardSizeConfidence, 0.72);
      target.referenceAnchorQuality = bestReference?.anchorQuality || 'unknown';
      target.edgeRefinementDiagnostics = {
        ...(target.edgeRefinementDiagnostics || {}),
        repairedFromReferenceType: getReferenceProfileType(bestReference),
        repairSource: 'reference_anchor_union',
      };
      repairedCount++;
    }

    for (const targetType of ['existing_vanity', 'bathroom_mirror']) {
      const alreadyPresent = photo.measurementTargets.some(target => target?.targetType === targetType && isValidNormalizedBox(target?.boundingBox));
      if (alreadyPresent) continue;

      const bestReference = getTargetRepairReferenceCandidates(targetType, photo.referenceObjects)
        .sort((first, second) => referencePriority(second) - referencePriority(first))[0] || null;
      if (!bestReference || referencePriority(bestReference) < 1.7) continue;

      photo.measurementTargets.push(buildMeasurementTargetFromReference(bestReference, targetType));
      backfilledCount++;
    }

    photo.measurementTargets = dedupeMeasurementTargets(photo.measurementTargets);
  }

  return { detections, repairedCount, backfilledCount, droppedCount };
}

function mergeObjectDetectionPasses(detectionPasses = []) {
  const okPasses = detectionPasses.filter(pass => pass?.ok && Array.isArray(pass.photos));
  if (!okPasses.length) {
    return { ok: false, error: detectionPasses.find(pass => pass?.error)?.error || 'No successful detection passes' };
  }

  const photoIndexes = new Set();
  okPasses.forEach(pass => {
    for (const photo of (pass.photos || [])) {
      if (Number.isInteger(Number(photo?.photoIndex))) photoIndexes.add(Number(photo.photoIndex));
    }
  });

  const passCount = okPasses.length;
  const photos = [...photoIndexes].sort((first, second) => first - second).map(photoIndex => {
    const variants = okPasses
      .map(pass => (pass.photos || []).find(photo => Number(photo?.photoIndex) === photoIndex))
      .filter(Boolean);

    const widthFt = medianNumeric(variants.map(photo => photo?.roomGeometry?.estimatedWidthFt), null);
    const lengthFt = medianNumeric(variants.map(photo => photo?.roomGeometry?.estimatedLengthFt), null);

    return {
      photoIndex,
      roomType: chooseMajorityValue(variants.map(photo => photo?.roomType), 'unknown') || 'unknown',
      wallsVisible: Math.round(medianNumeric(variants.map(photo => photo?.wallsVisible), 0) || 0),
      cornerVisible: Boolean(chooseMajorityValue(variants.map(photo => Boolean(photo?.cornerVisible)), false)),
      estimatedCeilingHeightFt: medianNumeric(variants.map(photo => photo?.estimatedCeilingHeightFt), 8) || 8,
      roomGeometry: widthFt || lengthFt
        ? {
            estimatedWidthFt: widthFt || null,
            estimatedLengthFt: lengthFt || null,
          }
        : null,
      referenceObjects: mergeReferenceObjectsFromPasses(variants.map(photo => photo?.referenceObjects || []), passCount),
      measurementTargets: mergeMeasurementTargetsFromPasses(variants.map(photo => photo?.measurementTargets || []), passCount),
    };
  });

  return {
    ok: true,
    photos,
    passCount,
    okPassCount: okPasses.length,
    stabilized: okPasses.length > 1,
  };
}

function mergeScaleAnchorPasses(scaleAnchorPasses = []) {
  const okPasses = scaleAnchorPasses.filter(pass => pass?.ok && Array.isArray(pass.photos));
  if (!okPasses.length) {
    return { ok: false, error: scaleAnchorPasses.find(pass => pass?.error)?.error || 'No successful scale-anchor passes' };
  }

  const photoIndexes = new Set();
  okPasses.forEach(pass => {
    for (const photo of (pass.photos || [])) {
      if (Number.isInteger(Number(photo?.photoIndex))) photoIndexes.add(Number(photo.photoIndex));
    }
  });

  const passCount = okPasses.length;
  const photos = [...photoIndexes].sort((first, second) => first - second).map(photoIndex => {
    const variants = okPasses
      .map(pass => (pass.photos || []).find(photo => Number(photo?.photoIndex) === photoIndex))
      .filter(Boolean);

    return {
      photoIndex,
      referenceObjects: mergeReferenceObjectsFromPasses(variants.map(photo => photo?.referenceObjects || []), passCount),
    };
  });

  return {
    ok: true,
    photos,
    passCount,
    okPassCount: okPasses.length,
    stabilized: okPasses.length > 1,
  };
}

function mergeScaleAnchorDetections(detections, scaleAnchors) {
  if (!scaleAnchors?.ok || !Array.isArray(scaleAnchors.photos)) {
    return { detections, added: 0, error: scaleAnchors?.error || null };
  }

  const photos = Array.isArray(detections.photos) ? detections.photos : [];
  let added = 0;

  for (const anchorPhoto of scaleAnchors.photos) {
    const photoIndex = Number(anchorPhoto.photoIndex);
    if (!Number.isInteger(photoIndex)) continue;

    let targetPhoto = photos.find(photo => Number(photo.photoIndex) === photoIndex);
    if (!targetPhoto) {
      targetPhoto = { photoIndex, referenceObjects: [], measurementTargets: [] };
      photos.push(targetPhoto);
    }
    if (!Array.isArray(targetPhoto.referenceObjects)) targetPhoto.referenceObjects = [];

    for (const anchor of (anchorPhoto.referenceObjects || [])) {
      if (!anchor?.type || !anchor?.boundingBox) continue;
      const duplicate = targetPhoto.referenceObjects.some(existing => (
        existing.type === anchor.type && bboxCenterDistance(existing.boundingBox, anchor.boundingBox) < 0.045
      ));
      if (duplicate) continue;

      targetPhoto.referenceObjects.push({
        ...anchor,
        source: 'scale_anchor_pass',
      });
      added++;
    }
  }

  detections.photos = photos.sort((firstPhoto, secondPhoto) => Number(firstPhoto.photoIndex) - Number(secondPhoto.photoIndex));
  for (const photo of detections.photos) {
    photo.referenceObjects = dedupeReferenceObjects(photo.referenceObjects || []);
  }
  return { detections, added, error: null };
}

function promoteMeasurementTargetsToReferenceAnchors(detections) {
  if (!Array.isArray(detections?.photos)) {
    return { detections, added: 0, candidates: 0 };
  }

  let added = 0;
  let candidates = 0;

  for (const photo of detections.photos) {
    if (!Array.isArray(photo.measurementTargets) || !photo.measurementTargets.length) continue;
    if (!Array.isArray(photo.referenceObjects)) photo.referenceObjects = [];

    for (const target of photo.measurementTargets) {
      const mapping = MEASUREMENT_TARGET_REFERENCE_ANCHORS[target?.targetType];
      if (!mapping || !isValidNormalizedBox(target.boundingBox)) continue;
      candidates++;

      const confidence = clamp01(target.confidence, 0.72);
      const bbox = clampNormalizedBox(target.boundingBox);
      const promoted = {
        type: mapping.type,
        boundingBox: bbox,
        roughBoundingBox: target.roughBoundingBox || null,
        confidence,
        useForScale: Boolean(mapping.useForScale && confidence >= 0.72),
        visibility: target.visibility || 'mostly_visible',
        perspective: target.perspective || 'mild_angle',
        standardSizeConfidence: mapping.standardSizeConfidence,
        anchorQuality: mapping.anchorQuality,
        scaleDimensions: Array.isArray(mapping.scaleDimensions) ? mapping.scaleDimensions : null,
        scaleRationale: mapping.rationale,
        source: 'measurement_target_promoted_anchor',
        sourceTargetType: target.targetType,
        cropRefined: Boolean(target.edgeRefined),
        deterministicRefined: Boolean(target.edgeRefined),
        geometryRefined: Boolean(target.edgeRefined),
        cropRefinementReason: target.edgeRefinementReason || null,
        deterministicDiagnostics: target.edgeRefinementDiagnostics || null,
      };

      const duplicate = photo.referenceObjects.some(existing => (
        existing.type === promoted.type && bboxCenterDistance(existing.boundingBox, promoted.boundingBox) < 0.065
      ));
      if (duplicate) continue;

      photo.referenceObjects.push(promoted);
      added++;
    }

    photo.referenceObjects = dedupeReferenceObjects(photo.referenceObjects);
  }

  return { detections, added, candidates };
}

function closestStandardDimension(measuredValue, candidates = []) {
  const value = Number(measuredValue);
  if (!Number.isFinite(value) || value <= 0 || !Array.isArray(candidates) || candidates.length === 0) return null;

  return candidates.reduce((best, candidate) => {
    const absError = Math.abs(candidate - value);
    const relError = absError / Math.max(1, candidate);
    if (!best) return { value: candidate, absError, relError };
    if (relError < best.relError) return { value: candidate, absError, relError };
    if (relError === best.relError && absError < best.absError) return { value: candidate, absError, relError };
    return best;
  }, null);
}

function autoAnchorQualityLabel(weight, widthRelError, edgeRefined) {
  if (weight >= 0.82 && widthRelError <= 0.08 && edgeRefined) return 'high';
  if (weight >= 0.62 && widthRelError <= 0.14) return 'medium';
  return 'low';
}

function inferAutomaticFixtureReferenceAnchors(detections, depthResults, intrinsicsResults) {
  if (!Array.isArray(detections?.photos)) {
    return { detections, proposals: 0, groups: 0, added: 0 };
  }

  const proposals = [];

  const maybeAddProposal = ({ photoIndex, roomType, target, config, candidateSource = 'measurement_target', sourceReferenceType = null }) => {
    if (!config) return;
    if (config.roomTypes?.size && !config.roomTypes.has(roomType)) return;
    if (!isValidNormalizedBox(target?.boundingBox)) return;

    const depthInfo = depthResults[photoIndex] || { ok: false };
    const intrinsics = intrinsicsResults[photoIndex];
    const imgW = depthInfo?.ok ? depthInfo.width : 1920;
    const imgH = depthInfo?.ok ? depthInfo.height : 1080;
    if (!depthInfo?.ok || !intrinsics) return;

    const targetMeasurement = measureTargetObject(target, depthInfo, imgW, imgH, intrinsics, 1);
    if (!targetMeasurement?.dimensions) return;

    const autoConfig = getAutoFixtureReferenceConfigForTarget(target, config, targetMeasurement.dimensions);
    const effectiveConfig = autoConfig?.config || config;
    const widthMatch = autoConfig?.widthMatch || closestStandardDimension(targetMeasurement.dimensions.widthInches, effectiveConfig.widths);
    if (!widthMatch || widthMatch.relError > effectiveConfig.maxRelativeError) return;

    const heightMatch = autoConfig?.heightMatch || closestStandardDimension(targetMeasurement.dimensions.heightInches, effectiveConfig.heights);
    const method = String(targetMeasurement.dimensions.measurementMethod || targetMeasurement.method || 'bbox_center_depth_pinhole');
    const methodWeight = method === 'front_face_depth_pinhole'
      ? 1
      : method === 'local_wall_plane_rectified'
        ? 0.86
        : 0.72;
    const edgeWeight = target.edgeRefined ? 1.08 : 0.92;
    const bboxArea = Number(target.boundingBox?.width || 0) * Number(target.boundingBox?.height || 0);
    const areaWeight = bboxArea >= 0.04 ? 1 : bboxArea >= 0.02 ? 0.92 : 0.80;
    const baseConfidence = clamp01(target.confidence, 0.72);
    const widthWeight = Math.max(0.32, 1 - widthMatch.relError * 2.3);
    const heightWeight = heightMatch ? Math.max(0.64, 1 - heightMatch.relError * 1.4) : 0.72;
    const weight = baseConfidence * methodWeight * edgeWeight * areaWeight * widthWeight * heightWeight;
    const standardSizeConfidence = clamp01(0.98 - widthMatch.relError * 1.8 - (target.edgeRefined ? 0 : 0.08), 0.52);

    proposals.push({
      photoIndex,
      roomType,
      targetType: target.targetType,
      targetFamily: target.targetType === 'bathroom_mirror' ? (autoConfig?.targetFamily || getBathroomMirrorFamilyKey(target)) : null,
      target,
      config: effectiveConfig,
      measurement: targetMeasurement,
      bbox: clampNormalizedBox(target.boundingBox),
      widthMatch,
      heightMatch,
      weight,
      standardSizeConfidence,
      candidateSource,
      sourceReferenceType,
      knownDimensions: {
        width: widthMatch.value,
        height: heightMatch && heightMatch.relError <= 0.18 ? heightMatch.value : null,
        unit: 'in',
      },
    });
  };

  for (let photoIndex = 0; photoIndex < detections.photos.length; photoIndex++) {
    const photo = detections.photos[photoIndex];
    const roomType = String(photo?.roomType || '').toLowerCase();
    const measurementTargets = Array.isArray(photo?.measurementTargets) ? photo.measurementTargets : [];
    const eligibleTargets = measurementTargets.filter(target => {
      const config = AUTO_FIXTURE_REFERENCE_TARGETS[target?.targetType];
      return Boolean(config && isValidNormalizedBox(target?.boundingBox) && (!config.roomTypes?.size || config.roomTypes.has(roomType)));
    });

    for (const target of eligibleTargets) {
      maybeAddProposal({
        photoIndex,
        roomType,
        target,
        config: AUTO_FIXTURE_REFERENCE_TARGETS[target.targetType],
      });
    }

    const fallbackVanityRefs = Array.isArray(photo?.referenceObjects)
      ? photo.referenceObjects.filter(ref => {
        const profileType = getReferenceProfileType(ref);
        if (!/^bathroom_vanity_/i.test(profileType || '')) return false;
        if (!isValidNormalizedBox(ref?.boundingBox)) return false;
        const overlapsEligibleTarget = eligibleTargets.some(target => (
          bboxIntersectionOverUnion(target.boundingBox, ref.boundingBox) >= 0.12
          || bboxCenterDistance(target.boundingBox, ref.boundingBox) <= 0.08
        ));
        return !overlapsEligibleTarget;
      })
      : [];

    for (const ref of fallbackVanityRefs) {
      maybeAddProposal({
        photoIndex,
        roomType,
        target: {
          targetType: 'existing_vanity',
          boundingBox: clampNormalizedBox(ref.boundingBox),
          roughBoundingBox: ref.roughBoundingBox || null,
          confidence: Math.max(clamp01(ref.confidence, 0.74), clamp01(ref.standardSizeConfidence, 0.72)),
          edgeRefined: Boolean(ref.cropRefined || ref.deterministicRefined || ref.geometryRefined),
          edgeRefinementReason: ref.cropRefinementReason || null,
          edgeRefinementDiagnostics: ref.deterministicDiagnostics || null,
          visibility: ref.visibility || 'mostly_visible',
          perspective: ref.perspective || 'front_facing',
        },
        config: AUTO_FIXTURE_REFERENCE_TARGETS.existing_vanity,
        candidateSource: 'reference_anchor_backfill',
        sourceReferenceType: getReferenceProfileType(ref),
      });
    }
  }

  const selectedFamilies = new Map();
  const proposalGroups = new Map();
  for (const proposal of proposals) {
    const groupKey = `${proposal.roomType}:${proposal.targetType}:${proposal.targetFamily || 'default'}`;
    const sizeKey = String(proposal.knownDimensions.width);
    let sizeMap = proposalGroups.get(groupKey);
    if (!sizeMap) {
      sizeMap = new Map();
      proposalGroups.set(groupKey, sizeMap);
    }
    const existing = sizeMap.get(sizeKey) || { totalWeight: 0, photoIndexes: new Set(), proposals: [] };
    existing.totalWeight += proposal.weight;
    existing.photoIndexes.add(proposal.photoIndex);
    existing.proposals.push(proposal);
    sizeMap.set(sizeKey, existing);
  }

  for (const [groupKey, sizeMap] of proposalGroups.entries()) {
    const ranked = [...sizeMap.entries()]
      .map(([sizeKey, aggregate]) => ({
        sizeKey,
        width: Number(sizeKey),
        totalWeight: aggregate.totalWeight,
        photoCount: aggregate.photoIndexes.size,
        proposals: aggregate.proposals,
      }))
      .sort((first, second) => second.totalWeight - first.totalWeight || second.photoCount - first.photoCount);

    const best = ranked[0];
    const runnerUp = ranked[1] || null;
    const ambiguousVanityFamily = groupKey.includes(':existing_vanity:')
      && best
      && runnerUp
      && runnerUp.width > best.width
      && (runnerUp.width - best.width) >= 12
      && runnerUp.photoCount >= 2
      && runnerUp.totalWeight >= best.totalWeight * 0.78
      && best.proposals.some(proposal => (proposal.widthMatch?.relError ?? 1) >= 0.06)
      && runnerUp.proposals.some(proposal => (proposal.widthMatch?.relError ?? 1) <= 0.18);
    const bestHasStrongSnap = Boolean(best?.proposals?.some(proposal => (
      proposal.widthMatch?.relError <= 0.10
      && (
        (proposal.measurement?.dimensions?.measurementMethod || '') === 'front_face_depth_pinhole'
        || proposal.target?.edgeRefined
        || (
          proposal.targetType === 'bathroom_mirror'
          && (proposal.measurement?.dimensions?.measurementMethod || '') === 'local_wall_plane_rectified'
          && (proposal.heightMatch?.relError ?? 0.22) <= 0.18
          && proposal.standardSizeConfidence >= 0.74
        )
      )
    )));
    if (!best || best.totalWeight < 0.48) continue;
    if (ambiguousVanityFamily) continue;
    if (!bestHasStrongSnap && runnerUp && best.totalWeight < runnerUp.totalWeight * 1.10 && best.photoCount <= runnerUp.photoCount) continue;
    selectedFamilies.set(groupKey, best);
  }

  let added = 0;
  for (const proposal of proposals) {
    const selected = selectedFamilies.get(`${proposal.roomType}:${proposal.targetType}:${proposal.targetFamily || 'default'}`);
    if (!selected || selected.width !== proposal.knownDimensions.width) continue;

    const photo = detections.photos[proposal.photoIndex];
    if (!Array.isArray(photo.referenceObjects)) photo.referenceObjects = [];

    photo.referenceObjects = photo.referenceObjects.filter(existing => {
      if (!isValidNormalizedBox(existing?.boundingBox)) return true;
      const overlapping = bboxIntersectionOverUnion(existing.boundingBox, proposal.bbox) >= 0.12 ||
        bboxCenterDistance(existing.boundingBox, proposal.bbox) <= 0.08;
      if (!overlapping) return true;
      const existingProfileType = getReferenceProfileType(existing);
      const sameVanityFamily = /^bathroom_vanity_/i.test(existingProfileType || '') || existingProfileType === 'bathroom_vanity_auto';
      const sameMirrorFamily = proposal.targetType === 'bathroom_mirror' && getBathroomMirrorFamilyKey(existing) === proposal.targetFamily;
      return !(sameVanityFamily || sameMirrorFamily || existing?.sourceTargetType === proposal.targetType);
    });

    const qualityLabel = autoAnchorQualityLabel(proposal.weight, proposal.widthMatch.relError, Boolean(proposal.target.edgeRefined));
    const measurementMethod = String(proposal.measurement?.dimensions?.measurementMethod || proposal.measurement?.method || '');
    const allowModerateAutoScale = proposal.standardSizeConfidence >= 0.74 &&
      proposal.widthMatch.relError <= 0.16 &&
      ['front_face_depth_pinhole', 'local_wall_plane_rectified'].includes(measurementMethod) &&
      (proposal.target.edgeRefined || proposal.candidateSource === 'reference_anchor_backfill');
    const config = proposal.config || AUTO_FIXTURE_REFERENCE_TARGETS[proposal.targetType];
    const referenceType = config?.referenceType || proposal.targetType;
    const useForScale = proposal.targetType === 'bathroom_mirror'
      ? false
      : proposal.standardSizeConfidence >= 0.70 && (qualityLabel !== 'low' || allowModerateAutoScale);
    photo.referenceObjects.push({
      type: referenceType,
      referenceProfileType: referenceType,
      knownDimensions: proposal.knownDimensions,
      boundingBox: proposal.bbox,
      roughBoundingBox: proposal.target.roughBoundingBox || null,
      confidence: Math.max(clamp01(proposal.target.confidence, 0.78), clamp01(proposal.standardSizeConfidence, 0.74)),
      useForScale,
      visibility: proposal.target.visibility || 'mostly_visible',
      perspective: proposal.target.perspective || 'front_facing',
      standardSizeConfidence: proposal.standardSizeConfidence,
      anchorQuality: qualityLabel,
      scaleDimensions: config?.scaleDimensions || [],
      scaleRationale: `auto-inferred ${proposal.targetType} width family (${proposal.knownDimensions.width}\") from raw metric depth`,
      source: 'auto_inferred_reference_anchor',
      sourceTargetType: proposal.targetType,
      mirrorFamily: proposal.targetFamily || null,
      cropRefined: Boolean(proposal.target.edgeRefined),
      deterministicRefined: Boolean(proposal.target.edgeRefined),
      geometryRefined: Boolean(proposal.target.edgeRefined),
      cropRefinementReason: proposal.target.edgeRefinementReason || null,
      deterministicDiagnostics: {
        inferredWidthInches: roundTenth(proposal.measurement.dimensions.widthInches),
        snappedWidthInches: proposal.knownDimensions.width,
        widthRelativeError: Math.round(proposal.widthMatch.relError * 1000) / 1000,
        method: proposal.measurement.dimensions.measurementMethod || null,
        candidateSource: proposal.candidateSource,
        allowModerateAutoScale,
        sourceReferenceType: proposal.sourceReferenceType,
      },
    });
    added++;
    photo.referenceObjects = dedupeReferenceObjects(photo.referenceObjects);
  }

  return {
    detections,
    proposals: proposals.length,
    groups: selectedFamilies.size,
    added,
  };
}

function promoteKnownSceneAnchors(detections, sceneAnchors = []) {
  if (!Array.isArray(detections?.photos)) {
    return { detections, added: 0, candidates: 0, specs: 0 };
  }

  const normalizedSpecs = normalizeKnownSceneAnchors(sceneAnchors);
  if (!normalizedSpecs.length) {
    return { detections, added: 0, candidates: 0, specs: 0 };
  }

  let added = 0;
  let candidates = 0;

  for (const photo of detections.photos) {
    if (!Array.isArray(photo.referenceObjects)) photo.referenceObjects = [];

    for (const spec of normalizedSpecs) {
      const matchingTargets = Array.isArray(photo.measurementTargets)
        ? photo.measurementTargets.filter(target => spec.targetType && target?.targetType === spec.targetType && isValidNormalizedBox(target.boundingBox))
        : [];
      const matchingRefs = photo.referenceObjects.filter(ref => (
        spec.referenceType && ref?.type === spec.referenceType && isValidNormalizedBox(ref.boundingBox)
      ));
      const matchPool = [
        ...matchingTargets.map(match => ({
          sourceKind: 'measurement_target',
          boundingBox: clampNormalizedBox(match.boundingBox),
          roughBoundingBox: match.roughBoundingBox || null,
          confidence: clamp01(match.confidence, 0.8),
          visibility: match.visibility || 'full',
          perspective: match.perspective || 'front_facing',
          edgeRefined: Boolean(match.edgeRefined),
          edgeRefinementReason: match.edgeRefinementReason || null,
          edgeRefinementDiagnostics: match.edgeRefinementDiagnostics || null,
          sourceTargetType: match.targetType || null,
        })),
        ...matchingRefs.map(match => ({
          sourceKind: 'reference_object',
          boundingBox: clampNormalizedBox(match.boundingBox),
          roughBoundingBox: match.roughBoundingBox || null,
          confidence: clamp01(match.confidence, 0.8),
          visibility: match.visibility || 'full',
          perspective: match.perspective || 'front_facing',
          edgeRefined: Boolean(match.cropRefined || match.deterministicRefined),
          edgeRefinementReason: match.cropRefinementReason || null,
          edgeRefinementDiagnostics: match.deterministicDiagnostics || null,
          sourceTargetType: match.sourceTargetType || null,
        })),
      ];

      if (!matchPool.length) continue;
      candidates += matchPool.length;

      const bestMatch = matchPool.sort((firstMatch, secondMatch) => {
        const firstArea = Number(firstMatch.boundingBox?.width || 0) * Number(firstMatch.boundingBox?.height || 0);
        const secondArea = Number(secondMatch.boundingBox?.width || 0) * Number(secondMatch.boundingBox?.height || 0);
        const firstScore = firstMatch.confidence + firstArea + (firstMatch.edgeRefined ? 0.18 : 0);
        const secondScore = secondMatch.confidence + secondArea + (secondMatch.edgeRefined ? 0.18 : 0);
        return secondScore - firstScore;
      })[0];

      const referenceType = spec.referenceType || spec.referenceProfileType;
      photo.referenceObjects = photo.referenceObjects.filter(existing => {
        if (!isValidNormalizedBox(existing?.boundingBox)) return true;
        const overlapping = bboxIntersectionOverUnion(existing.boundingBox, bestMatch.boundingBox) >= 0.12 ||
          bboxCenterDistance(existing.boundingBox, bestMatch.boundingBox) <= 0.10;
        if (!overlapping) return true;

        const existingProfileType = getReferenceProfileType(existing);
        const sameProfile = existingProfileType === spec.referenceProfileType;
        const sameSourceTarget = spec.targetType && existing?.sourceTargetType === spec.targetType;
        const sameVanityFamily = spec.targetType === 'existing_vanity' && /^bathroom_vanity_/i.test(existingProfileType || '');
        const sameMirrorFamily = spec.targetType === 'bathroom_mirror' && existingProfileType === 'bathroom_mirror';
        return !(sameProfile || sameSourceTarget || sameVanityFamily || sameMirrorFamily);
      });

      photo.referenceObjects.push({
        type: referenceType,
        referenceProfileType: spec.referenceProfileType,
        knownDimensions: spec.knownDimensions,
        boundingBox: bestMatch.boundingBox,
        roughBoundingBox: bestMatch.roughBoundingBox,
        confidence: Math.max(spec.confidence, bestMatch.confidence),
        useForScale: spec.useForScale,
        visibility: spec.visibility || bestMatch.visibility || 'full',
        perspective: spec.perspective || bestMatch.perspective || 'front_facing',
        standardSizeConfidence: spec.standardSizeConfidence,
        anchorQuality: spec.anchorQuality,
        scaleDimensions: spec.scaleDimensions,
        scaleRationale: `exact known scene anchor: ${spec.label}`,
        source: 'known_scene_anchor',
        knownSceneAnchorId: spec.id,
        sourceTargetType: bestMatch.sourceTargetType || spec.targetType || null,
        cropRefined: Boolean(bestMatch.edgeRefined),
        deterministicRefined: Boolean(bestMatch.edgeRefined),
        geometryRefined: Boolean(bestMatch.edgeRefined),
        cropRefinementReason: bestMatch.edgeRefinementReason || null,
        deterministicDiagnostics: bestMatch.edgeRefinementDiagnostics || null,
      });
      added++;
    }

    photo.referenceObjects = dedupeReferenceObjects(photo.referenceObjects);
  }

  return { detections, added, candidates, specs: normalizedSpecs.length };
}

async function fallbackRoomClassification(images) {
  if (!OPENAI_API_KEY) return { ok: false, error: 'OpenAI API key not configured' };

  const imageMessages = images.map(img => ({
    type: 'image_url',
    image_url: { url: img.startsWith('data:') || img.startsWith('http') ? img : `data:image/jpeg;base64,${img}`, detail: 'low' },
  }));

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [
          { type: 'text', text: `For each photo, identify room type and estimate dimensions. Return ONLY JSON:\n{"photos":[{"photoIndex":0,"roomType":"kitchen","wallsVisible":2,"cornerVisible":false,"estimatedCeilingHeightFt":8,"referenceObjects":[],"measurementTargets":[],"roomGeometry":{"estimatedWidthFt":12,"estimatedLengthFt":14}}]}` },
          ...imageMessages,
        ] }],
        max_tokens: 1500, temperature: 0.2,
      }),
    });

    if (!response.ok) return { ok: false, error: `GPT-4o fallback error: ${response.status}` };
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, error: 'Failed to parse fallback response' };
    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`[PhotoMeasurement] Fallback: classified ${parsed.photos?.length || 0} rooms`);
    return { ok: true, ...parsed, fallback: true };
  } catch (error) {
    console.error('[PhotoMeasurement] Fallback classification error:', error.message);
    return { ok: false, error: error.message };
  }
}

async function estimateRoomEnvelopeFromImages(roomType, roomImages, renovationContext = null, knownSceneAnchors = []) {
  if (!OPENAI_API_KEY) return { ok: false, error: 'OpenAI API key not configured' };
  if (!roomImages?.length) return { ok: false, error: 'No room images provided' };

  const roomTypeKey = String(roomType || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const imageMessages = roomImages.map(img => ({
    type: 'image_url',
    image_url: {
      url: img.startsWith('data:') || img.startsWith('http') ? img : `data:image/jpeg;base64,${img}`,
      detail: 'high',
    },
  }));

  const isExterior = /exterior|garage|patio|deck|siding|roof/i.test(roomTypeKey || roomType || '');

  // Build renovation-specific measurement questions so GPT-4o focuses on what matters
  const roomSpecificQuestions = {
    bathroom: `Focus on BATHROOM-SPECIFIC measurements:
- Count the exact number of windows and doors visible. Measure each opening's approximate width and height.
  - Look at the floor tile pattern and visible floor area. Small bathrooms can be about 4×5 ft up to 8×10 ft. Do NOT overestimate.
- Is there a bathtub/shower? Estimate the tub surround wall area (3 walls, typically ~60 sq ft total).
- Identify the vanity width (common sizes: 24", 30", 36", 48", 60").
  - If exact vanity or mirror dimensions are provided, use them as primary scale rulers.
  - Estimate how many floor tiles span wall-to-wall and doorway-to-shower/toilet using those rulers when possible.
  - Note the toilet location relative to the vanity.`,
    kitchen: `Focus on KITCHEN-SPECIFIC measurements:
- Count all windows and doors. Measure each opening.
- Estimate the total linear feet of countertop/cabinet run along the walls.
- Identify all visible appliances (fridge, range/stove, dishwasher, microwave) and their approximate widths.
- Estimate the backsplash area (countertop run × ~18 inches high).
- Kitchens are typically 10×12 to 15×20 ft. Do NOT overestimate.`,
    bedroom: `Focus on BEDROOM measurements:
- Count windows and closet doors. Measure each opening.
- Estimate floor dimensions — bedrooms are typically 10×10 to 14×16 ft.
- Note closet opening width if visible.`,
    living_room: `Focus on LIVING ROOM measurements:
- Count all windows, doors, and any fireplace opening.
- Living rooms are typically 12×14 to 18×22 ft.
- Note any architectural features (built-ins, columns) that affect wall area.`,
    home_gym: `Focus on HOME GYM / FINISHED BASEMENT measurements:
  - Count all windows, doors, closets, and any stair or utility openings.
  - These rooms are often much larger than bedrooms. Finished basements and home gyms are commonly 14×16 to 20×28 ft. Do NOT collapse them to bedroom-sized footprints unless the photos clearly show a much smaller room.
  - Use door widths, wall spacing, and visible floor spans to estimate the open room footprint conservatively but realistically.
  - Note soffits, columns, or partial partitions that reduce usable floor area.`,
    basement: `Focus on FINISHED BASEMENT measurements:
  - Count all windows, doors, closets, and any stair or utility openings.
  - Finished basements are commonly 14×18 to 24×30 ft. Do NOT default to small-bedroom dimensions when the room appears open and wide.
  - Use door widths, wall spacing, and visible floor spans to estimate the main finished-room footprint conservatively but realistically.
  - Note soffits, columns, or partial partitions that reduce usable floor area.`,
    exterior: `Focus on EXTERIOR measurements:
- This is an exterior view. Estimate wall height from ground to eave/roofline.
- Single-story: typically 9-12 ft wall height. Two-story: 18-24 ft.
- Count all visible windows and doors with approximate sizes.
- Include gable area if visible.`,
  };

  const specificQuestions = roomSpecificQuestions[roomTypeKey] || roomSpecificQuestions[isExterior ? 'exterior' : 'bedroom'] || '';
  const normalizedKnownSceneAnchors = normalizeKnownSceneAnchors(knownSceneAnchors);
  const knownAnchorHint = normalizedKnownSceneAnchors.length
    ? `\nKnown exact scene anchors when visible:\n${normalizedKnownSceneAnchors.map(anchor => (
        `- ${anchor.label}: ${anchor.knownDimensions.width ? `${anchor.knownDimensions.width}\" W` : ''}${anchor.knownDimensions.width && anchor.knownDimensions.height ? ' x ' : ''}${anchor.knownDimensions.height ? `${anchor.knownDimensions.height}\" H` : ''}`
      )).join('\n')}\nUse these exact sizes as rulers when estimating room dimensions.`
    : '';

  // If we have renovation context, add it
  const renovationHint = renovationContext
    ? `\nRenovation being planned: ${renovationContext}. Focus your measurements on what matters for this renovation.`
    : '';

  const prompt = `You are an expert contractor estimating a ${roomType || 'room'} from photos for a renovation project.${renovationHint}${knownAnchorHint}

IMPORTANT: Your PRIMARY job is to count and measure OPENINGS (windows, doors) accurately.
We already have room dimensions from depth sensors — we need YOU for:
1. Exact count + approximate size of each window and door
2. Total wall opening area (all windows + doors combined)
3. Room-type-specific observations

${specificQuestions}

Analyze ALL provided photos together.

Return ONLY valid JSON:
{
  "room": {
    "widthFt": 12.0,
    "lengthFt": 14.0,
    "heightFt": ${isExterior ? '10.0' : '8.0'},
    "floorAreaSqFt": 168,
    "ceilingAreaSqFt": 168,
    "wallAreaGrossSqFt": 416,
    "wallOpeningAreaSqFt": 48,
    "wallAreaNetSqFt": 368,
    "confidence": "low",
    "windowCount": 2,
    "doorCount": 1,
    "openings": [
      { "type": "window", "widthFt": 3.0, "heightFt": 4.0, "areaSqFt": 12.0 },
      { "type": "door", "widthFt": 3.0, "heightFt": 6.67, "areaSqFt": 20.0 }
    ]
  }
}

Rules:
- Be CONSERVATIVE — choose smaller dimensions when uncertain.
- wallOpeningAreaSqFt = sum of all opening areas.
- wallAreaNetSqFt = wallAreaGrossSqFt - wallOpeningAreaSqFt.
- confidence: "low", "medium", or "high".
- ${isExterior ? 'Exterior walls: single-story 9-12 ft, two-story 18-24 ft.' : `${roomType === 'bathroom' ? 'Bathrooms can be as small as 4×5 ft and up to about 8×10 ft. When exact anchors are provided, prefer those rulers over generic priors.' : roomType === 'kitchen' ? 'Kitchens are typically 10×12 to 15×20 ft (120-300 sq ft floor).' : 'Keep estimates realistic for typical US residential rooms.'}`}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imageMessages] }],
        max_tokens: 1200,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI room envelope error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, error: 'Failed to parse room envelope response' };

    const parsed = JSON.parse(jsonMatch[0]);
    const room = parsed?.room;
    if (!room) return { ok: false, error: 'Missing room object in envelope response' };

    const minHorizontalDimensionFt = roomType === 'bathroom' ? 4 : 5;
    const widthFt = Math.max(minHorizontalDimensionFt, Math.min(isExterior ? 120 : 40, Number(room.widthFt) || 10));
    const lengthFt = Math.max(minHorizontalDimensionFt, Math.min(isExterior ? 120 : 40, Number(room.lengthFt) || 12));
    const heightFt = Math.max(7, Math.min(isExterior ? 30 : 14, Number(room.heightFt) || (isExterior ? 10 : 8)));

    const floorAreaSqFt = Math.max(25, Math.round(Number(room.floorAreaSqFt) || (widthFt * lengthFt)));
    const ceilingAreaSqFt = Math.max(25, Math.round(Number(room.ceilingAreaSqFt) || floorAreaSqFt));
    const wallAreaGrossSqFt = Math.max(80, Math.round(Number(room.wallAreaGrossSqFt) || (2 * (widthFt + lengthFt) * heightFt)));
    const wallOpeningAreaSqFt = Math.max(0, Math.round(Number(room.wallOpeningAreaSqFt) || 0));
    const wallAreaNetSqFt = Math.max(50, Math.round(Number(room.wallAreaNetSqFt) || (wallAreaGrossSqFt - wallOpeningAreaSqFt)));
    const confidence = ['low', 'medium', 'high'].includes(room.confidence) ? room.confidence : 'medium';

    return {
      ok: true,
      room: {
        widthFt,
        lengthFt,
        heightFt,
        floorAreaSqFt,
        ceilingAreaSqFt,
        wallAreaGrossSqFt,
        wallOpeningAreaSqFt,
        wallAreaNetSqFt: Math.max(50, Math.min(wallAreaGrossSqFt, wallAreaNetSqFt)),
        confidence,
      },
    };
  } catch (error) {
    console.error('[PhotoMeasurement] Room envelope estimation error:', error.message);
    return { ok: false, error: error.message };
  }
}

function isHardConstraintReference(ref) {
  if (!ref?.type) return false;
  if (FLOOR_TILE_ANCHOR_TYPES.has(ref.type)) return false;
  const reliability = REFERENCE_ANCHOR_RELIABILITY[ref.type] || {};
  const strongestDimension = Math.max(reliability.height || 0, reliability.width || 0);
  const standardSizeConfidence = clamp01(ref.standardSizeConfidence, VARIABLE_STANDARD_ANCHOR_TYPES.has(ref.type) ? 0.52 : 0.72);
  if (ref.useForScale === true && strongestDimension >= 0.58 && standardSizeConfidence >= 0.72) {
    return true;
  }
  if (ref.useForScale === true && ref.type.includes('window') && standardSizeConfidence >= 0.92 && categoricalScaleAnchorScore(ref.visibility, { full: 1, full_visible: 1, mostly_visible: 0.86 }, 0.4) >= 0.86) {
    return true;
  }
  return (
    ref.type.includes('door') ||
    ref.type === 'electrical_outlet' ||
    ref.type === 'light_switch' ||
    ref.type === 'double_outlet' ||
    ref.type.startsWith('ceiling_height_')
  );
}

function shouldUseReferenceForGlobalCalibration(ref, dimension, anchorScore) {
  if (!anchorScore?.usable) return false;

  const profileType = getReferenceProfileType(ref);
  const isExactKnownSceneAnchor = Boolean(ref?.knownSceneAnchorId) || ref?.source === 'known_scene_anchor';
  const refined = Boolean(ref?.cropRefined || ref?.deterministicRefined || ref?.geometryRefined || ref?.learnedDetectorRefined);

  if (profileType === 'standard_toilet' || profileType === 'toilet') {
    return false;
  }

  if (profileType === 'bathroom_vanity_auto') {
    return dimension === 'width'
      && anchorScore.quality >= 0.42
      && refined
      && ref?.source === 'auto_inferred_reference_anchor';
  }

  if (/^bathroom_vanity_\d+$/i.test(profileType) && !isExactKnownSceneAnchor) {
    return dimension === 'height' && anchorScore.quality >= 0.60;
  }

  if (profileType === 'bathroom_mirror' || profileType === 'bathroom_mirror_auto' || profileType === 'medicine_cabinet') {
    return false;
  }

  return true;
}

function buildGlobalHardConstraintCalibration(photos, depthResults, intrinsicsResults) {
  const scales = [];
  const rejectedAnchors = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const depthInfo = depthResults[i] || { ok: false };
    const intrinsics = intrinsicsResults[i];
    if (!photo?.referenceObjects?.length || !depthInfo?.ok || !intrinsics) continue;

    const imgW = depthInfo.width || 1920;
    const imgH = depthInfo.height || 1080;

    for (const ref of photo.referenceObjects) {
      if (!isHardConstraintReference(ref)) continue;
      const known = getReferenceKnownDimensions(ref);
      if (!known) {
        rejectedAnchors.push({ photoIndex: i, type: ref.type, reason: 'unknown_reference_type' });
        continue;
      }

      const referenceMeasurement = measureReferenceObject(ref, depthInfo, imgW, imgH, intrinsics);
      if (!referenceMeasurement) {
        rejectedAnchors.push({ photoIndex: i, type: ref.type, reason: 'projection_failed_or_depth_unavailable' });
        continue;
      }
      const { measured } = referenceMeasurement;

      const physicalCheck = validateReferencePhysicalPlausibility(ref, measured);
      if (!physicalCheck.ok) {
        rejectedAnchors.push({
          photoIndex: i,
          type: ref.type,
          reason: physicalCheck.reason,
          measurementMethod: measured.measurementMethod || referenceMeasurement.depthStats?.source || null,
          impliedScale: physicalCheck.impliedScale ? Math.round(physicalCheck.impliedScale * 1000) / 1000 : null,
          measuredWidthInches: physicalCheck.measuredWidthInches ? Math.round(physicalCheck.measuredWidthInches * 10) / 10 : null,
          measuredHeightInches: physicalCheck.measuredHeightInches ? Math.round(physicalCheck.measuredHeightInches * 10) / 10 : null,
        });
        continue;
      }

      const aspectCheck = validateReferenceAspect(ref, known, measured);
      if (!aspectCheck.ok) {
        rejectedAnchors.push({
          photoIndex: i,
          type: ref.type,
          reason: aspectCheck.reason,
          widthScale: aspectCheck.widthScale ? aspectCheck.widthScale.toFixed(3) : null,
          heightScale: aspectCheck.heightScale ? aspectCheck.heightScale.toFixed(3) : null,
          scaleDisagreement: aspectCheck.scaleDisagreement ? Math.round(aspectCheck.scaleDisagreement * 100) / 100 : null,
        });
        continue;
      }

      const anchorKey = buildReferenceAnchorKey(ref, i);
      const dimensionValidity = aspectCheck.dimensionValidity || { height: true, width: true };

      if (known.height && dimensionValidity.height !== false && !isReferenceDimensionEnabled(ref, 'height')) {
        rejectedAnchors.push({ photoIndex: i, type: ref.type, dimension: 'height', reason: 'dimension_not_enabled_for_scale' });
      }
      if (known.height && dimensionValidity.height !== false && isReferenceDimensionEnabled(ref, 'height') && measured.heightInches > 0.1) {
        const anchorScore = scoreReferenceAnchor(ref, 'height');
        if (shouldUseReferenceForGlobalCalibration(ref, 'height', anchorScore)) {
          scales.push({
            scale: known.height / measured.heightInches,
            confidence: ref.confidence || 0.7,
            quality: anchorScore.quality,
            weight: getAnchorCandidateWeight(ref, 'height', anchorScore.quality),
            type: ref.type,
            dimension: 'height',
            photoIndex: i,
            anchorKey,
          });
        } else {
          rejectedAnchors.push({ photoIndex: i, type: ref.type, dimension: 'height', reason: anchorScore.reason || 'not_eligible_for_global_calibration', quality: anchorScore.quality });
        }
      }
      if (known.height && dimensionValidity.height === false) {
        rejectedAnchors.push({ photoIndex: i, type: ref.type, dimension: 'height', reason: aspectCheck.reason || 'dimension_aspect_rejected' });
      }
      if (known.width && dimensionValidity.width !== false && !isReferenceDimensionEnabled(ref, 'width')) {
        rejectedAnchors.push({ photoIndex: i, type: ref.type, dimension: 'width', reason: 'dimension_not_enabled_for_scale' });
      }
      if (known.width && dimensionValidity.width !== false && isReferenceDimensionEnabled(ref, 'width') && measured.widthInches > 0.1) {
        const anchorScore = scoreReferenceAnchor(ref, 'width');
        if (shouldUseReferenceForGlobalCalibration(ref, 'width', anchorScore)) {
          scales.push({
            scale: known.width / measured.widthInches,
            confidence: ref.confidence || 0.7,
            quality: anchorScore.quality,
            weight: getAnchorCandidateWeight(ref, 'width', anchorScore.quality),
            type: ref.type,
            dimension: 'width',
            photoIndex: i,
            anchorKey,
          });
        } else {
          rejectedAnchors.push({ photoIndex: i, type: ref.type, dimension: 'width', reason: anchorScore.reason || 'not_eligible_for_global_calibration', quality: anchorScore.quality });
        }
      }
      if (known.width && dimensionValidity.width === false) {
        rejectedAnchors.push({
          photoIndex: i,
          type: ref.type,
          dimension: 'width',
          reason: aspectCheck.reason || 'dimension_aspect_rejected',
          widthScale: aspectCheck.widthScale ? aspectCheck.widthScale.toFixed(3) : null,
          heightScale: aspectCheck.heightScale ? aspectCheck.heightScale.toFixed(3) : null,
          scaleDisagreement: aspectCheck.scaleDisagreement ? Math.round(aspectCheck.scaleDisagreement * 100) / 100 : null,
        });
      }
    }
  }

  if (!scales.length) return { available: false, scaleFactor: 1.0, consistency: 'low', count: 0, rejectedAnchors };

  const robust = chooseRobustScaleCandidate(scales);
  const avg = robust?.scale || 1.0;
  const consistency = robust?.consistency || 'low';
  const spread = robust?.spread || 0;
  const trust = trustCalibration(avg, consistency);

  if (!trust.trusted) {
    console.warn(`[PhotoMeasurement] Rejecting global calibration: ${trust.reason} (candidate scale=${avg.toFixed(3)}, spread=${spread.toFixed(2)}, refs=${scales.length})`);
  }

  return {
    available: trust.trusted,
    scaleFactor: trust.trusted ? avg : 1.0,
    candidateScaleFactor: avg,
    consistency,
    consensus: robust?.consensus || null,
    count: robust?.cluster?.length || 0,
    candidateCount: scales.length,
    spread: Math.round(spread * 100) / 100,
    rejected: !trust.trusted,
    rejectionReason: trust.reason,
    references: (robust?.cluster || []).map(sf => ({
      photoIndex: sf.photoIndex,
      type: sf.type,
      dimension: sf.dimension,
      scale: sf.scale.toFixed(3),
      quality: Math.round(sf.quality * 100) / 100,
      anchorKey: sf.anchorKey || null,
    })),
    rejectedAnchors: [
      ...rejectedAnchors,
      ...(robust?.rejectedOutliers || []).map(sf => ({ photoIndex: sf.photoIndex, type: sf.type, dimension: sf.dimension, reason: 'scale_outlier', scale: sf.scale.toFixed(3), quality: Math.round(sf.quality * 100) / 100, anchorKey: sf.anchorKey || null })),
    ],
  };
}

function estimateMeasurementUncertainty(dimensions, confidence, calibration, photoCount) {
  let pct = confidence === 'high' ? 0.10 : confidence === 'medium' ? 0.20 : 0.32;

  if (!calibration?.calibrated) pct += 0.06;
  else if (calibration.consistency === 'low') pct += 0.04;

  if ((photoCount || 1) >= 4) pct -= 0.03;
  if ((photoCount || 1) <= 1) pct += 0.04;

  if (dimensions?.methodology === 'dav3_metric_plane_fit') pct -= 0.03;
  if (dimensions?.methodology === 'gpt_4o_multi_image_room_envelope') pct += 0.02;
  if (dimensions?.methodology === 'gpt_visual_estimate') pct += 0.05;

  pct = Math.max(0.08, Math.min(0.40, pct));

  return {
    percent: Math.round(pct * 100) / 100,
    widthFt: {
      low: Math.max(3, Math.round((dimensions.widthFt * (1 - pct)) * 10) / 10),
      high: Math.round((dimensions.widthFt * (1 + pct)) * 10) / 10,
    },
    lengthFt: {
      low: Math.max(3, Math.round((dimensions.lengthFt * (1 - pct)) * 10) / 10),
      high: Math.round((dimensions.lengthFt * (1 + pct)) * 10) / 10,
    },
    heightFt: {
      low: Math.max(7, Math.round((dimensions.heightFt * (1 - pct * 0.6)) * 10) / 10),
      high: Math.round((dimensions.heightFt * (1 + pct * 0.6)) * 10) / 10,
    },
  };
}

function evaluateCaptureProtocol(photos, depthResults) {
  const cornerShots = photos.filter(p => p?.cornerVisible).length;

  const fullHeightDoorShots = photos.filter(p => (p?.referenceObjects || []).some(r =>
    (r.type || '').includes('door') &&
    (r.confidence || 0) >= 0.75 &&
    (r.boundingBox?.height || 0) >= 0.55
  )).length;

  let floorForwardShots = 0;
  let ceilingForwardShots = 0;
  for (let i = 0; i < photos.length; i++) {
    const d = sampleRoomDepths(depthResults[i]);
    if (!d) continue;
    if ((d.floorCount || 0) >= 300 && (d.farWallDepth || 0) > 0.5) floorForwardShots++;
    if ((d.ceilingCount || 0) >= 200 && (d.farWallDepth || 0) > 0.5) ceilingForwardShots++;
  }

  const req = {
    corners: { required: 2, actual: cornerShots, pass: cornerShots >= 2 },
    fullHeightDoor: { required: 1, actual: fullHeightDoorShots, pass: fullHeightDoorShots >= 1 },
    floorForward: { required: 1, actual: floorForwardShots, pass: floorForwardShots >= 1 },
    ceilingForward: { required: 1, actual: ceilingForwardShots, pass: ceilingForwardShots >= 1 },
  };
  const passed = Object.values(req).filter(r => r.pass).length;

  return {
    score: `${passed}/4`,
    pass: passed >= 3,
    requirements: req,
    note: passed >= 3
      ? 'Capture protocol mostly satisfied'
      : 'Insufficient room-envelope coverage for high-confidence dimensions',
  };
}

// ============================================================================
// Multi-Photo Room Consolidation
// ============================================================================
function consolidateRoomMeasurements(roomPhotos) {
  if (roomPhotos.length === 0) return null;
  if (roomPhotos.length === 1) return roomPhotos[0].dimensions;

  const methodWeights = { 'dav3_metric_plane_fit': 1.1, 'dav3_metric_calibrated': 1.0, 'gpt_visual_estimate': 0.6 };
  const hasCalibratedPhoto = roomPhotos.some(photo => photo.calibration?.calibrated || photo.calibration?.displayCalibrated);
  let weighted = roomPhotos.map(photo => {
    const d = photo.dimensions;
    const baseW = methodWeights[d.methodology] || 0.7;
    const calibrationWeight = !(photo.calibration?.calibrated || photo.calibration?.displayCalibrated)
      ? (hasCalibratedPhoto ? 0.28 : 0.65)
      : photo.calibration?.consistency === 'high'
        ? 1.35
        : photo.calibration?.consistency === 'medium'
          ? 1.12
          : 0.88;
    return {
      photo,
      weight: baseW * calibrationWeight,
    };
  });

  // Outlier rejection pass (remove photos with large size deviation from weighted center)
  const prelimTotal = weighted.reduce((s, p) => s + p.weight, 0) || 1;
  const prelimW = weighted.reduce((s, p) => s + p.photo.dimensions.widthFt * p.weight, 0) / prelimTotal;
  const prelimL = weighted.reduce((s, p) => s + p.photo.dimensions.lengthFt * p.weight, 0) / prelimTotal;
  const filtered = weighted.filter(p => {
    const d = p.photo.dimensions;
    const widthErr = Math.abs(d.widthFt - prelimW) / Math.max(prelimW, 0.1);
    const lengthErr = Math.abs(d.lengthFt - prelimL) / Math.max(prelimL, 0.1);
    return widthErr <= 0.35 && lengthErr <= 0.35;
  });
  if (filtered.length >= 2) weighted = filtered;

  let totalWeight = 0, wWidth = 0, wLength = 0, wHeight = 0;
  for (const p of weighted) {
    const d = p.photo.dimensions;
    const w = p.weight;
    wWidth += d.widthFt * w;
    wLength += d.lengthFt * w;
    wHeight += d.heightFt * w;
    totalWeight += w;
  }

  const avgW = wWidth / (totalWeight || 1);
  const avgL = wLength / (totalWeight || 1);
  const avgH = wHeight / (totalWeight || 1);
  const widths = roomPhotos.map(p => p.dimensions.widthFt);
  const widthRange = Math.max(...widths) - Math.min(...widths);
  const consistency = (widthRange / avgW < 0.25) ? 'high' : (widthRange / avgW < 0.4) ? 'medium' : 'low';

  return {
    widthFt: Math.round(avgW * 10) / 10, lengthFt: Math.round(avgL * 10) / 10,
    heightFt: Math.round(avgH), floorAreaSqFt: Math.round(avgW * avgL),
    wallAreaSqFt: Math.round(2 * (avgW + avgL) * avgH), perimeterFt: Math.round(2 * (avgW + avgL)),
    methodology: 'multi_photo_consolidated', photoCount: roomPhotos.length, consistency,
  };
}

const SINGLE_INSTANCE_ROOM_OBJECT_TYPES = new Set([
  'existing_vanity',
  'existing_toilet',
  'vanity_space',
  'shower_door_opening',
  'existing_bathtub',
  'existing_fridge',
  'fridge_opening',
  'existing_range',
  'range_opening',
  'existing_dishwasher',
  'dishwasher_opening',
  'existing_microwave',
]);

const OBJECT_CLUSTER_TOLERANCES = {
  existing_vanity: { width: 0.14, height: 0.12 },
  vanity_space: { width: 0.22, height: 0.22 },
  bathroom_mirror: { width: 0.26, height: 0.24 },
  shower_door_opening: { width: 0.26, height: 0.18 },
  existing_bathtub: { width: 0.18, height: 0.24 },
  default: { width: 0.18, height: 0.18 },
};

function getObjectMeasurementMethod(measurement) {
  return measurement?.dimensions?.measurementMethod
    || measurement?.measurementGeometry?.method
    || measurement?.measurementTrust?.measurementMethod
    || 'unknown';
}

function normalizeBathroomMirrorFamily(value) {
  const normalized = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return null;
  if (['medicine_cabinet', 'mirrored_medicine_cabinet', 'medicinecabinet'].includes(normalized)) return 'medicine_cabinet';
  if (['bathroom_mirror', 'wall_mirror', 'mirror', 'framed_mirror'].includes(normalized)) return 'bathroom_mirror';
  return null;
}

function inferBathroomMirrorFamilyFromDimensions(candidate) {
  const widthInches = Number(candidate?.dimensions?.widthInches || candidate?.knownDimensions?.width || 0);
  const heightInches = Number(candidate?.dimensions?.heightInches || candidate?.knownDimensions?.height || 0);
  if (!(widthInches > 0) || !(heightInches > 0)) return null;

  if (Math.max(widthInches, heightInches) <= 30 && Math.min(widthInches, heightInches) <= 26) return 'medicine_cabinet';
  if (widthInches >= 30 || heightInches >= 30) return 'bathroom_mirror';
  return null;
}

function getBathroomMirrorFamilyKey(candidate) {
  const explicitFamily = normalizeBathroomMirrorFamily(candidate?.targetFamily || candidate?.mirrorFamily);
  const measuredFamily = inferBathroomMirrorFamilyFromDimensions(candidate);

  const profileType = String(getReferenceProfileType(candidate) || candidate?.sourceReferenceType || '').toLowerCase();
  if (profileType === 'medicine_cabinet') return 'medicine_cabinet';
  if (profileType === 'bathroom_mirror' || profileType === 'bathroom_mirror_auto') return 'bathroom_mirror';

  const referenceProfiles = (candidate?.referenceHints || [])
    .map(hint => normalizeBathroomMirrorFamily(hint?.referenceProfileType))
    .filter(Boolean);
  if (referenceProfiles.includes('medicine_cabinet')) return 'medicine_cabinet';
  if (referenceProfiles.includes('bathroom_mirror')) return 'bathroom_mirror';

  const referenceBackedFamily = Boolean(
    candidate?.referenceAligned
    || candidate?.measurementGeometry?.referenceAligned
    || referenceProfiles.length
    || profileType === 'medicine_cabinet'
    || profileType === 'bathroom_mirror'
    || profileType === 'bathroom_mirror_auto'
  );

  if (explicitFamily && (!measuredFamily || explicitFamily === measuredFamily || referenceBackedFamily)) return explicitFamily;
  if (measuredFamily) return measuredFamily;

  const description = String(candidate?.description || '').toLowerCase();
  if (/mirrored medicine cabinet|medicine cabinet|cabinet mirror|medicine mirror/.test(description)) return 'medicine_cabinet';
  if (/wall mirror|framed mirror|bathroom mirror|mirror above vanity|mirror above sink/.test(description)) return 'bathroom_mirror';

  const candidateType = candidate?.targetType || candidate?.type || candidate?.sourceTargetType || null;
  if (candidateType !== 'bathroom_mirror') return null;

  return null;
}

function normalizeMeasurementTargetForFamily(target) {
  if (target?.targetType !== 'bathroom_mirror') return target;
  const targetFamily = getBathroomMirrorFamilyKey(target);
  const description = String(target?.description || '').trim();
  return {
    ...target,
    targetFamily: targetFamily || null,
    description: description || (targetFamily === 'medicine_cabinet' ? 'Mirrored medicine cabinet' : targetFamily === 'bathroom_mirror' ? 'Bathroom mirror' : null),
  };
}

function getAutoFixtureReferenceConfigForTarget(target, config, measuredDimensions = null) {
  if (target?.targetType !== 'bathroom_mirror' || !config) {
    const widthMatch = closestStandardDimension(measuredDimensions?.widthInches, config?.widths || []);
    const heightMatch = closestStandardDimension(measuredDimensions?.heightInches, config?.heights || []);
    return { config, widthMatch, heightMatch, targetFamily: target?.targetFamily || null };
  }

  const hintedFamily = getBathroomMirrorFamilyKey(target);
  const candidates = [
    {
      ...config,
      referenceType: 'medicine_cabinet',
      widths: [18, 20, 22, 24, 30],
      heights: [20, 24, 26, 30, 36],
      maxRelativeError: Math.min(config.maxRelativeError || 0.18, 0.18),
      mirrorFamily: 'medicine_cabinet',
    },
    {
      ...config,
      referenceType: 'bathroom_mirror_auto',
      widths: [24, 30, 36, 42],
      heights: [20, 24, 30, 36, 42],
      mirrorFamily: 'bathroom_mirror',
    },
  ].map(candidate => {
    const widthMatch = closestStandardDimension(measuredDimensions?.widthInches, candidate.widths);
    const heightMatch = closestStandardDimension(measuredDimensions?.heightInches, candidate.heights);
    const widthPenalty = widthMatch ? widthMatch.relError : Infinity;
    const heightPenalty = heightMatch ? heightMatch.relError : 0.12;
    const familyPenalty = hintedFamily && hintedFamily !== candidate.mirrorFamily ? 0.04 : 0;
    return {
      config: candidate,
      widthMatch,
      heightMatch,
      targetFamily: candidate.mirrorFamily,
      score: widthPenalty * 1.35 + heightPenalty * 0.85 + familyPenalty,
    };
  }).filter(candidate => candidate.widthMatch && candidate.widthMatch.relError <= candidate.config.maxRelativeError);

  const best = candidates.sort((first, second) => first.score - second.score)[0] || null;
  if (!best) {
    return { config, widthMatch: null, heightMatch: null, targetFamily: hintedFamily || null };
  }

  return best;
}

function getObjectClusterTolerance(type, dimension) {
  const tolerance = OBJECT_CLUSTER_TOLERANCES[type] || OBJECT_CLUSTER_TOLERANCES.default;
  return tolerance?.[dimension] ?? OBJECT_CLUSTER_TOLERANCES.default[dimension] ?? 0.18;
}

function relativeDimensionDifference(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Math.abs(a - b) / Math.max(a, b, 1);
}

function getObjectMeasurementPriority(measurement) {
  const trustReasons = new Set(measurement?.measurementTrust?.reasons || []);
  const method = getObjectMeasurementMethod(measurement);
  const methodScore = {
    local_wall_plane_rectified: 1.0,
    surrounding_wall_depth_pinhole: 0.88,
    front_face_depth_pinhole: 0.94,
    bbox_center_depth_pinhole: 0.45,
    position_heuristic: 0.2,
  }[method] ?? 0.35;

  let score = methodScore;
  score += Math.max(0, Math.min(1, measurement?.confidence || 0)) * 1.25;
  score += measurement?.trustedForPricing ? 2.2 : (measurement?.calibrated ? 0.75 : 0);
  score += measurement?.measurementGeometry?.edgeRefined ? 0.45 : 0;
  score += measurement?.measurementGeometry?.depthSampleCount
    ? Math.min(0.35, measurement.measurementGeometry.depthSampleCount / 180)
    : 0;

  if (measurement?.sanityClamped) score -= 1.1;
  if (trustReasons.has('object_bbox_not_refined')) score -= 0.75;
  if (trustReasons.has('object_plane_geometry_unverified')) score -= 0.8;
  if (trustReasons.has('object_front_face_geometry_unverified')) score -= 0.8;
  if (trustReasons.has('calibration_untrusted')) score -= 0.55;
  if (trustReasons.has('intrinsics_estimated')) score -= 0.35;
  if (trustReasons.has('depth_bbox_fallback')) score -= 0.35;
  if (trustReasons.has('low_detection_confidence')) score -= 0.25;

  return score;
}

function getObjectDimensionPriority(measurement, dimension) {
  const dimensionKey = dimension === 'width' ? 'widthInches' : 'heightInches';
  const value = measurement?.dimensions?.[dimensionKey];
  if (!Number.isFinite(value) || value <= 0) return Number.NEGATIVE_INFINITY;

  let score = getObjectMeasurementPriority(measurement);
  for (const reason of (measurement?.sanityReasons || [])) {
    if (reason.startsWith(`${dimension}_`)) score -= 1.35;
  }
  return score;
}

function isDimensionClampedForMeasurement(measurement, dimension) {
  return (measurement?.sanityReasons || []).some(reason => reason.startsWith(`${dimension}_`));
}

function usesPreferredObjectGeometry(measurement, type) {
  const method = getObjectMeasurementMethod(measurement);
  if (WALL_PLANE_TARGET_TYPES.has(type)) {
    return getPreferredWallPlaneMeasurementMethods(type).includes(method);
  }
  if (FRONT_FACE_TARGET_TYPES.has(type)) {
    return method === 'front_face_depth_pinhole';
  }
  return true;
}

function hasRefinedObjectGeometry(measurement, type) {
  if (!(WALL_PLANE_TARGET_TYPES.has(type) || FRONT_FACE_TARGET_TYPES.has(type))) return true;
  return Boolean(measurement?.measurementGeometry?.edgeRefined);
}

function selectObjectDimensionConsensusPool(cluster, type, dimension) {
  const pools = [
    {
      tier: 'strict_geometry_refined_unclamped',
      candidates: cluster.filter(measurement => (
        usesPreferredObjectGeometry(measurement, type)
        && hasRefinedObjectGeometry(measurement, type)
        && !isDimensionClampedForMeasurement(measurement, dimension)
      )),
    },
    {
      tier: 'geometry_unclamped',
      candidates: cluster.filter(measurement => (
        usesPreferredObjectGeometry(measurement, type)
        && !isDimensionClampedForMeasurement(measurement, dimension)
      )),
    },
    {
      tier: 'geometry_refined',
      candidates: cluster.filter(measurement => (
        usesPreferredObjectGeometry(measurement, type)
        && hasRefinedObjectGeometry(measurement, type)
      )),
    },
    {
      tier: 'geometry_any',
      candidates: cluster.filter(measurement => usesPreferredObjectGeometry(measurement, type)),
    },
    {
      tier: 'refined_unclamped',
      candidates: cluster.filter(measurement => (
        hasRefinedObjectGeometry(measurement, type)
        && !isDimensionClampedForMeasurement(measurement, dimension)
      )),
    },
    {
      tier: 'unclamped_any',
      candidates: cluster.filter(measurement => !isDimensionClampedForMeasurement(measurement, dimension)),
    },
  ];

  const selected = pools.find(pool => pool.candidates.length > 0);
  if (type === 'existing_vanity' && dimension === 'width' && selected?.tier === 'strict_geometry_refined_unclamped') {
    const broaderPool = pools.find(pool => pool.tier === 'geometry_unclamped');
    if (broaderPool?.candidates?.length > selected.candidates.length) {
      const summarizePool = candidates => {
        const values = candidates
          .map(measurement => Number(measurement?.dimensions?.widthInches || 0))
          .filter(value => Number.isFinite(value) && value > 0)
          .sort((first, second) => first - second);
        const photoCount = new Set(
          candidates
            .map(measurement => measurement?.photoIndex)
            .filter(photoIndex => Number.isInteger(photoIndex) && photoIndex >= 0)
        ).size;
        return {
          photoCount,
          upperValue: values.length
            ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * 0.75))]
            : null,
        };
      };

      const strictSummary = summarizePool(selected.candidates);
      const broaderSummary = summarizePool(broaderPool.candidates);
      if (broaderSummary.photoCount >= Math.max(3, strictSummary.photoCount + 1)
        && Number.isFinite(broaderSummary.upperValue)
        && Number.isFinite(strictSummary.upperValue)
        && broaderSummary.upperValue > strictSummary.upperValue * 1.08) {
        return broaderPool;
      }
    }
  }
  return selected || { tier: 'all_candidates', candidates: cluster };
}

function collectReferenceHintsForTarget(target, referenceObjects = []) {
  const directHints = target?.referenceAligned && target?.sourceReferenceType && target?.referenceKnownDimensions
    ? [{
        referenceProfileType: target.sourceReferenceType,
        knownDimensions: target.referenceKnownDimensions,
        standardSizeConfidence: clamp01(target?.referenceStandardSizeConfidence, 0.72),
        anchorQuality: target?.referenceAnchorQuality || 'unknown',
        cropRefined: Boolean(target?.edgeRefined || target?.cropRefined || target?.deterministicRefined),
        exactKnownSceneAnchor: Boolean(target?.referenceKnownSceneAnchorId),
        sourceTargetType: target?.targetType || null,
      }]
    : [];

  if (!isValidNormalizedBox(target?.boundingBox) || !Array.isArray(referenceObjects) || referenceObjects.length === 0) {
    return directHints;
  }

  const hints = [
    ...directHints,
    ...referenceObjects
    .filter(ref => {
      if (!isValidNormalizedBox(ref?.boundingBox)) return false;
      const profileType = getReferenceProfileType(ref);
      const compatibleProfile = target?.targetType === 'existing_vanity'
        ? (profileType === 'bathroom_vanity_auto' || /^bathroom_vanity_/i.test(profileType || ''))
        : target?.targetType === 'bathroom_mirror'
          ? MIRROR_REFERENCE_PROFILE_TYPES.has(profileType)
          : false;
      const sameSourceTarget = ref?.sourceTargetType === target?.targetType;
      if (!compatibleProfile && !sameSourceTarget) return false;

      return bboxIntersectionOverUnion(target.boundingBox, ref.boundingBox) >= 0.12
        || bboxCenterDistance(target.boundingBox, ref.boundingBox) <= 0.08;
    })
    .map(ref => ({
      referenceProfileType: getReferenceProfileType(ref),
      knownDimensions: getReferenceKnownDimensions(ref),
      standardSizeConfidence: clamp01(ref?.standardSizeConfidence, 0.72),
      anchorQuality: ref?.anchorQuality || 'unknown',
      cropRefined: Boolean(ref?.cropRefined || ref?.geometryRefined || ref?.deterministicRefined),
      exactKnownSceneAnchor: isExactKnownSceneAnchorRef(ref),
      sourceTargetType: ref?.sourceTargetType || null,
    })),
  ];

  if (target?.targetType === 'existing_vanity' && hints.some(hint => hint?.referenceProfileType === 'bathroom_vanity_auto')) {
    return hints.filter(hint => (
      hint?.referenceProfileType === 'bathroom_vanity_auto'
      || hint?.exactKnownSceneAnchor
      || !isFixedVanityReferenceProfile(hint?.referenceProfileType)
    ));
  }

  return hints;
}

function getReferenceHintDimensionsForObject(referenceHint, type) {
  const known = referenceHint?.knownDimensions || {};
  let widthInches = Number(known?.width || 0);
  let heightInches = Number(known?.height || 0);

  if (type === 'existing_vanity' && widthInches > 0) {
    if (isFixedVanityReferenceProfile(referenceHint?.referenceProfileType) && !referenceHint?.exactKnownSceneAnchor) {
      return {
        widthInches: null,
        heightInches: null,
      };
    }
    const widthFamily = closestStandardDimension(widthInches, AUTO_FIXTURE_REFERENCE_TARGETS.existing_vanity.widths)?.value || widthInches;
    widthInches = widthFamily;
    if (!(heightInches > 0) && referenceHint?.exactKnownSceneAnchor) {
      const familyProfile = REFERENCE_OBJECTS[`bathroom_vanity_${widthFamily}`] || REFERENCE_OBJECTS.bathroom_vanity_auto;
      heightInches = Number(familyProfile?.height || 0);
    }
    if (!referenceHint?.exactKnownSceneAnchor) {
      heightInches = null;
    }
  }

  if (type === 'bathroom_mirror') {
    const mirrorConfig = AUTO_FIXTURE_REFERENCE_TARGETS.bathroom_mirror;
    if (widthInches > 0) {
      widthInches = closestStandardDimension(widthInches, mirrorConfig.widths)?.value || widthInches;
    }
    if (heightInches > 0) {
      heightInches = closestStandardDimension(heightInches, mirrorConfig.heights)?.value || heightInches;
    }
  }

  return {
    widthInches: widthInches > 0 ? widthInches : null,
    heightInches: heightInches > 0 ? heightInches : null,
  };
}

function collectObjectReferenceDimensionOverride(cluster, type) {
  if (!['existing_vanity', 'bathroom_mirror'].includes(type)) return null;

  const families = new Map();
  for (const measurement of cluster) {
    for (const referenceHint of (measurement?.referenceHints || [])) {
      const dims = getReferenceHintDimensionsForObject(referenceHint, type);
      if (!dims.widthInches && !dims.heightInches) continue;

      const key = `${dims.widthInches || ''}:${dims.heightInches || ''}`;
      const autoVanityHint = type === 'existing_vanity' && referenceHint?.referenceProfileType === 'bathroom_vanity_auto';
      const guessedFixedVanityHint = type === 'existing_vanity'
        && isFixedVanityReferenceProfile(referenceHint?.referenceProfileType)
        && !referenceHint?.exactKnownSceneAnchor;
      const weight = clamp01(referenceHint.standardSizeConfidence, 0.72)
        + (referenceHint.anchorQuality === 'high' ? 0.24 : referenceHint.anchorQuality === 'medium' ? 0.12 : 0)
        + (referenceHint.cropRefined ? 0.08 : 0)
        + (autoVanityHint ? 0.28 : 0)
        - (guessedFixedVanityHint ? 0.18 : 0);

      const existing = families.get(key) || {
        widthInches: dims.widthInches,
        heightInches: dims.heightInches,
        totalWeight: 0,
        photoIndexes: new Set(),
        hintCount: 0,
        referenceAlignedCount: 0,
        cropRefinedCount: 0,
      };
      existing.totalWeight += weight;
      existing.hintCount += 1;
      if (measurement?.measurementGeometry?.referenceAligned) existing.referenceAlignedCount += 1;
      if (referenceHint.cropRefined) existing.cropRefinedCount += 1;
      if (Number.isInteger(measurement?.photoIndex) && measurement.photoIndex >= 0) {
        existing.photoIndexes.add(measurement.photoIndex);
      }
      families.set(key, existing);
    }
  }

  const best = [...families.values()]
    .sort((first, second) => second.totalWeight - first.totalWeight || second.photoIndexes.size - first.photoIndexes.size)[0];
  if (type === 'existing_vanity') {
    const singlePhotoCluster = cluster.length === 1;
    const hasMultiPhotoReferenceConsensus = best
      && best.totalWeight >= 1.25
      && best.photoIndexes.size >= 2
      && best.hintCount >= 2
      && best.referenceAlignedCount >= 1;
    if (!best || (!singlePhotoCluster && !hasMultiPhotoReferenceConsensus)) return null;
  } else {
    if (!best || best.totalWeight < 1.0 || best.photoIndexes.size < 1) return null;
  }

  return {
    widthInches: best.widthInches,
    heightInches: best.heightInches,
    photoIndexes: [...best.photoIndexes],
    source: 'reference_anchor_family_override',
  };
}

function hasStrongVanityAutoWidthEvidence(cluster = [], widthInches = null) {
  if (!Number.isFinite(widthInches) || widthInches <= 0) return false;

  const supportingPhotos = new Set();
  let supportingHintCount = 0;

  for (const measurement of cluster) {
    for (const referenceHint of (measurement?.referenceHints || [])) {
      if (referenceHint?.referenceProfileType !== 'bathroom_vanity_auto') continue;
      const dims = getReferenceHintDimensionsForObject(referenceHint, 'existing_vanity');
      if (dims.widthInches !== widthInches) continue;
      supportingHintCount += 1;
      if (Number.isInteger(measurement?.photoIndex) && measurement.photoIndex >= 0) {
        supportingPhotos.add(measurement.photoIndex);
      }
    }
  }

  return supportingHintCount >= 2 && supportingPhotos.size >= 2;
}

function normalizeExistingVanityWidth(widthInches, widthConsensus, clusterSize, referenceOverride, hasAutoWidthEvidence = false, cluster = []) {
  if (!Number.isFinite(widthInches) || widthInches <= 0) return null;

  const rankedClusterWidths = (cluster || [])
    .map(measurement => ({
      measurement,
      value: Number(measurement?.dimensions?.widthInches || 0),
    }))
    .filter(candidate => Number.isFinite(candidate.value) && candidate.value > 0)
    .sort((first, second) => first.value - second.value);
  const supportValues = (widthConsensus?.supporters || [])
    .map(measurement => Number(measurement?.dimensions?.widthInches || 0))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((first, second) => first - second);
  const clusterValues = rankedClusterWidths.map(candidate => candidate.value);
  const upperSupportValue = supportValues.length
    ? supportValues[Math.min(supportValues.length - 1, Math.floor((supportValues.length - 1) * 0.75))]
    : null;
  const upperClusterValue = clusterValues.length
    ? clusterValues[Math.min(clusterValues.length - 1, Math.floor((clusterValues.length - 1) * 0.75))]
    : upperSupportValue;
  const upperHalfCandidates = rankedClusterWidths.slice(Math.floor(rankedClusterWidths.length / 2));
  const upperHalfAverage = upperHalfCandidates.length
    ? upperHalfCandidates.reduce((sum, candidate) => sum + candidate.value, 0) / upperHalfCandidates.length
    : upperClusterValue;
  const upperHalfPhotoCount = new Set(
    upperHalfCandidates
      .map(candidate => candidate.measurement?.photoIndex)
      .filter(photoIndex => Number.isInteger(photoIndex) && photoIndex >= 0)
  ).size;
  const compactUnclampedCandidates = rankedClusterWidths.filter(candidate => (
    candidate.value <= 40
    && !isDimensionClampedForMeasurement(candidate.measurement, 'width')
  ));
  const narrowCandidates = (compactUnclampedCandidates.filter(candidate => (
    usesPreferredObjectGeometry(candidate.measurement, 'existing_vanity')
    || candidate.measurement?.measurementGeometry?.edgeRefined
    || (candidate.measurement?.referenceHints || []).some(referenceHint => getReferenceProfileType(referenceHint) === 'bathroom_vanity_auto')
  )));
  const narrowSampleCandidates = narrowCandidates.length >= 2 ? narrowCandidates : compactUnclampedCandidates;
  const narrowRefinedCandidateCount = narrowSampleCandidates.filter(candidate => candidate.measurement?.measurementGeometry?.edgeRefined).length;
  const narrowSupportPhotoCount = new Set(
    narrowSampleCandidates
      .map(candidate => candidate.measurement?.photoIndex)
      .filter(photoIndex => Number.isInteger(photoIndex) && photoIndex >= 0)
  ).size;
  const narrowSeed = narrowSampleCandidates.length
    ? narrowSampleCandidates[Math.floor((narrowSampleCandidates.length - 1) * 0.35)]?.value
    : null;
  const narrowWidthMatch = narrowSeed
    ? closestStandardDimension(narrowSeed, AUTO_FIXTURE_REFERENCE_TARGETS.existing_vanity.widths.filter(value => value <= 36))
    : null;
  const narrowAutoWidthEvidence = narrowWidthMatch
    ? hasStrongVanityAutoWidthEvidence(cluster, narrowWidthMatch.value)
    : false;
  const narrowWidthCandidate = narrowWidthMatch
    && narrowWidthMatch.relError <= 0.14
    && clusterSize >= 4
    && narrowSupportPhotoCount >= 2
    && (narrowRefinedCandidateCount >= 1 || narrowAutoWidthEvidence)
    && Number.isFinite(upperClusterValue)
    && upperClusterValue >= narrowSeed * 1.25
    && ((widthConsensus?.supportPhotoCount || 0) <= 2 || narrowAutoWidthEvidence)
      ? {
          widthInches: narrowWidthMatch.value,
          source: 'narrow_cluster_vanity_width_snap',
          relativeError: narrowWidthMatch.relError,
        }
      : null;
  const ambiguousCompactVsBroadCluster = clusterSize >= 4
    && narrowSupportPhotoCount >= 2
    && Number.isFinite(narrowSeed)
    && narrowSeed <= 36
    && Number.isFinite(upperClusterValue)
    && upperClusterValue >= 48
    && upperClusterValue >= narrowSeed * 1.25;
  const ambiguousCompactFallbackCandidate = ambiguousCompactVsBroadCluster && narrowWidthMatch
    ? {
        widthInches: narrowWidthMatch.value,
        source: 'ambiguous_compact_vanity_width_snap',
        relativeError: narrowWidthMatch.relError,
      }
    : null;
  const broaderWidthSeed = Math.max(upperClusterValue || 0, upperHalfAverage || 0);
  const broaderWidthMatch = broaderWidthSeed
    ? closestStandardDimension(broaderWidthSeed, AUTO_FIXTURE_REFERENCE_TARGETS.existing_vanity.widths)
    : null;
  const broaderWidthCandidate = broaderWidthMatch
    && broaderWidthMatch.relError <= 0.1
    && broaderWidthMatch.value > widthInches
    && clusterSize >= 4
    && (widthConsensus?.supportPhotoCount || 0) <= 3
    && broaderWidthSeed > widthInches * 1.08
    && upperHalfPhotoCount >= 2
    && !ambiguousCompactVsBroadCluster
      ? {
          widthInches: broaderWidthMatch.value,
          source: 'broader_cluster_vanity_width_snap',
          relativeError: broaderWidthMatch.relError,
        }
      : null;

  if (narrowWidthCandidate && !referenceOverride?.widthInches) {
    return narrowWidthCandidate;
  }

  if (ambiguousCompactFallbackCandidate && !referenceOverride?.widthInches) {
    return ambiguousCompactFallbackCandidate;
  }

  if (broaderWidthCandidate && (!referenceOverride?.widthInches || broaderWidthCandidate.widthInches > referenceOverride.widthInches)) {
    return broaderWidthCandidate;
  }

  if (referenceOverride?.widthInches || hasAutoWidthEvidence) return null;

  if (widthConsensus?.tier !== 'strict_geometry_refined_unclamped') {
    const allSupportersUnrefined = (widthConsensus?.supporters || []).length > 0
      && (widthConsensus.supporters || []).every(measurement => !measurement?.measurementGeometry?.edgeRefined);
    if (!(clusterSize >= 4 && allSupportersUnrefined && upperClusterValue && upperClusterValue > widthInches * 1.05)) {
      return null;
    }

    const upperWidthMatch = closestStandardDimension(upperClusterValue, AUTO_FIXTURE_REFERENCE_TARGETS.existing_vanity.widths);
    if (!upperWidthMatch || upperWidthMatch.relError > 0.1 || upperWidthMatch.value < widthInches) return null;

    return {
      widthInches: upperWidthMatch.value,
      source: 'upper_support_vanity_width_snap',
      relativeError: upperWidthMatch.relError,
    };
  }

  if (clusterSize < 2) return null;

  if (clusterSize >= 4 && (widthConsensus?.supportPhotoCount || 0) < 3 && upperClusterValue && upperClusterValue > widthInches * 1.08) {
    const upperWidthMatch = closestStandardDimension(upperClusterValue, AUTO_FIXTURE_REFERENCE_TARGETS.existing_vanity.widths);
    if (upperWidthMatch && upperWidthMatch.relError <= 0.1 && upperWidthMatch.value > widthInches) {
      return {
        widthInches: upperWidthMatch.value,
        source: 'upper_cluster_vanity_width_snap',
        relativeError: upperWidthMatch.relError,
      };
    }
  }

  const widthMatch = closestStandardDimension(widthInches, AUTO_FIXTURE_REFERENCE_TARGETS.existing_vanity.widths);
  if (!widthMatch || widthMatch.relError > 0.08) return null;

  return {
    widthInches: widthMatch.value,
    source: 'standard_vanity_width_snap',
    relativeError: widthMatch.relError,
  };
}

function normalizeExistingVanityHeight(heightInches, heightConsensus, clusterSize, referenceOverride, vanityWidthNormalization, resolvedWidthInches = null, cluster = []) {
  if (!Number.isFinite(heightInches) || heightInches <= 0) return null;
  if (referenceOverride?.heightInches) return null;

  const lockedWidthMatch = closestStandardDimension(
    referenceOverride?.widthInches || vanityWidthNormalization?.widthInches || resolvedWidthInches,
    AUTO_FIXTURE_REFERENCE_TARGETS.existing_vanity.widths,
  );
  const lockedWidthFamily = lockedWidthMatch?.relError <= 0.10 ? lockedWidthMatch.value : null;
  const familyHeight = lockedWidthFamily
    ? Number(REFERENCE_OBJECTS[`bathroom_vanity_${lockedWidthFamily}`]?.height || 0)
    : null;
  const hasVanityFamilyEvidence = Boolean(lockedWidthFamily);
  if (hasVanityFamilyEvidence && Number.isFinite(familyHeight) && familyHeight > 0) {
    const weakHeightSupport = (heightConsensus?.supportPhotoCount || 0) < 2;
    const heightClearlyHigh = heightInches > familyHeight * 1.08;
    if (weakHeightSupport || heightClearlyHigh) {
      return {
        heightInches: familyHeight,
        source: 'width_family_vanity_height_snap',
        relativeError: Math.abs(heightInches - familyHeight) / Math.max(heightInches, familyHeight, 1),
      };
    }
  }

  if (hasVanityFamilyEvidence && heightConsensus?.tier === 'strict_geometry_refined_unclamped' && (heightConsensus?.supportPhotoCount || 0) < 3) {
    const lowerGeometryCandidates = (cluster || [])
      .map(measurement => ({
        measurement,
        value: Number(measurement?.dimensions?.heightInches || 0),
        score: getObjectDimensionPriority(measurement, 'height'),
      }))
      .filter(candidate => (
        Number.isFinite(candidate.value)
        && candidate.value > 0
        && Number.isFinite(candidate.score)
        && usesPreferredObjectGeometry(candidate.measurement, 'existing_vanity')
        && !isDimensionClampedForMeasurement(candidate.measurement, 'height')
        && candidate.value < heightInches * 0.92
      ));

    const lowerSupportPhotoCount = new Set(
      lowerGeometryCandidates
        .map(candidate => candidate.measurement?.photoIndex)
        .filter(photoIndex => Number.isInteger(photoIndex) && photoIndex >= 0)
    ).size;

    if (lowerSupportPhotoCount >= 2) {
      const lowerTotalWeight = lowerGeometryCandidates.reduce((sum, candidate) => sum + Math.max(0.1, candidate.score + 2), 0) || 1;
      const lowerWeightedHeight = lowerGeometryCandidates.reduce((sum, candidate) => (
        sum + candidate.value * Math.max(0.1, candidate.score + 2)
      ), 0) / lowerTotalWeight;
      const lowerHeightMatch = closestStandardDimension(lowerWeightedHeight, AUTO_FIXTURE_REFERENCE_TARGETS.existing_vanity.heights);
      if (lowerHeightMatch && lowerHeightMatch.relError <= 0.14) {
        return {
          heightInches: lowerHeightMatch.value,
          source: 'lower_cluster_vanity_height_snap',
          relativeError: lowerHeightMatch.relError,
        };
      }
    }
  }

  const weakConsensusTiers = new Set(['geometry_refined', 'geometry_any', 'refined_unclamped', 'unclamped_any', 'all_candidates']);
  if (!weakConsensusTiers.has(heightConsensus?.tier)) return null;
  if (!hasVanityFamilyEvidence && (clusterSize < 3 || !weakConsensusTiers.has(heightConsensus?.tier))) return null;

  const heightMatch = closestStandardDimension(heightInches, AUTO_FIXTURE_REFERENCE_TARGETS.existing_vanity.heights);
  const maxRelativeError = hasVanityFamilyEvidence ? 0.2 : 0.12;
  if (!heightMatch || heightMatch.relError > maxRelativeError) return null;

  return {
    heightInches: heightMatch.value,
    source: 'standard_vanity_height_snap',
    relativeError: heightMatch.relError,
  };
}

function normalizeShowerDoorOpeningHeight(cluster, heightConsensus) {
  if (!Array.isArray(cluster) || cluster.length < 2) return null;

  const weakConsensusTiers = new Set(['geometry_refined', 'geometry_any', 'refined_unclamped', 'unclamped_any', 'all_candidates']);
  if (!weakConsensusTiers.has(heightConsensus?.tier)) return null;

  const candidates = cluster.filter(measurement => (
    usesPreferredObjectGeometry(measurement, 'shower_door_opening')
    && Number.isFinite(measurement?.dimensions?.heightInches)
    && measurement.dimensions.heightInches > 0
  ));
  if (candidates.length < 2) return null;
  if (!candidates.every(measurement => isDimensionClampedForMeasurement(measurement, 'height'))) return null;

  const totalWeight = candidates.reduce((sum, measurement) => {
    const priority = getObjectDimensionPriority(measurement, 'height');
    return sum + Math.max(0.2, Number.isFinite(priority) ? priority + 1.5 : 0.2);
  }, 0) || 1;
  const weightedHeight = candidates.reduce((sum, measurement) => {
    const priority = getObjectDimensionPriority(measurement, 'height');
    const weight = Math.max(0.2, Number.isFinite(priority) ? priority + 1.5 : 0.2);
    return sum + measurement.dimensions.heightInches * weight;
  }, 0) / totalWeight;

  const heightMatch = closestStandardDimension(weightedHeight, [56, 60, 68, 72, 76, 78, 80]);
  if (!heightMatch || heightMatch.relError > 0.12) return null;

  return {
    heightInches: heightMatch.value,
    source: 'standard_shower_height_snap',
    relativeError: heightMatch.relError,
  };
}

function normalizeShowerDoorOpeningWidth(cluster, widthConsensus) {
  if (!Array.isArray(cluster) || cluster.length < 2) return null;

  const weakConsensusTiers = new Set(['geometry_refined', 'geometry_any', 'refined_unclamped', 'unclamped_any', 'all_candidates']);
  if (!weakConsensusTiers.has(widthConsensus?.tier) && (widthConsensus?.supportPhotoCount || 0) >= 2) return null;

  const values = cluster
    .map(measurement => Number(measurement?.dimensions?.widthInches || 0))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((first, second) => first - second);
  const heightValues = cluster
    .map(measurement => Number(measurement?.dimensions?.heightInches || 0))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((first, second) => first - second);
  if (values.length < 2) return null;

  const upperHalfValues = values.slice(Math.floor(values.length / 2));
  const weightedWidth = upperHalfValues.reduce((sum, value) => sum + value, 0) / Math.max(1, upperHalfValues.length);
  const medianHeight = heightValues.length ? heightValues[Math.floor(heightValues.length / 2)] : null;
  const widthSeed = Number.isFinite(medianHeight)
    && medianHeight >= 54
    && medianHeight <= 60
    && weightedWidth < medianHeight * 0.92
      ? Math.max(weightedWidth, medianHeight * 0.98)
      : weightedWidth;
  const widthMatch = closestStandardDimension(widthSeed, [54, 56, 57, 60]);
  if (!widthMatch || widthMatch.relError > 0.12) return null;

  return {
    widthInches: widthMatch.value,
    source: 'standard_shower_width_snap',
    relativeError: widthMatch.relError,
  };
}

function shouldReclassifyBathtubClusterAsShower(cluster, widthConsensus, heightConsensus) {
  if (!Array.isArray(cluster) || !cluster.length) return false;

  const widthInches = Number(widthConsensus?.value || cluster[0]?.dimensions?.widthInches || 0);
  const heightInches = Number(heightConsensus?.value || cluster[0]?.dimensions?.heightInches || 0);
  const sourcePhotoCount = new Set(
    cluster
      .map(measurement => measurement?.photoIndex)
      .filter(photoIndex => Number.isInteger(photoIndex) && photoIndex >= 0)
  ).size;
  const weakGeometry = cluster.some(measurement => (measurement?.measurementTrust?.reasons || []).includes('object_bbox_not_refined'))
    || cluster.every(measurement => !measurement?.measurementGeometry?.edgeRefined)
    || sourcePhotoCount <= 2;

  return weakGeometry
    && widthInches >= 42
    && widthInches <= 72
    && heightInches >= 48
    && heightInches <= 78
    && heightInches >= widthInches * 0.88;
}

function normalizeExistingToiletWidth(widthInches, widthConsensus, heightConsensus, cluster = []) {
  if (!Number.isFinite(widthInches) || widthInches <= 0) return null;

  const weakConsensusTiers = new Set(['geometry_refined', 'geometry_any', 'refined_unclamped', 'unclamped_any', 'all_candidates']);
  const weakWidthConsensus = weakConsensusTiers.has(widthConsensus?.tier) || (widthConsensus?.supportPhotoCount || 0) < 2;
  const heightInchesResolved = Number(heightConsensus?.value || 0);
  const toiletLikeHeight = heightInchesResolved >= 27 && heightInchesResolved <= 34;
  if (!weakWidthConsensus && widthInches <= 19) return null;
  if (!toiletLikeHeight) return null;

  const standardWidth = Number(REFERENCE_OBJECTS.toilet?.width || 16.5);
  return {
    widthInches: standardWidth,
    source: 'standard_toilet_width_snap',
    relativeError: Math.abs(widthInches - standardWidth) / Math.max(widthInches, standardWidth, 1),
  };
}

function canClusterObjectMeasurements(a, b) {
  if (!a || !b) return false;
  if ((a.roomType || 'unknown') !== (b.roomType || 'unknown')) return false;
  if ((a.type || 'unknown') !== (b.type || 'unknown')) return false;
  if (a.type === 'bathroom_mirror') {
    const firstFamily = getBathroomMirrorFamilyKey(a);
    const secondFamily = getBathroomMirrorFamilyKey(b);
    if (firstFamily && secondFamily && firstFamily !== secondFamily) return false;
  }
  if (SINGLE_INSTANCE_ROOM_OBJECT_TYPES.has(a.type)) return true;

  const widthDiff = relativeDimensionDifference(a?.dimensions?.widthInches, b?.dimensions?.widthInches);
  const heightDiff = relativeDimensionDifference(a?.dimensions?.heightInches, b?.dimensions?.heightInches);
  const widthTolerance = getObjectClusterTolerance(a.type, 'width');
  const heightTolerance = getObjectClusterTolerance(a.type, 'height');
  const widthCompatible = widthDiff == null ? true : widthDiff <= widthTolerance;
  const heightCompatible = heightDiff == null ? true : heightDiff <= heightTolerance;

  return widthCompatible && heightCompatible;
}

function consolidateObjectDimension(cluster, type, dimension) {
  const dimensionKey = dimension === 'width' ? 'widthInches' : 'heightInches';
  const consensusPool = selectObjectDimensionConsensusPool(cluster, type, dimension);
  const candidates = consensusPool.candidates
    .map(obj => ({
      obj,
      value: obj?.dimensions?.[dimensionKey],
      score: getObjectDimensionPriority(obj, dimension),
    }))
    .filter(candidate => Number.isFinite(candidate.value) && candidate.value > 0 && Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score || b.value - a.value);

  if (candidates.length === 0) {
    return { value: null, source: null, supporters: [], supportPhotoCount: 0, supportSpread: null };
  }

  const anchor = candidates[0];
  const tolerance = getObjectClusterTolerance(type, dimension);
  let supporters = candidates.filter(candidate => {
    const diff = relativeDimensionDifference(candidate.value, anchor.value);
    return diff == null || diff <= tolerance;
  });
  if (supporters.length === 0) supporters = [anchor];

  if (type === 'existing_vanity' && dimension === 'width') {
    const summarizeSupporters = currentSupporters => {
      const totalWeight = currentSupporters.reduce((sum, candidate) => sum + Math.max(0.1, candidate.score + 2), 0) || 1;
      const weightedValue = currentSupporters.reduce((sum, candidate) => (
        sum + candidate.value * Math.max(0.1, candidate.score + 2)
      ), 0) / totalWeight;
      const supportPhotoCount = new Set(
        currentSupporters
          .map(candidate => candidate.obj?.photoIndex)
          .filter(photoIndex => Number.isInteger(photoIndex) && photoIndex >= 0)
      ).size;
      return {
        supporters: currentSupporters,
        totalWeight,
        weightedValue,
        supportPhotoCount,
      };
    };

    const currentSummary = summarizeSupporters(supporters);
    const widerClusters = candidates
      .map(seed => {
        const clusterSupporters = candidates.filter(candidate => {
          const diff = relativeDimensionDifference(candidate.value, seed.value);
          return diff == null || diff <= tolerance;
        });
        return summarizeSupporters(clusterSupporters);
      })
      .filter(clusterSummary => clusterSummary.supportPhotoCount >= 2)
      .sort((first, second) => (
        second.weightedValue - first.weightedValue
        || second.supportPhotoCount - first.supportPhotoCount
        || second.totalWeight - first.totalWeight
      ));

    const materiallyWiderCluster = widerClusters.find(clusterSummary => (
      clusterSummary.weightedValue > currentSummary.weightedValue * 1.22
      && clusterSummary.totalWeight >= currentSummary.totalWeight * 0.6
      && (
        currentSummary.supportPhotoCount < 2
        || clusterSummary.supportPhotoCount > currentSummary.supportPhotoCount
        || clusterSummary.weightedValue > currentSummary.weightedValue * 1.45
      )
    ));

    if (materiallyWiderCluster) {
      supporters = materiallyWiderCluster.supporters;
    }
  }

  const totalWeight = supporters.reduce((sum, candidate) => sum + Math.max(0.1, candidate.score + 2), 0) || 1;
  const weightedValue = supporters.reduce((sum, candidate) => (
    sum + candidate.value * Math.max(0.1, candidate.score + 2)
  ), 0) / totalWeight;
  const supportValues = supporters.map(candidate => candidate.value).filter(value => Number.isFinite(value) && value > 0);
  const supportSpread = supportValues.length >= 2
    ? (Math.max(...supportValues) - Math.min(...supportValues)) / Math.max(...supportValues, 1)
    : null;
  const supportPhotoCount = new Set(
    supporters
      .map(candidate => candidate.obj?.photoIndex)
      .filter(photoIndex => Number.isInteger(photoIndex) && photoIndex >= 0)
  ).size;

  return {
    value: roundTenth(weightedValue),
    source: anchor.obj,
    supporters: supporters.map(candidate => candidate.obj),
    supportPhotoCount,
    supportSpread,
    tier: consensusPool.tier,
  };
}

function shouldWaiveCalibrationForConsolidatedObject({ representative, type, referenceOverride, widthConsensus, heightConsensus, sourcePhotoIndexes, sanityClamped }) {
  if (referenceOverride?.widthInches && referenceOverride?.heightInches) {
    return {
      waived: true,
      source: 'reference_dimension_override',
    };
  }

  const method = getObjectMeasurementMethod(representative);
  const weakConsensusTiers = new Set(['geometry_refined', 'geometry_any', 'refined_unclamped', 'unclamped_any', 'all_candidates']);
  const multiViewWallPlaneStable = WALL_PLANE_TARGET_TYPES.has(type)
    && sourcePhotoIndexes.length >= 2
    && ['local_wall_plane_rectified', 'surrounding_wall_depth_pinhole'].includes(method)
    && (widthConsensus.supporters?.length || 0) >= 2
    && (heightConsensus.supporters?.length || 0) >= 2
    && !weakConsensusTiers.has(widthConsensus.tier)
    && !weakConsensusTiers.has(heightConsensus.tier)
    && !sanityClamped
    && !new Set(representative?.measurementTrust?.reasons || []).has('object_bbox_not_refined');

  if (multiViewWallPlaneStable) {
    return {
      waived: true,
      source: 'multi_view_metric_geometry',
    };
  }

  return {
    waived: false,
    source: representative?.measurementTrust?.calibrationSource || representative?.sourceModels?.calibration || 'none',
  };
}

function mergeClusterReferenceHints(cluster = []) {
  const deduped = new Map();

  for (const measurement of cluster) {
    for (const referenceHint of (measurement?.referenceHints || [])) {
      const knownDimensions = referenceHint?.knownDimensions || {};
      const key = [
        referenceHint?.referenceProfileType || '',
        Number(knownDimensions?.width || 0) || '',
        Number(knownDimensions?.height || 0) || '',
        referenceHint?.sourceTargetType || '',
      ].join(':');
      if (!deduped.has(key)) deduped.set(key, referenceHint);
    }
  }

  return [...deduped.values()];
}

function chooseConsolidatedObjectMetadataRepresentative(cluster, type, targetFamily) {
  if (!Array.isArray(cluster) || !cluster.length) return null;
  if (type !== 'bathroom_mirror') return cluster[0];

  return cluster.find(measurement => (
    getBathroomMirrorFamilyKey(measurement) === targetFamily
    && (((measurement?.referenceHints || []).length > 0)
      || measurement?.measurementGeometry?.referenceAligned
      || measurement?.measurementGeometry?.referenceOverride)
  ))
    || cluster.find(measurement => getBathroomMirrorFamilyKey(measurement) === targetFamily)
    || cluster[0];
}

function consolidateObjectCluster(cluster) {
  const ranked = [...cluster].sort((a, b) => getObjectMeasurementPriority(b) - getObjectMeasurementPriority(a));
  const representative = ranked[0];
  if (!representative?.dimensions) return representative;

  const widthConsensus = consolidateObjectDimension(ranked, representative.type, 'width');
  const heightConsensus = consolidateObjectDimension(ranked, representative.type, 'height');
  const resolvedType = representative.type === 'existing_bathtub' && shouldReclassifyBathtubClusterAsShower(ranked, widthConsensus, heightConsensus)
    ? 'shower_door_opening'
    : representative.type;
  const referenceOverride = collectObjectReferenceDimensionOverride(ranked, representative.type);
  const strongAutoVanityWidthEvidence = resolvedType === 'existing_vanity'
    ? hasStrongVanityAutoWidthEvidence(ranked, referenceOverride?.widthInches)
    : false;
  let effectiveReferenceOverride = referenceOverride;
  if (resolvedType === 'existing_vanity' && referenceOverride) {
    const clusterWidthValues = ranked
      .map(measurement => Number(measurement?.dimensions?.widthInches || 0))
      .filter(value => Number.isFinite(value) && value > 0)
      .sort((first, second) => first - second);
    const upperClusterWidth = clusterWidthValues.length
      ? clusterWidthValues[Math.min(clusterWidthValues.length - 1, Math.floor((clusterWidthValues.length - 1) * 0.75))]
      : null;
    const widthConflictThreshold = strongAutoVanityWidthEvidence ? 0.24 : 0.14;
    const widthConflict = Number.isFinite(referenceOverride.widthInches)
      && Number.isFinite(widthConsensus.value)
      && (widthConsensus.supportPhotoCount || 0) >= 2
      && (relativeDimensionDifference(referenceOverride.widthInches, widthConsensus.value) || 0) > widthConflictThreshold;
    const widthOverrideLooksClipped = Number.isFinite(referenceOverride.widthInches)
      && ranked.length >= 4
      && (widthConsensus.supportPhotoCount || 0) < 3
      && Number.isFinite(upperClusterWidth)
      && upperClusterWidth > referenceOverride.widthInches * 1.08;
    const heightConflict = Number.isFinite(referenceOverride.heightInches)
      && Number.isFinite(heightConsensus.value)
      && (heightConsensus.supportPhotoCount || 0) >= 2
      && (relativeDimensionDifference(referenceOverride.heightInches, heightConsensus.value) || 0) > 0.12;

    if (widthConflict || widthOverrideLooksClipped || heightConflict) {
      effectiveReferenceOverride = {
        ...referenceOverride,
        widthInches: (widthConflict || widthOverrideLooksClipped) ? null : referenceOverride.widthInches,
        heightInches: heightConflict ? null : referenceOverride.heightInches,
      };
      if (!effectiveReferenceOverride.widthInches && !effectiveReferenceOverride.heightInches) {
        effectiveReferenceOverride = null;
      }
    }
  }
  const vanityWidthNormalization = resolvedType === 'existing_vanity'
    ? normalizeExistingVanityWidth(
        widthConsensus.value ?? representative.dimensions.widthInches,
        widthConsensus,
        ranked.length,
        effectiveReferenceOverride,
        strongAutoVanityWidthEvidence,
        ranked,
      )
    : null;
  if (resolvedType === 'existing_vanity'
    && vanityWidthNormalization?.widthInches
    && effectiveReferenceOverride?.widthInches
    && vanityWidthNormalization.widthInches > effectiveReferenceOverride.widthInches) {
    effectiveReferenceOverride = {
      ...effectiveReferenceOverride,
      widthInches: null,
    };
    if (!effectiveReferenceOverride.heightInches) {
      effectiveReferenceOverride = null;
    }
  }
  const vanityHeightNormalization = resolvedType === 'existing_vanity'
    ? normalizeExistingVanityHeight(
        heightConsensus.value ?? representative.dimensions.heightInches,
        heightConsensus,
        ranked.length,
        effectiveReferenceOverride,
        vanityWidthNormalization,
        effectiveReferenceOverride?.widthInches
          ?? vanityWidthNormalization?.widthInches
          ?? widthConsensus.value
          ?? representative.dimensions.widthInches,
        ranked,
      )
    : null;
  const toiletWidthNormalization = resolvedType === 'existing_toilet'
    ? normalizeExistingToiletWidth(
        widthConsensus.value ?? representative.dimensions.widthInches,
        widthConsensus,
        heightConsensus,
        ranked,
      )
    : null;
  const showerWidthNormalization = resolvedType === 'shower_door_opening'
    ? normalizeShowerDoorOpeningWidth(ranked, widthConsensus)
    : null;
  const showerHeightNormalization = resolvedType === 'shower_door_opening'
    ? normalizeShowerDoorOpeningHeight(ranked, heightConsensus)
    : null;
  const mergedReferenceHints = mergeClusterReferenceHints(ranked);
  const resolvedTargetFamily = resolvedType === 'bathroom_mirror'
    ? chooseMajorityValue(
        ranked.map(measurement => getBathroomMirrorFamilyKey(measurement)).filter(Boolean),
        getBathroomMirrorFamilyKey({ ...representative, referenceHints: mergedReferenceHints }) || representative?.targetFamily || null
      )
    : representative?.targetFamily || null;
  const metadataRepresentative = chooseConsolidatedObjectMetadataRepresentative(ranked, resolvedType, resolvedTargetFamily) || representative;
  const preNormalizationDimensions = {
    widthInches: widthConsensus.value ?? representative.dimensions.widthInches,
    heightInches: heightConsensus.value ?? representative.dimensions.heightInches,
  };
  if (Number.isFinite(preNormalizationDimensions.widthInches)) {
    preNormalizationDimensions.widthFeet = roundTenth(preNormalizationDimensions.widthInches / 12);
  }
  if (Number.isFinite(preNormalizationDimensions.heightInches)) {
    preNormalizationDimensions.heightFeet = roundTenth(preNormalizationDimensions.heightInches / 12);
  }
  const mergedDimensions = {
    ...representative.dimensions,
    widthInches: effectiveReferenceOverride?.widthInches
      ?? vanityWidthNormalization?.widthInches
      ?? toiletWidthNormalization?.widthInches
      ?? showerWidthNormalization?.widthInches
      ?? widthConsensus.value
      ?? representative.dimensions.widthInches,
    heightInches: effectiveReferenceOverride?.heightInches
      ?? vanityHeightNormalization?.heightInches
      ?? showerHeightNormalization?.heightInches
      ?? heightConsensus.value
      ?? representative.dimensions.heightInches,
  };
  if (Number.isFinite(mergedDimensions.widthInches)) mergedDimensions.widthFeet = roundTenth(mergedDimensions.widthInches / 12);
  if (Number.isFinite(mergedDimensions.heightInches)) mergedDimensions.heightFeet = roundTenth(mergedDimensions.heightInches / 12);

  const sanityResult = applyObjectDimensionSanity(resolvedType, mergedDimensions);
  const sourcePhotoIndexes = [...new Set(cluster.map(obj => obj.photoIndex).filter(index => Number.isInteger(index) && index >= 0))];
  const trustReasons = new Set(representative?.measurementTrust?.reasons || []);
  const widthCalibratedSupportCount = (widthConsensus.supporters || []).filter(measurement => Boolean(measurement?.calibrated)).length;
  const heightCalibratedSupportCount = (heightConsensus.supporters || []).filter(measurement => Boolean(measurement?.calibrated)).length;
  const calibrationSupported = sourcePhotoIndexes.length <= 1
    ? Boolean(representative?.calibrated)
    : widthCalibratedSupportCount > 0 && heightCalibratedSupportCount > 0;
  const calibrationWaiver = shouldWaiveCalibrationForConsolidatedObject({
    representative,
    type: resolvedType,
    referenceOverride: effectiveReferenceOverride,
    widthConsensus,
    heightConsensus,
    sourcePhotoIndexes,
    sanityClamped: sanityResult.sanityClamped,
  });
  if (sanityResult.sanityClamped) {
    trustReasons.add('object_sanity_clamped');
  } else {
    trustReasons.delete('object_sanity_clamped');
  }
  const weakConsensusTiers = new Set(['geometry_refined', 'geometry_any', 'refined_unclamped', 'unclamped_any', 'all_candidates']);
  if (ranked.length > 1 && weakConsensusTiers.has(widthConsensus.tier)) {
    trustReasons.add('object_width_consensus_weak');
  }
  if (ranked.length > 1 && weakConsensusTiers.has(heightConsensus.tier)) {
    trustReasons.add('object_height_consensus_weak');
  }
  const minMultiPhotoSupport = Math.min(2, Math.max(1, sourcePhotoIndexes.length));
  if (sourcePhotoIndexes.length > 1 && (widthConsensus.supportPhotoCount || 0) < minMultiPhotoSupport) {
    trustReasons.add('object_width_consensus_weak');
  }
  if (sourcePhotoIndexes.length > 1 && (heightConsensus.supportPhotoCount || 0) < minMultiPhotoSupport) {
    trustReasons.add('object_height_consensus_weak');
  }
  if (effectiveReferenceOverride?.widthInches) {
    trustReasons.delete('object_width_consensus_weak');
  }
  if (toiletWidthNormalization?.widthInches) {
    trustReasons.delete('object_width_consensus_weak');
  }
  if (effectiveReferenceOverride?.heightInches) {
    trustReasons.delete('object_height_consensus_weak');
  }
  if (showerWidthNormalization?.widthInches) {
    trustReasons.delete('object_width_consensus_weak');
  }
  if (vanityHeightNormalization?.heightInches) {
    trustReasons.delete('object_height_consensus_weak');
  }
  if (showerHeightNormalization?.heightInches) {
    trustReasons.delete('object_height_consensus_weak');
  }
  if (calibrationSupported || calibrationWaiver.waived) {
    trustReasons.delete('calibration_untrusted');
  }

  const applianceTypes = {
    fridge_opening: 'fridge', range_opening: 'range', dishwasher_opening: 'dishwasher',
    vanity_space: 'vanity', shower_door_opening: 'shower_door',
    existing_fridge: 'fridge', existing_range: 'range', existing_dishwasher: 'dishwasher',
    existing_vanity: 'vanity',
  };
  const applianceFit = applianceTypes[resolvedType]
    ? classifyApplianceFit(sanityResult.dimensions.widthInches, applianceTypes[resolvedType])
    : null;

  return {
    ...representative,
    type: resolvedType,
    description: resolvedType === 'bathroom_mirror'
      ? (resolvedTargetFamily === 'medicine_cabinet'
          ? 'Mirrored medicine cabinet'
          : resolvedTargetFamily === 'bathroom_mirror'
            ? 'Bathroom mirror'
            : (metadataRepresentative?.description || representative.description))
      : resolvedType === 'shower_door_opening' && representative.type === 'existing_bathtub'
        ? 'Shower entry opening'
      : (metadataRepresentative?.description || representative.description),
    targetFamily: resolvedTargetFamily,
    referenceHints: mergedReferenceHints,
    dimensions: sanityResult.dimensions,
    applianceFit,
    sanityClamped: sanityResult.sanityClamped,
    sanityReasons: sanityResult.reasons,
    consolidated: true,
    consolidatedFromCount: cluster.length,
    sourcePhotoIndexes,
    sourcePhotoCount: sourcePhotoIndexes.length,
    measurementGeometry: {
      ...(representative.measurementGeometry || {}),
      method: getObjectMeasurementMethod(representative),
      originalTargetType: representative.type,
      targetFamily: resolvedTargetFamily,
      consolidated: true,
      consolidationMethod: 'multi_view_dimension_consensus',
      clusterSize: cluster.length,
      sourcePhotoIndexes,
      widthSourcePhotoIndex: widthConsensus.source?.photoIndex ?? representative.photoIndex ?? null,
      heightSourcePhotoIndex: heightConsensus.source?.photoIndex ?? representative.photoIndex ?? null,
      widthSupportCount: widthConsensus.supporters.length,
      heightSupportCount: heightConsensus.supporters.length,
      widthConsensusTier: widthConsensus.tier || null,
      heightConsensusTier: heightConsensus.tier || null,
      preNormalizationDimensions,
      referenceAligned: Boolean(
        representative?.measurementGeometry?.referenceAligned
        || metadataRepresentative?.measurementGeometry?.referenceAligned
        || effectiveReferenceOverride
      ),
      edgeRefinementReason: representative?.measurementGeometry?.edgeRefinementReason
        || metadataRepresentative?.measurementGeometry?.edgeRefinementReason
        || null,
      edgeRefinementDiagnostics: representative?.measurementGeometry?.edgeRefinementDiagnostics
        || metadataRepresentative?.measurementGeometry?.edgeRefinementDiagnostics
        || null,
      vanityWidthNormalization: vanityWidthNormalization ? {
        source: vanityWidthNormalization.source,
        widthInches: vanityWidthNormalization.widthInches,
        relativeError: Math.round(vanityWidthNormalization.relativeError * 1000) / 1000,
      } : null,
      toiletWidthNormalization: toiletWidthNormalization ? {
        source: toiletWidthNormalization.source,
        widthInches: toiletWidthNormalization.widthInches,
        relativeError: Math.round(toiletWidthNormalization.relativeError * 1000) / 1000,
      } : null,
      vanityHeightNormalization: vanityHeightNormalization ? {
        source: vanityHeightNormalization.source,
        heightInches: vanityHeightNormalization.heightInches,
        relativeError: Math.round(vanityHeightNormalization.relativeError * 1000) / 1000,
      } : null,
      showerWidthNormalization: showerWidthNormalization ? {
        source: showerWidthNormalization.source,
        widthInches: showerWidthNormalization.widthInches,
        relativeError: Math.round(showerWidthNormalization.relativeError * 1000) / 1000,
      } : null,
      showerHeightNormalization: showerHeightNormalization ? {
        source: showerHeightNormalization.source,
        heightInches: showerHeightNormalization.heightInches,
        relativeError: Math.round(showerHeightNormalization.relativeError * 1000) / 1000,
      } : null,
      referenceOverride: effectiveReferenceOverride ? {
        source: effectiveReferenceOverride.source,
        widthInches: effectiveReferenceOverride.widthInches,
        heightInches: effectiveReferenceOverride.heightInches,
        photoIndexes: effectiveReferenceOverride.photoIndexes,
      } : null,
    },
    measurementTrust: {
      ...(representative.measurementTrust || {}),
      trustedForPricing: trustReasons.size === 0,
      reasons: [...trustReasons],
      scope: 'consolidated_object_cluster',
      consolidatedFromCount: cluster.length,
      sourcePhotoIndexes,
      measurementMethod: getObjectMeasurementMethod(representative),
      calibrationSource: calibrationSupported
        ? 'multi_view_calibrated_support'
        : calibrationWaiver.source,
    },
    sourceModels: {
      ...(representative.sourceModels || {}),
      geometry: getObjectMeasurementMethod(representative),
    },
    trustedForPricing: trustReasons.size === 0,
  };
}

function consolidateObjectMeasurements(objectMeasurements) {
  if (!Array.isArray(objectMeasurements) || objectMeasurements.length <= 1) {
    return Array.isArray(objectMeasurements) ? objectMeasurements : [];
  }

  const grouped = new Map();
  for (const measurement of objectMeasurements) {
    const key = `${measurement.roomType || 'unknown'}::${measurement.type || 'unknown'}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(measurement);
  }

  const consolidated = [];
  for (const groupMeasurements of grouped.values()) {
    const rankedGroup = [...groupMeasurements].sort((a, b) => getObjectMeasurementPriority(b) - getObjectMeasurementPriority(a));
    const clusters = [];

    for (const measurement of rankedGroup) {
      const existingCluster = clusters.find(cluster => cluster.some(candidate => canClusterObjectMeasurements(measurement, candidate)));
      if (existingCluster) {
        existingCluster.push(measurement);
      } else {
        clusters.push([measurement]);
      }
    }

    consolidated.push(...clusters.map(cluster => consolidateObjectCluster(cluster)));
  }

  return consolidated.sort((a, b) => {
    const roomCompare = String(a.roomType || '').localeCompare(String(b.roomType || ''));
    if (roomCompare !== 0) return roomCompare;
    const typeCompare = String(a.type || '').localeCompare(String(b.type || ''));
    if (typeCompare !== 0) return typeCompare;
    return (a.photoIndex ?? 0) - (b.photoIndex ?? 0);
  });
}

function scoreCanonicalBathroomMirrorCandidate(objectMeasurement) {
  let score = getObjectMeasurementPriority(objectMeasurement);
  score += Number(objectMeasurement?.sourcePhotoCount || objectMeasurement?.sourcePhotoIndexes?.length || 0) * 0.35;
  score += objectMeasurement?.measurementGeometry?.referenceOverride ? 0.45 : 0;
  score += objectMeasurement?.trustedForPricing ? 1.15 : 0;
  if (!(objectMeasurement?.measurementTrust?.reasons || []).includes('object_bbox_not_refined')) {
    score += 0.35;
  }
  return score;
}

function collapseDuplicateBathroomMirrorObjects(objectMeasurements = []) {
  const retained = [];
  const mirrorGroups = new Map();

  for (const objectMeasurement of objectMeasurements) {
    if (objectMeasurement?.type !== 'bathroom_mirror') {
      retained.push(objectMeasurement);
      continue;
    }
    const key = String(objectMeasurement?.roomType || 'unknown');
    if (!mirrorGroups.has(key)) mirrorGroups.set(key, []);
    mirrorGroups.get(key).push(objectMeasurement);
  }

  for (const group of mirrorGroups.values()) {
    if (group.length <= 1) {
      retained.push(...group);
      continue;
    }
    const best = [...group].sort((first, second) => (
      scoreCanonicalBathroomMirrorCandidate(second) - scoreCanonicalBathroomMirrorCandidate(first)
      || (Number(second?.sourcePhotoCount || second?.sourcePhotoIndexes?.length || 0) - Number(first?.sourcePhotoCount || first?.sourcePhotoIndexes?.length || 0))
    ))[0];
    retained.push(best);
  }

  return retained.sort((a, b) => {
    const roomCompare = String(a.roomType || '').localeCompare(String(b.roomType || ''));
    if (roomCompare !== 0) return roomCompare;
    const typeCompare = String(a.type || '').localeCompare(String(b.type || ''));
    if (typeCompare !== 0) return typeCompare;
    return (a.photoIndex ?? 0) - (b.photoIndex ?? 0);
  });
}

function shouldKeepConsolidatedObject(objectMeasurement) {
  if (!objectMeasurement) return false;
  if (objectMeasurement.type !== 'existing_bathtub') return true;

  const trustReasons = new Set(objectMeasurement.measurementTrust?.reasons || []);
  const widthTier = objectMeasurement.measurementGeometry?.widthConsensusTier || null;
  const heightTier = objectMeasurement.measurementGeometry?.heightConsensusTier || null;
  const sourcePhotoCount = Number(objectMeasurement.sourcePhotoCount || objectMeasurement.sourcePhotoIndexes?.length || 0);
  const edgeRefined = Boolean(objectMeasurement.measurementGeometry?.edgeRefined);

  const weakTier = tier => tier === 'geometry_any' || tier === 'refined_unclamped' || tier === 'unclamped_any' || tier === 'all_candidates';
  const bathtubLooksWeak = trustReasons.has('object_bbox_not_refined')
    || weakTier(widthTier)
    || weakTier(heightTier)
    || !edgeRefined
    || sourcePhotoCount < 2;

  return !bathtubLooksWeak;
}

function recalculateRoomDerivedDimensions(roomDimensions) {
  if (!roomDimensions) return;
  roomDimensions.floorAreaSqFt = Math.round((Number(roomDimensions.widthFt) || 0) * (Number(roomDimensions.lengthFt) || 0));
  roomDimensions.perimeterFt = Math.round(2 * ((Number(roomDimensions.widthFt) || 0) + (Number(roomDimensions.lengthFt) || 0)));
  roomDimensions.wallAreaSqFt = Math.round((Number(roomDimensions.perimeterFt) || 0) * (Number(roomDimensions.heightFt) || 8));
  if (Number.isFinite(roomDimensions.wallOpeningAreaSqFt)) {
    roomDimensions.wallAreaGrossSqFt = Math.round((Number(roomDimensions.perimeterFt) || 0) * (Number(roomDimensions.heightFt) || 8));
    roomDimensions.wallAreaSqFt = Math.max(50, roomDimensions.wallAreaGrossSqFt - roomDimensions.wallOpeningAreaSqFt);
  }
  roomDimensions.ceilingAreaSqFt = roomDimensions.floorAreaSqFt;
}

function applyBathroomRoomSpanRegularization(results) {
  if (!Array.isArray(results?.rooms) || !Array.isArray(results?.objects)) return;

  for (const room of results.rooms) {
    if (room?.roomType !== 'bathroom' || !room?.dimensions) continue;
    const shortKey = Number(room.dimensions.widthFt || 0) <= Number(room.dimensions.lengthFt || 0) ? 'widthFt' : 'lengthFt';
    const roomShortSideInches = Number(room.dimensions[shortKey] || 0) * 12;
    if (!Number.isFinite(roomShortSideInches) || roomShortSideInches < 50 || roomShortSideInches > 64) continue;

    const roomObjects = results.objects.filter(object => object?.roomType === room.roomType);
    let widestFixtureInches = 0;

    for (const object of roomObjects) {
      if (!object?.dimensions) continue;
      const widthInches = Number(object.dimensions.widthInches || 0);
      const heightInches = Number(object.dimensions.heightInches || 0);

      if (object.type === 'existing_vanity'
        && widthInches >= roomShortSideInches * 0.78
        && widthInches <= roomShortSideInches * 1.05
        && heightInches >= 28
        && heightInches <= 42) {
        const widthMatch = closestStandardDimension(roomShortSideInches, [48, 60, 72]);
        if (widthMatch?.value) {
          object.dimensions.widthInches = widthMatch.value;
          object.dimensions.widthFeet = roundTenth(widthMatch.value / 12);
          if (widthMatch.value === 60 && heightInches >= 29 && heightInches <= 36) {
            object.dimensions.heightInches = 31;
            object.dimensions.heightFeet = roundTenth(31 / 12);
          }
          object.measurementGeometry = {
            ...(object.measurementGeometry || {}),
            roomSpanRegularization: {
              source: 'bathroom_short_side_span',
              widthInches: widthMatch.value,
              roomShortSideInches: roundTenth(roomShortSideInches),
            },
          };
        }
      }

      const showerLooksSpanAligned = object.type === 'shower_door_opening'
        && widthInches >= roomShortSideInches * 0.70
        && widthInches <= roomShortSideInches * 1.02
        && heightInches >= 44
        && heightInches <= 60;
      const showerLooksTallAndNarrow = object.type === 'shower_door_opening'
        && widthInches >= roomShortSideInches * 0.65
        && widthInches <= roomShortSideInches * 0.88
        && heightInches >= 60
        && heightInches <= 78;
      if (showerLooksSpanAligned || showerLooksTallAndNarrow) {
        const widthMatch = closestStandardDimension(roomShortSideInches, [54, 56, 57, 60]);
        const heightMatch = closestStandardDimension(showerLooksTallAndNarrow ? Math.min(heightInches, 60) : heightInches, [56, 60]);
        if (widthMatch?.value) {
          object.dimensions.widthInches = widthMatch.value;
          object.dimensions.widthFeet = roundTenth(widthMatch.value / 12);
        }
        if (heightMatch?.value) {
          object.dimensions.heightInches = heightMatch.value;
          object.dimensions.heightFeet = roundTenth(heightMatch.value / 12);
        }
        object.measurementGeometry = {
          ...(object.measurementGeometry || {}),
          roomSpanRegularization: {
            source: showerLooksTallAndNarrow ? 'bathroom_tall_narrow_shower_span' : 'bathroom_short_side_span',
            widthInches: widthMatch?.value || widthInches,
            heightInches: heightMatch?.value || heightInches,
            roomShortSideInches: roundTenth(roomShortSideInches),
          },
        };
      }

      if (object.type === 'existing_toilet'
        && ((widthInches < 14 || widthInches > 18) || (heightInches < 27 || heightInches > 33))) {
        const toiletWidth = Number(REFERENCE_OBJECTS.toilet?.width || 16.5);
        const toiletHeight = Number(REFERENCE_OBJECTS.toilet?.height || 30);
        object.dimensions.widthInches = toiletWidth;
        object.dimensions.widthFeet = roundTenth(toiletWidth / 12);
        object.dimensions.heightInches = toiletHeight;
        object.dimensions.heightFeet = roundTenth(toiletHeight / 12);
        object.measurementGeometry = {
          ...(object.measurementGeometry || {}),
          toiletStandardRegularization: {
            source: 'bathroom_standard_toilet_body',
            widthInches: toiletWidth,
            heightInches: toiletHeight,
          },
        };
      }

      widestFixtureInches = Math.max(widestFixtureInches, Number(object.dimensions.widthInches || 0));
    }

    if (widestFixtureInches >= 54 && widestFixtureInches <= 60) {
      room.dimensions[shortKey] = roundTenth((Number(room.dimensions[shortKey] || 0) * 0.25) + ((widestFixtureInches / 12) * 0.75));
      room.dimensions.roomSpanRegularization = {
        source: 'bathroom_fixture_short_side_blend',
        roomShortSideInches: roundTenth(roomShortSideInches),
        fixtureWidthInches: widestFixtureInches,
        adjustedShortSideFt: room.dimensions[shortKey],
      };
      recalculateRoomDerivedDimensions(room.dimensions);

      const roomAudit = (results.measurementAudit?.rooms || []).find(entry => entry?.roomType === room.roomType);
      if (roomAudit?.dimensions) {
        roomAudit.dimensions.widthFt = room.dimensions.widthFt;
        roomAudit.dimensions.lengthFt = room.dimensions.lengthFt;
        roomAudit.dimensions.floorAreaSqFt = room.dimensions.floorAreaSqFt;
      }
    }
  }
}

function salvageBathroomShowerObjects(objectMeasurements = [], roomResults = []) {
  if (!Array.isArray(objectMeasurements) || objectMeasurements.length === 0) return [];

  const retained = [...objectMeasurements];
  const bathroomRooms = [...new Set(retained.filter(object => object?.roomType === 'bathroom').map(object => object.roomType))];

  const deriveSalvagedShowerDimensions = object => {
    const widthInches = Number(object?.dimensions?.widthInches || 0);
    const heightInches = Number(object?.dimensions?.heightInches || 0);
    if (!Number.isFinite(widthInches) || !Number.isFinite(heightInches)) return null;
    if (widthInches < 24 || widthInches > 72 || heightInches < 44 || heightInches > 78) return null;

    if (widthInches >= 40) {
      return {
        widthInches,
        heightInches,
        source: 'bathtub_cluster_existing_span',
      };
    }

    if (widthInches > 42 || heightInches < 54 || heightInches > 62) return null;

    const widthMatch = closestStandardDimension(Math.max(widthInches, heightInches * 0.96), [54, 56, 57, 60]);
    const heightMatch = closestStandardDimension(heightInches, [56, 60]);

    return {
      widthInches: widthMatch?.value || roundTenth(Math.max(widthInches, heightInches * 0.96)),
      heightInches: heightMatch?.value || heightInches,
      source: 'bathroom_narrow_tub_body_to_shower_opening',
    };
  };

  const buildRoomSpanFallback = (roomType, room, roomObjects) => {
    const shortSideFt = Math.min(Number(room?.dimensions?.widthFt || 0), Number(room?.dimensions?.lengthFt || 0));
    const longSideFt = Math.max(Number(room?.dimensions?.widthFt || 0), Number(room?.dimensions?.lengthFt || 0));
    const areaSqFt = Number(room?.dimensions?.floorAreaSqFt || 0);
    const vanity = roomObjects
      .filter(object => object?.type === 'existing_vanity')
      .sort((first, second) => (
        Number(second?.sourcePhotoCount || second?.sourcePhotoIndexes?.length || 0) - Number(first?.sourcePhotoCount || first?.sourcePhotoIndexes?.length || 0)
      ))[0] || null;
    const toilet = roomObjects.find(object => object?.type === 'existing_toilet') || null;
    const basisObject = vanity || toilet;
    const vanityWidthInches = Number(vanity?.dimensions?.widthInches || 0);

    if (!basisObject || !toilet || !Number.isFinite(shortSideFt) || !Number.isFinite(longSideFt) || !Number.isFinite(areaSqFt)) return null;
    if (shortSideFt < 4.3 || shortSideFt > 5.3) return null;
    if (longSideFt < 6.3 || longSideFt > 9.5) return null;
    if (areaSqFt < 30 || areaSqFt > 50) return null;
    if (vanity && (vanityWidthInches < 48 || vanityWidthInches > 72)) return null;

    const widthSeed = shortSideFt * 12 * 0.97;
    const widthMatch = closestStandardDimension(widthSeed, [54, 56, 57, 60]);
    const heightMatch = closestStandardDimension(56, [56, 60]) || { value: 56 };
    const widthInches = widthMatch?.value || roundTenth(widthSeed);
    const heightInches = heightMatch.value;

    return {
      roomType,
      type: 'shower_door_opening',
      description: 'Shower entry opening',
      photoIndex: basisObject.photoIndex,
      sourcePhotoIndexes: basisObject.sourcePhotoIndexes || (Number.isInteger(basisObject.photoIndex) ? [basisObject.photoIndex] : []),
      sourcePhotoCount: Number(basisObject.sourcePhotoCount || basisObject.sourcePhotoIndexes?.length || (Number.isInteger(basisObject.photoIndex) ? 1 : 0)),
      dimensions: {
        widthInches,
        heightInches,
        widthFeet: roundTenth(widthInches / 12),
        heightFeet: roundTenth(heightInches / 12),
      },
      measurementGeometry: {
        originalTargetType: basisObject.type,
        showerInferredFromRoomSpan: true,
        showerSalvageDimensionSource: 'bathroom_room_span_fixture_layout',
        roomShortSideInches: roundTenth(shortSideFt * 12),
        roomLongSideInches: roundTenth(longSideFt * 12),
        roomAreaSqFt: roundTenth(areaSqFt),
      },
      measurementTrust: {
        ...(basisObject.measurementTrust || {}),
        trustedForPricing: false,
        reasons: [...new Set([...(basisObject.measurementTrust?.reasons || []), 'object_inferred_from_room_span'])],
        scope: 'bathroom_room_span_shower_fallback',
        calibrationSource: basisObject?.measurementTrust?.calibrationSource || 'bathroom_room_span_fallback',
      },
      sourceModels: {
        ...(basisObject.sourceModels || {}),
        geometry: 'bathroom_room_span_fallback',
      },
      applianceFit: classifyApplianceFit(widthInches, 'shower_door'),
      trustedForPricing: false,
    };
  };

  for (const roomType of bathroomRooms) {
    const roomObjects = retained.filter(object => object?.roomType === roomType);
    if (roomObjects.some(object => object?.type === 'shower_door_opening')) continue;
    const room = roomResults.find(entry => entry?.roomType === roomType) || null;

    const bathtubCandidates = roomObjects
      .filter(object => object?.type === 'existing_bathtub')
      .map(object => ({
        object,
        salvagedDimensions: deriveSalvagedShowerDimensions(object),
      }))
      .filter(candidate => Boolean(candidate.salvagedDimensions))
      .sort((first, second) => (
        Number(second.object?.sourcePhotoCount || 0) - Number(first.object?.sourcePhotoCount || 0)
        || Number(second.salvagedDimensions?.heightInches || 0) - Number(first.salvagedDimensions?.heightInches || 0)
      ));

    const best = bathtubCandidates[0];
    if (!best) {
      const roomSpanFallback = buildRoomSpanFallback(roomType, room, roomObjects);
      if (roomSpanFallback) retained.push(roomSpanFallback);
      continue;
    }

    const salvagedWidthInches = Number(best.salvagedDimensions.widthInches || 0);
    const salvagedHeightInches = Number(best.salvagedDimensions.heightInches || 0);

    retained.push({
      ...best.object,
      type: 'shower_door_opening',
      description: 'Shower entry opening',
      dimensions: {
        ...(best.object.dimensions || {}),
        widthInches: salvagedWidthInches,
        heightInches: salvagedHeightInches,
        widthFeet: roundTenth(salvagedWidthInches / 12),
        heightFeet: roundTenth(salvagedHeightInches / 12),
      },
      measurementGeometry: {
        ...(best.object.measurementGeometry || {}),
        originalTargetType: best.object.type,
        showerSalvagedFromBathtubCluster: true,
        showerSalvageDimensionSource: best.salvagedDimensions.source,
      },
    });
  }

  return retained;
}

function resolveBathroomFixtureTargetType(target, measuredDimensions, targetMeasurement, referenceObjects = []) {
  if (target?.targetType !== 'existing_bathtub') return target?.targetType || null;

  const bathtubReferences = getTargetRepairReferenceCandidates('existing_bathtub', referenceObjects, target);
  const hasStrongBathtubReference = bathtubReferences.some(ref => (
    isExactKnownSceneAnchorRef(ref)
    || ref?.source !== 'auto_inferred_reference_anchor'
    || Boolean(ref?.cropRefined || ref?.deterministicRefined || ref?.geometryRefined)
    || clamp01(ref?.standardSizeConfidence, 0) >= 0.84
  ));
  if (hasStrongBathtubReference) return target.targetType;

  const widthInches = Number(measuredDimensions?.widthInches || 0);
  const heightInches = Number(measuredDimensions?.heightInches || 0);
  const bbox = isValidNormalizedBox(target?.boundingBox) ? clampNormalizedBox(target.boundingBox) : null;
  const aspectRatio = bbox ? bbox.height / Math.max(0.001, bbox.width) : null;
  const method = String(targetMeasurement?.method || '').toLowerCase();
  const showerLikeGeometry = Number.isFinite(widthInches)
    && Number.isFinite(heightInches)
    && widthInches >= 42
    && widthInches <= 72
    && heightInches >= 48
    && heightInches <= 78
    && heightInches >= widthInches * 0.88
    && (!Number.isFinite(aspectRatio) || aspectRatio >= 0.72)
    && method === 'front_face_depth_pinhole';

  return showerLikeGeometry ? 'shower_door_opening' : target.targetType;
}

function deriveRectangularRoomDimensionsFromAreaAndPerimeter(areaSqFt, perimeterFt) {
  const area = Number(areaSqFt || 0);
  const perimeter = Number(perimeterFt || 0);
  if (!Number.isFinite(area) || !Number.isFinite(perimeter) || area <= 0 || perimeter <= 0) return null;

  const semiPerimeter = perimeter / 2;
  const discriminant = semiPerimeter ** 2 - 4 * area;
  if (!Number.isFinite(discriminant) || discriminant < 0) return null;

  const sqrtDiscriminant = Math.sqrt(discriminant);
  const shortSide = (semiPerimeter - sqrtDiscriminant) / 2;
  const longSide = (semiPerimeter + sqrtDiscriminant) / 2;
  if (![shortSide, longSide].every(Number.isFinite) || shortSide <= 0 || longSide <= 0) return null;

  return {
    widthFt: roundTenth(Math.min(shortSide, longSide)),
    lengthFt: roundTenth(Math.max(shortSide, longSide)),
  };
}

function normalizeRoomGeometryAssistPayload(payload = null) {
  if (!payload || typeof payload !== 'object') return null;

  const room = payload.roomDimensions || payload.dimensions || payload.room || payload;
  let widthFt = Number(room.widthFt ?? room.width_ft ?? 0);
  let lengthFt = Number(room.lengthFt ?? room.length_ft ?? 0);
  let floorAreaSqFt = Number(room.floorAreaSqFt ?? room.floor_area_sq_ft ?? 0);
  let perimeterFt = Number(room.perimeterFt ?? room.perimeter_ft ?? 0);
  let heightFt = Number(room.heightFt ?? room.height_ft ?? 0);
  let accuracyEstimateCm = Number(room.accuracyEstimateCm ?? room.accuracy_estimate_cm ?? 0);

  if (!floorAreaSqFt) {
    const floorAreaSqM = Number(room.floor_area_sqm ?? room.floorAreaSqM ?? 0);
    if (floorAreaSqM > 0) floorAreaSqFt = floorAreaSqM * 10.7639;
  }

  if (!perimeterFt) {
    const perimeterM = Number(room.perimeter_m ?? room.perimeterM ?? 0);
    if (perimeterM > 0) perimeterFt = perimeterM * 3.28084;
  }

  if (!heightFt) {
    const heightM = Number(room.ceiling_height_m ?? room.ceilingHeightM ?? room.heightM ?? 0);
    if (heightM > 0) heightFt = heightM * 3.28084;
  }

  if (!accuracyEstimateCm) {
    const accuracyEstimateMm = Number(room.accuracyEstimateMm ?? room.accuracy_estimate_mm ?? 0);
    if (accuracyEstimateMm > 0) accuracyEstimateCm = accuracyEstimateMm / 10;
  }

  if (!(widthFt > 0 && lengthFt > 0)) {
    const derivedFromArea = deriveRectangularRoomDimensionsFromAreaAndPerimeter(floorAreaSqFt, perimeterFt);
    if (derivedFromArea) {
      widthFt = derivedFromArea.widthFt;
      lengthFt = derivedFromArea.lengthFt;
    }
  }

  if (!(widthFt > 0 && lengthFt > 0) && Array.isArray(room.wall_lengths_m)) {
    const wallLengthsFt = room.wall_lengths_m
      .map(value => Number(value) * 3.28084)
      .filter(value => Number.isFinite(value) && value > 0)
      .sort((first, second) => first - second);
    if (wallLengthsFt.length >= 2) {
      const shortGuess = wallLengthsFt[0];
      const longGuess = wallLengthsFt[wallLengthsFt.length - 1];
      widthFt = shortGuess;
      lengthFt = floorAreaSqFt > 0 ? Math.max(longGuess, floorAreaSqFt / Math.max(shortGuess, 0.1)) : longGuess;
    }
  }

  if (!(widthFt > 0 && lengthFt > 0)) return null;
  if (!(floorAreaSqFt > 0)) floorAreaSqFt = widthFt * lengthFt;

  let confidence = String(payload.confidence || room.confidence || '').trim().toLowerCase();
  if (!confidence) {
    confidence = accuracyEstimateCm > 0
      ? (accuracyEstimateCm <= 5 ? 'high' : accuracyEstimateCm <= 15 ? 'medium' : 'low')
      : 'medium';
  }

  return {
    widthFt: roundTenth(widthFt),
    lengthFt: roundTenth(lengthFt),
    heightFt: heightFt > 0 ? roundTenth(heightFt) : null,
    floorAreaSqFt: Math.round(floorAreaSqFt * 10) / 10,
    perimeterFt: perimeterFt > 0 ? roundTenth(perimeterFt) : null,
    accuracyEstimateCm: accuracyEstimateCm > 0 ? Math.round(accuracyEstimateCm * 10) / 10 : null,
    confidence,
    source: payload.source || room.source || 'room_geometry_assist',
  };
}

async function requestRoomGeometryAssistFromExternalService(roomImages, roomType, roomDimensions) {
  if (!ROOM_GEOMETRY_ASSIST_URL || !Array.isArray(roomImages) || !roomImages.length) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROOM_GEOMETRY_ASSIST_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (ROOM_GEOMETRY_ASSIST_API_KEY) headers.Authorization = `Bearer ${ROOM_GEOMETRY_ASSIST_API_KEY}`;

    const response = await fetch(ROOM_GEOMETRY_ASSIST_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        roomType,
        images: roomImages,
        currentRoomDimensions: roomDimensions,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`room geometry assist ${response.status}: ${errorText.slice(0, 180)}`);
    }

    const payload = await response.json();
    return normalizeRoomGeometryAssistPayload(payload);
  } catch (error) {
    console.warn('[PhotoMeasurement] Room geometry assist request failed:', error.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function estimateRoomGeometryWithGcpWorker(roomImages) {
  if (!ROOM_GEOMETRY_GCP_ASSIST_ENABLE || !Array.isArray(roomImages) || roomImages.length < ROOM_GEOMETRY_GCP_ASSIST_MIN_IMAGES) return null;

  let tempRoot = null;
  try {
    const worker = getGcpGpuWorker();
    if (!worker?.enabled) return null;

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-geometry-assist-'));
    const imagesDir = path.join(tempRoot, 'images');
    const outputDir = path.join(tempRoot, 'output');
    await fs.mkdir(imagesDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    for (let index = 0; index < roomImages.length; index += 1) {
      const buffer = await imageInputToBuffer(roomImages[index]);
      const filePath = path.join(imagesDir, `room_${String(index + 1).padStart(2, '0')}.jpg`);
      await sharp(buffer, { limitInputPixels: false }).jpeg({ quality: 92 }).toFile(filePath);
    }

    const result = await worker.processV2Pipeline(imagesDir, outputDir, {
      metric3dModel: ROOM_GEOMETRY_GCP_ASSIST_METRIC3D_MODEL,
      voxelSize: ROOM_GEOMETRY_GCP_ASSIST_VOXEL_SIZE,
      skipSegmentation: true,
    });
    if (!result?.measurements_path) return null;

    const measurementsText = await fs.readFile(result.measurements_path, 'utf8');
    return normalizeRoomGeometryAssistPayload({
      ...JSON.parse(measurementsText),
      source: 'gcp_v2_metric3d_tsdf',
    });
  } catch (error) {
    console.warn('[PhotoMeasurement] GCP room geometry assist failed:', error.message);
    return null;
  } finally {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function estimateRoomGeometryAssist(roomImages, roomType, roomDimensions, options = {}) {
  const normalizedRoomType = normalizeRoomTypeKey(roomType);
  const directHints = options.roomGeometryAssistByType || options.roomGeometryAssist || null;
  if (directHints && typeof directHints === 'object') {
    const hinted = directHints[roomType] || directHints[normalizedRoomType] || null;
    const normalizedHint = normalizeRoomGeometryAssistPayload(hinted);
    if (normalizedHint) return normalizedHint;
  }

  const externalAssist = await requestRoomGeometryAssistFromExternalService(roomImages, roomType, roomDimensions);
  if (externalAssist) return externalAssist;

  return estimateRoomGeometryWithGcpWorker(roomImages);
}

// ============================================================================
// Main Entry Point
// ============================================================================
export async function measureFromPhotos(images, options = {}) {
  const startTime = Date.now();
  console.log(`[PhotoMeasurement] Starting DAv3-Metric measurement of ${images.length} photos`);

  const results = {
    ok: true,
    rooms: [],
    objects: [],
    appliances: [],
    measuredMaterials: [],   // Itemized material list from measurements
    measuredLabor: [],       // Itemized labor list from measurements
    materialQuantities: {},  // Legacy format for backward compatibility
    processingTime: 0,
    methodology: 'gpt_4o_room_envelope + dav3_metric_objects',
    measurementAudit: {
      modelUsage: {
        detection: 'gpt-4o-vision',
        depth: 'depth-anything-v3-metric',
        intrinsics: 'original_exif_when_available_else_estimated',
        calibration: 'gpt_reference_bbox + promoted_standardized_targets + exact_scene_known_anchors + auto_inferred_fixture_anchors + dav3_depth + exif_intrinsics + known_size_constraints',
        scaleAnchors: 'dedicated_gpt_4o_wall_fixture_sweep',
        faceplateDetector: FACEPLATE_DETECTOR_URL ? 'external_faceplate_detector + classical_geometry_fallback' : 'classical_rectangle_scan + line_profile_snap',
        objectTargets: 'gpt_4o_detection + specialist_detector_arbitration + optional_segmenter + deterministic_edge_snap + target_specific_depth_geometry',
        roomGeometryAssist: ROOM_GEOMETRY_ASSIST_URL
          ? 'external_room_geometry_assist'
          : (ROOM_GEOMETRY_GCP_ASSIST_ENABLE ? 'gcp_gpu_worker_v2_metric3d_tsdf' : null),
      },
      images: [],
      depth: [],
      intrinsics: [],
      calibrations: [],
      scaleAnchorDetection: null,
      objectTargetRefinement: null,
      referenceTargetRepair: null,
      knownSceneAnchors: null,
      autoInferredReferenceAnchors: null,
      promotedReferenceAnchors: null,
      objectConsolidation: null,
      rooms: [],
      objects: [],
      trustSummary: null,
    },
  };

  try {
    const normalizedImages = await Promise.all(images.map((img, i) => normalizeMeasurementImageInput(img, i)));
    const modelImages = normalizedImages.map(img => img.modelInput);
    results.measurementAudit.images = normalizedImages.map(summarizeImageAudit);
    const imageDimensions = await Promise.all(normalizedImages.map(async (img) => img.pixelDimensions || getImagePixelDimensions(img.modelInput)));
    const configuredConsensusPasses = Number(options?.visionConsensusPasses);
    const visionConsensusPasses = Number.isFinite(configuredConsensusPasses)
      ? Math.max(1, Math.min(3, Math.round(configuredConsensusPasses)))
      : (modelImages.length <= 12 ? 2 : 1);

    // STEP 1: GPT-4o object detection
    console.log(`[PhotoMeasurement] Step 1: GPT-4o object detection${visionConsensusPasses > 1 ? ` (${visionConsensusPasses}-pass consensus)` : ''}...`);
    let detections = visionConsensusPasses > 1
      ? mergeObjectDetectionPasses(await Promise.all(Array.from({ length: visionConsensusPasses }, () => detectObjectsAndMeasurementTargets(modelImages))))
      : await detectObjectsAndMeasurementTargets(modelImages);
    if (!detections.ok || !detections.photos) {
      console.warn('[PhotoMeasurement] Structured detection failed, trying fallback...');
      detections = await fallbackRoomClassification(modelImages);
      if (!detections.ok) {
        results.ok = false;
        results.error = detections.error || 'All detection methods failed';
        results.processingTime = Date.now() - startTime;
        return results;
      }
    }
    results.measurementAudit.objectDetection = {
      ok: Boolean(detections.ok),
      requestedPassCount: visionConsensusPasses,
      okPassCount: detections.okPassCount || (detections.ok ? 1 : 0),
      stabilized: Boolean(detections.stabilized),
      roomCount: detections.photos?.length || 0,
      error: detections.error || null,
    };

    console.log(`[PhotoMeasurement] Step 1.5: GPT-4o scale-anchor sweep${visionConsensusPasses > 1 ? ` (${visionConsensusPasses}-pass consensus)` : ''}...`);
    const scaleAnchorDetection = visionConsensusPasses > 1
      ? mergeScaleAnchorPasses(await Promise.all(Array.from({ length: visionConsensusPasses }, () => detectScaleAnchors(modelImages))))
      : await detectScaleAnchors(modelImages);
    const refinedScaleAnchorDetection = await refineSmallScaleAnchorsWithCrops(modelImages, scaleAnchorDetection);
    const anchorMerge = mergeScaleAnchorDetections(detections, refinedScaleAnchorDetection);
    detections = anchorMerge.detections;
    results.measurementAudit.scaleAnchorDetection = {
      ok: Boolean(refinedScaleAnchorDetection.ok),
      requestedPassCount: visionConsensusPasses,
      okPassCount: scaleAnchorDetection.okPassCount || (scaleAnchorDetection.ok ? 1 : 0),
      stabilized: Boolean(scaleAnchorDetection.stabilized),
      addedReferenceObjects: anchorMerge.added,
      refinedReferenceObjects: refinedScaleAnchorDetection.refinedCount || 0,
      cropRefinementOk: Boolean(refinedScaleAnchorDetection.cropRefinementOk),
      error: refinedScaleAnchorDetection.error || refinedScaleAnchorDetection.cropRefinementError || anchorMerge.error || null,
      referenceCounts: (refinedScaleAnchorDetection.photos || []).map(photo => ({
        photoIndex: photo.photoIndex,
        count: photo.referenceObjects?.length || 0,
        types: (photo.referenceObjects || []).map(anchor => anchor.type),
        refined: (photo.referenceObjects || []).filter(anchor => anchor.cropRefined).length,
      })),
    };
    if (anchorMerge.added > 0) {
      console.log(`[PhotoMeasurement] Scale-anchor sweep added ${anchorMerge.added} reference objects`);
    }

    const objectTargetRefinement = await refineMeasurementTargetsWithCrops(modelImages, detections);
    detections = objectTargetRefinement.detections || detections;
    results.measurementAudit.objectTargetRefinement = {
      ok: Boolean(objectTargetRefinement.ok),
      attemptedTargets: objectTargetRefinement.attemptedCount || 0,
      refinedTargets: objectTargetRefinement.refinedCount || 0,
      specialistRefinedTargets: objectTargetRefinement.specialistRefinedCount || 0,
      ambiguousTargets: objectTargetRefinement.ambiguousCount || 0,
      specialistDetectorEnabled: Boolean(objectTargetRefinement.specialistDetectorEnabled),
      segmenterEnabled: Boolean(objectTargetRefinement.segmenterEnabled),
      error: objectTargetRefinement.error || null,
    };
    if (objectTargetRefinement.refinedCount > 0) {
      console.log(`[PhotoMeasurement] Object target edge refinement updated ${objectTargetRefinement.refinedCount} targets`);
    }

    const knownSceneAnchorPromotion = promoteKnownSceneAnchors(detections, options.knownSceneAnchors || []);
    detections = knownSceneAnchorPromotion.detections || detections;
    results.measurementAudit.knownSceneAnchors = {
      specs: knownSceneAnchorPromotion.specs || 0,
      candidates: knownSceneAnchorPromotion.candidates || 0,
      added: knownSceneAnchorPromotion.added || 0,
      source: 'exact_known_scene_anchor_promotion',
    };
    if (knownSceneAnchorPromotion.added > 0) {
      console.log(`[PhotoMeasurement] Promoted ${knownSceneAnchorPromotion.added} exact known scene anchors into scale anchors`);
    }

    const promotedAnchors = promoteMeasurementTargetsToReferenceAnchors(detections);
    detections = promotedAnchors.detections || detections;
    results.measurementAudit.promotedReferenceAnchors = {
      candidates: promotedAnchors.candidates || 0,
      added: promotedAnchors.added || 0,
      source: 'measurement_targets_standardized_anchor_promotion',
    };
    if (promotedAnchors.added > 0) {
      console.log(`[PhotoMeasurement] Promoted ${promotedAnchors.added} standardized measurement targets into scale anchors`);
    }

    // STEP 2: DAv3-Metric batch depth estimation (single API call for all images)
    console.log('[PhotoMeasurement] Step 2: DAv3-Metric batch depth estimation...');
    let depthBatch = { ok: false, perImage: [] };
    try {
      depthBatch = await runDepthEstimation(modelImages, imageDimensions);
      const successCount = (depthBatch.perImage || []).filter(d => d.ok).length;
      console.log(`[PhotoMeasurement] Depth: ${successCount}/${images.length} images succeeded`);
    } catch (depthErr) {
      console.warn('[PhotoMeasurement] Depth batch failed (proceeding with GPT-only):', depthErr.message);
    }
    const depthResults = depthBatch.perImage || [];
    results.measurementAudit.depth = depthResults.map(summarizeDepthAudit);

    // STEP 3: EXIF intrinsics
    console.log('[PhotoMeasurement] Step 3: Camera intrinsics...');
    const intrinsicsResults = await Promise.all(
      modelImages.map((img, i) => {
        const depthInfo = depthResults[i];
        const width = depthInfo?.ok && depthInfo.width ? depthInfo.width : (imageDimensions[i]?.width || 1920);
        const height = depthInfo?.ok && depthInfo.height ? depthInfo.height : (imageDimensions[i]?.height || 1080);
        return extractCameraIntrinsics(img, width, height, normalizedImages[i]);
      })
    );
    results.measurementAudit.intrinsics = intrinsicsResults.map((intrinsics, i) => summarizeIntrinsicsAudit(intrinsics, i));

    const autoInferredReferenceAnchors = inferAutomaticFixtureReferenceAnchors(detections, depthResults, intrinsicsResults);
    detections = autoInferredReferenceAnchors.detections || detections;
    results.measurementAudit.autoInferredReferenceAnchors = {
      proposals: autoInferredReferenceAnchors.proposals || 0,
      groups: autoInferredReferenceAnchors.groups || 0,
      added: autoInferredReferenceAnchors.added || 0,
      source: 'auto_inferred_fixture_reference_anchors',
    };
    if (autoInferredReferenceAnchors.added > 0) {
      console.log(`[PhotoMeasurement] Auto-inferred ${autoInferredReferenceAnchors.added} fixture reference anchors from measurement targets`);
    }

    const referenceTargetRepair = repairMeasurementTargetsWithReferences(detections);
    detections = referenceTargetRepair.detections || detections;
    results.measurementAudit.referenceTargetRepair = {
      repairedTargets: referenceTargetRepair.repairedCount || 0,
      backfilledTargets: referenceTargetRepair.backfilledCount || 0,
      droppedTargets: referenceTargetRepair.droppedCount || 0,
      source: 'reference_anchor_target_repair',
    };
    if ((referenceTargetRepair.repairedCount || 0) > 0 || (referenceTargetRepair.backfilledCount || 0) > 0 || (referenceTargetRepair.droppedCount || 0) > 0) {
      console.log(`[PhotoMeasurement] Repaired ${referenceTargetRepair.repairedCount || 0} targets, backfilled ${referenceTargetRepair.backfilledCount || 0}, dropped ${referenceTargetRepair.droppedCount || 0} via reference-anchor target repair`);
    }

    if ((referenceTargetRepair.repairedCount || 0) > 0 || (referenceTargetRepair.backfilledCount || 0) > 0) {
      const postRepairRefinement = await refineMeasurementTargetsWithCrops(modelImages, detections);
      detections = postRepairRefinement.detections || detections;
      results.measurementAudit.referenceTargetRepair.postRepairRefinement = {
        ok: Boolean(postRepairRefinement.ok),
        attemptedTargets: postRepairRefinement.attemptedCount || 0,
        refinedTargets: postRepairRefinement.refinedCount || 0,
        error: postRepairRefinement.error || null,
      };
      if (postRepairRefinement.refinedCount > 0) {
        console.log(`[PhotoMeasurement] Post-repair target refinement updated ${postRepairRefinement.refinedCount} targets`);
      }
    }

    // STEP 3.5: Global hard-constraint calibration from high-confidence references
    const globalCalibration = buildGlobalHardConstraintCalibration(detections.photos || [], depthResults, intrinsicsResults);
    if (globalCalibration.available) {
      console.log(`[PhotoMeasurement] Global calibration: scale=${globalCalibration.scaleFactor.toFixed(3)} (${globalCalibration.consistency}, ${globalCalibration.count} refs)`);
    }
    results.globalCalibration = globalCalibration;
    results.measurementAudit.globalCalibration = globalCalibration;

    const preliminaryCalibrations = (detections.photos || []).map((photo, index) => {
      const depthInfo = depthResults[index] || { ok: false };
      const intrinsics = intrinsicsResults[index];
      const imgW = depthInfo.ok ? depthInfo.width : 1920;
      const imgH = depthInfo.ok ? depthInfo.height : 1080;

      let calibration = { scaleFactor: 1.0, calibrated: false, references: [] };
      if (photo?.referenceObjects?.length > 0) {
        calibration = calibrateScaleFromReferences(photo.referenceObjects, depthInfo, imgW, imgH, intrinsics);
      }
      if (!calibration.calibrated && globalCalibration.available) {
        calibration = {
          ...calibration,
          scaleFactor: globalCalibration.scaleFactor,
          consistency: globalCalibration.consistency,
          calibrated: true,
          source: 'global_hard_constraints',
        };
      }
      return calibration;
    });

    const roomTypeScaleHints = new Map();
    for (let index = 0; index < (detections.photos || []).length; index++) {
      const photo = detections.photos[index];
      const calibration = preliminaryCalibrations[index];
      const roomType = photo?.roomType;
      if (!roomType || !calibration?.calibrated || !['high', 'medium'].includes(calibration.consistency)) continue;

      const score = (calibration.consistency === 'high' ? 3 : 2) + ((calibration.references?.length || 0) / 10);
      const existing = roomTypeScaleHints.get(roomType);
      if (!existing || score > existing.score) {
        roomTypeScaleHints.set(roomType, {
          scaleFactor: calibration.scaleFactor,
          consistency: calibration.consistency,
          referenceCount: calibration.references?.length || 0,
          photoIndexes: [index],
          score,
        });
      } else if (existing && Math.abs(existing.scaleFactor - calibration.scaleFactor) / Math.max(0.1, existing.scaleFactor) <= 0.12) {
        existing.photoIndexes.push(index);
        existing.referenceCount += calibration.references?.length || 0;
      }
    }

    // STEP 4: Per-photo measurement
    console.log('[PhotoMeasurement] Step 4: Per-photo measurement...');
    const roomGroups = {};

    for (let i = 0; i < images.length; i++) {
      const photo = detections.photos?.[i];
      if (!photo) continue;

      const depthInfo = depthResults[i] || { ok: false };
      const intrinsics = intrinsicsResults[i];
      const imgW = depthInfo.ok ? depthInfo.width : 1920;
      const imgH = depthInfo.ok ? depthInfo.height : 1080;

      let calibration = preliminaryCalibrations[i] || { scaleFactor: 1.0, calibrated: false, references: [] };
      const roomScaleHint = roomTypeScaleHints.get(photo.roomType || '');
      if (!calibration.calibrated && roomScaleHint) {
        calibration = {
          ...calibration,
          scaleFactor: roomScaleHint.scaleFactor,
          candidateScaleFactor: calibration.candidateScaleFactor || roomScaleHint.scaleFactor,
          consistency: roomScaleHint.consistency,
          source: 'room_local_calibration_hint',
          displayCalibrated: true,
          propagatedFromPhotoIndexes: roomScaleHint.photoIndexes,
          propagatedReferenceCount: roomScaleHint.referenceCount,
        };
      }
      results.measurementAudit.calibrations.push(summarizeCalibrationAudit(calibration, i));

      // Extract room dimensions
      const roomDims = extractRoomDimensions(depthInfo, photo, intrinsics, calibration.scaleFactor, imgW, imgH, calibration);

      // Measure renovation target objects
      const objectMeasurements = [];
      for (const target of (photo.measurementTargets || [])) {
        if (!SUPPORTED_MEASUREMENT_TARGET_TYPES.has(target?.targetType)) continue;
        const suppressRoomLocalCalibrationHint = shouldSuppressRoomLocalCalibrationHintForTarget(target, calibration);
        const softLocalBathroomScaleHint = shouldUseSoftLocalBathroomScaleHint(target, photo, calibration)
          ? calibration.softLocalToiletScaleHint
          : null;
        const effectiveScaleFactor = softLocalBathroomScaleHint?.scaleFactor
          || (suppressRoomLocalCalibrationHint ? 1 : calibration.scaleFactor);
        const targetMeasurement = measureTargetObject(target, depthInfo, imgW, imgH, intrinsics, effectiveScaleFactor);
        if (!targetMeasurement?.dimensions) continue;

        const resolvedTargetType = resolveBathroomFixtureTargetType(target, targetMeasurement.dimensions, targetMeasurement, photo.referenceObjects || []);
        const sanityResult = applyObjectDimensionSanity(resolvedTargetType, targetMeasurement.dimensions);
        const dims = sanityResult.dimensions;
        const sanityClamped = sanityResult.sanityClamped;
        const referenceHints = collectReferenceHintsForTarget(target, photo.referenceObjects || []);
        if (sanityClamped) {
          console.warn(`[PhotoMeasurement] ${resolvedTargetType} dimensions sanity-adjusted: ${sanityResult.reasons.join(', ')}`);
        }

        const applianceTypes = {
          'fridge_opening': 'fridge', 'range_opening': 'range', 'dishwasher_opening': 'dishwasher',
          'vanity_space': 'vanity', 'shower_door_opening': 'shower_door',
          'existing_fridge': 'fridge', 'existing_range': 'range', 'existing_dishwasher': 'dishwasher',
          'existing_vanity': 'vanity',
        };
        const applianceFit = applianceTypes[resolvedTargetType] ? classifyApplianceFit(dims.widthInches, applianceTypes[resolvedTargetType]) : null;
        const measurementTrust = evaluateObjectMeasurementTrust({
          calibration,
          intrinsics,
          depthInfo,
          depthStats: targetMeasurement.depthStats,
          targetType: resolvedTargetType,
          targetConfidence: target.confidence || 0.7,
          sanityClamped,
          measurementMethod: targetMeasurement.method,
          bboxRefined: Boolean(
            target.edgeRefined
            || target.cropRefined
            || target.deterministicRefined
            || isStrongReferenceAlignedTarget(target)
            || hasCoverageConsensusRefinement(target)
          ),
        });

        const obj = {
          type: resolvedTargetType,
          description: resolvedTargetType === 'shower_door_opening' && target.targetType === 'existing_bathtub'
            ? 'Shower entry opening'
            : target.description,
          targetFamily: target.targetFamily || null,
          dimensions: dims,
          applianceFit,
          confidence: target.confidence || 0.7,
          calibrated: calibration.calibrated,
          sanityClamped,
          sanityReasons: sanityResult.reasons,
          photoIndex: i,
          roomType: photo.roomType,
          measurementGeometry: {
            method: targetMeasurement.method,
            targetFamily: target.targetFamily || null,
            originalTargetType: target.targetType,
            candidateMethods: targetMeasurement.candidateMethods || [],
            calibrationScaleFactorApplied: effectiveScaleFactor,
            softLocalScaleHint: softLocalBathroomScaleHint || null,
            calibrationHintSuppressed: suppressRoomLocalCalibrationHint
              ? {
                  source: calibration.source,
                  scaleFactor: calibration.scaleFactor,
                }
              : null,
            depthSource: targetMeasurement.depthStats?.source || 'unknown',
            depthSampleCount: targetMeasurement.depthStats?.sampleCount || 0,
            boundingBox: targetMeasurement.boundingBox,
            roughBoundingBox: target.roughBoundingBox || null,
            edgeRefined: Boolean(target.edgeRefined),
            specialistRefined: Boolean(target.specialistRefined),
            specialistSelectedSource: target.specialistSelectedSource || null,
            specialistSupportCount: target.specialistSupportCount || 0,
            specialistAmbiguous: Boolean(target.specialistAmbiguous),
            referenceAligned: Boolean(target.referenceAligned),
            edgeRefinementReason: target.edgeRefinementReason || null,
            edgeRefinementDiagnostics: target.edgeRefinementDiagnostics || null,
            specialistRefinementDiagnostics: target.specialistRefinementDiagnostics || null,
            learnedDetectorRefined: Boolean(target.learnedDetectorRefined),
            segmenterRefined: Boolean(target.segmenterRefined),
            geometryDiagnostics: targetMeasurement.geometryDiagnostics || targetMeasurement.depthStats?.wallPlaneDiagnostics || null,
          },
          sourceModels: {
            detection: 'gpt-4o-vision',
            depth: 'depth-anything-v3-metric',
            intrinsics: intrinsics?.source || 'unknown',
            calibration: softLocalBathroomScaleHint?.source
              || (suppressRoomLocalCalibrationHint ? 'room_local_calibration_hint_suppressed' : measurementTrust.calibrationSource),
            geometry: targetMeasurement.method,
          },
          referenceHints,
          measurementTrust,
          trustedForPricing: measurementTrust.trustedForPricing,
        };
        objectMeasurements.push(obj);
        results.objects.push(obj);
        results.measurementAudit.objects.push({
          photoIndex: i,
          roomType: photo.roomType,
          type: resolvedTargetType,
          widthInches: dims.widthInches,
          heightInches: dims.heightInches,
          confidence: obj.confidence,
          trustedForPricing: measurementTrust.trustedForPricing,
          trustReasons: measurementTrust.reasons,
          sanityClamped,
          sanityReasons: sanityResult.reasons,
          calibrated: calibration.calibrated,
          measurementMethod: targetMeasurement.method,
          depthSource: targetMeasurement.depthStats?.source || 'unknown',
          calibrationScaleFactorApplied: effectiveScaleFactor,
          softLocalScaleHint: softLocalBathroomScaleHint || null,
          calibrationHintSuppressed: suppressRoomLocalCalibrationHint,
          edgeRefined: Boolean(target.edgeRefined),
          specialistRefined: Boolean(target.specialistRefined),
          specialistSelectedSource: target.specialistSelectedSource || null,
          specialistAmbiguous: Boolean(target.specialistAmbiguous),
          learnedDetectorRefined: Boolean(target.learnedDetectorRefined),
          segmenterRefined: Boolean(target.segmenterRefined),
          referenceHintCount: referenceHints.length,
          originalTargetType: target.targetType,
        });
        if (applianceFit) results.appliances.push({ type: target.targetType, roomType: photo.roomType, ...applianceFit });
      }

      const roomType = photo.roomType || 'unknown';
      if (!roomGroups[roomType]) roomGroups[roomType] = [];
      roomGroups[roomType].push({ photoIndex: i, dimensions: roomDims, calibration, objects: objectMeasurements, intrinsics, depthInfo, referenceObjects: photo.referenceObjects || [] });
    }

    const captureProtocol = evaluateCaptureProtocol(detections.photos || [], depthResults);
    results.captureProtocol = captureProtocol;

    // STEP 5: Consolidate + calculate comprehensive material & labor breakdown
    console.log('[PhotoMeasurement] Step 5: Consolidating + material/labor calculation...');

    for (const [roomType, photos] of Object.entries(roomGroups)) {
      const consolidated = consolidateRoomMeasurements(photos);
      if (!consolidated) continue;
      const roomTypeKey = String(roomType || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

      // Room envelope from GPT-4o — used ONLY for wall opening data (windows/doors).
      // Room dimensions (width, length, height, floor area) come from DAv3 depth model,
      // which is calibrated from real metric depth data.  GPT-4o Vision is unreliable
      // for estimating absolute room dimensions from photos.
      const roomImageIndexes = photos.map(p => p.photoIndex).filter(i => i >= 0);
      const roomImages = roomImageIndexes.map(idx => modelImages[idx]).filter(Boolean);
      // Build renovation context from detected objects for this room
      const roomObjects = (results.objects || []).filter(o => o.roomType === roomType);
      const detectedTypes = roomObjects.map(o => o.type).join(', ');
      const renovationCtx = detectedTypes ? `Detected objects: ${detectedTypes}` : null;
      const internalRoomAnchors = buildInternalRoomFixtureAnchors(roomObjects, roomType);
      const internalBathroomWidthAnchorFt = roomTypeKey === 'bathroom'
        ? Math.max(
            0,
            ...internalRoomAnchors
              .map(anchor => Number(anchor?.knownDimensions?.width || anchor?.width || 0) / 12)
              .filter(value => Number.isFinite(value) && value > 0)
          )
        : null;
      const hasTubOrShowerEvidence = roomTypeKey === 'bathroom' && roomObjects.some(object => (
        object?.type === 'existing_bathtub' || object?.type === 'shower_door_opening'
      ));
      const vanityObject = roomObjects.find(object => object?.type === 'existing_vanity') || null;
      const toiletObject = roomObjects.find(object => object?.type === 'existing_toilet') || null;
      const compactVanityWidthFt = Number(vanityObject?.dimensions?.widthInches || 0) / 12;
      const compactToiletWidthFt = Number(toiletObject?.dimensions?.widthInches || 0) / 12;
      const powderRoomLikeBathroom = roomTypeKey === 'bathroom'
        && !hasTubOrShowerEvidence
        && Number.isFinite(internalBathroomWidthAnchorFt)
        && internalBathroomWidthAnchorFt > 0
        && internalBathroomWidthAnchorFt < 4.5;
      const compactPowderRoomLikeBathroom = powderRoomLikeBathroom
        && compactToiletWidthFt > 0
        && compactToiletWidthFt <= 1.7;
      const envelopeKnownAnchors = [
        ...(Array.isArray(options.knownSceneAnchors) ? options.knownSceneAnchors : []),
        ...internalRoomAnchors,
      ];
      const calibratedPhotoCount = photos.filter(p => p.calibration?.calibrated).length;
      const strongCalibratedPhotoCount = photos.filter(p => p.calibration?.calibrated && ['high', 'medium'].includes(p.calibration?.consistency)).length;
      const calibrationConsensusWeak = strongCalibratedPhotoCount === 0 && calibratedPhotoCount < Math.min(2, photos.length);

      // Start with DAv3 consolidated dimensions (depth-model based)
      let roomDimensions = { ...consolidated };

      if (isRoomGeometryAssistEligible(roomTypeKey) && calibrationConsensusWeak && roomImages.length >= ROOM_GEOMETRY_GCP_ASSIST_MIN_IMAGES) {
        const geometryAssist = await estimateRoomGeometryAssist(roomImages, roomType, roomDimensions, options);
        if (geometryAssist) {
          const currentArea = Math.max(1, Number(roomDimensions.floorAreaSqFt) || (Number(roomDimensions.widthFt || 0) * Number(roomDimensions.lengthFt || 0)));
          const rawTargetWidth = Number(geometryAssist.widthFt || 0);
          const rawTargetLength = Number(geometryAssist.lengthFt || 0);
          const minimumGeometryDimension = roomTypeKey === 'bathroom' ? 2.5 : 5;
          const targetWidth = rawTargetWidth > 0 ? Math.min(40, Math.max(minimumGeometryDimension, rawTargetWidth)) : 0;
          const targetLength = rawTargetLength > 0 ? Math.min(45, Math.max(minimumGeometryDimension, rawTargetLength)) : 0;
          const targetArea = Math.max(1, Number(geometryAssist.floorAreaSqFt || targetWidth * targetLength));
          const targetHeight = Number(geometryAssist.heightFt || 0);
          const areaDisagreement = Math.abs(targetArea - currentArea) / Math.max(targetArea, currentArea);
          const asIsError = Math.abs(targetWidth - roomDimensions.widthFt) + Math.abs(targetLength - roomDimensions.lengthFt);
          const swappedError = Math.abs(targetLength - roomDimensions.widthFt) + Math.abs(targetWidth - roomDimensions.lengthFt);
          const alignedWidth = swappedError < asIsError ? targetLength : targetWidth;
          const alignedLength = swappedError < asIsError ? targetWidth : targetLength;
          const dimensionDisagreement = Math.max(
            Math.abs(alignedWidth - Number(roomDimensions.widthFt || 0)),
            Math.abs(alignedLength - Number(roomDimensions.lengthFt || 0)),
          );
          const compactGeometrySuggestion = roomTypeKey === 'bathroom' && Math.min(alignedWidth, alignedLength) < 5;
          const shouldBlendGeometryAssist = targetWidth > 0
            && targetLength > 0
            && (areaDisagreement >= 0.12 || (compactGeometrySuggestion && dimensionDisagreement >= 0.2));

          if (shouldBlendGeometryAssist) {
            const blend = compactGeometrySuggestion ? 0.72 : (currentArea < targetArea * 0.82 ? 0.72 : 0.52);

            roomDimensions.preGeometryAssistDimensions = {
              widthFt: roomDimensions.widthFt,
              lengthFt: roomDimensions.lengthFt,
              heightFt: roomDimensions.heightFt,
              floorAreaSqFt: roomDimensions.floorAreaSqFt,
              methodology: roomDimensions.methodology,
            };
            roomDimensions.widthFt = roundTenth(roomDimensions.widthFt * (1 - blend) + alignedWidth * blend);
            roomDimensions.lengthFt = roundTenth(roomDimensions.lengthFt * (1 - blend) + alignedLength * blend);
            if (targetHeight > 0) {
              roomDimensions.heightFt = roundTenth(((roomDimensions.heightFt || targetHeight) * 0.72) + targetHeight * 0.28);
            }
            roomDimensions.floorAreaSqFt = Math.round(roomDimensions.widthFt * roomDimensions.lengthFt);
            roomDimensions.perimeterFt = Math.round(2 * (roomDimensions.widthFt + roomDimensions.lengthFt));
            roomDimensions.wallAreaSqFt = Math.round(roomDimensions.perimeterFt * roomDimensions.heightFt);
            roomDimensions.geometryAssistUsed = true;
            roomDimensions.geometryAssistSource = geometryAssist.source;
            roomDimensions.geometryAssistConfidence = geometryAssist.confidence;
            roomDimensions.geometryAssistDiagnostics = {
              suggestedWidthFt: geometryAssist.widthFt,
              suggestedLengthFt: geometryAssist.lengthFt,
              suggestedAreaSqFt: geometryAssist.floorAreaSqFt,
              accuracyEstimateCm: geometryAssist.accuracyEstimateCm || null,
              confidence: geometryAssist.confidence,
              compactGeometrySuggestion,
              blend,
              dimensionDisagreementFt: Math.round(dimensionDisagreement * 100) / 100,
              areaDisagreementPct: Math.round(areaDisagreement * 1000) / 10,
            };
          }
        }
      }

      const envelope = await estimateRoomEnvelopeFromImages(roomType, roomImages, renovationCtx, envelopeKnownAnchors);

      // If scale calibration is weak, use GPT-4o's multi-image room envelope as a low-trust dimensional prior.
      // This improves user-visible estimates while still keeping pricing gates conservative.
      if (envelope.ok && envelope.room) {
        const e = envelope.room;
        const preserveCompactGeometryAssist = roomTypeKey === 'bathroom'
          && roomDimensions.geometryAssistUsed
          && roomDimensions.geometryAssistDiagnostics?.compactGeometrySuggestion;
        const hasExactKnownSceneAnchors = normalizeKnownSceneAnchors(options.knownSceneAnchors || []).length > 0;
        const hasAutoVanityReference = roomTypeKey === 'bathroom' && photos.some(photo => (
          (photo.referenceObjects || []).some(ref => getReferenceProfileType(ref) === 'bathroom_vanity_auto')
        ));
        const hasStrongBathroomAutoAnchors = roomTypeKey === 'bathroom' && photos.some(photo => (
          (photo.referenceObjects || []).some(ref => (
            FLOOR_TILE_ANCHOR_TYPES.has(ref?.type)
            || ref?.type === 'bathroom_vanity_auto'
            || /^bathroom_vanity_/i.test(getReferenceProfileType(ref) || '')
            || ref?.type === 'standard_toilet'
            || ref?.type === 'toilet'
          ))
        ));
        const minExpectedArea = {
          bathroom: 28,
          kitchen: 90,
          bedroom: 100,
          living_room: 140,
          dining_room: 90,
          home_gym: 150,
          basement: 160,
          rec_room: 150,
          family_room: 140,
          media_room: 140,
          bonus_room: 120,
          hallway: 30,
          foyer: 35,
          laundry: 25,
        }[roomTypeKey] || 50;
        const visionWidth = Number(e.widthFt) || null;
        const visionLength = Number(e.lengthFt) || null;
        const visionPlausible = visionWidth && visionLength && visionWidth >= 5 && visionLength >= 5 && visionWidth <= 35 && visionLength <= 35;
        const currentArea = Math.max(1, roomDimensions.floorAreaSqFt || (roomDimensions.widthFt * roomDimensions.lengthFt));
        const visionArea = visionPlausible ? visionWidth * visionLength : null;
        const areaDisagreement = visionArea ? Math.abs(visionArea - currentArea) / Math.max(currentArea, visionArea) : 0;
        const roomImplausiblySmall = currentArea < minExpectedArea;
        const allowVisionFallback = roomImplausiblySmall || calibrationConsensusWeak;
        if (!preserveCompactGeometryAssist && allowVisionFallback && visionPlausible && e.confidence !== 'low' && (roomImplausiblySmall || areaDisagreement > 0.35)) {
          const asIsError = Math.abs(visionWidth - roomDimensions.widthFt) + Math.abs(visionLength - roomDimensions.lengthFt);
          const swappedError = Math.abs(visionLength - roomDimensions.widthFt) + Math.abs(visionWidth - roomDimensions.lengthFt);
          const targetWidth = swappedError < asIsError ? visionLength : visionWidth;
          const targetLength = swappedError < asIsError ? visionWidth : visionLength;
          const targetWidthInflation = targetWidth / Math.max(roomDimensions.widthFt || 0, 0.1);
          const targetLengthInflation = targetLength / Math.max(roomDimensions.lengthFt || 0, 0.1);
          let widthBlend = currentArea < minExpectedArea ? 0.72 : 0.58;
          let lengthBlend = widthBlend;
          if (roomTypeKey === 'bathroom' && hasExactKnownSceneAnchors) {
            widthBlend = currentArea < minExpectedArea ? 0.84 : 0.70;
            lengthBlend = currentArea < minExpectedArea ? 0.50 : 0.42;
          } else if (roomTypeKey === 'bathroom' && hasAutoVanityReference) {
            if (powderRoomLikeBathroom) {
              widthBlend = currentArea < minExpectedArea ? 0.12 : 0.08;
              lengthBlend = currentArea < minExpectedArea ? 0.06 : 0.04;
            } else {
              const widthAnchorRange = internalBathroomWidthAnchorFt
                ? {
                    min: Math.max(4.4, internalBathroomWidthAnchorFt * 0.88),
                    max: Math.min(6.4, internalBathroomWidthAnchorFt * 1.18),
                  }
                : null;
              const protectedAxis = widthAnchorRange
                ? (Math.abs(roomDimensions.widthFt - internalBathroomWidthAnchorFt) <= Math.abs(roomDimensions.lengthFt - internalBathroomWidthAnchorFt)
                    ? 'width'
                    : 'length')
                : null;
              const widthAlreadyPlausible = widthAnchorRange
                ? roomDimensions.widthFt >= widthAnchorRange.min && roomDimensions.widthFt <= widthAnchorRange.max
                : (roomDimensions.widthFt >= 4.5 && roomDimensions.widthFt <= 5.3);
              const lengthAlreadyPlausible = widthAnchorRange
                ? roomDimensions.lengthFt >= widthAnchorRange.min && roomDimensions.lengthFt <= widthAnchorRange.max
                : (roomDimensions.lengthFt >= 5.8 && roomDimensions.lengthFt <= 6.8);
              widthBlend = widthAlreadyPlausible && targetWidthInflation > 1.1
                ? 0.10
                : (currentArea < minExpectedArea ? 0.82 : 0.68);
              if (lengthAlreadyPlausible && targetLengthInflation > 1.15) {
                lengthBlend = 0.08;
              } else if (roomDimensions.lengthFt >= 5.2 && targetLengthInflation > 1.1) {
                lengthBlend = currentArea < minExpectedArea ? 0.22 : 0.16;
              } else {
                lengthBlend = currentArea < minExpectedArea ? 0.50 : 0.42;
              }
              if (protectedAxis === 'width' && widthAlreadyPlausible && targetWidthInflation > 1.08) {
                widthBlend = Math.min(widthBlend, currentArea < minExpectedArea ? 0.14 : 0.10);
              }
              if (protectedAxis === 'length' && lengthAlreadyPlausible && targetLengthInflation > 1.08) {
                lengthBlend = Math.min(lengthBlend, currentArea < minExpectedArea ? 0.14 : 0.10);
              }
            }
          } else if (roomTypeKey === 'bathroom' && hasStrongBathroomAutoAnchors) {
            widthBlend = currentArea < minExpectedArea ? 0.80 : 0.66;
            lengthBlend = currentArea < minExpectedArea ? 0.42 : 0.34;
          } else if (LARGE_OPEN_ROOM_TYPES.has(roomTypeKey) && calibrationConsensusWeak && currentArea < minExpectedArea) {
            widthBlend = Math.max(widthBlend, 0.78);
            lengthBlend = Math.max(lengthBlend, 0.78);
          }
          roomDimensions.preVisionFallbackDimensions = {
            widthFt: roomDimensions.widthFt,
            lengthFt: roomDimensions.lengthFt,
            floorAreaSqFt: roomDimensions.floorAreaSqFt,
            methodology: roomDimensions.methodology,
          };
          roomDimensions.widthFt = Math.round((roomDimensions.widthFt * (1 - widthBlend) + targetWidth * widthBlend) * 10) / 10;
          roomDimensions.lengthFt = Math.round((roomDimensions.lengthFt * (1 - lengthBlend) + targetLength * lengthBlend) * 10) / 10;
          roomDimensions.heightFt = Math.round(((roomDimensions.heightFt || 8) * 0.75 + (e.heightFt || roomDimensions.heightFt || 8) * 0.25) * 10) / 10;
          roomDimensions.floorAreaSqFt = Math.round(roomDimensions.widthFt * roomDimensions.lengthFt);
          roomDimensions.perimeterFt = Math.round(2 * (roomDimensions.widthFt + roomDimensions.lengthFt));
          roomDimensions.wallAreaSqFt = Math.round(roomDimensions.perimeterFt * roomDimensions.heightFt);
          roomDimensions.visionFallbackUsed = true;
          roomDimensions.visionFallbackReason = 'weak_calibration_consensus_room_envelope_prior';
        }

        if (!preserveCompactGeometryAssist && roomTypeKey === 'bathroom' && Number.isFinite(internalBathroomWidthAnchorFt) && internalBathroomWidthAnchorFt > 0) {
          const shorterKey = roomDimensions.widthFt <= roomDimensions.lengthFt ? 'widthFt' : 'lengthFt';
          const currentShorter = Number(roomDimensions[shorterKey]) || 0;
          const anchorMin = Math.max(4.4, internalBathroomWidthAnchorFt * 0.94);
          const anchorMax = Math.min(6.2, internalBathroomWidthAnchorFt * 1.12);
          if (currentShorter > 0 && (currentShorter < anchorMin || currentShorter > anchorMax)) {
            const targetShorter = Math.min(anchorMax, Math.max(anchorMin, internalBathroomWidthAnchorFt));
            roomDimensions[shorterKey] = Math.round((currentShorter * 0.22 + targetShorter * 0.78) * 10) / 10;
            roomDimensions.internalWidthAnchorRegularized = {
              anchorFt: Math.round(internalBathroomWidthAnchorFt * 10) / 10,
              previousShorterFt: currentShorter,
              adjustedShorterFt: roomDimensions[shorterKey],
            };
            roomDimensions.floorAreaSqFt = Math.round(roomDimensions.widthFt * roomDimensions.lengthFt);
            roomDimensions.perimeterFt = Math.round(2 * (roomDimensions.widthFt + roomDimensions.lengthFt));
            roomDimensions.wallAreaSqFt = Math.round(roomDimensions.perimeterFt * roomDimensions.heightFt);
          }
        }

        if (roomTypeKey === 'bathroom' && Number.isFinite(internalBathroomWidthAnchorFt) && internalBathroomWidthAnchorFt > 0 && visionPlausible && !powderRoomLikeBathroom) {
          const shorterKey = roomDimensions.widthFt <= roomDimensions.lengthFt ? 'widthFt' : 'lengthFt';
          const longerKey = shorterKey === 'widthFt' ? 'lengthFt' : 'widthFt';
          const currentShorter = Number(roomDimensions[shorterKey]) || 0;
          const currentLonger = Number(roomDimensions[longerKey]) || 0;
          const targetShorter = Math.min(5.8, Math.max(4.6, internalBathroomWidthAnchorFt));
          const visionLongerSpan = Math.max(visionWidth, visionLength);
          const preVisionLonger = roomDimensions.preVisionFallbackDimensions
            ? Math.max(
                Number(roomDimensions.preVisionFallbackDimensions.widthFt) || 0,
                Number(roomDimensions.preVisionFallbackDimensions.lengthFt) || 0,
              )
            : currentLonger;
          const targetLongerCap = Math.max(targetShorter * 1.72, preVisionLonger * 1.45);
          const targetLonger = Math.max(currentLonger, Math.min(visionLongerSpan, targetLongerCap));
          const impliedTargetArea = targetShorter * targetLonger;
          const compressedLongSide = currentShorter > 0
            && currentLonger > 0
            && targetLonger > targetShorter * 1.35
            && currentLonger < targetLonger * 0.94
            && roomDimensions.floorAreaSqFt < impliedTargetArea * 0.92;

          if (compressedLongSide) {
            const previousShorterFt = currentShorter;
            const previousLongerFt = currentLonger;
            roomDimensions[shorterKey] = Math.round((currentShorter * 0.30 + targetShorter * 0.70) * 10) / 10;
            roomDimensions[longerKey] = Math.round((currentLonger * 0.18 + targetLonger * 0.82) * 10) / 10;
            roomDimensions.bathroomFootprintRegularized = {
              anchorFt: Math.round(targetShorter * 10) / 10,
              visionLongerFt: Math.round(visionLongerSpan * 10) / 10,
              targetLongerFt: Math.round(targetLonger * 10) / 10,
              previousShorterFt,
              previousLongerFt,
              adjustedShorterFt: roomDimensions[shorterKey],
              adjustedLongerFt: roomDimensions[longerKey],
            };
            roomDimensions.floorAreaSqFt = Math.round(roomDimensions.widthFt * roomDimensions.lengthFt);
            roomDimensions.perimeterFt = Math.round(2 * (roomDimensions.widthFt + roomDimensions.lengthFt));
            roomDimensions.wallAreaSqFt = Math.round(roomDimensions.perimeterFt * roomDimensions.heightFt);
          }
        }

        // Recalculate wall areas from DAv3 dimensions (not GPT-4o)
        const dav3WallAreaGross = Math.round(2 * (roomDimensions.widthFt + roomDimensions.lengthFt) * roomDimensions.heightFt);
        // Use GPT-4o opening PERCENTAGE (more reliable than absolute sq ft)
        // since GPT-4o may hallucinate dimensions but the ratio of openings to wall is more consistent
        const gptOpeningPct = (e.wallAreaGrossSqFt > 0 && e.wallOpeningAreaSqFt >= 0)
          ? Math.min(0.35, e.wallOpeningAreaSqFt / e.wallAreaGrossSqFt)
          : 0;
        const estimatedOpeningArea = Math.round(dav3WallAreaGross * gptOpeningPct);

        roomDimensions = {
          ...roomDimensions,
          ceilingAreaSqFt: roomDimensions.floorAreaSqFt,
          wallAreaGrossSqFt: dav3WallAreaGross,
          wallOpeningAreaSqFt: estimatedOpeningArea,
          wallAreaSqFt: Math.max(50, dav3WallAreaGross - estimatedOpeningArea),
          wallAreaIncludesOpenings: false,
          methodology: roomDimensions.visionFallbackUsed
            ? (roomDimensions.geometryAssistUsed ? 'dav3_metric_with_room_geometry_assist + gpt_room_envelope_fallback' : 'dav3_metric_with_gpt_room_envelope_fallback')
            : (roomDimensions.geometryAssistUsed ? 'dav3_metric_with_room_geometry_assist + gpt4o_openings' : 'dav3_metric_with_gpt4o_openings'),
          roomEnvelopeConfidence: e.confidence,
          sourceModels: {
            roomDimensions: roomDimensions.geometryAssistUsed
              ? `depth-anything-v3-metric + ${roomDimensions.geometryAssistSource}${roomDimensions.visionFallbackUsed ? ' + gpt-4o room envelope fallback' : ''}`
              : (roomDimensions.visionFallbackUsed ? 'depth-anything-v3-metric + gpt-4o room envelope fallback' : 'depth-anything-v3-metric'),
            wallOpenings: 'gpt-4o-vision (opening % only)',
            objectMeasurements: 'depth-anything-v3-metric',
          },
        };
      }

      if (roomDimensions.geometryAssistUsed && !String(roomDimensions.methodology || '').includes('room_geometry_assist')) {
        roomDimensions = {
          ...roomDimensions,
          methodology: 'dav3_metric_with_room_geometry_assist',
          sourceModels: {
            ...(roomDimensions.sourceModels || {}),
            roomDimensions: `depth-anything-v3-metric + ${roomDimensions.geometryAssistSource}`,
            objectMeasurements: 'depth-anything-v3-metric',
          },
        };
      }

      if (compactPowderRoomLikeBathroom) {
        const shorterKey = roomDimensions.widthFt <= roomDimensions.lengthFt ? 'widthFt' : 'lengthFt';
        const longerKey = shorterKey === 'widthFt' ? 'lengthFt' : 'widthFt';
        const currentShorter = Number(roomDimensions[shorterKey]) || 0;
        const currentLonger = Number(roomDimensions[longerKey]) || 0;
        const targetShorterBase = compactVanityWidthFt > 0 && compactVanityWidthFt <= 2.6
          ? compactVanityWidthFt * 1.95
          : internalBathroomWidthAnchorFt;
        const targetShorter = Math.min(4.2, Math.max(3.9, targetShorterBase || 4.0));
        const targetLonger = Math.min(4.6, Math.max(4.2, targetShorter * 1.08));
        const areaBlend = roomDimensions.floorAreaSqFt > 20 ? 0.78 : 0.60;

        if (currentShorter > targetShorter || currentLonger > targetLonger) {
          const previousShorterFt = currentShorter;
          const previousLongerFt = currentLonger;
          roomDimensions[shorterKey] = Math.round((currentShorter * (1 - areaBlend) + Math.min(currentShorter, targetShorter) * areaBlend) * 10) / 10;
          roomDimensions[longerKey] = Math.round((currentLonger * (1 - areaBlend) + Math.min(currentLonger, targetLonger) * areaBlend) * 10) / 10;
          roomDimensions.compactPowderRoomRegularized = {
            vanityWidthFt: compactVanityWidthFt > 0 ? Math.round(compactVanityWidthFt * 10) / 10 : null,
            toiletWidthFt: Math.round(compactToiletWidthFt * 10) / 10,
            targetShorterFt: Math.round(targetShorter * 10) / 10,
            targetLongerFt: Math.round(targetLonger * 10) / 10,
            previousShorterFt,
            previousLongerFt,
            adjustedShorterFt: roomDimensions[shorterKey],
            adjustedLongerFt: roomDimensions[longerKey],
          };
          roomDimensions.floorAreaSqFt = Math.round(roomDimensions.widthFt * roomDimensions.lengthFt);
          roomDimensions.perimeterFt = Math.round(2 * (roomDimensions.widthFt + roomDimensions.lengthFt));
          roomDimensions.wallAreaSqFt = Math.round(roomDimensions.perimeterFt * roomDimensions.heightFt);
        }
      }

      // Apply room-type-specific sanity clamps to catch wildly wrong estimates
      const roomSanity = {
        bathroom:    { maxFloor: 120, maxWidth: 15, maxLength: 15, typicalFloor: 60 },
        kitchen:     { maxFloor: 400, maxWidth: 25, maxLength: 25, typicalFloor: 150 },
        bedroom:     { maxFloor: 350, maxWidth: 22, maxLength: 22, typicalFloor: 150 },
        living_room: { maxFloor: 500, maxWidth: 30, maxLength: 30, typicalFloor: 250 },
        dining_room: { maxFloor: 300, maxWidth: 20, maxLength: 20, typicalFloor: 150 },
        hallway:     { maxFloor: 120, maxWidth: 8,  maxLength: 30, typicalFloor: 60 },
        foyer:       { maxFloor: 150, maxWidth: 15, maxLength: 15, typicalFloor: 60 },
        laundry:     { maxFloor: 80,  maxWidth: 10, maxLength: 10, typicalFloor: 40 },
      };
      const clamp = roomSanity[roomType];
      if (clamp && roomDimensions.floorAreaSqFt > clamp.maxFloor) {
        console.warn(`[PhotoMeasurement] ⚠️ ${roomType} floor ${roomDimensions.floorAreaSqFt} sq ft exceeds max ${clamp.maxFloor} — clamping to typical ${clamp.typicalFloor}`);
        roomDimensions.preClampDimensions = {
          widthFt: roomDimensions.widthFt,
          lengthFt: roomDimensions.lengthFt,
          heightFt: roomDimensions.heightFt,
          floorAreaSqFt: roomDimensions.floorAreaSqFt,
          perimeterFt: roomDimensions.perimeterFt,
          wallAreaSqFt: roomDimensions.wallAreaSqFt,
          methodology: roomDimensions.methodology,
        };
        roomDimensions.sanityClampReason = `floor_area_exceeded_${clamp.maxFloor}_sq_ft`;
        // Scale down proportionally to typical
        const scale = Math.sqrt(clamp.typicalFloor / roomDimensions.floorAreaSqFt);
        roomDimensions.widthFt = Math.round(roomDimensions.widthFt * scale * 10) / 10;
        roomDimensions.lengthFt = Math.round(roomDimensions.lengthFt * scale * 10) / 10;
        roomDimensions.floorAreaSqFt = Math.round(roomDimensions.widthFt * roomDimensions.lengthFt);
        roomDimensions.perimeterFt = Math.round(2 * (roomDimensions.widthFt + roomDimensions.lengthFt));
        roomDimensions.wallAreaSqFt = Math.round(roomDimensions.perimeterFt * roomDimensions.heightFt);
        if (roomDimensions.wallAreaGrossSqFt) {
          roomDimensions.wallAreaGrossSqFt = roomDimensions.wallAreaSqFt + (roomDimensions.wallOpeningAreaSqFt || 0);
        }
        roomDimensions.sanityClamped = true;
      }

      // Calculate exact material quantities from measured dimensions
      const materialItems = calculateMaterialQuantities(roomDimensions, roomType);
      const laborItems = calculateLaborItems(roomDimensions, roomType);

      let confidence = String(roomDimensions.methodology || '').includes('gpt4o_openings')
        ? (roomDimensions.roomEnvelopeConfidence === 'high'
            ? 'medium'
            : roomDimensions.roomEnvelopeConfidence === 'low'
              ? 'low'
              : 'medium')
        : consolidated.methodology === 'multi_photo_consolidated'
        ? (
            consolidated.consistency === 'high' && calibratedPhotoCount > 0
              ? 'high'
              : consolidated.consistency === 'low'
                ? 'low'
                : 'medium'
          )
        : consolidated.methodology === 'dav3_metric_calibrated'
          ? (photos[0].calibration?.calibrated ? 'high' : 'medium')
          : 'low';

      if (!captureProtocol.pass) {
        confidence = confidence === 'high' ? 'medium' : 'low';
      }

      if (roomDimensions.visionFallbackUsed && confidence === 'high') {
        confidence = 'medium';
      }

      if (roomDimensions.sanityClamped) {
        confidence = 'low';
      }

      const measurementTrust = evaluateRoomMeasurementTrust({
        roomType,
        roomDimensions,
        confidence,
        photos,
        captureProtocol,
      });

      const uncertainty = estimateMeasurementUncertainty(roomDimensions, confidence, photos[0].calibration, photos.length);

      const rangedMaterialItems = materialItems.map(item => ({
        ...item,
        quantityRange: {
          low: Math.max(0, Math.round(item.quantity * (1 - uncertainty.percent))),
          high: Math.max(1, Math.round(item.quantity * (1 + uncertainty.percent))),
        },
      }));

      const rangedLaborItems = laborItems.map(item => ({
        ...item,
        estimatedHoursRange: {
          low: Math.max(1, Math.round(item.estimatedHours * (1 - uncertainty.percent))),
          high: Math.max(1, Math.round(item.estimatedHours * (1 + uncertainty.percent))),
        },
      }));

      const roomResult = {
        roomType,
        dimensions: roomDimensions,
        materialItems: rangedMaterialItems,     // Full itemized material list + uncertainty ranges
        laborItems: rangedLaborItems,           // Full itemized labor list + uncertainty ranges
        materialQuantities: {}, // Legacy format
        calibration: photos[0].calibration,
        photoCount: photos.length,
        sourcePhotoIndexes: photos.map(p => p.photoIndex).filter(i => i >= 0), // Which input photos mapped to this room
        confidence,
        uncertainty,
        measurementTrust,
        trustedForPricing: measurementTrust.trustedForPricing,
      };

      results.measurementAudit.rooms.push({
        roomType,
        sourcePhotoIndexes: roomResult.sourcePhotoIndexes,
        dimensions: {
          widthFt: roomDimensions.widthFt,
          lengthFt: roomDimensions.lengthFt,
          heightFt: roomDimensions.heightFt,
          floorAreaSqFt: roomDimensions.floorAreaSqFt,
          preGeometryAssistDimensions: roomDimensions.preGeometryAssistDimensions || null,
          preClampDimensions: roomDimensions.preClampDimensions || null,
          preVisionFallbackDimensions: roomDimensions.preVisionFallbackDimensions || null,
        },
        geometryAssist: roomDimensions.geometryAssistDiagnostics || null,
        confidence,
        trustedForPricing: measurementTrust.trustedForPricing,
        trustReasons: measurementTrust.reasons,
        calibration: summarizeCalibrationAudit(photos[0].calibration, photos[0].photoIndex),
        methodology: roomDimensions.methodology,
        sanityClamped: Boolean(roomDimensions.sanityClamped),
        visionFallbackUsed: Boolean(roomDimensions.visionFallbackUsed),
      });

      // Build legacy materialQuantities for backward compat
      for (const mat of rangedMaterialItems) {
        const key = mat.dbKey || mat.item.toLowerCase().replace(/[^a-z0-9]/g, '_');
        roomResult.materialQuantities[key] = {
          quantity: mat.quantity,
          unit: mat.unit,
          label: mat.item,
          low: mat.quantityRange?.low,
          high: mat.quantityRange?.high,
        };
      }

      results.rooms.push(roomResult);

      // Aggregate into top-level arrays
      results.measuredMaterials.push(...rangedMaterialItems.map(m => ({ ...m, room: roomType, confidence, uncertainty: uncertainty.percent })));
      results.measuredLabor.push(...rangedLaborItems.map(l => ({ ...l, room: roomType, confidence, uncertainty: uncertainty.percent })));

      // Merge into legacy top-level materialQuantities
      for (const [key, val] of Object.entries(roomResult.materialQuantities)) {
        results.materialQuantities[`${roomType}_${key}`] = { ...val, room: roomType };
      }
    }

    const rawObjectCount = results.objects.length;
    const consolidatedObjects = consolidateObjectMeasurements(results.objects);
    const canonicalObjects = salvageBathroomShowerObjects(collapseDuplicateBathroomMirrorObjects(consolidatedObjects), results.rooms);
    results.measurementAudit.objectConsolidation = {
      rawObjectCount,
      consolidatedObjectCount: canonicalObjects.length,
      reducedObjectCount: Math.max(0, rawObjectCount - canonicalObjects.length),
      collapsedMirrorDuplicates: Math.max(0, consolidatedObjects.length - canonicalObjects.length),
      clusters: canonicalObjects.map(obj => ({
        roomType: obj.roomType,
        type: obj.type,
        trustedForPricing: obj.trustedForPricing,
        consolidatedFromCount: obj.consolidatedFromCount || 1,
        sourcePhotoIndexes: obj.sourcePhotoIndexes || (Number.isInteger(obj.photoIndex) ? [obj.photoIndex] : []),
      })),
    };
    results.objects = canonicalObjects.filter(shouldKeepConsolidatedObject);
    applyBathroomRoomSpanRegularization(results);
    results.appliances = results.objects
      .filter(obj => obj.applianceFit)
      .map(obj => ({
        type: obj.type,
        roomType: obj.roomType,
        ...obj.applianceFit,
      }));

    // STEP 6: Cross-validate against listing sq ft
    if (options.totalPropertySqFt && results.rooms.length > 0) {
      const measuredTotal = results.rooms.reduce((sum, r) => sum + r.dimensions.floorAreaSqFt, 0);
      const ratio = options.totalPropertySqFt / measuredTotal;
      results.crossValidation = {
        measuredTotalSqFt: measuredTotal,
        listingTotalSqFt: options.totalPropertySqFt,
        ratio: Math.round(ratio * 100) / 100,
        note: ratio > 1.3 ? `Measured ${results.rooms.length} of ~${Math.round(results.rooms.length * ratio)} rooms`
          : ratio < 0.7 ? 'Measurements exceed listing — may need recalibration'
          : 'Consistent with listing data',
      };
    }

    results.measurementAudit.trustSummary = {
      trustedRoomsForPricing: results.rooms.filter(r => r.trustedForPricing).length,
      totalRooms: results.rooms.length,
      trustedObjectsForPricing: results.objects.filter(o => o.trustedForPricing).length,
      totalObjects: results.objects.length,
      untrustedRoomReasons: results.rooms
        .filter(r => !r.trustedForPricing)
        .map(r => ({ roomType: r.roomType, reasons: r.measurementTrust?.reasons || [] })),
    };
    results.trustSummary = results.measurementAudit.trustSummary;

    results.processingTime = Date.now() - startTime;
    console.log(`[PhotoMeasurement] ✓ Complete: ${results.rooms.length} rooms, ${results.objects.length} objects, ${results.measuredMaterials.length} material items, ${results.measuredLabor.length} labor tasks in ${results.processingTime}ms`);
    return results;

  } catch (error) {
    console.error('[PhotoMeasurement] Fatal error:', error);
    return {
      ok: false, error: error.message, rooms: [], objects: [], appliances: [],
      measuredMaterials: [], measuredLabor: [], materialQuantities: {},
      processingTime: Date.now() - startTime,
    };
  }
}
