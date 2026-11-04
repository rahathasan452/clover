import React, { useState, useMemo, useEffect } from 'react';
import { Book } from '../../types/book';
import { BookCard } from './BookCard';
import { Search, BookOpen, Layers, Tag as TagIcon, ChevronDown, X, RotateCcw } from 'lucide-react';
import { prewarmBook } from '../../services/pdfService';

interface BookshelfProps {
  books: Book[];
  isLoading: boolean;
  onSelectBook: (book: Book, initialPage?: number) => void;
  onOpenSearch: (filterBookId?: string, categoryFilter?: string) => void;
}

export function Bookshelf({ books, isLoading, onSelectBook, onOpenSearch }: BookshelfProps) {
  const [filterQuery, setFilterQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [selectedTag, setSelectedTag] = useState<string>('All');

  // Extract all unique categories dynamically
  const categories = useMemo(() => {
    const set = new Set<string>();
    books.forEach((b) => {
      if (b.category) set.add(b.category);
    });
    return ['All', ...Array.from(set)];
  }, [books]);

  // Extract tags for the selected category
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    books.forEach((b) => {
      if (selectedCategory === 'All' || b.category === selectedCategory) {
        if (b.tags && Array.isArray(b.tags)) {
          b.tags.forEach((t) => set.add(t));
        }
      }
    });
    return ['All', ...Array.from(set).sort()];
  }, [books, selectedCategory]);

  const filteredBooks = useMemo(() => {
    return books.filter((b) => {
      // Category filter
      if (selectedCategory !== 'All' && b.category !== selectedCategory) {
        return false;
      }
      // Tag filter
      if (selectedTag !== 'All') {
        if (!b.tags || !b.tags.includes(selectedTag)) return false;
      }
      // Search query filter
      if (filterQuery.trim()) {
        const q = filterQuery.toLowerCase();
        const matchesTitle = b.title.toLowerCase().includes(q);
        const matchesAuthor = b.author.toLowerCase().includes(q);
        const matchesTags = b.tags?.some((t) => t.toLowerCase().includes(q));
        const matchesCategory = b.category?.toLowerCase().includes(q);
        return matchesTitle || matchesAuthor || matchesTags || matchesCategory;
      }
      return true;
    });
  }, [books, filterQuery, selectedCategory, selectedTag]);

  const hasActiveFilters =
    selectedCategory !== 'All' || selectedTag !== 'All' || filterQuery.trim().length > 0;

  // Silently pre-warm top books into IndexedDB during browser idle time for 0ms instant open
  useEffect(() => {
    if (books.length > 0 && typeof window !== 'undefined') {
      const timer = setTimeout(() => {
        books.slice(0, 3).forEach((b) => {
          void prewarmBook(b.id, b.pdfUrl);
        });
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [books]);

  const handleResetFilters = () => {
    setSelectedCategory('All');
    setSelectedTag('All');
    setFilterQuery('');
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6 animate-fade-in">
      {/* Apple Books Minimalist Control Bar */}
      <div className="space-y-3 pb-3 border-b border-subtle">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* Categories Segmented Control */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
            <div className="flex items-center gap-1 text-xs font-semibold text-muted mr-1 shrink-0">
              <Layers className="w-3.5 h-3.5 text-sky-500" />
              <span>Category:</span>
            </div>

            <div className="inline-flex p-1 rounded-2xl bg-surface-elevated/70 border border-subtle gap-1 shrink-0">
              {categories.map((cat) => {
                const count = cat === 'All' ? books.length : books.filter((b) => b.category === cat).length;
                const isSelected = selectedCategory === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => {
                      setSelectedCategory(cat);
                      setSelectedTag('All');
                    }}
                    className={`px-3 py-1 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 ${isSelected
                        ? 'bg-surface text-main font-semibold shadow-sm border border-subtle/80'
                        : 'text-muted hover:text-main hover:bg-surface/50'
                      }`}
                  >
                    <span>{cat}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${isSelected
                          ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400 font-bold'
                          : 'bg-black/5 dark:bg-white/10 text-dim'
                        }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Side: Tag Dropdown Select, Filter Input & Global Search Action */}
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
            {/* Tag Dropdown Select */}
            {availableTags.length > 1 && (
              <div className="relative inline-flex items-center">
                <TagIcon className="w-3.5 h-3.5 text-sky-500 pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 z-10" />
                <select
                  value={selectedTag}
                  onChange={(e) => setSelectedTag(e.target.value)}
                  className="appearance-none pl-8 pr-8 py-1.5 rounded-xl bg-surface border border-subtle hover:border-sky-500/40 text-main text-xs font-medium outline-none transition-all cursor-pointer shadow-sm focus:ring-2 focus:ring-sky-500/20"
                  title="Filter books by tag"
                >
                  <option value="All">
                    All Tags ({availableTags.length > 1 ? availableTags.length - 1 : 0})
                  </option>
                  {availableTags
                    .filter((t) => t !== 'All')
                    .map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-muted pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2" />
                {selectedTag !== 'All' && (
                  <button
                    onClick={() => setSelectedTag('All')}
                    className="ml-1 p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-muted hover:text-main text-xs transition-colors"
                    title="Clear tag filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}

            {/* Title / Author Quick Filter Input */}
            <div className="relative flex-1 sm:w-56">
              <input
                type="text"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Filter titles or authors..."
                className="w-full px-3.5 py-1.5 pl-8 pr-7 rounded-xl bg-surface border border-subtle hover:border-sky-500/40 focus:border-sky-500 text-main text-xs outline-none transition-colors shadow-sm placeholder:text-dim"
              />
              <Search className="w-3.5 h-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
              {filterQuery && (
                <button
                  onClick={() => setFilterQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-muted hover:text-main"
                  title="Clear query"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* OCR Full-Text Search Action */}
            <button
              onClick={() =>
                onOpenSearch(undefined, selectedCategory !== 'All' ? selectedCategory : undefined)
              }
              className="px-3.5 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-sky-600/20 transition-all shrink-0 active:scale-95"
              title="Search OCR text & embeddings across books"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Full Text Search</span>
            </button>
          </div>
        </div>

        {/* Active Filter Pill Bar (Appears only when filtering to reduce clutter) */}
        {hasActiveFilters && (
          <div className="flex items-center justify-between text-xs pt-1 animate-fade-in">
            <div className="flex items-center gap-2 text-muted">
              <span>
                Showing <strong className="text-main font-semibold">{filteredBooks.length}</strong> of{' '}
                {books.length} books
              </span>
              {selectedCategory !== 'All' && (
                <span className="px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium text-[11px] flex items-center gap-1">
                  Category: {selectedCategory}
                  <button onClick={() => setSelectedCategory('All')}>
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              )}
              {selectedTag !== 'All' && (
                <span className="px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium text-[11px] flex items-center gap-1">
                  Tag: {selectedTag}
                  <button onClick={() => setSelectedTag('All')}>
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              )}
            </div>

            <button
              onClick={handleResetFilters}
              className="flex items-center gap-1 text-[11px] text-muted hover:text-main transition-colors font-medium"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset filters</span>
            </button>
          </div>
        )}
      </div>

      {/* Books Grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl aspect-[3/4] animate-pulse bg-surface border border-subtle"
            />
          ))}
        </div>
      ) : filteredBooks.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6">
          {filteredBooks.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              onSelectBook={onSelectBook}
              onSearchInBook={() => onOpenSearch(book.id, book.category)}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-16 rounded-2xl border border-subtle bg-surface space-y-3">
          <BookOpen className="w-10 h-10 text-muted mx-auto opacity-40" />
          <h3 className="text-sm font-semibold text-main">No books match the filter</h3>
          <p className="text-xs text-muted max-w-sm mx-auto">
            Try resetting your search query or tag selection to view all books.
          </p>
          <button
            onClick={handleResetFilters}
            className="px-3.5 py-1.5 rounded-xl bg-surface-elevated text-xs font-semibold text-main hover:bg-surface border border-subtle transition-all"
          >
            Show All Books
          </button>
        </div>
      )}
    </div>
  );
}
