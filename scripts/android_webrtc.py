"""Pinned WebRTC AAR with only its microphone recorder replaced by our PCM adapter."""
from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

from download_retry import fetch

SDK_PATH = "io/getstream/stream-webrtc-android/1.3.10/stream-webrtc-android-1.3.10.aar"
#: Maven Central and two of its official mirrors; the checksum pins the bytes.
SDK_URLS = tuple(
    base + SDK_PATH
    for base in (
        "https://repo.maven.apache.org/maven2/",
        "https://repo1.maven.org/maven2/",
        "https://maven-central.storage-download.googleapis.com/maven2/",
    )
)
SDK_SHA256 = "afa3b0feaa2902f6ece10e67ce3b7e6d9def18a86b73f0c6a524209cb938aa96"


def prepare_webrtc(root: Path) -> None:
    cache = root / "android/build/webrtc-original.aar"
    output = root / "android/app/libs/soundsible-webrtc.aar"
    cache.parent.mkdir(parents=True, exist_ok=True)
    if not cache.exists():
        raw = fetch(SDK_URLS, max_bytes=64 * 1024 * 1024, sha256=SDK_SHA256, what="WebRTC dependency")
        partial = cache.with_suffix(".part")
        partial.write_bytes(raw)
        partial.replace(cache)
    raw = cache.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SDK_SHA256:
        raise RuntimeError("Cached WebRTC dependency checksum mismatch")
    rewritten = BytesIO()
    with ZipFile(BytesIO(raw)) as original, ZipFile(rewritten, "w", ZIP_DEFLATED) as result:
        for entry in original.infolist():
            data = original.read(entry)
            if entry.filename == "classes.jar":
                classes = BytesIO()
                with ZipFile(BytesIO(data)) as source, ZipFile(classes, "w", ZIP_DEFLATED) as target:
                    removed = 0
                    for item in source.infolist():
                        name = item.filename
                        if name == "org/webrtc/audio/WebRtcAudioRecord.class" or name.startswith("org/webrtc/audio/WebRtcAudioRecord$"):
                            removed += 1
                        else:
                            target.writestr(item, source.read(item))
                    if removed < 2:
                        raise RuntimeError("Unexpected WebRTC recorder ABI layout")
                data = classes.getvalue()
            result.writestr(entry, data)
        for name in ("GETSTREAM-LICENSE", "WEBRTC-LICENSE", "README.md"):
            notice = root / "android/third-party/webrtc" / name
            entry = ZipInfo("assets/third_party/webrtc/" + name, (1980, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            result.writestr(entry, notice.read_bytes())
    output.parent.mkdir(parents=True, exist_ok=True)
    content = rewritten.getvalue()
    if not output.exists() or output.read_bytes() != content:
        output.write_bytes(content)
