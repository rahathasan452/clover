import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  Plus,
  Tag as TagIcon,
  FolderPlus,
  CheckCircle2,
  Loader2,
  BookOpen,
  Cloud,
  HardDrive,
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { Book } from '../../types/book';
import { resolveAssetUrl } from '../../services/hfStorage';

interface EditBookModalProps {
  isOpen: boolean;
  onClose: () => void;
  book: Book | null;
  allCategories?: string[];
  allKnownTags?: string[];
  onSave: (
    bookId: string,
    updates: {
      title: string;
      author: string;
      category: string;
      tags: string[];
      description?: string;
    }
  ) => Promise<{ success: boolean; syncedToDisk: boolean; syncedToHf: boolean }>;
}

const CUSTOM_CATS_STORAGE = 'clover_studio_custom_categories';

export function EditBookModal({
  isOpen,
  onClose,
  book,
  allCategories = [],
  allKnownTags = [],
  onSave,
}: EditBookModalProps) {
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [description, setDescription] = useState('');

  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [customTagInput, setCustomTagInput] = useState('');

  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<{
    type: 'success' | 'error';
    msg: string;
  } | null>(null);

  // Sync state whenever the target book changes
  useEffect(() => {
    if (book && isOpen) {
      setTitle(book.title || '');
      setAuthor(book.author || '');
      setCategory(book.category || 'Trading');
      setTags(Array.isArray(book.tags) ? [...book.tags] : []);
      setDescription(book.description || '');
      setIsCreatingCategory(false);
      setNewCategoryInput('');
      setCustomTagInput('');
      setNotice(null);
    }
  }, [book, isOpen]);

  // Combine known categories with any locally created custom categories
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allCategories) if (c?.trim()) set.add(c.trim());
    try {
      const stored: string[] = JSON.parse(
        localStorage.getItem(CUSTOM_CATS_STORAGE) || '[]'
      );
      for (const c of stored) if (c?.trim()) set.add(c.trim());
    } catch {}
    if (category?.trim()) set.add(category.trim());
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allCategories, category]);

  if (!book) return null;

  const handleToggleTag = (tag: string) => {
    const clean = tag.trim();
    if (!clean) return;
    setTags((prev) =>
      prev.includes(clean) ? prev.filter((t) => t !== clean) : [...prev, clean]
    );
  };

  const handleAddCustomTag = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = customTagInput.trim();
    if (clean && !tags.includes(clean)) {
      setTags((prev) => [...prev, clean]);
    }
    setCustomTagInput('');
  };

  const handleCreateCategory = () => {
    const clean = newCategoryInput.trim();
    if (clean) {
      setCategory(clean);
      try {
        const stored: string[] = JSON.parse(
          localStorage.getItem(CUSTOM_CATS_STORAGE) || '[]'
        );
        if (!stored.includes(clean)) {
          localStorage.setItem(
            CUSTOM_CATS_STORAGE,
            JSON.stringify([...stored, clean])
          );
        }
      } catch {}
    }
    setIsCreatingCategory(false);
    setNewCategoryInput('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setIsSaving(true);
    setNotice(null);

    try {
      const result = await onSave(book.id, {
        title: title.trim(),
        author: author.trim() || 'Unknown Author',
        category: category.trim() || 'Uncategorized',
        tags: tags.length > 0 ? tags : [category.trim() || 'General'],
        description: description.trim(),
      });

      if (result.syncedToDisk && result.syncedToHf) {
        setNotice({
          type: 'success',
          msg: 'Updated catalog.json on disk & synced to Hugging Face cloud!',
        });
      } else if (result.syncedToDisk) {
        setNotice({
          type: 'success',
          msg: 'Updated catalog.json & search index on disk!',
        });
      } else {
        setNotice({
          type: 'success',
          msg: 'Saved changes to library!',
        });
      }

      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err: any) {
      setNotice({
        type: 'error',
        msg: err?.message || 'Failed to update book metadata',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const coverUrl = resolveAssetUrl(book.coverUrl);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Edit Book Details"
      maxWidth="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4 p-1">
        {/* Book Header Card */}
        <div className="flex items-center gap-3.5 p-3 rounded-2xl bg-surface/70 border border-subtle">
          <div className="w-12 h-16 rounded-lg overflow-hidden bg-black/20 shrink-0 border border-subtle">
            <img
              src={coverUrl}
              alt={book.title}
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLElement).style.display = 'none';
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-main truncate leading-snug">
              {book.title}
            </h4>
            <p className="text-xs text-muted truncate">{book.author}</p>
            <div className="flex items-center gap-2 mt-1 text-[11px] font-mono text-dim">
              <span>{book.totalPages} pages</span>
              <span>•</span>
              <span className="truncate">id: {book.id}</span>
            </div>
          </div>
        </div>

        {/* Title Input */}
        <div>
          <label className="text-[11px] font-semibold text-muted uppercase tracking-wider block mb-1">
            Book Title
          </label>
          <input
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter book title..."
            className="w-full px-3 py-2 rounded-xl bg-black/25 border border-subtle text-xs font-semibold text-main outline-none focus:border-sky-500 transition-colors"
          />
        </div>

        {/* Author Input */}
        <div>
          <label className="text-[11px] font-semibold text-muted uppercase tracking-wider block mb-1">
            Author
          </label>
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Author name..."
            className="w-full px-3 py-2 rounded-xl bg-black/25 border border-subtle text-xs text-main outline-none focus:border-sky-500 transition-colors"
          />
        </div>

        {/* Category Selector + Creator */}
        <div>
          <label className="text-[11px] font-semibold text-muted uppercase tracking-wider block mb-1">
            Category
          </label>
          {isCreatingCategory ? (
            <div className="flex items-center gap-1.5 animate-fadeIn">
              <FolderPlus className="w-4 h-4 text-emerald-400 shrink-0" />
              <input
                type="text"
                autoFocus
                value={newCategoryInput}
                onChange={(e) => setNewCategoryInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleCreateCategory();
                  } else if (e.key === 'Escape') {
                    setIsCreatingCategory(false);
                  }
                }}
                placeholder="New category name (e.g. Economics)..."
                className="flex-1 px-3 py-2 rounded-xl bg-black/35 border border-emerald-500/50 text-xs text-main outline-none focus:border-emerald-400"
              />
              <button
                type="button"
                onClick={handleCreateCategory}
                className="px-3 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition-colors"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => setIsCreatingCategory(false)}
                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-muted"
                title="Cancel"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <select
                value={category}
                onChange={(e) => {
                  if (e.target.value === '__NEW__') {
                    setIsCreatingCategory(true);
                  } else {
                    setCategory(e.target.value);
                  }
                }}
                className="flex-1 px-3 py-2 rounded-xl bg-black/25 border border-subtle text-xs font-semibold text-sky-300 outline-none focus:border-sky-500"
              >
                {categoryOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value="__NEW__" className="text-emerald-400 font-bold">
                  + Create New Category...
                </option>
              </select>
              <button
                type="button"
                onClick={() => setIsCreatingCategory(true)}
                className="px-2.5 py-2 rounded-xl bg-surface hover:bg-surface-elevated text-dim hover:text-emerald-300 border border-subtle text-xs font-semibold flex items-center gap-1 transition-colors"
                title="Create a new custom category"
              >
                <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
                <span>New</span>
              </button>
            </div>
          )}
        </div>

        {/* Tags Section */}
        <div>
          <label className="text-[11px] font-semibold text-muted uppercase tracking-wider block mb-1.5">
            Tags
          </label>
          <div className="p-3 rounded-2xl bg-black/20 border border-subtle space-y-2.5">
            {/* Active Tag Pills */}
            <div className="flex flex-wrap items-center gap-1.5 min-h-[28px]">
              <TagIcon className="w-3.5 h-3.5 text-sky-400 mr-0.5 shrink-0" />
              {tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => handleToggleTag(t)}
                  className="px-2.5 py-1 rounded-lg bg-sky-500 text-slate-950 font-bold text-[11px] flex items-center gap-1 hover:bg-sky-400 transition-colors shadow-xs"
                >
                  <span>{t}</span>
                  <X className="w-2.5 h-2.5" />
                </button>
              ))}

              {/* Add Custom Tag Form */}
              <div className="inline-flex items-center">
                <input
                  type="text"
                  value={customTagInput}
                  onChange={(e) => setCustomTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddCustomTag(e);
                    }
                  }}
                  placeholder="+ Custom tag..."
                  className="w-28 px-2 py-0.5 rounded-lg bg-black/35 border border-subtle text-[11px] text-main outline-none focus:border-sky-500"
                />
              </div>
            </div>

            {/* Suggested / Available Tags Pool */}
            {allKnownTags.length > 0 && (
              <div className="pt-2 border-t border-subtle/50 flex flex-wrap items-center gap-1">
                <span className="text-[10px] text-dim font-medium mr-1">Suggested:</span>
                {allKnownTags
                  .filter((t) => !tags.includes(t))
                  .slice(0, 10)
                  .map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => handleToggleTag(t)}
                      className="px-2 py-0.5 rounded-lg bg-white/5 hover:bg-white/10 text-muted hover:text-main text-[11px] border border-subtle flex items-center gap-1 transition-colors"
                    >
                      <Plus className="w-2.5 h-2.5 text-sky-400" />
                      <span>{t}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* Description / Notes */}
        <div>
          <label className="text-[11px] font-semibold text-muted uppercase tracking-wider block mb-1">
            Description / Reading Notes <span className="text-dim text-[10px] lowercase">(optional)</span>
          </label>
          <textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Key concepts, synopsis, or custom notes for this book..."
            className="w-full px-3 py-2 rounded-xl bg-black/25 border border-subtle text-xs text-main outline-none focus:border-sky-500 resize-none transition-colors"
          />
        </div>

        {/* Notice Banner */}
        {notice && (
          <div
            className={`p-2.5 rounded-xl text-xs flex items-center gap-2 ${
              notice.type === 'success'
                ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-medium'
                : 'bg-rose-500/15 border border-rose-500/30 text-rose-300 font-medium'
            }`}
          >
            {notice.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <X className="w-4 h-4 text-rose-400 shrink-0" />
            )}
            <span>{notice.msg}</span>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-subtle">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-2 rounded-xl bg-surface hover:bg-surface-elevated text-muted hover:text-main border border-subtle text-xs font-semibold transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving || !title.trim()}
            className="px-5 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-sky-500/25 transition-all"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Saving...</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Save Changes</span>
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
