"""Durable personal decisions per installed artifact, independent of favorites."""
import hashlib
import json

STATES=('not_tried','keep','unsorted')

def key(row):
    fields=('source','model_key','source_file_id','version_id','file_fingerprint','local_path')
    return hashlib.sha256(json.dumps([str(row.get(f) or '') for f in fields],ensure_ascii=False).encode()).hexdigest()

def record(conn,row,state='not_tried'):
    row=dict(row)
    model=conn.execute('SELECT display_name,name FROM models WHERE id=?',(row.get('model_id'),)).fetchone()
    name=(model['display_name'] or model['name']) if model else row.get('filename','')
    identity=key(row)
    conn.execute('''INSERT INTO download_reviews(identity_key,model_name,source,model_key,source_file_id,
        version_id,version_name,file_fingerprint,filename,local_path,completed_at,review_state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(identity_key) DO UPDATE SET
        deletion_group='',completed_at=excluded.completed_at,filename=excluded.filename,version_name=excluded.version_name,deleted_at='',uninstalled_at='',verified_sha256='',verified_size=NULL
        ''',
        (identity,name,row.get('source',''),row.get('model_key',''),row.get('source_file_id',''),row.get('version_id',''),row.get('version_name',''),row.get('file_fingerprint',''),row.get('filename',''),row.get('local_path',''),row.get('installed_at',''),state))
    ident=conn.execute('SELECT id FROM download_reviews WHERE identity_key=?',(identity,)).fetchone()[0]
    conn.execute('UPDATE installed_files SET review_id=? WHERE id=?',(ident,row['id']))
    return ident

def ensure_schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS download_reviews(
      id INTEGER PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, model_name TEXT,
      source TEXT,model_key TEXT,source_file_id TEXT,version_id TEXT,version_name TEXT,
      file_fingerprint TEXT,filename TEXT,local_path TEXT,completed_at TEXT,
      review_state TEXT NOT NULL DEFAULT 'unsorted' CHECK(review_state IN ('not_tried','keep','unsorted')),
      personal_tags TEXT NOT NULL DEFAULT '[]')''')
    if 'deleted_at' not in {r['name'] for r in conn.execute('PRAGMA table_info(download_reviews)')}:
        conn.execute("ALTER TABLE download_reviews ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''")
    if 'hearted' not in {r['name'] for r in conn.execute('PRAGMA table_info(download_reviews)')}:
        conn.execute('ALTER TABLE download_reviews ADD COLUMN hearted INTEGER NOT NULL DEFAULT 0')
    columns={r['name'] for r in conn.execute('PRAGMA table_info(download_reviews)')}
    for name,definition in [('deletion_group',"TEXT NOT NULL DEFAULT ''"),('review_edited','INTEGER NOT NULL DEFAULT 0'),('uninstalled_at',"TEXT NOT NULL DEFAULT ''"),('location_updated_at',"TEXT NOT NULL DEFAULT ''"),('verified_sha256',"TEXT NOT NULL DEFAULT ''"),('verified_size','INTEGER'),('imported_at',"TEXT NOT NULL DEFAULT ''"),('import_date_source',"TEXT NOT NULL DEFAULT ''"),('install_category',"TEXT NOT NULL DEFAULT ''")]:
        if name not in columns:conn.execute(f'ALTER TABLE download_reviews ADD COLUMN {name} {definition}')
    if 'review_id' not in {r['name'] for r in conn.execute('PRAGMA table_info(installed_files)')}:
        conn.execute('ALTER TABLE installed_files ADD COLUMN review_id INTEGER')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_download_reviews_date ON download_reviews(completed_at DESC,id DESC)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_installed_files_review_id ON installed_files(review_id)')
    for row in conn.execute('SELECT * FROM installed_files WHERE review_id IS NULL').fetchall():
        record(conn,row,'unsorted')

def listing(conn,state='',query='',offset=0,limit=100):
    where=[];params=[]
    if state:
        if state not in STATES:raise ValueError('Invalid review state')
        where.append('r.review_state=?');params.append(state)
    if query:
        where.append("(instr(lower(COALESCE(r.model_name,'')||' '||COALESCE(r.filename,'')||' '||r.personal_tags),lower(?))>0)");params.append(query)
    clause=' WHERE '+' AND '.join(where) if where else ''
    total=conn.execute('SELECT COUNT(*) FROM download_reviews r'+clause,params).fetchone()[0]
    rows=conn.execute('''SELECT r.*,EXISTS(SELECT 1 FROM installed_files i WHERE i.review_id=r.id) AS tracked
       FROM download_reviews r'''+clause+' ORDER BY julianday(r.completed_at) DESC,r.id DESC LIMIT ? OFFSET ?',params+[limit,offset]).fetchall()
    items=[]
    for row in rows:
        item=dict(row);item['personal_tags']=json.loads(item['personal_tags']);items.append(item)
    return {'items':items,'total':total,'has_more':offset+len(items)<total}

def update(conn,ident,state,tags):
    if state is None and tags is None:
        raise ValueError('Choose a review state or supply personal tags')
    if state is not None and state not in STATES:
        raise ValueError('Choose Not tried, Keep or Unsorted')
    encoded_tags = None
    if tags is not None:
        if not isinstance(tags, list) or len(tags) > 30:
            raise ValueError('Use up to 30 personal tags')
        clean = []
        seen = set()
        for tag in tags:
            if not isinstance(tag, str) or not 1 <= len(tag.strip()) <= 60:
                raise ValueError('Tags must contain 1–60 characters')
            tag = tag.strip()
            if tag.casefold() not in seen:
                clean.append(tag)
                seen.add(tag.casefold())
        encoded_tags = json.dumps(clean, ensure_ascii=False)
    return conn.execute(
        'UPDATE download_reviews SET review_edited=1, review_state=COALESCE(?,review_state), '
        'personal_tags=COALESCE(?,personal_tags) WHERE id=?',
        (state, encoded_tags, ident),
    ).rowcount == 1



def search_clause():
    return """(instr(lower(COALESCE(r.model_name,'')||' '||COALESCE(r.filename,'')||' '||r.personal_tags),lower(?))>0 OR r.id IN (
        SELECT dr.id FROM models m JOIN model_sources ms ON ms.model_id=m.id
        JOIN download_reviews dr ON dr.source=ms.source AND dr.model_key=ms.model_key
        WHERE instr(lower(coalesce(m.author,'')||' '||coalesce(m.tags,'')||' '||coalesce(m.display_tags,'')),lower(?))>0 OR EXISTS (
            SELECT 1 FROM model_sources alt WHERE alt.model_id=m.id AND instr(lower(
                CASE WHEN json_valid(source_data) THEN coalesce(json_extract(source_data,'$.author'),'')||' '||coalesce(json_extract(source_data,'$.tags'),'')||' '||coalesce(json_extract(source_data,'$.display_tags'),'') END
            ),lower(?))>0)))"""

def grouped_page(conn,state='',query='',page=1,per_page=24,card_ids=None,hearted=False,sort='newest',review_ids=None,include_history=True,history_only=False,source=''):
    """Page model groups, never split one model's matching files across pages."""
    if state and state not in STATES:raise ValueError('Invalid review state')
    if sort not in {'newest','oldest'}:raise ValueError('Invalid download order')
    direction='ASC' if sort=='oldest' else 'DESC'
    aggregate='MIN' if sort=='oldest' else 'MAX'
    where=[];params=[]
    if source:
        where.append('lower(r.source)=lower(?)');params.append(source)
    if history_only:
        where.append('NOT EXISTS(SELECT 1 FROM installed_files i WHERE i.review_id=r.id)')
    elif not include_history:
        where.append('EXISTS(SELECT 1 FROM installed_files i WHERE i.review_id=r.id)')
    if state:where.append('r.review_state=?');params.append(state)
    if query:
        where.append(search_clause());params.extend([query]*3)
    if review_ids is not None:
        where.append('r.id IN (SELECT value FROM json_each(?))');params.append(json.dumps(review_ids))
    if hearted:where.append('r.hearted=1')
    if card_ids is not None:
        where.append('ms.model_id IN (SELECT value FROM json_each(?))');params.append(json.dumps(card_ids))
    clause=' WHERE '+' AND '.join(where) if where else ''
    cte='''WITH resolved AS (SELECT r.*,ms.model_id AS card_id,
       CASE WHEN ms.model_id IS NULL THEN 'review:'||r.id ELSE 'model:'||ms.model_id END AS group_key
       FROM download_reviews r LEFT JOIN model_sources ms ON lower(ms.source)=lower(r.source) AND ms.model_key=r.model_key'''+clause+') '
    total=conn.execute(cte+'SELECT COUNT(DISTINCT group_key) FROM resolved',params).fetchone()[0]
    keys=[r[0] for r in conn.execute(cte+f'''SELECT group_key FROM resolved GROUP BY group_key
       ORDER BY {aggregate}(julianday(completed_at)) IS NULL ASC,{aggregate}(julianday(completed_at)) {direction},{aggregate}(id) {direction} LIMIT ? OFFSET ?''',params+[per_page,(page-1)*per_page])]
    if not keys:return {'groups':[],'total':total,'page':page,'pages':max(1,(total+per_page-1)//per_page)}
    rows=conn.execute(cte+f'''SELECT resolved.*,EXISTS(SELECT 1 FROM installed_files i WHERE i.review_id=resolved.id) AS tracked,
       (SELECT i.model_id FROM installed_files i WHERE i.review_id=resolved.id LIMIT 1) AS installed_model_id
       FROM resolved WHERE group_key IN (SELECT value FROM json_each(?))
       ORDER BY julianday(completed_at) IS NULL ASC,julianday(completed_at) {direction},id {direction}''',params+[json.dumps(keys)]).fetchall()
    groups={key:{'key':key,'files':[],'model':None} for key in keys}
    for row in rows:
        item=dict(row);item['personal_tags']=json.loads(item['personal_tags']);groups[item['group_key']]['files'].append(item)
    return {'groups':list(groups.values()),'total':total,'page':page,'pages':max(1,(total+per_page-1)//per_page)}

def clean_deleted_group(conn, group):
    if not group:
        return
    protected = conn.execute('''SELECT 1 FROM download_reviews r WHERE deletion_group=? AND
        (deleted_at='' OR review_edited OR review_state='keep' OR personal_tags!='[]' OR hearted
         OR EXISTS(SELECT 1 FROM installed_files i WHERE i.review_id=r.id)
         OR EXISTS(SELECT 1 FROM model_sources m WHERE lower(m.source)=lower(r.source) AND m.model_key=r.model_key))
        LIMIT 1''', (group,)).fetchone()
    if not protected:
        conn.execute('DELETE FROM download_reviews WHERE deletion_group=?', (group,))
