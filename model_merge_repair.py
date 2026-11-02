"""Reconcile an existing CivitAI mirror pair on an explicit model reload."""
FAMILY = {'civitai', 'civitaired'}
from model_identity import decoded, sha256


def mirror_identity(model):
    """Exact shared-provider inventory, including non-weight artifacts.

    All advertised versions and every file must have stable numeric IDs and a
    full SHA256. This proof is only valid inside the CivitAI/Red ID namespace.
    Filenames and provider primary flags do not affect artifact identity.
    """
    if str(model.get('source') or '').lower() not in FAMILY:
        return None
    key = str(model.get('model_key') or '').strip()
    kind = str(model.get('model_type') or '').strip().casefold()
    arch = str(model.get('architecture') or '').strip().casefold()
    if not key.isdigit() or not kind or arch in {'', 'other', 'unknown'}:
        return None
    card = decoded(model.get('card_data'), {})
    provider = str(model.get('source') or '').lower()
    data = card.get(provider) if isinstance(card.get(provider), dict) else card
    versions = data.get('versions')
    if not isinstance(versions, list) or not versions:
        return None
    declared = set()
    for version in versions:
        ident = str((version.get('id') or version.get('version_id') or '') if isinstance(version, dict) else version).strip()
        if not ident.isdigit():
            return None
        declared.add(ident)
    try:
        if data.get('version_count') is not None and int(data['version_count']) > len(declared):
            return None
    except (ValueError, TypeError):
        return None
    files = decoded(model.get('files'), [])
    if not files:
        return None
    groups = {}
    seen = set()
    for file in files:
        if not isinstance(file, dict):
            return None
        version = str(file.get('version_id') or file.get('modelVersionId') or file.get('model_version_id') or '').strip()
        ident = str(file.get('id') or file.get('file_id') or file.get('fileId') or '').strip()
        digest = sha256(file)
        if version not in declared or not ident.isdigit() or not digest or ident in seen:
            return None
        seen.add(ident)
        groups.setdefault(version, []).append((ident, digest))
    if set(groups) != declared:
        return None
    return key, kind, arch, tuple(sorted((version, tuple(sorted(files))) for version, files in groups.items()))



def _native_identity(model):
    """Provider-native model/version/file IDs, independent of gated file hashes.

    CivitAI and CivitAI Red mirror the same numeric model/version namespace.
    Only use this route for that exact pair; other sources still require the
    complete SHA-based proof. A common model ID *and* a common version ID are
    required, so an unverified title or an empty paid-download placeholder can
    never establish a match on its own.
    """
    source = str(model.get('source') or '').strip().lower()
    key = str(model.get('model_key') or '').strip()
    if source not in FAMILY or not key.isdigit():
        return None
    card = decoded(model.get('card_data'), {})
    data = card.get(source) if isinstance(card.get(source), dict) else card
    versions = set()
    for item in data.get('versions') or []:
        ident = (item.get('id') or item.get('version_id')) if isinstance(item, dict) else item
        ident = str(ident or '').strip()
        if ident.isdigit():
            versions.add(ident)
    # Some restricted listings expose only their selected version; that is
    # still an explicit native version ID, not a guessed file or card hash.
    selected = str(data.get('version_id') or '').strip()
    if selected.isdigit():
        versions.add(selected)
    if not versions:
        return None

    files = {}
    for item in decoded(model.get('files'), []):
        if not isinstance(item, dict):
            continue
        file_id = str(item.get('file_id') or item.get('id') or item.get('fileId') or '').strip()
        version_id = str(item.get('version_id') or item.get('modelVersionId') or item.get('model_version_id') or '').strip()
        if not file_id.isdigit() or not version_id.isdigit():
            continue
        digest = sha256(item)
        previous = files.get(file_id)
        if previous and (previous[0] != version_id or (previous[1] and digest and previous[1] != digest)):
            return None  # Conflicting identifiers inside one source snapshot.
        files[file_id] = (version_id, digest or (previous[1] if previous else ''))
    return key, versions, files, str(model.get('model_type') or '').strip().casefold()


def _native_mirror_match(first, second):
    """Confirm shared CivitAI/Red identity; reject contradictory file evidence."""
    left, right = _native_identity(first), _native_identity(second)
    if not left or not right:
        return False
    if {str(first.get('source') or '').lower(), str(second.get('source') or '').lower()} != FAMILY:
        return False
    key1, versions1, files1, kind1 = left
    key2, versions2, files2, kind2 = right
    if key1 != key2 or not (versions1 & versions2):
        return False
    if kind1 and kind2 and kind1 != kind2:
        return False
    for file_id in files1.keys() & files2.keys():
        version1, hash1 = files1[file_id]
        version2, hash2 = files2[file_id]
        if version1 != version2 or (hash1 and hash2 and hash1 != hash2):
            return False
    return True


def _one_source_snapshot(cursor, model_id, expected_source):
    """Never extend multi-source/ambiguous historical cards by native ID alone."""
    links = cursor.execute(
        'SELECT source,model_key,source_data FROM model_sources WHERE model_id=?',
        (model_id,)).fetchall()
    if len(links) != 1 or str(links[0]['source'] or '').lower() != expected_source:
        return None
    snapshot = dict(decoded(links[0]['source_data'], {}))
    if not snapshot:
        return None
    snapshot.update(source=expected_source, model_key=str(links[0]['model_key'] or ''))
    return snapshot


def native_card_pair_matches(cursor, first_id, second_id):
    """Separate, single-source CivitAI/Red cards with matching native IDs."""
    for a, b in (('civitai', 'civitaired'), ('civitaired', 'civitai')):
        first = _one_source_snapshot(cursor, first_id, a)
        second = _one_source_snapshot(cursor, second_id, b)
        if first and second:
            return _native_mirror_match(first, second)
    return False

def mirror_card_identity(cursor, model_id):
    links = cursor.execute('SELECT source,model_key,source_data FROM model_sources WHERE model_id=?', (model_id,)).fetchall()
    signatures, sources = set(), set()
    for link in links:
        source = str(link['source'] or '').lower()
        if source not in FAMILY or source in sources:
            return None
        sources.add(source)
        snapshot = dict(decoded(link['source_data'], {}))
        snapshot.update(source=source, model_key=str(link['model_key'] or ''))
        signature = mirror_identity(snapshot)
        if signature is None:
            return None
        signatures.add(signature)
    return next(iter(signatures)) if len(signatures) == 1 else None


def find_new_mirror(cursor, incoming):
    """Attach only a unique, proven mirror; SHA or shared native model/version IDs."""
    signature = mirror_identity(incoming)
    incoming_native = _native_identity(incoming)
    if signature is None and incoming_native is None:
        return None
    source, key = str(incoming['source']).lower(), str(incoming['model_key'])
    if cursor.execute('SELECT 1 FROM model_sources WHERE lower(source)=? AND model_key=?', (source, key)).fetchone():
        return None  # Existing separate cards are repaired only on explicit reload.
    opposite = 'civitaired' if source == 'civitai' else 'civitai'
    rows = cursor.execute('SELECT m.* FROM model_sources s JOIN models m ON m.id=s.model_id WHERE lower(s.source)=? AND s.model_key=?', (opposite, key)).fetchall()
    matches = []
    for row in rows:
        previous = _one_source_snapshot(cursor, row['id'], opposite)
        if previous is None:
            continue
        if (signature is not None and mirror_card_identity(cursor, row['id']) == signature) or _native_mirror_match(incoming, previous):
            matches.append(row)
    return matches[0] if len(matches) == 1 else None


def reconcile(database, model_id, blocked_ids=()):
    """Keep the opened card ID; require matching complete whole-card evidence.

    This is targeted by shared provider model ID, never by names/images. The
    caller serializes download-job creation and excludes scans while applying.
    No schema changes or filesystem operations occur here.
    """
    conn = database.connect()
    try:
        conn.execute('BEGIN IMMEDIATE')
        cursor = conn.cursor()
        winner = cursor.execute('SELECT * FROM models WHERE id=?', (model_id,)).fetchone()
        if not winner:
            return {'removed_ids': [], 'reason': 'missing_card'}
        links = cursor.execute('SELECT source,model_key FROM model_sources WHERE model_id=?', (model_id,)).fetchall()
        candidates = set()
        for link in links:
            source = str(link['source'] or '').lower()
            key = str(link['model_key'] or '')
            if source not in FAMILY or not key.isdigit():
                continue
            opposite = 'civitaired' if source == 'civitai' else 'civitai'
            candidates.update(row[0] for row in cursor.execute(
                'SELECT model_id FROM model_sources WHERE lower(source)=? AND model_key=? AND model_id<>?',
                (opposite, key, model_id)))
        if len(candidates) != 1:
            return {'removed_ids': [], 'reason': 'no_unique_pair'}
        loser_id = next(iter(candidates))
        if {int(model_id), int(loser_id)} & set(blocked_ids):
            return {'removed_ids': [], 'reason': 'download_jobs'}
        loser = cursor.execute('SELECT * FROM models WHERE id=?', (loser_id,)).fetchone()
        if not loser:
            return {'removed_ids': [], 'reason': 'missing_pair'}
        signature = database._card_merge_identity(cursor, winner)
        weights_match = signature is not None and database._card_merge_identity(cursor, loser) == signature
        if not weights_match:
            exact = mirror_card_identity(cursor, model_id)
            if not ((exact is not None and mirror_card_identity(cursor, loser_id) == exact)
                    or native_card_pair_matches(cursor, model_id, loser_id)):
                return {'removed_ids': [], 'reason': 'different_or_incomplete_evidence'}
        other_links = cursor.execute('SELECT source FROM model_sources WHERE model_id=?', (loser_id,)).fetchall()
        sources = [str(row['source'] or '').lower() for row in links]
        other_sources = [str(row['source'] or '').lower() for row in other_links]
        if set(sources) & set(other_sources):
            return {'removed_ids': [], 'reason': 'overlapping_sources'}

        # Preserve New when either card is still unseen, and favorite when
        # either is favorite. The existing row-fold helper moves all source
        # snapshots, media, tracking, queue/watch and collection references.
        viewed = min(int(winner['viewed'] or 0), int(loser['viewed'] or 0))
        timestamps = {field: max(str(row[field] or '') for row in (winner, loser))
                      for field in ('last_seen', 'last_changed')}
        if not database._merge_existing_model_rows(cursor, model_id, loser_id):
            raise RuntimeError('Card merge did not complete.')
        cursor.execute('UPDATE models SET viewed=?,last_seen=?,last_changed=? WHERE id=?',
                       (viewed, timestamps['last_seen'], timestamps['last_changed'], model_id))
        import architecture_seen
        architecture_seen.summarize(cursor, model_id)
        media = cursor.execute("SELECT COUNT(*) total, SUM(CASE WHEN type='video' THEN 1 ELSE 0 END) videos FROM model_media WHERE model_id=?", (model_id,)).fetchone()
        cursor.execute('UPDATE models SET has_media=?,has_video=?,preview_count=? WHERE id=?',
                       (int(media['total'] > 0), int((media['videos'] or 0) > 0), media['total'], model_id))
        conn.commit()
        return {'removed_ids': [int(loser_id)], 'reason': 'matched'}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
