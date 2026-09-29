"""Account-owned artist/album bookmarks, independent of files and song holdings."""
from datetime import datetime, timezone
from hashlib import sha256
import json
from urllib.parse import urlsplit, parse_qs

from shared.atomic_file import publish, text_pieces
from shared.library_lifecycle import serialized, LibraryPersistenceError
from shared.user_context import user_config_dir


def normalise(raw):
    if not isinstance(raw, dict) or raw.get('kind') not in ('artist', 'album'):
        raise ValueError('kind must be artist or album')
    entry = {'kind': raw['kind']}
    for field in ('name', 'artist', 'cover', 'destination'):
        value = raw.get(field, '')
        if not isinstance(value, str) or len(value) > 4096:
            raise ValueError(f'Invalid {field}')
        entry[field] = value.strip()
    if not entry['name']:
        raise ValueError('name is required')
    path = urlsplit(entry['destination'])
    if path.scheme or path.netloc or not path.path.startswith(f"/{entry['kind']}/") or path.fragment:
        raise ValueError('Invalid destination')
    query = parse_qs(path.query)
    # Keep exact entity identities; names are only unresolved navigation references.
    keys = []
    for param, namespace in ((f"{entry['kind']}_id", 'library'), ('deezer_id', 'deezer')):
        values = query.get(param, [])
        if len(values) > 1:
            raise ValueError('Ambiguous identity')
        if values:
            keys.append(f"{entry['kind']}:{namespace}:{values[0]}")
    if not keys:
        reference = json.dumps([entry['kind'], entry['name'], entry['artist']], ensure_ascii=False)
        keys = [f"{entry['kind']}:reference:{sha256(reference.encode()).hexdigest()}"]
    entry['keys'] = keys
    return entry


def get_entries():
    path = user_config_dir() / 'saved_entities.json'
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
        entries = payload['entities']
        if not isinstance(entries, list):
            raise ValueError('Invalid entities')
        for entry in entries:
            normalise(entry)
            if (not isinstance(entry.get('keys'), list) or not entry['keys']
                    or any(not isinstance(key, str) for key in entry['keys'])
                    or not isinstance(entry.get('id'), str)
                    or not isinstance(entry.get('added_at'), str)):
                raise ValueError('Invalid identity')
        return entries
    except FileNotFoundError:
        return []
    except (OSError, ValueError, KeyError, TypeError) as exc:
        # Never overwrite an unreadable collection with an empty one.
        raise LibraryPersistenceError() from exc


@serialized
def set_saved(raw, saved):
    entry = normalise(raw)
    if not isinstance(saved, bool):
        raise ValueError('saved must be boolean')
    entries = get_entries()
    matches = [item for item in entries if set(item['keys']) & set(entry['keys'])]
    if saved and matches:
        # Idempotent saves preserve order and enrich known aliases only.
        first = matches[0]
        for field in ('artist', 'cover'):
            if not entry[field]:
                entry[field] = first.get(field, '')
        entry['keys'] = list(dict.fromkeys(key for item in [*matches, entry] for key in item['keys']))
        entry['added_at'] = first['added_at']
        entry['id'] = first['id']
        entries = [entry if item is first else item for item in entries if item is first or item not in matches]
    elif saved:
        entry['id'] = sha256(entry['keys'][0].encode()).hexdigest()
        entry['added_at'] = datetime.now(timezone.utc).isoformat()
        entries.insert(0, entry)
    else:
        entries = [item for item in entries if item not in matches]
    try:
        publish(user_config_dir() / 'saved_entities.json', text_pieces([json.dumps({'entities': entries}, ensure_ascii=False)]))
    except OSError as exc:
        raise LibraryPersistenceError() from exc
    return entries
