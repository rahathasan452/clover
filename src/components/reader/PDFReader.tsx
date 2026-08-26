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
import { PDFPage } from './PDFPage';
import { ReaderToolbar } from './ReaderToolbar';
import { TOCDrawer } from './TOCDrawer';
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

  // Scroll to page reliably
  const scrollToPage = useCallback((pageNum: number, smooth: boolean = true) => {
    setCurrentPage(pageNum);
    saveReadingProgress(book.id, pageNum, book.totalPages);

    const performScroll = (attempts = 0) => {
      const pageElement = document.getElementById(`pdf-page-${pageNum}`);
      if (pageElement) {
        pageElement.scrollIntoView({
          behavior: smooth ? 'smooth' : 'auto',
          block: 'start',
        });
      } else if (attempts < 15) {
        setTimeout(() => performScroll(attempts + 1), 60);
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

  // Track active page on scroll
  const handlePageVisible = useCallback((pageNum: number) => {
    setCurrentPage(pageNum);
    saveReadingProgress(book.id, pageNum, book.totalPages);
  }, [book.id, book.totalPages]);

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
        case '/':
          e.preventDefault();
          onOpenSearch(book.id);
          break;
        case 'Escape':
          if (isTOCSidebarOpen) {
            setIsTOCSidebarOpen(false);
          } else {
            onBackToLibrary();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, book.totalPages, isTOCSidebarOpen, scrollToPage, onOpenSearch, onBackToLibrary]);

  return (
    <div className="min-h-screen flex flex-col bg-surface transition-colors">
      {/* Top Reading Toolbar */}
      <ReaderToolbar
        bookTitle={book.title}
        currentPage={currentPage}
        totalPages={book.totalPages}
        scale={scale}
        viewMode={viewMode}
        currentTheme={currentTheme}
        isBookmarked={isCurrentPageBookmarked}
        onPageChange={(p) => scrollToPage(p, true)}
        onZoomChange={setScale}
        onFitWidth={handleFitWidth}
        onViewModeChange={setViewMode}
        onThemeChange={onThemeChange}
        onToggleTOC={() => setIsTOCSidebarOpen((prev) => !prev)}
        onToggleBookmark={handleToggleBookmark}
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
        className="flex-1 w-full overflow-y-auto px-2 sm:px-6 py-6 flex flex-col items-center"
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

              return (
                <PDFPage
                  key={pageNum}
                  pdfDoc={pdfDoc}
                  pageNumber={pageNum}
                  scale={scale}
                  highlightBboxes={isHighlightTarget ? highlightTarget.bboxes : []}
                  isActivePage={isHighlightTarget || currentPage === pageNum}
                  onPageVisible={handlePageVisible}
                />
              );
            })}
          </div>
        ) : null}
      </main>
    </div>
  );
}
