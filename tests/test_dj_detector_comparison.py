"""Experiment correctness: missing evidence, event matches and coverage."""
import numpy as np
import pytest

from docs.dj.detector_comparison.common import result
from docs.dj.detector_comparison.metrics import events, evaluate
from docs.dj.detector_comparison.normalize import to_analysis
from docs.dj.detector_comparison.matching import ordered_matches


def test_integrated_probe_checks_frozen_references_and_bytes_before_inference(tmp_path):
    import hashlib
    import json
    from docs.dj.detector_comparison.integrated_probe import frozen_manifest

    audio = tmp_path / 'relocated.wav'
    audio.write_bytes(b'frozen audio')
    case = dict(id='known', file='/original/location.wav', file_sha256=hashlib.sha256(audio.read_bytes()).hexdigest(),
                beats=[.25, .75], downbeats=[.25])
    reference = tmp_path / 'reference.json'
    reference.write_text(json.dumps(dict(cases=[case])))
    relocated = dict(cases=[{**case, 'file': str(audio)}])
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps(relocated))
    assert frozen_manifest(manifest, reference) == relocated
    relocated['cases'][0]['beats'] = [.5, 1.]
    manifest.write_text(json.dumps(relocated))
    with pytest.raises(ValueError, match='frozen references'):
        frozen_manifest(manifest, reference)
    manifest.write_text(json.dumps(dict(cases=[{**case, 'file': str(audio)}])))
    audio.write_bytes(b'changed after freezing')
    with pytest.raises(ValueError, match='Audio checksum mismatch'):
        frozen_manifest(manifest, reference)


def test_integrated_comparison_rejects_missing_cases_instead_of_silently_changing_cohort():
    from docs.dj.detector_comparison.integrated_probe import compare

    with pytest.raises(ValueError, match='cohort differs'):
        compare([dict(case='a')], dict(rows=[dict(case='b')]))


def test_bar_cue_scoring_keeps_the_event_tolerance_at_annotation_boundaries():
    from docs.dj.detector_comparison.final_pairs import bar_cue_match

    case = dict(beats=[.25, .75], downbeats=[.25])
    assert bar_cue_match(case, .2495, .01) is True
    assert bar_cue_match(case, .23, .01) is None
    assert bar_cue_match(case, .5, .01) is False


def test_no_identifiable_first_beat_is_not_an_unknown_bar_cue():
    from docs.dj.detector_comparison.final_pairs import bar_cue_match

    assert bar_cue_match(dict(beats=[.25, .75], downbeats=[]), .2495, .01) is False
    assert bar_cue_match(dict(beats=[.25, .75], downbeats=None), .2495, .01) is None


def test_matching_cannot_count_two_predictions_as_the_same_reference_event():
    scored = events([1., 1.01, 2.], [1., 2.], .07)
    assert scored['matched'] == 2
    assert scored['precision'] == pytest.approx(2/3)
    assert scored['recall'] == 1


def test_timing_uses_the_closest_event_after_maximizing_matches():
    scored = events([.94, 1.001], [1.], .07)
    assert scored['matched'] == 1
    assert scored['median_ms'] == pytest.approx(1.)


def test_exact_tolerance_boundary_does_not_fail_due_to_binary_float_representation():
    assert events([.26], [.25], .01)['matched'] == 1


def test_numpy_only_assignment_prioritizes_cardinality_over_the_closest_single_pair():
    delta = np.array([0., .08])[:, None]-np.array([.06, .14])[None, :]
    assert ordered_matches(delta/.07, abs(delta) <= .07) == [(0, 0), (1, 1)]


def test_annotated_boundary_keeps_events_within_the_matching_tolerance():
    case = dict(beats=[.25, .75], downbeats=[.25], duration=1.)
    scored = evaluate(result([.26, .76], [.26], duration=1.), case, .01)
    assert scored['beat']['f1'] == 1
    assert scored['downbeat']['f1'] == 1


def test_abstention_is_not_perfect_detection_and_silence_has_no_tempo():
    case = dict(beats=[1., 2., 3., 4.], downbeats=[1., 3.], duration=5.)
    scored = evaluate(result([], duration=5), case, .07)
    assert scored['beat']['f1'] == 0
    assert scored['downbeat']['f1'] == 0
    assert scored['downbeat']['precision'] is None
    assert scored['downbeat_abstention']
    assert scored['tempo_error_percent'] is None


def test_uniform_pulses_never_get_a_hidden_four_four_in_normalization():
    measured = result([1., 2., 3., 4.], duration=5)
    assert measured['downbeats'] == []
    assert measured['regions'] == []


def test_normalizer_counts_observed_beats_but_does_not_invent_subdivision_or_confidence():
    measured = result([1., 1.5, 2., 2.5, 3., 3.5, 4.], [1., 2.5, 4.], duration=5)
    assert [r['beats_per_bar'] for r in measured['regions']] == [3, 3]
    assert all(r['subdivision'] is None and r['pulse_unit'] is None for r in measured['regions'])
    assert all(r['downbeat_confidence'] is None for r in measured['regions'])


@pytest.mark.parametrize('beats', [[2., 1.], [1., 1.], [float('nan')], [-1.]])
def test_invalid_backend_output_is_a_failure_not_a_silently_repaired_result(beats):
    with pytest.raises(ValueError):
        result(beats, duration=5.)


def test_octave_error_is_not_folded_away():
    reference = np.arange(1., 10., .5).tolist()
    case = dict(beats=reference, downbeats=[1., 3., 5., 7., 9.], duration=10.)
    scored = evaluate(result(np.arange(1., 10., 1), duration=10.), case, .07)
    assert scored['tempo_error_percent'] == -50
    assert scored['beat']['recall'] < 1


def test_false_firsts_on_an_ambiguous_signal_remain_visible():
    measured = result([1., 2., 3., 4.], [1., 3.], duration=5)
    scored = evaluate(measured, dict(beats=[1., 2., 3., 4.], downbeats=[], duration=5), .07)
    assert scored['unsupported_downbeat_events'] == 2
    assert scored['downbeat']['precision'] == 0


def test_normalization_does_not_promote_model_events_to_musical_confidence():
    from types import SimpleNamespace
    contracts = SimpleNamespace(fallback_analysis=lambda duration: dict(duration=duration))
    normalized = to_analysis(result([0., .5, 1., 1.5, 2.], [0., 2.], duration=3.), contracts)
    assert normalized['metric_regions'][0]['beats_per_bar'] == 4
    assert normalized['metric_regions'][0]['downbeat_confidence'] == 0
    assert normalized['tempo_confidence'] == 0
    assert normalized['pulse_unit'] is None


def test_native_metric_coverage_preserves_an_unmeasured_middle_and_is_not_mutated():
    from types import SimpleNamespace
    native = dict(metric_regions=[dict(start=0., end=72.), dict(start=528., end=600.)])
    normalized = to_analysis(dict(native_analysis=native), SimpleNamespace())
    normalized['metric_regions'][0]['end'] = 60.
    assert native['metric_regions'][0]['end'] == 72.
    assert normalized['metric_regions'][1]['start'] == 528.


def test_missing_subdivision_is_unavailable_with_zero_coverage():
    measured = result([0., .5, 1., 1.5, 2.], [0., 2.], duration=3.)
    case = dict(beats=[0., .5, 1., 1.5, 2.], downbeats=[0., 2.], duration=3., subdivision=2)
    scored = evaluate(measured, case, .01)
    assert scored['subdivision_accuracy'] is None
    assert scored['subdivision_coverage'] == 0
    assert scored['correct_subdivision_coverage'] == 0


def test_reliability_does_not_borrow_a_high_activation_outside_the_tolerance(tmp_path):
    import json
    from docs.dj.detector_comparison.calibration import measure
    corpus = tmp_path/'corpus'
    corpus.mkdir()
    case = dict(id='fixture', dataset='synthetic', split='test', duration=1.,
                beats=[.26, .76], downbeats=[.26])
    (corpus/'manifest.json').write_text(json.dumps(dict(cases=[case])))
    directory = tmp_path/'results/beatnet-fixture'
    directory.mkdir(parents=True)
    (directory/'metadata.json').write_text('{}')
    (directory/'fixture.json').write_text(json.dumps(dict(case='fixture', raw=dict(
        downbeats=[.26], activation_kind='native_probability_50fps'))))
    activation = np.zeros((50, 2))
    activation[12, 1] = .99  # 0.24 s lies outside 0.26 +/- 0.01 s.
    activation[13, 1] = .1
    np.savez(directory/'fixture.npz', activation=activation)
    measure(tmp_path)
    scored = json.loads((tmp_path/'calibration-results.json').read_text())['methods']['beatnet-fixture']['test']
    assert scored['bins'][0]['mean_score'] == pytest.approx(.1)
    assert scored['brier_on_emitted_events'] == pytest.approx(.81)


class _IndexSession:
    """Returns column 0 of each chunk as both logits: the frame index, or 0 in padding."""
    def run(self, _outputs, feeds):
        piece = feeds['spect']
        return piece[..., 0], piece[..., 0]


@pytest.mark.parametrize('frames', [100, 1488, 1489, 1501, 4000])
def test_torch_free_chunking_gives_every_frame_its_own_prediction(frames):
    from docs.dj.detector_comparison.onnx_probe import predict
    spect = np.zeros((frames, 128), dtype=np.float32)
    spect[:, 0] = np.arange(frames)
    beat, downbeat = predict(_IndexSession(), spect)
    assert np.array_equal(beat, np.arange(frames)) and np.array_equal(downbeat, beat)


def test_torch_free_minimal_postprocessor_merges_adjacent_peaks_and_snaps_firsts_to_beats():
    from docs.dj.detector_comparison.onnx_probe import minimal
    beat = np.full(100, -5., dtype=np.float32)
    downbeat = beat.copy()
    beat[[10, 11, 60]] = 3.
    downbeat[61] = 2.
    beats, firsts = minimal(beat, downbeat)
    assert beats.tolist() == pytest.approx([10.5 / 50, 60 / 50])
    assert firsts.tolist() == pytest.approx([60 / 50])
