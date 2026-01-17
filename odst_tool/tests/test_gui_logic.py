import threading
import sys
import os
import unittest
from unittest.mock import MagicMock, patch
from gui_app import DownloaderGUI
import tkinter as tk

# Mock Tkinter to avoid display issues
sys.modules['tkinter'] = MagicMock()
sys.modules['tkinter.ttk'] = MagicMock()
sys.modules['tkinter.messagebox'] = MagicMock()
sys.modules['tkinter.scrolledtext'] = MagicMock()

class TestGUI(unittest.TestCase):
    def setUp(self):
        # Setup mock root
        self.root = MagicMock()
        self.app = DownloaderGUI(self.root)
        
        # Mock backend methods
        self.app.app.downloader = MagicMock()
        self.app.app.library = MagicMock()
        self.app.cloud = MagicMock()
        self.app.log = MagicMock()
        
    def test_youtube_url_detection(self):
        """Test if URL triggers process_video instead of process_track."""
        url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        self.app.queue = [url]
        
        # Mock return track
        mock_track = MagicMock()
        mock_track.artist = "Rick"
        mock_track.title = "Astley"
        self.app.app.downloader.process_video.return_value = mock_track
        
        # Run download thread logic directly (bypass threading)
        self.app._download_thread()
        
        self.app.app.downloader.process_video.assert_called_with(url)
        self.app.app.downloader.process_track.assert_not_called()
        print("URL Detection Test Passed")

    def test_direct_cloud_sync(self):
        """Test if sync is triggered with delete_local=True."""
        url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        self.app.queue = [url]
        self.app.direct_to_cloud_var.get.return_value = True # Enable check
        self.app.app.downloader.process_video.return_value = MagicMock()
        self.app.cloud.sync_library.return_value = {'uploaded': 1, 'deleted': 1}
        
        self.app._download_thread()
        
        self.app.cloud.sync_library.assert_called_with(
            self.app.app.library, 
            progress_callback=self.app.log, 
            delete_local=True
        )
        print("Direct Cloud Sync Test Passed")

if __name__ == '__main__':
    unittest.main()
