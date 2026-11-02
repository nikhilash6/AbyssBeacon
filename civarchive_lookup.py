"""On-demand, read-only CivArchive identification. Never uploads model bytes."""
import hashlib
import json
import re
import threading
import time
import secrets
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlsplit
import local_inventory

_LOCK=threading.RLock()
_JOBS={}
_CACHE={}
_NEXT_REQUEST=0
_COOLDOWN=0

def normalize(payload, digest):
    if not isinstance(payload,dict):raise ValueError('Unexpected CivArchive response.')
    data=payload.get('data',payload)
    if not isinstance(data,dict):raise ValueError('Unexpected CivArchive response.')
    model=data.get('model') or {}
    if not isinstance(model,dict):raise ValueError('Unexpected model metadata.')
    version=model.get('version') or data.get('version') or {}
    if not isinstance(version,dict):raise ValueError('Unexpected version metadata.')
    matches=[]
    for file in version.get('files') or []:
        if not isinstance(file,dict):continue
        hashes=file.get('hashes') or {}
        sha=file.get('sha256') or (hashes.get('SHA256') if isinstance(hashes,dict) else '')
        if str(sha).lower()!=digest:continue
        if str(file.get('modelVersionId',version.get('id')))!=str(version.get('id')):continue
        mirrors=[]
        for mirror in file.get('mirrors') or []:
            if not isinstance(mirror,dict):continue
            url=mirror.get('url','')
            try:valid=urlsplit(url).scheme=='https' and bool(urlsplit(url).hostname) and not urlsplit(url).username
            except (ValueError,TypeError):valid=False
            if valid:mirrors.append({k:mirror.get(k) for k in ('filename','url','source','deletedAt','is_gated','is_paid')})
        matches.append({'model':model.get('name'),'model_id':model.get('id'),'platform':model.get('platform'),
          'creator':model.get('creator_username') or model.get('username') or '',
          'model_url':'https://civarchive.com/models/'+str(model.get('id'))+'?modelVersionId='+str(version.get('id')),
          'version':version.get('name'),'version_id':version.get('id'),'architecture':version.get('baseModel'),
          'file_id':file.get('id'),'filename':file.get('name'),'type':file.get('type'),'size_kb':file.get('sizeKB'),
          'archive_model':{k:model.get(k) for k in ('name','type','description','creator_username','createdAt','updatedAt','tags','is_nsfw')},
          'archive_version':{k:version.get(k) for k in ('id','name','baseModel','description','trigger','images','createdAt','updatedAt')},'archive_file':file,
          'sha256':digest,'mirrors':mirrors,'mature':bool(model.get('is_nsfw') or version.get('is_nsfw'))})
    # Collapse repeated records only when all source identity fields agree.
    unique={}
    for match in matches:
        key=(match['platform'],str(match['model_id']),str(match['version_id']),str(match['file_id']),match['sha256'])
        unique.setdefault(key,match)
    matches=list(unique.values())
    mirror_only=not model and bool(data.get('mirrors') or data.get('files'))
    return {'state':'matched' if matches else 'unverified','mirror_only':mirror_only,'matches':matches,
      'message':'' if matches else ('Mirror found — model details unavailable. This file cannot yet be imported as a model card.' if mirror_only else 'No verified model/version details available for import. A mirror may still be listed on CivArchive; review its page.')}

def _request_json(route,cancel):
    global _NEXT_REQUEST,_COOLDOWN
    if time.time()<_COOLDOWN:raise ValueError('CivArchive is cooling down after a rate limit. Try later.')
    if cancel.wait(max(0,_NEXT_REQUEST-time.monotonic())):raise InterruptedError('Lookup stopped.')
    _NEXT_REQUEST=time.monotonic()+3
    request=urllib.request.Request('https://civarchive.com/api/'+route,headers={'Accept':'application/json','User-Agent':'AbyssBeacon/1.5.1 (selected-file identification)'})
    try:
        with urllib.request.urlopen(request,timeout=20) as response:
            raw=response.read(4*1024*1024+1)
            if len(raw)>4*1024*1024:raise ValueError('CivArchive response too large; review its page manually.')
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        if exc.code==429:
            try:delay=max(3600,int(exc.headers.get('Retry-After','3600')))
            except ValueError:delay=3600
            _COOLDOWN=time.time()+delay
            raise ValueError('CivArchive rate limit reached. Try again later.') from exc
        raise


def expand_matches(payload,digest,cancel,fetch=_request_json):
    result=normalize(payload,digest)
    data=payload.get('data',payload)
    identities=set()
    for file in data.get('files',[]):
        if not isinstance(file,dict) or file.get('source') not in ('civitai','civitaired'):continue
        mid=str(file.get('model_id') or '');vid=str(file.get('model_version_id') or '')
        if mid.isdigit() and vid.isdigit():identities.add((mid,vid))
    loaded={(str(m['model_id']),str(m['version_id'])) for m in result['matches']}
    pending=sorted(identities-loaded)
    failures=[]
    for mid,vid in pending[:20]:
        try:
            model=fetch('models/'+mid+'?modelVersionId='+vid,cancel)
            model=model.get('data',model)
            if 'model' in model:model=model['model']
            if str(model.get('id'))!=mid or str((model.get('version') or {}).get('id'))!=vid:
                raise ValueError('CivArchive returned a different model/version.')
            found=normalize({'model':model},digest)['matches']
            if not found:raise ValueError('No matching SHA-256 in this version.')
            result['matches'].extend(found)
        except InterruptedError:raise
        except Exception as exc:failures.append(f'Model {mid}, version {vid}: {exc}')
    unique={}
    for m in result['matches']:
        unique.setdefault((m['platform'],str(m['model_id']),str(m['version_id']),str(m['file_id'])),m)
    result['matches']=list(unique.values())
    if len(pending)>20:failures.append('More than 20 additional associations; use a direct model URL.')
    if failures:
        result.update(state='incomplete',message='Some model matches could not be verified. Retry lookup or link a model URL. No model was chosen automatically. '+'; '.join(failures))
    elif result['matches']:result['state']='matched'
    return result


def lookup(digest,cancel):
    if not re.fullmatch('[0-9a-f]{64}',digest) or digest==hashlib.sha256(b'').hexdigest():raise ValueError('A nonempty file SHA-256 is required.')
    if digest in _CACHE and time.time()-_CACHE[digest][0]<86400:return _CACHE[digest][1]
    try:result=expand_matches(_request_json('sha256/'+digest,cancel),digest,cancel)
    except urllib.error.HTTPError as exc:
        if exc.code==404:result={'state':'not_found','matches':[],'message':'CivArchive returned no result. This does not mean the model was deleted.'}
        else:raise ValueError(f'CivArchive returned HTTP {exc.code}; this is not a no-match result.') from exc
    if result['state']!='incomplete':_CACHE[digest]=(time.time(),result)
    while len(_CACHE)>256:_CACHE.pop(next(iter(_CACHE)))
    return result

def start(inventory_id,paths):
    inventory=local_inventory.status(inventory_id)
    if inventory['status']!='complete':raise ValueError('Finish the local scan first.')
    available={f['path']:dict(f) for f in inventory['result']['files'] if not f['tracked']}
    if not isinstance(paths,list) or not 1<=len(paths)<=50 or any(not isinstance(p,str) or p not in available for p in paths):raise ValueError('Select 1–50 unlinked files from this scan.')
    files=[available[p] for p in dict.fromkeys(paths)]
    with _LOCK:
        if any(j['status']=='running' for j in _JOBS.values()):raise ValueError('An identification is already running.')
        _JOBS.clear();key=secrets.token_urlsafe(18);job={'status':'running','results':[],'total':len(files),'phase':'Starting','cancel':threading.Event()};_JOBS[key]=job
    def worker():
        try:
            for file in files:
                if job['cancel'].is_set():raise InterruptedError('Lookup stopped; completed results retained.')
                job['phase']='Checking cached hash: '+file['filename']
                try:
                    path=Path(file['path']);before=local_inventory.identity(path)
                    if before!=file['identity']:raise ValueError('File changed since scan; scan again.')
                    if before[2]==0:raise ValueError('Empty files cannot be identified.')
                    digest=file.get('sha256')
                    if not digest:
                        job['phase']='Hashing local file: '+file['filename'];hasher=hashlib.sha256()
                        with path.open('rb') as stream:
                            while True:
                                if job['cancel'].is_set():raise InterruptedError('Lookup stopped; completed results retained.')
                                chunk=stream.read(4*1024*1024)
                                if not chunk:break
                                hasher.update(chunk)
                        digest=hasher.hexdigest()
                    if local_inventory.identity(path)!=before:raise ValueError('File changed while hashing; scan again.')
                    job['phase']='Looking up on CivArchive: '+file['filename']
                    result=lookup(digest,job['cancel'])
                    job['results'].append({'path':str(path),'identity':before,'sha256':digest,**result})
                except InterruptedError:raise
                except Exception as exc:
                    job['results'].append({'path':file['path'],'state':'error','matches':[],'message':str(exc)})
                    # Do not hammer the service or mislabel unprocessed files.
                    job.update(status='error',phase='Stopped after an error; remaining files were not queried.');return
            job.update(status='complete',phase='Identification complete. No files or installed records changed.')
        except InterruptedError as exc:job.update(status='cancelled',phase=str(exc))
    threading.Thread(target=worker,daemon=True,name='CivArchiveLookup').start();return key

def status(key,stop=False,internal=False):
    with _LOCK:
        if key not in _JOBS:raise ValueError('Identification expired; run it again.')
        job=_JOBS[key]
        if stop:job['cancel'].set()
        result={k:list(v) if k=='results' else v for k,v in job.items() if k!='cancel'}
        if not internal:
            result['results']=[{**r,'matches':[{k:v for k,v in m.items() if not k.startswith('archive_')} for m in r.get('matches',[])]} for r in result['results']]
        return result
