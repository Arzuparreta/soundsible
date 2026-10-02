"""Pushing the download pool to a Cloudflare R2 bucket."""

import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

import boto3
from botocore.exceptions import ClientError

from shared.models import LibraryMetadata

logger = logging.getLogger(__name__)


class CloudSync:
    """Handles synchronization with Cloudflare R2 bucket."""

    def __init__(self, output_dir: Path):
        self.output_dir = output_dir
        # Saved downloader settings reach the environment through
        # `shared.downloader.settings.export_to_environ`.
        self.config: Dict[str, Optional[str]] = {
            "account_id": os.getenv("R2_ACCOUNT_ID"),
            "access_key": os.getenv("R2_ACCESS_KEY_ID"),
            "secret_key": os.getenv("R2_SECRET_ACCESS_KEY"),
            "bucket": os.getenv("R2_BUCKET_NAME"),
        }
        self.s3_client = self._init_client()

    def _init_client(self):
        if not all(self.config.values()):
            return None
        return boto3.client(
            "s3",
            endpoint_url=f"https://{self.config['account_id']}.r2.cloudflarestorage.com",
            aws_access_key_id=self.config["access_key"],
            aws_secret_access_key=self.config["secret_key"],
            region_name="auto",
        )

    def is_configured(self) -> bool:
        return self.s3_client is not None

    def upload_file(self, local_path: Path, remote_key: str) -> bool:
        """Upload a single file to R2."""
        if not self.s3_client:
            return False
        try:
            self.s3_client.upload_file(str(local_path), self.config["bucket"], remote_key)
            return True
        except Exception as e:
            logger.warning("Upload failed for %s: %s", local_path, e)
            return False

    def sync_library(self, local_library: LibraryMetadata, progress_callback=None) -> Dict[str, Any]:
        """Merge the local library into the bucket's and upload what it lacks.

        Remote tracks are kept as they are; local tracks the bucket does not
        know are added. A track enters the pushed library.json only when its
        file is on the bucket, already or after this upload, so players never
        see metadata without audio.
        """
        if not self.s3_client:
            return {"error": "Not configured"}

        bucket = self.config["bucket"]
        stats: Dict[str, Any] = {"uploaded": 0, "errors": 0, "merged": 0}

        remote_lib = None
        try:
            obj = self.s3_client.get_object(Bucket=bucket, Key="library.json")
            remote_lib = LibraryMetadata.from_json(obj["Body"].read().decode("utf-8"))
        except ClientError as e:
            if e.response["Error"]["Code"] != "NoSuchKey":
                return {"error": f"Failed to fetch remote library: {e}"}

        final_tracks = {t.id: t for t in remote_lib.tracks} if remote_lib else {}
        for track in local_library.tracks:
            if track.id not in final_tracks:
                final_tracks[track.id] = track
                stats["merged"] += 1

        tracks_dir = self.output_dir / "tracks"
        validated_tracks = []
        if progress_callback:
            progress_callback("Checking files to upload...")
        for track in final_tracks.values():
            remote_path = f"tracks/{track.file_hash}.{track.format}"
            local_path = tracks_dir / f"{track.file_hash}.{track.format}"
            try:
                self.s3_client.head_object(Bucket=bucket, Key=remote_path)
                validated_tracks.append(track)
                continue
            except ClientError:
                pass
            if not local_path.exists():
                continue  # Neither here nor there: leave the ghost out.
            if progress_callback:
                progress_callback(f"Uploading: {track.artist} - {track.title}")
            if self.upload_file(local_path, remote_path):
                stats["uploaded"] += 1
                validated_tracks.append(track)
            else:
                stats["errors"] += 1

        new_lib = LibraryMetadata(
            version=1,
            tracks=validated_tracks,
            playlists=remote_lib.playlists if remote_lib else {},
            settings=remote_lib.settings if remote_lib else {},
            podcast_subscriptions=getattr(remote_lib, "podcast_subscriptions", []) if remote_lib else [],
            podcast_episode_cache=getattr(remote_lib, "podcast_episode_cache", {}) if remote_lib else {},
        )
        try:
            self.s3_client.put_object(
                Bucket=bucket,
                Key="library.json",
                Body=new_lib.to_json(),
                ContentType="application/json",
            )
        except Exception as e:
            return {"error": f"Failed to push library.json: {e}"}

        stats["total_remote"] = len(validated_tracks)
        stats["synced_library"] = new_lib
        return stats
