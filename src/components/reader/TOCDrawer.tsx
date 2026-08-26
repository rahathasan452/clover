import React, { useState } from 'react';
import { TOCItem } from '../../types/book';
import { Bookmark } from '../../types/reader';
import { ListTree, Bookmark as BookmarkIcon, X, ChevronRight } from 'lucide-react';

interface TOCDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  toc: TOCItem[];
  bookmarks: Bookmark[];
  currentPage: number;
  onSelectPage: (page: number) => void;
}

export function TOCDrawer({
  isOpen,
  onClose,
  toc,
  bookmarks,
  currentPage,
  onSelectPage,
}: TOCDrawerProps) {
  const [tab, setTab] = useState<'toc' | 'bookmarks'>('toc');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 left-0 z-50 w-80 sm:w-96 glass-panel bg-surface-elevated/95 border-r border-emerald-500/20 shadow-2xl flex flex-col animate-slide-right backdrop-blur-xl">
      {/* Header Tabs */}
      <div className="p-4 border-b border-subtle flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 p-1 rounded-xl bg-white/5 border border-subtle flex-1">
          <button
            onClick={() => setTab('toc')}
            className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
              tab === 'toc'
                ? 'bg-emerald-600 text-white shadow shadow-emerald-600/30'
                : 'text-muted hover:text-main'
            }`}
          >
            <ListTree className="w-3.5 h-3.5" />
            <span>Contents ({toc.length})</span>
          </button>

          <button
            onClick={() => setTab('bookmarks')}
            className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
              tab === 'bookmarks'
                ? 'bg-emerald-600 text-white shadow shadow-emerald-600/30'
                : 'text-muted hover:text-main'
            }`}
          >
            <BookmarkIcon className="w-3.5 h-3.5" />
            <span>Bookmarks ({bookmarks.length})</span>
          </button>
        </div>

        <button
          onClick={onClose}
          className="p-2 rounded-xl text-muted hover:text-main hover:bg-white/10 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-1">
        {tab === 'toc' ? (
          toc.length > 0 ? (
            toc.map((item, i) => {
              const isCurrent = currentPage === item.page;
              const indentClass =
                item.level === 1
                  ? 'pl-2 font-medium text-main text-sm'
                  : item.level === 2
                  ? 'pl-6 text-xs text-muted font-normal'
                  : 'pl-10 text-[11px] text-dim';

              return (
                <button
                  key={i}
                  onClick={() => {
                    onSelectPage(item.page);
                    onClose();
                  }}
                  className={`w-full text-left py-2 px-3 rounded-xl transition-all flex items-center justify-between group hover:bg-emerald-500/10 ${indentClass} ${
                    isCurrent
                      ? 'bg-emerald-600/20 text-emerald-300 font-semibold border border-emerald-500/35'
                      : ''
                  }`}
                >
                  <span className="truncate pr-2">{item.title}</span>
                  <span className="text-[11px] font-mono text-dim group-hover:text-emerald-400 shrink-0">
                    p. {item.page}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="text-center py-12 text-muted space-y-2">
              <ListTree className="w-8 h-8 mx-auto opacity-30 text-emerald-400" />
              <p className="text-xs">No table of contents available for this book.</p>
            </div>
          )
        ) : bookmarks.length > 0 ? (
          bookmarks.map((bm) => (
            <button
              key={bm.id}
              onClick={() => {
                onSelectPage(bm.page);
                onClose();
              }}
              className="w-full text-left p-3 rounded-xl bg-white/5 hover:bg-emerald-600/15 border border-subtle hover:border-emerald-500/40 transition-all flex items-center justify-between group"
            >
              <div className="flex items-center gap-2">
                <BookmarkIcon className="w-3.5 h-3.5 text-emerald-400 fill-emerald-400" />
                <span className="text-xs font-medium text-main">{bm.title}</span>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-muted group-hover:translate-x-0.5 transition-transform" />
            </button>
          ))
        ) : (
          <div className="text-center py-12 text-muted space-y-2">
            <BookmarkIcon className="w-8 h-8 mx-auto opacity-30 text-emerald-400" />
            <p className="text-xs font-semibold text-main">No bookmarks yet</p>
            <p className="text-[11px] text-dim max-w-xs mx-auto">
              Click the bookmark icon on the toolbar to bookmark important pages.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
