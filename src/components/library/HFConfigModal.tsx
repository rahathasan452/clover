import React, { useState, useEffect } from 'react';
import { Cloud, Check, Key, Database, RefreshCw, Cpu, Github } from 'lucide-react';
import { Modal } from '../common/Modal';
import { getHFConfig, saveHFConfig } from '../../services/hfStorage';

interface HFConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRefreshCatalog: () => void;
}

export function HFConfigModal({ isOpen, onClose, onRefreshCatalog }: HFConfigModalProps) {
  const [source, setSource] = useState<'hf' | 'local'>('hf');
  const [hfRepo, setHfRepo] = useState('');
  const [hfToken, setHfToken] = useState('');
  const [ghRepo, setGhRepo] = useState('');
  const [ghToken, setGhToken] = useState('');
  const [engineUrl, setEngineUrl] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const current = getHFConfig();
      setSource(current.source);
      setHfRepo(current.hfRepo);
      setHfToken(current.hfToken);
      setGhRepo(current.ghRepo);
      setGhToken(current.ghToken);
      setEngineUrl(current.engineUrl);
    }
  }, [isOpen]);

  const handleSave = () => {
    saveHFConfig({
      source,
      hfRepo,
      hfToken,
      ghRepo,
      ghToken,
      engineUrl,
    });
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
      onRefreshCatalog();
    }, 500);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Cloud Storage, Search & Pipeline Settings">
      <div className="space-y-5">
        <div>
          <label className="text-xs font-semibold text-muted uppercase tracking-wider block mb-2">
            Storage Provider
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setSource('local')}
              className={`p-3 rounded-xl border flex items-center gap-3 transition-all ${
                source === 'local'
                  ? 'bg-indigo-600/15 border-indigo-500 text-main font-medium shadow-sm'
                  : 'bg-white/5 border-subtle text-muted hover:border-strong'
              }`}
            >
              <Database className="w-5 h-5 text-indigo-400" />
              <div className="text-left">
                <div className="text-sm font-semibold">Local Storage</div>
                <div className="text-[11px] text-muted">Direct files from public/data</div>
              </div>
            </button>

            <button
              onClick={() => setSource('hf')}
              className={`p-3 rounded-xl border flex items-center gap-3 transition-all ${
                source === 'hf'
                  ? 'bg-indigo-600/15 border-indigo-500 text-main font-medium shadow-sm'
                  : 'bg-white/5 border-subtle text-muted hover:border-strong'
              }`}
            >
              <Cloud className="w-5 h-5 text-indigo-400" />
              <div className="text-left">
                <div className="text-sm font-semibold">Hugging Face CDN</div>
                <div className="text-[11px] text-muted">HTTP 206 Streaming + Arctic Index</div>
              </div>
            </button>
          </div>
        </div>

        {source === 'hf' && (
          <div className="space-y-3.5 animate-fade-in">
            <div>
              <label className="text-xs font-semibold text-muted uppercase tracking-wider block mb-1">
                Hugging Face Dataset Repository
              </label>
              <input
                type="text"
                value={hfRepo}
                onChange={(e) => setHfRepo(e.target.value)}
                placeholder="learner20011/CloverTexts-Data"
                className="w-full px-3.5 py-2 rounded-xl bg-white/5 border border-subtle focus:border-indigo-500 text-main text-sm outline-none"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted uppercase tracking-wider block mb-1 flex items-center justify-between">
                <span>HF Write Token (For Online Mobile/Web Book Uploads)</span>
                <span className="text-[11px] text-dim lowercase font-normal">Saved locally only</span>
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={hfToken}
                  onChange={(e) => setHfToken(e.target.value)}
                  placeholder="hf_..."
                  className="w-full px-3.5 py-2 pl-9 rounded-xl bg-white/5 border border-subtle focus:border-indigo-500 text-main text-sm outline-none"
                />
                <Key className="w-4 h-4 text-dim absolute left-3 top-2.5" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label className="text-[11px] font-semibold text-muted uppercase tracking-wider block mb-1 flex items-center gap-1">
                  <Github className="w-3.5 h-3.5" />
                  <span>GitHub Actions Repo</span>
                </label>
                <input
                  type="text"
                  value={ghRepo}
                  onChange={(e) => setGhRepo(e.target.value)}
                  placeholder="rahathasan452/clover"
                  className="w-full px-3 py-2 rounded-xl bg-white/5 border border-subtle focus:border-indigo-500 text-main text-xs outline-none"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-muted uppercase tracking-wider block mb-1">
                  GitHub PAT (Optional Instant Dispatch)
                </label>
                <input
                  type="password"
                  value={ghToken}
                  onChange={(e) => setGhToken(e.target.value)}
                  placeholder="github_pat_... (optional)"
                  className="w-full px-3 py-2 rounded-xl bg-white/5 border border-subtle focus:border-indigo-500 text-main text-xs outline-none"
                />
              </div>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-muted uppercase tracking-wider block mb-1 flex items-center gap-1">
                <Cpu className="w-3.5 h-3.5 text-sky-400" />
                <span>Custom Cloud Engine URL (Optional Self-Hosted / HF PRO Space)</span>
              </label>
              <input
                type="text"
                value={engineUrl}
                onChange={(e) => setEngineUrl(e.target.value)}
                placeholder="Leave blank to use $0 Serverless HF Arctic + Reranker Index"
                className="w-full px-3 py-2 rounded-xl bg-white/5 border border-subtle focus:border-indigo-500 text-main text-xs outline-none"
              />
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-subtle">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-muted hover:text-main hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold flex items-center gap-2 shadow-lg shadow-indigo-600/30 transition-all"
          >
            {saved ? <Check className="w-4 h-4" /> : <RefreshCw className="w-4 h-4" />}
            <span>{saved ? 'Saved!' : 'Save & Reload'}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
