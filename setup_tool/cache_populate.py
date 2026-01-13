
"""
Batch process to populate local cover cache without modifying audio files.
"""
import os
import time
import re
from pathlib import Path
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn

from shared.models import PlayerConfig, LibraryMetadata
from shared.constants import DEFAULT_CONFIG_DIR, DEFAULT_LIBRARY_PATH, DEFAULT_CACHE_DIR, LIBRARY_METADATA_FILENAME
from setup_tool.provider_factory import StorageProviderFactory
from setup_tool.metadata import search_itunes, download_image

console = Console()

class CachePopulator:
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
        
        # Setup Cache Dir
        self.covers_dir = os.path.join(os.path.expanduser(DEFAULT_CACHE_DIR), "covers")
        os.makedirs(self.covers_dir, exist_ok=True)
        
    def run(self, force: bool = False):
        console.print(f"[bold]Starting Batch Cache Population[/bold]")
        console.print(f"Cache Directory: [cyan]{self.covers_dir}[/cyan]")
        
        # 1. Load Library
        try:
            with console.status("Downloading library metadata..."):
                json_str = self.provider.download_json(LIBRARY_METADATA_FILENAME)
                if not json_str:
                    console.print("[red]Could not load library from cloud.[/red]")
                    return
                
                library = LibraryMetadata.from_json(json_str)
                console.print(f"Found [bold]{len(library.tracks)}[/bold] tracks in library.")
                
        except Exception as e:
            console.print(f"[red]Error loading library: {e}[/red]")
            return

        updated_count = 0
        skipped_count = 0
        failed_count = 0
        
        # 2. Iterate Tracks
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console
        ) as progress:
            task = progress.add_task("Processing tracks...", total=len(library.tracks))
            
            for track in library.tracks:
                progress.update(task, description=f"Checking: {track.artist} - {track.title}")
                
                cache_path = os.path.join(self.covers_dir, f"{track.id}.jpg")
                
                # Skip if already cached (unless forced)
                if os.path.exists(cache_path) and not force:
                    skipped_count += 1
                    progress.advance(task)
                    continue
                
                # Fetch Logic
                try:
                    # Rate limiting
                    time.sleep(1.0) # Be nice to iTunes
                    
                    found_url = self._find_cover_url(track)
                    
                    if found_url:
                        data = download_image(found_url)
                        if data:
                            with open(cache_path, 'wb') as f:
                                f.write(data)
                            updated_count += 1
                        else:
                            failed_count += 1
                    else:
                        failed_count += 1 # Not found
                        
                except Exception as e:
                    # console.print(f"[red]Error fetching {track.title}: {e}[/red]")
                    failed_count += 1
                
                progress.advance(task)

        console.print("\n[bold green]Batch Population Complete![/bold green]")
        console.print(f"New covers cached: {updated_count}")
        console.print(f"Already cached: {skipped_count}")
        console.print(f"Not found / Failed: {failed_count}")

    def _find_cover_url(self, track):
        # Strategy 1: Artist + Title
        queries = [f"{track.artist} {track.title}"]
        
        # Strategy 2: Cleaned
        clean_query = f"{track.artist} {track.title}"
        clean_query = re.sub(r'(?i)original soundtrack|ost', '', clean_query)
        clean_query = re.sub(r'^\d+\s*[-_.]?\s*', '', clean_query).strip()
        if clean_query != queries[0]:
            queries.append(clean_query)
        
        # Strategy 3: Just Title (if artist is generic)
        if track.artist.lower() in ['unknown', 'unknown artist', 'various artists']:
                queries.append(track.title)

        for q in queries:
            if len(q) < 3: continue
            try:
                results = search_itunes(q, limit=1)
                if results:
                    return results[0]['artwork_url']
                time.sleep(0.5)
            except: pass
            
        return None
