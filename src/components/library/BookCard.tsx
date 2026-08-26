import React from 'react';
import { BookOpen, Search, FileText, CheckCircle2 } from 'lucide-react';
import { Book } from '../../types/book';
import { getReadingProgress } from '../../services/storageService';
import { resolveAssetUrl } from '../../services/hfStorage';

interface BookCardProps {
  book: Book;
  onSelectBook: (book: Book, initialPage?: number) => void;
  onSearchInBook: (book: Book) => void;
}

export function BookCard({ book, onSelectBook, onSearchInBook }: BookCardProps) {
  const progress = getReadingProgress(book.id);
  const coverUrl = resolveAssetUrl(book.coverUrl);

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="group relative glass-panel rounded-2xl overflow-hidden border border-subtle hover:border-emerald-500/40 transition-all duration-300 hover:shadow-2xl hover:shadow-emerald-500/15 flex flex-col bg-surface-elevated/50">
      {/* Cover Image Area */}
      <div
        onClick={() => onSelectBook(book, progress?.currentPage || 1)}
        className="relative aspect-[3/4] w-full overflow-hidden cursor-pointer bg-slate-900/90 flex items-center justify-center"
      >
        <img
          src={coverUrl}
          alt={book.title}
          loading="lazy"
          className="w-full h-full object-cover object-top transition-transform duration-500 group-hover:scale-105"
          onError={(e) => {
            (e.target as HTMLElement).style.display = 'none';
          }}
        />

        {/* Hover Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-4">
          <div className="w-full flex items-center justify-between gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSelectBook(book, progress?.currentPage || 1);
              }}
              className="flex-1 py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-600/40 transition-all"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>{progress ? 'Resume' : 'Read'}</span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSearchInBook(book);
              }}
              title="Search inside this book"
              className="p-2 rounded-xl bg-white/20 hover:bg-emerald-500/40 text-white backdrop-blur-md transition-all"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Reading Progress Badge */}
        {progress && progress.percent > 0 && (
          <div className="absolute top-3 right-3 px-2 py-0.5 rounded-full bg-black/75 backdrop-blur-md text-[11px] font-semibold text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
            {progress.percent === 100 ? (
              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            ) : null}
            <span>{progress.percent}%</span>
          </div>
        )}
      </div>

      {/* Book Metadata */}
      <div className="p-4 flex-1 flex flex-col justify-between">
        <div>
          <h3
            onClick={() => onSelectBook(book, progress?.currentPage || 1)}
            className="text-sm font-semibold text-main group-hover:text-emerald-400 transition-colors line-clamp-2 cursor-pointer"
            title={book.title}
          >
            {book.title}
          </h3>
          <p className="text-xs text-muted mt-1 truncate" title={book.author}>
            {book.author}
          </p>
        </div>

        <div className="mt-3 pt-3 border-t border-subtle flex items-center justify-between text-[11px] text-dim">
          <span className="flex items-center gap-1">
            <FileText className="w-3 h-3 text-emerald-400" />
            {book.totalPages} pages
          </span>
          <span>{formatFileSize(book.fileSize)}</span>
        </div>

        {/* Progress Bar */}
        {progress && progress.percent > 0 && (
          <div className="w-full bg-white/5 h-1 rounded-full overflow-hidden mt-2">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
