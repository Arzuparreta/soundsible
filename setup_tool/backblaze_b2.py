"""
Backblaze B2 storage provider implementation.

Backblaze B2 offers affordable storage with a simple free tier (no credit card required).
"""

from b2sdk.v2 import B2Api, InMemoryAccountInfo
from typing import Optional, Callable, Dict, Any, List
import os
from .storage_provider import S3StorageProvider, UploadProgress


class BackblazeB2Provider(S3StorageProvider):
    """
    Backblaze B2 storage implementation using b2sdk.
    
    B2 is cost-effective with a generous free tier and simple pricing.
    """
    
    def __init__(self):
        self.api = B2Api(InMemoryAccountInfo())
        self.bucket = None
        self.bucket_name = None
        
    def authenticate(self, credentials: Dict[str, str]) -> bool:
        """
        Authenticate with Backblaze B2.
        
        Args:
            credentials: Must contain:
                - application_key_id: B2 application key ID
                - application_key: B2 application key
                - bucket: Bucket name (optional, can be set later)
        """
        try:
            self.api.authorize_account(
                'production',
                credentials['application_key_id'],
                credentials['application_key']
            )
            
            # Set bucket if provided
            if 'bucket' in credentials:
                self.bucket_name = credentials['bucket']
                self.bucket = self.api.get_bucket_by_name(self.bucket_name)
            
            return True
            
        except (Exception, KeyError) as e:
            print(f"B2 authentication failed: {e}")
            return False
    
    def create_bucket(self, bucket_name: str, public: bool = False,
                     region: Optional[str] = None) -> Dict[str, Any]:
        """Create B2 bucket."""
        try:
            # B2 bucket types: allPrivate, allPublic
            bucket_type = 'allPublic' if public else 'allPrivate'
            
            self.bucket = self.api.create_bucket(
                bucket_name,
                bucket_type,
                bucket_info={},
                cors_rules=[],
                lifecycle_rules=[]
            )
            self.bucket_name = bucket_name
            
            # Get download URL
            auth_info = self.api.account_info
            download_url = auth_info.get_download_url()
            
            return {
                "bucket_name": bucket_name,
                "bucket_id": self.bucket.id_,
                "endpoint": download_url,
                "url": f"{download_url}/file/{bucket_name}",
                "public": public
            }
            
        except Exception as e:
            print(f"Failed to create B2 bucket: {e}")
            raise
    
    def bucket_exists(self, bucket_name: str) -> bool:
        """Check if bucket exists."""
        try:
            self.api.get_bucket_by_name(bucket_name)
            return True
        except Exception:
            return False
    
    def upload_file(self, local_path: str, remote_key: str,
                   metadata: Optional[Dict[str, str]] = None,
                   progress_callback: Optional[Callable[[UploadProgress], None]] = None) -> bool:
        """Upload file to B2."""
        try:
            if not self.bucket:
                raise ValueError("No bucket selected. Call create_bucket or authenticate with bucket name.")
            
            file_size = os.path.getsize(local_path)
            
            # Progress listener
            class ProgressListener:
                def __init__(self, callback, total_bytes, file_name):
                    self.callback = callback
                    self.total_bytes = total_bytes
                    self.file_name = file_name
                
                def __call__(self, bytes_uploaded):
                    if self.callback:
                        self.callback(UploadProgress(
                            bytes_uploaded=bytes_uploaded,
                            total_bytes=self.total_bytes,
                            percentage=(bytes_uploaded / self.total_bytes * 100) if self.total_bytes > 0 else 0,
                            file_name=self.file_name
                        ))
            
            listener = ProgressListener(progress_callback, file_size, os.path.basename(local_path)) if progress_callback else None
            
            # Upload with automatic large file handling
            self.bucket.upload_local_file(
                local_file=local_path,
                file_name=remote_key,
                file_infos=metadata or {},
                progress_listener=listener
            )
            
            return True
            
        except (Exception, FileNotFoundError, ValueError) as e:
            print(f"Upload failed: {e}")
            return False
    
    def download_file(self, remote_key: str, local_path: str,
                     progress_callback: Optional[Callable[[UploadProgress], None]] = None) -> bool:
        """Download file from B2."""
        try:
            if not self.bucket:
                raise ValueError("No bucket selected.")
            
            # Get file info first
            file_version = self.bucket.get_file_info_by_name(remote_key)
            file_size = file_version.size
            
            # Progress listener
            class ProgressListener:
                def __init__(self, callback, total_bytes, file_name):
                    self.callback = callback
                    self.total_bytes = total_bytes
                    self.file_name = file_name
                
                def __call__(self, bytes_downloaded):
                    if self.callback:
                        self.callback(UploadProgress(
                            bytes_uploaded=bytes_downloaded,
                            total_bytes=self.total_bytes,
                            percentage=(bytes_downloaded / self.total_bytes * 100) if self.total_bytes > 0 else 0,
                            file_name=self.file_name
                        ))
            
            listener = ProgressListener(progress_callback, file_size, os.path.basename(remote_key)) if progress_callback else None
            
            self.bucket.download_file_by_name(
                remote_key,
                progress_listener=listener
            ).save_to(local_path)
            
            return True
            
        except Exception as e:
            print(f"Download failed: {e}")
            return False
    
    def delete_file(self, remote_key: str) -> bool:
        """Delete file from B2."""
        try:
            if not self.bucket:
                raise ValueError("No bucket selected.")
            
            file_version = self.bucket.get_file_info_by_name(remote_key)
            self.api.delete_file_version(file_version.id_, remote_key)
            return True
            
        except Exception as e:
            print(f"Delete failed: {e}")
            return False
    
    def file_exists(self, remote_key: str) -> bool:
        """Check if file exists in B2."""
        try:
            if not self.bucket:
                return False
            self.bucket.get_file_info_by_name(remote_key)
            return True
        except Exception:
            return False
    
    def list_files(self, prefix: Optional[str] = None) -> List[Dict[str, Any]]:
        """List files in B2 bucket."""
        try:
            if not self.bucket:
                return []
            
            files = []
            for file_version, _ in self.bucket.ls(folder_to_list=prefix or ''):
                files.append({
                    'key': file_version.file_name,
                    'size': file_version.size,
                    'modified': str(file_version.upload_timestamp),
                    'id': file_version.id_
                })
            
            return files
            
        except Exception as e:
            print(f"List files failed: {e}")
            return []
    
    def get_file_url(self, remote_key: str, expires_in: int = 3600) -> str:
        """Get download URL for file."""
        try:
            if not self.bucket:
                return ""
            
            # B2 presigned URLs
            auth_token = self.api.get_download_authorization(
                self.bucket_name,
                remote_key,
                expires_in
            )
            
            download_url = self.api.account_info.get_download_url()
            url = f"{download_url}/file/{self.bucket_name}/{remote_key}?Authorization={auth_token}"
            return url
            
        except Exception as e:
            print(f"URL generation failed: {e}")
            return ""
    
    def get_bucket_size(self) -> int:
        """Calculate total bucket size."""
        files = self.list_files()
        return sum(f['size'] for f in files)
    
    def upload_json(self, data: str, remote_key: str) -> bool:
        """Upload JSON string directly."""
        try:
            if not self.bucket:
                raise ValueError("No bucket selected.")
            
            data_bytes = data.encode('utf-8')
            self.bucket.upload_bytes(
                data_bytes=data_bytes,
                file_name=remote_key,
                content_type='application/json'
            )
            return True
            
        except Exception as e:
            print(f"JSON upload failed: {e}")
            return False
    
    def download_json(self, remote_key: str) -> Optional[str]:
        """Download JSON string directly."""
        try:
            if not self.bucket:
                return None
            
            download = self.bucket.download_file_by_name(remote_key)
            data_bytes = download.save_to_bytes()
            return data_bytes.decode('utf-8')
            
        except Exception as e:
            print(f"JSON download failed: {e}")
            return None
