#!/usr/bin/env python3
"""
Executed during `docker build` on Hugging Face Spaces to download and quantize:
1. `ibm-granite/granite-embedding-278m-multilingual` -> QInt8 ONNX (~275 MB, 3x faster CPU inference)
2. `Xenova/ms-marco-MiniLM-L-6-v2` -> QInt8 Cross-Encoder Reranker (~23 MB)
Deletes the temporary 1.1 GB float32 ONNX file afterward so the final container boots in <3s!
"""

import os
import shutil
from pathlib import Path
from huggingface_hub import hf_hub_download
from transformers import AutoTokenizer
from onnxruntime.quantization import quantize_dynamic, QuantType

CACHE_DIR = Path("/app/models_cache")
GRANITE_REPO = "ibm-granite/granite-embedding-278m-multilingual"
RERANKER_REPO = "Xenova/ms-marco-MiniLM-L-6-v2"


def main():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[1/3] Downloading tokenizer & config for {GRANITE_REPO}...")
    granite_tok_dir = CACHE_DIR / "granite_tokenizer"
    tok = AutoTokenizer.from_pretrained(GRANITE_REPO)
    tok.save_pretrained(str(granite_tok_dir))

    print(f"[2/3] Downloading & QInt8-quantizing {GRANITE_REPO} model.onnx...")
    raw_onnx = hf_hub_download(
        repo_id=GRANITE_REPO,
        filename="model.onnx",
        local_dir=str(CACHE_DIR / "_tmp_granite"),
    )
    quant_granite_path = CACHE_DIR / "granite_278m_qint8.onnx"
    quantize_dynamic(
        model_input=str(raw_onnx),
        model_output=str(quant_granite_path),
        weight_type=QuantType.QInt8,
    )
    # Remove raw 1.1 GB float32 file & temp cache to keep Docker image lean
    try:
        shutil.rmtree(CACHE_DIR / "_tmp_granite", ignore_errors=True)
    except OSError:
        pass
    print(f"    -> Saved {quant_granite_path} ({quant_granite_path.stat().st_size / (1024*1024):.1f} MB)")

    print(f"[3/3] Downloading Cross-Encoder Reranker {RERANKER_REPO}...")
    rerank_tok_dir = CACHE_DIR / "reranker_tokenizer"
    rtok = AutoTokenizer.from_pretrained(RERANKER_REPO)
    rtok.save_pretrained(str(rerank_tok_dir))

    hf_hub_download(
        repo_id=RERANKER_REPO,
        filename="onnx/model_quantized.onnx",
        local_dir=str(CACHE_DIR / "reranker_onnx"),
    )
    print("All models baked & quantized successfully!")


if __name__ == "__main__":
    main()
