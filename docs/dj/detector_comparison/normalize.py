"""Single conservative adapter to the experimental #394 P12 contract.

Missing confidence stays missing in raw predictions and becomes zero evidence
at the existing execution boundary. A sigmoid is never promoted to calibrated
metre confidence. Integration/calibration remains a subsequent user decision.
"""
from __future__ import annotations

import copy


def to_analysis(raw, contracts):
    native = raw.get('native_analysis')
    if native and 'metric_regions' in native:
        return copy.deepcopy(native)
    analysis = contracts.fallback_analysis(raw['duration'])
    regions = []
    for region in raw['regions']:
        row = copy.deepcopy(region)
        for key in ['pulse_confidence', 'metre_confidence', 'downbeat_confidence', 'subdivision_confidence']:
            row[key] = row.get(key) or 0.
        regions.append(row)
    analysis.update(analysed=True, bpm=raw.get('bpm') or 0., beat_grid=raw['beats'],
                    downbeats=raw['downbeats'], metric_regions=regions,
                    beat_offset=raw['beats'][0] if raw['beats'] else 0.,
                    intro_cue=raw['downbeats'][0] if raw['downbeats'] else raw['beats'][0] if raw['beats'] else 0.,
                    outro_cue=raw['downbeats'][-1] if raw['downbeats'] else None,
                    confidence=0., tempo_confidence=0.)
    for key in ['beats_per_bar', 'bar_seconds', 'subdivision', 'pulse_unit']:
        values = {r.get(key) for r in regions}
        analysis[key] = next(iter(values)) if len(values) == 1 else None
    for key in ['metre_confidence', 'downbeat_confidence', 'subdivision_confidence']:
        analysis[key] = min((r[key] for r in regions), default=0.)
    return analysis
