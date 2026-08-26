import React, { useEffect, useRef, useState, memo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { renderPDFPageCancelable, CancelableRenderTask } from '../../services/pdfService';
import { BBoxHighlightOverlay } from './BBoxHighlightOverlay';
import { BBox } from '../../types/search';
import { Loader2, Check } from 'lucide-react';

interface PDFPageProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  highlightBboxes?: BBox[];
  isActivePage?: boolean;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (pageNumber: number) => void;
}

export const PDFPage = memo(function PDFPage({
  pdfDoc,
  pageNumber,
  scale,
  highlightBboxes = [],
  isActivePage = false,
  isSelectionMode = false,
  isSelected = false,
  onToggleSelect,
}: PDFPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isRendered, setIsRendered] = useState(false);
  const [isNearViewport, setIsNearViewport] = useState(isActivePage || highlightBboxes.length > 0);
  const [aspectRatio, setAspectRatio] = useState<number>(0.75);

  const activeTaskRef = useRef<CancelableRenderTask | null>(null);
  const lastRenderedScaleRef = useRef<number | null>(null);

  // 1. Intersection Observer for Virtualized Lazy Loading
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting) {
          setIsNearViewport(true);
        }
      },
      {
        rootMargin: '800px 0px 800px 0px',
        threshold: 0.05,
      }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [pageNumber]);

  // Immediately enable viewport when active or highlighted
  useEffect(() => {
    if (isActivePage || (highlightBboxes && highlightBboxes.length > 0)) {
      setIsNearViewport(true);
    }
  }, [isActivePage, highlightBboxes]);

  // 2. Fetch page dimensions for placeholder aspect ratio
  useEffect(() => {
    let isCancelled = false;
    pdfDoc.getPage(pageNumber).then((page) => {
      if (!isCancelled) {
        const view = page.getViewport({ scale: 1 });
        setAspectRatio(view.width / view.height);
      }
    }).catch(console.error);

    return () => {
      isCancelled = true;
    };
  }, [pdfDoc, pageNumber]);

  // 3. Render Canvas with Cancellation Protection
  useEffect(() => {
    if (!isNearViewport || !canvasRef.current) return;

    // If already rendered at this exact scale, don't re-render
    if (isRendered && lastRenderedScaleRef.current === scale) {
      return;
    }

    // Cancel any ongoing render task on this canvas before starting a new one
    if (activeTaskRef.current) {
      activeTaskRef.current.cancel();
      activeTaskRef.current = null;
    }

    let isEffectActive = true;
    const task = renderPDFPageCancelable(pdfDoc, pageNumber, canvasRef.current, scale);
    activeTaskRef.current = task;

    task.promise
      .then(() => {
        if (isEffectActive) {
          setIsRendered(true);
          lastRenderedScaleRef.current = scale;
        }
      })
      .catch((err) => {
        // Ignore cancellation errors
        if (err?.message !== 'RenderingCancelledException' && isEffectActive) {
          console.error(`Page ${pageNumber} render error:`, err);
        }
      });

    return () => {
      isEffectActive = false;
      task.cancel();
    };
  }, [pdfDoc, pageNumber, scale, isNearViewport]);

  return (
    <div
      ref={containerRef}
      id={`pdf-page-${pageNumber}`}
      className={`relative mx-auto my-4 transition-all duration-200 shadow-xl rounded-lg overflow-hidden bg-surface-elevated flex items-center justify-center pdf-canvas-container border ${
        isSelected
          ? 'ring-2 ring-sky-500 shadow-sky-500/20 border-sky-400'
          : 'border-subtle'
      }`}
      style={{
        maxWidth: '100%',
        minHeight: isRendered ? 'auto' : '650px',
      }}
    >
      {/* Canvas Layer */}
      <canvas
        ref={canvasRef}
        className={`block transition-opacity duration-200 ${
          isRendered ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Loading Skeleton */}
      {!isRendered && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-elevated/80 gap-3 text-muted">
          <Loader2 className="w-8 h-8 animate-spin text-sky-400" />
          <span className="text-xs font-mono font-medium">Loading Page {pageNumber}...</span>
        </div>
      )}

      {/* OCR Search Highlighting Overlay */}
      {highlightBboxes.length > 0 && (
        <BBoxHighlightOverlay bboxes={highlightBboxes} isActivePage={isActivePage} />
      )}

      {/* Page Selection Overlay & Toggle Button */}
      {isSelectionMode && (
        <div
          onClick={() => onToggleSelect?.(pageNumber)}
          className={`absolute top-3 right-3 z-20 cursor-pointer flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl backdrop-blur-md transition-all shadow-lg select-none ${
            isSelected
              ? 'bg-sky-500 text-slate-950 font-bold border border-sky-400 shadow-sky-500/30'
              : 'bg-black/60 hover:bg-black/80 text-white font-medium border border-white/20'
          }`}
        >
          <div
            className={`w-4 h-4 rounded-md flex items-center justify-center border transition-colors ${
              isSelected
                ? 'bg-slate-950 border-slate-950 text-sky-400'
                : 'border-white/40 bg-white/10'
            }`}
          >
            {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
          </div>
          <span className="text-xs font-mono">
            {isSelected ? `Page ${pageNumber} Selected` : `Select Page ${pageNumber}`}
          </span>
        </div>
      )}

      {/* Page Number Watermark */}
      <div className="absolute bottom-2 right-3 px-2 py-0.5 rounded bg-black/60 backdrop-blur-sm text-[10px] font-mono text-zinc-400 pointer-events-none z-10">
        p. {pageNumber}
      </div>
    </div>
  );
});

