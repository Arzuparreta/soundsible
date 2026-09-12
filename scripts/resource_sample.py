#!/usr/bin/env python3
"""Read-only Linux process-tree sampling. No browser or game settings changed.

Example: python scripts/resource_sample.py --group server=123 --group client=456
         --group game=789 --seconds 60 --output /tmp/resources.json
CPU 100% means ONE logical CPU. PSS avoids double-counting shared memory.
GPU engine utilization is kept as raw nvidia-smi samples, not additive shares.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import time


def processes():
    result = {}
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit():
            continue
        try:
            raw = (directory / 'stat').read_text()
            fields = raw[raw.rfind(')') + 2:].split()
            result[int(directory.name)] = {
                'name': raw[raw.find('(') + 1:raw.rfind(')')],
                'parent': int(fields[1]), 'start': int(fields[19]),
                'ticks': int(fields[11]) + int(fields[12]),
            }
        except (OSError, ValueError, IndexError):
            continue
    return result


def counters(pid):
    result = {}
    for name, keys in [('smaps_rollup', {'Pss'}), ('io', {'read_bytes', 'write_bytes'})]:
        try:
            for line in (Path('/proc') / str(pid) / name).read_text().splitlines():
                key, value = line.split(':', 1)
                if key in keys:
                    result[key] = int(value.split()[0])
        except (OSError, ValueError):
            pass
    return result


def members(rows, root):
    found = {root} if root in rows else set()
    while True:
        expanded = found | {pid for pid, row in rows.items() if row['parent'] in found}
        if expanded == found:
            return found
        found = expanded


def sample(groups, seconds):
    hz = os.sysconf('SC_CLK_TCK')
    previous = processes()
    roots = {name: previous.get(pid, {}).get('start') for name, pid in groups.items()}
    previous_io = {pid: counters(pid) for root in groups.values() for pid in members(previous, root)}
    records = []
    start = last = time.monotonic()
    while time.monotonic() - start < seconds:
        time.sleep(min(1, max(0, seconds - (time.monotonic() - start))))
        now = time.monotonic()
        current = processes()
        row = {'elapsed_s': now - start, 'interval_s': now - last, 'groups': {}, 'group_status': {}}
        next_io = {}
        for label, root in groups.items():
            entries = []
            alive = roots[label] is not None and current.get(root, {}).get('start') == roots[label]
            for pid in members(current, root) if alive else []:
                proc = current[pid]
                old = previous.get(pid)
                same = old is not None and old['start'] == proc['start']
                count = counters(pid)
                next_io[pid] = count
                entries.append({
                    'pid': pid, 'name': proc['name'],
                    'cpu_percent_one_core': (100 * (proc['ticks'] - old['ticks']) / hz / (now - last)) if same else None,
                    'pss_kib': count.get('Pss'),
                    **{key: max(0, count[key] - previous_io[pid][key])
                       if same and key in count and key in previous_io.get(pid, {}) else None
                       for key in ('read_bytes', 'write_bytes')},
                })
            row['groups'][label] = entries
            row['group_status'][label] = {
                'root_alive': alive,
                'cpu_complete': alive and all(p['cpu_percent_one_core'] is not None for p in entries),
            }
        row['pressure'] = {}
        for kind in ('cpu', 'memory', 'io'):
            try:
                row['pressure'][kind] = Path('/proc/pressure', kind).read_text().strip()
            except OSError:
                pass
        records.append(row)
        previous, previous_io, last = current, next_io, now
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--group', action='append', required=True, metavar='NAME=PID')
    parser.add_argument('--seconds', type=int, default=60)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--label', default='', help='Scenario, visibility, playback and cache state')
    args = parser.parse_args()
    if not sys.platform.startswith('linux'):
        parser.error('This sampler requires Linux /proc counters')
    if args.seconds < 1:
        parser.error('--seconds must be positive')
    try:
        groups = {name: int(pid) for name, pid in (value.split('=', 1) for value in args.group)}
    except ValueError:
        parser.error('--group requires NAME=PID')
    if len(groups) != len(args.group) or any(not name or pid <= 0 for name, pid in groups.items()):
        parser.error('Use unique nonempty group names and positive PIDs')
    started = datetime.now(timezone.utc).isoformat()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    gpu_path = args.output.with_suffix('.gpu.txt')
    gpu_processes = []
    total_gpu_path = args.output.with_suffix('.gpu.csv')
    with gpu_path.open('w') as output, total_gpu_path.open('w') as total_output:
        if shutil.which('nvidia-smi'):
            gpu_processes.append(subprocess.Popen(
                ['nvidia-smi', 'pmon', '-c', str(args.seconds)], stdout=output, stderr=subprocess.STDOUT))
            gpu_processes.append(subprocess.Popen([
                'nvidia-smi', '--query-gpu=timestamp,index,utilization.gpu,power.draw,clocks.gr,memory.used,temperature.gpu',
                '--format=csv', '-l', '1',
            ], stdout=total_output, stderr=subprocess.STDOUT))
        try:
            rows = sample(groups, args.seconds)
        finally:
            for gpu in gpu_processes:
                if gpu.poll() is None:
                    gpu.terminate()
                try:
                    gpu.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    gpu.kill()
                    gpu.wait()
    report = {'started_utc': started, 'label': args.label, 'platform': platform.platform(),
              'logical_cpus': os.cpu_count(), 'requested_seconds': args.seconds, 'groups': groups, 'cpu_unit': '100 percent = one logical CPU',
              'limits': 'One-second sampling can miss short-lived workers. Missing counters are null; root exit or reuse invalidates the group. Groups may overlap. GPU percentages are not additive shares. No frame times recorded.',
              'samples': rows}
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for label in groups:
        valid = [row for row in rows if row['group_status'][label]['cpu_complete']]
        elapsed = sum(row['interval_s'] for row in valid)
        if not elapsed:
            print(f'{label}: CPU unavailable (no complete intervals)')
            continue
        weighted = sum(sum(p['cpu_percent_one_core'] for p in row['groups'][label]) * row['interval_s']
                       for row in valid) / elapsed
        print(f'{label}: mean CPU {weighted:.2f}% of one core ({len(valid)}/{len(rows)} complete intervals)')


if __name__ == '__main__':
    main()
