"""Publish a file whole or not at all, without holding its content in memory."""
import io
import os
from pathlib import Path
import shutil
import tempfile
from typing import BinaryIO, Callable, Iterable

# shutil's own Linux default; larger buffers only raise the memory peak.
COPY_BUFFER = 64 * 1024


def publish(path: Path, fill: Callable[[BinaryIO], None]) -> None:
    """Write through `fill` into a temporary beside `path`, fsync, then rename.

    Readers see the previous file or the complete new one, never a partial
    write. The temporary is closed before the rename, which Windows requires.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            fill(handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def text_pieces(pieces: Iterable[str]) -> Callable[[BinaryIO], None]:
    """A `fill` writing text as a UTF-8 text-mode file would, platform newlines included."""
    def fill(handle: BinaryIO) -> None:
        text = io.TextIOWrapper(handle, encoding="utf-8")
        try:
            for piece in pieces:
                text.write(piece)
            text.flush()
        finally:
            # Leave `handle` open for `publish` to fsync and close.
            text.detach()
    return fill


def copy_of(source: Path) -> Callable[[BinaryIO], None]:
    """A `fill` copying `source` in bounded chunks, open only while copying."""
    def fill(handle: BinaryIO) -> None:
        with open(source, "rb") as reader:
            shutil.copyfileobj(reader, handle, COPY_BUFFER)
    return fill
