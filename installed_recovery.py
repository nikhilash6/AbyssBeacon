"""Local inventory, cancellable SHA verification and opt-in download-record cleanup.
No discovery requests, file moves, renames or deletion. Jobs expire at restart.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timezone
import model_identity
import download_reviews

_LOCK = threading.RLock()
_JOBS = {}
_ACTIVE = None
_EXTENSIONS = model_identity.WEIGHT_EXTENSIONS | {'.json', '.zip', '.sft'}


def safe_file(path):
    path = Path(path).expanduser().absolute()
    for part in (path, *path.parents):
        if part.is_symlink() or getattr(part, 'is_junction', lambda: False)():
            raise ValueError('Linked files and junctions must be managed manually.')
    if not path.is_file():
        raise ValueError('The selected file is unavailable or was not found.')
    stat = path.stat()
    return path, [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]


def digest_file(path, cancel, progress):
    path, before = safe_file(path)
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while True:
            if cancel.is_set():
                raise InterruptedError('Scan cancelled; no locations were changed.')
            chunk = handle.read(4 * 1024 * 1024)
            if not chunk:break
            digest.update(chunk);progress(len(chunk))
    _, after = safe_file(path)
    if before != after:raise ValueError('The file changed while being checked. Try again.')
    return digest.hexdigest(), before


def _saved_fingerprint(snapshot, file):
    # Same historical identity recipe as the downloader. This only selects the
    # source artifact; the fingerprint itself is never treated as a content SHA.
    strong={
        'source_file_id':str(file.get('model_file_id') or file.get('id') or file.get('file_id') or ''),
        'file_sha':str(file.get('sha') or file.get('hash') or file.get('hashes') or ''),
        'model_sha':str(snapshot.get('sha') or ''),
        'size':str(file.get('size_bytes') or file.get('size') or ''),
        'path':str(file.get('path') or file.get('name') or ''),
    }
    if not (strong['source_file_id'] or strong['file_sha'] or strong['model_sha']):
        strong['source_updated']=str(snapshot.get('updated') or snapshot.get('created') or '')
    return hashlib.sha256(json.dumps(strong,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8',errors='ignore')).hexdigest()


def expected_identity(conn, review):
    """Trust artifact hashes only, never a whole-card hash or fingerprint-as-hash."""
    if re.fullmatch('[a-f0-9]{64}', str(review.get('verified_sha256') or '')):
        return review['verified_sha256'], review.get('verified_size')
    row = conn.execute('SELECT source_data FROM model_sources WHERE lower(source)=lower(?) AND model_key=?',
                       (review['source'], review['model_key'])).fetchone()
    snapshot = model_identity.decoded(row[0], {}) if row else {}
    files = model_identity.decoded(snapshot.get('files'), [])
    card = model_identity.decoded(snapshot.get('card_data'), {})
    versions = card.get('versions') or []
    for version in versions if isinstance(versions,list) else []:
        if isinstance(version,dict) and str(version.get('id') or version.get('version_id') or '') == str(review.get('version_id') or ''):
            files += [dict(f) for f in (version.get('files') or []) if isinstance(f,dict)]
    hashes = set();sizes = set()
    file_id = str(review.get('source_file_id') or '')
    # Civit's file IDs are exact artifact identities across the pair of sites.
    # Other sources may use paths, so require matching filename as well.
    for file in files:
        if not isinstance(file,dict):continue
        ident = str(file.get('model_file_id') or file.get('id') or file.get('file_id') or '')
        name = Path(str(file.get('path') or file.get('name') or file.get('filename') or '')).name
        fingerprint_match=bool(review.get('file_fingerprint')) and _saved_fingerprint(snapshot,file)==review['file_fingerprint']
        if not fingerprint_match:
            if not file_id or ident != file_id:continue
            if review['source'] not in {'civitai','civitaired'} and name.casefold()!=str(review.get('filename') or '').casefold():continue
        digest = model_identity.sha256(file)
        if not digest:continue
        hashes.add(digest)
        try:
            size=int(file.get('size_bytes') or 0)
            if size>0:sizes.add(size)
        except (TypeError,ValueError):pass
    return (next(iter(hashes)), next(iter(sizes)) if len(sizes)==1 else None) if len(hashes)==1 else ('',None)


def records(conn, review_id=None):
    sql='''SELECT r.*, i.id AS installed_id, i.model_id AS installed_model_id,
             i.local_path AS installed_path FROM download_reviews r
             LEFT JOIN installed_files i ON i.review_id=r.id'''
    if review_id is not None:
        return [dict(r) for r in conn.execute(sql+' WHERE r.id=?',(review_id,))]
    return [dict(r) for r in conn.execute(sql+" WHERE i.id IS NOT NULL")]


def _publish(job, **values):
    with _LOCK:job.update(values)


def _inventory(job, roots, names, sizes=()):
    paths={};errors=[];count=0
    for raw in roots:
        root=Path(raw).expanduser().absolute()
        if not root.is_dir():errors.append({'path':str(root),'error':'Folder unavailable; it may be disconnected or inaccessible.'});continue
        if any(p.is_symlink() or getattr(p,'is_junction',lambda:False)() for p in (root,*root.parents)):
            errors.append({'path':str(root),'error':'Linked folders/junctions are skipped.'});continue
        def failed(exc):errors.append({'path':str(exc.filename or root),'error':str(exc)})
        for folder,dirs,files in os.walk(root,followlinks=False,onerror=failed):
            if job['cancel'].is_set():raise InterruptedError()
            for directory in dirs:
                child=Path(folder)/directory
                if child.is_symlink() or getattr(child,'is_junction',lambda:False)():errors.append({'path':str(child),'error':'Linked folder skipped; missing download records were kept.'})
            dirs[:]=[d for d in dirs if d not in {'.git','__pycache__','.venv','venv','node_modules'} and not (Path(folder)/d).is_symlink() and not getattr(Path(folder)/d,'is_junction',lambda:False)()]
            for name in files:
                if job['cancel'].is_set():raise InterruptedError()
                path=Path(folder)/name
                count+=1
                if name.casefold() not in names and path.suffix.lower() not in _EXTENSIONS:continue
                try:
                    path,stat=safe_file(path)
                    if name.casefold() not in names and stat[2] not in sizes:continue
                    paths[os.path.normcase(str(path))]={'path':str(path),'filename':path.name,'size_bytes':stat[2],'identity':stat}
                except (ValueError,OSError) as exc:errors.append({'path':str(path),'error':str(exc)})
            _publish(job,phase='Searching for missing files',files_checked=count,current_path=str(folder))
    return list(paths.values()),errors


def _run(job, connect, roots, selected):
    conn=connect()
    try:
        reviews=records(conn,job['review_id']);probes={};targets=[];warnings=[]
        import install_choices
        for review in reviews:review['resolved_category']=install_choices.category(conn,review)
        if job.get('_record_ids') is not None:reviews=[r for r in reviews if r['id'] in job['_record_ids']]
        if job.get('model_types') is not None:reviews=[r for r in reviews if r['resolved_category'] in job['model_types']]
        _publish(job,phase='Checking recorded locations',total_records=len(reviews))
        for index,review in enumerate(reviews):
            if job['cancel'].is_set():raise InterruptedError()
            original=review.get('installed_path') or review['local_path']
            try:
                original_path=Path(original)
                original_path.stat()
                exists=original_path.is_file()
                unavailable=not exists and not Path(original_path.anchor).exists()
            except FileNotFoundError:
                exists=False;unavailable=not Path(Path(original).anchor).exists()
            except OSError:
                exists=False;unavailable=True
            probes[review['id']]=(exists,unavailable)
            if selected or (not unavailable and (not exists or job['find_copies'])):
                targets.append(review)
            if unavailable:warnings.append({'path':original,'error':'Recorded location unavailable; installed tracking is unchanged.'})
            _publish(job,records_checked=index+1,current_path=original)
        identities={r['id']:expected_identity(conn,r) for r in targets}
        if selected:
            path,stat=safe_file(selected)
            inventory=[{'path':str(path),'filename':path.name,'size_bytes':stat[2],'identity':stat}];errors=[]
        elif targets:
            names={str(r['filename']).casefold() for r in targets}
            sizes={size for digest,size in identities.values() if digest and size}
            inventory,errors=_inventory(job,roots,names,sizes)
        else:inventory=[];errors=[]
        _publish(job,warnings=warnings+errors,phase='Checking candidate files',search_targets=len(targets))
        cache={};used=set();results=[]
        def hash_path(path):
            if path not in cache:
                _publish(job,phase='Verifying file identity',current_path=path)
                def progress(size):
                    with _LOCK:job['bytes_hashed']+=size
                cache[path]=digest_file(path,job['cancel'],progress)
            return cache[path]
        for index,review in enumerate(reviews):
            if job['cancel'].is_set():raise InterruptedError()
            expected,size=identities.get(review['id'],('',None))
            original=review.get('installed_path') or review['local_path']
            entry={'review_id':review['id'],'model_name':review['model_name'],'filename':review['filename'],
                   'model_id':review.get('installed_model_id'),'install_category':review['resolved_category'],'old_path':original,'tracked':bool(review['installed_id']),'candidates':[],'status':'missing'}
            original_present,unavailable=probes[review['id']]
            entry['recorded_exists']=original_present
            # Existing files are not hashed on every inventory. Manual Locate can
            # compare against the original when the provider supplied no hash.
            if not expected and selected and original_present:
                expected,stat=hash_path(str(Path(original).absolute()));size=stat[2]
            if original_present and not selected:
                entry['status']='recorded_location';used.add(os.path.normcase(str(Path(original).absolute())))
            if unavailable and not selected:entry['status']='unavailable'
            if review['id'] in identities:
                for candidate in inventory:
                    if not selected and review['installed_id'] and os.path.normcase(candidate['path'])==os.path.normcase(str(Path(original).absolute())):continue
                    same_name=candidate['filename'].casefold()==str(review['filename']).casefold()
                    # Exact hash + byte size searches across renamed files too.
                    if not selected and not same_name and not (expected and size and candidate['size_bytes']==size):continue
                    if not selected and not same_name and size and candidate['size_bytes']!=size:continue
                    item=dict(candidate);item['verified']=False;item['name_matches']=same_name
                    if expected:
                        try:
                            digest,stat=hash_path(candidate['path']);item['identity']=stat
                            item['verified']=digest==expected;item['sha256']=digest
                            if not item['verified']:
                                if selected:entry['message']='The SHA-256 does not match this saved file/version.'
                                if same_name and not selected:
                                    item.update(hash_mismatch=True,error='Filename matches, but SHA-256 differs. Download records were kept for review.');entry['candidates'].append(item)
                                continue
                        except (OSError,ValueError) as exc:
                            item['error']=str(exc)
                    else:item['error']='No reliable saved file hash. Filename alone cannot verify this file.'
                    entry['candidates'].append(item);used.add(os.path.normcase(candidate['path']))
                verified=sum(c['verified'] for c in entry['candidates'])
                if verified:entry['status']='multiple_matches' if verified>1 else 'found'
                elif entry['candidates']:entry['status']='unverified'
                elif not original_present and (not Path(Path(original).anchor).exists() or errors):entry['status']='unavailable'
            if entry['status']=='missing' and not selected:
                entry['message']='Not found at the recorded location or in the folders searched. Search more folders, or remove tracking only if you know this file was deleted.'
            results.append(entry)
            _publish(job,records_checked=index+1)
        unknown=[]  # Recovery retains candidates only; full local inventory is a later feature.
        _publish(job,status='finalizing',phase='Saving scan results',results=results,unknown=unknown,current_path='')
        if not selected and (job['auto_exact'] or job['forget_missing']):
            _finalize(job,conn)
        _publish(job,status='complete',phase='Ready to review',current_path='')
    except InterruptedError:
        _publish(job,status='cancelled',phase='Cancelled — completed updates are kept' if job['auto_saved'] or job['forgotten'] else 'Cancelled — no locations changed',results=[],unknown=[])
    except Exception as exc:
        _publish(job,status='failed',phase='Scan failed',error=str(exc))
    finally:
        conn.close()
        global _ACTIVE
        with _LOCK:
            if _ACTIVE==job['id']:_ACTIVE=None


def start(connect, roots, review_id=None, selected=None, find_copies=False, auto_exact=False, forget_missing=False, busy_check=None, model_types=None, record_ids=None):
    global _ACTIVE
    with _LOCK:
        if _ACTIVE and _JOBS[_ACTIVE]['status'] in {'running','finalizing'}:raise ValueError('A local file scan is already running. Finish or cancel it first.')
        ident=secrets.token_urlsafe(18)
        job={'id':ident,'status':'running','phase':'Starting','review_id':review_id,'cancel':threading.Event(),
             '_roots':list(roots),'_record_ids':record_ids,'model_types':model_types,'_busy_check':busy_check,'auto_exact':bool(auto_exact),'forget_missing':False,'auto_saved':0,'forgotten':0,'find_copies':bool(find_copies),'search_targets':0,'files_checked':0,'records_checked':0,'total_records':0,'bytes_hashed':0,'warnings':[],'results':[],'unknown':[]}
        # Bound process memory. Retain the latest jobs only; no file inventory DB.
        while len(_JOBS)>=4:_JOBS.pop(next(iter(_JOBS)))
        _JOBS[ident]=job;_ACTIVE=ident
        threading.Thread(target=_run,args=(job,connect,roots,selected),daemon=True).start()
        return ident


def _automatic_matches(job):
    # A candidate claimed by multiple review records needs a human decision.
    owners={}
    for row in job['results']:
        if row['tracked'] and row.get('recorded_exists'):owners.setdefault(os.path.normcase(row['old_path']),set()).add(row['review_id'])
        for candidate in row['candidates']:
            if candidate['verified']:
                path=os.path.normcase(candidate['path'])
                owners.setdefault(path,set()).add(row['review_id'])
    matches=[]
    for row in job['results']:
        verified=[c for c in row['candidates'] if c['verified']]
        if row.get('apply_error') or row.get('recorded_exists') or len(verified)!=1:continue
        candidate=verified[0]
        if candidate['filename'].casefold()!=str(row['filename']).casefold():continue
        if len(owners[os.path.normcase(candidate['path'])])!=1:continue
        matches.append({'review_id':row['review_id'],'path':candidate['path'],'old_path':row['old_path'],'model_name':row['model_name']})
    return matches


def automatic_matches(ident):
    with _LOCK:
        job=_JOBS.get(ident)
        if not job or job['status']!='complete':raise ValueError('Complete a scan before updating verified locations.')
        return _automatic_matches(job)


def apply_error(ident, review_id, message):
    with _LOCK:
        job=_JOBS.get(ident)
        if not job:return
        row=next((r for r in job['results'] if r['review_id']==review_id),None)
        if row:row.update(apply_error=message,message='Location was not updated: '+message)


def status(ident, offset=0, limit=50, include_current=False, include_missing=False):
    with _LOCK:
        job=_JOBS.get(ident)
        if not job:raise ValueError('Scan expired. Run Find installed files again.')
        result={k:v for k,v in job.items() if k not in {'cancel','results','unknown'} and not k.startswith('_')}
        automatic=_automatic_matches(job)
        automatic_ids={r['review_id'] for r in automatic}
        rows=job['results'] if include_current else [r for r in job['results'] if (r['status'] not in {'recorded_location','relinked','missing','forgotten'} and r['review_id'] not in automatic_ids) or r.get('manual_review_slot') or (include_missing and r['status'] in {'missing','forgotten'})]
        result['automatic_total']=len(automatic)
        counts={}
        for row in job['results']:counts[row['status']]=counts.get(row['status'],0)+1
        result.update(results=rows[offset:offset+limit],total=len(rows),counts=counts,
                      unknown=job['unknown'][offset:offset+limit],unknown_total=len(job['unknown']))
        return result


def cancel(ident):
    with _LOCK:
        if ident not in _JOBS:raise ValueError('Scan not found.')
        _JOBS[ident]['cancel'].set()


def _same_artifact(left, right):
    def family(source):
        return 'civitai' if str(source).lower() in {'civitai','civitaired'} else str(source).lower()
    if family(left['source'])!=family(right['source']) or left['model_key']!=right['model_key']:return False
    # A file ID is artifact evidence, but never erase a distinct known version.
    lv=str(left.get('version_id') or '');rv=str(right.get('version_id') or '')
    if lv and rv and lv!=rv:return False
    lf=str(left.get('source_file_id') or '');rf=str(right.get('source_file_id') or '')
    if family(left['source'])=='civitai' and lf and rf and lf==rf:return True
    fingerprint=str(left.get('file_fingerprint') or '')
    return bool(fingerprint and fingerprint==str(right.get('file_fingerprint') or ''))


def _resolve_existing(conn, job, result, review, owner, chosen, candidate):
    # Keep the owner and BOTH review records/decisions. Only retire the missing,
    # redundant installed pointer; no file or history record is deleted.
    if not _same_artifact(review,owner):
        raise ValueError('Cannot save this location: it is already assigned to '+str(owner.get('model_name') or owner.get('filename') or 'another download')+' / '+str(owner.get('version_name') or owner.get('version_id') or 'version not recorded')+'. Choose another file or leave this entry unchanged.')
    old=Path(review.get('installed_path') or review['local_path'])
    if os.path.normcase(str(old.absolute()))!=os.path.normcase(str(chosen)) and old.exists():
        raise ValueError('Both copies still exist and the selected copy is already tracked. Keep the current copy or mark its tracking as not installed separately.')
    if review.get('installed_id'):
        with conn:
            conn.execute('DELETE FROM installed_files WHERE id=? AND review_id=?',(review['installed_id'],review['id']))
            conn.execute('UPDATE download_reviews SET uninstalled_at=? WHERE id=?',(datetime.now(timezone.utc).isoformat(),review['id']))
    result.update(manual_review_slot=True,status='already_installed',tracked=False,candidates=[],apply_error='',message='Already installed at '+str(chosen)+'. Duplicate missing-location tracking resolved; both review histories and the existing installed record were kept.')
    return {'path':str(chosen),'filename':chosen.name,'verification':'sha256' if candidate['verified'] else 'user_confirmed','already_installed':True,'message':result['message']}


def relink(conn, job_id, review_id, path, manual_confirm=False):
    with _LOCK:
        job=_JOBS.get(job_id)
        if not job or job['status'] not in {'complete','finalizing'}:raise ValueError('Complete a file check before relinking.')
        result=next((r for r in job['results'] if r['review_id']==review_id),None)
        candidate=next((c for c in result['candidates'] if c['path']==path),None) if result else None
        if not candidate:raise ValueError('Choose a candidate from this scan.')
        if candidate.get('hash_mismatch'):raise ValueError('The SHA-256 differs from this saved file/version. Choose another file or remove its download record.')
        if not candidate['verified'] and manual_confirm is not True:raise ValueError('Explicitly confirm the unverified file before updating tracking.')
        chosen,stat=safe_file(path)
        if stat!=candidate['identity']:raise ValueError('The file changed after verification. Check it again.')
        rows=records(conn,review_id)
        if not rows:raise ValueError('The saved download no longer exists.')
        review=rows[0]
        if (review.get('installed_path') or review['local_path'])!=result['old_path']:
            raise ValueError('The recorded location changed. Scan again.')
        for installed in conn.execute('SELECT * FROM installed_files').fetchall():
            if installed['review_id']==review_id or os.path.normcase(str(Path(installed['local_path']).absolute()))!=os.path.normcase(str(chosen)):continue
            owner=conn.execute('SELECT * FROM download_reviews WHERE id=?',(installed['review_id'],)).fetchone()
            if not owner:raise ValueError('This path is already tracked for a different file/version.')
            return _resolve_existing(conn,job,result,review,dict(owner),chosen,candidate)
        review['local_path']=str(chosen);review['filename']=chosen.name
        identity=download_reviews.key(review)
        conflict=conn.execute('SELECT id FROM download_reviews WHERE identity_key=? AND id<>?',(identity,review_id)).fetchone()
        if conflict:raise ValueError('Another saved review already owns this location. No review history was overwritten; choose another file or leave this entry unchanged.')
        now=datetime.now(timezone.utc).isoformat()
        with conn:
            if review['installed_id']:
                conn.execute('UPDATE installed_files SET local_path=?,filename=? WHERE review_id=?',(str(chosen),chosen.name,review_id))
            else:
                model=conn.execute('SELECT model_id FROM model_sources WHERE source=? AND model_key=?',(review['source'],review['model_key'])).fetchone()
                conn.execute('''INSERT INTO installed_files(model_id,source,model_key,source_file_id,file_fingerprint,local_path,filename,version_id,version_name,installed_at,review_id)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)''',(model[0] if model else None,review['source'],review['model_key'],review['source_file_id'],review['file_fingerprint'],str(chosen),chosen.name,review['version_id'],review['version_name'],review['completed_at'],review_id))
            conn.execute('''UPDATE download_reviews SET identity_key=?,local_path=?,filename=?,location_updated_at=?,uninstalled_at='',deleted_at='',verified_sha256=?,verified_size=? WHERE id=?''',
                         (identity,str(chosen),chosen.name,now,candidate.get('sha256','') if candidate['verified'] else '',stat[2],review_id))
        was_manual=result.get('manual_review_slot') or review_id not in {row['review_id'] for row in _automatic_matches(job)}
        result.update(manual_review_slot=was_manual,status='relinked',old_path=str(chosen),tracked=True,recorded_exists=True,candidates=[])
        return {'path':str(chosen),'filename':chosen.name,'verification':'sha256' if candidate['verified'] else 'user_confirmed'}


def _artifact_clause(row):
    base='lower(source)=lower(?) AND model_key=?'
    params=[row['source'],row['model_key']]
    if row.get('version_id'):
        base+=" AND (version_id=? OR COALESCE(version_id,'')='')";params.append(row['version_id'])
    identities=[];values=[]
    if row.get('file_fingerprint'):
        identities.append('file_fingerprint=?');values.append(row['file_fingerprint'])
    if row.get('source_file_id') and row.get('version_id'):
        identities.append("(source_file_id=? AND COALESCE(version_id,'')=?)");values.extend([row['source_file_id'],row['version_id']])
    if identities:return base+' AND ('+' OR '.join(identities)+')',params+values
    if row.get('source_file_id'):
        return base+" AND source_file_id=? AND COALESCE(version_id,'')=?",params+[row['source_file_id'],row.get('version_id') or '']
    return base+" AND filename=? AND COALESCE(version_id,'')=?",params+[row['filename'],row.get('version_id') or '']



def forget_download(conn, review_id, expected_path):
    rows=records(conn,review_id)
    if not rows:raise ValueError('Saved download not found.')
    row=rows[0]
    if (row.get('installed_path') or row['local_path'])!=expected_path:raise ValueError('The recorded location changed. Refresh before continuing.')
    clause,params=_artifact_clause(row)
    with conn:
        conn.execute('DELETE FROM installed_files WHERE review_id=?',(review_id,))
        conn.execute('DELETE FROM download_reviews WHERE id=?',(review_id,))
        # Other physical copies/review records still own shared artifact history.
        other=conn.execute('SELECT 1 FROM download_reviews WHERE '+clause+' LIMIT 1',params).fetchone()
        installed=conn.execute('SELECT 1 FROM installed_files WHERE '+clause+' LIMIT 1',params).fetchone()
        if not other and not installed:conn.execute('DELETE FROM download_history WHERE '+clause,params)
    with _LOCK:
        for job in _JOBS.values():
            for entry in job['results']:
                if entry['review_id']==review_id:entry.update(status='forgotten',tracked=False,candidates=[],manual_review_slot=False,apply_error='',message='Download record removed. Model card and physical files kept.')


def mark_uninstalled(conn, review_id, expected_path):
    forget_download(conn,review_id,expected_path)


def _finalize(job, conn):
    import active_downloads
    def perform(ident,path,action):
        if job['cancel'].is_set():raise InterruptedError()
        with active_downloads._LOCK:
            if job['_busy_check'] and job['_busy_check'](conn,ident,path):raise ValueError('A source scan or download is active; records were kept.')
            return action()
    if job['auto_exact']:
        for match in _automatic_matches(job):
            try:
                perform(match['review_id'],match['path'],lambda:relink(conn,job['id'],match['review_id'],match['path']))
                with _LOCK:job['auto_saved']+=1
            except (ValueError,OSError,sqlite3.Error) as exc:apply_error(job['id'],match['review_id'],str(exc))
