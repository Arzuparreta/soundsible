"""
Abstract base class for S3-compatible storage providers.

This module defines the interface that all storage providers must implement,
allowing the application to work with Cloudflare R2, Backblaze B2, AWS S3,
or any other S3-compatible storage service.
"""

from abc import ABC, abstractmethod
from typing import Optional, Callable, Dict, Any, List
from dataclasses import dataclass


@dataclass
class UploadProgress:
    """Progress information for file uploads."""
    bytes_uploaded: int
    total_bytes: int
    percentage: float
    file_name: str
    
    def __str__(self) -> str:
        return f"{self.file_name}: {self.percentage:.1f}% ({self.bytes_uploaded}/{self.total_bytes} bytes)"


class S3StorageProvider(ABC):
    """
    Abstract base class for S3-compatible storage providers.
    
    All storage providers (Cloudflare R2, Backblaze B2, AWS S3, etc.) must
    implement this interface to work with the music platform.
    """
    
    @abstractmethod
    def authenticate(self, credentials: Dict[str, str]) -> bool:
        """
        Authenticate with the storage provider.
        
        Args:
            credentials: Dictionary containing authentication credentials
                        (access_key_id, secret_access_key, endpoint, etc.)
        
        Returns:
            True if authentication successful, False otherwise
        """
        pass
    
    @abstractmethod
    def create_bucket(self, bucket_name: str, public: bool = False, 
                     region: Optional[str] = None) -> Dict[str, Any]:
        """
        Create a new storage bucket.
        
        Args:
            bucket_name: Name for the new bucket
            public: Whether bucket should be publicly accessible
            region: Region/location for bucket (provider-specific)
        
        Returns:
            Dictionary with bucket information (endpoint, url, etc.)
        """
        pass
    
    @abstractmethod
    def bucket_exists(self, bucket_name: str) -> bool:
        """
        Check if a bucket exists.
        
        Args:
            bucket_name: Name of bucket to check
            
        Returns:
            True if bucket exists, False otherwise
        """
        pass
    
    @abstractmethod
    def upload_file(self, local_path: str, remote_key: str,
                   metadata: Optional[Dict[str, str]] = None,
                   progress_callback: Optional[Callable[[UploadProgress], None]] = None) -> bool:
        """
        Upload a file to storage.
        
        Args:
            local_path: Path to local file
            remote_key: Key (path) for file in bucket
            metadata: Optional metadata to attach to file
            progress_callback: Optional callback for upload progress
            
        Returns:
            True if upload successful, False otherwise
        """
        pass
    
    @abstractmethod
    def download_file(self, remote_key: str, local_path: str,
                     progress_callback: Optional[Callable[[UploadProgress], None]] = None) -> bool:
        """
        Download a file from storage.
        
        Args:
            remote_key: Key (path) of file in bucket
            local_path: Path where file should be saved
            progress_callback: Optional callback for download progress
            
        Returns:
            True if download successful, False otherwise
        """
        pass
    
    @abstractmethod
    def delete_file(self, remote_key: str) -> bool:
        """
        Delete a file from storage.
        
        Args:
            remote_key: Key (path) of file to delete
            
        Returns:
            True if deletion successful, False otherwise
        """
        pass
    
    @abstractmethod
    def file_exists(self, remote_key: str) -> bool:
        """
        Check if a file exists in storage.
        
        Args:
            remote_key: Key (path) of file to check
            
        Returns:
            True if file exists, False otherwise
        """
        pass
    
    @abstractmethod
    def list_files(self, prefix: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        List files in the bucket.
        
        Args:
            prefix: Optional prefix to filter files
            
        Returns:
            List of dictionaries with file information (key, size, modified, etc.)
        """
        pass
    
    @abstractmethod
    def get_file_url(self, remote_key: str, expires_in: int = 3600) -> str:
        """
        Get a URL for accessing a file.
        
        Args:
            remote_key: Key (path) of file
            expires_in: Expiration time in seconds (for presigned URLs)
            
        Returns:
            URL string for accessing the file
        """
        pass
    
    @abstractmethod
    def get_bucket_size(self) -> int:
        """
        Get total size of all files in bucket.
        
        Returns:
            Total size in bytes
        """
        pass
    
    @abstractmethod
    def upload_json(self, data: str, remote_key: str) -> bool:
        """
        Upload JSON data directly.
        
        Args:
            data: JSON string to upload
            remote_key: Key (path) for the JSON file
            
        Returns:
            True if upload successful, False otherwise
        """
        pass
    
    @abstractmethod
    def download_json(self, remote_key: str) -> Optional[str]:
        """
        Download JSON data directly.
        
        Args:
            remote_key: Key (path) of JSON file
            
        Returns:
            JSON string if successful, None otherwise
        """
        pass

    def get_library(self) -> Any:
        """
        Retrieve library metadata from storage.
        
        Returns:
            LibraryMetadata object
            
        Raises:
            Exception: If library cannot be retrieved due to network/auth errors
        """
        # Do NO try/except here. We want to fail if the download fails.
        # The only allowed failure is "File Not Found" which returns None from download_json.
        
        from shared.constants import LIBRARY_METADATA_FILENAME
        from shared.models import LibraryMetadata
        
        json_str = self.download_json(LIBRARY_METADATA_FILENAME)
        
        if json_str:
            try:
                return LibraryMetadata.from_json(json_str)
            except Exception as e:
                # Corrupt JSON? We should probably stop too, to avoid overwriting a potentially valid file
                # that we just failed to parse.
                raise ValueError(f"Corrupt library.json file: {e}")
        
        # Only return new library if file was explicitly not found (None)
        print("Library not found (new install?), creating fresh one.")
        return LibraryMetadata(version=1, tracks=[], playlists={}, settings={})

    def save_library(self, metadata: Any) -> bool:
        """
        Save library metadata to storage.
        
        Args:
            metadata: LibraryMetadata object
            
        Returns:
            True if successful, False otherwise
        """
        try:
            from shared.constants import LIBRARY_METADATA_FILENAME
            metadata_json = metadata.to_json()
            return self.upload_json(metadata_json, LIBRARY_METADATA_FILENAME)
        except Exception as e:
            print(f"Failed to save library: {e}")
            return False
    
    def calculate_bucket_size(self) -> int:
        """
        Calculate total size of all objects in bucket.
        
        Returns:
            Total size in bytes, or 0 if error
        """
        try:
            total_size = 0
            # List all objects in bucket
            paginator = self.s3_client.get_paginator('list_objects_v2')
            pages = paginator.paginate(Bucket=self.bucket_name)
            
            for page in pages:
                if 'Contents' in page:
                    for obj in page['Contents']:
                        total_size += obj['Size']
            
            return total_size
        except Exception as e:
            print(f"Error calculating bucket size: {e}")
            return 0
