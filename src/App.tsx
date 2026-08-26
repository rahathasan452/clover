import React, { useState, useEffect, useCallback } from 'react';
import { useLibrary } from './hooks/useLibrary';
import { useMultiBookSearch } from './hooks/useMultiBookSearch';
import { Navbar } from './components/common/Navbar';
import { Bookshelf } from './components/library/Bookshelf';
import { PDFReader } from './components/reader/PDFReader';
import { GlobalSearchModal } from './components/search/GlobalSearchModal';
import { HFConfigModal } from './components/library/HFConfigModal';
import { Book } from './types/book';
import { SearchHit } from './types/search';
import { HighlightTarget, ReaderTheme } from './types/reader';
import { getSavedTheme, saveTheme } from './services/storageService';

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

  // Library & Multi-Book Search Hooks
  const { books, isLoading: isLibraryLoading, refresh: refreshLibrary } = useLibrary();
  const {
    search,
    groupedResults,
    totalMatches,
    activeQuery,
    isIndexLoaded,
    isSearching,
    totalRecords,
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

  // When a search hit is selected across ANY book
  const handleSelectSearchHit = useCallback((hit: SearchHit) => {
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
  }, [books]);

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

      {/* Global Multi-Book Search Modal (Cmd+K) */}
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
        onSearch={search}
        onSelectHit={handleSelectSearchHit}
        initialBookFilter={searchBookFilter}
        initialCategoryFilter={searchCategoryFilter}
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
