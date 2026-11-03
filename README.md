# 🍀 Clover 3.0 — Linearized PDF Reader & Serverless Hybrid Vector + Cross-Encoder Search

[![GitHub Pages](https://img.shields.io/badge/Hosted%20On-GitHub%20Pages-blue?logo=github)](https://rahathasan452.github.io/clover/)
[![Hugging Face Dataset](https://img.shields.io/badge/Cloud%20CDN%20%26%20Index-Hugging%20Face-FFD21E?logo=huggingface)](https://huggingface.co/datasets/learner20011/CloverTexts-Data)
[![Snowflake Arctic](https://img.shields.io/badge/Embeddings-Arctic--Embed--m--v1.5-29B5E8)](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5)
[![Reranker](https://img.shields.io/badge/Reranker-MS--MARCO%20MiniLM-8B5CF6)](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2)
[![QPDF Linearized](https://img.shields.io/badge/PDF%20Streaming-HTTP%20206%20Linearized-10B981)](https://pikepdf.readthedocs.io/)

A 100% free (`$0` forever), any-device online & offline PDF book reader and **Obsidian "Seek"-grade Hybrid Search Engine** powered by **Hugging Face Dataset CDN** (`learner20011/CloverTexts-Data`) + **GitHub Actions Cloud Pipeline**.

---

## ✨ Architecture & Capabilities

### 1. Linearized HTTP `206` Streaming & Offline-First Reading
* **QPDF Fast Web View Linearization (`pikepdf`)**: Every PDF is rewritten with `/Linearized 1` hint tables at byte `0` so large 100 MB+ books never download upfront.
* **Strict Current-Page-First Priority Queue**: Windowed virtualization + `PageRenderScheduler` (`src/services/pdfService.ts`) renders `currentPage` first with exclusive bandwidth before prefetching `+1` / `-1` neighbor pages via 128 KB HTTP `206` byte-range requests.
* **IndexedDB Chunk Cache & 1-Click Save Offline**: Visited byte chunks persist automatically in IndexedDB (`clover_pdf_cache_v1`), plus a **Save Offline** toggle pins entire books locally.

### 2. 4-Stage Obsidian "Seek+" Hybrid Search (Online from Any Phone, Tablet, or Laptop)
* **Smart Contextual Passage Chunking (`hf_space/chunker.py`)**: Strips repeating page headers/footers, sorts 2-column scientific PDFs in true reading order, merges broken fragments into ~950-char overlapping passages, and injects hierarchical `[Book | Topic | TOC Chapter]` breadcrumbs.
* **Automatic ONNX Scanned-Book OCR (`RapidOCR` + `Tesseract`)**: Automatically detects scanned/image-only PDF pages (`< 6` native words) and extracts full text + word-level `[x0, y0, x1, y1]` bounding boxes.
* **Ultra-Compact Unified Cloud Index (`data/cloud_index/`)**: Compresses all 25+ books' passages & 256-d Matryoshka Int8 vectors into a single `~10 MB` CDN bundle (`passages.json.gz` + `vectors.bin`, cached in IndexedDB — **18x smaller** than raw layout JSONs!).
* **4-Stage Retrieval & Neural Reranking (`src/workers/search.worker.ts`)**:
  1. **Lexical BM25 (`MiniSearch`)** across passage text + TOC chapter breadcrumbs.
  2. **Dense Semantic Vectors (`Snowflake/snowflake-arctic-embed-m-v1.5`)** 256-d Matryoshka QInt8 ONNX.
  3. **Reciprocal Rank Fusion (`RRF k=60`)** + Exact Phrase Boosting.
  4. **Neural Cross-Encoder Reranker (`Xenova/ms-marco-MiniLM-L-6-v2`)** scoring top candidate pairs for pinpoint passage precision + exact `[x0, y0, x1, y1]` PDF canvas highlights.

### 3. Online 1-Click Book Ingestion & Auto-Tagging from Any Device
* **Upload from Phone, Tablet, or Laptop (`+ Add Book`)**:
  1. Inspects PDF metadata, TOC, and front-matter right in the browser in `<1s` to auto-suggest **Title**, **Author**, **Category**, and **Tags** (on-device taxonomy AI + optional free `gemini-2.5-flash`).
  2. Uploads directly from your browser to `learner20011/CloverTexts-Data` (`data/inbox/`) via `@huggingface/hub`.
  3. **GitHub Actions Cloud Runner (`.github/workflows/cloud_ingest.yml`)** automatically runs OCR (if scanned), QPDF linearization, cover rendering, and Arctic vector indexing on free 16 GB Ubuntu runners!
* **Optional Self-Hosted / HF PRO Docker Engine (`hf_space/`)**: Full FastAPI + SQLite FTS5 + Granite 278M + Reranker Docker engine included for optional dedicated hosting (`python tools/deploy_hf_space.py`).

---

## 🚀 Setup for Online Cloud Ingestion

1. **Hugging Face Dataset (`learner20011/CloverTexts-Data`)**: Already configured as default CDN.
2. **GitHub Repository Secret (One-Time Setup for Cloud Runner)**:
   In your GitHub repo (`Settings -> Secrets and variables -> Actions`), add:
   * `HF_TOKEN`: Your Hugging Face Write Token (`hf_...`).
3. **Local Commands**:
   ```bash
   npm install
   npm run dev          # Launch web reader & search UI
   npm run studio       # Launch local desktop FastAPI Studio + Vite UI
   npm run cloud:build  # Rebuild full Cloud Index, OCR scanned books & linearize PDFs
   npm run build        # Production TypeScript + Vite build
   ```

---

## 📄 License
MIT License
