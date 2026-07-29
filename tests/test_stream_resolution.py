import time

from shared.stream_resolution import resolved_stream


def test_resolution_keeps_egress_and_signed_expiry():
    expiry = int(time.time()) + 1000
    stream = resolved_stream(
        f"https://rr.googlevideo.com/audio?expire={expiry}",
        egress="relay",
        proxy_url="http://100.91.167.48:8888",
        resolution_ms=123,
        now=1000,
    )
    assert stream.egress == "relay"
    assert stream.expires_at == expiry
    assert stream.resolution_ms == 123
    assert stream.requests_proxies() == {
        "http": "http://100.91.167.48:8888",
        "https": "http://100.91.167.48:8888",
    }
    assert stream.cache_ttl(default_sec=300, safety_margin_sec=60) == 300


def test_direct_resolution_never_carries_proxy():
    stream = resolved_stream(
        "https://rr.googlevideo.com/audio",
        egress="direct",
        proxy_url="http://should-be-dropped.invalid",
        now=1000,
    )
    assert stream.proxy_url is None
    assert stream.requests_proxies() is None
