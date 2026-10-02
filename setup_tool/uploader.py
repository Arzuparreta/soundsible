"""
Putting an audio file into the configured storage as a library track.
"""

import logging
import os
from pathlib import Path
from typing import Optional

from setup_tool.provider_factory import StorageProviderFactory
from shared.audio_files import AudioProcessor
from shared.models import PlayerConfig, Track

logger = logging.getLogger(__name__)


class UploadEngine:
    """Uploads audio files to the storage provider in the player config."""

    def __init__(self, config: PlayerConfig):
        self.config = config
        self.storage = StorageProviderFactory.create(self.config.provider)
        creds = {
            'access_key_id': self.config.access_key_id,
            'secret_access_key': self.config.secret_access_key,
            'region': self.config.region,
            'endpoint': self.config.endpoint,
            # Backblaze B2 names the same two credentials differently.
            'application_key_id': self.config.access_key_id,
            'application_key': self.config.secret_access_key,
        }
        # R2 endpoints are https://<account_id>.r2.cloudflarestorage.com.
        if self.config.provider.name == 'CLOUDFLARE_R2' and self.config.endpoint:
            try:
                creds['account_id'] = self.config.endpoint.split('//')[1].split('.')[0]
            except IndexError:
                logger.warning("Could not read an R2 account id from %s", self.config.endpoint)
        if not self.storage.authenticate(creds):
            raise ValueError("Failed to authenticate storage provider with cached config")
        self.storage.bucket_name = self.config.bucket

    def upload(self, file_path: Path) -> Optional[Track]:
        """Upload a file as it is, under its content hash, and return its Track.

        The file's embedded cover becomes the track's artwork unless the hash
        already has some. None when the upload fails.
        """
        try:
            from shared.artwork import artwork_store

            file_hash = AudioProcessor.calculate_hash(str(file_path))
            metadata = AudioProcessor.extract_metadata(str(file_path))
            store = artwork_store()
            previous_art = store.ref(file_hash)
            original_art = previous_art['hash'] if previous_art else None
            if not original_art:
                cover = AudioProcessor.extract_cover_art(str(file_path))
                original_art = store.put(cover) if cover else None

            remote_key = f"tracks/{file_hash}.{metadata['format']}"
            if not self.storage.upload_file(str(file_path), remote_key):
                return None
            if original_art:
                store.bind(file_hash, original_art, previous_art["source"] if previous_art else "embedded",
                           only_missing=True)

            # A local provider stores the file at an absolute path in its "bucket".
            local_path = None
            if self.config.provider.value == 'local' and hasattr(self.storage, '_get_path'):
                local_path = str(self.storage._get_path(remote_key).absolute())

            return Track(
                id=file_hash,
                title=metadata.get('title') or 'Unknown',
                artist=metadata.get('artist') or 'Unknown',
                album=metadata.get('album') or 'Unknown',
                album_artist=metadata.get('album_artist'),
                duration=metadata.get('duration') or 0,
                format=metadata.get('format') or 'mp3',
                bitrate=metadata.get('bitrate') or 0,
                file_size=os.path.getsize(file_path),
                file_hash=file_hash,
                original_filename=file_path.name,
                cover_art_key=None,
                year=metadata.get('year'),
                genre=metadata.get('genre'),
                track_number=metadata.get('track_number'),
                artists=metadata.get('artists'),
                disc_number=metadata.get('disc_number'),
                disc_total=metadata.get('disc_total'),
                is_compilation=bool(metadata.get('is_compilation')),
                is_local=(self.config.provider.value == 'local'),
                local_path=local_path,
                musicbrainz_id=metadata.get('musicbrainz_id'),
            )
        except Exception as e:
            logger.exception("Failed to upload %s: %s", file_path, e)
            return None
