import sys
from unittest.mock import MagicMock

# 1. Mock Tkinter BEFORE importing gui_app
sys.modules['tkinter'] = MagicMock()
sys.modules['tkinter.ttk'] = MagicMock()
sys.modules['tkinter.messagebox'] = MagicMock()
sys.modules['tkinter.scrolledtext'] = MagicMock()

# 2. Import gui_app (now it should think tkinter exists)
try:
    from gui_app import DownloaderGUI
except SystemExit:
    print("Caught SystemExit! Tkinter mocking failed.")
    sys.exit(1)

# 3. Setup Test
print("Setting up test...")
root = MagicMock()
app = DownloaderGUI(root)

# Mock internals
app.app.downloader = MagicMock()
app.app.library = MagicMock()
app.app.library.to_json.return_value = "{}" # Return valid string
app.cloud = MagicMock()
app.log = MagicMock()
app.btn_download = MagicMock() # Mock button to avoid config error

# --- Test 1: URL Detection ---
print("Test 1: URL Detection")
url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
app.queue = [url]

# Mock return track
mock_track = MagicMock()
mock_track.artist = "Rick"
mock_track.title = "Astley"
app.app.downloader.process_video.return_value = mock_track

# Run
app._download_thread()

# Assert
app.app.downloader.process_video.assert_called_with(url)
print("✅ URL correctly passed to process_video")


# --- Test 2: Direct Audit Sync ---
print("\nTest 2: Direct Cloud Sync")
app.queue = [url]
app.direct_to_cloud_var.get.return_value = True # Enable check
app.cloud.sync_library.return_value = {'uploaded': 1, 'deleted': 1}

app._download_thread()

app.cloud.sync_library.assert_called_with(
    app.app.library, 
    progress_callback=app.log, 
    delete_local=True
)
print("✅ sync_library called with delete_local=True")
print("\nAll Tests Passed!")
