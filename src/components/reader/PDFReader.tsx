import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Book } from '../../types/book';
import { ReaderTheme, ViewMode, HighlightTarget, Bookmark } from '../../types/reader';
import { loadPDFDocument } from '../../services/pdfService';
import { resolveAssetUrl, getAuthHeaders } from '../../services/hfStorage';
import {
  saveReadingProgress,
  getAllBookmarks,
  toggleBookmark,
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
import { Toast, ToastState } from '../common/Toast';
import { Loader2, AlertCircle } from 'lucide-react';

interface PDFReaderProps {
  book: Book;
  initialPage?: number;
  highlightTarget?: HighlightTarget | null;
  currentTheme: ReaderTheme;
  onThemeChange: (theme: ReaderTheme) => void;
  onOpenSearch: (bookIdFilter?: string) => void;
  onBackToLibrary: () => void;
}

export function PDFReader({
  book,
  initialPage = 1,
  highlightTarget,
  currentTheme,
  onThemeChange,
  onOpenSearch,
  onBackToLibrary,
}: PDFReaderProps) {
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(highlightTarget?.page || initialPage || 1);
  const [scale, setScale] = useState<number>(1.25);
  const [viewMode, setViewMode] = useState<ViewMode>('continuous');
  const [isTOCSidebarOpen, setIsTOCSidebarOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  // Multi-Page Screenshot & Selection state
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [isScreenshotModalOpen, setIsScreenshotModalOpen] = useState(false);
  const [isQuickCapturing, setIsQuickCapturing] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Load bookmarks on mount
  useEffect(() => {
    setBookmarks(getAllBookmarks(book.id));
  }, [book.id]);

  // Load PDF document on-demand via HTTP Range Streaming
  useEffect(() => {
    let isCancelled = false;
    setIsLoading(true);
    setError(null);

    const pdfUrl = resolveAssetUrl(book.pdfUrl);
    const headers = getAuthHeaders();

    loadPDFDocument(pdfUrl, headers)
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

    return () => {
      isCancelled = true;
    };
  }, [book.pdfUrl]);

  const isScrollingProgrammatically = useRef(false);

  // Scroll to page reliably
  const scrollToPage = useCallback((pageNum: number, smooth: boolean = true) => {
    setCurrentPage(pageNum);
    saveReadingProgress(book.id, pageNum, book.totalPages);
    isScrollingProgrammatically.current = true;

    const performScroll = (attempts = 0) => {
      const pageElement = document.getElementById(`pdf-page-${pageNum}`);
      if (pageElement) {
        pageElement.scrollIntoView({
          behavior: smooth ? 'smooth' : 'auto',
          block: 'start',
        });
        setTimeout(() => {
          isScrollingProgrammatically.current = false;
        }, smooth ? 650 : 100);
      } else if (attempts < 15) {
        setTimeout(() => performScroll(attempts + 1), 60);
      } else {
        isScrollingProgrammatically.current = false;
      }
    };

    performScroll();
  }, [book.id, book.totalPages]);

  // Jump to target page when document or highlightTarget changes
  useEffect(() => {
    if (pdfDoc) {
      const target = highlightTarget?.page || initialPage || 1;
      scrollToPage(target, false);
      // Secondary smooth scroll after layout stabilizes
      setTimeout(() => scrollToPage(target, true), 150);
    }
  }, [pdfDoc, highlightTarget, initialPage, scrollToPage]);

  // Track active page on scroll dynamically
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfDoc) return;

    let ticking = false;
    const handleScroll = () => {
      if (isScrollingProgrammatically.current) return;

      if (!ticking) {
        window.requestAnimationFrame(() => {
          const containerRect = container.getBoundingClientRect();
          // Anchor point at 35% from the top of the reader viewport
          const targetY = containerRect.top + Math.min(220, containerRect.height * 0.35);

          let bestPage = 1;
          let minDistance = Infinity;

          for (let p = 1; p <= book.totalPages; p++) {
            const pageEl = document.getElementById(`pdf-page-${p}`);
            if (pageEl) {
              const rect = pageEl.getBoundingClientRect();
              // If targetY is within this page
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
  }, [pdfDoc, book.id, book.totalPages]);

  // Bookmark Toggle
  const handleToggleBookmark = () => {
    toggleBookmark(book.id, currentPage);
    setBookmarks(getAllBookmarks(book.id));
  };

  const isCurrentPageBookmarked = bookmarks.some((b) => b.page === currentPage);

  // Fit to screen width
  const handleFitWidth = () => {
    if (containerRef.current) {
      const containerWidth = containerRef.current.clientWidth - 48;
      const targetScale = Math.max(0.6, Math.min(2.5, containerWidth / 680));
      setScale(parseFloat(targetScale.toFixed(2)));
    }
  };

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
          if (currentPage > 1) scrollToPage(currentPage - 1);
          break;
        case ']':
        case 'ArrowRight':
          if (currentPage < book.totalPages) scrollToPage(currentPage + 1);
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
          onOpenSearch(book.id);
          break;
        case 'Escape':
          if (isScreenshotModalOpen) {
            setIsScreenshotModalOpen(false);
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
    isTOCSidebarOpen,
    isSelectionMode,
    isScreenshotModalOpen,
    scrollToPage,
    onOpenSearch,
    onBackToLibrary,
    handleToggleSelectionMode,
  ]);

  return (
    <div className="min-h-screen flex flex-col bg-surface transition-colors relative">
      {/* Top Reading Toolbar */}
      <ReaderToolbar
        bookTitle={book.title}
        currentPage={currentPage}
        totalPages={book.totalPages}
        scale={scale}
        viewMode={viewMode}
        currentTheme={currentTheme}
        isBookmarked={isCurrentPageBookmarked}
        isSelectionMode={isSelectionMode}
        selectedPagesCount={selectedPages.length}
        onPageChange={(p) => scrollToPage(p, true)}
        onZoomChange={setScale}
        onFitWidth={handleFitWidth}
        onViewModeChange={setViewMode}
        onThemeChange={onThemeChange}
        onToggleTOC={() => setIsTOCSidebarOpen((prev) => !prev)}
        onToggleBookmark={handleToggleBookmark}
        onToggleSelectionMode={handleToggleSelectionMode}
        onOpenScreenshotModal={handleOpenScreenshotModal}
        onOpenSearch={() => onOpenSearch(book.id)}
        onBackToLibrary={onBackToLibrary}
      />

      {/* Table of Contents & Bookmarks Drawer */}
      <TOCDrawer
        isOpen={isTOCSidebarOpen}
        onClose={() => setIsTOCSidebarOpen(false)}
        toc={book.toc || []}
        bookmarks={bookmarks}
        currentPage={currentPage}
        onSelectPage={(p) => scrollToPage(p, true)}
      />

      {/* Main Viewport */}
      <main
        ref={containerRef}
        className={`flex-1 w-full overflow-y-auto px-2 sm:px-6 py-6 flex flex-col items-center ${
          isSelectionMode ? 'pb-24' : ''
        }`}
      >
        {isLoading ? (
          <div className="py-24 flex flex-col items-center gap-4 text-muted animate-fade-in">
            <Loader2 className="w-10 h-10 animate-spin text-sky-400" />
            <p className="text-sm font-semibold text-main">Streaming PDF from Cloud...</p>
            <p className="text-xs text-dim">
              Byte-range requests fetching initial metadata on-demand
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
        ) : pdfDoc ? (
          <div className="w-full max-w-5xl space-y-6">
            {Array.from({ length: book.totalPages }).map((_, index) => {
              const pageNum = index + 1;
              const isHighlightTarget = highlightTarget?.page === pageNum;
              const isSelected = selectedPages.includes(pageNum);

              return (
                <PDFPage
                  key={pageNum}
                  pdfDoc={pdfDoc}
                  pageNumber={pageNum}
                  scale={scale}
                  highlightBboxes={isHighlightTarget ? highlightTarget.bboxes : []}
                  isActivePage={isHighlightTarget || currentPage === pageNum}
                  isSelectionMode={isSelectionMode}
                  isSelected={isSelected}
                  onToggleSelect={handleToggleSelectPage}
                />
              );
            })}
          </div>
        ) : null}
      </main>

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

