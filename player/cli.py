import click
from rich.console import Console
from rich.table import Table
from rich.live import Live
from rich.layout import Layout
from rich.panel import Panel
from rich.text import Text
import time
import sys

# Try to import engine, handle missing libmpv
try:
    from .engine import PlaybackEngine
    MPV_AVAILABLE = True
except OSError:
    MPV_AVAILABLE = False
    
from .library import LibraryManager

console = Console()

@click.group()
def cli():
    """🎵 Cloud Music Player"""
    pass

@cli.command()
def list():
    """List tracks in library."""
    lib = LibraryManager()
    if not lib.sync_library():
        console.print("[red]Failed to sync library (or empty). Run setup-tool upload first.[/red]")
        return
        
    tracks = lib.get_all_tracks()
    if not tracks:
        console.print("[yellow]Library is empty.[/yellow]")
        return
        
    table = Table(title=f"Library ({len(tracks)} tracks)")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Title", style="bold white")
    table.add_column("Artist", style="green")
    table.add_column("Album", style="yellow")
    table.add_column("Duration", style="magenta")
    
    for t in tracks:
        duration = f"{int(t.duration // 60)}:{int(t.duration % 60):02d}"
        table.add_row(t.id[:8], t.title, t.artist, t.album, duration)
        
    console.print(table)

@cli.command()
@click.argument('query', required=False)
def play(query):
    """Play music. Optionally filter by query."""
    if not MPV_AVAILABLE:
        console.print(Panel.fit(
            "[red bold]Missing System Dependency: libmpv[/red bold]\n\n"
            "The music player requires the [cyan]libmpv[/cyan] library to work.\n\n"
            "Please install it:\n"
            "• Ubuntu/Debian: [green]sudo apt install libmpv1[/green]\n"
            "• Fedora: [green]sudo dnf install mpv-libs[/green]\n"
            "• Arch: [green]sudo pacman -S mpv[/green]",
            border_style="red"
        ))
        return

    lib = LibraryManager()
    lib.sync_library()
    tracks = lib.get_all_tracks()
    
    # Filter if query provided
    playlist = tracks
    if query:
        query = query.lower()
        playlist = [t for t in tracks if query in t.title.lower() or query in t.artist.lower()]
        
    if not playlist:
        console.print("[yellow]No matching tracks found.[/yellow]")
        return
        
    # Initialize Engine
    try:
        engine = PlaybackEngine()
    except Exception as e:
        console.print(f"[red]Error initializing player: {e}[/red]")
        return

    # Basic TUI Player Loop
    current_index = 0
    
    while current_index < len(playlist):
        track = playlist[current_index]
        url = lib.get_track_url(track)
        
        console.clear()
        console.print(f"[bold green]▶ Playing: {track.title}[/bold green]")
        console.print(f"[cyan]{track.artist}[/cyan] - [yellow]{track.album}[/yellow]")
        
        engine.play(url, track)
        
        # Interactive Control Loop
        try:
            with Live(refresh_per_second=4) as live:
                while engine.is_playing:
                    # Update Progress
                    curr = engine.get_time()
                    total = engine.get_duration() or track.duration or 1
                    percent = min(100, (curr / total) * 100)
                    
                    status = Text()
                    status.append(f"{int(curr//60)}:{int(curr%60):02d} ", style="cyan")
                    status.append("━" * int(percent/2), style="blue")
                    status.append(" " * (50 - int(percent/2)), style="gray")
                    status.append(f" {int(total//60)}:{int(total%60):02d}", style="cyan")
                    
                    live.update(Panel(status, title="Now Playing"))
                    time.sleep(0.25)
                    
                    # Check auto-advance (engine callback handles logic but we need to break loop)
                    # Note: engine.is_playing is updated by engine callbacks
                    
        except KeyboardInterrupt:
            engine.stop()
            console.print("\n[yellow]Stopped.[/yellow]")
            return
            
        current_index += 1
        
    engine.stop()

@cli.command()
@click.argument('query', required=False)
def download(query):
    """Download tracks for offline use."""
    lib = LibraryManager()
    if not lib.sync_library(): # Try to sync, but if offline, use local
        if not lib.metadata: # if completely empty/fail
             console.print("[red]Cannot sync library. Check internet connection.[/red]")
             return

    tracks = lib.get_all_tracks()
    
    # Filter
    playlist = tracks
    if query:
        query = query.lower()
        playlist = [t for t in tracks if query in t.title.lower() or query in t.artist.lower()]
    
    if not playlist:
        console.print("[yellow]No tracks found to download.[/yellow]")
        return
        
    console.print(f"[bold]Queueing {len(playlist)} tracks for download...[/bold]")
    
    # Simple sequential download for MVP
    # Ideally parallel, but cache logic is simple
    from rich.progress import track as progress_track
    
    success_count = 0
    with Console().status("Downloading...") as status:
        for t in progress_track(playlist, description="Downloading..."):
            try:
                # Force download by requesting URL (CacheManager logic could be exposed better)
                # Currently get_track_url only *checks* cache or returns remote URL.
                # It doesn't auto-download explicitly unless we trigger it.
                # We need a method in LibraryManager or CacheManager to "ensure_cached"
                
                # Adaptation:
                # 1. Get remote URL
                # 2. Download manually using requests/httpx and add_to_cache
                # OR update LibraryManager to handle this.
                
                # Let's add 'ensure_cached' to LibraryManager in next step.
                # For now, placeholder or quick implementation:
                pass 
                
                # Actually, let's implement the logic right here or in library.py
                # Re-using provider download
                if lib.provider and lib.cache:
                    remote_key = f"tracks/{t.id}.{t.format}"
                    # Temp download path
                    import tempfile
                    with tempfile.NamedTemporaryFile(suffix=f".{t.format}", delete=False) as tmp:
                         tmp_path = tmp.name
                    
                    if lib.provider.download_file(remote_key, tmp_path):
                         lib.cache.add_to_cache(t.id, tmp_path, move=True)
                         success_count += 1
                    else:
                         console.print(f"[red]Failed to download {t.title}[/red]")
            except Exception as e:
                console.print(f"[red]Error downloading {t.title}: {e}[/red]")
                
    console.print(f"[green]✓ Downloaded {success_count} tracks.[/green]")

@cli.command()
def cache_status():
    """Show cache usage stats."""
    try:
        from .cache import CacheManager
        cache = CacheManager()
        usage_bytes = cache.get_current_usage()
        
        # Format usage
        if usage_bytes > 1024**3:
            size_str = f"{usage_bytes / 1024**3:.2f} GB"
        else:
            size_str = f"{usage_bytes / 1024**2:.2f} MB"
            
        limit_str = f"{cache.max_size_bytes / 1024**3:.0f} GB"
        
        console.print(Panel.fit(
            f"[bold]Cache Status[/bold]\n\n"
            f"Usage: [green]{size_str}[/green] / {limit_str}\n"
            f"Location: {cache.cache_dir}",
            title=" Offline Storage "
        ))
    except Exception as e:
        console.print(f"[red]Error checking cache: {e}[/red]")

if __name__ == '__main__':
    cli()
