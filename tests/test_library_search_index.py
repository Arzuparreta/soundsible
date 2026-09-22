"""Indexed local search returns exactly what scanning the model returns."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import inspect
from pathlib import Path
import random
import runpy
import subprocess
import sys
from types import FunctionType, SimpleNamespace

from flask import Flask
import pytest

from shared import database, library_search, text_utils
from shared.database import DatabaseManager
from shared.models import LibraryMetadata, Track
from shared.text_utils import fold_text, match_tokens

_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("catalog_search_index_under_test", _ROOT / "shared/api/routes/catalog.py")
catalog = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = catalog
_SPEC.loader.exec_module(catalog)
# The frozen pre-optimization selector, bound to the current ranking helpers.
_FROZEN = runpy.run_path(str(_ROOT / "tests/fixtures/local_catalog_reference.py"))["_local_catalog"]
reference_selector = FunctionType(_FROZEN.__code__, vars(catalog))

_WORDS = [
    "In Rainbows", "rainbows", "Nude", "Rosalía", "ROSALIA", "Malamente (Official Video)",
    "Straße", "STRASSE", "İstanbul", "istanbul", "東京", "Ñandú", "e\u0301clair", "éclair",
    "a_b", "a b", "foo-bar", "Live", "Live (Remastered 2011)", "[HD] Live", "!!!", "x\x00y",
    "😀 Smile", "ǅemal", "ﬁne", "Ⅻ", "Café del Mar", "cafe", "ß", "ss", "  spaced   out  ",
]


def _track(track_id, title, artist, album, album_artist=None):
    return Track(
        id=track_id, title=title, artist=artist, album=album, album_artist=album_artist,
        duration=180, file_hash=f"hash-{track_id}", original_filename=f"{track_id}.mp3",
        compressed=False, file_size=1000, bitrate=320, format="mp3",
    )


def _value(rng):
    roll = rng.random()
    if roll < 0.08:
        return None
    if roll < 0.16:
        return ""
    return " ".join(rng.choice(_WORDS) for _ in range(rng.randint(1, 3)))


def _random_library(seed, size=250):
    rng = random.Random(seed)
    tracks = []
    for i in range(size):
        artist = _value(rng)
        album_artist = _value(rng) if not artist or rng.random() < 0.2 else None
        tracks.append(_track(f"{rng.randrange(10**6):06}-{i}", _value(rng), artist, _value(rng), album_artist))
    # Identical metadata ties on score; the id and library order break them.
    tracks[1].title, tracks[1].artist, tracks[1].album = tracks[0].title, tracks[0].artist, tracks[0].album
    return LibraryMetadata(1, tracks, {}, {})


def _base(count=40):
    names = ["Radiohead", "Rosalía", "Nine Inch Nails", "Ra Ra Riot", ""]
    tracks = [
        _track(str(i), f"Song {i}" if i % 3 else f"Radio {i}", names[i % 5], f"Album {i // 4}",
               "Various" if names[i % 5] == "" else None)
        for i in range(count)
    ]
    return LibraryMetadata(1, tracks, {}, {})


def _queries(metadata, rng, count=40):
    fields = [value for track in metadata.tracks
              for value in (track.title, track.artist, track.album, track.album_artist) if value]
    queries = ["", "\u0301", "!!", "zzqx", "ra", "ss", "rainbows in", "IN RAINBOWS", "rosalia", "istanbul", "x\x00y"]
    for _ in range(count):
        value = rng.choice(fields)
        start = rng.randrange(len(value))
        queries.append(value[start:rng.randrange(start, len(value) + 1)])
        tokens = match_tokens(value)
        if len(tokens) > 1:
            queries.append(" ".join(reversed(tokens)))
    return queries


def _state(db):
    with db._get_connection() as conn:
        return tuple(conn.execute("SELECT valid, version FROM library_search_state").fetchone())


def _execute(db, statement):
    with db._get_connection() as conn:
        conn.execute(statement)


class _Search:
    """Runs the same query through the index, the scan and the frozen reference."""

    def __init__(self, monkeypatch, db, metadata):
        self.monkeypatch = monkeypatch
        self.db = db
        self.metadata = metadata
        self.used = []
        original = library_search.candidates

        def spy(*args):
            rows = original(*args)
            self.used.append(rows is not None)
            return rows

        monkeypatch.setattr(library_search, "candidates", spy)

    def _run(self, function, tracks, query):
        self.monkeypatch.setattr(catalog, "_library_tracks", lambda: tracks)
        return function(query, 30)

    def indexed_tracks(self):
        tracks = catalog._LibraryTracks(self.metadata.tracks)
        tracks.search_db = self.db
        return tracks

    def indexed(self, query):
        return self._run(catalog._local_catalog, self.indexed_tracks(), query)

    def scanned(self, query):
        return self._run(catalog._local_catalog, list(self.metadata.tracks), query)

    def reference(self, query):
        return self._run(reference_selector, list(self.metadata.tracks), query)

    def check(self, query, *, index):
        before = len(self.used)
        actual = self.indexed(query)
        assert actual == self.reference(query) == self.scanned(query), query
        # An empty folded query never needs candidates.
        assert self.used[before:] == ([index] if fold_text(query) else []), query
        return actual


@pytest.fixture
def library(tmp_path, monkeypatch):
    def build(metadata):
        db = DatabaseManager(str(tmp_path / "library.db"))
        db.replace_library(metadata)
        return _Search(monkeypatch, db, metadata)
    return build


@pytest.fixture
def folds(monkeypatch):
    calls = []
    original = library_search.search_row

    def counted(*row):
        calls.append(row[0])
        return original(*row)

    monkeypatch.setattr(library_search, "search_row", counted)
    return calls


@pytest.mark.parametrize("seed", range(4))
def test_indexed_search_equals_a_full_scan_on_randomized_libraries(library, seed):
    rng = random.Random(seed)
    search = library(_random_library(seed))
    assert _state(search.db) == (1, library_search.VERSION)
    for query in _queries(search.metadata, rng):
        search.check(query, index=True)
    search.metadata.tracks.reverse()
    search.db.replace_library(search.metadata)
    for query in _queries(search.metadata, rng, 15):
        search.check(query, index=True)


def test_candidate_filter_keeps_every_row_that_scores(library):
    rng = random.Random(7)
    metadata = _random_library(7, 400)
    search = library(metadata)
    with search.db._get_connection() as conn:
        # Folding is idempotent on this Python, so no row needs the loose escape.
        assert conn.execute("SELECT COUNT(*) FROM library_search WHERE loose").fetchone()[0] == 0
        for query in _queries(metadata, rng, 80):
            q_folded, q_tokens = fold_text(query), frozenset(match_tokens(query))
            if not q_folded:
                continue
            sql, params = library_search._candidate_query(q_folded, q_tokens)
            returned = [row[0] for row in conn.execute(sql, params)]

            def scores(track):
                title = getattr(track, "title", "") or ""
                artist = track.artist or track.album_artist or ""
                return (
                    catalog._text_score(q_folded, q_tokens, title, 100, 70, 42, apply_coverage=True),
                    catalog._text_score(q_folded, q_tokens, artist, 100, 70, 42, apply_coverage=False),
                    catalog._text_score(q_folded, q_tokens, track.album or "", 100, 70, 42, apply_coverage=False),
                )

            scoring = [position for position, track in enumerate(metadata.tracks) if any(scores(track))]
            assert returned == sorted(set(returned)), query
            # Query tokens are tested as substrings, not whole words: a superset.
            # Without that branch the filter is exactly "some field scores".
            assert set(scoring) <= set(returned), query
            if q_tokens in (frozenset(), frozenset({q_folded})):
                assert returned == scoring, query


def test_loose_rows_are_always_candidates(library, monkeypatch):
    monkeypatch.setattr(library_search, "_loose", lambda text: text == "nude")
    search = library(LibraryMetadata(1, [_track("0", "Nude", "Radiohead", "In Rainbows"),
                                         _track("1", "Other", "Someone", "Else")], {}, {}))
    with search.db._get_connection() as conn:
        sql, params = library_search._candidate_query("zzz", frozenset({"zzz"}))
        assert [tuple(row) for row in conn.execute(sql, params)] == [(0, "nude", "radiohead", "in rainbows")]
    assert search.check("zzz", index=True) == []
    assert search.check("nude", index=True)


def _set(attribute, value, position=3):
    return lambda tracks: setattr(tracks[position], attribute, value)


_UNSAVED = {
    "title": _set("title", "Brand New Title"),
    "artist": _set("artist", "Brand New Artist"),
    "album_artist": _set("album_artist", "Brand New Artist", position=4),
    "album": _set("album", "Brand New Album"),
    "order": lambda tracks: tracks.reverse(),
    "add": lambda tracks: tracks.append(_track("added", "Brand New Title", "", "Radio", "Brand New Artist")),
    "remove": lambda tracks: tracks.pop(3),
}


@pytest.mark.parametrize("edit", sorted(_UNSAVED))
def test_unsaved_edits_scan_the_model_until_they_are_saved(library, edit):
    search = library(_base())
    _UNSAVED[edit](search.metadata.tracks)
    queries = ["brand new", "radio", "ra", "rosalia", "various", "song 3"]
    for query in queries:
        search.check(query, index=False)
    search.db.replace_library(search.metadata)
    for query in queries:
        search.check(query, index=True)


def test_an_unsaved_rekey_still_uses_the_index(library):
    # IDs are not part of the proof: positions match on search fields, and
    # every emitted id comes from the model itself.
    search = library(_base())
    search.metadata.tracks[3].id = "renamed"
    rows = search.check("ra ra riot", index=True)
    assert "library:track:renamed" in {row["id"] for row in rows}


_SAVED = {
    "title": (_set("title", "Brand New Title"), ["3"]),
    "artist": (_set("artist", "Brand New Artist"), ["3"]),
    "album_artist": (_set("album_artist", "Brand New Artist", position=4), ["4"]),
    "album": (_set("album", "Brand New Album"), ["3"]),
    "duration": (_set("duration", 999), []),
    "add": (lambda tracks: tracks.append(_track("added", "Brand New Title", "X", "Y")), ["added"]),
    "remove": (lambda tracks: tracks.pop(3), []),
    "order": (lambda tracks: tracks.reverse(), []),
}


@pytest.mark.parametrize("change", sorted(_SAVED))
def test_saves_fold_only_the_rows_they_change(library, folds, monkeypatch, change):
    search = library(_base())
    edit, expected = _SAVED[change]
    proofs = []
    original = library_search._stored_fingerprint
    monkeypatch.setattr(library_search, "_stored_fingerprint", lambda conn: proofs.append(1) or original(conn))
    folds.clear()
    edit(search.metadata.tracks)
    search.db.replace_library(search.metadata)
    assert folds == expected
    # Unrelated fields neither invalidate nor re-read the index.
    assert len(proofs) == (0 if change == "duration" else 1)
    assert _state(search.db) == (1, library_search.VERSION)
    for query in ("brand new", "radio", "ra", "various"):
        search.check(query, index=True)


def test_a_saved_rekey_folds_only_the_new_id(library, folds):
    search = library(_base())
    folds.clear()
    search.db.replace_library(search.metadata, id_replacements={"3": "3b"})
    assert search.metadata.tracks[3].id == "3b"
    assert folds == ["3b"]
    rows = search.check("ra ra riot", index=True)
    assert "library:track:3b" in {row["id"] for row in rows}


def test_restart_reuses_the_index_and_a_new_version_rebuilds_it(library, folds, monkeypatch):
    search = library(_random_library(3, 80))
    folds.clear()
    database._SCHEMA_READY.clear()
    db = DatabaseManager(str(search.db.db_path))
    assert folds == []
    # A model reloaded from SQLite reproduces the stored proof.
    search.db, search.metadata = db, db.load_library_metadata()
    for query in ("ra", "rosalia", "live"):
        search.check(query, index=True)
    monkeypatch.setattr(library_search, "VERSION", "next")
    search.check("ra", index=False)
    database._SCHEMA_READY.clear()
    DatabaseManager(str(db.db_path))
    assert len(folds) == 80
    assert _state(db) == (1, "next")
    search.check("ra", index=True)


def test_a_fresh_process_uses_the_index_for_the_reloaded_model(library):
    search = library(_random_library(5, 50))
    with search.db.library_search_candidates(search.metadata.tracks, "ra", frozenset({"ra"})) as rows:
        expected = len(list(rows))
    script = (
        "import sys\n"
        "sys.path.insert(0, sys.argv[1])\n"
        "from shared.database import DatabaseManager\n"
        "db = DatabaseManager(sys.argv[2])\n"
        "tracks = db.load_library_metadata().tracks\n"
        "with db.library_search_candidates(tracks, 'ra', frozenset({'ra'})) as rows:\n"
        "    print('indexed' if rows is not None else 'scan', len(list(rows or ())))\n"
    )
    result = subprocess.run([sys.executable, "-c", script, str(_ROOT), str(search.db.db_path)],
                            capture_output=True, text=True, check=True, timeout=60)
    assert result.stdout.split() == ["indexed", str(expected)]


@pytest.mark.parametrize("statement", [
    "UPDATE tracks SET title='Outside writer' WHERE id='3'",
    "UPDATE tracks SET album_artist='Outside writer' WHERE id='4'",
    "UPDATE library_tracks SET position=position+1000 WHERE position=0",
    "UPDATE library_search SET title='outside writer'",
    "INSERT INTO library_search VALUES ('ghost', 0, 'ra', 'ra', 'ra', 0)",
    "UPDATE library_search SET position=position+1 WHERE track_id='3'",
    "DELETE FROM library_search WHERE track_id='3'",
])
def test_raw_sql_invalidates_the_index_until_a_save_repairs_it(library, statement):
    search = library(_base())
    _execute(search.db, statement)
    assert _state(search.db)[0] == 0
    queries = ("outside writer", "ra", "radio", "various")
    # The engine keeps serving its own model; a reload sees the outside write.
    for model in (search.metadata, search.db.load_library_metadata()):
        search.metadata = model
        for query in queries:
            search.check(query, index=False)
    search.db.replace_library(search.metadata)
    assert _state(search.db) == (1, library_search.VERSION)
    for query in queries:
        search.check(query, index=True)


def test_positions_that_disagree_with_the_library_are_refolded(library, folds):
    search = library(_base())
    _execute(search.db, "UPDATE library_search SET position=position+1 WHERE track_id='3'")
    assert _state(search.db) == (0, library_search.VERSION)
    folds.clear()
    search.db.replace_library(search.metadata)
    assert len(folds) == 40
    for query in ("ra", "radio", "various"):
        search.check(query, index=True)


def test_a_dropped_index_falls_back_and_is_rebuilt_at_schema_setup(library, folds):
    search = library(_base())
    _execute(search.db, "DROP TABLE library_search")
    # The state still claims validity; the missing table fails the query.
    before = len(search.used)
    assert search.indexed("ra") == search.reference("ra")
    assert search.used[before:] == []
    folds.clear()
    database._SCHEMA_READY.clear()
    search.db = DatabaseManager(str(search.db.db_path))
    assert len(folds) == 40
    search.check("ra", index=True)


@pytest.mark.parametrize("previous", ["none", "other format"])
def test_a_database_without_this_index_is_built_once(library, folds, previous):
    search = library(_random_library(8, 120))
    with search.db._get_connection() as conn:
        for name in sorted(library_search._OBJECTS):
            kind = "TABLE" if name in library_search._COLUMNS else "TRIGGER"
            conn.execute(f"DROP {kind} IF EXISTS {name}")
        if previous == "other format":
            conn.execute("CREATE TABLE library_search (track_id TEXT PRIMARY KEY, title TEXT) WITHOUT ROWID")
            conn.execute("INSERT INTO library_search SELECT track_id, 'ra' FROM library_tracks")
    folds.clear()
    database._SCHEMA_READY.clear()
    search.db = DatabaseManager(str(search.db.db_path))
    assert len(folds) == 120
    assert _state(search.db) == (1, library_search.VERSION)
    search.check("ra", index=True)


def test_index_failures_never_block_a_canonical_save(library, monkeypatch):
    search = library(_base())
    original = library_search.search_row

    def broken(*row):
        raise RuntimeError("fold failed")

    monkeypatch.setattr(library_search, "search_row", broken)
    search.metadata.tracks[3].title = "Saved anyway"
    assert search.db.replace_library(search.metadata) == 2
    assert search.db.load_library_metadata().tracks[3].title == "Saved anyway"
    assert _state(search.db)[0] == 0
    search.check("saved anyway", index=False)
    monkeypatch.setattr(library_search, "search_row", original)
    search.db.replace_library(search.metadata)
    search.check("saved anyway", index=True)


def test_unbindable_queries_fall_back_to_the_scan(library):
    search = library(_base())
    before = len(search.used)
    # A lone surrogate cannot be bound to SQLite; the scan still answers.
    assert search.indexed("\ud800ra") == search.reference("\ud800ra")
    assert search.used[before:] == []


def test_empty_library_uses_an_empty_valid_index(library):
    search = library(LibraryMetadata(1, [], {}, {}))
    assert _state(search.db) == (1, library_search.VERSION)
    assert search.check("ra", index=True) == []
    assert search.check("", index=True) == []


def test_concurrent_indexed_searches_equal_the_reference(library):
    search = library(_random_library(9, 300))
    queries = _queries(search.metadata, random.Random(9), 30)
    expected = [search.reference(query) for query in queries]
    tracks = search.indexed_tracks()
    search.monkeypatch.setattr(catalog, "_library_tracks", lambda: tracks)
    before = len(search.used)
    with ThreadPoolExecutor(max_workers=8) as pool:
        actual = list(pool.map(lambda query: catalog._local_catalog(query, 30), queries))
    assert actual == expected
    assert search.used[before:] == [True] * sum(1 for query in queries if fold_text(query))


def test_catalog_search_route_serves_the_same_library_rows(library, monkeypatch):
    search = library(_base())
    lib = SimpleNamespace(db=search.db, metadata=search.metadata, refresh_if_stale=lambda: None)
    monkeypatch.setattr(catalog, "_get_api", lambda: {"get_core": lambda: (lib, None, None)})
    for name in ("_deezer_search", "_musicbrainz_search", "_youtube_search"):
        monkeypatch.setattr(catalog, name, lambda query, limit: [])
    app = Flask(__name__)
    app.register_blueprint(catalog.catalog_bp)
    bodies = []
    for db in (search.db, None):
        lib.db = db
        catalog._catalog_memo.clear()
        body = app.test_client().get("/api/catalog/search?q=radio").get_json()
        body.pop("generated_at")
        bodies.append(body)
    catalog._catalog_memo.clear()
    assert search.used == [True]
    assert bodies[0] == bodies[1]
    assert bodies[0]["items"]


# Update only together with INDEX_FORMAT, after re-checking the proof below.
_PINNED = (1, "8ac84f48d62438a9b731785e4f4750ea2d13bcba3b5dc4c4ce982c9eda35956f")


def test_matching_semantics_are_pinned_to_the_index_format():
    functions = (
        text_utils.collapse_text, text_utils.normalize_text, text_utils.fold_text, text_utils.match_tokens,
        text_utils.strip_release_junk, library_search.search_title, library_search.search_text,
        library_search.search_row, library_search._loose, library_search._candidate_query, catalog._score_folded,
    )
    parts = [inspect.getsource(function) for function in functions]
    parts += [text_utils._RELEASE_JUNK.pattern, str(text_utils._RELEASE_JUNK.flags),
              text_utils._TOKEN.pattern, str(text_utils._TOKEN.flags)]
    digest = hashlib.sha256("\x00".join(parts).encode()).hexdigest()
    assert (library_search.INDEX_FORMAT, digest) == _PINNED, (
        "Local search matching changed. Confirm that library_search's candidate filter still keeps every "
        "row _score_folded can score above zero, bump INDEX_FORMAT if stored values change, then update _PINNED."
    )
