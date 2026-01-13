"""
Command-line interface for the music platform setup tool.

Provides guided setup wizard and upload commands using Click framework.
"""

import click
from rich.console import Console
from rich.prompt import Prompt, Confirm
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.panel import Panel
from rich.table import Table
import os
import json
import base64
import zlib
import segno
from pathlib import Path

from shared.models import StorageProvider, PlayerConfig
from shared.constants import DEFAULT_CONFIG_DIR
from .provider_factory import StorageProviderFactory

console = Console()


@click.group()
@click.version_option(version="1.0.0")
def cli():
    """
    🎵 Self-Hosted Music Platform Setup Tool
    
    Upload and manage your music library on cloud storage
    (Cloudflare R2 / Backblaze B2 / Generic S3)
    """
    pass


@cli.command()
@click.option('--guided/--manual', default=True, help='Use guided setup wizard')
@click.option('--provider', type=click.Choice(['r2', 'b2', 's3']), 
              help='Storage provider (r2=Cloudflare, b2=Backblaze, s3=Generic)')
def init(guided, provider):
    """
    Initialize cloud storage and configuration.
    
    Sets up your storage provider credentials, creates a bucket,
    and generates player configuration.
    """
    console.print("\n")
    console.print(Panel.fit(
        "[bold cyan]🎵 Music Platform Setup[/bold cyan]\n\n"
        "This wizard will help you set up cloud storage for your music library.",
        border_style="cyan"
    ))
    console.print("\n")
    
    if guided:
        _guided_setup()
    else:
        if not provider:
            console.print("[red]Error: --provider required in manual mode[/red]")
            return
        _manual_setup(provider)


def _guided_setup():
    """Interactive guided setup wizard."""
    
    # Step 1: Provider Selection
    console.print("[bold]Step 1: Choose Your Storage Provider[/bold]\n")
    
    table = Table(show_header=True, header_style="bold magenta")
    table.add_column("Option", style="cyan", width=8)
    table.add_column("Provider", style="green")
    table.add_column("Free Tier", style="yellow")
    table.add_column("Best For")
    
    table.add_row(
        "[1]",
        "Cloudflare R2",
        "10GB",
        "✨ Streaming (zero bandwidth costs)"
    )
    table.add_row(
        "[2]",
        "Backblaze B2",
        "10GB",
        "💳 Simple (no credit card needed)"
    )
    table.add_row(
        "[3]",
        "Generic S3",
        "Varies",
        "🔧 Advanced users"
    )
    
    console.print(table)
    console.print("\n")
    
    choice = Prompt.ask(
        "Select provider",
        choices=["1", "2", "3"],
        default="1"
    )
    
    provider_map = {
        "1": ("r2", StorageProvider.CLOUDFLARE_R2),
        "2": ("b2", StorageProvider.BACKBLAZE_B2),
        "3": ("s3", StorageProvider.GENERIC_S3)
    }
    
    provider_code, provider_enum = provider_map[choice]
    provider_name = StorageProviderFactory.get_provider_name(provider_enum)
    
    console.print(f"\n[green]✓[/green] Selected: {provider_name}\n")
    
    # Step 2: Provider-specific setup
    if provider_code == "r2":
        credentials = _setup_cloudflare_r2()
    elif provider_code == "b2":
        credentials = _setup_backblaze_b2()
    else:
        credentials = _setup_generic_s3()
    
    if not credentials:
        console.print("[red]Setup cancelled or failed[/red]")
        return
    
    # Step 3: Create bucket
    console.print("\n[bold]Step 3: Create Storage Bucket[/bold]\n")
    
    bucket_name = Prompt.ask(
        "Bucket name",
        default=f"music-{os.getenv('USER', 'library')}"
    )
    
    is_public = Confirm.ask(
        "Make bucket publicly accessible?",
        default=False
    )
    
    # Step 4: Test connection and create bucket
    console.print("\n[bold]Step 4: Connecting to Storage[/bold]\n")
    
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console
    ) as progress:
        task = progress.add_task("Authenticating...", total=None)
        
        try:
            provider = StorageProviderFactory.create(provider_enum)
            
            if not provider.authenticate(credentials):
                console.print("[red]❌ Authentication failed[/red]")
                return
            
            progress.update(task, description="Creating bucket...")
            
            bucket_info = provider.create_bucket(bucket_name, is_public)
            
            progress.update(task, description="✓ Complete!")
        
        except Exception as e:
            console.print(f"[red]❌ Error: {e}[/red]")
            return
    
    console.print(f"\n[green]✓[/green] Bucket created: [cyan]{bucket_name}[/cyan]")
    console.print(f"[green]✓[/green] Endpoint: [cyan]{bucket_info.get('endpoint', 'N/A')}[/cyan]")
    
    # Step 5: Save configuration
    config = PlayerConfig(
        provider=provider_enum,
        endpoint=bucket_info['endpoint'],
        bucket=bucket_name,
        access_key_id=credentials.get('access_key_id', credentials.get('application_key_id', '')),
        secret_access_key=credentials.get('secret_access_key', credentials.get('application_key', '')),
        region=credentials.get('region'),
        public=is_public
    )
    
    config_dir = Path(DEFAULT_CONFIG_DIR).expanduser()
    config_dir.mkdir(parents=True, exist_ok=True)
    config_file = config_dir / "config.json"
    
    # TODO: Encrypt credentials before saving
    with open(config_file, 'w') as f:
        f.write(config.to_json())
    
    console.print(f"\n[green]✓[/green] Configuration saved to: {config_file}")
    
    # Success summary
    console.print("\n")
    console.print(Panel.fit(
        "[bold green]✅ Setup Complete![/bold green]\n\n"
        f"Provider: {provider_name}\n"
        f"Bucket: {bucket_name}\n"
        f"Config: {config_file}\n\n"
        "[cyan]Next steps:[/cyan]\n"
        "• Upload music: [yellow]setup-tool upload /path/to/music[/yellow]\n"
        "• Check status: [yellow]setup-tool status[/yellow]",
        border_style="green"
    ))


def _setup_cloudflare_r2():
    """Guide user through Cloudflare R2 setup."""
    console.print(Panel.fit(
        "[bold]Cloudflare R2 Setup[/bold]\n\n"
        "1. Create a Cloudflare account at: https://dash.cloudflare.com/sign-up\n"
        "2. Navigate to R2 Object Storage\n"
        "3. Create an API token with R2 read/write permissions\n\n"
        "[yellow]You'll need:[/yellow]\n"
        "• Account ID (found in R2 dashboard)\n"
        "• Access Key ID\n"
        "• Secret Access Key",
        border_style="blue"
    ))
    console.print("\n")
    
    account_id = Prompt.ask("Cloudflare Account ID").strip()
    access_key_id = Prompt.ask("Access Key ID").strip()
    secret_access_key = Prompt.ask("Secret Access Key", password=True).strip()
    
    return {
        'account_id': account_id,
        'access_key_id': access_key_id,
        'secret_access_key': secret_access_key
    }


def _setup_backblaze_b2():
    """Guide user through Backblaze B2 setup."""
    console.print(Panel.fit(
        "[bold]Backblaze B2 Setup[/bold]\n\n"
        "1. Create a B2 account at: https://www.backblaze.com/b2/sign-up.html\n"
        "2. Navigate to App Keys\n"
        "3. Create a new application key\n\n"
        "[yellow]You'll need:[/yellow]\n"
        "• Application Key ID (looks like: 000abc123...)\n"
        "• Application Key (shown once when created)",
        border_style="blue"
    ))
    console.print("\n")
    
    application_key_id = Prompt.ask("Application Key ID").strip()
    application_key = Prompt.ask("Application Key", password=True).strip()
    
    return {
        'application_key_id': application_key_id,
        'application_key': application_key,
        'bucket': None  # Will be created later
    }


def _setup_generic_s3():
    """Guide user through generic S3 setup."""
    console.print("[yellow]Generic S3 setup not yet implemented[/yellow]")
    return None


def _manual_setup(provider):
    """Non-interactive setup mode."""
    console.print(f"[yellow]Manual setup for {provider} not yet implemented[/yellow]")
    console.print("[cyan]Tip: Use --guided for interactive setup[/cyan]")


@cli.command()
@click.argument('music_path', type=click.Path(exists=True))
@click.option('--compress/--no-compress', default=True, 
              help='Compress lossless formats (FLAC/WAV) to MP3')
@click.option('--parallel', default=4, type=click.IntRange(1, 8),
              help='Number of parallel upload threads')
@click.option('--bitrate', default=320, type=click.IntRange(128, 320),
              help='MP3 bitrate for compression (kbps)')
@click.option('--auto-fetch/--no-auto-fetch', default=False,
              help='Automatically fetch and embed covers for tracks with missing art')
def upload(music_path, compress, parallel, bitrate, auto_fetch):
    """
    Upload music files from a directory.
    
    Scans the directory for audio files, extracts metadata,
    optionally compresses them, and uploads to cloud storage.
    """
    from .uploader import UploadEngine
    
    # Load config
    config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
    if not config_path.exists():
        console.print("[red]Error: Configuration not found. Run 'init' first.[/red]")
        return
        
    try:
        with open(config_path, 'r') as f:
            config_data = json.load(f)
        config = PlayerConfig.from_dict(config_data)
    except Exception as e:
        console.print(f"[red]Error loading config: {e}[/red]")
        return

    console.print(f"\n[bold green]Starting Upload[/bold green]")
    console.print(f"Source: [cyan]{music_path}[/cyan]")
    console.print(f"Options: parallel={parallel}, compress={compress}, bitrate={bitrate}k\n")

    try:
        uploader = UploadEngine(config)
        
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console
        ) as progress:
            library = uploader.run(music_path, compress=compress, parallel=parallel, bitrate=bitrate, 
                                 auto_fetch=auto_fetch, progress=progress)
            
        if library:
            console.print(f"\n[green]✅ Upload Complete![/green]")
            console.print(f"Total tracks in library: [bold]{len(library.tracks)}[/bold]")
            console.print(f"Metadata synced to: [cyan]{LIBRARY_METADATA_FILENAME}[/cyan]")
        else:
            console.print("\n[yellow]No tracks found or uploaded.[/yellow]")
            
    except Exception as e:
        console.print(f"\n[red]❌ Upload failed: {e}[/red]")


@cli.command()
def status():
    """
    Show storage status and library information.
    
    Displays bucket usage, number of tracks, and last sync time.
    """
    console.print(f"\n[yellow]Status command not yet implemented[/yellow]")


@cli.command()
@click.option('--format', type=click.Choice(['qr', 'token']), default='qr',
              help='Output format for configuration')
def export_config(format):
    """
    Export player configuration for multi-device setup.
    
    Generates a QR code or Token that can be imported on other devices.
    """
    config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
    if not config_path.exists():
        console.print("[red]Error: Configuration not found. Run 'init' first.[/red]")
        return
        
    try:
        with open(config_path, 'r') as f:
            config_data = json.load(f)
            
        # Security Note: This exports creds! Warning needed.
        console.print(Panel.fit(
            "[bold red]⚠️  SECURITY WARNING ⚠️[/bold red]\n\n"
            "This export contains your Storage Credentials.\n"
            "Do not share this QR code or Token publicly.",
            border_style="red"
        ))
        
        # Encode
        json_bytes = json.dumps(config_data).encode('utf-8')
        compressed = zlib.compress(json_bytes)
        token = base64.urlsafe_b64encode(compressed).decode('utf-8')
        
        if format == 'token':
            console.print("\n[bold green]Copy this token to your other device:[/bold green]\n")
            console.print(f"[cyan]{token}[/cyan]")
            console.print("\nRun on new device: [yellow]setup-tool import-config <token>[/yellow]")
            
        elif format == 'qr':
            qr = segno.make(token)
            console.print("\n[bold]Scan this on your mobile device:[/bold]\n")
            try:
                print("\n")
                qr.terminal(compact=True)
                print("\n")
            except Exception as e:
                console.print(f"[yellow]Could not display QR in terminal: {e}[/yellow]")
                console.print(f"Token: {token}")

    except Exception as e:
        console.print(f"[red]Export failed: {e}[/red]")

@cli.command()
@click.argument('token')
def import_config(token):
    """
    Import configuration from another device.
    """
    try:
        compressed = base64.urlsafe_b64decode(token)
        json_bytes = zlib.decompress(compressed)
        config_data = json.loads(json_bytes.decode('utf-8'))
    except Exception:
        console.print("[red]Invalid token.[/red]")
        return
        
    # Validate basics
    required = ['provider', 'bucket']
    if not all(k in config_data for k in required):
         console.print("[red]Invalid configuration data.[/red]")
         return
         
    # Save
    config_dir = Path(DEFAULT_CONFIG_DIR).expanduser()
    config_dir.mkdir(parents=True, exist_ok=True)
    config_file = config_dir / "config.json"
    
    # Overwrite check?
    if config_file.exists():
        if not Confirm.ask("Existing configuration found. Overwrite?"):
            return

    with open(config_file, 'w') as f:
        json.dump(config_data, f, indent=4)
        
    console.print(f"\n[green]✅ Configuration imported successfully![/green]")
    console.print(f"Provider: {config_data.get('provider')}")
    console.print(f"Bucket: {config_data.get('bucket')}")


@cli.command()
@click.option('--port', default=5000, help='Port to run web interface on')
@click.option('--debug/--no-debug', default=False, help='Run in debug mode')
def web(port, debug):
    """
    Launch the web interface.
    
    Starts a local web server for graphical upload management.
    """
    try:
        from .web import start_server
        console.print(f"[green]Starting web interface at http://localhost:{port}[/green]")
        console.print("[yellow]Press Ctrl+C to stop[/yellow]")
        start_server(debug=debug, port=port)
    except ImportError as e:
        console.print(f"[red]Error starting web server: {e}[/red]")
        console.print("Make sure flask and flask-socketio are installed.")

@cli.command()
@click.option('--force', is_flag=True, help='Force check covers for all tracks (even if seemingly fine)')
def fix_library_covers(force):
    """
    [Advanced] Embed covers into audio files and re-upload.
    
    This command modifies your actual files. It scans the library, finds tracks with missing covers,
    downloads artwork, embeds it into the MP3/FLAC tags, and re-uploads the file to cloud storage.
    Use this if you want covers to be permanently part of the file (e.g. for other players).
    """
    from .batch_fix import BatchCoverFixer
    
    # Load config
    config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
    if not config_path.exists():
        console.print("[red]Error: Configuration not found. Run 'init' first.[/red]")
        return
        
    try:
        with open(config_path, 'r') as f:
            config_data = json.load(f)
        config = PlayerConfig.from_dict(config_data)
    except Exception as e:
        console.print(f"[red]Error loading config: {e}[/red]")
        return
    
    try:
        fixer = BatchCoverFixer(config)
        fixer.run(force_all=force)
    except Exception as e:
        console.print(f"[red]Batch process failed: {e}[/red]")

@cli.command()
@click.option('--force', is_flag=True, help='Re-download covers even if they exist in cache')
def fetch_missing_covers(force):
    """
    [Recommended] Download missing covers to local cache.
    
    This command DOES NOT modify your audio files. It simply scans your library and
    downloads missing cover art to your local computer's cache (~/.cache/sh-music-hub/covers/).
    This is fast and safe.
    Downloads cover art for all tracks in the library and saves them
    locally to ~/.cache/sh-music-hub/covers/.
    """
    from .cache_populate import CachePopulator
    
    # Load config
    config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
    if not config_path.exists():
        console.print("[red]Error: Configuration not found. Run 'init' first.[/red]")
        return
        
    try:
        with open(config_path, 'r') as f:
            config_data = json.load(f)
        config = PlayerConfig.from_dict(config_data)
    except Exception as e:
        console.print(f"[red]Error loading config: {e}[/red]")
        return
    
    try:
        populator = CachePopulator(config)
        populator.run(force=force)
    except Exception as e:
        console.print(f"[red]Populate failed: {e}[/red]")


if __name__ == '__main__':
    cli()
