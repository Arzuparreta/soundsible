
import sys
import os
from pathlib import Path

# Add project root to path
sys.path.append(os.getcwd())

try:
    from setup_tool.audio import AudioProcessor
    print("Successfully imported AudioProcessor")
except ImportError as e:
    print(f"Import failed: {e}")
    sys.exit(1)

def test_compress():
    test_path = "/tmp/test_song.mp3"
    # Create dummy file
    with open(test_path, 'w') as f:
        f.write("dummy audio content")

    print(f"Testing should_compress on '{test_path}'...")
    try:
        # Test with string
        res = AudioProcessor.should_compress(test_path)
        print(f"Result (str): {res}")
        
        # Test with Path
        res2 = AudioProcessor.should_compress(Path(test_path))
        print(f"Result (Path): {res2}")
        
    except Exception:
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_compress()
