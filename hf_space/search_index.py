#!/usr/bin/env python3
"""
Clover Cloud Hybrid Search Index (`CloudSearchIndex`)
-----------------------------------------------------
Combines:
1. Lexical BM25 Ranking via SQLite FTS5 (`porter unicode61` stemmer)
2. Dense 768-d Semantic Vector Search via `ibm-granite/granite-embedding-278m-multilingual`
3. Reciprocal Rank Fusion (RRF) + Exact Phrase Boosting
4. Neural Cross-Encoder Passage Reranking (`Xenova/ms-marco-MiniLM-L-6-v2`)
5. Exact word-level `[x0, y0, x1, y1]` PDF bounding-box extraction & HF Dataset persistence
"""

import os
import re
import json
import time
import shutil
import sqlite3
import threading
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple, Set

import numpy as np
from huggingface_hub import HfApi, hf_hub_download

from models import GraniteEmbedder, CrossEncoderReranker, EMBED_DIM, GRANITE_REPO, RERANKER_REPO

STOPWORDS: Set[str] = {
    "the", "and", "for", "that", "this", "with", "from", "what", "how", "why",
    "when", "where", "who", "which", "are", "was", "were", "been", "being",
    "have", "has", "had", "does", "did", "can", "could", "should", "would",
    "will", "into", "about", "than", "then", "them", "they", "their", "there",
    "your", "you", "our", "out", "use", "using", "used", "between", "during",
}


def _tokenize_query(raw_query: str) -> Tuple[List[str], List[str]]:
    all_tokens = re.findall(r"[a-zA-Z0-9]{2,}", raw_query.lower())
    # Deduplicate preserving order
    seen: Set[str] = set()
    ordered: List[str] = []
    for t in all_tokens:
        if t not in seen:
            seen.add(t)
            ordered.append(t)
    meaningful = [t for t in ordered if t not in STOPWORDS]
    if not meaningful:
        meaningful = ordered
    return ordered, meaningful


def _build_fts5_queries(raw_query: str) -> Tuple[Optional[str], Optional[str]]:
    _, meaningful = _tokenize_query(raw_query)
    if not meaningful:
        return None, None
    capped = meaningful[:10]
    strict_and = " ".join(f'"{t}"*' for t in capped)
    broad_or = " OR ".join(f'"{t}"*' for t in capped)
    return strict_and, broad_or


def _extract_bboxes_and_matches(
    words_list: List[Dict[str, Any]],
    query_tokens: List[str],
) -> Tuple[List[str], List[List[float]]]:
    """
    Finds exact/prefix word-level `[x0, y0, x1, y1]` bounding boxes for matched query tokens.
    If a hit is purely conceptual (0 literal token overlap), returns the passage's union
    bounding box so clicking the search hit still highlights the exact paragraph on the PDF page!
    """
    if not words_list:
        return [], []

    matched_words_set: Set[str] = set()
    bboxes: List[List[float]] = []

    stems = [t[:5] if len(t) >= 6 else t for t in query_tokens if len(t) >= 2]

    for w_obj in words_list:
        raw_w = str(w_obj.get("w") or "")
        bbox = w_obj.get("b")
        if not raw_w or not isinstance(bbox, list) or len(bbox) != 4:
            continue
        clean_w = re.sub(r"^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$", "", raw_w).lower()
        if not clean_w:
            continue

        is_hit = False
        for tok, stem in zip(query_tokens, stems):
            if clean_w == tok or (len(tok) >= 4 and clean_w.startswith(stem)):
                is_hit = True
                break

        if is_hit:
            matched_words_set.add(clean_w)
            if len(bboxes) < 48:
                bboxes.append([round(float(x), 4) for x in bbox])

    if bboxes:
        return sorted(matched_words_set), bboxes

    # Pure semantic match fallback: compute clean paragraph union bounding box
    valid_coords = [
        w["b"] for w in words_list if isinstance(w.get("b"), list) and len(w["b"]) == 4
    ]
    if valid_coords:
        x0 = round(float(min(c[0] for c in valid_coords)), 4)
        y0 = round(float(min(c[1] for c in valid_coords)), 4)
        x1 = round(float(max(c[2] for c in valid_coords)), 4)
        y1 = round(float(max(c[3] for c in valid_coords)), 4)
        return [], [[x0, y0, x1, y1]]

    return [], []


def _format_snippet(text: str, section: str, query_tokens: List[str], max_len: int = 340) -> str:
    clean = re.sub(r"\s+", " ", text).strip()
    if len(clean) > max_len:
        # Center snippet around the first matched keyword if present
        lower = clean.lower()
        best_pos = -1
        for tok in query_tokens:
            idx = lower.find(tok)
            if idx != -1:
                best_pos = idx
                break
        if best_pos > max_len // 2:
            start = max(0, best_pos - max_len // 3)
            # Snap to word boundary
            space_idx = clean.find(" ", start)
            if 0 < space_idx < start + 25:
                start = space_idx + 1
            excerpt = "…" + clean[start : start + max_len].rstrip()
            if start + max_len < len(clean):
                excerpt += "…"
        else:
            excerpt = clean[:max_len].rstrip() + "…"
    else:
        excerpt = clean

    if section:
        return f"§ {section} — {excerpt}"
    return excerpt


class CloudSearchIndex:
    """
    Thread-safe hybrid SQLite FTS5 + NumPy 768-d Granite index with Cross-Encoder Reranking.
    """

    def __init__(self, index_dir: Path):
        self.index_dir = Path(index_dir)
        self.index_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.index_dir / "passages.sqlite"
        self.vec_path = self.index_dir / "vectors.npy"
        self.manifest_path = self.index_dir / "manifest.json"

        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

        self.vectors_f16: np.ndarray = np.zeros((0, EMBED_DIM), dtype=np.float16)
        self.vectors_f32: np.ndarray = np.zeros((0, EMBED_DIM), dtype=np.float32)
        self.book_ids_per_row: List[str] = []
        self.manifest: Dict[str, Any] = {
            "version": 2,
            "model": GRANITE_REPO,
            "reranker": RERANKER_REPO,
            "dim": EMBED_DIM,
            "indexed_books": {},
        }
        self._load_local_files()

    def _init_schema(self) -> None:
        with self._lock:
            cur = self.conn.cursor()
            cur.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;

                CREATE TABLE IF NOT EXISTS passages (
                    vec_idx INTEGER PRIMARY KEY,
                    id TEXT UNIQUE NOT NULL,
                    book_id TEXT NOT NULL,
                    book_title TEXT NOT NULL,
                    author TEXT NOT NULL,
                    category TEXT NOT NULL,
                    page INTEGER NOT NULL,
                    section TEXT NOT NULL,
                    text TEXT NOT NULL,
                    words_json TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_passages_book ON passages(book_id);

                CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
                    book_title,
                    section,
                    text,
                    content='passages',
                    content_rowid='vec_idx',
                    tokenize='porter unicode61'
                );
                """
            )
            self.conn.commit()

    def _load_local_files(self) -> None:
        with self._lock:
            if self.manifest_path.exists():
                try:
                    self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
                except Exception:
                    pass

            cur = self.conn.cursor()
            rows = cur.execute("SELECT vec_idx, book_id FROM passages ORDER BY vec_idx ASC").fetchall()
            db_count = len(rows)

            if self.vec_path.exists() and db_count > 0:
                vecs = np.load(str(self.vec_path))
                if vecs.ndim == 2 and vecs.shape[0] == db_count and vecs.shape[1] == EMBED_DIM:
                    self.vectors_f16 = vecs.astype(np.float16, copy=False)
                    self.vectors_f32 = vecs.astype(np.float32)
                    self.book_ids_per_row = [r["book_id"] for r in rows]
                    return

            # Reset clean if empty or mismatched
            self.vectors_f16 = np.zeros((0, EMBED_DIM), dtype=np.float16)
            self.vectors_f32 = np.zeros((0, EMBED_DIM), dtype=np.float32)
            self.book_ids_per_row = []

    def sync_from_hf_dataset(self, hf_repo: str, hf_token: Optional[str] = None) -> bool:
        """
        Downloads pre-built `data/cloud_index/{manifest.json, passages.sqlite, vectors.npy}`
        from Hugging Face Dataset if available so container cold-starts finish in <3 seconds!
        """
        if not hf_repo:
            return False

        tmp_dir = self.index_dir.parent / "_hf_sync_tmp"
        shutil.rmtree(tmp_dir, ignore_errors=True)
        tmp_dir.mkdir(parents=True, exist_ok=True)

        try:
            for fname in ("manifest.json", "passages.sqlite", "vectors.npy"):
                hf_hub_download(
                    repo_id=hf_repo,
                    repo_type="dataset",
                    filename=f"data/cloud_index/{fname}",
                    local_dir=str(tmp_dir),
                    token=hf_token or None,
                )

            src_base = tmp_dir / "data" / "cloud_index"
            with self._lock:
                self.conn.close()
                for wal_ext in ("-wal", "-shm"):
                    wal_file = Path(str(self.db_path) + wal_ext)
                    if wal_file.exists():
                        wal_file.unlink()

                shutil.copy2(src_base / "manifest.json", self.manifest_path)
                shutil.copy2(src_base / "passages.sqlite", self.db_path)
                shutil.copy2(src_base / "vectors.npy", self.vec_path)

                self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
                self.conn.row_factory = sqlite3.Row
                self._init_schema()
                self._load_local_files()

            shutil.rmtree(tmp_dir, ignore_errors=True)
            return self.total_passages > 0
        except Exception as e:
            print(f"[CloudSearchIndex] No remote cloud_index synced yet ({e})")
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return False

    def push_to_hf_dataset(
        self,
        hf_repo: str,
        hf_token: str,
        commit_message: str = "Update Clover Cloud Hybrid Search Index",
    ) -> Optional[str]:
        if not hf_repo or not hf_token:
            return None

        with self._lock:
            # Flush WAL into main SQLite file before uploading
            self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
            self.manifest_path.write_text(
                json.dumps(self.manifest, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            np.save(str(self.vec_path), self.vectors_f16)

            export_dir = self.index_dir.parent / "_hf_export_tmp"
            shutil.rmtree(export_dir, ignore_errors=True)
            export_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.manifest_path, export_dir / "manifest.json")
            shutil.copy2(self.db_path, export_dir / "passages.sqlite")
            shutil.copy2(self.vec_path, export_dir / "vectors.npy")

        api = HfApi(token=hf_token)
        from huggingface_hub import CommitOperationAdd

        ops = [
            CommitOperationAdd(
                path_in_repo=f"data/cloud_index/{fname}",
                path_or_fileobj=str(export_dir / fname),
            )
            for fname in ("manifest.json", "passages.sqlite", "vectors.npy")
        ]
        info = api.create_commit(
            repo_id=hf_repo,
            repo_type="dataset",
            operations=ops,
            commit_message=commit_message,
        )
        shutil.rmtree(export_dir, ignore_errors=True)
        return getattr(info, "commit_url", None)

    @property
    def total_passages(self) -> int:
        return int(self.vectors_f32.shape[0])

    @property
    def indexed_books_count(self) -> int:
        return len(self.manifest.get("indexed_books", {}))

    def has_book(self, book_id: str, min_passages: int = 5) -> bool:
        info = self.manifest.get("indexed_books", {}).get(book_id)
        if not info:
            return False
        return int(info.get("passageCount", 0)) >= min_passages

    def upsert_book(
        self,
        book_id: str,
        passages: List[Dict[str, Any]],
        embeddings_f32: np.ndarray,
        has_ocr: bool = False,
        persist_disk: bool = True,
    ) -> None:
        """
        Atomically inserts or replaces a book's passages and 768-d Granite vectors.
        Fast-path appends in O(M) if `book_id` is new; rebuilds cleanly if replacing an existing book.
        """
        if len(passages) != embeddings_f32.shape[0]:
            raise ValueError("Passages length and embeddings row count mismatch")

        if len(passages) == 0:
            return

        new_f16 = embeddings_f32.astype(np.float16)
        new_f32 = new_f16.astype(np.float32)

        with self._lock:
            cur = self.conn.cursor()
            existing_count = cur.execute(
                "SELECT COUNT(*) FROM passages WHERE book_id = ?", (book_id,)
            ).fetchone()[0]

            if existing_count == 0 and self.vectors_f32.shape[0] == len(self.book_ids_per_row):
                # Fast O(M) append path
                base_idx = self.vectors_f32.shape[0]
                db_rows = []
                fts_rows = []
                for offset, p in enumerate(passages):
                    v_idx = base_idx + offset
                    words_str = json.dumps(p.get("words") or [], separators=(",", ":"))
                    db_rows.append(
                        (
                            v_idx,
                            p["id"],
                            book_id,
                            p["bookTitle"],
                            p["author"],
                            p.get("category") or "Uncategorized",
                            int(p["page"]),
                            p.get("section") or "",
                            p["text"],
                            words_str,
                        )
                    )
                    fts_rows.append((v_idx, p["bookTitle"], p.get("section") or "", p["text"]))

                cur.executemany(
                    """
                    INSERT INTO passages (
                        vec_idx, id, book_id, book_title, author, category, page, section, text, words_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    db_rows,
                )
                cur.executemany(
                    "INSERT INTO passages_fts(rowid, book_title, section, text) VALUES (?, ?, ?, ?)",
                    fts_rows,
                )
                self.conn.commit()

                if self.vectors_f16.shape[0] == 0:
                    self.vectors_f16 = new_f16
                    self.vectors_f32 = new_f32
                else:
                    self.vectors_f16 = np.vstack([self.vectors_f16, new_f16])
                    self.vectors_f32 = np.vstack([self.vectors_f32, new_f32])

                self.book_ids_per_row.extend([book_id] * len(passages))
            else:
                # Replace path: keep all other books, append updated book, re-index contiguous 0..N-1
                kept_rows = cur.execute(
                    """
                    SELECT vec_idx, id, book_id, book_title, author, category, page, section, text, words_json
                    FROM passages WHERE book_id != ? ORDER BY vec_idx ASC
                    """,
                    (book_id,),
                ).fetchall()

                kept_indices = [int(r["vec_idx"]) for r in kept_rows]
                kept_f16 = (
                    self.vectors_f16[kept_indices]
                    if kept_indices and self.vectors_f16.shape[0] > max(kept_indices)
                    else np.zeros((0, EMBED_DIM), dtype=np.float16)
                )

                rebuilt_db = []
                new_book_ids: List[str] = []
                for new_idx, r in enumerate(kept_rows):
                    rebuilt_db.append(
                        (
                            new_idx,
                            r["id"],
                            r["book_id"],
                            r["book_title"],
                            r["author"],
                            r["category"],
                            int(r["page"]),
                            r["section"],
                            r["text"],
                            r["words_json"],
                        )
                    )
                    new_book_ids.append(r["book_id"])

                base_idx = len(rebuilt_db)
                for offset, p in enumerate(passages):
                    v_idx = base_idx + offset
                    words_str = json.dumps(p.get("words") or [], separators=(",", ":"))
                    rebuilt_db.append(
                        (
                            v_idx,
                            p["id"],
                            book_id,
                            p["bookTitle"],
                            p["author"],
                            p.get("category") or "Uncategorized",
                            int(p["page"]),
                            p.get("section") or "",
                            p["text"],
                            words_str,
                        )
                    )
                    new_book_ids.append(book_id)

                cur.execute("DELETE FROM passages")
                cur.executemany(
                    """
                    INSERT INTO passages (
                        vec_idx, id, book_id, book_title, author, category, page, section, text, words_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    rebuilt_db,
                )
                cur.execute("INSERT INTO passages_fts(passages_fts) VALUES('rebuild')")
                self.conn.commit()

                self.vectors_f16 = (
                    np.vstack([kept_f16, new_f16]) if kept_f16.shape[0] > 0 else new_f16
                )
                self.vectors_f32 = self.vectors_f16.astype(np.float32)
                self.book_ids_per_row = new_book_ids

            self.manifest.setdefault("indexed_books", {})[book_id] = {
                "passageCount": len(passages),
                "hasOcr": bool(has_ocr),
                "updatedAt": int(time.time()),
            }

            if persist_disk:
                self.save_disk()

    def save_disk(self) -> None:
        with self._lock:
            np.save(str(self.vec_path), self.vectors_f16)
            self.manifest_path.write_text(
                json.dumps(self.manifest, indent=2, ensure_ascii=False), encoding="utf-8"
            )

    def search(
        self,
        query: str,
        book_ids_filter: Optional[List[str]] = None,
        mode: str = "hybrid",
        limit: int = 120,
    ) -> Dict[str, Any]:
        t0 = time.perf_counter()
        clean_q = (query or "").strip()
        if not clean_q or self.total_passages == 0:
            return {
                "query": clean_q,
                "mode": mode,
                "totalMatches": 0,
                "grouped": [],
                "totalPassages": self.total_passages,
                "indexedBooks": self.indexed_books_count,
                "latencyMs": 0.0,
            }

        # If caller explicitly passed an empty filter list (e.g., tag matched 0 books), return empty
        if book_ids_filter is not None and len(book_ids_filter) == 0:
            return {
                "query": clean_q,
                "mode": mode,
                "totalMatches": 0,
                "grouped": [],
                "totalPassages": self.total_passages,
                "indexedBooks": self.indexed_books_count,
                "latencyMs": 0.0,
            }

        allowed_set: Optional[Set[str]] = set(book_ids_filter) if book_ids_filter else None
        all_tokens, meaningful_tokens = _tokenize_query(clean_q)

        lex_ranks: Dict[int, int] = {}
        lex_scores: Dict[int, float] = {}
        sem_ranks: Dict[int, int] = {}
        sem_scores: Dict[int, float] = {}

        # 1. Lexical BM25 Retrieval via SQLite FTS5
        if mode in ("hybrid", "keyword"):
            strict_fts, broad_fts = _build_fts5_queries(clean_q)
            with self._lock:
                cur = self.conn.cursor()
                seen_rowids: Set[int] = set()
                fts_candidates: List[Tuple[int, float]] = []

                for fts_expr, weight in ((strict_fts, 1.25), (broad_fts, 1.0)):
                    if not fts_expr or len(fts_candidates) >= 200:
                        continue
                    try:
                        rows = cur.execute(
                            """
                            SELECT rowid AS vec_idx, -bm25(passages_fts, 2.0, 4.5, 10.0) AS score
                            FROM passages_fts
                            WHERE passages_fts MATCH ?
                            ORDER BY score DESC
                            LIMIT 260
                            """,
                            (fts_expr,),
                        ).fetchall()
                        for r in rows:
                            v_idx = int(r["vec_idx"])
                            if v_idx in seen_rowids or v_idx >= len(self.book_ids_per_row):
                                continue
                            if allowed_set is not None and self.book_ids_per_row[v_idx] not in allowed_set:
                                continue
                            seen_rowids.add(v_idx)
                            fts_candidates.append((v_idx, float(r["score"]) * weight))
                            if len(fts_candidates) >= 200:
                                break
                    except sqlite3.OperationalError:
                        continue

                for rank_i, (v_idx, b_score) in enumerate(fts_candidates):
                    lex_ranks[v_idx] = rank_i + 1
                    lex_scores[v_idx] = b_score

        # 2. Dense 768-d Granite Semantic Retrieval
        if mode in ("hybrid", "semantic"):
            q_vec = GraniteEmbedder.get().embed([clean_q], batch_size=1, max_length=128)[0]
            with self._lock:
                sims = self.vectors_f32 @ q_vec
                if allowed_set is not None:
                    mask = np.fromiter(
                        (b in allowed_set for b in self.book_ids_per_row),
                        dtype=bool,
                        count=len(self.book_ids_per_row),
                    )
                    sims = np.where(mask, sims, -2.0)

                k = min(200, sims.shape[0])
                if k > 0:
                    top_idx = np.argpartition(sims, -k)[-k:]
                    top_idx = top_idx[np.argsort(sims[top_idx])[::-1]]
                    for rank_i, v_idx_np in enumerate(top_idx):
                        v_idx = int(v_idx_np)
                        s_val = float(sims[v_idx])
                        if s_val < 0.22:
                            break
                        sem_ranks[v_idx] = rank_i + 1
                        sem_scores[v_idx] = s_val

        candidate_ids = list(set(lex_ranks.keys()) | set(sem_ranks.keys()))
        if not candidate_ids:
            return {
                "query": clean_q,
                "mode": mode,
                "totalMatches": 0,
                "grouped": [],
                "totalPassages": self.total_passages,
                "indexedBooks": self.indexed_books_count,
                "latencyMs": round((time.perf_counter() - t0) * 1000.0, 1),
            }

        # Fetch candidate passage records from SQLite
        with self._lock:
            placeholders = ",".join("?" for _ in candidate_ids)
            rows = self.conn.execute(
                f"""
                SELECT vec_idx, id, book_id, book_title, author, category, page, section, text, words_json
                FROM passages
                WHERE vec_idx IN ({placeholders})
                """,
                candidate_ids,
            ).fetchall()

        row_map = {int(r["vec_idx"]): r for r in rows}

        # 3. Reciprocal Rank Fusion (RRF, k=60) + Exact Substring Bonus
        rrf_k = 60.0
        clean_phrase = clean_q.lower()
        has_phrase_check = len(clean_phrase) >= 4

        fused: List[Dict[str, Any]] = []
        for v_idx in candidate_ids:
            row = row_map.get(v_idx)
            if row is None:
                continue

            l_rank = lex_ranks.get(v_idx)
            s_rank = sem_ranks.get(v_idx)

            score = 0.0
            if s_rank is not None:
                score += 1.15 / (rrf_k + s_rank)
            if l_rank is not None:
                score += 1.0 / (rrf_k + l_rank)

            passage_text = row["text"]
            exact_bonus = 0.012 if (has_phrase_check and clean_phrase in passage_text.lower()) else 0.0
            score += exact_bonus

            if l_rank is not None and s_rank is not None:
                match_source = "hybrid"
            elif s_rank is not None:
                match_source = "semantic"
            else:
                match_source = "keyword"

            fused.append(
                {
                    "vec_idx": v_idx,
                    "row": row,
                    "rrf_score": score,
                    "exact_bonus": exact_bonus,
                    "sem_score": sem_scores.get(v_idx),
                    "lex_score": lex_scores.get(v_idx),
                    "match_source": match_source,
                }
            )

        fused.sort(key=lambda x: x["rrf_score"], reverse=True)
        fused = fused[: max(limit, 40)]

        # 4. Cross-Encoder Neural Reranking (`ms-marco-MiniLM-L-6-v2`) on Top 30 Candidates
        if mode in ("hybrid", "semantic") and len(fused) > 1:
            rerank_k = min(30, len(fused))
            top_slice = fused[:rerank_k]
            pair_texts = [
                f"{item['row']['book_title']} - {item['row']['section']}: {item['row']['text']}"
                if item["row"]["section"]
                else f"{item['row']['book_title']}: {item['row']['text']}"
                for item in top_slice
            ]
            ce_probs = CrossEncoderReranker.get().score_pairs(clean_q, pair_texts)
            for item, prob in zip(top_slice, ce_probs):
                rrf_norm = min(1.0, item["rrf_score"] * 30.0)
                item["final_score"] = (
                    0.72 * float(prob)
                    + 0.28 * rrf_norm
                    + (0.06 if item["exact_bonus"] > 0 else 0.0)
                )
                item["ce_prob"] = float(prob)

            top_slice.sort(key=lambda x: x["final_score"], reverse=True)
            min_top_score = top_slice[-1]["final_score"] if top_slice else 0.2

            tail_slice = fused[rerank_k:]
            for idx_tail, item in enumerate(tail_slice):
                item["final_score"] = max(0.01, min_top_score * 0.85 - idx_tail * 0.002)

            fused = top_slice + tail_slice
        else:
            max_rrf = max((x["rrf_score"] for x in fused), default=1.0)
            for item in fused:
                item["final_score"] = item["rrf_score"] / max(max_rrf, 1e-9)

        # Trim to requested limit and filter ultra-low noise hits in semantic mode
        selected = []
        for item in fused:
            if mode == "semantic" and item.get("ce_prob") is not None and item["ce_prob"] < 0.015:
                if (item.get("sem_score") or 0.0) < 0.32:
                    continue
            selected.append(item)
            if len(selected) >= limit:
                break

        # 5. Format & Group by Book with Exact Word-Level BBoxes
        groups_map: Dict[str, Dict[str, Any]] = {}
        highlight_tokens = meaningful_tokens if meaningful_tokens else all_tokens

        for item in selected:
            r = item["row"]
            b_id = r["book_id"]
            try:
                words_list = json.loads(r["words_json"])
            except Exception:
                words_list = []

            matched_words, bboxes = _extract_bboxes_and_matches(words_list, highlight_tokens)
            snippet = _format_snippet(r["text"], r["section"], highlight_tokens)

            hit = {
                "id": r["id"],
                "bookId": b_id,
                "bookTitle": r["book_title"],
                "author": r["author"],
                "category": r["category"],
                "page": int(r["page"]),
                "snippet": snippet,
                "matchedWords": matched_words,
                "bboxes": bboxes,
                "score": round(float(item["final_score"]), 4),
                "semanticScore": round(float(item["sem_score"]), 4)
                if item["sem_score"] is not None
                else None,
                "lexicalScore": round(float(item["lex_score"]), 4)
                if item["lex_score"] is not None
                else None,
                "matchSource": item["match_source"],
            }

            if b_id not in groups_map:
                groups_map[b_id] = {
                    "bookId": b_id,
                    "bookTitle": r["book_title"],
                    "author": r["author"],
                    "category": r["category"],
                    "totalMatches": 0,
                    "bestScore": hit["score"],
                    "hits": [],
                }

            grp = groups_map[b_id]
            grp["hits"].append(hit)
            grp["totalMatches"] += 1
            if hit["score"] > grp["bestScore"]:
                grp["bestScore"] = hit["score"]

        grouped_list = sorted(
            groups_map.values(),
            key=lambda g: (g["bestScore"], g["totalMatches"]),
            reverse=True,
        )

        latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        return {
            "query": clean_q,
            "mode": mode,
            "totalMatches": len(selected),
            "grouped": grouped_list,
            "totalPassages": self.total_passages,
            "indexedBooks": self.indexed_books_count,
            "latencyMs": latency_ms,
        }

