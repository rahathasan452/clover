# 🍀 Clover — Scientific & Trading PDF Reader & Search Engine

[![GitHub Pages](https://img.shields.io/badge/Hosted%20On-GitHub%20Pages-blue?logo=github)](https://rahathasan452.github.io/clover/)
[![Hugging Face Dataset](https://img.shields.io/badge/Backend%20Storage-Hugging%20Face%20CDN-FFD21E?logo=huggingface)](https://huggingface.co/datasets/learner20011/CloverTexts-Data)
[![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react)](https://reactjs.org/)
[![Vite](https://img.shields.io/badge/Vite-6.1-646CFF?logo=vite)](https://vitejs.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![PyMuPDF](https://img.shields.io/badge/OCR%20Engine-PyMuPDF%20Vector-2BA055)](https://pymupdf.readthedocs.io/)

A modern, high-speed PDF reader and multi-book search engine. Clover streams PDF pages on-demand from a **Hugging Face Dataset CDN** and provides sub-pixel visual search highlighting across entire book libraries using vector-extracted word bounding boxes (`[x0, y0, x1, y1]`).

---

## 🌐 Live Website & Dataset Links

* **Live Web App**: [https://rahathasan452.github.io/clover/](https://rahathasan452.github.io/clover/)
* **Hugging Face Backend Storage**: [https://huggingface.co/datasets/learner20011/CloverTexts-Data](https://huggingface.co/datasets/learner20011/CloverTexts-Data)
* **Master Catalog JSON**: [`data/catalog.json`](https://huggingface.co/datasets/learner20011/CloverTexts-Data/resolve/main/data/catalog.json)

---

## ✨ Features

* **Instant Multi-Book Search**: Full-text search across all books simultaneously with exact bounding box (`[x0, y0, x1, y1]`) highlighting on the PDF canvas.
* **Hugging Face CDN Cloud Storage**: Large PDF binaries and layouts are hosted on Hugging Face Datasets with zero storage limits, keeping the Git repository lightweight (<1 MB).
* **High-Precision Vector Extraction (PyMuPDF)**: 100% sub-pixel coordinate accuracy for born-digital PDFs, with automated OCR fallback for scanned pages.
* **Dynamic Category & Topic Filtering**: Filter by category (*Trading*, *Engineering*, *Computer Science*) and sub-topics (*Price Action*, *Algorithmic*, *Psychology*, *Risk Management*).
* **IndexedDB Local Caching**: Instant reader and layout access after initial load.
* **Interactive Table of Contents**: Seamless chapter navigation with publisher bookmarks.

---

## 🚀 How to Ingest & Upload New Books Workflow

Whenever you have new PDF books to add (e.g. Trading, Engineering, Computer Science), follow this 3-step workflow:

### Step 1: Set up your `.env` credentials
Ensure your `.env` file contains your Hugging Face write token and dataset repository:
```env
HF_TOKEN=hf_your_write_token_here
PUBLIC_HF_DATASET_REPO=learner20011/CloverTexts-Data
```

### Step 2: Run the Ingestion Pipeline

Put your new PDF files into a folder (e.g. `./Trading`, `./Engineering`, or `./CS`) and run:

```bash
# Example 1: Ingesting Trading Books
python tools/ingest.py \
  --input-dir ./Trading \
  --category "Trading" \
  --tags "Technical Analysis, Price Action, Algorithmic, Risk Management" \
  --hf-repo learner20011/CloverTexts-Data \
  --hf-token $HF_TOKEN

# Example 2: Ingesting Engineering Books
python tools/ingest.py \
  --input-dir ./Engineering \
  --category "Engineering" \
  --tags "Circuits, Electronics, Signal Processing" \
  --hf-repo learner20011/CloverTexts-Data \
  --hf-token $HF_TOKEN

# Example 3: Ingesting Computer Science Books
python tools/ingest.py \
  --input-dir ./CS \
  --category "Computer Science" \
  --tags "Algorithms, Distributed Systems, Python" \
  --hf-repo learner20011/CloverTexts-Data \
  --hf-token $HF_TOKEN
```

#### What `ingest.py` does automatically:
1. Extracts exact vector word coordinates `[x0, y0, x1, y1]` using PyMuPDF.
2. Renders high-resolution cover thumbnails (`public/data/covers/<book_id>.jpg`).
3. Extracts publisher bookmarks/Table of Contents.
4. Generates dedicated search layout JSONs (`public/data/layouts/<book_id>.json`).
5. Updates the master `catalog.json` with categories and tags.
6. Uploads the fresh library to the Hugging Face dataset CDN.

---

### Step 3: Complete Reset & Re-upload (If needed)

To completely wipe all previous files from the Hugging Face dataset and upload a fresh library from scratch:

```bash
python tools/reset_and_upload_hf.py
```

---

## 🚢 How to Deploy to GitHub Pages

The repository includes an automated GitHub Actions deployment workflow ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)).

### 1. Push code to GitHub:
```bash
git add .
git commit -m "Update books and features"
git push -u origin main
```

### 2. Enable GitHub Actions in GitHub Settings:
1. Open your repository on GitHub: `https://github.com/rahathasan452/clover/settings/pages`
2. Under **Build and deployment > Source**, choose **GitHub Actions**.
3. Every `git push` to `main` will automatically build and deploy the frontend to `https://rahathasan452.github.io/clover/`.

---

## 💻 Local Development

```bash
# 1. Install dependencies
npm install

# 2. Start local development server
npm run dev

# 3. Build production bundle
npm run build

# 4. Preview production build locally
npm run preview
```

---

## 📂 Project Architecture

```
clover/
├── .github/workflows/
│   └── deploy.yml              # Automated GitHub Pages deployment
├── public/
│   └── data/
│       ├── catalog.json        # Master books index & metadata
│       ├── covers/             # Rendered cover thumbnails
│       └── layouts/            # Word-level bounding box JSONs
├── src/
│   ├── components/
│   │   ├── library/            # Bookshelf, BookCard, Category Filters
│   │   ├── reader/             # PDF Viewer, BBox Highlights, TOC Drawer
│   │   └── search/             # Global multi-book search modal
│   ├── hooks/                  # useLibrary, useMultiBookSearch
│   ├── services/               # hfStorage, pdfService, storageService
│   ├── workers/                # Web Worker for fast in-browser MiniSearch
│   └── App.tsx                 # Main application layout
├── tools/
│   ├── ingest.py               # Main ingestion CLI tool (PyMuPDF / Marker)
│   └── reset_and_upload_hf.py  # Reset & push pipeline to Hugging Face
├── .env.example                # Safe environment variable template
├── .gitignore                  # Strict protection for tokens and local PDFs
├── package.json
└── vite.config.ts              # Relative path configuration for GitHub Pages
```

---

## 📄 License
MIT License
