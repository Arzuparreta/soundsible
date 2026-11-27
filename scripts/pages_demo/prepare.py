"""Validate and package the pinned music and its credits for the Pages build."""
import hashlib
import html
import json
import shutil
import sys
from pathlib import Path

root = Path(__file__).parent / "catalog"
output = Path(sys.argv[1])
catalog = json.loads((root / "tracks.json").read_text(encoding="utf-8"))
credits = []
runtime = []
media = output / "media"
media.mkdir()
for entry in catalog:
    track = entry.copy()
    source = track.pop("source_page")
    license_url = track.pop("license")
    expected = track.pop("sha256")
    recording = root / "media" / f"{track['id']}.mp3"
    data = recording.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"Demo recording has changed: {recording.name}")
    name = f"{track['id']}-{expected[:12]}.mp3"
    (media / name).write_bytes(data)
    track.update(file=name, file_size=len(data), audio_quality="lossy", bitrate=96,
                 artwork_width=400, artwork_height=400)
    cover = f"{track['album_id']}.svg"
    shutil.copyfile(root / cover, media / cover)
    runtime.append(track)
    title, artist, album = (html.escape(track[key]) for key in ("title", "artist", "album"))
    credits.append(
        f'<li><a href="{html.escape(source)}">{title}</a> by {artist}, from <i>{album}</i> '
        f'(<a href="{html.escape(license_url)}">CC BY {license_url.rstrip("/").split("/")[-1]}</a>)</li>'
    )

(output / "catalog.json").write_text(json.dumps(runtime, ensure_ascii=False), encoding="utf-8")
(output / "credits.html").write_text(
    """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Soundsible demo music credits</title>
<style>body{font:1rem/1.55 system-ui;color:#e7e9ec;background:#141719;margin:0}main{width:min(43rem,calc(100% - 3rem));margin:3rem auto}a{color:#b6dcbc}li{margin:.55rem 0}</style>
<main><a href="./index.html">Open the demo</a>
<h1>Music credits</h1>
<p>The demo includes complete recordings from two albums. The audio has been re-encoded to 96 kbps MP3 and the illustrations were created for the demo.</p>
<ul>
""" + "\n".join(credits) + """
</ul></main></html>
""", encoding="utf-8",
)
