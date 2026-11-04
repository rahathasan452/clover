import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Book } from '../../types/book';
import { ReaderTheme, ViewMode, HighlightTarget, Bookmark } from '../../types/reader';
import {
  loadPDFDocument,
  PageRenderScheduler,
  StreamStats,
} from '../../services/pdfService';
import {
  isBookSavedOffline,
  saveBookOffline,
  removeOfflineBook,
} from '../../services/pdfCacheService';
import { resolveAssetUrl, getAuthHeaders } from '../../services/hfStorage';
import {
  saveReadingProgress,
  getAllBookmarks,
  toggleBookmark,
  getSavedViewMode,
  saveViewMode,
} from '../../services/storageService';
import {
  renderMultiPageScreenshot,
  copyScreenshotToClipboard,
} from '../../services/screenshotService';
import { PDFPage } from './PDFPage';
import { ReaderToolbar } from './ReaderToolbar';
import { TOCDrawer } from './TOCDrawer';
import { PageSelectionDock } from './PageSelectionDock';
import { ScreenshotModal } from './ScreenshotModal';
import { TextSelectionDock } from './TextSelectionDock';
import {
  UserHighlight,
  getBookHighlights,
  removeBookHighlight,
  removeHighlightsOnPage,
} from '../../services/highlightService';
import { Toast, ToastState } from '../common/Toast';
import { Loader2, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';

const EMPTY_HIGHLIGHTS: UserHighlight[] = [];

interface PDFReaderProps {
  book: Book;
  initialPage?: number;
  highlightTarget?: HighlightTarget | null;
  currentTheme: ReaderTheme;
  onThemeChange: (theme: ReaderTheme) => void;
  onOpenSearch: (bookIdFilter?: string, categoryFilter?: string) => void;
  onBackToLibrary: () => void;
  onEditBook?: (book: Book) => void;
}

export function PDFReader({
  book,
  initialPage = 1,
  highlightTarget,
  currentTheme,
  onThemeChange,
  onOpenSearch,
  onBackToLibrary,
  onEditBook,
}: PDFReaderProps) {
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(
    highlightTarget?.page || initialPage || 1
  );
  const [scale, setScale] = useState<number>(1.25);
  const [rotation, setRotation] = useState<number>(0);
  const [viewMode, setViewMode] = useState<ViewMode>(() => getSavedViewMode());
  const [isTOCSidebarOpen, setIsTOCSidebarOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [userHighlights, setUserHighlights] = useState<UserHighlight[]>(() =>
    getBookHighlights(book.id)
  );

  // Group highlights by page number with a stable map to avoid PDFPage re-renders
  const pageHighlights = useMemo(() => {
    const map = new Map<number, UserHighlight[]>();
    for (const hl of userHighlights) {
      const list = map.get(hl.pageNumber) || [];
      list.push(hl);
      map.set(hl.pageNumber, list);
    }
    return map;
  }, [userHighlights]);

  // Edge-style Floating Text Selection Dock state
  const [selectionDock, setSelectionDock] = useState<{
    text: string;
    pageNumber: number;
    position: { top: number; left: number };
    rects: { x: number; y: number; w: number; h: number }[];
  } | null>(null);

  const hasExistingHighlight = useMemo(() => {
    if (!selectionDock) return false;
    return userHighlights.some(
      (h) =>
        h.pageNumber === selectionDock.pageNumber &&
        (selectionDock.text.includes(h.text) || h.text.includes(selectionDock.text))
    );
  }, [selectionDock, userHighlights]);

  const handleHighlightAdded = useCallback(
    (newHl: UserHighlight) => {
      setUserHighlights((prev) => [newHl, ...prev]);
      setToast({
        message: 'Highlight added',
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => {
            const updated = removeBookHighlight(book.id, newHl.id);
            setUserHighlights(updated);
          },
        },
      });
    },
    [book.id]
  );

  const handleRemoveHighlight = useCallback(
    (highlightId: string) => {
      const updated = removeBookHighlight(book.id, highlightId);
      setUserHighlights(updated);
      setToast({ message: 'Highlight removed', type: 'info' });
    },
    [book.id]
  );

  const handleRemoveSelectionHighlights = useCallback(
    (pageNumber: number, text: string) => {
      const updated = removeHighlightsOnPage(book.id, pageNumber, text);
      setUserHighlights(updated);
      setToast({ message: 'Highlight removed', type: 'info' });
    },
    [book.id]
  );

  // Measured unscaled PDF page dimensions (default US Letter 612x792pt until active page measures)
  const [basePagePt, setBasePagePt] = useState<{ w: number; h: number }>({
    w: 612,
    h: 792,
  });

  // Offline & Streaming Telemetry
  const [isOfflineSaved, setIsOfflineSaved] = useState<boolean>(() =>
    isBookSavedOffline(book.id)
  );
  const [offlineSavingProgress, setOfflineSavingProgress] = useState<number | null>(null);
  const [streamStats, setStreamStats] = useState<StreamStats | null>(null);

  // Multi-Page Screenshot & Selection state
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [isScreenshotModalOpen, setIsScreenshotModalOpen] = useState(false);
  const [isQuickCapturing, setIsQuickCapturing] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const scheduler = useMemo(() => new PageRenderScheduler(), [book.id]);
  const renderedPagesSetRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    return () => {
      scheduler.destroy();
    };
  }, [scheduler]);

  // Keep priority queue locked onto currentPage FIRST
  useEffect(() => {
    scheduler.setActivePage(currentPage, renderedPagesSetRef.current.has(currentPage));
  }, [scheduler, currentPage]);

  useEffect(() => {
    renderedPagesSetRef.current.clear();
  }, [scale, rotation, book.id]);

  // Keep reader locked onto currentPage when zooming or rotating
  useEffect(() => {
    if (!pdfDoc) return;

    isScrollingProgrammatically.current = true;
    scheduler.setActivePage(currentPage, false);

    if (viewMode === 'continuous') {
      const pageEl = document.getElementById(`pdf-page-${currentPage}`);
      if (pageEl) {
        pageEl.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    }

    const timer = setTimeout(() => {
      isScrollingProgrammatically.current = false;
    }, 350);

    return () => clearTimeout(timer);
  }, [scale, rotation, currentPage, pdfDoc, scheduler, viewMode]);

  // Load bookmarks, offline status, and user highlights on book mount
  useEffect(() => {
    setBookmarks(getAllBookmarks(book.id));
    setIsOfflineSaved(isBookSavedOffline(book.id));
    setUserHighlights(getBookHighlights(book.id));
  }, [book.id]);

  // Load PDF document via Linearized CachedRangeTransport (fetches ONLY first 128 KB + current page!)
  useEffect(() => {
    let isCancelled = false;
    setIsLoading(true);
    setError(null);
    setStreamStats(null);

    const cleanPath = (book.pdfUrl || `data/pdfs/${book.id}.pdf`).replace(/^\//, '');
    const pdfUrl = resolveAssetUrl(cleanPath);
    const headers = getAuthHeaders();

    loadPDFDocument(pdfUrl, {
      bookId: book.id,
      knownFileSize: book.fileSize,
      httpHeaders: headers,
      onStreamStats: (stats) => {
        if (!isCancelled) setStreamStats(stats);
      },
    })
      .then((doc) => {
        if (!isCancelled) {
          setPdfDoc(doc);
          setIsLoading(false);
        }
      })
      .catch(() => {
        return loadPDFDocument(`/${cleanPath}`, {
          bookId: book.id,
          knownFileSize: book.fileSize,
          onStreamStats: (stats) => {
            if (!isCancelled) setStreamStats(stats);
          },
        })
          .then((doc) => {
            if (!isCancelled) {
              setPdfDoc(doc);
              setIsLoading(false);
            }
          })
          .catch((err) => {
            if (!isCancelled) {
              console.error('PDF loading error:', err);
              setError(err.message || 'Failed to stream PDF document');
              setIsLoading(false);
            }
          });
      });

    return () => {
      isCancelled = true;
    };
  }, [book.id, book.pdfUrl, book.fileSize]);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    saveViewMode(mode);
  }, []);

  const handlePageMeasured = useCallback((wPt: number, hPt: number) => {
    if (wPt > 50 && hPt > 50) {
      setBasePagePt((prev) => {
        if (Math.abs(prev.w - wPt) < 2 && Math.abs(prev.h - hPt) < 2) return prev;
        return { w: wPt, h: hPt };
      });
    }
  }, []);

  const handlePageRendered = useCallback(
    (pageNum: number) => {
      renderedPagesSetRef.current.add(pageNum);
      scheduler.markPageRendered(pageNum);
    },
    [scheduler]
  );

  const isScrollingProgrammatically = useRef(false);

  // Navigate / Scroll to page reliably
  const scrollToPage = useCallback(
    (pageNum: number, smooth: boolean = true) => {
      const clamped = Math.max(1, Math.min(book.totalPages, pageNum));
      setCurrentPage(clamped);
      saveReadingProgress(book.id, clamped, book.totalPages);

      if (viewMode === 'single' || viewMode === 'dual') {
        containerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
        return;
      }

      isScrollingProgrammatically.current = true;

      const performScroll = (attempts = 0) => {
        const pageElement = document.getElementById(`pdf-page-${clamped}`);
        if (pageElement) {
          pageElement.scrollIntoView({
            behavior: smooth ? 'smooth' : 'auto',
            block: 'start',
          });
          setTimeout(
            () => {
              isScrollingProgrammatically.current = false;
            },
            smooth ? 550 : 90
          );
        } else if (attempts < 15) {
          setTimeout(() => performScroll(attempts + 1), 50);
        } else {
          isScrollingProgrammatically.current = false;
        }
      };

      performScroll();
    },
    [book.id, book.totalPages, viewMode]
  );

  // Jump to target page when document or highlightTarget changes
  useEffect(() => {
    if (pdfDoc) {
      const target = highlightTarget?.page || initialPage || 1;
      scrollToPage(target, false);
    }
  }, [pdfDoc, highlightTarget, initialPage, scrollToPage]);

  // Fast O(1)-ish scroll tracking in continuous mode
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfDoc || viewMode !== 'continuous') return;

    let ticking = false;
    const handleScroll = () => {
      if (isScrollingProgrammatically.current) return;

      if (!ticking) {
        window.requestAnimationFrame(() => {
          if (isScrollingProgrammatically.current) {
            ticking = false;
            return;
          }
          const scrollTop = container.scrollTop;
          const currentH = rotation === 90 || rotation === 270 ? basePagePt.w : basePagePt.h;
          const approxPagePitch = currentH * scale + 24;
          const centerGuess = Math.max(
            1,
            Math.min(book.totalPages, Math.floor((scrollTop + 220) / approxPagePitch) + 1)
          );

          const containerRect = container.getBoundingClientRect();
          const targetY = containerRect.top + Math.min(220, containerRect.height * 0.35);

          let bestPage = centerGuess;
          let minDistance = Infinity;

          // Only inspect DOM elements around centerGuess (±8 pages) instead of all 1000 pages!
          const startP = Math.max(1, centerGuess - 8);
          const endP = Math.min(book.totalPages, centerGuess + 8);

          for (let p = startP; p <= endP; p++) {
            const pageEl = document.getElementById(`pdf-page-${p}`);
            if (pageEl) {
              const rect = pageEl.getBoundingClientRect();
              if (rect.top <= targetY && rect.bottom >= targetY) {
                bestPage = p;
                break;
              }
              const dist = Math.abs(rect.top - targetY);
              if (dist < minDistance) {
                minDistance = dist;
                bestPage = p;
              }
            }
          }

          setCurrentPage((prev) => {
            if (prev !== bestPage) {
              saveReadingProgress(book.id, bestPage, book.totalPages);
              return bestPage;
            }
            return prev;
          });

          ticking = false;
        });
        ticking = true;
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [pdfDoc, book.id, book.totalPages, viewMode, basePagePt.h, basePagePt.w, scale, rotation]);

  // Save or remove full offline copy in IndexedDB
  const handleToggleOfflineSave = useCallback(async () => {
    if (offlineSavingProgress !== null) return;

    if (isOfflineSaved) {
      await removeOfflineBook(book.id);
      setIsOfflineSaved(false);
      setToast({
        message: 'Removed full offline copy (visited page chunks remain cached)',
        type: 'info',
      });
      return;
    }

    const cleanPath = (book.pdfUrl || `data/pdfs/${book.id}.pdf`).replace(/^\//, '');
    const primaryUrl = resolveAssetUrl(cleanPath);
    const headers = getAuthHeaders();

    try {
      setOfflineSavingProgress(1);
      try {
        await saveBookOffline(book.id, primaryUrl, headers, (pct) => {
          setOfflineSavingProgress(pct);
        });
      } catch {
        await saveBookOffline(book.id, `/${cleanPath}`, {}, (pct) => {
          setOfflineSavingProgress(pct);
        });
      }
      setIsOfflineSaved(true);
      setToast({
        message: `✓ "${book.title}" saved for 100% instant offline reading!`,
        type: 'success',
      });
    } catch (err: any) {
      setToast({
        message: err?.message || 'Failed to save book offline',
        type: 'error',
      });
    } finally {
      setOfflineSavingProgress(null);
    }
  }, [book.id, book.pdfUrl, book.title, isOfflineSaved, offlineSavingProgress]);

  // Bookmark Toggle
  const handleToggleBookmark = () => {
    toggleBookmark(book.id, currentPage);
    setBookmarks(getAllBookmarks(book.id));
  };

  const isCurrentPageBookmarked = bookmarks.some((b) => b.page === currentPage);

  // Fit to screen width (handles rotation & dual spread)
  const handleFitWidth = () => {
    if (containerRef.current) {
      const isRotatedSideways = rotation === 90 || rotation === 270;
      const pageWidth = isRotatedSideways ? basePagePt.h : basePagePt.w;
      const containerWidth = containerRef.current.clientWidth - 48;
      const divisor = viewMode === 'dual' ? pageWidth * 2 + 16 : pageWidth;
      const targetScale = Math.max(0.4, Math.min(2.5, containerWidth / divisor));
      setScale(parseFloat(targetScale.toFixed(2)));
    }
  };

  // Rotate PDF by 90 degrees clockwise (0 -> 90 -> 180 -> 270)
  const handleRotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
  }, []);

  // Edge-style text selection listener on PDF pages
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;

      const rawText = sel.toString().trim();
      if (!rawText) return;

      const anchorNode = sel.anchorNode;
      const focusNode = sel.focusNode;
      const anchorEl = (anchorNode instanceof HTMLElement ? anchorNode : anchorNode?.parentElement) as HTMLElement | null;
      const focusEl = (focusNode instanceof HTMLElement ? focusNode : focusNode?.parentElement) as HTMLElement | null;

      const pageEl = anchorEl?.closest('[id^="pdf-page-"]') || focusEl?.closest('[id^="pdf-page-"]');
      if (!pageEl) return;

      const pageIdMatch = pageEl.id.match(/pdf-page-(\d+)/);
      const pageNum = pageIdMatch ? parseInt(pageIdMatch[1], 10) : currentPage;

      try {
        const range = sel.getRangeAt(0);
        const clientRect = range.getBoundingClientRect();
        if (clientRect.width === 0 && clientRect.height === 0) return;

        const pageBox = pageEl.getBoundingClientRect();
        const rawRects = Array.from(range.getClientRects());
        const normalizedRects = rawRects.map((r) => ({
          x: Math.max(0, (r.left - pageBox.left) / pageBox.width),
          y: Math.max(0, (r.top - pageBox.top) / pageBox.height),
          w: Math.min(1, r.width / pageBox.width),
          h: Math.min(1, r.height / pageBox.height),
        }));

        const dockWidth = 330;
        const dockHeight = 44;
        let top = clientRect.top - dockHeight - 12;
        if (top < 65) {
          top = clientRect.bottom + 12;
        }
        let left = clientRect.left + clientRect.width / 2 - dockWidth / 2;
        left = Math.max(16, Math.min(window.innerWidth - dockWidth - 16, left));

        setSelectionDock({
          text: rawText,
          pageNumber: pageNum,
          position: { top, left },
          rects: normalizedRects,
        });
      } catch (err) {
        console.warn('Selection positioning error:', err);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.text-selection-dock')) {
        return;
      }
      setSelectionDock(null);
    };

    container.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('touchend', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      container.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('touchend', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [currentPage]);

  // Multi-Page Screenshot Handlers
  const handleToggleSelectionMode = useCallback(() => {
    setIsSelectionMode((prev) => {
      const next = !prev;
      if (next && selectedPages.length === 0) {
        setSelectedPages([currentPage]);
      }
      return next;
    });
  }, [currentPage, selectedPages.length]);

  const handleToggleSelectPage = useCallback((pageNum: number) => {
    setSelectedPages((prev) => {
      if (prev.includes(pageNum)) {
        return prev.filter((p) => p !== pageNum);
      }
      return [...prev, pageNum].sort((a, b) => a - b);
    });
  }, []);

  const handleToggleCurrentPage = useCallback(() => {
    handleToggleSelectPage(currentPage);
  }, [currentPage, handleToggleSelectPage]);

  const handleSelectAllPages = useCallback(() => {
    setSelectedPages(Array.from({ length: book.totalPages }, (_, i) => i + 1));
  }, [book.totalPages]);

  const handleClearSelectedPages = useCallback(() => {
    setSelectedPages([]);
  }, []);

  const handleQuickCopyScreenshot = useCallback(async () => {
    if (!pdfDoc || selectedPages.length === 0) return;

    try {
      setIsQuickCapturing(true);
      const result = await renderMultiPageScreenshot(
        pdfDoc,
        selectedPages,
        {
          scale: 2.0,
          layout: 'vertical',
          theme: 'original',
          currentReaderTheme: currentTheme,
          showPageNumbers: true,
          showBookTitle: true,
        },
        book.title
      );

      await copyScreenshotToClipboard(result.blob);
      setToast({
        message: `✓ Copied ${selectedPages.length} ${
          selectedPages.length === 1 ? 'page' : 'pages'
        } to clipboard!`,
        type: 'success',
      });
    } catch (err: any) {
      console.error('Quick copy error:', err);
      setToast({
        message: err?.message || 'Failed to copy to clipboard',
        type: 'error',
      });
    } finally {
      setIsQuickCapturing(false);
    }
  }, [pdfDoc, selectedPages, currentTheme, book.title]);

  const handleOpenScreenshotModal = useCallback(() => {
    if (selectedPages.length === 0) {
      setSelectedPages([currentPage]);
    }
    setIsScreenshotModalOpen(true);
  }, [currentPage, selectedPages.length]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      switch (e.key) {
        case '[':
        case 'ArrowLeft':
          if (viewMode === 'dual') {
            const prevSpread = Math.max(1, (currentPage % 2 === 1 ? currentPage : currentPage - 1) - 2);
            scrollToPage(prevSpread, false);
          } else if (currentPage > 1) {
            scrollToPage(currentPage - 1, viewMode !== 'single');
          }
          break;
        case ']':
        case 'ArrowRight':
          if (viewMode === 'dual') {
            const leftPage = currentPage % 2 === 1 ? currentPage : currentPage - 1;
            const nextSpread = Math.min(book.totalPages, leftPage + 2);
            scrollToPage(nextSpread, false);
          } else if (currentPage < book.totalPages) {
            scrollToPage(currentPage + 1, viewMode !== 'single');
          }
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          handleRotate();
          break;
        case 't':
        case 'T':
          setIsTOCSidebarOpen((prev) => !prev);
          break;
        case 'b':
        case 'B':
          handleToggleBookmark();
          break;
        case 's':
        case 'S':
          e.preventDefault();
          handleToggleSelectionMode();
          break;
        case '/':
          e.preventDefault();
          onOpenSearch(book.id, book.category);
          break;
        case 'Escape':
          if (isScreenshotModalOpen) {
            setIsScreenshotModalOpen(false);
          } else if (selectionDock) {
            setSelectionDock(null);
          } else if (isSelectionMode) {
            setIsSelectionMode(false);
          } else if (isTOCSidebarOpen) {
            setIsTOCSidebarOpen(false);
          } else {
            onBackToLibrary();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    currentPage,
    book.totalPages,
    book.id,
    book.category,
    viewMode,
    isTOCSidebarOpen,
    isSelectionMode,
    isScreenshotModalOpen,
    selectionDock,
    scrollToPage,
    handleRotate,
    onOpenSearch,
    onBackToLibrary,
    handleToggleSelectionMode,
  ]);

  const isRotatedSideways = rotation === 90 || rotation === 270;
  const unscaledW = isRotatedSideways ? basePagePt.h : basePagePt.w;
  const unscaledH = isRotatedSideways ? basePagePt.w : basePagePt.h;
  const estimatedWidth = unscaledW * scale;
  const estimatedHeight = unscaledH * scale;

  return (
    <div className="h-screen flex flex-col bg-reader-desk transition-colors relative overflow-hidden">
      {/* Top Reading Toolbar */}
      <ReaderToolbar
        bookTitle={book.title}
        currentPage={currentPage}
        totalPages={book.totalPages}
        scale={scale}
        rotation={rotation}
        viewMode={viewMode}
        currentTheme={currentTheme}
        isBookmarked={isCurrentPageBookmarked}
        isOfflineSaved={isOfflineSaved}
        offlineSavingProgress={offlineSavingProgress}
        streamStats={streamStats}
        isSelectionMode={isSelectionMode}
        selectedPagesCount={selectedPages.length}
        onPageChange={(p) => scrollToPage(p, viewMode !== 'single')}
        onZoomChange={setScale}
        onFitWidth={handleFitWidth}
        onRotate={handleRotate}
        onViewModeChange={handleViewModeChange}
        onThemeChange={onThemeChange}
        onToggleTOC={() => setIsTOCSidebarOpen((prev) => !prev)}
        onToggleBookmark={handleToggleBookmark}
        onToggleOfflineSave={handleToggleOfflineSave}
        onToggleSelectionMode={handleToggleSelectionMode}
        onOpenScreenshotModal={handleOpenScreenshotModal}
        onOpenSearch={() => onOpenSearch(book.id, book.category)}
        onBackToLibrary={onBackToLibrary}
        onEditBook={onEditBook ? () => onEditBook(book) : undefined}
      />

      {/* Table of Contents & Bookmarks Drawer */}
      <TOCDrawer
        isOpen={isTOCSidebarOpen}
        onClose={() => setIsTOCSidebarOpen(false)}
        toc={book.toc || []}
        bookmarks={bookmarks}
        currentPage={currentPage}
        onSelectPage={(p) => scrollToPage(p, viewMode !== 'single')}
      />

      {/* Main Viewport (Reader Desk Canvas) */}
      <main
        ref={containerRef}
        className={`flex-1 w-full overflow-y-auto px-2 sm:px-6 py-8 flex flex-col items-center bg-reader-desk transition-colors ${
          isSelectionMode ? 'pb-24' : ''
        }`}
      >
        {isLoading ? (
          <div className="py-24 flex flex-col items-center gap-4 text-muted animate-fade-in">
            <Loader2 className="w-10 h-10 animate-spin text-sky-400" />
            <p className="text-sm font-semibold text-main">
              Opening Linearized PDF Stream (Page {currentPage} first)...
            </p>
            <p className="text-xs text-dim">
              Fetching initial 128 KB header — skipping remaining pages until needed
            </p>
          </div>
        ) : error ? (
          <div className="py-24 flex flex-col items-center gap-4 text-center max-w-md mx-auto p-6 glass-panel rounded-3xl border border-red-500/20">
            <AlertCircle className="w-12 h-12 text-rose-500" />
            <h3 className="text-base font-semibold text-main">Failed to Load PDF</h3>
            <p className="text-xs text-muted leading-relaxed">{error}</p>
            <button
              onClick={onBackToLibrary}
              className="mt-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-main text-xs font-semibold"
            >
              Back to Library
            </button>
          </div>
        ) : pdfDoc && viewMode === 'single' ? (
          /* Single-Page Offline-Style Reader Mode (with silent next/prev page prefetch!) */
          <div className="w-full max-w-5xl flex flex-col items-center gap-4">
            <div className="relative flex items-center justify-center w-full">
              {currentPage > 1 && (
                <button
                  onClick={() => scrollToPage(currentPage - 1, false)}
                  className="hidden md:flex fixed left-5 top-1/2 -translate-y-1/2 z-20 p-3 rounded-2xl glass-panel border border-subtle hover:border-sky-500/40 text-muted hover:text-sky-400 shadow-xl transition-all"
                  title="Previous Page (←)"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
              )}

              <PDFPage
                key={currentPage}
                pdfDoc={pdfDoc}
                scheduler={scheduler}
                pageNumber={currentPage}
                scale={scale}
                rotation={rotation}
                shouldRender={true}
                estimatedWidth={estimatedWidth}
                estimatedHeight={estimatedHeight}
                highlightBboxes={
                  highlightTarget?.page === currentPage ? highlightTarget.bboxes : []
                }
                userHighlights={pageHighlights.get(currentPage) || EMPTY_HIGHLIGHTS}
                isActivePage={true}
                isSelectionMode={isSelectionMode}
                isSelected={selectedPages.includes(currentPage)}
                onToggleSelect={handleToggleSelectPage}
                onPageMeasured={handlePageMeasured}
                onPageRendered={handlePageRendered}
                onRemoveHighlight={handleRemoveHighlight}
              />

              {currentPage < book.totalPages && (
                <button
                  onClick={() => scrollToPage(currentPage + 1, false)}
                  className="hidden md:flex fixed right-5 top-1/2 -translate-y-1/2 z-20 p-3 rounded-2xl glass-panel border border-subtle hover:border-sky-500/40 text-muted hover:text-sky-400 shadow-xl transition-all"
                  title="Next Page (→)"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              )}
            </div>

            {/* Silent hidden prefetch of next & previous page so turning pages is 0ms */}
            <div className="sr-only pointer-events-none h-0 overflow-hidden" aria-hidden="true">
              {[currentPage + 1, currentPage - 1]
                .filter((p) => p >= 1 && p <= book.totalPages)
                .map((prefetchPage) => (
                  <PDFPage
                    key={`prefetch-${prefetchPage}`}
                    pdfDoc={pdfDoc}
                    scheduler={scheduler}
                    pageNumber={prefetchPage}
                    scale={scale}
                    rotation={rotation}
                    shouldRender={true}
                    estimatedWidth={estimatedWidth}
                    estimatedHeight={estimatedHeight}
                    isActivePage={false}
                    onPageRendered={handlePageRendered}
                    onRemoveHighlight={handleRemoveHighlight}
                  />
                ))}
            </div>
          </div>
        ) : pdfDoc && viewMode === 'dual' ? (
          /* Edge-Style Two-Page Spread Mode */
          (() => {
            const leftPage = currentPage % 2 === 1 ? currentPage : currentPage - 1;
            const rightPage = leftPage + 1 <= book.totalPages ? leftPage + 1 : null;

            return (
              <div className="w-full max-w-7xl flex flex-col items-center gap-4">
                <div className="relative flex flex-col md:flex-row items-center md:items-start justify-center gap-6 w-full">
                  {leftPage > 1 && (
                    <button
                      onClick={() => scrollToPage(Math.max(1, leftPage - 2), false)}
                      className="hidden md:flex fixed left-5 top-1/2 -translate-y-1/2 z-20 p-3 rounded-2xl glass-panel border border-subtle hover:border-sky-500/40 text-muted hover:text-sky-400 shadow-xl transition-all"
                      title="Previous Spread (←)"
                    >
                      <ChevronLeft className="w-6 h-6" />
                    </button>
                  )}

                  {/* Left Page */}
                  <PDFPage
                    key={leftPage}
                    pdfDoc={pdfDoc}
                    scheduler={scheduler}
                    pageNumber={leftPage}
                    scale={scale}
                    rotation={rotation}
                    shouldRender={true}
                    estimatedWidth={estimatedWidth}
                    estimatedHeight={estimatedHeight}
                    highlightBboxes={
                      highlightTarget?.page === leftPage ? highlightTarget.bboxes : []
                    }
                    userHighlights={pageHighlights.get(leftPage) || EMPTY_HIGHLIGHTS}
                    isActivePage={currentPage === leftPage}
                    isSelectionMode={isSelectionMode}
                    isSelected={selectedPages.includes(leftPage)}
                    onToggleSelect={handleToggleSelectPage}
                    onPageMeasured={handlePageMeasured}
                    onPageRendered={handlePageRendered}
                    onRemoveHighlight={handleRemoveHighlight}
                  />

                  {/* Right Page */}
                  {rightPage && (
                    <PDFPage
                      key={rightPage}
                      pdfDoc={pdfDoc}
                      scheduler={scheduler}
                      pageNumber={rightPage}
                      scale={scale}
                      rotation={rotation}
                      shouldRender={true}
                      estimatedWidth={estimatedWidth}
                      estimatedHeight={estimatedHeight}
                      highlightBboxes={
                        highlightTarget?.page === rightPage ? highlightTarget.bboxes : []
                      }
                      userHighlights={pageHighlights.get(rightPage) || EMPTY_HIGHLIGHTS}
                      isActivePage={currentPage === rightPage}
                      isSelectionMode={isSelectionMode}
                      isSelected={selectedPages.includes(rightPage)}
                      onToggleSelect={handleToggleSelectPage}
                      onPageMeasured={handlePageMeasured}
                      onPageRendered={handlePageRendered}
                      onRemoveHighlight={handleRemoveHighlight}
                    />
                  )}

                  {rightPage && rightPage < book.totalPages && (
                    <button
                      onClick={() => scrollToPage(Math.min(book.totalPages, leftPage + 2), false)}
                      className="hidden md:flex fixed right-5 top-1/2 -translate-y-1/2 z-20 p-3 rounded-2xl glass-panel border border-subtle hover:border-sky-500/40 text-muted hover:text-sky-400 shadow-xl transition-all"
                      title="Next Spread (→)"
                    >
                      <ChevronRight className="w-6 h-6" />
                    </button>
                  )}
                </div>

                {/* Prefetch adjacent spread pages */}
                <div className="sr-only pointer-events-none h-0 overflow-hidden" aria-hidden="true">
                  {[leftPage - 2, leftPage - 1, leftPage + 2, leftPage + 3]
                    .filter((p) => p >= 1 && p <= book.totalPages && p !== leftPage && p !== rightPage)
                    .map((prefetchPage) => (
                      <PDFPage
                        key={`prefetch-${prefetchPage}`}
                        pdfDoc={pdfDoc}
                        scheduler={scheduler}
                        pageNumber={prefetchPage}
                        scale={scale}
                        rotation={rotation}
                        shouldRender={true}
                        estimatedWidth={estimatedWidth}
                        estimatedHeight={estimatedHeight}
                        isActivePage={false}
                        onPageRendered={handlePageRendered}
                        onRemoveHighlight={handleRemoveHighlight}
                      />
                    ))}
                </div>
              </div>
            );
          })()
        ) : pdfDoc ? (
          /* Continuous Windowed Virtualized Mode (Loads currentPage FIRST, then ±2..3 neighbors) */
          <div className="w-full max-w-5xl space-y-6">
            {Array.from({ length: book.totalPages }).map((_, index) => {
              const pageNum = index + 1;
              const isHighlightTarget = highlightTarget?.page === pageNum;
              const isSelected = selectedPages.includes(pageNum);
              const distance = Math.abs(pageNum - currentPage);
              // Render ONLY active window [currentPage - 2, currentPage + 3] or active highlight!
              const shouldRender =
                (pageNum >= currentPage - 2 && pageNum <= currentPage + 3) ||
                isHighlightTarget;

              return (
                <PDFPage
                  key={pageNum}
                  pdfDoc={pdfDoc}
                  scheduler={scheduler}
                  pageNumber={pageNum}
                  scale={scale}
                  rotation={rotation}
                  shouldRender={shouldRender}
                  estimatedWidth={estimatedWidth}
                  estimatedHeight={estimatedHeight}
                  highlightBboxes={isHighlightTarget ? highlightTarget.bboxes : []}
                  userHighlights={pageHighlights.get(pageNum) || EMPTY_HIGHLIGHTS}
                  isActivePage={currentPage === pageNum}
                  isSelectionMode={isSelectionMode}
                  isSelected={isSelected}
                  onToggleSelect={handleToggleSelectPage}
                  onPageMeasured={distance === 0 ? handlePageMeasured : undefined}
                  onPageRendered={handlePageRendered}
                  onRemoveHighlight={handleRemoveHighlight}
                />
              );
            })}
          </div>
        ) : null}
      </main>

      {/* Microsoft Edge Text Selection Dock */}
      {selectionDock && (
        <TextSelectionDock
          bookId={book.id}
          selectedText={selectionDock.text}
          pageNumber={selectionDock.pageNumber}
          position={selectionDock.position}
          rects={selectionDock.rects}
          hasExistingHighlight={hasExistingHighlight}
          onClose={() => setSelectionDock(null)}
          onSearchInBook={(_query) => {
            onOpenSearch(book.id, book.category);
          }}
          onHighlightAdded={handleHighlightAdded}
          onRemoveHighlight={() => {
            handleRemoveSelectionHighlights(selectionDock.pageNumber, selectionDock.text);
          }}
        />
      )}

      {/* Floating Selection Dock */}
      {isSelectionMode && (
        <PageSelectionDock
          selectedPages={selectedPages}
          currentPage={currentPage}
          totalPages={book.totalPages}
          isCapturing={isQuickCapturing}
          onToggleCurrentPage={handleToggleCurrentPage}
          onSelectAll={handleSelectAllPages}
          onClearSelection={handleClearSelectedPages}
          onQuickCopy={handleQuickCopyScreenshot}
          onOpenAdvancedModal={handleOpenScreenshotModal}
          onExitSelectionMode={() => setIsSelectionMode(false)}
        />
      )}

      {/* Screenshot & Export Modal */}
      <ScreenshotModal
        isOpen={isScreenshotModalOpen}
        onClose={() => setIsScreenshotModalOpen(false)}
        pdfDoc={pdfDoc}
        bookTitle={book.title}
        currentPage={currentPage}
        totalPages={book.totalPages}
        initialSelectedPages={selectedPages}
        currentReaderTheme={currentTheme}
        onCopySuccess={(msg) => setToast({ message: msg, type: 'success' })}
      />

      {/* Feedback Toast Notification */}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
