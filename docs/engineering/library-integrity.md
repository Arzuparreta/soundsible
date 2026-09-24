# Library integrity and recovery

## Audio ownership

A library owns references; managed audio can belong to several accounts. Removing
one account's reference is committed before physical cleanup. Cleanup intents
live in `instance.db` and survive crashes. A periodic pass checks all canonical
account databases (including disabled accounts); unknown or unreadable state
retains the object. Storage changes do not retarget old cleanup intents.

Canonical replacements and cleanup use one reentrant process/file lock, acquired
before SQLite transactions. External scanned originals are borrowed and never
removed. Repairs and optimization retain their previous objects until canonical
references have moved. A failed remap preserves the original and reports failure.

A library wipe clears that account only; it no longer enumerates and deletes a
shared bucket. Artwork remains under its existing reference-management policy.

Validation uses temporary libraries and managed files. No live library is used
for fault injection; Windows file locking still needs native platform acceptance.
