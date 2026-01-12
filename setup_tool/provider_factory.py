"""
Factory for creating storage provider instances.

Simplifies provider selection and initialization.
"""

from typing import Optional
from shared.models import StorageProvider
from .storage_provider import S3StorageProvider
from .cloudflare_r2 import CloudflareR2Provider
from .backblaze_b2 import BackblazeB2Provider


class StorageProviderFactory:
    """Factory for creating storage provider instances."""
    
    @staticmethod
    def create(provider_type: StorageProvider) -> S3StorageProvider:
        """
        Create a storage provider instance.
        
        Args:
            provider_type: Type of provider to create
            
        Returns:
            Storage provider instance
            
        Raises:
            ValueError: If provider type is not supported
        """
        if provider_type == StorageProvider.CLOUDFLARE_R2:
            return CloudflareR2Provider()
        
        elif provider_type == StorageProvider.BACKBLAZE_B2:
            return BackblazeB2Provider()
        
        elif provider_type == StorageProvider.AWS_S3:
            # Could implement AWS S3 provider here
            raise NotImplementedError("AWS S3 provider not yet implemented")
        
        elif provider_type == StorageProvider.GENERIC_S3:
            # Could implement generic S3 provider here
            raise NotImplementedError("Generic S3 provider not yet implemented")
        
        else:
            raise ValueError(f"Unknown provider type: {provider_type}")
    
    @staticmethod
    def get_provider_name(provider_type: StorageProvider) -> str:
        """Get human-readable provider name."""
        names = {
            StorageProvider.CLOUDFLARE_R2: "Cloudflare R2",
            StorageProvider.BACKBLAZE_B2: "Backblaze B2",
            StorageProvider.AWS_S3: "Amazon S3",
            StorageProvider.GENERIC_S3: "Generic S3-Compatible"
        }
        return names.get(provider_type, "Unknown")
    
    @staticmethod
    def get_provider_description(provider_type: StorageProvider) -> str:
        """Get detailed provider description."""
        descriptions = {
            StorageProvider.CLOUDFLARE_R2: 
                "Cloudflare R2 - Zero egress fees, 10GB free storage, ideal for streaming",
            StorageProvider.BACKBLAZE_B2:
                "Backblaze B2 - 10GB free storage, no credit card required for free tier",
            StorageProvider.AWS_S3:
                "Amazon S3 - Industry standard, pay-as-you-go pricing",
            StorageProvider.GENERIC_S3:
                "Generic S3-compatible storage (DigitalOcean Spaces, MinIO, etc.)"
        }
        return descriptions.get(provider_type, "Unknown provider")
