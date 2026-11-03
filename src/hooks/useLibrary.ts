import { useState, useEffect, useCallback } from 'react';
import { Book } from '../types/book';
import {
  getHFConfig,
  resolveAssetUrl,
  resolveLocalPath,
  getAuthHeaders,
} from '../services/hfStorage';

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
      setBooks(data);
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

  return {
    books,
    isLoading,
    error,
    refresh: loadCatalog,
  };
}
