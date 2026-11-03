import { uploadFiles } from '@huggingface/hub';
import { pdfjsLib } from './pdfService';
import { Book } from '../types/book';

export const DEFAULT_TAXONOMY: Record<string, string[]> = {
  Trading: [
    'Price Action',
    'Technical Analysis',
    'Candlesticks',
    'Chart Patterns',
    'Volume Spread Analysis',
    'Market Microstructure',
    'Order Flow',
    'Risk Management',
    'Position Sizing',
    'Trading Psychology',
    'Algorithmic Trading',
    'Options & Derivatives',
    'Swing Trading',
  ],
  'Machine Learning': [
    'Deep Learning',
    'Transformers & LLMs',
    'NLP',
    'Computer Vision',
    'Reinforcement Learning',
    'Feature Engineering',
    'PyTorch',
    'Statistical Learning',
    'MLOps',
    'Time Series Forecasting',
  ],
  'Mathematics & Quant': [
    'Probability & Statistics',
    'Linear Algebra',
    'Calculus',
    'Optimization',
    'Stochastic Calculus',
    'Quantitative Finance',
  ],
  'Computer Science': [
    'Algorithms & Data Structures',
    'Systems Architecture',
    'Databases',
    'Distributed Systems',
    'Python',
    'Software Engineering',
  ],
  Engineering: [
    'Electrical Engineering',
    'Signal Processing',
    'Control Systems',
    'Hardware',
  ],
};

export function buildBrowserTaxonomy(books: Book[]): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(DEFAULT_TAXONOMY)) {
    merged[k] = [...v];
  }
  for (const b of books) {
    const cat = (b.category || '').trim();
    if (cat && cat !== 'Uncategorized') {
      if (!merged[cat]) merged[cat] = [];
      for (const t of b.tags || []) {
        const clean = t.trim();
        if (clean && !merged[cat].includes(clean)) {
          merged[cat].push(clean);
        }
      }
    }
  }
  return merged;
}

export function slugifyBookId(text: string): string {
  const clean = text
    .toLowerCase()
    .replace(/(z[-_ ]?lib(rary)?|1lib|pdfdrive|libgen)/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean.slice(0, 64) || `book_${Date.now()}`;
}

function cleanFilenameStem(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/\b(z-library|z_library|1lib|pdfdrive|libgen|ebook)\b/gi, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function suggestBookMetadataInBrowser(
  file: File,
  existingBooks: Book[],
  geminiApiKey?: string
): Promise<{
  title: string;
  author: string;
  totalPages: number;
  category: string;
  tags: string[];
  source: string;
}> {
  const taxonomy = buildBrowserTaxonomy(existingBooks);
  let title = cleanFilenameStem(file.name);
  let author = 'Unknown Author';
  let totalPages = 0;
  const tocTitles: string[] = [];
  const sampleTextChunks: string[] = [];

  try {
    const buf = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      disableAutoFetch: true,
      disableStream: true,
    });
    const doc = await loadingTask.promise;
    totalPages = doc.numPages;

    try {
      const meta = await doc.getMetadata();
      const info: any = meta?.info || {};
      const mTitle = String(info.Title || '').trim();
      const mAuthor = String(info.Author || '').trim();
      if (
        mTitle.length > 3 &&
        !/^(untitled|microsoft word|\.pdf)/i.test(mTitle) &&
        !mTitle.toLowerCase().endsWith('.pdf')
      ) {
        title = mTitle;
      }
      if (mAuthor.length > 2 && !/^(unknown|admin|user)/i.test(mAuthor)) {
        author = mAuthor;
      }
    } catch {
      // Ignore missing PDF metadata dictionary
    }

    try {
      const outline = await doc.getOutline();
      if (Array.isArray(outline)) {
        for (const item of outline.slice(0, 25)) {
          if (item?.title) tocTitles.push(String(item.title).trim());
        }
      }
    } catch {
      // Ignore missing outline
    }

    const pagesToSample = Math.min(8, totalPages);
    for (let p = 1; p <= pagesToSample; p++) {
      try {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        const pageStr = (tc.items as any[])
          .map((it) => it.str || '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (pageStr) {
          sampleTextChunks.push(pageStr.slice(0, 900));
        }
      } catch {
        // Ignore single page parse error
      }
    }
    await doc.destroy();
  } catch (err) {
    console.warn('Browser PDF inspection fallback:', err);
  }

  const contextBlob = [
    `Filename: ${file.name}`,
    `Title: ${title}`,
    `Author: ${author}`,
    `TOC: ${tocTitles.join(' | ')}`,
    `Sample: ${sampleTextChunks.join(' ').slice(0, 3500)}`,
  ].join('\n');

  // 1. Optional Free Gemini 2.5 Flash Cloud Tagger (works directly from any browser!)
  if (geminiApiKey && geminiApiKey.trim().length > 10) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
        geminiApiKey.trim()
      )}`;
      const prompt = `You are cataloging a technical PDF book. Given the front-matter below and library taxonomy ${JSON.stringify(
        taxonomy
      )}, return ONLY valid JSON: {"title": string, "author": string, "category": string, "tags": [3 to 5 concise strings]}.\n\n${contextBlob}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const rawJson = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawJson) {
          const parsed = JSON.parse(rawJson);
          return {
            title: String(parsed.title || title).trim(),
            author: String(parsed.author || author).trim(),
            totalPages,
            category: String(parsed.category || 'Trading').trim(),
            tags: Array.isArray(parsed.tags)
              ? parsed.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 5)
              : [],
            source: 'gemini-2.5-flash',
          };
        }
      }
    } catch (gemErr) {
      console.warn('Gemini browser tagger fallback:', gemErr);
    }
  }

  // 2. Instant On-Device Lexical/Taxonomy Scorer (<5ms, 100% free & offline-capable)
  const lowerCorpus = contextBlob.toLowerCase();
  let bestCategory = Object.keys(taxonomy)[0] || 'Trading';
  let bestCatScore = -1;

  const scoredTags: Array<{ cat: string; tag: string; score: number }> = [];

  for (const [cat, tagPool] of Object.entries(taxonomy)) {
    let catScore = 0;
    for (const word of cat.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)) {
      const matches = lowerCorpus.split(word).length - 1;
      catScore += matches * 4;
    }

    for (const tag of tagPool) {
      let tScore = 0;
      const phrase = tag.toLowerCase();
      if (lowerCorpus.includes(phrase)) {
        tScore += 14;
      }
      for (const tok of phrase.split(/[^a-z0-9]+/).filter((w) => w.length > 2)) {
        const cnt = lowerCorpus.split(tok).length - 1;
        tScore += Math.min(cnt, 8) * 2;
      }
      catScore += tScore * 0.5;
      scoredTags.push({ cat, tag, score: tScore });
    }

    if (catScore > bestCatScore) {
      bestCatScore = catScore;
      bestCategory = cat;
    }
  }

  const chosenTags = scoredTags
    .map((item) => ({
      ...item,
      adjusted: item.score + (item.cat === bestCategory ? 5 : 0),
    }))
    .filter((item) => item.adjusted > 0)
    .sort((a, b) => b.adjusted - a.adjusted)
    .slice(0, 4)
    .map((item) => item.tag);

  if (chosenTags.length === 0 && taxonomy[bestCategory]?.length) {
    chosenTags.push(taxonomy[bestCategory][0]);
  }

  return {
    title,
    author,
    totalPages,
    category: bestCategory,
    tags: chosenTags,
    source: 'browser-instant-ai',
  };
}

export async function publishBookToCloudInbox(params: {
  file: File;
  title: string;
  author: string;
  category: string;
  tags: string[];
  hfRepo: string;
  hfToken: string;
  ghRepo?: string;
  ghToken?: string;
  onStep?: (step: string, percent: number) => void;
}): Promise<{
  bookId: string;
  commitUrl?: string;
  dispatchedActions: boolean;
}> {
  const { file, title, author, category, tags, hfRepo, hfToken, ghRepo, ghToken, onStep } = params;

  if (!hfToken.trim()) {
    throw new Error(
      'Add your Hugging Face Write Token once in Cloud Settings (top-right Cloud icon) to upload books from any device.'
    );
  }

  const bookId = slugifyBookId(title);
  const pdfRepoPath = `data/inbox/${bookId}.pdf`;
  const metaRepoPath = `data/inbox/${bookId}.meta.json`;

  onStep?.(`Uploading '${file.name}' directly to Hugging Face (${hfRepo})...`, 30);

  const metaPayload = {
    bookId,
    title: title.trim(),
    author: author.trim() || 'Unknown Author',
    category: category.trim() || 'Uncategorized',
    tags: tags.length > 0 ? tags : [category],
    pdfRepoPath,
    uploadedAt: new Date().toISOString(),
  };

  const metaBlob = new Blob([JSON.stringify(metaPayload, null, 2)], {
    type: 'application/json',
  });

  const commitOut = await uploadFiles({
    repo: { type: 'dataset', name: hfRepo.trim() },
    accessToken: hfToken.trim(),
    commitTitle: `Queue book for Cloud OCR + Linearize + Arctic Index: ${title}`,
    files: [
      { path: pdfRepoPath, content: file },
      { path: metaRepoPath, content: metaBlob },
    ],
  });

  let dispatchedActions = false;
  if (ghRepo && ghToken && ghToken.trim().length > 10) {
    onStep?.('Triggering GitHub Actions Cloud Pipeline (OCR + Linearize + Arctic Vectors)...', 82);
    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${ghRepo.trim()}/actions/workflows/cloud_ingest.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${ghToken.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: 'main', inputs: { rebuild_full_index: 'false' } }),
        }
      );
      dispatchedActions = ghRes.ok || ghRes.status === 204;
    } catch {
      dispatchedActions = false;
    }
  }

  onStep?.(
    dispatchedActions
      ? 'Uploaded to HF & Cloud Pipeline triggered! Will appear in library in ~1-2 min.'
      : 'Uploaded to HF Inbox! GitHub Actions Cloud Pipeline will OCR, linearize & index it automatically.',
    100
  );

  return {
    bookId,
    commitUrl: commitOut?.commit?.url,
    dispatchedActions,
  };
}

