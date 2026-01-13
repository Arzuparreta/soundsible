
"""
Batch process to auto-fetch covers for all tracks in the library.
"""
from shared.models import PlayerConfig, LibraryMetadata
from setup_tool.provider_factory import StorageProviderFactory
from setup_tool.audio import AudioProcessor
from setup_tool.metadata import search_itunes, download_image
from setup_tool.uploader import UploadEngine
from shared.constants import DEFAULT_CONFIG_DIR, LIBRARY_METADATA_FILENAME

import os
import json
from pathlib import Path
import tempfile
import shutil
import re
import time


class BatchCoverFixer:
    def __init__(self, config: PlayerConfig):
        self.config = config
        self.provider = StorageProviderFactory.create(self.config.provider)
        # Auth
        creds = {
            'access_key_id': self.config.access_key_id,
            'secret_access_key': self.config.secret_access_key,
            'endpoint': self.config.endpoint
        }
        if self.config.provider.name == 'CLOUDFLARE_R2' and self.config.endpoint:
             try:
                creds['account_id'] = self.config.endpoint.split('//')[1].split('.')[0]
             except: pass
             
        self.provider.authenticate(creds)
        self.provider.bucket_name = self.config.bucket
        
        self.uploader = UploadEngine(self.config)
        
        # Init Cache (try to load)
        try:
            from player.cache import CacheManager
            self.cache = CacheManager()
        except Exception as e:
            print(f"Warning: Could not initialize cache manager: {e}")
            self.cache = None
        
    def run(self, force_all: bool = False):
        print(f"Starting batch cover fix (Force all: {force_all})...")
        
        # 1. Load Library
        try:
            print("Downloading library metadata...")
            json_str = self.provider.download_json(LIBRARY_METADATA_FILENAME)
            if not json_str:
                print("Could not load library.")
                return
            
            library = LibraryMetadata.from_json(json_str)
            print(f"Found {len(library.tracks)} tracks.")
            
        except Exception as e:
            print(f"Error loading library: {e}")
            return

        updated_count = 0
        failed_count = 0
        skipped_count = 0
        
        # 2. Iterate Tracks
        total = len(library.tracks)
        for i, track in enumerate(library.tracks):
            print(f"Processing [{i+1}/{total}]: {track.title} - {track.artist}...")
            
            # Check if needs cover
            # We assume if cover_art_key is None OR track.compressed is True (embedded) we might need to check.
            # But the track model doesn't have a 'has_cover' boolean easily accessible except maybe file size or checking file?
            # Actually, `AudioProcessor` extracts it. 
            # Ideally we check a flag. For now, we trust the user or check if art is missing.
            # If 'force_all' is True, we do it anyway.
            # A good heuristic: if we don't have a specific boolean, we might need to check the file.
            # BUT downloading every file is slow.
            # Let's assume we want to fix ALL tracks or trust `force_all`.
            
            # Optimization: If not force_all, how do we know if it has cover?
            # We can't know without checking file headers.
            # So we only fetch IF we find a new cover online?
            
            # Let's try to fetch a cover regardless, and if found, apply it.
            
            try:
                # Rate Limiting
                time.sleep(1.5)

                # 3. Search for Cover
                # Strategy 1: Raw from metadata (matches GUI behavior)
                queries = [f"{track.artist} {track.title}"]
                
                # Strategy 2: Cleaned
                clean_query = f"{track.artist} {track.title}"
                clean_query = re.sub(r'(?i)original soundtrack|ost', '', clean_query)
                clean_query = re.sub(r'^\d+\s*[-_.]?\s*', '', clean_query).strip()
                if clean_query != queries[0]:
                    queries.append(clean_query)
                
                # Strategy 3: Just Title (if artist is likely generic)
                if track.artist.lower() in ['unknown', 'unknown artist', 'various artists']:
                     queries.append(track.title)

                results = None
                used_query = ""
                
                for q in queries:
                    if len(q) < 3: continue
                    print(f"  Searching cover for: '{q}'")
                    try:
                        results = search_itunes(q, limit=1)
                        if results:
                            used_query = q
                            break
                        time.sleep(0.5) # small delay between retries
                    except Exception as e:
                        print(f"  Search error: {e}")
                
                if not results:
                    print("  No cover found online. Skipping.")
                    skipped_count += 1
                    continue
                    
                cover_url = results[0]['artwork_url']
                print(f"  Found cover: {cover_url}")
                
                # Download cover
                cover_data = download_image(cover_url)
                if not cover_data:
                    print("  Failed to download cover image.")
                    failed_count += 1
                    continue
                
                with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp_cover:
                    tmp_cover.write(cover_data)
                    cover_path = tmp_cover.name
                
                try:
                    # 4. Download Track
                    remote_key = f"tracks/{track.id}.{track.format}"
                    fd, temp_track = tempfile.mkstemp(suffix=f".{track.format}")
                    os.close(fd)
                    
                    print("  Downloading track file...")
                    if self.provider.download_file(remote_key, temp_track):
                        
                        # 5. Embed Art
                        print("  Embedding artwork...")
                        if AudioProcessor.embed_artwork(temp_track, cover_path):
                            
                            # Verify embed worked
                            if not AudioProcessor.extract_cover_art(temp_track):
                                print("  ERROR: Embedding verified failed (no cover found after embed). Skipping.")
                                failed_count += 1
                                continue
                            
                            # 6. Re-upload using UploadEngine logic
                            # We create a fake source root
                            print("  Re-uploading...")
                            # Use uploader's internal process but bypass scanning
                            # We need to manually upload to keep ID if possible?
                            # No, UploadEngine recalculates hash. If we change file (embed art), hash changes -> New ID.
                            # This is desired! We want to replace the old track.
                            
                            source_root = Path(temp_track).parent
                            new_track, uploaded = self.uploader._process_single_file(
                                Path(temp_track),
                                source_root,
                                compress=False, # Don't recompress
                                bitrate=track.bitrate,
                                existing_tracks={}, # Force processing
                                cover_image_path=None, # Already embedded
                                auto_fetch=False
                            )
                            
                            if new_track:
                                # Update Library List
                                # Remove old
                                library.tracks = [t for t in library.tracks if t.id != track.id]
                                # Add new
                                # Try to preserve some old metadata if needed (like added date)? 
                                # library.json track model handles it.
                                
                                # Restore original filename for display if possible
                                new_track.original_filename = track.original_filename
                                
                                library.tracks.append(new_track)
                                
                                # Remove old remote file if ID changed
                                if new_track.id != track.id:
                                    print(f"  Removing old file: {remote_key}")
                                    self.provider.delete_file(remote_key)
                                
                                updated_count += 1
                                print("  ✓ Track updated successfully.")
                                
                                # Add to cache!
                                if self.cache:
                                    print("  Populating local cache...")
                                    self.cache.add_to_cache(new_track.id, temp_track, move=False)

                            else:
                                print("  Upload failed.")
                                failed_count += 1
                        else:
                            print("  Embedding failed (format might not support it).")
                            skipped_count += 1
                    else:
                        print("  Download failed.")
                        failed_count += 1
                        
                    os.remove(temp_track)
                    
                finally:
                    os.remove(cover_path)
                    
                # Save library periodically?
                if updated_count % 5 == 0 and updated_count > 0:
                    print("  Saving library checkpoint...")
                    self.provider.save_library(library)
                    
            except Exception as e:
                print(f"  Error processing track: {e}")
                failed_count += 1

        # Final Save
        print("Saving final library...")
        library.version += 1
        self.provider.save_library(library)
        
        print(f"\nBatch Complete!")
        print(f"Updated: {updated_count}")
        print(f"Skipped: {skipped_count}")
        print(f"Failed: {failed_count}")
