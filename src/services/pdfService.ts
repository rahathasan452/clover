import * as pdfjsLib from 'pdfjs-dist';

// Configure Mozilla PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export async function loadPDFDocument(
  url: string,
  httpHeaders?: Record<string, string>
): Promise<pdfjsLib.PDFDocumentProxy> {
  const loadingTask = pdfjsLib.getDocument({
    url,
    disableAutoFetch: true, // Lazy loading: only fetch requested byte ranges
    disableStream: false,    // Enable streaming transport
    rangeChunkSize: 65536,   // 64 KB Range chunks
    httpHeaders: httpHeaders || {},
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/',
    cMapPacked: true,
  });

  return loadingTask.promise;
}

export interface RenderPageResult {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface CancelableRenderTask {
  promise: Promise<RenderPageResult>;
  cancel: () => void;
}

export function renderPDFPageCancelable(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number = 1.2
): CancelableRenderTask {
  let activeRenderTask: any = null;
  let isCancelled = false;

  const promise = (async (): Promise<RenderPageResult> => {
    const page = await pdfDoc.getPage(pageNumber);
    if (isCancelled) {
      throw new Error('RenderingCancelledException');
    }

    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not get 2D canvas context');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;

    const renderContext = {
      canvasContext: ctx,
      viewport,
      transform,
    };

    activeRenderTask = page.render(renderContext);

    try {
      await activeRenderTask.promise;
    } catch (err: any) {
      if (err?.name === 'RenderingCancelledException' || isCancelled) {
        throw new Error('RenderingCancelledException');
      }
      throw err;
    }

    return {
      width: canvas.width,
      height: canvas.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    };
  })();

  return {
    promise,
    cancel: () => {
      isCancelled = true;
      if (activeRenderTask) {
        try {
          activeRenderTask.cancel();
        } catch (_) {}
      }
    },
  };
}
