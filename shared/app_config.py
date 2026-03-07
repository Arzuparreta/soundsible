"""
Runtime app config set at startup. Shared code uses this instead of
depending on odst_tool layout or env file location.
"""

import os
from pathlib import Path
from typing import Optional, Union

_output_dir: Optional[Path] = None


def set_output_dir(path: Optional[Union[str, Path]]) -> None:
    """Set the output directory (e.g. library/tracks root). Normalized and expanded."""
    global _output_dir
    if path is None:
        _output_dir = None
        return
    _output_dir = Path(path).expanduser().resolve()


def get_output_dir() -> Optional[Path]:
    """Return the configured output directory, or None if not set.
    When not set in memory, reads from ~/.config/soundsible/output_dir then env.
    """
    global _output_dir
    if _output_dir is not None:
        return _output_dir
    try:
        from shared.constants import DEFAULT_CONFIG_DIR
        cfg = Path(DEFAULT_CONFIG_DIR).expanduser()
        out_file = cfg / "output_dir"
        if out_file.exists():
            raw = out_file.read_text().strip()
            if raw:
                _output_dir = Path(raw).expanduser().resolve()
                return _output_dir
    except Exception:
        pass
    try:
        out = os.environ.get("OUTPUT_DIR")
        if out:
            return Path(out).expanduser().resolve()
    except Exception:
        pass
    return None
