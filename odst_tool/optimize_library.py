import os
import json
import shutil
import subprocess
import argparse
from pathlib import Path
from typing import List, Dict, Any
from .config import DEFAULT_OUTPUT_DIR, LIBRARY_FILENAME, TRACKS_DIR, DEFAULT_BITRATE
from .models import LibraryMetadata, Track
from .audio_utils import AudioProcessor

def optimize_library(library_path: Path, dry_run: bool = False, limit: int = 0, progress_callback=None):
    """
    Iterates through the library, finds tracks with bitrate > 128kbps (approx),
    and re-encodes them to 128kbps.
    """
    def log(msg):
        if progress_callback:
            progress_callback(msg)
        else:
            print(msg)

    log(f"Loading library from {library_path}..." + (" (DRY RUN)" if dry_run else ""))
    
    json_path = library_path / LIBRARY_FILENAME
    if not json_path.exists():
        log("Library not found!")
        return

    try:
        with open(json_path, 'r') as f:
            data = json.load(f)
            library = LibraryMetadata.from_dict(data)
    except Exception as e:
        log(f"Error loading library: {e}")
        return

    tracks_dir = library_path / TRACKS_DIR
    optimized_count = 0
    saved_space = 0
    
    updated_tracks = []
    
    total_tracks = len(library.tracks)
    log(f"Found {total_tracks} tracks. Checking for optimization candidates...")
    
    for i, track in enumerate(library.tracks):
        if limit > 0 and optimized_count >= limit:
            log(f"Limit of {limit} reached.")
            updated_tracks.append(track) # Append the rest? No, we should break and append the rest unmodified
            # Actually if we rebuild list, we must process all
            # So if limit reached, we just skip optimization logic but append track
            updated_tracks.append(track)
            continue

        original_file = tracks_dir / f"{track.file_hash}.mp3"
        
        if not original_file.exists():
            log(f"Warning: File not found for {track.title} ({track.file_hash})")
            updated_tracks.append(track)
            continue
            
        duration, bitrate, size = AudioProcessor.get_audio_details(str(original_file))
        
        # Threshold: if bitrate > 140kbps
        if bitrate > 140:
            log(f"[{i+1}/{total_tracks}] Optimizing: {track.artist} - {track.title} ({bitrate}kbps -> 128kbps)...")
            
            if dry_run:
                # Estimate savings (approx 60% for 320->128)
                est_saving = size * 0.6
                log(f"   -> (Dry Run) Would save approx {est_saving / 1024 / 1024:.2f} MB")
                saved_space += est_saving
                optimized_count += 1
                updated_tracks.append(track)
                continue

            temp_file = tracks_dir / f"temp_{track.file_hash}.mp3"
            
            try:
                cmd = [
                    'ffmpeg', '-y', '-i', str(original_file),
                    '-codec:a', 'libmp3lame', '-b:a', '128k',
                    str(temp_file)
                ]
                subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                
                if temp_file.exists():
                    new_size = os.path.getsize(temp_file)
                    space_diff = size - new_size
                    
                    if space_diff > 0:
                        new_hash = AudioProcessor.calculate_hash(str(temp_file))
                        new_final_path = tracks_dir / f"{new_hash}.mp3"
                        shutil.move(str(temp_file), str(new_final_path))
                        
                        if new_hash != track.file_hash:
                            if original_file.exists(): os.remove(original_file)
                        
                        updated_track = Track(
                            id=new_hash,
                            title=track.title,
                            artist=track.artist,
                            album=track.album,
                            album_artist=track.album_artist,
                            duration=track.duration,
                            file_hash=new_hash,
                            original_filename=track.original_filename,
                            compressed=True,
                            file_size=new_size,
                            bitrate=128,
                            format='mp3',
                            year=track.year,
                            genre=track.genre,
                            track_number=track.track_number,
                            cover_art_key=track.cover_art_key
                        )
                        
                        updated_tracks.append(updated_track)
                        saved_space += space_diff
                        optimized_count += 1
                        log(f"   -> Saved {space_diff / 1024 / 1024:.2f} MB")
                    else:
                        log("   -> No space saved.")
                        if temp_file.exists(): os.remove(temp_file)
                        updated_tracks.append(track)
                else:
                    updated_tracks.append(track)
            except Exception as e:
                log(f"   -> Error: {e}")
                if temp_file.exists(): os.remove(temp_file)
                updated_tracks.append(track)
        else:
            updated_tracks.append(track)

    if dry_run:
        log(f"\nDry Run Complete!")
        log(f"Potential Tracks to Optimize: {optimized_count}")
        log(f"Estimated Space Savings: {saved_space / 1024 / 1024:.2f} MB")
        return

    # Save logic
    if optimized_count > 0:
        library.tracks = updated_tracks
        shutil.copy(json_path, str(json_path) + ".bak")
        with open(json_path, 'w') as f:
            f.write(library.to_json())
        log(f"\nOptimization Complete! Saved {saved_space / 1024 / 1024:.2f} MB")
    else:
        log("\nNo changes needed.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Optimize music library to 128kbps.")
    parser.add_argument("--dry-run", action="store_true", help="Simulate optimization without changes")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of tracks to process")
    args = parser.parse_args()
    
    optimize_library(DEFAULT_OUTPUT_DIR, dry_run=args.dry_run, limit=args.limit)
