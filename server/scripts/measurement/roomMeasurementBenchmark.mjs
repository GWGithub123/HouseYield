import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { measureFromPhotos } from '../../services/photoMeasurementService.js';
import { getRoomMeasurementBenchmarkCase, roomMeasurementBenchmarkCases } from './roomMeasurementBenchmarkCases.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

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
    caseIds: [],
    repeat: 2,
    writeReport: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--case') {
      options.caseIds.push(argv[++index] || '');
    } else if (value === '--repeat') {
      options.repeat = Math.max(1, Math.min(10, Number(argv[++index]) || 2));
    } else if (value === '--write-report') {
      options.writeReport = argv[++index] || null;
    } else if (value === '--help' || value === '-h') {
      options.help = true;
    }
  }

  return options;
}

function usage() {
  console.log([
    'Usage: node server/scripts/measurement/roomMeasurementBenchmark.mjs [--case <case-id>] [--repeat 2] [--write-report <path>]',
    '',
    'Available cases:',
    ...roomMeasurementBenchmarkCases.map(benchmarkCase => `  - ${benchmarkCase.id}: ${benchmarkCase.description}`),
  ].join('\n'));
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

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function calculateErrorPct(expectedValue, measuredValue) {
  if (!Number.isFinite(expectedValue) || !Number.isFinite(measuredValue) || expectedValue <= 0) return null;
  return round((Math.abs(measuredValue - expectedValue) / expectedValue) * 100, 1);
}

function normalizeRoomDimensions(roomDimensions) {
  if (!roomDimensions) return null;
  return {
    widthFt: round(Number(roomDimensions.widthFt) || 0, 3),
    lengthFt: round(Number(roomDimensions.lengthFt) || 0, 3),
    floorAreaSqFt: round(Number(roomDimensions.floorAreaSqFt) || 0, 3),
  };
}

function buildRoomMetrics(roomDimensions, roomExpectation) {
  if (!roomDimensions || !roomExpectation) {
    return {
      expected: Boolean(roomExpectation),
      present: false,
      measured: null,
      errors: {
        shortSidePct: null,
        longSidePct: null,
        areaPct: null,
      },
    };
  }

  const normalizedDimensions = normalizeRoomDimensions(roomDimensions);
  const orderedSides = [normalizedDimensions.widthFt || 0, normalizedDimensions.lengthFt || 0].sort((first, second) => first - second);
  return {
    expected: true,
    present: true,
    measured: normalizedDimensions,
    errors: {
      shortSidePct: calculateErrorPct(roomExpectation.shortSideFt, orderedSides[0]),
      longSidePct: calculateErrorPct(roomExpectation.longSideFt, orderedSides[1]),
      areaPct: calculateErrorPct(roomExpectation.areaSqFt, normalizedDimensions.floorAreaSqFt || 0),
    },
  };
}

function selectInitialRoomDimensions(result) {
  const room = result.rooms?.[0] || null;
  const roomAudit = (result.measurementAudit?.rooms || []).find(entry => entry?.roomType === room?.roomType)
    || result.measurementAudit?.rooms?.[0]
    || null;
  return roomAudit?.dimensions?.preVisionFallbackDimensions
    || roomAudit?.dimensions?.preClampDimensions
    || room?.dimensions
    || null;
}

function buildObjectMetrics(resultObjects, objectExpectations = {}, dimensionSelector = object => object?.dimensions) {
  const objectsByType = Object.fromEntries((resultObjects || []).map(object => [object.type, object]));

  return Object.entries(objectExpectations).reduce((accumulator, [objectType, expectation]) => {
    const object = objectsByType[objectType] || null;
    const selectedDimensions = object ? dimensionSelector(object) : null;
    accumulator[objectType] = {
      required: Boolean(expectation?.required),
      present: Boolean(selectedDimensions),
      measured: selectedDimensions ? {
        widthInches: round(Number(selectedDimensions.widthInches) || 0, 3),
        heightInches: round(Number(selectedDimensions.heightInches) || 0, 3),
      } : null,
      errors: {
        widthPct: calculateErrorPct(expectation?.widthInches, Number(selectedDimensions?.widthInches) || 0),
        heightPct: calculateErrorPct(expectation?.heightInches, Number(selectedDimensions?.heightInches) || 0),
      },
    };
    return accumulator;
  }, {});
}

function summarizeWorstErrors(runReports = []) {
  const summary = {
    failedRuns: [],
    room: {
      missing: false,
      shortSidePct: null,
      longSidePct: null,
      areaPct: null,
    },
    initialRoom: {
      missing: false,
      shortSidePct: null,
      longSidePct: null,
      areaPct: null,
    },
    objects: {},
    initialObjects: {},
    missingRequiredObjects: [],
    missingRequiredInitialObjects: [],
  };

  for (const run of runReports) {
    if (!run.ok || run.error) {
      summary.failedRuns.push({
        attempt: run.attempt,
        error: run.error || 'measureFromPhotos returned ok=false',
      });
    }

    const roomErrors = run.room?.errors || {};
    if (run.room?.expected && !run.room?.present) {
      summary.room.missing = true;
    }
    summary.room.shortSidePct = Math.max(summary.room.shortSidePct ?? 0, roomErrors.shortSidePct ?? 0);
    summary.room.longSidePct = Math.max(summary.room.longSidePct ?? 0, roomErrors.longSidePct ?? 0);
    summary.room.areaPct = Math.max(summary.room.areaPct ?? 0, roomErrors.areaPct ?? 0);

    const initialRoomErrors = run.initialRoom?.errors || {};
    if (run.initialRoom?.expected && !run.initialRoom?.present) {
      summary.initialRoom.missing = true;
    }
    summary.initialRoom.shortSidePct = Math.max(summary.initialRoom.shortSidePct ?? 0, initialRoomErrors.shortSidePct ?? 0);
    summary.initialRoom.longSidePct = Math.max(summary.initialRoom.longSidePct ?? 0, initialRoomErrors.longSidePct ?? 0);
    summary.initialRoom.areaPct = Math.max(summary.initialRoom.areaPct ?? 0, initialRoomErrors.areaPct ?? 0);

    for (const [objectType, objectMetrics] of Object.entries(run.objects || {})) {
      if (!summary.objects[objectType]) {
        summary.objects[objectType] = {
          widthPct: null,
          heightPct: null,
        };
      }
      summary.objects[objectType].widthPct = Math.max(summary.objects[objectType].widthPct ?? 0, objectMetrics.errors?.widthPct ?? 0);
      summary.objects[objectType].heightPct = Math.max(summary.objects[objectType].heightPct ?? 0, objectMetrics.errors?.heightPct ?? 0);

      if (objectMetrics.required && !objectMetrics.present && !summary.missingRequiredObjects.includes(objectType)) {
        summary.missingRequiredObjects.push(objectType);
      }
    }

    for (const [objectType, objectMetrics] of Object.entries(run.initialObjects || {})) {
      if (!summary.initialObjects[objectType]) {
        summary.initialObjects[objectType] = {
          widthPct: null,
          heightPct: null,
        };
      }
      summary.initialObjects[objectType].widthPct = Math.max(summary.initialObjects[objectType].widthPct ?? 0, objectMetrics.errors?.widthPct ?? 0);
      summary.initialObjects[objectType].heightPct = Math.max(summary.initialObjects[objectType].heightPct ?? 0, objectMetrics.errors?.heightPct ?? 0);

      if (objectMetrics.required && !objectMetrics.present && !summary.missingRequiredInitialObjects.includes(objectType)) {
        summary.missingRequiredInitialObjects.push(objectType);
      }
    }
  }

  return summary;
}

function calculateRangePct(values = [], baseline = null) {
  const numeric = values.map(value => Number(value)).filter(Number.isFinite);
  if (numeric.length < 2) return null;
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const denominator = Number.isFinite(baseline) && baseline > 0
    ? baseline
    : (numeric.reduce((sum, value) => sum + value, 0) / numeric.length);
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return round(((max - min) / denominator) * 100, 1);
}

function getOrderedRoomSides(roomMetrics) {
  if (!roomMetrics?.measured) return null;
  return [Number(roomMetrics.measured.widthFt) || 0, Number(roomMetrics.measured.lengthFt) || 0].sort((first, second) => first - second);
}

function summarizeStability(runReports = [], benchmarkCase = {}) {
  const summary = {
    room: {
      shortSidePct: null,
      longSidePct: null,
      areaPct: null,
    },
    initialRoom: {
      shortSidePct: null,
      longSidePct: null,
      areaPct: null,
    },
    objects: {},
    initialObjects: {},
  };

  const roomSidePairs = runReports.map(run => getOrderedRoomSides(run.room)).filter(Boolean);
  summary.room.shortSidePct = calculateRangePct(roomSidePairs.map(pair => pair[0]), benchmarkCase.room?.shortSideFt);
  summary.room.longSidePct = calculateRangePct(roomSidePairs.map(pair => pair[1]), benchmarkCase.room?.longSideFt);
  summary.room.areaPct = calculateRangePct(runReports.map(run => run.room?.measured?.floorAreaSqFt), benchmarkCase.room?.areaSqFt);

  const initialRoomSidePairs = runReports.map(run => getOrderedRoomSides(run.initialRoom)).filter(Boolean);
  summary.initialRoom.shortSidePct = calculateRangePct(initialRoomSidePairs.map(pair => pair[0]), benchmarkCase.initialRoom?.shortSideFt);
  summary.initialRoom.longSidePct = calculateRangePct(initialRoomSidePairs.map(pair => pair[1]), benchmarkCase.initialRoom?.longSideFt);
  summary.initialRoom.areaPct = calculateRangePct(runReports.map(run => run.initialRoom?.measured?.floorAreaSqFt), benchmarkCase.initialRoom?.areaSqFt);

  for (const [objectType, expectation] of Object.entries(benchmarkCase.objects || {})) {
    summary.objects[objectType] = {
      widthPct: calculateRangePct(
        runReports.map(run => run.objects?.[objectType]?.measured?.widthInches),
        expectation?.widthInches,
      ),
      heightPct: calculateRangePct(
        runReports.map(run => run.objects?.[objectType]?.measured?.heightInches),
        expectation?.heightInches,
      ),
    };
  }

  for (const [objectType, expectation] of Object.entries(benchmarkCase.initialObjects || {})) {
    summary.initialObjects[objectType] = {
      widthPct: calculateRangePct(
        runReports.map(run => run.initialObjects?.[objectType]?.measured?.widthInches),
        expectation?.widthInches,
      ),
      heightPct: calculateRangePct(
        runReports.map(run => run.initialObjects?.[objectType]?.measured?.heightInches),
        expectation?.heightInches,
      ),
    };
  }

  return summary;
}

function evaluateCasePass(benchmarkCase, worstErrors, stability) {
  const maxErrorPct = Number(benchmarkCase?.thresholds?.maxErrorPct || 10);
  const maxInitialErrorPct = Number(benchmarkCase?.thresholds?.maxInitialErrorPct || maxErrorPct);
  const maxStabilityRangePct = Number.isFinite(Number(benchmarkCase?.thresholds?.maxStabilityRangePct))
    ? Number(benchmarkCase.thresholds.maxStabilityRangePct)
    : null;
  const failures = [];

  if (worstErrors.failedRuns.length) failures.push('run.error');
  if (benchmarkCase.room && worstErrors.room.missing) failures.push('room.missing');
  if ((worstErrors.room.shortSidePct ?? 0) > maxErrorPct) failures.push(`room.shortSidePct>${maxErrorPct}`);
  if ((worstErrors.room.longSidePct ?? 0) > maxErrorPct) failures.push(`room.longSidePct>${maxErrorPct}`);
  if ((worstErrors.room.areaPct ?? 0) > maxErrorPct) failures.push(`room.areaPct>${maxErrorPct}`);
  if (benchmarkCase.initialRoom && worstErrors.initialRoom.missing) failures.push('initialRoom.missing');
  if ((worstErrors.initialRoom.shortSidePct ?? 0) > maxInitialErrorPct) failures.push(`initialRoom.shortSidePct>${maxInitialErrorPct}`);
  if ((worstErrors.initialRoom.longSidePct ?? 0) > maxInitialErrorPct) failures.push(`initialRoom.longSidePct>${maxInitialErrorPct}`);
  if ((worstErrors.initialRoom.areaPct ?? 0) > maxInitialErrorPct) failures.push(`initialRoom.areaPct>${maxInitialErrorPct}`);

  for (const [objectType, expectation] of Object.entries(benchmarkCase.objects || {})) {
    if (expectation?.required && worstErrors.missingRequiredObjects.includes(objectType)) {
      failures.push(`${objectType}.missing`);
      continue;
    }
    const objectErrors = worstErrors.objects[objectType];
    if (!objectErrors) continue;
    if ((objectErrors.widthPct ?? 0) > maxErrorPct) failures.push(`${objectType}.widthPct>${maxErrorPct}`);
    if ((objectErrors.heightPct ?? 0) > maxErrorPct) failures.push(`${objectType}.heightPct>${maxErrorPct}`);
  }

  for (const [objectType, expectation] of Object.entries(benchmarkCase.initialObjects || {})) {
    if (expectation?.required && worstErrors.missingRequiredInitialObjects.includes(objectType)) {
      failures.push(`initial.${objectType}.missing`);
      continue;
    }
    const objectErrors = worstErrors.initialObjects[objectType];
    if (!objectErrors) continue;
    if ((objectErrors.widthPct ?? 0) > maxInitialErrorPct) failures.push(`initial.${objectType}.widthPct>${maxInitialErrorPct}`);
    if ((objectErrors.heightPct ?? 0) > maxInitialErrorPct) failures.push(`initial.${objectType}.heightPct>${maxInitialErrorPct}`);
  }

  if (Number.isFinite(maxStabilityRangePct) && maxStabilityRangePct > 0) {
    if ((stability?.room?.shortSidePct ?? 0) > maxStabilityRangePct) failures.push(`stability.room.shortSidePct>${maxStabilityRangePct}`);
    if ((stability?.room?.longSidePct ?? 0) > maxStabilityRangePct) failures.push(`stability.room.longSidePct>${maxStabilityRangePct}`);
    if ((stability?.room?.areaPct ?? 0) > maxStabilityRangePct) failures.push(`stability.room.areaPct>${maxStabilityRangePct}`);
    if ((stability?.initialRoom?.shortSidePct ?? 0) > maxStabilityRangePct) failures.push(`stability.initialRoom.shortSidePct>${maxStabilityRangePct}`);
    if ((stability?.initialRoom?.longSidePct ?? 0) > maxStabilityRangePct) failures.push(`stability.initialRoom.longSidePct>${maxStabilityRangePct}`);
    if ((stability?.initialRoom?.areaPct ?? 0) > maxStabilityRangePct) failures.push(`stability.initialRoom.areaPct>${maxStabilityRangePct}`);

    for (const [objectType, objectStability] of Object.entries(stability?.objects || {})) {
      if ((objectStability?.widthPct ?? 0) > maxStabilityRangePct) failures.push(`stability.${objectType}.widthPct>${maxStabilityRangePct}`);
      if ((objectStability?.heightPct ?? 0) > maxStabilityRangePct) failures.push(`stability.${objectType}.heightPct>${maxStabilityRangePct}`);
    }
    for (const [objectType, objectStability] of Object.entries(stability?.initialObjects || {})) {
      if ((objectStability?.widthPct ?? 0) > maxStabilityRangePct) failures.push(`stability.initial.${objectType}.widthPct>${maxStabilityRangePct}`);
      if ((objectStability?.heightPct ?? 0) > maxStabilityRangePct) failures.push(`stability.initial.${objectType}.heightPct>${maxStabilityRangePct}`);
    }
  }

  return {
    pass: failures.length === 0,
    failures,
  };
}

async function runBenchmarkCase(benchmarkCase, repeat) {
  const imageDir = path.resolve(repoRoot, benchmarkCase.dir);
  const images = await loadImagesFromDir(imageDir);
  const runReports = [];

  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const result = await measureFromPhotos(images, {
      ...(benchmarkCase.options || {}),
    });
    const roomDimensions = result.rooms?.[0]?.dimensions || null;
    const initialRoomDimensions = selectInitialRoomDimensions(result);
    runReports.push({
      attempt,
      room: buildRoomMetrics(roomDimensions, benchmarkCase.room),
      initialRoom: buildRoomMetrics(initialRoomDimensions, benchmarkCase.initialRoom),
      objects: buildObjectMetrics(result.objects || [], benchmarkCase.objects),
      initialObjects: buildObjectMetrics(
        result.objects || [],
        benchmarkCase.initialObjects,
        object => object?.measurementGeometry?.preNormalizationDimensions || null,
      ),
      objectsPresent: (result.objects || []).map(object => object.type),
      ok: Boolean(result.ok),
      error: result.error || null,
    });
  }

  const worstErrors = summarizeWorstErrors(runReports);
  const stability = summarizeStability(runReports, benchmarkCase);
  const evaluation = evaluateCasePass(benchmarkCase, worstErrors, stability);
  const requiredToPass = benchmarkCase.requiredToPass !== false;

  return {
    id: benchmarkCase.id,
    description: benchmarkCase.description,
    dir: imageDir,
    imageCount: images.length,
    repeat,
    requiredToPass,
    thresholds: benchmarkCase.thresholds,
    pass: evaluation.pass,
    failures: evaluation.failures,
    worstErrors,
    stability,
    runs: runReports,
  };
}

async function writeReportIfRequested(reportPath, payload) {
  if (!reportPath) return;
  const resolvedPath = path.resolve(process.cwd(), reportPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }

  const selectedCases = options.caseIds.length
    ? options.caseIds.map(caseId => {
        const benchmarkCase = getRoomMeasurementBenchmarkCase(caseId);
        if (!benchmarkCase) {
          throw new Error(`Unknown benchmark case: ${caseId}`);
        }
        return benchmarkCase;
      })
    : roomMeasurementBenchmarkCases;

  if (!selectedCases.length) {
    throw new Error('No benchmark cases selected');
  }

  const caseReports = [];
  for (const benchmarkCase of selectedCases) {
    caseReports.push(await runBenchmarkCase(benchmarkCase, options.repeat));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    repeat: options.repeat,
    summary: {
      totalCases: caseReports.length,
      gatingCases: caseReports.filter(report => report.requiredToPass).length,
      diagnosticCases: caseReports.filter(report => !report.requiredToPass).length,
      passedCases: caseReports.filter(report => report.pass).length,
      failedCases: caseReports.filter(report => !report.pass).length,
      passedGatingCases: caseReports.filter(report => report.requiredToPass && report.pass).length,
      failedGatingCases: caseReports.filter(report => report.requiredToPass && !report.pass).length,
    },
    cases: caseReports,
  };

  await writeReportIfRequested(options.writeReport, payload);
  console.log(JSON.stringify(payload, null, 2));

  if (caseReports.some(report => report.requiredToPass && !report.pass)) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`[roomMeasurementBenchmark] ${error.message}`);
  process.exit(1);
});