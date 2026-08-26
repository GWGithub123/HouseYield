import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { initializeFirebaseAdmin } from '../firebase-admin.js';

const AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = firstDefined([
  process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
  process.env.AZURE_DOCUMENT_INTELLIGENCE_URL,
  process.env.AZURE_FORM_RECOGNIZER_ENDPOINT,
  process.env.FORM_RECOGNIZER_ENDPOINT,
  process.env.Microsoft_Azure_Endpoint,
  process.env.Microsoft_Azure_Document_Intelligence_Endpoint,
  process.env.Azure_Document_Intelligence_Endpoint,
  process.env.Azure_Form_Recognizer_Endpoint
]);

const AZURE_DOCUMENT_INTELLIGENCE_API_KEY = firstDefined([
  process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY,
  process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
  process.env.AZURE_FORM_RECOGNIZER_API_KEY,
  process.env.AZURE_FORM_RECOGNIZER_KEY,
  process.env.FORM_RECOGNIZER_API_KEY,
  process.env.Microsoft_Azure_API_Key1,
  process.env.Microsoft_Azure_API_Key,
  process.env.Microsoft_Azure_Document_Intelligence_API_Key,
  process.env.Azure_Document_Intelligence_API_Key,
  process.env.Azure_Document_Intelligence_Key,
  process.env.Azure_Form_Recognizer_API_Key,
  process.env.Azure_Form_Recognizer_Key
]);

const CLAUDE_API_KEY = firstDefined([
  process.env.Claude_API_Key,
  process.env.ANTHROPIC_API_KEY
]);

const CLAUDE_DOCUMENT_MODEL = process.env.CLAUDE_DOCUMENT_MODEL || 'claude-sonnet-4-20250514';
const AZURE_API_VERSION = process.env.AZURE_DOCUMENT_INTELLIGENCE_API_VERSION || '2024-11-30';

const anthropic = CLAUDE_API_KEY ? new Anthropic({ apiKey: CLAUDE_API_KEY }) : null;

const EXTENSION_TO_MIME = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic'
};

const AZURE_SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/bmp',
  'image/tiff',
  'image/heic'
]);

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/gif',
  'image/webp'
]);

function firstDefined(values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMimeType(mimeType = '') {
  return mimeType.split(';')[0].trim().toLowerCase();
}

function normalizeAzureEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, '');
}

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text || '';
  }

  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractClaudeText(response) {
  if (!response?.content || !Array.isArray(response.content)) {
    return '';
  }

  return response.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function extractJsonFromText(text) {
  if (!text) {
    return null;
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : text.trim();

  try {
    return JSON.parse(candidate);
  } catch {
    const jsonMatch = candidate.match(/\{[\s\S]*\}$/);
    if (!jsonMatch) {
      return null;
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

function cleanArray(values, maxItems = 20) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => {
      if (typeof value === 'string') {
        return value.trim();
      }
      if (value == null) {
        return '';
      }
      return JSON.stringify(value);
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeConfidence(value) {
  const number = toNumber(value, 0);
  if (number < 0) return 0;
  if (number > 1) return 1;
  return number;
}

function average(values, fallback = 0) {
  if (!Array.isArray(values) || values.length === 0) {
    return fallback;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function normalizeAzureSpans(value) {
  const spans = Array.isArray(value) ? value : value ? [value] : [];
  return spans
    .map((span) => ({
      offset: toNumber(span?.offset, null),
      length: toNumber(span?.length, null)
    }))
    .filter((span) => span.offset != null && span.length != null && span.length >= 0);
}

function spansOverlap(leftSpans, rightSpans) {
  if (!leftSpans.length || !rightSpans.length) {
    return false;
  }

  return leftSpans.some((left) => {
    const leftEnd = left.offset + left.length;
    return rightSpans.some((right) => {
      const rightEnd = right.offset + right.length;
      return left.offset < rightEnd && right.offset < leftEnd;
    });
  });
}

function getPageUnitScale(unit = '') {
  const normalizedUnit = String(unit || '').trim().toLowerCase();
  if (normalizedUnit === 'inch' || normalizedUnit === 'in') {
    return 96;
  }
  if (normalizedUnit === 'cm') {
    return 37.7952755906;
  }
  if (normalizedUnit === 'mm') {
    return 3.77952755906;
  }
  if (normalizedUnit === 'pt') {
    return 1.3333333333;
  }
  return 1;
}

function normalizeAzurePolygon(polygon, scale = 1) {
  if (!Array.isArray(polygon) || polygon.length < 8) {
    return [];
  }

  const points = [];
  for (let index = 0; index < polygon.length; index += 2) {
    points.push({
      x: toNumber(polygon[index], 0) * scale,
      y: toNumber(polygon[index + 1], 0) * scale
    });
  }
  return points;
}

function getEntityPolygon(entity) {
  if (!entity) {
    return [];
  }

  if (Array.isArray(entity.polygon)) {
    return entity.polygon;
  }

  if (Array.isArray(entity.boundingPolygon)) {
    return entity.boundingPolygon;
  }

  const regionPolygon = entity.boundingRegions?.[0]?.polygon;
  return Array.isArray(regionPolygon) ? regionPolygon : [];
}

function getBoundingBox(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 0),
    height: Math.max(maxY - minY, 0)
  };
}

function boxesOverlap(left, right) {
  if (!left || !right) {
    return false;
  }

  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height;
}

function getVerticalOverlapRatio(left, right) {
  if (!left || !right) {
    return 0;
  }

  const overlap = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  if (overlap <= 0) {
    return 0;
  }

  return overlap / Math.max(Math.min(left.height, right.height), 1);
}

function getPolygonAngle(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return 0;
  }

  const start = points[0];
  const end = points[1];
  return Math.atan2(end.y - start.y, end.x - start.x) * (180 / Math.PI);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeParagraphRole(role) {
  const value = typeof role === 'string' ? role.trim().toLowerCase() : '';
  return value ? value.replace(/[\s_-]+/g, '') : null;
}

function getParagraphRolePriority(role) {
  switch (normalizeParagraphRole(role)) {
    case 'title':
      return 6;
    case 'sectionheading':
    case 'heading':
      return 5;
    case 'pageheader':
      return 4;
    case 'pagefooter':
    case 'pagenumber':
      return 3;
    case 'footnote':
    case 'caption':
      return 2;
    default:
      return 1;
  }
}

function findSelectionMarkLabel(markBox, lines) {
  if (!markBox || !Array.isArray(lines) || lines.length === 0) {
    return '';
  }

  const match = lines
    .filter((line) => line.bbox && getVerticalOverlapRatio(markBox, line.bbox) >= 0.2)
    .map((line) => ({
      line,
      distance: Math.min(
        Math.abs(line.bbox.x - (markBox.x + markBox.width)),
        Math.abs((line.bbox.x + line.bbox.width) - markBox.x)
      )
    }))
    .sort((left, right) => left.distance - right.distance)[0];

  return match?.line?.text || '';
}

function buildSignatureAnchors(lines, pageWidth, pageHeight, pageNumber) {
  const signaturePattern = /\b(signature|signed|initial|witness)\b/i;
  return lines
    .filter((line) => signaturePattern.test(line.text) && line.bbox)
    .slice(0, 12)
    .map((line, index) => {
      const anchorWidth = Math.min(pageWidth * 0.34, Math.max(pageWidth * 0.18, line.bbox.width * 0.7));
      const anchorX = clamp(
        line.bbox.x + Math.max(line.bbox.width * 0.55, pageWidth * 0.04),
        0,
        Math.max(pageWidth - anchorWidth, 0)
      );
      const anchorHeight = Math.min(pageHeight * 0.1, Math.max(line.bbox.height * 2.4, pageHeight * 0.045));
      const anchorY = clamp(line.bbox.y - line.bbox.height * 0.45, 0, Math.max(pageHeight - anchorHeight, 0));

      return {
        id: `page_${pageNumber}_signature_${index + 1}`,
        pageNumber,
        sourceLineId: line.id,
        labelText: line.text,
        bbox: {
          x: anchorX,
          y: anchorY,
          width: anchorWidth,
          height: anchorHeight
        }
      };
    });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildReplicaSvgText(line) {
  if (!line?.bbox || !line.text) {
    return '';
  }

  const role = normalizeParagraphRole(line.paragraphRole || line.role);
  const fontScale = role === 'title'
    ? 1.08
    : role === 'sectionheading' || role === 'heading'
      ? 1.04
      : role === 'pageheader'
        ? 0.96
        : role === 'pagefooter' || role === 'pagenumber'
          ? 0.92
          : role === 'footnote' || role === 'caption'
            ? 0.9
            : 1;
  const fontSize = clamp(line.bbox.height * 0.88 * fontScale, 10, 34);
  const y = line.bbox.y + Math.max(fontSize * 0.88, line.bbox.height * 0.9);
  const widthAttributes = line.bbox.width > 1
    ? ` textLength="${line.bbox.width.toFixed(2)}" lengthAdjust="spacingAndGlyphs"`
    : '';
  const rotation = Math.abs(line.angle || 0) > 0.6
    ? ` transform="rotate(${line.angle.toFixed(2)} ${line.bbox.x.toFixed(2)} ${y.toFixed(2)})"`
    : '';
  const confidenceOpacity = line.confidence > 0 && line.confidence < 0.45 ? '0.82' : '1';
  const fill = role === 'pagefooter' || role === 'pagenumber'
    ? '#64748b'
    : role === 'pageheader' || role === 'footnote' || role === 'caption'
      ? '#475569'
      : '#0f172a';
  const fontWeight = role === 'title' || role === 'sectionheading' || role === 'heading' ? '700' : '400';

  return `<text x="${line.bbox.x.toFixed(2)}" y="${y.toFixed(2)}" font-size="${fontSize.toFixed(2)}" font-family="Times New Roman, Georgia, serif" font-weight="${fontWeight}" fill="${fill}" opacity="${confidenceOpacity}" xml:space="preserve"${widthAttributes}${rotation}>${escapeHtml(line.text)}</text>`;
}

function buildReplicaSvgSelectionMark(mark) {
  if (!mark?.bbox) {
    return '';
  }

  const strokeWidth = clamp(Math.min(mark.bbox.width, mark.bbox.height) * 0.12, 1.1, 2.6);
  const cornerRadius = clamp(Math.min(mark.bbox.width, mark.bbox.height) * 0.18, 1, 4);
  const rect = `<rect x="${mark.bbox.x.toFixed(2)}" y="${mark.bbox.y.toFixed(2)}" width="${mark.bbox.width.toFixed(2)}" height="${mark.bbox.height.toFixed(2)}" rx="${cornerRadius.toFixed(2)}" ry="${cornerRadius.toFixed(2)}" fill="#ffffff" stroke="#0f172a" stroke-width="${strokeWidth.toFixed(2)}" />`;

  if (mark.state !== 'selected') {
    return rect;
  }

  const left = mark.bbox.x + mark.bbox.width * 0.18;
  const midX = mark.bbox.x + mark.bbox.width * 0.42;
  const right = mark.bbox.x + mark.bbox.width * 0.82;
  const midY = mark.bbox.y + mark.bbox.height * 0.72;
  const topY = mark.bbox.y + mark.bbox.height * 0.28;
  const bottomY = mark.bbox.y + mark.bbox.height * 0.82;
  const tick = `<path d="M ${left.toFixed(2)} ${midY.toFixed(2)} L ${midX.toFixed(2)} ${bottomY.toFixed(2)} L ${right.toFixed(2)} ${topY.toFixed(2)}" fill="none" stroke="#0f172a" stroke-width="${(strokeWidth * 1.1).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" />`;

  return `${rect}${tick}`;
}

function buildReplicaSvgImage(anchor) {
  if (!anchor?.bbox || !anchor.imageDataUrl) {
    return '';
  }

  return `<image href="${anchor.imageDataUrl}" x="${anchor.bbox.x.toFixed(2)}" y="${anchor.bbox.y.toFixed(2)}" width="${anchor.bbox.width.toFixed(2)}" height="${anchor.bbox.height.toFixed(2)}" preserveAspectRatio="xMidYMid meet" />`;
}

function expandPixelBounds(bounds, paddingX, paddingY, width, height) {
  const left = clamp(bounds.left - paddingX, 0, Math.max(width - 1, 0));
  const top = clamp(bounds.top - paddingY, 0, Math.max(height - 1, 0));
  const right = clamp(bounds.left + bounds.width + paddingX, left + 1, width);
  const bottom = clamp(bounds.top + bounds.height + paddingY, top + 1, height);

  return {
    left,
    top,
    width: Math.max(right - left, 1),
    height: Math.max(bottom - top, 1)
  };
}

function buildSignatureInkMask(rawPixelData) {
  const maskedPixelData = Buffer.alloc(rawPixelData.length);

  for (let index = 0; index < rawPixelData.length; index += 4) {
    const red = rawPixelData[index];
    const green = rawPixelData[index + 1];
    const blue = rawPixelData[index + 2];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    const alpha = luminance >= 250 ? 0 : clamp(Math.round((250 - luminance) * 5.4), 0, 255);

    maskedPixelData[index] = red;
    maskedPixelData[index + 1] = green;
    maskedPixelData[index + 2] = blue;
    maskedPixelData[index + 3] = alpha >= 24 ? alpha : 0;
  }

  return maskedPixelData;
}

function findNonTransparentPixelBounds(maskedPixelData, width, height, options = {}) {
  const alphaThreshold = options.alphaThreshold != null ? options.alphaThreshold : 28;
  const minX = clamp(Math.floor(options.minX || 0), 0, Math.max(width - 1, 0));
  const maxX = clamp(Math.ceil(options.maxX || width), minX + 1, width);
  const minY = clamp(Math.floor(options.minY || 0), 0, Math.max(height - 1, 0));
  const maxY = clamp(Math.ceil(options.maxY || height), minY + 1, height);

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = minY; y < maxY; y += 1) {
    const rowOffset = y * width * 4;
    for (let x = minX; x < maxX; x += 1) {
      const alpha = maskedPixelData[rowOffset + x * 4 + 3];
      if (alpha <= alphaThreshold) {
        continue;
      }

      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) {
    return null;
  }

  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1
  };
}

function isLikelyUnderlineOnly(bounds, width, height) {
  if (!bounds) {
    return false;
  }

  return bounds.height <= Math.max(Math.round(height * 0.12), 5)
    && bounds.width >= Math.max(Math.round(width * 0.55), 24);
}

async function extractSignatureImageArtifact(cropBuffer, options = {}) {
  const {
    data,
    info
  } = await sharp(cropBuffer, { failOn: 'none', unlimited: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const maskedPixelData = buildSignatureInkMask(data);
  const fullBounds = findNonTransparentPixelBounds(maskedPixelData, info.width, info.height);
  const focusMinXs = (Array.isArray(options.focusMinXs) ? options.focusMinXs : [options.focusMinX])
    .filter((value) => value != null)
    .map((value) => clamp(Math.floor(value), 0, Math.max(info.width - 1, 0)));
  const focusedCandidate = focusMinXs
    .filter((value, index, values) => values.indexOf(value) === index)
    .map((focusMinX) => ({
      focusMinX,
      bounds: focusMinX < info.width - 1
        ? findNonTransparentPixelBounds(maskedPixelData, info.width, info.height, { minX: focusMinX })
        : null
    }))
    .find((candidate) => candidate.bounds && !isLikelyUnderlineOnly(candidate.bounds, info.width - candidate.focusMinX, info.height));

  const selectedBounds = focusedCandidate?.bounds
    ? focusedCandidate.bounds
    : fullBounds && !isLikelyUnderlineOnly(fullBounds, info.width, info.height)
      ? fullBounds
      : null;

  if (!selectedBounds) {
    return null;
  }

  const paddedBounds = expandPixelBounds(
    selectedBounds,
    Math.max(Math.round(selectedBounds.width * 0.08), 3),
    Math.max(Math.round(selectedBounds.height * 0.2), 3),
    info.width,
    info.height
  );

  const transparentSignatureBuffer = await sharp(maskedPixelData, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4
    }
  })
    .extract(paddedBounds)
    .png()
    .toBuffer();

  return {
    pixelBounds: paddedBounds,
    imageDataUrl: `data:image/png;base64,${transparentSignatureBuffer.toString('base64')}`
  };
}

function suspiciousLineScore(line) {
  if (!line?.text) {
    return 0;
  }

  let score = 0;
  if (line.confidence > 0 && line.confidence < 0.78) {
    score += (0.78 - line.confidence) * 2;
  }

  if (/[?]{2,}|[_]{3,}|[|]{2,}/.test(line.text)) {
    score += 0.45;
  }

  const alphaCharacters = (line.text.match(/[A-Za-z]/g) || []).length;
  const digitCharacters = (line.text.match(/[0-9]/g) || []).length;
  if (alphaCharacters > 0 && digitCharacters > 0) {
    score += 0.08;
  }

  return score;
}

async function buildClaudeRepairCandidates(azureSnapshot, buffer, mimeType) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const lowConfidenceLines = azureSnapshot.pages
    .flatMap((page) => (page.lines || []).map((line) => ({
      ...line,
      pageNumber: page.pageNumber,
      pageWidth: page.renderWidth || page.width,
      pageHeight: page.renderHeight || page.height,
      suspiciousScore: suspiciousLineScore(line)
    })))
    .filter((line) => line.bbox && line.suspiciousScore > 0)
    .sort((left, right) => right.suspiciousScore - left.suspiciousScore)
    .slice(0, 8);

  const candidates = lowConfidenceLines.map((line, index) => ({
    id: line.id,
    pageNumber: line.pageNumber,
    originalText: line.text,
    confidence: line.confidence,
    suspiciousScore: Number(line.suspiciousScore.toFixed(3)),
    cropMediaType: null,
    cropBase64: null,
    cropNotes: '',
    sequence: index + 1
  }));

  if (!normalizedMimeType.startsWith('image/') || !buffer || candidates.length === 0 || azureSnapshot.pages.length !== 1) {
    return candidates;
  }

  const metadata = await sharp(buffer, { failOn: 'none', unlimited: true }).metadata();
  if (!metadata.width || !metadata.height) {
    return candidates;
  }

  const page = azureSnapshot.pages[0];
  const pageWidth = page.renderWidth || page.width;
  const pageHeight = page.renderHeight || page.height;
  if (!pageWidth || !pageHeight) {
    return candidates;
  }

  const scaleX = metadata.width / pageWidth;
  const scaleY = metadata.height / pageHeight;

  for (const candidate of candidates) {
    const line = lowConfidenceLines.find((item) => item.id === candidate.id);
    if (!line) {
      continue;
    }

    const horizontalPadding = Math.max(line.bbox.width * 0.08, pageWidth * 0.015);
    const verticalPadding = Math.max(line.bbox.height * 0.55, pageHeight * 0.012);
    const cropBox = {
      x: clamp(line.bbox.x - horizontalPadding, 0, Math.max(pageWidth - 1, 0)),
      y: clamp(line.bbox.y - verticalPadding, 0, Math.max(pageHeight - 1, 0)),
      width: clamp(line.bbox.width + horizontalPadding * 2, 1, pageWidth),
      height: clamp(line.bbox.height + verticalPadding * 2, 1, pageHeight)
    };

    const extractRegion = {
      left: Math.max(Math.floor(cropBox.x * scaleX), 0),
      top: Math.max(Math.floor(cropBox.y * scaleY), 0),
      width: Math.max(Math.floor(cropBox.width * scaleX), 1),
      height: Math.max(Math.floor(cropBox.height * scaleY), 1)
    };

    extractRegion.width = Math.min(extractRegion.width, Math.max(metadata.width - extractRegion.left, 1));
    extractRegion.height = Math.min(extractRegion.height, Math.max(metadata.height - extractRegion.top, 1));

    try {
      const cropBuffer = await sharp(buffer, { failOn: 'none', unlimited: true })
        .extract(extractRegion)
        .png()
        .toBuffer();
      candidate.cropMediaType = 'image/png';
      candidate.cropBase64 = cropBuffer.toString('base64');
      candidate.cropNotes = `Crop ${candidate.sequence} for line ${candidate.id} on page ${candidate.pageNumber}`;
    } catch {
      // Leave the candidate text-only if crop generation fails.
    }
  }

  return candidates;
}

function applyClaudeLineRepairs(azureSnapshot, claudeInterpretation) {
  const repairedLines = Array.isArray(claudeInterpretation?.repairedLines)
    ? claudeInterpretation.repairedLines
        .map((item) => ({
          lineId: typeof item?.lineId === 'string' ? item.lineId.trim() : '',
          pageNumber: item?.pageNumber != null ? toNumber(item.pageNumber, null) : null,
          repairedText: typeof item?.repairedText === 'string' ? item.repairedText.trim() : '',
          confidence: normalizeConfidence(item?.confidence ?? 0),
          reason: typeof item?.reason === 'string' ? item.reason.trim() : ''
        }))
        .filter((item) => item.lineId && item.repairedText)
    : [];

  if (repairedLines.length === 0) {
    return {
      snapshot: azureSnapshot,
      repairedLines: []
    };
  }

  const repairedById = new Map(repairedLines.map((item) => [item.lineId, item]));
  const pages = azureSnapshot.pages.map((page) => {
    const lines = (page.lines || []).map((line) => {
      const repair = repairedById.get(line.id);
      if (!repair) {
        return line;
      }

      return {
        ...line,
        text: repair.repairedText,
        repairedText: repair.repairedText,
        repairConfidence: repair.confidence,
        repairReason: repair.reason
      };
    });

    return {
      ...page,
      lines,
      text: lines.map((line) => line.text).join('\n').trim()
    };
  });

  const content = pages.map((page) => page.text).filter(Boolean).join('\n\n').trim();
  return {
    snapshot: {
      ...azureSnapshot,
      pages,
      content: content || azureSnapshot.content
    },
    repairedLines
  };
}

async function attachSignatureImagesToPages(buffer, pages, mimeType) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (!normalizedMimeType.startsWith('image/') || !Array.isArray(pages) || pages.length !== 1) {
    return pages;
  }

  const normalizedInput = await normalizeImageBufferForAzure(buffer, normalizedMimeType);
  const image = sharp(normalizedInput.buffer, { failOn: 'none', unlimited: true });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    return pages;
  }

  const [page] = pages;
  const pageWidth = page.renderWidth || page.width;
  const pageHeight = page.renderHeight || page.height;
  if (!pageWidth || !pageHeight) {
    return pages;
  }

  const scaleX = metadata.width / pageWidth;
  const scaleY = metadata.height / pageHeight;
  const signatureAnchors = [];
  const pageLines = Array.isArray(page.lines) ? page.lines : [];

  for (const anchor of page.signatureAnchors || []) {
    const extractRegion = {
      left: Math.max(Math.floor(anchor.bbox.x * scaleX), 0),
      top: Math.max(Math.floor(anchor.bbox.y * scaleY), 0),
      width: Math.max(Math.floor(anchor.bbox.width * scaleX), 1),
      height: Math.max(Math.floor(anchor.bbox.height * scaleY), 1)
    };

    const maxWidth = Math.max(metadata.width - extractRegion.left, 1);
    const maxHeight = Math.max(metadata.height - extractRegion.top, 1);
    extractRegion.width = Math.min(extractRegion.width, maxWidth);
    extractRegion.height = Math.min(extractRegion.height, maxHeight);

    try {
      const cropBuffer = await sharp(normalizedInput.buffer, { failOn: 'none', unlimited: true })
        .extract(extractRegion)
        .png()
        .toBuffer();
      const sourceLine = pageLines.find((line) => line.id === anchor.sourceLineId);
      const focusMinXsOnPage = sourceLine?.bbox
        ? [
            Math.max(anchor.bbox.x, sourceLine.bbox.x + sourceLine.bbox.width - Math.max(sourceLine.bbox.height * 0.3, pageWidth * 0.005)),
            Math.max(anchor.bbox.x, sourceLine.bbox.x + sourceLine.bbox.width * 0.68)
          ]
        : [];
      const focusMinXsInCrop = focusMinXsOnPage
        .map((value) => Math.max(Math.floor((value - anchor.bbox.x) * scaleX), 0));
      const signatureArtifact = await extractSignatureImageArtifact(cropBuffer, {
        focusMinXs: focusMinXsInCrop
      });

      signatureAnchors.push({
        ...anchor,
        ...(signatureArtifact
          ? {
              bbox: {
                x: anchor.bbox.x + signatureArtifact.pixelBounds.left / scaleX,
                y: anchor.bbox.y + signatureArtifact.pixelBounds.top / scaleY,
                width: signatureArtifact.pixelBounds.width / scaleX,
                height: signatureArtifact.pixelBounds.height / scaleY
              },
              imageDataUrl: signatureArtifact.imageDataUrl
            }
          : {})
      });
    } catch {
      signatureAnchors.push(anchor);
    }
  }

  return [{
    ...page,
    signatureAnchors
  }];
}

function buildReplicaHtml(pages, meta) {
  const pageMarkup = pages.map((page) => {
    const width = Math.max(page.renderWidth || page.width || 1, 1);
    const height = Math.max(page.renderHeight || page.height || 1, 1);
    const svgLines = (page.lines || []).map((line) => buildReplicaSvgText(line)).join('');
    const svgSelectionMarks = (page.selectionMarks || []).map((mark) => buildReplicaSvgSelectionMark(mark)).join('');
    const svgSignatures = (page.signatureAnchors || []).map((anchor) => buildReplicaSvgImage(anchor)).join('');

    return `
      <section class="replica-page">
        <div class="replica-page__meta">Page ${page.pageNumber}</div>
        <svg class="replica-page__svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Digitized page ${page.pageNumber}">
          <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
          ${svgSelectionMarks}
          ${svgLines}
          ${svgSignatures}
        </svg>
      </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title || meta.fileName || 'Digitized Document')}</title>
    <style>
      :root {
        color-scheme: light;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 24px;
        background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
        color: #0f172a;
        font-family: "Times New Roman", Georgia, serif;
      }
      .replica-shell {
        display: grid;
        gap: 18px;
        max-width: 1100px;
        margin: 0 auto;
      }
      .replica-header {
        padding: 16px 18px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.85);
        border: 1px solid rgba(148, 163, 184, 0.28);
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
      }
      .replica-header__eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: #e0f2fe;
        color: #075985;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .replica-header h1 {
        margin: 12px 0 8px;
        font-size: 28px;
        line-height: 1.2;
      }
      .replica-header p {
        margin: 0;
        color: #475569;
        line-height: 1.55;
        font-size: 14px;
      }
      .replica-page {
        display: grid;
        gap: 10px;
      }
      .replica-page__meta {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #64748b;
      }
      .replica-page__svg {
        width: 100%;
        height: auto;
        display: block;
        background: #ffffff;
        border-radius: 20px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        box-shadow: 0 20px 60px rgba(15, 23, 42, 0.08);
      }
    </style>
  </head>
  <body>
    <main class="replica-shell">
      <header class="replica-header">
        <span class="replica-header__eyebrow">Digitized Replica</span>
        <h1>${escapeHtml(meta.title || meta.fileName || 'Digitized Document')}</h1>
        <p>This reconstruction preserves the document layout from Azure Document Intelligence and uses AI cleanup as a secondary interpretation layer.</p>
      </header>
      ${pageMarkup}
    </main>
  </body>
</html>`;
}

export function resolveDocumentMimeType(fileName = '', mimeType = '') {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (normalizedMimeType && normalizedMimeType !== 'application/octet-stream') {
    return normalizedMimeType;
  }

  const extension = fileName.split('.').pop()?.trim().toLowerCase();
  return EXTENSION_TO_MIME[extension || ''] || normalizedMimeType || 'application/octet-stream';
}

export function isAzureDocumentSupported(mimeType) {
  return AZURE_SUPPORTED_MIME_TYPES.has(normalizeMimeType(mimeType));
}

export function isImageDocumentMimeType(mimeType, fileName = '') {
  const resolvedMimeType = resolveDocumentMimeType(fileName, mimeType);
  return IMAGE_MIME_TYPES.has(normalizeMimeType(resolvedMimeType));
}

export function shouldDigitizeUploadedDocument(mimeType, fileName = '') {
  return isImageDocumentMimeType(mimeType, fileName);
}

export function buildNativeDigitalSkipResult(mimeType, fileName = '') {
  return {
    ok: false,
    status: 'skipped',
    reason: 'native_digital',
    error: null,
    mimeType: resolveDocumentMimeType(fileName, mimeType)
  };
}

export async function fetchRemoteDocumentBuffer(fileUrl) {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch uploaded file (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: normalizeMimeType(response.headers.get('content-type') || '')
  };
}

export async function fetchFirebaseStorageFileByPath(storagePath) {
  if (!storagePath) {
    throw new Error('Firebase Storage path is required');
  }

  const admin = initializeFirebaseAdmin();
  const bucket = admin.storage().bucket();
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();

  if (!exists) {
    throw new Error(`Firebase Storage file not found: ${storagePath}`);
  }

  const [[metadata], [buffer]] = await Promise.all([
    file.getMetadata(),
    file.download()
  ]);

  return {
    buffer,
    mimeType: normalizeMimeType(metadata.contentType || '')
  };
}

function normalizeAzureFieldValue(field) {
  if (!field) {
    return null;
  }

  if (field.content) {
    return field.content;
  }

  if (field.type === 'string') return field.valueString ?? null;
  if (field.type === 'date') return field.valueDate ?? null;
  if (field.type === 'time') return field.valueTime ?? null;
  if (field.type === 'number') return field.valueNumber ?? null;
  if (field.type === 'integer') return field.valueInteger ?? null;
  if (field.type === 'phoneNumber') return field.valuePhoneNumber ?? null;

  if (field.type === 'currency') {
    if (field.valueCurrency?.amount != null) {
      return field.valueCurrency.currencySymbol
        ? `${field.valueCurrency.currencySymbol}${field.valueCurrency.amount}`
        : String(field.valueCurrency.amount);
    }
    return field.valueCurrency ?? null;
  }

  if (field.type === 'address') {
    if (field.valueAddress?.formattedAddress) {
      return field.valueAddress.formattedAddress;
    }
    return field.valueAddress ?? null;
  }

  if (field.type === 'array' && Array.isArray(field.valueArray)) {
    return field.valueArray.map(normalizeAzureFieldValue).filter((value) => value != null);
  }

  if (field.type === 'object' && field.valueObject) {
    return Object.fromEntries(
      Object.entries(field.valueObject)
        .map(([key, value]) => [key, normalizeAzureFieldValue(value)])
        .filter(([, value]) => value != null)
    );
  }

  return field.value ?? null;
}

function summarizeAzureTables(tables = []) {
  return tables.slice(0, 12).map((table, index) => {
    const rows = new Map();
    for (const cell of table.cells || []) {
      const rowIndex = cell.rowIndex ?? 0;
      const existingRow = rows.get(rowIndex) || [];
      existingRow[cell.columnIndex ?? existingRow.length] = (cell.content || '').trim();
      rows.set(rowIndex, existingRow);
    }

    return {
      id: `table_${index + 1}`,
      pageNumber: table.boundingRegions?.[0]?.pageNumber || null,
      rowCount: table.rowCount || rows.size,
      columnCount: table.columnCount || 0,
      previewRows: Array.from(rows.values())
        .slice(0, 5)
        .map((row) => row.filter((cell) => cell != null).join(' | '))
        .filter(Boolean)
    };
  });
}

function buildAzureSnapshot(layoutResult, documentResult) {
  const pageScaleByNumber = new Map();
  const basePages = (layoutResult?.pages || []).map((page, index) => {
    const pageNumber = page.pageNumber || index + 1;
    const unit = page.unit || null;
    const scale = getPageUnitScale(unit);
    const width = toNumber(page.width, 0);
    const height = toNumber(page.height, 0);
    pageScaleByNumber.set(pageNumber, scale);

    const words = (page.words || []).map((word, wordIndex) => {
      const polygon = normalizeAzurePolygon(getEntityPolygon(word), scale);
      return {
        id: `page_${pageNumber}_word_${wordIndex + 1}`,
        text: (word.content || '').trim(),
        confidence: normalizeConfidence(word.confidence),
        polygon,
        bbox: getBoundingBox(polygon),
        spans: normalizeAzureSpans(word.spans || word.span)
      };
    }).filter((word) => word.text);

    const lines = (page.lines || []).map((line, lineIndex) => {
      const polygon = normalizeAzurePolygon(getEntityPolygon(line), scale);
      const bbox = getBoundingBox(polygon);
      const spans = normalizeAzureSpans(line.spans || line.span);
      const lineWords = words.filter((word) => spansOverlap(spans, word.spans));

      return {
        id: `page_${pageNumber}_line_${lineIndex + 1}`,
        text: (line.content || '').trim(),
        polygon,
        bbox,
        spans,
        angle: getPolygonAngle(polygon),
        confidence: normalizeConfidence(average(lineWords.map((word) => word.confidence), 0))
      };
    }).filter((line) => line.text && line.bbox);

    const selectionMarks = (page.selectionMarks || []).map((mark, markIndex) => {
      const polygon = normalizeAzurePolygon(getEntityPolygon(mark), scale);
      const bbox = getBoundingBox(polygon);

      return {
        id: `page_${pageNumber}_selection_${markIndex + 1}`,
        pageNumber,
        state: mark.state === 'selected' ? 'selected' : 'unselected',
        confidence: normalizeConfidence(mark.confidence),
        polygon,
        bbox
      };
    }).filter((mark) => mark.bbox);

    const renderWidth = width > 0 ? width * scale : 0;
    const renderHeight = height > 0 ? height * scale : 0;

    return {
      pageNumber,
      width,
      height,
      renderWidth,
      renderHeight,
      unit,
      angle: page.angle || null,
      text: lines.map((line) => line.text).join('\n').trim(),
      lineCount: lines.length,
      lines,
      selectionMarks: selectionMarks.map((mark) => ({
        ...mark,
        labelText: findSelectionMarkLabel(mark.bbox, lines)
      })),
      signatureAnchors: buildSignatureAnchors(lines, renderWidth || width, renderHeight || height, pageNumber),
      lowConfidenceWords: words
        .filter((word) => word.confidence > 0 && word.confidence < 0.82)
        .map((word) => ({
          text: word.text,
          confidence: word.confidence
        }))
        .slice(0, 15)
    };
  });

  const pageMap = new Map(basePages.map((page) => [page.pageNumber, page]));
  const paragraphs = (layoutResult?.paragraphs || []).map((paragraph, index) => {
    const pageNumber = paragraph.boundingRegions?.[0]?.pageNumber || null;
    const scale = pageScaleByNumber.get(pageNumber) || 1;
    const polygon = normalizeAzurePolygon(paragraph.boundingRegions?.[0]?.polygon, scale);
    const bbox = getBoundingBox(polygon);
    const spans = normalizeAzureSpans(paragraph.spans || paragraph.span);
    const pageLines = pageMap.get(pageNumber)?.lines || [];
    const lineIds = pageLines
      .filter((line) => spansOverlap(spans, line.spans) || (bbox && boxesOverlap(bbox, line.bbox)))
      .map((line) => line.id);

    return {
      id: `paragraph_${index + 1}`,
      pageNumber,
      role: normalizeParagraphRole(paragraph.role),
      content: (paragraph.content || '').trim(),
      polygon,
      bbox,
      lineIds,
      confidence: normalizeConfidence(average(
        pageLines.filter((line) => lineIds.includes(line.id)).map((line) => line.confidence),
        0
      ))
    };
  }).filter((paragraph) => paragraph.content && paragraph.pageNumber != null);

  const lineRoleAssignments = new Map();
  for (const paragraph of paragraphs) {
    for (const lineId of paragraph.lineIds) {
      const current = lineRoleAssignments.get(lineId);
      if (!current || getParagraphRolePriority(paragraph.role) > getParagraphRolePriority(current.role)) {
        lineRoleAssignments.set(lineId, {
          role: paragraph.role,
          paragraphId: paragraph.id
        });
      }
    }
  }

  const pages = basePages.map((page) => ({
    ...page,
    lines: page.lines.map((line) => {
      const assignment = lineRoleAssignments.get(line.id);
      if (!assignment) {
        return line;
      }

      return {
        ...line,
        paragraphRole: assignment.role,
        paragraphId: assignment.paragraphId
      };
    }),
    paragraphs: paragraphs
      .filter((paragraph) => paragraph.pageNumber === page.pageNumber)
      .map((paragraph) => ({
        id: paragraph.id,
        role: paragraph.role,
        content: paragraph.content,
        bbox: paragraph.bbox,
        confidence: paragraph.confidence,
        lineIds: paragraph.lineIds
      }))
  }));

  const keyValuePairs = (documentResult?.keyValuePairs || []).map((pair) => ({
    key: pair.key?.content?.trim() || '',
    value: pair.value?.content?.trim() || '',
    confidence: normalizeConfidence(pair.confidence)
  })).filter((pair) => pair.key || pair.value);

  const normalizedDocuments = (documentResult?.documents || []).map((document) => ({
    docType: document.docType || 'unknown',
    confidence: normalizeConfidence(document.confidence),
    fields: Object.fromEntries(
      Object.entries(document.fields || {})
        .map(([key, value]) => [key, normalizeAzureFieldValue(value)])
        .filter(([, value]) => value != null)
    )
  }));

  return {
    content: (layoutResult?.content || documentResult?.content || '').trim(),
    pages,
    paragraphs: paragraphs.map((paragraph) => ({
      id: paragraph.id,
      pageNumber: paragraph.pageNumber,
      role: paragraph.role,
      content: paragraph.content
    })),
    keyValuePairs,
    documents: normalizedDocuments,
    tables: summarizeAzureTables(layoutResult?.tables || documentResult?.tables || []),
    lowConfidenceWords: pages.flatMap((page) => page.lowConfidenceWords).slice(0, 40)
  };
}

async function readAzureError(response) {
  const text = await response.text();
  if (!text) {
    return `Azure returned ${response.status}`;
  }

  try {
    const payload = JSON.parse(text);
    const errorParts = [
      payload.error?.message,
      payload.error?.code,
      payload.error?.innererror?.message,
      payload.error?.innererror?.code,
      payload.message
    ].filter(Boolean);

    if (errorParts.length > 0) {
      return errorParts.join(' | ');
    }

    return text;
  } catch {
    return text;
  }
}

async function normalizeImageBufferForAzure(buffer, mimeType) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (!normalizedMimeType.startsWith('image/')) {
    return {
      buffer,
      mimeType: normalizedMimeType
    };
  }

  try {
    const normalizedBuffer = await sharp(buffer, { failOn: 'none', unlimited: true })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width: 6000,
        height: 6000,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();

    return {
      buffer: normalizedBuffer,
      mimeType: 'image/jpeg'
    };
  } catch (error) {
    console.warn('[DocumentDigitization] Image normalization fallback:', error.message);
    return {
      buffer,
      mimeType: normalizedMimeType
    };
  }
}

async function analyzeWithAzureEndpoint(endpointPrefix, modelId, buffer, mimeType) {
  const analyzeUrl = `${normalizeAzureEndpoint(AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT)}/${endpointPrefix}/documentModels/${modelId}:analyze?api-version=${encodeURIComponent(AZURE_API_VERSION)}`;
  const response = await fetch(analyzeUrl, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_DOCUMENT_INTELLIGENCE_API_KEY,
      'Content-Type': mimeType,
      'Content-Length': String(buffer.length)
    },
    body: buffer
  });

  if (response.status === 404) {
    const error = new Error(`Azure endpoint prefix ${endpointPrefix} not found`);
    error.code = 'AZURE_PREFIX_NOT_FOUND';
    throw error;
  }

  if (response.status !== 202 && response.status !== 200) {
    throw new Error(await readAzureError(response));
  }

  if (response.status === 200) {
    const payload = await response.json();
    return payload.analyzeResult || payload;
  }

  const operationLocation = response.headers.get('operation-location');
  if (!operationLocation) {
    throw new Error('Azure analysis did not return an operation location');
  }

  for (let attempt = 0; attempt < 45; attempt += 1) {
    const pollResponse = await fetch(operationLocation, {
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_DOCUMENT_INTELLIGENCE_API_KEY
      }
    });

    if (!pollResponse.ok) {
      throw new Error(await readAzureError(pollResponse));
    }

    const payload = await pollResponse.json();
    const status = String(payload.status || '').toLowerCase();
    if (status === 'succeeded') {
      return payload.analyzeResult || payload;
    }

    if (status === 'failed') {
      throw new Error(payload.error?.message || 'Azure analysis failed');
    }

    const retryAfterSeconds = toNumber(pollResponse.headers.get('retry-after'), 1);
    await delay(Math.min(Math.max(retryAfterSeconds * 1000, 1000), 4000));
  }

  throw new Error('Azure analysis timed out');
}

async function analyzeWithAzure(modelId, buffer, mimeType) {
  const endpointPrefixes = ['documentintelligence', 'formrecognizer'];
  let lastError = null;

  for (const endpointPrefix of endpointPrefixes) {
    try {
      return await analyzeWithAzureEndpoint(endpointPrefix, modelId, buffer, mimeType);
    } catch (error) {
      if (error.code === 'AZURE_PREFIX_NOT_FOUND') {
        lastError = error;
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('Azure Document Intelligence endpoint is unavailable');
}

function buildClaudePayload(azureSnapshot, meta, repairCandidates = []) {
  return {
    titleHint: meta.title || '',
    fileName: meta.fileName || '',
    mimeType: meta.mimeType || '',
    pageCount: azureSnapshot.pages.length,
    rawText: truncateText(azureSnapshot.content, 36000),
    paragraphs: azureSnapshot.paragraphs.slice(0, 60).map((paragraph) => ({
      id: paragraph.id,
      pageNumber: paragraph.pageNumber,
      role: paragraph.role,
      content: paragraph.content
    })),
    pageLines: azureSnapshot.pages.slice(0, 12).map((page) => ({
      pageNumber: page.pageNumber,
      lines: (page.lines || []).slice(0, 120).map((line) => ({
        lineId: line.id,
        text: line.text,
        confidence: line.confidence,
        role: line.paragraphRole || null
      }))
    })),
    keyValuePairs: azureSnapshot.keyValuePairs.slice(0, 60),
    detectedDocumentTypes: azureSnapshot.documents.map((document) => ({
      docType: document.docType,
      confidence: document.confidence,
      fields: document.fields
    })),
    tableSummaries: azureSnapshot.tables.slice(0, 10),
    lowConfidenceWords: azureSnapshot.lowConfidenceWords.slice(0, 30),
    repairCandidates: repairCandidates.map((candidate) => ({
      lineId: candidate.id,
      pageNumber: candidate.pageNumber,
      originalText: candidate.originalText,
      confidence: candidate.confidence,
      suspiciousScore: candidate.suspiciousScore
    }))
  };
}

async function interpretWithClaude(azureSnapshot, meta, repairCandidates = []) {
  if (!anthropic) {
    return null;
  }

  const content = [
    {
      type: 'text',
      text: `Return a JSON object with this exact shape:
{
  "title": "string or null",
  "documentType": "lease_agreement|rental_application|insurance_certificate|invoice|receipt|utility_bill|tax_document|repair_estimate|inspection_report|notice|correspondence|id_document|bank_statement|pay_stub|other",
  "confidence": 0.0,
  "summary": "string",
  "extractionQuality": "high|medium|low",
  "parties": ["string"],
  "addresses": ["string"],
  "dates": ["string"],
  "monetaryAmounts": ["string"],
  "identifiers": ["string"],
  "actionItems": ["string"],
  "keyFacts": [{"label": "string", "value": "string", "confidence": "high|medium|low"}],
  "structuredSections": [{"heading": "string", "pageNumber": 1, "text": "string"}],
  "missingOrUnclear": ["string"],
  "reviewNotes": ["string"],
  "repairedLines": [{"lineId": "string", "pageNumber": 1, "repairedText": "string", "confidence": 0.0, "reason": "string"}],
  "normalizedFullText": "string or null"
}

Rules:
- Azure is the source of truth for layout and baseline transcription.
- Only repair lines listed in repairCandidates. Do not invent new line ids.
- Keep repairedText faithful to the visible source and attached crops. If uncertain, leave the original text unchanged.
- The replica layer needs exact copy fidelity before interpretation.

Use the Azure extraction payload below.
${JSON.stringify(buildClaudePayload(azureSnapshot, meta, repairCandidates))}`
    }
  ];

  for (const candidate of repairCandidates) {
    if (!candidate.cropBase64 || !candidate.cropMediaType) {
      continue;
    }

    content.push({
      type: 'text',
      text: `Repair candidate ${candidate.sequence}: lineId=${candidate.id}, page=${candidate.pageNumber}, originalText=${JSON.stringify(candidate.originalText)}`
    });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: candidate.cropMediaType,
        data: candidate.cropBase64
      }
    });
  }

  const response = await anthropic.messages.create({
    model: CLAUDE_DOCUMENT_MODEL,
    max_tokens: 3200,
    temperature: 0,
    system: `You are a document digitization quality-control layer for a property management platform.
You receive Azure Document Intelligence extraction output from a scanned paper document.
Your job is to infer structure, repair low-confidence OCR lines when supported by the document evidence, and extract the key facts without inventing missing information.
Return JSON only. If a value is unclear, use null, an empty array, or add it to missingOrUnclear.
Do not include markdown fences.`,
    messages: [
      {
        role: 'user',
        content
      }
    ]
  });

  const parsed = extractJsonFromText(extractClaudeText(response));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Claude returned an invalid document interpretation payload');
  }

  return parsed;
}

function buildDigitizationResult(azureSnapshot, claudeInterpretation, meta) {
  const repairedSnapshot = applyClaudeLineRepairs(azureSnapshot, claudeInterpretation);
  const effectiveSnapshot = repairedSnapshot.snapshot;
  const fallbackDocument = azureSnapshot.documents[0] || null;
  const fallbackSummary = fallbackDocument
    ? `Azure extracted ${Object.keys(fallbackDocument.fields || {}).length} document fields.`
    : `Azure extracted ${effectiveSnapshot.content.length} characters from the document.`;

  const normalizedFullText = typeof claudeInterpretation?.normalizedFullText === 'string'
    ? claudeInterpretation.normalizedFullText.trim()
    : '';

  const extractedText = normalizedFullText.length >= Math.min(effectiveSnapshot.content.length * 0.6, 12000)
    ? normalizedFullText
    : effectiveSnapshot.content;

  const keyFacts = Array.isArray(claudeInterpretation?.keyFacts)
    ? claudeInterpretation.keyFacts.slice(0, 12).map((fact) => ({
        label: typeof fact?.label === 'string' ? fact.label.trim() : '',
        value: typeof fact?.value === 'string' ? fact.value.trim() : '',
        confidence: ['high', 'medium', 'low'].includes(fact?.confidence) ? fact.confidence : 'medium'
      })).filter((fact) => fact.label && fact.value)
    : azureSnapshot.keyValuePairs.slice(0, 12).map((pair) => ({
        label: pair.key || 'Field',
        value: pair.value || '',
        confidence: pair.confidence >= 0.85 ? 'high' : pair.confidence >= 0.65 ? 'medium' : 'low'
      })).filter((fact) => fact.value);

  const summary = typeof claudeInterpretation?.summary === 'string' && claudeInterpretation.summary.trim()
    ? claudeInterpretation.summary.trim()
    : fallbackSummary;

  return {
    ok: true,
    status: claudeInterpretation ? 'completed' : 'partial',
    mimeType: meta.mimeType,
    pageCount: effectiveSnapshot.pages.length,
    rawTextLength: effectiveSnapshot.content.length,
    documentType: typeof claudeInterpretation?.documentType === 'string' && claudeInterpretation.documentType.trim()
      ? claudeInterpretation.documentType.trim()
      : fallbackDocument?.docType || 'other',
    title: typeof claudeInterpretation?.title === 'string' && claudeInterpretation.title.trim()
      ? claudeInterpretation.title.trim()
      : meta.title || meta.fileName || 'Digitized Document',
    summary,
    classificationConfidence: normalizeConfidence(claudeInterpretation?.confidence ?? fallbackDocument?.confidence ?? 0),
    extractedText,
    extractedFields: {
      parties: cleanArray(claudeInterpretation?.parties),
      addresses: cleanArray(claudeInterpretation?.addresses),
      dates: cleanArray(claudeInterpretation?.dates),
      monetaryAmounts: cleanArray(claudeInterpretation?.monetaryAmounts),
      identifiers: cleanArray(claudeInterpretation?.identifiers),
      actionItems: cleanArray(claudeInterpretation?.actionItems),
      missingOrUnclear: cleanArray(claudeInterpretation?.missingOrUnclear),
      reviewNotes: cleanArray(claudeInterpretation?.reviewNotes)
    },
    extractionQuality: ['high', 'medium', 'low'].includes(claudeInterpretation?.extractionQuality)
      ? claudeInterpretation.extractionQuality
      : claudeInterpretation ? 'medium' : 'low',
    structuredSections: Array.isArray(claudeInterpretation?.structuredSections)
      ? claudeInterpretation.structuredSections.slice(0, 12).map((section) => ({
          heading: typeof section?.heading === 'string' ? section.heading.trim() : '',
          pageNumber: section?.pageNumber != null ? toNumber(section.pageNumber, null) : null,
          text: typeof section?.text === 'string' ? section.text.trim() : ''
        })).filter((section) => section.heading || section.text)
      : [],
    repairedLines: repairedSnapshot.repairedLines,
    keyFacts,
    tableSummaries: effectiveSnapshot.tables,
    lowConfidenceWords: effectiveSnapshot.lowConfidenceWords,
    pages: effectiveSnapshot.pages,
    providers: {
      extraction: 'azure-document-intelligence',
      interpretation: claudeInterpretation ? 'claude' : null,
      claudeModel: claudeInterpretation ? CLAUDE_DOCUMENT_MODEL : null
    }
  };
}

export async function digitizeDocumentFromBytes({ buffer, mimeType, fileName, title }) {
  const resolvedMimeType = resolveDocumentMimeType(fileName, mimeType);

  if (!AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || !AZURE_DOCUMENT_INTELLIGENCE_API_KEY) {
    return {
      ok: false,
      status: 'skipped',
      reason: 'azure_not_configured',
      error: 'Azure Document Intelligence credentials are not configured',
      mimeType: resolvedMimeType
    };
  }

  if (!buffer || !buffer.length) {
    return {
      ok: false,
      status: 'failed',
      reason: 'empty_file',
      error: 'The document file was empty',
      mimeType: resolvedMimeType
    };
  }

  if (!isAzureDocumentSupported(resolvedMimeType)) {
    return {
      ok: false,
      status: 'skipped',
      reason: 'unsupported_file_type',
      error: `Digitization currently supports PDF and image files. Received ${resolvedMimeType}.`,
      mimeType: resolvedMimeType
    };
  }

  try {
    const normalizedInput = await normalizeImageBufferForAzure(buffer, resolvedMimeType);

    const layoutResult = await analyzeWithAzure('prebuilt-layout', normalizedInput.buffer, normalizedInput.mimeType);

    let documentResult = null;
    try {
      documentResult = await analyzeWithAzure('prebuilt-document', normalizedInput.buffer, normalizedInput.mimeType);
    } catch (error) {
      console.warn('[DocumentDigitization] Azure prebuilt-document fallback:', error.message);
    }

    const azureSnapshot = buildAzureSnapshot(layoutResult, documentResult);
    if (!azureSnapshot.content) {
      return {
        ok: false,
        status: 'failed',
        reason: 'empty_extraction',
        error: 'Azure did not return extractable document text',
        mimeType: normalizedInput.mimeType || resolvedMimeType
      };
    }

    let claudeInterpretation = null;
    try {
      const repairCandidates = await buildClaudeRepairCandidates(azureSnapshot, normalizedInput.buffer, normalizedInput.mimeType);
      claudeInterpretation = await interpretWithClaude(azureSnapshot, {
        fileName,
        mimeType: resolvedMimeType,
        title
      }, repairCandidates);
    } catch (error) {
      console.warn('[DocumentDigitization] Claude interpretation fallback:', error.message);
    }

    return buildDigitizationResult(azureSnapshot, claudeInterpretation, {
      fileName,
      mimeType: normalizedInput.mimeType || resolvedMimeType,
      title
    });
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      reason: 'digitization_failed',
      error: error.message,
      mimeType: resolvedMimeType
    };
  }
}

export async function digitizeDocumentFromUrl({ fileUrl, mimeType, fileName, title }) {
  const fetched = await fetchRemoteDocumentBuffer(fileUrl);
  return digitizeDocumentFromBytes({
    buffer: fetched.buffer,
    mimeType: fetched.mimeType || mimeType,
    fileName,
    title
  });
}

export async function digitizeDocumentFromStorage({ storagePath, fileUrl, mimeType, fileName, title }) {
  let lastError = null;

  if (storagePath) {
    try {
      const fetched = await fetchFirebaseStorageFileByPath(storagePath);
      return digitizeDocumentFromBytes({
        buffer: fetched.buffer,
        mimeType: fetched.mimeType || mimeType,
        fileName,
        title
      });
    } catch (error) {
      lastError = error;
      console.warn('[DocumentDigitization] Firebase Storage fetch fallback:', error.message);
    }
  }

  if (fileUrl) {
    return digitizeDocumentFromUrl({
      fileUrl,
      mimeType,
      fileName,
      title
    });
  }

  throw lastError || new Error('No document source was provided for digitization');
}

export function summarizeDigitizationForStorage(digitization) {
  if (!digitization?.ok) {
    if (digitization?.reason === 'native_digital') {
      return {
        content: null,
        classifiedType: null,
        classificationConfidence: 0,
        extractedFields: {},
        metadata: {
          digitization: {
            status: 'not_needed',
            supported: false,
            reason: 'native_digital',
            provider: null,
            interpretationProvider: null,
            claudeModel: null,
            processedAt: new Date().toISOString(),
            mimeType: digitization?.mimeType || null,
            pageCount: 0,
            rawTextLength: 0,
            documentType: null,
            classificationConfidence: 0,
            summary: null,
            extractionQuality: null,
            repairedLineCount: 0,
            keyFacts: [],
            parties: [],
            addresses: [],
            dates: [],
            monetaryAmounts: [],
            identifiers: [],
            actionItems: [],
            missingOrUnclear: [],
            reviewNotes: [],
            structuredSections: [],
            tableSummaries: [],
            lowConfidenceWords: [],
            error: null
          },
          ocrProcessed: false,
          extractedText: null,
          textLength: 0,
          classifiedType: null,
          classificationConfidence: 0,
          extractedFields: {},
          summary: null
        }
      };
    }

    return {
      content: null,
      classifiedType: null,
      classificationConfidence: 0,
      extractedFields: {},
      metadata: {
        digitization: {
          status: digitization?.status || 'failed',
          supported: digitization?.status !== 'skipped',
          provider: 'azure-document-intelligence',
          interpretationProvider: null,
          claudeModel: null,
          processedAt: new Date().toISOString(),
          mimeType: digitization?.mimeType || null,
          pageCount: 0,
          rawTextLength: 0,
          documentType: null,
          classificationConfidence: 0,
          summary: null,
          extractionQuality: null,
          repairedLineCount: 0,
          keyFacts: [],
          parties: [],
          addresses: [],
          dates: [],
          monetaryAmounts: [],
          identifiers: [],
          actionItems: [],
          missingOrUnclear: [],
          reviewNotes: [],
          structuredSections: [],
          tableSummaries: [],
          lowConfidenceWords: [],
          error: digitization?.error || null
        },
        ocrProcessed: false,
        extractedText: null,
        textLength: 0,
        classifiedType: null,
        classificationConfidence: 0,
        extractedFields: {},
        summary: null
      }
    };
  }

  return {
    content: digitization.extractedText,
    classifiedType: digitization.documentType,
    classificationConfidence: digitization.classificationConfidence,
    extractedFields: {
      ...digitization.extractedFields,
      keyFacts: digitization.keyFacts
    },
    metadata: {
      digitization: {
        status: digitization.status,
        supported: true,
        provider: digitization.providers.extraction,
        interpretationProvider: digitization.providers.interpretation,
        claudeModel: digitization.providers.claudeModel,
        processedAt: new Date().toISOString(),
        mimeType: digitization.mimeType,
        pageCount: digitization.pageCount,
        rawTextLength: digitization.rawTextLength,
        documentType: digitization.documentType,
        classificationConfidence: digitization.classificationConfidence,
        summary: digitization.summary,
        extractionQuality: digitization.extractionQuality,
        repairedLineCount: Array.isArray(digitization.repairedLines) ? digitization.repairedLines.length : 0,
        keyFacts: digitization.keyFacts,
        parties: digitization.extractedFields.parties,
        addresses: digitization.extractedFields.addresses,
        dates: digitization.extractedFields.dates,
        monetaryAmounts: digitization.extractedFields.monetaryAmounts,
        identifiers: digitization.extractedFields.identifiers,
        actionItems: digitization.extractedFields.actionItems,
        missingOrUnclear: digitization.extractedFields.missingOrUnclear,
        reviewNotes: digitization.extractedFields.reviewNotes,
        structuredSections: digitization.structuredSections,
        tableSummaries: digitization.tableSummaries,
        lowConfidenceWords: digitization.lowConfidenceWords,
        error: null
      },
      ocrProcessed: true,
      extractedText: digitization.extractedText,
      textLength: digitization.rawTextLength,
      classifiedType: digitization.documentType,
      classificationConfidence: digitization.classificationConfidence,
      extractedFields: {
        ...digitization.extractedFields,
        keyFacts: digitization.keyFacts
      },
      summary: digitization.summary
    }
  };
}

export async function buildDigitizedReplicaArtifacts({ digitization, sourceBuffer, sourceMimeType, fileName, title }) {
  if (!digitization?.ok || !Array.isArray(digitization.pages) || digitization.pages.length === 0) {
    return null;
  }

  const pages = digitization.pages.map((page) => ({
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    renderWidth: page.renderWidth || page.width,
    renderHeight: page.renderHeight || page.height,
    unit: page.unit || null,
    angle: page.angle || null,
    text: page.text || '',
    lines: Array.isArray(page.lines)
      ? page.lines.map((line) => ({
          id: line.id,
          text: line.text,
          bbox: line.bbox,
          angle: line.angle || 0,
          confidence: line.confidence || 0,
          paragraphRole: line.paragraphRole || null,
          paragraphId: line.paragraphId || null
        }))
      : [],
    paragraphs: Array.isArray(page.paragraphs)
      ? page.paragraphs.map((paragraph) => ({
          id: paragraph.id,
          role: paragraph.role || null,
          content: paragraph.content || '',
          bbox: paragraph.bbox || null,
          confidence: paragraph.confidence || 0,
          lineIds: Array.isArray(paragraph.lineIds) ? paragraph.lineIds : []
        }))
      : [],
    selectionMarks: Array.isArray(page.selectionMarks)
      ? page.selectionMarks.map((mark) => ({
          id: mark.id,
          pageNumber: mark.pageNumber,
          state: mark.state,
          confidence: mark.confidence || 0,
          bbox: mark.bbox,
          labelText: mark.labelText || ''
        }))
      : [],
    signatureAnchors: Array.isArray(page.signatureAnchors)
      ? page.signatureAnchors.map((anchor) => ({
          id: anchor.id,
          pageNumber: anchor.pageNumber,
          sourceLineId: anchor.sourceLineId,
          labelText: anchor.labelText,
          bbox: anchor.bbox
        }))
      : []
  }));

  const pagesWithSignatureImages = sourceBuffer
    ? await attachSignatureImagesToPages(sourceBuffer, pages, sourceMimeType || digitization.mimeType)
    : pages;

  const layoutPages = pagesWithSignatureImages.map((page) => ({
    ...page,
    signatureAnchors: Array.isArray(page.signatureAnchors)
      ? page.signatureAnchors.map(({ imageDataUrl, ...anchor }) => anchor)
      : []
  }));

  return {
    html: buildReplicaHtml(pagesWithSignatureImages, {
      title: title || digitization.title || fileName,
      fileName,
      mimeType: sourceMimeType || digitization.mimeType
    }),
    layout: {
      version: 3,
      generatedAt: new Date().toISOString(),
      title: title || digitization.title || fileName || 'Digitized Document',
      fileName: fileName || '',
      mimeType: sourceMimeType || digitization.mimeType,
      documentType: digitization.documentType,
      pageCount: digitization.pageCount,
      pages: layoutPages
    }
  };
}