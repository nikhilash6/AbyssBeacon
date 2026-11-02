"""Constrained preview selection and decoding for local model imports."""
import io
import json
from pathlib import Path
from urllib.parse import urlsplit
import urllib.request

HOSTS={'image.civitai.com','image.civitai.red','c.genur.art'}
PREFIX='/static/cache/previews/'
CACHE=Path(__file__).resolve().parent/'static'/'cache'/'previews'
LIMIT=20*1024*1024

def allowed_url(value):
    try:
        u=urlsplit(value)
        return u.scheme=='https' and u.hostname in HOSTS and u.port in (None,443) and not u.username and not u.password
    except (ValueError,TypeError):return False

def cached_path(value):
    if not isinstance(value,str) or not value.startswith(PREFIX):return None
    name=value[len(PREFIX):]
    if not name or '/' in name or '\\' in name or name in {'.','..'}:return None
    path=CACHE/name
    from local_inventory import identity
    try:
        identity(path)
        return path if 0<path.stat().st_size<=LIMIT else None
    except (OSError,ValueError):return None

def candidates(conn,card_id,match,snapshot,include_mature):
    from scanners.civitai import _civitai_media_is_mature
    result=[]
    def add(url,label):
        if (allowed_url(url) or cached_path(url)) and not any(c['url']==url for c in result):result.append({'url':url,'label':label})
    for item in snapshot['media']:
        if item.get('type')=='image':add(item.get('url'),'Matched-version image from CivArchive')
    if card_id:
        for row in conn.execute("SELECT url,metadata FROM model_media WHERE model_id=? AND source IN ('civitai','civitaired') AND type='image' ORDER BY position,id",(card_id,)):
            try:meta=json.loads(row['metadata'] or '{}')
            except (TypeError,ValueError):continue
            if not isinstance(meta,dict):continue
            version=meta.get('civitai_model_version_id') or meta.get('civitaired_model_version_id') or meta.get('model_version_id')
            if str(version)!=str(match['version_id']):continue
            if not include_mature and (meta.get('mature') is True or _civitai_media_is_mature(meta)):continue
            add(row['url'],'Saved image for this exact version')
        row=conn.execute('SELECT image,card_data,sensitive FROM models WHERE id=?',(card_id,)).fetchone()
        if row:
            try:data=json.loads(row['card_data'] or '{}')
            except (TypeError,ValueError):data={}
            # A card thumbnail is only safe to reuse if its version is explicit.
            if isinstance(data,dict) and str(data.get('version_id'))==str(match['version_id']) and (include_mature or (not row['sensitive'] and data.get('mature_media_count')==0 and data.get('include_mature_media') is False)):
                add(row['image'],'Saved card preview for this exact version')
    if result:return result[:4],result[0]['label']
    images=(match.get('archive_version') or {}).get('images') or []
    if not images:return [],'Preview unavailable: the archive returned no images for this version, and no eligible saved version image was found.'
    if not include_mature and any(isinstance(i,dict) and _civitai_media_is_mature(i) for i in images):
        return [],'Preview unavailable: no supported still image remains after the current mature-media filter.'
    return [],'Preview unavailable: this version has no supported still-image URL or eligible saved version image.'

def read_image(url):
    local=cached_path(url)
    if local:raw=local.read_bytes()
    else:
        if not allowed_url(url):raise ValueError('Unsupported preview image host.')
        class SafeRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,req,fp,code,msg,headers,newurl):
                if not allowed_url(newurl):raise ValueError('Preview redirected to an unsupported host.')
                return super().redirect_request(req,fp,code,msg,headers,newurl)
        request=urllib.request.Request(url,headers={'User-Agent':'AbyssBeacon/1.5.1','Accept':'image/*'})
        with urllib.request.build_opener(SafeRedirect).open(request,timeout=20) as response:raw=response.read(LIMIT+1)
    if len(raw)>LIMIT:raise ValueError('Preview exceeds 20 MB.')
    from PIL import Image,ImageOps
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('error',Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(raw)) as image:
            image=ImageOps.exif_transpose(image)
            image.thumbnail((2048,2048));out=io.BytesIO();image.convert('RGB').save(out,format='JPEG',quality=90)
    return out.getvalue()
