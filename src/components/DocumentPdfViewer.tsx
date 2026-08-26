import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { findPdfTextHighlights, type PdfTextHighlight } from '../utils/pdfAuditHighlight';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface DocumentPdfViewerProps {
  fileUrl: string;
  title: string;
  highlightQuery?: string;
  highlightExcerpt?: string;
  activeHighlightIndex?: number;
  onHighlightCountChange?: (count: number) => void;
  onActiveHighlightChange?: (highlight: PdfTextHighlight | null, index: number) => void;
}

const DocumentPdfViewer: React.FC<DocumentPdfViewerProps> = ({
  fileUrl,
  title,
  highlightQuery = '',
  highlightExcerpt = '',
  activeHighlightIndex = 0,
  onHighlightCountChange,
  onActiveHighlightChange,
}) => {
  const [numPages, setNumPages] = useState(0);
  const [pageWidth, setPageWidth] = useState(760);
  const [highlights, setHighlights] = useState<PdfTextHighlight[]>([]);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    const node = shellRef.current;
    if (!node) {
      return undefined;
    }

    const updateWidth = () => {
      const nextWidth = Math.max(Math.min(node.clientWidth - 36, 920), 280);
      setPageWidth(nextWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!pdfDocument || !highlightQuery.trim()) {
      setHighlights([]);
      onHighlightCountChange?.(0);
      return () => {
        cancelled = true;
      };
    }

    void findPdfTextHighlights(pdfDocument, highlightQuery, highlightExcerpt).then((nextHighlights) => {
      if (cancelled) {
        return;
      }
      setHighlights(nextHighlights);
      onHighlightCountChange?.(nextHighlights.length);
    });

    return () => {
      cancelled = true;
    };
  }, [highlightExcerpt, highlightQuery, onHighlightCountChange, pdfDocument]);

  const activeHighlight = highlights[activeHighlightIndex] || highlights[0] || null;

  useEffect(() => {
    if (!activeHighlight) {
      onActiveHighlightChange?.(null, activeHighlightIndex);
      return;
    }

    onActiveHighlightChange?.(activeHighlight, activeHighlightIndex);
    pageRefs.current[activeHighlight.pageNumber]?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [activeHighlight, activeHighlightIndex, highlights.length, onActiveHighlightChange]);

  const highlightsByPage = useMemo(() => {
    const grouped: Record<number, PdfTextHighlight[]> = {};
    highlights.forEach((highlight) => {
      grouped[highlight.pageNumber] = grouped[highlight.pageNumber] || [];
      grouped[highlight.pageNumber].push(highlight);
    });
    return grouped;
  }, [highlights]);

  return (
    <div ref={shellRef} className="doc-viewer-pdf-shell">
      <Document
        file={fileUrl}
        loading={<div className="doc-viewer-pdf-state">Loading PDF...</div>}
        error={<div className="doc-viewer-pdf-state error">Unable to render this PDF preview.</div>}
        onLoadSuccess={(pdf) => {
          setPdfDocument(pdf);
          setNumPages(pdf.numPages);
        }}
      >
        {Array.from({ length: numPages }, (_, index) => {
          const pageNumber = index + 1;
          const pageHighlights = highlightsByPage[pageNumber] || [];

          return (
            <div
              key={`pdf-page-${pageNumber}`}
              ref={(node) => {
                pageRefs.current[pageNumber] = node;
              }}
              className={`doc-viewer-pdf-page ${activeHighlight?.pageNumber === pageNumber ? 'active' : ''}`}
            >
              <div className="doc-viewer-pdf-page-meta">Page {pageNumber}</div>
              <div className="doc-viewer-pdf-page-frame">
                <Page
                  pageNumber={pageNumber}
                  width={pageWidth}
                  renderAnnotationLayer={false}
                  renderTextLayer
                  loading={<div className="doc-viewer-pdf-state">Rendering page...</div>}
                />
                <div className="doc-viewer-pdf-highlight-layer" aria-hidden="true">
                  {pageHighlights.map((highlight, highlightIndex) => (
                    <div
                      key={`${pageNumber}-${highlight.left}-${highlight.top}-${highlightIndex}`}
                      className={`doc-viewer-pdf-highlight ${
                        activeHighlight === highlight ? 'active' : ''
                      }`}
                      style={{
                        left: `${highlight.left}%`,
                        top: `${highlight.top}%`,
                        width: `${highlight.width}%`,
                        height: `${highlight.height}%`,
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </Document>
      {numPages === 0 && (
        <div className="doc-viewer-pdf-state">Preparing {title}...</div>
      )}
    </div>
  );
};

export default DocumentPdfViewer;
