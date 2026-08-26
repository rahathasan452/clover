import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Loader2, BookOpen, Target, ChevronDown, ChevronUp } from 'lucide-react';
import { Modal } from '../common/Modal';
import { SearchResultsGrouped, SearchHit } from '../../types/search';
import { Book } from '../../types/book';
import { SearchResultItem } from './SearchResultItem';
import { resolveAssetUrl } from '../../services/hfStorage';

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  books: Book[];
  isSearching: boolean;
  isIndexLoaded: boolean;
  totalRecords: number;
  groupedResults: SearchResultsGrouped[];
  totalMatches: number;
  activeQuery: string;
  onSearch: (query: string, bookIdFilter?: string) => void;
  onSelectHit: (hit: SearchHit) => void;
  initialBookFilter?: string;
}

export function GlobalSearchModal({
  isOpen,
  onClose,
  books,
  isSearching,
  isIndexLoaded,
  totalRecords,
  groupedResults,
  totalMatches,
  activeQuery,
  onSearch,
  onSelectHit,
  initialBookFilter,
}: GlobalSearchModalProps) {
  const [query, setQuery] = useState(activeQuery);
  const [selectedBookFilter, setSelectedBookFilter] = useState<string>(initialBookFilter || '');
  const [sortBy, setSortBy] = useState<'page' | 'score'>('page');
  const [expandedBooks, setExpandedBooks] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync initial filter when opened
  useEffect(() => {
    if (isOpen) {
      if (initialBookFilter) setSelectedBookFilter(initialBookFilter);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialBookFilter]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim().length > 1) {
        onSearch(query, selectedBookFilter || undefined);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query, selectedBookFilter, onSearch]);

  // Expand all matching books by default
  useEffect(() => {
    if (groupedResults.length > 0) {
      const exp: Record<string, boolean> = {};
      groupedResults.forEach((g) => {
        exp[g.bookId] = true;
      });
      setExpandedBooks(exp);
    }
  }, [groupedResults]);

  const toggleBookExpand = (bookId: string) => {
    setExpandedBooks((prev) => ({
      ...prev,
      [bookId]: !prev[bookId],
    }));
  };

  const getBookCoverUrl = (bookId: string) => {
    const book = books.find((b) => b.id === bookId);
    return book ? resolveAssetUrl(book.coverUrl) : '';
  };

  // Sort groups and hits according to sortBy state
  const sortedGroupedResults = React.useMemo(() => {
    return groupedResults.map((group) => {
      const hitsCopy = [...group.hits];
      if (sortBy === 'page') {
        hitsCopy.sort((a, b) => {
          if (a.page !== b.page) return a.page - b.page;
          const aY = a.bboxes?.[0]?.[1] ?? 0;
          const bY = b.bboxes?.[0]?.[1] ?? 0;
          return aY - bY;
        });
      } else {
        hitsCopy.sort((a, b) => (b.score || 0) - (a.score || 0));
      }
      return {
        ...group,
        hits: hitsCopy,
      };
    });
  }, [groupedResults, sortBy]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="max-w-3xl">
      <div className="space-y-4">
        {/* Search Header Input */}
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search text across all books (e.g. 'moving average', 'candlestick', 'risk')..."
            className="w-full px-4 py-3.5 pl-11 pr-24 rounded-2xl bg-surface-elevated border border-strong focus:border-sky-500 text-main text-base outline-none transition-all shadow-inner"
          />
          <Search className="w-5 h-5 text-sky-400 absolute left-3.5 top-4" />

          {/* Right Status / Clear */}
          <div className="absolute right-3.5 top-3 flex items-center gap-2">
            {isSearching ? (
              <Loader2 className="w-5 h-5 text-sky-400 animate-spin" />
            ) : query ? (
              <button
                onClick={() => {
                  setQuery('');
                  onSearch('');
                  inputRef.current?.focus();
                }}
                className="p-1 rounded-lg text-muted hover:text-main hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Filter Bar & Stats */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted border-b border-subtle pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-main">Scope:</span>
              <select
                value={selectedBookFilter}
                onChange={(e) => setSelectedBookFilter(e.target.value)}
                className="bg-surface-elevated text-main px-2.5 py-1 rounded-lg border border-subtle focus:border-sky-500 outline-none text-xs"
              >
                <option value="">All Books ({books.length})</option>
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title.substring(0, 45)}...
                  </option>
                ))}
              </select>
            </div>

            {/* Sort Order Toggle */}
            <div className="flex items-center gap-1 bg-surface-elevated px-1.5 py-0.5 rounded-lg border border-subtle">
              <span className="font-semibold text-muted text-[11px] mr-1">Order:</span>
              <button
                type="button"
                onClick={() => setSortBy('page')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                  sortBy === 'page'
                    ? 'bg-sky-500 text-white font-semibold shadow-sm'
                    : 'text-dim hover:text-main'
                }`}
              >
                Page 1→9
              </button>
              <button
                type="button"
                onClick={() => setSortBy('score')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                  sortBy === 'score'
                    ? 'bg-sky-500 text-white font-semibold shadow-sm'
                    : 'text-dim hover:text-main'
                }`}
              >
                Relevance
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 font-mono">
            {totalMatches > 0 ? (
              <span className="text-sky-400 font-semibold">
                {totalMatches} matches in {sortedGroupedResults.length} {sortedGroupedResults.length === 1 ? 'book' : 'books'}
              </span>
            ) : isIndexLoaded ? (
              <span className="text-dim">
                {totalRecords.toLocaleString()} searchable OCR blocks ready
              </span>
            ) : (
              <span className="text-sky-400 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading OCR Index...
              </span>
            )}
          </div>
        </div>

        {/* Search Results Area */}
        <div className="max-h-[60vh] overflow-y-auto space-y-4 pr-1">
          {sortedGroupedResults.length > 0 ? (
            sortedGroupedResults.map((group) => {
              const isExpanded = expandedBooks[group.bookId] !== false;
              const coverUrl = getBookCoverUrl(group.bookId);

              return (
                <div
                  key={group.bookId}
                  className="glass-panel rounded-2xl border border-subtle overflow-hidden bg-surface-elevated/50"
                >
                  {/* Book Header Accordion */}
                  <div
                    onClick={() => toggleBookExpand(group.bookId)}
                    className="p-3 sm:p-4 flex items-center justify-between gap-3 cursor-pointer hover:bg-sky-500/10 transition-colors border-b border-subtle/50"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {coverUrl && (
                        <img
                          src={coverUrl}
                          alt={group.bookTitle}
                          className="w-8 h-11 object-cover rounded-md shadow shrink-0 border border-subtle"
                        />
                      )}
                      <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-main truncate">
                          {group.bookTitle}
                        </h4>
                        <p className="text-xs text-muted truncate">{group.author}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="px-2.5 py-1 rounded-full bg-sky-500/15 text-sky-300 text-xs font-semibold border border-sky-500/35">
                        {group.totalMatches} {group.totalMatches === 1 ? 'match' : 'matches'}
                      </span>
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-muted" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-muted" />
                      )}
                    </div>
                  </div>

                  {/* List of Matching Snippets */}
                  {isExpanded && (
                    <div className="p-3 sm:p-4 space-y-2.5 animate-fade-in bg-black/20">
                      {group.hits.map((hit) => (
                        <SearchResultItem
                          key={hit.id}
                          hit={hit}
                          query={query}
                          onSelectHit={(h) => {
                            onSelectHit(h);
                            onClose();
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          ) : query.trim().length > 1 && !isSearching ? (
            <div className="text-center py-12 space-y-2 text-muted">
              <Target className="w-10 h-10 mx-auto opacity-40 text-sky-400" />
              <p className="text-sm font-semibold text-main">No matches found for "{query}"</p>
              <p className="text-xs text-dim">
                Try checking for typos or searching for broader terms like "trend", "price", or "system".
              </p>
            </div>
          ) : (
            <div className="text-center py-12 space-y-2 text-muted">
              <BookOpen className="w-10 h-10 mx-auto opacity-35 text-sky-400" />
              <p className="text-sm font-semibold text-main">Search all books simultaneously</p>
              <p className="text-xs text-dim max-w-md mx-auto">
                Type any scientific or financial word to search across all OCR text and jump directly to
                highlighted bounding boxes.
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
