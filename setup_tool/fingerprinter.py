"""
Audio Fingerprinting Utility using AcoustID.
Identifies tracks by audio content rather than filenames/metadata.
"""

import acoustid
import os
from typing import Optional, Dict, Any

# Note: Free API key for soundsible (should eventually be configurable)
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
            # Note: Generate fingerprint and lookup
            # Note: 'Recordings' gives us MBID
            results = acoustid.match(ACOUSTID_API_KEY, file_path, parse=True)
            
            # Note: Pick the best match
            for score, recording_id, title, artist in results:
                if score > 0.5: # Note: 50% Confidence threshold
                    return {
                        'musicbrainz_id': recording_id,
                        'title': title,
                        'artist': artist,
                        'confidence': score
                    }
        except Exception as e:
            # Note: Print(f"fingerprinting error {E}")
            pass
            
        return None
