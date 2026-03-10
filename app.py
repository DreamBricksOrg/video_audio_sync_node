"""
Python Video Audio Sync — FastAPI + VLC

Video plays locally via python-vlc.
Audio sync page served via FastAPI WebSockets.
"""

import os
import time
import socket
import asyncio
import mimetypes
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from vlc_player import VLCPlayer

# ── Config ──────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("PORT", 8002))
ASSETS_DIR = Path(__file__).parent / "assets"
STATIC_PY_DIR = Path(__file__).parent / "static_py"
DRIFT_THRESHOLD_MS = 80
DRIFT_INTERVAL_S = 2.0

# ── Hardcoded media files (from assets/ folder) ─────────────────────────────
VIDEO_FILE = "ivete_video2.mp4"
AUDIO_FILE = "ivete_audio.mp3"

# ── Global state ────────────────────────────────────────────────────────────
player = VLCPlayer()
connected_clients: set[WebSocket] = set()
start_time: float = 0.0


# ── Helpers ─────────────────────────────────────────────────────────────────
def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def recalc_start_time():
    """Recalculate start_time from VLC's current position."""
    global start_time
    pos = player.get_position()
    start_time = time.time() - pos


# ── Background task: keep start_time in sync with VLC ───────────────────────
async def sync_loop():
    """Recalc every 1s so loop transitions update start_time fast."""
    while True:
        if player.is_playing():
            recalc_start_time()
        await asyncio.sleep(1)


# ── Lifespan ────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    video_path = ASSETS_DIR / VIDEO_FILE
    if not video_path.exists():
        print(f"  ❌ Video not found: {video_path}")
    else:
        print(f"  🎬 Playing: {VIDEO_FILE}")
        player.play(str(video_path), fullscreen=True)
        recalc_start_time()

    # Start background sync
    task = asyncio.create_task(sync_loop())

    local_ip = get_local_ip()
    print()
    print(f"  🎧 Audio Page: http://{local_ip}:{PORT}/audio")
    print(f"  🎧 Audio Page: http://localhost:{PORT}/audio")
    print(f"  ❤️  Health:     http://localhost:{PORT}/health")
    print()

    yield

    task.cancel()
    player.release()


# ── FastAPI app ─────────────────────────────────────────────────────────────
app = FastAPI(title="Video Audio Sync (Python)", lifespan=lifespan)

# Serve static_py files
app.mount("/static_py", StaticFiles(directory=str(STATIC_PY_DIR)), name="static_py")


# ── Routes ──────────────────────────────────────────────────────────────────
@app.get("/")
async def root():
    return RedirectResponse(url="/audio")


@app.get("/audio")
async def audio_page():
    return FileResponse(STATIC_PY_DIR / "audio.html", media_type="text/html")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "server_time": time.time(),
        "vlc_playing": player.is_playing(),
        "vlc_position": round(player.get_position(), 2),
        "vlc_duration": round(player.get_duration(), 2),
        "vlc_video": player.get_video_name(),
        "connected_clients": len(connected_clients),
    }


@app.get("/media/{filename}")
async def media_stream(filename: str):
    if ".." in filename or "/" in filename or "\\" in filename:
        return JSONResponse({"error": "Invalid filename"}, status_code=400)

    file_path = ASSETS_DIR / filename
    if not file_path.exists():
        return JSONResponse({"error": "File not found"}, status_code=404)

    content_type, _ = mimetypes.guess_type(str(file_path))
    content_type = content_type or "application/octet-stream"

    return FileResponse(
        path=str(file_path),
        media_type=content_type,
        headers={"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400"},
    )


# ── WebSocket sync ──────────────────────────────────────────────────────────
@app.websocket("/ws/sync")
async def ws_sync(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)

    try:
        # Send initial sync payload
        duration = player.get_duration()

        await ws.send_json({
            "type": "sync",
            "start_time": start_time,
            "duration": duration,
            "server_time": time.time(),
            "drift_enabled": True,
            "audio": f"/media/{AUDIO_FILE}",
        })

        # Drift correction loop
        while True:
            await asyncio.sleep(DRIFT_INTERVAL_S)

            if not player.is_playing():
                continue

            duration = player.get_duration()
            if duration <= 0:
                continue

            # Use VLC's ACTUAL position as ground truth (not computed from start_time)
            vlc_pos = player.get_position()
            now = time.time()

            await ws.send_json({
                "type": "drift_check",
                "expected_position": vlc_pos,
                "server_time": now,
                "start_time": start_time,
                "duration": duration,
                "threshold_ms": DRIFT_THRESHOLD_MS,
            })

            # Wait for position report from client
            try:
                data = await asyncio.wait_for(ws.receive_json(), timeout=DRIFT_INTERVAL_S)
                if data.get("type") == "position_report":
                    correction = compute_correction_vlc(
                        data["position"], vlc_pos, duration
                    )
                    if correction:
                        await ws.send_json(correction)
                    else:
                        await ws.send_json({"type": "drift_ok"})
            except asyncio.TimeoutError:
                pass

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        connected_clients.discard(ws)


def compute_correction_vlc(client_position: float, vlc_position: float, duration: float) -> dict | None:
    """Compare client audio position directly against VLC's actual position."""
    drift = client_position - vlc_position

    # Handle wrap-around
    if abs(drift) > duration / 2:
        drift = drift - duration if drift > 0 else drift + duration

    drift_ms = abs(drift) * 1000

    if drift_ms <= DRIFT_THRESHOLD_MS:
        return None

    if drift_ms > 500:
        return {
            "type": "drift_correction",
            "mode": "HARD",
            "target_time": vlc_position,
            "drift_ms": round(drift_ms),
        }
    else:
        return {
            "type": "drift_correction",
            "mode": "SOFT",
            "playback_rate": 0.97 if drift > 0 else 1.03,
            "drift_ms": round(drift_ms),
        }


# ── Entry point ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    print()
    print("  🎬 Video Audio Sync (Python + VLC)")
    print("  ───────────────────────────────────")

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
