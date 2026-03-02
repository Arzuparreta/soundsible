## CONFIGURATION – Options & environment

This document summarizes the main configuration surfaces for Soundsible.

> Note: exact option names may evolve; when in doubt, prefer the in‑app setup wizard and settings UI.

### 1. Setup wizard

The primary way to configure Soundsible is through the guided setup in the Station UI:

- Library path (where music files live).
- Storage backend selection (local / NAS / object storage).
- Optional cloud backends (Cloudflare R2, Backblaze B2/R2, S2).
- Downloader defaults (quality preferences, search source).

Changes made here are persisted so future sessions pick them up automatically.

### 2. Environment variables (examples)

Depending on how you deploy Soundsible, you may expose certain values via environment variables, such as:

- Base paths for storage.
- API keys or credentials for third‑party services used by the downloader or storage backends.

Consult the code and sample `.env` files in the repository for the latest list of supported variables.

### 3. Downloader / ODST settings

The ODST downloader supports:

- Selecting the search & download source (YouTube vs YouTube Music).
- Choosing quality presets (lossless by default where available, with manual selection).
- Controlling parallelism / concurrency for faster downloads (subject to your bandwidth and hardware).

Refer to [`odst_tool/README.md`](../odst_tool/README.md) for more details on standalone usage.

