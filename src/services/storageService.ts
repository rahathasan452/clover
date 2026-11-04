import { ReadingProgress, Bookmark, ReaderTheme, ViewMode } from '../types/reader';

const PROGRESS_PREFIX = 'clover_progress_';
const BOOKMARKS_PREFIX = 'clover_bookmarks_';
const THEME_KEY = 'clover_theme';
const VIEW_MODE_KEY = 'clover_view_mode';

export function getSavedTheme(): ReaderTheme {
  return (localStorage.getItem(THEME_KEY) as ReaderTheme) || 'dark';
}

export function saveTheme(theme: ReaderTheme): void {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);
}

export function getSavedViewMode(): ViewMode {
  return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || 'continuous';
}

export function saveViewMode(mode: ViewMode): void {
  localStorage.setItem(VIEW_MODE_KEY, mode);
}

export function getReadingProgress(bookId: string): ReadingProgress | null {
  try {
    const raw = localStorage.getItem(`${PROGRESS_PREFIX}${bookId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveReadingProgress(bookId: string, currentPage: number, totalPages: number): void {
  try {
    const progress: ReadingProgress = {
      bookId,
      currentPage,
      totalPages,
      lastReadTimestamp: Date.now(),
      percent: Math.min(100, Math.round((currentPage / totalPages) * 100)),
    };
    localStorage.setItem(`${PROGRESS_PREFIX}${bookId}`, JSON.stringify(progress));
  } catch (e) {
    console.error('Failed to save reading progress', e);
  }
}

export function getAllBookmarks(bookId: string): Bookmark[] {
  try {
    const raw = localStorage.getItem(`${BOOKMARKS_PREFIX}${bookId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function toggleBookmark(bookId: string, page: number, title?: string): boolean {
  try {
    const bookmarks = getAllBookmarks(bookId);
    const existingIndex = bookmarks.findIndex((b) => b.page === page);

    if (existingIndex !== -1) {
      bookmarks.splice(existingIndex, 1);
      localStorage.setItem(`${BOOKMARKS_PREFIX}${bookId}`, JSON.stringify(bookmarks));
      return false; // removed
    } else {
      const newBm: Bookmark = {
        id: `${bookId}_p${page}_${Date.now()}`,
        bookId,
        page,
        title: title || `Page ${page}`,
        createdAt: Date.now(),
      };
      bookmarks.push(newBm);
      bookmarks.sort((a, b) => a.page - b.page);
      localStorage.setItem(`${BOOKMARKS_PREFIX}${bookId}`, JSON.stringify(bookmarks));
      return true; // added
    }
  } catch (e) {
    console.error('Failed to toggle bookmark', e);
    return false;
  }
}

const METADATA_OVERRIDES_KEY = 'clover_metadata_overrides';

export interface BookMetadataOverride {
  title?: string;
  author?: string;
  category?: string;
  tags?: string[];
  description?: string;
}

export function getBookMetadataOverrides(): Record<string, BookMetadataOverride> {
  try {
    const raw = localStorage.getItem(METADATA_OVERRIDES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveBookMetadataOverride(bookId: string, metadata: BookMetadataOverride): void {
  try {
    const current = getBookMetadataOverrides();
    current[bookId] = {
      ...(current[bookId] || {}),
      ...metadata,
    };
    localStorage.setItem(METADATA_OVERRIDES_KEY, JSON.stringify(current));
  } catch (e) {
    console.error('Failed to save metadata override', e);
  }
}
