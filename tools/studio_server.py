#!/usr/bin/env python3
"""
Clover Local PC 1-Click Fast Hybrid OCR Ingestion & Auto-Tagging Studio Server (FastAPI)
----------------------------------------------------------------------------------------
Runs 100% locally on your PC:
- Auto-tags dropped PDFs (<1s)
- Runs Fast 2-Tier Hybrid Extraction (`PyMuPDF` Native + `220 DPI WinOCR`/`RapidOCR`,
  or optional `Marker` for heavy LaTeX math papers)
- Linearizes PDFs via `pikepdf` (`/Linearized 1`) for HTTP 206 streaming
- Chunks & embeds passages via `Snowflake/snowflake-arctic-embed-m-v1.5` (256-d Matryoshka Int8)
- Pushes static linearized PDFs + `data/cloud_index/` to Hugging Face Dataset so any phone,
  tablet, or laptop can read & run 4-stage hybrid search online!

Run together with Vite UI:
  npm run studio
"""

import os
import sys
import uuid
import json
import shutil
import threading
from pathlib import Path
from typing import List, Optional, Dict, Any

# Ensure Windows cp1252 / cmd console won't crash on Unicode/emojis
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "public" / "data"
INDEX_DIR = DATA_DIR / "cloud_index"
STAGING_DIR = ROOT_DIR / "tools" / "_studio_staging"
STAGING_DIR.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline_core import (
    load_env_config,
    build_dynamic_taxonomy,
    suggest_book_metadata,
    check_duplicate_book,
)
from hybrid_ocr_engine import HybridOcrEngine
from local_pipeline import (
    ingest_book_local,
    reocr_and_reembed_hf_library,
    ensure_local_index_synced_from_hf,
)

app = FastAPI(title="Clover Local 1-Click Hybrid Studio API", version="3.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STAGED_FILES: Dict[str, Path] = {}
JOBS: Dict[str, Dict[str, Any]] = {}


def _read_catalog() -> List[Dict[str, Any]]:
    cat_path = DATA_DIR / "catalog.json"
    if not cat_path.exists():
        return []
    try:
        return json.loads(cat_path.read_text(encoding="utf-8"))
    except Exception:
        return []


def _describe_local_engine() -> str:
    eng = HybridOcrEngine.get()
    threads = os.cpu_count() or 4
    return f"PyMuPDF + {eng.backend_name.upper()} ({threads} threads)"


@app.on_event("startup")
def _on_startup():
    def _bg_sync():
        try:
            env_cfg = load_env_config(ROOT_DIR / ".env")
            repo = env_cfg.get("PUBLIC_HF_DATASET_REPO")
            token = env_cfg.get("HF_TOKEN")
            if repo:
                ensure_local_index_synced_from_hf(repo, token)
        except Exception as e:
            print(f"[!] Warning: Initial background HF sync check failed: {e}")

    threading.Thread(target=_bg_sync, daemon=True).start()


@app.get("/api/studio/health")
def studio_health():
    env_cfg = load_env_config(ROOT_DIR / ".env")
    catalog = _read_catalog()
    taxonomy = build_dynamic_taxonomy(catalog)

    manifest_path = INDEX_DIR / "manifest.json"
    indexed_books = 0
    upgraded_books = 0
    total_passages = 0
    if manifest_path.exists():
        try:
            m = json.loads(manifest_path.read_text(encoding="utf-8"))
            b_stats = m.get("books") or {}
            indexed_books = len(b_stats)
            total_passages = int(m.get("totalPassages") or 0)
            upgraded_books = sum(
                1
                for info in b_stats.values()
                if isinstance(info, dict)
                and (
                    str(info.get("ocrEngine") or "") == "marker"
                    or str(info.get("ocrEngine") or "").startswith("hybrid")
                    or int(info.get("passages") or 0) > 0
                )
            )
        except Exception:
            pass

    return {
        "ok": True,
        "mode": "local",
        "ocrEngine": "hybrid (PyMuPDF + 220 DPI WinOCR/RapidOCR)",
        "embedModel": "Snowflake/snowflake-arctic-embed-m-v1.5 (256-d Int8)",
        "device": _describe_local_engine(),
        "hfRepo": env_cfg["PUBLIC_HF_DATASET_REPO"],
        "hasHfToken": bool(env_cfg["HF_TOKEN"]),
        "hasGeminiKey": bool(env_cfg["GEMINI_API_KEY"]),
        "totalBooks": len(catalog),
        "indexedBooks": indexed_books,
        "markerBooks": upgraded_books,
        "totalPassages": total_passages,
        "taxonomy": taxonomy,
    }


@app.post("/api/studio/suggest")
async def studio_suggest(
    file: UploadFile = File(...),
    geminiApiKey: Optional[str] = Form(default=None),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    staged_id = uuid.uuid4().hex[:12]
    safe_name = Path(file.filename).name
    staged_dir = STAGING_DIR / staged_id
    staged_dir.mkdir(parents=True, exist_ok=True)
    staged_pdf = staged_dir / safe_name

    with open(staged_pdf, "wb") as out_f:
        shutil.copyfileobj(file.file, out_f)

    STAGED_FILES[staged_id] = staged_pdf

    env_cfg = load_env_config(ROOT_DIR / ".env")
    effective_gemini = (geminiApiKey or "").strip() or env_cfg["GEMINI_API_KEY"]
    catalog = _read_catalog()

    meta = suggest_book_metadata(
        staged_pdf,
        existing_catalog=catalog,
        gemini_api_key=effective_gemini or None,
    )

    dup_info = check_duplicate_book(
        pdf_path=staged_pdf,
        title=meta.get("title", ""),
        author=meta.get("author", ""),
        total_pages=meta.get("totalPages", 0),
        existing_catalog=catalog,
    )

    return {
        "stagedId": staged_id,
        "filename": safe_name,
        "isDuplicate": dup_info["isDuplicate"],
        "duplicateType": dup_info["matchType"],
        "duplicateBook": dup_info["existingBook"],
        "similarity": dup_info["similarity"],
        **meta,
    }


class IngestJobRequest(BaseModel):
    stagedId: str
    title: str
    author: str
    category: str
    tags: List[str]
    ocrEngine: str = "hybrid"
    uploadToHf: bool = True
    keepLocalPdf: bool = False
    duplicateAction: str = "replace"  # "replace" | "skip" | "version"
    hfRepo: Optional[str] = None
    hfToken: Optional[str] = None
    geminiApiKey: Optional[str] = None


@app.post("/api/studio/ingest")
def studio_start_ingest(req: IngestJobRequest):
    pdf_path = STAGED_FILES.get(req.stagedId)
    if not pdf_path or not pdf_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Staged PDF file expired or not found. Please drop the PDF again.",
        )

    job_id = uuid.uuid4().hex[:10]
    JOBS[job_id] = {
        "jobId": job_id,
        "status": "running",
        "step": "Queued for Local Fast Hybrid OCR, Linearization & Arctic Vectorization...",
        "percent": 2,
        "result": None,
        "error": None,
    }

    def _worker():
        try:
            def _on_step(msg: str, pct: int):
                JOBS[job_id]["step"] = msg
                JOBS[job_id]["percent"] = pct

            result = ingest_book_local(
                pdf_path=pdf_path,
                title=req.title,
                author=req.author,
                category=req.category,
                tags=req.tags,
                ocr_engine=req.ocrEngine or "hybrid",
                upload_to_hf=req.uploadToHf,
                keep_local_pdf=req.keepLocalPdf,
                duplicate_action=req.duplicateAction,
                hf_repo=req.hfRepo,
                hf_token=req.hfToken,
                gemini_api_key=req.geminiApiKey,
                on_step=_on_step,
            )

            shutil.rmtree(pdf_path.parent, ignore_errors=True)
            STAGED_FILES.pop(req.stagedId, None)

            JOBS[job_id].update(
                {
                    "status": "completed",
                    "step": f"Hybrid Extracted + Linearized + Arctic Indexed ({result['passagesIndexed']} passages)!",
                    "percent": 100,
                    "result": result,
                }
            )
        except Exception as e:
            JOBS[job_id].update(
                {
                    "status": "error",
                    "step": "Failed",
                    "error": str(e),
                }
            )

    threading.Thread(target=_worker, daemon=True).start()
    return {"jobId": job_id}


class ReocrLibraryRequest(BaseModel):
    uploadToHf: bool = True
    force: bool = False
    ocrEngine: str = "hybrid"
    onlyBookIds: Optional[List[str]] = None


@app.post("/api/studio/reocr-library")
@app.post("/api/studio/backfill-vectors")
def studio_reocr_library(req: ReocrLibraryRequest):
    job_id = uuid.uuid4().hex[:10]
    JOBS[job_id] = {
        "jobId": job_id,
        "status": "running",
        "step": "Initializing Local Fast Hybrid OCR & Snowflake Arctic Embedder...",
        "percent": 2,
        "result": None,
        "error": None,
    }

    def _worker():
        try:
            def _on_step(msg: str, pct: int):
                JOBS[job_id]["step"] = msg
                JOBS[job_id]["percent"] = pct

            out = reocr_and_reembed_hf_library(
                force_all=req.force,
                only_book_ids=req.onlyBookIds,
                ocr_engine=req.ocrEngine or "hybrid",
                upload_to_hf=req.uploadToHf,
                on_book_step=_on_step,
            )

            JOBS[job_id].update(
                {
                    "status": "completed",
                    "step": f"Hybrid Re-OCR & Arctic Re-Embedding Complete ({out['upgradedBooks']} books updated)!",
                    "percent": 100,
                    "result": out,
                }
            )
        except Exception as e:
            JOBS[job_id].update(
                {
                    "status": "error",
                    "step": "Re-OCR failed",
                    "error": str(e),
                }
            )

    threading.Thread(target=_worker, daemon=True).start()
    return {"jobId": job_id}


@app.get("/api/studio/job/{job_id}")
def studio_job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


class UpdateBookMetadataRequest(BaseModel):
    id: str
    title: str
    author: str
    category: str
    tags: List[str]
    description: Optional[str] = ""
    uploadToHf: bool = True
    hfRepo: Optional[str] = None
    hfToken: Optional[str] = None


@app.post("/api/studio/book/update")
def studio_update_book_metadata(req: UpdateBookMetadataRequest):
    cat_path = DATA_DIR / "catalog.json"
    if not cat_path.exists():
        raise HTTPException(status_code=404, detail="catalog.json not found on disk")

    try:
        catalog = json.loads(cat_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read catalog.json: {e}")

    target_book = None
    for b in catalog:
        if b.get("id") == req.id:
            target_book = b
            break

    if not target_book:
        raise HTTPException(status_code=404, detail=f"Book with id '{req.id}' not found in catalog")

    target_book["title"] = req.title.strip()
    target_book["author"] = req.author.strip()
    target_book["category"] = req.category.strip() or "Uncategorized"
    target_book["tags"] = [t.strip() for t in req.tags if t.strip()]
    if req.description is not None:
        target_book["description"] = req.description.strip()

    cat_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8")

    # Update cloud_index bundle if it exists
    gz_p = INDEX_DIR / "passages.json.gz"
    if gz_p.exists():
        try:
            import gzip
            with gzip.open(gz_p, "rb") as gz:
                bundle = json.loads(gz.read().decode("utf-8"))
            if "books" in bundle and req.id in bundle["books"]:
                bundle["books"][req.id]["t"] = target_book["title"]
                bundle["books"][req.id]["a"] = target_book["author"]
                bundle["books"][req.id]["c"] = target_book["category"]
                with gzip.open(gz_p, "wb", compresslevel=9) as gz:
                    gz.write(
                        json.dumps(bundle, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                    )
        except Exception as e:
            print(f"[!] Warning: failed to update cloud_index bundle: {e}")

    # Manifest update if exists
    manifest_p = INDEX_DIR / "manifest.json"
    if manifest_p.exists():
        try:
            manifest = json.loads(manifest_p.read_text(encoding="utf-8"))
            if "books" in manifest and req.id in manifest["books"]:
                if isinstance(manifest["books"][req.id], dict):
                    manifest["books"][req.id]["category"] = target_book["category"]
                manifest_p.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception as e:
            print(f"[!] Warning: failed to update manifest: {e}")

    synced_to_hf = False
    if req.uploadToHf:
        env_cfg = load_env_config(ROOT_DIR / ".env")
        eff_repo = (req.hfRepo or env_cfg.get("PUBLIC_HF_DATASET_REPO") or "").strip()
        eff_token = (req.hfToken or env_cfg.get("HF_TOKEN") or "").strip()
        if eff_repo and eff_token:
            try:
                from huggingface_hub import HfApi, CommitOperationAdd

                api = HfApi(token=eff_token)
                ops = [
                    CommitOperationAdd(
                        path_in_repo="data/catalog.json",
                        path_or_fileobj=str(cat_path),
                    )
                ]
                if gz_p.exists():
                    ops.append(
                        CommitOperationAdd(
                            path_in_repo="data/cloud_index/passages.json.gz",
                            path_or_fileobj=str(gz_p),
                        )
                    )
                if manifest_p.exists():
                    ops.append(
                        CommitOperationAdd(
                            path_in_repo="data/cloud_index/manifest.json",
                            path_or_fileobj=str(manifest_p),
                        )
                    )
                api.create_commit(
                    repo_id=eff_repo,
                    repo_type="dataset",
                    operations=ops,
                    commit_message=f"Update metadata for '{target_book['title']}' ({target_book['id']})",
                )
                synced_to_hf = True
            except Exception as e:
                print(f"[!] Warning: HF metadata upload failed: {e}")

    return {
        "ok": True,
        "book": target_book,
        "syncedToHf": synced_to_hf,
    }


def get_server_port() -> int:
    import socket
    pref = int(os.environ.get("STUDIO_PORT", 8088))
    for p in [pref, 8088, 8089, 8090, 8686, 8000]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return pref


if __name__ == "__main__":
    port = get_server_port()
    print(f"🚀 Clover Local 1-Click Hybrid Studio API listening at http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
