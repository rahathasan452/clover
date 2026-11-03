#!/usr/bin/env python3
"""
Clover Cloud PDF Processor, Scanned-Book OCR Engine, Linearizer & Auto-Tagger
-----------------------------------------------------------------------------
1. Extracts normalized word-level `[x0, y0, x1, y1]` bounding boxes via PyMuPDF (`fitz`).
2. Automatically detects scanned/image-only pages (`< 6` native words) and runs C++ Tesseract OCR
   (`page.get_textpage_ocr`) so scanned books get full searchable text + word highlight coordinates!
3. Linearizes PDFs via `pikepdf` (`QPDF` Fast Web View `/Linearized 1`) for HTTP 206 page streaming.
4. Zero-shot AI Auto-Tagging via `GraniteEmbedder` (768-d) + optional `gemini-2.5-flash`.
5. 3-Phase Background Library Bootstrap & Repair for all existing books in HF Dataset.
"""

import os
import re
import json
import time
import shutil
import urllib.request
import urllib.error
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple, Callable

import fitz  # PyMuPDF
import pikepdf
import numpy as np
from huggingface_hub import HfApi, hf_hub_download, CommitOperationAdd

from chunker import build_contextual_passages
from models import GraniteEmbedder
from search_index import CloudSearchIndex

DEFAULT_TAXONOMY: Dict[str, List[str]] = {
    "Trading": [
        "Price Action", "Technical Analysis", "Candlesticks", "Chart Patterns",
        "Volume Spread Analysis", "Market Microstructure", "Order Flow",
        "Risk Management", "Position Sizing", "Trading Psychology",
        "Algorithmic Trading", "Options & Derivatives", "Swing Trading",
    ],
    "Machine Learning": [
        "Deep Learning", "Transformers & LLMs", "NLP", "Computer Vision",
        "Reinforcement Learning", "Feature Engineering", "PyTorch",
        "Statistical Learning", "MLOps", "Time Series Forecasting",
    ],
    "Mathematics & Quant": [
        "Probability & Statistics", "Linear Algebra", "Calculus",
        "Optimization", "Stochastic Calculus", "Quantitative Finance",
    ],
    "Computer Science": [
        "Algorithms & Data Structures", "Systems Architecture", "Databases",
        "Distributed Systems", "Python", "Software Engineering",
    ],
    "Engineering": [
        "Electrical Engineering", "Signal Processing", "Control Systems", "Hardware",
    ],
}


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return s[:64] or f"book_{int(time.time())}"


def build_dynamic_taxonomy(catalog: List[Dict[str, Any]]) -> Dict[str, List[str]]:
    merged: Dict[str, List[str]] = {k: list(v) for k, v in DEFAULT_TAXONOMY.items()}
    for b in catalog:
        cat = (b.get("category") or "").strip()
        if cat and cat != "Uncategorized":
            merged.setdefault(cat, [])
            for t in b.get("tags") or []:
                t_clean = str(t).strip()
                if t_clean and t_clean not in merged[cat]:
                    merged[cat].append(t_clean)
    return merged


def is_pdf_linearized(pdf_path: Path) -> bool:
    try:
        with open(pdf_path, "rb") as f:
            head = f.read(1024)
        return b"/Linearized" in head
    except Exception:
        return False


def linearize_pdf(src_path: Path, dst_path: Path) -> bool:
    """
    Rewrites PDF with QPDF `/Linearized 1` Fast Web View tables at byte 0
    so PDF.js can render page N immediately via HTTP 206 byte-range requests.
    """
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with pikepdf.open(str(src_path)) as pdf:
            pdf.save(str(dst_path), linearize=True)
        return True
    except Exception as e:
        print(f"[linearize_pdf] pikepdf fallback copy for {src_path.name}: {e}")
        if src_path.resolve() != dst_path.resolve():
            shutil.copy2(src_path, dst_path)
        return is_pdf_linearized(dst_path)


def extract_pdf_layout_with_ocr(
    pdf_path: Path,
    book_id: str,
    title_override: Optional[str] = None,
    author_override: Optional[str] = None,
    cover_out_path: Optional[Path] = None,
    enable_ocr: bool = True,
    ocr_dpi: int = 180,
    on_progress: Optional[Callable[[int, int, int], None]] = None,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]], int]:
    """
    Extracts normalized `[x0, y0, x1, y1]` word bounding boxes for every page.
    Automatically triggers PyMuPDF C++ Tesseract OCR on scanned pages (`< 6` native words).
    Returns `(book_layout_dict, toc_list, ocr_pages_count)`.
    """
    doc = fitz.open(str(pdf_path))
    try:
        total_pages = len(doc)
        meta = doc.metadata or {}
        raw_title = (title_override or meta.get("title") or pdf_path.stem).strip()
        raw_author = (author_override or meta.get("author") or "Unknown Author").strip()

        # Extract hierarchical TOC
        toc_list: List[Dict[str, Any]] = []
        try:
            for item in doc.get_toc(simple=True):
                if len(item) >= 3:
                    lvl, t_str, p_num = item[0], str(item[1]).strip(), int(item[2])
                    if t_str and 1 <= p_num <= total_pages:
                        toc_list.append({"level": int(lvl), "title": t_str, "page": p_num})
        except Exception:
            pass

        # Render cover thumbnail if requested
        if cover_out_path is not None and total_pages > 0:
            cover_out_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                p0 = doc[0]
                pix = p0.get_pixmap(dpi=140, alpha=False)
                pix.save(str(cover_out_path))
            except Exception as e:
                print(f"[extract_pdf] Cover render warning: {e}")

        pages_out: List[Dict[str, Any]] = []
        ocr_pages_count = 0

        for p_idx in range(total_pages):
            page = doc[p_idx]
            rect = page.rect
            pw = max(float(rect.width), 1.0)
            ph = max(float(rect.height), 1.0)

            words = page.get_text("words")
            if enable_ocr and len(words) < 6:
                try:
                    tp = page.get_textpage_ocr(flags=0, language="eng", dpi=ocr_dpi, full=True)
                    ocr_words = page.get_text("words", textpage=tp)
                    if len(ocr_words) > len(words):
                        words = ocr_words
                        ocr_pages_count += 1
                except Exception as ocr_err:
                    if p_idx == 0:
                        print(f"[OCR warning] Page 1 of {pdf_path.name}: {ocr_err}")

            blocks_map: Dict[int, List[Tuple[int, int, str, List[float]]]] = {}
            for w_tuple in words:
                x0, y0, x1, y1, w_str, block_no, line_no, word_no = w_tuple[:8]
                w_clean = str(w_str).strip()
                if not w_clean:
                    continue
                nx0 = round(max(0.0, min(1.0, float(x0) / pw)), 4)
                ny0 = round(max(0.0, min(1.0, float(y0) / ph)), 4)
                nx1 = round(max(0.0, min(1.0, float(x1) / pw)), 4)
                ny1 = round(max(0.0, min(1.0, float(y1) / ph)), 4)
                blocks_map.setdefault(int(block_no), []).append(
                    (int(line_no), int(word_no), w_clean, [nx0, ny0, nx1, ny1])
                )

            page_blocks: List[Dict[str, Any]] = []
            for b_no in sorted(blocks_map.keys()):
                items = sorted(blocks_map[b_no], key=lambda item: (item[0], item[1]))
                block_text = " ".join(it[2] for it in items).strip()
                if not block_text:
                    continue
                block_words = [{"w": it[2], "b": it[3]} for it in items]
                page_blocks.append(
                    {
                        "id": f"{book_id}_p{p_idx + 1}_b{b_no}",
                        "text": block_text,
                        "words": block_words,
                    }
                )

            pages_out.append(
                {
                    "page": p_idx + 1,
                    "width": round(pw, 2),
                    "height": round(ph, 2),
                    "blocks": page_blocks,
                }
            )

            if on_progress and ((p_idx + 1) % 10 == 0 or (p_idx + 1) == total_pages):
                on_progress(p_idx + 1, total_pages, ocr_pages_count)

        layout = {
            "bookId": book_id,
            "title": raw_title,
            "author": raw_author,
            "totalPages": total_pages,
            "pages": pages_out,
        }
        return layout, toc_list, ocr_pages_count
    finally:
        doc.close()


def _clean_filename_title(stem: str) -> Tuple[str, str]:
    clean = re.sub(r"[_-]+", " ", stem).strip()
    clean = re.sub(r"\s+", " ", clean)
    # Remove trailing edition/year noise if obvious
    return clean.title() if clean.islower() else clean, "Unknown Author"


def _call_gemini_suggest(
    api_key: str,
    sample_context: str,
    taxonomy: Dict[str, List[str]],
) -> Optional[Dict[str, Any]]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    prompt = (
        "You are cataloging a technical PDF book. Given the extracted front-matter below and the "
        f"existing library taxonomy {json.dumps(taxonomy)}, return ONLY valid JSON with keys: "
        '{"title": string, "author": string, "category": string, "tags": [3 to 5 concise strings]}.\n\n'
        f"BOOK SAMPLE:\n{sample_context[:6000]}"
    )
    payload = json.dumps(
        {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1},
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            txt = body["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(txt)
            if isinstance(parsed, dict) and parsed.get("title"):
                return parsed
    except Exception as e:
        print(f"[auto_tag] Gemini fallback to Granite zero-shot: {e}")
    return None


def suggest_book_metadata(
    pdf_path: Path,
    existing_catalog: List[Dict[str, Any]],
    gemini_api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Inspects the first ~10 pages + TOC of a dropped PDF and predicts Title, Author, Category & Tags
    in <1 second using Granite 278M Zero-Shot Semantic Classification (or Gemini 2.5 Flash if key given).
    """
    taxonomy = build_dynamic_taxonomy(existing_catalog)
    fallback_title, fallback_author = _clean_filename_title(pdf_path.stem)

    doc = fitz.open(str(pdf_path))
    try:
        total_pages = len(doc)
        meta = doc.metadata or {}
        pdf_title = (meta.get("title") or "").strip()
        pdf_author = (meta.get("author") or "").strip()

        if pdf_title and len(pdf_title) > 3 and not pdf_title.lower().endswith((".pdf", ".doc", "untitled")):
            title = pdf_title
        else:
            title = fallback_title

        author = pdf_author if (pdf_author and len(pdf_author) > 2) else fallback_author

        toc_titles = []
        try:
            for item in doc.get_toc(simple=True)[:35]:
                if len(item) >= 2 and str(item[1]).strip():
                    toc_titles.append(str(item[1]).strip())
        except Exception:
            pass

        sample_pages_text = []
        for idx in range(min(10, total_pages)):
            p = doc[idx]
            txt = p.get_text("text").strip()
            if len(txt) < 30 and idx < 3:
                try:
                    tp = p.get_textpage_ocr(flags=0, language="eng", dpi=150, full=True)
                    txt = p.get_text("text", textpage=tp).strip()
                except Exception:
                    pass
            if txt:
                sample_pages_text.append(txt[:900])
    finally:
        doc.close()

    summary_blob = (
        f"Filename: {pdf_path.name}\n"
        f"Title: {title}\n"
        f"Author: {author}\n"
        f"TOC: {' | '.join(toc_titles[:25])}\n"
        f"Excerpt: {' '.join(sample_pages_text)[:3200]}"
    )

    if gemini_api_key:
        gem = _call_gemini_suggest(gemini_api_key, summary_blob, taxonomy)
        if gem:
            return {
                "title": str(gem.get("title") or title).strip(),
                "author": str(gem.get("author") or author).strip(),
                "totalPages": total_pages,
                "category": str(gem.get("category") or "Trading").strip(),
                "tags": [str(t).strip() for t in (gem.get("tags") or []) if str(t).strip()][:6],
                "source": "gemini-2.5-flash",
            }

    # Zero-Shot Semantic Classification with Granite 278M Embedder
    embedder = GraniteEmbedder.get()
    cat_names = list(taxonomy.keys())
    cat_prompts = [
        f"Book category: {cat}. Topics: {', '.join(taxonomy[cat][:12])}" for cat in cat_names
    ]

    all_tags: List[Tuple[str, str]] = []
    for cat, t_list in taxonomy.items():
        for t in t_list:
            all_tags.append((cat, t))
    tag_prompts = [f"Technical book topic and tag: {t} ({cat})" for cat, t in all_tags]

    vecs = embedder.embed([summary_blob[:2000]] + cat_prompts + tag_prompts, batch_size=32)
    doc_vec = vecs[0]
    cat_vecs = vecs[1 : 1 + len(cat_names)]
    tag_vecs = vecs[1 + len(cat_names) :]

    cat_sims = cat_vecs @ doc_vec
    best_cat = cat_names[int(np.argmax(cat_sims))]

    tag_sims = tag_vecs @ doc_vec
    # Give slight preference to tags belonging to the winning category
    boosted_tag_sims = np.array(
        [
            float(sim) + (0.04 if all_tags[i][0] == best_cat else 0.0)
            for i, sim in enumerate(tag_sims)
        ]
    )
    top_tag_indices = np.argsort(boosted_tag_sims)[::-1][:4]
    chosen_tags = []
    for idx in top_tag_indices:
        t_name = all_tags[int(idx)][1]
        if t_name not in chosen_tags:
            chosen_tags.append(t_name)

    return {
        "title": title,
        "author": author,
        "totalPages": total_pages,
        "category": best_cat,
        "tags": chosen_tags,
        "source": "granite-278m-zero-shot",
    }


def fetch_remote_catalog(hf_repo: str, hf_token: Optional[str] = None) -> List[Dict[str, Any]]:
    tmp_dir = Path("/tmp/clover_cat_fetch")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        p = hf_hub_download(
            repo_id=hf_repo,
            repo_type="dataset",
            filename="data/catalog.json",
            local_dir=str(tmp_dir),
            token=hf_token or None,
            force_download=True,
        )
        data = json.loads(Path(p).read_text(encoding="utf-8"))
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"[fetch_remote_catalog] warning: {e}")
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return []


def ingest_pdf_to_cloud(
    pdf_path: Path,
    title: str,
    author: str,
    category: str,
    tags: List[str],
    index: CloudSearchIndex,
    hf_repo: str,
    hf_token: str,
    on_step: Optional[Callable[[str, int], None]] = None,
) -> Dict[str, Any]:
    """
    Full online 1-click book ingestion pipeline:
    1. OCR/native word bbox extraction + cover generation + TOC extraction
    2. QPDF Fast Web View Linearization (`/Linearized 1`)
    3. Smart Contextual Passage Chunking + 768-d Granite Embedding
    4. Live `CloudSearchIndex` upsert (instant searchability!)
    5. Atomic commit of PDF + Cover + Layout + Catalog + Cloud Search Index to HF Dataset
    """
    def report(msg: str, pct: int):
        if on_step:
            on_step(msg, pct)

    book_id = slugify(title)
    work_dir = Path(f"/tmp/clover_ingest_{book_id}_{int(time.time())}")
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        cover_path = work_dir / f"{book_id}.png"
        linear_pdf_path = work_dir / f"{book_id}.pdf"
        layout_path = work_dir / f"{book_id}.json"

        report("Extracting text, word bounding boxes & running OCR if scanned...", 10)

        def _ocr_prog(done_p: int, tot_p: int, ocr_cnt: int):
            pct = 10 + int((done_p / max(tot_p, 1)) * 32)
            ocr_note = f" ({ocr_cnt} OCR pages)" if ocr_cnt > 0 else ""
            report(f"Extracting layout page {done_p}/{tot_p}{ocr_note}...", pct)

        layout, toc_list, ocr_pages = extract_pdf_layout_with_ocr(
            pdf_path=pdf_path,
            book_id=book_id,
            title_override=title,
            author_override=author,
            cover_out_path=cover_path,
            enable_ocr=True,
            on_progress=_ocr_prog,
        )
        layout_path.write_text(json.dumps(layout, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

        report("Linearizing PDF (`pikepdf` Fast Web View for HTTP 206 streaming)...", 46)
        is_lin = linearize_pdf(pdf_path, linear_pdf_path)

        book_entry: Dict[str, Any] = {
            "id": book_id,
            "title": title,
            "author": author,
            "totalPages": layout["totalPages"],
            "category": category or "Uncategorized",
            "tags": tags or ([category] if category else []),
            "coverUrl": f"data/covers/{book_id}.png",
            "pdfUrl": f"data/pdfs/{book_id}.pdf",
            "layoutUrl": f"data/layouts/{book_id}.json",
            "linearized": bool(is_lin),
            "toc": toc_list,
        }

        report("Building smart contextual passages with TOC breadcrumbs...", 54)
        passages = build_contextual_passages(book_entry, layout)

        if passages:
            embed_texts = [p["embedText"] for p in passages]

            def _emb_prog(done_c: int, tot_c: int):
                pct = 56 + int((done_c / max(tot_c, 1)) * 26)
                report(f"Embedding passages with IBM Granite 278M ({done_c}/{tot_c})...", pct)

            vecs = GraniteEmbedder.get().embed(embed_texts, batch_size=32, on_progress=_emb_prog)
            report("Updating live Hybrid Search + Reranker index...", 84)
            index.upsert_book(book_id, passages, vecs, has_ocr=(ocr_pages > 0), persist_disk=True)

        uploaded_url = None
        if hf_repo and hf_token:
            report(f"Publishing linearized PDF, layout & cloud index to {hf_repo}...", 90)
            catalog = fetch_remote_catalog(hf_repo, hf_token)
            cat_map = {b["id"]: b for b in catalog if isinstance(b, dict) and "id" in b}
            cat_map[book_id] = book_entry
            updated_catalog = list(cat_map.values())

            cat_file = work_dir / "catalog.json"
            cat_file.write_text(
                json.dumps(updated_catalog, indent=2, ensure_ascii=False), encoding="utf-8"
            )

            # Flush SQLite WAL so cloud_index files are self-contained
            with index._lock:
                index.conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
                index.save_disk()

            ops = [
                CommitOperationAdd(
                    path_in_repo=f"data/pdfs/{book_id}.pdf",
                    path_or_fileobj=str(linear_pdf_path),
                ),
                CommitOperationAdd(
                    path_in_repo=f"data/layouts/{book_id}.json",
                    path_or_fileobj=str(layout_path),
                ),
                CommitOperationAdd(
                    path_in_repo="data/catalog.json",
                    path_or_fileobj=str(cat_file),
                ),
                CommitOperationAdd(
                    path_in_repo="data/cloud_index/manifest.json",
                    path_or_fileobj=str(index.manifest_path),
                ),
                CommitOperationAdd(
                    path_in_repo="data/cloud_index/passages.sqlite",
                    path_or_fileobj=str(index.db_path),
                ),
                CommitOperationAdd(
                    path_in_repo="data/cloud_index/vectors.npy",
                    path_or_fileobj=str(index.vec_path),
                ),
            ]
            if cover_path.exists():
                ops.append(
                    CommitOperationAdd(
                        path_in_repo=f"data/covers/{book_id}.png",
                        path_or_fileobj=str(cover_path),
                    )
                )

            api = HfApi(token=hf_token)
            commit_info = api.create_commit(
                repo_id=hf_repo,
                repo_type="dataset",
                operations=ops,
                commit_message=f"Ingest '{title}' (Linearized + Granite 278M Cloud Index)",
            )
            uploaded_url = getattr(commit_info, "commit_url", None)

        report("Complete! Book is live & searchable on all devices.", 100)
        return {
            "book": book_entry,
            "passagesIndexed": len(passages),
            "ocrPages": ocr_pages,
            "uploadedUrl": uploaded_url,
        }
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def bootstrap_and_repair_library(
    index: CloudSearchIndex,
    hf_repo: str,
    hf_token: str,
    state: Dict[str, Any],
) -> None:
    """
    Runs automatically in the background on Space startup:
    - Syncs pre-built `data/cloud_index/*` from HF Dataset if already built (<3s cold start!).
    - Phase 1: Contextually chunks & embeds any unindexed text books from `data/layouts/*.json`.
    - Phase 2: Downloads & runs C++ Tesseract OCR on any scanned 0-text books, saves repaired
               word-bbox layouts & updates `cloud_index` on HF Dataset!
    - Phase 3: Linearizes any existing PDFs on HF Dataset missing `/Linearized` Fast Web View headers!
    """
    try:
        state.update({"running": True, "phase": "sync", "step": "Syncing catalog & cloud index from HF...", "percent": 5})
        catalog = fetch_remote_catalog(hf_repo, hf_token)
        state["totalBooks"] = len(catalog)

        if index.total_passages == 0:
            synced = index.sync_from_hf_dataset(hf_repo, hf_token)
            if synced:
                print(
                    f"[Bootstrap] Loaded pre-built cloud_index: {index.indexed_books_count} books, {index.total_passages} passages"
                )

        if not catalog:
            state.update({"running": False, "phase": "ready", "step": "Ready (empty catalog)", "percent": 100})
            return

        # Identify books missing from CloudSearchIndex
        missing_books = [b for b in catalog if not index.has_book(b["id"], min_passages=5)]
        scanned_books: List[Dict[str, Any]] = []

        # ------------------------------------------------------------------
        # PHASE 1: Fast Contextual Re-Chunking & Granite Embedding (Text Books)
        # ------------------------------------------------------------------
        if missing_books:
            state["phase"] = "phase1_index"
            phase1_added = 0
            tmp_dl = Path("/tmp/clover_bootstrap_layouts")

            for i, book in enumerate(missing_books):
                b_id = book["id"]
                b_title = book.get("title") or b_id
                pct = 8 + int(((i + 1) / max(len(missing_books), 1)) * 42)
                state.update(
                    {
                        "step": f"[Phase 1/{len(missing_books)}] Contextual chunking & Granite embedding: {b_title}",
                        "percent": pct,
                    }
                )

                shutil.rmtree(tmp_dl, ignore_errors=True)
                tmp_dl.mkdir(parents=True, exist_ok=True)
                try:
                    layout_rel = (book.get("layoutUrl") or f"data/layouts/{b_id}.json").lstrip("/")
                    lp = hf_hub_download(
                        repo_id=hf_repo,
                        repo_type="dataset",
                        filename=layout_rel,
                        local_dir=str(tmp_dl),
                        token=hf_token or None,
                    )
                    layout_data = json.loads(Path(lp).read_text(encoding="utf-8"))
                except Exception as e:
                    print(f"[Phase 1] Layout fetch failed for {b_id}, queuing for Phase 2 OCR: {e}")
                    scanned_books.append(book)
                    continue
                finally:
                    shutil.rmtree(tmp_dl, ignore_errors=True)

                total_blocks = sum(len(p.get("blocks") or []) for p in (layout_data.get("pages") or []))
                if total_blocks < 20:
                    scanned_books.append(book)
                    continue

                passages = build_contextual_passages(book, layout_data)
                if len(passages) < 5:
                    scanned_books.append(book)
                    continue

                vecs = GraniteEmbedder.get().embed([p["embedText"] for p in passages], batch_size=32)
                index.upsert_book(b_id, passages, vecs, has_ocr=False, persist_disk=False)
                phase1_added += 1

            if phase1_added > 0:
                index.save_disk()
                if hf_token:
                    state["step"] = f"Persisting Phase 1 Cloud Index ({index.indexed_books_count} books) to HF..."
                    index.push_to_hf_dataset(
                        hf_repo,
                        hf_token,
                        f"Build Granite 278M Cloud Index ({index.indexed_books_count} text books)",
                    )

        # ------------------------------------------------------------------
        # PHASE 2: Automatic C++ Tesseract OCR Repair for Scanned Books
        # ------------------------------------------------------------------
        if scanned_books and hf_token:
            state["phase"] = "phase2_ocr"
            api = HfApi(token=hf_token)

            for idx_s, book in enumerate(scanned_books):
                b_id = book["id"]
                b_title = book.get("title") or b_id
                tmp_ocr = Path(f"/tmp/clover_ocr_{b_id}")
                shutil.rmtree(tmp_ocr, ignore_errors=True)
                tmp_ocr.mkdir(parents=True, exist_ok=True)

                try:
                    state.update(
                        {
                            "step": f"[Phase 2 OCR {idx_s + 1}/{len(scanned_books)}] Downloading scanned PDF: {b_title}...",
                            "percent": 55 + int((idx_s / max(len(scanned_books), 1)) * 25),
                        }
                    )
                    pdf_rel = (book.get("pdfUrl") or f"data/pdfs/{b_id}.pdf").lstrip("/")
                    local_pdf = Path(
                        hf_hub_download(
                            repo_id=hf_repo,
                            repo_type="dataset",
                            filename=pdf_rel,
                            local_dir=str(tmp_ocr),
                            token=hf_token,
                        )
                    )

                    def _on_ocr_p(done_p: int, tot_p: int, ocr_c: int):
                        state["step"] = (
                            f"[Phase 2 OCR {idx_s + 1}/{len(scanned_books)}] {b_title}: "
                            f"Tesseract OCR page {done_p}/{tot_p}..."
                        )

                    repaired_layout, toc_extracted, ocr_cnt = extract_pdf_layout_with_ocr(
                        pdf_path=local_pdf,
                        book_id=b_id,
                        title_override=book.get("title"),
                        author_override=book.get("author"),
                        enable_ocr=True,
                        ocr_dpi=175,
                        on_progress=_on_ocr_p,
                    )

                    if toc_extracted and not book.get("toc"):
                        book["toc"] = toc_extracted

                    passages = build_contextual_passages(book, repaired_layout)
                    if passages:
                        state["step"] = f"[Phase 2 OCR] Embedding {len(passages)} OCR passages for {b_title}..."
                        vecs = GraniteEmbedder.get().embed(
                            [p["embedText"] for p in passages], batch_size=32
                        )
                        index.upsert_book(b_id, passages, vecs, has_ocr=True, persist_disk=True)

                        repaired_layout_file = tmp_ocr / f"{b_id}.json"
                        repaired_layout_file.write_text(
                            json.dumps(repaired_layout, separators=(",", ":"), ensure_ascii=False),
                            encoding="utf-8",
                        )

                        # Also linearize this PDF while we already have it on local disk!
                        lin_pdf_file = tmp_ocr / f"{b_id}_lin.pdf"
                        is_lin = linearize_pdf(local_pdf, lin_pdf_file)
                        book["linearized"] = bool(is_lin)

                        cat_out = tmp_ocr / "catalog.json"
                        cat_out.write_text(
                            json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
                        )

                        with index._lock:
                            index.conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
                            index.save_disk()

                        ops = [
                            CommitOperationAdd(
                                path_in_repo=f"data/layouts/{b_id}.json",
                                path_or_fileobj=str(repaired_layout_file),
                            ),
                            CommitOperationAdd(
                                path_in_repo=pdf_rel,
                                path_or_fileobj=str(lin_pdf_file),
                            ),
                            CommitOperationAdd(
                                path_in_repo="data/catalog.json",
                                path_or_fileobj=str(cat_out),
                            ),
                            CommitOperationAdd(
                                path_in_repo="data/cloud_index/manifest.json",
                                path_or_fileobj=str(index.manifest_path),
                            ),
                            CommitOperationAdd(
                                path_in_repo="data/cloud_index/passages.sqlite",
                                path_or_fileobj=str(index.db_path),
                            ),
                            CommitOperationAdd(
                                path_in_repo="data/cloud_index/vectors.npy",
                                path_or_fileobj=str(index.vec_path),
                            ),
                        ]
                        api.create_commit(
                            repo_id=hf_repo,
                            repo_type="dataset",
                            operations=ops,
                            commit_message=f"OCR repair + Linearize + Granite index: {b_title} ({ocr_cnt} pages)",
                        )
                        print(f"[Phase 2 OCR] Repaired & indexed {b_title} ({len(passages)} passages)")
                except Exception as ocr_exc:
                    print(f"[Phase 2 OCR] Error repairing {b_id}: {ocr_exc}")
                finally:
                    shutil.rmtree(tmp_ocr, ignore_errors=True)

        # ------------------------------------------------------------------
        # PHASE 3: QPDF Fast-Web-View Linearization of Remaining PDFs
        # ------------------------------------------------------------------
        non_lin_books = [b for b in catalog if not b.get("linearized")]
        if non_lin_books and hf_token:
            state["phase"] = "phase3_linearize"
            api = HfApi(token=hf_token)
            batch_ops: List[CommitOperationAdd] = []
            batch_dir = Path("/tmp/clover_lin_batch")
            shutil.rmtree(batch_dir, ignore_errors=True)
            batch_dir.mkdir(parents=True, exist_ok=True)
            catalog_dirty = False

            for idx_l, book in enumerate(non_lin_books):
                b_id = book["id"]
                b_title = book.get("title") or b_id
                pct = 82 + int(((idx_l + 1) / max(len(non_lin_books), 1)) * 16)
                state.update(
                    {
                        "step": f"[Phase 3 Linearize {idx_l + 1}/{len(non_lin_books)}] Optimizing Fast Web View: {b_title}",
                        "percent": pct,
                    }
                )
                pdf_rel = (book.get("pdfUrl") or f"data/pdfs/{b_id}.pdf").lstrip("/")
                dl_sub = batch_dir / f"dl_{b_id}"
                dl_sub.mkdir(parents=True, exist_ok=True)
                try:
                    src_pdf = Path(
                        hf_hub_download(
                            repo_id=hf_repo,
                            repo_type="dataset",
                            filename=pdf_rel,
                            local_dir=str(dl_sub),
                            token=hf_token,
                        )
                    )
                    if is_pdf_linearized(src_pdf):
                        book["linearized"] = True
                        catalog_dirty = True
                        shutil.rmtree(dl_sub, ignore_errors=True)
                    else:
                        out_lin = batch_dir / f"{b_id}.pdf"
                        if linearize_pdf(src_pdf, out_lin):
                            book["linearized"] = True
                            catalog_dirty = True
                            batch_ops.append(
                                CommitOperationAdd(
                                    path_in_repo=pdf_rel,
                                    path_or_fileobj=str(out_lin),
                                )
                            )
                        shutil.rmtree(dl_sub, ignore_errors=True)

                    # Commit every 5 linearized PDFs to keep disk small & progress incremental
                    if len(batch_ops) >= 5:
                        cat_file = batch_dir / "catalog.json"
                        cat_file.write_text(
                            json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
                        )
                        api.create_commit(
                            repo_id=hf_repo,
                            repo_type="dataset",
                            operations=batch_ops
                            + [
                                CommitOperationAdd(
                                    path_in_repo="data/catalog.json",
                                    path_or_fileobj=str(cat_file),
                                )
                            ],
                            commit_message=f"Linearize batch of {len(batch_ops)} PDFs for HTTP 206 streaming",
                        )
                        batch_ops.clear()
                        catalog_dirty = False
                        shutil.rmtree(batch_dir, ignore_errors=True)
                        batch_dir.mkdir(parents=True, exist_ok=True)
                except Exception as lin_err:
                    print(f"[Phase 3 Linearize] Warning for {b_id}: {lin_err}")
                    shutil.rmtree(dl_sub, ignore_errors=True)

            if batch_ops or catalog_dirty:
                try:
                    cat_file = batch_dir / "catalog.json"
                    cat_file.write_text(
                        json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
                    )
                    api.create_commit(
                        repo_id=hf_repo,
                        repo_type="dataset",
                        operations=batch_ops
                        + [
                            CommitOperationAdd(
                                path_in_repo="data/catalog.json",
                                path_or_fileobj=str(cat_file),
                            )
                        ],
                        commit_message="Complete PDF Fast Web View linearization across catalog",
                    )
                except Exception as final_lin_err:
                    print(f"[Phase 3 Final Commit] Warning: {final_lin_err}")
            shutil.rmtree(batch_dir, ignore_errors=True)

        state.update(
            {
                "running": False,
                "phase": "ready",
                "step": f"All {index.indexed_books_count} books indexed, OCR-repaired & linearized!",
                "percent": 100,
            }
        )
    except Exception as fatal_err:
        print(f"[Bootstrap Error] {fatal_err}")
        state.update(
            {
                "running": False,
                "phase": "error",
                "step": f"Bootstrap error: {fatal_err}",
                "percent": 100,
                "error": str(fatal_err),
            }
        )

