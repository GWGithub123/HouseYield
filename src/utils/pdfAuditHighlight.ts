import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface PdfTextHighlight {
  pageNumber: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TextSpan {
  start: number;
  end: number;
  rect: PdfTextHighlight;
}

function normalizeSearchText(value = '') {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function getSearchCandidates(query: string, excerpt?: string) {
  const candidates = new Set<string>();
  const normalizedQuery = normalizeSearchText(query);
  const normalizedExcerpt = normalizeSearchText(excerpt || '');

  if (normalizedExcerpt.length >= 12) {
    candidates.add(normalizedExcerpt);
  }
  if (normalizedQuery.length >= 12) {
    candidates.add(normalizedQuery);
  }

  const tokens = normalizedQuery
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 4)
    .slice(0, 4);

  if (tokens.length >= 2) {
    candidates.add(tokens.join(' '));
  }

  tokens.forEach((token) => {
    if (token.length >= 5) {
      candidates.add(token);
    }
  });

  return Array.from(candidates).sort((left, right) => right.length - left.length);
}

function buildPageTextSpans(pageNumber: number, page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>): {
  normalizedText: string;
  spans: TextSpan[];
} {
  return page.getTextContent().then((textContent) => {
    const viewport = page.getViewport({ scale: 1 });
    const spans: TextSpan[] = [];
    let normalizedText = '';

    textContent.items.forEach((rawItem) => {
      if (!('str' in rawItem) || !rawItem.str) {
        return;
      }

      const item = rawItem as {
        str: string;
        transform: number[];
        width: number;
        height: number;
      };

      const start = normalizedText.length;
      normalizedText += item.str;
      const end = normalizedText.length;

      const transform = item.transform;
      const x = transform[4];
      const y = transform[5];
      const height = Math.max(
        Math.hypot(transform[2], transform[3]),
        item.height || 0,
        8
      );
      const width = Math.max(item.width || 0, item.str.length * (height * 0.45));

      spans.push({
        start,
        end,
        rect: {
          pageNumber,
          left: (x / viewport.width) * 100,
          top: ((viewport.height - y - height) / viewport.height) * 100,
          width: (width / viewport.width) * 100,
          height: (height / viewport.height) * 100,
        },
      });

      normalizedText += ' ';
    });

    return {
      normalizedText: normalizeSearchText(normalizedText),
      spans,
    };
  });
}

function mergeSpanRects(spans: TextSpan[], startIndex: number, endIndex: number, pageNumber: number): PdfTextHighlight | null {
  const matchedSpans = spans.filter((span) => span.end > startIndex && span.start < endIndex);
  if (matchedSpans.length === 0) {
    return null;
  }

  const left = Math.min(...matchedSpans.map((span) => span.rect.left));
  const top = Math.min(...matchedSpans.map((span) => span.rect.top));
  const right = Math.max(...matchedSpans.map((span) => span.rect.left + span.rect.width));
  const bottom = Math.max(...matchedSpans.map((span) => span.rect.top + span.rect.height));

  return {
    pageNumber,
    left,
    top,
    width: Math.max(right - left, 0.5),
    height: Math.max(bottom - top, 0.8),
  };
}

function findMatchesInPage(
  pageNumber: number,
  normalizedText: string,
  spans: TextSpan[],
  candidates: string[]
): PdfTextHighlight[] {
  const highlights: PdfTextHighlight[] = [];

  candidates.forEach((candidate) => {
    let fromIndex = 0;
    while (fromIndex < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(candidate, fromIndex);
      if (matchIndex === -1) {
        break;
      }

      const merged = mergeSpanRects(spans, matchIndex, matchIndex + candidate.length, pageNumber);
      if (merged) {
        highlights.push(merged);
      }

      fromIndex = matchIndex + Math.max(candidate.length, 1);
    }
  });

  return highlights;
}

export async function findPdfTextHighlights(
  pdf: PDFDocumentProxy,
  query: string,
  excerpt?: string
): Promise<PdfTextHighlight[]> {
  if (!query.trim()) {
    return [];
  }

  const candidates = getSearchCandidates(query, excerpt);
  if (candidates.length === 0) {
    return [];
  }

  const highlights: PdfTextHighlight[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const { normalizedText, spans } = await buildPageTextSpans(pageNumber, page);
    if (!normalizedText) {
      continue;
    }

    const pageHighlights = findMatchesInPage(pageNumber, normalizedText, spans, candidates);
    highlights.push(...pageHighlights);
  }

  const deduped: PdfTextHighlight[] = [];
  highlights.forEach((highlight) => {
    const duplicate = deduped.some((existing) =>
      existing.pageNumber === highlight.pageNumber
      && Math.abs(existing.left - highlight.left) < 0.4
      && Math.abs(existing.top - highlight.top) < 0.4
    );
    if (!duplicate) {
      deduped.push(highlight);
    }
  });

  return deduped.slice(0, 8);
}
