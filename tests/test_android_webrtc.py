from hashlib import sha256
from io import BytesIO
from pathlib import Path
import sys
from urllib.error import HTTPError
from zipfile import ZipFile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import android_webrtc  # noqa: E402
import download_retry  # noqa: E402


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    monkeypatch.setattr(download_retry, "sleep", lambda _seconds: None)


def test_pcm_dependency_rewrite_preserves_native_library_and_other_classes(tmp_path, monkeypatch):
    notices = tmp_path / "android/third-party/webrtc"
    notices.mkdir(parents=True)
    for name in ("GETSTREAM-LICENSE", "WEBRTC-LICENSE", "README.md"):
        (notices / name).write_text("license notice")
    classes = BytesIO()
    with ZipFile(classes, "w") as archive:
        archive.writestr("org/webrtc/audio/WebRtcAudioRecord.class", b"microphone")
        archive.writestr("org/webrtc/audio/WebRtcAudioRecord$AudioRecordThread.class", b"microphone thread")
        archive.writestr("org/webrtc/PeerConnection.class", b"peer")
    original = BytesIO()
    with ZipFile(original, "w") as archive:
        archive.writestr("classes.jar", classes.getvalue())
        archive.writestr("jni/x86_64/libjingle_peerconnection_so.so", b"unchanged native ABI")
    raw = original.getvalue()
    monkeypatch.setattr(android_webrtc, "SDK_SHA256", sha256(raw).hexdigest())
    monkeypatch.setattr(download_retry, "urlopen", lambda *args, **kwargs: BytesIO(raw))
    android_webrtc.prepare_webrtc(tmp_path)
    artifact = tmp_path / "android/app/libs/soundsible-webrtc.aar"
    first = artifact.read_bytes()
    with ZipFile(BytesIO(first)) as archive:
        assert archive.read("assets/third_party/webrtc/WEBRTC-LICENSE") == b"license notice"
        assert archive.read("jni/x86_64/libjingle_peerconnection_so.so") == b"unchanged native ABI"
        with ZipFile(BytesIO(archive.read("classes.jar"))) as rewritten:
            assert rewritten.namelist() == ["org/webrtc/PeerConnection.class"]
            assert rewritten.read("org/webrtc/PeerConnection.class") == b"peer"
    # A repeat uses the verified cache; network availability is not required.
    monkeypatch.setattr(download_retry, "urlopen", lambda *args, **kwargs: pytest.fail("unexpected download"))
    android_webrtc.prepare_webrtc(tmp_path)
    assert artifact.read_bytes() == first
    cache = tmp_path / "android/build/webrtc-original.aar"
    cache.write_bytes(raw + b"tampered")
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        android_webrtc.prepare_webrtc(tmp_path)
    assert artifact.read_bytes() == first


def test_pcm_dependency_rejects_unverified_download(tmp_path, monkeypatch):
    monkeypatch.setattr(download_retry, "urlopen", lambda *args, **kwargs: BytesIO(b"untrusted artifact"))
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        android_webrtc.prepare_webrtc(tmp_path)
    assert not (tmp_path / "android/build/webrtc-original.aar").exists()
    assert not (tmp_path / "android/app/libs/soundsible-webrtc.aar").exists()


def _aar():
    original = BytesIO()
    with ZipFile(original, "w") as archive:
        classes = BytesIO()
        with ZipFile(classes, "w") as jar:
            jar.writestr("org/webrtc/audio/WebRtcAudioRecord.class", b"microphone")
            jar.writestr("org/webrtc/audio/WebRtcAudioRecord$Thread.class", b"thread")
        archive.writestr("classes.jar", classes.getvalue())
    return original.getvalue()


def test_a_transient_404_and_a_truncated_body_are_retried_across_mirrors(tmp_path, monkeypatch):
    notices = tmp_path / "android/third-party/webrtc"
    notices.mkdir(parents=True)
    for name in ("GETSTREAM-LICENSE", "WEBRTC-LICENSE", "README.md"):
        (notices / name).write_text("notice")
    raw = _aar()
    monkeypatch.setattr(android_webrtc, "SDK_SHA256", sha256(raw).hexdigest())
    asked = []

    def flaky(url, **_kwargs):
        asked.append(url)
        if len(asked) == 1:
            raise HTTPError(url, 404, "Not Found", {}, None)
        if len(asked) == 2:
            return BytesIO(raw[:10])  # cut short
        return BytesIO(raw)

    monkeypatch.setattr(download_retry, "urlopen", flaky)
    android_webrtc.prepare_webrtc(tmp_path)

    assert len(asked) == 3 and len(set(asked)) == 3  # one mirror each
    assert (tmp_path / "android/build/webrtc-original.aar").read_bytes() == raw
    assert not (tmp_path / "android/build/webrtc-original.part").exists()


def test_a_dependency_that_never_arrives_fails_after_every_attempt(tmp_path, monkeypatch):
    calls = []

    def gone(url, **_kwargs):
        calls.append(url)
        raise HTTPError(url, 404, "Not Found", {}, None)

    monkeypatch.setattr(download_retry, "urlopen", gone)
    with pytest.raises(RuntimeError, match="failed after 6 attempts"):
        android_webrtc.prepare_webrtc(tmp_path)
    assert len(calls) == download_retry.ATTEMPTS
    assert not (tmp_path / "android/build/webrtc-original.aar").exists()
