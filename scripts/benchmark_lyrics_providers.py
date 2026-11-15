"""Read-only library sampling and bounded, resumable public lyrics measurements.

No application database managers, audio processing, provider keys, or lyric bodies
are persisted. Run --help for the snapshot, run and summarize commands.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import html
import json
import logging
import math
from pathlib import Path
import random
import re
import sqlite3
import statistics
import sys
import threading
import time
from types import SimpleNamespace
from urllib.parse import urljoin, urlsplit
import xml.etree.ElementTree as ET

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from shared import lyrics as production

PROVIDERS = ("lrclib", "lrc_red", "better_ttml", "better_qq", "better_kugou", "unison", "bini_legacy")
SEED = "soundsible-lyrics-2026-11-15"
MAX_BODY = 4 * 1024 * 1024
LOCAL = threading.local()


def utc():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def snapshot(database, output, limit, seed):
    """Mirror collection.snapshot's membership and file-first metadata, read-only."""
    conn = sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    conn.execute("BEGIN")
    try:
        items = conn.execute('''SELECT i.id,i.snapshot,i.saved FROM collection_items i
            WHERE i.saved=1 OR EXISTS(SELECT 1 FROM collection_files f WHERE f.item_id=i.id)
            OR EXISTS(SELECT 1 FROM playlist_tracks p WHERE p.track_id=i.id)''').fetchall()
        files = {}
        for row in conn.execute('''SELECT f.item_id,t.* FROM tracks t JOIN library_tracks l ON l.track_id=t.id
            JOIN collection_files f ON f.file_id=t.id ORDER BY l.position'''):
            files.setdefault(row["item_id"], dict(row))
        videos = {}
        for item, video in conn.execute("SELECT item_id,source_id FROM collection_sources WHERE kind='youtube' ORDER BY rowid"):
            videos.setdefault(item, video)
        population, excluded = [], Counter()
        for item in items:
            row = files.get(item["id"], json.loads(item["snapshot"]))
            if row.get("media_kind") == "podcast_episode" or row.get("podcast_feed_id"):
                excluded["podcast"] += 1
                continue
            if not row.get("artist") or not row.get("title"):
                excluded["missing_artist_or_title"] += 1
                continue
            artist, title = production._canonical_metadata(row["artist"], row["title"])
            raw_isrc = re.sub(r"[\s-]", "", str(row.get("isrc") or "")).upper()
            population.append({
                "artist": row["artist"], "title": row["title"], "album": row.get("album") or "",
                "duration": row.get("duration") or None, "query_artist": artist, "query_title": title,
                "isrc": raw_isrc if re.fullmatch(r"[A-Z]{2}[A-Z0-9]{3}\d{7}", raw_isrc) else None,
                "youtube_id": row.get("youtube_id") or videos.get(item["id"]),
                "context": "file" if item["id"] in files else "saved_or_playlist",
            })
    finally:
        conn.close()
    # Proportional strata retain the library's source/album/ISRC composition.
    # Within a stratum, deterministic random selection avoids alphabetical bias.
    population.sort(key=lambda row: json.dumps(row, sort_keys=True, ensure_ascii=False))
    population_hash = digest(json.dumps(population, sort_keys=True, ensure_ascii=False))
    strata = defaultdict(list)
    for row in population:
        strata[(row["context"], bool(row["album"]), bool(row["isrc"]))].append(row)
    size = min(limit, len(population))
    quotas = {key: int(len(rows) * size / len(population)) for key, rows in strata.items()} if population else {}
    remainder = size - sum(quotas.values())
    for key in sorted(strata, key=lambda key: (-(len(strata[key]) * size / len(population) - quotas[key]), key))[:remainder]:
        quotas[key] += 1
    selected = []
    strata_info = []
    for key, rows in sorted(strata.items()):
        random.Random(seed + repr(key)).shuffle(rows)
        selected.extend(rows[:quotas[key]])
        strata_info.append({"context": key[0], "album": key[1], "isrc": key[2], "population": len(rows), "sample": quotas[key]})
    random.Random(seed).shuffle(selected)
    for index, row in enumerate(selected, 1):
        row["sample_id"] = f"m{index:04d}"
    value = {"captured_at": utc(), "seed": seed, "membership": "collection.snapshot", "collection_rows": len(items),
             "population": len(population), "excluded": dict(excluded), "sample_size": size, "strata": strata_info,
             "population_sha256": population_hash,
             "population_artists": len({row["artist"] for row in population}),
             "sample_artists": len({row["artist"] for row in selected}), "tracks": selected}
    Path(output).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value[key] for key in ("collection_rows", "population", "sample_size", "sample_artists", "strata")}))


def stamp(value):
    if value is None:
        return None
    text = str(value).strip()
    if text.endswith("ms"):
        return float(text[:-2]) / 1000
    if text.endswith("s"):
        text = text[:-1]
    parts = text.split(":")
    if len(parts) > 3:
        raise ValueError("Unsupported timestamp")
    result = sum(float(part) * 60 ** power for power, part in enumerate(reversed(parts)))
    if not math.isfinite(result) or result < 0:
        raise ValueError("Invalid timestamp")
    return result


def parse_text(body, kind):
    """Measure actual supplied timing; never interpolate word timings."""
    lines, words, text, document_duration = [], 0, [], None
    if kind == "qrc" and not body.lstrip().startswith("<"):
        # QQ also returns plain LRC for some instrumental / untimed entries.
        return parse_text(body, "lrc")
    if kind == "ttml":
        if "<!DOCTYPE" in body.upper() or "<!ENTITY" in body.upper():
            raise ValueError("Unsafe XML declaration")
        root = ET.fromstring(body)
        for element in root.iter():
            tag = element.tag.rsplit("}", 1)[-1]
            if tag == "body" and element.get("dur"):
                document_duration = stamp(element.get("dur"))
            if tag != "p":
                continue
            content = "".join(element.itertext()).strip()
            if not content:
                continue
            text.append(content)
            start, end = stamp(element.get("begin")), stamp(element.get("end"))
            if start is not None and (end is None or end >= start):
                lines.append((start, end))
            segments = []
            for child in element.iter():
                if child.tag.rsplit("}", 1)[-1] == "span" and child.get("begin") and child.get("end"):
                    begin, finish = stamp(child.get("begin")), stamp(child.get("end"))
                    if finish > begin and "".join(child.itertext()).strip():
                        segments.append((begin, finish))
            if len(set(segments)) >= 2:
                words += len(set(segments))
    elif kind == "qrc":
        # QRC contains line-start/length pairs and word-start/length pairs in ms.
        root = ET.fromstring(body)
        content = "\n".join(element.get("LyricContent", "") for element in root.iter())
        # XML normalizes literal attribute newlines into spaces. Bound a line
        # by the next timestamp instead of relying on those newlines surviving.
        for match in re.finditer(r"\[(\d+),(\d+)\]([\s\S]*?)(?=\[\d+,\d+\]|$)", content):
            line = match[3]
            starts = re.findall(r"\((\d+),(\d+)\)", line)
            text.append(re.sub(r"\(\d+,\d+\)", "", line))
            lines.append((int(match[1]) / 1000, (int(match[1]) + int(match[2])) / 1000))
            if len(starts) >= 2:
                words += sum(int(length) > 0 for _, length in starts)
    elif kind == "lrc":
        for raw in body.splitlines():
            matches = list(re.finditer(r"\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]", raw))
            if not matches:
                if not re.match(r"^\[[a-z]+:", raw, re.I):
                    text.append(raw)
                continue
            content = raw[matches[-1].end():].strip()
            if not content:
                continue
            segments = re.findall(r"<(\d{1,3}:\d{2}(?:\.\d+)?)>", content)
            words += len(segments) if len(segments) >= 2 else 0
            text.append(re.sub(r"<\d[^>]+>", "", content))
            for match in matches:
                value = match[1]
                if value.count(":") == 2:
                    left, right = value.rsplit(":", 1)
                    value = left + "." + right
                lines.append((stamp(value), None))
    else:
        text = body.splitlines()
    normalized = production._fold(" ".join(text))
    instrumental = "此歌曲为没有填词的纯音乐" in body
    return {"format": kind, "sync": "word_or_syllable" if words else "line" if lines else "plain" if normalized else "empty",
            "timed_lines": len(lines), "timed_segments": words, "text_chars": len(normalized),
            "text_sha256": digest(normalized), "last_start_sec": max((a for a, _ in lines), default=None),
            "document_duration": document_duration, "instrumental_notice": instrumental}, set(normalized.split())


def candidate_evidence(track, candidate):
    """Song identity and recording duration are separate evidence."""
    artist = candidate.get("artist") or candidate.get("artistName") or candidate.get("artist_name") or ""
    title = candidate.get("title") or candidate.get("trackName") or candidate.get("track_name") or candidate.get("song") or ""
    if isinstance(artist, dict):
        artist = artist.get("name", "")
    duration = candidate.get("duration")
    if duration is not None:
        duration = float(duration)
    same_isrc = bool(track.get("isrc") and track["isrc"] == candidate.get("isrc"))
    title_score = production._similarity(track["query_title"], title)
    artist_score = production._similarity(track["query_artist"], artist)
    version_match = production._version_tokens(track["query_title"]) == production._version_tokens(title)
    identity = "matched" if same_isrc or (title_score >= .8 and artist_score >= .72 and version_match) else "mismatch" if title or artist else "unverified"
    delta = abs(duration - track["duration"]) if duration and track.get("duration") else None
    return {"identity": identity, "candidate_title": title or None, "candidate_artist": artist or None,
            "candidate_duration": duration, "duration_delta_sec": delta, "duration_compatible": delta <= 3 if delta is not None else None,
            "title_similarity": round(title_score, 4), "artist_similarity": round(artist_score, 4), "version_match": version_match}


def timing_evidence(track, row):
    """Recompute gates from primitive observations, not document length guesses.

    A TTML body may stop before an instrumental coda. Its duration is not a
    certified recording duration. A line starting after the audio ends is a
    concrete conflict, as is a different provider-reported recording length.
    """
    audio, candidate = track.get("duration"), row.get("candidate_duration")
    compatible = abs(audio - candidate) <= 3 if audio and candidate else None
    if audio and row.get("last_start_sec") is not None and row["last_start_sec"] > audio + 3:
        compatible = False
    eligible = (row.get("status") == "returned" and not row.get("instrumental_notice")
                and row.get("sync") in {"line", "word_or_syllable"} and row.get("identity") != "mismatch" and compatible is not False)
    return {"duration_compatible": compatible, "eligible_timed": eligible,
            "identity_verified_timed": eligible and row.get("identity") == "matched"}


class HTTP:
    """One in-flight request per host, pacing, bounded responses and traces."""
    def __init__(self, user_agent, interval=.6, timeout=10):
        self.user_agent, self.interval, self.timeout = user_agent, interval, timeout
        self.locks, self.next = defaultdict(threading.Lock), defaultdict(float)

    def get(self, url, params=None, timeout=None, headers=None, **kwargs):
        for redirect in range(4):
            host = urlsplit(url).netloc
            if host not in {"lrclib.net", "api.deezer.com", "lrc.red", "lyrics-api.binimum.org", "api.betterlyrics.org", "unison.betterlyrics.org", "api.spicylyrics.org"}:
                raise ValueError("Unexpected response origin")
            queued = time.perf_counter()
            with self.locks[host]:
                time.sleep(max(0, self.next[host] - time.monotonic()))
                pace_ms = (time.perf_counter() - queued) * 1000
                self.next[host] = time.monotonic() + self.interval
                started = time.perf_counter()
                trace = {"host": host, "path": urlsplit(url).path, "started_at": utc(), "pacing_ms": round(pace_ms, 3)}
                try:
                    response = requests.get(url, params=params, headers={**(headers or {}), "User-Agent": self.user_agent},
                                            timeout=timeout or (3, self.timeout), allow_redirects=False, stream=True)
                    try:
                        content = bytearray()
                        for chunk in response.iter_content(65536):
                            content.extend(chunk)
                            if len(content) > MAX_BODY:
                                raise ValueError("Response over 4 MiB")
                        response._content = bytes(content)
                        response._content_consumed = True
                        trace.update(status=response.status_code, bytes=len(content), body_sha256=hashlib.sha256(content).hexdigest(),
                                     cache=response.headers.get("X-Cache-Status"), auth=response.headers.get("X-Auth-Mode"),
                                     retry_after=response.headers.get("Retry-After"), content_type=response.headers.get("Content-Type"))
                    finally:
                        response.close()
                except (requests.RequestException, ValueError) as exc:
                    trace.update(error=type(exc).__name__, status=0, bytes=0)
                    raise
                finally:
                    trace["http_ms"] = round((time.perf_counter() - started) * 1000, 3)
                    LOCAL.traces.append(trace)
            if response.status_code in {301, 302, 303, 307, 308}:
                url, params = urljoin(url, response.headers["Location"]), None
                continue
            # Only the production resolver consumes these; never persist payloads.
            if host == "lrclib.net" and response.ok:
                LOCAL.lrclib_payloads.append(response.json())
            return response
        raise ValueError("Too many redirects")

    def fetch(self, url, params=None):
        response = self.get(url, params=params)
        if response.status_code in {429, 503}:
            try:
                wait = float(response.headers.get("Retry-After", 1))
            except ValueError:
                # An HTTP-date or unrecognized hint must not be shortened to
                # a one-second retry. Leave the error in the measured result.
                wait = math.inf
            if 0 <= wait <= 3:
                time.sleep(wait)
                response = self.get(url, params=params)
        if response.status_code in {401, 403}:
            raise LookupError("access_denied")
        if response.status_code == 404:
            raise LookupError("not_found")
        response.raise_for_status()
        return response


def lookup(provider, track, http):
    """Return parsed evidence and transient text tokens, not complete lyrics."""
    artist, title = track["query_artist"], track["query_title"]
    album, duration = track["album"], track["duration"]
    candidate, flags = {}, {}
    if provider == "lrclib":
        record = production.fetch_lyrics(track["artist"], track["title"], album or None, duration)
        if record is None:
            raise LookupError("provider_error")
        if record.get("instrumental"):
            return {"status": "instrumental", "sync": "empty"}, set()
        body, kind = (record.get("synced"), "lrc") if record.get("synced") else (record.get("plain"), "plain")
        if not body:
            raise LookupError("not_found")
        for payload in reversed(LOCAL.lrclib_payloads):
            for row in payload if isinstance(payload, list) else []:
                if row.get("syncedLyrics") == body or row.get("plainLyrics") == body:
                    candidate = {**row, "duration": record.get("synced_duration") or row.get("duration")}
                    break
            if candidate:
                break
    elif provider in {"lrc_red", "bini_legacy"}:
        if provider == "lrc_red" and track.get("isrc"):
            isrc = track["isrc"]
            candidate = {"isrc": isrc}
        else:
            if provider == "lrc_red":
                data = http.fetch("https://lrc.red/search.json", {"q": f"{title} {artist}"}).json()
                rows = data.get("hits", [])
                flags["search_has_next_page"] = bool(data.get("next"))
            else:
                data = http.fetch("https://lyrics-api.binimum.org/", {"track": title, "artist": artist, "album": album, "duration": duration or ""}).json()
                rows = data.get("results", [])
            if not rows:
                raise LookupError("not_found")
            def score(row):
                evidence = candidate_evidence(track, row)
                return (evidence["identity"] == "matched", evidence["duration_compatible"] is not False,
                        evidence["title_similarity"] + evidence["artist_similarity"])
            candidate = max(rows, key=score)
            if candidate_evidence(track, candidate)["identity"] != "matched":
                return {"status": "candidate_mismatch", **candidate_evidence(track, candidate), **flags}, set()
            isrc = candidate.get("isrc") or candidate.get("id")
        # Combined JSON carries source TTML, identity, duration and byModel in one read.
        # No additional lyric download is needed after this request.
        data = http.fetch(f"https://lrc.red/s/{isrc}.song.json").json()
        candidate = {**data, "isrc": isrc}
        flags["by_model"] = data.get("byModel")
        body, kind = data.get("source") or "", "ttml"
        if not body:
            raise LookupError("no_ttml_body")
    elif provider.startswith("better_"):
        path = {"better_ttml": "/getLyrics", "better_qq": "/qq/getLyrics", "better_kugou": "/kugou/getLyrics"}[provider]
        data = http.fetch("https://api.betterlyrics.org" + path, {"s": title, "a": artist, "al": album, "d": str(round(duration)) if duration else ""}).json()
        body = data.get("ttml") or data.get("lyrics") or ""
        kind = {"better_ttml": "ttml", "better_qq": "qrc", "better_kugou": "lrc"}[provider]
        flags["provider_score"] = data.get("score")
    else:
        params = {"song": title, "artist": artist, "album": album, "duration": duration or ""}
        if track.get("youtube_id"):
            params["v"] = track["youtube_id"]
        if track.get("isrc"):
            params["isrc"] = track["isrc"]
        data = http.fetch("https://unison.betterlyrics.org/lyrics", params).json()
        if not data.get("success") or not data.get("data"):
            raise LookupError("not_found")
        candidate = data["data"]
        body, kind = candidate.get("lyrics", ""), candidate.get("format", "plain")
        flags["matched_by"] = candidate.get("matchedBy")
    if not isinstance(body, str) or not body.strip():
        raise LookupError("empty_response")
    start_cpu = time.thread_time()
    parsed, tokens = parse_text(body, kind)
    parsed["parse_cpu_ms"] = round((time.thread_time() - start_cpu) * 1000, 4)
    evidence = candidate_evidence(track, candidate)
    parsed.update(status="returned", **evidence, **flags)
    parsed.update(timing_evidence(track, parsed))
    return parsed, tokens


def measure(provider, track, http):
    LOCAL.traces, LOCAL.lrclib_payloads = [], []
    start = time.perf_counter()
    start_cpu = time.thread_time()
    result = {"sample_id": track["sample_id"], "provider": provider, "started_at": utc()}
    tokens = set()
    try:
        data, tokens = lookup(provider, track, http)
        result.update(data)
    except LookupError as exc:
        result["status"] = str(exc)
    except requests.RequestException as exc:
        result.update(status="network_or_http_error", error_type=type(exc).__name__)
    except (ValueError, TypeError, KeyError, ET.ParseError) as exc:
        result.update(status="parse_or_contract_error", error_type=type(exc).__name__)
    result.update(finished_at=utc(), lookup_ms=round((time.perf_counter() - start) * 1000, 3), requests=LOCAL.traces)
    result["lookup_cpu_ms"] = round((time.thread_time() - start_cpu) * 1000, 4)
    result["http_ms"] = round(sum(row["http_ms"] for row in LOCAL.traces), 3)
    result["pacing_ms"] = round(sum(row["pacing_ms"] for row in LOCAL.traces), 3)
    result["active_ms"] = round(max(0, result["lookup_ms"] - result["pacing_ms"]), 3)
    result["body_bytes"] = sum(row["bytes"] for row in LOCAL.traces)
    LOCAL.lrclib_payloads = []
    return result, tokens


def run(args):
    manifest = json.loads(Path(args.sample).read_text())
    output = Path(args.output)
    existing = [json.loads(line) for line in output.read_text().splitlines()] if output.exists() else []
    done = {(row["sample_id"], row["provider"]) for row in existing}
    http = HTTP(args.user_agent, args.interval, args.timeout)
    # Only this module's dependency is replaced; requests itself is never patched.
    production.requests = SimpleNamespace(get=http.get, RequestException=requests.RequestException)
    logging.getLogger("shared.lyrics").setLevel(logging.CRITICAL)
    config = {"sample_sha256": digest(Path(args.sample).read_text()), "providers": list(PROVIDERS),
              "interval_sec": args.interval, "timeout_sec": args.timeout, "workers": args.workers,
              "max_response_bytes": MAX_BODY, "max_generic_attempts": 2, "seed": manifest["seed"]}
    config_path = output.with_suffix(".config.json")
    if config_path.exists() and json.loads(config_path.read_text()) != config:
        raise ValueError("Resume configuration differs")
    config_path.write_text(json.dumps(config, indent=2) + "\n")

    def track_run(track):
        order = list(PROVIDERS)
        random.Random(manifest["seed"] + track["sample_id"]).shuffle(order)
        rows, texts = [], {}
        for provider in order:
            if (track["sample_id"], provider) in done:
                continue
            row, tokens = measure(provider, track, http)
            rows.append(row)
            texts[provider] = tokens
        reference = texts.get("lrclib", set())
        for row in rows:
            tokens = texts[row["provider"]]
            if reference and tokens:
                row["text_token_jaccard_to_lrclib"] = round(len(reference & tokens) / len(reference | tokens), 4)
        return rows

    completed = len(done)
    with output.open("a") as handle, ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(track_run, track) for track in manifest["tracks"] if any((track["sample_id"], p) not in done for p in PROVIDERS)]
        for future in as_completed(futures):
            rows = future.result()
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            completed += len(rows)
            print(json.dumps({"completed": completed, "total": len(manifest["tracks"]) * len(PROVIDERS),
                              "track": rows[0]["sample_id"] if rows else None,
                              "results": {row["provider"]: row["status"] + ":" + row.get("sync", "") for row in rows}}), flush=True)


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def validate(args):
    """Recheck QQ parsing and test Unison's independent metadata lookup route.

    Preserve the first-pass records. A parsing correction can be applied to the
    summary only when the HTTP body digest is identical on the recheck.
    """
    manifest = json.loads(Path(args.sample).read_text())
    tracks = {track["sample_id"]: track for track in manifest["tracks"]}
    initial = [json.loads(line) for line in Path(args.results).read_text().splitlines()]
    output = Path(args.output)
    done = {(row["sample_id"], row["validation"]) for row in
            ([json.loads(line) for line in output.read_text().splitlines()] if output.exists() else [])}
    http = HTTP(args.user_agent)
    with output.open("a") as handle:
        for row in initial:
            purpose = ("qq_parser" if row["provider"] == "better_qq" and row["status"] in {"returned", "parse_or_contract_error"}
                       else "unison_metadata" if row["provider"] == "unison" and row["status"] == "not_found" else None)
            if not purpose or (row["sample_id"], purpose) in done:
                continue
            track = dict(tracks[row["sample_id"]])
            if purpose == "unison_metadata":
                track.pop("youtube_id", None)
            value, _ = measure(row["provider"], track, http)
            value["validation"] = purpose
            value["original_body_identical"] = bool(row["requests"] and value["requests"] and
                row["requests"][-1].get("body_sha256") == value["requests"][-1].get("body_sha256"))
            handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            print(json.dumps({"sample_id": row["sample_id"], "validation": purpose, "status": value["status"],
                              "body_identical": value["original_body_identical"]}), flush=True)


def summarize(sample, result_path, output, validation_path=None):
    manifest = json.loads(Path(sample).read_text())
    rows = [json.loads(line) for line in Path(result_path).read_text().splitlines()]
    pairs = {(row["sample_id"], row["provider"]) for row in rows}
    expected = {(track["sample_id"], provider) for track in manifest["tracks"] for provider in PROVIDERS}
    if len(pairs) != len(rows) or pairs != expected:
        raise ValueError("Incomplete or duplicate paired matrix")
    validation = [json.loads(line) for line in Path(validation_path).read_text().splitlines()] if validation_path else []
    if validation_path:
        expected_validation = {(row["sample_id"], "qq_parser") for row in rows
                               if row["provider"] == "better_qq" and row["status"] in {"returned", "parse_or_contract_error"}}
        expected_validation |= {(row["sample_id"], "unison_metadata") for row in rows
                                if row["provider"] == "unison" and row["status"] == "not_found"}
        actual_validation = {(row["sample_id"], row["validation"]) for row in validation}
        if actual_validation != expected_validation or len(validation) != len(actual_validation):
            raise ValueError("Incomplete or duplicate validation matrix")
    corrected = []
    for value in validation:
        if value["validation"] != "qq_parser" or not value["original_body_identical"]:
            continue
        original = next(row for row in rows if row["sample_id"] == value["sample_id"] and row["provider"] == value["provider"])
        # Network observations stay untouched. Only parsing-derived evidence is
        # replaced; CPU summaries below retain first-pass cost measurements.
        for key in ("status", "sync", "format", "timed_lines", "timed_segments", "text_chars", "text_sha256", "last_start_sec",
                    "document_duration", "instrumental_notice", "eligible_timed", "identity_verified_timed", "duration_compatible"):
            if key in value:
                original[key] = value[key]
        # The initial token set included QRC line timestamp text. The original
        # lyric tokens are deliberately not retained, so do not reuse that score.
        original.pop("text_token_jaccard_to_lrclib", None)
        corrected.append(value["sample_id"])
    tracks = {track["sample_id"]: track for track in manifest["tracks"]}
    for row in rows:
        row.update(timing_evidence(tracks[row["sample_id"]], row))
    stats = {}
    lrclib_timed = {row["sample_id"] for row in rows if row["provider"] == "lrclib" and row.get("eligible_timed")}
    for provider in PROVIDERS:
        group = [row for row in rows if row["provider"] == provider]
        stats[provider] = {
            "queries": len(group), "statuses": dict(Counter(row["status"] for row in group)),
            "sync": dict(Counter(row.get("sync", "none") for row in group)),
            "returned_timed": sum(row.get("sync") in {"line", "word_or_syllable"} and not row.get("instrumental_notice") for row in group),
            "returned_word_or_syllable": sum(row.get("sync") == "word_or_syllable" for row in group),
            "instrumental_notices": sum(bool(row.get("instrumental_notice")) for row in group),
            "eligible_timed": sum(bool(row.get("eligible_timed")) for row in group),
            "identity_verified_timed": sum(bool(row.get("identity_verified_timed")) for row in group),
            "eligible_word_or_syllable": sum(bool(row.get("eligible_timed")) and row.get("sync") == "word_or_syllable" for row in group),
            "requests": sum(len(row["requests"]) for row in group),
            "body_bytes": sum(row["body_bytes"] for row in group),
            "http_statuses": dict(Counter(str(req["status"]) for row in group for req in row["requests"])),
            "active_p50_ms": percentile([row["active_ms"] for row in group], .5),
            "active_p95_ms": percentile([row["active_ms"] for row in group], .95),
            "parse_cpu_p50_ms": percentile([row["parse_cpu_ms"] for row in group if "parse_cpu_ms" in row], .5),
            "parse_cpu_p95_ms": percentile([row["parse_cpu_ms"] for row in group if "parse_cpu_ms" in row], .95),
            "lookup_cpu_p50_ms": percentile([row["lookup_cpu_ms"] for row in group], .5),
            "lookup_cpu_p95_ms": percentile([row["lookup_cpu_ms"] for row in group], .95),
            "duration_conflicts": sum(row.get("duration_compatible") is False for row in group),
            "identity_conflicts": sum(row.get("identity") == "mismatch" or row["status"] == "candidate_mismatch" for row in group),
            "unverified_timed": sum(bool(row.get("eligible_timed")) and row.get("identity") == "unverified" for row in group),
            "model_flagged_returns": sum(row.get("by_model") is True for row in group),
            "model_flagged_eligible_timed": sum(row.get("by_model") is True and bool(row.get("eligible_timed")) for row in group),
            "model_flagged_eligible_word_or_syllable": sum(row.get("by_model") is True and bool(row.get("eligible_timed")) and row.get("sync") == "word_or_syllable" for row in group),
            "additional_timed_vs_lrclib": sum(bool(row.get("eligible_timed")) and row["sample_id"] not in lrclib_timed for row in group),
            "low_text_agreement_to_lrclib": sum(row.get("eligible_timed", False) and row.get("text_token_jaccard_to_lrclib", 1) < .5 for row in group),
            "text_agreement_available": sum("text_token_jaccard_to_lrclib" in row for row in group),
            "by_context": {
                context: {"queries": sum(tracks[row["sample_id"]]["context"] == context for row in group),
                          "eligible_timed": sum(bool(row.get("eligible_timed")) and tracks[row["sample_id"]]["context"] == context for row in group)}
                for context in sorted({track["context"] for track in manifest["tracks"]})
            },
            "by_album": {
                str(present).lower(): {"queries": sum(bool(tracks[row["sample_id"]]["album"]) == present for row in group),
                                      "eligible_timed": sum(bool(row.get("eligible_timed")) and bool(tracks[row["sample_id"]]["album"]) == present for row in group)}
                for present in (False, True)
            },
        }
    chains = []
    by_pair = {(row["sample_id"], row["provider"]): row for row in rows}
    for chain in [("lrc_red", "lrclib"), ("lrclib", "lrc_red"), ("better_ttml", "lrclib"), ("unison", "lrc_red", "lrclib"),
                  ("lrc_red", "better_ttml", "better_qq", "better_kugou", "unison", "lrclib")]:
        successes, words, calls, durations = 0, 0, [], []
        for track in manifest["tracks"]:
            cost, elapsed = 0, 0
            for provider in chain:
                row = by_pair[(track["sample_id"], provider)]
                cost += len(row["requests"])
                elapsed += row["active_ms"]
                if row.get("eligible_timed"):
                    successes += 1
                    words += row.get("sync") == "word_or_syllable"
                    break
            calls.append(cost)
            durations.append(elapsed)
        chains.append({"order": list(chain), "eligible_timed": successes, "word_or_syllable": words,
                       "simulated_mean_requests": statistics.mean(calls), "simulated_active_p50_ms": percentile(durations, .5),
                       "simulated_active_p95_ms": percentile(durations, .95)})
    value = {"sample_size": manifest["sample_size"], "rows": len(rows), "started_at": min(row["started_at"] for row in rows),
             "finished_at": max(row["finished_at"] for row in rows), "providers": stats, "simulated_first_timed_chains": chains,
             "qq_identical_body_parser_rechecks": corrected,
             "unison_metadata_validation": {"queries": sum(row["validation"] == "unison_metadata" for row in validation),
                  "statuses": dict(Counter(row["status"] for row in validation if row["validation"] == "unison_metadata")),
                  "eligible_timed": sum(bool(row.get("eligible_timed")) for row in validation if row["validation"] == "unison_metadata")}}
    Path(output).write_text(json.dumps(value, indent=2) + "\n")
    write_chart(value, Path(output).with_suffix(".svg"))
    print(json.dumps(value, indent=2))


def write_chart(summary, path):
    """Standalone SVG from the archived summary; no browser/server required."""
    labels = {"lrclib": "LRCLIB (current resolver)", "lrc_red": "lrc.red (direct)",
              "better_ttml": "Better Lyrics TTML *", "better_qq": "Better Lyrics QQ *",
              "better_kugou": "Better Lyrics Kugou *", "unison": "Unison (video first)",
              "bini_legacy": "Bini legacy → lrc.red"}
    total = summary["sample_size"]
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 550" role="img" aria-labelledby="title desc">',
           f'<title id="title">Timed lyrics returned for {total} collection items</title>',
           '<desc id="desc">Outline: timed response. Colored bars: no hard metadata or timing conflict. Purple: actual word or syllable timestamps. An asterisk means candidate identity is unavailable.</desc>',
           '<rect width="1000" height="550" fill="white"/>',
           '<style>text{font-family:system-ui,sans-serif;fill:#334155;font-size:15px}.small{font-size:13px}</style>',
           f'<text x="10" y="28" font-size="21" font-weight="600">Timed lyrics · {total} paired music items</text>']
    for tick in range(0, 101, 20):
        x = 270 + tick * 5.4
        svg.append(f'<line x1="{x}" y1="58" x2="{x}" y2="432" stroke="#CBD5E1" stroke-dasharray="3 5"/>')
        svg.append(f'<text class="small" x="{x}" y="452" text-anchor="middle">{tick}%</text>')
    for index, (provider, label) in enumerate(labels.items()):
        value = summary["providers"][provider]
        y = 76 + index * 51
        timed, rich, returned = value["eligible_timed"], value["eligible_word_or_syllable"], value["returned_timed"]
        x, width = 270, 540 / total
        svg.extend([
            f'<text x="10" y="{y + 20}">{html.escape(label)}</text>',
            f'<rect x="{x}" y="{y}" width="{returned * width:.2f}" height="28" fill="none" stroke="#94A3B8" stroke-width="2"/>',
            f'<rect x="{x}" y="{y + 4}" width="{timed * width:.2f}" height="20" fill="#0F766E"/>',
            f'<rect x="{x}" y="{y + 4}" width="{rich * width:.2f}" height="20" fill="#7C3AED"/>',
            f'<text x="835" y="{y + 20}">{timed}/{total} · {100 * timed / total:.1f}%</text>',
        ])
    svg.extend([
        '<rect x="10" y="476" width="18" height="14" fill="none" stroke="#94A3B8"/><text class="small" x="36" y="488">Timed body returned</text>',
        '<rect x="255" y="476" width="18" height="14" fill="#0F766E"/><text class="small" x="281" y="488">Nonconflicting line timing</text>',
        '<rect x="565" y="476" width="18" height="14" fill="#7C3AED"/><text class="small" x="591" y="488">Word/syllable timing included</text>',
        '<text class="small" x="10" y="520">* Candidate identity unavailable. Timed payloads do not establish acoustic alignment.</text>',
        '<text class="small" x="10" y="540">Spicy: authentication required, coverage not measured. Bini is a shared lrc.red route.</text>', '</svg>',
    ])
    Path(path).write_text("\n".join(svg) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    snap = sub.add_parser("snapshot")
    snap.add_argument("--database", required=True)
    snap.add_argument("--output", required=True)
    snap.add_argument("--limit", type=int, default=300)
    snap.add_argument("--seed", default=SEED)
    live = sub.add_parser("run")
    live.add_argument("--sample", required=True)
    live.add_argument("--output", required=True)
    live.add_argument("--user-agent", required=True, help="App name, URL and public contact email")
    live.add_argument("--interval", type=float, default=.6)
    live.add_argument("--timeout", type=float, default=10)
    live.add_argument("--workers", type=int, default=4)
    summary = sub.add_parser("summarize")
    summary.add_argument("--sample", required=True)
    summary.add_argument("--results", required=True)
    summary.add_argument("--output", required=True)
    summary.add_argument("--validation")
    correction = sub.add_parser("validate")
    correction.add_argument("--sample", required=True)
    correction.add_argument("--results", required=True)
    correction.add_argument("--output", required=True)
    correction.add_argument("--user-agent", required=True)
    args = parser.parse_args()
    if args.command == "snapshot":
        if args.limit < 1:
            parser.error("limit must be positive")
        snapshot(args.database, args.output, args.limit, args.seed)
    elif args.command == "run":
        if args.interval < .5 or not 1 <= args.workers <= 4 or not 1 <= args.timeout <= 15:
            parser.error("interval >= .5, workers 1..4, timeout 1..15 required")
        run(args)
    elif args.command == "validate":
        validate(args)
    else:
        summarize(args.sample, args.results, args.output, args.validation)


if __name__ == "__main__":
    main()
