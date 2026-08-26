export type ScreenshotLayout = 'vertical' | 'grid-2' | 'horizontal';

export type ScreenshotTheme = 'original' | 'current' | 'dark' | 'sepia' | 'oled' | 'light';

export interface ScreenshotOptions {
  scale?: number; // 1.0, 1.5, 2.0 (default 2.0 for sharp render)
  layout?: ScreenshotLayout; // default 'vertical'
  theme?: ScreenshotTheme; // default 'original'
  currentReaderTheme?: string;
  gap?: number; // spacing between pages in px (default 20)
  padding?: number; // outer canvas padding in px (default 24)
  showPageNumbers?: boolean; // badge with "Page X"
  showBookTitle?: boolean; // header badge with book title
  backgroundColor?: string;
}

export interface CaptureProgress {
  total: number;
  current: number;
  status: 'idle' | 'rendering' | 'stitching' | 'copying' | 'done' | 'error';
  message?: string;
}
