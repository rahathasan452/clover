#!/usr/bin/env python3
"""
Core Pipeline Engine for Clover:
1. True QPDF Fast-Web-View PDF Linearization (`pikepdf`).
2. Vector Word & Block BBox Extraction (`PyMuPDF` + optional `Marker`).
3. Quantized ONNX Dense Semantic Embeddings (`Xenova/bge-small-en-v1.5` -> `CLVR` Int8 `.bin`).
4. Hybrid Auto-Tagging & Category Suggestion (Local Zero-Shot BGE + Optional Free Gemini API).
5. Fast Atomic Delta-Upload to Hugging Face Dataset CDN (`CommitOperationAdd`).
"""

import os
import re
import json
import struct
import shutil
import urllib.request
import urllib.error
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple, Callable

import numpy as np
import fitz  # PyMuPDF

EMBED_MODEL_REPO = "Snowflake/snowflake-arctic-embed-m-v1.5"
EMBED_DIM = 256
BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

DEFAULT_TAXONOMY: Dict[str, List[str]] = {
    "Trading": [
        "Technical Analysis",
        "Price Action",
        "Algorithmic Trading",
        "Quantitative Finance",
        "Risk Management",
        "Position Sizing",
        "Candlestick Patterns",
        "Trading Psychology",
        "Market Microstructure",
        "Swing Trading",
        "Forex & Currency",
        "Options & Derivatives",
        "Backtesting",
        "Trend Following",
    ],
    "Machine Learning": [
        "Deep Learning",
        "Neural Networks",
        "PyTorch",
        "Scikit-Learn",
        "Statistical Learning",
        "MLOps & ML Systems",
        "Natural Language Processing",
        "Computer Vision",
        "Transformers & LLMs",
        "Reinforcement Learning",
        "Feature Engineering",
    ],
    "Computer Science": [
        "Algorithms & Data Structures",
        "Distributed Systems",
        "Software Architecture",
        "Python Programming",
        "TypeScript & Web",
        "Databases & Storage",
        "Operating Systems",
        "Networking",
        "Cybersecurity",
    ],
    "Engineering": [
        "Signal Processing",
        "Control Systems",
        "Electrical Circuits",
        "Electronics",
        "Embedded Systems",
        "Robotics",
        "Optimization",
    ],
    "Mathematics & Statistics": [
        "Probability & Statistics",
        "Linear Algebra",
        "Calculus",
        "Stochastic Processes",
        "Time Series Analysis",
        "Bayesian Inference",
    ],
}


def load_env_config(env_path: Path = Path(".env")) -> Dict[str, str]:
    cfg = {
        "HF_TOKEN": os.environ.get("HF_TOKEN", ""),
        "PUBLIC_HF_DATASET_REPO": os.environ.get(
            "PUBLIC_HF_DATASET_REPO", "learner20011/CloverTexts-Data"
        ),
        "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", ""),
    }
    if env_path.exists():
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if k in cfg and v and not v.startswith("your_"):
                            cfg[k] = v
        except Exception:
            pass
    return cfg


def slugify(text: str) -> str:
    text = text.lower()
    # Strip common noisy download suffixes
    text = re.sub(r"(z[-_ ]?lib(rary)?|1lib|pdfdrive|libgen)", "", text)
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return text[:64] if text else "book"


def clean_filename_title_author(stem: str, pdf_meta: Dict[str, Any]) -> Tuple[str, str]:
    raw_title = (pdf_meta.get("title") or "").strip()
    raw_author = (pdf_meta.get("author") or "").strip()

    cleaned_stem = re.sub(r"\[.*?\]|\(.*?\)", " ", stem)
    cleaned_stem = re.sub(
        r"(?i)\b(z-library|z_library|1lib|sk|pdf|ebook|edition)\b", " ", cleaned_stem
    )
    cleaned_stem = cleaned_stem.replace("_", " ").replace("  ", " ").strip(" -_")

    if (
        not raw_title
        or "Microsoft Word" in raw_title
        or "Untitled" in raw_title
        or len(raw_title) < 4
        or raw_title.lower().endswith(".pdf")
    ):
        if " - " in cleaned_stem:
            title_part = cleaned_stem.split(" - ")[0].strip()
        else:
            title_part = cleaned_stem
        title = re.sub(r"\s+", " ", title_part).strip()
    else:
        title = re.sub(r"\s+", " ", raw_title).strip()

    if not raw_author or len(raw_author) < 2:
        author = "Unknown Author"
        if " - " in cleaned_stem:
            parts = [p.strip() for p in cleaned_stem.split(" - ") if p.strip()]
            if len(parts) >= 2:
                author = parts[-1]
    else:
        author = re.sub(r"\s+", " ", raw_author).strip()

    return title or "Untitled Book", author


# ---------------------------------------------------------------------------
# Singleton Local Quantized ONNX Embedder (`Xenova/bge-small-en-v1.5`)
# ---------------------------------------------------------------------------
class LocalBGEEmbedder:
    _instance: Optional["LocalBGEEmbedder"] = None

    def __init__(self):
        from huggingface_hub import hf_hub_download
        from transformers import AutoTokenizer
        import onnxruntime as ort

        self.tokenizer = AutoTokenizer.from_pretrained(EMBED_MODEL_REPO)
        onnx_path = hf_hub_download(
            repo_id=EMBED_MODEL_REPO, filename="onnx/model_quantized.onnx"
        )
        sess_opts = ort.SessionOptions()
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers = ["CPUExecutionProvider"]
        self.session = ort.InferenceSession(
            onnx_path, sess_options=sess_opts, providers=providers
        )
        self.input_names = [inp.name for inp in self.session.get_inputs()]

    @classmethod
    def get(cls) -> "LocalBGEEmbedder":
        if cls._instance is None:
            cls._instance = LocalBGEEmbedder()
        return cls._instance

    def embed_texts(
        self,
        texts: List[str],
        batch_size: int = 64,
        is_query: bool = False,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> np.ndarray:
        if not texts:
            return np.zeros((0, EMBED_DIM), dtype=np.float32)

        prefixed = (
            [f"{BGE_QUERY_PREFIX}{t}" for t in texts] if is_query else texts
        )
        all_vecs: List[np.ndarray] = []
        total = len(prefixed)

        for start in range(0, total, batch_size):
            batch = prefixed[start : start + batch_size]
            encoded = self.tokenizer(
                batch,
                padding=True,
                truncation=True,
                max_length=512,
                return_tensors="np",
            )
            ort_inputs = {}
            for name in self.input_names:
                if name in encoded:
                    ort_inputs[name] = encoded[name].astype(np.int64)
                elif name == "token_type_ids":
                    ort_inputs[name] = np.zeros_like(
                        encoded["input_ids"], dtype=np.int64
                    )

            outputs = self.session.run(None, ort_inputs)
            # CLS Pooling + 256-d Matryoshka slice (`[:, 0, :256]`) -> L2 normalize
            cls_emb = outputs[0][:, 0, :EMBED_DIM].astype(np.float32)
            norms = np.linalg.norm(cls_emb, axis=1, keepdims=True)
            norms = np.maximum(norms, 1e-12)
            cls_emb = cls_emb / norms
            all_vecs.append(cls_emb)

            if on_progress:
                on_progress(min(total, start + batch_size), total)

        return np.vstack(all_vecs)


# ---------------------------------------------------------------------------
# Binary Quantized Vector Shard Writer (`CLVR` v1 Int8 `.bin`)
# ---------------------------------------------------------------------------
def build_vector_shard_from_layout(
    book_layout: Dict[str, Any],
    output_bin_path: Path,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> int:
    """
    Encodes every searchable block in `book_layout` using `Xenova/bge-small-en-v1.5`
    and writes a compact single-file `CLVR` Int8 binary shard (`~300-600 KB` per book).
    """
    book_id = book_layout.get("bookId", "book")
    pages = book_layout.get("pages", [])

    ids: List[str] = []
    texts: List[str] = []

    for page_item in pages:
        page_num = page_item.get("page", 1)
        for block in page_item.get("blocks", []):
            raw_text = (block.get("text") or "").strip()
            # Skip ultra-short page numbers / running headers (< 20 chars) for cleaner semantic space
            if len(raw_text) < 20:
                continue
            block_id = block.get("id", "b_0")
            rec_id = f"{book_id}_p{page_num}_{block_id}"
            ids.append(rec_id)
            texts.append(raw_text)

    output_bin_path.parent.mkdir(parents=True, exist_ok=True)

    if not texts:
        header_bytes = json.dumps(
            {
                "version": 1,
                "model": EMBED_MODEL_REPO,
                "dim": EMBED_DIM,
                "count": 0,
                "ids": [],
            }
        ).encode("utf-8")
        with open(output_bin_path, "wb") as f:
            f.write(b"CLVR")
            f.write(struct.pack("<I", len(header_bytes)))
            f.write(header_bytes)
        return 0

    embedder = LocalBGEEmbedder.get()
    float_vecs = embedder.embed_texts(
        texts, batch_size=64, is_query=False, on_progress=on_progress
    )
    int8_vecs = np.clip(np.round(float_vecs * 127.0), -127, 127).astype(np.int8)

    header_obj = {
        "version": 1,
        "model": EMBED_MODEL_REPO,
        "dim": EMBED_DIM,
        "count": len(ids),
        "ids": ids,
    }
    header_bytes = json.dumps(header_obj, separators=(",", ":")).encode("utf-8")

    with open(output_bin_path, "wb") as f:
        f.write(b"CLVR")
        f.write(struct.pack("<I", len(header_bytes)))
        f.write(header_bytes)
        f.write(int8_vecs.tobytes())

    return len(ids)


# ---------------------------------------------------------------------------
# True PDF Linearization ("Fast Web View" via pikepdf / QPDF)
# ---------------------------------------------------------------------------
def linearize_pdf_file(src_pdf: Path, dst_pdf: Path) -> bool:
    """
    Writes a QPDF-linearized ("Fast Web View") PDF so byte 0 contains the
    linearization dictionary + Page 1 xref, enabling instant HTTP Range page loads.
    """
    dst_pdf.parent.mkdir(parents=True, exist_ok=True)
    try:
        import pikepdf

        with pikepdf.open(src_pdf) as pdf:
            pdf.save(
                dst_pdf,
                linearize=True,
                object_stream_mode=pikepdf.ObjectStreamMode.generate,
                compress_streams=True,
            )
        return True
    except Exception as e:
        print(f"  [!] pikepdf linearization fallback ({e}); saving optimized PDF via PyMuPDF...")
        try:
            doc = fitz.open(src_pdf)
            doc.save(str(dst_pdf), garbage=3, deflate=True)
            doc.close()
        except Exception:
            shutil.copy2(src_pdf, dst_pdf)
        return False


# ---------------------------------------------------------------------------
# Hybrid Auto-Tagging & Category Classifier (Local Zero-Shot + Optional Gemini)
# ---------------------------------------------------------------------------
def build_dynamic_taxonomy(existing_catalog: List[Dict[str, Any]]) -> Dict[str, List[str]]:
    taxonomy = {k: list(v) for k, v in DEFAULT_TAXONOMY.items()}
    for book in existing_catalog:
        cat = (book.get("category") or "").strip()
        if not cat or cat == "Uncategorized":
            continue
        if cat not in taxonomy:
            taxonomy[cat] = []
        for tag in book.get("tags") or []:
            t = tag.strip()
            if t and t != cat and t not in taxonomy[cat]:
                taxonomy[cat].append(t)
    return taxonomy


def _suggest_with_gemini(
    title: str,
    author: str,
    toc_titles: List[str],
    sample_text: str,
    taxonomy: Dict[str, List[str]],
    gemini_api_key: str,
) -> Optional[Dict[str, Any]]:
    if not gemini_api_key:
        return None

    known_cats = list(taxonomy.keys())
    prompt = (
        "You are organizing a technical & trading PDF library. "
        "Given the book metadata and excerpt below, return ONLY valid JSON with keys: "
        '{"title": "Clean Book Title", "author": "Author Name", "category": "Best Category", "tags": ["Tag1", "Tag2", "Tag3", "Tag4"]}.\n'
        f"Prefer existing categories when appropriate: {known_cats}.\n"
        f"Raw Title: {title}\n"
        f"Raw Author: {author}\n"
        f"TOC Sample: {toc_titles[:20]}\n"
        f"Text Excerpt: {sample_text[:2500]}"
    )

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={gemini_api_key}"
    payload = json.dumps(
        {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.1,
                "responseMimeType": "application/json",
            },
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            text_out = body["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(text_out)
            if isinstance(parsed, dict) and parsed.get("category"):
                return {
                    "title": parsed.get("title") or title,
                    "author": parsed.get("author") or author,
                    "category": str(parsed["category"]).strip(),
                    "tags": [str(t).strip() for t in (parsed.get("tags") or []) if str(t).strip()][:6],
                    "source": "gemini-flash",
                }
    except Exception as e:
        print(f"  [*] Gemini suggestion skipped/fallback to local zero-shot: {e}")
    return None


def suggest_book_metadata(
    pdf_path: Path,
    existing_catalog: Optional[List[Dict[str, Any]]] = None,
    gemini_api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Inspects a PDF in <1s and predicts clean Title, Author, Category, and Tags
    using Optional Gemini Flash OR 100% Local Zero-Shot BGE Semantic Similarity!
    """
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    file_size = pdf_path.stat().st_size
    title, author = clean_filename_title_author(pdf_path.stem, doc.metadata or {})

    toc_raw = doc.get_toc()
    toc_titles = [t[1].strip() for t in toc_raw if len(t) >= 2 and t[1].strip()]

    sample_pages = []
    for p_idx in range(min(10, total_pages)):
        txt = doc[p_idx].get_text("text").strip()
        if txt:
            sample_pages.append(txt[:800])
    doc.close()

    sample_text = "\n".join(sample_pages)[:3500]
    taxonomy = build_dynamic_taxonomy(existing_catalog or [])

    # 1. Try Gemini Flash if user configured GEMINI_API_KEY
    if gemini_api_key:
        gem_res = _suggest_with_gemini(
            title, author, toc_titles, sample_text, taxonomy, gemini_api_key
        )
        if gem_res:
            return {
                "bookId": slugify(gem_res["title"]),
                "title": gem_res["title"],
                "author": gem_res["author"],
                "totalPages": total_pages,
                "fileSize": file_size,
                "category": gem_res["category"],
                "tags": gem_res["tags"],
                "source": "gemini",
            }

    # 2. Default 100% Free Local Zero-Shot BGE Embedding Classification
    summary_doc = (
        f"Book Title: {title}. Author: {author}. "
        f"Chapters: {', '.join(toc_titles[:25])}. "
        f"Excerpt: {sample_text[:1800]}"
    )

    try:
        embedder = LocalBGEEmbedder.get()
        cat_names = list(taxonomy.keys())
        cat_descriptions = [
            f"Category {cat}: {', '.join(taxonomy[cat][:12])}" for cat in cat_names
        ]

        all_tags: List[str] = []
        for cat in cat_names:
            for t in taxonomy[cat]:
                if t not in all_tags:
                    all_tags.append(t)

        vecs = embedder.embed_texts(
            [summary_doc] + cat_descriptions + [f"Topic: {t}" for t in all_tags],
            batch_size=64,
        )
        doc_vec = vecs[0]
        cat_vecs = vecs[1 : 1 + len(cat_names)]
        tag_vecs = vecs[1 + len(cat_names) :]

        cat_scores = cat_vecs @ doc_vec
        best_cat_idx = int(np.argmax(cat_scores))
        best_category = cat_names[best_cat_idx]

        tag_scores = tag_vecs @ doc_vec
        top_tag_indices = np.argsort(-tag_scores)[:5]
        predicted_tags = [all_tags[int(i)] for i in top_tag_indices if tag_scores[int(i)] >= 0.45]
        if not predicted_tags:
            predicted_tags = [all_tags[int(top_tag_indices[0])]]

        return {
            "bookId": slugify(pdf_path.stem),
            "title": title,
            "author": author,
            "totalPages": total_pages,
            "fileSize": file_size,
            "category": best_category,
            "tags": predicted_tags[:5],
            "source": "local-bge-zeroshot",
        }
    except Exception as e:
        print(f"  [!] Zero-shot tagger fallback: {e}")
        return {
            "bookId": slugify(pdf_path.stem),
            "title": title,
            "author": author,
            "totalPages": total_pages,
            "fileSize": file_size,
            "category": "Trading",
            "tags": ["Technical Analysis"],
            "source": "heuristic",
        }


# ---------------------------------------------------------------------------
# Duplicate Book Contingency Detection Engine
# ---------------------------------------------------------------------------
import difflib


def _normalize_title_for_comparison(title: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9\s]", " ", (title or "").lower())
    return " ".join(cleaned.split())


def check_duplicate_book(
    pdf_path: Optional[Path] = None,
    title: str = "",
    author: str = "",
    total_pages: int = 0,
    existing_catalog: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Checks if a PDF book is already present in catalog.json using:
    1. Exact ID / slug match (slugify(title) or slugify(pdf_path.stem))
    2. Fuzzy Title & Page Count similarity (SequenceMatcher >= 0.88 + pages matching within 5%)
    """
    if not existing_catalog:
        return {"isDuplicate": False, "matchType": None, "existingBook": None, "similarity": 0.0}

    norm_title = _normalize_title_for_comparison(title)
    target_slug = slugify(title) if title else ""
    filename_slug = slugify(pdf_path.stem) if (pdf_path and pdf_path.stem) else ""

    best_match = None
    best_sim = 0.0
    best_type = None

    for b in existing_catalog:
        if not isinstance(b, dict):
            continue
        b_id = str(b.get("id") or "")
        b_title = str(b.get("title") or "")
        b_norm = _normalize_title_for_comparison(b_title)
        b_pages = int(b.get("totalPages") or 0)

        # 1. Exact Title Match
        if norm_title and b_norm and norm_title == b_norm:
            return {
                "isDuplicate": True,
                "matchType": "exact_title",
                "existingBook": b,
                "similarity": 1.0,
            }

        # 2. Exact ID / Slug Match or Slug Containment
        if target_slug:
            if b_id == target_slug or (
                len(target_slug) >= 8 and (target_slug in b_id or b_id in target_slug)
            ):
                return {
                    "isDuplicate": True,
                    "matchType": "exact_slug",
                    "existingBook": b,
                    "similarity": 1.0,
                }
        if filename_slug and (b_id == filename_slug or (len(filename_slug) >= 8 and filename_slug in b_id)):
            return {
                "isDuplicate": True,
                "matchType": "exact_slug",
                "existingBook": b,
                "similarity": 1.0,
            }

        # 3. Fuzzy Title & Page Count Comparison
        if norm_title and b_norm:
            ratio = difflib.SequenceMatcher(None, norm_title, b_norm).ratio()
            if ratio >= 0.90:
                return {
                    "isDuplicate": True,
                    "matchType": "fuzzy_title",
                    "existingBook": b,
                    "similarity": round(ratio, 3),
                }

            if ratio >= 0.78 and total_pages > 0 and b_pages > 0:
                page_diff = abs(total_pages - b_pages)
                if page_diff <= 4 or (page_diff / max(1, b_pages)) <= 0.05:
                    return {
                        "isDuplicate": True,
                        "matchType": "fuzzy_title_and_pages",
                        "existingBook": b,
                        "similarity": round(ratio, 3),
                    }

            if ratio > best_sim:
                best_sim = ratio
                best_match = b
                best_type = "fuzzy_title"

    return {
        "isDuplicate": False,
        "matchType": best_type if best_sim >= 0.75 else None,
        "existingBook": best_match if best_sim >= 0.75 else None,
        "similarity": round(best_sim, 3),
    }


# ---------------------------------------------------------------------------
# Fast Atomic Delta Upload to Hugging Face Dataset CDN
# ---------------------------------------------------------------------------
def upload_delta_files_to_hf(
    local_root_data_dir: Path,
    relative_files: List[str],
    hf_repo: str,
    hf_token: str,
    commit_message: str,
) -> str:
    """
    Uploads ONLY the newly added/updated files in a single atomic commit
    to Hugging Face Datasets (instead of re-scanning all 25+ books).
    """
    from huggingface_hub import HfApi, CommitOperationAdd

    api = HfApi(token=hf_token)
    api.create_repo(repo_id=hf_repo, repo_type="dataset", exist_ok=True)

    operations = []
    for rel in relative_files:
        clean_rel = rel.lstrip("/")
        # If rel starts with "data/", strip "data/" when resolving inside local_root_data_dir (`public/data`)
        sub_rel = clean_rel[5:] if clean_rel.startswith("data/") else clean_rel
        local_file = local_root_data_dir / sub_rel
        if local_file.exists():
            operations.append(
                CommitOperationAdd(
                    path_in_repo=f"data/{sub_rel}".replace("\\", "/"),
                    path_or_fileobj=str(local_file),
                )
            )

    if not operations:
        return f"https://huggingface.co/datasets/{hf_repo}"

    api.create_commit(
        repo_id=hf_repo,
        repo_type="dataset",
        operations=operations,
        commit_message=commit_message,
    )
    return f"https://huggingface.co/datasets/{hf_repo}"

