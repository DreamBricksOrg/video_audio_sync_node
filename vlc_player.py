"""
VLC Video Player Controller

Thread-safe wrapper around python-vlc for looping video playback.
Uses EndReached event for seamless looping (no input-repeat gap).
Auto-detects platform (Windows/Raspberry Pi) for optimal VLC settings.
"""

import vlc
import sys
import time
import platform
import threading
from pathlib import Path


def _build_vlc_args() -> list[str]:
    """Build VLC instance arguments based on platform."""
    args = ["--fullscreen", "--no-video-title-show"]

    is_linux = sys.platform.startswith("linux")
    is_arm = platform.machine().startswith("arm") or platform.machine().startswith("aarch64")

    if is_linux:
        args.append("--no-xlib")

        if is_arm:
            # Raspberry Pi 4 optimizations
            args.extend([
                # ── HW decoding ──
                "--codec", "avcodec",
                "--avcodec-hw", "any",              # V4L2 M2M / MMAL HW accel
                "--avcodec-fast",                    # speed-optimized decoding
                "--avcodec-skiploopfilter", "4",      # skip deblocking filter (big CPU save)
                "--avcodec-threads", "2",             # use 2 decode threads

                # ── Disable audio (plays on phones, not here) ──
                "--no-audio",

                # ── Reduce overhead ──
                "--no-overlay",
                "--no-osd",
                "--no-snapshot-preview",
                "--no-video-title-show",
                "--file-caching=300",
                "--network-caching=300",
                "--no-interact",
                "--quiet",
            ])
            print("  🍓 Raspberry Pi detected — optimized VLC (no-audio, HW decode, skip-loopfilter)")

    return args


class VLCPlayer:
    def __init__(self):
        vlc_args = _build_vlc_args()
        self._instance = vlc.Instance(*vlc_args)
        self._player: vlc.MediaPlayer = self._instance.media_player_new()
        self._lock = threading.Lock()
        self._duration: float = 0.0
        self._video_path: str = ""
        self._running = False
        self._fullscreen = False
        self._last_valid_pos: float = 0.0

        # Register end-reached event for seamless looping
        events = self._player.event_manager()
        events.event_attach(vlc.EventType.MediaPlayerEndReached, self._on_end_reached)

    def _on_end_reached(self, event):
        """Restart video from 0 when it ends (seamless loop without input-repeat gap)."""
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

        if self._fullscreen:
            time.sleep(0.3)
            self._player.set_fullscreen(True)

    def play(self, video_path: str, fullscreen: bool = False):
        path = Path(video_path).resolve()
        if not path.exists():
            raise FileNotFoundError(f"Video not found: {path}")

        media = self._instance.media_new(str(path))

        with self._lock:
            self._video_path = str(path)
            self._fullscreen = fullscreen
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
            time.sleep(0.5)
            self._player.set_fullscreen(True)

    def get_position(self) -> float:
        with self._lock:
            t = self._player.get_time()
            if t >= 0:
                self._last_valid_pos = t / 1000.0
                return self._last_valid_pos
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
