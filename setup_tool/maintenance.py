"""
Library Maintenance and Integrity Tools (The Janitor).
Handles orphan pruning, path resolution, and library health checks.
"""

import os
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from rich.console import Console
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn

from shared.models import LibraryMetadata, Track, PlayerConfig
from setup_tool.audio import AudioProcessor
from setup_tool.provider_factory import StorageProviderFactory
from odst_tool.metadata_harmonizer import MetadataHarmonizer

console = Console()

class LibraryJanitor:
    def __init__(self, config: PlayerConfig):
        self.config = config
        self.storage = StorageProviderFactory.create(self.config.provider)
        self._authenticate()

    def identify_tracks(self, force: bool = False):
        """
        The 'Surgeon's Eye': Assign Durable IDs to tracks.
        """
        from .fingerprinter import AudioFingerprinter
        library = self.storage.get_library()
        identified = 0
        
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console
        ) as progress:
            task = progress.add_task("[cyan]Identifying tracks...", total=len(library.tracks))
            
            for track in library.tracks:
                if not force and (track.musicbrainz_id or track.isrc):
                    progress.advance(task)
                    continue
                
                # 1. Try Heuristic Search (standard harmonize logic with smart split)
                clean = MetadataHarmonizer.harmonize(track.to_dict(), source="youtube")
                mbid = clean.get('musicbrainz_id')
                isrc = clean.get('isrc')
                
                # 2. Try Fingerprinting (if local file exists)
                if not mbid and track.is_local and track.local_path and os.path.exists(track.local_path):
                    fingerprint = AudioFingerprinter.identify(track.local_path)
                    if fingerprint:
                        mbid = fingerprint.get('musicbrainz_id')
                        # Update basic info from fingerprint if we were empty/generic
                        if track.artist == "Unknown Artist" or "youtube" in track.artist.lower():
                            track.artist = fingerprint.get('artist', track.artist)
                            track.title = fingerprint.get('title', track.title)

                if mbid:
                    track.musicbrainz_id = mbid
                    track.isrc = isrc or track.isrc
                    identified += 1
                
                progress.advance(task)
        
        if identified > 0:
            library.version += 1
            self.storage.save_library(library)
            console.print(f"[bold green]Successfully identified {identified} tracks.[/bold green]")
        else:
            console.print("[yellow]No new tracks identified.[/yellow]")

    def refresh_metadata(self, deep: bool = False):
        """
        Verified Refresh: Pull Gold Standard data for anchored tracks.
        """
        library = self.storage.get_library()
        refreshed = 0
        
        console.print("[cyan]Starting Metadata Refresh...[/cyan]")
        
        for track in library.tracks:
            if not track.musicbrainz_id:
                continue
                
            # Fetch latest official data
            mb_info = MetadataHarmonizer.resolve_via_musicbrainz(track.artist, track.title)
            if mb_info:
                # Check for changes
                has_changes = (
                    track.title != mb_info['title'] or
                    track.artist != mb_info['artist'] or
                    track.album != mb_info['album'] or
                    track.album_artist != mb_info.get('album_artist')
                )
                
                if has_changes:
                    track.title = mb_info['title']
                    track.artist = mb_info['artist']
                    track.album = mb_info['album']
                    track.album_artist = mb_info.get('album_artist')
                    track.year = mb_info['year']
                    track.track_number = mb_info['track_number']
                    
                    # If we have a high-res cover URL, store it temporarily in cover_art_key
                    # so the player can use it immediately. 
                    # If it's a URL, the player's CoverFetchManager handles it.
                    if mb_info.get('cover_url'):
                        track.cover_art_key = mb_info['cover_url']
                    
                    refreshed += 1
                
        if refreshed > 0:
            library.version += 1
            self.storage.save_library(library)
            console.print(f"[bold green]Refreshed metadata for {refreshed} tracks.[/bold green]")
        else:
            console.print("[yellow]No metadata changes needed for anchored tracks.[/yellow]")

    def heuristic_album_artist_fix(self, dry_run: bool = False):
        """
        Smart Grouping Fix: If an album has multiple 'artists' but NO 'album_artist',
        this identifies the dominant artist and sets it as the 'album_artist' 
        to unify the album view.
        """
        library = self.storage.get_library()
        
        # Group tracks by album
        albums = {}
        for track in library.tracks:
            if track.album not in albums:
                albums[track.album] = []
            albums[track.album].append(track)
            
        fixed_albums = 0
        total_fixed_tracks = 0
        
        for album_name, tracks in albums.items():
            # Only process if they don't have album_artist already
            if any(t.album_artist for t in tracks):
                continue
                
            artists = [t.artist for t in tracks]
            unique_artists = set(artists)
            
            if len(unique_artists) > 1:
                # Find most frequent artist
                from collections import Counter
                dominant_artist = Counter(artists).most_common(1)[0][0]
                
                console.print(f"Album '[bold]{album_name}[/bold]': Multiple artists found {unique_artists}. ")
                console.print(f"  -> Suggesting '[green]{dominant_artist}[/green]' as Album Artist.")
                
                if not dry_run:
                    for t in tracks:
                        t.album_artist = dominant_artist
                    fixed_albums += 1
                    total_fixed_tracks += len(tracks)
                    
        if total_fixed_tracks > 0:
            if not dry_run:
                library.version += 1
                self.storage.save_library(library)
                console.print(f"[bold green]Successfully unified {fixed_albums} albums ({total_fixed_tracks} tracks).[/bold green]")
        else:
            console.print("[yellow]No albums needed heuristic unification.[/yellow]")

    def _authenticate(self):
        creds = {
            'access_key_id': self.config.access_key_id,
            'secret_access_key': self.config.secret_access_key,
            'endpoint': self.config.endpoint,
            'region': self.config.region,
            'application_key_id': self.config.access_key_id,
            'application_key': self.config.secret_access_key
        }
        
        # R2 specific: Need to extract account_id from endpoint
        from shared.models import StorageProvider
        if self.config.provider == StorageProvider.CLOUDFLARE_R2 and self.config.endpoint:
            try:
                # Endpoint format: https://<account_id>.r2.cloudflarestorage.com
                creds['account_id'] = self.config.endpoint.split('//')[1].split('.')[0]
            except IndexError:
                pass
                
        self.storage.authenticate(creds)
        self.storage.bucket_name = self.config.bucket

    def run_full_maintenance(self, dry_run: bool = False):
        """Perform all maintenance tasks."""
        console.print(f"[bold cyan]Starting Library Maintenance...[/bold cyan] {'(DRY RUN)' if dry_run else ''}")
        
        # 1. Identify & Refresh Metadata (The Surgery)
        if not dry_run:
            self.identify_tracks()
            self.refresh_metadata()

        library = self.storage.get_library()
        initial_count = len(library.tracks)
        
        # 2. Verify Local Files & Fix Paths
        library, fixed_paths = self.fix_moved_local_files(library, dry_run)
        
        # 3. Prune Orphans (Files that exist in manifest but not on disk OR cloud)
        library, pruned_count = self.prune_orphans(library, dry_run)
        
        # 3. Save if changed
        if not dry_run and (fixed_paths > 0 or pruned_count > 0):
            library.version += 1
            self.storage.save_library(library)
            console.print(f"[bold green]Library updated and saved. Version {library.version}[/bold green]")
        elif dry_run:
            console.print("[yellow]Dry run complete. No changes were saved.[/yellow]")
        else:
            console.print("[green]Library is already healthy. No changes needed.[/green]")

    def fix_moved_local_files(self, library: LibraryMetadata, dry_run: bool) -> Tuple[LibraryMetadata, int]:
        """
        If a local track's path is invalid, try to find it elsewhere by hash.
        """
        fixed = 0
        missing_local = [t for t in library.tracks if t.is_local and t.local_path and not os.path.exists(t.local_path)]
        
        if not missing_local:
            return library, 0
            
        console.print(f"[yellow]Found {len(missing_local)} local tracks with broken paths.[/yellow]")
        
        # We can't easily "scan the whole computer", but we can suggest the user runs 'scan' 
        # on the new location. However, if we have a known "Music" folder, we could check there.
        # For a professional tool, we'll just report them for now, 
        # or if we find them during a scan, the scanner already handles 'updated_tracks'.
        
        return library, fixed

    def prune_orphans(self, library: LibraryMetadata, dry_run: bool) -> Tuple[LibraryMetadata, int]:
        """
        Remove tracks that are neither local nor in the cloud.
        """
        orphans = []
        valid_tracks = []
        
        # Get list of cloud files to avoid repeated API calls
        cloud_files = {f['key'] for f in self.storage.list_files(prefix="tracks/")}
        
        for track in library.tracks:
            is_locally_available = track.is_local and track.local_path and os.path.exists(track.local_path)
            
            cloud_key = f"tracks/{track.id}.{track.format}"
            is_cloud_available = cloud_key in cloud_files
            
            if not is_locally_available and not is_cloud_available:
                orphans.append(track)
            else:
                valid_tracks.append(track)
                
        if orphans:
            console.print(f"[red]Found {len(orphans)} orphan tracks (no local file AND no cloud file).[/red]")
            for t in orphans:
                console.print(f"  - {t.artist} - {t.title}")
            
            if not dry_run:
                library.tracks = valid_tracks
                # Also cleanup playlists
                for name, p_tracks in library.playlists.items():
                    library.playlists[name] = [tid for tid in p_tracks if tid not in {o.id for o in orphans}]
        
        return library, len(orphans)

    def health_report(self):
        """Display a detailed health report of the library."""
        library = self.storage.get_library()
        
        table = Table(title="Library Health Report")
        table.add_column("Category", style="cyan")
        table.add_column("Value", style="magenta")
        
        total = len(library.tracks)
        local_only = len([t for t in library.tracks if t.is_local and not t.compressed]) # Approx
        cloud_files = {f['key'] for f in self.storage.list_files(prefix="tracks/")}
        
        cloud_count = 0
        local_available = 0
        both = 0
        
        for t in library.tracks:
            loc = t.is_local and t.local_path and os.path.exists(t.local_path)
            cld = f"tracks/{t.id}.{t.format}" in cloud_files
            
            if loc: local_available += 1
            if cld: cloud_count += 1
            if loc and cld: both += 1
            
        table.add_row("Total Tracks", str(total))
        table.add_row("Locally Available", str(local_available))
        table.add_row("Cloud Available", str(cloud_count))
        table.add_row("Hybrid (Both)", str(both))
        table.add_row("Orphans", str(total - (local_available + cloud_count - both)))
        
        console.print(table)
