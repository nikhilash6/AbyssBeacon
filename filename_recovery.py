"""Recover only filenames, using exact source model/version/file identities."""
import copy
import json
import re


def file_key(record):
    version = str(record.get('version_id') or record.get('modelVersionId') or '')
    file_id = str(record.get('id') or record.get('file_id') or '')
    return (version, file_id) if version.isdigit() and file_id.isdigit() else None


def import_page_names(snapshot, versions, model_key):
    names = {}
    for version in versions:
        if str(version.get('modelId') or version.get('model_id') or '') != str(model_key):
            continue
        for record in version.get('files') or []:
            if not isinstance(record, dict):
                continue
            key = file_key(dict(record, version_id=version.get('id')))
            name = str(record.get('name') or '')
            if not key or not name or len(name) > 512 or re.search(r'[/\\\x00-\x1f]', name):
                continue
            if key in names and names[key] != name:
                raise ValueError('The page contains conflicting filenames for one file ID.')
            names[key] = name
    result = copy.deepcopy(snapshot)
    records = result.get('files') or []
    if isinstance(records, str):
        records = json.loads(records)
    if not isinstance(records, list):
        raise ValueError('Saved file metadata is invalid. Reload this model first.')
    changed = 0
    matched = 0
    for record in records:
        if not isinstance(record, dict):
            continue
        name = names.get(file_key(record))
        if not name:
            continue
        matched += 1
        changed += int(record.get('name') != name or record.get('original_filename') != name)
        record.setdefault('filename_before_recovery', record.get('name') or '')
        # Keep the old path as download-history identity; no installed files move.
        record['filename_identity_path'] = record.get('path') or record.get('name') or ''
        record['name'] = name
        record['original_filename'] = name
        record['filename_authority'] = 'browser_page'
    if not matched:
        raise ValueError('No matching model, version and file IDs were found in this page.')
    result['files'] = records
    return result, changed, matched


def retain_verified_names(files, saved_files):
    """Keep browser-confirmed names if a later API fallback is still generic."""
    verified = {file_key(f): f for f in saved_files if isinstance(f, dict)
                and file_key(f) and f.get('filename_authority') == 'browser_page'}
    for record in files:
        if not isinstance(record, dict):
            continue
        prior = verified.get(file_key(record))
        if not prior:
            continue
        file_id = file_key(record)[1]
        incoming = str(record.get('name') or '')
        # A fresh descriptive provider filename supersedes the imported name.
        if incoming != prior.get('name') and not re.search(r'[_-]' + re.escape(file_id) + r'\.[^.]+$', incoming):
            continue
        old_sha = str(prior.get('sha256') or '').casefold()
        new_sha = str(record.get('sha256') or '').casefold()
        if old_sha and new_sha and old_sha != new_sha:
            continue
        for key in ('name', 'original_filename', 'filename_authority', 'filename_before_recovery', 'filename_identity_path'):
            if key in prior:
                record[key] = prior[key]
        if prior.get('filename_identity_path'):
            record['path'] = prior['filename_identity_path']
    return files


def saved_red_names(model_key):
    """Read only previously verified names for this exact Red model."""
    import database
    conn = None
    try:
        conn = database.connect()
        row = conn.execute("SELECT source_data FROM model_sources WHERE lower(source)='civitaired' AND model_key=?", (str(model_key),)).fetchone()
        snapshot = json.loads(row[0] or '{}') if row else {}
        files = snapshot.get('files') or []
        return json.loads(files) if isinstance(files, str) else files
    except (ValueError, TypeError, AttributeError):
        return []
    except Exception:
        # A fresh installation may not have a model_sources table yet.
        return []
    finally:
        if conn is not None:
            conn.close()
