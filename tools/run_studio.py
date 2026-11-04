#!/usr/bin/env python3
"""
Launches BOTH the Clover FastAPI Studio Backend (port 8765) and Vite Frontend (port 5173)
in a single command (`npm run studio`) so you can drag-and-drop books & auto-tag in 1 click.
"""

import os
import sys
import time
import signal
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Ensure Windows cp1252 / cmd console won't crash on Unicode/emojis
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def main():
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    print("🍀 Starting Clover 1-Click Studio (Backend API + Vite UI)...")

    # Dependency preflight check to ensure uvicorn, h11, and fastapi are ready
    try:
        import fastapi
        import uvicorn
        import h11
    except ImportError as exc:
        print(f"📦 Preflight check: installing missing studio dependency ({exc.name})...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "fastapi", "uvicorn", "h11>=0.13,<0.15"],
            check=False,
        )

    api_proc = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "studio_server.py")],
        cwd=str(ROOT),
    )
    vite_proc = subprocess.Popen(
        [npm_cmd, "run", "dev"],
        cwd=str(ROOT),
    )

    print("\n✨ Studio Ready:")
    print("   • Clover Web UI (click '+ Add Book' in top-right): http://localhost:5173")
    print("   • Local Ingestion & Auto-Tagging API:              http://127.0.0.1:8765/api/studio/health\n")

    try:
        while True:
            if api_proc.poll() is not None or vite_proc.poll() is not None:
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nShutting down Clover Studio...")
    finally:
        for p in (vite_proc, api_proc):
            if p.poll() is None:
                p.terminate()


if __name__ == "__main__":
    main()

