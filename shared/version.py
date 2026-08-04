"""The one place Soundsible says what version it is.

Before this module the answer depended on who you asked: four call sites each
defaulted to ``0.0.0-dev`` on their own, the Docker image defaulted to
``0.0.0-docker``, and the desktop shell claimed ``1.0.0-rc.1``. A user reporting
a bug had no single number to quote and no way to know whether two of them meant
the same build.

Resolution order, most specific first:

1. ``SOUNDSIBLE_VERSION`` — set by the Docker image and by CI from the git tag,
   so a published artefact reports exactly what was released.
2. ``VERSION`` below — what this source tree declares itself to be.

``source_revision()`` is the companion for "which commit": builds set
``SOUNDSIBLE_SOURCE_REVISION``, and it is absent rather than guessed when
nothing set it.
"""

from __future__ import annotations

import os

#: The version this source tree declares. Bump on release; CI overrides it with
#: the git tag for anything it publishes.
VERSION = "0.1.0"

__version__ = VERSION

__all__ = ["VERSION", "__version__", "resolve_version", "source_revision"]


def resolve_version() -> str:
    """Return the version this running process should report."""
    override = os.getenv("SOUNDSIBLE_VERSION", "").strip()
    return override or VERSION


def source_revision() -> str | None:
    """Return the commit this build came from, or ``None`` if unrecorded.

    Deliberately not derived from ``git describe`` at import time: a container
    has no checkout to ask, and a developer's dirty tree would answer with a
    revision that does not match what is running.
    """
    revision = os.getenv("SOUNDSIBLE_SOURCE_REVISION", "").strip()
    return revision or None
