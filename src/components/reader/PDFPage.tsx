import React, { useEffect, useRef, useState, memo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  PageRenderScheduler,
  CancelableRenderTask,
} from '../../services/pdfService';
import { BBoxHighlightOverlay } from './BBoxHighlightOverlay';
import { BBox } from '../../types/search';
import { UserHighlight } from '../../services/highlightService';
import { Loader2, Check, Trash2, X } from 'lucide-react';

interface PDFPageProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  scheduler: PageRenderScheduler;
  pageNumber: number;
  scale: number;
  rotation?: number;
  shouldRender: boolean;
  estimatedWidth: number;
  estimatedHeight: number;
  highlightBboxes?: BBox[];
  userHighlights?: UserHighlight[];
  isActivePage?: boolean;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (pageNumber: number) => void;
  onPageMeasured?: (pageWidthPt: number, pageHeightPt: number) => void;
  onPageRendered?: (pageNumber: number) => void;
  onRemoveHighlight?: (highlightId: string) => void;
}

export const PDFPage = memo(function PDFPage({
  pdfDoc,
  scheduler,
  pageNumber,
  scale,
  rotation = 0,
  shouldRender,
  estimatedWidth,
  estimatedHeight,
  highlightBboxes = [],
  userHighlights = [],
  isActivePage = false,
  isSelectionMode = false,
  isSelected = false,
  onToggleSelect,
  onPageMeasured,
  onPageRendered,
  onRemoveHighlight,
}: PDFPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const textLayerTaskRef = useRef<any>(null);

  const [isRendered, setIsRendered] = useState(false);
  const [exactSize, setExactSize] = useState<{ w: number; h: number } | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);

  const activeTaskRef = useRef<CancelableRenderTask | null>(null);
  const lastRenderedScaleRef = useRef<number | null>(null);
  const lastRenderedRotationRef = useRef<number | null>(null);

  const lastRenderedTextScaleRef = useRef<number | null>(null);
  const lastRenderedTextRotationRef = useRef<number | null>(null);
  const lastRenderedTextPageRef = useRef<number | null>(null);

  // Release canvas and text layer memory cleanly when page scrolls outside virtualization window
  useEffect(() => {
    if (!shouldRender) {
      if (activeTaskRef.current) {
        activeTaskRef.current.cancel();
        activeTaskRef.current = null;
      }
      if (textLayerTaskRef.current) {
        try {
          textLayerTaskRef.current.cancel();
        } catch {}
        textLayerTaskRef.current = null;
      }
      if (isRendered) {
        setIsRendered(false);
        lastRenderedScaleRef.current = null;
        lastRenderedRotationRef.current = null;
        lastRenderedTextScaleRef.current = null;
        lastRenderedTextRotationRef.current = null;
        lastRenderedTextPageRef.current = null;
      }
    }
  }, [shouldRender, isRendered]);

  // Schedule prioritized canvas render ONLY when inside active reading window
  useEffect(() => {
    if (!shouldRender || !canvasRef.current) return;

    if (
      isRendered &&
      lastRenderedScaleRef.current === scale &&
      lastRenderedRotationRef.current === rotation
    ) {
      if (isActivePage) scheduler.markPageRendered(pageNumber);
      return;
    }

    if (activeTaskRef.current) {
      activeTaskRef.current.cancel();
      activeTaskRef.current = null;
    }

    let isEffectActive = true;
    const task = scheduler.schedule(pdfDoc, pageNumber, canvasRef.current, scale, rotation);
    activeTaskRef.current = task;

    task.promise
      .then((res) => {
        if (isEffectActive) {
          setIsRendered(true);
          lastRenderedScaleRef.current = scale;
          lastRenderedRotationRef.current = rotation;
          setExactSize({ w: res.viewportWidth, h: res.viewportHeight });
          const isSideways = rotation === 90 || rotation === 270;
          const unrotatedW = isSideways ? res.viewportHeight / scale : res.viewportWidth / scale;
          const unrotatedH = isSideways ? res.viewportWidth / scale : res.viewportHeight / scale;
          onPageMeasured?.(unrotatedW, unrotatedH);
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
  }, [pdfDoc, scheduler, pageNumber, scale, rotation, shouldRender, isActivePage]);

  // Render High-Precision Edge Selectable Text Layer over canvas
  useEffect(() => {
    if (!shouldRender || !isRendered || !textLayerRef.current) return;

    // Guard: If text layer is already rendered for this scale & rotation, NEVER destroy innerHTML!
    if (
      lastRenderedTextPageRef.current === pageNumber &&
      lastRenderedTextScaleRef.current === scale &&
      lastRenderedTextRotationRef.current === rotation &&
      textLayerRef.current.childNodes.length > 0
    ) {
      return;
    }

    let isEffectActive = true;
    if (textLayerTaskRef.current) {
      try {
        textLayerTaskRef.current.cancel();
      } catch {}
      textLayerTaskRef.current = null;
    }

    const container = textLayerRef.current;
    container.innerHTML = '';

    pdfDoc.getPage(pageNumber).then(async (page) => {
      if (!isEffectActive || !container) return;

      const viewport = page.getViewport({ scale, rotation });
      container.style.setProperty('--scale-factor', String(viewport.scale));
      container.style.width = `${Math.round(viewport.width)}px`;
      container.style.height = `${Math.round(viewport.height)}px`;

      try {
        const textContent = await page.getTextContent();
        if (!isEffectActive) return;

        const textLayer = new (pdfjsLib as any).TextLayer({
          textContentSource: textContent,
          container,
          viewport,
        });

        textLayerTaskRef.current = textLayer;
        await textLayer.render();
        if (isEffectActive) {
          lastRenderedTextPageRef.current = pageNumber;
          lastRenderedTextScaleRef.current = scale;
          lastRenderedTextRotationRef.current = rotation;
        }
      } catch (err: any) {
        if (err?.name !== 'AbortException' && isEffectActive) {
          console.warn(`TextLayer error on page ${pageNumber}:`, err);
        }
      }
    });

    return () => {
      isEffectActive = false;
      if (textLayerTaskRef.current) {
        try {
          textLayerTaskRef.current.cancel();
        } catch {}
        textLayerTaskRef.current = null;
      }
    };
  }, [pdfDoc, pageNumber, scale, rotation, shouldRender, isRendered]);

  const boxWidth =
    exactSize && lastRenderedScaleRef.current === scale && lastRenderedRotationRef.current === rotation
      ? exactSize.w
      : estimatedWidth;
  const boxHeight =
    exactSize && lastRenderedScaleRef.current === scale && lastRenderedRotationRef.current === rotation
      ? exactSize.h
      : estimatedHeight;

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
      {/* 1. Canvas Layer (Pixel rendering) */}
      {shouldRender && (
        <canvas
          ref={canvasRef}
          className={`block max-w-full h-auto transition-opacity duration-150 ${
            isRendered ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}

      {/* 2. High-Precision Edge/Adobe Selectable Text Layer (Vector text over canvas) */}
      {shouldRender && isRendered && (
        <div
          ref={textLayerRef}
          className={`textLayer ${isSelectionMode ? 'pointer-events-none' : ''}`}
          style={{
            width: `${Math.round(boxWidth)}px`,
            height: `${Math.round(boxHeight)}px`,
          }}
        />
      )}

      {/* 3. Lightweight Virtual Placeholder / Loading State */}
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

      {/* 4. OCR Search Highlighting Overlay */}
      {shouldRender && highlightBboxes.length > 0 && (
        <BBoxHighlightOverlay bboxes={highlightBboxes} isActivePage={isActivePage} />
      )}

      {/* 5. User Highlights Overlay */}
      {shouldRender && userHighlights && userHighlights.length > 0 && (
        <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
          {userHighlights.map((hl) => {
            const bgClasses = {
              yellow: 'bg-yellow-400/35 border-b-2 border-yellow-400/80 hover:bg-yellow-400/50',
              green: 'bg-emerald-400/35 border-b-2 border-emerald-400/80 hover:bg-emerald-400/50',
              blue: 'bg-sky-400/35 border-b-2 border-sky-400/80 hover:bg-sky-400/50',
              pink: 'bg-pink-400/35 border-b-2 border-pink-400/80 hover:bg-pink-400/50',
            };
            return (
              <React.Fragment key={hl.id}>
                {hl.rects?.map((r, i) => (
                  <div
                    key={`${hl.id}_${i}`}
                    style={{
                      left: `${r.x * 100}%`,
                      top: `${r.y * 100}%`,
                      width: `${r.w * 100}%`,
                      height: `${r.h * 100}%`,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedHighlightId((prev) => (prev === hl.id ? null : hl.id));
                    }}
                    title={`Highlighted: "${hl.text.slice(0, 45)}..." — Click to delete`}
                    className={`absolute rounded-xs cursor-pointer pointer-events-auto transition-colors ${
                      bgClasses[hl.color] || bgClasses.yellow
                    }`}
                  />
                ))}
                {selectedHighlightId === hl.id && hl.rects && hl.rects[0] && (
                  <div
                    style={{
                      left: `${Math.min(85, Math.max(5, hl.rects[0].x * 100))}%`,
                      top: `${Math.max(2, hl.rects[0].y * 100 - 5)}%`,
                    }}
                    className="absolute z-30 pointer-events-auto -translate-y-full flex items-center gap-1.5 p-1 rounded-xl bg-slate-950/95 text-white border border-white/20 shadow-2xl animate-fadeIn select-none"
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveHighlight?.(hl.id);
                        setSelectedHighlightId(null);
                      }}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-500/25 hover:bg-rose-500 text-rose-300 hover:text-white text-[11px] font-semibold transition-colors"
                      title="Delete this highlight"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Remove</span>
                    </button>
                    <div className="w-[1px] h-3.5 bg-white/20" />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedHighlightId(null);
                      }}
                      className="p-1 rounded-lg hover:bg-white/15 text-white/60 hover:text-white"
                      title="Close"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* 6. Page Selection Overlay & Toggle Button */}
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

      {/* 7. Page Number Watermark */}
      <div className="absolute bottom-2 right-3 px-2 py-0.5 rounded bg-black/60 backdrop-blur-sm text-[10px] font-mono text-zinc-400 pointer-events-none z-10">
        p. {pageNumber}
      </div>
    </div>
  );
});
