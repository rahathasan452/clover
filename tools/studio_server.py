#!/usr/bin/env python3
"""
Clover Local 1-Click Ingestion & Auto-Tagging Studio Server (FastAPI)
---------------------------------------------------------------------
Run via:
  python tools/studio_server.py
Or together with Vite UI:
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
import uvicorn

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "public" / "data"
STAGING_DIR = ROOT_DIR / "tools" / "_studio_staging"
STAGING_DIR.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline_core import (
    load_env_config,
    build_dynamic_taxonomy,
    suggest_book_metadata,
    upload_delta_files_to_hf,
)
from ingest import process_single_pdf, backfill_vectors_for_catalog

app = FastAPI(title="Clover 1-Click Book Studio API", version="2.0.0")

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
        with open(cat_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _write_catalog(books: List[Dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(DATA_DIR / "catalog.json", "w", encoding="utf-8") as f:
        json.dump(books, f, indent=2, ensure_ascii=False)


@app.get("/api/studio/health")
def studio_health():
    env_cfg = load_env_config(ROOT_DIR / ".env")
    catalog = _read_catalog()
    vec_dir = DATA_DIR / "vectors"
    vectorized_count = sum(
        1 for b in catalog if (vec_dir / f"{b['id']}.bin").exists()
    )
    taxonomy = build_dynamic_taxonomy(catalog)

    return {
        "ok": True,
        "hfRepo": env_cfg["PUBLIC_HF_DATASET_REPO"],
        "hasHfToken": bool(env_cfg["HF_TOKEN"]),
        "hasGeminiKey": bool(env_cfg["GEMINI_API_KEY"]),
        "totalBooks": len(catalog),
        "vectorizedBooks": vectorized_count,
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
    engine: str = "auto"
    uploadToHf: bool = True
    keepLocalPdf: bool = False
    hfRepo: Optional[str] = None
    hfToken: Optional[str] = None


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
        "step": "Queued for Linearization & Vectorization...",
        "percent": 2,
        "result": None,
        "error": None,
    }

    def _worker():
        try:
            env_cfg = load_env_config(ROOT_DIR / ".env")
            catalog = _read_catalog()
            catalog_map = {b["id"]: b for b in catalog}

            def _on_step(msg: str, pct: int):
                JOBS[job_id]["step"] = msg
                JOBS[job_id]["percent"] = pct

            entry, _, rel_files = process_single_pdf(
                pdf_path=pdf_path,
                output_dir=DATA_DIR,
                engine=req.engine,
                category=req.category,
                tags=req.tags,
                title_override=req.title,
                author_override=req.author,
                generate_vectors=True,
                existing_catalog=catalog,
                on_step=_on_step,
            )

            if not entry:
                raise RuntimeError("PDF processing returned empty result.")

            catalog_map[entry["id"]] = entry
            final_catalog = list(catalog_map.values())
            _write_catalog(final_catalog)
            rel_files.append("catalog.json")

            hf_token = (req.hfToken or "").strip() or env_cfg["HF_TOKEN"]
            hf_repo = (req.hfRepo or "").strip() or env_cfg["PUBLIC_HF_DATASET_REPO"]

            uploaded_url = None
            if req.uploadToHf and hf_token and hf_repo:
                _on_step(f"Delta-uploading to Hugging Face CDN ({hf_repo})...", 92)
                uploaded_url = upload_delta_files_to_hf(
                    DATA_DIR,
                    rel_files,
                    hf_repo,
                    hf_token,
                    f"Add '{entry['title']}' [{entry['category']}] (Linearized + BGE Vectors)",
                )
                if not req.keepLocalPdf:
                    staged_out_pdf = DATA_DIR / "pdfs" / f"{entry['id']}.pdf"
                    if staged_out_pdf.exists():
                        staged_out_pdf.unlink()

            # Clean staging upload
            shutil.rmtree(pdf_path.parent, ignore_errors=True)
            STAGED_FILES.pop(req.stagedId, None)

            JOBS[job_id].update(
                {
                    "status": "completed",
                    "step": "Book Linearized, Vectorized & Published!",
                    "percent": 100,
                    "result": {
                        "book": entry,
                        "uploadedUrl": uploaded_url,
                    },
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


class BackfillRequest(BaseModel):
    uploadToHf: bool = True
    force: bool = False
    hfRepo: Optional[str] = None
    hfToken: Optional[str] = None


@app.post("/api/studio/backfill-vectors")
def studio_backfill_vectors(req: BackfillRequest):
    job_id = uuid.uuid4().hex[:10]
    JOBS[job_id] = {
        "jobId": job_id,
        "status": "running",
        "step": "Loading BGE ONNX model & scanning library layouts...",
        "percent": 3,
        "result": None,
        "error": None,
    }

    def _worker():
        try:
            env_cfg = load_env_config(ROOT_DIR / ".env")

            def _prog(idx: int, total: int, title: str):
                pct = min(88, max(5, int((idx / max(1, total)) * 88)))
                JOBS[job_id]["step"] = f"[{idx}/{total}] Vectorizing: {title}"
                JOBS[job_id]["percent"] = pct

            changed = backfill_vectors_for_catalog(
                DATA_DIR, force=req.force, on_book_progress=_prog
            )

            hf_token = (req.hfToken or "").strip() or env_cfg["HF_TOKEN"]
            hf_repo = (req.hfRepo or "").strip() or env_cfg["PUBLIC_HF_DATASET_REPO"]
            uploaded_url = None

            if req.uploadToHf and hf_token and hf_repo and len(changed) > 1:
                JOBS[job_id]["step"] = f"Syncing {len(changed)} files to Hugging Face CDN..."
                JOBS[job_id]["percent"] = 93
                uploaded_url = upload_delta_files_to_hf(
                    DATA_DIR,
                    changed,
                    hf_repo,
                    hf_token,
                    f"Backfill BGE semantic vector shards ({len(changed) - 1} books)",
                )

            JOBS[job_id].update(
                {
                    "status": "completed",
                    "step": f"Vectorized library complete ({max(0, len(changed) - 1)} new shards)!",
                    "percent": 100,
                    "result": {
                        "shardsCreated": max(0, len(changed) - 1),
                        "uploadedUrl": uploaded_url,
                    },
                }
            )
        except Exception as e:
            JOBS[job_id].update(
                {
                    "status": "error",
                    "step": "Backfill failed",
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
    print("🚀 Clover 1-Click Book Studio API listening at http://127.0.0.1:8765")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")

