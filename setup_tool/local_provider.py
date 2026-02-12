"""
Local filesystem storage provider.
Implements the S3StorageProvider interface for local storage.
"""

import os
import shutil
import json
from typing import Optional, Callable, Dict, Any, List
from pathlib import Path
from .storage_provider import S3StorageProvider, UploadProgress

class LocalStorageProvider(S3StorageProvider):
    """
    Storage provider that uses the local filesystem.
    Useful for self-hosting on a NAS or local drive.
    """
    
    def __init__(self):
        self.base_path: Optional[Path] = None
        self.bucket_name: Optional[str] = None

    def authenticate(self, credentials: Dict[str, str]) -> bool:
        """
        'Authenticate' by setting the base path.
        In local mode, the 'account_id' or 'endpoint' can be the root directory.
        """
        path = credentials.get('base_path') or credentials.get('endpoint')
        if not path:
            return False
            
        self.base_path = Path(path).expanduser().absolute()
        self.base_path.mkdir(parents=True, exist_ok=True)
        return True

    def create_bucket(self, bucket_name: str, public: bool = False, 
                     region: Optional[str] = None) -> Dict[str, Any]:
        """Create a subdirectory as a bucket."""
        bucket_path = self.base_path / bucket_name
        bucket_path.mkdir(parents=True, exist_ok=True)
        self.bucket_name = bucket_name
        return {
            'endpoint': str(bucket_path),
            'url': f"file://{bucket_path}"
        }

    def bucket_exists(self, bucket_name: str) -> bool:
        return (self.base_path / bucket_name).exists()

    def _get_path(self, remote_key: str) -> Path:
        """Get absolute local path for a remote key."""
        if not self.bucket_name:
            raise ValueError("Bucket not set")
        
        if self.bucket_name in [".", "", "default"]:
            return self.base_path / remote_key
            
        return self.base_path / self.bucket_name / remote_key

    def upload_file(self, local_path: str, remote_key: str,
                   metadata: Optional[Dict[str, str]] = None,
                   progress_callback: Optional[Callable[[UploadProgress], None]] = None) -> bool:
        try:
            dest_path = self._get_path(remote_key)
            
            # Skip if same file
            if Path(local_path).resolve() == dest_path.resolve():
                return True

            dest_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Simple copy
            shutil.copy2(local_path, dest_path)
            
            if progress_callback:
                size = os.path.getsize(local_path)
                progress_callback(UploadProgress(size, size, 100.0, os.path.basename(local_path)))
                
            return True
        except Exception as e:
            print(f"Local upload error: {e}")
            return False

    def download_file(self, remote_key: str, local_path: str,
                     progress_callback: Optional[Callable[[UploadProgress], None]] = None) -> bool:
        try:
            src_path = self._get_path(remote_key)
            if not src_path.exists():
                return False
            
            # Skip if same
            if src_path.resolve() == Path(local_path).resolve():
                return True
                
            shutil.copy2(src_path, local_path)
            return True
        except Exception as e:
            print(f"Local download error: {e}")
            return False

    def delete_file(self, remote_key: str) -> bool:
        try:
            path = self._get_path(remote_key)
            if path.exists():
                os.remove(path)
            return True
        except Exception as e:
            print(f"Local delete error: {e}")
            return False

    def file_exists(self, remote_key: str) -> bool:
        return self._get_path(remote_key).exists()

    def list_files(self, prefix: Optional[str] = None) -> List[Dict[str, Any]]:
        if self.bucket_name in [".", "", "default"]:
            bucket_root = self.base_path
        else:
            bucket_root = self.base_path / self.bucket_name
            
        files = []
        
        search_path = bucket_root
        if prefix:
            search_path = bucket_root / prefix
            
        if not search_path.exists():
            return []

        for root, _, filenames in os.walk(search_path):
            for filename in filenames:
                full_path = Path(root) / filename
                try:
                    rel_path = full_path.relative_to(bucket_root)
                    files.append({
                        'Key': str(rel_path),
                        'Size': full_path.stat().st_size,
                        'LastModified': full_path.stat().st_mtime
                    })
                except ValueError:
                    continue
        return files

    def get_file_url(self, remote_key: str, expires_in: int = 3600) -> str:
        """Return a file:// URL or just the path."""
        path = self._get_path(remote_key)
        return f"file://{path.absolute()}"

    def get_bucket_size(self) -> int:
        if self.bucket_name in [".", "", "default"]:
            bucket_root = self.base_path
        else:
            bucket_root = self.base_path / self.bucket_name
            
        total = 0
        if not bucket_root.exists(): return 0
        for root, _, filenames in os.walk(bucket_root):
            for filename in filenames:
                total += (Path(root) / filename).stat().st_size
        return total

    def upload_json(self, data: str, remote_key: str) -> bool:
        try:
            path = self._get_path(remote_key)
            print(f"DEBUG: Local - Writing JSON to {path}")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data)
            return True
        except Exception as e:
            print(f"Local upload_json error: {e}")
            return False

    def download_json(self, remote_key: str) -> Optional[str]:
        try:
            path = self._get_path(remote_key)
            print(f"DEBUG: Local - Reading JSON from {path}")
            if path.exists():
                return path.read_text()
            print(f"DEBUG: Local - File not found: {path}")
            return None
        except Exception as e:
            print(f"Local download_json error: {e}")
            return None
