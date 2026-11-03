#!/usr/bin/env python3
"""
Obsidian Seek-Grade Smart Contextual Passage Chunker for PDF Layouts
--------------------------------------------------------------------
Solves the #1 cause of poor PDF search accuracy:
1. Strips repeating running headers/footers across pages (e.g. chapter footers, draft watermarks).
2. Orders blocks in true reading order (column-aware for 2-column scientific PDFs).
3. Coalesces fragmented PyMuPDF/OCR micro-blocks into coherent ~750-1,250 char semantic passages
   with 1-block sliding overlap so sentences split across blocks stay intact.
4. Injects hierarchical `[Book Title > TOC Chapter > Section]` breadcrumbs into the embedding text
   while preserving exact word-level `[x0, y0, x1, y1]` bounding boxes for sub-pixel PDF highlights!
"""

import re
from collections import Counter
from typing import Dict, List, Any, Tuple, Set


def _normalize_boilerplate_text(text: str) -> str:
    # Remove page numbers and punctuation to catch repeating headers/footers
    s = re.sub(r"\d+", "", text.lower())
    s = re.sub(r"[^a-z]+", " ", s).strip()
    return s


def detect_repeating_boilerplate(pages: List[Dict[str, Any]]) -> Set[str]:
    """
    Finds short running headers/footers near top (y < 0.085) or bottom (y > 0.90)
    that repeat across >= 4 pages in the same book.
    """
    counts: Counter = Counter()
    for p in pages:
        seen_on_page: Set[str] = set()
        for b in p.get("blocks", []):
            txt = (b.get("text") or "").strip()
            if not txt or len(txt) > 120:
                continue
            words = b.get("words") or []
            if words:
                y0 = min((w["b"][1] for w in words if "b" in w), default=0.5)
                y1 = max((w["b"][3] for w in words if "b" in w), default=0.5)
                if not (y0 < 0.09 or y1 > 0.89):
                    continue
            norm = _normalize_boilerplate_text(txt)
            if len(norm) >= 5 and norm not in seen_on_page:
                seen_on_page.add(norm)
                counts[norm] += 1

    min_repeats = max(4, min(8, len(pages) // 12)) if len(pages) >= 12 else 4
    return {norm for norm, c in counts.items() if c >= min_repeats}


def build_page_toc_breadcrumbs(
    toc: List[Dict[str, Any]], total_pages: int
) -> Dict[int, str]:
    """
    Maps every page number `1..total_pages` to its active hierarchical TOC path,
    e.g. `Part I: Market Structure > Chapter 3: Pullbacks`.
    """
    if not toc:
        return {}

    sorted_toc = sorted(
        [t for t in toc if isinstance(t.get("page"), int) and t.get("title")],
        key=lambda x: x["page"],
    )
    if not sorted_toc:
        return {}

    page_map: Dict[int, str] = {}
    active_levels: Dict[int, str] = {}
    toc_idx = 0

    for p in range(1, max(total_pages, 1) + 1):
        while toc_idx < len(sorted_toc) and sorted_toc[toc_idx]["page"] <= p:
            entry = sorted_toc[toc_idx]
            lvl = max(1, min(4, int(entry.get("level", 1))))
            title = re.sub(r"\s+", " ", str(entry["title"])).strip()
            active_levels[lvl] = title
            # Clear deeper levels when a higher section changes
            for deeper in list(active_levels.keys()):
                if deeper > lvl:
                    del active_levels[deeper]
            toc_idx += 1

        if active_levels:
            crumbs = [active_levels[k] for k in sorted(active_levels.keys())]
            page_map[p] = " > ".join(crumbs[-3:])

    return page_map


def _block_geometry(block: Dict[str, Any]) -> Tuple[float, float, float, float]:
    words = block.get("words") or []
    coords = [w["b"] for w in words if isinstance(w.get("b"), list) and len(w["b"]) == 4]
    if not coords:
        return (0.0, 0.0, 1.0, 1.0)
    x0 = min(c[0] for c in coords)
    y0 = min(c[1] for c in coords)
    x1 = max(c[2] for c in coords)
    y1 = max(c[3] for c in coords)
    return (x0, y0, x1, y1)


def sort_blocks_reading_order(blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Sorts blocks on a page in natural reading order, handling both single-column
    and 2-column textbook/paper layouts cleanly.
    """
    if len(blocks) <= 2:
        return blocks

    enriched = []
    left_col = 0
    right_col = 0
    for b in blocks:
        x0, y0, x1, y1 = _block_geometry(b)
        width = x1 - x0
        if x1 <= 0.52 and width < 0.46:
            left_col += 1
        elif x0 >= 0.48 and width < 0.46:
            right_col += 1
        enriched.append((b, x0, y0, x1, y1))

    is_two_column = left_col >= 2 and right_col >= 2

    if is_two_column:
        # Full-width top banners first, then left column top-to-bottom, then right column top-to-bottom
        def col_key(item):
            _, x0, y0, x1, _ = item
            w = x1 - x0
            if w > 0.62 and y0 < 0.2:
                col = 0
            elif (x0 + x1) / 2.0 < 0.5:
                col = 1
            else:
                col = 2
            return (col, round(y0, 3), round(x0, 3))

        enriched.sort(key=col_key)
    else:
        enriched.sort(key=lambda item: (round(item[2], 3), round(item[1], 3)))

    return [item[0] for item in enriched]


def build_contextual_passages(
    book_meta: Dict[str, Any],
    book_layout: Dict[str, Any],
    target_chars: int = 950,
    max_chars: int = 1450,
) -> List[Dict[str, Any]]:
    """
    Converts fragmented raw PDF page blocks into rich, self-contained contextual passages.
    Each returned dict has:
      - `id`: unique passage ID (`{book_id}_p{page}_c{idx}`)
      - `bookId`, `bookTitle`, `author`, `category`, `page`, `section`
      - `text`: clean merged passage text for display & BM25
      - `embedText`: `[Book: Title | Category: Cat | Section: Breadcrumb]\\n{text}` for Granite embedding
      - `words`: merged list of `{ "w": word, "b": [x0, y0, x1, y1] }` for exact PDF BBox highlighting
    """
    book_id = book_meta.get("id") or book_layout.get("bookId") or "book"
    title = book_meta.get("title") or book_layout.get("title") or book_id
    author = book_meta.get("author") or book_layout.get("author") or "Unknown"
    category = book_meta.get("category") or "Uncategorized"
    tags = book_meta.get("tags") or []
    toc = book_meta.get("toc") or []
    pages = book_layout.get("pages") or []
    total_pages = book_meta.get("totalPages") or book_layout.get("totalPages") or len(pages)

    boilerplate_set = detect_repeating_boilerplate(pages)
    toc_map = build_page_toc_breadcrumbs(toc, total_pages)

    passages: List[Dict[str, Any]] = []
    tags_str = ", ".join(tags[:5]) if tags else category

    for page_obj in pages:
        page_num = int(page_obj.get("page", 1))
        raw_blocks = page_obj.get("blocks") or []
        if not raw_blocks:
            continue

        ordered = sort_blocks_reading_order(raw_blocks)

        # Filter out repeating margin boilerplate & 1-char noise
        clean_blocks: List[Dict[str, Any]] = []
        for b in ordered:
            txt = re.sub(r"\s+", " ", (b.get("text") or "")).strip()
            if len(txt) < 2:
                continue
            # Skip standalone page numbers
            if txt.isdigit() and len(txt) <= 4:
                continue
            _, y0, _, y1 = _block_geometry(b)
            if (y0 < 0.09 or y1 > 0.89) and len(txt) <= 120:
                if _normalize_boilerplate_text(txt) in boilerplate_set:
                    continue
            clean_blocks.append({"text": txt, "words": b.get("words") or []})

        if not clean_blocks:
            continue

        section = toc_map.get(page_num, "")
        chunk_idx = 0
        cur_texts: List[str] = []
        cur_words: List[Dict[str, Any]] = []
        cur_len = 0

        def flush_passage():
            nonlocal chunk_idx, cur_texts, cur_words, cur_len
            merged_text = " ".join(cur_texts).strip()
            # Fix hyphenated PDF line-wrap splits like "algo- rithm" -> "algorithm"
            merged_text = re.sub(r"(\w)-\s+([a-z])", r"\1\2", merged_text)
            if len(merged_text) < 18:
                return

            header_parts = [f"Book: {title}"]
            if category and category != "Uncategorized":
                header_parts.append(f"Topic: {category} ({tags_str})")
            if section:
                header_parts.append(f"Chapter: {section}")
            context_prefix = " | ".join(header_parts)
            embed_text = f"[{context_prefix}]\n{merged_text}"

            # Cap stored words per passage to keep SQLite compact while preserving full bbox coverage
            passages.append(
                {
                    "id": f"{book_id}_p{page_num}_c{chunk_idx}",
                    "bookId": book_id,
                    "bookTitle": title,
                    "author": author,
                    "category": category,
                    "page": page_num,
                    "section": section,
                    "text": merged_text,
                    "embedText": embed_text,
                    "words": cur_words[:450],
                }
            )
            chunk_idx += 1

        for i, blk in enumerate(clean_blocks):
            b_txt = blk["text"]
            b_words = blk["words"]

            if cur_len > 0 and (cur_len + 1 + len(b_txt) > max_chars or (cur_len >= target_chars and cur_texts[-1].endswith((".", "!", "?", ".”", '"')))):
                flush_passage()
                # Keep 1-block overlap if previous block was short/medium (<320 chars) for seamless context continuity!
                prev_blk = clean_blocks[i - 1]
                if len(prev_blk["text"]) <= 320:
                    cur_texts = [prev_blk["text"]]
                    cur_words = list(prev_blk["words"])
                    cur_len = len(prev_blk["text"])
                else:
                    cur_texts = []
                    cur_words = []
                    cur_len = 0

            cur_texts.append(b_txt)
            cur_words.extend(b_words)
            cur_len += len(b_txt) + 1

        if cur_texts:
            flush_passage()

    return passages

