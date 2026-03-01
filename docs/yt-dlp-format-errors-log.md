# yt-dlp "Requested format is not available" — fix

**Cause:** When the app passes cookies (e.g. `--cookies-from-browser` or `--cookies`), YouTube can return a different format list that does not match our format string, so yt-dlp raises "Requested format is not available". The same URL works from the terminal because the terminal often runs without cookies.

**Fix:** Download via CLI (subprocess). On that error, retry once with the same command but without cookie options. See `odst_tool/youtube_downloader.py` in `_download_audio`.
