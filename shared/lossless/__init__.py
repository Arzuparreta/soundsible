"""Idle, best-effort lossless upgrades for YouTube-backed library tracks."""

from .service import (
    LosslessUpgradeService,
    get_lossless_service,
    stop_lossless_service_if_started,
)

__all__ = [
    "LosslessUpgradeService",
    "get_lossless_service",
    "stop_lossless_service_if_started",
]
