import React, { useState, useMemo } from 'react';
import { Book } from '../../types/book';
import { BookCard } from './BookCard';
import { Search, BookOpen, Layers, Tag as TagIcon } from 'lucide-react';

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

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6 animate-fade-in">
      {/* Minimalist Header & Filters */}
      <div className="space-y-3 pb-2 border-b border-subtle">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {/* Categories */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1 text-xs font-semibold text-muted mr-1">
              <Layers className="w-3.5 h-3.5 text-sky-400" />
              <span>Category:</span>
            </div>

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
                  className={`px-3 py-1 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 ${
                    isSelected
                      ? 'bg-sky-500 text-slate-950 font-bold shadow-md shadow-sky-500/25 border border-sky-400'
                      : 'bg-surface-elevated text-muted hover:text-main hover:bg-surface-elevated/80 border border-subtle'
                  }`}
                >
                  <span>{cat}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                      isSelected ? 'bg-slate-950/20 text-slate-950 font-extrabold' : 'bg-white/10 text-muted'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search Input & Global Search Action */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1 sm:w-64">
              <input
                type="text"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Filter titles or authors..."
                className="w-full px-3.5 py-1.5 pl-8 rounded-xl bg-surface-elevated border border-subtle focus:border-sky-500 text-main text-xs outline-none transition-colors"
              />
              <Search className="w-3.5 h-3.5 text-muted absolute left-2.5 top-2.5" />
            </div>

            <button
              onClick={() =>
                onOpenSearch(undefined, selectedCategory !== 'All' ? selectedCategory : undefined)
              }
              className="px-3.5 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-sky-600/20 transition-all shrink-0"
              title="Search OCR text across books"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Full Text Search</span>
            </button>
          </div>
        </div>

        {/* Tags bar if multiple tags available */}
        {availableTags.length > 2 && (
          <div className="flex flex-wrap items-center gap-1 pt-1">
            <div className="flex items-center gap-1 text-[11px] font-semibold text-dim mr-1 shrink-0">
              <TagIcon className="w-3 h-3 text-sky-400" />
              <span>Tag:</span>
            </div>
            {availableTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setSelectedTag(tag)}
                className={`px-2.5 py-0.5 rounded-lg text-[11px] font-medium transition-all ${
                  selectedTag === tag
                    ? 'bg-sky-600 text-white font-semibold shadow-sm border border-sky-400/40'
                    : 'bg-white/5 text-dim hover:text-main hover:bg-white/10 border border-white/5'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Books Grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="glass-panel rounded-2xl aspect-[3/4] animate-pulse bg-sky-500/5 border border-subtle"
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
        <div className="text-center py-16 glass-panel rounded-2xl border border-subtle space-y-2">
          <BookOpen className="w-10 h-10 text-muted mx-auto opacity-40" />
          <h3 className="text-sm font-semibold text-main">No books match the filter</h3>
          <p className="text-xs text-muted max-w-sm mx-auto">
            Try clearing filters or search query to view all books.
          </p>
        </div>
      )}
    </div>
  );
}
