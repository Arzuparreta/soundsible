#!/usr/bin/env python3
"""Fail on new medium/high-confidence production Bandit findings.

The baseline is a reviewed set of exact syntax fingerprints, not a global
suppression of a rule. Altering an accepted expression requires a new review.
Scanner crashes, unreadable files and malformed reports also fail the gate.
"""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ['shared', 'player', 'odst_tool', 'setup_tool', 'launcher_web']
BASELINE = ROOT / 'docs/security-baseline.json'


def finding_key(finding, root=ROOT):
    path = Path(finding['filename'])
    if path.is_absolute():
        path = path.relative_to(root)
    tree = ast.parse((root / path).read_text(encoding='utf-8'))
    line = finding['line_number']
    candidates = [node for node in ast.walk(tree) if isinstance(node, ast.stmt)
                  and node.lineno <= line <= node.end_lineno]
    statement = min(candidates, key=lambda node: (node.end_lineno-node.lineno, -node.col_offset))
    fingerprint = hashlib.sha256(ast.dump(statement, include_attributes=False).encode()).hexdigest()
    return f"{path.as_posix()}:{finding['test_id']}:{fingerprint}"


def check_report(report, accepted):
    if report.get('errors'):
        raise ValueError('Bandit could not scan all production files')
    if 'results' not in report or not isinstance(report['results'], list):
        raise ValueError('Invalid Bandit report')
    return [finding for finding in report['results'] if finding_key(finding) not in accepted]


def main():
    accepted = json.loads(BASELINE.read_text())['accepted']
    with tempfile.TemporaryDirectory(prefix='soundsible-security-') as temporary:
        report_path = Path(temporary) / 'report.json'
        result = subprocess.run([sys.executable, '-m', 'bandit', '-r', *TARGETS,
                                 '-ll', '-ii', '-f', 'json', '-o', str(report_path)], cwd=ROOT)
        if result.returncode not in (0, 1) or not report_path.exists():
            raise RuntimeError('Bandit failed to produce a report')
        report = json.loads(report_path.read_text())
        new = check_report(report, accepted)
        for finding in new:
            print(f"{finding['filename']}:{finding['line_number']} {finding['test_id']}: {finding['issue_text']}")
        print(f"Security gate: {len(new)} new findings; {len(report['results'])-len(new)} reviewed findings")
        return 1 if new else 0


if __name__ == '__main__':
    raise SystemExit(main())
