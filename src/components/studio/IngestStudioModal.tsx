import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  UploadCloud,
  Sparkles,
  CheckCircle2,
  Loader2,
  X,
  Plus,
  Cloud,
  AlertCircle,
  Zap,
  Tag,
  KeyRound,
  ExternalLink,
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { Book } from '../../types/book';
import { getHFConfig, saveHFConfig } from '../../services/hfStorage';
import {
  buildBrowserTaxonomy,
  suggestBookMetadataInBrowser,
  publishBookToCloudInbox,
} from '../../services/cloudStudioService';

interface StudioHealth {
  ok: boolean;
  mode?: 'local' | 'cloud';
  hfRepo: string;
  hasHfToken: boolean;
  hasGeminiKey: boolean;
  totalBooks: number;
  vectorizedBooks: number;
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
  ingestStatus: 'draft' | 'running' | 'done' | 'error';
  ingestStep?: string;
  ingestPercent?: number;
  commitUrl?: string;
  error?: string;
}

interface IngestStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBooksUpdated: () => void;
  books?: Book[];
}

const GEMINI_KEY_STORAGE = 'clover_studio_gemini_key';

export function IngestStudioModal({
  isOpen,
  onClose,
  onBooksUpdated,
  books = [],
}: IngestStudioModalProps) {
  const [serverHealth, setServerHealth] = useState<StudioHealth | null>(null);
  const [activeApiBase, setActiveApiBase] = useState<string | null>(null);
  const [isCheckingServer, setIsCheckingServer] = useState(false);

  const [drafts, setDrafts] = useState<StagedBookDraft[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadToHf, setUploadToHf] = useState(true);

  const [geminiKey, setGeminiKey] = useState<string>(
    () => localStorage.getItem(GEMINI_KEY_STORAGE) || ''
  );
  const [hfTokenInput, setHfTokenInput] = useState<string>(() => getHFConfig().hfToken);
  const [showTokensConfig, setShowTokensConfig] = useState(false);
  const [newTagInputs, setNewTagInputs] = useState<Record<string, string>>({});

  const fileInputRef = useRef<HTMLInputElement>(null);

  const checkHealth = useCallback(async () => {
    setIsCheckingServer(true);
    const { engineUrl } = getHFConfig();
    const candidates = [
      ...(engineUrl ? [`${engineUrl}/api/studio`] : []),
      'http://127.0.0.1:8765/api/studio',
    ];

    let connectedHealth: StudioHealth | null = null;
    let connectedBase: string | null = null;

    for (const base of candidates) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 1600);
        const res = await fetch(`${base}/health`, { signal: ctrl.signal });
        clearTimeout(tid);
        if (res.ok) {
          connectedHealth = await res.json();
          connectedBase = base;
          break;
        }
      } catch {
        // Not running locally; fall back cleanly to Serverless Browser + HF Cloud Inbox mode!
      }
    }

    setServerHealth(connectedHealth);
    setActiveApiBase(connectedBase);
    setHfTokenInput(getHFConfig().hfToken);
    setIsCheckingServer(false);
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

  const handleSaveHfToken = (val: string) => {
    setHfTokenInput(val);
    saveHFConfig({ hfToken: val.trim(), source: 'hf' });
  };

  const taxonomy = serverHealth?.taxonomy || buildBrowserTaxonomy(books);
  const categoriesList = Object.keys(taxonomy);
  const hfCfg = getHFConfig();

  const stageAndSuggestFiles = async (files: FileList | File[]) => {
    const pdfs = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length === 0) return;

    const initialDrafts: StagedBookDraft[] = pdfs.map((f) => ({
      localKey: `${f.name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file: f,
      isAnalyzing: true,
      title: f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '),
      author: 'Analyzing...',
      totalPages: 0,
      category: categoriesList[0] || 'Trading',
      tags: [],
      ingestStatus: 'draft',
    }));

    setDrafts((prev) => [...initialDrafts, ...prev]);

    for (const draft of initialDrafts) {
      try {
        if (activeApiBase) {
          // Connected to Python Studio API (Local or Custom Cloud Engine)
          const form = new FormData();
          form.append('file', draft.file);
          if (geminiKey.trim()) {
            form.append('geminiApiKey', geminiKey.trim());
          }
          const res = await fetch(`${activeApiBase}/suggest`, {
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
                  }
                : d
            )
          );
        } else {
          // 100% Online Browser Mode (works on any phone, tablet, or laptop!)
          const suggestion = await suggestBookMetadataInBrowser(
            draft.file,
            books,
            geminiKey.trim() || undefined
          );
          setDrafts((prev) =>
            prev.map((d) =>
              d.localKey === draft.localKey
                ? {
                    ...d,
                    stagedId: `browser_${d.localKey}`,
                    isAnalyzing: false,
                    title: suggestion.title || d.title,
                    author: suggestion.author || 'Unknown Author',
                    totalPages: suggestion.totalPages || 0,
                    category: suggestion.category || 'Trading',
                    tags: suggestion.tags,
                    suggestionSource: suggestion.source,
                  }
                : d
            )
          );
        }
      } catch (err: any) {
        setDrafts((prev) =>
          prev.map((d) =>
            d.localKey === draft.localKey
              ? {
                  ...d,
                  isAnalyzing: false,
                  ingestStatus: 'error',
                  error: err?.message || 'Failed to inspect PDF',
                }
              : d
          )
        );
      }
    }
  };

  const pollServerJob = async (
    base: string,
    jobId: string,
    onTick: (step: string, percent: number) => void
  ): Promise<any> => {
    while (true) {
      await new Promise((r) => setTimeout(r, 900));
      const res = await fetch(`${base}/job/${jobId}`);
      if (!res.ok) throw new Error('Lost connection to ingestion job');
      const job = await res.json();
      onTick(job.step || 'Processing...', job.percent ?? 50);
      if (job.status === 'completed') return job.result;
      if (job.status === 'error') throw new Error(job.error || 'Pipeline job failed');
    }
  };

  const runIngestForDraft = async (draft: StagedBookDraft) => {
    if (draft.ingestStatus === 'running') return;

    // Require HF token when running in Serverless Online Cloud Mode
    if (!activeApiBase && !hfTokenInput.trim()) {
      setShowTokensConfig(true);
      setDrafts((prev) =>
        prev.map((d) =>
          d.localKey === draft.localKey
            ? {
                ...d,
                ingestStatus: 'error',
                error: 'Paste your Hugging Face Write Token above once to upload from this device.',
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
              ingestStep: activeApiBase
                ? 'Starting OCR, Linearization & Vectorization...'
                : 'Uploading PDF directly to Hugging Face Cloud Inbox...',
              ingestPercent: 8,
              error: undefined,
            }
          : d
      )
    );

    try {
      if (activeApiBase && draft.stagedId && !draft.stagedId.startsWith('browser_')) {
        const res = await fetch(`${activeApiBase}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stagedId: draft.stagedId,
            title: draft.title.trim(),
            author: draft.author.trim(),
            category: draft.category.trim() || 'Uncategorized',
            tags: draft.tags.length > 0 ? draft.tags : [draft.category],
            uploadToHf,
            keepLocalPdf: !uploadToHf,
          }),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.detail || `HTTP ${res.status}`);
        }

        const { jobId } = await res.json();
        await pollServerJob(activeApiBase, jobId, (step, percent) => {
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
                  ingestStep: 'Linearized, Vectorized & Live!',
                  ingestPercent: 100,
                }
              : d
          )
        );
        onBooksUpdated();
      } else {
        // Serverless Online Cloud Upload -> Hugging Face Dataset Inbox + GitHub Actions Runner
        const out = await publishBookToCloudInbox({
          file: draft.file,
          title: draft.title.trim(),
          author: draft.author.trim(),
          category: draft.category.trim() || 'Uncategorized',
          tags: draft.tags.length > 0 ? draft.tags : [draft.category],
          hfRepo: hfCfg.hfRepo,
          hfToken: hfTokenInput.trim(),
          ghRepo: hfCfg.ghRepo,
          ghToken: hfCfg.ghToken,
          onStep: (step, percent) => {
            setDrafts((prev) =>
              prev.map((d) =>
                d.localKey === draft.localKey
                  ? { ...d, ingestStep: step, ingestPercent: percent }
                  : d
              )
            );
          },
        });

        setDrafts((prev) =>
          prev.map((d) =>
            d.localKey === draft.localKey
              ? {
                  ...d,
                  ingestStatus: 'done',
                  commitUrl: out.commitUrl,
                  ingestStep: out.dispatchedActions
                    ? 'Uploaded & GitHub Cloud Pipeline started (~1-2 min to OCR, linearize & index)!'
                    : 'Uploaded to HF Inbox! Cloud Runner will OCR, linearize & index automatically.',
                  ingestPercent: 100,
                }
              : d
          )
        );
      }
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
                1-Click Cloud Book Studio — Auto-Tag, OCR, Linearize & Vectorize
              </h2>
              <p className="text-xs text-muted">
                Works online from any phone, tablet, or laptop • Snowflake Arctic-Embed-m-v1.5 + QPDF Fast Web View
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

        {/* Engine Mode Banner */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-elevated/50 px-3.5 py-2.5 rounded-xl border border-subtle text-xs">
          <div className="flex flex-wrap items-center gap-2.5">
            {isCheckingServer ? (
              <span className="flex items-center gap-1.5 text-muted font-mono text-[11px]">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                Checking pipeline...
              </span>
            ) : activeApiBase ? (
              <span className="flex items-center gap-1.5 font-semibold text-emerald-300">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                Direct Studio Engine Connected ({serverHealth?.hfRepo || hfCfg.hfRepo})
              </span>
            ) : (
              <span className="flex items-center gap-1.5 font-semibold text-sky-300">
                <Cloud className="w-3.5 h-3.5 text-sky-400" />
                Online Cloud Mode ({hfCfg.hfRepo} + Free GitHub Actions OCR/Vector Runner)
              </span>
            )}

            {activeApiBase && (
              <label className="flex items-center gap-1.5 cursor-pointer select-none ml-2">
                <input
                  type="checkbox"
                  checked={uploadToHf}
                  onChange={(e) => setUploadToHf(e.target.checked)}
                  className="rounded accent-sky-500"
                />
                <span className="text-muted">Push to HF</span>
              </label>
            )}
          </div>

          <div className="flex items-center gap-3">
            {hfCfg.ghRepo && !activeApiBase && (
              <a
                href={`https://github.com/${hfCfg.ghRepo}/actions/workflows/cloud_ingest.yml`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[11px] text-muted hover:text-main"
                title="View or manually trigger GitHub Actions Cloud Ingestion Runner"
              >
                <span>Cloud Runner</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
            <button
              type="button"
              onClick={() => setShowTokensConfig((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-sky-400 hover:text-sky-300"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>
                {!activeApiBase && !hfTokenInput.trim()
                  ? 'Set HF Write Token (Required once)'
                  : 'Tokens & AI Tagger'}
              </span>
            </button>
          </div>
        </div>

        {(showTokensConfig || (!activeApiBase && !hfTokenInput.trim())) && (
          <div className="p-3.5 rounded-xl bg-surface-elevated border border-sky-500/30 space-y-2.5 text-xs">
            {!activeApiBase && (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <span className="text-main font-semibold sm:w-44 shrink-0">
                  HF Write Token (`hf_...`):
                </span>
                <input
                  type="password"
                  value={hfTokenInput}
                  onChange={(e) => handleSaveHfToken(e.target.value)}
                  placeholder="hf_... (Saved locally in this browser to upload PDFs directly to HF)"
                  className="flex-1 px-3 py-1.5 rounded-lg bg-black/30 border border-subtle text-main font-mono text-xs outline-none focus:border-sky-500"
                />
              </div>
            )}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <span className="text-muted sm:w-44 shrink-0">
                Optional Gemini API Key:
              </span>
              <input
                type="password"
                value={geminiKey}
                onChange={(e) => handleSaveGeminiKey(e.target.value)}
                placeholder="AIza... (Optional — upgrades on-device auto-tagger to Gemini 2.5 Flash)"
                className="flex-1 px-3 py-1.5 rounded-lg bg-black/30 border border-subtle text-main font-mono text-xs outline-none focus:border-sky-500"
              />
            </div>
          </div>
        )}

        {/* Drag & Drop PDF Zone */}
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
            Drop one or multiple PDF books here, or tap to choose from your phone/device
          </p>
          <p className="text-xs text-dim mt-1">
            Auto-extracts Title, Author & TOC in &lt;1s • Runs OCR on scanned pages, linearizes PDF & indexes Arctic 256-d vectors
          </p>
        </div>

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
                1-Click Linearize, OCR, Vectorize & Publish{' '}
                {readyDraftCount > 1 ? `All (${readyDraftCount})` : ''}
              </span>
            </button>
          </div>
        )}

        {/* Staged Books Cards */}
        {drafts.length > 0 && (
          <div className="max-h-[42vh] overflow-y-auto space-y-3 pr-1">
            {drafts.map((draft) => {
              const suggestedPool = taxonomy[draft.category] || [];
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

                  {draft.isAnalyzing ? (
                    <div className="flex items-center gap-2 text-xs text-sky-400 font-mono">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Inspecting PDF & predicting tags...</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-semibold text-muted">Category:</span>
                        <select
                          value={draft.category}
                          disabled={draft.ingestStatus !== 'draft'}
                          onChange={(e) =>
                            updateDraft(draft.localKey, { category: e.target.value })
                          }
                          className="px-2.5 py-1 rounded-lg bg-black/30 border border-subtle text-xs font-semibold text-sky-300 outline-none"
                        >
                          {categoriesList.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>

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
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-emerald-400">
                      <span className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span>{draft.ingestStep}</span>
                      </span>
                      {!activeApiBase && hfCfg.ghRepo && (
                        <a
                          href={`https://github.com/${hfCfg.ghRepo}/actions/workflows/cloud_ingest.yml`}
                          target="_blank"
                          rel="noreferrer"
                          className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 flex items-center gap-1"
                        >
                          <span>View / Run GitHub Actions</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
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

                  {draft.ingestStatus === 'draft' && !draft.isAnalyzing && (
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={() => runIngestForDraft(draft)}
                        className="px-3.5 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold flex items-center gap-1.5"
                      >
                        <Zap className="w-3.5 h-3.5" />
                        <span>Ingest, Linearize & Publish</span>
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
