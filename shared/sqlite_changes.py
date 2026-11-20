"""Bounded transactional key journals. They contain no metadata bodies."""
from dataclasses import dataclass

MAX_EVENTS = 10000
MAX_KEYS = 2000


@dataclass(frozen=True)
class Cursor:
    epoch: str
    seq: int
    floor: int
    anchor: str | None = None

    def to_list(self):
        return [self.epoch, self.seq, self.floor, self.anchor]

    @classmethod
    def parse(cls, value):
        return cls(*value)


def cursor(conn, *, journal='public_changes'):
    return Cursor(*conn.execute(f'''
        SELECT s.epoch,s.seq,s.floor,CASE WHEN s.seq=0 THEN s.epoch ELSE a.token END
        FROM {journal}_state s LEFT JOIN {journal}_anchors a ON a.seq=s.seq
        WHERE s.singleton=1
    ''').fetchone())


def install_changes(conn, sources, *, journal='public_changes'):
    """Sources are internal (table, kind, primary-key column) constants.

    At most MAX_EVENTS + 255 entries survive. Keys exceeding 512 UTF-8 bytes
    record a gap instead; clients crossing it must obtain a full snapshot.
    Row-key renames record a deletion and insertion, including on raw SQL.
    """
    if not journal.isidentifier():
        raise ValueError('Journal names must be internal identifiers')
    conn.execute(f'CREATE TABLE IF NOT EXISTS {journal}_state ('
                 'singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT, seq INTEGER, floor INTEGER)')
    conn.execute(f'INSERT OR IGNORE INTO {journal}_state VALUES (1,lower(hex(randomblob(16))),0,0)')
    conn.execute(f'CREATE TABLE IF NOT EXISTS {journal} ('
                 'seq INTEGER PRIMARY KEY,kind TEXT,key TEXT,operation TEXT)')
    # Copied databases can independently reach the same sequence. An anchor
    # at the client's sequence distinguishes the retained history on each
    # branch. Auxiliary triggers preserve the event schema for older writers.
    conn.execute(f'CREATE TABLE IF NOT EXISTS {journal}_anchors (seq INTEGER PRIMARY KEY,token TEXT NOT NULL)')
    conn.execute(f'''
        INSERT OR IGNORE INTO {journal}_anchors
        SELECT e.seq,lower(hex(randomblob(16))) FROM {journal}_state s
        JOIN {journal} e ON e.seq=s.seq WHERE s.singleton=1
    ''')
    conn.execute(f'''
        CREATE TRIGGER IF NOT EXISTS anchor_{journal}_insert AFTER INSERT ON {journal} BEGIN
            INSERT OR REPLACE INTO {journal}_anchors VALUES (NEW.seq,lower(hex(randomblob(16))));
        END
    ''')
    conn.execute(f'''
        CREATE TRIGGER IF NOT EXISTS anchor_{journal}_delete AFTER DELETE ON {journal} BEGIN
            DELETE FROM {journal}_anchors WHERE seq=OLD.seq;
        END
    ''')
    for table, kind, key in sources:
        if not all(name.isidentifier() for name in (table, kind, key)):
            raise ValueError('Journal names must be internal identifiers')
        for operation in ('INSERT', 'UPDATE', 'DELETE'):
            emissions = []
            if operation == 'UPDATE':
                emissions.append((f'OLD.{key}', "'DELETE'", f'OLD.{key} IS NOT NEW.{key}'))
                emissions.append((f'NEW.{key}', f"CASE WHEN OLD.{key} IS NOT NEW.{key} THEN 'INSERT' ELSE 'UPDATE' END", '1'))
            else:
                emissions.append((f'{"OLD" if operation == "DELETE" else "NEW"}.{key}', f"'{operation}'", '1'))
            body = ''
            for value, action, condition in emissions:
                valid = f'{value} IS NOT NULL AND length(CAST({value} AS BLOB))<=512'
                body += f'''
                    UPDATE {journal}_state SET seq=seq+1 WHERE singleton=1 AND ({condition});
                    INSERT INTO {journal} SELECT seq,
                        CASE WHEN {valid} THEN '{kind}' ELSE 'gap' END,
                        CASE WHEN {valid} THEN CAST({value} AS TEXT) ELSE '' END, {action}
                        FROM {journal}_state WHERE singleton=1 AND ({condition});
                    DELETE FROM {journal} WHERE seq <= (
                        SELECT seq-{MAX_EVENTS} FROM {journal}_state WHERE seq%256=0);
                    UPDATE {journal}_state SET floor=MAX(floor,seq-{MAX_EVENTS}) WHERE seq%256=0;
                '''
            conn.execute(f'CREATE TRIGGER IF NOT EXISTS changes_{table}_{operation} '
                         f'AFTER {operation} ON {table} BEGIN {body} END')


def changes_since(conn, previous, expected, *, journal='public_changes'):
    """Coalesce keys, preserving their first operation since the client's base.

    The first INSERT means the key did not exist at the base. This matters when
    something is added and deleted between polls: do not send a bogus removal.
    Call inside a read transaction; the cursor check and events share a snapshot.
    """
    now = cursor(conn, journal=journal)
    in_window = (previous.seq == 0 and now.floor == 0) or (now.floor < previous.seq <= now.seq)
    if now != expected or previous.epoch != now.epoch or previous.anchor is None or not in_window:
        return None
    if previous.seq == now.seq:
        return [] if previous.anchor == now.anchor else None
    if previous.seq:
        row = conn.execute(f'SELECT token FROM {journal}_anchors WHERE seq=?', (previous.seq,)).fetchone()
        if row is None or previous.anchor != row[0]:
            return None
    rows = conn.execute(f'''
        SELECT c.kind,c.key,c.operation FROM {journal} c
        JOIN (SELECT MIN(seq) AS seq FROM {journal} WHERE seq>?
              GROUP BY kind,key LIMIT ?) first ON first.seq=c.seq
    ''', (previous.seq, MAX_KEYS + 1)).fetchall()
    if len(rows) > MAX_KEYS or any(row[0] == 'gap' for row in rows):
        return None
    return [tuple(row) for row in rows]
