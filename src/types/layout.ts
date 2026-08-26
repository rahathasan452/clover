export type BBox = [number, number, number, number]; // [x0, y0, x1, y1] normalized (0.0 to 1.0)

export interface WordBBox {
  w: string;
  b: BBox;
}

export interface LayoutBlock {
  id: string;
  text: string;
  words: WordBBox[];
  type?: 'paragraph' | 'heading' | 'equation' | 'table';
}

export interface PageLayout {
  page: number;
  dimensions: {
    width: number;
    height: number;
  };
  blocks: LayoutBlock[];
}

export interface BookLayout {
  bookId: string;
  title: string;
  author: string;
  totalPages: number;
  pages: PageLayout[];
}
