"""The download pipeline: YouTube, the download pool and cloud sync.

- `service.Downloader`: the pool every account downloads into.
- `youtube_downloader.YouTubeDownloader` and `youtube/`: search, streams and
  downloads.
- `settings`: the admin settings Settings → Downloads saves.
- `cloud_sync`: pushing the pool to an R2 bucket.
"""
