import React, { useState } from 'react';
import {
  Copy,
  Check,
  Highlighter,
  Search,
  Eraser,
  X,
} from 'lucide-react';
import { UserHighlight, saveBookHighlight } from '../../services/highlightService';

interface TextSelectionDockProps {
  bookId: string;
  selectedText: string;
  pageNumber: number;
  position: { top: number; left: number };
  rects?: { x: number; y: number; w: number; h: number }[];
  hasExistingHighlight?: boolean;
  onClose: () => void;
  onSearchInBook: (query: string) => void;
  onHighlightAdded?: (highlight: UserHighlight) => void;
  onRemoveHighlight?: () => void;
}

export function TextSelectionDock({
  bookId,
  selectedText,
  pageNumber,
  position,
  rects = [],
  hasExistingHighlight = false,
  onClose,
  onSearchInBook,
  onHighlightAdded,
  onRemoveHighlight,
}: TextSelectionDockProps) {
  const [copied, setCopied] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const cleanText = selectedText.trim();
  if (!cleanText) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = cleanText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const handleApplyHighlight = (color: 'yellow' | 'green' | 'blue' | 'pink') => {
    const newHighlight: UserHighlight = {
      id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      bookId,
      pageNumber,
      text: cleanText,
      color,
      rects,
      createdAt: Date.now(),
    };
    saveBookHighlight(newHighlight);
    onHighlightAdded?.(newHighlight);
    setShowColorPicker(false);
    onClose();
  };

  return (
    <div
      style={{
        top: `${Math.max(12, position.top)}px`,
        left: `${Math.max(12, Math.min(window.innerWidth - 300, position.left))}px`,
      }}
      className="fixed z-50 flex flex-col gap-1.5 animate-fadeIn select-none text-selection-dock"
    >
      {/* Floating Edge Action Bar */}
      <div className="flex items-center gap-1 p-1 rounded-2xl bg-slate-900/95 dark:bg-zinc-900/95 text-white backdrop-blur-xl border border-white/20 shadow-2xl">
        {/* Copy */}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-white/15 text-xs font-medium transition-colors"
          title="Copy selected text (Ctrl+C)"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400 stroke-[3]" />
              <span className="text-emerald-300 font-semibold text-[11px]">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5 text-sky-400" />
              <span className="text-[11px]">Copy</span>
            </>
          )}
        </button>

        <div className="w-[1px] h-4 bg-white/15" />

        {/* Highlight with Color Picker */}
        <div className="relative">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShowColorPicker((v) => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl transition-colors text-xs font-medium ${
              showColorPicker ? 'bg-amber-500/25 text-amber-300' : 'hover:bg-white/15 text-white'
            }`}
            title="Highlight text"
          >
            <Highlighter className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[11px]">Highlight</span>
          </button>

          {showColorPicker && (
            <div
              onMouseDown={(e) => e.preventDefault()}
              className="absolute top-full left-0 mt-1.5 p-1.5 rounded-xl bg-slate-950/95 border border-white/20 shadow-xl flex items-center gap-2 z-50 animate-fadeIn"
            >
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleApplyHighlight('yellow')}
                className="w-5 h-5 rounded-full bg-yellow-400 hover:scale-110 transition-transform shadow-xs"
                title="Yellow Highlight"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleApplyHighlight('green')}
                className="w-5 h-5 rounded-full bg-emerald-400 hover:scale-110 transition-transform shadow-xs"
                title="Green Highlight"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleApplyHighlight('blue')}
                className="w-5 h-5 rounded-full bg-sky-400 hover:scale-110 transition-transform shadow-xs"
                title="Blue Highlight"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleApplyHighlight('pink')}
                className="w-5 h-5 rounded-full bg-pink-400 hover:scale-110 transition-transform shadow-xs"
                title="Pink Highlight"
              />
            </div>
          )}
        </div>

        {/* Remove / Erase Highlight Option */}
        {(hasExistingHighlight || onRemoveHighlight) && (
          <>
            <div className="w-[1px] h-4 bg-white/15" />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onRemoveHighlight?.();
                onClose();
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-rose-500/20 text-rose-300 hover:text-rose-200 text-xs font-medium transition-colors"
              title="Remove highlight on this selection"
            >
              <Eraser className="w-3.5 h-3.5 text-rose-400" />
              <span className="text-[11px]">Erase</span>
            </button>
          </>
        )}

        <div className="w-[1px] h-4 bg-white/15" />

        {/* Search Book */}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onSearchInBook(cleanText);
            onClose();
          }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-white/15 text-xs font-medium transition-colors"
          title="Search this text in book"
        >
          <Search className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-[11px]">Search</span>
        </button>

        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-white/15 text-white/60 hover:text-white transition-colors ml-0.5"
          title="Close dock"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
