"""
Upload engine for managing music uploads to cloud storage.
"""

import os
import re
import concurrent.futures
import traceback
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Any
from concurrent.futures import ThreadPoolExecutor

from shared.models import PlayerConfig, Track, LibraryMetadata
# from setup_tool.cloud import CloudStorage  <-- REMOVED
from setup_tool.provider_factory import StorageProviderFactory
from setup_tool.audio import AudioProcessor
from shared.constants import DEFAULT_MP3_BITRATE

# Optional progress reporting
try:
    from rich.progress import Progress
except ImportError:
    Progress = None # type: ignore


class UploadEngine:
    """Handles scanning, verification, and uploading of music files."""
    
    def __init__(self, config: PlayerConfig):
        self.config = config
        
        # Initialize storage provider
        self.storage = StorageProviderFactory.create(self.config.provider)
        
        # Authenticate using config credentials
        creds = {
            'access_key_id': self.config.access_key_id,
            'secret_access_key': self.config.secret_access_key,
            'region': self.config.region,
            'endpoint': self.config.endpoint,
            # B2 compatibility mappings if needed
            'application_key_id': self.config.access_key_id, 
            'application_key': self.config.secret_access_key
        }

        # R2 specific: Need to extract account_id from endpoint
        if self.config.provider.name == 'CLOUDFLARE_R2' and self.config.endpoint:
            try:
                # Endpoint format: https://<account_id>.r2.cloudflarestorage.com
                creds['account_id'] = self.config.endpoint.split('//')[1].split('.')[0]
            except IndexError:
                pass # Should probably log this warning
        
        if not self.storage.authenticate(creds):
            raise ValueError("Failed to authenticate storage provider with cached config")
            
        # Ensure bucket exists/is selectable
        self.storage.bucket_name = self.config.bucket


    def scan_directory(self, path: str) -> List[Path]:
        """
        Recursively scan directory for supported audio files.
        """
        files = []
        path_obj = Path(path).expanduser().resolve()
        
        if not path_obj.exists():
            return []
            
        if path_obj.is_file():
             if AudioProcessor.is_supported_format(str(path_obj)):
                 return [path_obj]
             return []

        for root, _, filenames in os.walk(str(path_obj)):
            for filename in filenames:
                file_path = Path(root) / filename
                if AudioProcessor.is_supported_format(str(file_path)):
                    files.append(file_path)
        return files

    def run(self, source_path: str, compress: bool = True, 
            parallel: int = 4, bitrate: int = DEFAULT_MP3_BITRATE, 
            cover_image_path: Optional[str] = None,
            auto_fetch: bool = False,
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
            progress.update(scan_task, completed=100, visible=False)

        if not audio_files:
            return None

        # 2. Fetch remote library to check for duplicates
        if progress:
            sync_task = progress.add_task("[cyan]Syncing library...", total=None)
            
        existing_library = self.storage.get_library()
        existing_tracks = {t.id: t for t in existing_library.tracks}
        
        if progress:
            progress.update(sync_task, completed=100, visible=False)

        # 3. Process and Upload
        # Create a map of existing tracks to merge updates into
        track_map = {t.id: t for t in existing_library.tracks}
        
        if progress:
            main_task = progress.add_task(f"[green]Processing {len(audio_files)} files...", total=len(audio_files))

        with ThreadPoolExecutor(max_workers=parallel) as executor:
            future_to_file = {
                executor.submit(
                    self._process_single_file, 
                    file_path, 
                    source_dir, 
                    compress, 
                    bitrate,
                    existing_tracks,
                    cover_image_path,
                    auto_fetch
                ): file_path for file_path in audio_files
            }

            for future in concurrent.futures.as_completed(future_to_file):
                try:
                    result_track, uploaded = future.result()
                    if result_track:
                        # Add or update the track in the map
                        track_map[result_track.id] = result_track
                    
                    if progress:
                        progress.advance(main_task)
                except Exception as e:
                    print(f"Error processing file: {e}")

        # 4. Update Library Manifest
        new_version = existing_library.version + 1
        updated_tracks = list(track_map.values())
        updated_library = LibraryMetadata(
            version=new_version,
            tracks=updated_tracks,
            playlists=existing_library.playlists,
            settings=existing_library.settings
        )
        
        # Save library to cloud
        self.storage.save_library(updated_library)

        return updated_library

    def _process_single_file(self, file_path: Path, source_root: Path, 
                             compress: bool, bitrate: int, 
                             existing_tracks: Dict[str, Track],
                             cover_image_path: Optional[str] = None,
                             auto_fetch: bool = False) -> Tuple[Optional[Track], bool]:
        """
        Process a single audio file: hash, compress, embed art, upload.
        """
        try:
            # Calculate hash first to check for duplicates
            file_hash = AudioProcessor.calculate_hash(str(file_path))
            
            # Check for duplicates, BUT allow overwrite if we are manually setting a cover
            # (This allows fixing missing covers by re-uploading same file)
            if file_hash in existing_tracks and not cover_image_path:
                return existing_tracks[file_hash], False

            # Extract metadata
            metadata = AudioProcessor.extract_metadata(str(file_path))
            print(f"DEBUG: Processing {file_path}")
            print(f"DEBUG: Metadata: {metadata}")
            print(f"DEBUG: Cover Path: {cover_image_path}")
            
            # Auto-Fetch / Cover Logic
            fetched_cover_path = None
            if auto_fetch and not cover_image_path and not metadata.get('cover_art', False):
                try:
                    from setup_tool.metadata import search_itunes, download_image
                    import tempfile
                    
                    # Construct query with progressive fallbacks
                    queries = []
                    
                    # 1. Artist + Title (Best)
                    if metadata['artist'] != 'Unknown Artist' and metadata['title'] != 'Unknown Title':
                         queries.append(f"{metadata['artist']} {metadata['title']}")
                    
                    # 2. Filename cleaned (smarter)
                    stem = file_path.stem
                    # Remove "Original Soundtrack", "OST", etc
                    stem = re.sub(r'(?i)original soundtrack|ost', '', stem)
                    # Remove track numbers "01 ", "04-"
                    stem = re.sub(r'^\d+\s*[-_.]?\s*', '', stem)
                    
                    # Strategy 3: Hyphen Split
                    if ' - ' in file_path.stem:
                        parts = file_path.stem.split(' - ')
                        if len(parts) >= 2:
                            possible_title = parts[-1]
                            possible_title = re.sub(r'^\d+\s*[-_.]?\s*', '', possible_title)
                            queries.append(possible_title)
                            
                            possible_artist = parts[0].replace('_', ' ').strip()
                            queries.append(f"{possible_artist} {possible_title}")

                    # Replace separators (Strategy 2 cont)
                    stem = stem.replace('_', ' ').replace('-', ' ')
                    stem = " ".join(stem.split())
                    queries.append(stem)
                    
                    # 4. Simple Filename (last resort)
                    if stem != file_path.stem:
                        queries.append(file_path.stem.replace('_', ' '))

                    # Try queries until one works
                    results = None
                    for q in queries:
                        if len(q) < 3: continue 
                        results = search_itunes(q, limit=1)
                        if results:
                            break
                            
                    if results:
                        img_url = results[0]['artwork_url']
                        img_data = download_image(img_url)
                        if img_data:
                            with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
                                tmp.write(img_data)
                                fetched_cover_path = tmp.name
                except Exception as e:
                    print(f"Auto-fetch failed for {file_path.name}: {e}")

            # Determine active cover source
            active_cover_path = cover_image_path or fetched_cover_path
            
            # Logic: If we need to embed art we might need a temp copy
            working_file_path = file_path
            is_temp_copy = False
            
            print(f"DEBUG: Checking compression for {file_path}")
            compression_needed, _ = AudioProcessor.should_compress(str(file_path))
            will_compress = compress and compression_needed
            
            # Case 1: Embedding into original format (no compression)
            if active_cover_path and not will_compress:
                print("DEBUG: Checkpoint A - Embedding art")
                import shutil
                import tempfile
                fd, temp_path = tempfile.mkstemp(suffix=file_path.suffix)
                os.close(fd)
                shutil.copy2(file_path, temp_path)
                working_file_path = Path(temp_path)
                is_temp_copy = True
                
                AudioProcessor.embed_artwork(str(working_file_path), active_cover_path)
            
            # Compression decision
            print("DEBUG: Checkpoint B - Compression check 2")
            should_compress, reason = AudioProcessor.should_compress(str(working_file_path))
            final_file_path = working_file_path
            is_compressed_copy = False
            
            if compress and should_compress:
                print("DEBUG: Checkpoint C - Compressing")
                import tempfile
                fd, temp_path = tempfile.mkstemp(suffix=".mp3")
                os.close(fd)
                
                success = AudioProcessor.compress_to_mp3(str(working_file_path), temp_path, bitrate)
                if success:
                    final_file_path = Path(temp_path)
                    is_compressed_copy = True
                    metadata['format'] = 'mp3'
                    metadata['bitrate'] = bitrate
                    
                    # Embed art into the NEW mp3 if we have it
                    if active_cover_path:
                         AudioProcessor.embed_artwork(str(final_file_path), active_cover_path)
            
            # Use temp copy if no compression happened
            if is_temp_copy and not is_compressed_copy:
                 final_file_path = working_file_path

            # Upload
            print("DEBUG: Checkpoint D - Uploading")
            track_id = file_hash
            remote_key = f"tracks/{track_id}.{metadata['format']}"
            
            uploaded = self.storage.upload_file(str(final_file_path), remote_key)
            print(f"DEBUG: Checkpoint E - Upload result: {uploaded}")
            
            # Update metadata with remote URL? No, URL is generated.
            # But we might want size
            metadata['size'] = os.path.getsize(final_file_path)

             # Cleanup temp files
            if is_compressed_copy:
                os.remove(final_file_path)
            
            if is_temp_copy:
                 os.remove(working_file_path)

            # Cleanup fetched cover
            if fetched_cover_path and os.path.exists(fetched_cover_path):
                os.remove(fetched_cover_path)
            
            if not uploaded:
                return None, False

            # Create Track object
            # Validate metadata fields are not None
            title = metadata.get('title', 'Unknown') or 'Unknown'
            artist = metadata.get('artist', 'Unknown') or 'Unknown' 
            album = metadata.get('album', 'Unknown') or 'Unknown'
            
            # Calculate original filename relative to source_root safely
            try:
                orig_name = str(file_path.relative_to(source_root))
            except ValueError:
                orig_name = file_path.name

            track = Track(
                id=track_id,
                title=title,
                artist=artist,
                album=album,
                duration=metadata.get('duration', 0) or 0,
                format=metadata.get('format', 'mp3'),
                bitrate=metadata.get('bitrate', 0) or 0,
                file_size=metadata.get('size', 0) or 0,
                file_hash=file_hash,
                original_filename=orig_name,
                compressed=is_compressed_copy,
                cover_art_key=None,
                is_local=(self.config.provider.value == 'local')
            )
            
            return track, True

        except Exception as e:
            print(f"Failed to process {file_path}: {e}")
            traceback.print_exc()
            return None, False
