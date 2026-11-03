const DB_NAME = 'clover_pdf_cache_v1';
const DB_VERSION = 1;
const STORE_CHUNKS = 'chunks';
const STORE_BOOKS = 'books';
const OFFLINE_INDEX_KEY = 'clover_offline_books_v1';

let dbPromise: Promise<IDBDatabase> | null = null;

function openCacheDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        db.createObjectStore(STORE_CHUNKS);
      }
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });

  return dbPromise;
}

export function getOfflineBookIds(): string[] {
  try {
    const raw = localStorage.getItem(OFFLINE_INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setOfflineBookIds(ids: string[]): void {
  try {
    localStorage.setItem(OFFLINE_INDEX_KEY, JSON.stringify(Array.from(new Set(ids))));
  } catch {
    // Ignore storage quota errors on localStorage
  }
}

export function isBookSavedOffline(bookId: string): boolean {
  return getOfflineBookIds().includes(bookId);
}

export async function getOfflineBookBuffer(bookId: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKS, 'readonly');
      const req = tx.objectStore(STORE_BOOKS).get(bookId);
      req.onsuccess = () => {
        const val = req.result;
        resolve(val?.buffer || null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveBookOffline(
  bookId: string,
  url: string,
  headers?: Record<string, string>,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(url, { headers: headers || {}, signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: Failed to download book for offline reading`);
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  let buffer: ArrayBuffer;

  if (res.body && contentLength > 0) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        onProgress?.(Math.min(99, Math.round((received / contentLength) * 100)));
      }
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    buffer = merged.buffer;
  } else {
    buffer = await res.arrayBuffer();
  }

  const db = await openCacheDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    tx.objectStore(STORE_BOOKS).put(
      {
        buffer,
        size: buffer.byteLength,
        savedAt: Date.now(),
      },
      bookId
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  setOfflineBookIds([...getOfflineBookIds(), bookId]);
  onProgress?.(100);
}

export async function removeOfflineBook(bookId: string): Promise<void> {
  const db = await openCacheDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    tx.objectStore(STORE_BOOKS).delete(bookId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  setOfflineBookIds(getOfflineBookIds().filter((id) => id !== bookId));
}

export async function getCachedRangeChunk(
  bookId: string,
  begin: number,
  end: number
): Promise<Uint8Array | null> {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_CHUNKS, 'readonly');
      const req = tx.objectStore(STORE_CHUNKS).get(`chunk:${bookId}:${begin}:${end}`);
      req.onsuccess = () => {
        const res = req.result;
        if (res instanceof Uint8Array) {
          resolve(res);
        } else if (res instanceof ArrayBuffer) {
          resolve(new Uint8Array(res));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedRangeChunk(
  bookId: string,
  begin: number,
  end: number,
  chunk: Uint8Array
): Promise<void> {
  try {
    const db = await openCacheDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_CHUNKS, 'readwrite');
      // Store a clean copy so PDF.js worker ArrayBuffer detachment never corrupts IDB
      tx.objectStore(STORE_CHUNKS).put(chunk.slice(), `chunk:${bookId}:${begin}:${end}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Non-fatal cache write failure
  }
}

export async function getCachedFileLength(bookId: string): Promise<number | null> {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_CHUNKS, 'readonly');
      const req = tx.objectStore(STORE_CHUNKS).get(`meta:${bookId}`);
      req.onsuccess = () => resolve(typeof req.result === 'number' ? req.result : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedFileLength(bookId: string, totalLength: number): Promise<void> {
  try {
    const db = await openCacheDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_CHUNKS, 'readwrite');
      tx.objectStore(STORE_CHUNKS).put(totalLength, `meta:${bookId}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

