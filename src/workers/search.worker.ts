import MiniSearch from 'minisearch';
import {
  SearchHit,
  SearchResultsGrouped,
  BBox,
  SearchMode,
  WordBBox,
} from '../types/search';
import { BookLayout } from '../types/layout';

const ARCTIC_MODEL_ID = 'Snowflake/snowflake-arctic-embed-m-v1.5';
const RERANKER_MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';
const MATRYOSHKA_DIM = 256;
const ARCTIC_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'how', 'why',
  'when', 'where', 'who', 'which', 'are', 'was', 'were', 'been', 'have', 'has',
  'had', 'into', 'about', 'than', 'then', 'them', 'they', 'their', 'there',
  'can', 'will', 'would', 'should', 'could', 'your', 'you', 'our', 'out', 'not',
  'does', 'did', 'using', 'used', 'use', 'between', 'during',
]);

interface CompactRecordMeta {
  id: string;
  bookId: string;
  bookTitle: string;
  author: string;
  category?: string;
  page: number;
  section: string;
  text: string;
  passageBBox?: BBox;
  words?: WordBBox[];
}

interface BookVectorShard {
  bookId: string;
  dim: number;
  count: number;
  ids: string[];
  vectors: Int8Array;
}

interface UnifiedCloudVectors {
  dim: number;
  count: number;
  ids: string[];
  bookIds: string[];
  vectors: Int8Array;
}

let miniSearch: MiniSearch<{
  id: string;
  bookId: string;
  bookTitle: string;
  section: string;
  page: number;
  text: string;
}> | null = null;

let isIndexLoaded = false;
const indexedBookIds = new Set<string>();
const recordsById = new Map<string, CompactRecordMeta>();
const vectorShardsByBook = new Map<string, BookVectorShard>();
let unifiedCloudVectors: UnifiedCloudVectors | null = null;
let totalVectorChunks = 0;

// Lazy-loaded Transformers.js ONNX models (cached in browser Cache API)
let extractorPromise: Promise<any> | null = null;
let modelReady = false;

let rerankerPromise: Promise<{ tokenizer: any; model: any }> | null = null;
let rerankerReady = false;

const queryEmbeddingCache = new Map<string, Float32Array>();

function getVectorizedBooksCount(): number {
  if (unifiedCloudVectors && unifiedCloudVectors.count > 0) {
    return indexedBookIds.size;
  }
  return vectorShardsByBook.size;
}

function postModelStatus(
  state: 'idle' | 'loading' | 'ready' | 'error',
  extra: Record<string, any> = {}
) {
  const label = rerankerReady
    ? 'Arctic-Embed-m-v1.5 + MS-MARCO Reranker'
    : 'Snowflake/arctic-embed-m-v1.5';
  self.postMessage({
    type: 'VECTOR_STATUS',
    status: {
      state,
      modelName: label,
      vectorizedBooks: getVectorizedBooksCount(),
      totalVectorChunks,
      ...extra,
    },
  });
}

async function ensureRerankerLoaded(): Promise<{ tokenizer: any; model: any } | null> {
  if (rerankerPromise) return rerankerPromise;
  rerankerPromise = (async () => {
    try {
      const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import(
        '@huggingface/transformers'
      );
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(RERANKER_MODEL_ID),
        AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL_ID, {
          dtype: 'q8',
        }),
      ]);
      rerankerReady = true;
      if (modelReady) {
        postModelStatus('ready', { progress: 100 });
      }
      return { tokenizer, model };
    } catch (err) {
      console.warn('Cross-encoder reranker unavailable, continuing with RRF:', err);
      rerankerPromise = null;
      rerankerReady = false;
      throw err;
    }
  })();

  try {
    return await rerankerPromise;
  } catch {
    return null;
  }
}

async function getQueryEmbedder(): Promise<any> {
  if (extractorPromise) return extractorPromise;

  postModelStatus('loading', { progress: 8 });

  extractorPromise = (async () => {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      const pipe = await pipeline('feature-extraction', ARCTIC_MODEL_ID, {
        dtype: 'q8',
        progress_callback: (info: any) => {
          if (info && typeof info.progress === 'number') {
            postModelStatus('loading', { progress: Math.round(info.progress) });
          }
        },
      });

      modelReady = true;
      postModelStatus('ready', { progress: 100 });
      // Kick off lightweight 23 MB Cross-Encoder Reranker warmup right after Arctic loads
      void ensureRerankerLoaded();
      return pipe;
    } catch (err: any) {
      extractorPromise = null;
      modelReady = false;
      postModelStatus('error', { error: err?.message || 'Failed to load Arctic embedding model' });
      throw err;
    }
  })();

  return extractorPromise;
}

async function embedQueryMatryoshka(query: string, targetDim: number = MATRYOSHKA_DIM): Promise<Float32Array | null> {
  const cacheKey = `${targetDim}:${query.trim().toLowerCase()}`;
  if (!query.trim()) return null;

  const cached = queryEmbeddingCache.get(cacheKey);
  if (cached) return cached;

  try {
    const extractor = await getQueryEmbedder();
    // Important: normalize=false BEFORE slicing 256-d Matryoshka dims, then L2-normalize!
    const output = await extractor(`${ARCTIC_QUERY_PREFIX}${query.trim()}`, {
      pooling: 'cls',
      normalize: false,
    });
    const raw = output.data as Float32Array;
    const dim = Math.min(targetDim, raw.length);
    const vec = new Float32Array(dim);
    let normSq = 0;
    for (let i = 0; i < dim; i++) {
      const v = raw[i];
      vec[i] = v;
      normSq += v * v;
    }
    const invNorm = 1.0 / Math.max(Math.sqrt(normSq), 1e-12);
    for (let i = 0; i < dim; i++) {
      vec[i] *= invNorm;
    }

    if (queryEmbeddingCache.size > 80) {
      const oldest = queryEmbeddingCache.keys().next().value;
      if (oldest) queryEmbeddingCache.delete(oldest);
    }
    queryEmbeddingCache.set(cacheKey, vec);
    return vec;
  } catch (err) {
    console.warn('Semantic query embedding unavailable, falling back to BM25:', err);
    return null;
  }
}

async function scoreCrossEncoderPairs(
  query: string,
  candidates: Array<{ rec: CompactRecordMeta }>
): Promise<Float32Array | null> {
  if (!rerankerReady || candidates.length === 0) return null;
  try {
    const bundle = await ensureRerankerLoaded();
    if (!bundle) return null;
    const { tokenizer, model } = bundle;

    const queries = candidates.map(() => query);
    const passages = candidates.map(({ rec }) =>
      rec.section ? `${rec.bookTitle} (${rec.section}): ${rec.text}` : `${rec.bookTitle}: ${rec.text}`
    );

    const inputs = tokenizer(queries, {
      text_pair: passages,
      padding: true,
      truncation: true,
      max_length: 360,
    });
    const out = await model(inputs);
    const logits = out.logits.data as Float32Array;
    const probs = new Float32Array(candidates.length);
    for (let i = 0; i < candidates.length; i++) {
      const x = Math.max(-20, Math.min(20, logits[i] ?? 0));
      probs[i] = 1.0 / (1.0 + Math.exp(-x));
    }
    return probs;
  } catch (err) {
    console.warn('Cross-encoder scoring error:', err);
    return null;
  }
}

function createMiniSearchInstance() {
  if (!miniSearch) {
    miniSearch = new MiniSearch({
      fields: ['section', 'text', 'bookTitle'],
      storeFields: ['bookId', 'page'],
      tokenize: (str) => str.toLowerCase().split(/[^a-z0-9_.$%+-]+/).filter(Boolean),
      searchOptions: {
        boost: { section: 2.8, text: 2.0, bookTitle: 1.3 },
        prefix: true,
        fuzzy: 0.16,
        combineWith: 'OR',
      },
    });
  }
}

function parsePerBookVectorShard(bookId: string, buffer: ArrayBuffer): BookVectorShard | null {
  if (!buffer || buffer.byteLength < 12) return null;
  const view = new DataView(buffer);
  if (
    view.getUint8(0) !== 0x43 ||
    view.getUint8(1) !== 0x4c ||
    view.getUint8(2) !== 0x56 ||
    view.getUint8(3) !== 0x52
  ) {
    return null;
  }
  const headerLen = view.getUint32(4, true);
  const vecOffset = 8 + headerLen;
  if (vecOffset > buffer.byteLength) return null;

  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLen)));
  const dim = Number(meta.dim || 256);
  const ids: string[] = Array.isArray(meta.ids) ? meta.ids : [];
  const count = ids.length;
  if (count === 0 || vecOffset + count * dim > buffer.byteLength) return null;

  return {
    bookId,
    dim,
    count,
    ids,
    vectors: new Int8Array(buffer, vecOffset, count * dim),
  };
}

function extractSnippet(
  text: string,
  section: string,
  queryWords: string[],
  maxLength: number = 250
): string {
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

  let excerpt = '';
  if (matchIndex === -1) {
    excerpt = text.length > maxLength ? text.substring(0, maxLength).trimEnd() + '…' : text;
  } else {
    const start = Math.max(0, matchIndex - 65);
    const end = Math.min(text.length, matchIndex + maxLength - 65);
    excerpt = text.substring(start, end).trim();
    if (start > 0) excerpt = '…' + excerpt;
    if (end < text.length) excerpt = excerpt + '…';
  }

  return section ? `§ ${section} — ${excerpt}` : excerpt;
}

function extractBBoxesForQuery(
  record: CompactRecordMeta,
  queryWords: string[],
  fallbackToPassageBox: boolean
): BBox[] {
  if (record.words && record.words.length > 0) {
    const bboxes: BBox[] = [];
    const meaningfulQueryWords = queryWords
      .map((q) => q.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter((q) => q.length >= 2 && !STOPWORDS.has(q));

    for (const item of record.words) {
      if (!item.w || !item.b) continue;
      const cleanWord = item.w.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!cleanWord || cleanWord.length < 2) continue;

      for (const qw of meaningfulQueryWords) {
        if (
          cleanWord === qw ||
          (qw.length >= 4 && cleanWord.startsWith(qw)) ||
          (cleanWord.length >= 4 && qw.startsWith(cleanWord))
        ) {
          bboxes.push(item.b);
          break;
        }
      }
    }
    if (bboxes.length > 0) return bboxes;

    if (fallbackToPassageBox) {
      let minX = 1, minY = 1, maxX = 0, maxY = 0, valid = false;
      for (const w of record.words) {
        if (!w.b) continue;
        valid = true;
        if (w.b[0] < minX) minX = w.b[0];
        if (w.b[1] < minY) minY = w.b[1];
        if (w.b[2] > maxX) maxX = w.b[2];
        if (w.b[3] > maxY) maxY = w.b[3];
      }
      if (valid) return [[minX, minY, maxX, maxY]];
    }
  }

  if (record.passageBBox) {
    return [record.passageBBox];
  }

  return [];
}

function loadUnifiedCloudBundle(
  booksMeta: Record<string, { t: string; a: string; c?: string }>,
  passages: Array<{
    i: string;
    b: string;
    p: number;
    s?: string;
    t: string;
    bb?: [number, number, number, number];
  }>,
  vectorsBuffer: ArrayBuffer
) {
  // Reset cleanly
  miniSearch = null;
  createMiniSearchInstance();
  recordsById.clear();
  indexedBookIds.clear();
  vectorShardsByBook.clear();
  unifiedCloudVectors = null;
  totalVectorChunks = 0;

  const docsToAdd: Array<{
    id: string;
    bookId: string;
    bookTitle: string;
    section: string;
    page: number;
    text: string;
  }> = [];

  const rowIds: string[] = new Array(passages.length);
  const rowBookIds: string[] = new Array(passages.length);

  for (let idx = 0; idx < passages.length; idx++) {
    const p = passages[idx];
    const bMeta = booksMeta[p.b] || { t: p.b, a: 'Unknown Author', c: 'Uncategorized' };
    const section = p.s || '';

    const rec: CompactRecordMeta = {
      id: p.i,
      bookId: p.b,
      bookTitle: bMeta.t,
      author: bMeta.a,
      category: bMeta.c,
      page: p.p,
      section,
      text: p.t,
      passageBBox: p.bb,
    };

    recordsById.set(p.i, rec);
    indexedBookIds.add(p.b);
    rowIds[idx] = p.i;
    rowBookIds[idx] = p.b;

    docsToAdd.push({
      id: p.i,
      bookId: p.b,
      bookTitle: bMeta.t,
      section,
      page: p.p,
      text: p.t,
    });
  }

  if (docsToAdd.length > 0) {
    miniSearch!.addAll(docsToAdd);
  }

  if (vectorsBuffer && vectorsBuffer.byteLength >= 12) {
    const view = new DataView(vectorsBuffer);
    if (
      view.getUint8(0) === 0x43 &&
      view.getUint8(1) === 0x4c &&
      view.getUint8(2) === 0x56 &&
      view.getUint8(3) === 0x52
    ) {
      const hLen = view.getUint32(4, true);
      const vOffset = 8 + hLen;
      const meta = JSON.parse(
        new TextDecoder().decode(new Uint8Array(vectorsBuffer, 8, hLen))
      );
      const dim = Number(meta.dim || MATRYOSHKA_DIM);
      const count = Number(meta.count || passages.length);
      if (count === passages.length && vOffset + count * dim <= vectorsBuffer.byteLength) {
        unifiedCloudVectors = {
          dim,
          count,
          ids: rowIds,
          bookIds: rowBookIds,
          vectors: new Int8Array(vectorsBuffer, vOffset, count * dim),
        };
        totalVectorChunks = count;
      }
    }
  }

  isIndexLoaded = true;
}

function indexBookLayoutInternal(layout: BookLayout): number {
  if (!layout || !layout.pages || indexedBookIds.has(layout.bookId)) return 0;
  createMiniSearchInstance();

  const docsToAdd: Array<{
    id: string;
    bookId: string;
    bookTitle: string;
    section: string;
    page: number;
    text: string;
  }> = [];

  for (const pageItem of layout.pages) {
    const pageNum = pageItem.page;
    if (!pageItem.blocks) continue;

    for (const block of pageItem.blocks) {
      if (!block.text || block.text.trim().length < 3) continue;
      const id = `${layout.bookId}_p${pageNum}_${block.id}`;

      const meta: CompactRecordMeta = {
        id,
        bookId: layout.bookId,
        bookTitle: layout.title,
        author: layout.author || 'Unknown',
        page: pageNum,
        section: '',
        text: block.text,
        words: block.words || [],
      };
      recordsById.set(id, meta);

      docsToAdd.push({
        id,
        bookId: meta.bookId,
        bookTitle: meta.bookTitle,
        section: '',
        page: meta.page,
        text: meta.text,
      });
    }
  }

  if (docsToAdd.length > 0) {
    miniSearch!.addAll(docsToAdd);
  }
  indexedBookIds.add(layout.bookId);
  isIndexLoaded = true;
  return docsToAdd.length;
}

function searchDenseVectors(
  queryVec: Float32Array,
  allowedBooks: Set<string> | null,
  topK: number = 250,
  minCosine: number = 0.34
): Array<{ id: string; cosine: number }> {
  const candidates: Array<{ id: string; cosine: number }> = [];

  if (unifiedCloudVectors && unifiedCloudVectors.dim === queryVec.length) {
    const { dim, count, ids, bookIds, vectors } = unifiedCloudVectors;
    const limit4 = dim - 3;

    for (let i = 0; i < count; i++) {
      if (allowedBooks && !allowedBooks.has(bookIds[i])) continue;
      const base = i * dim;
      let dot = 0;
      let d = 0;
      for (; d < limit4; d += 4) {
        dot +=
          queryVec[d] * vectors[base + d] +
          queryVec[d + 1] * vectors[base + d + 1] +
          queryVec[d + 2] * vectors[base + d + 2] +
          queryVec[d + 3] * vectors[base + d + 3];
      }
      for (; d < dim; d++) {
        dot += queryVec[d] * vectors[base + d];
      }

      const cosine = dot / 127.0;
      if (cosine >= minCosine) {
        candidates.push({ id: ids[i], cosine });
      }
    }
  } else {
    for (const [bookId, shard] of vectorShardsByBook.entries()) {
      if (allowedBooks && !allowedBooks.has(bookId)) continue;
      const { dim, count, ids, vectors } = shard;
      if (dim !== queryVec.length) continue;
      const limit4 = dim - 3;

      for (let i = 0; i < count; i++) {
        const base = i * dim;
        let dot = 0;
        let d = 0;
        for (; d < limit4; d += 4) {
          dot +=
            queryVec[d] * vectors[base + d] +
            queryVec[d + 1] * vectors[base + d + 1] +
            queryVec[d + 2] * vectors[base + d + 2] +
            queryVec[d + 3] * vectors[base + d + 3];
        }
        for (; d < dim; d++) {
          dot += queryVec[d] * vectors[base + d];
        }
        const cosine = dot / 127.0;
        if (cosine >= minCosine) {
          candidates.push({ id: ids[i], cosine });
        }
      }
    }
  }

  candidates.sort((a, b) => b.cosine - a.cosine);
  return candidates.slice(0, topK);
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, messageId } = e.data;

  if (type === 'WARMUP_VECTOR_MODEL') {
    if (totalVectorChunks > 0 || payload?.force) {
      void getQueryEmbedder().catch(() => {});
    } else {
      postModelStatus(modelReady ? 'ready' : 'idle');
    }
    return;
  }

  if (type === 'LOAD_CLOUD_INDEX_BUNDLE') {
    const { booksMeta, passages, vectorsBuffer } = payload;
    loadUnifiedCloudBundle(booksMeta || {}, passages || [], vectorsBuffer);
    self.postMessage({
      type: 'INIT_DONE',
      totalBooksIndexed: indexedBookIds.size,
      totalBlocksIndexed: recordsById.size,
    });
    postModelStatus(modelReady ? 'ready' : 'idle');
    return;
  }

  if (type === 'INDEX_BOOK_LAYOUT') {
    const { layout } = payload;
    if (!layout || !layout.bookId) return;
    indexBookLayoutInternal(layout);
    self.postMessage({
      type: 'BOOK_INDEXED',
      bookId: layout.bookId,
      totalBooksIndexed: indexedBookIds.size,
      totalBlocksIndexed: recordsById.size,
    });
    return;
  }

  if (type === 'INDEX_BOOK_VECTORS') {
    const { bookId, buffer } = payload;
    if (!bookId || !buffer || vectorShardsByBook.has(bookId)) return;
    const shard = parsePerBookVectorShard(bookId, buffer);
    if (shard) {
      vectorShardsByBook.set(bookId, shard);
      totalVectorChunks += shard.count;
      postModelStatus(modelReady ? 'ready' : 'idle');
    }
    return;
  }

  if (type === 'SEARCH') {
    const {
      query,
      bookIdFilter,
      bookIdsFilter,
      mode = 'hybrid' as SearchMode,
      limit = 160,
    } = payload;

    if (!isIndexLoaded || !query || query.trim().length === 0) {
      self.postMessage({ type: 'SEARCH_RESULTS', messageId, grouped: [], totalMatches: 0 });
      return;
    }

    let allowedBooks: Set<string> | null = null;
    if (bookIdFilter) {
      allowedBooks = new Set([bookIdFilter]);
    } else if (bookIdsFilter && Array.isArray(bookIdsFilter)) {
      if (bookIdsFilter.length === 0) {
        self.postMessage({ type: 'SEARCH_RESULTS', messageId, grouped: [], totalMatches: 0, query });
        return;
      }
      allowedBooks = new Set(bookIdsFilter);
    }

    const cleanQuery = query.trim();
    const lowerQuery = cleanQuery.toLowerCase();
    const rawTokens = cleanQuery.split(/\s+/).filter((t: string) => t.length > 1);
    const nonStopTokens = rawTokens.filter((t: string) => !STOPWORDS.has(t.toLowerCase()));
    const effectiveTokens = nonStopTokens.length > 0 ? nonStopTokens : rawTokens;

    // 1. Lexical BM25 Ranking (MiniSearch over contextual passages + TOC chapter breadcrumbs)
    const lexicalRanks = new Map<string, { rank: number; score: number; matchedTerms: string[] }>();
    if (mode !== 'semantic' && miniSearch) {
      const filterFn = allowedBooks
        ? (res: any) => allowedBooks!.has(res.bookId)
        : undefined;

      const bm25Query = effectiveTokens.join(' ') || cleanQuery;
      const lexResults = miniSearch.search(bm25Query, {
        filter: filterFn,
        combineWith: effectiveTokens.length <= 2 ? 'AND' : 'OR',
      });

      const maxLex = Math.min(lexResults.length, 250);
      for (let i = 0; i < maxLex; i++) {
        const r = lexResults[i];
        lexicalRanks.set(r.id, {
          rank: i + 1,
          score: r.score,
          matchedTerms: r.match ? Object.keys(r.match) : effectiveTokens,
        });
      }
    }

    // 2. Dense Semantic Vector Search (Snowflake Arctic-Embed-m-v1.5 256-d Matryoshka Int8)
    const semanticRanks = new Map<string, { rank: number; cosine: number }>();
    const activeDim =
      unifiedCloudVectors?.dim ||
      (vectorShardsByBook.size > 0
        ? Array.from(vectorShardsByBook.values())[0].dim
        : MATRYOSHKA_DIM);
    const hasVectorsForScope =
      (unifiedCloudVectors !== null && unifiedCloudVectors.count > 0) ||
      (vectorShardsByBook.size > 0 &&
        (!allowedBooks || Array.from(allowedBooks).some((id) => vectorShardsByBook.has(id))));

    if ((mode === 'hybrid' || mode === 'semantic') && hasVectorsForScope) {
      const qVec = await embedQueryMatryoshka(cleanQuery, activeDim);
      if (qVec) {
        const minCos = mode === 'semantic' ? 0.30 : 0.34;
        const vecHits = searchDenseVectors(qVec, allowedBooks, 250, minCos);
        for (let i = 0; i < vecHits.length; i++) {
          semanticRanks.set(vecHits[i].id, {
            rank: i + 1,
            cosine: vecHits[i].cosine,
          });
        }
      }
    }

    // 3. Reciprocal Rank Fusion (RRF, k = 60) + Exact Phrase Bonus
    const RRF_K = 60;
    const candidateIds = new Set<string>([
      ...lexicalRanks.keys(),
      ...semanticRanks.keys(),
    ]);

    interface CandidateEntry {
      rec: CompactRecordMeta;
      lex?: { rank: number; score: number; matchedTerms: string[] };
      sem?: { rank: number; cosine: number };
      rrfScore: number;
      exactBonus: number;
      finalScore: number;
      matchSource: 'hybrid' | 'semantic' | 'keyword';
    }

    const candidates: CandidateEntry[] = [];

    for (const id of candidateIds) {
      const rec = recordsById.get(id);
      if (!rec) continue;
      if (allowedBooks && !allowedBooks.has(rec.bookId)) continue;

      const lex = lexicalRanks.get(id);
      const sem = semanticRanks.get(id);

      let rrfScore = 0;
      let exactBonus = 0;
      let matchSource: 'hybrid' | 'semantic' | 'keyword' = 'keyword';

      if (mode === 'keyword' || !hasVectorsForScope) {
        if (!lex) continue;
        rrfScore = lex.score;
        matchSource = 'keyword';
      } else if (mode === 'semantic') {
        if (!sem) continue;
        rrfScore = sem.cosine;
        matchSource = 'semantic';
      } else {
        const rrfLex = lex ? 1.0 / (RRF_K + lex.rank) : 0;
        const rrfSem = sem ? 1.18 / (RRF_K + sem.rank) : 0;
        exactBonus =
          lowerQuery.length >= 4 && rec.text.toLowerCase().includes(lowerQuery) ? 0.014 : 0;
        rrfScore = rrfLex + rrfSem + exactBonus;
        if (lex && sem) matchSource = 'hybrid';
        else if (sem) matchSource = 'semantic';
        else matchSource = 'keyword';
      }

      candidates.push({
        rec,
        lex,
        sem,
        rrfScore,
        exactBonus,
        finalScore: rrfScore,
        matchSource,
      });
    }

    candidates.sort((a, b) => b.rrfScore - a.rrfScore);

    // 4. Neural Cross-Encoder Reranking (`ms-marco-MiniLM-L-6-v2`) on Top 16 RRF Candidates
    if (
      (mode === 'hybrid' || mode === 'semantic') &&
      rerankerReady &&
      candidates.length > 1
    ) {
      const rerankK = Math.min(16, candidates.length);
      const topPool = candidates.slice(0, rerankK);
      const ceProbs = await scoreCrossEncoderPairs(cleanQuery, topPool);
      if (ceProbs) {
        const maxRrf = Math.max(topPool[0].rrfScore, 1e-6);
        for (let i = 0; i < rerankK; i++) {
          const rrfNorm = topPool[i].rrfScore / maxRrf;
          topPool[i].finalScore =
            (0.70 * ceProbs[i] + 0.30 * rrfNorm + (topPool[i].exactBonus > 0 ? 0.06 : 0)) * 100;
        }
        topPool.sort((a, b) => b.finalScore - a.finalScore);
        const floorScore = topPool[topPool.length - 1]?.finalScore ?? 20;

        for (let j = rerankK; j < candidates.length; j++) {
          candidates[j].finalScore = Math.max(1, floorScore * 0.85 - (j - rerankK) * 0.15);
        }
        candidates.splice(0, rerankK, ...topPool);
      }
    } else if (mode === 'hybrid') {
      for (const c of candidates) {
        c.finalScore = c.rrfScore * 1000;
      }
    } else if (mode === 'semantic') {
      for (const c of candidates) {
        c.finalScore = c.rrfScore * 100;
      }
    }

    const sliced = candidates.slice(0, limit);
    const fusedHits: SearchHit[] = sliced.map((c) => {
      const bboxes = extractBBoxesForQuery(
        c.rec,
        effectiveTokens,
        c.matchSource === 'semantic' || c.matchSource === 'hybrid'
      );
      const snippet = extractSnippet(c.rec.text, c.rec.section, effectiveTokens);

      return {
        id: c.rec.id,
        bookId: c.rec.bookId,
        bookTitle: c.rec.bookTitle,
        author: c.rec.author,
        category: c.rec.category,
        page: c.rec.page,
        snippet,
        matchedWords: c.lex?.matchedTerms || effectiveTokens,
        bboxes,
        score: Number(c.finalScore.toFixed(3)),
        semanticScore: c.sem ? Math.round(c.sem.cosine * 100) : undefined,
        lexicalScore: c.lex ? Number(c.lex.score.toFixed(1)) : undefined,
        matchSource: c.matchSource,
      };
    });

    const groupedMap = new Map<string, SearchResultsGrouped>();
    for (const hit of fusedHits) {
      if (!groupedMap.has(hit.bookId)) {
        groupedMap.set(hit.bookId, {
          bookId: hit.bookId,
          bookTitle: hit.bookTitle,
          author: hit.author,
          category: hit.category,
          totalMatches: 0,
          bestScore: hit.score,
          hits: [],
        });
      }
      const group = groupedMap.get(hit.bookId)!;
      group.totalMatches++;
      if ((group.bestScore ?? 0) < hit.score) {
        group.bestScore = hit.score;
      }
      group.hits.push(hit);
    }

    const grouped = Array.from(groupedMap.values()).sort(
      (a, b) => (b.bestScore ?? 0) - (a.bestScore ?? 0)
    );

    self.postMessage({
      type: 'SEARCH_RESULTS',
      messageId,
      grouped,
      totalMatches: fusedHits.length,
      query,
      mode,
    });
  }
};
