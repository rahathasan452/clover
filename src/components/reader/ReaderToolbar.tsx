import React, { useState, useEffect } from 'react';
import {
  ListTree,
  Bookmark as BookmarkIcon,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Search,
  ArrowLeft,
  Moon,
  Sun,
  Coffee,
  Sparkles,
  Camera,
  DownloadCloud,
  CheckCircle2,
  Loader2,
  FileText,
  Rows3,
  BookOpen,
  RotateCw,
  Zap,
  Pencil,
} from 'lucide-react';
import { ViewMode, ReaderTheme } from '../../types/reader';
import { StreamStats } from '../../services/pdfService';

interface ReaderToolbarProps {
  bookTitle: string;
  currentPage: number;
  totalPages: number;
  scale: number;
  rotation?: number;
  viewMode: ViewMode;
  currentTheme: ReaderTheme;
  isBookmarked: boolean;
  isOfflineSaved?: boolean;
  offlineSavingProgress?: number | null;
  streamStats?: StreamStats | null;
  isSelectionMode?: boolean;
  selectedPagesCount?: number;
  onPageChange: (page: number) => void;
  onZoomChange: (scale: number) => void;
  onFitWidth: () => void;
  onRotate?: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  onThemeChange: (theme: ReaderTheme) => void;
  onToggleTOC: () => void;
  onToggleBookmark: () => void;
  onToggleOfflineSave?: () => void;
  onToggleSelectionMode?: () => void;
  onOpenScreenshotModal?: () => void;
  onOpenSearch: () => void;
  onBackToLibrary: () => void;
  onEditBook?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ReaderToolbar({
  bookTitle,
  currentPage,
  totalPages,
  scale,
  rotation = 0,
  viewMode,
  currentTheme,
  isBookmarked,
  isOfflineSaved = false,
  offlineSavingProgress = null,
  streamStats = null,
  isSelectionMode = false,
  selectedPagesCount = 0,
  onPageChange,
  onZoomChange,
  onFitWidth,
  onRotate,
  onViewModeChange,
  onThemeChange,
  onToggleTOC,
  onToggleBookmark,
  onToggleOfflineSave,
  onToggleSelectionMode,
  onOpenSearch,
  onBackToLibrary,
  onEditBook,
}: ReaderToolbarProps) {
  const [inputPage, setInputPage] = useState(String(currentPage));

  useEffect(() => {
    setInputPage(String(currentPage));
  }, [currentPage]);

  const handlePageSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseInt(inputPage, 10);
    if (!isNaN(p) && p >= 1 && p <= totalPages) {
      onPageChange(p);
    } else {
      setInputPage(String(currentPage));
    }
  };

  return (
    <div className="sticky top-0 z-30 w-full glass-panel border-b border-subtle backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-2 sm:gap-3">
        {/* Left: Back, TOC, Bookmark & Stream Status */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 min-w-0">
          <button
            onClick={onBackToLibrary}
            title="Back to Library"
            className="p-2 rounded-xl bg-surface hover:bg-surface-elevated text-muted hover:text-main border border-subtle hover:border-sky-500/30 transition-colors shadow-xs"
          >
            <ArrowLeft className="w-4 h-4 text-sky-500" />
          </button>

          <button
            onClick={onToggleTOC}
            title="Table of Contents & Bookmarks (T)"
            className="p-2 rounded-xl bg-surface hover:bg-surface-elevated text-muted hover:text-main border border-subtle hover:border-sky-500/30 transition-colors flex items-center gap-1.5 text-xs font-semibold shadow-xs"
          >
            <ListTree className="w-4 h-4 text-sky-500" />
            <span className="hidden sm:inline">Contents</span>
          </button>

          <button
            onClick={onToggleBookmark}
            title={isBookmarked ? 'Remove bookmark (B)' : 'Bookmark this page (B)'}
            className={`p-2 rounded-xl border transition-colors shadow-xs ${
              isBookmarked
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-500'
                : 'bg-surface hover:bg-surface-elevated border-subtle text-muted hover:text-main'
            }`}
          >
            <BookmarkIcon
              className={`w-4 h-4 ${isBookmarked ? 'fill-amber-500 text-amber-500' : ''}`}
            />
          </button>

          <div className="hidden xl:flex items-center gap-1.5 max-w-xs pl-2 border-l border-subtle min-w-0">
            <span className="truncate text-xs font-semibold text-main" title={bookTitle}>
              {bookTitle}
            </span>
            {onEditBook && (
              <button
                type="button"
                onClick={onEditBook}
                title="Edit book details (Title, Author, Category, Tags)"
                className="p-1 rounded-md hover:bg-surface-elevated text-dim hover:text-sky-400 transition-colors shrink-0"
              >
                <Pencil className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Live Linearized Stream / Cache Indicator */}
          {streamStats && (
            <div
              title={
                streamStats.mode === 'offline-full'
                  ? 'Reading 100% locally from IndexedDB offline storage'
                  : `On-demand Range Streaming: ${formatBytes(streamStats.bytesLoaded)} of ${formatBytes(
                      streamStats.totalBytes
                    )} loaded (${streamStats.cachedChunksHit} cached chunks, ${streamStats.networkChunksFetched} network chunks)`
              }
              className="hidden lg:flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-[10px] font-mono text-emerald-600 dark:text-emerald-300 shrink-0"
            >
              <Zap className="w-3 h-3 text-emerald-500" />
              {streamStats.mode === 'offline-full' ? (
                <span>Offline Local</span>
              ) : (
                <span>
                  {formatBytes(streamStats.bytesLoaded)} / {formatBytes(streamStats.totalBytes)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Center: Page Navigation */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <button
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            title="Previous Page (←)"
            className="p-1.5 rounded-xl bg-surface hover:bg-surface-elevated disabled:opacity-30 disabled:pointer-events-none text-main border border-subtle shadow-xs"
          >
            <ChevronLeft className="w-4 h-4 text-sky-500" />
          </button>

          <form onSubmit={handlePageSubmit} className="flex items-center gap-1.5 text-xs font-mono">
            <input
              type="text"
              value={inputPage}
              onChange={(e) => setInputPage(e.target.value)}
              onBlur={() => setInputPage(String(currentPage))}
              className="w-12 text-center py-1 rounded-xl bg-surface border border-subtle text-main font-semibold outline-none focus:border-sky-500 shadow-xs"
            />
            <span className="text-dim">/ {totalPages}</span>
          </form>

          <button
            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
            title="Next Page (→)"
            className="p-1.5 rounded-xl bg-surface hover:bg-surface-elevated disabled:opacity-30 disabled:pointer-events-none text-main border border-subtle shadow-xs"
          >
            <ChevronRight className="w-4 h-4 text-sky-500" />
          </button>
        </div>

        {/* Right: View Mode, Offline Pin, Zoom, Search & Theme */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Continuous vs Single Page View Switcher */}
          <div className="hidden sm:flex items-center p-0.5 rounded-xl bg-surface border border-subtle shadow-xs">
            <button
              onClick={() => onViewModeChange('continuous')}
              title="Continuous Scroll Mode"
              className={`p-1.5 rounded-lg transition-all ${
                viewMode === 'continuous'
                  ? 'bg-sky-500 text-slate-950 font-bold shadow-sm'
                  : 'text-muted hover:text-main'
              }`}
            >
              <Rows3 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onViewModeChange('single')}
              title="Single-Page Instant Flip Mode (Offline-reader style)"
              className={`p-1.5 rounded-lg transition-all ${
                viewMode === 'single'
                  ? 'bg-sky-500 text-slate-950 font-bold shadow-sm'
                  : 'text-muted hover:text-main'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onViewModeChange('dual')}
              title="Two-Page Book Spread (Edge Book Mode)"
              className={`p-1.5 rounded-lg transition-all ${
                viewMode === 'dual'
                  ? 'bg-sky-500 text-slate-950 font-bold shadow-sm'
                  : 'text-muted hover:text-main'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Save Book Offline Toggle */}
          {onToggleOfflineSave && (
            <button
              onClick={onToggleOfflineSave}
              disabled={offlineSavingProgress !== null}
              title={
                isOfflineSaved
                  ? 'Book saved offline in browser IndexedDB (click to remove offline copy)'
                  : 'Download & pin entire book for 100% offline reading'
              }
              className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-all shadow-xs ${
                isOfflineSaved
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-500/25'
                  : 'bg-surface hover:bg-surface-elevated border-subtle hover:border-sky-500/30 text-muted hover:text-main'
              }`}
            >
              {offlineSavingProgress !== null ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-500" />
                  <span className="font-mono text-[11px]">{offlineSavingProgress}%</span>
                </>
              ) : isOfflineSaved ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="hidden md:inline text-[11px]">Offline</span>
                </>
              ) : (
                <>
                  <DownloadCloud className="w-3.5 h-3.5 text-sky-500" />
                  <span className="hidden md:inline text-[11px]">Save Offline</span>
                </>
              )}
            </button>
          )}

          {/* Zoom Controls */}
          <div className="hidden md:flex items-center gap-1 p-1 rounded-xl bg-surface border border-subtle shadow-xs">
            <button
              onClick={() => onZoomChange(Math.max(0.5, scale - 0.15))}
              title="Zoom Out"
              className="p-1 rounded-lg text-muted hover:text-main"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onFitWidth}
              title="Fit to Width"
              className="px-2 py-0.5 text-[11px] font-mono text-muted hover:text-sky-500 rounded font-medium"
            >
              {Math.round(scale * 100)}%
            </button>
            <button
              onClick={() => onZoomChange(Math.min(3.0, scale + 0.15))}
              title="Zoom In"
              className="p-1 rounded-lg text-muted hover:text-main"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Rotate Page 90° (Microsoft Edge Style) */}
          {onRotate && (
            <button
              type="button"
              onClick={onRotate}
              title={`Rotate page 90° clockwise (Current: ${rotation}°) [R]`}
              className="p-2 rounded-xl bg-surface hover:bg-surface-elevated text-muted hover:text-main border border-subtle hover:border-sky-500/30 transition-colors shadow-xs"
            >
              <RotateCw className="w-4 h-4 text-sky-500" />
            </button>
          )}

          {/* In-Book Search Trigger */}
          <button
            onClick={onOpenSearch}
            title="Hybrid Search inside book (/)"
            className="p-2 rounded-xl bg-surface hover:bg-surface-elevated text-muted hover:text-main border border-subtle hover:border-sky-500/30 transition-colors shadow-xs"
          >
            <Search className="w-4 h-4 text-sky-500" />
          </button>

          {/* Multi-Page Screenshot Trigger */}
          <button
            onClick={onToggleSelectionMode}
            title={
              isSelectionMode
                ? 'Exit Screenshot Selection Mode'
                : 'Capture Multi-Page Screenshot (S)'
            }
            className={`p-2 rounded-xl border transition-all relative flex items-center gap-1.5 shadow-xs ${
              isSelectionMode
                ? 'bg-sky-500 text-slate-950 border-sky-400 font-bold shadow-lg shadow-sky-500/25'
                : 'bg-surface hover:bg-surface-elevated text-muted hover:text-main border-subtle hover:border-sky-500/30'
            }`}
          >
            <Camera
              className={`w-4 h-4 ${isSelectionMode ? 'text-slate-950 stroke-[2.5]' : 'text-sky-500'}`}
            />
            {selectedPagesCount > 0 && (
              <span
                className={`text-[10px] font-mono font-bold px-1.5 py-0.2 rounded-full ${
                  isSelectionMode ? 'bg-slate-950 text-sky-400' : 'bg-sky-500 text-slate-950'
                }`}
              >
                {selectedPagesCount}
              </span>
            )}
          </button>

          {/* Theme Selector */}
          <div className="flex items-center p-0.5 rounded-xl bg-surface border border-subtle shadow-xs">
            <button
              onClick={() => onThemeChange('dark')}
              title="Night Mode (Slate Charcoal)"
              className={`p-1 rounded-lg transition-all ${
                currentTheme === 'dark' ? 'bg-sky-600 text-white shadow' : 'text-muted hover:text-main'
              }`}
            >
              <Moon className="w-3 h-3" />
            </button>
            <button
              onClick={() => onThemeChange('sepia')}
              title="Sepia Mode (Warm Paper)"
              className={`p-1 rounded-lg transition-all ${
                currentTheme === 'sepia' ? 'bg-amber-600 text-white shadow' : 'text-muted hover:text-main'
              }`}
            >
              <Coffee className="w-3 h-3" />
            </button>
            <button
              onClick={() => onThemeChange('oled')}
              title="OLED Mode (Pitch Black)"
              className={`p-1 rounded-lg transition-all ${
                currentTheme === 'oled' ? 'bg-zinc-800 text-sky-400 border border-sky-500/30 shadow' : 'text-muted hover:text-main'
              }`}
            >
              <Sparkles className="w-3 h-3" />
            </button>
            <button
              onClick={() => onThemeChange('light')}
              title="Day Mode (Soft Paper White)"
              className={`p-1 rounded-lg transition-all ${
                currentTheme === 'light' ? 'bg-blue-600 text-white shadow' : 'text-muted hover:text-main'
              }`}
            >
              <Sun className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
