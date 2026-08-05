"""
Soundsible

A self-hosted music environment. A Python Station Engine exposes an HTTP API
and real-time events, serves the SolidJS Station player, and coordinates
library management, playback state, discovery and downloads.

Repository structure:
- shared/:        Flask API, models, runtime, database, and the DJ, loudness,
                  lyrics and discovery subsystems
- player/:        Library, queue, favourites and cache managers
- ui_web/:        SolidJS + TypeScript Station player
- odst_tool/:     Download pipeline (yt-dlp, FFmpeg)
- setup_tool/:    Storage providers, scanning, and audio tag helpers
- launcher_web/:  Optional browser launcher and first-run setup
- desktop-shell/: Tauri desktop shell that supervises the engine
- tests/:         Unit and integration tests
- docs/:          Documentation

The version lives in shared/version.py. See docs/ARCHITECTURE.md for how the
pieces fit together.

License: MIT
"""
