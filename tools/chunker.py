#!/usr/bin/env python3
"""
Obsidian Seek-Grade Smart Contextual Passage Chunker for Marker & PyMuPDF Layouts
---------------------------------------------------------------------------------
1. Skips Marker-classified `PageHeader` / `PageFooter` blocks + repeating margin boilerplate.
2. Preserves Marker's deep-learning reading order (or 2-column sort for PyMuPDF blocks).
3. Coalesces blocks into coherent ~850-1,350 char semantic passages with 1-block overlap
   so sentences, tables, and LaTeX equations stay intact.
4. Injects hierarchical `[Book: Title | Topic: Category | Chapter: Section]` breadcrumbs
   (from both PDF TOC and Marker's `section_hierarchy`) into `embedText` while keeping
   exact normalized `[x0, y0, x1, y1]` bounding boxes for PDF highlights!
"""

import re
from collections import Counter
from typing import Dict, List, Any, Tuple, Set

SKIP_MARKER_TYPES = {"pageheader", "pagefooter", "picture", "figure"}


def _normalize_boilerplate_text(text: str) -> str:
    s = re.sub(r"\d+", "", text.lower())
    s = re.sub(r"[^a-z]+", " ", s).strip()
    return s


def detect_repeating_boilerplate(pages: List[Dict[str, Any]]) -> Set[str]:
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
            for deeper in list(active_levels.keys()):
                if deeper > lvl:
                    del active_levels[deeper]
            toc_idx += 1

        if active_levels:
            crumbs = [active_levels[k] for k in sorted(active_levels.keys())]
            page_map[p] = " > ".join(crumbs[-3:])

    return page_map


def _block_geometry(block: Dict[str, Any]) -> Tuple[float, float, float, float]:
    if isinstance(block.get("bbox"), list) and len(block["bbox"]) == 4:
        b = block["bbox"]
        return (float(b[0]), float(b[1]), float(b[2]), float(b[3]))
    words = block.get("words") or []
    coords = [w["b"] for w in words if isinstance(w.get("b"), list) and len(w["b"]) == 4]
    if not coords:
        return (0.0, 0.0, 1.0, 1.0)
    return (
        min(c[0] for c in coords),
        min(c[1] for c in coords),
        max(c[2] for c in coords),
        max(c[3] for c in coords),
    )


def sort_blocks_reading_order(blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    # If extracted by Marker, blocks are already ordered by Surya deep-learning reading order!
    if any(str(b.get("id", "")).startswith("mk_") for b in blocks):
        return blocks

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

    if left_col >= 2 and right_col >= 2:
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
    active_marker_section = ""

    for page_obj in pages:
        page_num = int(page_obj.get("page", 1))
        raw_blocks = page_obj.get("blocks") or []
        if not raw_blocks:
            continue

        ordered = sort_blocks_reading_order(raw_blocks)
        clean_blocks: List[Dict[str, Any]] = []

        for b in ordered:
            b_type = str(b.get("type") or "").lower().replace("_", "")
            if b_type in SKIP_MARKER_TYPES:
                continue

            txt = re.sub(r"\s+", " ", (b.get("text") or "")).strip()
            if len(txt) < 2:
                continue
            if txt.isdigit() and len(txt) <= 4:
                continue

            if b_type == "sectionheader" and 3 <= len(txt) <= 140:
                active_marker_section = txt

            if b.get("section"):
                active_marker_section = str(b["section"]).strip()

            _, y0, _, y1 = _block_geometry(b)
            if (y0 < 0.09 or y1 > 0.89) and len(txt) <= 120:
                if _normalize_boilerplate_text(txt) in boilerplate_set:
                    continue

            clean_blocks.append(
                {
                    "text": txt,
                    "words": b.get("words") or [],
                    "section": active_marker_section,
                }
            )

        if not clean_blocks:
            continue

        toc_section = toc_map.get(page_num, "")
        chunk_idx = 0
        cur_texts: List[str] = []
        cur_words: List[Dict[str, Any]] = []
        cur_len = 0
        cur_sec = toc_section or active_marker_section

        def flush_passage():
            nonlocal chunk_idx, cur_texts, cur_words, cur_len
            merged_text = " ".join(cur_texts).strip()
            merged_text = re.sub(r"(\w)-\s+([a-z])", r"\1\2", merged_text)
            if len(merged_text) < 18:
                return

            section_label = toc_section or cur_sec
            header_parts = [f"Book: {title}"]
            if category and category != "Uncategorized":
                header_parts.append(f"Topic: {category} ({tags_str})")
            if section_label:
                header_parts.append(f"Chapter: {section_label}")
            context_prefix = " | ".join(header_parts)
            embed_text = f"[{context_prefix}]\n{merged_text}"

            passages.append(
                {
                    "id": f"{book_id}_p{page_num}_c{chunk_idx}",
                    "bookId": book_id,
                    "bookTitle": title,
                    "author": author,
                    "category": category,
                    "page": page_num,
                    "section": section_label,
                    "text": merged_text,
                    "embedText": embed_text,
                    "words": cur_words[:450],
                }
            )
            chunk_idx += 1

        for i, blk in enumerate(clean_blocks):
            b_txt = blk["text"]
            b_words = blk["words"]
            if blk.get("section"):
                cur_sec = blk["section"]

            if cur_len > 0 and (
                cur_len + 1 + len(b_txt) > max_chars
                or (
                    cur_len >= target_chars
                    and cur_texts[-1].endswith((".", "!", "?", ".”", '"'))
                )
            ):
                flush_passage()
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

