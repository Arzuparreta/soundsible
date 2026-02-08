"""
Cryptography utilities for secure credential storage.

This module provides functions to encrypt and decrypt sensitive data
like cloud storage credentials.
"""

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2
from cryptography.hazmat.backends import default_backend
import base64
import os
from typing import Optional


class CredentialManager:
    """Manager for encrypting/decrypting stored credentials."""
    
    @staticmethod
    def generate_key_from_password(password: str, salt: bytes) -> bytes:
        """
        Derive encryption key from password using PBKDF2.
        
        Args:
            password: User password
            salt: Salt bytes for key derivation
            
        Returns:
            Derived encryption key
        """
        kdf = PBKDF2(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000,
            backend=default_backend()
        )
        key = base64.urlsafe_b64encode(kdf.derive(password.encode()))
        return key
    
    @staticmethod
    def generate_machine_key() -> bytes:
        """
        Generate a machine-specific encryption key.
        
        Uses machine-specific data to create a consistent key without
        requiring user input. Less secure than password-based, but
        convenient for automatic credential storage.
        
        Returns:
            Encryption key
        """
        # Use machine ID and username as password
        try:
            with open('/etc/machine-id', 'r') as f:
                machine_id = f.read().strip()
        except:
            # Fallback for systems without /etc/machine-id
            machine_id = os.getenv('HOSTNAME', 'default-machine')
        
        username = os.getenv('USER', 'default-user')
        password = f"{machine_id}-{username}"
        
        # Use fixed salt (less secure but allows consistent key generation)
        salt = b'soundsible-salt-v1'
        
        return CredentialManager.generate_key_from_password(password, salt)
    
    @staticmethod
    def encrypt(data: str, key: Optional[bytes] = None) -> str:
        """
        Encrypt string data.
        
        Args:
            data: String to encrypt
            key: Encryption key (generates machine key if None)
            
        Returns:
            Base64-encoded encrypted string
        """
        if key is None:
            key = CredentialManager.generate_machine_key()
        
        f = Fernet(key)
        encrypted = f.encrypt(data.encode())
        return base64.urlsafe_b64encode(encrypted).decode()
    
    @staticmethod
    def decrypt(encrypted_data: str, key: Optional[bytes] = None) -> Optional[str]:
        """
        Decrypt encrypted string data.
        
        Args:
            encrypted_data: Base64-encoded encrypted string
            key: Encryption key (generates machine key if None)
            
        Returns:
            Decrypted string, or None if decryption fails
        """
        try:
            if key is None:
                key = CredentialManager.generate_machine_key()
            
            f = Fernet(key)
            encrypted_bytes = base64.urlsafe_b64decode(encrypted_data.encode())
            decrypted = f.decrypt(encrypted_bytes)
            return decrypted.decode()
            
        except Exception as e:
            print(f"Decryption failed: {e}")
            return None
