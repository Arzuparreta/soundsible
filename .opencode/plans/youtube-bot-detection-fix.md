# Fix: YouTube Bot Detection Error

## Problem
YouTube is blocking yt-dlp with: `"Sign in to confirm you're not a bot"`

## Changes Required

### 1. `odst_tool/youtube_downloader.py` - Line ~723-728

**Add "Sign in to confirm" to retry conditions:**

```python
# Before:
if returncode != 0 and (
    "Requested format is not available" in combined_output
    or "The page needs to be reloaded" in combined_output
):

# After:
if returncode != 0 and (
    "Requested format is not available" in combined_output
    or "The page needs to be reloaded" in combined_output
    or "Sign in to confirm" in combined_output
):
```

### 2. `odst_tool/youtube_downloader.py` - Add `tv` player client

Update `extractor_args` in 4 locations to include `'tv'` (YouTube TV client is less restrictive for servers):

**Location A - `_search_youtube` (~line 555-559):**
```python
# Before:
'extractor_args': {
    'youtube': {
        'player_client': ['android', 'ios', 'web'],
    }
}

# After:
'extractor_args': {
    'youtube': {
        'player_client': ['android', 'ios', 'web', 'tv'],
    }
}
```

**Location B - `_peek_video_metadata` (~line 752):**
```python
# Before:
"extractor_args": {"youtube": {"player_client": ["android", "ios", "web"]}},

# After:
"extractor_args": {"youtube": {"player_client": ["android", "ios", "web", "tv"]}},
```

**Location C - `search_youtube` (~line 838-840):**
```python
# Before:
'extractor_args': {
    'youtube': {'player_client': ['android', 'ios', 'web']}
}

# After:
'extractor_args': {
    'youtube': {'player_client': ['android', 'ios', 'web', 'tv']}
}
```

**Location D - `get_related_videos` (~line 938-940):**
```python
# Before:
'extractor_args': {
    'youtube': {'player_client': ['android', 'ios', 'web']}
}

# After:
'extractor_args': {
    'youtube': {'player_client': ['android', 'ios', 'web', 'tv']}
}
```

## Summary
- **File:** `odst_tool/youtube_downloader.py`
- **Changes:** 5 edits total (1 retry condition + 4 player_client updates)
- **Risk:** Low - adds fallback behavior and an additional client option
