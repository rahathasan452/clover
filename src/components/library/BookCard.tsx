import React from 'react';
import { BookOpen, Search, CheckCircle2, WifiOff } from 'lucide-react';
import { Book } from '../../types/book';
import { getReadingProgress } from '../../services/storageService';
import { isBookSavedOffline } from '../../services/pdfCacheService';
import { resolveAssetUrl } from '../../services/hfStorage';

interface BookCardProps {
  book: Book;
  onSelectBook: (book: Book, initialPage?: number) => void;
  onSearchInBook: (book: Book) => void;
}

export function BookCard({ book, onSelectBook, onSearchInBook }: BookCardProps) {
  const progress = getReadingProgress(book.id);
  const savedOffline = isBookSavedOffline(book.id);
  const coverUrl = resolveAssetUrl(book.coverUrl);

  return (
    <div className="group relative rounded-2xl overflow-hidden border border-subtle hover:border-sky-500/40 transition-all duration-300 ease-out hover:-translate-y-1.5 hover:shadow-xl hover:shadow-black/10 flex flex-col bg-surface">
      {/* Cover Image Area with Apple Books 3D Spine Crease */}
      <div
        onClick={() => onSelectBook(book, progress?.currentPage || 1)}
        className="relative aspect-[3/4] w-full overflow-hidden cursor-pointer bg-neutral-900/5 dark:bg-slate-950 flex items-center justify-center border-b border-subtle/50"
      >
        <img
          src={coverUrl}
          alt={book.title}
          loading="lazy"
          className="w-full h-full object-cover object-top transition-transform duration-300 ease-out group-hover:scale-105"
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

        {/* Apple Books 3D Physical Spine Crease Reflection */}
        <div className="book-spine-crease" />

        {/* Hover Fluid Action Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-end p-3 z-20">
          <div className="w-full flex items-center justify-between gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSelectBook(book, progress?.currentPage || 1);
              }}
              className="flex-1 py-1.5 px-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-sky-600/30 transition-all active:scale-95"
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
              className="p-1.5 rounded-xl bg-white/20 hover:bg-sky-500/50 text-white backdrop-blur-md transition-all active:scale-95"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Offline Pinned Badge */}
        {savedOffline && (
          <div
            title="Saved for 100% offline reading"
            className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-full bg-emerald-950/85 backdrop-blur-md text-[10px] font-semibold text-emerald-300 border border-emerald-500/40 flex items-center gap-1 z-10"
          >
            <WifiOff className="w-2.5 h-2.5 text-emerald-400" />
            <span>Offline</span>
          </div>
        )}

        {/* Reading Progress Badge */}
        {progress && progress.percent > 0 && (
          <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full bg-black/80 backdrop-blur-md text-[10px] font-semibold text-sky-300 border border-sky-500/30 flex items-center gap-1 z-10">
            {progress.percent === 100 && <CheckCircle2 className="w-3 h-3 text-sky-400" />}
            <span>{progress.percent}%</span>
          </div>
        )}
      </div>

      {/* Book Metadata - Clean & Clutter-Free */}
      <div className="p-3.5 flex-1 flex flex-col justify-between">
        <div>
          <h3
            onClick={() => onSelectBook(book, progress?.currentPage || 1)}
            className="text-xs sm:text-sm font-semibold text-main group-hover:text-sky-500 transition-colors line-clamp-2 cursor-pointer leading-snug"
            title={book.title}
          >
            {book.title}
          </h3>
          <p className="text-[11px] text-muted mt-1 truncate" title={book.author}>
            {book.author}
          </p>
        </div>

        <div className="mt-2.5">
          <div className="pt-2 border-t border-subtle flex items-center justify-between text-[10px] text-dim font-mono">
            <span>{book.totalPages} pages</span>
            {book.category && (
              <span className="text-sky-500/90 font-sans font-medium">{book.category}</span>
            )}
          </div>

          {/* Reading Progress Bar */}
          {progress && progress.percent > 0 && (
            <div className="w-full bg-subtle/40 h-1 rounded-full overflow-hidden mt-2">
              <div
                className="bg-sky-500 h-full rounded-full transition-all"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
