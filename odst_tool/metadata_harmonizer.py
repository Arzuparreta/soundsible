"""Metadata harmonizer for source-agnostic canonical resolution."""

import re
import logging
from difflib import SequenceMatcher
from typing import Dict, Any, List, Tuple

from .metadata_scorer import decide_consensus, metadata_query_fingerprint
from .musicbrainz_provider import search_candidates as mb_search_candidates
from .itunes_provider import search_candidates as itunes_search_candidates

logger = logging.getLogger(__name__)


class MetadataHarmonizer:
    COLLECTIVES = [
        "88rising", "88 rising", "topic", "various artists", "lyrical lemonade",
        "vevo", "records", "music", "collective", "label", "trap nation",
        "proximity", "monstercat", "ncs", "nocopyrightsounds"
    ]
    CLEANUP_REGEX = [
        r"\(Official Video\)", r"\[Official Video\]",
        r"\(Official Music Video\)", r"\[Official Music Video\]",
        r"\(Official Audio\)", r"\[Official Audio\]",
        r"\(Lyrics\)", r"\[Lyrics\]",
        r"\(HQ\)", r"\[HQ\]", r"\(HD\)", r"\[HD\]",
        r"\(4K\)", r"\[4K\]",
        r"\[[^\]]*4K[^\]]*\]",
        r"\[[^\]]*UPGRADE[^\]]*\]",
        r"\[[^\]]*REMASTER[^\]]*\]",
        r"\[[^\]]*LYRIC[^\]]*\]",
        r"\[[^\]]*VISUALIZER[^\]]*\]",
        r"\[[^\]]*AUDIOVISUAL[^\]]*\]",
        r"\(prod\..*?\)", r"\[prod\..*?\]",
        r"\bprod(?:\.|uction)?\s+.*$",  # Match "Prod" or "Prod." or "Production" followed by space and rest
        r"^\s*\d+\.\s*",  # Track number at start
        r"\s+\d+\.\s+",  # Track number in middle (e.g., "17. OUTRO")
        r"^\s*track\s*\d+\s*[-:]\s*",
        r"\s*official channel\s*$",
        r"\s*tv oficial\s*$",
        r"\s*official\s*$",
        r"\|.*?$",
    ]
    CHANNEL_HINTS = {
        "official", "oficial", "tv", "channel", "records", "music", "topic",
        "vevo", "videos", "video", "canal",
    }

    @staticmethod
    def clean_string(text: str) -> str:
        if not text:
            return "Unknown"
        original = str(text)
        cleaned = re.sub(r"\s*-\s*Topic$", "", original, flags=re.IGNORECASE)
        for pattern in MetadataHarmonizer.CLEANUP_REGEX:
            cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
        cleaned = cleaned.replace("—", "-").replace("–", "-")
        cleaned = re.sub(r"\s*-\s*$", "", cleaned)
        result = " ".join(cleaned.split()).strip()
        if original != result:
            logger.debug(f"clean_string: '{original}' -> '{result}'")
        return result

    @classmethod
    def _artist_looks_like_channel(cls, artist: str) -> bool:
        norm = (artist or "").strip().lower()
        if norm in {"unknown", "youtube", "unknown artist"}:
            return True
        if any(token in norm for token in cls.COLLECTIVES):
            return True
        words = set(re.findall(r"\w+", norm))
        return len(words.intersection(cls.CHANNEL_HINTS)) >= 1

    @classmethod
    def _extract_artist_from_title(cls, title: str) -> Tuple[str, str]:
        normalized_title = (title or "").replace("—", "-").replace("–", "-")
        if " - " not in normalized_title:
            return "", cls.clean_string(normalized_title)
        left, right = normalized_title.split(" - ", 1)
        extracted_artist = cls.clean_string(left)
        extracted_title = cls.clean_string(right)
        return extracted_artist, extracted_title

    @classmethod
    def _derive_channel_search_variants(cls, artist: str) -> List[str]:
        """
        Derive search variants from channel-like artist names.
        Strips known channel suffixes and optionally suggests canonical forms.
        Returns list of variants, most likely first.
        """
        if not artist or not cls._artist_looks_like_channel(artist):
            return []
        
        variants = []
        base = artist.strip()
        logger.debug(f"_derive_channel_search_variants: input='{base}'")
        
        # Known channel suffixes to strip (case-insensitive)
        channel_suffixes = [
            r"\s+TV\s+Oficial$",
            r"\s+TV\s+Official$",
            r"\s+Official\s+Channel$",
            r"\s+Official$",
            r"\s+Oficial$",
            r"\s+-?\s*Topic$",
            r"\s+Records$",
            r"\s+Music$",
            r"\s+VEVO$",
        ]
        
        # Strip suffixes
        stripped = base
        for suffix_pattern in channel_suffixes:
            stripped = re.sub(suffix_pattern, "", stripped, flags=re.IGNORECASE).strip()
        
        if stripped and stripped.lower() != base.lower():
            variants.append(cls.clean_string(stripped))
        
        # Optional: suggest canonical form (e.g., "KaseO" -> "Kase.O")
        # Conservative heuristic: check camelCase pattern first, then two-token patterns
        if stripped:
            # Check camelCase pattern for single token (e.g., "KaseO" -> "Kase.O")
            stripped_no_space = stripped.replace(" ", "")
            match = re.match(r"^(.+?)([A-Z])$", stripped_no_space)
            if match:
                base_part, last_letter = match.groups()
                # Only create canonical if base_part ends with lowercase (camelCase)
                if base_part and base_part[-1].islower() and len(base_part) > 2:
                    canonical = f"{base_part}.{last_letter}"
                    if canonical not in variants:
                        variants.insert(0, canonical)
            
            # Check two-token patterns (e.g., "Kase O" -> "Kase.O")
            tokens = stripped.split()
            if len(tokens) == 2:
                first, second = tokens
                # Check if second token is a single capital letter
                if len(second) == 1 and second.isupper():
                    canonical = f"{first}.{second}"
                    if canonical not in variants:
                        variants.insert(0, canonical)
        
        # Always include the cleaned original if different
        cleaned_original = cls.clean_string(base)
        if cleaned_original and cleaned_original not in variants:
            variants.append(cleaned_original)
        
        result = variants[:3]  # Limit to 3 variants
        logger.debug(f"_derive_channel_search_variants: '{base}' -> {result}")
        return result

    @classmethod
    def _build_lookup_queries(cls, title: str, artist: str, original_artist: str = None) -> List[Tuple[str, str]]:
        title_clean = cls.clean_string(title)
        artist_clean = cls.clean_string(artist)
        original_artist_clean = cls.clean_string(original_artist) if original_artist else None
        queries: List[Tuple[str, str]] = []
        queries.append((artist_clean, title_clean))
        extracted_artist, extracted_title = cls._extract_artist_from_title(title_clean)
        if extracted_artist and extracted_title:
            queries.append((extracted_artist, extracted_title))
        # Also try removing track numbers from title prefix.
        no_track_title = re.sub(r"^\s*\d+\.\s*", "", title_clean).strip()
        if no_track_title and no_track_title != title_clean:
            queries.append((artist_clean, no_track_title))
            ext_artist2, ext_title2 = cls._extract_artist_from_title(no_track_title)
            if ext_artist2 and ext_title2:
                queries.append((ext_artist2, ext_title2))
        
        # Add channel-derived variants if artist looks like channel
        # Check both current artist and original artist (in case artist was extracted from title)
        channel_artist = None
        if cls._artist_looks_like_channel(artist_clean):
            channel_artist = artist_clean
        elif original_artist_clean and cls._artist_looks_like_channel(original_artist_clean):
            channel_artist = original_artist_clean
        
        if channel_artist:
            variants = cls._derive_channel_search_variants(channel_artist)
            for variant in variants:
                if variant and variant.lower() != artist_clean.lower():
                    queries.append((variant, title_clean))
                    if no_track_title and no_track_title != title_clean:
                        queries.append((variant, no_track_title))
        
        # Deduplicate while preserving order.
        seen = set()
        deduped: List[Tuple[str, str]] = []
        for q_artist, q_title in queries:
            key = (q_artist.lower(), q_title.lower())
            if key in seen or not q_title:
                continue
            seen.add(key)
            deduped.append((q_artist, q_title))
        return deduped[:8]  # Increased limit to accommodate variants

    @staticmethod
    def _match_similarity(a: str, b: str) -> float:
        aa = re.sub(r"[^\w\s]", " ", (a or "").lower())
        bb = re.sub(r"[^\w\s]", " ", (b or "").lower())
        aa = " ".join(aa.split())
        bb = " ".join(bb.split())
        if not aa or not bb:
            return 0.0
        tokens_a = set(aa.split())
        tokens_b = set(bb.split())
        overlap = len(tokens_a.intersection(tokens_b)) / max(1, len(tokens_a))
        seq = SequenceMatcher(None, aa, bb).ratio()
        return (overlap * 0.6) + (seq * 0.4)

    @staticmethod
    def _duration_match_score(a: int, b: int) -> float:
        if not a or not b:
            return 0.65
        diff = abs(int(a) - int(b))
        if diff <= 2:
            return 1.0
        if diff <= 6:
            return 0.9
        if diff <= 12:
            return 0.78
        if diff <= 20:
            return 0.62
        return 0.3

    @classmethod
    def _pick_enrichment_candidate(cls, title: str, artist: str, duration_sec: int, review_candidates: Dict[str, Any]) -> Dict[str, Any]:
        best = None
        best_score = 0.0
        for provider_name, candidate in (review_candidates or {}).items():
            if not isinstance(candidate, dict):
                continue
            t_score = cls._match_similarity(title, candidate.get("title", ""))
            a_score = cls._match_similarity(artist, candidate.get("artist", ""))
            d_score = cls._duration_match_score(duration_sec, candidate.get("duration_sec", 0))
            score = (t_score * 0.45) + (a_score * 0.4) + (d_score * 0.15)
            logger.debug(f"_pick_enrichment_candidate: {provider_name} - title='{candidate.get('title')}', artist='{candidate.get('artist')}', "
                        f"t_score={t_score:.3f}, a_score={a_score:.3f}, d_score={d_score:.3f}, total={score:.3f}")
            if score > best_score:
                best_score = score
                best = candidate
        if best and best_score >= 0.8:
            logger.debug(f"_pick_enrichment_candidate: selected candidate with score={best_score:.3f} (threshold=0.8)")
            return best
        elif best:
            logger.debug(f"_pick_enrichment_candidate: best score={best_score:.3f} below threshold 0.8")
        return {}

    @classmethod
    def _gather_provider_candidates(cls, artist: str, title: str, original_artist: str = None) -> Dict[str, List[Dict[str, Any]]]:
        provider_candidates = {"musicbrainz": [], "itunes": []}
        queries = cls._build_lookup_queries(title, artist, original_artist=original_artist)
        logger.debug(f"_gather_provider_candidates: queries={queries}")
        seen_ids = {name: set() for name in provider_candidates.keys()}

        for q_artist, q_title in queries:
            mb_items = mb_search_candidates(q_artist, q_title, limit=6)
            it_items = itunes_search_candidates(q_artist, q_title, limit=6)
            for provider_name, items in (
                ("musicbrainz", mb_items),
                ("itunes", it_items),
            ):
                for item in items:
                    key = item.get("catalog_id") or f"{item.get('title','')}|{item.get('artist','')}|{item.get('duration_sec',0)}"
                    if key in seen_ids[provider_name]:
                        continue
                    seen_ids[provider_name].add(key)
                    provider_candidates[provider_name].append(item)
        return provider_candidates

    @classmethod
    def harmonize(cls, raw_data: Dict[str, Any], source: str = "youtube") -> Dict[str, Any]:
        """
        Metadata harmonization pipeline: transforms raw YouTube/UI metadata into canonical form.
        
        Metadata Field Flow:
        ===================
        
        1. INPUT (raw_meta):
           - Source: YouTube/UI metadata
           - Fields: title, artist (or uploader/channel), album, duration_sec, isrc, channel, 
             uploader, album_art_url (YouTube thumbnail), is_music_content (flag), etc.
           - Meaning: Raw, unnormalized data from yt-dlp or UI search results
        
        2. NORMALIZATION:
           - clean_string(): Removes noise (Official Video, [4K], prod. tags, etc.)
           - Title-derived artist: If title contains "ARTIST - TITLE" and artist looks like channel,
             extract artist from title (e.g., "Kase.O - Basureta" → artist="Kase.O", title="Basureta")
           - Channel-derived variants: If artist looks like channel (e.g., "KaseO TV Oficial"),
             derive search variants by stripping suffixes ("TV Oficial" → "KaseO", optionally "Kase.O")
           - Display artist: For enrichment comparison, use title-derived artist or first channel variant
        
        3. PROVIDER CANDIDATES:
           - Source: MusicBrainz, iTunes, Spotify (web/API)
           - Query: Multiple (artist, title) pairs built from normalized data + channel variants
           - Schema: {title, artist, album, duration_sec, isrc, cover_url, catalog_source, catalog_id}
           - Purpose: Find canonical metadata from authoritative databases
        
        4. CONSENSUS (decide_consensus):
           - Input: Base metadata + provider_candidates
           - Output: canonical (best match), metadata_state (auto_resolved/pending_review/fallback_youtube),
             review_candidates (best per provider), metadata_confidence
           - Album from canonical: Only when metadata_state == "auto_resolved"
        
        5. ENRICHMENT:
           - When: Album is empty/generic (Singles, Unknown, etc.)
           - Method: _pick_enrichment_candidate() scores candidates by title/artist/duration similarity
             using display_artist_for_comparison (not raw channel name)
           - Threshold: Agreement ≥ 0.8 required
           - Sets: album, cover_url (only; never overwrites title/artist outside auto_resolved)
           - Fallback: If still no album and we have channel variants, run one album-only lookup
             with primary variant artist + title
        
        6. COVER SELECTION:
           - Priority order:
             1. Premium sources: candidate_cover (MusicBrainz Cover Art Archive, Spotify, iTunes)
             2. YouTube thumbnail: Only if no premium cover AND is_music_content == True
             3. Fallback: raw_data.get("thumbnail") (yt-dlp's thumbnail field)
           - Rationale: Regular YouTube video thumbnails are often random frames; only music-specific
             uploads (VEVO, Topic channels, YouTube Music) tend to have good album art
        
        7. OUTPUT:
           - Final fields: title, artist, album (Singles if still empty), album_artist, 
             album_art_url (from premium sources when available), cover_url, musicbrainz_id, isrc,
             metadata_source_authority, metadata_confidence, metadata_state, metadata_query_fingerprint,
             review_candidates, metadata_decision_id
           - Provenance: All source information preserved for review/audit
        
        Rules:
        ------
        - Keep authoritative core fields if provided (ISRC/MusicBrainz/source evidence)
        - Use external APIs to enrich and only override core fields on high confidence
        - Never overwrite title/artist outside auto_resolved state
        - Album/cover enrichment allowed when candidate strongly agrees (≥0.8) and current is empty/generic
        """
        raw_title = raw_data.get("title") or raw_data.get("name") or "Unknown Title"
        raw_artist = raw_data.get("artist") or raw_data.get("uploader") or "Unknown Artist"
        original_artist = cls.clean_string(raw_artist)  # Keep original for fallback detection
        title = cls.clean_string(raw_title)
        artist = original_artist
        album = cls.clean_string(raw_data.get("album") or "") if raw_data.get("album") else ""
        isrc = raw_data.get("isrc")

        extracted_artist, extracted_title = cls._extract_artist_from_title(raw_title)
        title_derived_artist = None
        if extracted_title and cls._artist_looks_like_channel(artist):
            # Prefer artist inferred from title when uploader appears to be a channel name.
            title_derived_artist = extracted_artist
            artist = extracted_artist or artist
            title = extracted_title or title
            logger.debug(f"harmonize: extracted from title - artist='{extracted_artist}', title='{extracted_title}'")
        else:
            # Remove duplicated trailing artist in title when present.
            normalized_title = title.replace("—", "-").replace("–", "-")
            if " - " in normalized_title:
                left, right = normalized_title.rsplit(" - ", 1)
                if cls.clean_string(right).lower() == artist.lower():
                    title = cls.clean_string(left)

        # Derive display/canonical artist for enrichment comparison
        # Use title-derived artist if available, else first channel variant, else current artist
        display_artist_for_comparison = artist
        has_channel_variant = False
        if title_derived_artist:
            display_artist_for_comparison = title_derived_artist
        elif cls._artist_looks_like_channel(original_artist):
            variants = cls._derive_channel_search_variants(original_artist)
            if variants:
                display_artist_for_comparison = variants[0]
                has_channel_variant = True
                logger.debug(f"harmonize: using channel variant - original='{original_artist}', variant='{display_artist_for_comparison}'")

        logger.debug(f"harmonize: normalized - title='{title}', artist='{artist}', display_artist='{display_artist_for_comparison}'")
        query_fingerprint = metadata_query_fingerprint(title, artist, int(raw_data.get("duration_sec") or 0))
        provider_candidates = cls._gather_provider_candidates(artist, title, original_artist=original_artist)
        
        # Log candidate counts
        candidate_counts = {k: len(v) for k, v in provider_candidates.items()}
        logger.debug(f"harmonize: provider_candidates counts: {candidate_counts}")

        decision = decide_consensus(
            {
                "title": title,
                "artist": artist,
                "album": album,
                "duration_sec": int(raw_data.get("duration_sec") or 0),
                "isrc": isrc,
            },
            provider_candidates=provider_candidates,
        )

        canonical = decision.get("canonical") or {}
        review_candidates = decision.get("review_candidates") or {}
        metadata_state = decision.get("metadata_state", "fallback_youtube")
        authority = decision.get("metadata_source_authority", "youtube_fallback")
        confidence = float(decision.get("metadata_confidence") or 0.0)
        
        logger.debug(f"harmonize: consensus - state='{metadata_state}', confidence={confidence:.3f}, authority='{authority}'")
        if canonical:
            logger.debug(f"harmonize: canonical - title='{canonical.get('title')}', artist='{canonical.get('artist')}', album='{canonical.get('album')}'")
        logger.debug(f"harmonize: review_candidates providers: {list(review_candidates.keys())}")

        # Apply core fields only for auto-resolved consensus.
        if metadata_state == "auto_resolved" and canonical:
            title = cls.clean_string(canonical.get("title") or title)
            artist = cls.clean_string(canonical.get("artist") or artist)
            album = cls.clean_string(canonical.get("album") or album)

        enrichment_candidate = cls._pick_enrichment_candidate(
            title=title,
            artist=display_artist_for_comparison,
            duration_sec=int(raw_data.get("duration_sec") or 0),
            review_candidates=review_candidates,
        )
        
        if enrichment_candidate:
            logger.debug(f"harmonize: enrichment_candidate found - album='{enrichment_candidate.get('album')}', cover='{bool(enrichment_candidate.get('cover_url'))}'")
        else:
            logger.debug(f"harmonize: no enrichment_candidate (threshold not met or no candidates)")
        
        # Professional-safe enrichment rule:
        # - never overwrite title/artist outside auto_resolved
        # - allow album/cover enrichment when candidate strongly agrees on title/artist/duration.
        if (not album or album.lower() in {"singles", "unknown", "manual", "manual download", "none"}) and enrichment_candidate.get("album"):
            album = cls.clean_string(enrichment_candidate.get("album"))
            logger.debug(f"harmonize: applied enrichment album='{album}'")

        # Fallback album-only pass: if still no album and we have channel variants, try one more lookup
            if (not album or album.lower() in {"singles", "unknown", "manual", "manual download", "none"}):
                if has_channel_variant and display_artist_for_comparison and display_artist_for_comparison.lower() != original_artist.lower():
                    # We have a variant that differs from original artist, try album-only lookup
                    fallback_candidates = cls._gather_provider_candidates(display_artist_for_comparison, title, original_artist=original_artist)
                # Convert to review_candidates format (best per provider)
                fallback_review_candidates = {}
                for provider_name, candidates in fallback_candidates.items():
                    if candidates:
                        # Pick best candidate for this provider
                        best_candidate = None
                        best_score = 0.0
                        for candidate in candidates:
                            t_score = cls._match_similarity(title, candidate.get("title", ""))
                            a_score = cls._match_similarity(display_artist_for_comparison, candidate.get("artist", ""))
                            d_score = cls._duration_match_score(int(raw_data.get("duration_sec") or 0), candidate.get("duration_sec", 0))
                            score = (t_score * 0.45) + (a_score * 0.4) + (d_score * 0.15)
                            if score > best_score:
                                best_score = score
                                best_candidate = candidate
                        if best_candidate:
                            fallback_review_candidates[provider_name] = best_candidate
                
                fallback_enrichment = cls._pick_enrichment_candidate(
                    title=title,
                    artist=display_artist_for_comparison,
                    duration_sec=int(raw_data.get("duration_sec") or 0),
                    review_candidates=fallback_review_candidates,
                )
                if fallback_enrichment.get("album"):
                    album = cls.clean_string(fallback_enrichment.get("album"))
                    logger.debug(f"harmonize: fallback album-only pass succeeded - album='{album}'")
                    # Also update enrichment_candidate cover if we got a better one
                    if not enrichment_candidate.get("cover_url") and fallback_enrichment.get("cover_url"):
                        enrichment_candidate = fallback_enrichment
                else:
                    logger.debug(f"harmonize: fallback album-only pass found no candidate")

        if not album:
            album = "Singles"

        # Enrichment from chosen or top evidence (without unsafe core override).
        candidate_cover = canonical.get("cover_url") or enrichment_candidate.get("cover_url")
        candidate_album_artist = raw_data.get("album_artist") or canonical.get("album_artist") or enrichment_candidate.get("album_artist")
        candidate_mbid = canonical.get("musicbrainz_id") or enrichment_candidate.get("musicbrainz_id")
        candidate_isrc = canonical.get("isrc") or enrichment_candidate.get("isrc")

        # Determine cover source and premium status
        # Premium: musicbrainz, itunes. YouTube Music: youtube_music. Fallback: youtube.
        is_music_content = raw_data.get("is_music_content", False)
        cover_source = None
        premium_cover_failed = False
        final_cover = None

        if candidate_cover:
            if canonical:
                catalog_source = canonical.get("catalog_source", "")
                if catalog_source == "musicbrainz":
                    cover_source = "musicbrainz"
                elif catalog_source == "itunes":
                    cover_source = "itunes"
            elif enrichment_candidate:
                catalog_source = enrichment_candidate.get("catalog_source", "")
                if catalog_source == "musicbrainz":
                    cover_source = "musicbrainz"
                elif catalog_source == "itunes":
                    cover_source = "itunes"

            if cover_source:
                final_cover = candidate_cover
            else:
                # Fallback: if we have a cover but don't know source, assume premium
                final_cover = candidate_cover
                cover_source = "musicbrainz"  # Default assumption
        
        # If no premium cover, check YouTube Music thumbnail
        if not final_cover:
            yt_thumbnail = raw_data.get("album_art_url") if is_music_content else None
            if yt_thumbnail:
                final_cover = yt_thumbnail
                cover_source = "youtube_music" if is_music_content else "youtube"
            else:
                # Final fallback: yt-dlp thumbnail
                final_cover = raw_data.get("thumbnail")
                cover_source = "youtube" if final_cover else "none"
        
        # Determine if premium cover failed
        if cover_source in ("musicbrainz", "itunes", "youtube_music"):
            premium_cover_failed = False
        else:
            premium_cover_failed = True

        return {
            "title": title,
            "artist": artist,
            "album": album,
            "album_artist": candidate_album_artist,
            "year": raw_data.get("year"),
            "track_number": raw_data.get("track_number", 1),
            "album_art_url": final_cover,
            "musicbrainz_id": raw_data.get("musicbrainz_id") or candidate_mbid,
            "isrc": raw_data.get("isrc") or candidate_isrc,
            "duration_sec": raw_data.get("duration_sec", 0),
            "metadata_source_authority": authority,
            "metadata_confidence": round(confidence, 3),
            "metadata_state": metadata_state,
            "metadata_query_fingerprint": query_fingerprint,
            "review_candidates": review_candidates,
            "metadata_decision_id": raw_data.get("metadata_decision_id"),
            "cover_source": cover_source,
            "premium_cover_failed": premium_cover_failed,
            "fallback_cover_url": final_cover if cover_source == "youtube" else (raw_data.get("thumbnail") or raw_data.get("album_art_url") if not final_cover else None),
        }

    @staticmethod
    def get_best_yt_thumbnail(video_id: str) -> str:
        return f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"
