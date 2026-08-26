import React from 'react';
import { Search, BookOpen, Sun, Moon, Cloud, ArrowLeft, Coffee, Sparkles } from 'lucide-react';
import { ReaderTheme } from '../../types/reader';

interface NavbarProps {
  currentTheme: ReaderTheme;
  onThemeChange: (theme: ReaderTheme) => void;
  onOpenSearch: () => void;
  onOpenHFModal: () => void;
  activeBookTitle?: string | null;
  onBackToLibrary?: () => void;
  totalBooks?: number;
  totalIndexed?: number;
}

export function Navbar({
  currentTheme,
  onThemeChange,
  onOpenSearch,
  onOpenHFModal,
  activeBookTitle,
  onBackToLibrary,
  totalBooks = 0,
  totalIndexed = 0,
}: NavbarProps) {
  const isReading = Boolean(activeBookTitle);

  return (
    <header className="sticky top-0 z-40 w-full glass-panel border-b border-subtle transition-all">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        {/* Left: Brand or Back Button */}
        <div className="flex items-center gap-3">
          {isReading ? (
            <button
              onClick={onBackToLibrary}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-sky-500/10 text-main border border-subtle hover:border-sky-500/30 transition-colors text-sm font-medium"
            >
              <ArrowLeft className="w-4 h-4 text-sky-400" />
              <span>Library</span>
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 via-sky-500 to-indigo-400 flex items-center justify-center shadow-lg shadow-sky-500/25">
                <BookOpen className="w-5 h-5 text-white" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-bold text-main tracking-tight">Clover</h1>
                  <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/25">
                    Search & Read
                  </span>
                </div>
                <p className="text-xs text-muted">
                  {totalBooks} Books · {totalIndexed.toLocaleString()} Indexed Blocks
                </p>
              </div>
            </div>
          )}

          {isReading && (
            <div className="hidden md:block max-w-md truncate text-sm font-medium text-main border-l border-subtle pl-4">
              {activeBookTitle}
            </div>
          )}
        </div>

        {/* Center: Global Multi-Book Search Trigger */}
        <div className="flex-1 max-w-xl mx-2">
          <button
            onClick={onOpenSearch}
            className="w-full flex items-center justify-between px-4 py-2 rounded-xl bg-white/5 hover:bg-sky-500/10 border border-subtle hover:border-sky-500/40 text-muted hover:text-main transition-all group"
          >
            <div className="flex items-center gap-2.5">
              <Search className="w-4 h-4 text-sky-400 group-hover:scale-110 transition-transform" />
              <span className="text-sm font-normal">Search across all books...</span>
            </div>
            <div className="flex items-center gap-1">
              <kbd className="hidden sm:inline-block px-2 py-0.5 text-[11px] font-mono font-semibold rounded bg-white/10 text-muted border border-white/10">
                Ctrl
              </kbd>
              <kbd className="hidden sm:inline-block px-2 py-0.5 text-[11px] font-mono font-semibold rounded bg-white/10 text-muted border border-white/10">
                K
              </kbd>
            </div>
          </button>
        </div>

        {/* Right: Controls & Themes */}
        <div className="flex items-center gap-2">
          {/* Hugging Face Cloud Storage Settings */}
          <button
            onClick={onOpenHFModal}
            title="Hugging Face Cloud Storage Settings"
            className="p-2 rounded-xl bg-white/5 hover:bg-sky-500/10 border border-subtle hover:border-sky-500/30 text-muted hover:text-main transition-colors"
          >
            <Cloud className="w-4 h-4 text-sky-400" />
          </button>

          {/* Theme Selector */}
          <div className="flex items-center p-1 rounded-xl bg-white/5 border border-subtle">
            <button
              onClick={() => onThemeChange('dark')}
              title="Night Mode (Slate Charcoal)"
              className={`p-1.5 rounded-lg transition-all ${
                currentTheme === 'dark'
                  ? 'bg-sky-600 text-white shadow shadow-sky-600/30'
                  : 'text-muted hover:text-main'
              }`}
            >
              <Moon className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onThemeChange('sepia')}
              title="Sepia Mode (Warm Book Paper)"
              className={`p-1.5 rounded-lg transition-all ${
                currentTheme === 'sepia'
                  ? 'bg-amber-600 text-white shadow'
                  : 'text-muted hover:text-main'
              }`}
            >
              <Coffee className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onThemeChange('oled')}
              title="OLED Mode (Pitch Black)"
              className={`p-1.5 rounded-lg transition-all ${
                currentTheme === 'oled'
                  ? 'bg-zinc-800 text-sky-400 border border-sky-500/30 shadow'
                  : 'text-muted hover:text-main'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onThemeChange('light')}
              title="Day Mode (Soft Paper White)"
              className={`p-1.5 rounded-lg transition-all ${
                currentTheme === 'light'
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-muted hover:text-main'
              }`}
            >
              <Sun className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
