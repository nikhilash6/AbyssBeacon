"""Local inventory, cancellable duplicate checks, and opt-in verified-copy recycling."""
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import threading
import subprocess
import sys
from collections import defaultdict
from installed_recovery import safe_file
from file_format_detection import detect_extension, needs_extension
from model_identity import WEIGHT_EXTENSIONS

_LOCK = threading.RLock()
_JOBS = {}
_CACHE = Path(__file__).resolve().parent / 'user_settings' / 'local_hash_cache.json'

def identity(path):
    path, _ = safe_file(path)
    stat = path.stat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]

def scan(roots, tracked, cancel, progress, cache, rehash=False):
    files, errors, seen = [], [], set()
    def check():
        if cancel.is_set(): raise InterruptedError('Scan cancelled; no model files were changed.')
    for raw in roots:
        check();root=Path(raw).expanduser().absolute()
        if not root.is_dir():errors.append(f'{root}: folder unavailable');continue
        if any(p.is_symlink() or getattr(p,'is_junction',lambda:False)() for p in (root,*root.parents)):
            errors.append(f'{root}: linked folder skipped');continue
        for folder, dirs, names in os.walk(root,followlinks=False,onerror=lambda exc:errors.append(str(exc))):
            check()
            dirs[:]=[d for d in dirs if d not in {'.git','.venv','venv','node_modules','__pycache__'} and not (Path(folder)/d).is_symlink() and not getattr(Path(folder)/d,'is_junction',lambda:False)()]
            for name in names:
                check();path=Path(folder)/name;key=os.path.normcase(str(path))
                if key in seen:continue
                seen.add(key)
                if path.suffix.casefold() not in WEIGHT_EXTENSIONS|{'.sft','.json','.zip'} and key not in tracked:
                    if not needs_extension(name) or detect_extension(path) not in {'.safetensors','.json'}:continue
                try:
                    stamp=identity(path);record=tracked.get(key,{})
                    files.append({'path':str(path),'filename':name,'size':stamp[2],'identity':stamp,'tracked':bool(record),'model_id':record.get('model_id'),'model_name':record.get('model_name') or '', 'sha256':'','cached':False})
                except (OSError,ValueError) as exc:errors.append(f'{path}: {exc}')
                progress(phase='Reading folders',files=len(files),current_path=str(path))
    sizes=defaultdict(list)
    for file in files:
        if file['size']>0:sizes[file['size']].append(file)
    candidates=[file for group in sizes.values() if len(group)>1 for file in group]
    total=sum(f['size'] for f in candidates);done=0;hashed=0;cached=0
    for file in candidates:
        check();path=Path(file['path']);key=os.path.normcase(str(path))
        try:
            before=identity(path)
            if before!=file['identity']:raise ValueError('File changed during inventory; skipped.')
            prior=cache.get(key,{})
            if not isinstance(prior,dict):prior={}
            if not rehash and prior.get('identity')==before and isinstance(prior.get('sha256'),str) and re.fullmatch(r'[0-9a-f]{64}',prior['sha256']):
                digest=prior['sha256'];file['cached']=True;cached+=1;done+=file['size']
            else:
                digest=hashlib.sha256()
                with path.open('rb') as handle:
                    while True:
                        check();chunk=handle.read(4*1024*1024)
                        if not chunk:break
                        digest.update(chunk);done+=len(chunk)
                        progress(phase='Checking SHA-256',current_path=str(path),bytes_done=done,bytes_total=total,hashed=hashed,cached=cached)
                digest=digest.hexdigest();hashed+=1
            if identity(path)!=before:raise ValueError('File changed while hashing; skipped.')
            file['sha256']=digest;cache[key]={'identity':before,'sha256':digest}
        except (OSError,ValueError) as exc:errors.append(f'{path}: {exc}')
    groups=defaultdict(list)
    for file in files:
        if file['sha256']:groups[file['sha256']].append(file)
    duplicates=[]
    for digest, group in groups.items():
        if len(group)<2:continue
        physical={(f['identity'][0],f['identity'][1]) if f['identity'][1] else f['path'] for f in group}
        duplicates.append({'sha256':digest,'files':group,'physical_copies':len(physical),'extra_bytes':max(0,len(physical)-1)*group[0]['size']})
    duplicates.sort(key=lambda g:g['extra_bytes'],reverse=True)
    progress(phase='Complete',bytes_done=done,bytes_total=total,hashed=hashed,cached=cached,current_path='')
    return {'files':files,'duplicates':duplicates,'errors':errors,'unlinked':sum(not f['tracked'] for f in files)}

def start(connect, roots, rehash=False):
    with _LOCK:
        if any(j['status']=='running' for j in _JOBS.values()):raise ValueError('A local inventory is already running.')
        _JOBS.clear();key=secrets.token_urlsafe(18);job={'status':'running','phase':'Starting','files':0,'bytes_done':0,'bytes_total':0,'cancel':threading.Event(),'result':None};_JOBS[key]=job
    def worker():
        conn=None
        def progress(**values):
            with _LOCK:job.update(values)
        try:
            try:
                cache=json.loads(_CACHE.read_text(encoding='utf-8'))
                if not isinstance(cache,dict):cache={}
            except (OSError,ValueError):cache={}
            conn=connect()
            rows=conn.execute('SELECT i.local_path,i.model_id,r.model_name FROM installed_files i LEFT JOIN download_reviews r ON r.id=i.review_id').fetchall()
            tracked={os.path.normcase(os.path.abspath(r['local_path'])):dict(r) for r in rows};conn.close();conn=None
            result=scan(roots,tracked,job['cancel'],progress,cache,rehash)
            if job['cancel'].is_set():raise InterruptedError('Scan cancelled; no model files were changed.')
            try:
                _CACHE.parent.mkdir(parents=True,exist_ok=True);temp=_CACHE.with_suffix('.tmp');temp.write_text(json.dumps(cache),encoding='utf-8');os.replace(temp,_CACHE)
            except OSError as exc:result['errors'].append('Hash cache could not be saved: '+str(exc))
            progress(status='complete',result=result)
        except InterruptedError as exc:progress(status='cancelled',phase=str(exc))
        except Exception as exc:progress(status='error',phase=str(exc))
        finally:
            if conn:conn.close()
    threading.Thread(target=worker,daemon=True,name='LocalInventory').start();return key

def status(key, cancel=False):
    with _LOCK:
        if key not in _JOBS:raise ValueError('Scan expired; scan again.')
        job=_JOBS[key]
        if cancel:job['cancel'].set()
        return {k:v for k,v in job.items() if k!='cancel'}


_DELETE_LOCK = threading.Lock()


def _live_sha256(file_path):
    """Hash a currently present, regular file and verify its identity stayed stable."""
    before = identity(file_path)  # safe_file refuses junctions and symlinks
    h = hashlib.sha256()
    with Path(file_path).open('rb') as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b''):
            h.update(block)
    if identity(file_path) != before:
        raise ValueError('A file changed while verifying the duplicate. Scan again.')
    return h.hexdigest(), before


def _recycle_to_bin(file_path):
    """Windows Recycle Bin only. Never silently fall back to permanent deletion."""
    if sys.platform != 'win32':
        raise ValueError('Recycle Bin deletion is supported on Windows only. Use Open folder instead.')
    # Pass the file path through the environment to prevent command injection.
    # Microsoft.VisualBasic.FileIO.DeleteFile explicitly requests the Recycle Bin.
    script = ("$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; "
              "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile("
              "$env:ABYSS_RECYCLE_PATH,"
              "[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,"
              "[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,"
              "[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)")
    env = os.environ.copy()
    env['ABYSS_RECYCLE_PATH'] = str(file_path)
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    try:
        process = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                                 env=env, capture_output=True, text=True, timeout=45,
                                 creationflags=flags, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f'Could not send the file to the Recycle Bin: {exc}') from exc
    if process.returncode != 0:
        detail = (process.stderr or process.stdout or 'Windows rejected the recycle operation.').strip()
        raise ValueError('Windows could not recycle this file. It was not deliberately deleted permanently. '+detail[:400])
    if Path(file_path).exists():
        raise ValueError('Windows did not remove the file from its original location. Scan again.')


def recycle_copy(key, selected_path, selected_sha256, connect):
    """Safely recycle one verified duplicate from a completed scan.

    Checks are made against actual on-disk contents, not only cached inventory
    hashes. We retain at least one independent verified physical copy.
    """
    if not isinstance(selected_path, str) or not isinstance(selected_sha256, str):
        raise ValueError('Choose a duplicate from the completed scan.')
    if not re.fullmatch(r'[a-f0-9]{64}', selected_sha256):
        raise ValueError('The duplicate identity is invalid. Scan again.')
    with _DELETE_LOCK:
        with _LOCK:
            job = _JOBS.get(key)
            if not job or job.get('status') != 'complete' or not job.get('result'):
                raise ValueError('Scan expired or is not complete. Scan again.')
            result = job['result']
            group = next((g for g in result['duplicates'] if g['sha256'] == selected_sha256 and
                          any(f['path'] == selected_path for f in g['files'])), None)
            if not group:
                raise ValueError('The chosen file is no longer in a verified duplicate group. Scan again.')
            target = next(f for f in group['files'] if f['path'] == selected_path)
            if Path(target['filename']).suffix.casefold() != '.safetensors':
                raise ValueError('Only .safetensors duplicates can be recycled here. Use Open folder for other files.')
            if group['physical_copies'] < 2:
                raise ValueError('This group has no separate physical copy to keep.')
            snapshots = [dict(f) for f in group['files']]

        # Do not touch the disk until the target AND another independent copy
        # have just been hashed and compared with the scan's exact identities.
        target_hash, target_identity = _live_sha256(selected_path)
        if target_identity != target['identity'] or target_hash != selected_sha256:
            raise ValueError('The selected file changed after the scan. Scan again before deleting anything.')
        survivor = None
        for candidate in snapshots:
            if candidate['path'] == selected_path:
                continue
            if candidate['identity'][0:2] == target_identity[0:2] and target_identity[1]:
                continue  # another name for the SAME physical file (hard link)
            try:
                digest, live_identity = _live_sha256(candidate['path'])
            except (OSError, ValueError):
                continue
            if digest == selected_sha256 and live_identity == candidate['identity']:
                survivor = candidate
                break
        if not survivor:
            raise ValueError('No other independently verified physical copy remains. Nothing was deleted.')

        # One final no-race preflight before asking Windows to recycle it.
        if identity(selected_path) != target_identity or identity(survivor['path']) != survivor['identity']:
            raise ValueError('The duplicate changed while checking it. Scan again.')
        _recycle_to_bin(selected_path)

        warning = ''
        try:
            # Only untrack the selected path. Keep review states, tags, and
            # download history; the model may still be installed elsewhere.
            db = connect()
            try:
                db.execute('DELETE FROM installed_files WHERE local_path=? COLLATE NOCASE', (selected_path,))
                db.commit()
            finally:
                db.close()
        except Exception as exc:
            warning = 'File recycled, but library tracking could not be updated. Refresh your library: '+str(exc)

        with _LOCK:
            result['files'] = [f for f in result['files'] if f['path'] != selected_path]
            result['unlinked'] = sum(not f['tracked'] for f in result['files'])
            for current in result['duplicates'][:]:
                if any(f['path'] == selected_path for f in current['files']):
                    current['files'] = [f for f in current['files'] if f['path'] != selected_path]
                    physical = {(f['identity'][0], f['identity'][1]) if f['identity'][1] else f['path'] for f in current['files']}
                    current['physical_copies'] = len(physical)
                    current['extra_bytes'] = max(0, len(physical)-1) * (current['files'][0]['size'] if current['files'] else 0)
                    if len(current['files']) < 2:
                        result['duplicates'].remove(current)
            result['duplicates'].sort(key=lambda g: g['extra_bytes'], reverse=True)
            job['files'] = len(result['files'])
        return {'path': selected_path, 'kept_path': survivor['path'], 'warning': warning,
                'result': result}
