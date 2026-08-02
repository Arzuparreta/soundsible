"""EBU R128 / ITU-R BS.1770 loudness measurement for a single audio file.

One ffmpeg pass per file, one meter, one reference. Nothing here ever returns a
partial or approximate reading: a measurement is either fully trustworthy or it
is ``None``, because the player turns a reading into a gain and a wrong reading
is an audibly wrong track.

Pre-existing ``REPLAYGAIN_*`` / ``R128_*`` / ``iTunNORM`` tags are deliberately
ignored. They are written against four different reference levels, they go stale
the moment a file is re-encoded, and plenty of them were written by tools that
got it wrong. Trusting one is exactly the false correction this feature must not
make.
"""

from __future__ import annotations

import logging
import math
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from shared.ffmpeg_runtime import ffmpeg_executable

logger = logging.getLogger(__name__)

#: Bumping this invalidates every stored measurement. Change it whenever the
#: command, the filter options, or the parser's idea of a valid reading changes.
LOUDNESS_VERSION = 1

#: The meter's own floor. `ebur128` reports exactly -70.0 LUFS for digital
#: silence and for anything shorter than one 400 ms gating block, which is not a
#: reading of the programme — it is the absolute gate saying "nothing here".
#: Treating it as one would ask for +56 dB.
UNMEASURABLE_LUFS = -69.0

#: Sanity band for a real reading. The ceiling is deliberately above 0 LUFS: a
#: master clipped into a near-square wave really does integrate to about
#: +2.3 LUFS, and that is the loudest content there is — precisely what most
#: needs attenuating. Rejecting it would leave the worst offender at unity.
#: Nothing physical goes past +5, so a larger number is a mis-parse.
MIN_VALID_LUFS = -70.0
MAX_VALID_LUFS = 5.0
MIN_VALID_PEAK_DBTP = -70.0
MAX_VALID_PEAK_DBTP = 12.0

#: K-weighting can put integrated loudness a few dB above true peak on very
#: bright material, but not far above it. More than this means the two numbers
#: did not come from the same place — most likely a mis-parse.
MAX_LOUDNESS_OVER_PEAK = 5.0

DEFAULT_TIMEOUT_SEC = 300.0
MIN_TIMEOUT_SEC = 60.0
MAX_TIMEOUT_SEC = 600.0


@dataclass(frozen=True)
class LoudnessMeasurement:
    """A complete, trustworthy reading. Partial readings do not exist."""

    lufs: float
    peak_dbtp: float
    lra: float


class MeasurementError(RuntimeError):
    """The file could not be read — a hang, a missing binary, a bad disk.

    Distinct from a `None` measurement, which means the file *was* read and
    genuinely has no programme loudness. The difference is the whole retry
    policy: this is worth trying again later, that never is.
    """


# `Summary:` sections, matched on their own line. `peak=true+sample` emits both a
# `Sample peak:` and a `True peak:` section whose value lines are identical
# (`Peak: -0.4 dBFS`) at the same indentation, so the only safe way to read the
# true peak is to know which section we are inside.
_SECTION_RE = re.compile(r"^\s*(Integrated loudness|Loudness range|Sample peak|True peak):\s*$")
_INTEGRATED_RE = re.compile(r"^\s*I:\s*(\S+)\s*LUFS\s*$")
_LRA_RE = re.compile(r"^\s*LRA:\s*(\S+)\s*LU\s*$")
_PEAK_RE = re.compile(r"^\s*Peak:\s*(\S+)\s*dBFS\s*$")


def _ffmpeg_command(path: Path) -> list[str]:
    """The measurement pass.

    ``-vn -sn -dn`` is a performance decision, not a tidiness one: without it
    ffmpeg decodes the embedded cover art of every tagged MP3 and FLAC as a
    video stream. ``framelog=quiet`` drops the per-frame line, which otherwise
    makes stderr megabytes long for one track while telling us nothing — the
    ``Summary:`` block still prints. ``peak=true`` is what makes the player's
    clipping guard safe: a decoded MP3's true peak routinely sits 1-2 dB above
    its sample peak.
    """
    return [
        ffmpeg_executable(),
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-v", "info",
        "-i", str(path),
        "-map", "0:a:0",
        "-vn", "-sn", "-dn",
        "-threads", "1",
        "-filter:a", "ebur128=peak=true:framelog=quiet",
        "-f", "null",
        "-",
    ]


def _finite(raw: str) -> float | None:
    """Parse one number from the summary, rejecting anything not finite.

    ``-inf`` is what silence reports for its peak, and a locale that writes
    ``-9,3`` would otherwise parse as ``-9``.
    """
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def parse_ebur128_summary(stderr: str) -> LoudnessMeasurement | None:
    """Read the meter's final summary, or ``None`` if it cannot be trusted.

    Scans from the *last* ``Summary:`` — a filter graph that was re-initialised
    prints more than one, and only the last describes the whole file.
    """
    if not stderr:
        return None
    marker = stderr.rfind("Summary:")
    if marker < 0:
        return None

    section = ""
    lufs: float | None = None
    peak: float | None = None
    lra: float | None = None

    for line in stderr[marker:].splitlines():
        header = _SECTION_RE.match(line)
        if header:
            section = header.group(1)
            continue
        if section == "Integrated loudness":
            found = _INTEGRATED_RE.match(line)
            if found:
                lufs = _finite(found.group(1))
        elif section == "Loudness range":
            found = _LRA_RE.match(line)
            if found:
                lra = _finite(found.group(1))
        elif section == "True peak":
            found = _PEAK_RE.match(line)
            if found:
                peak = _finite(found.group(1))

    # No `True peak:` section at all means an ffmpeg too old for `peak=true`.
    # Proceeding without a ceiling would let a boost clip, so we do not proceed.
    if lufs is None or peak is None:
        return None
    if not (MIN_VALID_LUFS < lufs <= MAX_VALID_LUFS):
        return None
    if not (MIN_VALID_PEAK_DBTP <= peak <= MAX_VALID_PEAK_DBTP):
        return None
    if lufs > peak + MAX_LOUDNESS_OVER_PEAK:
        return None
    if lufs <= UNMEASURABLE_LUFS:
        return None
    return LoudnessMeasurement(lufs=lufs, peak_dbtp=peak, lra=lra if lra is not None else 0.0)


def _timeout_for(duration_hint: float) -> float:
    if duration_hint and duration_hint > 0:
        return min(MAX_TIMEOUT_SEC, max(MIN_TIMEOUT_SEC, duration_hint * 0.5))
    return DEFAULT_TIMEOUT_SEC


def _low_priority_kwargs() -> dict:
    """Ask the OS to schedule the measurement behind everything else.

    Windows only, on purpose. The POSIX equivalent is ``preexec_fn=os.nice``,
    which CPython documents as unsafe in a process with threads — and this runs
    inside a threaded Flask + SocketIO server, where the payoff is a nice level
    and the risk is a fork-time deadlock. The idle gate, ``-threads 1`` and the
    pause between files already keep the sweep out of the way, and the real
    bottleneck is the disk anyway.
    """
    if sys.platform == "win32":
        return {"creationflags": getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)}
    return {}


def measure_loudness(path: str | Path, *, duration_hint: float = 0.0) -> LoudnessMeasurement | None:
    """Measure one file.

    Returns the reading, or ``None`` when the file was read successfully and
    simply has no programme loudness to speak of — digital silence, or a
    fragment shorter than one gating block. That is a verdict: it will never
    change, and the caller records it so the file is not reopened every sweep.

    Raises :class:`MeasurementError` when the *attempt* failed rather than the
    file: no ffmpeg, an unreadable path, a hang, a corrupt stream. Those are
    worth another try later, so the caller backs off instead of concluding
    anything about the audio.

    Either way the player ends up at unity gain until there is a real reading.
    """
    source = Path(path)
    try:
        if not source.is_file():
            raise MeasurementError(f"not a file: {source}")
    except OSError as exc:
        raise MeasurementError(f"could not stat {source}") from exc

    try:
        completed = subprocess.run(
            _ffmpeg_command(source),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=_timeout_for(duration_hint),
            **_low_priority_kwargs(),
        )
    except subprocess.TimeoutExpired as exc:
        raise MeasurementError(f"timed out measuring {source.name}") from exc
    except (OSError, ValueError) as exc:
        raise MeasurementError(f"could not run ffmpeg for {source.name}") from exc

    if completed.returncode != 0:
        raise MeasurementError(f"ffmpeg exited {completed.returncode} for {source.name}")
    # A clean exit whose summary we cannot trust is a verdict, not a failure:
    # rerunning the same deterministic command would produce the same summary.
    return parse_ebur128_summary((completed.stderr or b"").decode("utf-8", "ignore"))
