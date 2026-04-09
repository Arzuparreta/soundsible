## CONFIGURATION – Options and environment

This document summarizes the main configuration surfaces for Soundsible.

Exact option names may evolve. When in doubt, prefer the in‑app setup wizard and settings UI.

### 1. Setup wizard (recommended)

The primary way to configure Soundsible is through the guided setup in the Station UI.

Key options:

- Library path – where your music files live.
- Storage backend – local disk, NAS, or object storage.
- Cloud backends – Cloudflare R2, Backblaze B2/R2, S2 (optional).
- Downloader defaults – quality preferences and search source.

Changes made here are persisted so future sessions pick them up automatically.

### 2. Environment variables

Depending on how you deploy Soundsible, you may expose certain values via environment variables.

Typical categories:

- Paths – base paths for storage or temporary working directories.
- Feature flags and tuning – optional flags for concurrency limits or debug behaviour.

Consult the code and any sample `.env` files in the repository for the current list of supported variables.

### 3. Downloader / ODST settings

The ODST downloader can be tuned from configuration and the UI.

Main controls:

- Selecting the search and download source (YouTube vs YouTube Music).
- Choosing quality presets (lossless by default where available, with manual selection).
- Controlling parallelism and concurrency for faster downloads (subject to your bandwidth and hardware).

Refer to `odst_tool/README.md` for more details on standalone ODST usage.

If downloads fail with yt‑dlp “Requested format is not available” when using cookies, see [troubleshooting-yt-dlp-formats.md](troubleshooting-yt-dlp-formats.md).

### 4. Storage configuration overview

At a high level, storage can be configured in three ways:

- Local disk – default mode; files stored on the same machine running Soundsible.
- NAS or shared storage – a mounted network path used as the library location.
- Object storage – supported providers such as Cloudflare R2, Backblaze B2/R2, or S2.

The setup wizard and settings UI handle the common cases. If you need a custom backend, look for the storage abstraction layer in the code and implement the same interface that existing backends use.

