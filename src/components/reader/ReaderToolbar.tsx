import React, { useState } from 'react';
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
} from 'lucide-react';
import { ViewMode, ReaderTheme } from '../../types/reader';

interface ReaderToolbarProps {
  bookTitle: string;
  currentPage: number;
  totalPages: number;
  scale: number;
  viewMode: ViewMode;
  currentTheme: ReaderTheme;
  isBookmarked: boolean;
  onPageChange: (page: number) => void;
  onZoomChange: (scale: number) => void;
  onFitWidth: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  onThemeChange: (theme: ReaderTheme) => void;
  onToggleTOC: () => void;
  onToggleBookmark: () => void;
  onOpenSearch: () => void;
  onBackToLibrary: () => void;
}

export function ReaderToolbar({
  bookTitle,
  currentPage,
  totalPages,
  scale,
  viewMode,
  currentTheme,
  isBookmarked,
  onPageChange,
  onZoomChange,
  onFitWidth,
  onViewModeChange,
  onThemeChange,
  onToggleTOC,
  onToggleBookmark,
  onOpenSearch,
  onBackToLibrary,
}: ReaderToolbarProps) {
  const [inputPage, setInputPage] = useState(String(currentPage));

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
      <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-2 sm:gap-4">
        {/* Left: Back & TOC */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button
            onClick={onBackToLibrary}
            title="Back to Library"
            className="p-2 rounded-xl bg-white/5 hover:bg-sky-500/10 text-muted hover:text-main border border-subtle hover:border-sky-500/30 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 text-sky-400" />
          </button>

          <button
            onClick={onToggleTOC}
            title="Table of Contents & Bookmarks"
            className="p-2 rounded-xl bg-white/5 hover:bg-sky-500/10 text-muted hover:text-main border border-subtle hover:border-sky-500/30 transition-colors flex items-center gap-1.5 text-xs font-semibold"
          >
            <ListTree className="w-4 h-4 text-sky-400" />
            <span className="hidden sm:inline">Contents</span>
          </button>

          <button
            onClick={onToggleBookmark}
            title={isBookmarked ? 'Remove bookmark' : 'Bookmark this page'}
            className={`p-2 rounded-xl border transition-colors ${
              isBookmarked
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                : 'bg-white/5 border-subtle text-muted hover:text-main'
            }`}
          >
            <BookmarkIcon
              className={`w-4 h-4 ${isBookmarked ? 'fill-amber-400 text-amber-400' : ''}`}
            />
          </button>

          <div className="hidden lg:block max-w-xs truncate text-xs font-semibold text-main pl-2 border-l border-subtle">
            {bookTitle}
          </div>
        </div>

        {/* Center: Page Navigation */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <button
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            title="Previous Page"
            className="p-1.5 rounded-lg bg-white/5 hover:bg-sky-500/10 disabled:opacity-30 disabled:pointer-events-none text-main border border-subtle"
          >
            <ChevronLeft className="w-4 h-4 text-sky-400" />
          </button>

          <form onSubmit={handlePageSubmit} className="flex items-center gap-1.5 text-xs font-mono">
            <input
              type="text"
              value={inputPage}
              onChange={(e) => setInputPage(e.target.value)}
              onBlur={() => setInputPage(String(currentPage))}
              className="w-12 text-center py-1 rounded-lg bg-surface-elevated border border-strong text-main font-semibold outline-none focus:border-sky-500"
            />
            <span className="text-dim">/ {totalPages}</span>
          </form>

          <button
            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
            title="Next Page"
            className="p-1.5 rounded-lg bg-white/5 hover:bg-sky-500/10 disabled:opacity-30 disabled:pointer-events-none text-main border border-subtle"
          >
            <ChevronRight className="w-4 h-4 text-sky-400" />
          </button>
        </div>

        {/* Right: Zoom, Search & Theme */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Zoom Controls */}
          <div className="hidden md:flex items-center gap-1 p-1 rounded-xl bg-white/5 border border-subtle">
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
              className="px-2 py-0.5 text-[11px] font-mono text-muted hover:text-sky-400 rounded"
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

          {/* In-Book Search Trigger */}
          <button
            onClick={onOpenSearch}
            title="Search inside book"
            className="p-2 rounded-xl bg-white/5 hover:bg-sky-500/10 text-muted hover:text-main border border-subtle hover:border-sky-500/30 transition-colors"
          >
            <Search className="w-4 h-4 text-sky-400" />
          </button>

          {/* Theme Selector */}
          <div className="flex items-center p-1 rounded-xl bg-white/5 border border-subtle">
            <button
              onClick={() => onThemeChange('dark')}
              title="Night Mode (Slate Charcoal)"
              className={`p-1 rounded-lg ${currentTheme === 'dark' ? 'bg-sky-600 text-white shadow' : 'text-muted'}`}
            >
              <Moon className="w-3 h-3" />
            </button>
            <button
              onClick={() => onThemeChange('sepia')}
              title="Sepia Mode (Warm Paper)"
              className={`p-1 rounded-lg ${currentTheme === 'sepia' ? 'bg-amber-600 text-white shadow' : 'text-muted'}`}
            >
              <Coffee className="w-3 h-3" />
            </button>
            <button
              onClick={() => onThemeChange('oled')}
              title="OLED Mode (Pitch Black)"
              className={`p-1 rounded-lg ${currentTheme === 'oled' ? 'bg-zinc-800 text-sky-400 border border-sky-500/30 shadow' : 'text-muted'}`}
            >
              <Sparkles className="w-3 h-3" />
            </button>
            <button
              onClick={() => onThemeChange('light')}
              title="Day Mode (Soft Paper White)"
              className={`p-1 rounded-lg ${currentTheme === 'light' ? 'bg-blue-600 text-white shadow' : 'text-muted'}`}
            >
              <Sun className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
