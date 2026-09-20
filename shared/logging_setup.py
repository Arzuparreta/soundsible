"""Shared console logging for native and container engines."""

import logging
import os


def configure_logging() -> None:
    logging.basicConfig(
        level=os.getenv("SOUNDSIBLE_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
