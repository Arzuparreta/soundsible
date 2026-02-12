"""
Audio Fingerprinting Utility using AcoustID.
Identifies tracks by audio content rather than filenames/metadata.
"""

import acoustid
import os
from typing import Optional, Dict, Any

# Free API key for Soundsible (should eventually be configurable)
ACOUSTID_API_KEY = "8XaI6Z9v"

class AudioFingerprinter:
    @staticmethod
    def identify(file_path: str) -> Optional[Dict[str, Any]]:
        """
        Fingerprint a local file and lookup on AcoustID.
        Returns MusicBrainz info if matched.
        """
        if not os.path.exists(file_path):
            return None
            
        try:
            # Generate fingerprint and lookup
            # 'recordings' gives us MBID
            results = acoustid.match(ACOUSTID_API_KEY, file_path, parse=True)
            
            # Pick the best match
            for score, recording_id, title, artist in results:
                if score > 0.5: # 50% confidence threshold
                    return {
                        'musicbrainz_id': recording_id,
                        'title': title,
                        'artist': artist,
                        'confidence': score
                    }
        except Exception as e:
            # print(f"Fingerprinting error: {e}")
            pass
            
        return None
