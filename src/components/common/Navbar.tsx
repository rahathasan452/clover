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
}: NavbarProps) {
  const isReading = Boolean(activeBookTitle);

  return (
    <header className="sticky top-0 z-40 w-full glass-panel border-b border-subtle backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        {/* Left: Brand or Back Button */}
        <div className="flex items-center gap-3">
          {isReading ? (
            <button
              onClick={onBackToLibrary}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-sky-500/10 text-main border border-subtle hover:border-sky-500/30 transition-colors text-xs font-medium"
            >
              <ArrowLeft className="w-3.5 h-3.5 text-sky-400" />
              <span>Library</span>
            </button>
          ) : (
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-sky-500 flex items-center justify-center shadow-md shadow-sky-500/25">
                <BookOpen className="w-4 h-4 text-slate-950" />
              </div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold text-main tracking-tight">Clover</h1>
                <span className="text-[11px] text-muted font-medium">({totalBooks} books)</span>
              </div>
            </div>
          )}

          {isReading && (
            <div className="hidden md:block max-w-md truncate text-xs font-medium text-main border-l border-subtle pl-3">
              {activeBookTitle}
            </div>
          )}
        </div>

        {/* Center: Global Search Trigger */}
        <div className="flex-1 max-w-lg mx-2">
          <button
            onClick={onOpenSearch}
            className="w-full flex items-center justify-between px-3.5 py-1.5 rounded-xl bg-white/5 hover:bg-sky-500/10 border border-subtle hover:border-sky-500/30 text-muted hover:text-main transition-all group text-xs"
          >
            <div className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-sky-400" />
              <span className="font-normal">Search across all books...</span>
            </div>
            <div className="flex items-center gap-1">
              <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono rounded bg-white/10 text-muted">
                Ctrl K
              </kbd>
            </div>
          </button>
        </div>

        {/* Right: Cloud Storage & Themes */}
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenHFModal}
            title="Cloud Storage Settings"
            className="p-1.5 rounded-lg bg-white/5 hover:bg-sky-500/10 border border-subtle hover:border-sky-500/30 text-muted hover:text-main transition-colors"
          >
            <Cloud className="w-4 h-4 text-sky-400" />
          </button>

          {/* Theme Selector */}
          <div className="flex items-center p-0.5 rounded-lg bg-white/5 border border-subtle">
            <button
              onClick={() => onThemeChange('dark')}
              title="Dark"
              className={`p-1 rounded transition-all ${
                currentTheme === 'dark' ? 'bg-sky-600 text-white shadow-sm' : 'text-muted hover:text-main'
              }`}
            >
              <Moon className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onThemeChange('sepia')}
              title="Sepia"
              className={`p-1 rounded transition-all ${
                currentTheme === 'sepia' ? 'bg-amber-600 text-white shadow-sm' : 'text-muted hover:text-main'
              }`}
            >
              <Coffee className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onThemeChange('oled')}
              title="OLED"
              className={`p-1 rounded transition-all ${
                currentTheme === 'oled' ? 'bg-zinc-800 text-sky-400 shadow-sm' : 'text-muted hover:text-main'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onThemeChange('light')}
              title="Light"
              className={`p-1 rounded transition-all ${
                currentTheme === 'light' ? 'bg-blue-600 text-white shadow-sm' : 'text-muted hover:text-main'
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
