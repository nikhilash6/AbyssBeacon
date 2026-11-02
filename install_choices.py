"""Local install classification; never mutates source metadata."""
import json
import installer

TYPES={'checkpoints':'Checkpoint','diffusion_models':'Diffusion model','loras':'LoRA','vae':'VAE','text_encoders':'Text encoder','controlnet':'ControlNet','embeddings':'Embedding','upscale_models':'Upscaler','workflows':'Workflow',installer.UNKNOWN_CATEGORY:'Unknown type'}

def category(conn, row, sources=None, model_types=None):
    saved=row.get('install_category')
    if saved in TYPES:return saved
    found=(sources.get((str(row['source']).lower(),str(row['model_key']))) if sources is not None else conn.execute('SELECT source_data FROM model_sources WHERE lower(source)=lower(?) AND model_key=?',(row['source'],row['model_key'])).fetchone())
    try:model=dict(found[0]) if found and isinstance(found[0],dict) else json.loads(found[0]) if found else {}
    except (ValueError,TypeError):model={}
    if not isinstance(model,dict):model={}
    files=model.get('files') or []
    if isinstance(files,str):
        try:files=json.loads(files)
        except ValueError:files=[]
    card=model.get('card_data') or {}
    if isinstance(card,str):
        try:card=json.loads(card)
        except ValueError:card={}
    for version in (card.get('versions') or []) if isinstance(card,dict) else []:
        if isinstance(version,dict) and str(version.get('id') or version.get('version_id') or '')==str(row.get('version_id') or ''):
            files=list(files)+[f for f in version.get('files',[]) if isinstance(f,dict)]
    exact=[f for f in files if isinstance(f,dict) and row.get('source_file_id') and str(f.get('model_file_id') or f.get('id') or f.get('file_id') or '')==str(row['source_file_id'])]
    if exact:
        unique={json.dumps(f,sort_keys=True):f for f in exact};exact=list(unique.values())
    if not model.get('model_type'):
        model_id=row.get('installed_model_id') or row.get('card_id')
        modelrow=model_types.get(model_id) if model_types is not None else conn.execute('SELECT model_type FROM models WHERE id=?',(model_id,)).fetchone()
        if modelrow:model['model_type']=modelrow[0]
    if exact:
        categories={installer.comfy_category_for_model(model,row.get('filename',''),f) for f in exact}
        return next(iter(categories)) if len(categories)==1 and next(iter(categories)) in TYPES else installer.UNKNOWN_CATEGORY
    result=installer.comfy_category_for_model(model,row.get('filename',''),{})
    return result if result in TYPES else installer.UNKNOWN_CATEGORY


def categories(conn, rows):
    """Batch metadata reads; never issue a source query per download record."""
    rows=[dict(r) for r in rows]
    unresolved=[r for r in rows if r.get('install_category') not in TYPES]
    sources={};model_types={}
    if unresolved:
        keys=list({str(r['model_key']) for r in unresolved})
        for r in conn.execute('SELECT source,model_key,source_data FROM model_sources WHERE model_key IN (SELECT value FROM json_each(?))',(json.dumps(keys),)):
            try:decoded=json.loads(r[2])
            except (ValueError,TypeError):decoded={}
            sources.setdefault((str(r[0]).lower(),str(r[1])),(decoded if isinstance(decoded,dict) else {},))
        ids=list({r.get('installed_model_id') or r.get('card_id') for r in unresolved})
        model_types={r[0]:(r[1],) for r in conn.execute('SELECT id,model_type FROM models WHERE id IN (SELECT value FROM json_each(?))',(json.dumps(ids),))}
    return {r['id']:category(conn,r,sources,model_types) for r in rows}
