import React, { useEffect, useRef, useState, memo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  PageRenderScheduler,
  CancelableRenderTask,
} from '../../services/pdfService';
import { BBoxHighlightOverlay } from './BBoxHighlightOverlay';
import { BBox } from '../../types/search';
import { Loader2, Check } from 'lucide-react';

interface PDFPageProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  scheduler: PageRenderScheduler;
  pageNumber: number;
  scale: number;
  shouldRender: boolean;
  estimatedWidth: number;
  estimatedHeight: number;
  highlightBboxes?: BBox[];
  isActivePage?: boolean;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (pageNumber: number) => void;
  onPageMeasured?: (pageWidthPt: number, pageHeightPt: number) => void;
  onPageRendered?: (pageNumber: number) => void;
}

export const PDFPage = memo(function PDFPage({
  pdfDoc,
  scheduler,
  pageNumber,
  scale,
  shouldRender,
  estimatedWidth,
  estimatedHeight,
  highlightBboxes = [],
  isActivePage = false,
  isSelectionMode = false,
  isSelected = false,
  onToggleSelect,
  onPageMeasured,
  onPageRendered,
}: PDFPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isRendered, setIsRendered] = useState(false);
  const [exactSize, setExactSize] = useState<{ w: number; h: number } | null>(null);

  const activeTaskRef = useRef<CancelableRenderTask | null>(null);
  const lastRenderedScaleRef = useRef<number | null>(null);

  // Release canvas memory cleanly when page scrolls far outside virtualization window
  useEffect(() => {
    if (!shouldRender) {
      if (activeTaskRef.current) {
        activeTaskRef.current.cancel();
        activeTaskRef.current = null;
      }
      if (isRendered) {
        setIsRendered(false);
        lastRenderedScaleRef.current = null;
      }
    }
  }, [shouldRender, isRendered]);

  // Schedule prioritized render ONLY when inside active reading window
  useEffect(() => {
    if (!shouldRender || !canvasRef.current) return;

    if (isRendered && lastRenderedScaleRef.current === scale) {
      if (isActivePage) scheduler.markPageRendered(pageNumber);
      return;
    }

    if (activeTaskRef.current) {
      activeTaskRef.current.cancel();
      activeTaskRef.current = null;
    }

    let isEffectActive = true;
    const task = scheduler.schedule(pdfDoc, pageNumber, canvasRef.current, scale);
    activeTaskRef.current = task;

    task.promise
      .then((res) => {
        if (isEffectActive) {
          setIsRendered(true);
          lastRenderedScaleRef.current = scale;
          setExactSize({ w: res.viewportWidth, h: res.viewportHeight });
          onPageMeasured?.(res.viewportWidth / scale, res.viewportHeight / scale);
          onPageRendered?.(pageNumber);
        }
      })
      .catch((err) => {
        if (err?.message !== 'RenderingCancelledException' && isEffectActive) {
          console.error(`Page ${pageNumber} render error:`, err);
        }
      });

    return () => {
      isEffectActive = false;
      task.cancel();
    };
  }, [pdfDoc, scheduler, pageNumber, scale, shouldRender, isActivePage]);

  const boxWidth = exactSize && lastRenderedScaleRef.current === scale ? exactSize.w : estimatedWidth;
  const boxHeight = exactSize && lastRenderedScaleRef.current === scale ? exactSize.h : estimatedHeight;

  return (
    <div
      id={`pdf-page-${pageNumber}`}
      style={{
        width: `${Math.round(boxWidth)}px`,
        height: `${Math.round(boxHeight)}px`,
        maxWidth: '100%',
      }}
      className={`relative mx-auto transition-all duration-200 rounded-lg overflow-hidden flex items-center justify-center pdf-canvas-container reader-page-shadow border ${
        isSelected
          ? 'ring-2 ring-sky-500 shadow-sky-500/20 border-sky-400'
          : isActivePage
          ? 'border-sky-500/35'
          : 'border-subtle'
      }`}
    >
      {/* Only mount <canvas> inside active virtualization window to save GPU memory */}
      {shouldRender && (
        <canvas
          ref={canvasRef}
          className={`block max-w-full h-auto transition-opacity duration-150 ${
            isRendered ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}

      {/* Lightweight Virtual Placeholder / Loading State */}
      {(!shouldRender || !isRendered) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-elevated/85 gap-2.5 text-muted select-none">
          {shouldRender ? (
            <>
              <Loader2 className="w-7 h-7 animate-spin text-sky-400" />
              <span className="text-xs font-mono font-medium">
                {isActivePage ? `Streaming Page ${pageNumber} first...` : `Prefetching Page ${pageNumber}...`}
              </span>
            </>
          ) : (
            <span className="text-xs font-mono text-dim/60">Page {pageNumber}</span>
          )}
        </div>
      )}

      {/* OCR Search Highlighting Overlay */}
      {shouldRender && highlightBboxes.length > 0 && (
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
