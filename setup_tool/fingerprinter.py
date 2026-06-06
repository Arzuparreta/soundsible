"""
Audio Fingerprinting Utility using AcoustID.
Identifies tracks by audio content rather than filenames/metadata.
"""

import logging
import os
from typing import Optional, Dict, Any

ACOUSTID_API_KEY = os.environ.get("SOUNDSIBLE_ACOUSTID_API_KEY", "")

logger = logging.getLogger(__name__)


class AudioFingerprinter:
    @staticmethod
    def identify(file_path: str) -> Optional[Dict[str, Any]]:
        """
        Fingerprint a local file and lookup on AcoustID.
        Returns MusicBrainz info if matched.
        """
        if not ACOUSTID_API_KEY:
            logger.warning("ACOUSTID_API_KEY not set; skipping fingerprinting.")
            return None

        if not os.path.exists(file_path):
            return None

        try:
            import acoustid

            results = acoustid.match(ACOUSTID_API_KEY, file_path, parse=True)

            for score, recording_id, title, artist in results:
                if score > 0.5:
                    return {
                        "musicbrainz_id": recording_id,
                        "title": title,
                        "artist": artist,
                        "confidence": score,
                    }
        except OSError as exc:
            logger.warning("Fingerprinting I/O error for %s: %s", file_path, exc)
        except Exception as exc:
            logger.warning("Fingerprinting error for %s: %s", file_path, exc)

        return None
