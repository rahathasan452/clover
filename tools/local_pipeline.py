#!/usr/bin/env python3
"""
Clover Local PC 1-Click Ingestion, Fast Hybrid OCR & Arctic Hybrid Index Pipeline
---------------------------------------------------------------------------------
Architecture:
- **Ingestion, Fast 2-Tier Hybrid Extraction (`PyMuPDF` Native + `220 DPI WinOCR`/`RapidOCR`,
  with optional `--engine marker`), PDF Linearization (`pikepdf`), Contextual Chunking, and
  Snowflake Arctic 256-d Vector Indexing** run **100% LOCALLY on your PC**.
- Automatically syncs the finished static artifacts (`data/pdfs/`, `data/covers/`, `data/layouts/`,
  `data/catalog.json`, and `data/cloud_index/{manifest.json, passages.json.gz, vectors.bin}`)
  to your free Hugging Face Dataset (`learner20011/CloverTexts-Data`).
- **Online Reading (HTTP 206 Range streaming) & 4-Stage Semantic + BM25 + Cross-Encoder Search**
  work instantly online from **ANY device (phone, tablet, laptop)** with $0 cloud compute!
"""

import os
import re
import sys
import gzip
import json
import time
import socket
import struct
import shutil
import argparse
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple, Callable

import urllib3.util.connection as urllib3_conn

urllib3_conn.allowed_gai_family = lambda: socket.AF_INET

import pikepdf
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer
from huggingface_hub import HfApi, hf_hub_download, CommitOperationAdd

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "public" / "data"
INDEX_DIR = DATA_DIR / "cloud_index"

sys.path.insert(0, str(ROOT_DIR / "tools"))
from chunker import build_contextual_passages
from hybrid_ocr_engine import HybridOcrEngine
from pipeline_core import load_env_config, suggest_book_metadata, slugify


def _get_extractor_engine(ocr_engine: str = "hybrid"):
    if (ocr_engine or "hybrid").strip().lower() == "marker":
        from marker_engine import MarkerLocalEngine

        return MarkerLocalEngine.get(), "Marker"
    return HybridOcrEngine.get(), "Hybrid OCR"

ARCTIC_MODEL_ID = "Snowflake/snowflake-arctic-embed-m-v1.5"
RERANKER_MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2"
MATRYOSHKA_DIM = 256


class ArcticLocalEmbedder:
    """
    Local GPU/CPU Embedder for `Snowflake/snowflake-arctic-embed-m-v1.5`
    producing unit-normalized 256-d Matryoshka Int8 vectors (`[:, 0, :256]`).
    Automatically accelerates on Intel Arc (`xpu` FP16) or NVIDIA (`cuda` FP16) via PyTorch,
    falling back to quantized ONNX Runtime on CPU.
    """

    _instance: Optional["ArcticLocalEmbedder"] = None

    def __init__(self):
        self.tokenizer = AutoTokenizer.from_pretrained(ARCTIC_MODEL_ID)
        self.torch_model = None
        self.torch_device = None
        self.session = None
        self.input_names: List[str] = []

        try:
            import torch
            from transformers import AutoModel

            dev = None
            if torch.cuda.is_available():
                dev = "cuda"
            elif hasattr(torch, "xpu") and torch.xpu.is_available():
                dev = "xpu"

            if dev is not None:
                print(
                    f"[ArcticEmbedder] Loading {ARCTIC_MODEL_ID} ({MATRYOSHKA_DIM}-d FP16) on GPU ({dev})..."
                )
                self.torch_model = (
                    AutoModel.from_pretrained(
                        ARCTIC_MODEL_ID,
                        add_pooling_layer=False,
                        torch_dtype=torch.float16,
                    )
                    .eval()
                    .to(dev)
                )
                self.torch_device = dev
                return
        except Exception as gpu_err:
            print(f"[ArcticEmbedder] GPU init skipped ({gpu_err}), falling back to ONNX CPU...")

        print(f"[ArcticEmbedder] Loading {ARCTIC_MODEL_ID} ({MATRYOSHKA_DIM}-d Matryoshka ONNX CPU)...")
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
    def get(cls) -> "ArcticLocalEmbedder":
        if cls._instance is None:
            cls._instance = ArcticLocalEmbedder()
        return cls._instance

    def embed_passages(
        self,
        texts: List[str],
        batch_size: int = 96,
        max_length: int = 512,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> np.ndarray:
        if not texts:
            return np.zeros((0, MATRYOSHKA_DIM), dtype=np.int8)

        out_batches: List[np.ndarray] = []
        total = len(texts)

        if self.torch_model is not None and self.torch_device is not None:
            import torch

            for start in range(0, total, batch_size):
                batch = texts[start : start + batch_size]
                enc = self.tokenizer(
                    batch,
                    padding=True,
                    truncation=True,
                    max_length=max_length,
                    return_tensors="pt",
                )
                enc_gpu = {
                    k: v.to(self.torch_device)
                    for k, v in enc.items()
                    if k in ("input_ids", "attention_mask")
                }
                with torch.inference_mode():
                    hidden = self.torch_model(**enc_gpu).last_hidden_state
                    cls_256 = hidden[:, 0, :MATRYOSHKA_DIM].float().cpu().numpy()

                norms = np.linalg.norm(cls_256, axis=1, keepdims=True)
                cls_256 = cls_256 / np.maximum(norms, 1e-12)
                quant_i8 = np.clip(np.round(cls_256 * 127.0), -127, 127).astype(np.int8)
                out_batches.append(quant_i8)

                if on_progress:
                    on_progress(min(total, start + batch_size), total)

            return np.vstack(out_batches)

        cpu_bs = min(batch_size, 32)
        for start in range(0, total, cpu_bs):
            batch = texts[start : start + cpu_bs]
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

            if on_progress:
                on_progress(min(total, start + cpu_bs), total)

        return np.vstack(out_batches)


def linearize_pdf_fast_web_view(src_path: Path, dst_path: Path) -> bool:
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


def ensure_local_index_synced_from_hf(hf_repo: str, hf_token: str) -> None:
    """
    If `public/data/cloud_index/` doesn't exist locally yet, pulls the current bundle
    from `learner20011/CloverTexts-Data` so adding 1 new book locally appends cleanly!
    """
    if (
        (INDEX_DIR / "manifest.json").exists()
        and (INDEX_DIR / "passages.json.gz").exists()
        and (INDEX_DIR / "vectors.bin").exists()
    ):
        return

    if not hf_repo:
        return

    tmp_sync = ROOT_DIR / "tools" / "_hf_idx_sync"
    shutil.rmtree(tmp_sync, ignore_errors=True)
    tmp_sync.mkdir(parents=True, exist_ok=True)
    try:
        INDEX_DIR.mkdir(parents=True, exist_ok=True)
        for fname in ("manifest.json", "passages.json.gz", "vectors.bin"):
            dl = hf_hub_download(
                repo_id=hf_repo,
                repo_type="dataset",
                filename=f"data/cloud_index/{fname}",
                local_dir=str(tmp_sync),
                token=hf_token or None,
            )
            shutil.copy2(dl, INDEX_DIR / fname)
        print(f"[LocalPipeline] Synced existing cloud_index from {hf_repo}.")
    except Exception as e:
        print(f"[LocalPipeline] Starting fresh local cloud_index ({e}).")
    finally:
        shutil.rmtree(tmp_sync, ignore_errors=True)


def load_local_index_bundle(
    index_dir: Path = INDEX_DIR,
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
    vecs = (
        np.frombuffer(raw_vec, dtype=np.int8, offset=8 + hlen, count=cnt * dim)
        .reshape((cnt, dim))
        .copy()
    )
    return (
        bundle.get("books", {}),
        bundle.get("passages", []),
        vecs,
        manifest.get("books", {}),
    )


def save_local_index_bundle(
    books_meta_map: Dict[str, Dict[str, str]],
    compact_passages: List[Dict[str, Any]],
    vectors_i8: np.ndarray,
    book_stats: Dict[str, Dict[str, Any]],
    index_dir: Path = INDEX_DIR,
) -> None:
    index_dir.mkdir(parents=True, exist_ok=True)
    count = len(compact_passages)
    assert vectors_i8.shape == (count, MATRYOSHKA_DIM)

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
    (index_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    payload_bytes = json.dumps(
        {"books": books_meta_map, "passages": compact_passages},
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    with gzip.open(index_dir / "passages.json.gz", "wb", compresslevel=9) as gz:
        gz.write(payload_bytes)

    header_bytes = json.dumps(
        {"v": 3, "dim": MATRYOSHKA_DIM, "count": count, "updatedAt": updated_at},
        separators=(",", ":"),
    ).encode("utf-8")
    with open(index_dir / "vectors.bin", "wb") as vf:
        vf.write(b"CLVR")
        vf.write(struct.pack("<I", len(header_bytes)))
        vf.write(header_bytes)
        vf.write(np.ascontiguousarray(vectors_i8, dtype=np.int8).tobytes())


def upsert_book_into_local_index(
    book_entry: Dict[str, Any],
    layout_data: Dict[str, Any],
    on_embed_progress: Optional[Callable[[int, int], None]] = None,
) -> int:
    """
    Contextually chunks `layout_data`, embeds passages with Snowflake Arctic 256-d,
    and updates `public/data/cloud_index/{manifest.json, passages.json.gz, vectors.bin}`.
    """
    b_id = book_entry["id"]
    books_meta_map, compact_passages, vecs_i8, book_stats = load_local_index_bundle(INDEX_DIR)

    # Remove old passages for `b_id` if replacing/re-OCRing
    if any(p["b"] == b_id for p in compact_passages):
        keep_idx = [i for i, p in enumerate(compact_passages) if p["b"] != b_id]
        compact_passages = [compact_passages[i] for i in keep_idx]
        vecs_i8 = (
            vecs_i8[keep_idx]
            if keep_idx
            else np.zeros((0, MATRYOSHKA_DIM), dtype=np.int8)
        )

    passages = build_contextual_passages(book_entry, layout_data)
    if not passages:
        return 0

    new_vecs = ArcticLocalEmbedder.get().embed_passages(
        [p["embedText"] for p in passages],
        batch_size=32,
        on_progress=on_embed_progress,
    )

    books_meta_map[b_id] = {
        "t": book_entry.get("title") or b_id,
        "a": book_entry.get("author") or "Unknown Author",
        "c": book_entry.get("category") or "Uncategorized",
    }
    for p in passages:
        compact_passages.append(
            {
                "i": p["id"],
                "b": b_id,
                "p": int(p["page"]),
                "s": p.get("section") or "",
                "t": p["text"],
                "bb": _passage_union_bbox(p.get("words") or []),
            }
        )

    vecs_i8 = np.vstack([vecs_i8, new_vecs]) if vecs_i8.shape[0] > 0 else new_vecs
    book_stats[b_id] = {
        "passages": len(passages),
        "ocrEngine": layout_data.get("ocrEngine", "marker"),
        "linearized": bool(book_entry.get("linearized", True)),
    }

    save_local_index_bundle(books_meta_map, compact_passages, vecs_i8, book_stats, INDEX_DIR)
    return len(passages)


def ingest_book_local(
    pdf_path: Path,
    title: Optional[str] = None,
    author: Optional[str] = None,
    category: Optional[str] = None,
    tags: Optional[List[str]] = None,
    ocr_engine: str = "hybrid",
    upload_to_hf: bool = True,
    keep_local_pdf: bool = False,
    hf_repo: Optional[str] = None,
    hf_token: Optional[str] = None,
    gemini_api_key: Optional[str] = None,
    on_step: Optional[Callable[[str, int], None]] = None,
) -> Dict[str, Any]:
    """
    1-Click Local PC Book Ingestion:
    1. Auto-tags Title/Author/Category/Tags if not overridden.
    2. Extracts text, columns, headings & OCR via Fast Hybrid (`PyMuPDF` + `220 DPI WinOCR`/`RapidOCR`,
       or optional `--engine marker`).
    3. Linearizes PDF (`pikepdf` `/Linearized 1`).
    4. Updates local + cloud `Snowflake Arctic` hybrid search index (`public/data/cloud_index/`).
    5. Uploads delta commit to Hugging Face Dataset so all online devices can read & search it!
    """
    def report(msg: str, pct: int):
        print(f"  [{pct}%] {msg}")
        if on_step:
            on_step(msg, pct)

    cfg = load_env_config(ROOT_DIR / ".env")
    eff_token = (hf_token or cfg["HF_TOKEN"]).strip()
    eff_repo = (hf_repo or cfg["PUBLIC_HF_DATASET_REPO"]).strip()
    eff_gemini = (gemini_api_key or cfg["GEMINI_API_KEY"]).strip()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cat_path = DATA_DIR / "catalog.json"
    catalog: List[Dict[str, Any]] = (
        json.loads(cat_path.read_text(encoding="utf-8")) if cat_path.exists() else []
    )

    ensure_local_index_synced_from_hf(eff_repo, eff_token)

    if not title or not category or category.lower() == "auto" or not tags:
        report("Running local AI Auto-Tagger...", 5)
        suggested = suggest_book_metadata(
            pdf_path, existing_catalog=catalog, gemini_api_key=eff_gemini or None
        )
        title = title or suggested["title"]
        author = author or suggested["author"]
        category = (
            category
            if (category and category.lower() != "auto")
            else suggested["category"]
        )
        tags = tags or suggested["tags"]

    final_title = (title or pdf_path.stem).strip()
    final_author = (author or "Unknown Author").strip()
    final_cat = (category or "Uncategorized").strip()
    final_tags = tags if tags else [final_cat]
    book_id = slugify(final_title)

    cover_path = DATA_DIR / "covers" / f"{book_id}.png"
    layout_path = DATA_DIR / "layouts" / f"{book_id}.json"
    out_pdf_path = DATA_DIR / "pdfs" / f"{book_id}.pdf"
    layout_path.parent.mkdir(parents=True, exist_ok=True)

    extractor, engine_label = _get_extractor_engine(ocr_engine)
    report(f"Running {engine_label} Layout & Text Extraction...", 12)

    def _ext_prog(done_p: int, tot_p: int):
        pct = 12 + int((done_p / max(1, tot_p)) * 46)
        report(f"{engine_label} extraction: page {done_p}/{tot_p}...", pct)

    layout_data, toc_list = extractor.extract_book_layout(
        pdf_path=pdf_path,
        book_id=book_id,
        title_override=final_title,
        author_override=final_author,
        cover_out_path=cover_path,
        on_progress=_ext_prog,
    )
    layout_path.write_text(
        json.dumps(layout_data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
    )

    report("Linearizing PDF (`pikepdf` Fast Web View for HTTP 206 streaming)...", 62)
    is_lin = linearize_pdf_fast_web_view(pdf_path, out_pdf_path)

    entry: Dict[str, Any] = {
        "id": book_id,
        "title": final_title,
        "author": final_author,
        "totalPages": layout_data["totalPages"],
        "category": final_cat,
        "tags": final_tags,
        "coverUrl": f"data/covers/{book_id}.png",
        "pdfUrl": f"data/pdfs/{book_id}.pdf",
        "layoutUrl": f"data/layouts/{book_id}.json",
        "linearized": bool(is_lin),
        "toc": toc_list,
    }

    report("Chunking & embedding passages with Snowflake Arctic-Embed-m-v1.5...", 68)

    def _emb_prog(done_c: int, tot_c: int):
        pct = 68 + int((done_c / max(1, tot_c)) * 18)
        report(f"Embedding contextual passages ({done_c}/{tot_c})...", pct)

    passage_count = upsert_book_into_local_index(entry, layout_data, on_embed_progress=_emb_prog)

    cat_map = {b["id"]: b for b in catalog if isinstance(b, dict) and "id" in b}
    cat_map[book_id] = entry
    updated_catalog = list(cat_map.values())
    cat_path.write_text(
        json.dumps(updated_catalog, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    uploaded_url = None
    if upload_to_hf and eff_token and eff_repo:
        report(f"Uploading linearized PDF + Arctic index to Hugging Face ({eff_repo})...", 90)
        ops = [
            CommitOperationAdd(
                path_in_repo=f"data/pdfs/{book_id}.pdf", path_or_fileobj=str(out_pdf_path)
            ),
            CommitOperationAdd(
                path_in_repo=f"data/layouts/{book_id}.json", path_or_fileobj=str(layout_path)
            ),
            CommitOperationAdd(
                path_in_repo="data/catalog.json", path_or_fileobj=str(cat_path)
            ),
        ] + [
            CommitOperationAdd(
                path_in_repo=f"data/cloud_index/{fname}",
                path_or_fileobj=str(INDEX_DIR / fname),
            )
            for fname in ("manifest.json", "passages.json.gz", "vectors.bin")
        ]
        if cover_path.exists():
            ops.append(
                CommitOperationAdd(
                    path_in_repo=f"data/covers/{book_id}.png", path_or_fileobj=str(cover_path)
                )
            )

        api = HfApi(token=eff_token)
        c_info = api.create_commit(
            repo_id=eff_repo,
            repo_type="dataset",
            operations=ops,
            commit_message=f"Ingest '{final_title}' ({layout_data.get('ocrEngine', 'hybrid')} + Linearized + Arctic 256-d Index)",
        )
        uploaded_url = getattr(c_info, "commit_url", None)

        if not keep_local_pdf and out_pdf_path.exists():
            out_pdf_path.unlink()

    report(f"Done! '{final_title}' ({passage_count} passages) is live on all devices.", 100)
    return {
        "book": entry,
        "passagesIndexed": passage_count,
        "uploadedUrl": uploaded_url,
    }


ingest_book_local_marker = ingest_book_local


def reocr_and_reembed_hf_library(
    force_all: bool = False,
    only_book_ids: Optional[List[str]] = None,
    ocr_engine: str = "hybrid",
    upload_to_hf: bool = True,
    on_book_step: Optional[Callable[[str, int], None]] = None,
) -> Dict[str, Any]:
    """
    Downloads PDFs from `learner20011/CloverTexts-Data` to your local PC, re-extracts them
    with Fast Hybrid OCR (`PyMuPDF` + `220 DPI WinOCR`/`RapidOCR`, or optional `marker`),
    re-embeds with Snowflake Arctic 256-d, and pushes incremental updates to Hugging Face Dataset!
    """
    cfg = load_env_config(ROOT_DIR / ".env")
    hf_token = cfg["HF_TOKEN"].strip()
    hf_repo = cfg["PUBLIC_HF_DATASET_REPO"].strip()

    ensure_local_index_synced_from_hf(hf_repo, hf_token)

    tmp_work = ROOT_DIR / "tools" / "_reocr_work"
    tmp_work.mkdir(parents=True, exist_ok=True)
    cat_path = DATA_DIR / "catalog.json"

    try:
        dl_cat = hf_hub_download(
            repo_id=hf_repo,
            repo_type="dataset",
            filename="data/catalog.json",
            local_dir=str(tmp_work / "_cat"),
            token=hf_token or None,
            force_download=True,
        )
        catalog = json.loads(Path(dl_cat).read_text(encoding="utf-8"))
        cat_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        catalog = json.loads(cat_path.read_text(encoding="utf-8"))

    priority_scanned = {
        "study_guide_for_technical_analysis_of_the_financial_markets",
        "the_candlestick_course_steve_nison",
        "definitive_guide_to_position_sizing_van_k_tharp",
    }
    ordered_catalog = sorted(
        catalog,
        key=lambda b: (0 if b["id"] in priority_scanned else 1, int(b.get("totalPages") or 500)),
    )

    if only_book_ids:
        target_set = set(only_book_ids)
        ordered_catalog = [b for b in ordered_catalog if b["id"] in target_set]

    extractor, engine_label = _get_extractor_engine(ocr_engine)
    api = HfApi(token=hf_token) if (upload_to_hf and hf_token) else None
    upgraded_count = 0

    _, _, _, existing_book_stats = load_local_index_bundle(INDEX_DIR)
    total_targets = len(ordered_catalog)
    pending_layout_uploads: List[Tuple[str, Path]] = []

    def _flush_hf_batch(reason: str):
        nonlocal pending_layout_uploads
        if not api or not pending_layout_uploads:
            return
        ops = [
            CommitOperationAdd(
                path_in_repo=f"data/layouts/{bid}.json",
                path_or_fileobj=str(lpath),
            )
            for bid, lpath in pending_layout_uploads
        ] + [
            CommitOperationAdd(
                path_in_repo="data/catalog.json",
                path_or_fileobj=str(cat_path),
            ),
        ] + [
            CommitOperationAdd(
                path_in_repo=f"data/cloud_index/{fname}",
                path_or_fileobj=str(INDEX_DIR / fname),
            )
            for fname in ("manifest.json", "passages.json.gz", "vectors.bin")
        ]
        api.create_commit(
            repo_id=hf_repo,
            repo_type="dataset",
            operations=ops,
            commit_message=f"Fast Hybrid OCR + exact word bboxes + Arctic 256-d index ({reason})",
        )
        print(f"    -> Synced batch ({len(pending_layout_uploads)} book layouts + cloud_index) to {hf_repo}!")
        pending_layout_uploads = []

    for idx, book in enumerate(ordered_catalog):
        b_id = book["id"]
        title = book.get("title") or b_id
        local_layout_path = DATA_DIR / "layouts" / f"{b_id}.json"

        if not force_all:
            cur_eng = str((existing_book_stats.get(b_id) or {}).get("ocrEngine") or "")
            already_done = (
                cur_eng.startswith("hybrid")
                if ocr_engine == "hybrid"
                else cur_eng == "marker"
            )
            if already_done:
                print(f"[{idx + 1}/{total_targets}] Skipping '{title}' (already extracted via {cur_eng}).")
                continue

        base_pct = int((idx / max(1, total_targets)) * 95)
        msg_start = f"[{idx + 1}/{total_targets}] {engine_label} & Re-Embedding: {title}..."
        print(f"\n{msg_start}")
        if on_book_step:
            on_book_step(msg_start, max(2, base_pct))

        dl_dir = tmp_work / f"pdf_{b_id}"
        shutil.rmtree(dl_dir, ignore_errors=True)
        dl_dir.mkdir(parents=True, exist_ok=True)

        try:
            pdf_rel = (book.get("pdfUrl") or f"data/pdfs/{b_id}.pdf").lstrip("/")
            pdf_file = Path(
                hf_hub_download(
                    repo_id=hf_repo,
                    repo_type="dataset",
                    filename=pdf_rel,
                    local_dir=str(dl_dir),
                    token=hf_token or None,
                )
            )

            def _p_cb(done_p: int, tot_p: int):
                sub_pct = base_pct + int((done_p / max(1, tot_p)) * (95 / max(1, total_targets)))
                step_txt = f"[{idx + 1}/{total_targets}] {engine_label} '{title}': page {done_p}/{tot_p}"
                print(f"    {step_txt}")
                if on_book_step:
                    on_book_step(step_txt, min(98, sub_pct))

            layout_data, toc_extracted = extractor.extract_book_layout(
                pdf_path=pdf_file,
                book_id=b_id,
                title_override=title,
                author_override=book.get("author"),
                on_progress=_p_cb,
            )

            if toc_extracted and not book.get("toc"):
                book["toc"] = toc_extracted
                cat_path.write_text(
                    json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8"
                )

            local_layout_path.parent.mkdir(parents=True, exist_ok=True)
            local_layout_path.write_text(
                json.dumps(layout_data, separators=(",", ":"), ensure_ascii=False),
                encoding="utf-8",
            )

            book["linearized"] = True
            p_cnt = upsert_book_into_local_index(book, layout_data)
            upgraded_count += 1
            used_eng = layout_data.get("ocrEngine", "hybrid")
            print(f"    -> {used_eng} extracted & embedded {p_cnt} smart passages for '{title}'!")

            pending_layout_uploads.append((b_id, local_layout_path))
            if len(pending_layout_uploads) >= 8:
                _flush_hf_batch(f"{upgraded_count} books upgraded")
        finally:
            shutil.rmtree(dl_dir, ignore_errors=True)

    if pending_layout_uploads:
        _flush_hf_batch(f"all {upgraded_count} books upgraded")

    shutil.rmtree(tmp_work, ignore_errors=True)
    if on_book_step:
        on_book_step(f"Completed {engine_label} & Arctic re-embedding ({upgraded_count} books updated)!", 100)
    return {"upgradedBooks": upgraded_count}


def main():
    parser = argparse.ArgumentParser(
        description="Clover Local PC 1-Click Fast Hybrid OCR Ingestion & Index Pipeline"
    )
    parser.add_argument("--pdf", type=str, help="Path to a single PDF file to ingest locally & push to HF")
    parser.add_argument("--input-dir", type=str, help="Folder of PDFs to batch-ingest locally & push to HF")
    parser.add_argument("--category", type=str, default="auto", help="Category override (default: auto)")
    parser.add_argument(
        "--engine",
        type=str,
        choices=["hybrid", "marker"],
        default="hybrid",
        help="Extraction engine: 'hybrid' (default: fast PyMuPDF + 220 DPI WinOCR/RapidOCR) or 'marker' (deep LaTeX math OCR)",
    )
    parser.add_argument(
        "--reocr-hf",
        action="store_true",
        help="Re-OCR & re-embed existing HF Dataset books locally",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-running extraction even on books already marked as extracted",
    )
    parser.add_argument(
        "--books",
        type=str,
        default="",
        help="Optional comma-separated book IDs for --reocr-hf",
    )
    parser.add_argument("--local-only", action="store_true", help="Do not upload to Hugging Face")
    args = parser.parse_args()

    upload_hf = not args.local_only

    if args.reocr_hf:
        only_ids = [x.strip() for x in args.books.split(",") if x.strip()] or None
        reocr_and_reembed_hf_library(
            force_all=args.force,
            only_book_ids=only_ids,
            ocr_engine=args.engine,
            upload_to_hf=upload_hf,
        )
    elif args.pdf:
        p = Path(args.pdf)
        if not p.exists():
            print(f"File not found: {p}", file=sys.stderr)
            sys.exit(1)
        ingest_book_local(
            pdf_path=p,
            category=args.category,
            ocr_engine=args.engine,
            upload_to_hf=upload_hf,
        )
    elif args.input_dir:
        d = Path(args.input_dir)
        pdfs = sorted(d.glob("*.pdf"))
        print(f"Found {len(pdfs)} PDF(s) in {d}")
        for idx, pdf_file in enumerate(pdfs):
            print(f"\n=== [{idx + 1}/{len(pdfs)}] {pdf_file.name} ===")
            ingest_book_local(
                pdf_path=pdf_file,
                category=args.category,
                ocr_engine=args.engine,
                upload_to_hf=upload_hf,
            )
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
