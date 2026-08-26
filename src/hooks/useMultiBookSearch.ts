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
        const rawGrouped: SearchResultsGrouped[] = grouped || [];
        const enriched = rawGrouped.map((group) => {
          const book = books.find((b) => b.id === group.bookId);
          const cat = book?.category || 'Uncategorized';
          return {
            ...group,
            category: cat,
            coverUrl: book?.coverUrl,
            hits: group.hits.map((h) => ({
              ...h,
              category: cat,
            })),
          };
        });

        setGroupedResults(enriched);
        setTotalMatches(matches || 0);
        setActiveQuery(query || '');
        setIsSearching(false);
      }
    };

    return () => {
      worker.terminate();
    };
  }, [books]);

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
            // 2. Fetch this PDF's own layout JSON (try resolve URL, then local)
            const cleanPath = (book.layoutUrl || `data/layouts/${book.id}.json`).replace(/^\//, '');
            const layoutUrl = resolveAssetUrl(cleanPath);
            const headers = getAuthHeaders();
            let res = await fetch(layoutUrl, { headers });
            if (!res.ok) {
              res = await fetch(`/${cleanPath}`);
            }

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

  const search = useCallback(
    (
      query: string,
      bookIdFilter?: string | string[],
      categoryFilter?: string | string[],
      tagFilter?: string | string[]
    ) => {
      if (!workerRef.current || !query.trim()) {
        setGroupedResults([]);
        setTotalMatches(0);
        setActiveQuery('');
        setIsSearching(false);
        return;
      }

      setIsSearching(true);

      let bookIdsFilter: string[] | undefined = undefined;

      const categoriesArray = Array.isArray(categoryFilter)
        ? categoryFilter.filter((c) => c && c !== 'All')
        : categoryFilter && categoryFilter !== 'All'
        ? [categoryFilter]
        : [];

      const tagsArray = Array.isArray(tagFilter)
        ? tagFilter.filter((t) => t && t !== 'All')
        : tagFilter && tagFilter !== 'All'
        ? [tagFilter]
        : [];

      const bookIdsArray = Array.isArray(bookIdFilter)
        ? bookIdFilter.filter(Boolean)
        : bookIdFilter
        ? [bookIdFilter]
        : [];

      const hasCategoryFilter = categoriesArray.length > 0;
      const hasTagFilter = tagsArray.length > 0;
      const hasBookIdFilter = bookIdsArray.length > 0;

      if (hasCategoryFilter || hasTagFilter || hasBookIdFilter) {
        const matchingBookIds = books
          .filter((b) => {
            if (hasBookIdFilter && !bookIdsArray.includes(b.id)) {
              return false;
            }
            if (hasCategoryFilter) {
              const bookCat = b.category || 'Uncategorized';
              if (!categoriesArray.includes(bookCat)) {
                return false;
              }
            }
            if (hasTagFilter) {
              if (!b.tags || !b.tags.some((t) => tagsArray.includes(t))) {
                return false;
              }
            }
            return true;
          })
          .map((b) => b.id);

        bookIdsFilter = matchingBookIds;
      }

      workerRef.current.postMessage({
        type: 'SEARCH',
        payload: { query, bookIdsFilter, limit: 200 },
      });
    },
    [books]
  );

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

