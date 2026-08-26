import MiniSearch from 'minisearch';
import { SearchRecord, SearchHit, SearchResultsGrouped, BBox } from '../types/search';
import { BookLayout } from '../types/layout';

let miniSearch: MiniSearch<SearchRecord> | null = null;
let isIndexLoaded = false;
let indexedBookIds = new Set<string>();
let totalIndexedBlocks = 0;

function createMiniSearchInstance() {
  if (!miniSearch) {
    miniSearch = new MiniSearch<SearchRecord>({
      fields: ['text', 'bookTitle', 'author'],
      storeFields: ['bookId', 'bookTitle', 'author', 'page', 'text', 'words'],
      searchOptions: {
        boost: { bookTitle: 2 },
        prefix: true,
        fuzzy: 0.2,
        combineWith: 'AND',
      },
    });
  }
}

function extractSnippet(text: string, queryWords: string[], maxLength: number = 180): string {
  if (!text) return '';
  const lowerText = text.toLowerCase();
  
  let matchIndex = -1;
  for (const qw of queryWords) {
    if (qw.length < 2) continue;
    const idx = lowerText.indexOf(qw.toLowerCase());
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx;
    }
  }

  if (matchIndex === -1) {
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  }

  const start = Math.max(0, matchIndex - 50);
  const end = Math.min(text.length, matchIndex + maxLength - 50);
  let snippet = text.substring(start, end);
  
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';

  return snippet;
}

function extractBBoxesForQuery(record: SearchRecord, queryWords: string[]): BBox[] {
  if (!record.words || record.words.length === 0) return [];
  const bboxes: BBox[] = [];
  const lowerQueryWords = queryWords.map((q) => q.toLowerCase());

  for (const item of record.words) {
    if (!item.w || !item.b) continue;
    const cleanWord = item.w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!cleanWord) continue;

    for (const qw of lowerQueryWords) {
      if (cleanWord.includes(qw) || qw.includes(cleanWord)) {
        bboxes.push(item.b);
        break;
      }
    }
  }

  return bboxes;
}

// Convert a single BookLayout into searchable records
function bookLayoutToSearchRecords(layout: BookLayout): SearchRecord[] {
  const records: SearchRecord[] = [];
  if (!layout || !layout.pages) return records;

  for (const pageItem of layout.pages) {
    const pageNum = pageItem.page;
    if (!pageItem.blocks) continue;

    for (const block of pageItem.blocks) {
      if (!block.text || block.text.trim().length < 3) continue;

      records.push({
        id: `${layout.bookId}_p${pageNum}_${block.id}`,
        bookId: layout.bookId,
        bookTitle: layout.title,
        author: layout.author || 'Unknown',
        page: pageNum,
        text: block.text,
        words: block.words || [],
      });
    }
  }

  return records;
}

self.onmessage = (e: MessageEvent) => {
  const { type, payload, messageId } = e.data;

  // Add one book's layout JSON to the search index
  if (type === 'INDEX_BOOK_LAYOUT') {
    const { layout } = payload;
    if (!layout || !layout.bookId) return;

    createMiniSearchInstance();
    if (!indexedBookIds.has(layout.bookId)) {
      const records = bookLayoutToSearchRecords(layout);
      if (records.length > 0) {
        miniSearch!.addAll(records);
        totalIndexedBlocks += records.length;
      }
      indexedBookIds.add(layout.bookId);
      isIndexLoaded = true;
    }

    self.postMessage({
      type: 'BOOK_INDEXED',
      bookId: layout.bookId,
      totalBooksIndexed: indexedBookIds.size,
      totalBlocksIndexed: totalIndexedBlocks,
    });
    return;
  }

  // Batch index multiple book layouts
  if (type === 'INDEX_MULTIPLE_LAYOUTS') {
    const { layouts } = payload;
    createMiniSearchInstance();

    for (const layout of layouts) {
      if (!layout || !layout.bookId || indexedBookIds.has(layout.bookId)) continue;
      const records = bookLayoutToSearchRecords(layout);
      if (records.length > 0) {
        miniSearch!.addAll(records);
        totalIndexedBlocks += records.length;
      }
      indexedBookIds.add(layout.bookId);
    }

    isIndexLoaded = true;
    self.postMessage({
      type: 'INIT_DONE',
      messageId,
      totalBooksIndexed: indexedBookIds.size,
      totalBlocksIndexed: totalIndexedBlocks,
    });
    return;
  }

  // Execute multi-book search across all indexed book layouts
  if (type === 'SEARCH') {
    const { query, bookIdFilter, limit = 200 } = payload;

    if (!miniSearch || !isIndexLoaded || !query || query.trim().length === 0) {
      self.postMessage({ type: 'SEARCH_RESULTS', messageId, grouped: [], totalMatches: 0 });
      return;
    }

    const queryTokens = query.trim().split(/\s+/).filter((t: string) => t.length > 1);

    const searchResults = miniSearch.search(query, {
      filter: bookIdFilter ? (result) => result.bookId === bookIdFilter : undefined,
    });

    const hits: SearchHit[] = [];
    const sliced = searchResults.slice(0, limit);

    for (const res of sliced) {
      const bboxes = extractBBoxesForQuery(res as unknown as SearchRecord, queryTokens);
      const snippet = extractSnippet(res.text, queryTokens);

      hits.push({
        id: res.id,
        bookId: res.bookId,
        bookTitle: res.bookTitle,
        author: res.author,
        page: res.page,
        snippet,
        matchedWords: res.match ? Object.keys(res.match) : queryTokens,
        bboxes,
        score: res.score,
      });
    }

    // Group hits by book
    const groupedMap = new Map<string, SearchResultsGrouped>();
    for (const hit of hits) {
      if (!groupedMap.has(hit.bookId)) {
        groupedMap.set(hit.bookId, {
          bookId: hit.bookId,
          bookTitle: hit.bookTitle,
          author: hit.author,
          totalMatches: 0,
          hits: [],
        });
      }
      const group = groupedMap.get(hit.bookId)!;
      group.totalMatches++;
      group.hits.push(hit);
    }

    // Sort hits within each book group ORDERLY by page number (ascending)
    for (const group of groupedMap.values()) {
      group.hits.sort((a, b) => {
        if (a.page !== b.page) {
          return a.page - b.page;
        }
        // If on the same page, sort by top vertical coordinate (y0)
        const aY = a.bboxes?.[0]?.[1] ?? 0;
        const bY = b.bboxes?.[0]?.[1] ?? 0;
        return aY - bY;
      });
    }

    const grouped = Array.from(groupedMap.values());
    self.postMessage({
      type: 'SEARCH_RESULTS',
      messageId,
      grouped,
      totalMatches: hits.length,
      query,
    });
  }
};
