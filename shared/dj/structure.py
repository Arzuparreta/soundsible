"""Bars, phrases, sections and candidate cues from measured windows; no pulse detector."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .contracts import Structure, WindowFeatures

def _sections_from_features(
    features: Mapping[str, Any],
    offset: float,
    duration: float,
    downbeats: list[float],
) -> list[dict[str, Any]]:
    """Describe measured eight-bar regions and their musical role."""
    import numpy as np

    local_downbeats = [value for value in downbeats if offset <= value < offset + float(features["window_seconds"])]
    starts = local_downbeats[::8]
    if not starts:
        return []
    hop_seconds = float(features["hop_seconds"])
    frame_energy = features["frame_energy"]
    flux = features["flux"]
    # The grid reaches the last sample; the frames stop one frame short of it.
    starts = [start for start in starts if int((start - offset) / hop_seconds) < min(len(frame_energy), len(flux))]
    if not starts:
        return []
    regions: list[tuple[float, float, float, float]] = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else min(duration, offset + float(features["window_seconds"]))
        left = max(0, int((start - offset) / hop_seconds))
        right = max(left + 1, min(len(frame_energy), int((end - offset) / hop_seconds)))
        region_energy = float(np.mean(frame_energy[left:right])) if right > left else 0.0
        flux_right = max(left + 1, min(len(flux), right))
        onset = float(np.mean(flux[left:flux_right])) if flux_right > left else 0.0
        slope = float(frame_energy[right - 1] - frame_energy[left]) if right - left > 1 else 0.0
        regions.append((start, end, region_energy, onset + max(0.0, slope)))
    median_energy = max(1e-6, float(np.median([row[2] for row in regions])))
    result: list[dict[str, Any]] = []
    for index, (start, end, energy, motion) in enumerate(regions):
        ratio = energy / median_energy
        if index == 0 and ratio < 0.9:
            label = "intro"
        elif index == len(regions) - 1 and end >= duration - 1 and ratio < 0.95:
            label = "outro"
        elif ratio >= 1.18 and motion >= 0.35:
            label = "drop"
        elif ratio <= 0.72:
            label = "breakdown"
        elif motion >= 0.48:
            label = "build"
        else:
            label = "body"
        result.append({
            "start": round(float(start), 3),
            "end": round(float(end), 3),
            "label": label,
            # Mean frame level against the song's loud level, not between songs.
            "level": round(max(0.0, min(1.5, energy)), 3),
        })
    return result


def structure_from_windows(
    features: WindowFeatures,
    head_features: WindowFeatures | None,
    *,
    duration: float,
    tail_start: float,
) -> Structure:
    """Consume measured bars locally; eight-bar phrase/section prior awaits P13."""
    period = features["period"]
    intro_local = head_features["intro"] if head_features is not None else 0.0

    def window_grid(window_features: Mapping[str, Any], offset: float) -> tuple[list[float], list[float]]:
        beats = [offset + float(value) for value in window_features["beats"]]
        return beats, [offset + value for region in window_features["metric_regions"]
                       for value in region["downbeats"]]

    beats, downbeats = window_grid(features, tail_start)
    if tail_start and head_features is not None:
        head_beats, head_downbeats = window_grid(head_features, 0.0)
        # The windows are measured apart; neither grid is extended across the gap.
        beats = [value for value in head_beats if value < tail_start] + beats
        downbeats = [value for value in head_downbeats if value < tail_start] + downbeats
    beats = [value for value in beats if 0 <= value <= duration]
    downbeats = [value for value in downbeats if 0 <= value <= duration]

    # Eight bars is a useful phrase prior, but the additional section starts
    # below are derived from changes in measured bar energy and onset density.
    boundaries = []
    windows = [(features, tail_start)]
    if tail_start and head_features is not None:
        windows.insert(0, (head_features, 0.0))
    for window, offset in windows:
        for region in window['metric_regions']:
            boundaries.extend(offset + t for t in region['downbeats'][::8])
    sections = []
    for window, offset in windows:
        for region in window['metric_regions']:
            local_bars = [offset + t for t in region['downbeats']]
            section_rows = _sections_from_features(window, offset, duration, local_bars)
            for row in section_rows:
                row['end'] = min(row['end'], round(offset + region['end'], 3))
            sections.extend(section_rows)
    boundaries.extend(float(section["start"]) for section in sections)
    boundaries = sorted({round(value, 3) for value in boundaries if 0 <= value < duration})
    last_active = tail_start + features["last_active"]
    last_regions = features['metric_regions']
    reserve = float(last_regions[-1]['bar_seconds'] or 2.) if last_regions else 2.
    outro_limit = min(last_active, duration - reserve)
    desired_outro = max(0.0, outro_limit - 64 * period)
    outro_candidates = [value for value in boundaries if desired_outro <= value <= outro_limit]
    outro = outro_candidates[0] if outro_candidates else max(0.0, duration - 32 * period)

    return {
        "beat_grid": [round(float(value), 4) for value in beats],
        "downbeats": [round(float(value), 4) for value in downbeats],
        "phrase_boundaries": boundaries,
        "sections": sections,
        "intro_cue": round(max(0.0, min(intro_local, duration * 0.25)), 3),
        "outro_cue": round(max(0.0, min(outro, duration - reserve)), 3),
    }
