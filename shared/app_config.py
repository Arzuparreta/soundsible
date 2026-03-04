"""
Runtime app config set at startup. Shared code uses this instead of
depending on odst_tool layout or env file location.
"""

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
    """Return the configured output directory, or None if not set."""
    return _output_dir
