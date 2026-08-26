import React, { useState, useMemo } from 'react';
import { Book } from '../../types/book';
import { BookCard } from './BookCard';
import { Search, Library, Sparkles, BookOpen, Layers, HardDrive } from 'lucide-react';

interface BookshelfProps {
  books: Book[];
  isLoading: boolean;
  onSelectBook: (book: Book, initialPage?: number) => void;
  onOpenSearch: (filterBookId?: string) => void;
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

  // Extract top tags for the selected category
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    books.forEach((b) => {
      if (selectedCategory === 'All' || b.category === selectedCategory) {
        if (b.tags && Array.isArray(b.tags)) {
          b.tags.forEach((t) => set.add(t));
        }
      }
    });
    return ['All', ...Array.from(set)];
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

  const totalPagesCount = useMemo(() => {
    return books.reduce((acc, b) => acc + (b.totalPages || 0), 0);
  }, [books]);

  const totalSize = useMemo(() => {
    const bytes = books.reduce((acc, b) => acc + (b.fileSize || 0), 0);
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }, [books]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8 animate-fade-in">
      {/* Hero / Stats Banner */}
      <div className="relative overflow-hidden glass-panel rounded-3xl p-6 sm:p-8 border border-subtle bg-surface-elevated/60 shadow-xl">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-500 text-xs font-semibold">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Mint Scientific & Trading Library</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-main tracking-tight">
              Read & Search Across Your Books Instantly
            </h2>
            <p className="text-sm text-muted">
              Stream pages on-demand without full downloads. Search text across all books
              simultaneously with exact OCR bounding-box highlighting.
            </p>
          </div>

          {/* Quick Stats Pill */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <div className="px-4 py-3 rounded-2xl glass-panel bg-surface border border-subtle flex items-center gap-3">
              <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-500">
                <BookOpen className="w-5 h-5" />
              </div>
              <div>
                <div className="text-base font-bold text-main">{books.length}</div>
                <div className="text-[11px] text-muted">Books</div>
              </div>
            </div>

            <div className="px-4 py-3 rounded-2xl glass-panel bg-surface border border-subtle flex items-center gap-3">
              <div className="p-2 rounded-xl bg-teal-500/15 text-teal-500">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <div className="text-base font-bold text-main">{totalPagesCount.toLocaleString()}</div>
                <div className="text-[11px] text-muted">Total Pages</div>
              </div>
            </div>

            <div className="px-4 py-3 rounded-2xl glass-panel bg-surface border border-subtle flex items-center gap-3">
              <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-500">
                <HardDrive className="w-5 h-5" />
              </div>
              <div>
                <div className="text-base font-bold text-main">{totalSize}</div>
                <div className="text-[11px] text-muted">Cloud Stored</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Filter and Search Controls */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Filter library by title, author, or tags..."
              className="w-full px-4 py-2.5 pl-10 rounded-2xl bg-surface-elevated/70 border border-subtle focus:border-emerald-500 text-main text-sm outline-none transition-colors"
            />
            <Search className="w-4 h-4 text-emerald-400/60 absolute left-3.5 top-3.5" />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onOpenSearch()}
              className="px-5 py-2.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold flex items-center gap-2 shadow-lg shadow-emerald-600/30 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <Search className="w-4 h-4" />
              <span>Search Text Across All Books</span>
            </button>
          </div>
        </div>

        {/* Category & Tag Filter Pills */}
        <div className="space-y-2">
          {/* Main Categories (e.g. All, Trading, Engineering) */}
          {categories.length > 2 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-muted mr-1">Category:</span>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => {
                    setSelectedCategory(cat);
                    setSelectedTag('All');
                  }}
                  className={`px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all ${
                    selectedCategory === cat
                      ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/25'
                      : 'bg-surface-elevated/60 text-muted hover:text-main hover:bg-surface-elevated border border-subtle'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}

          {/* Sub-tags */}
          {availableTags.length > 2 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-xs font-semibold text-muted mr-1">Topic:</span>
              {availableTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setSelectedTag(tag)}
                  className={`px-3 py-1 rounded-lg text-[11px] font-medium transition-all ${
                    selectedTag === tag
                      ? 'bg-teal-600/80 text-white border border-teal-400/40 shadow-sm'
                      : 'bg-white/5 text-dim hover:text-main hover:bg-white/10 border border-white/5'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Books Grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="glass-panel rounded-2xl aspect-[3/4] animate-pulse bg-emerald-500/5 border border-subtle"
            />
          ))}
        </div>
      ) : filteredBooks.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
          {filteredBooks.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              onSelectBook={onSelectBook}
              onSearchInBook={() => onOpenSearch(book.id)}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-16 glass-panel rounded-3xl border border-subtle space-y-3">
          <Library className="w-12 h-12 text-muted mx-auto opacity-40" />
          <h3 className="text-base font-semibold text-main">No books found</h3>
          <p className="text-xs text-muted max-w-sm mx-auto">
            {filterQuery || selectedCategory !== 'All' || selectedTag !== 'All'
              ? 'No books match the selected filters. Try clearing some tags.'
              : 'Your library is currently empty. Run the ingest script to add books.'}
          </p>
        </div>
      )}
    </div>
  );
}
