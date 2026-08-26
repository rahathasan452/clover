#!/usr/bin/env python3
"""
Trading Books Ingestion & Hugging Face Dataset Reset Script
------------------------------------------------------------
1. Clears and resets all old files in Hugging Face dataset: learner20011/CloverTexts-Data.
2. Ingests all 17 trading PDFs from ./Trading using PyMuPDF for 100% vector word coordinates & covers.
3. Generates public/data/catalog.json, covers/, layouts/, and pdfs/.
4. Uploads the clean library to Hugging Face Dataset CDN.
"""

import os
import sys
import re
import json
import shutil
import time
from pathlib import Path
from typing import List, Dict, Any, Tuple
import fitz  # PyMuPDF
from huggingface_hub import HfApi, CommitOperationDelete

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

def load_env_vars():
    """Load variables from .env file manually."""
    env_file = Path(".env")
    if env_file.exists():
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip()
                if k and v and k not in os.environ:
                    os.environ[k] = v

load_env_vars()

HF_TOKEN = os.getenv("HF_TOKEN")
HF_REPO = os.getenv("PUBLIC_HF_DATASET_REPO", "learner20011/CloverTexts-Data")
TRADING_DIR = Path("./Trading")
OUTPUT_DIR = Path("./public/data")

def slugify(text: str) -> str:
    """Create URL-safe bookId from title/filename."""
    text = text.lower()
    text = re.sub(r'[^a-z0-9]+', '_', text).strip('_')
    return text[:60] if text else "book"

def extract_toc(doc) -> list:
    """Extract Table of Contents from PDF bookmarks."""
    toc_list = doc.get_toc()
    items = []
    for level, title, page in toc_list:
        clean_title = re.sub(r'[\x00-\x1f]', '', title).strip()
        if clean_title:
            items.append({
                "level": level,
                "title": clean_title,
                "page": max(1, page)
            })
    return items

def extract_words_and_layout(doc) -> List[Dict[str, Any]]:
    """Extract word bounding boxes and layout blocks using PyMuPDF."""
    pages_layout = []
    total_pages = len(doc)

    for page_idx in range(total_pages):
        page_num = page_idx + 1
        page = doc[page_idx]
        rect = page.rect
        p_width = max(1.0, rect.width)
        p_height = max(1.0, rect.height)

        # 1. Native vector word extraction
        words_data = page.get_text("words")

        # 2. OCR fallback for scanned pages with minimal text
        if len(words_data) < 5:
            try:
                tp = page.get_textpage_ocr(dpi=200, full=True)
                words_data = tp.extractWORDS()
            except Exception:
                words_data = []

        if not words_data:
            pages_layout.append({
                "page": page_num,
                "dimensions": {"width": round(p_width, 1), "height": round(p_height, 1)},
                "blocks": []
            })
            continue

        # Group words by block number
        blocks_dict = {}
        for w in words_data:
            x0, y0, x1, y1, word, block_no = w[:6]
            clean_word = re.sub(r'[\x00-\x1f]', '', word).strip()
            if not clean_word:
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

            blocks_dict[block_key]["words"].append(clean_word)
            blocks_dict[block_key]["word_entries"].append({
                "w": clean_word,
                "b": norm_bbox
            })

        page_blocks = []
        for b_id, b_content in blocks_dict.items():
            block_text = " ".join(b_content["words"])
            if len(block_text.strip()) < 2:
                continue

            block_type = "paragraph"
            if len(block_text) < 80 and (
                block_text.isupper() or 
                any(k in block_text.upper() for k in ["CHAPTER", "SECTION", "PART", "CONTENTS", "APPENDIX", "INDEX", "INTRODUCTION"])
            ):
                block_type = "heading"

            page_blocks.append({
                "id": b_id,
                "type": block_type,
                "text": block_text,
                "words": b_content["word_entries"]
            })

        pages_layout.append({
            "page": page_num,
            "dimensions": {"width": round(p_width, 1), "height": round(p_height, 1)},
            "blocks": page_blocks
        })

    return pages_layout

def process_all_trading_books() -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Process all trading books and build catalog, covers, layouts, and pdfs."""
    print("==================================================")
    print("📚 Processing Trading Books with PyMuPDF Engine")
    print("==================================================")

    covers_dir = OUTPUT_DIR / "covers"
    layouts_dir = OUTPUT_DIR / "layouts"
    pdfs_dir = OUTPUT_DIR / "pdfs"

    covers_dir.mkdir(parents=True, exist_ok=True)
    layouts_dir.mkdir(parents=True, exist_ok=True)
    pdfs_dir.mkdir(parents=True, exist_ok=True)

    pdf_files = sorted(list(TRADING_DIR.glob("*.pdf")) + list(TRADING_DIR.glob("*.PDF")), key=lambda p: p.name)
    print(f"Found {len(pdf_files)} PDF books in '{TRADING_DIR}'\n")

    catalog = []
    start_total = time.time()

    for idx, pdf_path in enumerate(pdf_files, 1):
        filename = pdf_path.stem
        book_id = slugify(filename)
        print(f"[{idx}/{len(pdf_files)}] 📖 Processing '{filename}'...")
        t0 = time.time()

        try:
            doc = fitz.open(pdf_path)
        except Exception as e:
            print(f"  ❌ Error opening {pdf_path.name}: {e}")
            continue

        total_pages = len(doc)
        file_size = pdf_path.stat().st_size

        # Metadata resolution
        meta = doc.metadata or {}
        raw_title = meta.get("title", "").strip()
        if not raw_title or "Microsoft Word" in raw_title or len(raw_title) < 3:
            clean_title = filename.replace("_", " ").replace("-", " ")
            clean_title = re.sub(r'\(.*?\)', '', clean_title).strip()
            # Beautify title casing
            clean_title = " ".join([w.capitalize() if not w.isupper() else w for w in clean_title.split()])
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

        if not author or author.lower() in ["unknown", "adobe"]:
            author = "Trading & Financial Author"

        # 1. Render Cover Image
        cover_filename = f"{book_id}.jpg"
        cover_path = covers_dir / cover_filename
        if not cover_path.exists() and total_pages > 0:
            first_page = doc[0]
            pix = first_page.get_pixmap(dpi=150)
            pix.save(str(cover_path))

        # 2. Extract TOC
        toc = extract_toc(doc)

        # 3. Save optimized PDF
        out_pdf_path = pdfs_dir / f"{book_id}.pdf"
        if not out_pdf_path.exists():
            try:
                doc.save(str(out_pdf_path), garbage=3, deflate=True)
            except Exception:
                shutil.copy2(pdf_path, out_pdf_path)

        # 4. Extract word layout blocks
        pages_layout = extract_words_and_layout(doc)

        # 5. Save dedicated layout JSON
        book_layout = {
            "bookId": book_id,
            "title": clean_title,
            "author": author,
            "totalPages": total_pages,
            "engine": "pymupdf",
            "pages": pages_layout
        }
        layout_path = layouts_dir / f"{book_id}.json"
        with open(layout_path, "w", encoding="utf-8") as f:
            json.dump(book_layout, f, ensure_ascii=False)

        total_words = sum(len(b.get("words", [])) for p in pages_layout for b in p.get("blocks", []))
        elapsed = time.time() - t0
        print(f"  ✅ Done in {elapsed:.2f}s | Pages: {total_pages} | Words: {total_words} | Cover: {cover_filename}")

        # Add to catalog
        book_entry = {
            "id": book_id,
            "title": clean_title,
            "author": author,
            "totalPages": total_pages,
            "fileSize": file_size,
            "pdfUrl": f"data/pdfs/{book_id}.pdf",
            "coverUrl": f"data/covers/{cover_filename}",
            "layoutUrl": f"data/layouts/{book_id}.json",
            "toc": toc
        }
        catalog.append(book_entry)
        doc.close()

    # Save catalog.json
    catalog_path = OUTPUT_DIR / "catalog.json"
    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)

    print(f"\n🎉 Processed all {len(catalog)} books in {time.time() - start_total:.2f}s!")
    print(f"📁 Saved catalog to {catalog_path}")
    return catalog

def reset_and_upload_to_huggingface():
    """Deletes all existing files in the HF dataset and uploads the fresh library."""
    if not HF_TOKEN:
        print("❌ Error: HF_TOKEN is not defined in .env")
        sys.exit(1)

    print("\n==================================================")
    print(f"☁️ Connecting to Hugging Face: {HF_REPO}")
    print("==================================================")

    api = HfApi(token=HF_TOKEN)

    # 1. Ensure dataset repo exists
    api.create_repo(repo_id=HF_REPO, repo_type="dataset", exist_ok=True)

    # 2. List all existing files in the repository
    print("🔍 Fetching existing repository files to delete/reset...")
    existing_files = api.list_repo_files(repo_id=HF_REPO, repo_type="dataset")
    print(f"Found {len(existing_files)} existing files in {HF_REPO}.")

    # Delete all old files except .gitattributes
    files_to_delete = [f for f in existing_files if f != ".gitattributes"]
    if files_to_delete:
        print(f"🗑️ Deleting {len(files_to_delete)} legacy files from Hugging Face dataset...")
        
        # Commit deletions in chunks if needed
        operations = [CommitOperationDelete(path_in_repo=f) for f in files_to_delete]
        
        # Batch into slices of 100 for reliable API execution
        batch_size = 100
        for i in range(0, len(operations), batch_size):
            chunk = operations[i:i+batch_size]
            print(f"  • Deleting batch {i//batch_size + 1}/{(len(operations)-1)//batch_size + 1} ({len(chunk)} files)...")
            api.create_commit(
                repo_id=HF_REPO,
                repo_type="dataset",
                operations=chunk,
                commit_message=f"Reset and wipe legacy files (batch {i//batch_size + 1})"
            )
        print("✅ Hugging Face dataset successfully wiped clean!")
    else:
        print("ℹ️ No previous files found to delete.")

    # 3. Create dataset README.md
    readme_content = f"""---
license: mit
task_categories:
- text-retrieval
- document-question-answering
language:
- en
tags:
- finance
- trading
- technical-analysis
- pdf-layouts
- clover
size_categories:
- 10M<n<100M
---

# 🍀 Clover Trading Books & Layout Dataset

This repository serves as the high-speed backend CDN for the [Clover PDF Reader & Search Engine](https://rahathasan452.github.io).

## Structure
- `data/catalog.json`: Master index of all books, authors, page counts, and Table of Contents.
- `data/covers/`: Rendered book cover thumbnails.
- `data/layouts/`: Dedicated companion layout JSONs with sub-pixel word bounding boxes `[x0, y0, x1, y1]`.
- `data/pdfs/`: High-resolution optimized PDF book files.
"""
    readme_path = Path("temp_dataset_readme.md")
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(readme_content)

    print("\n📦 Uploading fresh Trading library to Hugging Face...")
    # Upload public/data folder as 'data' in HF repo
    api.upload_folder(
        folder_path=str(OUTPUT_DIR),
        path_in_repo="data",
        repo_id=HF_REPO,
        repo_type="dataset",
        commit_message="Add fresh trading books library with exact PyMuPDF word bounding boxes"
    )

    # Upload README.md
    api.upload_file(
        path_or_fileobj=str(readme_path),
        path_in_repo="README.md",
        repo_id=HF_REPO,
        repo_type="dataset",
        commit_message="Update Dataset Card"
    )
    if readme_path.exists():
        readme_path.unlink()

    print(f"\n🎉 Successfully published new Trading dataset to: https://huggingface.co/datasets/{HF_REPO}")

def main():
    process_all_trading_books()
    reset_and_upload_to_huggingface()

if __name__ == "__main__":
    main()
