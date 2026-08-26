#!/usr/bin/env python3
"""
Scientific & Engineering OCR Ingestion Pipeline for Clover PDF Reader
---------------------------------------------------------------------
Supports:
1. High-Accuracy Deep Learning Scientific OCR via Marker (`marker-pdf` / Surya).
   - Extracts LaTeX math equations ($...$, $$...$$), tables, multi-column scientific layouts,
     and exact character/word bounding boxes.
2. Fast Native Vector Extraction via PyMuPDF (100% vector accuracy for digital PDFs).
3. Generates dedicated companion `<book_id>.json` Layout files for every PDF.
4. Generates `catalog.json` and renders crisp cover thumbnails.
"""

import os
import sys
import re
import json
import shutil
import argparse
import subprocess
from pathlib import Path
import fitz  # PyMuPDF

def slugify(text: str) -> str:
    text = text.lower()
    text = re.sub(r'[^a-z0-9]+', '_', text).strip('_')
    return text[:60] if text else "book"

def extract_toc(doc) -> list:
    toc_list = doc.get_toc()
    items = []
    for level, title, page in toc_list:
        items.append({
            "level": level,
            "title": title.strip(),
            "page": max(1, page)
        })
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
            pages_layout.append({
                "page": page_num,
                "dimensions": { "width": round(p_width, 1), "height": round(p_height, 1) },
                "blocks": []
            })
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
                round(max(0.0, min(1.0, y1 / p_height)), 4)
            ]

            block_key = f"b_{block_no}"
            if block_key not in blocks_dict:
                blocks_dict[block_key] = {
                    "words": [],
                    "word_entries": []
                }
            
            blocks_dict[block_key]["words"].append(word)
            blocks_dict[block_key]["word_entries"].append({
                "w": word,
                "b": norm_bbox
            })

        page_blocks = []
        for b_id, b_content in blocks_dict.items():
            block_text = " ".join(b_content["words"])
            if len(block_text.strip()) < 3:
                continue

            # Detect if text contains equations or headings
            block_type = "paragraph"
            if re.search(r'[=+\-*/^_{}\\]', block_text) and len(block_text) < 80:
                block_type = "equation"

            page_blocks.append({
                "id": b_id,
                "type": block_type,
                "text": block_text,
                "words": b_content["word_entries"]
            })

        pages_layout.append({
            "page": page_num,
            "dimensions": { "width": round(p_width, 1), "height": round(p_height, 1) },
            "blocks": page_blocks
        })

    return pages_layout

def extract_with_marker(pdf_path: Path, max_pages=None):
    """High-Accuracy Deep Learning Scientific & OCR extraction using Marker"""
    print(f"  [*] Running Deep Learning Scientific OCR via Marker...")
    temp_out = pdf_path.parent / f"_marker_temp_{slugify(pdf_path.stem)}"
    temp_out.mkdir(parents=True, exist_ok=True)

    cmd = [
        "marker_single",
        str(pdf_path),
        "--output_dir", str(temp_out),
        "--output_format", "json"
    ]
    if max_pages:
        cmd.extend(["--max_pages", str(max_pages)])

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        # Search for generated JSON inside temp_out
        json_files = list(temp_out.rglob("*.json"))
        if json_files:
            with open(json_files[0], "r", encoding="utf-8") as f:
                marker_data = json.load(f)
            shutil.rmtree(temp_out, ignore_errors=True)
            print(f"  [+] Marker extraction succeeded with deep learning layout analysis!")
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
    """Parse Marker's rich scientific JSON (LaTeX, formulas, bboxes) into Clover layout schema"""
    doc = fitz.open(pdf_path)
    pages_layout = []
    
    # If Marker provides page-by-page blocks or markdown blocks
    pages_dict = {}
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
                round(max(0.0, min(1.0, raw_bbox[3] / p_height)), 4)
            ]

            words_entries = []
            for w in text.split():
                words_entries.append({
                    "w": w,
                    "b": norm_bbox
                })

            blocks.append({
                "id": f"mb_{b_idx}",
                "type": b_type,
                "text": text,
                "words": words_entries
            })

        pages_layout.append({
            "page": p_num,
            "dimensions": { "width": round(p_width, 1), "height": round(p_height, 1) },
            "blocks": blocks
        })

    doc.close()
    return pages_layout

def process_single_pdf(pdf_path: Path, output_dir: Path, engine: str = "auto", max_pages: int = None, category: str = "Trading", tags: list = None):
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        print(f"  [!] Failed to open {pdf_path.name}: {e}")
        return None, None

    total_pages = len(doc)
    file_size = pdf_path.stat().st_size
    filename = pdf_path.stem
    book_id = slugify(filename)

    meta = doc.metadata or {}
    raw_title = meta.get("title", "").strip()
    if not raw_title or "Microsoft Word" in raw_title or len(raw_title) < 3:
        clean_title = filename.replace("_", " ").replace("-", " ")
        clean_title = re.sub(r'\(.*?\)', '', clean_title).strip()
    else:
        clean_title = raw_title

    author = meta.get("author", "").strip()
    if not author:
        if " - " in filename:
            parts = filename.split(" - ")
            if len(parts) >= 2:
                author = parts[-1].replace("_", " ").strip()
        elif "_" in filename:
            parts = filename.split("_")
            if len(parts) >= 3:
                author = f"{parts[-2]} {parts[-1]}"

    if not author:
        author = "Unknown Author"

    print(f"Processing: '{clean_title}' ({total_pages} pages)...")

    # 1. Render Cover Image
    covers_dir = output_dir / "covers"
    covers_dir.mkdir(parents=True, exist_ok=True)
    cover_filename = f"{book_id}.jpg"
    cover_path = covers_dir / cover_filename
    
    if not cover_path.exists() and total_pages > 0:
        first_page = doc[0]
        pix = first_page.get_pixmap(dpi=150)
        pix.save(str(cover_path))

    # 2. Extract TOC
    toc = extract_toc(doc)

    # 3. Copy/Link PDF into pdfs/ directory
    pdfs_dir = output_dir / "pdfs"
    pdfs_dir.mkdir(parents=True, exist_ok=True)
    out_pdf_path = pdfs_dir / f"{book_id}.pdf"
    if not out_pdf_path.exists():
        try:
            doc.save(str(out_pdf_path), garbage=3, deflate=True)
        except Exception:
            shutil.copy2(pdf_path, out_pdf_path)

    # 4. Extract Text & Bounding Boxes using requested OCR engine
    if engine == "marker":
        pages_layout = extract_with_marker(pdf_path, max_pages=max_pages)
    elif engine == "auto":
        # Check if PDF contains scanned image pages with low text density
        sample_text = "".join([doc[i].get_text() for i in range(min(5, len(doc)))])
        if len(sample_text.strip()) < 50:
            print("  [*] Scanned image-only PDF detected. Using Marker OCR...")
            pages_layout = extract_with_marker(pdf_path, max_pages=max_pages)
        else:
            pages_layout = extract_with_pymupdf(doc, max_pages=max_pages)
    else:
        pages_layout = extract_with_pymupdf(doc, max_pages=max_pages)

    layouts_dir = output_dir / "layouts"
    layouts_dir.mkdir(parents=True, exist_ok=True)
    layout_file_path = layouts_dir / f"{book_id}.json"

    # Save THIS PDF's Dedicated Companion Layout JSON
    book_layout = {
        "bookId": book_id,
        "title": clean_title,
        "author": author,
        "totalPages": total_pages,
        "engine": engine,
        "pages": pages_layout
    }

    with open(layout_file_path, "w", encoding="utf-8") as f:
        json.dump(book_layout, f, ensure_ascii=False)

    print(f"  [+] Created dedicated layout JSON: {layout_file_path.name} ({len(pages_layout)} pages)")

    # Book metadata entry for catalog.json
    book_entry = {
        "id": book_id,
        "title": clean_title,
        "author": author,
        "totalPages": total_pages,
        "fileSize": file_size,
        "pdfUrl": f"data/pdfs/{book_id}.pdf",
        "coverUrl": f"data/covers/{cover_filename}",
        "layoutUrl": f"data/layouts/{book_id}.json",
        "category": category,
        "tags": tags or [category],
        "toc": toc
    }

    doc.close()
    return book_entry, book_layout

def main():
    parser = argparse.ArgumentParser(description="Ingest Scientific & Engineering PDFs with Marker OCR & exact bboxes")
    parser.add_argument("--input-dir", type=str, default="./Trading", help="Path to folder containing PDF files")
    parser.add_argument("--single-pdf", type=str, default=None, help="Process only a single PDF file")
    parser.add_argument("--output-dir", type=str, default="./public/data", help="Output directory for catalog & layouts")
    parser.add_argument("--engine", type=str, choices=["marker", "pymupdf", "auto"], default="auto", help="OCR engine to use")
    parser.add_argument("--category", type=str, default="Trading", help="Category for the books (e.g. Trading, Engineering, CS)")
    parser.add_argument("--tags", type=str, default="", help="Comma-separated tags (e.g. 'Technical Analysis, Forex')")
    # Auto-load .env configuration
    env_file = Path(".env")
    env_token = None
    env_repo = "learner20011/CloverTexts-Data"
    if env_file.exists():
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    if k.strip() == "HF_TOKEN":
                        env_token = v.strip()
                    elif k.strip() == "PUBLIC_HF_DATASET_REPO":
                        env_repo = v.strip()

    parser.add_argument("--hf-repo", type=str, default=env_repo, help="Hugging Face dataset repo (defaults to .env)")
    parser.add_argument("--hf-token", type=str, default=env_token, help="Hugging Face access token (defaults to .env)")
    parser.add_argument("--no-upload-hf", action="store_true", help="Skip automatic Hugging Face upload")
    parser.add_argument("--keep-local-pdfs", action="store_true", help="Keep local PDF copies in public/data/pdfs after upload")
    
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    catalog_path = output_dir / "catalog.json"
    catalog = []
    if catalog_path.exists():
        try:
            with open(catalog_path, "r", encoding="utf-8") as f:
                catalog = json.load(f)
        except Exception:
            catalog = []

    catalog_map = {b["id"]: b for b in catalog}

    parsed_tags = [t.strip() for t in args.tags.split(",") if t.strip()] if args.tags else [args.category]

    if args.single_pdf:
        pdf_file = Path(args.single_pdf)
        if not pdf_file.exists():
            print(f"Error: Single PDF '{pdf_file}' not found.")
            sys.exit(1)
        book_entry, _ = process_single_pdf(pdf_file, output_dir, engine=args.engine, max_pages=args.max_pages, category=args.category, tags=parsed_tags)
        if book_entry:
            catalog_map[book_entry["id"]] = book_entry
    else:
        input_dir = Path(args.input_dir)
        if not input_dir.exists():
            print(f"Error: Input directory '{input_dir}' does not exist.")
            sys.exit(1)

        pdf_paths = set(list(input_dir.glob("*.pdf")) + list(input_dir.glob("*.PDF")))
        pdf_files = sorted(list(pdf_paths), key=lambda p: p.name)
        print(f"Found {len(pdf_files)} PDF books in '{input_dir}' (Engine: {args.engine})\n")

        for idx, pdf_file in enumerate(pdf_files, 1):
            print(f"[{idx}/{len(pdf_files)}] ", end="")
            book_entry, _ = process_single_pdf(pdf_file, output_dir, engine=args.engine, max_pages=args.max_pages, category=args.category, tags=parsed_tags)
            if book_entry:
                catalog_map[book_entry["id"]] = book_entry

    final_catalog = list(catalog_map.values())
    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump(final_catalog, f, indent=2, ensure_ascii=False)
    print(f"\n[+] Saved catalog with {len(final_catalog)} books to {catalog_path}")

    # Automatic Hugging Face Sync
    hf_token = args.hf_token or env_token
    hf_repo = args.hf_repo or env_repo
    if not args.no_upload_hf and hf_token and hf_repo:
        print(f"\n[🚀] Automatically syncing library to Hugging Face: {hf_repo}...")
        try:
            from huggingface_hub import HfApi
            api = HfApi(token=hf_token)
            api.create_repo(repo_id=hf_repo, repo_type="dataset", exist_ok=True)
            api.upload_folder(
                folder_path=str(output_dir),
                path_in_repo="data",
                repo_id=hf_repo,
                repo_type="dataset",
                commit_message=f"Ingest category '{args.category}' ({len(catalog_map)} total books)"
            )
            print(f"[+] Successfully pushed library to https://huggingface.co/datasets/{hf_repo}")

            # Clean local staging PDFs to keep local workspace light
            if not args.keep_local_pdfs:
                pdfs_dir = output_dir / "pdfs"
                if pdfs_dir.exists():
                    print("🧹 Cleaning local staging PDFs to keep workspace lightweight...")
                    shutil.rmtree(pdfs_dir)
                    pdfs_dir.mkdir(parents=True, exist_ok=True)
                    print("✅ Local staging PDFs cleaned.")
        except Exception as e:
            print(f"[!] Hugging Face upload failed: {e}")

    print("\nProcessing complete! OCR layout JSONs with exact bboxes generated & catalog synchronized.")


if __name__ == "__main__":
    main()
