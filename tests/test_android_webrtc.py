from hashlib import sha256
from io import BytesIO
from zipfile import ZipFile

import pytest

from scripts import android_webrtc


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
    monkeypatch.setattr(android_webrtc, "urlopen", lambda *args, **kwargs: BytesIO(raw))
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
    monkeypatch.setattr(android_webrtc, "urlopen", lambda *args, **kwargs: pytest.fail("unexpected download"))
    android_webrtc.prepare_webrtc(tmp_path)
    assert artifact.read_bytes() == first
    cache = tmp_path / "android/build/webrtc-original.aar"
    cache.write_bytes(raw + b"tampered")
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        android_webrtc.prepare_webrtc(tmp_path)
    assert artifact.read_bytes() == first


def test_pcm_dependency_rejects_unverified_download(tmp_path, monkeypatch):
    monkeypatch.setattr(android_webrtc, "urlopen", lambda *args, **kwargs: BytesIO(b"untrusted artifact"))
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        android_webrtc.prepare_webrtc(tmp_path)
    assert not (tmp_path / "android/build/webrtc-original.aar").exists()
    assert not (tmp_path / "android/app/libs/soundsible-webrtc.aar").exists()
