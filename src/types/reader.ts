import { BBox } from './search';

export type ReaderTheme = 'light' | 'dark' | 'sepia' | 'oled';
export type ViewMode = 'continuous' | 'single' | 'dual';
export type ZoomMode = 'fit-width' | 'fit-page' | 'custom';

export interface HighlightTarget {
  page: number;
  bboxes: BBox[];
  searchQuery?: string;
}

export interface ReadingProgress {
  bookId: string;
  currentPage: number;
  totalPages: number;
  lastReadTimestamp: number;
  percent: number;
}

export interface Bookmark {
  id: string;
  bookId: string;
  page: number;
  title: string;
  createdAt: number;
}
