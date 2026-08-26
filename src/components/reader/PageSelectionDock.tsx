import React from 'react';
import {
  Copy,
  SlidersHorizontal,
  X,
  CheckSquare,
  Square,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import { formatPageList } from '../../utils/pageRange';

interface PageSelectionDockProps {
  selectedPages: number[];
  currentPage: number;
  totalPages: number;
  isCapturing: boolean;
  onToggleCurrentPage: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onQuickCopy: () => void;
  onOpenAdvancedModal: () => void;
  onExitSelectionMode: () => void;
}

export function PageSelectionDock({
  selectedPages,
  currentPage,
  totalPages,
  isCapturing,
  onToggleCurrentPage,
  onSelectAll,
  onClearSelection,
  onQuickCopy,
  onOpenAdvancedModal,
  onExitSelectionMode,
}: PageSelectionDockProps) {
  const selectedCount = selectedPages.length;
  const isCurrentSelected = selectedPages.includes(currentPage);
  const formattedSummary = formatPageList(selectedPages);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 max-w-2xl w-[92%] sm:w-auto animate-fade-in">
      <div className="glass-panel bg-surface-elevated/95 backdrop-blur-2xl border border-sky-500/30 rounded-2xl shadow-2xl px-3 sm:px-5 py-2.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-2.5 sm:gap-4">
        {/* Selection summary info */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20 font-mono text-xs font-bold">
            {selectedCount}
          </div>
          <div className="flex flex-col">
            <div className="text-xs font-semibold text-main flex items-center gap-1.5">
              <span>{selectedCount === 1 ? '1 Page Selected' : `${selectedCount} Pages Selected`}</span>
            </div>
            <div className="text-[11px] text-muted font-mono truncate max-w-[140px] sm:max-w-[200px]" title={formattedSummary}>
              {selectedCount > 0 ? formattedSummary : 'Click pages or use buttons to select'}
            </div>
          </div>
        </div>

        {/* Action button helpers */}
        <div className="flex items-center gap-1 sm:gap-1.5">
          <button
            onClick={onToggleCurrentPage}
            title={isCurrentSelected ? `Deselect current page ${currentPage}` : `Select current page ${currentPage}`}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors border ${
              isCurrentSelected
                ? 'bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/25'
                : 'bg-white/5 border-subtle text-muted hover:text-main hover:bg-white/10'
            }`}
          >
            {isCurrentSelected ? <CheckSquare className="w-3.5 h-3.5 text-amber-400" /> : <Plus className="w-3.5 h-3.5 text-sky-400" />}
            <span className="hidden md:inline">Current (p.{currentPage})</span>
            <span className="md:hidden">p.{currentPage}</span>
          </button>

          {selectedCount < totalPages ? (
            <button
              onClick={onSelectAll}
              title="Select all pages"
              className="px-2.5 py-1.5 rounded-xl bg-white/5 border border-subtle text-muted hover:text-main hover:bg-white/10 text-xs font-semibold transition-colors flex items-center gap-1"
            >
              <Square className="w-3.5 h-3.5 text-sky-400" />
              <span className="hidden sm:inline">All</span>
            </button>
          ) : (
            <button
              onClick={onClearSelection}
              title="Clear selection"
              className="px-2.5 py-1.5 rounded-xl bg-white/5 border border-subtle text-muted hover:text-rose-400 hover:bg-rose-500/10 text-xs font-semibold transition-colors flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
              <span className="hidden sm:inline">Clear</span>
            </button>
          )}

          {selectedCount > 0 && selectedCount < totalPages && (
            <button
              onClick={onClearSelection}
              title="Clear selection"
              className="p-1.5 rounded-xl bg-white/5 border border-subtle text-muted hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
            </button>
          )}
        </div>

        {/* Right primary action & options */}
        <div className="flex items-center gap-1.5 ml-auto sm:ml-0 shrink-0">
          {/* Quick Copy to Clipboard Button */}
          <button
            onClick={onQuickCopy}
            disabled={selectedCount === 0 || isCapturing}
            className="px-3.5 py-1.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-40 disabled:pointer-events-none text-slate-950 text-xs font-bold shadow-lg shadow-sky-500/25 flex items-center gap-1.5 transition-all transform active:scale-95"
            title="Copy high-res screenshot directly to clipboard"
          >
            {isCapturing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Capturing...</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Screenshot</span>
              </>
            )}
          </button>

          {/* Advanced / Preview Modal Button */}
          <button
            onClick={onOpenAdvancedModal}
            title="Preview screenshot & customize layout/quality"
            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-muted hover:text-main border border-subtle transition-colors"
          >
            <SlidersHorizontal className="w-4 h-4 text-sky-400" />
          </button>

          {/* Exit Selection Mode */}
          <button
            onClick={onExitSelectionMode}
            title="Exit page selection mode"
            className="p-2 rounded-xl bg-white/5 hover:bg-rose-500/15 text-muted hover:text-rose-400 border border-subtle hover:border-rose-500/30 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
