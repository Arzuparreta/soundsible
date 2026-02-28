#!/usr/bin/env python3
"""
Diagnose Discover cover URLs: recommendations and resolve endpoints.
Run with API base URL (default http://127.0.0.1:5005). Use to verify cover_url/thumbnail
are valid and reachable.
"""
import os
import sys
import json
import argparse

try:
    import requests
except ImportError:
    print("Install requests: pip install requests")
    sys.exit(1)

DEFAULT_BASE = os.environ.get("SOUNDSIBLE_API_URL", "http://127.0.0.1:5005")


def test_recommendations(base_url: str, limit: int = 5) -> list:
    print("--- /api/discover/recommendations ---")
    try:
        r = requests.post(
            f"{base_url}/api/discover/recommendations",
            json={"limit": limit, "new_session": True},
            timeout=15,
        )
        if r.status_code != 200:
            print(f"Error {r.status_code}: {r.text}")
            return []
        data = r.json()
        results = data.get("results", [])
        reason = data.get("reason")
        if reason:
            print(f"Reason: {reason}")
        print(f"Results: {len(results)}")
        for i, item in enumerate(results):
            print(f"  [{i}] {item.get('artist')} - {item.get('title')}")
            print(f"      id: {item.get('id')}")
            print(f"      cover_url: {item.get('cover_url')}")
            print(f"      thumbnail: {item.get('thumbnail')}")
        return results
    except Exception as e:
        print(f"Exception: {e}")
        return []


def test_resolve(base_url: str, artist: str, title: str) -> dict | None:
    print(f"\n--- /api/discover/resolve '{artist}' - '{title}' ---")
    try:
        r = requests.post(
            f"{base_url}/api/discover/resolve",
            json={"artist": artist, "title": title},
            timeout=15,
        )
        if r.status_code != 200:
            print(f"Error {r.status_code}: {r.text}")
            return None
        data = r.json()
        print("Response keys:", list(data.keys()))
        print(f"  id: {data.get('id')}")
        print(f"  cover_url: {data.get('cover_url')}")
        print(f"  thumbnail: {data.get('thumbnail')}")
        if data.get("cover_url"):
            check_url(data["cover_url"], "cover_url")
        if data.get("thumbnail") and data.get("thumbnail") != data.get("cover_url"):
            check_url(data["thumbnail"], "thumbnail")
        return data
    except Exception as e:
        print(f"Exception: {e}")
        return None


def check_url(url: str, label: str) -> None:
    try:
        r = requests.head(url, timeout=5, allow_redirects=True)
        print(f"  {label} HEAD -> {r.status_code}")
    except Exception as e:
        print(f"  {label} HEAD failed: {e}")


def main():
    p = argparse.ArgumentParser(description="Diagnose Discover cover URLs")
    p.add_argument("--base", default=DEFAULT_BASE, help="API base URL")
    p.add_argument("--limit", type=int, default=5, help="Number of recommendations")
    p.add_argument("--resolve-only", nargs=2, metavar=("ARTIST", "TITLE"), help="Only call resolve")
    args = p.parse_args()
    base = args.base.rstrip("/")

    if args.resolve_only:
        test_resolve(base, args.resolve_only[0], args.resolve_only[1])
        return

    results = test_recommendations(base, args.limit)
    if not results:
        return
    unresolved = [r for r in results if str(r.get("id", "")).startswith("unresolved-")]
    if unresolved:
        item = unresolved[0]
        test_resolve(base, item.get("artist", ""), item.get("title", ""))
    else:
        test_resolve(base, results[0].get("artist", ""), results[0].get("title", ""))


if __name__ == "__main__":
    main()
