import { useState, useEffect, useRef, useCallback } from 'react';
import {
  SearchResultsGrouped,
  SearchMode,
  VectorModelStatus,
} from '../types/search';
import { Book } from '../types/book';
import { BookLayout } from '../types/layout';
import {
  getHFConfig,
  resolveAssetUrl,
  resolveLocalPath,
  getAuthHeaders,
} from '../services/hfStorage';
import { get as getIDB, set as setIDB } from 'idb-keyval';

const CLOUD_INDEX_IDB_KEY = 'clover_cloud_index_v3';

async function decompressGzipJson(res: Response): Promise<any> {
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const decompressedStream = new Blob([buf]).stream().pipeThrough(ds);
      const text = await new Response(decompressedStream).text();
      return JSON.parse(text);
    }
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function useMultiBookSearch(books: Book[]) {
  const workerRef = useRef<Worker | null>(null);
  const latestMessageIdRef = useRef<number>(0);

  const [isIndexLoaded, setIsIndexLoaded] = useState(false);
  const [indexedBooksCount, setIndexedBooksCount] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [groupedResults, setGroupedResults] = useState<SearchResultsGrouped[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [activeQuery, setActiveQuery] = useState('');
  const [totalRecords, setTotalRecords] = useState(0);
  const [vectorStatus, setVectorStatus] = useState<VectorModelStatus>({
    state: 'idle',
    vectorizedBooks: 0,
    totalVectorChunks: 0,
  });

  const enrichGroupsWithCatalog = useCallback(
    (rawGrouped: SearchResultsGrouped[]): SearchResultsGrouped[] => {
      return (rawGrouped || []).map((group) => {
        const book = books.find((b) => b.id === group.bookId);
        const cat = book?.category || group.category || 'Uncategorized';
        return {
          ...group,
          category: cat,
          coverUrl: book?.coverUrl,
          hits: (group.hits || []).map((h) => ({
            ...h,
            category: cat,
          })),
        };
      });
    },
    [books]
  );

  // Initialize Web Worker
  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/search.worker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const {
        type,
        messageId,
        totalBooksIndexed,
        totalBlocksIndexed,
        grouped,
        totalMatches: matches,
        query,
        status,
      } = e.data;

      if (type === 'INIT_DONE' || type === 'BOOK_INDEXED') {
        setIsIndexLoaded(true);
        if (totalBooksIndexed !== undefined) setIndexedBooksCount(totalBooksIndexed);
        if (totalBlocksIndexed !== undefined) setTotalRecords(totalBlocksIndexed);
      } else if (type === 'VECTOR_STATUS' && status) {
        setVectorStatus((prev) => ({ ...prev, ...status }));
      } else if (type === 'SEARCH_RESULTS') {
        if (messageId !== undefined && messageId < latestMessageIdRef.current) {
          return;
        }
        setGroupedResults(enrichGroupsWithCatalog(grouped || []));
        setTotalMatches(matches || 0);
        setActiveQuery(query || '');
        setIsSearching(false);
      }
    };

    return () => {
      worker.terminate();
    };
  }, [enrichGroupsWithCatalog]);

  // Load Pre-Built Unified Index Bundle (`data/cloud_index/{manifest.json, passages.json.gz, vectors.bin}`)
  // Works online from ANY phone, tablet, or laptop via HF Dataset CDN (and locally when `source === 'local'`)!
  useEffect(() => {
    if (!books || books.length === 0 || !workerRef.current) return;
    let isCancelled = false;

    async function initIndex() {
      const { source } = getHFConfig();
      const headers = getAuthHeaders();

      // 1. Try Unified Pre-Built Index (`data/cloud_index/`) from active storage (HF CDN or Local)
      try {
        const manifestBase =
          source === 'hf'
            ? resolveAssetUrl('data/cloud_index/manifest.json')
            : resolveLocalPath('data/cloud_index/manifest.json');
        const mRes = await fetch(`${manifestBase}?t=${Math.floor(Date.now() / 20000)}`, {
          headers,
        });

        if (mRes.ok) {
          const remoteManifest = await mRes.json();
          const cachedBundle:
            | {
                updatedAt: number;
                booksMeta: any;
                passages: any[];
                vectorsBuffer: ArrayBuffer;
              }
            | undefined = await getIDB(CLOUD_INDEX_IDB_KEY);

          if (
            cachedBundle &&
            cachedBundle.updatedAt === remoteManifest.updatedAt &&
            cachedBundle.passages?.length > 0 &&
            cachedBundle.vectorsBuffer?.byteLength > 12
          ) {
            if (!isCancelled && workerRef.current) {
              const vecCopy = cachedBundle.vectorsBuffer.slice(0);
              workerRef.current.postMessage(
                {
                  type: 'LOAD_CLOUD_INDEX_BUNDLE',
                  payload: {
                    booksMeta: cachedBundle.booksMeta,
                    passages: cachedBundle.passages,
                    vectorsBuffer: vecCopy,
                  },
                },
                [vecCopy]
              );
            }
            return;
          }

          const cb = `?v=${remoteManifest.updatedAt || 1}`;
          const passagesUrl =
            source === 'hf'
              ? `${resolveAssetUrl('data/cloud_index/passages.json.gz')}${cb}`
              : `${resolveLocalPath('data/cloud_index/passages.json.gz')}${cb}`;
          const vecUrl =
            source === 'hf'
              ? `${resolveAssetUrl('data/cloud_index/vectors.bin')}${cb}`
              : `${resolveLocalPath('data/cloud_index/vectors.bin')}${cb}`;

          const [passagesRes, vecRes] = await Promise.all([
            fetch(passagesUrl, { headers }),
            fetch(vecUrl, { headers }),
          ]);

          if (passagesRes.ok && vecRes.ok) {
            const [parsedPassages, vecBuf] = await Promise.all([
              decompressGzipJson(passagesRes),
              vecRes.arrayBuffer(),
            ]);

            if (parsedPassages?.passages && vecBuf.byteLength > 12) {
              await setIDB(CLOUD_INDEX_IDB_KEY, {
                updatedAt: remoteManifest.updatedAt,
                booksMeta: parsedPassages.books || {},
                passages: parsedPassages.passages,
                vectorsBuffer: vecBuf,
              });

              if (!isCancelled && workerRef.current) {
                const vecCopy = vecBuf.slice(0);
                workerRef.current.postMessage(
                  {
                    type: 'LOAD_CLOUD_INDEX_BUNDLE',
                    payload: {
                      booksMeta: parsedPassages.books || {},
                      passages: parsedPassages.passages,
                      vectorsBuffer: vecCopy,
                    },
                  },
                  [vecCopy]
                );
              }
              return;
            }
          }
        }
      } catch (err) {
        console.warn('Unified index fetch warning, checking offline cache:', err);
      }

      // 2. Offline IndexedDB Bundle Fallback
      try {
        const offlineBundle: any = await getIDB(CLOUD_INDEX_IDB_KEY);
        if (
          offlineBundle?.passages?.length > 0 &&
          offlineBundle?.vectorsBuffer &&
          !isCancelled &&
          workerRef.current
        ) {
          const vecCopy = offlineBundle.vectorsBuffer.slice(0);
          workerRef.current.postMessage(
            {
              type: 'LOAD_CLOUD_INDEX_BUNDLE',
              payload: {
                booksMeta: offlineBundle.booksMeta || {},
                passages: offlineBundle.passages,
                vectorsBuffer: vecCopy,
              },
            },
            [vecCopy]
          );
          return;
        }
      } catch {
        // Proceed to local layout fallback
      }

      // 3. Per-book layout fallback (local dev without pre-built index)
      let cursor = 0;
      const concurrency = 3;
      async function loadBookFallback(book: Book) {
        if (isCancelled || !workerRef.current) return;
        try {
          const layoutCacheKey = `layout_${book.id}`;
          let layout: BookLayout | undefined = await getIDB(layoutCacheKey);
          if (!layout) {
            const cleanPath = (book.layoutUrl || `data/layouts/${book.id}.json`).replace(/^\//, '');
            let res = await fetch(resolveLocalPath(cleanPath));
            if (!res.ok) {
              res = await fetch(resolveAssetUrl(cleanPath), { headers });
            }
            if (res.ok) {
              layout = await res.json();
              await setIDB(layoutCacheKey, layout);
            }
          }
          if (layout && !isCancelled && workerRef.current) {
            workerRef.current.postMessage({
              type: 'INDEX_BOOK_LAYOUT',
              payload: { layout },
            });
          }
        } catch {
          // Ignore individual missing layout
        }
      }

      async function workerLoop() {
        while (!isCancelled && cursor < books.length) {
          const idx = cursor++;
          await loadBookFallback(books[idx]);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, books.length) }, workerLoop)
      );
    }

    void initIndex();

    return () => {
      isCancelled = true;
    };
  }, [books]);

  const warmupVectorModel = useCallback((force: boolean = false) => {
    workerRef.current?.postMessage({
      type: 'WARMUP_VECTOR_MODEL',
      payload: { force },
    });
  }, []);

  const search = useCallback(
    (
      query: string,
      bookIdFilter?: string | string[],
      categoryFilter?: string | string[],
      tagFilter?: string | string[],
      mode: SearchMode = 'hybrid'
    ) => {
      if (!query.trim()) {
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

      if (categoriesArray.length > 0 || tagsArray.length > 0 || bookIdsArray.length > 0) {
        bookIdsFilter = books
          .filter((b) => {
            if (bookIdsArray.length > 0 && !bookIdsArray.includes(b.id)) return false;
            if (categoriesArray.length > 0 && !categoriesArray.includes(b.category || 'Uncategorized')) {
              return false;
            }
            if (tagsArray.length > 0 && (!b.tags || !b.tags.some((t) => tagsArray.includes(t)))) {
              return false;
            }
            return true;
          })
          .map((b) => b.id);
      }

      const messageId = ++latestMessageIdRef.current;

      workerRef.current?.postMessage({
        type: 'SEARCH',
        messageId,
        payload: { query, bookIdsFilter, mode, limit: 160 },
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
    warmupVectorModel,
    groupedResults,
    totalMatches,
    activeQuery,
    isIndexLoaded,
    indexedBooksCount,
    isSearching,
    totalRecords,
    vectorStatus,
  };
}
