# Verified offline recovery

Stop the Station engine **and standalone download/sync tools** before copying.
`--stopped` records your confirmation; it does not stop processes or prove that
another container is not using the volumes. Keep writers stopped until the copy
finishes. Never test recovery against your only live copy.

```sh
python -m shared.instance_backup create /backups/before-update \
  --config-dir /path/to/config --data-dir /path/to/data \
  --music-dir /path/to/music --stopped
python -m shared.instance_backup verify /backups/before-update
python -m shared.instance_backup restore /backups/before-update /recovery/instance
```

The backup is a private directory containing `config/`, `data/`, optional
`music/`, and a manifest with the producing release, source locations, sizes and
SHA-256 checksums. It includes account credentials: protect it like the instance.
Encrypted storage credentials include their key as `config/.credentials.key`
inside the private backup. Current code uses that key after restoration even if
the replacement container has a different machine identity. Older releases that
do not understand the key file still require the original machine identity for
credential decryption. The source configuration is never rewritten by backup.
SQLite databases are copied through SQLite's backup API (including committed
WAL contents) and checked for integrity. Cache/log directories are not required.
Include music when it is the only copy of the audio. External scanned folders,
remote buckets and symlinks need their own backup; symlinks are refused rather
than silently omitted or followed. This is an offline copy, not a live snapshot.

Creation and restoration stage and verify the complete copy before publishing
it. Destinations must not exist; nothing is merged with an old installation.
Verification detects missing, extra and changed files. Checksums detect damage,
not an attacker who can rewrite both data and manifest. Keep a separate copy.

On a failed update, stop the new engine, retain its directories for diagnosis,
and restore the backup with the **same release that created it**. The restore
command deliberately uses no database manager and runs no migrations. Mount
restored `config`, `data`, and `music` at their original container paths, or put
them back at their original host paths while stopped. Absolute storage settings
and scanned-file paths are preserved, not rewritten; pointing runtime variables
at another directory alone does not relocate external audio. Start the old
release only after all roots are restored together. Pending work then follows
normal download recovery. Do not replay a legacy queue JSON over a newer DB.

The automated recovery rehearsal creates a real account, canonical library,
playlist and pending download, copies settings/favourites/artwork/audio, damages
the original database, and reopens the restored library through schema setup.
It also upgrades and restores the legacy single-user layout through the real
account migration, and verifies credential decryption after changing machine
identity. It separately covers committed WAL, damaged backups and refusal to overwrite.
This proves recovery of the fixture with current code, not compatibility with
all historical releases, physical power-loss durability or Windows acceptance.
