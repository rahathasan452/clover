import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  UploadCloud,
  Sparkles,
  CheckCircle2,
  Loader2,
  X,
  Plus,
  AlertCircle,
  AlertTriangle,
  Zap,
  Tag,
  KeyRound,
  Cpu,
  RefreshCw,
  Terminal,
  SkipForward,
  FolderPlus,
  Folder,
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { Book } from '../../types/book';
import { getHFConfig } from '../../services/hfStorage';

interface StudioHealth {
  ok: boolean;
  mode: 'local';
  ocrEngine: string;
  embedModel: string;
  device: string;
  hfRepo: string;
  hasHfToken: boolean;
  hasGeminiKey: boolean;
  totalBooks: number;
  indexedBooks: number;
  markerBooks: number;
  totalPassages: number;
  taxonomy: Record<string, string[]>;
}

interface StagedBookDraft {
  localKey: string;
  file: File;
  stagedId?: string;
  isAnalyzing: boolean;
  title: string;
  author: string;
  totalPages: number;
  category: string;
  tags: string[];
  suggestionSource?: string;
  isDuplicate?: boolean;
  duplicateType?: string;
  duplicateBook?: {
    id: string;
    title: string;
    author: string;
    totalPages: number;
    category: string;
  };
  duplicateAction?: 'replace' | 'skip' | 'version';
  ingestStatus: 'draft' | 'running' | 'done' | 'error';
  ingestStep?: string;
  ingestPercent?: number;
  error?: string;
}

interface IngestStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBooksUpdated: () => void;
  books?: Book[];
}

const STUDIO_PORT = 8088;
const LOCAL_STUDIO_API =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? '/api/studio'
    : `http://127.0.0.1:${STUDIO_PORT}/api/studio`;
const GEMINI_KEY_STORAGE = 'clover_studio_gemini_key';

function buildFallbackTaxonomy(books: Book[]): Record<string, string[]> {
  const map: Record<string, Set<string>> = {
    Trading: new Set(['Technical Analysis', 'Price Action', 'Risk Management']),
    Programming: new Set(['Algorithms', 'Architecture']),
    Mathematics: new Set(['Probability', 'Linear Algebra']),
  };
  for (const b of books) {
    const cat = b.category || 'Uncategorized';
    if (!map[cat]) map[cat] = new Set();
    for (const t of b.tags || []) map[cat].add(t);
  }
  const out: Record<string, string[]> = {};
  for (const [k, s] of Object.entries(map)) out[k] = Array.from(s);
  return out;
}

export function IngestStudioModal({
  isOpen,
  onClose,
  onBooksUpdated,
  books = [],
}: IngestStudioModalProps) {
  const [serverHealth, setServerHealth] = useState<StudioHealth | null>(null);
  const [isCheckingServer, setIsCheckingServer] = useState(false);

  const [drafts, setDrafts] = useState<StagedBookDraft[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadToHf, setUploadToHf] = useState(true);
  const [ocrEngine, setOcrEngine] = useState<'hybrid' | 'marker'>('hybrid');

  const [reocrRunning, setReocrRunning] = useState(false);
  const [reocrStep, setReocrStep] = useState('');
  const [reocrPercent, setReocrPercent] = useState(0);
  const [reocrDoneMsg, setReocrDoneMsg] = useState('');
  const [reocrError, setReocrError] = useState('');

  const [geminiKey, setGeminiKey] = useState<string>(
    () => localStorage.getItem(GEMINI_KEY_STORAGE) || ''
  );
  const [showTokensConfig, setShowTokensConfig] = useState(false);
  const [newTagInputs, setNewTagInputs] = useState<Record<string, string>>({});

  const CUSTOM_CATS_STORAGE = 'clover_studio_custom_categories';
  const [customCategories, setCustomCategories] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(CUSTOM_CATS_STORAGE);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [creatingCategoryFor, setCreatingCategoryFor] = useState<string | null>(null);
  const [newCategoryDraftInputs, setNewCategoryDraftInputs] = useState<Record<string, string>>({});

  const [batchCategoryChoice, setBatchCategoryChoice] = useState<string>('');
  const [isBatchCreatingCategory, setIsBatchCreatingCategory] = useState<boolean>(false);
  const [batchNewCatInput, setBatchNewCatInput] = useState<string>('');

  const [showPreCreateCat, setShowPreCreateCat] = useState<boolean>(false);
  const [preCreateCatInput, setPreCreateCatInput] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const addCustomCategory = useCallback((name: string): string => {
    const trimmed = name.trim();
    if (!trimmed) return '';
    setCustomCategories((prev) => {
      if (prev.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
        return prev;
      }
      const next = [...prev, trimmed];
      try {
        localStorage.setItem(CUSTOM_CATS_STORAGE, JSON.stringify(next));
      } catch {}
      return next;
    });
    return trimmed;
  }, []);

  const checkHealth = useCallback(async () => {
    setIsCheckingServer(true);
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 1800);
      const res = await fetch(`${LOCAL_STUDIO_API}/health`, { signal: ctrl.signal });
      clearTimeout(tid);
      if (res.ok) {
        const data: StudioHealth = await res.json();
        setServerHealth(data);
      } else {
        setServerHealth(null);
      }
    } catch {
      setServerHealth(null);
    } finally {
      setIsCheckingServer(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      void checkHealth();
    }
  }, [isOpen, checkHealth]);

  const handleSaveGeminiKey = (val: string) => {
    setGeminiKey(val);
    localStorage.setItem(GEMINI_KEY_STORAGE, val.trim());
  };

  const taxonomy = serverHealth?.taxonomy || buildFallbackTaxonomy(books);

  const allCategories = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of Object.keys(taxonomy)) {
      if (c?.trim()) map.set(c.trim().toLowerCase(), c.trim());
    }
    for (const c of customCategories) {
      if (c?.trim() && !map.has(c.trim().toLowerCase())) {
        map.set(c.trim().toLowerCase(), c.trim());
      }
    }
    for (const d of drafts) {
      if (d.category?.trim() && !map.has(d.category.trim().toLowerCase())) {
        map.set(d.category.trim().toLowerCase(), d.category.trim());
      }
    }
    const list = Array.from(map.values()).sort((a, b) => a.localeCompare(b));
    return list.length > 0 ? list : ['Trading', 'Machine Learning', 'Computer Science'];
  }, [taxonomy, customCategories, drafts]);

  const draftCategoryTags = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const d of drafts) {
      if (!d.category) continue;
      if (!map[d.category]) map[d.category] = new Set();
      for (const t of d.tags) map[d.category].add(t);
    }
    return map;
  }, [drafts]);

  const commitNewCategoryForDraft = (localKey: string) => {
    const raw = (newCategoryDraftInputs[localKey] || '').trim();
    if (raw) {
      const added = addCustomCategory(raw);
      updateDraft(localKey, { category: added || raw });
    }
    setCreatingCategoryFor(null);
    setNewCategoryDraftInputs((p) => ({ ...p, [localKey]: '' }));
  };

  const handleApplyBatchCategory = (category: string) => {
    const trimmed = category.trim();
    if (!trimmed) return;
    setDrafts((prev) =>
      prev.map((d) => (d.ingestStatus === 'draft' ? { ...d, category: trimmed } : d))
    );
  };

  const handleApplyBatchNewCategory = () => {
    const raw = batchNewCatInput.trim();
    if (raw) {
      const added = addCustomCategory(raw);
      handleApplyBatchCategory(added || raw);
      setBatchCategoryChoice(added || raw);
    }
    setIsBatchCreatingCategory(false);
    setBatchNewCatInput('');
  };

  const handlePreCreateCategory = () => {
    const raw = preCreateCatInput.trim();
    if (raw) {
      addCustomCategory(raw);
      setPreCreateCatInput('');
      setShowPreCreateCat(false);
    }
  };

  const hfCfg = getHFConfig();
  const isLocalConnected = Boolean(serverHealth?.ok);

  const pollServerJob = async (
    jobId: string,
    onTick: (step: string, percent: number) => void
  ): Promise<any> => {
    while (true) {
      await new Promise((r) => setTimeout(r, 950));
      const res = await fetch(`${LOCAL_STUDIO_API}/job/${jobId}`);
      if (!res.ok) throw new Error('Lost connection to local Studio server');
      const job = await res.json();
      onTick(job.step || 'Processing...', job.percent ?? 50);
      if (job.status === 'completed') return job.result;
      if (job.status === 'error') throw new Error(job.error || 'Pipeline job failed');
    }
  };

  const stageAndSuggestFiles = async (files: FileList | File[]) => {
    if (!isLocalConnected) return;
    const pdfs = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length === 0) return;

    const initialDrafts: StagedBookDraft[] = pdfs.map((f) => ({
      localKey: `${f.name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file: f,
      isAnalyzing: true,
      title: f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '),
      author: 'Analyzing...',
      totalPages: 0,
      category: allCategories[0] || 'Trading',
      tags: [],
      ingestStatus: 'draft',
    }));

    setDrafts((prev) => [...initialDrafts, ...prev]);

    for (const draft of initialDrafts) {
      try {
        const form = new FormData();
        form.append('file', draft.file);
        if (geminiKey.trim()) {
          form.append('geminiApiKey', geminiKey.trim());
        }
        const res = await fetch(`${LOCAL_STUDIO_API}/suggest`, {
          method: 'POST',
          body: form,
        });
        if (!res.ok) throw new Error(`Suggest failed (${res.status})`);
        const suggestion = await res.json();

        setDrafts((prev) =>
          prev.map((d) =>
            d.localKey === draft.localKey
              ? {
                  ...d,
                  stagedId: suggestion.stagedId,
                  isAnalyzing: false,
                  title: suggestion.title || d.title,
                  author: suggestion.author || 'Unknown Author',
                  totalPages: suggestion.totalPages || 0,
                  category: suggestion.category || 'Trading',
                  tags: Array.isArray(suggestion.tags) ? suggestion.tags : [],
                  suggestionSource: suggestion.source,
                  isDuplicate: Boolean(suggestion.isDuplicate),
                  duplicateType: suggestion.duplicateType,
                  duplicateBook: suggestion.duplicateBook,
                  duplicateAction: suggestion.isDuplicate ? 'skip' : 'replace',
                }
              : d
          )
        );
      } catch (err: any) {
        setDrafts((prev) =>
          prev.map((d) =>
            d.localKey === draft.localKey
              ? {
                  ...d,
                  isAnalyzing: false,
                  ingestStatus: 'error',
                  error: err?.message || 'Failed to inspect PDF locally',
                }
              : d
          )
        );
      }
    }
  };

  const setDraftDuplicateAction = (
    localKey: string,
    action: 'replace' | 'skip' | 'version'
  ) => {
    setDrafts((prev) =>
      prev.map((d) => (d.localKey === localKey ? { ...d, duplicateAction: action } : d))
    );
  };

  const handleSetAllDuplicatesAction = (action: 'replace' | 'skip' | 'version') => {
    setDrafts((prev) =>
      prev.map((d) => (d.isDuplicate ? { ...d, duplicateAction: action } : d))
    );
  };

  const runIngestForDraft = async (draft: StagedBookDraft) => {
    if (!isLocalConnected || !draft.stagedId || draft.ingestStatus === 'running') return;

    // Contingency: Skip duplicate without running compute
    if (draft.duplicateAction === 'skip') {
      setDrafts((prev) =>
        prev.map((d) =>
          d.localKey === draft.localKey
            ? {
                ...d,
                ingestStatus: 'done',
                ingestStep: `Skipped: Already exists in library as '${draft.duplicateBook?.title || draft.title}'`,
                ingestPercent: 100,
              }
            : d
        )
      );
      return;
    }

    setDrafts((prev) =>
      prev.map((d) =>
        d.localKey === draft.localKey
          ? {
              ...d,
              ingestStatus: 'running',
              ingestStep:
                ocrEngine === 'marker'
                  ? 'Starting Local Marker OCR, Linearize & Arctic Embed...'
                  : 'Starting Fast Hybrid OCR (PyMuPDF + WinOCR), Linearize & Arctic Embed...',
              ingestPercent: 5,
              error: undefined,
            }
          : d
      )
    );

    try {
      const res = await fetch(`${LOCAL_STUDIO_API}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stagedId: draft.stagedId,
          title: draft.title.trim(),
          author: draft.author.trim(),
          category: draft.category.trim() || 'Uncategorized',
          tags: draft.tags.length > 0 ? draft.tags : [draft.category],
          ocrEngine,
          uploadToHf,
          keepLocalPdf: !uploadToHf,
          duplicateAction: draft.duplicateAction || 'replace',
          geminiApiKey: geminiKey.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.detail || `HTTP ${res.status}`);
      }

      const { jobId } = await res.json();
      await pollServerJob(jobId, (step, percent) => {
        setDrafts((prev) =>
          prev.map((d) =>
            d.localKey === draft.localKey
              ? { ...d, ingestStep: step, ingestPercent: percent }
              : d
          )
        );
      });

      setDrafts((prev) =>
        prev.map((d) =>
          d.localKey === draft.localKey
            ? {
                ...d,
                ingestStatus: 'done',
                ingestStep: 'Extracted + Linearized + Arctic Vectorized & Synced to HF!',
                ingestPercent: 100,
              }
            : d
        )
      );
      void checkHealth();
      onBooksUpdated();
    } catch (err: any) {
      setDrafts((prev) =>
        prev.map((d) =>
          d.localKey === draft.localKey
            ? {
                ...d,
                ingestStatus: 'error',
                error: err?.message || 'Ingestion failed',
              }
            : d
        )
      );
    }
  };

  const handleIngestAllReady = async () => {
    const ready = drafts.filter((d) => !d.isAnalyzing && d.ingestStatus === 'draft');
    for (const item of ready) {
      await runIngestForDraft(item);
    }
  };

  const handleReocrExistingLibrary = async () => {
    if (!isLocalConnected || reocrRunning) return;
    setReocrRunning(true);
    setReocrError('');
    setReocrDoneMsg('');
    setReocrStep('Starting Local Fast Hybrid OCR & Snowflake Arctic Re-Embedding...');
    setReocrPercent(3);

    try {
      const res = await fetch(`${LOCAL_STUDIO_API}/reocr-library`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadToHf: true, force: false, ocrEngine }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { jobId } = await res.json();
      const result = await pollServerJob(jobId, (step, pct) => {
        setReocrStep(step);
        setReocrPercent(pct);
      });
      setReocrDoneMsg(
        `Hybrid Re-OCR & Arctic Re-Embedding finished (${result?.upgradedBooks ?? 0} books upgraded & synced to HF)!`
      );
      void checkHealth();
      onBooksUpdated();
    } catch (err: any) {
      setReocrError(err?.message || 'Re-OCR failed');
    } finally {
      setReocrRunning(false);
    }
  };

  const updateDraft = (localKey: string, patch: Partial<StagedBookDraft>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.localKey === localKey ? { ...d, ...patch } : d))
    );
  };

  const toggleDraftTag = (localKey: string, tag: string) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.localKey !== localKey) return d;
        const exists = d.tags.includes(tag);
        return {
          ...d,
          tags: exists ? d.tags.filter((t) => t !== tag) : [...d.tags, tag],
        };
      })
    );
  };

  const readyDraftCount = drafts.filter(
    (d) => !d.isAnalyzing && d.ingestStatus === 'draft'
  ).length;

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="max-w-4xl">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-sky-500/20 border border-sky-500/40 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-sky-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-main">
                Local PC 1-Click Book Studio — Fast Hybrid OCR, Linearize & Arctic Vectorize
              </h2>
              <p className="text-xs text-muted">
                Local PC: PyMuPDF + 220 DPI WinOCR + QPDF + Arctic 256-d → Syncs to `{hfCfg.hfRepo}` for Online Any-Device Reading & Search
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-muted hover:text-main"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Local Engine Status Banner */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-elevated/50 px-3.5 py-2.5 rounded-xl border border-subtle text-xs">
          <div className="flex flex-wrap items-center gap-2.5">
            {isCheckingServer ? (
              <span className="flex items-center gap-1.5 text-muted font-mono text-[11px]">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                Checking local PC Studio server (`127.0.0.1:8088`)...
              </span>
            ) : isLocalConnected && serverHealth ? (
              <>
                <span className="flex items-center gap-1.5 font-semibold text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  Local Studio Ready
                </span>
                <span className="px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-300 border border-sky-500/30 font-mono text-[11px] flex items-center gap-1">
                  <Cpu className="w-3 h-3" />
                  {serverHealth.device}
                </span>
                <span className="text-dim font-mono text-[11px]">
                  Indexed: {serverHealth.indexedBooks}/{serverHealth.totalBooks} books •{' '}
                  {serverHealth.totalPassages.toLocaleString()} passages
                </span>
                <select
                  value={ocrEngine}
                  onChange={(e) => setOcrEngine(e.target.value as 'hybrid' | 'marker')}
                  className="px-2 py-0.5 rounded-md bg-black/35 border border-subtle text-[11px] text-sky-300 outline-none"
                  title="Extraction engine for background search index"
                >
                  <option value="hybrid">Engine: Fast Hybrid (PyMuPDF + WinOCR)</option>
                  <option value="marker">Engine: Marker (Slow LaTeX Math)</option>
                </select>
                <label className="flex items-center gap-1.5 cursor-pointer select-none ml-1">
                  <input
                    type="checkbox"
                    checked={uploadToHf}
                    onChange={(e) => setUploadToHf(e.target.checked)}
                    className="rounded accent-sky-500"
                  />
                  <span className="text-muted">Upload to HF (`{serverHealth.hfRepo}`)</span>
                </label>
              </>
            ) : (
              <span className="flex items-center gap-1.5 font-semibold text-amber-300">
                <Terminal className="w-3.5 h-3.5 text-amber-400" />
                Local PC Studio Server Not Running (Reading & Hybrid Search remain 100% online on all devices)
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void checkHealth()}
              className="text-[11px] text-muted hover:text-main flex items-center gap-1"
              title="Re-check local Studio server"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => setShowPreCreateCat((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 hover:text-emerald-300 transition-colors"
              title="Create a custom category"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>+ New Category</span>
            </button>
            {isLocalConnected && (
              <button
                type="button"
                onClick={() => setShowTokensConfig((v) => !v)}
                className="flex items-center gap-1.5 text-[11px] font-semibold text-sky-400 hover:text-sky-300"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>Optional AI Tagger Key</span>
              </button>
            )}
          </div>
        </div>

        {/* Pre-create custom category banner */}
        {showPreCreateCat && (
          <div className="p-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex flex-wrap items-center justify-between gap-2.5 animate-fadeIn">
            <div className="flex flex-wrap items-center gap-2">
              <FolderPlus className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="text-xs font-semibold text-main">New Category:</span>
              <input
                type="text"
                autoFocus
                placeholder="e.g. Economics, Philosophy..."
                value={preCreateCatInput}
                onChange={(e) => setPreCreateCatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handlePreCreateCategory();
                  } else if (e.key === 'Escape') {
                    setShowPreCreateCat(false);
                  }
                }}
                className="px-2.5 py-1 rounded-lg bg-black/40 border border-emerald-500/50 text-xs text-main outline-none w-52 focus:border-emerald-400"
              />
              <button
                type="button"
                onClick={handlePreCreateCategory}
                className="px-3 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-colors"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => setShowPreCreateCat(false)}
                className="p-1 rounded-lg bg-white/5 hover:bg-white/10 text-muted hover:text-main"
                title="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-dim font-mono">
              <span>{allCategories.length} categories available</span>
            </div>
          </div>
        )}

        {/* Instructions when opened on an online phone/tablet or without `npm run studio` */}
        {!isCheckingServer && !isLocalConnected && (
          <div className="p-4 rounded-2xl bg-surface-elevated border border-subtle space-y-2.5 text-xs">
            <p className="text-main font-semibold">
              How Local PC 1-Click Ingestion Works:
            </p>
            <p className="text-muted leading-relaxed">
              Per your architecture, **reading** (HTTP 206 linearized streaming) and **4-stage semantic hybrid search** (`Arctic` + `BM25` + `MS-MARCO` Cross-Encoder) work **100% online from any phone, tablet, or laptop**, while **Fast Hybrid OCR (`PyMuPDF` + `220 DPI WinOCR`), PDF linearization, and vector indexing** run strictly on your **local PC** and push static artifacts to `{hfCfg.hfRepo}`.
            </p>
            <div className="p-3 rounded-xl bg-black/40 border border-subtle font-mono text-[11px] text-sky-300 space-y-1">
              <div># On your local PC, launch the 1-Click Visual Studio:</div>
              <div className="text-emerald-300">npm run studio</div>
              <div className="pt-1 text-dim"># Or ingest a PDF / folder / re-OCR HF library in 1 CLI command:</div>
              <div className="text-emerald-300">npm run ingest -- --pdf "C:\Books\NewBook.pdf"</div>
              <div className="text-emerald-300">npm run reocr</div>
            </div>
          </div>
        )}

        {isLocalConnected && showTokensConfig && (
          <div className="p-3.5 rounded-xl bg-surface-elevated border border-sky-500/30 space-y-2 text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <span className="text-muted sm:w-48 shrink-0">
                Optional Gemini API Key:
              </span>
              <input
                type="password"
                value={geminiKey}
                onChange={(e) => handleSaveGeminiKey(e.target.value)}
                placeholder="AIza... (Optional — upgrades local auto-tagger to Gemini 2.5 Flash)"
                className="flex-1 px-3 py-1.5 rounded-lg bg-black/30 border border-subtle text-main font-mono text-xs outline-none focus:border-sky-500"
              />
            </div>
          </div>
        )}

        {/* 1-Click Re-OCR & Re-Embed Existing HF Dataset Banner */}
        {isLocalConnected &&
          serverHealth &&
          serverHealth.markerBooks < serverHealth.totalBooks && (
            <div className="p-3.5 rounded-xl bg-indigo-500/10 border border-indigo-500/30 space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-semibold text-indigo-200">
                    Upgrade Existing HF Library to Marker OCR (No Image Cropping):
                  </span>{' '}
                  <span className="text-muted">
                    {serverHealth.totalBooks - serverHealth.markerBooks} of{' '}
                    {serverHealth.totalBooks} books have not yet been extracted with Marker.
                  </span>
                </div>
                <button
                  type="button"
                  disabled={reocrRunning}
                  onClick={handleReocrExistingLibrary}
                  className="px-3.5 py-1.5 rounded-xl bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white font-bold text-xs flex items-center gap-1.5 transition-all"
                >
                  {reocrRunning ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  <span>Re-OCR & Re-Embed HF Books with Marker</span>
                </button>
              </div>

              {reocrRunning && (
                <div className="space-y-1 pt-1">
                  <div className="flex justify-between font-mono text-[11px] text-indigo-300">
                    <span>{reocrStep}</span>
                    <span>{reocrPercent}%</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-indigo-400 transition-all duration-300"
                      style={{ width: `${reocrPercent || 4}%` }}
                    />
                  </div>
                </div>
              )}
              {reocrDoneMsg && (
                <div className="text-emerald-300 font-semibold">{reocrDoneMsg}</div>
              )}
              {reocrError && <div className="text-rose-400">{reocrError}</div>}
            </div>
          )}

        {/* Drag & Drop PDF Zone (Active when Local Studio Server is running) */}
        {isLocalConnected && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files?.length) {
                void stageAndSuggestFiles(e.dataTransfer.files);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`cursor-pointer rounded-2xl border-2 border-dashed p-6 text-center transition-all ${
              isDragging
                ? 'border-sky-400 bg-sky-500/15'
                : 'border-strong hover:border-sky-500/60 bg-surface-elevated/35 hover:bg-surface-elevated/60'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void stageAndSuggestFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <UploadCloud className="w-9 h-9 text-sky-400 mx-auto mb-2" />
            <p className="text-sm font-semibold text-main">
              Drop one or multiple PDF books here, or click to browse on your PC
            </p>
            <p className="text-xs text-dim mt-1">
              Auto-suggests Title, Author, Category & Tags in &lt;1s • Runs Fast Hybrid OCR (`PyMuPDF` + `WinOCR`), QPDF linearization & Arctic 256-d indexing locally
            </p>
          </div>
        )}

        {/* Batch 1-Click Publish Action */}
        {readyDraftCount > 0 && (
          <div className="flex items-center justify-between bg-sky-500/10 border border-sky-500/30 px-4 py-2.5 rounded-xl">
            <span className="text-xs font-semibold text-sky-200">
              {readyDraftCount} {readyDraftCount === 1 ? 'book' : 'books'} auto-tagged & ready
            </span>
            <button
              onClick={handleIngestAllReady}
              className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-sky-500/25 transition-all"
            >
              <Zap className="w-4 h-4" />
              <span>
                1-Click Hybrid Extract, Linearize, Embed & Upload{' '}
                {readyDraftCount > 1 ? `All (${readyDraftCount})` : ''}
              </span>
            </button>
          </div>
        )}

        {/* Batch Category Assignment Bar */}
        {readyDraftCount > 0 && (
          <div className="p-3 rounded-2xl bg-surface-elevated/70 border border-subtle flex flex-wrap items-center justify-between gap-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 text-main font-semibold">
                <Folder className="w-4 h-4 text-sky-400 shrink-0" />
                <span>
                  Assign Category to All {readyDraftCount} Book{readyDraftCount > 1 ? 's' : ''}:
                </span>
              </div>
              {isBatchCreatingCategory ? (
                <div className="flex items-center gap-1.5 animate-fadeIn">
                  <FolderPlus className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <input
                    type="text"
                    autoFocus
                    value={batchNewCatInput}
                    onChange={(e) => setBatchNewCatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleApplyBatchNewCategory();
                      } else if (e.key === 'Escape') {
                        setIsBatchCreatingCategory(false);
                      }
                    }}
                    placeholder="Enter new category name..."
                    className="px-2.5 py-1 rounded-lg bg-black/40 border border-emerald-500/50 text-xs text-main outline-none w-44 focus:border-emerald-400"
                  />
                  <button
                    type="button"
                    onClick={handleApplyBatchNewCategory}
                    className="px-2.5 py-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-lg transition-colors"
                  >
                    Apply to All
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsBatchCreatingCategory(false)}
                    className="p-1 rounded-lg bg-white/5 hover:bg-white/10 text-muted"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <select
                    value={batchCategoryChoice}
                    onChange={(e) => {
                      if (e.target.value === '__BATCH_NEW__') {
                        setIsBatchCreatingCategory(true);
                      } else {
                        setBatchCategoryChoice(e.target.value);
                      }
                    }}
                    className="px-2.5 py-1 rounded-lg bg-black/30 border border-subtle text-xs font-semibold text-sky-300 outline-none"
                  >
                    <option value="">Choose category...</option>
                    {allCategories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                    <option value="__BATCH_NEW__" className="text-emerald-400 font-bold">
                      + Create New Category...
                    </option>
                  </select>
                  {batchCategoryChoice && (
                    <button
                      type="button"
                      onClick={() => handleApplyBatchCategory(batchCategoryChoice)}
                      className="px-2.5 py-1 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs transition-colors"
                    >
                      Apply to All
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setIsBatchCreatingCategory(true)}
                    className="px-2 py-1 rounded-lg bg-surface hover:bg-surface-elevated text-dim hover:text-emerald-300 border border-subtle text-xs font-semibold flex items-center gap-1 transition-colors"
                    title="Create new category and apply to all staged books"
                  >
                    <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
                    <span>New Category</span>
                  </button>
                </div>
              )}
            </div>
            <div className="text-[11px] text-dim font-mono">
              {allCategories.length} categories available
            </div>
          </div>
        )}

        {/* Global Duplicate Batch Notice */}
        {drafts.some((d) => d.isDuplicate && d.ingestStatus === 'draft') && (
          <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-semibold">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
              <span>
                {drafts.filter((d) => d.isDuplicate && d.ingestStatus === 'draft').length} duplicate book(s) detected in queue
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleSetAllDuplicatesAction('skip')}
                className="px-2.5 py-1 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs transition-colors"
              >
                Skip All Duplicates
              </button>
              <button
                type="button"
                onClick={() => handleSetAllDuplicatesAction('replace')}
                className="px-2.5 py-1 rounded-xl bg-surface hover:bg-surface-elevated text-muted hover:text-main border border-subtle text-xs transition-colors"
              >
                Overwrite All
              </button>
            </div>
          </div>
        )}

        {/* Staged Books Cards */}
        {drafts.length > 0 && (
          <div className="max-h-[42vh] overflow-y-auto space-y-3 pr-1">
            {drafts.map((draft) => {
              const serverPool = taxonomy[draft.category] || [];
              const draftPool = Array.from(draftCategoryTags[draft.category] || []);
              const suggestedPool = Array.from(new Set([...serverPool, ...draftPool]));
              const customInput = newTagInputs[draft.localKey] || '';

              return (
                <div
                  key={draft.localKey}
                  className="p-4 rounded-2xl bg-surface-elevated/70 border border-subtle space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex-1 min-w-[220px] grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div className="sm:col-span-2">
                        <label className="text-[10px] font-semibold uppercase text-dim">
                          Title
                        </label>
                        <input
                          type="text"
                          value={draft.title}
                          disabled={draft.ingestStatus !== 'draft'}
                          onChange={(e) =>
                            updateDraft(draft.localKey, { title: e.target.value })
                          }
                          className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-black/25 border border-subtle text-xs font-semibold text-main outline-none focus:border-sky-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-semibold uppercase text-dim">
                          Author
                        </label>
                        <input
                          type="text"
                          value={draft.author}
                          disabled={draft.ingestStatus !== 'draft'}
                          onChange={(e) =>
                            updateDraft(draft.localKey, { author: e.target.value })
                          }
                          className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-black/25 border border-subtle text-xs text-main outline-none focus:border-sky-500"
                        />
                      </div>
                    </div>

                    <button
                      onClick={() =>
                        setDrafts((prev) =>
                          prev.filter((x) => x.localKey !== draft.localKey)
                        )
                      }
                      className="p-1 text-dim hover:text-rose-400"
                      title="Remove from queue"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Duplicate Contingency Alert & Action Selector */}
                  {draft.isDuplicate && draft.duplicateBook && draft.ingestStatus === 'draft' && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-2 animate-fade-in">
                      <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-amber-600 dark:text-amber-400 font-semibold">
                        <div className="flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-500" />
                          <span>Already in library: "{draft.duplicateBook.title}" ({draft.duplicateBook.totalPages} pp.)</span>
                        </div>
                        <span className="font-mono text-[10px] text-amber-500/80">id: {draft.duplicateBook.id}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <span className="text-[11px] text-muted font-medium mr-1">Action:</span>
                        <button
                          type="button"
                          onClick={() => setDraftDuplicateAction(draft.localKey, 'skip')}
                          className={`px-2.5 py-0.5 rounded-lg text-xs font-semibold transition-all ${
                            (draft.duplicateAction || 'skip') === 'skip'
                              ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                              : 'bg-surface text-muted hover:text-main border border-subtle'
                          }`}
                        >
                          Skip (Keep Existing)
                        </button>
                        <button
                          type="button"
                          onClick={() => setDraftDuplicateAction(draft.localKey, 'replace')}
                          className={`px-2.5 py-0.5 rounded-lg text-xs font-semibold transition-all ${
                            draft.duplicateAction === 'replace'
                              ? 'bg-sky-500 text-slate-950 font-bold shadow-sm'
                              : 'bg-surface text-muted hover:text-main border border-subtle'
                          }`}
                        >
                          Re-OCR & Overwrite
                        </button>
                        <button
                          type="button"
                          onClick={() => setDraftDuplicateAction(draft.localKey, 'version')}
                          className={`px-2.5 py-0.5 rounded-lg text-xs font-semibold transition-all ${
                            draft.duplicateAction === 'version'
                              ? 'bg-purple-600 text-white font-bold shadow-sm'
                              : 'bg-surface text-muted hover:text-main border border-subtle'
                          }`}
                        >
                          Keep Both (New Edition)
                        </button>
                      </div>
                    </div>
                  )}

                  {draft.isAnalyzing ? (
                    <div className="flex items-center gap-2 text-xs text-sky-400 font-mono">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Inspecting PDF & predicting tags...</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-semibold text-muted">Category:</span>
                        {creatingCategoryFor === draft.localKey ? (
                          <div className="flex items-center gap-1.5 animate-fadeIn">
                            <FolderPlus className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                            <input
                              type="text"
                              autoFocus
                              value={newCategoryDraftInputs[draft.localKey] || ''}
                              onChange={(e) =>
                                setNewCategoryDraftInputs((p) => ({
                                  ...p,
                                  [draft.localKey]: e.target.value,
                                }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  commitNewCategoryForDraft(draft.localKey);
                                } else if (e.key === 'Escape') {
                                  setCreatingCategoryFor(null);
                                }
                              }}
                              placeholder="New category name..."
                              className="px-2.5 py-1 rounded-lg bg-black/40 border border-emerald-500/60 text-xs font-semibold text-emerald-200 outline-none w-44 focus:border-emerald-400"
                            />
                            <button
                              type="button"
                              onClick={() => commitNewCategoryForDraft(draft.localKey)}
                              className="px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-colors"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setCreatingCategoryFor(null)}
                              className="p-1 rounded-lg bg-white/5 hover:bg-white/10 text-muted"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <select
                              value={draft.category}
                              disabled={draft.ingestStatus !== 'draft'}
                              onChange={(e) => {
                                if (e.target.value === '__NEW_CATEGORY__') {
                                  setCreatingCategoryFor(draft.localKey);
                                } else {
                                  updateDraft(draft.localKey, { category: e.target.value });
                                }
                              }}
                              className="px-2.5 py-1 rounded-lg bg-black/30 border border-subtle text-xs font-semibold text-sky-300 outline-none"
                            >
                              {allCategories.map((cat) => (
                                <option key={cat} value={cat}>
                                  {cat}
                                </option>
                              ))}
                              <option value="__NEW_CATEGORY__" className="text-emerald-400 font-bold">
                                + Create New Category...
                              </option>
                            </select>

                            {draft.ingestStatus === 'draft' && (
                              <button
                                type="button"
                                onClick={() => setCreatingCategoryFor(draft.localKey)}
                                className="px-2 py-1 rounded-lg bg-surface hover:bg-surface-elevated text-dim hover:text-emerald-300 border border-subtle text-[11px] font-semibold flex items-center gap-1 transition-colors"
                                title="Create new category and assign to this book"
                              >
                                <FolderPlus className="w-3 h-3 text-emerald-400" />
                                <span>New</span>
                              </button>
                            )}
                          </div>
                        )}

                        {draft.totalPages > 0 && (
                          <span className="text-[11px] font-mono text-dim">
                            • {draft.totalPages} pages
                          </span>
                        )}
                        {draft.suggestionSource && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 font-mono">
                            Auto-tagged ({draft.suggestionSource})
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <Tag className="w-3.5 h-3.5 text-sky-400 mr-0.5" />
                        {draft.tags.map((t) => (
                          <button
                            key={t}
                            type="button"
                            disabled={draft.ingestStatus !== 'draft'}
                            onClick={() => toggleDraftTag(draft.localKey, t)}
                            className="px-2.5 py-0.5 rounded-lg bg-sky-500 text-slate-950 font-bold text-[11px] flex items-center gap-1"
                          >
                            <span>{t}</span>
                            <X className="w-2.5 h-2.5" />
                          </button>
                        ))}

                        {suggestedPool
                          .filter((t) => !draft.tags.includes(t))
                          .slice(0, 6)
                          .map((t) => (
                            <button
                              key={t}
                              type="button"
                              disabled={draft.ingestStatus !== 'draft'}
                              onClick={() => toggleDraftTag(draft.localKey, t)}
                              className="px-2 py-0.5 rounded-lg bg-white/5 hover:bg-white/10 text-muted text-[11px] border border-subtle flex items-center gap-1"
                            >
                              <Plus className="w-2.5 h-2.5" />
                              <span>{t}</span>
                            </button>
                          ))}

                        {draft.ingestStatus === 'draft' && (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              const clean = customInput.trim();
                              if (clean && !draft.tags.includes(clean)) {
                                toggleDraftTag(draft.localKey, clean);
                              }
                              setNewTagInputs((p) => ({ ...p, [draft.localKey]: '' }));
                            }}
                            className="inline-flex items-center"
                          >
                            <input
                              type="text"
                              value={customInput}
                              onChange={(e) =>
                                setNewTagInputs((p) => ({
                                  ...p,
                                  [draft.localKey]: e.target.value,
                                }))
                              }
                              placeholder="+ Custom tag..."
                              className="w-28 px-2 py-0.5 rounded-lg bg-black/25 border border-subtle text-[11px] text-main outline-none focus:border-sky-500"
                            />
                          </form>
                        )}
                      </div>
                    </>
                  )}

                  {draft.ingestStatus === 'running' && (
                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center justify-between text-xs font-mono text-sky-300">
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          {draft.ingestStep}
                        </span>
                        <span>{draft.ingestPercent}%</span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className="h-full bg-sky-500 transition-all duration-300"
                          style={{ width: `${draft.ingestPercent || 5}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {draft.ingestStatus === 'done' && (
                    <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>{draft.ingestStep}</span>
                    </div>
                  )}

                  {draft.ingestStatus === 'error' && (
                    <div className="flex items-center justify-between gap-2 text-xs text-rose-400">
                      <span className="flex items-center gap-1.5">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        {draft.error}
                      </span>
                      <button
                        onClick={() => runIngestForDraft(draft)}
                        className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 font-semibold shrink-0"
                      >
                        Retry
                      </button>
                    </div>
                  )}

                  {!draft.isAnalyzing && draft.ingestStatus === 'draft' && (
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={() => runIngestForDraft(draft)}
                        className={`px-3.5 py-1.5 rounded-xl font-semibold text-xs flex items-center gap-1.5 transition-all ${
                          draft.duplicateAction === 'skip'
                            ? 'bg-amber-500/20 hover:bg-amber-500 hover:text-slate-950 text-amber-500 border border-amber-500/40'
                            : draft.duplicateAction === 'version'
                            ? 'bg-purple-500/20 hover:bg-purple-600 hover:text-white text-purple-300 border border-purple-500/40'
                            : 'bg-sky-500/20 hover:bg-sky-500 hover:text-slate-950 text-sky-300 border border-sky-500/40'
                        }`}
                      >
                        {draft.duplicateAction === 'skip' ? (
                          <>
                            <SkipForward className="w-3.5 h-3.5" />
                            <span>Skip (Already in Library)</span>
                          </>
                        ) : draft.duplicateAction === 'version' ? (
                          <>
                            <Plus className="w-3.5 h-3.5" />
                            <span>Publish as New Edition</span>
                          </>
                        ) : (
                          <>
                            <Zap className="w-3.5 h-3.5" />
                            <span>
                              {draft.isDuplicate ? 'Re-OCR & Overwrite' : 'Extract, Linearize & Publish'}
                            </span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
