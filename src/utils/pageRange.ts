/**
 * Parses user input strings like "1-3, 5, 8-10, 15" into a deduplicated, sorted array of page numbers.
 * Clamps all page numbers between 1 and totalPages.
 */
export function parsePageRange(input: string, totalPages: number): number[] {
  if (!input || !input.trim()) return [];

  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'all') {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pageSet = new Set<number>();
  const parts = trimmed.split(/[,;\s]+/);

  for (const part of parts) {
    if (!part) continue;

    // Check for range like "1-5" or "1..5" or "1:5"
    const rangeMatch = part.match(/^(\d+)[\-\.\:]+(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (!isNaN(start) && !isNaN(end)) {
        const min = Math.max(1, Math.min(start, end));
        const max = Math.min(totalPages, Math.max(start, end));
        for (let p = min; p <= max; p++) {
          pageSet.add(p);
        }
      }
      continue;
    }

    // Check for single number like "4" or "p4" or "p.4"
    const singleMatch = part.match(/^(?:p\.?)?(\d+)$/);
    if (singleMatch) {
      const num = parseInt(singleMatch[1], 10);
      if (!isNaN(num) && num >= 1 && num <= totalPages) {
        pageSet.add(num);
      }
    }
  }

  return Array.from(pageSet).sort((a, b) => a - b);
}

/**
 * Formats a sorted list of page numbers into human-readable compact ranges.
 * e.g., [1, 2, 3, 5, 8, 9, 10] -> "1-3, 5, 8-10"
 */
export function formatPageList(pages: number[]): string {
  if (!pages || pages.length === 0) return '';
  const sorted = Array.from(new Set(pages)).sort((a, b) => a - b);

  const ranges: string[] = [];
  let rangeStart = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    if (curr === prev + 1) {
      prev = curr;
    } else {
      if (rangeStart === prev) {
        ranges.push(`${rangeStart}`);
      } else if (prev === rangeStart + 1) {
        ranges.push(`${rangeStart}, ${prev}`);
      } else {
        ranges.push(`${rangeStart}-${prev}`);
      }
      rangeStart = curr;
      prev = curr;
    }
  }

  if (rangeStart === prev) {
    ranges.push(`${rangeStart}`);
  } else if (prev === rangeStart + 1) {
    ranges.push(`${rangeStart}, ${prev}`);
  } else {
    ranges.push(`${rangeStart}-${prev}`);
  }

  return ranges.join(', ');
}
