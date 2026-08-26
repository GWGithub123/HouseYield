export const roomMeasurementBenchmarkCases = [
  {
    id: 'bathroom-new-images2',
    description: 'Validated bathroom benchmark for vanity, toilet, shower, and room footprint.',
    dir: 'test-images/new bathroom images2',
    options: {
      totalPropertySqFt: 1800,
      measurementMode: 'hybrid',
    },
    thresholds: {
      maxErrorPct: 10,
    },
    room: {
      shortSideFt: 5.0,
      longSideFt: 94 / 12,
      areaSqFt: (60 * 64 + 60 * 30) / 144,
    },
    objects: {
      existing_vanity: {
        required: true,
        widthInches: 60,
        heightInches: 31,
      },
      existing_toilet: {
        required: true,
        widthInches: 16,
        heightInches: 30,
      },
      shower_door_opening: {
        required: true,
        widthInches: 57,
        heightInches: 56,
      },
    },
  },
  {
    id: 'downstairs-bathroom-diagnostic',
    description: 'Diagnostic half-bath benchmark tracking upstream vanity and compact room-footprint accuracy.',
    dir: 'test-images/Downstairs bathroom test images',
    requiredToPass: false,
    options: {
      totalPropertySqFt: 1800,
      measurementMode: 'hybrid',
    },
    thresholds: {
      maxErrorPct: 10,
      maxInitialErrorPct: 12,
      maxStabilityRangePct: 18,
    },
    room: {
      shortSideFt: 3.75,
      longSideFt: 13 / 3,
      areaSqFt: 16.25,
    },
    initialRoom: {
      shortSideFt: 3.75,
      longSideFt: 13 / 3,
      areaSqFt: 16.25,
    },
    objects: {
      existing_vanity: {
        required: true,
        widthInches: 25,
        heightInches: 33,
      },
    },
    initialObjects: {
      existing_vanity: {
        required: true,
        widthInches: 25,
        heightInches: 33,
      },
    },
  },
  {
    id: 'basement-diagnostic',
    description: 'Diagnostic finished-basement benchmark tracking pre-fallback and final large-room accuracy.',
    dir: 'test-images/Basement test Images',
    requiredToPass: false,
    options: {
      totalPropertySqFt: 1800,
      measurementMode: 'hybrid',
    },
    thresholds: {
      maxErrorPct: 10,
      maxInitialErrorPct: 18,
      maxStabilityRangePct: 15,
    },
    room: {
      shortSideFt: 15.5,
      longSideFt: 17.5,
      areaSqFt: 271.25,
    },
    initialRoom: {
      shortSideFt: 15.5,
      longSideFt: 17.5,
      areaSqFt: 271.25,
    },
  },
];

export function getRoomMeasurementBenchmarkCase(caseId) {
  return roomMeasurementBenchmarkCases.find(benchmarkCase => benchmarkCase.id === caseId) || null;
}