
import argparse
import sys
from rich.console import Console
from pathlib import Path

# Add project root needed
sys.path.append(str(Path(__file__).parent))

from odst_tool.smart_downloader import SmartDownloader

console = Console()

def main():
    parser = argparse.ArgumentParser(description="Download and Upload Music")
    parser.add_argument("query", help="Song name or YouTube URL")
    args = parser.parse_args()
    
    # Custom logger for CLI
    def cli_logger(msg, level):
        style = "white"
        if level == "error": style = "red"
        elif level == "warning": style = "yellow"
        elif level == "success": style = "green"
        elif level == "info": style = "cyan"
        console.print(f"[{style}]{msg}[/{style}]")

    app = SmartDownloader()
    app.set_log_callback(cli_logger)
    
    try:
        track = app.process_query(args.query)
        if track:
            console.print(f"[green]Downloaded: {track.title}[/green]")
            app.upload_to_cloud()
        else:
            console.print("[red]Download failed.[/red]")
    except KeyboardInterrupt:
        console.print("\n[yellow]Cancelled.[/yellow]")
    except Exception as e:
         console.print(f"[red]Fatal Error: {e}[/red]")
    finally:
        app.cleanup()

if __name__ == "__main__":
    main()
