import React, { useState, useEffect } from 'react';
import { Cloud, Check, Key, Database, RefreshCw, Info } from 'lucide-react';
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
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const current = getHFConfig();
      setSource(current.source);
      setHfRepo(current.hfRepo);
      setHfToken(current.hfToken);
    }
  }, [isOpen]);

  const handleSave = () => {
    saveHFConfig({
      source,
      hfRepo,
      hfToken,
    });
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
      onRefreshCatalog();
    }, 500);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Cloud Storage & Dataset Settings">
      <div className="space-y-5">
        <div>
          <label className="text-xs font-semibold text-muted uppercase tracking-wider block mb-2">
            Storage Provider
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setSource('local')}
              className={`p-3.5 rounded-xl border flex items-center gap-3 transition-all ${
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
              className={`p-3.5 rounded-xl border flex items-center gap-3 transition-all ${
                source === 'hf'
                  ? 'bg-indigo-600/15 border-indigo-500 text-main font-medium shadow-sm'
                  : 'bg-white/5 border-subtle text-muted hover:border-strong'
              }`}
            >
              <Cloud className="w-5 h-5 text-indigo-400" />
              <div className="text-left">
                <div className="text-sm font-semibold">Hugging Face Dataset CDN</div>
                <div className="text-[11px] text-muted">Online reading & hybrid search</div>
              </div>
            </button>
          </div>
        </div>

        {source === 'hf' && (
          <div className="space-y-4 animate-fade-in">
            <div>
              <label className="text-xs font-semibold text-muted uppercase tracking-wider block mb-1.5">
                Hugging Face Dataset Repository
              </label>
              <input
                type="text"
                value={hfRepo}
                onChange={(e) => setHfRepo(e.target.value)}
                placeholder="learner20011/CloverTexts-Data"
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-subtle focus:border-indigo-500 text-main text-sm outline-none"
              />
              <p className="text-[11px] text-dim mt-1">
                Streams linearized PDFs & pre-built Arctic hybrid search index from:{' '}
                <code className="text-indigo-400 font-mono">
                  https://huggingface.co/datasets/{hfRepo || '<repo>'}/resolve/main/
                </code>
              </p>
            </div>

            <div>
              <label className="text-xs font-semibold text-muted uppercase tracking-wider block mb-1.5 flex items-center justify-between">
                <span>HF Read Token (Optional)</span>
                <span className="text-[11px] text-dim lowercase font-normal">
                  Only needed if dataset is private
                </span>
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={hfToken}
                  onChange={(e) => setHfToken(e.target.value)}
                  placeholder="hf_..."
                  className="w-full px-4 py-2.5 pl-10 rounded-xl bg-white/5 border border-subtle focus:border-indigo-500 text-main text-sm outline-none"
                />
                <Key className="w-4 h-4 text-dim absolute left-3.5 top-3" />
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex gap-3 text-xs text-indigo-300">
              <Info className="w-4 h-4 shrink-0 text-indigo-400 mt-0.5" />
              <div>
                To add new books locally (Marker OCR + Linearization + Arctic Vectors + 1-click HF upload), run on your PC:
                <div className="mt-1.5 font-mono text-[11px] bg-black/40 p-2 rounded border border-white/10 text-indigo-200">
                  npm run studio
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-4 border-t border-subtle">
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
