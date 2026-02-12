import os
import shutil
from pathlib import Path
from typing import Optional, Dict, Any, List
import yt_dlp
from .config import (
    DEFAULT_OUTPUT_DIR,
    SEARCH_STRATEGY_PRIMARY,
    SEARCH_STRATEGY_FALLBACK,
    DURATION_TOLERANCE_SEC,
    DEFAULT_BITRATE,
    DEFAULT_QUALITY,
    QUALITY_PROFILES,
    TRACKS_DIR,
    MATCH_THRESHOLD_TITLE,
    FORBIDDEN_KEYWORDS
)
import difflib
from .audio_utils import AudioProcessor
from .models import Track
from .metadata_harmonizer import MetadataHarmonizer

class YouTubeDownloader:
    """Handles searching and downloading from YouTube."""
    
    def __init__(self, output_dir: Path = DEFAULT_OUTPUT_DIR, cookie_browser: Optional[str] = None, cookie_file: Optional[str] = None, quality: str = DEFAULT_QUALITY):
        self.output_dir = output_dir
        self.tracks_dir = output_dir / TRACKS_DIR
        self.tracks_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir = output_dir / "temp"
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.cookie_browser = cookie_browser
        self.cookie_file = cookie_file
        self.quality = quality

    def process_track(self, spotify_metadata: Dict[str, Any]) -> Optional[Track]:
        """
        Full workflow for a single track: Search -> Download -> Process -> Return Track
        """
        # 1. Harmonize Spotify metadata (Standardize source)
        clean_metadata = MetadataHarmonizer.harmonize(spotify_metadata, source="spotify")
        
        # 2. Search for video
        video_info = self._search_youtube(clean_metadata)
        
        if not video_info:
            return None
            
        # Rate Limit Protection: Sleep random amount
        import time
        import random
        from .config import DOWNLOAD_DELAY_RANGE
        time.sleep(random.uniform(*DOWNLOAD_DELAY_RANGE))
            
        # 3. Download audio
        url = video_info.get('webpage_url') or video_info.get('url')
        temp_file = self._download_audio(url)
        
        if not temp_file:
            return None
            
        try:
            # 4. Process file (Hash, Metadata, Move)
            file_hash = AudioProcessor.calculate_hash(str(temp_file))
            extension = temp_file.suffix[1:]
            final_path = self.tracks_dir / f"{file_hash}.{extension}"
            
            # Embed metadata (using clean version)
            AudioProcessor.embed_metadata(
                str(temp_file), 
                clean_metadata, 
                clean_metadata.get('album_art_url')
            )
            
            # Verify audio details
            duration, bitrate, size = AudioProcessor.get_audio_details(str(temp_file))
            
            # Move to final location (renaming to hash)
            shutil.move(str(temp_file), str(final_path))
            
            # 5. Create Track Object
            track = Track(
                id=file_hash,
                title=clean_metadata['title'],
                artist=clean_metadata['artist'],
                album=clean_metadata['album'],
                duration=duration if duration > 0 else clean_metadata['duration_sec'],
                file_hash=file_hash,
                original_filename=f"{clean_metadata['artist']} - {clean_metadata['title']}.{extension}",
                compressed=(self.quality != 'ultra'),
                file_size=size,
                bitrate=bitrate,
                format=extension,
                year=clean_metadata.get('year'),
                genre=None,
                track_number=clean_metadata.get('track_number'),
                is_local=True
            )
            
            return track
            
        except Exception as e:
            print(f"Error processing downloaded file {spotify_metadata['title']}: {e}")
            if temp_file.exists():
                os.remove(temp_file)
            return None

    def process_video(self, url: str) -> Optional[Track]:
        """
        Process a direct YouTube URL.
        1. Fetch metadata
        2. Download
        3. Process & Return Track
        """
        try:
            # 1. Fetch Video Info
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': False, # Need full info
            }
            if self.cookie_file and os.path.exists(self.cookie_file):
                ydl_opts['cookiefile'] = self.cookie_file
            elif self.cookie_browser:
                ydl_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                
            if not info:
                print("Could not fetch video info.")
                return None

            # Parse Metadata
            video_id = info.get('id')
            video_title = info.get('title', 'Unknown Title')
            uploader = info.get('uploader', 'Unknown Artist')
            duration = info.get('duration', 0)
            
            # Use YT-DLP's specific fields if available (YouTube Music)
            artist = info.get('artist') or uploader
            title = info.get('track') or video_title
            album = info.get('album')
            
            # Initial raw dict
            raw_meta = {
                'title': title,
                'artist': artist,
                'album': album,
                'album_art_url': MetadataHarmonizer.get_best_yt_thumbnail(video_id) if video_id else info.get('thumbnail'),
                'duration_sec': duration,
                'release_date': info.get('upload_date'),
                'track_number': info.get('track_number', 1)
            }
            
            # Harmonize (Standardize + MusicBrainz lookup)
            clean_meta = MetadataHarmonizer.harmonize(raw_meta, source="youtube")
            
            # 2. Download
            temp_file = self._download_audio(url)
            
            if not temp_file:
                return None
                
            # 3. Process
            # Reuse logic from process_track but without strict spotify match checks?
            # Actually we can just manually do the processing here to avoid 'process_track's search logic.
            
            file_hash = AudioProcessor.calculate_hash(str(temp_file))
            extension = temp_file.suffix[1:]
            final_path = self.tracks_dir / f"{file_hash}.{extension}"
            
            # Embed metadata
            AudioProcessor.embed_metadata(
                str(temp_file), 
                clean_meta, 
                clean_meta.get('album_art_url')
            )
            
            # Verify audio details
            duration, bitrate, size = AudioProcessor.get_audio_details(str(temp_file))
            
            # Move
            shutil.move(str(temp_file), str(final_path))
            
            # Create Track
            track = Track(
                id=file_hash, 
                title=clean_meta['title'],
                artist=clean_meta['artist'],
                album=clean_meta['album'],
                duration=duration if duration > 0 else clean_meta['duration_sec'],
                file_hash=file_hash,
                original_filename=f"{clean_meta['artist']} - {clean_meta['title']}.{extension}",
                compressed=(self.quality != 'ultra'),
                file_size=size,
                bitrate=bitrate,
                format=extension,
                year=clean_meta.get('year'),
                genre=None,
                track_number=clean_meta.get('track_number'),
                is_local=True
            )
            
            return track

        except Exception as e:
            print(f"Error processing video {url}: {e}")
            return None

    def _search_youtube(self, metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Search YouTube using configured strategies.
        Returns video info dict or None.
        """
        queries = []
        
        # Strategy 1: Topic search (Artist - Title official audio)
        q1 = SEARCH_STRATEGY_PRIMARY.format(
            artist=metadata['artist'], 
            title=metadata['title']
        )
        queries.append(q1)
        
        # Strategy 2: Fallback (Artist - Title)
        q2 = SEARCH_STRATEGY_FALLBACK.format(
            artist=metadata['artist'], 
            title=metadata['title']
        )
        queries.append(q2)
        
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True, # Don't download, just get info
            'extractor_args': {
                'youtube': {
                    'player_client': ['android', 'ios', 'web'], # Try mobile clients first
                }
            }
        }
        
        if self.cookie_file and os.path.exists(self.cookie_file):
            ydl_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            ydl_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            for query in queries:
                try:
                    # Search 5 results
                    results = ydl.extract_info(f"ytsearch5:{query}", download=False)
                    if not results or 'entries' not in results:
                        continue
                        
                    best_match = None
                    highest_score = 0
                    
                    for entry in results['entries']:
                        if not entry: continue
                        
                        is_valid, score = self._is_valid_match(entry, metadata)
                        
                        if is_valid:
                            if score > highest_score:
                                highest_score = score
                                best_match = entry
                    
                    if best_match:
                        print(f"Found match: {best_match.get('title')} (Score: {highest_score:.2f})")
                        return best_match
                        
                except Exception as e:
                    print(f"Search error for {query}: {e}")
                    continue
                    
        return None

    def _is_valid_match(self, video_info: Dict[str, Any], metadata: Dict[str, Any]) -> tuple[bool, float]:
        """
        Check if a video is a valid match for the requested metadata.
        Returns (is_valid, confidence_score)
        """
        title = video_info.get('title', '')
        channel = video_info.get('channel', '') or video_info.get('uploader', '')
        duration = video_info.get('duration', 0)
        
        # 1. Duration Check
        target_duration = metadata['duration_sec']
        if target_duration > 0:
            diff = abs(duration - target_duration)
            if diff > DURATION_TOLERANCE_SEC:
                # print(f"Skipping '{title}': Duration diff {diff}s > {DURATION_TOLERANCE_SEC}s")
                return False, 0.0
        
        # 2. Keyword Exclusion (Strict Filter)
        title_lower = title.lower()
        target_title_lower = metadata['title'].lower()
        
        # Only check for forbidden keywords if the original title doesn't contain them
        # (e.g. if I want a "Live" version, don't filter out "Live")
        for keyword in FORBIDDEN_KEYWORDS:
            if keyword in title_lower and keyword not in target_title_lower:
                # print(f"Skipping '{title}': Contains forbidden keyword '{keyword}'")
                return False, 0.0

        # 3. Fuzzy Title Matching
        # We check similarity between Video Title and "Artist - Title" AND "Title"
        # Often video title is "Artist - Song Name"
        
        artist_title = f"{metadata['artist']} - {metadata['title']}"
        
        sim_full = self._calculate_similarity(title_lower, artist_title.lower())
        sim_title = self._calculate_similarity(title_lower, target_title_lower)
        
        # Take the better match
        similarity = max(sim_full, sim_title)
        
        if similarity < MATCH_THRESHOLD_TITLE:
            # print(f"Skipping '{title}': Similarity {similarity:.2f} < {MATCH_THRESHOLD_TITLE}")
            return False, 0.0
            
        # 4. Channel/Artist Check (Bonus Score)
        score = similarity
        
        # If channel name looks like a topic channel or contains artist name
        channel_lower = channel.lower()
        artist_lower = metadata['artist'].lower()
        
        if "topic" in channel_lower or artist_lower in channel_lower:
            score += 0.1
        
        # Preference for "Official Audio" or "Official Video"
        if "official" in title_lower:
            score += 0.05
            
        return True, score

    def _calculate_similarity(self, a: str, b: str) -> float:
        return difflib.SequenceMatcher(None, a, b).ratio()

    def _download_audio(self, url: str) -> Optional[Path]:
        """Download audio from URL and convert/remux based on quality."""
        temp_filename = f"temp_{os.getpid()}_{int(os.times().system)}"
        output_template = str(self.temp_dir / f"{temp_filename}.%(ext)s")
        
        profile = QUALITY_PROFILES.get(self.quality, QUALITY_PROFILES[DEFAULT_QUALITY])
        
        ydl_opts = {
            'format': 'bestaudio/best',
            'retries': 10,
            'fragment_retries': 10,
            'outtmpl': output_template,
            'quiet': True,
            'no_warnings': True,
        }
        
        if profile['bitrate'] > 0:
            # Force conversion to MP3 with specific bitrate
            ydl_opts['postprocessors'] = [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': profile['format'],
                'preferredquality': str(profile['bitrate']),
            }]
        else:
            # Ultra quality: get best audio and just remux to a standard container if needed
            # or just leave it as is. ffmpeg will ensure it's playable.
            ydl_opts['postprocessors'] = [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'flac', # Default for 'ultra' if we want lossless
            }]
            # Alternatively, if we want TRULY best source without conversion:
            # ydl_opts['format'] = 'bestaudio'
            # (No FFmpegExtractAudio post-processor)
            # But FLAC is a safe bet for 'ultra' to ensure compatibility with metadata embedding.
        
        if self.cookie_file and os.path.exists(self.cookie_file):
            ydl_opts['cookiefile'] = self.cookie_file
        elif self.cookie_browser:
            ydl_opts['cookiesfrombrowser'] = (self.cookie_browser, None, None, None)
        
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])
                
            # Find the generated mp3 file
            expected_path = self.temp_dir / f"{temp_filename}.mp3"
            
            # Clean up potential leftovers immediately if failed?
            # yt-dlp usually cleans up partials unless keep_fragments is True
            
            if expected_path.exists():
                return expected_path
            
        except Exception as e:
            print(f"Download error: {e}")
            
        return None
