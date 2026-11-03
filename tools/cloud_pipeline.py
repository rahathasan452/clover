#!/usr/bin/env python3
"""
Clover Serverless Cloud Index Builder, ONNX Scanned-Book OCR & Inbox Pipeline
-----------------------------------------------------------------------------
100% Free ($0) Cloud Architecture powered by Hugging Face Datasets + GitHub Actions:
1. Contextually chunks PDF layouts (`hf_space/chunker.py`: strips running headers/footers,
   2-column reading order, ~950-char overlapping passages + TOC chapter breadcrumbs).
2. Embeds all passages with `Snowflake/snowflake-arctic-embed-m-v1.5` (Matryoshka 256-d Int8,
   CLS pooling + L2 normalization — matches Browser Transformers.js bit-for-bit!).
3. Automatically rescues scanned 0-text PDFs using pure ONNX `RapidOCR` (or `Tesseract`)
   with interpolated word-level `[x0, y0, x1, y1]` bounding boxes!
4. Linearizes PDFs via `pikepdf` (`/Linearized 1` Fast Web View) for HTTP 206 streaming.
5. Outputs ultra-compact `data/cloud_index/{manifest.json, passages.json.gz, vectors.bin}`
   (~10 MB total for 25 books vs 185 MB raw layouts!) and processes `data/inbox/*` uploads
   from any phone, tablet, or laptop!
"""

import os
import re
import sys
import gzip
import json
import time
import struct
import shutil
import argparse
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple

import fitz  # PyMuPDF
import pikepdf
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer
from huggingface_hub import (
    HfApi,
    hf_hub_download,
    CommitOperationAdd,
    CommitOperationDelete,
)

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "hf_space"))
sys.path.insert(0, str(ROOT_DIR / "tools"))

from chunker import build_contextual_passages
from pipeline_core import load_env_config

ARCTIC_MODEL_ID = "Snowflake/snowflake-arctic-embed-m-v1.5"
RERANKER_MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2"
MATRYOSHKA_DIM = 256
ARCTIC_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


def slugify(text: str) -> str:
    s = re.sub(r"(z[-_ ]?lib(rary)?|1lib|pdfdrive|libgen)", "", text.lower())
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s[:64] or f"book_{int(time.time())}"


class ArcticMatryoshkaEmbedder:
    """
    `Snowflake/snowflake-arctic-embed-m-v1.5` ONNX QInt8 Embedder producing
    unit-normalized 256-d Matryoshka vectors (`CLS` token `[:, 0, :256]` -> L2 norm).
    """

    _instance: Optional["ArcticMatryoshkaEmbedder"] = None

    def __init__(self):
        print(f"[ArcticEmbedder] Loading {ARCTIC_MODEL_ID} (QInt8 ONNX, {MATRYOSHKA_DIM}-d MRL)...")
        self.tokenizer = AutoTokenizer.from_pretrained(ARCTIC_MODEL_ID)
        onnx_path = hf_hub_download(
            repo_id=ARCTIC_MODEL_ID, filename="onnx/model_quantized.onnx"
        )
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = max(2, os.cpu_count() or 2)
        self.session = ort.InferenceSession(
            onnx_path, sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self.input_names = [i.name for i in self.session.get_inputs()]

    @classmethod
    def get(cls) -> "ArcticMatryoshkaEmbedder":
        if cls._instance is None:
            cls._instance = ArcticMatryoshkaEmbedder()
        return cls._instance

    def embed_passages(
        self, texts: List[str], batch_size: int = 32, max_length: int = 512
    ) -> np.ndarray:
        if not texts:
            return np.zeros((0, MATRYOSHKA_DIM), dtype=np.int8)

        out_batches: List[np.ndarray] = []
        total = len(texts)
        for start in range(0, total, batch_size):
            batch = texts[start : start + batch_size]
            enc = self.tokenizer(
                batch,
                padding=True,
                truncation=True,
                max_length=max_length,
                return_tensors="np",
            )
            ort_inputs = {}
            for name in self.input_names:
                if name in enc:
                    ort_inputs[name] = enc[name].astype(np.int64)
                elif name == "token_type_ids":
                    ort_inputs[name] = np.zeros_like(enc["input_ids"], dtype=np.int64)

            raw_out = self.session.run(None, ort_inputs)[0]
            cls_256 = (
                raw_out[:, 0, :MATRYOSHKA_DIM].astype(np.float32)
                if raw_out.ndim == 3
                else raw_out[:, :MATRYOSHKA_DIM].astype(np.float32)
            )
            norms = np.linalg.norm(cls_256, axis=1, keepdims=True)
            cls_256 = cls_256 / np.maximum(norms, 1e-12)
            quant_i8 = np.clip(np.round(cls_256 * 127.0), -127, 127).astype(np.int8)
            out_batches.append(quant_i8)

        return np.vstack(out_batches)

    def embed_query_f32(self, query: str) -> np.ndarray:
        prefixed = f"{ARCTIC_QUERY_PREFIX}{query.strip()}"
        enc = self.tokenizer(
            [prefixed], padding=True, truncation=True, max_length=128, return_tensors="np"
        )
        ort_inputs = {}
        for name in self.input_names:
            if name in enc:
                ort_inputs[name] = enc[name].astype(np.int64)
            elif name == "token_type_ids":
                ort_inputs[name] = np.zeros_like(enc["input_ids"], dtype=np.int64)
        raw_out = self.session.run(None, ort_inputs)[0]
        cls_256 = raw_out[0, 0, :MATRYOSHKA_DIM].astype(np.float32)
        return cls_256 / max(float(np.linalg.norm(cls_256)), 1e-12)


_RAPID_OCR_INSTANCE = None


def _get_rapid_ocr():
    global _RAPID_OCR_INSTANCE
    if _RAPID_OCR_INSTANCE is None:
        from rapidocr_onnxruntime import RapidOCR

        _RAPID_OCR_INSTANCE = RapidOCR()
    return _RAPID_OCR_INSTANCE


def extract_pdf_with_onnx_ocr(
    pdf_path: Path,
    book_id: str,
    title_override: Optional[str] = None,
    author_override: Optional[str] = None,
    cover_out_path: Optional[Path] = None,
    ocr_dpi: int = 145,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]], int]:
    """
    Extracts normalized `[x0, y0, x1, y1]` word bounding boxes for every page.
    Automatically runs pure-ONNX RapidOCR on scanned/image-only pages (`< 6` native words)
    and interpolates proportional word-level bounding boxes within each OCR text line!
    """
    has_tesseract = bool(shutil.which("tesseract"))
    doc = fitz.open(str(pdf_path))
    try:
        total_pages = len(doc)
        meta = doc.metadata or {}
        raw_title = (title_override or meta.get("title") or pdf_path.stem).strip()
        raw_author = (author_override or meta.get("author") or "Unknown Author").strip()

        toc_list: List[Dict[str, Any]] = []
        try:
            for item in doc.get_toc(simple=True):
                if len(item) >= 3:
                    lvl, t_str, p_num = item[0], str(item[1]).strip(), int(item[2])
                    if t_str and 1 <= p_num <= total_pages:
                        toc_list.append({"level": int(lvl), "title": t_str, "page": p_num})
        except Exception:
            pass

        if cover_out_path is not None and total_pages > 0:
            cover_out_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                pix0 = doc[0].get_pixmap(dpi=140, alpha=False)
                pix0.save(str(cover_out_path))
            except Exception as cov_err:
                print(f"[Cover warning] {cov_err}")

        pages_out: List[Dict[str, Any]] = []
        ocr_pages_count = 0

        for p_idx in range(total_pages):
            page = doc[p_idx]
            pw = max(float(page.rect.width), 1.0)
            ph = max(float(page.rect.height), 1.0)

            words = page.get_text("words")
            page_blocks: List[Dict[str, Any]] = []

            if len(words) >= 6:
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

                for b_no in sorted(blocks_map.keys()):
                    items = sorted(blocks_map[b_no], key=lambda it: (it[0], it[1]))
                    b_text = " ".join(it[2] for it in items).strip()
                    if b_text:
                        page_blocks.append(
                            {
                                "id": f"{book_id}_p{p_idx + 1}_b{b_no}",
                                "text": b_text,
                                "words": [{"w": it[2], "b": it[3]} for it in items],
                            }
                        )
            else:
                # Scanned / image-only page -> Run OCR!
                if has_tesseract:
                    try:
                        tp = page.get_textpage_ocr(flags=0, language="eng", dpi=ocr_dpi, full=True)
                        ocr_words = page.get_text("words", textpage=tp)
                        if ocr_words:
                            ocr_pages_count += 1
                            blocks_map = {}
                            for w_tuple in ocr_words:
                                x0, y0, x1, y1, w_str, block_no, line_no, word_no = w_tuple[:8]
                                w_clean = str(w_str).strip()
                                if not w_clean:
                                    continue
                                blocks_map.setdefault(int(block_no), []).append(
                                    (
                                        int(line_no),
                                        int(word_no),
                                        w_clean,
                                        [
                                            round(max(0.0, min(1.0, float(x0) / pw)), 4),
                                            round(max(0.0, min(1.0, float(y0) / ph)), 4),
                                            round(max(0.0, min(1.0, float(x1) / pw)), 4),
                                            round(max(0.0, min(1.0, float(y1) / ph)), 4),
                                        ],
                                    )
                                )
                            for b_no in sorted(blocks_map.keys()):
                                items = sorted(blocks_map[b_no], key=lambda it: (it[0], it[1]))
                                b_text = " ".join(it[2] for it in items).strip()
                                if b_text:
                                    page_blocks.append(
                                        {
                                            "id": f"{book_id}_p{p_idx + 1}_b{b_no}",
                                            "text": b_text,
                                            "words": [{"w": it[2], "b": it[3]} for it in items],
                                        }
                                    )
                    except Exception:
                        pass

                if not page_blocks:
                    # Pure ONNX RapidOCR path (works everywhere with zero system dependencies!)
                    try:
                        ocr_engine = _get_rapid_ocr()
                        pix = page.get_pixmap(dpi=ocr_dpi, alpha=False)
                        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                            pix.height, pix.width, pix.n
                        )
                        ocr_res, _ = ocr_engine(img)
                        if ocr_res:
                            ocr_pages_count += 1
                            iw = max(float(pix.width), 1.0)
                            ih = max(float(pix.height), 1.0)
                            # Coalesce adjacent OCR lines into paragraph-sized blocks if vertically close
                            cur_lines_text: List[str] = []
                            cur_words: List[Dict[str, Any]] = []
                            prev_ly1 = -1.0
                            b_counter = 0

                            for det in ocr_res:
                                pts, line_txt, _conf = det[0], str(det[1]).strip(), det[2]
                                if not line_txt:
                                    continue
                                xs = [float(pt[0]) / iw for pt in pts]
                                ys = [float(pt[1]) / ih for pt in pts]
                                lx0 = max(0.0, min(1.0, min(xs)))
                                ly0 = max(0.0, min(1.0, min(ys)))
                                lx1 = max(0.0, min(1.0, max(xs)))
                                ly1 = max(0.0, min(1.0, max(ys)))
                                line_h = max(0.005, ly1 - ly0)

                                # Start new block if vertical gap > 1.8x line height
                                if cur_lines_text and prev_ly1 > 0 and (ly0 - prev_ly1) > line_h * 1.8:
                                    page_blocks.append(
                                        {
                                            "id": f"{book_id}_p{p_idx + 1}_b{b_counter}",
                                            "text": " ".join(cur_lines_text),
                                            "words": cur_words,
                                        }
                                    )
                                    b_counter += 1
                                    cur_lines_text = []
                                    cur_words = []

                                tokens = line_txt.split()
                                total_chars = max(1, sum(len(t) for t in tokens) + max(0, len(tokens) - 1))
                                line_w = max(0.005, lx1 - lx0)
                                char_cursor = 0
                                for tok in tokens:
                                    wx0 = round(lx0 + (char_cursor / total_chars) * line_w, 4)
                                    wx1 = round(
                                        lx0 + ((char_cursor + len(tok)) / total_chars) * line_w, 4
                                    )
                                    cur_words.append(
                                        {
                                            "w": tok,
                                            "b": [wx0, round(ly0, 4), wx1, round(ly1, 4)],
                                        }
                                    )
                                    char_cursor += len(tok) + 1

                                cur_lines_text.append(line_txt)
                                prev_ly1 = ly1

                            if cur_lines_text:
                                page_blocks.append(
                                    {
                                        "id": f"{book_id}_p{p_idx + 1}_b{b_counter}",
                                        "text": " ".join(cur_lines_text),
                                        "words": cur_words,
                                    }
                                )
                    except Exception as rocr_err:
                        if p_idx == 0:
                            print(f"[RapidOCR warning] {pdf_path.name}: {rocr_err}")

            pages_out.append(
                {
                    "page": p_idx + 1,
                    "width": round(pw, 2),
                    "height": round(ph, 2),
                    "blocks": page_blocks,
                }
            )

            if (p_idx + 1) % 25 == 0 or (p_idx + 1) == total_pages:
                print(
                    f"    [{book_id}] Extracted page {p_idx + 1}/{total_pages} (OCR pages: {ocr_pages_count})"
                )

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


def linearize_pdf_file(src_path: Path, dst_path: Path) -> bool:
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with pikepdf.open(str(src_path)) as pdf:
            pdf.save(str(dst_path), linearize=True)
        return True
    except Exception as e:
        print(f"[Linearize warning] {src_path.name}: {e}")
        if src_path.resolve() != dst_path.resolve():
            shutil.copy2(src_path, dst_path)
        return False


def _passage_union_bbox(words: List[Dict[str, Any]]) -> List[float]:
    coords = [w["b"] for w in (words or []) if isinstance(w.get("b"), list) and len(w["b"]) == 4]
    if not coords:
        return [0.06, 0.08, 0.94, 0.92]
    return [
        round(float(min(c[0] for c in coords)), 4),
        round(float(min(c[1] for c in coords)), 4),
        round(float(max(c[2] for c in coords)), 4),
        round(float(max(c[3] for c in coords)), 4),
    ]


def write_cloud_index_bundle(
    out_dir: Path,
    books_meta_map: Dict[str, Dict[str, str]],
    compact_passages: List[Dict[str, Any]],
    vectors_i8: np.ndarray,
    book_stats: Dict[str, Dict[str, Any]],
) -> None:
    """
    Writes the 3 ultra-compact Cloud Index files:
    - `manifest.json`
    - `passages.json.gz` (~5 MB gzipped for 25 books!)
    - `vectors.bin` (`CLVR` header + 256-d Int8 matrix, ~5.5 MB for 25 books!)
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    count = len(compact_passages)
    assert vectors_i8.shape == (count, MATRYOSHKA_DIM), (
        f"Mismatch: {count} passages vs {vectors_i8.shape} vectors"
    )

    updated_at = int(time.time())
    manifest = {
        "version": 3,
        "updatedAt": updated_at,
        "model": ARCTIC_MODEL_ID,
        "reranker": RERANKER_MODEL_ID,
        "dim": MATRYOSHKA_DIM,
        "totalBooks": len(book_stats),
        "totalPassages": count,
        "books": book_stats,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    payload_bytes = json.dumps(
        {"books": books_meta_map, "passages": compact_passages},
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    with gzip.open(out_dir / "passages.json.gz", "wb", compresslevel=9) as gz:
        gz.write(payload_bytes)

    header_bytes = json.dumps(
        {"v": 3, "dim": MATRYOSHKA_DIM, "count": count, "updatedAt": updated_at},
        separators=(",", ":"),
    ).encode("utf-8")
    with open(out_dir / "vectors.bin", "wb") as vf:
        vf.write(b"CLVR")
        vf.write(struct.pack("<I", len(header_bytes)))
        vf.write(header_bytes)
        vf.write(np.ascontiguousarray(vectors_i8, dtype=np.int8).tobytes())

    gz_mb = (out_dir / "passages.json.gz").stat().st_size / (1024 * 1024)
    vec_mb = (out_dir / "vectors.bin").stat().st_size / (1024 * 1024)
    print(
        f"[CloudIndex] Wrote {count} passages across {len(book_stats)} books -> "
        f"passages.json.gz: {gz_mb:.2f} MB | vectors.bin: {vec_mb:.2f} MB"
    )


def load_existing_cloud_index(
    index_dir: Path,
) -> Tuple[Dict[str, Dict[str, str]], List[Dict[str, Any]], np.ndarray, Dict[str, Any]]:
    manifest_p = index_dir / "manifest.json"
    gz_p = index_dir / "passages.json.gz"
    vec_p = index_dir / "vectors.bin"

    if not (manifest_p.exists() and gz_p.exists() and vec_p.exists()):
        return {}, [], np.zeros((0, MATRYOSHKA_DIM), dtype=np.int8), {}

    manifest = json.loads(manifest_p.read_text(encoding="utf-8"))
    with gzip.open(gz_p, "rb") as gz:
        bundle = json.loads(gz.read().decode("utf-8"))

    raw_vec = vec_p.read_bytes()
    assert raw_vec[:4] == b"CLVR"
    hlen = struct.unpack("<I", raw_vec[4:8])[0]
    hmeta = json.loads(raw_vec[8 : 8 + hlen].decode("utf-8"))
    cnt = int(hmeta["count"])
    dim = int(hmeta["dim"])
    vecs = np.frombuffer(raw_vec, dtype=np.int8, offset=8 + hlen, count=cnt * dim).reshape(
        (cnt, dim)
    ).copy()

    return (
        bundle.get("books", {}),
        bundle.get("passages", []),
        vecs,
        manifest.get("books", {}),
    )


def build_full_library_cloud_index(
    hf_repo: str,
    hf_token: str,
    repair_scanned: bool = True,
    linearize_pdfs: bool = True,
    push_hf: bool = True,
) -> None:
    """
    Upgrades all existing books in the library:
    1. Fetches `catalog.json` (remote HF first, local fallback).
    2. Repairs any scanned 0-text books via RapidOCR ONNX + uploads repaired `layouts/<id>.json`.
    3. Contextually chunks & embeds all 25 books with `Snowflake/snowflake-arctic-embed-m-v1.5`.
    4. Optionally linearizes non-linearized PDFs on HF Dataset.
    5. Pushes `data/cloud_index/{manifest.json, passages.json.gz, vectors.bin}` to HF Dataset!
    """
    local_data = ROOT_DIR / "public" / "data"
    work_dir = ROOT_DIR / "tools" / "_cloud_build_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    out_index_dir = work_dir / "cloud_index"

    # 1. Load catalog
    catalog: List[Dict[str, Any]] = []
    try:
        dl_cat = hf_hub_download(
            repo_id=hf_repo,
            repo_type="dataset",
            filename="data/catalog.json",
            local_dir=str(work_dir / "_cat"),
            token=hf_token or None,
            force_download=True,
        )
        catalog = json.loads(Path(dl_cat).read_text(encoding="utf-8"))
    except Exception:
        local_cat = local_data / "catalog.json"
        if local_cat.exists():
            catalog = json.loads(local_cat.read_text(encoding="utf-8"))

    print(f"[CloudBuild] Loaded catalog with {len(catalog)} books.")
    embedder = ArcticMatryoshkaEmbedder.get()
    api = HfApi(token=hf_token) if hf_token else None

    books_meta_map: Dict[str, Dict[str, str]] = {}
    all_compact_passages: List[Dict[str, Any]] = []
    all_vec_chunks: List[np.ndarray] = []
    book_stats: Dict[str, Dict[str, Any]] = {}
    repaired_layout_ops: List[CommitOperationAdd] = []
    catalog_changed = False

    scanned_queue: List[Dict[str, Any]] = []

    for idx, book in enumerate(catalog):
        b_id = book["id"]
        title = book.get("title") or b_id
        print(f"\n[Phase 1: {idx + 1}/{len(catalog)}] Checking '{title}' ({b_id})...")

        local_layout_path = local_data / "layouts" / f"{b_id}.json"
        layout_data: Optional[Dict[str, Any]] = None
        if local_layout_path.exists():
            try:
                layout_data = json.loads(local_layout_path.read_text(encoding="utf-8"))
            except Exception:
                layout_data = None

        if layout_data is None:
            try:
                lp = hf_hub_download(
                    repo_id=hf_repo,
                    repo_type="dataset",
                    filename=f"data/layouts/{b_id}.json",
                    local_dir=str(work_dir / "_layouts"),
                    token=hf_token or None,
                )
                layout_data = json.loads(Path(lp).read_text(encoding="utf-8"))
            except Exception as e:
                print(f"    Layout missing ({e})")

        total_blocks = (
            sum(len(p.get("blocks") or []) for p in (layout_data.get("pages") or []))
            if layout_data
            else 0
        )
        if total_blocks < 20:
            print(f"    -> Scanned 0-text book ({total_blocks} blocks), queued for Phase 2 ONNX OCR.")
            scanned_queue.append(book)
            continue

        passages = build_contextual_passages(book, layout_data)
        if not passages:
            scanned_queue.append(book)
            continue

        vecs_i8 = embedder.embed_passages([p["embedText"] for p in passages], batch_size=32)
        books_meta_map[b_id] = {
            "t": title,
            "a": book.get("author") or "Unknown Author",
            "c": book.get("category") or "Uncategorized",
        }
        for p in passages:
            all_compact_passages.append(
                {
                    "i": p["id"],
                    "b": b_id,
                    "p": int(p["page"]),
                    "s": p.get("section") or "",
                    "t": p["text"],
                    "bb": _passage_union_bbox(p.get("words") or []),
                }
            )
        all_vec_chunks.append(vecs_i8)
        book_stats[b_id] = {
            "passages": len(passages),
            "ocr": False,
            "linearized": bool(book.get("linearized", False)),
        }
        print(f"    -> Indexed {len(passages)} smart passages ({vecs_i8.shape[0]} x {MATRYOSHKA_DIM}-d Int8)")

    final_vecs = (
        np.vstack(all_vec_chunks)
        if all_vec_chunks
        else np.zeros((0, MATRYOSHKA_DIM), dtype=np.int8)
    )
    write_cloud_index_bundle(
        out_index_dir, books_meta_map, all_compact_passages, final_vecs, book_stats
    )

    if push_hf and api and len(book_stats) > 0:
        p1_ops = [
            CommitOperationAdd(
                path_in_repo=f"data/cloud_index/{fname}",
                path_or_fileobj=str(out_index_dir / fname),
            )
            for fname in ("manifest.json", "passages.json.gz", "vectors.bin")
        ]
        print(f"\n[Phase 1 Push] Publishing Cloud Index ({len(book_stats)} text books) to {hf_repo}...")
        c1 = api.create_commit(
            repo_id=hf_repo,
            repo_type="dataset",
            operations=p1_ops,
            commit_message=f"Publish Snowflake Arctic Cloud Index ({len(book_stats)} text books, {len(all_compact_passages)} passages)",
        )
        print(f"[Phase 1 Push] LIVE on HF CDN: {getattr(c1, 'commit_url', 'OK')}")

    # Phase 2: Scanned 0-Text Books ONNX OCR + Incremental Push
    if scanned_queue and repair_scanned:
        for s_idx, book in enumerate(scanned_queue):
            b_id = book["id"]
            title = book.get("title") or b_id
            local_layout_path = local_data / "layouts" / f"{b_id}.json"
            print(f"\n[Phase 2 OCR {s_idx + 1}/{len(scanned_queue)}] Running ONNX RapidOCR on '{title}'...")
            tmp_pdf_dir = work_dir / f"_ocr_{b_id}"
            tmp_pdf_dir.mkdir(parents=True, exist_ok=True)
            try:
                pdf_rel = (book.get("pdfUrl") or f"data/pdfs/{b_id}.pdf").lstrip("/")
                pdf_file = Path(
                    hf_hub_download(
                        repo_id=hf_repo,
                        repo_type="dataset",
                        filename=pdf_rel,
                        local_dir=str(tmp_pdf_dir),
                        token=hf_token or None,
                    )
                )
                layout_data, toc_extracted, ocr_cnt = extract_pdf_with_onnx_ocr(
                    pdf_path=pdf_file,
                    book_id=b_id,
                    title_override=title,
                    author_override=book.get("author"),
                    ocr_dpi=115,
                )
                if toc_extracted and not book.get("toc"):
                    book["toc"] = toc_extracted
                    catalog_changed = True

                local_layout_path.parent.mkdir(parents=True, exist_ok=True)
                local_layout_path.write_text(
                    json.dumps(layout_data, separators=(",", ":"), ensure_ascii=False),
                    encoding="utf-8",
                )

                passages = build_contextual_passages(book, layout_data)
                if passages:
                    vecs_i8 = embedder.embed_passages([p["embedText"] for p in passages], batch_size=32)
                    books_meta_map[b_id] = {
                        "t": title,
                        "a": book.get("author") or "Unknown Author",
                        "c": book.get("category") or "Uncategorized",
                    }
                    for p in passages:
                        all_compact_passages.append(
                            {
                                "i": p["id"],
                                "b": b_id,
                                "p": int(p["page"]),
                                "s": p.get("section") or "",
                                "t": p["text"],
                                "bb": _passage_union_bbox(p.get("words") or []),
                            }
                        )
                    all_vec_chunks.append(vecs_i8)
                    book_stats[b_id] = {
                        "passages": len(passages),
                        "ocr": ocr_cnt > 0,
                        "linearized": True,
                    }

                    final_vecs = np.vstack(all_vec_chunks)
                    write_cloud_index_bundle(
                        out_index_dir, books_meta_map, all_compact_passages, final_vecs, book_stats
                    )

                    if push_hf and api:
                        lin_pdf = tmp_pdf_dir / f"{b_id}_lin.pdf"
                        is_lin = linearize_pdf_file(pdf_file, lin_pdf)
                        book["linearized"] = bool(is_lin)
                        cat_tmp = tmp_pdf_dir / "catalog.json"
                        cat_tmp.write_text(json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8")
                        (local_data / "catalog.json").write_text(
                            json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
                        )

                        ocr_ops = [
                            CommitOperationAdd(
                                path_in_repo=f"data/layouts/{b_id}.json",
                                path_or_fileobj=str(local_layout_path),
                            ),
                            CommitOperationAdd(
                                path_in_repo=pdf_rel,
                                path_or_fileobj=str(lin_pdf),
                            ),
                            CommitOperationAdd(
                                path_in_repo="data/catalog.json",
                                path_or_fileobj=str(cat_tmp),
                            ),
                        ] + [
                            CommitOperationAdd(
                                path_in_repo=f"data/cloud_index/{fname}",
                                path_or_fileobj=str(out_index_dir / fname),
                            )
                            for fname in ("manifest.json", "passages.json.gz", "vectors.bin")
                        ]
                        api.create_commit(
                            repo_id=hf_repo,
                            repo_type="dataset",
                            operations=ocr_ops,
                            commit_message=f"OCR repair + Linearize + Arctic Index: {title} ({ocr_cnt} pages)",
                        )
                        print(f"    -> Committed OCR repair + updated Cloud Index for '{title}'!")
            except Exception as ocr_exc:
                print(f"    -> OCR failed for {b_id}: {ocr_exc}")
            finally:
                shutil.rmtree(tmp_pdf_dir, ignore_errors=True)

    # Optional Phase 3: Linearize non-linearized PDFs on HF Dataset in clean batches
    if linearize_pdfs and push_hf and api:
        non_lin = [b for b in catalog if not b.get("linearized")]
        if non_lin:
            print(f"\n[Linearize] Checking & linearizing {len(non_lin)} PDFs for HTTP 206 Fast Web View...")
            lin_dir = work_dir / "_lin_batch"
            batch_ops: List[CommitOperationAdd] = []
            cat_dirty = False

            for idx_l, book in enumerate(non_lin):
                b_id = book["id"]
                pdf_rel = (book.get("pdfUrl") or f"data/pdfs/{b_id}.pdf").lstrip("/")
                dl_dir = lin_dir / f"dl_{b_id}"
                dl_dir.mkdir(parents=True, exist_ok=True)
                try:
                    src_pdf = Path(
                        hf_hub_download(
                            repo_id=hf_repo,
                            repo_type="dataset",
                            filename=pdf_rel,
                            local_dir=str(dl_dir),
                            token=hf_token,
                        )
                    )
                    with open(src_pdf, "rb") as f:
                        already_lin = b"/Linearized" in f.read(1024)

                    if already_lin:
                        book["linearized"] = True
                        cat_dirty = True
                        print(f"    [{idx_l + 1}/{len(non_lin)}] {b_id}: already linearized")
                    else:
                        out_pdf = lin_dir / f"{b_id}.pdf"
                        if linearize_pdf_file(src_pdf, out_pdf):
                            book["linearized"] = True
                            cat_dirty = True
                            batch_ops.append(
                                CommitOperationAdd(
                                    path_in_repo=pdf_rel, path_or_fileobj=str(out_pdf)
                                )
                            )
                            print(f"    [{idx_l + 1}/{len(non_lin)}] {b_id}: linearized (/Linearized 1)")
                except Exception as lin_e:
                    print(f"    [{idx_l + 1}/{len(non_lin)}] {b_id} warning: {lin_e}")
                finally:
                    shutil.rmtree(dl_dir, ignore_errors=True)

                if len(batch_ops) >= 6:
                    cat_f = lin_dir / "catalog.json"
                    cat_f.write_text(
                        json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
                    )
                    api.create_commit(
                        repo_id=hf_repo,
                        repo_type="dataset",
                        operations=batch_ops
                        + [
                            CommitOperationAdd(
                                path_in_repo="data/catalog.json", path_or_fileobj=str(cat_f)
                            )
                        ],
                        commit_message=f"Linearize {len(batch_ops)} PDFs for HTTP 206 Range streaming",
                    )
                    batch_ops.clear()
                    cat_dirty = False
                    shutil.rmtree(lin_dir, ignore_errors=True)
                    lin_dir.mkdir(parents=True, exist_ok=True)

            if batch_ops or cat_dirty:
                lin_dir.mkdir(parents=True, exist_ok=True)
                cat_f = lin_dir / "catalog.json"
                cat_f.write_text(
                    json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
                )
                (local_data / "catalog.json").write_text(
                    json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
                )
                api.create_commit(
                    repo_id=hf_repo,
                    repo_type="dataset",
                    operations=batch_ops
                    + [
                        CommitOperationAdd(
                            path_in_repo="data/catalog.json", path_or_fileobj=str(cat_f)
                        )
                    ],
                    commit_message="Complete QPDF Fast Web View linearization across catalog",
                )
            shutil.rmtree(lin_dir, ignore_errors=True)

    shutil.rmtree(work_dir, ignore_errors=True)


def process_cloud_inbox(hf_repo: str, hf_token: str) -> int:
    """
    Invoked by GitHub Actions (`.github/workflows/cloud_ingest.yml`) when a user uploads
    one or more PDFs from ANY phone/tablet/laptop into `data/inbox/` on HF Dataset!
    """
    if not hf_token:
        raise RuntimeError("HF_TOKEN is required to process cloud inbox.")

    api = HfApi(token=hf_token)
    try:
        items = list(
            api.list_repo_tree(repo_id=hf_repo, repo_type="dataset", path_in_repo="data/inbox")
        )
    except Exception:
        print("[Inbox] No `data/inbox` folder present yet. Nothing to process.")
        return 0

    meta_files = [
        it.path for it in items if hasattr(it, "path") and it.path.endswith(".meta.json")
    ]
    if not meta_files:
        print("[Inbox] 0 queued books in `data/inbox`.")
        return 0

    print(f"[Inbox] Found {len(meta_files)} queued book(s) to ingest!")
    work_dir = Path("/tmp/clover_inbox_work") if os.name != "nt" else ROOT_DIR / "tools" / "_inbox_work"
    shutil.rmtree(work_dir, ignore_errors=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    # Download current catalog & cloud_index
    cat_p = hf_hub_download(
        repo_id=hf_repo,
        repo_type="dataset",
        filename="data/catalog.json",
        local_dir=str(work_dir / "cur"),
        token=hf_token,
        force_download=True,
    )
    catalog: List[Dict[str, Any]] = json.loads(Path(cat_p).read_text(encoding="utf-8"))
    cat_map = {b["id"]: b for b in catalog if isinstance(b, dict) and "id" in b}

    idx_dir = work_dir / "cur_idx"
    idx_dir.mkdir(parents=True, exist_ok=True)
    for fname in ("manifest.json", "passages.json.gz", "vectors.bin"):
        try:
            dl = hf_hub_download(
                repo_id=hf_repo,
                repo_type="dataset",
                filename=f"data/cloud_index/{fname}",
                local_dir=str(work_dir / "cur"),
                token=hf_token,
                force_download=True,
            )
            shutil.copy2(dl, idx_dir / fname)
        except Exception:
            pass

    books_meta_map, compact_passages, vecs_i8, book_stats = load_existing_cloud_index(idx_dir)
    embedder = ArcticMatryoshkaEmbedder.get()
    commit_ops: List[Any] = []
    processed = 0

    for meta_repo_path in meta_files:
        dl_meta = hf_hub_download(
            repo_id=hf_repo,
            repo_type="dataset",
            filename=meta_repo_path,
            local_dir=str(work_dir / "inbox_dl"),
            token=hf_token,
            force_download=True,
        )
        meta_obj = json.loads(Path(dl_meta).read_text(encoding="utf-8"))
        pdf_repo_path = meta_obj.get("pdfRepoPath") or meta_repo_path.replace(".meta.json", ".pdf")

        dl_pdf = Path(
            hf_hub_download(
                repo_id=hf_repo,
                repo_type="dataset",
                filename=pdf_repo_path,
                local_dir=str(work_dir / "inbox_dl"),
                token=hf_token,
                force_download=True,
            )
        )

        title = (meta_obj.get("title") or dl_pdf.stem).strip()
        author = (meta_obj.get("author") or "Unknown Author").strip()
        category = (meta_obj.get("category") or "Uncategorized").strip()
        tags = meta_obj.get("tags") or [category]
        book_id = meta_obj.get("bookId") or slugify(title)

        print(f"[Inbox] Processing '{title}' -> {book_id}...")
        out_book_dir = work_dir / f"out_{book_id}"
        out_book_dir.mkdir(parents=True, exist_ok=True)
        cover_file = out_book_dir / f"{book_id}.png"
        lin_pdf_file = out_book_dir / f"{book_id}.pdf"
        layout_file = out_book_dir / f"{book_id}.json"

        layout_data, toc_list, ocr_cnt = extract_pdf_with_onnx_ocr(
            pdf_path=dl_pdf,
            book_id=book_id,
            title_override=title,
            author_override=author,
            cover_out_path=cover_file,
        )
        layout_file.write_text(
            json.dumps(layout_data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
        )
        is_lin = linearize_pdf_file(dl_pdf, lin_pdf_file)

        entry = {
            "id": book_id,
            "title": title,
            "author": author,
            "totalPages": layout_data["totalPages"],
            "category": category,
            "tags": tags,
            "coverUrl": f"data/covers/{book_id}.png",
            "pdfUrl": f"data/pdfs/{book_id}.pdf",
            "layoutUrl": f"data/layouts/{book_id}.json",
            "linearized": bool(is_lin),
            "toc": toc_list,
        }
        cat_map[book_id] = entry

        # Remove old passages for `book_id` if replacing an existing book
        if any(p["b"] == book_id for p in compact_passages):
            keep_mask = [i for i, p in enumerate(compact_passages) if p["b"] != book_id]
            compact_passages = [compact_passages[i] for i in keep_mask]
            vecs_i8 = (
                vecs_i8[keep_mask]
                if keep_mask
                else np.zeros((0, MATRYOSHKA_DIM), dtype=np.int8)
            )

        new_passages = build_contextual_passages(entry, layout_data)
        if new_passages:
            new_vecs = embedder.embed_passages([p["embedText"] for p in new_passages], batch_size=32)
            books_meta_map[book_id] = {"t": title, "a": author, "c": category}
            for p in new_passages:
                compact_passages.append(
                    {
                        "i": p["id"],
                        "b": book_id,
                        "p": int(p["page"]),
                        "s": p.get("section") or "",
                        "t": p["text"],
                        "bb": _passage_union_bbox(p.get("words") or []),
                    }
                )
            vecs_i8 = np.vstack([vecs_i8, new_vecs]) if vecs_i8.shape[0] > 0 else new_vecs
            book_stats[book_id] = {
                "passages": len(new_passages),
                "ocr": ocr_cnt > 0,
                "linearized": bool(is_lin),
            }

        commit_ops.extend(
            [
                CommitOperationAdd(
                    path_in_repo=f"data/pdfs/{book_id}.pdf", path_or_fileobj=str(lin_pdf_file)
                ),
                CommitOperationAdd(
                    path_in_repo=f"data/layouts/{book_id}.json", path_or_fileobj=str(layout_file)
                ),
                CommitOperationDelete(path_in_repo=meta_repo_path),
                CommitOperationDelete(path_in_repo=pdf_repo_path),
            ]
        )
        if cover_file.exists():
            commit_ops.append(
                CommitOperationAdd(
                    path_in_repo=f"data/covers/{book_id}.png", path_or_fileobj=str(cover_file)
                )
            )
        processed += 1

    out_idx = work_dir / "updated_idx"
    write_cloud_index_bundle(out_idx, books_meta_map, compact_passages, vecs_i8, book_stats)

    out_cat = work_dir / "catalog.json"
    out_cat.write_text(
        json.dumps(list(cat_map.values()), indent=2, ensure_ascii=False), encoding="utf-8"
    )

    commit_ops.append(
        CommitOperationAdd(path_in_repo="data/catalog.json", path_or_fileobj=str(out_cat))
    )
    for fname in ("manifest.json", "passages.json.gz", "vectors.bin"):
        commit_ops.append(
            CommitOperationAdd(
                path_in_repo=f"data/cloud_index/{fname}",
                path_or_fileobj=str(out_idx / fname),
            )
        )

    api.create_commit(
        repo_id=hf_repo,
        repo_type="dataset",
        operations=commit_ops,
        commit_message=f"Cloud Studio: Ingest {processed} book(s) (Linearized + OCR + Arctic Index)",
    )
    shutil.rmtree(work_dir, ignore_errors=True)
    print(f"[Inbox] Successfully ingested & published {processed} book(s)!")
    return processed


def main():
    parser = argparse.ArgumentParser(description="Clover Serverless Cloud Index & Inbox Pipeline")
    parser.add_argument(
        "--build-all",
        action="store_true",
        help="Repair scanned books, build Arctic Cloud Index for all books & push to HF",
    )
    parser.add_argument(
        "--process-inbox",
        action="store_true",
        help="Process queued PDFs uploaded from mobile/web in `data/inbox/`",
    )
    parser.add_argument(
        "--skip-linearize",
        action="store_true",
        help="Skip Phase 3 bulk PDF linearization",
    )
    args = parser.parse_args()

    cfg = load_env_config(ROOT_DIR / ".env")
    hf_token = cfg.get("HF_TOKEN", "").strip()
    hf_repo = cfg.get("PUBLIC_HF_DATASET_REPO", "learner20011/CloverTexts-Data").strip()

    if args.process_inbox:
        process_cloud_inbox(hf_repo=hf_repo, hf_token=hf_token)
    elif args.build_all:
        build_full_library_cloud_index(
            hf_repo=hf_repo,
            hf_token=hf_token,
            repair_scanned=True,
            linearize_pdfs=not args.skip_linearize,
            push_hf=bool(hf_token),
        )
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
