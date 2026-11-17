import json

import pytest

from scripts.check_android_webview import check


def packaged(tmp_path):
    (tmp_path / "ui_web").mkdir()
    (tmp_path / "android/web-dist").mkdir(parents=True)
    config = {"android": {"minWebViewVersion": 120}, "server": {"errorPath": "webview-error.html"}}
    (tmp_path / "ui_web/capacitor.config.json").write_text(json.dumps(config))
    (tmp_path / "ui_web/vite.android.config.ts").write_text("export default { build: { target: 'chrome120' } }")
    (tmp_path / "android/variables.gradle").write_text("ext { minSdkVersion = 26 }")
    (tmp_path / "android/web-dist/webview-error.html").write_text("<main><h1>Update WebView</h1></main>")
    return tmp_path, config


def test_packaged_entry_is_independent_of_the_modern_bundle(tmp_path):
    root, _ = packaged(tmp_path)
    check(root)
    (root / "android/web-dist/webview-error.html").write_text('<main><h1>Update</h1><script type="module" src="assets/player.js"></script></main>')
    with pytest.raises(ValueError, match="JavaScript"):
        check(root)


def test_rejects_an_os_that_cannot_install_the_required_webview(tmp_path):
    root, _ = packaged(tmp_path)
    (root / "android/variables.gradle").write_text("ext { minSdkVersion = 24 }")
    with pytest.raises(ValueError, match="API 26"):
        check(root)


def test_rejects_an_engine_below_the_bundle_target(tmp_path):
    root, config = packaged(tmp_path)
    config["android"]["minWebViewVersion"] = 119
    (root / "ui_web/capacitor.config.json").write_text(json.dumps(config))
    with pytest.raises(ValueError, match="compiled JavaScript"):
        check(root)


@pytest.mark.parametrize("entry", ["missing.html", "../outside.html", ""])
def test_rejects_a_missing_or_unpackaged_compatibility_entry(tmp_path, entry):
    root, config = packaged(tmp_path)
    config["server"]["errorPath"] = entry
    (root / "ui_web/capacitor.config.json").write_text(json.dumps(config))
    with pytest.raises(ValueError):
        check(root)
