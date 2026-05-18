# Reference migration fixtures

Versioned files used by `tests/test_migration_reference_fixtures.py` to lock **expected**
aggregate match statistics for the Phase 1 migration gate (`docs/LAYER_CONTRACTS.md` §5).

## `manifest.json`

- **`version`**: increment when you change **`shared/migration/match.py`** weights/thresholds or replace fixture files so stats drift.
- **`scenarios`**: each entry lists inputs (`export` CSV/JSON or raw `sources` list), a **`library`** JSON file (`tracks` array compatible with `Track.from_dict`), and **`expected_stats`** as returned by `migration_stats()` after `match_sources_to_library()`.

## Files

| File | Role |
|------|------|
| `apple_two_rows.csv` | Tiny Apple Music–style CSV (header + 2 rows). |
| `library_pair.json` | Two local tracks matching the CSV rows (auto-accept). |
| `spotify_three_tracks.json` | Minimal Spotify `tracks.items[]` export. |
| `library_three.json` | Three local tracks matching that export. |
| `gate50_sources.json` | 50 `SourceTrack` rows (49 aligned + 1 orphan). |
| `gate50_library.json` | 50 local tracks `Gate Track 001` … `050`. |

## Regression policy

If `track_match_score` or thresholds change, recompute expectations (run the test or the small probe in CI) and bump **`manifest.json` `version`**.
