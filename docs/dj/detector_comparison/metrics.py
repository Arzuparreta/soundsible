"""Reference-based metrics, without octave folding or many-to-one matches."""
from __future__ import annotations

import numpy as np


def events(estimated, reference, tolerance, *, include_matches=False):
    estimated = np.asarray(estimated, dtype=float)
    reference = np.asarray(reference, dtype=float)
    # Maximize matches FIRST, then minimize their total timing error. A greedy
    # cardinality match can report 60 ms when a duplicate is only 1 ms away.
    count = len(estimated)+len(reference)
    delta = estimated[:, None]-reference[None, :]
    inside = np.abs(delta) <= tolerance+1e-9
    try:
        from scipy.optimize import linear_sum_assignment
    except ImportError:
        from .matching import ordered_matches
        pairs = ordered_matches(delta/max(tolerance, 1e-12), inside)
    else:
        cost = np.ones((count, count))
        cost[len(estimated):, len(reference):] = 0
        cost[:len(estimated), :len(reference)] = np.where(
            inside, np.abs(delta)/max(tolerance, 1e-12)/max(count, 1), count+1)
        rows, columns = linear_sum_assignment(cost)
        pairs = zip(rows, columns)
    pairs = [(int(i), int(j)) for i, j in pairs
             if i < len(estimated) and j < len(reference) and inside[i, j]]
    errors = [float(delta[i, j]) for i, j in pairs]
    matched = len(errors)
    precision = matched / len(estimated) if len(estimated) else None
    recall = matched / len(reference) if len(reference) else None
    f1 = 2 * matched / (len(estimated) + len(reference)) if len(estimated) + len(reference) else None
    absolute = np.abs(errors) * 1000
    output = dict(precision=precision, recall=recall, f1=f1, matched=matched,
                predicted=len(estimated), reference=len(reference),
                median_ms=float(np.median(absolute)) if matched else None,
                p90_ms=float(np.percentile(absolute, 90)) if matched else None,
                signed_median_ms=float(np.median(errors) * 1000) if matched else None)
    if include_matches:
        output['matches'] = pairs
    return output


def continuity(estimated, reference):
    if len(estimated) < 2 or len(reference) < 2:
        return None
    try:
        from mir_eval.beat import continuity as calculate
    except ImportError:
        return None  # Optional experiment dependency; never fabricate continuity.
    cmlc, cmlt, amlc, amlt = calculate(np.asarray(reference), np.asarray(estimated))
    return dict(cmlc=float(cmlc), cmlt=float(cmlt), amlc=float(amlc), amlt=float(amlt))


def nearest_error(estimated, reference):
    """All predicted events, including misses; read beside recall/unit error."""
    if not len(estimated) or not len(reference):
        return None
    delta = np.asarray(estimated)[:, None]-np.asarray(reference)[None, :]
    signed = delta[np.arange(len(delta)), np.argmin(abs(delta), axis=1)]*1000
    return dict(signed_median_ms=float(np.median(signed)),
                absolute_median_ms=float(np.median(abs(signed))),
                absolute_p90_ms=float(np.percentile(abs(signed), 90)))


def evaluate(result, case, tolerance):
    reference = case['beats']
    firsts = case['downbeats']
    # Unannotated intro/outro is never scored as a false event.
    start, end = (reference[0], reference[-1]) if reference else (0., case['duration'])
    def cut(values):
        return [float(t) for t in values
                if max(0., start-tolerance)-1e-9 <= t <= min(case['duration'], end+tolerance)+1e-9]
    beats, downbeats = cut(result['beats']), cut(result['downbeats'])
    beat = events(beats, reference, tolerance)
    first = events(downbeats, firsts, tolerance) if firsts is not None else None
    bpm = result.get('bpm')
    ref_bpm = 60 / float(np.median(np.diff(reference))) if len(reference) > 1 else None
    # Grouping and physical bar duration are assessed at each annotated full bar.
    counts, durations, subdivisions = [], [], []
    subdivision_known = subdivision_total = 0
    known = correct = 0
    regions = result.get('regions', [])
    for a, b in zip(firsts or [], (firsts or [])[1:]):
        if case.get('subdivision') is not None:
            subdivision_total += 1
        expected = sum(a <= t < b - 1e-6 for t in reference)
        row = next((r for r in regions if r['start'] <= a + .5 * (b-a) < r['end']), None)
        if row and row.get('beats_per_bar'):
            known += 1
            correct += int(row['beats_per_bar'] == expected)
            counts.append(row['beats_per_bar'] == expected)
            if row.get('bar_seconds'):
                durations.append((row['bar_seconds'] / (b-a) - 1) * 100)
            if case.get('subdivision') is not None:
                if row.get('subdivision') is not None:
                    subdivision_known += 1
                    subdivisions.append(row['subdivision'] == case['subdivision'])
    total = max(len(firsts or []) - 1, 0)
    return dict(beat=beat, downbeat=first,
                all_predicted_beat_nearest_error=nearest_error(beats, reference),
                all_predicted_downbeat_nearest_error=nearest_error(downbeats, firsts) if firsts else None,
                beat_continuity=continuity(beats, reference),
                downbeat_continuity=continuity(downbeats, firsts) if firsts else None,
                bpm=bpm, reference_bpm=ref_bpm,
                tempo_error_percent=(bpm/ref_bpm-1)*100 if bpm and ref_bpm else None,
                grouping_coverage=known/total if total else None,
                correct_grouping_coverage=correct/total if total else None,
                grouping_accuracy=float(np.mean(counts)) if counts else None,
                bar_duration_abs_error_percent=float(np.median(np.abs(durations))) if durations else None,
                subdivision_accuracy=float(np.mean(subdivisions)) if subdivisions else None,
                subdivision_coverage=subdivision_known/subdivision_total if subdivision_total else None,
                correct_subdivision_coverage=sum(subdivisions)/subdivision_total if subdivision_total else None,
                downbeat_abstention=not bool(downbeats),
                downbeat_false_fraction=1-first['precision'] if first and first['precision'] is not None else None,
                unsupported_downbeat_events=len(downbeats) if firsts == [] else None)
