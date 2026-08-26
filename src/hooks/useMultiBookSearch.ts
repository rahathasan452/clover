import { useState, useEffect, useRef, useCallback } from 'react';
import { SearchResultsGrouped } from '../types/search';
import { Book } from '../types/book';
import { BookLayout } from '../types/layout';
import { resolveAssetUrl, getAuthHeaders } from '../services/hfStorage';
import { get as getIDB, set as setIDB } from 'idb-keyval';

export function useMultiBookSearch(books: Book[]) {
  const workerRef = useRef<Worker | null>(null);
  const [isIndexLoaded, setIsIndexLoaded] = useState(false);
  const [indexedBooksCount, setIndexedBooksCount] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [groupedResults, setGroupedResults] = useState<SearchResultsGrouped[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [activeQuery, setActiveQuery] = useState('');
  const [totalRecords, setTotalRecords] = useState(0);

  // Initialize Worker
  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/search.worker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const {
        type,
        totalBooksIndexed,
        totalBlocksIndexed,
        grouped,
        totalMatches: matches,
        query,
      } = e.data;

      if (type === 'INIT_DONE' || type === 'BOOK_INDEXED') {
        setIsIndexLoaded(true);
        if (totalBooksIndexed !== undefined) setIndexedBooksCount(totalBooksIndexed);
        if (totalBlocksIndexed !== undefined) setTotalRecords(totalBlocksIndexed);
      } else if (type === 'SEARCH_RESULTS') {
        setGroupedResults(grouped || []);
        setTotalMatches(matches || 0);
        setActiveQuery(query || '');
        setIsSearching(false);
      }
    };

    return () => {
      worker.terminate();
    };
  }, []);

  // Fetch & Index Each PDF's Dedicated Companion Layout JSON
  useEffect(() => {
    if (!books || books.length === 0 || !workerRef.current) return;

    let isCancelled = false;

    async function loadIndividualBookLayouts() {
      for (const book of books) {
        if (isCancelled) break;
        try {
          const cacheKey = `layout_${book.id}`;
          // 1. Try local IndexedDB cache first
          let layout: BookLayout | undefined = await getIDB(cacheKey);

          if (!layout) {
            // 2. Fetch this PDF's own layout JSON
            const layoutUrl = resolveAssetUrl(book.layoutUrl || `data/layouts/${book.id}.json`);
            const headers = getAuthHeaders();
            const res = await fetch(layoutUrl, { headers });

            if (res.ok) {
              layout = await res.json();
              // Cache in IndexedDB for instant future loads
              await setIDB(cacheKey, layout);
            }
          }

          if (layout && workerRef.current) {
            workerRef.current.postMessage({
              type: 'INDEX_BOOK_LAYOUT',
              payload: { layout },
            });
          }
        } catch (err) {
          console.error(`Failed to load layout JSON for book ${book.id}:`, err);
        }
      }
    }

    loadIndividualBookLayouts();

    return () => {
      isCancelled = true;
    };
  }, [books]);

  const search = useCallback((query: string, bookIdFilter?: string) => {
    if (!workerRef.current || !query.trim()) {
      setGroupedResults([]);
      setTotalMatches(0);
      setActiveQuery('');
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    workerRef.current.postMessage({
      type: 'SEARCH',
      payload: { query, bookIdFilter, limit: 100 },
    });
  }, []);

  const clearSearch = useCallback(() => {
    setGroupedResults([]);
    setTotalMatches(0);
    setActiveQuery('');
    setIsSearching(false);
  }, []);

  return {
    search,
    clearSearch,
    groupedResults,
    totalMatches,
    activeQuery,
    isIndexLoaded,
    indexedBooksCount,
    isSearching,
    totalRecords,
  };
}
