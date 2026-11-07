"""Recovery must preserve artifacts and never turn missing provenance green."""

from pathlib import Path
import re

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
ACTION = './.github/actions/attest-with-retry'


def load(relative):
    return yaml.safe_load((ROOT / relative).read_text())


def retry_plan(results):
    """Evaluate the composite's outcome guards with injected signer failures.

    GitHub executes the real signer; this checks the recovery graph offline,
    including skipped attempts and whether the last failure reaches the caller.
    """
    steps = load('.github/actions/attest-with-retry/action.yml')['runs']['steps']
    outcomes = {}
    calls, waits = [], []
    failed = False
    for step in steps:
        if 'if' in step:
            guard = re.fullmatch(r"steps\.(\w+)\.outcome == 'failure'", step['if'])
            assert guard, 'Keep recovery guards outcome-based and cancellation-aware'
            if outcomes.get(guard[1]) != 'failure':
                if 'id' in step:
                    outcomes[step['id']] = 'skipped'
                continue
        if 'run' in step:
            # Only bounded, increasing delays: no network or rebuild commands.
            delay = re.search(r'^sleep (\d+)$', step['run'], re.MULTILINE)
            assert delay
            waits.append(int(delay[1]))
            continue
        assert step['uses'] == 'actions/attest-build-provenance@v4.2.2'
        calls.append(step)
        outcome = results[len(calls) - 1]
        outcomes[step['id']] = outcome
        if outcome == 'failure' and not step.get('continue-on-error', False):
            failed = True
            break
    return calls, waits, failed


@pytest.mark.parametrize('failures', range(4))
def test_transient_failure_recovers_and_stops_retrying(failures):
    calls, waits, failed = retry_plan(['failure'] * failures + ['success'])
    assert len(calls) == failures + 1
    assert waits == [30, 90, 180][:failures]
    assert not failed
    # Every retry signs the identical subject, with the same registry policy.
    assert all(call['with'] == calls[0]['with'] for call in calls)
    assert calls[0]['with'] == {
        'subject-path': '${{ inputs.subject-path }}',
        'subject-name': '${{ inputs.subject-name }}',
        'subject-digest': '${{ inputs.subject-digest }}',
        'push-to-registry': '${{ inputs.push-to-registry }}',
    }


def test_persistent_outage_remains_a_failure():
    calls, waits, failed = retry_plan(['failure'] * 4)
    assert len(calls) == 4
    assert sum(waits) == 300
    assert failed, 'A missing attestation must block the calling job/release'


def test_installer_certification_uses_preserved_build_artifacts():
    jobs = load('.github/workflows/desktop-build.yml')['jobs']
    build = jobs['build-windows']
    assert not any('attest' in step.get('uses', '') for step in build['steps'])
    assert any(step.get('uses', '').startswith('actions/upload-artifact@')
               and '*.exe' in step.get('with', {}).get('path', '')
               for step in build['steps'])
    certify = jobs['attest-windows']
    assert certify['needs'] == 'build-windows'
    assert certify['if'] == "github.event_name != 'pull_request'"
    assert not certify.get('continue-on-error')
    assert certify['strategy']['matrix']['arch'] == ['x64', 'arm64']
    steps = certify['steps']
    download = next(step for step in steps if step.get('uses', '').startswith('actions/download-artifact@'))
    attest = next(step for step in steps if step.get('uses') == ACTION)
    assert steps.index(download) < steps.index(attest)
    assert download['with']['path'] == '${{ runner.temp }}/installers'
    assert attest['with']['subject-path'] == '${{ runner.temp }}/installers/*.exe'
    assert not attest.get('continue-on-error')
    # A successful Windows build alone must not unblock the public release.
    release = load('.github/workflows/release.yml')['jobs']
    assert release['installers']['uses'] == './.github/workflows/desktop-build.yml'
    assert 'installers' in release['publish']['needs']


def test_image_certification_reuses_digest_without_rebuilding_or_retagging():
    jobs = load('.github/workflows/ci.yml')['jobs']
    publish = jobs['publish']
    assert publish['outputs']['image_digest'] == '${{ steps.build.outputs.digest }}'
    assert not any('attest' in step.get('uses', '') for step in publish['steps'])
    certify = jobs['attest_image']
    assert certify['needs'] == 'publish'
    assert not certify.get('continue-on-error')
    assert not any('build-push' in step.get('uses', '') for step in certify['steps'])
    attest = next(step for step in certify['steps'] if step.get('uses') == ACTION)
    assert attest['with']['subject-digest'] == '${{ needs.publish.outputs.image_digest }}'
    assert attest['with']['push-to-registry'] is True
    assert not attest.get('continue-on-error')
