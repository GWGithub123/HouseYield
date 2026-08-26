const RENOVATION_MEASUREMENT_API_URL = String(process.env.RENOVATION_MEASUREMENT_API_URL || '').trim().replace(/\/+$/, '');
const RENOVATION_MEASUREMENT_API_KEY = String(process.env.RENOVATION_MEASUREMENT_API_KEY || '').trim();
const RENOVATION_MEASUREMENT_API_TIMEOUT_MS = Number(process.env.RENOVATION_MEASUREMENT_API_TIMEOUT_MS || 600000);
const RENOVATION_MEASUREMENT_API_ALLOW_LOCAL_FALLBACK = process.env.RENOVATION_MEASUREMENT_API_ALLOW_LOCAL_FALLBACK === 'true';

function buildRenovationMeasurementVmUrl(endpointPath) {
  const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  return `${RENOVATION_MEASUREMENT_API_URL}${normalizedPath}`;
}

export function isRenovationMeasurementVmEnabled() {
  return Boolean(RENOVATION_MEASUREMENT_API_URL);
}

export function shouldAllowLocalMeasurementFallback() {
  return RENOVATION_MEASUREMENT_API_ALLOW_LOCAL_FALLBACK;
}

async function postToRenovationMeasurementVm(endpointPath, payload) {
  if (!isRenovationMeasurementVmEnabled()) {
    throw new Error('Renovation measurement VM is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RENOVATION_MEASUREMENT_API_TIMEOUT_MS);
  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (RENOVATION_MEASUREMENT_API_KEY) {
      headers.Authorization = `Bearer ${RENOVATION_MEASUREMENT_API_KEY}`;
      headers['X-API-Key'] = RENOVATION_MEASUREMENT_API_KEY;
    }

    const response = await fetch(buildRenovationMeasurementVmUrl(endpointPath), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Renovation measurement VM ${response.status}: ${errorText.slice(0, 240)}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function measureFromPhotosViaRenovationMeasurementVm(images, options = {}) {
  return postToRenovationMeasurementVm('/measure-from-photos', {
    images,
    options,
  });
}

export async function normalizeVisionImagesViaRenovationMeasurementVm(images) {
  return postToRenovationMeasurementVm('/normalize-images', {
    images,
  });
}