export type BBox = [number, number, number, number]; // [x0, y0, x1, y1] normalized (0.0 to 1.0)

export interface WordBBox {
  w: string;
  b: BBox;
}

export interface SearchRecord {
  id: string;
  bookId: string;
  bookTitle: string;
  author: string;
  page: number;
  text: string;
  words: WordBBox[];
}

export interface SearchHit {
  id: string;
  bookId: string;
  bookTitle: string;
  author: string;
  category?: string;
  page: number;
  snippet: string;
  matchedWords: string[];
  bboxes: BBox[];
  score: number;
}

export interface SearchResultsGrouped {
  bookId: string;
  bookTitle: string;
  author: string;
  category?: string;
  coverUrl?: string;
  totalMatches: number;
  hits: SearchHit[];
}

