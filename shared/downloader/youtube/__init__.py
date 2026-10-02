"""Everything Soundsible asks of YouTube, one concern per module.

- `ytdlp`: how a yt-dlp call reaches YouTube — relay or IPv4, cookies,
  retries and the format selectors.
- `ids`: video ids, watch URLs and thumbnails.
- `web`: the small plain-HTTP calls to youtube.com (oembed, visitor data).
- `search`: text search, match candidates, related videos and metadata peeks.
- `streams`: resolving a video to a playable audio URL.
- `download`: fetching a video's audio to a file.
- `tracks`: turning a downloaded file into a library `Track`.

`shared.downloader.youtube_downloader.YouTubeDownloader` ties them to one output
folder and one set of cookies; the engine talks to that.
"""
