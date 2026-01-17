
import sys
import os
from pathlib import Path

# Add project root needed
sys.path.append(str(Path(__file__).parent))

from shared.models import PlayerConfig, LibraryMetadata, Track, StorageProvider
from shared.constants import DEFAULT_CONFIG_DIR, LIBRARY_METADATA_FILENAME
from setup_tool.provider_factory import StorageProviderFactory
import json
import uuid

def rebuild_library():
    print("Initializing Library Recovery...")
    
    # 1. Load Config
    config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
    if not config_path.exists():
        print("Error: Config not found.")
        return

    with open(config_path, 'r') as f:
        config_data = json.load(f)
    config = PlayerConfig.from_dict(config_data)
    
    # 2. Connect to Storage
    print(f"Connecting to {config.provider.name}...")
    storage = StorageProviderFactory.create(config.provider)
    
    creds = {
        'access_key_id': config.access_key_id,
        'secret_access_key': config.secret_access_key,
        'region': config.region,
        'endpoint': config.endpoint,
        'application_key_id': config.access_key_id, 
        'application_key': config.secret_access_key
    }
    # R2 specific
    if config.provider.name == 'CLOUDFLARE_R2' and config.endpoint:
        try:
             creds['account_id'] = config.endpoint.split('//')[1].split('.')[0]
        except: pass
        
    if not storage.authenticate(creds):
        print("Authentication failed.")
        return
        
    storage.bucket_name = config.bucket
    
    # 3. List All Files
    print("Scanning bucket for audio files...")
    files = storage.list_files(prefix="tracks/")
    
    tracks = []
    print(f"Found {len(files)} files. Processing...")
    
    # FAST MODE: Skip metadata headers to avoid network lag
    s3 = None # getattr(storage, 's3_client', None) 
    
    for i, f in enumerate(files):
        key = f['key']
        if not key.startswith("tracks/"): continue
        if key.endswith(".json"): continue
        
        # simple progress
        if i % 10 == 0:
            print(f"Scanning {i}/{len(files)}: {key} ...")
            
        try:
            head = None
            meta = {}
            # SKIP SLOW FETCH
            # if s3: ... 
            
            filename = os.path.basename(key)
            file_hash = filename.split('.')[0]
            
            # Fast Recovery Defaults
            title = filename.replace('_', ' ').replace('-', ' ').split('.')[0]
            artist = "Unknown Artist"
            album = "Unknown Album"
            
            # Try to handle encoding if needed? boto3 handles usually.
            
            track = Track(
                id=file_hash, 
                title=title, 
                artist=artist,
                album=album,
                duration=int(meta.get('duration', 0)),
                file_hash=file_hash,
                original_filename=filename,
                compressed=meta.get('format') == 'mp3', 
                file_size=f['size'],
                bitrate=int(meta.get('bitrate', 0)),
                format=meta.get('format', filename.split('.')[-1]),
                cover_art_key=None # We assume embedded art or none mostly
            )
            tracks.append(track)
            
        except Exception as e:
            print(f"Skipping {key}: {e}")
            
    print(f"Reconstructed {len(tracks)} tracks from cloud.")
            
    print(f"Reconstructed {len(tracks)} tracks (metadata missing).")
    
    # 4. Save
    print("Saving new library manifest...")
    new_lib = LibraryMetadata(
        version=1,
        tracks=tracks,
        playlists={},
        settings={}
    )
    
    if storage.save_library(new_lib):
        print("✅ Recovery Complete. Library manifest updated.")
        print("⚠ Note: Song titles/artists are lost because they were stored in the JSON.")
        print("⚠ Recommendation: Re-upload your local music folder to restore metadata.")
    else:
        print("❌ Failed to save library.")

if __name__ == "__main__":
    rebuild_library()
