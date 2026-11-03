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


def main():
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    print("🍀 Starting Clover 1-Click Studio (Backend API + Vite UI)...")

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

