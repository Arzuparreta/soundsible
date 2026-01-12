"""
Core upload engine for processing and syncing music files.

Handles parallel uploads, format conversion, deductible detection,
and library metadata generation.
"""

import os
import json
import concurrent.futures
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Set
from rich.progress import Progress, TaskID
from datetime import datetime

from shared.models import Track, LibraryMetadata, PlayerConfig, StorageProvider
from shared.constants import LIBRARY_METADATA_FILENAME, DEFAULT_MP3_BITRATE
from setup_tool.audio import AudioProcessor
from setup_tool.provider_factory import StorageProviderFactory
from setup_tool.storage_provider import S3StorageProvider


class UploadEngine:
    """
    Manages the upload process for music files.
    """
    
    def __init__(self, config: PlayerConfig):
        self.config = config
        self.provider = StorageProviderFactory.create(config.provider)
        
        # Re-authenticate using stored config
        # Note: In a real app we'd decrypt these first
        creds = {}
        if config.provider == StorageProvider.CLOUDFLARE_R2:
            # We need account_id for R2 which might not be explicitly stored 
            # in the simple config object if not careful, but PlayerConfig usually has endpoint
            # Extract account ID from endpoint if possible or strictly use stored keys
            # For this MVP we'll rely on the simplified auth flow or what's in config
             creds = {
                'account_id': self._extract_account_id(config.endpoint), # Helper needed?
                'access_key_id': config.access_key_id,
                'secret_access_key': config.secret_access_key,
                'bucket': config.bucket
            }
        elif config.provider == StorageProvider.BACKBLAZE_B2:
            creds = {
                'application_key_id': config.access_key_id,
                'application_key': config.secret_access_key,
                'bucket': config.bucket
            }
            
        # R2 Provider implementation expects 'account_id'
        # Let's handle the R2 specific auth slightly better if we can
        # For now, pass what we have; the provider implementation might need adjustment 
        # if it strictly requires account_id separate from endpoint.
        # Actually, looking at CloudflareR2Provider.authenticate:
        # It sets self.endpoint_url based on account_id.
        # If we already have the endpoint in config, we might want to adjust the provider 
        # to accept that or extract account_id. 
        # Let's extract account_id from the endpoint "https://{account_id}.r2.cloudflarestorage.com"
        
        if config.provider == StorageProvider.CLOUDFLARE_R2 and not creds.get('account_id'):
             # Try to extract from endpoint
             if '.r2.cloudflarestorage.com' in config.endpoint:
                 creds['account_id'] = config.endpoint.split('//')[1].split('.')[0]
        
        if not self.provider.authenticate(creds):
            raise ValueError("Failed to authenticate with storage provider using saved configuration.")

    def _extract_account_id(self, endpoint: str) -> str:
        try:
             # Basic extraction for R2: https://<id>.r2...
             if '//' in endpoint:
                 return endpoint.split('//')[1].split('.')[0]
        except:
            pass
        return ""

    def scan_directory(self, path: str) -> List[Path]:
        """Recursively scan for supported audio files (or single file)."""
        files = []
        path_obj = Path(path).expanduser().resolve()
        
        # Handle single file case
        if path_obj.is_file():
            if AudioProcessor.is_supported_format(str(path_obj)):
                files.append(path_obj)
            return files

        # Handle directory case
        for root, _, filenames in os.walk(str(path_obj)):
            for filename in filenames:
                file_path = Path(root) / filename
                if AudioProcessor.is_supported_format(str(file_path)):
                    files.append(file_path)
        return files

    def run(self, source_path: str, compress: bool = True, 
            parallel: int = 4, bitrate: int = DEFAULT_MP3_BITRATE, 
            progress: Optional[Progress] = None) -> LibraryMetadata:
        """
        Execute the upload process.
        """
        source_dir = Path(source_path).expanduser().resolve()
        if not source_dir.exists():
            raise FileNotFoundError(f"Directory not found: {source_path}")

        # 1. Scan files
        if progress:
            scan_task = progress.add_task("[cyan]Scanning files...", total=None)
        
        audio_files = self.scan_directory(str(source_dir))
        
        if progress:
            progress.update(scan_task, completed=1, total=1, visible=False)
        
        if not audio_files:
            return None

        # 2. Load existing library if available
        existing_library = self._load_remote_library()
        existing_tracks = {t.file_hash: t for t in existing_library.tracks} if existing_library else {}
        
        new_tracks = []
        skipped_count = 0
        upload_count = 0
        
        # 3. Process and Upload
        if progress:
            main_task = progress.add_task(f"[green]Processing {len(audio_files)} files...", total=len(audio_files))

        with concurrent.futures.ThreadPoolExecutor(max_workers=parallel) as executor:
            # Map files to future objects
            future_to_file = {
                executor.submit(
                    self._process_single_file, 
                    file_path, 
                    source_dir, 
                    compress, 
                    bitrate,
                    existing_tracks
                ): file_path for file_path in audio_files
            }

            for future in concurrent.futures.as_completed(future_to_file):
                file_path = future_to_file[future]
                try:
                    result_track, uploaded = future.result()
                    if result_track:
                        new_tracks.append(result_track)
                        if uploaded:
                            upload_count += 1
                        else:
                            skipped_count += 1
                except Exception as e:
                    print(f"Error processing {file_path.name}: {e}")
                
                if progress:
                    progress.advance(main_task)

        # 4. Generate and Upload updated Library Metadata
        # Merge new tracks with existing ones (updating if needed, or just appending?)
        # For simplicity, we'll rebuild the track list based on what we just scanned/verified
        # BUT we should preserve playlists etc from existing_library
        
        # Current strategy: The 'new_tracks' list contains everything valid found in the scan.
        # If we want to keep tracks that weren't in this specific scan (additive), we'd need more logic.
        # For now, let's assume 'sync' means 'make cloud match this folder' OR 
        # mostly likely for a setup tool cleanup: invalid/missing tracks should be handled carefully.
        # Let's do ADDITIVE for now: keep existing tracks if they aren't duplicates of new ones.
        
        final_track_list = list(new_tracks)
        
        # (Optional: Add logic here to keep tracks from existing_library that weren't part of this upload scan
        #  but still exist in the bucket? Not implemented for MVP to avoid "ghost" tracks)

        updated_library = LibraryMetadata(
            library_version="1.0",
            tracks=final_track_list,
            playlists=existing_library.playlists if existing_library else {},
            settings=existing_library.settings if existing_library else {},
            last_updated=datetime.utcnow().isoformat()
        )
        
        if progress:
            sync_task = progress.add_task("[yellow]Syncing library metadata...", total=1)

        self._save_remote_library(updated_library)
        
        if progress:
            progress.update(sync_task, completed=1)

        return updated_library

    def _process_single_file(self, file_path: Path, source_root: Path, 
                             compress: bool, bitrate: int, 
                             existing_tracks: Dict[str, Track]) -> Tuple[Optional[Track], bool]:
        """
        Process a single audio file: hash, compress (if needed), upload.
        Returns (Track, uploaded_bool)
        """
        try:
            # Calculate hash first to check for duplicates
            file_hash = AudioProcessor.calculate_hash(str(file_path))
            
            # Check if exists in remote library
            # If so, we can skip processing logic if we trust the hash (Deduplication)
            if file_hash in existing_tracks:
                # We still return the track object so it ends up in the new library manifest
                # But we skip upload
                return existing_tracks[file_hash], False

            # Extract metadata
            metadata = AudioProcessor.extract_metadata(str(file_path))
            
            # Compression decision
            should_compress, reason = AudioProcessor.should_compress(str(file_path))
            final_file_path = file_path
            is_compressed_copy = False
            
            if compress and should_compress:
                # Create a temporary compressed version
                # For MVP, maybe just use /tmp or a cache dir. 
                # Let's assume we upload the processed stream or file.
                # Since our S3 provider takes a path, we need a temp file.
                import tempfile
                fd, temp_path = tempfile.mkstemp(suffix=".mp3")
                os.close(fd)
                
                success = AudioProcessor.compress_to_mp3(str(file_path), temp_path, bitrate)
                if success:
                    final_file_path = Path(temp_path)
                    is_compressed_copy = True
                    # Update metadata for the new compressed file (size, format) ?
                    # Ideally yes, but we keep original metadata (Artist/Title)
                    metadata['format'] = 'mp3'
                    metadata['bitrate'] = bitrate
            
            # Upload
            # Remote key structure: tracks/{uuid}.{ext}
            track_id = Track.generate_id()
            ext = final_file_path.suffix.lstrip('.')
            remote_key = f"tracks/{track_id}.{ext}"
            
            uploaded = self.provider.upload_file(str(final_file_path), remote_key, metadata={
                'title': str(metadata.get('title', '')),
                'artist': str(metadata.get('artist', ''))
            })
            
            # Cleanup temp file
            if is_compressed_copy:
                os.remove(final_file_path)
            
            if not uploaded:
                return None, False

            # Create Track object
            track = Track(
                id=track_id,
                title=metadata.get('title', 'Unknown'),
                artist=metadata.get('artist', 'Unknown'),
                album=metadata.get('album', 'Unknown'),
                duration=metadata.get('duration', 0),
                file_hash=file_hash,
                original_filename=file_path.name,
                compressed=is_compressed_copy,
                file_size=os.path.getsize(str(file_path)), # Original size or new? 
                # Let's store the size of the file we actually possess locally or the one in cloud?
                # Usually cloud size.
                bitrate=metadata.get('bitrate', 0),
                format=ext,
                year=metadata.get('year'),
                genre=metadata.get('genre'),
                track_number=metadata.get('track_number')
            )
            
            return track, True

        except Exception as e:
            print(f"Error in worker for {file_path}: {e}")
            return None, False

    def _load_remote_library(self) -> Optional[LibraryMetadata]:
        try:
            json_str = self.provider.download_json(LIBRARY_METADATA_FILENAME)
            if json_str:
                return LibraryMetadata.from_json(json_str)
        except Exception:
            pass # File doesn't exist or error
        return None

    def _save_remote_library(self, library: LibraryMetadata):
        self.provider.upload_json(library.to_json(), LIBRARY_METADATA_FILENAME)
