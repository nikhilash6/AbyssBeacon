"""Explicit, preview-confirmed deletion of a tracked installed artifact."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import time
from datetime import datetime,timezone

_SECRET=secrets.token_bytes(32)


def _stat(path):
    if path.is_symlink() or getattr(path,'is_junction',lambda:False)():
        raise ValueError('Linked files/folders must be managed manually.')
    stat=path.stat()
    return [stat.st_dev,stat.st_ino,stat.st_size,stat.st_mtime_ns]


def plan(conn,review_id,root,stamp=None):
    row=conn.execute('SELECT * FROM installed_files WHERE review_id=?',(review_id,)).fetchone()
    if not row:raise ValueError('This file/version is no longer tracked as installed.')
    path=Path(row['local_path']).expanduser().absolute()
    review=conn.execute('SELECT location_updated_at,verified_sha256 FROM download_reviews WHERE id=?',(review_id,)).fetchone()
    relocated=bool(review and review[0])
    if relocated:
        candidates = [path.parent]
    elif isinstance(root, list):
        candidates = root
    else:
        candidates = [Path(root).expanduser()] if root else []
    root = next((base for base in candidates if base.is_dir() and path.is_relative_to(base.absolute())), None)
    if root is None:
        raise ValueError('The recorded file is outside your configured download folders.')
    root = root.absolute()
    # Resolve aliases without following a link into a different destination.
    if os.path.normcase(str(path.resolve()))!=os.path.normcase(str(path)):
        raise ValueError('The path uses a symbolic link or junction; manage it manually.')
    for parent in path.parents:
        _stat(parent)
        if parent==root:break
    if not path.is_file():raise ValueError('The recorded file was not found. Tracking has been kept.')
    folder=path.parent
    entries=sorted(folder.iterdir(),key=lambda p:p.name)
    inventory=[]
    for entry in entries:
        stat=_stat(entry);inventory.append([entry.name,entry.is_file(),stat])
    # Never infer companion ownership from arbitrary extensions or file size.
    def companion(p):
        return p.is_file() and (p.name in {'AbyssBeacon Info.txt','ModelRadar Info.txt'} or re.fullmatch(r'preview\.(?:png|jpe?g|webp|avif|gif|mp4|webm)',p.name,re.I))
    managed=any(p.name in {'AbyssBeacon','ModelRadar'} for p in folder.parents) and folder.name not in {'AbyssBeacon','ModelRadar'}
    others=[entry for entry in entries if entry!=path]
    other_tracked=conn.execute('SELECT local_path FROM installed_files WHERE id<>?',(row['id'],)).fetchall()
    shared=any(Path(r[0]).parent==folder for r in other_tracked)
    clean_folder=managed and not relocated and not shared and all(companion(p) for p in others)
    paths=[path]+(others if clean_folder else [])
    files=[{'path':str(p),'filename':p.name,'size_bytes':p.stat().st_size,'identity':_stat(p)} for p in paths]
    stamp=int(time.time()) if stamp is None else int(stamp)
    payload={'review_id':review_id,'installed_id':row['id'],'files':files,'folder':str(folder) if clean_folder else None,'inventory':inventory,'stamp':stamp}
    token=str(stamp)+':'+hmac.new(_SECRET,json.dumps(payload,sort_keys=True).encode(),hashlib.sha256).hexdigest()
    return {'files':files,'folder':payload['folder'],'token':token,'installed_id':row['id'],'model_id':row['model_id']}


def delete(conn,review_id,root,token):
    try:stamp=int(token.split(':',1)[0])
    except (ValueError,AttributeError):raise ValueError('Preview the exact files before confirming deletion.')
    if not 0<=time.time()-stamp<=600:raise ValueError('Deletion preview expired. Preview again.')
    current=plan(conn,review_id,root,stamp)
    if not hmac.compare_digest(current['token'],str(token)):
        raise ValueError('The folder or file changed. Preview again before deleting.')
    deleted=[];errors=[]
    main=current['files'][0]
    # Main artifact first. A locked/failed main file leaves all tracking and companions intact.
    path=Path(main['path'])
    if _stat(path)!=main['identity']:raise ValueError('The model file changed. Preview again.')
    path.unlink()
    if path.exists():raise OSError('The model file still exists after deletion.')
    deleted.append(str(path))
    # Clear installed tracking only after the physical removal. History/reviews remain.
    with conn:
        conn.execute('DELETE FROM installed_files WHERE id=? AND review_id=?',(current['installed_id'],review_id))
        conn.execute('UPDATE download_reviews SET deleted_at=? WHERE id=?',(datetime.now(timezone.utc).isoformat(),review_id))
    expected={Path(item['path']).name for item in current['files'][1:]}
    if current['folder'] and {p.name for p in path.parent.iterdir()}!=expected:
        return {'success':False,'deleted':deleted,'failed':[{'path':str(path.parent),'error':'Folder contents changed; companions were kept.'}],'model_file_deleted':True}
    for item in current['files'][1:]:
        try:
            sidecar=Path(item['path'])
            if _stat(sidecar)!=item['identity']:raise OSError('Companion changed after confirmation')
            sidecar.unlink();deleted.append(str(sidecar))
        except (ValueError,OSError) as exc:errors.append({'path':item['path'],'error':str(exc)})
    if current['folder']:
        try:Path(current['folder']).rmdir();deleted.append(current['folder'])
        except OSError as exc:errors.append({'path':current['folder'],'error':str(exc)})
    if not errors:
        from download_reviews import clean_deleted_group
        with conn:
            row = conn.execute('SELECT deletion_group FROM download_reviews WHERE id=?',(review_id,)).fetchone()
            if row:
                clean_deleted_group(conn,row[0])
    return {'success':not errors,'deleted':deleted,'failed':errors,'model_file_deleted':True}
