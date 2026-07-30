from pathlib import Path


def test_lossless_provider_code_is_absent_from_music_hot_paths():
    root = Path(__file__).resolve().parents[1]
    for relative in (
        "odst_tool/youtube_downloader.py",
        "shared/api/routes/catalog.py",
        "shared/api/routes/discovery.py",
        "shared/api/routes/playback.py",
    ):
        source = (root / relative).read_text(encoding="utf-8")
        assert "shared.lossless" not in source
        assert "LosslessProvider" not in source
