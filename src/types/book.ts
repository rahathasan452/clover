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
  vectorUrl?: string; // Path to compact Int8 quantized semantic vector shard (.bin)
  linearized?: boolean; // True when PDF is QPDF Fast-Web-View linearized
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
