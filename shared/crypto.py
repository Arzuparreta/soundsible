"""
Cryptography utilities for secure credential storage.

This module provides functions to encrypt and decrypt sensitive data
like cloud storage credentials.
"""

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
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
        """
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000,
            backend=default_backend()
        )
        return base64.urlsafe_b64encode(kdf.derive(password.encode()))
    
    @staticmethod
    def generate_machine_key() -> bytes:
        """
        Generate a machine-specific encryption key.
        """
        if os.name == 'nt':
            # Windows: Use COMPUTERNAME and USERNAME
            machine_id = os.getenv('COMPUTERNAME', 'default-windows-machine')
            username = os.getenv('USERNAME', 'default-windows-user')
        else:
            # Linux/Unix
            try:
                with open('/etc/machine-id', 'r') as f:
                    machine_id = f.read().strip()
            except:
                machine_id = os.getenv('HOSTNAME', 'default-machine')
            username = os.getenv('USER', 'default-user')
        
        password = f"{machine_id}-{username}"
        salt = b'soundsible-salt-v1'
        
        return CredentialManager.generate_key_from_password(password, salt)
    
    @staticmethod
    def encrypt(data: str, key: Optional[bytes] = None) -> str:
        """
        Encrypt string data.
        """
        if not data:
            return ""
        if key is None:
            key = CredentialManager.generate_machine_key()
        
        f = Fernet(key)
        return f.encrypt(data.encode()).decode()
    
    @staticmethod
    def decrypt(encrypted_data: str, key: Optional[bytes] = None) -> Optional[str]:
        """
        Decrypt encrypted string data.
        """
        if not encrypted_data:
            return ""
        try:
            if key is None:
                key = CredentialManager.generate_machine_key()
            
            f = Fernet(key)
            return f.decrypt(encrypted_data.encode()).decode()
            
        except Exception as e:
            # print(f"Decryption failed: {e}")
            return None
