"""Publish a file whole or not at all, without holding its content in memory."""
import io
import os
from pathlib import Path
import secrets
import shutil
import stat
import tempfile
from typing import BinaryIO, Callable, Iterable, Optional, Tuple

# shutil's own Linux default; larger buffers only raise the memory peak.
COPY_BUFFER = 64 * 1024


def publish(path: Path, fill: Callable[[BinaryIO], None]) -> None:
    """Write through `fill` into a temporary beside `path`, fsync, then rename.

    Readers see the previous file or the complete new one, never a partial
    write. The temporary is closed before the rename, which Windows requires.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    _fill_and_rename(fd, temporary, path, fill, None)


def replace_contents(path: Path, fill: Callable[[BinaryIO], None]) -> None:
    """`publish` for a file other people's setups point at.

    Where an in-place rewrite used to be, readers now see the previous file or
    the complete new one, while the rest looks as before: a symlink is followed
    and stays a symlink, the file keeps its permission bits, and a new file gets
    the umask default as `open(path, "w")` gave it. Owner and inode do change.
    If the directory refuses a temporary, the file is rewritten in place as
    before rather than not at all.
    """
    target = path.resolve()
    try:
        mode: Optional[int] = stat.S_IMODE(target.stat().st_mode)
    except FileNotFoundError:
        mode = None
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd, temporary = _create_beside(target)
    except PermissionError:
        with open(target, "wb") as handle:
            fill(handle)
        return
    _fill_and_rename(fd, temporary, target, fill, mode)


def _create_beside(path: Path) -> Tuple[int, str]:
    """A new temporary beside `path`, created with the umask default mode."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    for _ in range(100):
        temporary = str(path.parent / f".{path.name}.{secrets.token_hex(4)}")
        try:
            return os.open(temporary, flags, 0o666), temporary
        except FileExistsError:
            continue
    raise FileExistsError(f"No free temporary name beside {path}")


def _fill_and_rename(fd: int, temporary: str, path: Path,
                     fill: Callable[[BinaryIO], None], mode: Optional[int]) -> None:
    try:
        with os.fdopen(fd, "wb") as handle:
            fill(handle)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temporary, mode)
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
