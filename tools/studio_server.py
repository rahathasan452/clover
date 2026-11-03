#!/usr/bin/env python3
"""
Clover Local PC 1-Click Marker Ingestion & Auto-Tagging Studio Server (FastAPI)
-------------------------------------------------------------------------------
Runs 100% locally on your PC:
- Auto-tags dropped PDFs (<1s)
- Runs Marker Deep-Learning OCR (`disable_image_extraction=True` — no image cropping/storing)
- Linearizes PDFs via `pikepdf` (`/Linearized 1`) for HTTP 206 streaming
- Chunks & embeds passages via `Snowflake/snowflake-arctic-embed-m-v1.5` (256-d Matryoshka Int8)
- Pushes static linearized PDFs + `data/cloud_index/` to Hugging Face Dataset so any phone,
  tablet, or laptop can read & run 4-stage hybrid search online!

Run together with Vite UI:
  npm run studio
"""

import sys
import uuid
import json
import shutil
import threading
from pathlib import Path
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import torch
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
)
from marker_engine import detect_best_torch_device
from local_pipeline import (
    ingest_book_local_marker,
    reocr_and_reembed_hf_library,
    ensure_local_index_synced_from_hf,
)

app = FastAPI(title="Clover Local 1-Click Marker Studio API", version="3.0.0")

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


def _describe_local_accelerator() -> str:
    dev, _ = detect_best_torch_device()
    if dev == "cuda" and torch.cuda.is_available():
        return f"CUDA ({torch.cuda.get_device_name(0)})"
    if dev == "xpu" and hasattr(torch, "xpu") and torch.xpu.is_available():
        try:
            return f"Intel XPU ({torch.xpu.get_device_name(0)})"
        except Exception:
            return "Intel XPU"
    return "CPU"


@app.get("/api/studio/health")
def studio_health():
    env_cfg = load_env_config(ROOT_DIR / ".env")
    ensure_local_index_synced_from_hf(
        env_cfg["PUBLIC_HF_DATASET_REPO"], env_cfg["HF_TOKEN"]
    )
    catalog = _read_catalog()
    taxonomy = build_dynamic_taxonomy(catalog)

    manifest_path = INDEX_DIR / "manifest.json"
    indexed_books = 0
    marker_books = 0
    total_passages = 0
    if manifest_path.exists():
        try:
            m = json.loads(manifest_path.read_text(encoding="utf-8"))
            b_stats = m.get("books") or {}
            indexed_books = len(b_stats)
            total_passages = int(m.get("totalPassages") or 0)
            marker_books = sum(
                1
                for info in b_stats.values()
                if isinstance(info, dict) and info.get("ocrEngine") == "marker"
            )
        except Exception:
            pass

    return {
        "ok": True,
        "mode": "local",
        "ocrEngine": "marker (disable_image_extraction=True)",
        "embedModel": "Snowflake/snowflake-arctic-embed-m-v1.5 (256-d Int8)",
        "device": _describe_local_accelerator(),
        "hfRepo": env_cfg["PUBLIC_HF_DATASET_REPO"],
        "hasHfToken": bool(env_cfg["HF_TOKEN"]),
        "hasGeminiKey": bool(env_cfg["GEMINI_API_KEY"]),
        "totalBooks": len(catalog),
        "indexedBooks": indexed_books,
        "markerBooks": marker_books,
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

    return {
        "stagedId": staged_id,
        "filename": safe_name,
        **meta,
    }


class IngestJobRequest(BaseModel):
    stagedId: str
    title: str
    author: str
    category: str
    tags: List[str]
    uploadToHf: bool = True
    keepLocalPdf: bool = False
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
        "step": "Queued for Local Marker OCR, Linearization & Arctic Vectorization...",
        "percent": 2,
        "result": None,
        "error": None,
    }

    def _worker():
        try:
            def _on_step(msg: str, pct: int):
                JOBS[job_id]["step"] = msg
                JOBS[job_id]["percent"] = pct

            result = ingest_book_local_marker(
                pdf_path=pdf_path,
                title=req.title,
                author=req.author,
                category=req.category,
                tags=req.tags,
                upload_to_hf=req.uploadToHf,
                keep_local_pdf=req.keepLocalPdf,
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
                    "step": f"Marker OCR + Linearized + Arctic Indexed ({result['passagesIndexed']} passages)!",
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
    onlyBookIds: Optional[List[str]] = None


@app.post("/api/studio/reocr-library")
@app.post("/api/studio/backfill-vectors")
def studio_reocr_library(req: ReocrLibraryRequest):
    job_id = uuid.uuid4().hex[:10]
    JOBS[job_id] = {
        "jobId": job_id,
        "status": "running",
        "step": "Initializing Local Marker OCR (no image cropping) & Snowflake Arctic Embedder...",
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
                upload_to_hf=req.uploadToHf,
                on_book_step=_on_step,
            )

            JOBS[job_id].update(
                {
                    "status": "completed",
                    "step": f"Marker Re-OCR & Arctic Re-Embedding Complete ({out['upgradedBooks']} books updated)!",
                    "percent": 100,
                    "result": out,
                }
            )
        except Exception as e:
            JOBS[job_id].update(
                {
                    "status": "error",
                    "step": "Marker Re-OCR failed",
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


if __name__ == "__main__":
    print("🚀 Clover Local 1-Click Marker Studio API listening at http://127.0.0.1:8765")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
