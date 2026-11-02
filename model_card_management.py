"""Delete a discovery card without deleting local files or download records."""
import uuid
from download_reviews import clean_deleted_group
import hashlib
import json


def summary(conn, model_id):
    row = conn.execute('SELECT id,name,display_name,source,model_key,favorite FROM models WHERE id=?', (model_id,)).fetchone()
    if row is None:
        return None
    sources = [dict(r) for r in conn.execute('SELECT source,model_key FROM model_sources WHERE model_id=? ORDER BY source,model_key', (model_id,))]
    identity = [dict(row), sources]
    result = dict(row)
    result['name'] = row['display_name'] or row['name'] or 'Untitled model'
    result['sources'] = sources
    result['identity'] = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    for table in ('download_history', 'installed_files', 'download_queue', 'download_watchlist'):
        result[table] = conn.execute(f'SELECT COUNT(*) FROM {table} WHERE model_id=?', (model_id,)).fetchone()[0]
    return result


def delete_card(conn, model_id, expected_identity):
    """Single transaction; detach retained tracking so SQLite ID reuse is safe."""
    try:
        conn.execute('BEGIN IMMEDIATE')
        current = summary(conn, model_id)
        if current is None:
            raise LookupError('This model card no longer exists.')
        if current['identity'] != expected_identity:
            raise ValueError('This model card changed. Reopen it before deleting.')
        group = uuid.uuid4().hex
        if not current['favorite']:
            conn.execute("""UPDATE download_reviews AS r SET deletion_group=?
                WHERE EXISTS(SELECT 1 FROM model_sources s WHERE s.model_id=?
                    AND lower(s.source)=lower(r.source) AND s.model_key=r.model_key)
                OR id IN (SELECT review_id FROM installed_files WHERE model_id=?)""",
                (group, model_id, model_id))
        for table in ('download_history', 'installed_files'):
            conn.execute(f'UPDATE {table} SET model_id=NULL WHERE model_id=?', (model_id,))
        for table in ('download_queue', 'download_watchlist', 'model_file_hashes',
                      'scan_model_changes', 'collection_families', 'model_media', 'model_sources'):
            conn.execute(f'DELETE FROM {table} WHERE model_id=?', (model_id,))
        conn.execute('DELETE FROM models WHERE id=?', (model_id,))
        clean_deleted_group(conn, group)
        conn.commit()
        return current
    except Exception:
        conn.rollback()
        raise
