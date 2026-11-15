"""Offline checks for evidence classification, sampling and summary integrity."""
import json
import sqlite3

import pytest

from scripts import benchmark_lyrics_providers as bench


def track(**changes):
    return {"query_title": "Example", "query_artist": "Singer", "duration": 100, "isrc": None, **changes}


def test_ttml_container_does_not_imply_word_timing():
    body = '<tt><body dur="100s"><p begin="10s" end="12s">Example words</p></body></tt>'
    result, _ = bench.parse_text(body, "ttml")
    assert result["sync"] == "line"
    assert result["document_duration"] == 100
    assert result["timed_segments"] == 0


def test_nested_background_word_segments_and_namespaces():
    body = ('<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="1s" end="3s">'
            '<span begin="1s" end="2s">Example </span><span begin="2s" end="3s">words</span>'
            '</p></body></tt>')
    result, tokens = bench.parse_text(body, "ttml")
    assert result["sync"] == "word_or_syllable"
    assert result["timed_segments"] == 2
    assert tokens == {"example", "words"}


def test_one_span_per_line_is_not_word_timing():
    result, _ = bench.parse_text('<tt><p begin="1s"><span begin="1s" end="3s">Example words</span></p></tt>', "ttml")
    assert result["sync"] == "line"


@pytest.mark.parametrize("value", ["-1", "nan", "inf", "1:2:3:4"])
def test_invalid_timestamps(value):
    with pytest.raises(ValueError):
        bench.stamp(value)


def test_unsafe_xml_rejected():
    with pytest.raises(ValueError, match="Unsafe"):
        bench.parse_text('<!DOCTYPE tt [<!ENTITY x "example">]><tt><p>&x;</p></tt>', "ttml")


def test_qrc_real_word_timing():
    result, _ = bench.parse_text('<QrcInfos><Lyric_1 LyricContent="[1000,2000]Example(1000,1000) words(2000,1000)"/></QrcInfos>', "qrc")
    assert result["sync"] == "word_or_syllable"
    assert result["last_start_sec"] == 1


def test_qrc_attribute_newline_normalization_preserves_line_boundaries():
    body = ('<QrcInfos><Lyric_1 LyricContent="[1000,2000]Example(1000,1000) words(2000,1000)\n'
            '[4000,2000]Other(4000,1000) words(5000,1000)"/></QrcInfos>')
    result, _ = bench.parse_text(body, "qrc")
    assert result["timed_lines"] == 2
    assert result["last_start_sec"] == 4


def test_qq_instrumental_lrc_fallback_is_not_xml_error():
    result, _ = bench.parse_text('[00:00:00]此歌曲为没有填词的纯音乐，请您欣赏', "qrc")
    assert result["format"] == "lrc"
    assert result["instrumental_notice"] is True


def test_lrc_fraction_and_repeated_line_stamps():
    result, tokens = bench.parse_text('[ar:Singer]\n[00:01.50][00:04.500]Example words\n[00:06:25]Other words', "lrc")
    assert result["sync"] == "line"
    assert result["timed_lines"] == 3
    assert result["last_start_sec"] == 6.25
    assert "singer" not in tokens


def test_wrong_version_and_wrong_duration_are_separate():
    evidence = bench.candidate_evidence(track(), {"title": "Example", "artist": "Singer", "duration": 120})
    assert evidence["identity"] == "matched"
    assert evidence["duration_compatible"] is False
    assert bench.candidate_evidence(track(), {"title": "Example (Live)", "artist": "Singer"})["identity"] == "mismatch"
    assert bench.candidate_evidence(track(), {})["identity"] == "unverified"


def test_ttml_document_ending_before_coda_is_not_recording_mismatch():
    observation = {"status": "returned", "sync": "word_or_syllable", "identity": "unverified", "document_duration": 80,
                   "candidate_duration": None, "last_start_sec": 78}
    assert bench.timing_evidence(track(), observation)["eligible_timed"] is True
    assert bench.timing_evidence(track(), {**observation, "last_start_sec": 110})["eligible_timed"] is False
    assert bench.timing_evidence(track(), {**observation, "candidate_duration": 110})["eligible_timed"] is False


def test_http_access_error_is_not_a_catalog_miss(monkeypatch):
    class HTTP:
        def fetch(self, *args, **kwargs):
            raise LookupError("access_denied")
    row, _ = bench.measure("better_ttml", {**track(), "sample_id": "m0001", "album": "", "artist": "Singer", "title": "Example"}, HTTP())
    assert row["status"] == "access_denied"
    assert "eligible_timed" not in row


@pytest.mark.parametrize("retry_after,retries", [("1", True), ("60", False), ("Sun, 15 Nov 2026 20:00:00 GMT", False)])
def test_generic_retry_does_not_shorten_server_wait(monkeypatch, retry_after, retries):
    import requests
    http = bench.HTTP("test")
    calls = []
    def get(*args, **kwargs):
        response = requests.Response()
        response.status_code = 429 if not calls else 200
        response.headers['Retry-After'] = retry_after
        calls.append(response)
        return response
    monkeypatch.setattr(http, 'get', get)
    monkeypatch.setattr(bench.time, 'sleep', lambda _: None)
    if retries:
        assert http.fetch('https://lrc.red/search.json').status_code == 200
        assert len(calls) == 2
    else:
        with pytest.raises(requests.HTTPError):
            http.fetch('https://lrc.red/search.json')
        assert len(calls) == 1


def test_read_only_snapshot_matches_collection_membership_and_redacts_paths(tmp_path):
    database = tmp_path / "library.db"
    conn = sqlite3.connect(database)
    conn.executescript('''CREATE TABLE collection_items(id TEXT,snapshot TEXT,saved INT);
        CREATE TABLE tracks(id TEXT,title TEXT,artist TEXT,album TEXT,duration INT,isrc TEXT,youtube_id TEXT,local_path TEXT);
        CREATE TABLE library_tracks(track_id TEXT,position INT);
        CREATE TABLE collection_files(file_id TEXT,item_id TEXT);
        CREATE TABLE collection_sources(item_id TEXT,kind TEXT,source_id TEXT);
        CREATE TABLE playlist_tracks(track_id TEXT);''')
    for index in range(12):
        conn.execute('INSERT INTO collection_items VALUES (?,?,1)', (str(index), json.dumps({"title": f"Example {index}", "artist": "Singer", "duration": 100})))
    conn.execute('INSERT INTO tracks VALUES (?,?,?,?,?,?,?,?)', ('file', 'File title', 'Singer', 'Album', 100, None, None, '/private/music'))
    conn.execute('INSERT INTO collection_files VALUES (?,?)', ('file', '0'))
    conn.execute('INSERT INTO library_tracks VALUES (?,0)', ('file',))
    conn.commit()
    conn.close()
    before = database.read_bytes()
    output = tmp_path / "sample.json"
    bench.snapshot(database, output, 12, "fixed")
    data = json.loads(output.read_text())
    assert data["population"] == data["sample_size"] == 12
    assert "File title" in {row["title"] for row in data["tracks"]}
    assert "/private" not in output.read_text()
    assert "item_id" not in output.read_text()
    assert database.read_bytes() == before


def test_summary_rejects_incomplete_matrix(tmp_path):
    sample = tmp_path / "sample.json"
    sample.write_text(json.dumps({"tracks": [{"sample_id": "m0001"}], "sample_size": 1}))
    results = tmp_path / "results.jsonl"
    results.write_text(json.dumps({"sample_id": "m0001", "provider": "lrclib"}) + '\n')
    with pytest.raises(ValueError, match="Incomplete"):
        bench.summarize(sample, results, tmp_path / "summary.json")


def test_summary_uses_union_not_sum_and_keeps_401_separate(tmp_path):
    sample = tmp_path / "sample.json"
    sample.write_text(json.dumps({"tracks": [{"sample_id": "m0001", "duration": 100, "context": "file", "album": ""}], "sample_size": 1}))
    rows = []
    for provider in bench.PROVIDERS:
        found = provider in {"lrclib", "lrc_red"}
        rows.append({"sample_id": "m0001", "provider": provider, "started_at": "2026-01-01", "finished_at": "2026-01-01",
                     "status": "returned" if found else "access_denied", "sync": "line" if found else "none",
                     "identity": "matched" if found else None, "active_ms": 1, "lookup_cpu_ms": 1, "body_bytes": 10,
                     "requests": [{"status": 200 if found else 401}], "candidate_duration": 100 if found else None})
    results = tmp_path / "results.jsonl"
    results.write_text(''.join(json.dumps(row) + '\n' for row in rows))
    output = tmp_path / "summary.json"
    bench.summarize(sample, results, output)
    value = json.loads(output.read_text())
    assert value["simulated_first_timed_chains"][0]["eligible_timed"] == 1
    assert value["providers"]["better_ttml"]["statuses"] == {"access_denied": 1}
    assert value["providers"]["lrc_red"]["additional_timed_vs_lrclib"] == 0
    validation = tmp_path / "validation.jsonl"
    validation.write_text(json.dumps({"sample_id": "m9999", "validation": "qq_parser"}) + '\n')
    with pytest.raises(ValueError, match="validation matrix"):
        bench.summarize(sample, results, output, validation)
