#!/usr/bin/env python3
import os
import sys
import argparse
from pathlib import Path
from typing import List, Dict, Any
import concurrent.futures
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeRemainingColumn
from rich.prompt import Prompt, Confirm
from rich.table import Table
from rich.panel import Panel

from .config import DEFAULT_OUTPUT_DIR, DEFAULT_WORKERS, LIBRARY_FILENAME, DEFAULT_COOKIE_BROWSER, DEFAULT_QUALITY
from .models import LibraryMetadata, Track
from .spotify_auth import SpotifyAuth
from .spotify_library import SpotifyLibrary
from .youtube_downloader import YouTubeDownloader
from .cloud_sync import CloudSync
import shutil
import threading
import signal

console = Console()

class SpotifyYouTubeDL:
    def __init__(self, output_dir: Path, workers: int = DEFAULT_WORKERS, skip_auth: bool = False, access_token: str = None, cookie_browser: str = None, quality: str = DEFAULT_QUALITY, client_id=None, client_secret=None, open_browser=None):
        self.output_dir = Path(output_dir)
        self.workers = workers
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # Verbose internal init logging for API bridge debugging
        print(f"DEBUG: ODST init start at {output_dir}")
        
        self.cloud = CloudSync(self.output_dir)
        print("DEBUG: CloudSync ready")
        
        # Load or Init Library
        self.library_path = self.output_dir / LIBRARY_FILENAME
        self.library = self._load_library()
        print("DEBUG: Library loaded")
        
        # Components
        self.spotify = SpotifyLibrary(skip_auth=skip_auth, access_token=access_token, client_id=client_id, client_secret=client_secret, open_browser=open_browser)
        print("DEBUG: Spotify component ready")
        
        self.downloader = YouTubeDownloader(self.output_dir, cookie_browser=cookie_browser, quality=quality)
        print("DEBUG: Downloader component ready")

    def cleanup_temp(self):
        """Cleanup temp directory."""
        temp_dir = self.output_dir / "temp"
        if temp_dir.exists():
            try:
                shutil.rmtree(temp_dir)
                console.print("[green]Temp files cleaned.[/green]")
            except Exception as e:
                console.print(f"[red]Error cleaning temp: {e}[/red]")

    def _load_library(self) -> LibraryMetadata:
        """Load library library.json or create new."""
        if self.library_path.exists():
            try:
                with open(self.library_path, 'r') as f:
                    return LibraryMetadata.from_json(f.read())
            except Exception as e:
                console.print(f"[red]Error loading library.json: {e}[/red]")
                
        # Return new empty library
        return LibraryMetadata(
            version=1,
            tracks=[],
            playlists={},
            settings={}
        )

    def save_library(self):
        """Save library to library.json."""
        with open(self.library_path, 'w') as f:
            f.write(self.library.to_json())

    def clean_library(self):
        """Delete all local and remote library content."""
        if not Confirm.ask("[bold red]WARNING: This will delete ALL songs from Cloud and Local storage. Are you sure?[/bold red]"):
            return

        if not Confirm.ask("[bold red]Really? This cannot be undone.[/bold red]"):
            return
            
        console.print("[bold red]Starting erasure...[/bold red]")
        
        # Cloud
        if self.cloud.is_configured():
            with console.status("Cleaning Remote Bucket..."):
                self.cloud.delete_all_remote_files(progress_callback=console.print)
        else:
            console.print("Cloud not configured, skipping.")
            
        # Local
        tracks_dir = self.output_dir / "tracks"
        if tracks_dir.exists():
            try:
                shutil.rmtree(tracks_dir)
                tracks_dir.mkdir(exist_ok=True)
                console.print("Local tracks cleared.")
            except Exception as e:
                console.print(f"Error clearing local tracks: {e}")
                
        # Library JSON
        if self.library_path.exists():
            try:
                os.remove(self.library_path)
                console.print("library.json deleted.")
            except Exception as e:
                console.print(f"Error deleting library.json: {e}")
                
        # Reset memory
        self.library = self._load_library()
        console.print("[bold green]Library cleaned successfully.[/bold green]")

    def run(self, source: str, playlist_name: str = None, interactive: bool = False):
        """Main execution flow."""
        console.print(Panel(f"[bold green]Spotify to YouTube Downloader[/bold green]\nOutput: {self.output_dir}"))

        # 1. Fetch Tracks from Spotify
        tracks_to_process = self._fetch_spotify_tracks(source, playlist_name, interactive)
        
        if not tracks_to_process:
            console.print("[yellow]No tracks selected. Exiting.[/yellow]")
            return

        console.print(f"[cyan]Found {len(tracks_to_process)} tracks to process.[/cyan]")
        
        # 2. Filter out already downloaded (by naive check? No, we don't have hash yet for new ones)
        # We can only check if we have the ISRC or title/artist match in library?
        # For compatibility/simplicity, we might re-process or check if we can verify existence.
        # Since we hash AFTER download, we can't skip by hash purely from Spotify data.
        # But we can check if `artist - title` is roughly in our library?
        # Let's just process them. Ideally we'd map Spotify ID to library track, but our model doesn't store Spotify ID explicitly in top fields.
        
        # 3. Download Loop
        self._process_download_queue(tracks_to_process)
        
        # 4. Final Save
        self.save_library()
        console.print("[bold green]All Done![/bold green]")

    def _fetch_spotify_tracks(self, source: str, playlist_name: str, interactive: bool) -> List[Dict[str, Any]]:
        """Get list of tracks based on user selection."""
        all_tracks = []
        
        # Check if we have a client
        if not self.spotify.client:
            console.print("[yellow]Warning: No Spotify credentials found.[/yellow]")
            console.print("Cannot fetch Liked Songs, Playlists, or Albums.")
            return []

        with console.status("[bold green]Connecting to Spotify...[/bold green]"):
            user = self.spotify.get_user_profile()
            console.print(f"Logged in as: [bold]{user['display_name']}[/bold]")

        if source == 'liked' or source == 'all':
            with console.status("[bold green]Fetching Liked Songs...[/bold green]"):
                liked = self.spotify.get_all_liked_songs()
                console.print(f"Found {len(liked)} liked songs.")
                all_tracks.extend(liked)

        if source == 'playlists' or source == 'all' or (source == 'playlist' and playlist_name):
            with console.status("[bold green]Fetching Playlists...[/bold green]"):
                playlists = self.spotify.get_user_playlists()
                
            selected_playlists = []
            
            if source == 'all':
                selected_playlists = playlists
            elif playlist_name:
                # Find by name
                matches = [p for p in playlists if p['name'].lower() == playlist_name.lower()]
                selected_playlists = matches
            elif interactive:
                # Show selection menu
                table = Table(title="Your Playlists")
                table.add_column("Index", style="cyan")
                table.add_column("Name", style="green")
                table.add_column("Tracks", style="magenta")
                
                for i, p in enumerate(playlists):
                    table.add_row(str(i+1), p['name'], str(p['tracks']['total']))
                
                console.print(table)
                indices = Prompt.ask("Enter playlist numbers to download (comma separated)", default="all")
                
                if indices == 'all':
                    selected_playlists = playlists
                else:
                    try:
                        idxs = [int(x.strip())-1 for x in indices.split(',')]
                        selected_playlists = [playlists[i] for i in idxs if 0 <= i < len(playlists)]
                    except Exception:
                        console.print("[red]Invalid input[/red]")
            
            # Fetch tracks for selected playlists
            for p in selected_playlists:
                console.print(f"Fetching tracks for playlist: [bold]{p['name']}[/bold]")
                p_tracks = self.spotify.get_playlist_tracks(p['id'])
                all_tracks.extend(p_tracks)
                
                # Create playlist in library metadata
                # We need to map spotify tracks to our library tracks later.
                # For now just collecting tracks.

        if source == 'albums' or source == 'all':
             with console.status("[bold green]Fetching Saved Albums...[/bold green]"):
                album_tracks = self.spotify.get_saved_albums_tracks()
                console.print(f"Found {len(album_tracks)} tracks from saved albums.")
                all_tracks.extend(album_tracks)

        # Unique tracks by ID
        unique_tracks = {}
        for t in all_tracks:
            unique_tracks[t['id']] = t
            
        return list(unique_tracks.values())

    def _process_download_queue(self, spotify_tracks: List[Dict[str, Any]]):
        """Process downloads in parallel."""
        
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            TimeRemainingColumn(),
            console=console
        ) as progress:
            
            task_id = progress.add_task("[cyan]Downloading tracks...", total=len(spotify_tracks))
            
            with concurrent.futures.ThreadPoolExecutor(max_workers=self.workers) as executor:
                # Submit all tasks
                future_to_track = {
                    executor.submit(self._download_single, track): track 
                    for track in spotify_tracks
                }
                
                completed = 0
                for future in concurrent.futures.as_completed(future_to_track):
                    track_data = future_to_track[future]
                    try:
                        result = future.result()
                        if result:
                            # Update library
                            self.library.add_track(result)
                            # Save periodically? Maybe every 10 tracks
                            if completed % 10 == 0:
                                self.save_library()
                    except Exception as e:
                        console.print(f"[red]Error downloading {track_data['name']}: {e}[/red]")
                    
                    completed += 1
                    progress.update(task_id, advance=1)

    def _download_single(self, spotify_track: Dict[str, Any]) -> Optional[Track]:
        """Worker function for single track download."""
        meta = self.spotify.extract_track_metadata(spotify_track)
        
        # Naive check: if we already have a track with this title/artist in library
        # This prevents re-downloading things we already have (if we trust metadata match)
        # For now, let's just attempt download. YouTubeDownloader will verify duration.
        
        return self.downloader.process_track(meta)

def main():
    parser = argparse.ArgumentParser(description="Spotify to YouTube Downloader")
    parser.add_argument("--output", default=DEFAULT_OUTPUT_DIR, help="Output directory")
    parser.add_argument("--source", choices=['all', 'liked', 'playlists', 'playlist', 'albums'], default=None, help="Source to download from")
    parser.add_argument("--playlist-name", help="Name of playlist to download (if source=playlist)")
    parser.add_argument("--interactive", action="store_true", help="Interactive selection mode")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="Number of parallel downloads")
    
    parser.add_argument("--manual", action="store_true", help="Manual input mode (bypass Spotify)")
    parser.add_argument("--test-song", help="Test specific song 'Artist - Title'")
    parser.add_argument("--url", help="Direct YouTube or Spotify URL to download")
    parser.add_argument("--clean-library", action="store_true", help="Delete ALL songs from library (Cloud & Local)")
    
    # Cookie support
    parser.add_argument("--use-cookies", action="store_true", help="Use browser cookies for YouTube auth (default: firefox)")
    
    args = parser.parse_args()
    
    cookie_browser = DEFAULT_COOKIE_BROWSER if args.use_cookies else None
    skip_auth = args.manual or args.test_song is not None or args.clean_library or args.url is not None
    app = SpotifyYouTubeDL(args.output, args.workers, skip_auth=skip_auth, cookie_browser=cookie_browser)
    
    if args.clean_library:
        app.clean_library()
        return

    if args.url:
         # Direct URL download
        console.print(f"[cyan]Processing direct URL: {args.url}[/cyan]")
        track = app.downloader.process_video(args.url)
        
        if track:
            app.library.add_track(track)
            app.save_library()
            console.print(f"[green]Successfully downloaded: {track.artist} - {track.title}[/green]")
        else:
            console.print("[red]Download failed.[/red]")
        return

    if args.manual or args.test_song:
        # Bypass Spotify Auth
        if args.test_song:
            # Create a dummy track object
            parts = args.test_song.split('-')
            artist = parts[0].strip()
            title = parts[1].strip() if len(parts) > 1 else "Unknown"
            
            fake_track = {
                'name': title,
                'artists': [{'name': artist}],
                'album': {'name': 'Test Album', 'release_date': '2024-01-01', 'images': []},
                'duration_ms': 200000, # 3:20
                'id': 'test_id',
                'external_ids': {'isrc': 'TEST12345'},
                'explicit': False,
                'track_number': 1
            }
            
            console.print(f"[yellow]Testing download for: {artist} - {title}[/yellow]")
            track = app.downloader.process_track(app.spotify.extract_track_metadata(fake_track))
            
            if track:
                app.library.add_track(track)
                app.save_library()
                console.print("[green]Test download successful![/green]")
            else:
                console.print("[red]Test download failed.[/red]")
                
    else:
        if not args.source and not args.interactive:
            parser.print_help()
            console.print("\n[red]Error: You must specify --source or --manual[/red]")
            return
            
        app.run(args.source, args.playlist_name, args.interactive)

if __name__ == "__main__":
    main()
