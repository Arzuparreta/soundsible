# Download troubleshooting

Soundsible searches and downloads through [yt-dlp](https://github.com/yt-dlp/yt-dlp).
When a download fails, the reason is in the engine's log:

| You run Soundsible with | Read the log with |
| --- | --- |
| `python3 run.py --daemon` | The terminal it runs in |
| systemd | `journalctl -u soundsible -f` |
| Docker | `docker compose logs -f soundsible` |

## How a download is attempted

Each download tries, in order:

1. the native audio stream **without cookies** — public extraction usually
   offers the cleanest audio-only formats;
2. the same **with your cookies**, if you configured them and YouTube asked
   for sign-in, age confirmation or a cookie-only format, or answered
   "Requested format is not available" or HTTP 403;
3. a **re-encoded** download, with cookies when you have them.

Metadata lookups follow the same order: anonymous first, then `cookies.txt`,
then browser cookies. Cookies are never required for public music; they are a
fallback.

## "Requested format is not available"

Cookies can make YouTube return a different format list, which is why
Soundsible starts without them and retries with them only when needed. If this
error survives all three attempts:

- **Update yt-dlp.** YouTube changes often, and an old yt-dlp is the most
  common cause. On a native install, turn on **Settings → Downloads →
  Auto-update yt-dlp** (admin only) and restart Soundsible: it then upgrades
  yt-dlp in the background every time it starts. With Docker, pull the newest image.
- Export a fresh `cookies.txt`; an expired session can fail the same way.

## "Sign in to confirm you're not a bot", empty searches on a VPS

Datacenter addresses are often treated as automated traffic. In order of effort:

1. Set `SOUNDSIBLE_YT_SEARCH_SOURCE=youtube` if YouTube Music searches come
   back empty.
2. Add YouTube cookies — see [Configuration → YouTube cookies](CONFIGURATION.md#youtube-cookies).
3. Route YouTube through a trusted home computer with the
   [VPS relay](VPS_RELAY.md).

## Downloads stall or time out

Soundsible already forces IPv4 and retries with backoff; the defaults and how
to tune them are in
[Configuration → YouTube and downloads](CONFIGURATION.md#youtube-and-downloads).

The attempt order lives in `_download_audio` in
[`odst_tool/youtube_downloader.py`](../odst_tool/youtube_downloader.py).
