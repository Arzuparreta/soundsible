"""Stable DJ entry points; implementation lives in :mod:`shared.dj`.

Acquisition owns the only cache and worker pool. Musical modules are pure and
can be imported without loading SQLite, FFmpeg or the HTTP application.
Private test injection points live in their owning modules (see docs/dj/ARCHITECTURE.md).
"""

from shared.dj.contracts import ANALYSER_VERSION as ANALYSER_VERSION
from shared.dj.routes import (
    order_continuous_route as order_continuous_route,
    order_route as order_route,
    route_to_request as route_to_request,
)
from shared.dj.store import (
    analyse_audio as analyse_audio,
    analysis_identity as analysis_identity,
    cached_analysis as cached_analysis,
    request_analysis as request_analysis,
)
from shared.dj.transitions import plan_transition as plan_transition
