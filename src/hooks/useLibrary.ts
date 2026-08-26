import { useState, useEffect, useCallback } from 'react';
import { Book } from '../types/book';
import { resolveAssetUrl, getAuthHeaders } from '../services/hfStorage';

export function useLibrary() {
  const [books, setBooks] = useState<Book[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const catalogUrl = resolveAssetUrl('data/catalog.json');
      const headers = getAuthHeaders();
      const res = await fetch(catalogUrl, { headers });

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
