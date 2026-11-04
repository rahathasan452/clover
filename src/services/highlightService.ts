export interface UserHighlight {
  id: string;
  bookId: string;
  pageNumber: number;
  text: string;
  color: 'yellow' | 'green' | 'blue' | 'pink';
  createdAt: number;
  rects?: { x: number; y: number; w: number; h: number }[];
}

const STORAGE_PREFIX = 'clover_highlights_';

export function getBookHighlights(bookId: string): UserHighlight[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${bookId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveBookHighlight(highlight: UserHighlight): UserHighlight[] {
  try {
    const existing = getBookHighlights(highlight.bookId);
    const updated = [highlight, ...existing];
    localStorage.setItem(`${STORAGE_PREFIX}${highlight.bookId}`, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

export function removeBookHighlight(bookId: string, highlightId: string): UserHighlight[] {
  try {
    const existing = getBookHighlights(bookId);
    const updated = existing.filter((h) => h.id !== highlightId);
    localStorage.setItem(`${STORAGE_PREFIX}${bookId}`, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

export function removeHighlightsOnPage(
  bookId: string,
  pageNumber: number,
  matchingText?: string
): UserHighlight[] {
  try {
    const existing = getBookHighlights(bookId);
    const updated = existing.filter((h) => {
      if (h.pageNumber !== pageNumber) return true;
      if (
        matchingText &&
        !matchingText.toLowerCase().includes(h.text.toLowerCase()) &&
        !h.text.toLowerCase().includes(matchingText.toLowerCase())
      ) {
        return true;
      }
      return false;
    });
    localStorage.setItem(`${STORAGE_PREFIX}${bookId}`, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

