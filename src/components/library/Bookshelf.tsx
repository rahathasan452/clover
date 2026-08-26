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

  const filteredBooks = useMemo(() => {
    if (!filterQuery.trim()) return books;
    const q = filterQuery.toLowerCase();
    return books.filter(
      (b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
    );
  }, [books, filterQuery]);

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
      <div className="relative overflow-hidden glass-panel rounded-3xl p-6 sm:p-8 border border-emerald-500/20 bg-gradient-to-br from-emerald-950/40 via-surface-elevated/80 to-teal-950/30 shadow-2xl shadow-emerald-950/40">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs font-semibold">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Mint Scientific & OCR Library</span>
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
            <div className="px-4 py-3 rounded-2xl glass-panel bg-white/5 border border-emerald-500/15 flex items-center gap-3">
              <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-400">
                <BookOpen className="w-5 h-5" />
              </div>
              <div>
                <div className="text-base font-bold text-main">{books.length}</div>
                <div className="text-[11px] text-muted">Books</div>
              </div>
            </div>

            <div className="px-4 py-3 rounded-2xl glass-panel bg-white/5 border border-emerald-500/15 flex items-center gap-3">
              <div className="p-2 rounded-xl bg-teal-500/15 text-teal-400">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <div className="text-base font-bold text-main">{totalPagesCount.toLocaleString()}</div>
                <div className="text-[11px] text-muted">Total Pages</div>
              </div>
            </div>

            <div className="px-4 py-3 rounded-2xl glass-panel bg-white/5 border border-emerald-500/15 flex items-center gap-3">
              <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-300">
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

      {/* Filter Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Filter library by title or author..."
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
            {filterQuery
              ? `No books match "${filterQuery}". Try a different filter term.`
              : 'Your library is currently empty. Run the ingest script to add books.'}
          </p>
        </div>
      )}
    </div>
  );
}
