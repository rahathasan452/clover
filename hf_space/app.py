#!/usr/bin/env python3
"""
Clover Cloud Hybrid Search & 1-Click Book Ingestion Engine (FastAPI)
--------------------------------------------------------------------
Hosted on Hugging Face Docker Spaces (`port 7860`):
- Instant Obsidian Seek-grade Hybrid Search:
  `SQLite FTS5 BM25` + `IBM Granite 278M (768-d QInt8 ONNX)` + `RRF` + `MS-MARCO Cross-Encoder Reranker`
- Online 1-Click PDF Ingestion from ANY device (phone, tablet, laptop):
  `Zero-Shot Auto-Tagger` + `C++ Tesseract Scanned-Page OCR` + `QPDF Linearization` + `HF Dataset Sync`
"""

import os
import time
import uuid
import shutil
import threading
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Dict, List, Any, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from models import GraniteEmbedder, CrossEncoderReranker, GRANITE_REPO, RERANKER_REPO
from search_index import CloudSearchIndex
from pdf_processor import (
    build_dynamic_taxonomy,
    suggest_book_metadata,
    fetch_remote_catalog,
    ingest_pdf_to_cloud,
    bootstrap_and_repair_library,
)

HF_REPO = os.environ.get("HF_DATASET_REPO", "learner20011/CloverTexts-Data").strip()
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
ADMIN_PIN = os.environ.get("ADMIN_PIN", "").strip()

DATA_ROOT = Path(os.environ.get("CLOVER_DATA_DIR", "/app/data"))
INDEX_DIR = DATA_ROOT / "cloud_index"
STAGING_DIR = Path("/tmp/clover_studio_staging")
STAGING_DIR.mkdir(parents=True, exist_ok=True)

INDEX = CloudSearchIndex(INDEX_DIR)

BOOTSTRAP_STATE: Dict[str, Any] = {
    "running": True,
    "phase": "starting",
    "step": "Warming up IBM Granite 278M & Cross-Encoder Reranker...",
    "percent": 2,
    "totalBooks": 0,
}

STAGED_FILES: Dict[str, Path] = {}
JOBS: Dict[str, Dict[str, Any]] = {}

_CATALOG_CACHE: Dict[str, Any] = {"ts": 0.0, "books": []}


def _get_cached_catalog(force: bool = False) -> List[Dict[str, Any]]:
    now = time.time()
    if not force and _CATALOG_CACHE["books"] and (now - _CATALOG_CACHE["ts"] < 45.0):
        return _CATALOG_CACHE["books"]
    books = fetch_remote_catalog(HF_REPO, HF_TOKEN or None)
    if books:
        _CATALOG_CACHE["books"] = books
        _CATALOG_CACHE["ts"] = now
        BOOTSTRAP_STATE["totalBooks"] = len(books)
    return _CATALOG_CACHE["books"]


def _verify_pin(pin_value: Optional[str]) -> None:
    if ADMIN_PIN and (pin_value or "").strip() != ADMIN_PIN:
        raise HTTPException(status_code=403, detail="Invalid Studio Admin PIN.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    def _startup_worker():
        try:
            GraniteEmbedder.get()
            CrossEncoderReranker.get()
        except Exception as model_err:
            print(f"[Startup] Model warmup warning: {model_err}")
        bootstrap_and_repair_library(INDEX, HF_REPO, HF_TOKEN, BOOTSTRAP_STATE)
        _get_cached_catalog(force=True)

    threading.Thread(target=_startup_worker, daemon=True).start()
    yield


app = FastAPI(
    title="Clover Cloud Hybrid Search & Book Studio Engine",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
@app.get("/api/health")
def api_health():
    total_books = BOOTSTRAP_STATE.get("totalBooks") or INDEX.indexed_books_count
    return {
        "ok": True,
        "service": "clover-cloud-engine",
        "hfRepo": HF_REPO,
        "embedModel": GRANITE_REPO,
        "rerankModel": RERANKER_REPO,
        "indexedBooks": INDEX.indexed_books_count,
        "totalBooks": max(total_books, INDEX.indexed_books_count),
        "totalPassages": INDEX.total_passages,
        "bootstrap": BOOTSTRAP_STATE,
    }


class SearchRequest(BaseModel):
    query: str
    bookIdsFilter: Optional[List[str]] = None
    mode: str = "hybrid"
    limit: int = 120


@app.post("/api/search")
def api_search_post(req: SearchRequest):
    mode = req.mode if req.mode in ("hybrid", "semantic", "keyword") else "hybrid"
    limit = max(1, min(250, int(req.limit or 120)))
    return INDEX.search(
        query=req.query,
        book_ids_filter=req.bookIdsFilter,
        mode=mode,
        limit=limit,
    )


@app.get("/api/search")
def api_search_get(
    q: str = Query(..., description="Search query"),
    mode: str = Query("hybrid", description="hybrid | semantic | keyword"),
    limit: int = Query(80, ge=1, le=250),
):
    safe_mode = mode if mode in ("hybrid", "semantic", "keyword") else "hybrid"
    return INDEX.search(query=q, mode=safe_mode, limit=limit)


@app.get("/api/studio/health")
def studio_health():
    catalog = _get_cached_catalog()
    taxonomy = build_dynamic_taxonomy(catalog)
    total_books = max(len(catalog), INDEX.indexed_books_count)
    return {
        "ok": True,
        "mode": "cloud",
        "hfRepo": HF_REPO,
        "hasHfToken": bool(HF_TOKEN),
        "hasGeminiKey": bool(GEMINI_API_KEY),
        "requiresPin": bool(ADMIN_PIN),
        "embedModel": GRANITE_REPO,
        "rerankModel": RERANKER_REPO,
        "totalBooks": total_books,
        "vectorizedBooks": INDEX.indexed_books_count,
        "totalPassages": INDEX.total_passages,
        "bootstrap": BOOTSTRAP_STATE,
        "taxonomy": taxonomy,
    }


@app.post("/api/studio/suggest")
async def studio_suggest(
    file: UploadFile = File(...),
    geminiApiKey: Optional[str] = Form(default=None),
    adminPin: Optional[str] = Form(default=None),
    x_admin_pin: Optional[str] = Header(default=None),
):
    _verify_pin(adminPin or x_admin_pin)
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

    effective_gemini = (geminiApiKey or "").strip() or GEMINI_API_KEY
    catalog = _get_cached_catalog()

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
    adminPin: Optional[str] = None


@app.post("/api/studio/ingest")
def studio_ingest(
    req: IngestJobRequest,
    x_admin_pin: Optional[str] = Header(default=None),
):
    _verify_pin(req.adminPin or x_admin_pin)
    if not HF_TOKEN:
        raise HTTPException(
            status_code=500,
            detail="HF_TOKEN secret is not configured on this Hugging Face Space.",
        )

    pdf_path = STAGED_FILES.get(req.stagedId)
    if not pdf_path or not pdf_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Staged PDF expired or not found. Please drop the PDF again.",
        )

    job_id = uuid.uuid4().hex[:10]
    JOBS[job_id] = {
        "jobId": job_id,
        "status": "running",
        "step": "Starting OCR check, Linearization & Granite 278M Vectorization...",
        "percent": 4,
        "result": None,
        "error": None,
    }

    def _worker():
        try:
            def _on_step(msg: str, pct: int):
                JOBS[job_id]["step"] = msg
                JOBS[job_id]["percent"] = pct

            res = ingest_pdf_to_cloud(
                pdf_path=pdf_path,
                title=req.title.strip(),
                author=req.author.strip() or "Unknown Author",
                category=req.category.strip() or "Uncategorized",
                tags=req.tags,
                index=INDEX,
                hf_repo=HF_REPO,
                hf_token=HF_TOKEN,
                on_step=_on_step,
            )

            _get_cached_catalog(force=True)
            shutil.rmtree(pdf_path.parent, ignore_errors=True)
            STAGED_FILES.pop(req.stagedId, None)

            JOBS[job_id].update(
                {
                    "status": "completed",
                    "step": "Linearized, Vectorized & Live on All Devices!",
                    "percent": 100,
                    "result": res,
                }
            )
        except Exception as exc:
            JOBS[job_id].update(
                {
                    "status": "error",
                    "step": "Failed",
                    "error": str(exc),
                }
            )

    threading.Thread(target=_worker, daemon=True).start()
    return {"jobId": job_id}


@app.post("/api/studio/backfill-vectors")
@app.post("/api/studio/repair")
def studio_repair_library(x_admin_pin: Optional[str] = Header(default=None)):
    _verify_pin(x_admin_pin)
    job_id = uuid.uuid4().hex[:10]
    JOBS[job_id] = {
        "jobId": job_id,
        "status": "running",
        "step": BOOTSTRAP_STATE.get("step") or "Running library OCR & Granite index check...",
        "percent": BOOTSTRAP_STATE.get("percent") or 10,
        "result": None,
        "error": None,
    }

    def _monitor_or_run():
        try:
            if not BOOTSTRAP_STATE.get("running"):
                bootstrap_and_repair_library(INDEX, HF_REPO, HF_TOKEN, BOOTSTRAP_STATE)
            else:
                while BOOTSTRAP_STATE.get("running"):
                    JOBS[job_id]["step"] = BOOTSTRAP_STATE.get("step", "Processing...")
                    JOBS[job_id]["percent"] = BOOTSTRAP_STATE.get("percent", 50)
                    time.sleep(1.0)

            _get_cached_catalog(force=True)
            JOBS[job_id].update(
                {
                    "status": "completed",
                    "step": f"All {INDEX.indexed_books_count} books indexed, OCR-repaired & linearized!",
                    "percent": 100,
                    "result": {
                        "indexedBooks": INDEX.indexed_books_count,
                        "totalPassages": INDEX.total_passages,
                    },
                }
            )
        except Exception as e:
            JOBS[job_id].update(
                {
                    "status": "error",
                    "step": "Repair failed",
                    "error": str(e),
                }
            )

    threading.Thread(target=_monitor_or_run, daemon=True).start()
    return {"jobId": job_id}


@app.get("/api/studio/job/{job_id}")
def studio_job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

