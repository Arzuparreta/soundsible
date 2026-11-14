# S2l: podcast directory, following and acquisition

The directory uses the engine search and opens RSS without subscribing or acquiring.
Follow/unfollow requires server confirmation and lives in the
three-dot menu of the show. Unfollowing keeps the acquired files.

The episode menu offers explicit acquisition, retry after failure/interruption and
job cancellation. The durable engine queue is the authority. Its completed
jobs disappear from queue/status: that disappearance refreshes Library, but
"Downloaded" requires a confirmed acquired Track, never only the absence of a job.
Observation is cancelled on disconnect/account change and resumes on reconnect.

Streaming and the acquired file keep the S2k progress. The join fallback
requires a real GUID plus feed or RSS; two shows without a feed ID cannot be joined by
a GUID with the same name. Offline B still covers only acquired music.

The fixture replaces the iTunes/RSS/enclosure edge with synthetic audio. Search,
RSS, roles, tokens, persistent queue, finalizer and files/ranges are real
paths. The downloader now closes the upstream Response also when status,
type or read fails. SSRF and cookies toward providers are not modified.

Two APK tests (HTTP and verified HTTPS) walk through search, stream without follow,
follow, acquisition that fails with 503, retry, local file with resume and unfollow
without deletion. The Python test reproduces the real acquisition and account
isolation. See HANDOFF for final regression results.

External covers, other episode actions and the rest of the matrix are still
pending. This is development, not alpha. Continue with native Radio NORMAL and
the phone, DJ, Live, Auto, signing and update gates before PR/release.
