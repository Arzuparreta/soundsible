# Portable Soundsible instances

A portable instance is one directory containing the complete Soundsible
installation state: every account, library, playlist, queue, recommendation
signal, shared cache, and audio file. The application binary is installed
separately; moving the instance does not require rewriting paths.

## Directory contract

```text
My Soundsible/
├── soundsible.instance.json   # format marker and stable instance id
├── soundsible.db              # canonical transactional state for all users
├── config.json                # non-secret instance configuration
├── media/
│   └── tracks/                # shared content-addressed audio
├── data/
│   └── telemetry/
├── cache/
├── logs/
├── runtime/                   # lock, PID state, ephemeral owner token
└── backups/
```

Paths persisted in the instance are relative to this root. There is no
per-account directory: user ownership and isolation are represented by
`user_id` and foreign keys inside `soundsible.db`.

SQLite remains a deliberate fit here. It gives Soundsible transactions,
referential integrity, full-text search, crash-safe WAL recovery, online backup,
and a single movable database without requiring a separate database server.
Portable mode uses `foreign_keys=ON`, a 5-second busy timeout, WAL, and
`synchronous=FULL`.

## Commands

Create, run, inspect, and back up an instance:

```bash
python3 run.py --create-instance "/path/My Soundsible"
python3 run.py --daemon --instance-dir "/path/My Soundsible"
python3 run.py --instance-doctor "/path/My Soundsible"
python3 run.py --instance-backup "/path/My Soundsible"
```

The desktop app creates or opens the selected directory and remembers only its
last location in the machine's platform config directory.

To copy a legacy installation into a new portable instance:

```bash
python3 run.py --migrate-instance "/path/My Soundsible"
```

Migration is non-destructive. It builds a staging instance, copies shared media,
imports all users and their state, runs SQLite integrity checks, writes an audit
report, and only then publishes the target directory. Existing source files are
left untouched.

## Moving and copying

1. Stop Soundsible cleanly.
2. Move or copy the whole directory.
3. Open the directory on the destination machine.

Do not copy a live instance. SQLite's `-wal` and `-shm` files are part of an
active database state, and the instance lock intentionally prevents two engines
from opening the same directory. Use `--instance-backup` for a consistent
database backup while the source is running.

Local disks and normal removable drives are supported. SMB/NFS/network
filesystems are not a safe default because their locking and durability
semantics vary; keep the live instance on a local filesystem and copy a stopped
instance or backup instead.

## Credentials and privacy

Cloud access keys are intentionally not portable. They are encrypted with the
machine-bound credential key and stored in the platform config directory,
keyed by the instance id. `config.json` contains blank secret fields. Opening
the instance on another computer therefore keeps the library and configuration
but requires cloud reauthentication.

The `runtime/` directory can contain a short-lived local owner token and process
metadata while Soundsible is running. Both are invalidated or removed during a
clean shutdown. Treat the whole instance as private data and encrypt the drive
when its contents require protection.

## Compatibility

Legacy split-directory installations continue to work. Portable mode is enabled
only with `--instance-dir`, `SOUNDSIBLE_INSTANCE_DIR`, or the desktop instance
picker. JSON manifests are accepted as migration inputs; in portable mode
SQLite is canonical and API JSON responses are derived views.
