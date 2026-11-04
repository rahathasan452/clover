import React, { useEffect, useRef, useState, memo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  PageRenderScheduler,
  CancelableRenderTask,
} from '../../services/pdfService';
import { BBoxHighlightOverlay } from './BBoxHighlightOverlay';
import { BBox } from '../../types/search';
import { UserHighlight } from '../../services/highlightService';
import { Loader2, Check } from 'lucide-react';

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
  onPageTextExtracted?: (pageNumber: number, text: string) => void;
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
  onPageTextExtracted,
}: PDFPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const textLayerTaskRef = useRef<any>(null);

  const [isRendered, setIsRendered] = useState(false);
  const [exactSize, setExactSize] = useState<{ w: number; h: number } | null>(null);

  const activeTaskRef = useRef<CancelableRenderTask | null>(null);
  const lastRenderedScaleRef = useRef<number | null>(null);
  const lastRenderedRotationRef = useRef<number | null>(null);

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
  }, [pdfDoc, scheduler, pageNumber, scale, rotation, shouldRender, isActivePage]);

  // Render High-Precision Edge/Adobe Selectable Text Layer over canvas
  useEffect(() => {
    if (!shouldRender || !isRendered || !textLayerRef.current) return;

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

        // Provide text content to parent for Edge Read Aloud
        const strings = textContent.items
          .filter((i: any) => typeof i?.str === 'string')
          .map((i: any) => i.str);
        if (strings.length > 0) {
          onPageTextExtracted?.(pageNumber, strings.join(' '));
        }

        const textLayer = new (pdfjsLib as any).TextLayer({
          textContentSource: textContent,
          container,
          viewport,
        });

        textLayerTaskRef.current = textLayer;
        await textLayer.render();
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
  }, [pdfDoc, pageNumber, scale, rotation, shouldRender, isRendered, onPageTextExtracted]);

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
              yellow: 'bg-yellow-400/35 border-b-2 border-yellow-400/70',
              green: 'bg-emerald-400/35 border-b-2 border-emerald-400/70',
              blue: 'bg-sky-400/35 border-b-2 border-sky-400/70',
              pink: 'bg-pink-400/35 border-b-2 border-pink-400/70',
            };
            return hl.rects?.map((r, i) => (
              <div
                key={`${hl.id}_${i}`}
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                }}
                title={hl.text}
                className={`absolute rounded-xs ${bgClasses[hl.color] || bgClasses.yellow}`}
              />
            ));
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
