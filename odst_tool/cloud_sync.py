import os
import boto3
import json
from pathlib import Path
from typing import Optional, Dict, List, Any
from botocore.exceptions import ClientError
from .models import LibraryMetadata, Track

class CloudSync:
    """Handles synchronization with Cloudflare R2 bucket."""
    
    def __init__(self, output_dir: Path):
        self.output_dir = output_dir
        self.config = self._load_config()
        self.s3_client = self._init_client()
        
    def _load_config(self) -> Dict[str, str]:
        """
        Load cloud credentials. 
        Prioritizes environment variables (set by Settings UI).
        Fallbacks to reading soundsible/.env if available.
        """
        config = {
            'account_id': os.getenv('R2_ACCOUNT_ID'),
            'access_key': os.getenv('R2_ACCESS_KEY_ID'),
            'secret_key': os.getenv('R2_SECRET_ACCESS_KEY'),
            'bucket': os.getenv('R2_BUCKET_NAME')
        }
        
        # If missing, try to find neighbor project .env
        if not all(config.values()):
            possible_path = Path('../soundsible/.env')
            if possible_path.exists():
                from dotenv import dotenv_values
                env_vals = dotenv_values(possible_path)
                
                # soundsible naming might be slightly different or same.
                # Usually: REPOSITORY_R2_ACCOUNT_ID etc.
                # Based on user context, we might guess or just look for standard R2 keys.
                # For now let's check standard keys.
                if not config['account_id']: config['account_id'] = env_vals.get('R2_ACCOUNT_ID')
                if not config['access_key']: config['access_key'] = env_vals.get('R2_ACCESS_KEY_ID')
                if not config['secret_key']: config['secret_key'] = env_vals.get('R2_SECRET_ACCESS_KEY')
                if not config['bucket']: config['bucket'] = env_vals.get('R2_BUCKET_NAME')

        return config

    def _init_client(self):
        if not all(self.config.values()):
            return None
            
        return boto3.client(
            's3',
            endpoint_url=f"https://{self.config['account_id']}.r2.cloudflarestorage.com",
            aws_access_key_id=self.config['access_key'],
            aws_secret_access_key=self.config['secret_key'],
            region_name='auto'
        )

    def is_configured(self) -> bool:
        return self.s3_client is not None

    def delete_all_remote_files(self, progress_callback=None) -> bool:
        """
        Delete ALL files in the configured bucket.
        WARNING: This is destructive.
        """
        if not self.s3_client: return False
        
        bucket = self.config['bucket']
        
        try:
            # List all objects
            paginator = self.s3_client.get_paginator('list_objects_v2')
            
            for page in paginator.paginate(Bucket=bucket):
                if 'Contents' not in page:
                    continue
                    
                objects_to_delete = [{'Key': obj['Key']} for obj in page['Contents']]
                
                if objects_to_delete:
                    if progress_callback:
                        progress_callback(f"Deleting {len(objects_to_delete)} objects...")
                        
                    self.s3_client.delete_objects(
                        Bucket=bucket,
                        Delete={'Objects': objects_to_delete}
                    )
            
            if progress_callback: progress_callback("Remote bucket cleared.")
            return True
            
        except Exception as e:
            if progress_callback: progress_callback(f"Error clearing bucket: {e}")
            return False

    def upload_file(self, local_path: Path, remote_key: str) -> bool:
        """Upload a single file to R2."""
        if not self.s3_client: return False
        
        try:
            self.s3_client.upload_file(str(local_path), self.config['bucket'], remote_key)
            return True
        except Exception as e:
            print(f"Upload failed for {local_path}: {e}")
            return False

    def sync_library(self, local_library: LibraryMetadata, progress_callback=None, delete_local=False) -> Dict[str, Any]:
        """
        Full sync process:
        1. Fetch remote library.json
        2. Merge: Remote U Local -> New Remote
        3. Identify missing files on Remote
        4. Upload missing files
        5. Push updated library.json
        """
        if not self.s3_client:
            return {"error": "Not configured"}

        bucket = self.config['bucket']
        stats = {'uploaded': 0, 'errors': 0, 'merged': 0, 'deleted': 0}

        # 1. Fetch Remote Library
        remote_lib = None
        try:
            obj = self.s3_client.get_object(Bucket=bucket, Key='library.json')
            remote_data = obj['Body'].read().decode('utf-8')
            remote_lib = LibraryMetadata.from_json(remote_data)
        except ClientError as e:
            if e.response['Error']['Code'] == "NoSuchKey":
                # No remote library, start fresh with local
                pass
            else:
                return {"error": f"Failed to fetch remote library: {e}"}

        # 2. Merge Logic
        # We want to keep all remote tracks and add any local tracks that are new.
        # Track identity is roughly ID.
        
        final_tracks = {}
        
        # Start with remote tracks
        if remote_lib:
            for t in remote_lib.tracks:
                final_tracks[t.id] = t
                
        # Add/Overwrite with Local tracks (Local is authoritative for files we just downloaded)
        # Actually safer to just add if missing to avoid overwriting metadata edits on cloud?
        # User said "UPLOADS this music", implying adding new stuff.
        for t in local_library.tracks:
            if t.id not in final_tracks:
                final_tracks[t.id] = t
                stats['merged'] += 1
            else:
                # Optional: Update metadata if strictly newer?
                # For now, skip if ID exists.
                pass

        merged_list = list(final_tracks.values())
        
        # 3. Upload Missing Files
        # We need to check what files corresponding to 'merged_list' are actually present on R2?
        # CRITICAL FIX: Only add to the final library IF the file actually exists on remote (or was just uploaded).
        # This prevents "Ghost Tracks" (metadata without audio) which cause 404s in players.
        
        tracks_dir = self.output_dir / "tracks"
        validated_tracks = []
        
        if progress_callback: progress_callback("Checking files to upload...")
        
        for track in merged_list:
            remote_path = f"tracks/{track.file_hash}.mp3" 
            local_path = tracks_dir / f"{track.file_hash}.mp3"
            
            exists_on_remote = False
            
            # Check if exists on remote (HeadObject)
            try:
                self.s3_client.head_object(Bucket=bucket, Key=remote_path)
                exists_on_remote = True
            except ClientError:
                # Doesn't exist on remote. Check if we have it locally to upload.
                if local_path.exists():
                     if progress_callback: progress_callback(f"Uploading: {track.artist} - {track.title}")
                     success = self.upload_file(local_path, remote_path)
                     if success:
                        stats['uploaded'] += 1
                        exists_on_remote = True
                     else:
                        stats['errors'] += 1
                else:
                    # We don't have it locally, and it's not on remote.
                    # This track is broken (ghost). Skip it.
                    pass
            
            if exists_on_remote:
                validated_tracks.append(track)
                
                # Delete local file if configured and confirmed on remote
                if delete_local and local_path.exists():
                    try:
                        os.remove(local_path)
                        stats['deleted'] += 1
                        if progress_callback: progress_callback(f"Deleted local: {track.title}")
                    except Exception as e:
                        print(f"Failed to delete {local_path}: {e}")
        
        # 4. Push Updated Library (Only validated tracks)
        new_lib = LibraryMetadata(
            version=1,
            tracks=validated_tracks,
            playlists=remote_lib.playlists if remote_lib else {}, # Keep remote playlists
            settings=remote_lib.settings if remote_lib else {}
        )
        
        try:
            self.s3_client.put_object(
                Bucket=bucket, 
                Key='library.json', 
                Body=new_lib.to_json(),
                ContentType='application/json'
            )
        except Exception as e:
             return {"error": f"Failed to push library.json: {e}"}
             
        stats['total_remote'] = len(validated_tracks)
        return stats
