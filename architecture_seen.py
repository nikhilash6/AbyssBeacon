"""Architecture-specific New/Seen state; models.viewed remains a summary."""
import json
from functools import lru_cache


def mapping(value):
    if isinstance(value, str):
        try: value = json.loads(value)
        except (ValueError, TypeError): return {}
    return value if isinstance(value, dict) else {}


@lru_cache(maxsize=8192)
def _canonical(value, revision):
    from scanners.common.processors import classify_architecture
    return classify_architecture(value) or 'Other'


def canonical(value):
    from utils.loader import CONFIG_PATH
    path = CONFIG_PATH / 'architectures.json'
    return _canonical(value, path.stat().st_mtime_ns if path.exists() else 0)


def labels(snapshot):
    snapshot = mapping(snapshot)
    values = [snapshot.get('architecture'), snapshot.get('base_model')]
    card = mapping(snapshot.get('card_data'))
    containers = [snapshot, card] + [card[key] for key in
        ('huggingface','modelscope','civitai','civitaired','seaart','tensorhub') if isinstance(card.get(key),dict)]
    for data in containers:
        values.extend([data.get('architecture'), data.get('base_model'), data.get('baseModel')])
        versions = data.get('versions')
        for version in versions if isinstance(versions, list) else []:
            if isinstance(version, dict):
                values.extend([version.get('architecture'), version.get('base_model'), version.get('baseModel')])
    found = {canonical(str(value).strip()) for value in values if value}
    return (found - {'Other'}) or {'Other'}


def ensure_schema(conn):
    created = not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_architecture_seen'").fetchone()
    conn.execute('''CREATE TABLE IF NOT EXISTS model_architecture_seen (
        model_id INTEGER NOT NULL, architecture TEXT NOT NULL COLLATE NOCASE,
        seen INTEGER NOT NULL DEFAULT 0 CHECK(seen IN (0,1)),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        PRIMARY KEY(model_id,architecture), FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE)''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_architecture_seen_scope ON model_architecture_seen(architecture,active,seen,model_id)')
    # The application historically does not enable foreign_keys on every handle.
    conn.execute('''CREATE TRIGGER IF NOT EXISTS cleanup_architecture_seen AFTER DELETE ON models
        BEGIN DELETE FROM model_architecture_seen WHERE model_id=OLD.id; END''')
    return created


def summarize(cursor, model_id):
    cursor.execute('''UPDATE models SET viewed=CASE WHEN EXISTS (
        SELECT 1 FROM model_architecture_seen a WHERE a.model_id=models.id AND a.active=1 AND a.seen=0
        ) THEN 0 ELSE 1 END WHERE id=?''', (model_id,))


def sync(cursor, model_id):
    row = cursor.execute('SELECT architecture,base_model,card_data,viewed FROM models WHERE id=?', (model_id,)).fetchone()
    if not row: return
    found = labels(dict(row))
    for source in cursor.execute('SELECT source_data FROM model_sources WHERE model_id=?', (model_id,)).fetchall():
        found.update(labels(source['source_data']))
    if len(found)>1: found.discard('Other')
    prior = cursor.execute('SELECT 1 FROM model_architecture_seen WHERE model_id=? LIMIT 1', (model_id,)).fetchone()
    # First migration inherits legacy state. Later newly discovered memberships
    # are New even when all previously known architectures were Seen.
    initial = 0 if prior else int(bool(row['viewed']))
    cursor.execute('UPDATE model_architecture_seen SET active=0 WHERE model_id=?', (model_id,))
    for name in sorted(found):
        cursor.execute('''INSERT INTO model_architecture_seen(model_id,architecture,seen,active) VALUES(?,?,?,1)
            ON CONFLICT(model_id,architecture) DO UPDATE SET active=1''', (model_id,name,initial))
    if prior:
        summarize(cursor, model_id)


def backfill(conn):
    # Stream the legacy database rather than loading all source_data into RAM.
    rows = conn.execute('SELECT id FROM models WHERE NOT EXISTS (SELECT 1 FROM model_architecture_seen a WHERE a.model_id=models.id) ORDER BY id')
    cursor = conn.cursor()
    for row in rows:
        sync(cursor, row['id'])


def merge(cursor, winner_id, loser_id):
    for row in cursor.execute('SELECT * FROM model_architecture_seen WHERE model_id=?', (loser_id,)).fetchall():
        cursor.execute('''INSERT INTO model_architecture_seen(model_id,architecture,seen,active) VALUES(?,?,?,?)
            ON CONFLICT(model_id,architecture) DO UPDATE SET seen=MIN(seen,excluded.seen),active=MAX(active,excluded.active)''',
            (winner_id,row['architecture'],row['seen'],row['active']))
    sync(cursor, winner_id)


def selection(value):
    if isinstance(value,str):
        try: value=json.loads(value) if value.strip().startswith('[') else [value]
        except ValueError: value=[]
    return list(dict.fromkeys(str(v).strip() for v in (value or []) if str(v).strip()))[:64]


def new_condition(architectures=None, model_ref='models'):
    names=selection(architectures)
    clause=f'EXISTS (SELECT 1 FROM model_architecture_seen ast WHERE ast.model_id={model_ref}.id AND ast.active=1 AND ast.seen=0'
    if names: clause+=' AND ast.architecture IN ('+','.join('?' for _ in names)+')'
    return clause+')',names


def mark(conn, architectures=None, ids=None, preview=False):
    if not conn.in_transaction:
        conn.execute('BEGIN' if preview else 'BEGIN IMMEDIATE')
    names=selection(architectures)
    where=['active=1','seen=0'];params=[]
    if names:
        where.append('architecture IN ('+','.join('?' for _ in names)+')');params.extend(names)
    if ids is not None:
        ids=list(dict.fromkeys(int(v) for v in ids if str(v).isdigit()))
        if not ids:return {'changed':0,'architecture_states':0}
        # Use a JSON array to avoid SQLite's host-parameter limit for large calls.
        where.append('model_id IN (SELECT value FROM json_each(?))');params.append(json.dumps(ids))
    predicate=' AND '.join(where)
    count=conn.execute('SELECT COUNT(DISTINCT model_id),COUNT(*) FROM model_architecture_seen WHERE '+predicate,params).fetchone()
    result={'changed':count[0],'architecture_states':count[1]}
    if not preview and count[1]:
        touched=[row[0] for row in conn.execute('SELECT DISTINCT model_id FROM model_architecture_seen WHERE '+predicate,params)]
        conn.execute('UPDATE model_architecture_seen SET seen=1 WHERE '+predicate,params)
        # Clearing cannot make a card New. Avoid rewriting already-seen model
        # rows or shared cards that still have another unseen architecture.
        conn.execute('''UPDATE models SET viewed=1 WHERE viewed=0
            AND id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (
            SELECT 1 FROM model_architecture_seen a WHERE a.model_id=models.id AND a.active=1 AND a.seen=0)''',
            (json.dumps(touched),))
    return result


def annotate(conn, models, architectures=None):
    ids=[int(m['id']) for m in models]
    if not ids:return
    rows=conn.execute('SELECT model_id,architecture,seen FROM model_architecture_seen WHERE active=1 AND model_id IN (SELECT value FROM json_each(?))',(json.dumps(ids),)).fetchall()
    lookup={}
    for row in rows:lookup.setdefault(row['model_id'],{})[row['architecture']]=bool(row['seen'])
    selected={v.casefold() for v in selection(architectures)}
    for model in models:
        states=lookup.get(int(model['id']),{})
        model['architecture_seen']=states
        model['new_architectures']=[name for name,seen in states.items() if not seen]
        relevant=[seen for name,seen in states.items() if not selected or name.casefold() in selected]
        if states:model['viewed']=int(all(relevant))
