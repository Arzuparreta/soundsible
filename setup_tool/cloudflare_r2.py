"""
Cloudflare R2 storage provider implementation.

Cloudflare R2 is S3-compatible and offers zero egress fees, making it ideal
for music streaming use cases.
"""

import boto3
from botocore.exceptions import ClientError, NoCredentialsError
from typing import Optional, Callable, Dict, Any, List
import os
from .storage_provider import S3StorageProvider, UploadProgress


class CloudflareR2Provider(S3StorageProvider):
    """
    Cloudflare R2 storage implementation using boto3 S3 client.
    
    R2 is S3-compatible and provides zero egress costs, making it perfect
    for streaming applications.
    """
    
    def __init__(self):
        self.s3_client = None
        self.bucket_name = None
        self.endpoint_url = None
        self.account_id = None
        
    def authenticate(self, credentials: Dict[str, str]) -> bool:
        """
        Authenticate with Cloudflare R2.
        
        Args:
            credentials: Must contain:
                - access_key_id: R2 access key ID
                - secret_access_key: R2 secret access key
                - account_id: Cloudflare account ID
                - bucket: Bucket name (optional, can be set later)
        """
        try:
            self.account_id = credentials['account_id']
            self.endpoint_url = f"https://{self.account_id}.r2.cloudflarestorage.com"
            self.bucket_name = credentials.get('bucket')
            
            self.s3_client = boto3.client(
                's3',
                endpoint_url=self.endpoint_url,
                aws_access_key_id=credentials['access_key_id'],
                aws_secret_access_key=credentials['secret_access_key'],
                region_name='auto'  # R2 uses 'auto' region
            )
            
            # Test connection by listing buckets
            # Test connection
            try:
                self.s3_client.list_buckets()
            except AttributeError:
                # Fallback if client wasn't created properly
                print(f"DEBUG: s3_client type is {type(self.s3_client)}")
                raise
            except Exception:
                # If list_buckets fails (permissions?), we try to continue if we have a bucket name
                if self.bucket_name:
                    print("Warning: Could not list buckets. Verifying specific bucket access...")
                    self.s3_client.head_bucket(Bucket=self.bucket_name)
                else:
                    raise
            return True
            
        except (ClientError, NoCredentialsError, KeyError) as e:
            print(f"R2 authentication failed: {e}")
            return False

    def list_buckets(self) -> List[Dict[str, Any]]:
        """List all buckets in account."""
        try:
            response = self.s3_client.list_buckets()
            return [{'name': b['Name'], 'creation_date': b['CreationDate']} for b in response.get('Buckets', [])]
        except ClientError as e:
            print(f"Failed to list buckets: {e}")
            return []
    
    def create_bucket(self, bucket_name: str, public: bool = False,
                     region: Optional[str] = None) -> Dict[str, Any]:
        """Create R2 bucket."""
        try:
            # R2 doesn't use regions, always 'auto'
            self.s3_client.create_bucket(Bucket=bucket_name)
            self.bucket_name = bucket_name
            
            # Note: R2 public bucket access must be configured in Cloudflare dashboard
            # The PutBucketPolicy operation is not supported by R2
            # Users can make buckets public via: R2 Dashboard > Bucket > Settings > Public Access
            if public:
                print("\n⚠️  Note: R2 buckets must be made public via Cloudflare dashboard")
                print("   Go to: R2 > Your Bucket > Settings > Enable Public Access")
            
            bucket_url = f"{self.endpoint_url}/{bucket_name}"
            return {
                "bucket_name": bucket_name,
                "endpoint": self.endpoint_url,
                "url": bucket_url,
                "public": public
            }
            
        except ClientError as e:
            print(f"Failed to create R2 bucket: {e}")
            raise
    
    def bucket_exists(self, bucket_name: str) -> bool:
        """Check if bucket exists."""
        try:
            self.s3_client.head_bucket(Bucket=bucket_name)
            return True
        except ClientError:
            return False
    
    def upload_file(self, local_path: str, remote_key: str,
                   metadata: Optional[Dict[str, str]] = None,
                   progress_callback: Optional[Callable[[UploadProgress], None]] = None) -> bool:
        """Upload file to R2."""
        try:
            file_size = os.path.getsize(local_path)
            
            extra_args = {}
            if metadata:
                extra_args['Metadata'] = metadata
            
            # Upload with progress callback
            if progress_callback:
                def progress(bytes_uploaded):
                    progress_callback(UploadProgress(
                        bytes_uploaded=bytes_uploaded,
                        total_bytes=file_size,
                        percentage=(bytes_uploaded / file_size * 100) if file_size > 0 else 0,
                        file_name=os.path.basename(local_path)
                    ))
                
                self.s3_client.upload_file(
                    local_path, self.bucket_name, remote_key,
                    ExtraArgs=extra_args,
                    Callback=progress
                )
            else:
                self.s3_client.upload_file(
                    local_path, self.bucket_name, remote_key,
                    ExtraArgs=extra_args
                )
            
            return True
            
        except (ClientError, FileNotFoundError) as e:
            print(f"Upload failed: {e}")
            return False
    
    def download_file(self, remote_key: str, local_path: str,
                     progress_callback: Optional[Callable[[UploadProgress], None]] = None) -> bool:
        """Download file from R2."""
        try:
            if progress_callback:
                # Get file size first
                response = self.s3_client.head_object(Bucket=self.bucket_name, Key=remote_key)
                file_size = response['ContentLength']
                
                def progress(bytes_downloaded):
                    progress_callback(UploadProgress(
                        bytes_uploaded=bytes_downloaded,
                        total_bytes=file_size,
                        percentage=(bytes_downloaded / file_size * 100) if file_size > 0 else 0,
                        file_name=os.path.basename(remote_key)
                    ))
                
                self.s3_client.download_file(
                    self.bucket_name, remote_key, local_path,
                    Callback=progress
                )
            else:
                self.s3_client.download_file(self.bucket_name, remote_key, local_path)
            
            return True
            
        except ClientError as e:
            print(f"Download failed: {e}")
            return False
    
    def delete_file(self, remote_key: str) -> bool:
        """Delete file from R2."""
        try:
            self.s3_client.delete_object(Bucket=self.bucket_name, Key=remote_key)
            return True
        except ClientError as e:
            print(f"Delete failed: {e}")
            return False
    
    def file_exists(self, remote_key: str) -> bool:
        """Check if file exists in R2."""
        try:
            self.s3_client.head_object(Bucket=self.bucket_name, Key=remote_key)
            return True
        except ClientError:
            return False
    
    def list_files(self, prefix: Optional[str] = None) -> List[Dict[str, Any]]:
        """List files in R2 bucket."""
        try:
            kwargs = {'Bucket': self.bucket_name}
            if prefix:
                kwargs['Prefix'] = prefix
            
            files = []
            paginator = self.s3_client.get_paginator('list_objects_v2')
            
            for page in paginator.paginate(**kwargs):
                if 'Contents' in page:
                    for obj in page['Contents']:
                        files.append({
                            'key': obj['Key'],
                            'size': obj['Size'],
                            'modified': obj['LastModified'].isoformat(),
                            'etag': obj['ETag'].strip('"')
                        })
            
            return files
            
        except ClientError as e:
            print(f"List files failed: {e}")
            return []
    
    def get_file_url(self, remote_key: str, expires_in: int = 3600) -> str:
        """Generate presigned URL for file access."""
        try:
            url = self.s3_client.generate_presigned_url(
                'get_object',
                Params={'Bucket': self.bucket_name, 'Key': remote_key},
                ExpiresIn=expires_in
            )
            return url
        except ClientError as e:
            print(f"URL generation failed: {e}")
            return ""
    
    def get_bucket_size(self) -> int:
        """Calculate total bucket size."""
        files = self.list_files()
        return sum(f['size'] for f in files)
    
    def upload_json(self, data: str, remote_key: str) -> bool:
        """Upload JSON string directly."""
        try:
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=remote_key,
                Body=data.encode('utf-8'),
                ContentType='application/json'
            )
            return True
        except ClientError as e:
            print(f"JSON upload failed: {e}")
            return False
    
    def download_json(self, remote_key: str) -> Optional[str]:
        """Download JSON string directly."""
        try:
            response = self.s3_client.get_object(Bucket=self.bucket_name, Key=remote_key)
            return response['Body'].read().decode('utf-8')
        except ClientError as e:
            print(f"JSON download failed: {e}")
            return None
