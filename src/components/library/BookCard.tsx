import React from 'react';
import { BookOpen, Search, CheckCircle2 } from 'lucide-react';
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

  return (
    <div className="group relative glass-panel rounded-2xl overflow-hidden border border-subtle hover:border-sky-500/40 transition-all duration-200 hover:shadow-xl hover:shadow-sky-500/10 flex flex-col bg-surface-elevated/40">
      {/* Cover Image Area */}
      <div
        onClick={() => onSelectBook(book, progress?.currentPage || 1)}
        className="relative aspect-[3/4] w-full overflow-hidden cursor-pointer bg-slate-950 flex items-center justify-center"
      >
        <img
          src={coverUrl}
          alt={book.title}
          loading="lazy"
          className="w-full h-full object-cover object-top transition-transform duration-300 group-hover:scale-105"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            const cleanPath = (book.coverUrl || `data/covers/${book.id}.jpg`).replace(/^\//, '');
            const localUrl = `/${cleanPath}`;
            if (target.src !== window.location.origin + localUrl) {
              target.src = localUrl;
            } else {
              target.style.display = 'none';
            }
          }}
        />


        {/* Hover Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
          <div className="w-full flex items-center justify-between gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSelectBook(book, progress?.currentPage || 1);
              }}
              className="flex-1 py-1.5 px-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-sky-600/30 transition-all"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>{progress ? 'Resume' : 'Read'}</span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSearchInBook(book);
              }}
              title="Search in this book"
              className="p-1.5 rounded-xl bg-white/20 hover:bg-sky-500/40 text-white backdrop-blur-md transition-all"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Reading Progress Badge */}
        {progress && progress.percent > 0 && (
          <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full bg-black/80 backdrop-blur-md text-[10px] font-semibold text-sky-300 border border-sky-500/30 flex items-center gap-1">
            {progress.percent === 100 && <CheckCircle2 className="w-3 h-3 text-sky-400" />}
            <span>{progress.percent}%</span>
          </div>
        )}
      </div>

      {/* Book Metadata */}
      <div className="p-3.5 flex-1 flex flex-col justify-between">
        <div>
          <h3
            onClick={() => onSelectBook(book, progress?.currentPage || 1)}
            className="text-xs sm:text-sm font-semibold text-main group-hover:text-sky-400 transition-colors line-clamp-2 cursor-pointer leading-snug"
            title={book.title}
          >
            {book.title}
          </h3>
          <p className="text-[11px] text-muted mt-1 truncate" title={book.author}>
            {book.author}
          </p>

          {/* Tags */}
          {book.tags && book.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {book.tags.slice(0, 2).map((tag, idx) => (
                <span
                  key={idx}
                  className="px-1.5 py-0.2 rounded bg-white/5 text-muted text-[10px] font-medium border border-subtle"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="mt-2.5 pt-2.5 border-t border-subtle flex items-center justify-between text-[10px] text-dim font-mono">
          <span>{book.totalPages} pages</span>
          {book.category && (
            <span className="text-sky-400/80 font-sans">{book.category}</span>
          )}
        </div>

        {/* Reading Progress Bar */}
        {progress && progress.percent > 0 && (
          <div className="w-full bg-white/5 h-0.5 rounded-full overflow-hidden mt-1.5">
            <div
              className="bg-sky-500 h-full rounded-full transition-all"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
