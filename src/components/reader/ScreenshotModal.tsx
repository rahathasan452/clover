import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  Copy,
  Download,
  Check,
  Loader2,
  Columns,
  Rows,
  Sparkles,
  BookOpen,
  Hash,
  Palette,
  Eye,
  CheckSquare,
  Square,
  Maximize2,
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { ScreenshotLayout, ScreenshotTheme, ScreenshotOptions, CaptureProgress } from '../../types/screenshot';
import { parsePageRange, formatPageList } from '../../utils/pageRange';
import {
  renderMultiPageScreenshot,
  copyScreenshotToClipboard,
  downloadScreenshotBlob,
} from '../../services/screenshotService';

interface ScreenshotModalProps {
  isOpen: boolean;
  onClose: () => void;
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  bookTitle: string;
  currentPage: number;
  totalPages: number;
  initialSelectedPages?: number[];
  currentReaderTheme: string;
  onCopySuccess?: (message: string) => void;
}

export function ScreenshotModal({
  isOpen,
  onClose,
  pdfDoc,
  bookTitle,
  currentPage,
  totalPages,
  initialSelectedPages = [],
  currentReaderTheme,
  onCopySuccess,
}: ScreenshotModalProps) {
  // Page selection state
  const [rangeInput, setRangeInput] = useState('');
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [showThumbnailGrid, setShowThumbnailGrid] = useState(false);

  // Configuration options
  const [layout, setLayout] = useState<ScreenshotLayout>('vertical');
  const [scale, setScale] = useState<number>(2.0);
  const [theme, setTheme] = useState<ScreenshotTheme>('original');
  const [showPageNumbers, setShowPageNumbers] = useState(true);
  const [showBookTitle, setShowBookTitle] = useState(true);

  // Preview & export state
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [previewDimensions, setPreviewDimensions] = useState<{ width: number; height: number } | null>(null);
  const [progress, setProgress] = useState<CaptureProgress>({
    total: 0,
    current: 0,
    status: 'idle',
  });
  const [isCopied, setIsCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize selected pages when modal opens
  useEffect(() => {
    if (isOpen) {
      const initial =
        initialSelectedPages.length > 0
          ? Array.from(new Set(initialSelectedPages)).sort((a, b) => a - b)
          : [currentPage];
      setSelectedPages(initial);
      setRangeInput(formatPageList(initial));
      setIsCopied(false);
      setError(null);
    }
  }, [isOpen, initialSelectedPages, currentPage]);

  // Handle range input change
  const handleRangeInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setRangeInput(val);
    const parsed = parsePageRange(val, totalPages);
    setSelectedPages(parsed);
  };

  // Toggle single page
  const togglePage = (p: number) => {
    let updated: number[];
    if (selectedPages.includes(p)) {
      updated = selectedPages.filter((x) => x !== p);
    } else {
      updated = [...selectedPages, p].sort((a, b) => a - b);
    }
    setSelectedPages(updated);
    setRangeInput(formatPageList(updated));
  };

  // Presets
  const handlePresetCurrent = () => {
    setSelectedPages([currentPage]);
    setRangeInput(`${currentPage}`);
  };

  const handlePresetSpread = () => {
    const second = currentPage < totalPages ? currentPage + 1 : currentPage;
    const pages = Array.from(new Set([currentPage, second])).sort((a, b) => a - b);
    setSelectedPages(pages);
    setRangeInput(formatPageList(pages));
    setLayout('grid-2');
  };

  const handlePresetNext3 = () => {
    const pages: number[] = [];
    for (let p = currentPage; p <= Math.min(totalPages, currentPage + 2); p++) {
      pages.push(p);
    }
    setSelectedPages(pages);
    setRangeInput(formatPageList(pages));
  };

  const handleSelectAll = () => {
    const all = Array.from({ length: totalPages }, (_, i) => i + 1);
    setSelectedPages(all);
    setRangeInput(`1-${totalPages}`);
  };

  const handleClearAll = () => {
    setSelectedPages([]);
    setRangeInput('');
    setPreviewBlob(null);
    setPreviewDataUrl(null);
    setPreviewDimensions(null);
  };

  // Generate composite preview
  const generatePreview = useCallback(async () => {
    if (!pdfDoc || selectedPages.length === 0) {
      setPreviewBlob(null);
      setPreviewDataUrl(null);
      setPreviewDimensions(null);
      return;
    }

    try {
      setIsExporting(true);
      setError(null);

      const options: ScreenshotOptions = {
        scale,
        layout,
        theme,
        currentReaderTheme,
        showPageNumbers,
        showBookTitle,
      };

      const result = await renderMultiPageScreenshot(
        pdfDoc,
        selectedPages,
        options,
        bookTitle,
        (p) => setProgress(p)
      );

      setPreviewBlob(result.blob);
      setPreviewDimensions({ width: result.canvas.width, height: result.canvas.height });

      const url = URL.createObjectURL(result.blob);
      setPreviewDataUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch (err: any) {
      console.error('Screenshot generation failed:', err);
      setError(err?.message || 'Failed to render screenshot');
    } finally {
      setIsExporting(false);
      setProgress({ total: 0, current: 0, status: 'idle' });
    }
  }, [
    pdfDoc,
    selectedPages,
    scale,
    layout,
    theme,
    currentReaderTheme,
    showPageNumbers,
    showBookTitle,
    bookTitle,
  ]);

  // Automatically update preview when relevant options or selected pages change
  useEffect(() => {
    if (isOpen && pdfDoc && selectedPages.length > 0) {
      const debounceTimer = setTimeout(() => {
        generatePreview();
      }, 250);
      return () => clearTimeout(debounceTimer);
    }
  }, [isOpen, selectedPages, scale, layout, theme, showPageNumbers, showBookTitle, generatePreview]);

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      if (previewDataUrl) URL.revokeObjectURL(previewDataUrl);
    };
  }, [previewDataUrl]);

  // Action: Copy to Clipboard
  const handleCopyToClipboard = async () => {
    if (!pdfDoc || selectedPages.length === 0) return;

    try {
      setIsExporting(true);
      setError(null);

      let blobToCopy = previewBlob;
      if (!blobToCopy) {
        const options: ScreenshotOptions = {
          scale,
          layout,
          theme,
          currentReaderTheme,
          showPageNumbers,
          showBookTitle,
        };
        const result = await renderMultiPageScreenshot(
          pdfDoc,
          selectedPages,
          options,
          bookTitle,
          (p) => setProgress(p)
        );
        blobToCopy = result.blob;
      }

      await copyScreenshotToClipboard(blobToCopy);
      setIsCopied(true);
      const msg = `Copied ${selectedPages.length} ${
        selectedPages.length === 1 ? 'page' : 'pages'
      } (${formatPageList(selectedPages)}) to clipboard!`;
      onCopySuccess?.(msg);
      setTimeout(() => setIsCopied(false), 2500);
    } catch (err: any) {
      console.error('Clipboard copy error:', err);
      setError(err?.message || 'Failed to copy image to clipboard');
    } finally {
      setIsExporting(false);
      setProgress({ total: 0, current: 0, status: 'idle' });
    }
  };

  // Action: Download PNG
  const handleDownload = async () => {
    if (!pdfDoc || selectedPages.length === 0) return;

    try {
      setIsExporting(true);
      setError(null);

      let blobToDownload = previewBlob;
      if (!blobToDownload) {
        const options: ScreenshotOptions = {
          scale,
          layout,
          theme,
          currentReaderTheme,
          showPageNumbers,
          showBookTitle,
        };
        const result = await renderMultiPageScreenshot(
          pdfDoc,
          selectedPages,
          options,
          bookTitle,
          (p) => setProgress(p)
        );
        blobToDownload = result.blob;
      }

      const cleanBookName = bookTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
      const pageStr = formatPageList(selectedPages).replace(/[\s,]+/g, '_');
      const filename = `${cleanBookName}_p_${pageStr}.png`;

      downloadScreenshotBlob(blobToDownload, filename);
      onCopySuccess?.(`Downloaded screenshot as ${filename}`);
    } catch (err: any) {
      console.error('Download error:', err);
      setError(err?.message || 'Failed to download screenshot');
    } finally {
      setIsExporting(false);
      setProgress({ total: 0, current: 0, status: 'idle' });
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Capture Multi-Page Screenshot" maxWidth="max-w-5xl">
      <div className="flex flex-col lg:flex-row gap-6 max-h-[75vh]">
        {/* Left Side: Controls & Page Selection */}
        <div className="w-full lg:w-[48%] flex flex-col gap-4 overflow-y-auto pr-1">
          {/* Page Range Input & Presets */}
          <div className="p-4 rounded-2xl bg-white/5 border border-subtle flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-main flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5 text-sky-400" />
                <span>Pages to Capture</span>
              </label>
              <span className="text-[11px] font-mono text-muted">
                {selectedPages.length} of {totalPages} selected
              </span>
            </div>

            <div className="relative">
              <input
                type="text"
                value={rangeInput}
                onChange={handleRangeInputChange}
                placeholder="e.g. 1-3, 5, 8-10 or 'all'"
                className="w-full px-3.5 py-2 rounded-xl bg-surface border border-strong text-main font-mono text-sm outline-none focus:border-sky-500 transition-colors"
              />
              {selectedPages.length > 0 && (
                <div className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono px-2 py-0.5 rounded bg-sky-500/20 text-sky-300">
                  {selectedPages.length}p
                </div>
              )}
            </div>

            {/* Quick Preset Buttons */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <button
                type="button"
                onClick={handlePresetCurrent}
                className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-sky-500/15 text-muted hover:text-sky-300 text-xs font-medium border border-subtle transition-colors"
              >
                Current (p.{currentPage})
              </button>
              <button
                type="button"
                onClick={handlePresetSpread}
                className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-sky-500/15 text-muted hover:text-sky-300 text-xs font-medium border border-subtle transition-colors"
              >
                2-Page Spread
              </button>
              <button
                type="button"
                onClick={handlePresetNext3}
                className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-sky-500/15 text-muted hover:text-sky-300 text-xs font-medium border border-subtle transition-colors"
              >
                Next 3 Pages
              </button>
              <button
                type="button"
                onClick={handleSelectAll}
                className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-sky-500/15 text-muted hover:text-sky-300 text-xs font-medium border border-subtle transition-colors"
              >
                Select All
              </button>
              <button
                type="button"
                onClick={handleClearAll}
                className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-rose-500/15 text-muted hover:text-rose-400 text-xs font-medium border border-subtle transition-colors ml-auto"
              >
                Clear
              </button>
            </div>

            {/* Page Picker Accordion */}
            <div className="pt-2 border-t border-subtle">
              <button
                type="button"
                onClick={() => setShowThumbnailGrid((prev) => !prev)}
                className="text-xs font-semibold text-sky-400 hover:text-sky-300 flex items-center justify-between w-full"
              >
                <span>{showThumbnailGrid ? '▾ Hide Page Grid Picker' : '▸ Show Page Grid Picker'}</span>
                <span className="text-[10px] text-muted">Click pages to toggle</span>
              </button>

              {showThumbnailGrid && (
                <div className="mt-2.5 p-2 rounded-xl bg-surface border border-subtle max-h-36 overflow-y-auto grid grid-cols-6 sm:grid-cols-8 gap-1.5 animate-fade-in">
                  {Array.from({ length: totalPages }).map((_, i) => {
                    const p = i + 1;
                    const isSelected = selectedPages.includes(p);
                    const isCurrent = p === currentPage;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => togglePage(p)}
                        className={`h-8 rounded-lg font-mono text-xs flex items-center justify-center font-semibold transition-all border ${
                          isSelected
                            ? 'bg-sky-500 text-slate-950 border-sky-400 shadow-sm'
                            : isCurrent
                            ? 'bg-amber-500/10 border-amber-500/40 text-amber-400'
                            : 'bg-white/5 border-subtle text-muted hover:text-main hover:bg-white/10'
                        }`}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Layout & Composition Options */}
          <div className="p-4 rounded-2xl bg-white/5 border border-subtle flex flex-col gap-3.5">
            <h4 className="text-xs font-semibold text-main flex items-center gap-1.5">
              <Columns className="w-3.5 h-3.5 text-sky-400" />
              <span>Layout & Arrangement</span>
            </h4>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setLayout('vertical')}
                className={`p-2.5 rounded-xl border flex flex-col items-center gap-1.5 text-xs font-medium transition-all ${
                  layout === 'vertical'
                    ? 'bg-sky-500/20 border-sky-500/40 text-sky-300 shadow-md'
                    : 'bg-white/5 border-subtle text-muted hover:text-main'
                }`}
              >
                <Rows className="w-4 h-4" />
                <span>Vertical Stack</span>
              </button>

              <button
                type="button"
                onClick={() => setLayout('grid-2')}
                className={`p-2.5 rounded-xl border flex flex-col items-center gap-1.5 text-xs font-medium transition-all ${
                  layout === 'grid-2'
                    ? 'bg-sky-500/20 border-sky-500/40 text-sky-300 shadow-md'
                    : 'bg-white/5 border-subtle text-muted hover:text-main'
                }`}
              >
                <Columns className="w-4 h-4" />
                <span>2-Column Grid</span>
              </button>

              <button
                type="button"
                onClick={() => setLayout('horizontal')}
                className={`p-2.5 rounded-xl border flex flex-col items-center gap-1.5 text-xs font-medium transition-all ${
                  layout === 'horizontal'
                    ? 'bg-sky-500/20 border-sky-500/40 text-sky-300 shadow-md'
                    : 'bg-white/5 border-subtle text-muted hover:text-main'
                }`}
              >
                <div className="flex items-center gap-0.5">
                  <div className="w-2.5 h-4 rounded-sm bg-current" />
                  <div className="w-2.5 h-4 rounded-sm bg-current" />
                </div>
                <span>Side-by-Side</span>
              </button>
            </div>

            {/* Quality / Resolution Scale */}
            <div className="pt-2 border-t border-subtle flex items-center justify-between">
              <span className="text-xs font-semibold text-main flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                <span>Render Quality / DPI</span>
              </span>

              <div className="flex items-center gap-1 p-1 rounded-xl bg-surface border border-subtle">
                <button
                  type="button"
                  onClick={() => setScale(1.5)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-mono font-medium transition-colors ${
                    scale === 1.5 ? 'bg-sky-600 text-white shadow' : 'text-muted hover:text-main'
                  }`}
                >
                  1.5x (Fast)
                </button>
                <button
                  type="button"
                  onClick={() => setScale(2.0)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-mono font-medium transition-colors ${
                    scale === 2.0 ? 'bg-sky-600 text-white shadow' : 'text-muted hover:text-main'
                  }`}
                >
                  2.0x (Crisp)
                </button>
                <button
                  type="button"
                  onClick={() => setScale(3.0)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-mono font-medium transition-colors ${
                    scale === 3.0 ? 'bg-sky-600 text-white shadow' : 'text-muted hover:text-main'
                  }`}
                >
                  3.0x (Ultra)
                </button>
              </div>
            </div>

            {/* Theme / Appearance */}
            <div className="pt-2 border-t border-subtle flex items-center justify-between">
              <span className="text-xs font-semibold text-main flex items-center gap-1.5">
                <Palette className="w-3.5 h-3.5 text-sky-400" />
                <span>Color Style</span>
              </span>

              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value as ScreenshotTheme)}
                className="px-3 py-1 rounded-xl bg-surface border border-subtle text-main text-xs font-medium outline-none focus:border-sky-500"
              >
                <option value="original">Original PDF (White Page)</option>
                <option value="current">Current Reader Theme ({currentReaderTheme})</option>
                <option value="dark">Dark Charcoal</option>
                <option value="oled">Pitch OLED</option>
                <option value="sepia">Warm Sepia</option>
                <option value="light">Day Soft</option>
              </select>
            </div>

            {/* Header & Badges Toggles */}
            <div className="pt-2 border-t border-subtle flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-main">
                <input
                  type="checkbox"
                  checked={showPageNumbers}
                  onChange={(e) => setShowPageNumbers(e.target.checked)}
                  className="rounded text-sky-500 focus:ring-sky-500"
                />
                <span>Page Badges ("p. 14")</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer text-xs text-main">
                <input
                  type="checkbox"
                  checked={showBookTitle}
                  onChange={(e) => setShowBookTitle(e.target.checked)}
                  className="rounded text-sky-500 focus:ring-sky-500"
                />
                <span>Book Title Header</span>
              </label>
            </div>
          </div>
        </div>

        {/* Right Side: Live Interactive Preview */}
        <div className="w-full lg:w-[52%] flex flex-col rounded-2xl bg-surface border border-subtle overflow-hidden">
          <div className="px-4 py-2.5 border-b border-subtle flex items-center justify-between bg-white/[0.02]">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-sky-400" />
              <span className="text-xs font-semibold text-main">Composite Preview</span>
            </div>
            {previewDimensions && (
              <span className="text-[11px] font-mono text-muted">
                {previewDimensions.width} × {previewDimensions.height} px
              </span>
            )}
          </div>

          <div className="flex-1 min-h-[300px] max-h-[440px] p-4 overflow-auto flex items-center justify-center bg-black/40 relative">
            {isExporting ? (
              <div className="flex flex-col items-center gap-3 text-muted">
                <Loader2 className="w-8 h-8 animate-spin text-sky-400" />
                <span className="text-xs font-semibold text-main">
                  {progress.message || 'Generating screenshot...'}
                </span>
                {progress.total > 0 && (
                  <div className="w-48 h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-sky-400 transition-all duration-300"
                      style={{
                        width: `${Math.round((progress.current / progress.total) * 100)}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            ) : error ? (
              <div className="p-4 text-center max-w-sm">
                <p className="text-xs text-rose-400 mb-2 font-medium">{error}</p>
                <button
                  onClick={generatePreview}
                  className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold text-main"
                >
                  Retry Render
                </button>
              </div>
            ) : previewDataUrl ? (
              <img
                src={previewDataUrl}
                alt="Multi-page screenshot preview"
                className="max-h-full max-w-full object-contain rounded-lg shadow-2xl border border-white/10"
              />
            ) : selectedPages.length === 0 ? (
              <div className="text-center text-muted text-xs p-4">
                <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-40 text-sky-400" />
                <p>No pages selected.</p>
                <p className="text-[11px] text-dim mt-1">Enter a page range or click pages above.</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Modal Bottom Actions */}
      <div className="mt-6 pt-4 border-t border-subtle flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted flex items-center gap-2">
          <span>{selectedPages.length} {selectedPages.length === 1 ? 'page' : 'pages'} ready</span>
          {selectedPages.length > 0 && (
            <span className="font-mono text-sky-300">({formatPageList(selectedPages)})</span>
          )}
        </div>

        <div className="flex items-center gap-2.5 ml-auto">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-muted hover:text-main text-xs font-semibold transition-colors"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleDownload}
            disabled={selectedPages.length === 0 || isExporting}
            className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:pointer-events-none text-main text-xs font-semibold border border-subtle transition-colors flex items-center gap-1.5"
            title="Download high-resolution PNG image"
          >
            <Download className="w-3.5 h-3.5 text-sky-400" />
            <span>Download PNG</span>
          </button>

          <button
            type="button"
            onClick={handleCopyToClipboard}
            disabled={selectedPages.length === 0 || isExporting}
            className={`px-5 py-2 rounded-xl font-bold text-xs shadow-lg flex items-center gap-2 transition-all transform active:scale-95 ${
              isCopied
                ? 'bg-emerald-500 text-slate-950 shadow-emerald-500/25'
                : 'bg-sky-500 hover:bg-sky-400 text-slate-950 shadow-sky-500/25 disabled:opacity-40 disabled:pointer-events-none'
            }`}
          >
            {isCopied ? (
              <>
                <Check className="w-4 h-4" />
                <span>Copied to Clipboard!</span>
              </>
            ) : isExporting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Copying...</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                <span>Copy to Clipboard</span>
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
