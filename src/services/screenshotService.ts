import * as pdfjsLib from 'pdfjs-dist';
import { ScreenshotOptions, CaptureProgress, ScreenshotTheme } from '../types/screenshot';

/**
 * Applies color transformation to canvas if dark/sepia/oled theme is selected.
 */
function applyThemeFilterToCanvas(
  sourceCanvas: HTMLCanvasElement,
  theme: ScreenshotTheme,
  currentReaderTheme?: string
): HTMLCanvasElement {
  const resolvedTheme = theme === 'current' ? (currentReaderTheme as ScreenshotTheme) || 'dark' : theme;

  if (resolvedTheme === 'original' || resolvedTheme === 'light') {
    return sourceCanvas;
  }

  let filterString = '';
  if (resolvedTheme === 'dark') {
    filterString = 'invert(0.88) hue-rotate(180deg) contrast(1.05) brightness(0.95)';
  } else if (resolvedTheme === 'oled') {
    filterString = 'invert(0.92) hue-rotate(180deg) contrast(1.12) brightness(0.9)';
  } else if (resolvedTheme === 'sepia') {
    filterString = 'sepia(0.35) contrast(0.96) brightness(0.98)';
  }

  if (!filterString) return sourceCanvas;

  const filteredCanvas = document.createElement('canvas');
  filteredCanvas.width = sourceCanvas.width;
  filteredCanvas.height = sourceCanvas.height;
  const ctx = filteredCanvas.getContext('2d');
  if (!ctx) return sourceCanvas;

  ctx.filter = filterString;
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.filter = 'none';
  return filteredCanvas;
}

/**
 * Renders a single PDF page to an offscreen high-res canvas.
 */
export async function renderSinglePageCanvas(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  scale: number = 2.0,
  theme: ScreenshotTheme = 'original',
  currentReaderTheme?: string
): Promise<HTMLCanvasElement> {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not create offscreen canvas context');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  await page.render({
    canvasContext: ctx,
    viewport,
  }).promise;

  return applyThemeFilterToCanvas(canvas, theme, currentReaderTheme);
}

/**
 * Resolves background color for screenshot composite based on theme.
 */
function resolveBackgroundColor(
  options: ScreenshotOptions,
  currentReaderTheme?: string
): string {
  if (options.backgroundColor) return options.backgroundColor;

  const resolvedTheme =
    options.theme === 'current'
      ? (currentReaderTheme as ScreenshotTheme) || 'dark'
      : options.theme || 'original';

  switch (resolvedTheme) {
    case 'dark':
      return '#0b0f17';
    case 'oled':
      return '#000000';
    case 'sepia':
      return '#f4ecd8';
    case 'light':
      return '#f8f9fa';
    case 'original':
    default:
      return '#181e29'; // Modern slate dark background for clean contrast with white PDF pages
  }
}

/**
 * Renders multiple PDF pages into a single stitched composite canvas and PNG Blob.
 */
export async function renderMultiPageScreenshot(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumbers: number[],
  options: ScreenshotOptions = {},
  bookTitle?: string,
  onProgress?: (progress: CaptureProgress) => void
): Promise<{ canvas: HTMLCanvasElement; blob: Blob }> {
  const sortedPages = Array.from(new Set(pageNumbers)).sort((a, b) => a - b);
  if (sortedPages.length === 0) {
    throw new Error('No pages selected for screenshot');
  }

  const scale = options.scale ?? 2.0;
  const layout = options.layout ?? 'vertical';
  const gap = options.gap ?? 24;
  const padding = options.padding ?? 28;
  const showPageNumbers = options.showPageNumbers ?? true;
  const showBookTitle = options.showBookTitle ?? true;
  const total = sortedPages.length;

  // 1. Render all individual page canvases
  const pageCanvases: { pageNum: number; canvas: HTMLCanvasElement }[] = [];

  for (let i = 0; i < sortedPages.length; i++) {
    const pageNum = sortedPages[i];
    onProgress?.({
      total,
      current: i + 1,
      status: 'rendering',
      message: `Rendering page ${pageNum} (${i + 1}/${total})...`,
    });

    const pageCanvas = await renderSinglePageCanvas(
      pdfDoc,
      pageNum,
      scale,
      options.theme ?? 'original',
      options.currentReaderTheme
    );
    pageCanvases.push({ pageNum, canvas: pageCanvas });
  }

  onProgress?.({
    total,
    current: total,
    status: 'stitching',
    message: 'Stitching composite screenshot...',
  });

  // 2. Header calculations
  const headerHeight = showBookTitle && bookTitle ? Math.round(52 * (scale / 1.5)) : 0;

  // 3. Layout geometry calculations
  let masterWidth = 0;
  let masterHeight = 0;
  interface PagePlacement {
    pageNum: number;
    canvas: HTMLCanvasElement;
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const placements: PagePlacement[] = [];

  if (layout === 'vertical') {
    const maxPageWidth = Math.max(...pageCanvases.map((p) => p.canvas.width));
    masterWidth = maxPageWidth + padding * 2;
    let currentY = padding + headerHeight;

    for (const item of pageCanvases) {
      const x = padding + Math.round((maxPageWidth - item.canvas.width) / 2);
      placements.push({
        pageNum: item.pageNum,
        canvas: item.canvas,
        x,
        y: currentY,
        w: item.canvas.width,
        h: item.canvas.height,
      });
      currentY += item.canvas.height + gap;
    }
    masterHeight = currentY - gap + padding;
  } else if (layout === 'grid-2') {
    // 2-column grid
    const colCount = Math.min(2, pageCanvases.length);
    const maxPageWidth = Math.max(...pageCanvases.map((p) => p.canvas.width));
    masterWidth = maxPageWidth * colCount + gap * (colCount - 1) + padding * 2;

    let currentY = padding + headerHeight;
    for (let i = 0; i < pageCanvases.length; i += 2) {
      const left = pageCanvases[i];
      const right = i + 1 < pageCanvases.length ? pageCanvases[i + 1] : null;

      const rowHeight = Math.max(left.canvas.height, right ? right.canvas.height : 0);

      // Left item
      placements.push({
        pageNum: left.pageNum,
        canvas: left.canvas,
        x: padding + Math.round((maxPageWidth - left.canvas.width) / 2),
        y: currentY,
        w: left.canvas.width,
        h: left.canvas.height,
      });

      // Right item if present, else center single item on row if alone
      if (right) {
        placements.push({
          pageNum: right.pageNum,
          canvas: right.canvas,
          x: padding + maxPageWidth + gap + Math.round((maxPageWidth - right.canvas.width) / 2),
          y: currentY,
          w: right.canvas.width,
          h: right.canvas.height,
        });
      }

      currentY += rowHeight + gap;
    }
    masterHeight = currentY - gap + padding;
  } else if (layout === 'horizontal') {
    const maxPageHeight = Math.max(...pageCanvases.map((p) => p.canvas.height));
    masterHeight = maxPageHeight + padding * 2 + headerHeight;

    let currentX = padding;
    for (const item of pageCanvases) {
      const y = padding + headerHeight + Math.round((maxPageHeight - item.canvas.height) / 2);
      placements.push({
        pageNum: item.pageNum,
        canvas: item.canvas,
        x: currentX,
        y,
        w: item.canvas.width,
        h: item.canvas.height,
      });
      currentX += item.canvas.width + gap;
    }
    masterWidth = currentX - gap + padding;
  }

  // 4. Create Master Canvas & Render
  const masterCanvas = document.createElement('canvas');
  masterCanvas.width = masterWidth;
  masterCanvas.height = masterHeight;
  const ctx = masterCanvas.getContext('2d');
  if (!ctx) throw new Error('Could not create composite canvas context');

  // Fill background
  const bgColor = resolveBackgroundColor(options, options.currentReaderTheme);
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, masterWidth, masterHeight);

  // Draw Header if enabled
  if (showBookTitle && bookTitle) {
    ctx.save();
    const titleFontSize = Math.max(14, Math.round(18 * (scale / 1.5)));
    const subFontSize = Math.max(11, Math.round(13 * (scale / 1.5)));

    ctx.fillStyle = bgColor === '#ffffff' || bgColor === '#f8f9fa' || bgColor === '#f4ecd8' ? '#0f172a' : '#f8fafc';
    ctx.font = `600 ${titleFontSize}px Inter, system-ui, sans-serif`;
    ctx.fillText(bookTitle, padding, padding + titleFontSize);

    ctx.fillStyle = bgColor === '#ffffff' || bgColor === '#f8f9fa' || bgColor === '#f4ecd8' ? '#64748b' : '#94a3b8';
    ctx.font = `400 ${subFontSize}px Inter, system-ui, sans-serif`;
    const pageRangeText = sortedPages.length === 1 ? `Page ${sortedPages[0]}` : `Pages ${sortedPages.join(', ')}`;
    ctx.fillText(`${pageRangeText} • Clover Reader`, padding, padding + titleFontSize + subFontSize + 6);
    ctx.restore();
  }

  // Draw Pages
  for (const p of placements) {
    ctx.save();

    // Drop shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = Math.round(16 * (scale / 1.5));
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.round(6 * (scale / 1.5));

    // Draw page image
    ctx.drawImage(p.canvas, p.x, p.y, p.w, p.h);

    // Reset shadow
    ctx.shadowColor = 'transparent';

    // Subtle border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = Math.max(1, Math.round(scale));
    ctx.strokeRect(p.x, p.y, p.w, p.h);

    // Page Number Badge
    if (showPageNumbers) {
      const badgeText = `p. ${p.pageNum}`;
      const badgeFontSize = Math.max(11, Math.round(12 * (scale / 1.5)));
      ctx.font = `600 ${badgeFontSize}px 'JetBrains Mono', monospace`;
      const textMetrics = ctx.measureText(badgeText);
      const badgePadX = Math.round(8 * (scale / 1.5));
      const badgePadY = Math.round(4 * (scale / 1.5));
      const badgeW = textMetrics.width + badgePadX * 2;
      const badgeH = badgeFontSize + badgePadY * 2;

      const badgeX = p.x + p.w - badgeW - Math.round(12 * (scale / 1.5));
      const badgeY = p.y + p.h - badgeH - Math.round(12 * (scale / 1.5));

      // Badge pill background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.beginPath();
      const radius = Math.round(4 * (scale / 1.5));
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, radius);
      ctx.fill();

      // Badge text
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(badgeText, badgeX + badgePadX, badgeY + badgePadY + badgeFontSize - 2);
    }

    ctx.restore();
  }

  // 5. Convert to PNG Blob
  const blob = await new Promise<Blob>((resolve, reject) => {
    masterCanvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to generate PNG blob from canvas'));
      },
      'image/png'
    );
  });

  onProgress?.({
    total,
    current: total,
    status: 'done',
    message: 'Screenshot generated successfully',
  });

  return { canvas: masterCanvas, blob };
}

/**
 * Copies a PNG Blob directly to the system clipboard using the standard Clipboard API.
 */
export async function copyScreenshotToClipboard(blob: Blob): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard || !window.ClipboardItem) {
    throw new Error('Clipboard API is not supported in this environment');
  }

  try {
    const item = new ClipboardItem({ 'image/png': blob });
    await navigator.clipboard.write([item]);
    return true;
  } catch (err: any) {
    console.error('Clipboard write failed:', err);
    throw new Error(
      err?.message || 'Failed to copy image to clipboard. Please check browser permissions or use Download PNG.'
    );
  }
}

/**
 * Triggers a file download for the screenshot PNG image.
 */
export function downloadScreenshotBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.png') ? filename : `${filename}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
