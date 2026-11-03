#!/usr/bin/env python3
"""
ONNX Inference Engines for Clover Cloud Search:
1. `GraniteEmbedder`: `ibm-granite/granite-embedding-278m-multilingual` (768-d, CLS pooling + L2 norm)
2. `CrossEncoderReranker`: `Xenova/ms-marco-MiniLM-L-6-v2` neural passage reranker
"""

import os
from pathlib import Path
from typing import List, Optional, Callable
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer
from huggingface_hub import hf_hub_download

CACHE_DIR = Path(os.environ.get("CLOVER_MODELS_DIR", "/app/models_cache"))
GRANITE_REPO = "ibm-granite/granite-embedding-278m-multilingual"
RERANKER_REPO = "Xenova/ms-marco-MiniLM-L-6-v2"
EMBED_DIM = 768


def _make_ort_session(onnx_path: str) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    opts.intra_op_num_threads = max(2, os.cpu_count() or 2)
    return ort.InferenceSession(onnx_path, sess_options=opts, providers=["CPUExecutionProvider"])


class GraniteEmbedder:
    _instance: Optional["GraniteEmbedder"] = None

    def __init__(self):
        baked_tok = CACHE_DIR / "granite_tokenizer"
        baked_onnx = CACHE_DIR / "granite_278m_qint8.onnx"

        if baked_tok.exists() and baked_onnx.exists():
            self.tokenizer = AutoTokenizer.from_pretrained(str(baked_tok))
            onnx_file = str(baked_onnx)
        else:
            self.tokenizer = AutoTokenizer.from_pretrained(GRANITE_REPO)
            onnx_file = hf_hub_download(repo_id=GRANITE_REPO, filename="model.onnx")

        self.session = _make_ort_session(onnx_file)
        self.input_names = [i.name for i in self.session.get_inputs()]

    @classmethod
    def get(cls) -> "GraniteEmbedder":
        if cls._instance is None:
            cls._instance = GraniteEmbedder()
        return cls._instance

    def embed(
        self,
        texts: List[str],
        batch_size: int = 32,
        max_length: int = 512,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> np.ndarray:
        if not texts:
            return np.zeros((0, EMBED_DIM), dtype=np.float32)

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
            # IBM Granite 278M uses CLS token pooling (`model_output[0][:, 0]`)
            cls_vecs = raw_out[:, 0, :].astype(np.float32) if raw_out.ndim == 3 else raw_out.astype(np.float32)
            norms = np.linalg.norm(cls_vecs, axis=1, keepdims=True)
            cls_vecs = cls_vecs / np.maximum(norms, 1e-12)
            out_batches.append(cls_vecs)

            if on_progress:
                on_progress(min(total, start + batch_size), total)

        return np.vstack(out_batches)


class CrossEncoderReranker:
    _instance: Optional["CrossEncoderReranker"] = None

    def __init__(self):
        baked_tok = CACHE_DIR / "reranker_tokenizer"
        baked_onnx = CACHE_DIR / "reranker_onnx" / "onnx" / "model_quantized.onnx"

        if baked_tok.exists() and baked_onnx.exists():
            self.tokenizer = AutoTokenizer.from_pretrained(str(baked_tok))
            onnx_file = str(baked_onnx)
        else:
            self.tokenizer = AutoTokenizer.from_pretrained(RERANKER_REPO)
            onnx_file = hf_hub_download(
                repo_id=RERANKER_REPO, filename="onnx/model_quantized.onnx"
            )

        self.session = _make_ort_session(onnx_file)
        self.input_names = [i.name for i in self.session.get_inputs()]

    @classmethod
    def get(cls) -> "CrossEncoderReranker":
        if cls._instance is None:
            cls._instance = CrossEncoderReranker()
        return cls._instance

    def score_pairs(self, query: str, passages: List[str], max_length: int = 384) -> np.ndarray:
        if not passages:
            return np.zeros((0,), dtype=np.float32)

        queries = [query] * len(passages)
        enc = self.tokenizer(
            queries,
            passages,
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

        logits = self.session.run(None, ort_inputs)[0].reshape(-1).astype(np.float32)
        # Calibrated sigmoid relevance probability in (0, 1)
        probs = 1.0 / (1.0 + np.exp(-np.clip(logits, -20.0, 20.0)))
        return probs

