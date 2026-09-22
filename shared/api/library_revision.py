"""Small validator cache; never retains library snapshots or serialized bodies."""
from shared.api.memo import Memo
from shared.library_fingerprint import fingerprint  # noqa: F401

validators: Memo[str] = Memo(ttl_sec=600, maxsize=128)
