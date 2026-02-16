"""
Deep Scanner for Local Music Library.
Recursively scans directories, extracts metadata, and adds tracks to library.json
WITHOUT moving or uploading them.
"""

import os
import concurrent.futures
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeRemainingColumn
from rich.console import Console

from shared.models import LibraryMetadata, Track, PlayerConfig
from shared.constants import LIBRARY_METADATA_FILENAME, DEFAULT_CONFIG_DIR
from setup_tool.audio import AudioProcessor
from setup_tool.provider_factory import StorageProviderFactory

console = Console()

class LibraryScanner:
    def __init__(self, config: Optional[PlayerConfig] = None):
        self.config = config
        self._load_config_if_needed()
        
        # We need a storage provider to Save the library.json
        # Even if we are just scanning local files, the manifest might live in the cloud (for hybrid setup)
        # OR it might live locally if using LocalStorageProvider.
        self.storage = StorageProviderFactory.create(self.config.provider)
        self._authenticate_storage()

    def _load_config_if_needed(self):
        if not self.config:
            try:
                config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
                if config_path.exists():
                    with open(config_path, 'r') as f:
                        import json
                        self.config = PlayerConfig.from_dict(json.load(f))
                else:
                    raise ValueError("Config not found. Please run setup first.")
            except Exception as e:
                console.print(f"[red]Error loading config: {e}[/red]")
                raise

    def _authenticate_storage(self):
        creds = {
            'access_key_id': self.config.access_key_id,
            'secret_access_key': self.config.secret_access_key,
            'region': self.config.region,
            'endpoint': self.config.endpoint,
             # B2 compatibility mappings
            'application_key_id': self.config.access_key_id, 
            'application_key': self.config.secret_access_key
        }
        
        # R2 specific
        if self.config.provider.name == 'CLOUDFLARE_R2' and self.config.endpoint:
             try:
                creds['account_id'] = self.config.endpoint.split('//')[1].split('.')[0]
             except: pass
             
        self.storage.authenticate(creds)
        self.storage.bucket_name = self.config.bucket

    def scan(self, scan_path: str, parallel: int = 4):
        """
        Main entry point for scanning a directory.
        """
        root_path = Path(scan_path).expanduser().resolve()
        if not root_path.exists():
            console.print(f"[red]Directory not found: {root_path}[/red]")
            return

        # 1. Fetch existing library to avoid duplicates
        console.print("[cyan]Fetching existing library manifest...[/cyan]")
        try:
            library = self.storage.get_library()
        except Exception:
            console.print("[yellow]Could not fetch library. Starting fresh.[/yellow]")
            library = LibraryMetadata(1, [], {}, {})

        existing_tracks = {t.file_hash: t for t in library.tracks}
        existing_paths = {t.local_path: t for t in library.tracks if t.local_path}

        # 2. Find all audio files
        audio_files = []
        with console.status(f"[bold green]Scanning {root_path}...[/bold green]"):
            for root, _, filenames in os.walk(root_path):
                for filename in filenames:
                    file_path = Path(root) / filename
                    if AudioProcessor.is_supported_format(str(file_path)):
                        audio_files.append(file_path)

        if not audio_files:
            console.print("[yellow]No audio files found.[/yellow]")
            return

        console.print(f"[green]Found {len(audio_files)} audio files.[/green]")

        # 3. Process files
        new_tracks = []
        updated_tracks = []
        skipped = 0
        
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            TimeRemainingColumn(),
            console=console
        ) as progress:
            task = progress.add_task("[cyan]Processing tracks...", total=len(audio_files))
            
            with concurrent.futures.ThreadPoolExecutor(max_workers=parallel) as executor:
                future_to_file = {
                    executor.submit(self._process_file, f): f 
                    for f in audio_files
                }
                
                for future in concurrent.futures.as_completed(future_to_file):
                    f_path = future_to_file[future]
                    try:
                        track, is_new = future.result()
                        if track:
                            # Check if hash already exists
                            if track.file_hash in existing_tracks:
                                # Track exists, but maybe local path is new/changed?
                                existing = existing_tracks[track.file_hash]
                                if existing.local_path != track.local_path:
                                    existing.local_path = track.local_path
                                    existing.is_local = True
                                    updated_tracks.append(existing)
                                else:
                                    skipped += 1
                            else:
                                new_tracks.append(track)
                    except Exception as e:
                        console.print(f"[red]Error processing {f_path.name}: {e}[/red]")
                    
                    progress.advance(task)

        # 4. Merge and Save
        if not new_tracks and not updated_tracks:
            console.print("[yellow]No changes to library.[/yellow]")
            return

        console.print(f"[green]Adding {len(new_tracks)} new tracks, Updating {len(updated_tracks)} existing paths.[/green]")
        
        # Merge logic
        final_tracks = list(existing_tracks.values())
        final_tracks.extend(new_tracks)
        
        library.tracks = final_tracks
        library.version += 1
        
        console.print("[cyan]Saving updated library manifest...[/cyan]")
        if self.storage.save_library(library):
            console.print("[bold green]Library updated successfully![/bold green]")
        else:
            console.print("[bold red]Failed to save library![/bold red]")

    def _process_file(self, file_path: Path) -> Tuple[Optional[Track], bool]:
        """
        Process a single file: Hash -> Extract Metadata -> Create Track
        Returns (Track, is_new_object)
        """
        try:
            # Hash
            file_hash = AudioProcessor.calculate_hash(str(file_path))
            
            # Metadata
            meta = AudioProcessor.extract_metadata(str(file_path))
            
            # Create Track
            track = Track(
                id=file_hash, # Use hash as ID for local files
                title=meta.get('title', 'Unknown'),
                artist=meta.get('artist', 'Unknown'),
                album=meta.get('album', 'Unknown'),
                album_artist=meta.get('album_artist'),
                duration=meta.get('duration', 0),
                file_hash=file_hash,
                original_filename=file_path.name,
                compressed=False, # We assume local files are "source" quality or explicitly kept
                file_size=file_path.stat().st_size,
                bitrate=meta.get('bitrate', 0),
                format=meta.get('format', 'mp3'),
                cover_art_key=None, # We don't upload cover art for local-only scan yet
                year=meta.get('year'),
                genre=meta.get('genre'),
                track_number=meta.get('track_number'),
                is_local=True,
                local_path=str(file_path.absolute())
            )
            
            return track, True
            
        except Exception as e:
            # console.print(f"Error in worker: {e}")
            return None, False
