export interface TOCItem {
  level: number;
  title: string;
  page: number;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  totalPages: number;
  fileSize: number;
  pdfUrl: string;
  coverUrl: string;
  layoutUrl: string; // Path to this specific PDF's dedicated layout JSON
  toc: TOCItem[];
  category?: string;
  tags?: string[];
  description?: string;
}

export interface LibraryCatalog {
  books: Book[];
  lastUpdated: string;
  hfRepo?: string;
}
