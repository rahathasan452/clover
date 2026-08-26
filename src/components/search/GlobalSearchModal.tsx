import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Search, X, Loader2, BookOpen, Target, ChevronDown, ChevronUp, Layers, ArrowRight } from 'lucide-react';
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
  onSearch: (
    query: string,
    bookIdFilter?: string | string[],
    categoryFilter?: string | string[]
  ) => void;
  onSelectHit: (hit: SearchHit) => void;
  initialBookFilter?: string;
  initialCategoryFilter?: string;
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
  initialCategoryFilter,
}: GlobalSearchModalProps) {
  const [query, setQuery] = useState(activeQuery);
  const [selectedCategory, setSelectedCategory] = useState<string>(initialCategoryFilter || 'All');
  const [selectedBookFilter, setSelectedBookFilter] = useState<string>(initialBookFilter || '');
  const [sortBy, setSortBy] = useState<'page' | 'score'>('page');
  const [expandedBooks, setExpandedBooks] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  // Extract all authentic categories with book counts
  const categoryStats = useMemo(() => {
    const map = new Map<string, number>();
    books.forEach((b) => {
      const cat = b.category || 'Uncategorized';
      map.set(cat, (map.get(cat) || 0) + 1);
    });
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [books]);

  // Filter available books based on selected category
  const categoryFilteredBooks = useMemo(() => {
    return books.filter((b) => {
      if (selectedCategory !== 'All' && (b.category || 'Uncategorized') !== selectedCategory) {
        return false;
      }
      return true;
    });
  }, [books, selectedCategory]);

  // Sync initial filter when opened
  useEffect(() => {
    if (isOpen) {
      if (initialBookFilter) {
        setSelectedBookFilter(initialBookFilter);
        const book = books.find((b) => b.id === initialBookFilter);
        if (book && book.category) {
          setSelectedCategory(book.category);
        }
      } else if (initialCategoryFilter) {
        setSelectedCategory(initialCategoryFilter);
      }
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialBookFilter, initialCategoryFilter, books]);

  // Debounced search with Category and Book filters
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim().length > 0) {
        onSearch(
          query,
          selectedBookFilter || undefined,
          selectedCategory !== 'All' ? selectedCategory : undefined
        );
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [query, selectedBookFilter, selectedCategory, onSearch]);

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

  const handleCategorySelect = (cat: string) => {
    setSelectedCategory(cat);
    if (selectedBookFilter) {
      const currentBook = books.find((b) => b.id === selectedBookFilter);
      if (cat !== 'All' && currentBook?.category !== cat) {
        setSelectedBookFilter('');
      }
    }
  };

  const handleClearFilters = () => {
    setSelectedCategory('All');
    setSelectedBookFilter('');
  };

  const getBookCoverUrl = (bookId: string) => {
    const book = books.find((b) => b.id === bookId);
    return book ? resolveAssetUrl(book.coverUrl) : '';
  };

  const getSelectedBookTitle = () => {
    const b = books.find((x) => x.id === selectedBookFilter);
    return b ? b.title : '';
  };

  // Sort groups and hits according to sortBy state
  const sortedGroupedResults = useMemo(() => {
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

  const hasActiveFilters = selectedCategory !== 'All' || selectedBookFilter !== '';

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="max-w-4xl">
      <div className="space-y-3">
        {/* Search Header Input */}
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              selectedBookFilter
                ? `Search inside "${getSelectedBookTitle().substring(0, 35)}..."`
                : selectedCategory !== 'All'
                ? `Search inside ${selectedCategory} books (${categoryFilteredBooks.length} books)...`
                : `Search text across all ${books.length} books...`
            }
            className="w-full px-4 py-3.5 pl-11 pr-24 rounded-2xl bg-surface-elevated border border-strong focus:border-sky-500 text-main text-base outline-none transition-all shadow-inner placeholder:text-muted/60"
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
                title="Clear query"
              >
                <X className="w-4 h-4" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Clean Category Selector Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1 text-xs font-semibold text-muted mr-1 shrink-0">
              <Layers className="w-3.5 h-3.5 text-sky-400" />
              <span>Category:</span>
            </div>

            <button
              type="button"
              onClick={() => handleCategorySelect('All')}
              className={`px-3 py-1 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 ${
                selectedCategory === 'All'
                  ? 'bg-sky-500 text-slate-950 font-bold shadow-md shadow-sky-500/25 border border-sky-400'
                  : 'bg-surface-elevated/70 text-muted hover:text-main hover:bg-surface-elevated border border-subtle'
              }`}
            >
              <span>All</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                  selectedCategory === 'All'
                    ? 'bg-slate-950/20 text-slate-950 font-extrabold'
                    : 'bg-white/10 text-muted'
                }`}
              >
                {books.length}
              </span>
            </button>

            {categoryStats.map((cat) => {
              const isSelected = selectedCategory === cat.name;
              return (
                <button
                  key={cat.name}
                  type="button"
                  onClick={() => handleCategorySelect(cat.name)}
                  className={`px-3 py-1 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 ${
                    isSelected
                      ? 'bg-sky-500 text-slate-950 font-bold shadow-md shadow-sky-500/25 border border-sky-400'
                      : 'bg-surface-elevated/70 text-muted hover:text-main hover:bg-surface-elevated border border-subtle'
                  }`}
                >
                  <span>{cat.name}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                      isSelected
                        ? 'bg-slate-950/20 text-slate-950 font-extrabold'
                        : 'bg-white/10 text-muted'
                    }`}
                  >
                    {cat.count}
                  </span>
                </button>
              );
            })}
          </div>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={handleClearFilters}
              className="text-[11px] text-rose-400 hover:text-rose-300 hover:underline font-semibold flex items-center gap-1 ml-auto"
            >
              <X className="w-3 h-3" />
              <span>Reset Filter</span>
            </button>
          )}
        </div>

        {/* Secondary Filter & Results Status Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted border-b border-subtle pb-2.5 pt-0.5">
          <div className="flex flex-wrap items-center gap-3">
            {/* Book Scope Selector */}
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-main">Book:</span>
              <select
                value={selectedBookFilter}
                onChange={(e) => setSelectedBookFilter(e.target.value)}
                className="bg-surface-elevated text-main px-2.5 py-1 rounded-lg border border-subtle focus:border-sky-500 outline-none text-xs max-w-[240px] truncate"
              >
                <option value="">
                  {selectedCategory !== 'All'
                    ? `All ${selectedCategory} Books (${categoryFilteredBooks.length})`
                    : `All Books (${books.length})`}
                </option>
                {categoryFilteredBooks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title.substring(0, 42)}...
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
                    ? 'bg-sky-500 text-slate-950 font-bold shadow-sm'
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
                    ? 'bg-sky-500 text-slate-950 font-bold shadow-sm'
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
                {selectedCategory !== 'All' && ` [${selectedCategory}]`}
              </span>
            ) : isIndexLoaded ? (
              <span className="text-dim">
                {categoryFilteredBooks.length} books in scope • {totalRecords.toLocaleString()} blocks indexed
              </span>
            ) : (
              <span className="text-sky-400 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading OCR Index...
              </span>
            )}
          </div>
        </div>

        {/* Search Results Area */}
        <div className="max-h-[60vh] overflow-y-auto space-y-3.5 pr-1">
          {sortedGroupedResults.length > 0 ? (
            sortedGroupedResults.map((group) => {
              const isExpanded = expandedBooks[group.bookId] !== false;
              const coverUrl = getBookCoverUrl(group.bookId);

              return (
                <div
                  key={group.bookId}
                  className="glass-panel rounded-2xl border border-subtle overflow-hidden bg-surface-elevated/50 shadow-sm"
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
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-semibold text-main truncate">
                            {group.bookTitle}
                          </h4>
                          {group.category && (
                            <span className="px-2 py-0.2 rounded-md bg-white/5 text-muted text-[10px] font-medium border border-subtle shrink-0 hidden sm:inline-block">
                              {group.category}
                            </span>
                          )}
                        </div>
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
          ) : query.trim().length > 0 && !isSearching ? (
            <div className="text-center py-12 space-y-3 text-muted">
              <Target className="w-10 h-10 mx-auto opacity-40 text-sky-400" />
              <div>
                <p className="text-sm font-semibold text-main">
                  No matches found for "{query}"
                  {selectedCategory !== 'All' ? ` in category "${selectedCategory}"` : ''}
                </p>
                <p className="text-xs text-dim mt-1">
                  {hasActiveFilters
                    ? 'Try searching across all categories or checking for typos.'
                    : 'Try checking for typos or searching for broader terms.'}
                </p>
              </div>

              {hasActiveFilters && (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={handleClearFilters}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md shadow-sky-600/20 transition-all"
                  >
                    <span>Search Across All Categories Instead</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12 space-y-2 text-muted">
              <BookOpen className="w-10 h-10 mx-auto opacity-35 text-sky-400" />
              <p className="text-sm font-semibold text-main">
                {selectedCategory !== 'All'
                  ? `Search within ${selectedCategory} books`
                  : 'Search books simultaneously'}
              </p>
              <p className="text-xs text-dim max-w-md mx-auto">
                Type any term to search across OCR text. Use category tabs above to filter by upload category.
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
