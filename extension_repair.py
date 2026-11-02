"""Preview and repair extensionless files without trusting filename guesses."""
import os
import re
from datetime import datetime, timezone
from pathlib import Path
import download_reviews
from file_format_detection import detect_extension, needs_extension
from installed_recovery import safe_file


def preview(conn, roots):
    tracked, by_name = {}, {}
    for row in conn.execute('''SELECT i.*, r.model_name, s.url AS source_url
        FROM installed_files i LEFT JOIN download_reviews r ON r.id=i.review_id
        LEFT JOIN model_sources s ON lower(s.source)=lower(i.source) AND s.model_key=i.model_key'''):
        record = dict(row)
        tracked[os.path.normcase(os.path.abspath(row['local_path']))] = record
        if str(row['source']).lower() == 'seaart':
            by_name.setdefault(str(row['filename'] or '').casefold(), []).append(record)
    files, errors, seen = [], [], set()
    for root in roots:
        path = Path(root).expanduser().absolute()
        if not path.is_dir():
            errors.append(f'{path}: folder unavailable'); continue
        if any(p.is_symlink() or getattr(p,'is_junction',lambda:False)() for p in (path,*path.parents)):
            errors.append(f'{path}: linked folder skipped'); continue
        def onerror(exc): errors.append(str(exc))
        for folder, dirs, names in os.walk(path, followlinks=False, onerror=onerror):
            dirs[:] = [d for d in dirs if not (Path(folder)/d).is_symlink() and not getattr(Path(folder)/d,'is_junction',lambda:False)()]
            for name in names:
                if not needs_extension(name): continue
                try:
                    item, identity = safe_file(Path(folder)/name)
                    key = os.path.normcase(str(item))
                    if key in seen: continue
                    seen.add(key)
                    info = tracked.get(os.path.normcase(str(item)), {})
                    suggestions = by_name.get(name.casefold(), []) if not info else []
                    hint = suggestions[0] if len(suggestions) == 1 else {}
                    ext = detect_extension(item)
                    files.append({'path':str(item),'identity':identity,'extension':ext or '',
                        'model_name':info.get('model_name') or hint.get('model_name') or name,'model_id':info.get('model_id') or hint.get('model_id'),
                        'source_url':info.get('source_url') or hint.get('source_url') or '', 'review_id':info.get('review_id'),
                        'suggested':bool(hint),
                        'installed_id':info.get('id'), 'source':info.get('source') or ''})
                except (OSError, ValueError) as exc: errors.append(f'{name}: {exc}')
    return files, errors


def apply_one(conn, item, extension):
    extension = str(extension or '').lower().strip()
    if not re.fullmatch(r'\.[a-z0-9]{1,16}', extension):
        raise ValueError('Choose an extension such as .safetensors or .json.')
    path, identity = safe_file(item['path'])
    if identity != item['identity']: raise ValueError('File changed since the scan; scan again.')
    detected = detect_extension(path)
    if item['extension'] and detected != item['extension']:
        raise ValueError('File format changed since the scan; scan again.')
    if detected and extension != detected: raise ValueError('The selected extension conflicts with the detected format.')
    target = path.with_name(path.name + extension)
    if target.exists(): raise ValueError('The destination already exists; no files were changed.')
    row = conn.execute('SELECT * FROM installed_files WHERE local_path=?',(str(path),)).fetchone()
    if (row['id'] if row else None) != item['installed_id']:
        raise ValueError('Download tracking changed since the scan; scan again.')
    # Same-directory hard links provide an atomic no-overwrite operation. Do not
    # silently fall back to rename on systems where it could overwrite a file.
    os.link(path, target)
    try:
        if safe_file(target)[1] != identity or safe_file(path)[1] != identity:
            raise ValueError('File changed while preparing the rename; scan again.')
        with conn:
            if row:
                if row['review_id']:
                    review = conn.execute('SELECT * FROM download_reviews WHERE id=?',(row['review_id'],)).fetchone()
                    if not review or review['local_path'] != str(path): raise ValueError('Review tracking changed; scan again.')
                    updated=dict(review);updated['local_path']=str(target)
                    conn.execute('UPDATE download_reviews SET local_path=?,filename=?,identity_key=?,location_updated_at=? WHERE id=?',
                        (str(target),target.name,download_reviews.key(updated),datetime.now(timezone.utc).isoformat(),row['review_id']))
                conn.execute('UPDATE installed_files SET local_path=?,filename=? WHERE id=?',(str(target),target.name,row['id']))
                conn.execute('''UPDATE download_history SET filename=? WHERE lower(source)=lower(?) AND model_key=?
                    AND file_fingerprint=? AND COALESCE(version_id,'')=? AND filename=?''',
                    (target.name,row['source'],row['model_key'],row['file_fingerprint'],row['version_id'] or '',row['filename']))
            if safe_file(path)[1] != identity: raise ValueError('File changed before the rename; scan again.')
            path.unlink()
    except Exception:
        # Commit can fail even after unlink succeeds. Recreate the original
        # name before removing the new link; if restoration fails keep the
        # new link so the data remains available for manual recovery.
        if not path.exists():
            try: os.link(target, path)
            except OSError: pass
        if path.exists(): target.unlink(missing_ok=True)
        raise
    return str(target)
