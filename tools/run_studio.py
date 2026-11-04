#!/usr/bin/env python3
"""
Launches BOTH the Clover FastAPI Studio Backend (port 8765) and Vite Frontend (port 5173)
in a single command (`npm run studio`) so you can drag-and-drop books & auto-tag in 1 click.
"""

import os
import sys
import time
import signal
import socket
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Ensure Windows cp1252 / cmd console won't crash on Unicode/emojis
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def find_available_port(preferred=8088, fallback_ports=(8088, 8089, 8090, 8686, 8000, 7777)):
    candidates = [preferred] + [p for p in fallback_ports if p != preferred]
    for p in candidates:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return preferred


def kill_proc_tree(proc):
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            proc.terminate()
    except Exception:
        pass


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

    preferred_port = int(os.environ.get("STUDIO_PORT", 8088))
    api_port = find_available_port(preferred_port)

    sub_env = dict(os.environ)
    sub_env["STUDIO_PORT"] = str(api_port)

    api_proc = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "studio_server.py")],
        cwd=str(ROOT),
        env=sub_env,
    )
    vite_proc = subprocess.Popen(
        [npm_cmd, "run", "dev"],
        cwd=str(ROOT),
        env=sub_env,
    )

    print("\n✨ Studio Ready:")
    print("   • Clover Web UI (click '+ Add Book' in top-right): http://localhost:5173")
    print(f"   • Local Ingestion & Auto-Tagging API:              http://127.0.0.1:{api_port}/api/studio/health\n")

    try:
        while True:
            if api_proc.poll() is not None or vite_proc.poll() is not None:
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n🛑 Shutting down Clover Studio...")
    finally:
        kill_proc_tree(api_proc)
        kill_proc_tree(vite_proc)


if __name__ == "__main__":
    main()

