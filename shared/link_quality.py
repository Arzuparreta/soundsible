"""How fast the music is actually reaching this listener.

The engine has always known how long a response took to open and how many bytes
it promised. It never recorded how many arrived, which is the only number that
explains a wait: a phone that took thirty seconds to start a song was being
served at 87 KB/s over a relayed path, and nothing in the app said so — it said
"Buffering…" and left the listener to guess.

What is measured here is the delivery of the audio the listener already asked
for. No probe traffic, no synthetic download: the bytes are the ones they were
waiting for anyway.

Two honesties are built in:

* **The peak, not the mean.** A media element that has buffered enough reads
  slowly on purpose. Averaging that in measures the player's patience rather
  than the link, so the reading is the fastest complete response seen recently.
* **Only responses that finished.** A response the client abandoned has bytes
  sitting in a socket buffer that may never have crossed the network, so it
  cannot be timed honestly. Those are counted, and kept out of the reading.

The scope is where the request came from — LAN, tailnet, or somewhere else. The
engine cannot see whether Tailscale relayed a packet, and this deliberately does
not pretend otherwise: it reports the address family it can see, next to a speed
it actually measured.
"""

from __future__ import annotations

import ipaddress
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Deque, Optional

#: Samples smaller than this are dominated by round trips rather than by
#: bandwidth: an opening chunk over a 200 ms path reads as slow however fat the
#: pipe is. They are recorded and ignored by the reading.
MIN_SAMPLE_BYTES = 64 * 1024

#: How long a reading stays meaningful. A listener who walks out of the house
#: should not be told about the Wi-Fi they were on an hour ago.
SAMPLE_TTL_SEC = 15 * 60

#: Per account. Enough to survive a track's worth of ranges without growing.
MAX_SAMPLES = 64

SCOPE_LOCAL = "local"
SCOPE_LAN = "lan"
SCOPE_TAILNET = "tailnet"
SCOPE_REMOTE = "remote"

#: Tailscale hands out addresses from the CGNAT range, so a request from
#: 100.64/10 came through the tailnet — direct or relayed, which is exactly the
#: distinction the engine cannot make and does not claim to.
_TAILNET = ipaddress.ip_network("100.64.0.0/10")


@dataclass(frozen=True)
class Sample:
    at: float
    scope: str
    delivered_bytes: int
    elapsed_ms: float
    complete: bool

    @property
    def kbps(self) -> float:
        if self.elapsed_ms <= 0:
            return 0.0
        return self.delivered_bytes * 8 / self.elapsed_ms


_samples: dict[str, Deque[Sample]] = defaultdict(lambda: deque(maxlen=MAX_SAMPLES))
_lock = threading.Lock()


def classify_scope(remote_addr: Optional[str]) -> str:
    """Where this request came from, as far as the socket can tell."""
    try:
        address = ipaddress.ip_address((remote_addr or "").strip())
    except ValueError:
        return SCOPE_REMOTE
    if address.is_loopback:
        return SCOPE_LOCAL
    if address.version == 4 and address in _TAILNET:
        return SCOPE_TAILNET
    if address.is_private or address.is_link_local:
        return SCOPE_LAN
    return SCOPE_REMOTE


def record(
    user_id: Optional[str],
    *,
    scope: str,
    delivered_bytes: int,
    elapsed_ms: float,
    complete: bool,
) -> None:
    if not user_id or delivered_bytes <= 0 or elapsed_ms <= 0:
        return
    with _lock:
        _samples[user_id].append(
            Sample(
                at=time.time(),
                scope=scope,
                delivered_bytes=int(delivered_bytes),
                elapsed_ms=float(elapsed_ms),
                complete=bool(complete),
            )
        )


def snapshot(user_id: Optional[str], *, now: Optional[float] = None) -> dict:
    """The best recent reading for this account, or an empty one.

    `kbps` is null rather than zero when nothing usable has been seen: "not
    measured yet" and "measured, and it is slow" are different answers, and a
    player that shows the second when it means the first is lying again.
    """
    moment = now if now is not None else time.time()
    with _lock:
        recent = [s for s in _samples.get(user_id or "", ()) if moment - s.at <= SAMPLE_TTL_SEC]
    usable = [s for s in recent if s.complete and s.delivered_bytes >= MIN_SAMPLE_BYTES]
    best = max(usable, key=lambda s: s.kbps, default=None)
    return {
        "scope": recent[-1].scope if recent else None,
        "kbps": round(best.kbps, 1) if best else None,
        "samples": len(recent),
        "measured_at": round(best.at, 3) if best else None,
    }


def reset() -> None:
    """Forget every reading. For tests and for a user switching account."""
    with _lock:
        _samples.clear()
