"""Bounded transactional key journals. They contain no metadata bodies."""
from dataclasses import dataclass

MAX_EVENTS = 10000
MAX_KEYS = 2000


@dataclass(frozen=True)
class Cursor:
    epoch: str
    seq: int
    floor: int

    def to_list(self):
        return [self.epoch, self.seq, self.floor]

    @classmethod
    def parse(cls, value):
        return cls(*value)


def cursor(conn):
    return Cursor(*conn.execute('SELECT epoch,seq,floor FROM public_changes_state WHERE singleton=1').fetchone())


def install_changes(conn, sources):
    """Sources are internal (table, kind, primary-key column) constants.

    At most MAX_EVENTS + 255 entries survive. Keys exceeding 512 UTF-8 bytes
    record a gap instead; clients crossing it must obtain a full snapshot.
    Row-key renames record a deletion and insertion, including on raw SQL.
    """
    conn.execute('CREATE TABLE IF NOT EXISTS public_changes_state ('
                 'singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT, seq INTEGER, floor INTEGER)')
    conn.execute('INSERT OR IGNORE INTO public_changes_state VALUES (1,lower(hex(randomblob(16))),0,0)')
    conn.execute('CREATE TABLE IF NOT EXISTS public_changes ('
                 'seq INTEGER PRIMARY KEY,kind TEXT,key TEXT,operation TEXT)')
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
                    UPDATE public_changes_state SET seq=seq+1 WHERE singleton=1 AND ({condition});
                    INSERT INTO public_changes SELECT seq,
                        CASE WHEN {valid} THEN '{kind}' ELSE 'gap' END,
                        CASE WHEN {valid} THEN CAST({value} AS TEXT) ELSE '' END, {action}
                        FROM public_changes_state WHERE singleton=1 AND ({condition});
                    DELETE FROM public_changes WHERE seq <= (
                        SELECT seq-{MAX_EVENTS} FROM public_changes_state WHERE seq%256=0);
                    UPDATE public_changes_state SET floor=MAX(floor,seq-{MAX_EVENTS}) WHERE seq%256=0;
                '''
            conn.execute(f'CREATE TRIGGER IF NOT EXISTS changes_{table}_{operation} '
                         f'AFTER {operation} ON {table} BEGIN {body} END')


def changes_since(conn, previous, expected):
    """Coalesce keys, preserving their first operation since the client's base.

    The first INSERT means the key did not exist at the base. This matters when
    something is added and deleted between polls: do not send a bogus removal.
    Call inside a read transaction; the cursor check and events share a snapshot.
    """
    now = cursor(conn)
    if now != expected or previous.epoch != now.epoch or not now.floor <= previous.seq <= now.seq:
        return None
    rows = conn.execute('''
        SELECT c.kind,c.key,c.operation FROM public_changes c
        JOIN (SELECT MIN(seq) AS seq FROM public_changes WHERE seq>?
              GROUP BY kind,key LIMIT ?) first ON first.seq=c.seq
    ''', (previous.seq, MAX_KEYS + 1)).fetchall()
    if len(rows) > MAX_KEYS or any(row[0] == 'gap' for row in rows):
        return None
    return [tuple(row) for row in rows]
