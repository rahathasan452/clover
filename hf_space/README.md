---
title: Clover Hybrid Search & Book Studio Engine
emoji: 🍀
colorFrom: sky
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Clover Cloud Hybrid Search & 1-Click Book Ingestion Engine

Cloud backend powering **Clover** (`learner20011/CloverTexts-Data`) from any device at `$0` cost:

1. **Obsidian Seek-Grade Hybrid Search (`/api/search`)**
   - **Smart Contextual Passage Chunking:** Strips repeating margin headers/footers, orders multi-column layouts, coalesces micro-blocks into ~950-char overlapping passages with `[Book | Topic | Chapter]` TOC breadcrumbs, and preserves exact word-level `[x0, y0, x1, y1]` PDF highlight coordinates.
   - **Dense Semantic Vectors:** `ibm-granite/granite-embedding-278m-multilingual` (768-d QInt8 ONNX).
   - **Lexical Keyword Ranking:** SQLite FTS5 BM25 (`porter unicode61`).
   - **Reciprocal Rank Fusion (RRF) + Neural Cross-Encoder Reranking:** `Xenova/ms-marco-MiniLM-L-6-v2` reranks top candidates for pinpoint passage precision.

2. **Online 1-Click Book Ingestion & Auto-Tagging (`/api/studio/*`)**
   - Upload PDFs from any phone, tablet, or laptop.
   - Zero-shot semantic auto-tagging (`Granite 278M` + optional `gemini-2.5-flash`).
   - Automatic C++ Tesseract OCR (`PyMuPDF`) for scanned/image-only pages with word bounding boxes.
   - `pikepdf` (`QPDF`) Fast Web View `/Linearized 1` optimization for instant HTTP `206` page streaming.

