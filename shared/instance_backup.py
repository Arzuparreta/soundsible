"""Verified, offline instance copies. No migrations or application imports on restore.

The caller must stop every writer first (including standalone ODST). SQLite's
backup API includes committed WAL contents; it does not make multiple databases
and audio files a transaction while an instance is running.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import tempfile

from shared.version import resolve_version


MANIFEST = 'backup-manifest.json'
ROOTS = frozenset({'config', 'data', 'music'})


def _digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _sqlite(path):
    with path.open('rb') as stream:
        return stream.read(16) == b'SQLite format 3\x00'


def _check_sqlite(path):
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)) as conn:
        if conn.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError(f'Invalid SQLite database: {path.name}')


def _publish_directory(destination, populate):
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f'Destination must not exist: {destination}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.soundsible-backup-', dir=destination.parent))
    try:
        populate(stage)
        # The destination is reserved only after validation; never merge with
        # an existing instance. mkdir also detects a concurrent creator.
        destination.mkdir(mode=0o700)
        try:
            os.replace(stage, destination)
        except BaseException:
            destination.rmdir()
            raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return destination


def create_backup(destination, roots):
    """Copy stopped-instance roots to a new directory and verify before publishing."""
    roots = {name: Path(path).expanduser().resolve() for name, path in roots.items()}
    if not {'config', 'data'} <= roots.keys() or not roots.keys() <= ROOTS:
        raise ValueError('Supply config and data, and optionally music')
    target = Path(destination).expanduser().resolve()
    for name, root in roots.items():
        if not root.is_dir():
            raise ValueError(f'Missing {name} directory: {root}')
        if target == root or root in target.parents:
            raise ValueError('Backup destination must be outside the source roots')

    def populate(stage):
        files = {}
        for name, root in roots.items():
            (stage / name).mkdir()
            for source in sorted(root.rglob('*')):
                relative = Path(name) / source.relative_to(root)
                output = stage / relative
                if source.is_symlink():
                    raise ValueError(f'Symlinks require a separate backup: {relative}')
                if source.is_dir():
                    output.mkdir(exist_ok=True)
                    continue
                if not source.is_file():
                    raise ValueError(f'Unsupported file: {relative}')
                # WAL/journal files are represented by the SQLite snapshot.
                if source.name.endswith(('-wal', '-shm', '-journal')):
                    suffix = source.name.rsplit('-', 1)[0]
                    database = source.with_name(suffix)
                    if database.is_file() and _sqlite(database):
                        continue
                output.parent.mkdir(parents=True, exist_ok=True)
                if _sqlite(source):
                    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
                        with closing(sqlite3.connect(output)) as dst:
                            src.backup(dst)
                            dst.execute('PRAGMA journal_mode=DELETE')
                    shutil.copystat(source, output)
                    _check_sqlite(output)
                else:
                    shutil.copy2(source, output)
                files[relative.as_posix()] = {'sha256': _digest(output), 'size': output.stat().st_size}
        # Storage credentials historically depended on machine-id/username.
        # Carry their key inside the private backup so a replacement container
        # can decrypt them. Resolve against the supplied config, never the
        # operator's unrelated active runtime. The source is not modified.
        config = stage / 'config/config.json'
        if config.is_file():
            try:
                settings = json.loads(config.read_text(encoding='utf-8'))
            except (ValueError, UnicodeError):
                settings = {}  # Preserve damaged configuration byte-for-byte.
            if isinstance(settings, dict) and settings.get('is_encrypted'):
                from shared.crypto import CredentialManager
                key = CredentialManager.key_for_config(roots['config'])
                for field in ('access_key_id', 'secret_access_key'):
                    value = settings.get(field)
                    if value and CredentialManager.decrypt(value, key=key) is None:
                        raise ValueError('Storage credentials cannot be decrypted on this host; retain the original host/key')
                key_path = stage / 'config/.credentials.key'
                key_path.write_bytes(key)
                key_path.chmod(0o600)
                files['config/.credentials.key'] = {'sha256': _digest(key_path), 'size': key_path.stat().st_size}
        manifest = {'format': 1, 'soundsible': resolve_version(),
                    'roots': {name: str(root) for name, root in roots.items()}, 'files': files}
        (stage / MANIFEST).write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        verify_backup(stage)

    return _publish_directory(target, populate)


def verify_backup(directory):
    directory = Path(directory).absolute()
    manifest_path = directory / MANIFEST
    if manifest_path.is_symlink():
        raise ValueError('Manifest must be a regular file')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('format') != 1 or not {'config', 'data'} <= manifest.get('roots', {}).keys():
        raise ValueError('Unsupported backup manifest')
    if not manifest['roots'].keys() <= ROOTS:
        raise ValueError('Unknown backup root')
    for root in manifest['roots']:
        if not (directory / root).is_dir() or (directory / root).is_symlink():
            raise ValueError('Missing or unsafe backup root')
    actual = set()
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise ValueError('Symlinks are not supported in backups')
        if path != manifest_path and path.relative_to(directory).parts[0] not in manifest['roots']:
            raise ValueError('Unexpected backup directory or file')
        if path.is_file() and path != manifest_path:
            actual.add(path.relative_to(directory).as_posix())
    if actual != set(manifest['files']):
        raise ValueError('Backup file inventory does not match its manifest')
    for name, info in manifest['files'].items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts or relative.parts[0] not in manifest['roots']:
            raise ValueError('Unsafe backup path')
        path = directory / name
        if path.stat().st_size != info['size'] or _digest(path) != info['sha256']:
            raise ValueError(f'Backup checksum mismatch: {name}')
        if _sqlite(path):
            _check_sqlite(path)
    return manifest


def restore_backup(source, destination):
    """Restore into a new root containing config/, data/ and optional music/."""
    source = Path(source).resolve()
    target = Path(destination).expanduser().resolve()
    if source == target or source in target.parents:
        raise ValueError('Restore destination must be outside the backup')
    verify_backup(source)

    def populate(stage):
        shutil.copytree(source, stage, dirs_exist_ok=True)
        verify_backup(stage)
        (stage / MANIFEST).unlink()

    return _publish_directory(destination, populate)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    create = sub.add_parser('create')
    create.add_argument('destination', type=Path)
    create.add_argument('--config-dir', required=True, type=Path)
    create.add_argument('--data-dir', required=True, type=Path)
    create.add_argument('--music-dir', type=Path)
    create.add_argument('--stopped', required=True, action='store_true', help='Confirm all instance writers are stopped')
    verify = sub.add_parser('verify')
    verify.add_argument('source', type=Path)
    restore = sub.add_parser('restore')
    restore.add_argument('source', type=Path)
    restore.add_argument('destination', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'create':
            roots = {'config': args.config_dir, 'data': args.data_dir}
            if args.music_dir:
                roots['music'] = args.music_dir
            result = create_backup(args.destination, roots)
        elif args.command == 'verify':
            result = verify_backup(args.source)
            result = f"Verified {len(result['files'])} files; music included: {'music' in result['roots']}"
        else:
            result = restore_backup(args.source, args.destination)
        print(result)
    except (OSError, ValueError, sqlite3.Error, KeyError, TypeError) as exc:
        parser.exit(1, f'Backup failed: {exc}\n')


if __name__ == '__main__':
    main()
