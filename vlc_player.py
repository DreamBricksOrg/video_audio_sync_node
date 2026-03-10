"""
VLC Video Player Controller

Thread-safe wrapper around python-vlc for looping video playback.
Uses EndReached event for seamless looping (no input-repeat gap).
Exposes position/duration so the FastAPI server can sync audio clients.
"""

import vlc
import time
import threading
from pathlib import Path


class VLCPlayer:
    def __init__(self):
        self._instance = vlc.Instance("--no-xlib", "--fullscreen")
        self._player: vlc.MediaPlayer = self._instance.media_player_new()
        self._lock = threading.Lock()
        self._duration: float = 0.0
        self._video_path: str = ""
        self._running = False
        self._last_valid_pos: float = 0.0

        # Register end-reached event for seamless looping
        events = self._player.event_manager()
        events.event_attach(vlc.EventType.MediaPlayerEndReached, self._on_end_reached)

    def _on_end_reached(self, event):
        """Restart video from 0 when it ends (seamless loop without input-repeat gap)."""
        # Can't call player methods directly from VLC event callback — use a thread
        threading.Timer(0.05, self._restart_playback).start()

    def _restart_playback(self):
        """Restart the current media from the beginning."""
        with self._lock:
            if not self._running or not self._video_path:
                return
            media = self._instance.media_new(self._video_path)
            self._player.set_media(media)
            self._player.play()
            self._last_valid_pos = 0.0
        # Re-apply fullscreen after restart
        time.sleep(0.3)
        self._player.set_fullscreen(True)

    def play(self, video_path: str, fullscreen: bool = False):
        path = Path(video_path).resolve()
        if not path.exists():
            raise FileNotFoundError(f"Video not found: {path}")

        media = self._instance.media_new(str(path))
        # No input-repeat — we handle looping via EndReached event

        with self._lock:
            self._video_path = str(path)
            self._player.set_media(media)
            self._player.play()
            self._running = True

        # Wait for VLC to start and report duration
        for _ in range(50):
            time.sleep(0.1)
            length = self._player.get_length()
            if length > 0:
                with self._lock:
                    self._duration = length / 1000.0
                break

        if fullscreen:
            self._player.set_fullscreen(True)
            # Fallback: re-apply after window is fully created
            time.sleep(0.5)
            self._player.set_fullscreen(True)

    def get_position(self) -> float:
        with self._lock:
            t = self._player.get_time()
            if t >= 0:
                self._last_valid_pos = t / 1000.0
                return self._last_valid_pos
            # During loop transition, return last known position
            return self._last_valid_pos

    def get_duration(self) -> float:
        with self._lock:
            if self._duration <= 0:
                length = self._player.get_length()
                if length > 0:
                    self._duration = length / 1000.0
            return self._duration

    def is_playing(self) -> bool:
        with self._lock:
            return self._running and (self._player.is_playing() == 1 or self._player.get_state() == vlc.State.Opening)

    def get_video_name(self) -> str:
        with self._lock:
            return Path(self._video_path).name if self._video_path else ""

    def stop(self):
        with self._lock:
            self._player.stop()
            self._running = False

    def release(self):
        self.stop()
        self._player.release()
        self._instance.release()
