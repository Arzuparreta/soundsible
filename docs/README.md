# Soundsible guides

[Back to Soundsible](../README.md)

## Start listening

| Guide | Use it to… |
| --- | --- |
| [Install & deployment](INSTALL.md) | Install on your computer or server; set up remote access, storage and a reverse proxy. |
| [Docker](DOCKER.md) | Run with Compose, mount an existing library, back up and upgrade. |
| [Desktop beta](DESKTOP_BETA.md) | Check platform status and use the bundled desktop app. |
| [Settings & sources](CONFIGURATION.md) | Configure accounts, search, downloads and YouTube cookies. |
| [Bring your music](MUSIC_MIGRATION.md) | Import Spotify and Apple Music exports. |

## Explore Soundsible

| Guide | What's inside |
| --- | --- |
| [DJ](AUTO_MODE.md) | Start a set, choose influences, request songs and edit transitions. |
| [Live](LIVE.md) | Broadcast, share a room and understand the relay and browser requirements. |
| [OpenSubsonic](OPENSUBSONIC.md) | Connect other apps to your saved music library. |
| [iOS status](IOS.md) | Build and installation instructions, with device behaviour still unverified. |
| [Car integration](CAR_INTEGRATION.md) | Web media controls and the unverified native car path. |
| [Roadmap](ROADMAP.md) | Current capabilities, priorities and planned device support. |
| [Privacy](TELEMETRY_PRIVACY.md) | What listening data stays on your server and how to turn learning off. |
| [Legal & acceptable use](LEGAL.md) | Responsibilities when downloading and sharing music. |

## Troubleshoot or contribute

- [YouTube download troubleshooting](troubleshooting-yt-dlp-formats.md) · [Playback diagnosis](PLAYBACK_DIAGNOSIS.md)
- [VPS YouTube relay](VPS_RELAY.md) · [Performance](PERFORMANCE.md)
- [Contributing](../CONTRIBUTING.md) · [Web player development](../ui_web/README.md)
- [Architecture](ARCHITECTURE.md) · [Design](../DESIGN.md) · [Artwork](ARTWORK.md)
- [Desktop shell](../desktop-shell/README.md) · [Agent API](AGENT_INTEGRATION.md)
- [Releases](RELEASING.md) · [Security policy](../SECURITY.md)

Some working notes are kept in the repository but go stale and are not
maintained for readers — read the [roadmap](ROADMAP.md) instead of these:
[appliance rework](appliance-rework-plan.md) · [premium quality contract](PREMIUM_QUALITY_CONTRACT.md) · [layer contracts](LAYER_CONTRACTS.md) · [playback queue contract](PLAYBACK_QUEUE_CONTRACT.md) · [mobile lists](MOBILE_LISTS.md) · [UI rebuild plan](UI_REBUILD_PLAN.md)

## Built with

FFmpeg is installed on the host; Python dependencies come from `pip`, and the
player is built with `npm` in `ui_web/`.

| Project | License | Role |
| --- | --- | --- |
| [SolidJS](https://www.solidjs.com/) + [Vite](https://vite.dev/) | MIT | The web player (`ui_web/`) |
| [Flask](https://flask.palletsprojects.com/) + [Socket.IO](https://socket.io/) | BSD / MIT | Station Engine API and real-time events |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense (public domain) | YouTube and YouTube Music search and download |
| [LRCLIB](https://lrclib.net/) | Public API | Synced and plain lyrics |
| [Deezer public API](https://developers.deezer.com/) | Public API | Discovery metadata only — no audio comes from Deezer |
| [MusicBrainz](https://musicbrainz.org/) | Public API | Recording and release identification |
| [FFmpeg](https://ffmpeg.org/) | LGPL / GPL | Audio conversion and extraction |
| [ffmpeg-python](https://github.com/kkroening/ffmpeg-python) | Apache 2.0 | Python bindings for FFmpeg |
