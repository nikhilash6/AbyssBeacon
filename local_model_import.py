"""Preview-confirmed local model imports. Existing files are never overwritten."""
import json
import os
import secrets
import threading
import time
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlsplit
import urllib.request
import io
import database
import download_reviews
import local_inventory
import civarchive_lookup
import import_previews
from installer import safe_component

_LOCK=threading.RLock()
_PLANS={}

def snapshot(match,include_mature=False):
    from scanners.civitai import _file_record,_media_records,_model_type,_version_summary
    from scanners.common import processors
    model=match.get('archive_model') or {};version=match.get('archive_version') or {};file=match.get('archive_file') or {}
    mid=str(match['model_id']);vid=str(match['version_id'])
    if match.get('platform') not in ('civitai','civitaired') or not mid.isdigit() or not vid.isdigit() or not str(match.get('file_id','')).isdigit():
        raise ValueError('This archive platform cannot yet be imported safely. Use its source page.')
    source='civitaired' if match.get('platform')=='civitaired' else 'civitai'
    domain='civitai.red' if source=='civitaired' else 'civitai.com'
    f=_file_record(file,version,mid);f['hashes']={'SHA256':match['sha256']};f['download_url']=f['download_url'].replace('civitai.com',domain);f['mirrors']=match['mirrors']
    media=_media_records([dict(version,files=[file])],match['mature'],include_mature)
    # Include the verified archive image CDN; keep arbitrary remote hosts blocked.
    media=[m for m in media if import_previews.allowed_url(m['url'])]
    image=next((m['url'] for m in media if m['type']=='image'),'')
    return {'name':match['model'],'display_name':match['model'],'author':model.get('creator_username') or '',
      'source':source,'model_key':mid,'url':f'https://{domain}/models/{mid}','base_model':match['architecture'] or '',
      'architecture':processors.classify_architecture(match['architecture'] or '') if match['architecture'] else 'Other',
      'model_type':_model_type(model.get('type') or match['type'],match['model']),
      'description':model.get('description') or '', 'sensitive':match['mature'],'files':[f], 'media':media,'image':image,
      'has_media':bool(media),'preview_count':len(media),'created':model.get('createdAt') or '', 'updated':model.get('updatedAt') or '',
      'card_data':{'imported_via':'civarchive','archive_url':'https://civarchive.com/sha256/'+match['sha256'],'matched_version_id':vid,'version_id':version.get('id'),'version_name':version.get('name'),'base_model':version.get('baseModel'),'versions':[_version_summary(dict(version,trainedWords=version.get('trigger') or []))]}}

def existing_card(conn,match):
    rows=conn.execute("SELECT DISTINCT model_id FROM model_sources WHERE source IN ('civitai','civitaired') AND model_key=? UNION SELECT id FROM models WHERE source IN ('civitai','civitaired') AND model_key=?",(str(match['model_id']),str(match['model_id']))).fetchall()
    if len(rows)>1:raise ValueError('Multiple existing cards share this source model ID; resolve the duplicate cards before importing this file.')
    return rows[0][0] if rows else None

def recorded_date(path,match):
    """Recover an explicit per-file installation date, never filesystem timestamps."""
    import re
    for name in ('AbyssBeacon Info.txt','ModelRadar Info.txt'):
        side=path.parent/name
        try:
            local_inventory.identity(side)
            if side.stat().st_size>1024*1024:continue
            text=side.read_text(encoding='utf-8')
            fields=dict(re.findall(r'^([^:\n]+): (.*)$',text,re.M))
            if fields.get('Installed file')!=path.name:continue
            url=fields.get('Source URL','')
            if not re.search(r'/models/'+re.escape(str(match['model_id']))+r'(?:[/?#]|$)',url):continue
            stamp=datetime.fromisoformat(fields.get('Installed','').replace('Z','+00:00'))
            if stamp.tzinfo is None or stamp>datetime.now(timezone.utc):continue
            return stamp.isoformat(),name+' · Installed timestamp'
        except (OSError,ValueError):pass
    return '', ''

def plan(job_id,paths,move=False,companions=False,include_mature=False,choices=None):
    choices=choices or {}
    if not isinstance(choices,dict):raise ValueError("Invalid match choices.")
    job=civarchive_lookup.status(job_id,internal=True)
    if job['status']=='running':raise ValueError('Wait for identification to finish or stop it before saving.')
    if not isinstance(paths,list) or not 1<=len(paths)<=50:raise ValueError('Select 1–50 identified files.')
    results={r['path']:r for r in job['results']}
    rows=[];destinations=set()
    for path in dict.fromkeys(paths):
        result=results.get(path)
        if not result or result['state']!='matched' or not result['matches']:raise ValueError(f'No verified model details for {Path(path).name}.')
        index=choices.get(path,0 if len(result['matches'])==1 else None)
        if type(index) is not int or not 0<=index<len(result['matches']):raise ValueError(f'Choose which metadata to import for {Path(path).name}.')
        match=result['matches'][index];snap=snapshot(match,include_mature);source=Path(path)
        if local_inventory.identity(source)!=result['identity']:raise ValueError(f'{source.name} changed since identification; identify it again.')
        conn=database.connect()
        try:
            card=existing_card(conn,match)
            previews,preview_status=import_previews.candidates(conn,card,match,snap,include_mature)
            if previews and not snap['image']:snap['image']=previews[0]['url']
            tracked=conn.execute('SELECT id FROM installed_files WHERE local_path=?',(str(source),)).fetchone()
        finally:conn.close()
        if tracked:raise ValueError(f'{source.name} is already installed; refresh the scan.')
        folder_name=safe_component(match['model'],max_length=90)
        folder=source.parent if not move or source.parent.name.casefold()==folder_name.casefold() else source.parent/folder_name
        for parent in (folder,*folder.parents):
            if parent.is_symlink() or getattr(parent,'is_junction',lambda:False)():raise ValueError('Linked folders must be managed manually.')
        target=folder/source.name
        if target!=source and target.exists():raise ValueError(f'Destination already exists: {target}')
        transfers=[{'from':str(source),'to':str(target),'identity':result['identity'],'size':source.stat().st_size}]
        if target!=source:
            sides=[source.with_suffix(ext) for ext in ('.json','.metadata.json','.txt','.png','.jpg','.jpeg','.webp')]
            sides.append(source.with_name(source.name+'.metadata.json'))
            for side in sides:
                if side.is_file():
                    dest=folder/side.name
                    if dest.exists():raise ValueError(f'Destination already exists: {dest}')
                    transfers.append({'from':str(side),'to':str(dest),'identity':local_inventory.identity(side),'size':side.stat().st_size})
        for transfer in transfers:
            dest=os.path.normcase(transfer['to'])
            if dest in destinations:raise ValueError('Selected files would use the same destination; import them separately.')
            destinations.add(dest)
        recorded,origin=recorded_date(source,match)
        rows.append({'completed_at':recorded,'date_origin':origin,'path':str(source),'target':str(target),'match':match,'snapshot':snap,'transfers':transfers,'card_id':card,
          'preview_candidates':previews,'preview_status':preview_status,'companions':bool(companions),'saved':False,'info_path':str(folder/(source.stem+'.abyss.txt')),'preview_path':str(folder/(source.stem+'.abyss.jpg'))})
    token=secrets.token_urlsafe(24)
    with _LOCK:
        for key in list(_PLANS):
            if time.time()-_PLANS[key]['created']>900:del _PLANS[key]
        _PLANS[token]={'created':time.time(),'rows':rows}
    return {'token':token,'files':[{'path':r['path'],'target':r['target'],'model':r['match']['model'],'chosen_filename':r['match'].get('filename'),'chosen_file_id':r['match'].get('file_id'),'chosen_version':r['match'].get('version'),'recorded_date':r['completed_at'],'date_origin':r['date_origin'],'action':'Link existing card' if r['card_id'] else 'Create model card','transfers':r['transfers'],'info_path':r['info_path'] if companions else '', 'preview_path':r['preview_path'] if companions and r['preview_candidates'] else '', 'preview_status':r['preview_status'] if companions else ''} for r in rows]}

def info_text(row):
    m=row['match'];v=m.get('archive_version') or {}
    lines=[m['model'],'Version: '+str(m['version']),'Architecture: '+str(m['architecture']),'Filename: '+Path(row['target']).name,'SHA-256: '+m['sha256'],'File ID: '+str(m['file_id']),'Version ID: '+str(m['version_id']),'Archive: https://civarchive.com/sha256/'+m['sha256']]
    triggers=v.get('trigger') or []
    if triggers:lines.append('Trigger words: '+(', '.join(map(str,triggers)) if isinstance(triggers,list) else str(triggers)))
    from html import unescape
    import re
    notes=unescape(re.sub('<[^>]+>',' ',str(v.get('description') or ''))).strip()
    if notes:lines.extend(['Version notes:',notes])
    lines.append('Full model description: '+row['snapshot']['url'])
    return '\n'.join(lines)+'\n'

def save_companions(row):
    warnings=[]
    info=Path(row['info_path']);preview=Path(row['preview_path'])
    try:
        with info.open('x',encoding='utf-8') as stream:stream.write(info_text(row))
    except FileExistsError:warnings.append('Existing info file kept.')
    except OSError as exc:warnings.append('Could not save info: '+str(exc))
    previews=row.get('preview_candidates') or ([{'url':row['snapshot']['image']}] if row['snapshot']['image'] else [])
    if not previews:return warnings+[row.get('preview_status') or 'No eligible image preview was available.']
    if preview.exists():return warnings+['Existing preview kept.']
    failures=[]
    for item in previews:
        try:
            raw=import_previews.read_image(item['url'])
            with preview.open('xb') as stream:stream.write(raw)
            if failures:warnings.append('Saved preview using an alternate image for the same version.')
            return warnings
        except FileExistsError:return warnings+['Existing preview kept.']
        except Exception as exc:failures.append(str(exc))
    warnings.append('Preview not saved: '+'; '.join(dict.fromkeys(failures)))

    return warnings

def add_missing_metadata(conn,card,source,snap):
    """Append the exact matched artifact/version; keep existing descriptions and statistics."""
    def merge(old):
        old=dict(old);files=old.get('files') or []
        if isinstance(files,str):files=json.loads(files)
        keys={(str(f.get('id') or f.get('file_id')),str(f.get('version_id'))) for f in files if isinstance(f,dict)}
        old['files']=files+[f for f in snap['files'] if (str(f.get('id')),str(f.get('version_id'))) not in keys]
        data=old.get('card_data') or {}
        if isinstance(data,str):data=json.loads(data)
        data=dict(data);versions=data.get('versions') or [];ids={str(v.get('id')) for v in versions if isinstance(v,dict)}
        data['versions']=versions+[v for v in snap['card_data']['versions'] if str(v.get('id')) not in ids]
        old['card_data']=data;return old
    row=conn.execute('SELECT source_data FROM model_sources WHERE model_id=? AND source=? AND model_key=?',(card,source,snap['model_key'])).fetchone()
    if row:
        old=json.loads(row[0] or '{}');old=merge(old)
        conn.execute('UPDATE model_sources SET source_data=? WHERE model_id=? AND source=? AND model_key=?',(json.dumps(old),card,source,snap['model_key']))
    row=conn.execute('SELECT source,files,card_data,image FROM models WHERE id=?',(card,)).fetchone()
    if row and row['source']==source:
        old=merge(dict(row));conn.execute('UPDATE models SET files=?,card_data=? WHERE id=?',(json.dumps(old['files']),json.dumps(old['card_data']),card))
        if not row['image'] and snap['image']:conn.execute('UPDATE models SET image=?,has_media=1 WHERE id=?',(snap['image'],card))
    for media in snap['media']:
        exists=conn.execute('SELECT 1 FROM model_media WHERE model_id=? AND source=? AND url=?',(card,source,media['url'])).fetchone()
        if not exists:conn.execute('INSERT INTO model_media(model_id,source,type,url,thumbnail,filename,path,metadata,position) VALUES(?,?,?,?,?,?,?,?,?)',(card,source,media['type'],media['url'],media.get('thumbnail',''),media['filename'],media['path'],json.dumps(media.get('metadata',{})),media.get('position',0)))

def apply(token):
    with _LOCK:
        entry=_PLANS.get(token)
        if not entry or time.time()-entry['created']>900:raise ValueError('Import preview expired; review again.')
        results=[]
        for row in entry['rows']:
            if row['saved']:
                results.append({'path':row['path'],'success':True,'already_saved':True,'model_id':row['card_id']});continue
            moved=[];made_folder=False;conn=None
            try:
                for transfer in row['transfers']:
                    if local_inventory.identity(transfer['from'])!=transfer['identity']:raise ValueError('File or companion changed since review; preview again.')
                    if transfer['to']!=transfer['from'] and Path(transfer['to']).exists():raise ValueError('Destination now exists; nothing was overwritten.')
                conn=database.connect()
                if conn.execute('SELECT 1 FROM installed_files WHERE local_path IN (?,?)',(row['path'],row['target'])).fetchone():raise ValueError('File is already recorded as installed; refresh the scan.')
                card=existing_card(conn,row['match']);conn.close();conn=None
                if card is None:card=database.add_model(row['snapshot'])['model_id']
                folder=Path(row['target']).parent
                for parent in (folder,*folder.parents):
                    if parent.is_symlink() or getattr(parent,'is_junction',lambda:False)():raise ValueError('Destination became a linked folder; preview again.')
                if not folder.exists():folder.mkdir();made_folder=True
                for transfer in row['transfers']:
                    if transfer['from']==transfer['to']:continue
                    # Same-volume link/unlink guarantees no overwrite and preserves metadata.
                    os.link(transfer['from'],transfer['to'])
                    try:Path(transfer['from']).unlink()
                    except OSError:Path(transfer['to']).unlink();raise
                    moved.append(transfer)
                conn=database.connect();now=datetime.now(timezone.utc).isoformat();m=row['match']
                # Prefer the source already attached to the card; never overwrite its snapshot.
                source_row=conn.execute("SELECT source FROM model_sources WHERE model_id=? AND model_key=? AND source IN ('civitai','civitaired') ORDER BY CASE source WHEN 'civitai' THEN 0 ELSE 1 END LIMIT 1",(card,str(m['model_id']))).fetchone()
                source=source_row[0] if source_row else row['snapshot']['source']
                with conn:
                    add_missing_metadata(conn,card,source,row['snapshot'])
                    conn.execute('INSERT INTO installed_files(model_id,source,model_key,source_file_id,file_fingerprint,local_path,filename,version_id,version_name,installed_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(card,source,str(m['model_id']),str(m['file_id']),m['sha256'],row['target'],Path(row['target']).name,str(m['version_id']),m['version'],row['completed_at']))
                    installed=conn.execute('SELECT * FROM installed_files WHERE local_path=?',(row['target'],)).fetchone()
                    installed=dict(installed);installed['installed_at']=row['completed_at']
                    review=download_reviews.record(conn,installed,'unsorted')
                    conn.execute("UPDATE download_reviews SET imported_at=?,completed_at=?,import_date_source=?,location_updated_at=?,verified_sha256=?,verified_size=? WHERE id=?",(now,row['completed_at'],row['date_origin'],now,m['sha256'],Path(row['target']).stat().st_size,review))
                conn.close();conn=None;row['saved']=True;row['card_id']=card
                try:warnings=save_companions(row) if row['companions'] else []
                except Exception as exc:warnings=['Installed record saved; companion creation failed: '+str(exc)]
                results.append({'path':row['path'],'target':row['target'],'success':True,'model_id':card,'warnings':warnings})
            except Exception as exc:
                rollback=[]
                for transfer in reversed(moved):
                    try:
                        os.link(transfer['to'],transfer['from']);Path(transfer['to']).unlink()
                    except OSError as error:rollback.append(f"File remains at {transfer['to']}: {error}")
                if made_folder:
                    try:Path(row['target']).parent.rmdir()
                    except OSError:pass
                results.append({'path':row['path'],'success':False,'error':str(exc),'recovery':rollback})
            finally:
                if conn:conn.close()
        return results
