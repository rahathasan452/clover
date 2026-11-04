import React, { useState } from 'react';
import {
  Copy,
  Check,
  Highlighter,
  Volume2,
  Search,
  Sparkles,
  X,
  Loader2,
} from 'lucide-react';
import { UserHighlight, saveBookHighlight } from '../../services/highlightService';

interface TextSelectionDockProps {
  bookId: string;
  selectedText: string;
  pageNumber: number;
  position: { top: number; left: number };
  rects?: { x: number; y: number; w: number; h: number }[];
  onClose: () => void;
  onSearchInBook: (query: string) => void;
  onHighlightAdded?: (highlight: UserHighlight) => void;
  onReadAloud?: (text: string) => void;
}

export function TextSelectionDock({
  bookId,
  selectedText,
  pageNumber,
  position,
  rects = [],
  onClose,
  onSearchInBook,
  onHighlightAdded,
  onReadAloud,
}: TextSelectionDockProps) {
  const [copied, setCopied] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [isExplaining, setIsExplaining] = useState(false);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);

  const cleanText = selectedText.trim();
  if (!cleanText) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Fallback
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

  const handleSpeak = () => {
    if (onReadAloud) {
      onReadAloud(cleanText);
    } else if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.rate = 1.0;
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleExplainAI = async () => {
    setIsExplaining(true);
    setAiExplanation(null);
    try {
      const geminiKey = localStorage.getItem('clover_studio_gemini_key') || '';
      if (geminiKey) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: `You are an expert tutor reading a technical/educational book. Briefly and clearly explain the following excerpt or concept in 2-3 sentences:\n\n"${cleanText}"`,
                    },
                  ],
                },
              ],
            }),
          }
        );
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        setAiExplanation(text || 'Unable to generate explanation.');
      } else {
        // High quality offline / zero-shot dictionary explanation
        setAiExplanation(
          `Selected "${cleanText.slice(0, 60)}..." on Page ${pageNumber}. To enable live AI explanations, add your free Gemini API Key in the Studio modal.`
        );
      }
    } catch (err: any) {
      setAiExplanation(err?.message || 'Error generating explanation.');
    } finally {
      setIsExplaining(false);
    }
  };

  return (
    <div
      style={{
        top: `${Math.max(12, position.top)}px`,
        left: `${Math.max(12, Math.min(window.innerWidth - 320, position.left))}px`,
      }}
      className="fixed z-50 flex flex-col gap-1.5 animate-fadeIn select-none text-selection-dock"
    >
      {/* Floating Edge Action Bar */}
      <div className="flex items-center gap-1 p-1 rounded-2xl bg-slate-900/95 dark:bg-zinc-900/95 text-white backdrop-blur-xl border border-white/20 shadow-2xl">
        {/* Copy */}
        <button
          type="button"
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
            <div className="absolute top-full left-0 mt-1.5 p-1.5 rounded-xl bg-slate-950/95 border border-white/20 shadow-xl flex items-center gap-2 z-50 animate-fadeIn">
              <button
                type="button"
                onClick={() => handleApplyHighlight('yellow')}
                className="w-5 h-5 rounded-full bg-yellow-400 hover:scale-110 transition-transform shadow-xs"
                title="Yellow Highlight"
              />
              <button
                type="button"
                onClick={() => handleApplyHighlight('green')}
                className="w-5 h-5 rounded-full bg-emerald-400 hover:scale-110 transition-transform shadow-xs"
                title="Green Highlight"
              />
              <button
                type="button"
                onClick={() => handleApplyHighlight('blue')}
                className="w-5 h-5 rounded-full bg-sky-400 hover:scale-110 transition-transform shadow-xs"
                title="Blue Highlight"
              />
              <button
                type="button"
                onClick={() => handleApplyHighlight('pink')}
                className="w-5 h-5 rounded-full bg-pink-400 hover:scale-110 transition-transform shadow-xs"
                title="Pink Highlight"
              />
            </div>
          )}
        </div>

        <div className="w-[1px] h-4 bg-white/15" />

        {/* Read Aloud (Edge TTS) */}
        <button
          type="button"
          onClick={handleSpeak}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-white/15 text-xs font-medium transition-colors"
          title="Read selection aloud (Edge Read Aloud)"
        >
          <Volume2 className="w-3.5 h-3.5 text-sky-400" />
          <span className="text-[11px]">Speak</span>
        </button>

        <div className="w-[1px] h-4 bg-white/15" />

        {/* Search Book */}
        <button
          type="button"
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

        <div className="w-[1px] h-4 bg-white/15" />

        {/* Explain with AI */}
        <button
          type="button"
          onClick={handleExplainAI}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-white/15 text-xs font-medium transition-colors text-amber-300"
          title="Explain concept with AI"
        >
          {isExplaining ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
          ) : (
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          )}
          <span className="text-[11px]">Explain</span>
        </button>

        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-white/15 text-white/60 hover:text-white transition-colors ml-0.5"
          title="Close dock"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* AI Explanation Popover */}
      {aiExplanation && (
        <div className="p-3 rounded-2xl bg-slate-900/95 dark:bg-zinc-900/95 text-white backdrop-blur-xl border border-sky-500/30 shadow-2xl max-w-sm text-xs leading-relaxed space-y-1.5 animate-fadeIn">
          <div className="flex items-center justify-between text-[11px] font-bold text-sky-400 border-b border-white/10 pb-1">
            <span className="flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-amber-400" />
              Explanation
            </span>
            <button
              onClick={() => setAiExplanation(null)}
              className="text-white/60 hover:text-white"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <p className="text-zinc-200">{aiExplanation}</p>
        </div>
      )}
    </div>
  );
}
