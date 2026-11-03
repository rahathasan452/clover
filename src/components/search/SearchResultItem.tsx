import React from 'react';
import { SearchHit } from '../../types/search';
import { HighlightedText } from '../../utils/textSnippet';
import { Target, ChevronRight, Sparkles, Type } from 'lucide-react';

interface SearchResultItemProps {
  hit: SearchHit;
  query: string;
  onSelectHit: (hit: SearchHit) => void;
}

export function SearchResultItem({ hit, query, onSelectHit }: SearchResultItemProps) {
  return (
    <div
      onClick={() => onSelectHit(hit)}
      className="group p-3.5 rounded-xl bg-white/5 hover:bg-sky-600/15 border border-subtle hover:border-sky-500/50 transition-all cursor-pointer space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="px-2 py-0.5 rounded-md bg-sky-500/20 text-sky-300 font-mono text-xs font-semibold border border-sky-500/35">
            Page {hit.page}
          </span>

          {/* Match Engine Source Pill */}
          {hit.matchSource === 'hybrid' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-500/20 text-violet-300 border border-violet-500/35 text-[10px] font-semibold">
              <Sparkles className="w-2.5 h-2.5 text-violet-300" />
              Hybrid{hit.semanticScore ? ` • ${hit.semanticScore}%` : ''}
            </span>
          )}
          {hit.matchSource === 'semantic' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/35 text-[10px] font-semibold">
              <Sparkles className="w-2.5 h-2.5 text-emerald-300" />
              Semantic{hit.semanticScore ? ` ${hit.semanticScore}%` : ''}
            </span>
          )}
          {(!hit.matchSource || hit.matchSource === 'keyword') && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-semibold">
              <Type className="w-2.5 h-2.5 text-amber-300" />
              BM25
            </span>
          )}

          {hit.bboxes.length > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-sky-400 font-mono">
              <Target className="w-3 h-3 text-sky-400" />
              {hit.bboxes.length} BBox {hit.bboxes.length === 1 ? 'hit' : 'hits'}
            </span>
          )}
        </div>

        <div className="flex items-center text-xs text-muted group-hover:text-sky-400 font-medium transition-colors">
          <span>Jump to page</span>
          <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </div>
      </div>

      <p className="text-xs text-muted leading-relaxed font-sans line-clamp-3 group-hover:text-main transition-colors">
        <HighlightedText text={hit.snippet} query={query} />
      </p>
    </div>
  );
}
