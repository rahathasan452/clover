import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
  X,
  Gauge,
  Sliders,
} from 'lucide-react';

interface ReadAloudBarProps {
  pageText: string;
  currentPage: number;
  totalPages: number;
  isOpen: boolean;
  onClose: () => void;
  onPageChange: (page: number) => void;
}

export function ReadAloudBar({
  pageText,
  currentPage,
  totalPages,
  isOpen,
  onClose,
  onPageChange,
}: ReadAloudBarProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [rate, setRate] = useState(1.0);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Load available system voices
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;

    const updateVoices = () => {
      const vs = window.speechSynthesis.getVoices();
      setVoices(vs);
      if (!selectedVoice && vs.length > 0) {
        const preferred =
          vs.find((v) => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Edge') || v.name.includes('Google'))) ||
          vs.find((v) => v.lang.startsWith('en')) ||
          vs[0];
        if (preferred) setSelectedVoice(preferred.name);
      }
    };

    updateVoices();
    window.speechSynthesis.onvoiceschanged = updateVoices;
  }, [selectedVoice]);

  // Split page text into readable sentences/paragraphs
  useEffect(() => {
    if (!pageText) {
      setParagraphs([]);
      return;
    }
    const rawChunks = pageText
      .split(/(?<=[.?!;])\s+|\n{2,}/)
      .map((s) => s.trim())
      .filter((s) => s.length > 3);
    setParagraphs(rawChunks.length > 0 ? rawChunks : [pageText]);
    setCurrentIdx(0);
  }, [pageText, currentPage]);

  const stopAudio = useCallback(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlaying(false);
  }, []);

  const speakChunk = useCallback(
    (index: number) => {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();

      if (index >= paragraphs.length) {
        // Page completed! Automatically turn to next page like Microsoft Edge
        if (currentPage < totalPages) {
          onPageChange(currentPage + 1);
        } else {
          setIsPlaying(false);
        }
        return;
      }

      const text = paragraphs[index];
      if (!text) return;

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rate;
      if (selectedVoice) {
        const v = voices.find((v) => v.name === selectedVoice);
        if (v) utterance.voice = v;
      }

      utterance.onend = () => {
        setCurrentIdx((prev) => {
          const next = prev + 1;
          speakChunk(next);
          return next;
        });
      };

      utterance.onerror = (e) => {
        if (e.error !== 'canceled') {
          setIsPlaying(false);
        }
      };

      utteranceRef.current = utterance;
      setIsPlaying(true);
      window.speechSynthesis.speak(utterance);
    },
    [paragraphs, rate, selectedVoice, voices, currentPage, totalPages, onPageChange]
  );

  const handleTogglePlay = () => {
    if (isPlaying) {
      stopAudio();
    } else {
      speakChunk(currentIdx);
    }
  };

  const handleNext = () => {
    const next = Math.min(paragraphs.length, currentIdx + 1);
    setCurrentIdx(next);
    if (isPlaying) speakChunk(next);
  };

  const handlePrev = () => {
    const prev = Math.max(0, currentIdx - 1);
    setCurrentIdx(prev);
    if (isPlaying) speakChunk(prev);
  };

  const handleClose = () => {
    stopAudio();
    onClose();
  };

  // Cleanup on unmount or close
  useEffect(() => {
    return () => {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed top-14 left-0 right-0 z-40 flex justify-center px-4 animate-fadeIn pointer-events-none">
      <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-3 px-4 py-2 rounded-2xl bg-slate-900/95 dark:bg-zinc-900/95 text-white backdrop-blur-xl border border-sky-500/30 shadow-2xl max-w-2xl w-full">
        {/* Left: Info */}
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
            <Volume2 className="w-4 h-4" />
          </div>
          <div>
            <div className="text-xs font-bold text-sky-300 flex items-center gap-1.5">
              <span>Microsoft Edge Read Aloud</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-sky-500/20 text-sky-300 font-mono">
                p. {currentPage}/{totalPages}
              </span>
            </div>
            <div className="text-[11px] text-zinc-400 font-mono">
              Sentence {paragraphs.length > 0 ? currentIdx + 1 : 0} of {paragraphs.length}
            </div>
          </div>
        </div>

        {/* Center: Playback Controls */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handlePrev}
            disabled={currentIdx <= 0}
            className="p-1.5 rounded-xl hover:bg-white/10 disabled:opacity-30 text-white transition-colors"
            title="Previous sentence"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleTogglePlay}
            className="px-3 py-1.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-md shadow-sky-500/25 transition-all"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
            <span>{isPlaying ? 'Pause' : 'Play'}</span>
          </button>

          <button
            type="button"
            onClick={handleNext}
            disabled={currentIdx >= paragraphs.length - 1}
            className="p-1.5 rounded-xl hover:bg-white/10 disabled:opacity-30 text-white transition-colors"
            title="Next sentence"
          >
            <SkipForward className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={stopAudio}
            className="p-1.5 rounded-xl hover:bg-white/10 text-rose-400 transition-colors"
            title="Stop audio"
          >
            <Square className="w-4 h-4" />
          </button>
        </div>

        {/* Right: Voice Settings & Close */}
        <div className="flex items-center gap-2">
          {/* Rate Switcher */}
          <select
            value={rate}
            onChange={(e) => {
              const r = parseFloat(e.target.value);
              setRate(r);
              if (isPlaying) speakChunk(currentIdx);
            }}
            className="px-2 py-1 rounded-lg bg-black/40 border border-white/20 text-[11px] font-mono text-sky-300 outline-none"
            title="Voice Speed"
          >
            <option value="0.75">0.75x</option>
            <option value="1.0">1.0x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2.0">2.0x</option>
          </select>

          {/* Voice Switcher */}
          {voices.length > 0 && (
            <select
              value={selectedVoice}
              onChange={(e) => {
                setSelectedVoice(e.target.value);
                if (isPlaying) speakChunk(currentIdx);
              }}
              className="hidden sm:block max-w-[140px] truncate px-2 py-1 rounded-lg bg-black/40 border border-white/20 text-[11px] text-zinc-300 outline-none"
              title="Voice selection"
            >
              {voices
                .filter((v) => v.lang.startsWith('en') || v.lang.startsWith('fr') || v.lang.startsWith('de'))
                .slice(0, 15)
                .map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
            </select>
          )}

          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 rounded-xl hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
            title="Close Read Aloud"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
