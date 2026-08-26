import fs from 'fs/promises';
import path from 'path';

import { measureFromPhotos } from '../../services/photoMeasurementService.js';

const SUPPORTED_IMAGE_EXTENSIONS = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
]);

function parseArgs(argv = []) {
  const options = {
    dir: null,
    repeat: 3,
    measurementMode: 'hybrid',
    totalPropertySqFt: 1800,
    visionConsensusPasses: null,
  };

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--dir') {
      options.dir = argv[++index] || null;
    } else if (value === '--repeat') {
      options.repeat = Math.max(1, Math.min(20, Number(argv[++index]) || 3));
    } else if (value === '--mode') {
      options.measurementMode = argv[++index] || 'hybrid';
    } else if (value === '--sqft') {
      options.totalPropertySqFt = Math.max(0, Number(argv[++index]) || 0);
    } else if (value === '--vision-consensus-passes') {
      options.visionConsensusPasses = Math.max(1, Math.min(3, Number(argv[++index]) || 1));
    } else if (value === '--help' || value === '-h') {
      options.help = true;
    }
  }

  return options;
}

function usage() {
  console.log(`Usage: node server/scripts/measurement/roomMeasurementStability.mjs --dir <image-folder> [--repeat 3] [--mode hybrid] [--sqft 1800] [--vision-consensus-passes 2]\n`);
}

async function loadImagesFromDir(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const imageFiles = entries
    .filter(entry => entry.isFile())
    .map(entry => ({
      name: entry.name,
      ext: path.extname(entry.name).toLowerCase(),
      fullPath: path.join(dirPath, entry.name),
    }))
    .filter(entry => SUPPORTED_IMAGE_EXTENSIONS.has(entry.ext))
    .sort((first, second) => first.name.localeCompare(second.name));

  if (!imageFiles.length) {
    throw new Error(`No supported images found in ${dirPath}`);
  }

  return Promise.all(imageFiles.map(async entry => {
    const buffer = await fs.readFile(entry.fullPath);
    return `data:${SUPPORTED_IMAGE_EXTENSIONS.get(entry.ext)};base64,${buffer.toString('base64')}`;
  }));
}

function mean(values = []) {
  const numeric = values.filter(Number.isFinite);
  if (!numeric.length) return null;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function standardDeviation(values = []) {
  const numeric = values.filter(Number.isFinite);
  if (numeric.length < 2) return 0;
  const avg = mean(numeric);
  const variance = numeric.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / numeric.length;
  return Math.sqrt(variance);
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.dir) {
    usage();
    process.exit(options.help ? 0 : 1);
  }

  const imageDir = path.resolve(process.cwd(), options.dir);
  const images = await loadImagesFromDir(imageDir);
  const runs = [];

  for (let attempt = 1; attempt <= options.repeat; attempt++) {
    const result = await measureFromPhotos(images, {
      totalPropertySqFt: options.totalPropertySqFt,
      measurementMode: options.measurementMode,
      ...(options.visionConsensusPasses ? { visionConsensusPasses: options.visionConsensusPasses } : {}),
    });
    const primaryRoom = result.rooms?.[0] || null;
    runs.push({
      attempt,
      roomType: primaryRoom?.roomType || null,
      widthFt: primaryRoom?.dimensions?.widthFt ?? null,
      lengthFt: primaryRoom?.dimensions?.lengthFt ?? null,
      floorAreaSqFt: primaryRoom?.dimensions?.floorAreaSqFt ?? null,
      trustedForPricing: Boolean(primaryRoom?.trustedForPricing),
      trustReasons: primaryRoom?.measurementTrust?.reasons || [],
      autoAnchors: result.measurementAudit?.autoInferredReferenceAnchors?.added || 0,
      globalCalibrationAvailable: Boolean(result.globalCalibration?.available),
      globalCalibrationConsistency: result.globalCalibration?.consistency || null,
      globalCalibrationAnchorTypes: result.globalCalibration?.consensus?.anchorTypes || [],
      globalCalibrationCount: result.globalCalibration?.count || 0,
    });
  }

  const widths = runs.map(run => run.widthFt).filter(Number.isFinite);
  const lengths = runs.map(run => run.lengthFt).filter(Number.isFinite);
  const areas = runs.map(run => run.floorAreaSqFt).filter(Number.isFinite);
  const trustedRuns = runs.filter(run => run.trustedForPricing).length;
  const calibratedRuns = runs.filter(run => run.globalCalibrationAvailable).length;

  console.log(JSON.stringify({
    input: {
      dir: imageDir,
      imageCount: images.length,
      repeat: options.repeat,
      measurementMode: options.measurementMode,
      totalPropertySqFt: options.totalPropertySqFt,
      visionConsensusPasses: options.visionConsensusPasses,
    },
    summary: {
      trustedRunCount: trustedRuns,
      calibrationAvailableRunCount: calibratedRuns,
      widthFtMean: round(mean(widths), 3),
      widthFtStdDev: round(standardDeviation(widths), 3),
      lengthFtMean: round(mean(lengths), 3),
      lengthFtStdDev: round(standardDeviation(lengths), 3),
      floorAreaSqFtMean: round(mean(areas), 3),
      floorAreaSqFtStdDev: round(standardDeviation(areas), 3),
    },
    runs,
  }, null, 2));
}

main().catch(error => {
  console.error(`[roomMeasurementStability] ${error.message}`);
  process.exit(1);
});