import React from 'react';

export function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <span>{text}</span>;

  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (tokens.length === 0) return <span>{text}</span>;

  const regex = new RegExp(`(${tokens.join('|')})`, 'gi');
  const parts = text.split(regex);

  return (
    <span>
      {parts.map((part, i) => {
        const isMatch = tokens.some((t) => new RegExp(`^${t}$`, 'i').test(part));
        return isMatch ? (
          <mark
            key={i}
            className="bg-amber-400/35 text-amber-200 dark:text-amber-100 font-semibold px-1 py-0.5 rounded border border-amber-400/50 shadow-sm"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </span>
  );
}
