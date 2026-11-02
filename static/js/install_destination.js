/* Shared preflight for local downloads and Download Manager retries. */
window.abyssChooseInstallDestination=async function(url,choice={},provided=null){
    const parts=url.pathname.split('/');
    if(parts[1]!=='download'&&!provided)return true;
    const source=parts[2]==='source'?parts[4]:'canonical',id=parts[3],index=parts.at(-1);
    let data=provided;
    if(!data){const response=await fetch(`/api/install-options/${id}/${source}/${index}`);data=await response.json();if(!response.ok||!data.success)throw new Error(data.error||'Unable to check destination');}
    const category=choice.installCategory||url.searchParams.get('install_category')||data.category;
    const folder=choice.installFolder??url.searchParams.get('install_folder')??data.folder;
    if(category!=='AbyssBeacon-Other'||folder||data.confirmed_other||url.searchParams.get('allow_other')==='1')return true;
    const d=document.createElement('dialog');d.className='abyss-destination-dialog';
    const make=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
    const title=make('h2','Choose a download location');d.append(title,make('p','AbyssBeacon couldn’t determine this file’s model type. Choose a type or destination folder, or continue to save it in Other.'));
    d.setAttribute('aria-label','Choose a download location');
    const type=document.createElement('select'),path=document.createElement('input'),remember=document.createElement('input');
    for(const [value,label] of Object.entries(data.types)){const o=make('option',label);o.value=value;type.append(o);}type.value=category;
    path.type='text';path.value=folder||'';remember.type='checkbox';
    const label=(text,input)=>{const l=make('label',text);l.append(input);d.append(l);};
    label('Install as',type);label('Destination folder (blank uses suggested layout)',path);
    const browse=make('button','Change folder…');browse.type='button';d.append(browse);
    label(' Remember for this model and file type',remember);
    const hint=make('p',''),error=make('p','');error.setAttribute('role','alert');d.append(hint,error);
    const actions=make('div','');actions.className='abyss-destination-actions';
    const cancel=make('button','Cancel'),other=make('button','Save in “Other” folder'),save=make('button','Download to selected folder');
    for(const b of [cancel,other,save])b.type='button';actions.append(cancel,other,save);d.append(actions);
    const update=()=>{hint.textContent='Destination: '+(path.value.trim()||data.paths[type.value]||'');path.placeholder=data.paths[type.value]||'';save.disabled=type.value==='AbyssBeacon-Other'&&!path.value.trim();};
    type.onchange=()=>{path.value='';update();};path.oninput=update;update();
    browse.onclick=async()=>{try{const r=await fetch('/api/installed-recovery/picker',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'folder'})});const v=await r.json();if(!r.ok||!v.success)throw new Error(v.error||'Unable to choose folder');if(v.path){path.value=v.path;update();}}catch(e){error.textContent=e.message;}};
    return new Promise(resolve=>{
        const previous=document.activeElement;let accepted=false;
        const commit=toOther=>{url.searchParams.set('install_category',toOther?'AbyssBeacon-Other':type.value);url.searchParams.set('install_folder',toOther?'':path.value.trim());url.searchParams.set('remember_install',remember.checked?'1':'0');url.searchParams.set('allow_other',toOther?'1':'0');accepted=true;d.close();};
        cancel.onclick=()=>d.close();other.onclick=()=>commit(true);save.onclick=()=>commit(false);
        let down=false;const outside=e=>{const r=d.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;};
        d.onpointerdown=e=>{down=e.target===d&&outside(e);};d.onclick=e=>{if(down&&e.target===d&&outside(e))d.close();down=false;};
        d.addEventListener('close',()=>{d.remove();previous?.focus();resolve(accepted);},{once:true});document.body.append(d);d.showModal();cancel.focus();
    });
};
