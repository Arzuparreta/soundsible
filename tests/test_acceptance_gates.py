import ast
import json

import pytest

from scripts.playback_report import evaluate_acceptance
from scripts.security_gate import check_report, finding_key


def test_missing_telemetry_cannot_pass_acceptance():
    policy = {'buckets': {'local': {'min_samples': 10, 'max_p95_ms': 2000}},
              'stability': {'whole_file': {'min_minutes': 60, 'max_rebuffers_per_hour': 1}}}
    report = {'buckets': {}, 'stability': {}, 'media_session': {'declaration_mismatches': 0}}
    assert evaluate_acceptance(report, policy)['status'] == 'inconclusive'
    report['buckets']['local'] = {'samples': 10, 'p95_ms': 3000}
    assert evaluate_acceptance(report, policy)['status'] == 'failed'
    report['buckets']['local']['p95_ms'] = 1000
    report['stability']['whole_file'] = {'audible_minutes': 60, 'rebuffers_per_hour': 0}
    assert evaluate_acceptance(report, policy)['status'] == 'passed'


def test_security_scanner_errors_are_fatal():
    with pytest.raises(ValueError):
        check_report({'errors': ['unreadable source'], 'results': []}, {})
    with pytest.raises(ValueError):
        check_report({}, {})


def test_security_fingerprint_tracks_syntax_not_line_movement(tmp_path):
    source = tmp_path / 'sample.py'
    source.write_text('value = dangerous(user_input)\n')
    finding = {'filename': 'sample.py', 'test_id': 'B999', 'line_number': 1}
    first = finding_key(finding, tmp_path)
    source.write_text('\n\nvalue = dangerous(user_input)\n')
    assert finding_key({**finding, 'line_number': 3}, tmp_path) == first
    source.write_text('value = dangerous(other_input)\n')
    assert finding_key(finding, tmp_path) != first
