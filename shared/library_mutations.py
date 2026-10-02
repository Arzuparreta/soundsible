"""Validated playlist commands, applied to a detached transactional header."""
from __future__ import annotations


class LibraryMutationError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def apply_playlist_command(metadata, command: str, name: str | None, data):
    if not isinstance(data, dict):
        raise LibraryMutationError("Expected a JSON object")

    def text(key):
        value = data.get(key)
        if not isinstance(value, str) or not value.strip():
            raise LibraryMutationError(f"{key} must be a nonempty string")
        return value.strip()

    def strings(key):
        value = data.get(key)
        if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
            raise LibraryMutationError(f"{key} must be a list of nonempty strings")
        return value

    if command == "create":
        name = text("name")
        if name in metadata.playlists:
            raise LibraryMutationError("Playlist already exists", 409)
        metadata.create_playlist(name)
        return
    if command == "reorder":
        order = strings("order")
        if len(order) != len(set(order)) or set(order) != set(metadata.playlists):
            raise LibraryMutationError("order must contain every playlist exactly once")
        metadata.reorder_playlists(order)
        return
    if name not in metadata.playlists:
        raise LibraryMutationError("Playlist not found", 404)
    if command == "add":
        metadata.add_to_playlist(name, text("track_id"))
    elif command == "remove":
        metadata.remove_from_playlist(name, text("track_id"))
    elif command == "delete":
        metadata.delete_playlist(name)
    elif command == "update":
        new_name = text("name") if "name" in data else name
        ids = strings("track_ids") if "track_ids" in data else metadata.playlists[name]
        cover = data.get("cover_track_id")
        if cover is not None and not isinstance(cover, str):
            raise LibraryMutationError("cover_track_id must be a string or null")
        if cover and cover.strip() not in ids:
            raise LibraryMutationError("Invalid cover_track_id (not in playlist)")
        if new_name != name and new_name in metadata.playlists:
            raise LibraryMutationError("Playlist already exists", 409)
        # Every field is valid before the first mutation, even on this copy.
        if new_name != name:
            metadata.rename_playlist(name, new_name)
        if "track_ids" in data:
            metadata.set_playlist_tracks(new_name, ids)
        if "cover_track_id" in data:
            metadata.set_playlist_cover_track_id(new_name, (cover or "").strip() or None)
    else:
        raise LibraryMutationError("Unknown playlist command")
