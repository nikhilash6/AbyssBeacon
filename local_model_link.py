"""Explicit local-file linking. No filesystem moves or guessed source identities."""
import hashlib
import json
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
import database
import download_reviews
import install_choices
import local_inventory

_PLANS={}
_LOCK=threading.RLock()

def scanned_file(job_id,path):
    job=local_inventory.status(job_id)
    if job['status']!='complete':raise ValueError('Finish the folder scan first.')
    row=next((r for r in job['result']['files'] if r['path']==path),None)
    if row is None:raise ValueError('Choose a file from this scan.')
    if local_inventory.identity(path)!=row['identity']:raise ValueError('File changed; scan again.')
    return row

def search(query):
    if not str(query).strip():return []
    conn=database.connect()
    try:return [dict(r) for r in conn.execute("SELECT id,COALESCE(NULLIF(display_name,''),name) AS name,source,model_key,architecture,author,CASE WHEN sensitive=0 THEN image END AS image FROM models WHERE instr(lower(COALESCE(display_name,'')||' '||COALESCE(name,'')),lower(?))>0 ORDER BY name LIMIT 30",(str(query)[:200],))]
    finally:conn.close()

def prepare(job_id,payload,settings):
    path=str(payload.get('path') or '');local=scanned_file(job_id,path)
    mode=payload.get('mode');card_id=None
    if mode=='existing':
        conn=database.connect()
        try:
            row=conn.execute('SELECT * FROM models WHERE id=?',(payload.get('card_id'),)).fetchone()
            if not row:raise ValueError('Choose an existing model card.')
            snap=dict(row);card_id=row['id']
        finally:conn.close()
    elif mode=='url':
        import url_import
        if urlsplit(str(payload.get('url') or '')).hostname in ('civarchive.com','www.civarchive.com'):
            raise ValueError('Paste the original model page linked from CivArchive to load its details.')
        target=url_import.parse_target(payload.get('url'))
        if target['kind']!='model':raise ValueError('Use a model URL, not a creator URL.')
        config=dict(settings.get('search_settings',{}).get(target['source'],{}))
        config['include_mature_media']=False
        models=url_import.scan_target(target,config)
        if len(models)!=1:raise ValueError('The URL did not identify one model.')
        snap=dict(database._model_mapping(models[0]))
        conn=database.connect()
        try:
            row=conn.execute('SELECT model_id FROM model_sources WHERE lower(source)=lower(?) AND model_key=?',(snap['source'],str(snap['model_key']))).fetchone()
            if row:card_id=row[0]
        finally:conn.close()
    elif mode=='manual':
        name=str(payload.get('name') or '').strip()[:200]
        if not name:raise ValueError('Enter a model name.')
        url=str(payload.get('url') or '').strip()
        if url:
            u=urlsplit(url)
            if u.scheme not in ('http','https') or not u.hostname or u.username or u.password:raise ValueError('Use an HTTP(S) reference URL.')
        category=payload.get('category')
        if category not in install_choices.TYPES:raise ValueError('Choose a model type.')
        snap={'name':name,'display_name':name,'source':'local','model_key':secrets.token_hex(16),'url':url,'architecture':str(payload.get('architecture') or 'Other')[:100], 'base_model':str(payload.get('architecture') or 'Other')[:100], 'model_type':install_choices.TYPES[category], 'description':'Manually added local model. File identity not verified against an online source.', 'files':[], 'card_data':{'imported_via':'manual'},'sensitive':False}
    else:raise ValueError('Choose URL, existing model, or manual entry.')
    files=snap.get('files') or []
    if isinstance(files,str):files=json.loads(files)
    files=[f for f in files if isinstance(f,dict)]
    # Preserve source file/version identifiers; an explicit "page only" choice has none.
    options=[]
    for index,f in enumerate(files):
        options.append({'index':index,'filename':f.get('name') or f.get('path') or 'Unnamed file','version':f.get('version_name') or f.get('version_id') or f.get('model_version_id') or '', 'file_id':str(f.get('model_file_id') or f.get('file_id') or f.get('id') or '')})
    token=secrets.token_urlsafe(24)
    with _LOCK:
        for key in list(_PLANS):
            if time.time()-_PLANS[key]['created']>900:del _PLANS[key]
        _PLANS[token]={'created':time.time(),'path':path,'identity':local['identity'],'snapshot':snap,'files':files,'card_id':card_id,'category':payload.get('category',''),'saved':False,'sha256':local.get('sha256')}
    return {'token':token,'name':snap.get('display_name') or snap.get('name'),'path':path,'files':options,'existing':card_id is not None}

def apply(token,index,confirmed):
    if confirmed is not True:raise ValueError('Review and confirm the link first.')
    with _LOCK:
        p=_PLANS.get(token)
        if not p or time.time()-p['created']>900:raise ValueError('Link preview expired; review again.')
        if p['saved']:return {'model_id':p['card_id'],'already_saved':True}
        path=Path(p['path'])
        if local_inventory.identity(path)!=p['identity']:raise ValueError('File changed; scan again.')
        if type(index) is not int or index < -1 or index>=len(p['files']):raise ValueError('Choose a file/version or model-page-only link.')
        f=p['files'][index] if index>=0 else {}
        hashes=f.get('hashes') or {};expected=f.get('sha256') or (hashes.get('SHA256') or hashes.get('sha256') if isinstance(hashes,dict) else '')
        verified=''
        if expected:
            digest=hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda:stream.read(4*1024*1024),b''):digest.update(chunk)
            if local_inventory.identity(path)!=p['identity']:raise ValueError('File changed during verification.')
            if digest.hexdigest().lower()!=str(expected).lower():raise ValueError('SHA-256 does not match the selected source file. Choose the correct file/version, or explicitly link only to the model page.')
            verified=digest.hexdigest()
        conn=database.connect()
        try:
            if conn.execute('SELECT id FROM installed_files WHERE local_path=?',(str(path),)).fetchone():raise ValueError('File is already linked; refresh the scan.')
        finally:conn.close()
        card=p['card_id']
        if card is None:card=database.add_model(p['snapshot'])['model_id']
        conn=database.connect()
        try:
            snap=p['snapshot'];now=datetime.now(timezone.utc).isoformat()
            with conn:
                conn.execute('INSERT INTO installed_files(model_id,source,model_key,source_file_id,file_fingerprint,local_path,filename,version_id,version_name,installed_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(card,snap['source'],str(snap['model_key']),str(f.get('model_file_id') or f.get('file_id') or f.get('id') or ''),verified,str(path),path.name,str(f.get('version_id') or f.get('model_version_id') or ''),str(f.get('version_name') or ''),now))
                row=conn.execute('SELECT * FROM installed_files WHERE local_path=?',(str(path),)).fetchone()
                review=download_reviews.record(conn,dict(row),'unsorted')
                conn.execute('UPDATE download_reviews SET imported_at=?,import_date_source=?,location_updated_at=?,verified_sha256=?,verified_size=?,install_category=? WHERE id=?',(now,'Manual link — file hash verified' if verified else 'Manual link — file identity not verified',now,verified,path.stat().st_size if verified else None,p['category'] if p['category'] in install_choices.TYPES else '',review))
            p.update(saved=True,card_id=card)
            return {'model_id':card,'verified':bool(verified)}
        finally:conn.close()
