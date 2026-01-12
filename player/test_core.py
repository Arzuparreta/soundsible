"""
Integration tests for Player Core.
"""

from player.engine import PlaybackEngine
from player.library import LibraryManager
import time
import sys

def test_playback():
    print("Initializing Library Manager...")
    lib = LibraryManager()
    
    if not lib.config:
        print("❌ No configuration found. Run 'setup-tool init' first.")
        return
        
    print(f"✓ Config loaded for {lib.config.provider.value}")
    
    print("Syncing library...")
    if lib.sync_library():
        print(f"✓ Library synced: {len(lib.get_all_tracks())} tracks")
    else:
        print("❌ Library sync failed")
        return
        
    tracks = lib.get_all_tracks()
    if not tracks:
        print("No tracks to play.")
        return
        
    target_track = tracks[0]
    print(f"\nSelected Track: {target_track.title} - {target_track.artist}")
    
    url = lib.get_track_url(target_track)
    print(f"Stream URL generated (len={len(url)})")
    
    print("\nInitializing Playback Engine...")
    try:
        engine = PlaybackEngine()
    except OSError as e:
         print(f"❌ Failed to load mpv: {e}")
         print("Make sure libmpv is installed: sudo apt install libmpv1 (Ubuntu/Debian)")
         return

    print("Playing (5 seconds demo)...")
    engine.play(url, target_track)
    
    start_time = time.time()
    while time.time() - start_time < 5:
        # Simple loop to keep main thread alive and show progress
        sys.stdout.write(f"\rTime: {engine.get_time():.1f}s / {engine.get_duration():.1f}s")
        sys.stdout.flush()
        time.sleep(0.5)
        
    print("\nStopping...")
    engine.stop()
    print("✓ Test complete")

if __name__ == "__main__":
    test_playback()
