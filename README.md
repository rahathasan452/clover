# 🍀 Clover 3.0 — Linearized Online PDF Reader & Hybrid Vector + BM25 + Cross-Encoder Search

[![Live Reader & Search](https://img.shields.io/badge/Online%20Reader%20%26%20Search-GitHub%20Pages-0EA5E9?logo=github)](https://rahathasan452.github.io/clover/)
[![Hugging Face Dataset CDN](https://img.shields.io/badge/Dataset%20CDN-learner20011%2FCloverTexts--Data-FFD21E?logo=huggingface)](https://huggingface.co/datasets/learner20011/CloverTexts-Data)
[![OCR Engine](https://img.shields.io/badge/Local%20OCR-Marker%20(No%20Image%20Crop)-F97316)](https://github.com/datalab-to/marker)
[![Embeddings](https://img.shields.io/badge/Embeddings-Snowflake%20Arctic%20256--d-29B5E8)](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5)
[![Reranker](https://img.shields.io/badge/Reranker-MS--MARCO%20MiniLM-8B5CF6)](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2)

Clover splits heavy document processing from everyday reading & search so everything stays **`$0` forever**, fast on your GPU PC, and instant on any phone, tablet, or laptop:

| Stage | Where It Runs | What Happens |
| :--- | :--- | :--- |
| **1. Book Ingestion, Marker OCR & Vector Indexing** | **100% Local on Your PC** (`npm run studio` or CLI) | Auto-tags metadata, extracts clean text/columns/tables/LaTeX via **`marker-pdf`** (`disable_image_extraction=True` — **no image cropping or storing**), linearizes PDFs via **`pikepdf`**, embeds contextual passages into **`Snowflake/snowflake-arctic-embed-m-v1.5`** (256-d Int8), and pushes static files to Hugging Face Dataset `learner20011/CloverTexts-Data`. |
| **2. Book Reading (Linearized Streaming + Offline)** | **Online from Any Device** (Phone / Tablet / Laptop) | Streams linearized PDFs (`/Linearized 1`) via `128 KB` HTTP `206` byte-range requests so `currentPage` loads immediately even on 100 MB+ books, caching visited chunks in IndexedDB (`Save Offline` supported). |
| **3. Obsidian "Seek+" 4-Stage Hybrid Search** | **Online from Any Device** (Phone / Tablet / Laptop) | Downloads the pre-computed `~10 MB` index bundle (`passages.json.gz` + `vectors.bin`) once from Hugging Face CDN (cached in IndexedDB), then runs **BM25 (`MiniSearch`) + Dense Semantic Vectors (`Arctic-Embed-m-v1.5`) + RRF + Neural Cross-Encoder Reranker (`ms-marco-MiniLM-L-6-v2`)** in a background Web Worker with sub-pixel `[x0, y0, x1, y1]` PDF page highlights. |

---

## 🚀 One-Time Local PC Setup

### 1. Configure `.env` (Project Root)
Create `.env` in `d:\Project\clover\.env`:
```env
HF_TOKEN=hf_your_write_token_here
PUBLIC_HF_DATASET_REPO=learner20011/CloverTexts-Data
# Optional: upgrades local auto-tagger to Gemini 2.5 Flash
GEMINI_API_KEY=
```

### 2. Install Frontend & Local Python Dependencies
```powershell
npm install
pip install marker-pdf pikepdf pymupdf onnxruntime transformers huggingface_hub fastapi uvicorn python-multipart beautifulsoup4
```
> **GPU Acceleration:** `tools/marker_engine.py` automatically detects **Intel Arc GPU (`xpu` `float16`)**, **NVIDIA CUDA (`bfloat16`)**, or **CPU**, and disables all image cropping (`disable_image_extraction=True`) so Marker runs ~2x faster without writing cropped figure PNGs to disk.

---

## ⚡ 1-Click Local PC Book Ingestion Guide

### Option A — 1-Click Visual Web Studio (Recommended)
Run a single command on your PC:
```powershell
npm run studio
```
1. Open **`http://localhost:5173`** and click **`+ Add Book`** in the top-right navbar.
2. **Drag & drop one or multiple PDFs** into the modal.
3. Clover inspects the PDF locally in `<1s` and auto-suggests **Title**, **Author**, **Category**, and **Tags** (editable before publishing).
4. Click **`1-Click Marker OCR, Linearize, Embed & Upload`**:
   * Runs **Marker OCR** locally (`disable_image_extraction=True`) — preserving 2-column reading order, tables, LaTeX math, and `[x0, y0, x1, y1]` word bounding boxes.
   * Linearizes the PDF (`pikepdf` Fast Web View `/Linearized 1`) for instant HTTP `206` page streaming.
   * Chunks contextual `[Book | Category | TOC Chapter]` passages and embeds 256-d Matryoshka Int8 vectors (`Snowflake/snowflake-arctic-embed-m-v1.5`).
   * Commits the delta (`data/pdfs/<book>.pdf`, `data/covers/<book>.png`, `data/layouts/<book>.json`, `data/catalog.json`, and `data/cloud_index/*`) directly to **`learner20011/CloverTexts-Data`**.
5. Open **`https://rahathasan452.github.io/clover/`** on any phone, tablet, or laptop — your new book is immediately readable and searchable!

---

### Option B — 1-Command CLI Ingestion & Batch Folder Import

* **Ingest a single PDF in 1 command (auto-tagged + Marker OCR + linearized + Arctic indexed + pushed to HF):**
  ```powershell
  npm run ingest -- --pdf "C:\Path\To\YourBook.pdf"
  ```

* **Batch-ingest an entire folder of PDFs:**
  ```powershell
  npm run ingest -- --input-dir "C:\Path\To\NewBooksFolder"
  ```

* **Re-OCR & Re-Embed Existing Hugging Face Dataset Books with Marker:**
  Downloads existing PDFs from `learner20011/CloverTexts-Data` to your PC, re-extracts them with **Marker (`disable_image_extraction=True`)**, re-embeds with **Snowflake Arctic 256-d**, and pushes incremental commits back to Hugging Face (automatically resumes if interrupted):
  ```powershell
  npm run reocr
  ```
  *(To target specific book IDs or force re-running already Marker-extracted books:)*
  ```powershell
  python -u tools/local_pipeline.py --reocr-hf --books "the_candlestick_course_steve_nison,definitive_guide_to_position_sizing_van_k_tharp" --force
  ```

---

## 🔍 How Online Search Works on Any Device (Zero Re-Indexing)

* **Indexing happens ONLY ONCE on your PC** during ingestion (`tools/local_pipeline.py`).
* When you open Clover on **any phone, tablet, or laptop**, the browser downloads `data/cloud_index/{manifest.json, passages.json.gz, vectors.bin}` (`~10 MB` total for 25+ books) once from Hugging Face CDN and caches it in IndexedDB (`clover_cloud_index_v3`).
* When you press `Ctrl+K` / `Cmd+K` and type a query:
  1. **Lexical BM25 (`MiniSearch`)** finds exact technical jargon, tickers, formulas, and chapter headings in `<5 ms`.
  2. **Dense Query Embedding (`Snowflake/snowflake-arctic-embed-m-v1.5`)** embeds *only your short search query* (~5–15 tokens) in a Web Worker and computes exact dot-product similarity against all pre-computed 256-d vectors in `<8 ms`.
  3. **Reciprocal Rank Fusion (`RRF k=60`)** + phrase boosting merges lexical and semantic candidates.
  4. **Cross-Encoder Reranker (`Xenova/ms-marco-MiniLM-L-6-v2`)** reranks the top 16 candidate passages for Obsidian Seek-grade accuracy and jumps straight to the exact PDF page & highlighted passage!

---

## 📂 Key Project Files

* `tools/marker_engine.py` — Local GPU/CPU `marker-pdf` engine (`disable_image_extraction=True`, math preservation, native + OCR word bounding boxes).
* `tools/chunker.py` — Smart contextual passage chunker (`~950` chars, header/footer stripping, TOC + Marker section hierarchy breadcrumbs).
* `tools/local_pipeline.py` — Unified local PC 1-click ingestion, `pikepdf` linearization, `Snowflake Arctic` 256-d ONNX indexer, HF uploader, and `--reocr-hf` upgrader.
* `tools/studio_server.py` & `src/components/studio/IngestStudioModal.tsx` — Local 1-click visual drag-and-drop Studio (`npm run studio`).
* `src/services/pdfService.ts` & `src/services/pdfCacheService.ts` — Linearized HTTP `206` priority page streaming & IndexedDB offline chunk cache.
* `src/workers/search.worker.ts` & `src/hooks/useMultiBookSearch.ts` — Online 4-stage BM25 + Arctic Semantic + RRF + MS-MARCO Cross-Encoder search worker.

---

## 📄 License
MIT License
