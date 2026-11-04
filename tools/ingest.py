#!/usr/bin/env python3
"""
Upgraded Clover Book Ingestion Pipeline:
1. QPDF Fast-Web-View PDF Linearization (`pikepdf`).
2. Vector Word & Block BBox Extraction (`PyMuPDF` + optional `Marker` OCR).
3. Quantized 384-d BGE Dense Semantic Vector Shards (`data/vectors/<book_id>.bin`).
4. Hybrid Auto-Tagging & Category Detection (Local Zero-Shot BGE + optional Gemini Flash).
5. Fast Atomic Delta-Upload to Hugging Face Dataset CDN.
"""

import os
import sys
import re
import json
import shutil
import argparse
import subprocess
from pathlib import Path
from typing import Optional, List, Dict, Any, Callable
import fitz  # PyMuPDF

# Ensure tools/ directory is importable regardless of cwd
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline_core import (
    slugify,
    load_env_config,
    linearize_pdf_file,
    build_vector_shard_from_layout,
    suggest_book_metadata,
    upload_delta_files_to_hf,
    check_duplicate_book,
)


def extract_toc(doc) -> list:
    toc_list = doc.get_toc()
    items = []
    for level, title, page in toc_list:
        items.append({"level": level, "title": title.strip(), "page": max(1, page)})
    return items


def extract_with_pymupdf(doc, max_pages=None):
    """Fast vector glyph & block bounding box extraction"""
    total_pages = len(doc)
    page_limit = min(total_pages, max_pages) if max_pages else total_pages
    pages_layout = []

    for page_idx in range(page_limit):
        page_num = page_idx + 1
        page = doc[page_idx]
        page_rect = page.rect
        p_width = max(1.0, page_rect.width)
        p_height = max(1.0, page_rect.height)

        words_data = page.get_text("words")
        if not words_data:
            pages_layout.append(
                {
                    "page": page_num,
                    "dimensions": {
                        "width": round(p_width, 1),
                        "height": round(p_height, 1),
                    },
                    "blocks": [],
                }
            )
            continue

        blocks_dict = {}
        for w in words_data:
            x0, y0, x1, y1, word, block_no, line_no, word_no = w
            if not word.strip():
                continue

            norm_bbox = [
                round(max(0.0, min(1.0, x0 / p_width)), 4),
                round(max(0.0, min(1.0, y0 / p_height)), 4),
                round(max(0.0, min(1.0, x1 / p_width)), 4),
                round(max(0.0, min(1.0, y1 / p_height)), 4),
            ]

            block_key = f"b_{block_no}"
            if block_key not in blocks_dict:
                blocks_dict[block_key] = {"words": [], "word_entries": []}

            blocks_dict[block_key]["words"].append(word)
            blocks_dict[block_key]["word_entries"].append({"w": word, "b": norm_bbox})

        page_blocks = []
        for b_id, b_content in blocks_dict.items():
            block_text = " ".join(b_content["words"])
            if len(block_text.strip()) < 3:
                continue

            block_type = "paragraph"
            if re.search(r"[=+\-*/^_{}\\]", block_text) and len(block_text) < 80:
                block_type = "equation"

            page_blocks.append(
                {
                    "id": b_id,
                    "type": block_type,
                    "text": block_text,
                    "words": b_content["word_entries"],
                }
            )

        pages_layout.append(
            {
                "page": page_num,
                "dimensions": {
                    "width": round(p_width, 1),
                    "height": round(p_height, 1),
                },
                "blocks": page_blocks,
            }
        )

    return pages_layout


def extract_with_marker(pdf_path: Path, max_pages=None):
    """High-Accuracy Deep Learning Scientific & OCR extraction using Marker"""
    print("  [*] Running Deep Learning Scientific OCR via Marker...")
    temp_out = pdf_path.parent / f"_marker_temp_{slugify(pdf_path.stem)}"
    temp_out.mkdir(parents=True, exist_ok=True)

    cmd = [
        "marker_single",
        str(pdf_path),
        "--output_dir",
        str(temp_out),
        "--output_format",
        "json",
    ]
    if max_pages:
        cmd.extend(["--max_pages", str(max_pages)])

    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        json_files = list(temp_out.rglob("*.json"))
        if json_files:
            with open(json_files[0], "r", encoding="utf-8") as f:
                marker_data = json.load(f)
            shutil.rmtree(temp_out, ignore_errors=True)
            return parse_marker_output(marker_data, pdf_path)
    except Exception as e:
        print(f"  [!] Marker execution warning: {e}")
    finally:
        shutil.rmtree(temp_out, ignore_errors=True)

    print("  [*] Falling back to high-precision PyMuPDF engine...")
    doc = fitz.open(pdf_path)
    res = extract_with_pymupdf(doc, max_pages=max_pages)
    doc.close()
    return res


def parse_marker_output(marker_data, pdf_path: Path):
    doc = fitz.open(pdf_path)
    pages_layout = []
    if isinstance(marker_data, dict) and "pages" in marker_data:
        pages_raw = marker_data["pages"]
    elif isinstance(marker_data, list):
        pages_raw = marker_data
    else:
        pages_raw = []

    for idx, p in enumerate(pages_raw):
        p_num = p.get("page", idx + 1)
        p_width = p.get("width", 612.0)
        p_height = p.get("height", 792.0)

        blocks = []
        for b_idx, block in enumerate(p.get("blocks", [])):
            text = block.get("text", "")
            b_type = block.get("type", "paragraph").lower()
            raw_bbox = block.get("bbox", [0, 0, p_width, p_height])

            norm_bbox = [
                round(max(0.0, min(1.0, raw_bbox[0] / p_width)), 4),
                round(max(0.0, min(1.0, raw_bbox[1] / p_height)), 4),
                round(max(0.0, min(1.0, raw_bbox[2] / p_width)), 4),
                round(max(0.0, min(1.0, raw_bbox[3] / p_height)), 4),
            ]
            words_entries = [{"w": w, "b": norm_bbox} for w in text.split()]
            blocks.append(
                {
                    "id": f"mb_{b_idx}",
                    "type": b_type,
                    "text": text,
                    "words": words_entries,
                }
            )

        pages_layout.append(
            {
                "page": p_num,
                "dimensions": {
                    "width": round(p_width, 1),
                    "height": round(p_height, 1),
                },
                "blocks": blocks,
            }
        )

    doc.close()
    return pages_layout


def process_single_pdf(
    pdf_path: Path,
    output_dir: Path,
    engine: str = "auto",
    max_pages: Optional[int] = None,
    category: Optional[str] = None,
    tags: Optional[List[str]] = None,
    title_override: Optional[str] = None,
    author_override: Optional[str] = None,
    generate_vectors: bool = True,
    existing_catalog: Optional[List[Dict[str, Any]]] = None,
    gemini_api_key: Optional[str] = None,
    duplicate_action: str = "skip",
    on_step: Optional[Callable[[str, int], None]] = None,
):
    if on_step:
        on_step("Opening & analyzing PDF metadata...", 8)

    # Auto-suggest metadata if category/tags/title aren't manually locked
    auto_meta = None
    if not category or category.lower() == "auto" or not tags:
        auto_meta = suggest_book_metadata(
            pdf_path,
            existing_catalog=existing_catalog,
            gemini_api_key=gemini_api_key,
        )

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        print(f"  [!] Failed to open {pdf_path.name}: {e}")
        return None, None, []

    total_pages = len(doc)
    book_id = slugify(title_override or pdf_path.stem)

    clean_title = (
        title_override
        or (auto_meta and auto_meta.get("title"))
        or pdf_path.stem.replace("_", " ")
    )
    author = (
        author_override
        or (auto_meta and auto_meta.get("author"))
        or "Unknown Author"
    )
    final_category = (
        category
        if (category and category.lower() != "auto")
        else (auto_meta.get("category") if auto_meta else "Trading")
    )
    final_tags = (
        tags
        if (tags and len(tags) > 0)
        else (auto_meta.get("tags") if auto_meta else [final_category])
    )

    # Duplicate Book Contingency Check
    if existing_catalog:
        dup = check_duplicate_book(
            pdf_path=pdf_path,
            title=clean_title,
            author=author,
            total_pages=total_pages,
            existing_catalog=existing_catalog,
        )
        if dup["isDuplicate"]:
            matched = dup["existingBook"]
            if duplicate_action == "skip":
                print(f"  [SKIP] Book already in library: '{matched.get('title')}' (id: {matched.get('id')}). Skipping.")
                doc.close()
                return matched, None, []
            elif duplicate_action == "version":
                v = 2
                existing_ids = {b.get("id") for b in existing_catalog if isinstance(b, dict)}
                while f"{book_id}-v{v}" in existing_ids:
                    v += 1
                book_id = f"{book_id}-v{v}"
                clean_title = f"{clean_title} (v{v})"
                print(f"  [VERSION] Book exists; saving as new edition: '{clean_title}' (id: {book_id})")

    print(
        f"Processing: '{clean_title}' by {author} ({total_pages} pages) -> [{final_category}] {final_tags}"
    )

    changed_rel_files: List[str] = []

    # 1. Render Cover Image
    if on_step:
        on_step("Rendering crisp cover thumbnail...", 18)
    covers_dir = output_dir / "covers"
    covers_dir.mkdir(parents=True, exist_ok=True)
    cover_filename = f"{book_id}.jpg"
    cover_path = covers_dir / cover_filename
    if total_pages > 0:
        pix = doc[0].get_pixmap(dpi=150)
        pix.save(str(cover_path))
        changed_rel_files.append(f"covers/{cover_filename}")

    # 2. Extract TOC
    toc = extract_toc(doc)

    # 3. Extract Text & Word Bounding Boxes BEFORE closing `doc`
    if on_step:
        on_step(f"Extracting vector word coordinates ({total_pages} pages)...", 35)
    if engine == "marker":
        pages_layout = extract_with_marker(pdf_path, max_pages=max_pages)
    elif engine == "auto":
        sample_text = "".join([doc[i].get_text() for i in range(min(5, len(doc)))])
        if len(sample_text.strip()) < 50:
            print("  [*] Scanned image-only PDF detected. Using Marker OCR...")
            pages_layout = extract_with_marker(pdf_path, max_pages=max_pages)
        else:
            pages_layout = extract_with_pymupdf(doc, max_pages=max_pages)
    else:
        pages_layout = extract_with_pymupdf(doc, max_pages=max_pages)

    doc.close()

    # 4. Linearize PDF ("Fast Web View" via pikepdf / QPDF)
    if on_step:
        on_step("Linearizing PDF for Fast Web View byte-range streaming...", 55)
    pdfs_dir = output_dir / "pdfs"
    pdfs_dir.mkdir(parents=True, exist_ok=True)
    out_pdf_path = pdfs_dir / f"{book_id}.pdf"
    is_linearized = linearize_pdf_file(pdf_path, out_pdf_path)
    final_file_size = out_pdf_path.stat().st_size
    changed_rel_files.append(f"pdfs/{book_id}.pdf")
    print(
        f"  [+] Saved {'QPDF Linearized' if is_linearized else 'Optimized'} PDF ({final_file_size / (1024*1024):.2f} MB)"
    )

    # 5. Save Companion Layout JSON
    layouts_dir = output_dir / "layouts"
    layouts_dir.mkdir(parents=True, exist_ok=True)
    layout_file_path = layouts_dir / f"{book_id}.json"

    book_layout = {
        "bookId": book_id,
        "title": clean_title,
        "author": author,
        "totalPages": total_pages,
        "engine": engine,
        "pages": pages_layout,
    }
    with open(layout_file_path, "w", encoding="utf-8") as f:
        json.dump(book_layout, f, ensure_ascii=False)
    changed_rel_files.append(f"layouts/{book_id}.json")

    # 6. Build Quantized Dense Semantic Vector Shard (`.bin`)
    vector_url = None
    if generate_vectors:
        if on_step:
            on_step("Computing 384-d BGE semantic embeddings (Int8 shard)...", 75)
        vec_path = output_dir / "vectors" / f"{book_id}.bin"

        def _vec_prog(done: int, total: int):
            if on_step and total > 0:
                pct = 75 + int(15 * (done / total))
                on_step(f"Embedding semantic blocks ({done}/{total})...", pct)

        chunk_count = build_vector_shard_from_layout(
            book_layout, vec_path, on_progress=_vec_prog
        )
        vector_url = f"data/vectors/{book_id}.bin"
        changed_rel_files.append(f"vectors/{book_id}.bin")
        print(
            f"  [+] Generated semantic vector shard: {vec_path.name} ({chunk_count} blocks, {vec_path.stat().st_size / 1024:.0f} KB)"
        )

    book_entry = {
        "id": book_id,
        "title": clean_title,
        "author": author,
        "totalPages": total_pages,
        "fileSize": final_file_size,
        "pdfUrl": f"data/pdfs/{book_id}.pdf",
        "coverUrl": f"data/covers/{cover_filename}",
        "layoutUrl": f"data/layouts/{book_id}.json",
        "vectorUrl": vector_url,
        "linearized": is_linearized,
        "category": final_category,
        "tags": final_tags,
        "toc": toc,
    }

    return book_entry, book_layout, changed_rel_files


def backfill_vectors_for_catalog(
    output_dir: Path,
    force: bool = False,
    on_book_progress: Optional[Callable[[int, int, str], None]] = None,
) -> List[str]:
    """
    Generates missing `data/vectors/<book_id>.bin` files directly from existing
    `public/data/layouts/<book_id>.json` files — no original PDFs required!
    """
    catalog_path = output_dir / "catalog.json"
    if not catalog_path.exists():
        return []

    with open(catalog_path, "r", encoding="utf-8") as f:
        catalog: List[Dict[str, Any]] = json.load(f)

    changed_files: List[str] = []
    total = len(catalog)

    for idx, book in enumerate(catalog, 1):
        book_id = book["id"]
        layout_path = output_dir / "layouts" / f"{book_id}.json"
        vec_path = output_dir / "vectors" / f"{book_id}.bin"

        if on_book_progress:
            on_book_progress(idx, total, book.get("title", book_id))

        if vec_path.exists() and not force:
            if not book.get("vectorUrl"):
                book["vectorUrl"] = f"data/vectors/{book_id}.bin"
            continue

        if not layout_path.exists():
            print(f"  [!] Skipping {book_id}: layout JSON not found locally")
            continue

        print(f"[{idx}/{total}] Vectorizing '{book.get('title', book_id)}'...")
        with open(layout_path, "r", encoding="utf-8") as lf:
            layout_data = json.load(lf)

        count = build_vector_shard_from_layout(layout_data, vec_path)
        book["vectorUrl"] = f"data/vectors/{book_id}.bin"
        changed_files.append(f"vectors/{book_id}.bin")
        print(
            f"  [+] {vec_path.name}: {count} blocks ({vec_path.stat().st_size / 1024:.0f} KB)"
        )

    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
    changed_files.append("catalog.json")
    return changed_files


def main():
    env_cfg = load_env_config()
    parser = argparse.ArgumentParser(
        description="Ingest, Linearize, Auto-Tag & Vectorize PDFs for Clover"
    )
    parser.add_argument("--input-dir", type=str, default=None, help="Folder of PDFs")
    parser.add_argument("--single-pdf", type=str, default=None, help="Single PDF file")
    parser.add_argument(
        "--backfill-vectors",
        action="store_true",
        help="Generate missing semantic vector shards (.bin) for all existing layouts",
    )
    parser.add_argument("--output-dir", type=str, default="./public/data")
    parser.add_argument(
        "--engine", type=str, choices=["marker", "pymupdf", "auto"], default="auto"
    )
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument(
        "--category",
        type=str,
        default="auto",
        help="Category name or 'auto' for AI zero-shot classification",
    )
    parser.add_argument(
        "--tags",
        type=str,
        default="",
        help="Comma-separated tags (leave empty for automatic AI tagging)",
    )
    parser.add_argument("--no-vectors", action="store_true")
    parser.add_argument(
        "--hf-repo", type=str, default=env_cfg["PUBLIC_HF_DATASET_REPO"]
    )
    parser.add_argument("--hf-token", type=str, default=env_cfg["HF_TOKEN"])
    parser.add_argument("--gemini-key", type=str, default=env_cfg["GEMINI_API_KEY"])
    parser.add_argument("--no-upload-hf", action="store_true")
    parser.add_argument("--keep-local-pdfs", action="store_true")
    parser.add_argument(
        "--on-duplicate",
        type=str,
        choices=["skip", "replace", "version"],
        default="skip",
        help="Action when duplicate book is encountered (default: skip)",
    )

    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.backfill_vectors:
        changed = backfill_vectors_for_catalog(output_dir)
        if not args.no_upload_hf and args.hf_token and args.hf_repo and changed:
            print(f"\n[🚀] Delta-uploading {len(changed)} vector files to {args.hf_repo}...")
            upload_delta_files_to_hf(
                output_dir,
                changed,
                args.hf_repo,
                args.hf_token,
                f"Add BGE semantic vector shards ({len(changed) - 1} books)",
            )
            print("[+] Synced vector shards to Hugging Face CDN!")
        return

    catalog_path = output_dir / "catalog.json"
    catalog: List[Dict[str, Any]] = []
    if catalog_path.exists():
        try:
            with open(catalog_path, "r", encoding="utf-8") as f:
                catalog = json.load(f)
        except Exception:
            catalog = []

    catalog_map = {b["id"]: b for b in catalog}
    parsed_tags = (
        [t.strip() for t in args.tags.split(",") if t.strip()] if args.tags else None
    )
    all_changed_files: List[str] = []

    if args.single_pdf:
        pdf_file = Path(args.single_pdf)
        if not pdf_file.exists():
            print(f"Error: Single PDF '{pdf_file}' not found.")
            sys.exit(1)
        entry, _, rel_files = process_single_pdf(
            pdf_file,
            output_dir,
            engine=args.engine,
            max_pages=args.max_pages,
            category=args.category,
            tags=parsed_tags,
            generate_vectors=not args.no_vectors,
            existing_catalog=list(catalog_map.values()),
            gemini_api_key=args.gemini_key,
            duplicate_action=args.on_duplicate,
        )
        if entry:
            catalog_map[entry["id"]] = entry
            all_changed_files.extend(rel_files)
    else:
        in_dir = Path(args.input_dir or "./Trading")
        if not in_dir.exists():
            print(f"Error: Input directory '{in_dir}' does not exist.")
            sys.exit(1)
        pdf_paths = sorted(
            set(list(in_dir.glob("*.pdf")) + list(in_dir.glob("*.PDF"))),
            key=lambda p: p.name,
        )
        print(f"Found {len(pdf_paths)} PDF books in '{in_dir}'\n")
        for idx, pdf_file in enumerate(pdf_paths, 1):
            print(f"[{idx}/{len(pdf_paths)}] ", end="")
            entry, _, rel_files = process_single_pdf(
                pdf_file,
                output_dir,
                engine=args.engine,
                max_pages=args.max_pages,
                category=args.category,
                tags=parsed_tags,
                generate_vectors=not args.no_vectors,
                existing_catalog=list(catalog_map.values()),
                gemini_api_key=args.gemini_key,
                duplicate_action=args.on_duplicate,
            )
            if entry:
                catalog_map[entry["id"]] = entry
                all_changed_files.extend(rel_files)

    final_catalog = list(catalog_map.values())
    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump(final_catalog, f, indent=2, ensure_ascii=False)
    all_changed_files.append("catalog.json")
    print(f"\n[+] Updated catalog.json ({len(final_catalog)} total books)")

    if not args.no_upload_hf and args.hf_token and args.hf_repo and all_changed_files:
        print(f"\n[🚀] Delta-uploading {len(all_changed_files)} changed files to {args.hf_repo}...")
        try:
            url = upload_delta_files_to_hf(
                output_dir,
                all_changed_files,
                args.hf_repo,
                args.hf_token,
                f"Ingest & linearize books ({len(final_catalog)} total in catalog)",
            )
            print(f"[+] Successfully synced to {url}")
            if not args.keep_local_pdfs:
                pdfs_dir = output_dir / "pdfs"
                if pdfs_dir.exists():
                    shutil.rmtree(pdfs_dir)
                    pdfs_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            print(f"[!] Hugging Face upload failed: {e}")


if __name__ == "__main__":
    main()
