"""A memo whose lifetime is one request.

Some values are cheap to derive once and expensive to derive repeatedly, but
stale the moment the request ends: the listening-event rollup is read from a
JSONL tail and re-parsed, the discovery settings from a small JSON file, and a
single discovery feed build asked for both several times over. A TTL cache is
the wrong tool — it would serve one request's answer to the next — so this
caches for exactly as long as the answer is guaranteed fresh.

Backed by a `ContextVar`, so it follows greenlets under gevent and threads
without one. Outside a scope every lookup simply computes, which keeps CLI
paths and background workers working unchanged.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Callable, Iterator, Optional, TypeVar

T = TypeVar("T")

_scope: ContextVar[Optional[dict[str, Any]]] = ContextVar("soundsible_request_scope", default=None)


def begin() -> object:
    """Open a scope. Returns a token to hand to :func:`end`."""
    return _scope.set({})


def end(token: object) -> None:
    """Close the scope opened by ``token``."""
    try:
        _scope.reset(token)  # type: ignore[arg-type]
    except ValueError:
        # The token belongs to another context (a worker greenlet outliving the
        # request that spawned it). Dropping the scope is the right fallback.
        _scope.set(None)


@contextmanager
def request_scope() -> Iterator[None]:
    token = begin()
    try:
        yield
    finally:
        end(token)


def scoped(key: str, factory: Callable[[], T]) -> T:
    """``factory()``'s result, computed at most once per scope.

    ``key`` must identify everything the value depends on — including whose
    request it is, since the bound user changes what most of these read.
    """
    cache = _scope.get()
    if cache is None:
        return factory()
    if key in cache:
        return cache[key]
    value = factory()
    cache[key] = value
    return value


def invalidate(prefix: str = "") -> None:
    """Drop scoped entries, all of them or those starting with ``prefix``.

    Needed when a request writes something it had already read — settings
    updates, for instance.
    """
    cache = _scope.get()
    if not cache:
        return
    if not prefix:
        cache.clear()
        return
    for key in [k for k in cache if k.startswith(prefix)]:
        cache.pop(key, None)
