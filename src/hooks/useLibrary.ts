import { useState, useEffect, useCallback } from 'react';
import { Book } from '../types/book';
import {
  getHFConfig,
  resolveAssetUrl,
  resolveLocalPath,
  getAuthHeaders,
} from '../services/hfStorage';
import {
  getBookMetadataOverrides,
  saveBookMetadataOverride,
} from '../services/storageService';

const STUDIO_PORT = 8088;
const LOCAL_STUDIO_API =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? '/api/studio'
    : `http://127.0.0.1:${STUDIO_PORT}/api/studio`;

export function useLibrary() {
  const [books, setBooks] = useState<Book[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { source, hfRepo } = getHFConfig();
      let res: Response | null = null;

      if (source === 'hf' && hfRepo) {
        // Fetch live catalog directly from Hugging Face Dataset CDN first (cache-busted so newly uploaded books appear immediately on any device!)
        try {
          const catalogUrl = `${resolveAssetUrl('data/catalog.json')}?t=${Math.floor(Date.now() / 15000)}`;
          res = await fetch(catalogUrl, { headers: getAuthHeaders() });
        } catch {
          res = null;
        }
      }

      if (!res || !res.ok) {
        // Local / offline static fallback respecting Vite BASE_URL
        res = await fetch(resolveLocalPath('data/catalog.json'));
      }

      if (!res.ok) {
        throw new Error(`Failed to load catalog: HTTP ${res.status} ${res.statusText}`);
      }

      const data: Book[] = await res.json();
      const overrides = getBookMetadataOverrides();
      const merged = data.map((b) => (overrides[b.id] ? { ...b, ...overrides[b.id] } : b));
      setBooks(merged);
    } catch (err: any) {
      console.error('Catalog load error:', err);
      setError(err.message || 'Failed to load library catalog');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const updateBook = useCallback(
    async (
      bookId: string,
      updates: {
        title: string;
        author: string;
        category: string;
        tags: string[];
        description?: string;
      }
    ): Promise<{ success: boolean; syncedToDisk: boolean; syncedToHf: boolean }> => {
      // 1. Immediately update in-memory state for 0ms fluid feedback
      setBooks((prev) =>
        prev.map((b) => (b.id === bookId ? { ...b, ...updates } : b))
      );

      // 2. Persist to local browser storage so offline & GitHub Pages retain it
      saveBookMetadataOverride(bookId, updates);

      let syncedToDisk = false;
      let syncedToHf = false;

      // 3. If local Studio Server is available, save directly to catalog.json on disk & HF
      try {
        const { hfRepo, hfToken } = getHFConfig();
        const res = await fetch(`${LOCAL_STUDIO_API}/book/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: bookId,
            title: updates.title,
            author: updates.author,
            category: updates.category,
            tags: updates.tags,
            description: updates.description,
            uploadToHf: true,
            hfRepo: hfRepo || undefined,
            hfToken: hfToken || undefined,
          }),
        });
        if (res.ok) {
          const result = await res.json();
          syncedToDisk = true;
          syncedToHf = Boolean(result.syncedToHf);
        }
      } catch {
        // Studio server not running locally; browser local override is saved
      }

      return { success: true, syncedToDisk, syncedToHf };
    },
    []
  );

  return {
    books,
    isLoading,
    error,
    refresh: loadCatalog,
    updateBook,
  };
}
