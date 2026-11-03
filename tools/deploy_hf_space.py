#!/usr/bin/env python3
"""
Deploys `hf_space/` to Hugging Face Docker Space `learner20011/clover-engine`
and securely configures Space Secrets (`HF_TOKEN`, `HF_DATASET_REPO`, optional `GEMINI_API_KEY`).
Never prints secret values to stdout.
"""

import sys
import argparse
from pathlib import Path
from huggingface_hub import HfApi

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline_core import load_env_config


def main():
    parser = argparse.ArgumentParser(description="Deploy Clover Cloud Engine to Hugging Face Spaces")
    parser.add_argument("--space-id", default="", help="HF Space repo_id (default: <owner>/clover-engine)")
    args = parser.parse_args()

    cfg = load_env_config(ROOT_DIR / ".env")
    hf_token = cfg.get("HF_TOKEN", "").strip()
    dataset_repo = cfg.get("PUBLIC_HF_DATASET_REPO", "learner20011/CloverTexts-Data").strip()
    gemini_key = cfg.get("GEMINI_API_KEY", "").strip()

    if not hf_token:
        print("ERROR: HF_TOKEN not found in .env or environment.", file=sys.stderr)
        sys.exit(1)

    api = HfApi(token=hf_token)
    who = api.whoami()
    username = who["name"]
    space_id = args.space_id.strip() or f"{username}/clover-engine"

    print(f"[1/3] Creating/verifying Docker Space: {space_id} (private=False)...")
    api.create_repo(
        repo_id=space_id,
        repo_type="space",
        space_sdk="docker",
        private=False,
        exist_ok=True,
    )

    print(f"[2/3] Setting encrypted Space Secrets on {space_id} (HF_TOKEN, HF_DATASET_REPO)...")
    api.add_space_secret(repo_id=space_id, key="HF_TOKEN", value=hf_token)
    api.add_space_secret(repo_id=space_id, key="HF_DATASET_REPO", value=dataset_repo)
    if gemini_key:
        api.add_space_secret(repo_id=space_id, key="GEMINI_API_KEY", value=gemini_key)

    hf_space_dir = ROOT_DIR / "hf_space"
    print(f"[3/3] Uploading {hf_space_dir} to {space_id}...")
    commit_info = api.upload_folder(
        folder_path=str(hf_space_dir),
        repo_id=space_id,
        repo_type="space",
        commit_message="Deploy Clover Hybrid Search (Granite 278M + Reranker + FTS5) & 1-Click Studio",
        ignore_patterns=["__pycache__", "*.pyc", ".DS_Store"],
    )

    subdomain = space_id.replace("/", "-").lower()
    print(f"SUCCESS! Space pushed: https://huggingface.co/spaces/{space_id}")
    print(f"Live Engine URL: https://{subdomain}.hf.space")
    if getattr(commit_info, "commit_url", None):
        print(f"Commit: {commit_info.commit_url}")


if __name__ == "__main__":
    main()

