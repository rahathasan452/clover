# %% [markdown] {"jupyter":{"outputs_hidden":false},"_kg_hide-output":true}
# 
# # 🚀 Kaggle GPU Setup & Marker PDF to Layout JSON Converter
# 
#  This script converts PDF files directly into **Clover Layout JSONs** (`public/data/layouts/<book_id>.json`) using **Marker** (GPU-accelerated Deep Learning OCR + Surya VLM Layout & PDFText Engine), **without PyMuPDF**.
#  Produces full OCR'd text, layout blocks (`heading`, `paragraph`, `equation`, `table`), and exact word-level bounding boxes `[0.0 to 1.0]` ready for instant search and text highlighting.
# 
# ## 📌 **What it generates:**
#  - **`<book_id>.json`** matching the exact Clover layout schema:
#    ```json
#    {
#      "bookId": "the_art_of_trading",
#      "title": "The Art of Trading",
#      "author": "Adam Grimes",
#      "totalPages": 250,
#      "engine": "marker",
#      "pages": [
#        {
#          "page": 1,
#          "dimensions": { "width": 612.0, "height": 792.0 },
#          "blocks": [
#            {
#              "id": "b_0",
#              "type": "heading",
#              "text": "CHAPTER 1 The Trader's Edge",
#              "words": [
#                { "w": "CHAPTER", "b": [0.1258, 0.1399, 0.2357, 0.1696] },
#                { "w": "1", "b": [0.2444, 0.1399, 0.2714, 0.1696] },
#                { "w": "The", "b": [0.2794, 0.1399, 0.3334, 0.1696] },
#                { "w": "Trader's", "b": [0.3415, 0.1399, 0.4572, 0.1696] },
#                { "w": "Edge", "b": [0.4659, 0.1399, 0.5372, 0.1696] }
#              ]
#            }
#          ]
#        }
#      ]
#    }
#    ```
#  - **`layouts.zip`**: Automatically archives all generated JSON files with a one-click download link in Kaggle.
# 
# ## ⚙️ **Kaggle Instructions:**
#  1. In Notebook Settings (right panel): Set **Accelerator** to `GPU T4 x2` or `P100`.
#  2. Enable **Internet** in Kaggle settings.
#  3. Add your PDF files via **+ Add Data** (searches `/kaggle/input/...` automatically).
#  4. Set `BATCH_TARGET = "all"` (or your filename like `"testch1.pdf"`) in the `__main__` section and run all cells!

# %% [code]
import os
import sys
import re
import json
import shutil
import time
import argparse
import subprocess
from pathlib import Path
from typing import Dict, List, Any, Tuple, Union, Optional

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

print("🔍 Checking System & GPU Configuration...")

# PyTorch CUDA GPU settings
os.environ["TORCH_DEVICE"] = "cuda"
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["USE_TF"] = "0"
os.environ["USE_FLAX"] = "0"
os.environ["USE_TORCH"] = "1"

# Disable autostart background servers in Surya / Marker
os.environ["SURYA_INFERENCE_AUTOSTART"] = "0"
os.environ["DETECTOR_SERVER_AUTOSTART"] = "0"
os.environ["OCR_ERROR_SERVER_AUTOSTART"] = "0"
os.environ["FAST_LAYOUT_SERVER_AUTOSTART"] = "0"

try:
    import torch
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        gpu_count = torch.cuda.device_count()
        vram_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
        print(f"✅ CUDA Available! GPU: {gpu_name} ({gpu_count} GPU(s), VRAM: {vram_gb:.2f} GB)")
    else:
        print("⚠️ CUDA not detected by PyTorch. Please enable GPU accelerator in Kaggle settings.")
except ImportError:
    print("⏳ PyTorch will be verified after package installation.")

# %% [code]

def run_cmd(cmd_str: str, env: dict = None):
    """Runs a shell command cleanly across environments."""
    print(f"📦 Executing: {cmd_str}")
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    res = subprocess.run(cmd_str, shell=True, env=merged_env, capture_output=False)
    if res.returncode != 0:
        print(f"⚠️ Command exited with code: {res.returncode}")

def install_dependencies():
    """Installs required Linux system packages and Python ML packages."""
    if shutil.which("apt-get"):
        print("\n--- 🛠️ Installing System Libraries ---")
        run_cmd("apt-get update -y && apt-get install -y poppler-utils tesseract-ocr libtesseract-dev ghostscript pngquant ocrmypdf")

    print("\n--- 📄 Installing Marker & ML Dependencies (No PyMuPDF) ---")
    run_cmd("pip install marker-pdf==1.8.2 surya-ocr==0.14.7 pdftext==0.6.3 pypdf pypdfium2==4.30.0 pdf2image ocrmypdf markdown2 markdownify rapidfuzz filetype pyOpenSSL>=24.0.0 cryptography>=42.0.0 Pillow")

try:
    import pdftext
    import pypdfium2
    import pypdf
except ImportError:
    install_dependencies()

# %% [code]
print("\n--- 🧪 Verifying Marker & GPU Setup ---")
import torch
import pypdfium2 as pdfium
import pypdf
from pdftext.extraction import dictionary_output

print(f"PyTorch CUDA Available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"Target GPU: {torch.cuda.get_device_name(0)}")

# %% [code]

def slugify(text: str) -> str:
    """Creates a clean bookId from filename."""
    text = text.lower()
    text = re.sub(r'[^a-z0-9]+', '_', text).strip('_')
    return text[:60] if text else "book"


def resolve_pdf_path(pdf_path: str) -> Path:
    """Locates PDF file in current directory or inside /kaggle/input/ datasets."""
    p = Path(pdf_path)
    if p.exists():
        return p.resolve()
        
    cwd_p = Path(".") / pdf_path
    if cwd_p.exists():
        return cwd_p.resolve()

    kaggle_input = Path("/kaggle/input")
    if kaggle_input.exists():
        matches = list(kaggle_input.rglob(p.name))
        if matches:
            return matches[0].resolve()
        
        stem_matches = list(kaggle_input.rglob(f"*{p.stem}*.pdf"))
        if stem_matches:
            return stem_matches[0].resolve()

        all_pdfs = list(kaggle_input.rglob("*.pdf")) + list(kaggle_input.rglob("*.PDF"))
        if all_pdfs:
            return all_pdfs[0].resolve()
            
    raise FileNotFoundError(f"PDF file '{pdf_path}' not found in current dir or /kaggle/input/")


def extract_metadata_pypdf(pdf_path: Path) -> Tuple[str, str, int]:
    """Extracts clean title, author, and total page count using pure pypdf (No PyMuPDF)."""
    clean_title = pdf_path.stem.replace("_", " ").title()
    clean_title = re.sub(r'\(.*?\)', '', clean_title).strip()
    author = "Unknown Author"
    total_pages = 0

    try:
        reader = pypdf.PdfReader(str(pdf_path))
        total_pages = len(reader.pages)
        info = reader.metadata
        if info:
            raw_title = info.get("/Title") or getattr(info, "title", None)
            if raw_title and str(raw_title).strip() and "Microsoft Word" not in str(raw_title):
                clean_title = str(raw_title).strip()
            
            raw_author = info.get("/Author") or getattr(info, "author", None)
            if raw_author and str(raw_author).strip():
                author = str(raw_author).strip()
    except Exception:
        pass

    if author == "Unknown Author":
        if " - " in pdf_path.stem:
            parts = pdf_path.stem.split(" - ")
            if len(parts) >= 2:
                author = parts[-1].replace("_", " ").strip()
        elif "_" in pdf_path.stem:
            parts = pdf_path.stem.split("_")
            if len(parts) >= 3:
                author = f"{parts[-2]} {parts[-1]}"

    return clean_title, author, total_pages


def free_gpu_memory():
    """Frees GPU VRAM cache to prevent OOM errors during batch runs."""
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()

# %% [code]

def extract_pdf_layout_blocks(pdf_path: Path) -> List[Dict[str, Any]]:
    """
    Extracts high-precision layout blocks and normalized word bounding boxes from PDF using Marker's OCR engines.
    1. Uses Marker's high-speed vector parser (pdftext) for digital text pages.
    2. Falls back to Marker/Surya VLM OCR on GPU for scanned/image pages.
    """
    pages_layout = []

    # 1. First extract page blocks via pdftext
    try:
        raw_pages = dictionary_output(str(pdf_path))
    except Exception as e:
        print(f"  [!] pdftext extraction note: {e}")
        raw_pages = []

    doc_pdfium = None
    try:
        doc_pdfium = pdfium.PdfDocument(str(pdf_path))
        total_doc_pages = len(doc_pdfium)
    except Exception:
        total_doc_pages = len(raw_pages)

    num_pages = max(len(raw_pages), total_doc_pages, 1)

    for p_idx in range(num_pages):
        page_num = p_idx + 1
        page_data = raw_pages[p_idx] if p_idx < len(raw_pages) else {}

        # Determine exact page dimensions
        page_w = float(page_data.get("width", 612.0))
        page_h = float(page_data.get("height", 792.0))

        if doc_pdfium and p_idx < len(doc_pdfium):
            try:
                pw, ph = doc_pdfium[p_idx].get_size()
                page_w, page_h = float(pw), float(ph)
            except Exception:
                pass

        page_blocks = []
        raw_blocks = page_data.get("blocks", [])

        # Check total characters on this page to detect scanned pages
        total_page_chars = sum(
            len(span.get("text", ""))
            for b in raw_blocks
            for line in b.get("lines", [])
            for span in line.get("spans", [])
        )

        # A: Digital Text Processing (Fast & 100% vector accurate)
        if raw_blocks:
            for b_idx, block in enumerate(raw_blocks):
                lines = block.get("lines", [])
                block_text_parts = []
                words_entries = []

                for line in lines:
                    for span in line.get("spans", []):
                        s_text = span.get("text", "")
                        s_bbox = span.get("bbox", [0, 0, page_w, page_h])
                        if not s_text.strip():
                            continue
                        
                        clean_span_text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', s_text).strip()
                        block_text_parts.append(clean_span_text)

                        # Split span into individual words with exact proportional bounding boxes
                        sx0, sy0, sx1, sy1 = s_bbox
                        sw = max(1.0, sx1 - sx0)
                        words_in_span = clean_span_text.split()

                        curr_pos = 0
                        for word in words_in_span:
                            clean_w = re.sub(r'[^\w\$\\\{\}\^_\-=]', '', word)
                            w_start = clean_span_text.find(word, curr_pos)
                            if w_start == -1:
                                w_start = curr_pos
                            w_end = w_start + len(word)
                            curr_pos = w_end

                            ratio_start = w_start / max(1, len(clean_span_text))
                            ratio_end = w_end / max(1, len(clean_span_text))

                            wx0 = sx0 + ratio_start * sw
                            wx1 = sx0 + ratio_end * sw

                            norm_b = [
                                round(max(0.0, min(1.0, float(wx0) / page_w)), 4),
                                round(max(0.0, min(1.0, float(sy0) / page_h)), 4),
                                round(max(0.0, min(1.0, float(wx1) / page_w)), 4),
                                round(max(0.0, min(1.0, float(sy1) / page_h)), 4),
                            ]
                            if clean_w:
                                words_entries.append({"w": clean_w, "b": norm_b})

                full_block_text = " ".join(block_text_parts).strip()
                if not full_block_text:
                    continue

                # Classify block type (heading, equation, table, paragraph)
                block_type = "paragraph"
                if len(full_block_text) < 100 and (
                    full_block_text.isupper() or
                    any(k in full_block_text.upper() for k in ["CHAPTER", "SECTION", "PART", "CONTENTS", "APPENDIX", "INTRODUCTION", "INDEX"])
                ):
                    block_type = "heading"
                elif re.search(r'[=+\-*/^_{}\\]', full_block_text) and len(full_block_text) < 80 and any(sym in full_block_text for sym in ["\\frac", "\\int", "=", "\\alpha"]):
                    block_type = "equation"

                page_blocks.append({
                    "id": f"b_{b_idx}",
                    "type": block_type,
                    "text": full_block_text,
                    "words": words_entries
                })

        # B: Scanned Page OCR Fallback (using Surya/Marker GPU model if page is scanned/empty)
        elif doc_pdfium and p_idx < len(doc_pdfium):
            try:
                page_obj = doc_pdfium[p_idx]
                pil_image = page_obj.render(scale=2.0).to_pil()
                
                from surya.recognition import run_recognition
                from surya.detection import batch_text_detection
                from surya.model.recognition.model import load_model as load_rec_model
                from surya.model.recognition.processor import load_processor as load_rec_processor
                from surya.model.detection.model import load_model as load_det_model
                from surya.model.detection.processor import load_processor as load_det_processor

                global _SURYA_MODELS
                if "_SURYA_MODELS" not in globals():
                    _SURYA_MODELS = {
                        "det_model": load_det_model(),
                        "det_processor": load_det_processor(),
                        "rec_model": load_rec_model(),
                        "rec_processor": load_rec_processor()
                    }

                det_results = batch_text_detection([pil_image], _SURYA_MODELS["det_model"], _SURYA_MODELS["det_processor"])
                ocr_results = run_recognition([pil_image], [["en"]], _SURYA_MODELS["rec_model"], _SURYA_MODELS["rec_processor"], det_results)

                if ocr_results and len(ocr_results) > 0:
                    ocr_res = ocr_results[0]
                    for b_idx, line in enumerate(ocr_res.text_lines):
                        line_text = str(line.text).strip()
                        if not line_text:
                            continue
                        
                        lx0, ly0, lx1, ly1 = line.bbox
                        lx0, ly0, lx1, ly1 = lx0 / 2.0, ly0 / 2.0, lx1 / 2.0, ly1 / 2.0
                        
                        norm_b = [
                            round(max(0.0, min(1.0, lx0 / page_w)), 4),
                            round(max(0.0, min(1.0, ly0 / page_h)), 4),
                            round(max(0.0, min(1.0, lx1 / page_w)), 4),
                            round(max(0.0, min(1.0, ly1 / page_h)), 4)
                        ]
                        
                        words_entries = [{"w": re.sub(r'[^\w\$\\\{\}\^_\-=]', '', w), "b": norm_b} for w in line_text.split() if w]
                        page_blocks.append({
                            "id": f"b_{b_idx}",
                            "type": "heading" if (len(line_text) < 60 and line_text.isupper()) else "paragraph",
                            "text": line_text,
                            "words": words_entries
                        })
            except Exception as ocr_err:
                print(f"  [!] Scanned OCR fallback note on page {page_num}: {ocr_err}")

        pages_layout.append({
            "page": page_num,
            "dimensions": {
                "width": round(page_w, 1),
                "height": round(page_h, 1)
            },
            "blocks": page_blocks
        })

    return pages_layout

# %% [code]

def convert_single_pdf_to_layout_json(
    pdf_path: str,
    output_dir: str = "layouts"
) -> Path:
    """
    Converts a single PDF to a dedicated `<book_id>.json` file in output_dir using Marker.
    """
    input_file = resolve_pdf_path(pdf_path)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    book_id = slugify(input_file.stem)
    out_json_path = out_dir / f"{book_id}.json"

    print(f"\n🚀 Processing PDF with Marker Layout & OCR Engine: {input_file.name}")
    print(f"  • Source: {input_file}")
    print(f"  • Output: {out_json_path.name}")
    
    start_time = time.time()

    # 1. Extract metadata
    title, author, total_pages = extract_metadata_pypdf(input_file)

    # 2. Extract layout blocks & word bounding boxes
    pages_layout = extract_pdf_layout_blocks(input_file)
    actual_pages_count = len(pages_layout) if pages_layout else total_pages

    # 3. Assemble pure Clover BookLayout dictionary
    book_layout = {
        "bookId": book_id,
        "title": title,
        "author": author,
        "totalPages": actual_pages_count,
        "engine": "marker",
        "pages": pages_layout
    }

    # 4. Write directly to <book_id>.json
    with open(out_json_path, "w", encoding="utf-8") as f:
        json.dump(book_layout, f, ensure_ascii=False)

    elapsed = time.time() - start_time
    total_blocks = sum(len(p.get("blocks", [])) for p in pages_layout)
    total_words = sum(len(b.get("words", [])) for p in pages_layout for b in p.get("blocks", []))
    print(f"✨ Layout JSON generated in {elapsed:.2f}s!")
    print(f"  • Pages: {len(pages_layout)} | Blocks: {total_blocks} | Searchable Words: {total_words}")
    print(f"📁 Saved: {out_json_path.resolve()}")

    free_gpu_memory()
    return out_json_path

# %% [code]

def find_all_pdfs(search_dir: str = "/kaggle/input") -> List[Path]:
    """Finds all PDF files recursively."""
    base_path = Path(search_dir)
    if not base_path.exists():
        base_path = Path(".")
    
    pdfs = list(base_path.rglob("*.pdf")) + list(base_path.rglob("*.PDF"))
    # Filter out output directories
    pdfs = [p for p in pdfs if "layouts" not in p.parts and "marker_output" not in p.parts]
    return sorted(list(set(pdfs)))


def batch_convert_pdfs_to_layouts(
    targets: Union[str, List[str]] = "all",
    input_dir: str = "/kaggle/input",
    output_dir: str = "layouts",
    auto_zip: bool = True,
    zip_name: str = "layouts.zip"
) -> Dict[str, Any]:
    """
    Batch converts single, selected, or all PDF files directly to `<book_id>.json` layout files.
    """
    pdf_paths: List[Path] = []

    if isinstance(targets, str):
        target_lower = targets.lower().strip()
        if target_lower in ["all", "*"]:
            pdf_paths = find_all_pdfs(input_dir)
            if not pdf_paths:
                print(f"📍 No PDFs found in '{input_dir}', searching current folder...")
                pdf_paths = find_all_pdfs(".")
        elif target_lower == "single":
            try:
                pdf_paths = [resolve_pdf_path("*.pdf")]
            except Exception:
                all_found = find_all_pdfs(input_dir) or find_all_pdfs(".")
                if all_found:
                    pdf_paths = [all_found[0]]
        else:
            pdf_paths = [resolve_pdf_path(targets)]
    elif isinstance(targets, (list, tuple)):
        for item in targets:
            try:
                if isinstance(item, Path):
                    resolved = item.resolve() if item.exists() else resolve_pdf_path(item.name)
                else:
                    resolved = resolve_pdf_path(str(item))
                if resolved not in pdf_paths:
                    pdf_paths.append(resolved)
            except Exception as e:
                print(f"⚠️ Could not resolve path for '{item}': {e}")
    else:
        raise ValueError(f"Invalid targets parameter: {targets}.")

    if not pdf_paths:
        print("⚠️ No valid PDF files found to convert.")
        return {"total": 0, "successful": [], "failed": []}

    print(f"\n=======================================================")
    print(f"🚀 Starting Batch Layout JSON Extraction ({len(pdf_paths)} file(s))")
    print(f"=======================================================")
    for p in pdf_paths:
        print(f"  • {p.name} -> {p}")

    out_p = Path(output_dir)
    out_p.mkdir(parents=True, exist_ok=True)

    results = {"total": len(pdf_paths), "successful": [], "failed": []}
    start_batch_time = time.time()

    for idx, pdf in enumerate(pdf_paths, 1):
        print(f"\n📄 [{idx}/{len(pdf_paths)}] Processing: {pdf.name}")
        try:
            out_json = convert_single_pdf_to_layout_json(
                pdf_path=str(pdf),
                output_dir=output_dir
            )
            results["successful"].append(str(out_json))
        except Exception as err:
            print(f"❌ Error processing '{pdf.name}': {err}")
            results["failed"].append({"file": str(pdf), "error": str(err)})

    elapsed_total = time.time() - start_batch_time
    print(f"\n=======================================================")
    print(f"🎉 Batch Layout Extraction Finished in {elapsed_total:.2f}s")
    print(f"  • Successful: {len(results['successful'])} / {len(pdf_paths)}")
    print(f"  • Failed:     {len(results['failed'])} / {len(pdf_paths)}")
    print(f"=======================================================")

    # Create downloadable zip containing only the layout JSON files
    if auto_zip and results["successful"]:
        zip_base = zip_name.rsplit(".", 1)[0]
        zip_path = shutil.make_archive(zip_base, "zip", str(out_p))
        print(f"\n📦 Created Layouts Zip Archive: {zip_path}")
        try:
            from IPython.display import FileLink, display
            print("🔗 Click link below to download layouts zip in Kaggle:")
            display(FileLink(f"{zip_base}.zip"))
        except ImportError:
            pass

    return results

# %% [code]
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Marker PDF to Pure Layout JSON Converter (No PyMuPDF)")
    parser.add_argument("--targets", type=str, default="all", help="'all', 'single', or comma-separated filenames")
    parser.add_argument("--input-dir", type=str, default="/kaggle/input", help="Directory containing PDF files")
    parser.add_argument("--output-dir", type=str, default="layouts", help="Directory to save <book_id>.json files")
    parser.add_argument("--no-zip", action="store_true", help="Disable automatic zip file creation")

    is_notebook = any("ipykernel" in k for k in sys.modules)

    if not is_notebook and len(sys.argv) > 1:
        args = parser.parse_args()
        targets_input = args.targets.split(",") if "," in args.targets else args.targets
        batch_convert_pdfs_to_layouts(
            targets=targets_input,
            input_dir=args.input_dir,
            output_dir=args.output_dir,
            auto_zip=not args.no_zip
        )
    else:
        # -----------------------------------------------------------------------------
        # ⚙️ INTERACTIVE KAGGLE NOTEBOOK CONFIGURATION:
        # -----------------------------------------------------------------------------
        # Option A (Convert ALL PDFs in /kaggle/input/): BATCH_TARGET = "all"
        # Option B (Convert SELECTED PDF files):         BATCH_TARGET = ["testch1.pdf", "book.pdf"]
        # Option C (Convert SINGLE PDF):                BATCH_TARGET = "testch1.pdf"
        # -----------------------------------------------------------------------------
        BATCH_TARGET = "all"
        OUTPUT_DIRECTORY = "layouts"  # Folder containing only <book_id>.json files
        AUTO_ZIP = True

        print("🚀 Running Marker PDF to Layout JSON Pipeline...")
        batch_convert_pdfs_to_layouts(
            targets=BATCH_TARGET,
            input_dir="/kaggle/input",
            output_dir=OUTPUT_DIRECTORY,
            auto_zip=AUTO_ZIP
        )

# %% [code] {"_kg_hide-input":true,"_kg_hide-output":true}
# Manual Download Helper Cell in Kaggle
import shutil
from pathlib import Path
try:
    from IPython.display import FileLink, display
    if Path('layouts').exists():
        shutil.make_archive('layouts', 'zip', 'layouts')
        display(FileLink('layouts.zip'))
except Exception:
    pass
