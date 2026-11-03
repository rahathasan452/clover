import React, { useState, useEffect, useCallback } from 'react';
import { get as getIDB, set as setIDB } from 'idb-keyval';
import { useLibrary } from './hooks/useLibrary';
import { useMultiBookSearch } from './hooks/useMultiBookSearch';
import { Navbar } from './components/common/Navbar';
import { Bookshelf } from './components/library/Bookshelf';
import { PDFReader } from './components/reader/PDFReader';
import { GlobalSearchModal } from './components/search/GlobalSearchModal';
import { HFConfigModal } from './components/library/HFConfigModal';
import { IngestStudioModal } from './components/studio/IngestStudioModal';
import { Book } from './types/book';
import { BookLayout } from './types/layout';
import { SearchHit, BBox } from './types/search';
import { HighlightTarget, ReaderTheme } from './types/reader';
import { getSavedTheme, saveTheme } from './services/storageService';
import { resolveAssetUrl, resolveLocalPath, getAuthHeaders } from './services/hfStorage';

export function App() {
  const [currentTheme, setCurrentTheme] = useState<ReaderTheme>('dark');
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [activeInitialPage, setActiveInitialPage] = useState<number>(1);
  const [highlightTarget, setHighlightTarget] = useState<HighlightTarget | null>(null);

  // Modals state
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [searchBookFilter, setSearchBookFilter] = useState<string | undefined>(undefined);
  const [searchCategoryFilter, setSearchCategoryFilter] = useState<string | undefined>(undefined);
  const [isHFModalOpen, setIsHFModalOpen] = useState(false);
  const [isStudioModalOpen, setIsStudioModalOpen] = useState(false);

  // Library & Multi-Book Hybrid Search Hooks
  const { books, isLoading: isLibraryLoading, refresh: refreshLibrary } = useLibrary();
  const {
    search,
    warmupVectorModel,
    groupedResults,
    totalMatches,
    activeQuery,
    isIndexLoaded,
    isSearching,
    totalRecords,
    vectorStatus,
  } = useMultiBookSearch(books);

  // Initialize theme on mount
  useEffect(() => {
    const saved = getSavedTheme();
    setCurrentTheme(saved);
    saveTheme(saved);
  }, []);

  const handleThemeChange = (theme: ReaderTheme) => {
    setCurrentTheme(theme);
    saveTheme(theme);
  };

  // Global Keyboard Shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchBookFilter(undefined);
        setSearchCategoryFilter(undefined);
        setIsSearchModalOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleOpenSearch = useCallback((bookIdFilter?: string, categoryFilter?: string) => {
    setSearchBookFilter(bookIdFilter);
    setSearchCategoryFilter(categoryFilter);
    setIsSearchModalOpen(true);
  }, []);

  // Lazily refine paragraph highlight into exact word-level [x0, y0, x1, y1] highlights for that 1 book
  const refineWordHighlightsForHit = useCallback(async (book: Book, hit: SearchHit) => {
    const terms = (hit.matchedWords || [])
      .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter((w) => w.length >= 2);
    if (terms.length === 0) return;

    try {
      const cacheKey = `layout_${book.id}`;
      let layout: BookLayout | undefined = await getIDB(cacheKey);
      if (!layout) {
        const cleanPath = (book.layoutUrl || `data/layouts/${book.id}.json`).replace(/^\//, '');
        let res = await fetch(resolveAssetUrl(cleanPath), { headers: getAuthHeaders() });
        if (!res.ok) {
          res = await fetch(resolveLocalPath(cleanPath));
        }
        if (res.ok) {
          layout = await res.json();
          await setIDB(cacheKey, layout);
        }
      }

      const pageObj = layout?.pages?.find((p) => p.page === hit.page);
      if (!pageObj?.blocks) return;

      // Restrict word highlights to the passage region if a passage bbox exists
      const passageBox = hit.bboxes?.[0];
      const wordBoxes: BBox[] = [];

      for (const blk of pageObj.blocks) {
        for (const w of blk.words || []) {
          if (!w.w || !w.b) continue;
          if (passageBox) {
            const cy = (w.b[1] + w.b[3]) / 2;
            if (cy < passageBox[1] - 0.03 || cy > passageBox[3] + 0.03) {
              continue;
            }
          }
          const cw = w.w.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!cw) continue;
          if (
            terms.some(
              (q) =>
                cw === q ||
                (q.length >= 4 && cw.startsWith(q)) ||
                (cw.length >= 4 && q.startsWith(cw))
            )
          ) {
            wordBoxes.push(w.b);
          }
        }
      }

      if (wordBoxes.length > 0) {
        setHighlightTarget((prev) =>
          prev && prev.page === hit.page
            ? {
                ...prev,
                bboxes: wordBoxes,
              }
            : prev
        );
      }
    } catch {
      // Passage-level highlight box is already active
    }
  }, []);

  // When a search hit is selected across ANY book
  const handleSelectSearchHit = useCallback(
    (hit: SearchHit) => {
      const targetBook = books.find((b) => b.id === hit.bookId);
      if (!targetBook) return;

      setActiveBook(targetBook);
      setActiveInitialPage(hit.page);
      setHighlightTarget({
        page: hit.page,
        bboxes: hit.bboxes,
        searchQuery: hit.matchedWords.join(' '),
      });
      setIsSearchModalOpen(false);

      if (hit.bboxes.length <= 1) {
        void refineWordHighlightsForHit(targetBook, hit);
      }
    },
    [books, refineWordHighlightsForHit]
  );

  // When opening a book directly from library
  const handleSelectBook = useCallback((book: Book, initialPage: number = 1) => {
    setActiveBook(book);
    setActiveInitialPage(initialPage);
    setHighlightTarget(null);
  }, []);

  const handleBackToLibrary = useCallback(() => {
    setActiveBook(null);
    setHighlightTarget(null);
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-primary text-main transition-colors">
      {/* Global Navbar (Only in Bookshelf view) */}
      {!activeBook && (
        <Navbar
          currentTheme={currentTheme}
          onThemeChange={handleThemeChange}
          onOpenSearch={() => handleOpenSearch()}
          onOpenHFModal={() => setIsHFModalOpen(true)}
          onOpenStudio={() => setIsStudioModalOpen(true)}
          onBackToLibrary={handleBackToLibrary}
          totalBooks={books.length}
          totalIndexed={totalRecords}
        />
      )}

      {/* Main View: Bookshelf vs Reader */}
      {activeBook ? (
        <PDFReader
          key={activeBook.id}
          book={activeBook}
          initialPage={activeInitialPage}
          highlightTarget={highlightTarget}
          currentTheme={currentTheme}
          onThemeChange={handleThemeChange}
          onOpenSearch={handleOpenSearch}
          onBackToLibrary={handleBackToLibrary}
        />
      ) : (
        <Bookshelf
          books={books}
          isLoading={isLibraryLoading}
          onSelectBook={handleSelectBook}
          onOpenSearch={handleOpenSearch}
        />
      )}

      {/* Global Multi-Book Hybrid Search Modal (Cmd+K) */}
      <GlobalSearchModal
        isOpen={isSearchModalOpen}
        onClose={() => setIsSearchModalOpen(false)}
        books={books}
        isSearching={isSearching}
        isIndexLoaded={isIndexLoaded}
        totalRecords={totalRecords}
        groupedResults={groupedResults}
        totalMatches={totalMatches}
        activeQuery={activeQuery}
        vectorStatus={vectorStatus}
        onWarmupVectors={warmupVectorModel}
        onSearch={search}
        onSelectHit={handleSelectSearchHit}
        initialBookFilter={searchBookFilter}
        initialCategoryFilter={searchCategoryFilter}
      />

      {/* 1-Click Book Ingestion, Auto-Tagging, Linearization & Vectorization Studio */}
      <IngestStudioModal
        isOpen={isStudioModalOpen}
        onClose={() => setIsStudioModalOpen(false)}
        onBooksUpdated={refreshLibrary}
        books={books}
      />

      {/* Hugging Face Cloud Storage Settings Modal */}
      <HFConfigModal
        isOpen={isHFModalOpen}
        onClose={() => setIsHFModalOpen(false)}
        onRefreshCatalog={refreshLibrary}
      />
    </div>
  );
}
export default App;
