import * as pdfjsLib from 'pdfjs-dist';
import {
  getOfflineBookBuffer,
  getCachedRangeChunk,
  setCachedRangeChunk,
  getCachedFileLength,
  setCachedFileLength,
} from './pdfCacheService';
import { resolveLocalPath, resolveAssetUrl, getAuthHeaders } from './hfStorage';

// Configure Mozilla PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export { pdfjsLib };

// High-speed 256 KB range streaming chunks (captures linearized hints + Page 1 in 1 single roundtrip)
export const RANGE_CHUNK_SIZE = 262144;

// Local Character Maps & Standard Fonts (0ms latency, zero third-party jsdelivr roundtrips)
const CMAP_CONFIG = {
  cMapUrl: resolveLocalPath('cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: resolveLocalPath('standard_fonts/'),
};

// In-memory cache for direct Cloudflare/LFS CDN URLs (bypasses Hugging Face HTTP 302 redirects)
const cdnUrlCache = new Map<string, string>();
const prewarmedSet = new Set<string>();

export interface StreamStats {
  mode: 'offline-full' | 'range-stream' | 'direct-memory';
  bytesLoaded: number;
  totalBytes: number;
  cachedChunksHit: number;
  networkChunksFetched: number;
  isLinearizedHeader?: boolean;
}

class CachedRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  private url: string;
  private bookId: string;
  private headers: Record<string, string>;
  private abortController = new AbortController();
  private inFlight = new Map<string, Promise<Uint8Array>>();
  private memCache = new Map<string, Uint8Array>();
  private stats: StreamStats;
  private onStats?: (stats: StreamStats) => void;

  constructor(
    length: number,
    initialData: Uint8Array,
    url: string,
    bookId: string,
    headers: Record<string, string>,
    initialFromCache: boolean,
    isLinearizedHeader: boolean,
    onStats?: (stats: StreamStats) => void
  ) {
    // Pass a sliced copy to super because PDF.js transfers ownership to its Worker
    super(length, initialData.slice());
    this.url = url;
    this.bookId = bookId;
    this.headers = headers;
    this.onStats = onStats;
    this.stats = {
      mode: 'range-stream',
      bytesLoaded: initialData.byteLength,
      totalBytes: length,
      cachedChunksHit: initialFromCache ? 1 : 0,
      networkChunksFetched: initialFromCache ? 0 : 1,
      isLinearizedHeader,
    };
    this.memCache.set(`0:${initialData.byteLength}`, initialData.slice());
    this.emitStats();
  }

  private emitStats() {
    this.onStats?.({ ...this.stats });
  }

  override requestDataRange(begin: number, end: number): void {
    const key = `${begin}:${end}`;

    // 1. Check fast in-memory chunk map
    const memHit = this.memCache.get(key);
    if (memHit) {
      this.stats.cachedChunksHit++;
      this.emitStats();
      this.onDataRange(begin, memHit.slice());
      return;
    }

    // 2. Deduplicate identical concurrent range requests
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.loadRange(begin, end).finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, pending);
    }

    pending
      .then((chunk) => {
        if (!this.abortController.signal.aborted) {
          this.onDataRange(begin, chunk.slice());
        }
      })
      .catch((err) => {
        if (!this.abortController.signal.aborted) {
          console.error(`Range [${begin}-${end}) error:`, err);
        }
      });
  }

  private async loadRange(begin: number, end: number): Promise<Uint8Array> {
    const key = `${begin}:${end}`;

    // 1. Check persistent IndexedDB chunk store (0ms offline page reload!)
    if (this.bookId) {
      const idbHit = await getCachedRangeChunk(this.bookId, begin, end);
      if (idbHit && idbHit.byteLength > 0) {
        this.memCache.set(key, idbHit.slice());
        this.stats.cachedChunksHit++;
        this.stats.bytesLoaded = Math.min(
          this.stats.totalBytes,
          this.stats.bytesLoaded + idbHit.byteLength
        );
        this.emitStats();
        return idbHit;
      }
    }

    // 2. Fetch ONLY this byte slice over HTTP 206 Partial Content
    const inclusiveEnd = Math.max(begin, end - 1);
    const res = await fetch(this.url, {
      headers: {
        ...this.headers,
        Range: `bytes=${begin}-${inclusiveEnd}`,
      },
      signal: this.abortController.signal,
    });

    if (!res.ok && res.status !== 206) {
      throw new Error(`Range request failed: HTTP ${res.status}`);
    }

    const buf = await res.arrayBuffer();
    let chunk = new Uint8Array(buf);

    // Guard in case an upstream static server ignored Range and returned 200 full body
    const expectedLen = end - begin;
    if (res.status === 200 && chunk.byteLength > expectedLen) {
      chunk = chunk.slice(begin, end);
    }

    if (this.memCache.size > 96) {
      const oldestKey = this.memCache.keys().next().value;
      if (oldestKey) this.memCache.delete(oldestKey);
    }
    this.memCache.set(key, chunk.slice());

    if (this.bookId) {
      void setCachedRangeChunk(this.bookId, begin, end, chunk);
    }

    this.stats.networkChunksFetched++;
    this.stats.bytesLoaded = Math.min(
      this.stats.totalBytes,
      this.stats.bytesLoaded + chunk.byteLength
    );
    this.emitStats();

    return chunk;
  }

  override abort(): void {
    this.abortController.abort();
    this.memCache.clear();
    this.inFlight.clear();
  }
}

function detectLinearizedHeader(bytes: Uint8Array): boolean {
  const sampleLen = Math.min(bytes.byteLength, 1024);
  let ascii = '';
  for (let i = 0; i < sampleLen; i++) {
    ascii += String.fromCharCode(bytes[i]);
  }
  return ascii.includes('/Linearized');
}

function parseTotalLengthFromContentRange(headerVal: string | null): number | null {
  if (!headerVal) return null;
  // Format: "bytes 0-131071/6309606"
  const match = headerVal.match(/\/(\d+)\s*$/);
  if (match && match[1]) {
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export interface LoadPDFOptions {
  bookId?: string;
  knownFileSize?: number;
  httpHeaders?: Record<string, string>;
  onStreamStats?: (stats: StreamStats) => void;
}

export async function loadPDFDocument(
  url: string,
  httpHeadersOrOpts?: Record<string, string> | LoadPDFOptions
): Promise<pdfjsLib.PDFDocumentProxy> {
  const opts: LoadPDFOptions =
    httpHeadersOrOpts && ('bookId' in httpHeadersOrOpts || 'onStreamStats' in httpHeadersOrOpts || 'httpHeaders' in httpHeadersOrOpts)
      ? (httpHeadersOrOpts as LoadPDFOptions)
      : { httpHeaders: httpHeadersOrOpts as Record<string, string> | undefined };

  const headers = opts.httpHeaders || {};
  const bookId = opts.bookId || '';

  // 1. Instant 100% Offline Load if user pinned this book offline in IndexedDB
  if (bookId) {
    const offlineBuffer = await getOfflineBookBuffer(bookId);
    if (offlineBuffer && offlineBuffer.byteLength > 0) {
      const bytes = new Uint8Array(offlineBuffer);
      opts.onStreamStats?.({
        mode: 'offline-full',
        bytesLoaded: bytes.byteLength,
        totalBytes: bytes.byteLength,
        cachedChunksHit: 1,
        networkChunksFetched: 0,
        isLinearizedHeader: detectLinearizedHeader(bytes),
      });
      return pdfjsLib.getDocument({
        data: bytes,
        ...CMAP_CONFIG,
      }).promise;
    }
  }

  // 2. Check if initial [0, RANGE_CHUNK_SIZE) chunk + file length are already in IDB (offline partial cache!)
  if (bookId) {
    const cachedTotal = await getCachedFileLength(bookId);
    if (cachedTotal && cachedTotal > 0) {
      const initialEnd = Math.min(RANGE_CHUNK_SIZE, cachedTotal);
      const cachedInitial = await getCachedRangeChunk(bookId, 0, initialEnd);
      if (cachedInitial && cachedInitial.byteLength === initialEnd) {
        const isLin = detectLinearizedHeader(cachedInitial);
        const transportUrl = cdnUrlCache.get(url) || url;
        const transport = new CachedRangeTransport(
          cachedTotal,
          cachedInitial,
          transportUrl,
          bookId,
          headers,
          true,
          isLin,
          opts.onStreamStats
        );
        transport.transportReady();
        return pdfjsLib.getDocument({
          range: transport,
          length: cachedTotal,
          rangeChunkSize: RANGE_CHUNK_SIZE,
          disableAutoFetch: true,
          disableStream: true,
          ...CMAP_CONFIG,
        }).promise;
      }
    }
  }

  // 3. Probe ONLY the first 256 KB via HTTP Range (fetches Linearized header + Page 1!)
  // If we already cached the resolved direct Cloudflare CDN URL, use it directly to bypass 302
  const requestUrl = cdnUrlCache.get(url) || url;
  const probeRes = await fetch(requestUrl, {
    headers: {
      ...headers,
      Range: `bytes=0-${RANGE_CHUNK_SIZE - 1}`,
    },
  });

  if (!probeRes.ok && probeRes.status !== 206) {
    throw new Error(`Failed to fetch PDF (${probeRes.status} ${probeRes.statusText})`);
  }

  // Server supports true HTTP 206 Partial Content
  if (probeRes.status === 206) {
    const initialBytes = new Uint8Array(await probeRes.arrayBuffer());
    const totalLength =
      parseTotalLengthFromContentRange(probeRes.headers.get('content-range')) ||
      opts.knownFileSize ||
      initialBytes.byteLength;

    if (bookId && totalLength > 0) {
      void setCachedFileLength(bookId, totalLength);
      void setCachedRangeChunk(bookId, 0, initialBytes.byteLength, initialBytes);
    }

    // Capture direct Cloudflare/LFS CDN URL to bypass Hugging Face HTTP 302 redirects on all subsequent chunks!
    const directCdnUrl = probeRes.url || requestUrl;
    if (directCdnUrl && directCdnUrl.startsWith('http')) {
      cdnUrlCache.set(url, directCdnUrl);
    }

    const isLin = detectLinearizedHeader(initialBytes);
    const transport = new CachedRangeTransport(
      totalLength,
      initialBytes,
      directCdnUrl,
      bookId,
      headers,
      false,
      isLin,
      opts.onStreamStats
    );
    transport.transportReady();

    return pdfjsLib.getDocument({
      range: transport,
      length: totalLength,
      rangeChunkSize: RANGE_CHUNK_SIZE,
      disableAutoFetch: true,
      disableStream: true,
      ...CMAP_CONFIG,
    }).promise;
  }

  // Fallback if local static server ignores Range and returns 200 OK full PDF
  const fullBytes = new Uint8Array(await probeRes.arrayBuffer());
  opts.onStreamStats?.({
    mode: 'direct-memory',
    bytesLoaded: fullBytes.byteLength,
    totalBytes: fullBytes.byteLength,
    cachedChunksHit: 0,
    networkChunksFetched: 1,
    isLinearizedHeader: detectLinearizedHeader(fullBytes),
  });

  return pdfjsLib.getDocument({
    data: fullBytes,
    ...CMAP_CONFIG,
  }).promise;
}

/**
 * Speculative Background Pre-warming:
 * Pre-fetches the initial 256 KB chunk of a book into IndexedDB during mouse hover or idle time.
 * When the user clicks "Read", Page 1 opens in 0 milliseconds!
 */
export async function prewarmBook(bookId: string, pdfUrlRelative?: string): Promise<void> {
  if (!bookId || prewarmedSet.has(bookId)) return;
  prewarmedSet.add(bookId);

  try {
    // Check if initial chunk already exists in IndexedDB
    const cachedTotal = await getCachedFileLength(bookId);
    if (cachedTotal && cachedTotal > 0) {
      const initialChunk = await getCachedRangeChunk(
        bookId,
        0,
        Math.min(RANGE_CHUNK_SIZE, cachedTotal)
      );
      if (initialChunk && initialChunk.byteLength > 0) return;
    }

    const cleanPath = (pdfUrlRelative || `data/pdfs/${bookId}.pdf`).replace(/^\//, '');
    const url = resolveAssetUrl(cleanPath);
    const headers = getAuthHeaders();
    const requestUrl = cdnUrlCache.get(url) || url;

    const res = await fetch(requestUrl, {
      headers: {
        ...headers,
        Range: `bytes=0-${RANGE_CHUNK_SIZE - 1}`,
      },
    });

    if (res.status === 206) {
      const initialBytes = new Uint8Array(await res.arrayBuffer());
      const totalLength =
        parseTotalLengthFromContentRange(res.headers.get('content-range')) || initialBytes.byteLength;

      if (totalLength > 0) {
        await setCachedFileLength(bookId, totalLength);
        await setCachedRangeChunk(bookId, 0, initialBytes.byteLength, initialBytes);
      }
      if (res.url && res.url.startsWith('http')) {
        cdnUrlCache.set(url, res.url);
      }
    }
  } catch {
    // Non-critical background pre-warm failure is safely swallowed
  }
}

export interface RenderPageResult {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface CancelableRenderTask {
  promise: Promise<RenderPageResult>;
  cancel: () => void;
}

export function renderPDFPageCancelable(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number = 1.2,
  rotation: number = 0
): CancelableRenderTask {
  let activeRenderTask: any = null;
  let isCancelled = false;

  const promise = (async (): Promise<RenderPageResult> => {
    const page = await pdfDoc.getPage(pageNumber);
    if (isCancelled) {
      throw new Error('RenderingCancelledException');
    }

    const viewport = page.getViewport({ scale, rotation });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not get 2D canvas context');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;

    const renderContext = {
      canvasContext: ctx,
      viewport,
      transform,
    };

    activeRenderTask = page.render(renderContext);

    try {
      await activeRenderTask.promise;
    } catch (err: any) {
      if (err?.name === 'RenderingCancelledException' || isCancelled) {
        throw new Error('RenderingCancelledException');
      }
      throw err;
    }

    return {
      width: canvas.width,
      height: canvas.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    };
  })();

  return {
    promise,
    cancel: () => {
      isCancelled = true;
      if (activeRenderTask) {
        try {
          activeRenderTask.cancel();
        } catch {
          // Ignore cancel error
        }
      }
    },
  };
}

interface QueuedRenderJob {
  pageNumber: number;
  priority: number;
  start: () => CancelableRenderTask;
  resolve: (res: RenderPageResult) => void;
  reject: (err: any) => void;
  cancelled: boolean;
  runningTask: CancelableRenderTask | null;
}

/**
 * Priority Render Scheduler:
 * Guarantees `activePage` renders FIRST with 100% of network & canvas bandwidth
 * before any neighbor (+1, -1, +2) pages prefetch in the background.
 */
export class PageRenderScheduler {
  private activePage = 1;
  private activePageRendered = false;
  private queue: QueuedRenderJob[] = [];
  private runningCount = 0;

  setActivePage(page: number, alreadyRendered: boolean = false) {
    this.activePage = page;
    this.activePageRendered = alreadyRendered;
    // Re-score priorities dynamically whenever reader scrolls or jumps
    for (const job of this.queue) {
      job.priority = this.computePriority(job.pageNumber);
    }
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  markPageRendered(page: number) {
    if (page === this.activePage) {
      this.activePageRendered = true;
      this.pump();
    }
  }

  private computePriority(pageNumber: number): number {
    if (pageNumber === this.activePage) return 0; // Immediate top priority
    if (pageNumber === this.activePage + 1) return 1; // Next reading page
    if (pageNumber === this.activePage - 1) return 2; // Previous page
    return 3 + Math.abs(pageNumber - this.activePage);
  }

  schedule(
    pdfDoc: pdfjsLib.PDFDocumentProxy,
    pageNumber: number,
    canvas: HTMLCanvasElement,
    scale: number,
    rotation: number = 0
  ): CancelableRenderTask {
    // Cancel any existing pending job for this exact pageNumber
    for (const existing of this.queue) {
      if (existing.pageNumber === pageNumber) {
        existing.cancelled = true;
        existing.reject(new Error('RenderingCancelledException'));
      }
    }
    this.queue = this.queue.filter((j) => !j.cancelled);

    let jobRef: QueuedRenderJob | null = null;

    const promise = new Promise<RenderPageResult>((resolve, reject) => {
      const job: QueuedRenderJob = {
        pageNumber,
        priority: this.computePriority(pageNumber),
        start: () => renderPDFPageCancelable(pdfDoc, pageNumber, canvas, scale, rotation),
        resolve,
        reject,
        cancelled: false,
        runningTask: null,
      };
      jobRef = job;
      this.queue.push(job);
      this.queue.sort((a, b) => a.priority - b.priority);
    });

    this.pump();

    return {
      promise,
      cancel: () => {
        if (!jobRef) return;
        jobRef.cancelled = true;
        if (jobRef.runningTask) {
          jobRef.runningTask.cancel();
        } else {
          this.queue = this.queue.filter((j) => j !== jobRef);
          jobRef.reject(new Error('RenderingCancelledException'));
        }
      },
    };
  }

  private pump() {
    this.queue = this.queue.filter((j) => !j.cancelled);
    if (this.queue.length === 0) return;

    // While activePage is NOT yet painted and is waiting in queue, dedicate 100% concurrency (1 slot) to it!
    const hasPendingActive = this.queue.some((j) => j.pageNumber === this.activePage);
    const maxConcurrency = hasPendingActive || !this.activePageRendered ? 1 : 2;

    while (this.runningCount < maxConcurrency && this.queue.length > 0) {
      // If activePage isn't rendered yet and the next job isn't activePage, wait if activePage is already running
      const nextJob = this.queue[0];
      if (!this.activePageRendered && nextJob.pageNumber !== this.activePage && this.runningCount > 0) {
        break;
      }

      this.queue.shift();
      if (nextJob.cancelled) continue;

      this.runningCount++;
      const task = nextJob.start();
      nextJob.runningTask = task;

      task.promise
        .then((res) => {
          if (nextJob.pageNumber === this.activePage) {
            this.activePageRendered = true;
          }
          nextJob.resolve(res);
        })
        .catch((err) => {
          nextJob.reject(err);
        })
        .finally(() => {
          this.runningCount = Math.max(0, this.runningCount - 1);
          this.pump();
        });
    }
  }

  destroy() {
    for (const j of this.queue) {
      j.cancelled = true;
      j.runningTask?.cancel();
    }
    this.queue = [];
  }
}
