#!/usr/bin/env python3
"""
Local Marker Deep-Learning OCR & Layout Engine (No Image Cropping)
------------------------------------------------------------------
Uses `marker-pdf` (`PdfConverter` + `ChunkRenderer`) with `disable_image_extraction=True`
(`extract_images=False`) so charts/figures are NEVER cropped or written to disk (~2x faster!).

Hardware Acceleration:
- Automatically detects Intel Arc GPU (`xpu` fp16), NVIDIA GPU (`cuda` bf16), or CPU.
- Keeps Surya Layout + Recognition + Table + Texify models warm in memory across books.
- Preserves LaTeX math (`$...$`), tables, 2-column reading order, and word-level `[x0, y0, x1, y1]`
  bounding boxes for sub-pixel PDF search highlights!
"""

import json
import os
import re
import time
import socket
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple, Callable

import requests
import urllib3.util.connection as urllib3_conn

# Prefer IPv4 on Windows to prevent Cloudflare/S3 IPv6 ConnectTimeoutError
urllib3_conn.allowed_gai_family = lambda: socket.AF_INET
os.environ.setdefault("PARALLEL_DOWNLOAD_WORKERS", "1")

import fitz  # PyMuPDF
import torch
from bs4 import BeautifulSoup


def _install_resilient_surya_downloader() -> None:
    """
    Replaces Surya's all-or-nothing parallel temp-dir S3 downloader with a resumable,
    single-socket HTTP Keep-Alive downloader so transient ISP packet drops never discard
    already-downloaded `.safetensors` weights.
    """
    import surya.common.s3 as surya_s3
    from surya.settings import settings

    if getattr(surya_s3, "_clover_patched", False):
        return

    session = requests.Session()
    session.headers.update({"Connection": "keep-alive", "User-Agent": "Clover-Marker/3.0"})

    def _fetch_with_retry(url: str, dst: Path, retries: int = 8) -> None:
        dst.parent.mkdir(parents=True, exist_ok=True)
        part = dst.with_suffix(dst.suffix + ".part")
        for attempt in range(1, retries + 1):
            try:
                with session.get(url, stream=True, allow_redirects=True, timeout=(15, 180)) as resp:
                    resp.raise_for_status()
                    with open(part, "wb") as f:
                        for chunk in resp.iter_content(chunk_size=1024 * 1024):
                            if chunk:
                                f.write(chunk)
                part.replace(dst)
                return
            except Exception as err:
                if part.exists():
                    try:
                        part.unlink()
                    except Exception:
                        pass
                if attempt == retries:
                    raise
                wait_s = min(15, 2 * attempt)
                print(f"[MarkerEngine] Retry {attempt}/{retries} for {dst.name} in {wait_s}s ({err})...")
                time.sleep(wait_s)

    def _resumable_download_directory(remote_path: str, local_dir: str) -> None:
        local_dir_p = Path(local_dir)
        local_dir_p.mkdir(parents=True, exist_ok=True)
        if surya_s3.check_manifest(local_dir):
            return

        model_name = surya_s3.get_model_name(remote_path)
        s3_url = surya_s3.join_urls(settings.S3_BASE_URL, remote_path)
        manifest_dst = local_dir_p / "manifest.json"
        if not manifest_dst.exists() or manifest_dst.stat().st_size == 0:
            _fetch_with_retry(surya_s3.join_urls(s3_url, "manifest.json"), manifest_dst)

        manifest = json.loads(manifest_dst.read_text(encoding="utf-8"))
        files = manifest.get("files") or []
        print(f"[MarkerEngine] Caching {model_name} checkpoint ({len(files)} files) -> {local_dir_p}")
        for idx, fname in enumerate(files, start=1):
            f_dst = local_dir_p / fname
            if f_dst.exists() and f_dst.stat().st_size > 0:
                print(f"  [{idx}/{len(files)}] Cached: {fname}")
                continue
            print(f"  [{idx}/{len(files)}] Downloading: {fname}...")
            _fetch_with_retry(surya_s3.join_urls(s3_url, fname), f_dst)

    surya_s3.download_directory = _resumable_download_directory
    surya_s3._clover_patched = True

SKIP_BLOCK_TYPES = {"PageHeader", "PageFooter", "Picture", "Figure"}


def detect_best_torch_device() -> Tuple[str, torch.dtype]:
    forced = os.environ.get("CLOVER_MARKER_DEVICE", "").strip().lower()
    if forced == "cpu":
        return "cpu", torch.float32
    if forced == "cuda" and torch.cuda.is_available():
        return "cuda", torch.bfloat16
    if forced == "xpu" and hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu", torch.float16

    if torch.cuda.is_available():
        return "cuda", torch.bfloat16
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu", torch.float16
    return "cpu", torch.float32


def _html_to_clean_text_with_math(raw_html: str) -> str:
    if not raw_html:
        return ""
    soup = BeautifulSoup(raw_html, "html.parser")
    # Preserve Marker's <math> tags as inline/block LaTeX before stripping HTML tags
    for m in soup.find_all("math"):
        tex = m.get_text().strip()
        if not tex:
            m.decompose()
            continue
        is_block = m.attrs.get("display") == "block"
        m.replace_with(f" $${tex}$$ " if is_block else f" ${tex}$ ")

    # Drop any residual <img> tags
    for img in soup.find_all("img"):
        img.decompose()

    txt = soup.get_text(" ", strip=True)
    return re.sub(r"\s+", " ", txt).strip()


class MarkerLocalEngine:
    _instance: Optional["MarkerLocalEngine"] = None

    def __init__(self, device: Optional[str] = None):
        if device:
            dev = device
            dtype = (
                torch.float16
                if dev == "xpu"
                else (torch.bfloat16 if dev == "cuda" else torch.float32)
            )
        else:
            dev, dtype = detect_best_torch_device()

        self.device = dev
        self.dtype = dtype
        os.environ["TORCH_DEVICE"] = dev

        _install_resilient_surya_downloader()
        from marker.models import create_model_dict

        print(f"[MarkerEngine] Loading Surya + Marker models on device='{dev}' ({dtype})...")
        self.artifact_dict = create_model_dict(device=dev, dtype=dtype)
        if dev == "xpu":
            # On Intel Arc (Level Zero), TableRec autoregressive decoder loop can trigger WDDM driver device reset.
            # Running TableRec on CPU is instant (tables are small and sparse) and eliminates driver timeouts
            # while keeping 99.9% of compute (recognition_model, layout_model, detection_model) on GPU (xpu)!
            from surya.table_rec import TableRecPredictor
            self.artifact_dict["table_rec_model"] = TableRecPredictor(device="cpu", dtype=torch.float32)

        print(f"[MarkerEngine] Models ready on '{dev}' (image cropping disabled)!")

    @classmethod
    def get(cls) -> "MarkerLocalEngine":
        if cls._instance is None:
            cls._instance = MarkerLocalEngine()
        return cls._instance

    @classmethod
    def fallback_to_cpu(cls) -> "MarkerLocalEngine":
        print("[MarkerEngine] Switching Marker models to CPU fallback...")
        cls._instance = MarkerLocalEngine(device="cpu")
        return cls._instance

    def _run_chunk_batch(self, pdf_path: Path, start_page: int, end_page: int):
        from marker.converters.pdf import PdfConverter
        from marker.config.parser import ConfigParser

        page_range_str = f"{start_page}-{end_page}" if end_page > start_page else str(start_page)
        cfg = ConfigParser(
            {
                "output_format": "chunks",
                "disable_image_extraction": True,
                "disable_multiprocessing": True,
                "page_range": page_range_str,
            }
        )
        converter = PdfConverter(
            config=cfg.generate_config_dict(),
            artifact_dict=self.artifact_dict,
            processor_list=cfg.get_processors(),
            renderer=cfg.get_renderer(),
            llm_service=None,
        )
        return converter(str(pdf_path))

    def _run_chunk_batch_cpu_fallback(self, pdf_path: Path, start_page: int, end_page: int):
        from marker.converters.pdf import PdfConverter
        from marker.config.parser import ConfigParser
        from marker.models import create_model_dict

        if not hasattr(self, "_cpu_artifact_dict"):
            print("[MarkerEngine] Initializing isolated CPU fallback converter for isolated batch...")
            self._cpu_artifact_dict = create_model_dict(device="cpu", dtype=torch.float32)

        page_range_str = f"{start_page}-{end_page}" if end_page > start_page else str(start_page)
        cfg = ConfigParser(
            {
                "output_format": "chunks",
                "disable_image_extraction": True,
                "disable_multiprocessing": True,
                "page_range": page_range_str,
            }
        )
        converter = PdfConverter(
            config=cfg.generate_config_dict(),
            artifact_dict=self._cpu_artifact_dict,
            processor_list=cfg.get_processors(),
            renderer=cfg.get_renderer(),
            llm_service=None,
        )
        return converter(str(pdf_path))

    def extract_book_layout(
        self,
        pdf_path: Path,
        book_id: str,
        title_override: Optional[str] = None,
        author_override: Optional[str] = None,
        cover_out_path: Optional[Path] = None,
        batch_pages: int = 10,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """
        Extracts full book layout using Marker (`disable_image_extraction=True`) in clean page batches,
        enriching blocks with exact PyMuPDF word bounding boxes where digital glyphs exist
        and proportional word boxes on scanned pages!
        """
        doc = fitz.open(str(pdf_path))
        try:
            total_pages = len(doc)
            meta = doc.metadata or {}
            title = (title_override or meta.get("title") or pdf_path.stem).strip()
            author = (author_override or meta.get("author") or "Unknown Author").strip()

            toc_list: List[Dict[str, Any]] = []
            try:
                for item in doc.get_toc(simple=True):
                    if len(item) >= 3:
                        lvl, t_str, p_num = int(item[0]), str(item[1]).strip(), int(item[2])
                        if t_str and 1 <= p_num <= total_pages:
                            toc_list.append({"level": lvl, "title": t_str, "page": p_num})
            except Exception:
                pass

            if cover_out_path is not None and total_pages > 0:
                cover_out_path.parent.mkdir(parents=True, exist_ok=True)
                try:
                    doc[0].get_pixmap(dpi=140, alpha=False).save(str(cover_out_path))
                except Exception as cov_err:
                    print(f"[MarkerEngine] Cover render warning: {cov_err}")

            # Pre-collect page dimensions and native digital word boxes (if any) from PyMuPDF
            page_dims: Dict[int, Tuple[float, float]] = {}
            native_words_by_page: Dict[int, List[Tuple[float, float, float, float, str]]] = {}
            for p_idx in range(total_pages):
                p = doc[p_idx]
                pw = max(1.0, float(p.rect.width))
                ph = max(1.0, float(p.rect.height))
                page_dims[p_idx] = (pw, ph)
                raw_w = p.get_text("words")
                if raw_w:
                    native_words_by_page[p_idx] = [
                        (
                            float(w[0]) / pw,
                            float(w[1]) / ph,
                            float(w[2]) / pw,
                            float(w[3]) / ph,
                            str(w[4]).strip(),
                        )
                        for w in raw_w
                        if str(w[4]).strip()
                    ]
                else:
                    native_words_by_page[p_idx] = []
        finally:
            doc.close()

        pages_blocks_map: Dict[int, List[Dict[str, Any]]] = {p: [] for p in range(total_pages)}
        header_text_by_id: Dict[str, str] = {}

        for start_p in range(0, total_pages, batch_pages):
            end_p = min(total_pages - 1, start_p + batch_pages - 1)
            try:
                chunk_out = self._run_chunk_batch(pdf_path, start_p, end_p)
            except Exception as gpu_err:
                if self.device != "cpu":
                    print(f"[MarkerEngine] Batch {start_p}-{end_p} GPU error ({gpu_err}), processing this single batch on CPU fallback...")
                    chunk_out = self._run_chunk_batch_cpu_fallback(pdf_path, start_p, end_p)
                else:
                    raise

            page_info = chunk_out.page_info or {}

            # First pass: index SectionHeader block IDs -> clean heading text
            for blk in chunk_out.blocks:
                if "header" in str(blk.block_type).lower() and blk.block_type not in SKIP_BLOCK_TYPES:
                    htxt = _html_to_clean_text_with_math(blk.html)
                    if htxt:
                        header_text_by_id[str(blk.id)] = htxt

            for b_idx, blk in enumerate(chunk_out.blocks):
                if blk.block_type in SKIP_BLOCK_TYPES:
                    continue

                text = _html_to_clean_text_with_math(blk.html)
                if len(text) < 2:
                    continue

                # Marker's ChunkRenderer has an upstream bug where `blk.page` parses `block_id`
                # instead of `page_id` from `/page/<page_id>/Page/<block_id>`. Always parse `/page/<page_id>/`!
                id_match = re.match(r"^/page/(\d+)/", str(blk.id))
                p_id = int(id_match.group(1)) if id_match else int(blk.page)
                if p_id < 0 or p_id >= total_pages:
                    continue

                # Normalize Marker bbox using Marker's own `page_info[p_id]["bbox"]`
                p_box = (page_info.get(p_id) or page_info.get(str(p_id)) or {}).get("bbox")
                if p_box and len(p_box) == 4 and (p_box[2] - p_box[0]) > 1:
                    mpw = float(p_box[2] - p_box[0])
                    mph = float(p_box[3] - p_box[1])
                else:
                    mpw, mph = page_dims.get(p_id, (612.0, 792.0))

                raw_bb = blk.bbox or [0.0, 0.0, mpw, mph]
                bx0 = round(max(0.0, min(1.0, float(raw_bb[0]) / mpw)), 4)
                by0 = round(max(0.0, min(1.0, float(raw_bb[1]) / mph)), 4)
                bx1 = round(max(0.0, min(1.0, float(raw_bb[2]) / mpw)), 4)
                by1 = round(max(0.0, min(1.0, float(raw_bb[3]) / mph)), 4)

                # Match exact native word boxes falling inside Marker's block bbox if digital PDF,
                # or interpolate word boxes inside `[bx0, by0, bx1, by1]` on scanned OCR pages!
                p_native = native_words_by_page.get(p_id) or []
                matched_words: List[Dict[str, Any]] = []
                if p_native:
                    for wx0, wy0, wx1, wy1, wstr in p_native:
                        cx = (wx0 + wx1) * 0.5
                        cy = (wy0 + wy1) * 0.5
                        if (bx0 - 0.015) <= cx <= (bx1 + 0.015) and (by0 - 0.012) <= cy <= (by1 + 0.012):
                            matched_words.append(
                                {
                                    "w": wstr,
                                    "b": [
                                        round(max(0.0, min(1.0, wx0)), 4),
                                        round(max(0.0, min(1.0, wy0)), 4),
                                        round(max(0.0, min(1.0, wx1)), 4),
                                        round(max(0.0, min(1.0, wy1)), 4),
                                    ],
                                }
                            )

                if not matched_words:
                    tokens = text.split()
                    lines_est = max(1, min(16, len(text) // 75 + 1))
                    words_per_line = max(1, (len(tokens) + lines_est - 1) // lines_est)
                    bh = max(0.008, by1 - by0)
                    bw = max(0.01, bx1 - bx0)
                    lh = bh / lines_est

                    for t_i, tok in enumerate(tokens[:350]):
                        line_i = min(lines_est - 1, t_i // words_per_line)
                        col_i = t_i % words_per_line
                        ly0 = round(by0 + line_i * lh, 4)
                        ly1 = round(min(1.0, ly0 + lh * 0.92), 4)
                        wx0 = round(bx0 + (col_i / words_per_line) * bw, 4)
                        wx1 = round(bx0 + ((col_i + 0.9) / words_per_line) * bw, 4)
                        matched_words.append({"w": tok, "b": [wx0, ly0, wx1, ly1]})

                section_str = ""
                if blk.section_hierarchy:
                    vals = []
                    for _, v in sorted(blk.section_hierarchy.items(), key=lambda kv: str(kv[0])):
                        v_str = str(v).strip()
                        resolved = header_text_by_id.get(v_str) or (
                            "" if v_str.startswith("/page/") else v_str
                        )
                        if resolved and resolved not in vals:
                            vals.append(resolved)
                    if vals:
                        section_str = " > ".join(vals[-2:])

                pages_blocks_map[p_id].append(
                    {
                        "id": f"mk_p{p_id + 1}_b{b_idx}",
                        "type": str(blk.block_type).lower(),
                        "bbox": [bx0, by0, bx1, by1],
                        "section": section_str,
                        "text": text,
                        "words": matched_words,
                    }
                )

            if hasattr(torch, "xpu") and self.device == "xpu":
                torch.xpu.empty_cache()
            elif torch.cuda.is_available() and self.device == "cuda":
                torch.cuda.empty_cache()

            if on_progress:
                on_progress(end_p + 1, total_pages)

        pages_out = []
        for p_idx in range(total_pages):
            pw, ph = page_dims.get(p_idx, (612.0, 792.0))
            pages_out.append(
                {
                    "page": p_idx + 1,
                    "dimensions": {"width": round(pw, 1), "height": round(ph, 1)},
                    "blocks": pages_blocks_map[p_idx],
                }
            )

        layout = {
            "bookId": book_id,
            "title": title,
            "author": author,
            "totalPages": total_pages,
            "ocrEngine": "marker",
            "pages": pages_out,
        }
        return layout, toc_list
