window.abyssLinkLocalModel=async function(job,file){
 const d=document.createElement('dialog');d.className='abyss-destination-dialog';d.setAttribute('aria-label','Link local model');
 const n=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
 const request=async(url,payload)=>{const r=await fetch(url,payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const v=await r.json();if(!r.ok||!v.success)throw new Error(v.error||'Unable to link model');return v;};
 d.append(n('h2','Link local model'),n('p',file.filename));
 const mode=document.createElement('select');for(const [v,t] of [['url','Link via model URL'],['existing','Link to an existing library model'],['manual','Add manually']]){const o=n('option',t);o.value=v;mode.append(o);}d.append(mode);
 const fields=n('div',''),review=n('div',''),status=n('p','');status.setAttribute('role','status');d.append(fields,review,status);
 const cancel=n('button','Cancel'),prepare=n('button','Review link'),save=n('button','Confirm link');save.hidden=true;const actions=n('div','');actions.className='abyss-destination-actions';actions.append(cancel,prepare,save);d.append(actions);
 let inputs={},token='',fileIndex=null,busy=false,done=false;
 const resetReview=()=>{token='';review.replaceChildren();save.hidden=true;};
 const field=(key,text,type='input')=>{const l=n('label',text),e=document.createElement(type);if(type==='input')e.type='text';l.append(e);fields.append(l);inputs[key]=e;e.addEventListener('input',resetReview);return e;};
 const show=()=>{fields.replaceChildren();inputs={};resetReview();status.textContent='';
  if(mode.value==='url')field('url','Supported model page URL');
  if(mode.value==='existing'){
   const q=field('query','Search model names'),search=n('button','Search'),choices=field('card_id','Choose a model','select');const browse=n('button','Find in library');fields.append(search,browse);
   browse.onclick=()=>{
    const picker=n('dialog','');picker.className='abyss-destination-dialog';picker.setAttribute('aria-label','Find in library');
    const term=n('input','');term.type='search';term.value=q.value;term.placeholder='Search model names';term.setAttribute('aria-label','Search model names');
    const results=n('div',''),close=n('button','Cancel');let generation=0;
    async function refresh(){
     const current=++generation;results.replaceChildren();
     if(!term.value.trim()){results.textContent='Enter a model name.';return;}
     try{
      const data=await request('/api/local-model-link/search?q='+encodeURIComponent(term.value));
      if(current!==generation)return;
      for(const m of data.models){
       const pick=n('button','');pick.className='library-picker-result';
       if(m.image){const img=n('img','');img.src=m.image;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';pick.append(img);}
       pick.append(n('strong',m.name),n('small',[m.author,m.architecture,m.source,m.model_key].filter(Boolean).join(' · ')));
       pick.onclick=()=>{q.value=term.value;choices.replaceChildren(new Option(m.name+' · '+m.source+' · '+m.model_key,m.id));resetReview();picker.close();};results.append(pick);
      }
      if(!data.models.length)results.textContent='No matching cards found.';
     }catch(error){if(current===generation)results.textContent=error.message;}
    }
    term.oninput=refresh;close.onclick=()=>picker.close();picker.onclose=()=>picker.remove();
    picker.append(n('h2','Find in library'),term,results,close);d.append(picker);picker.showModal();refresh();
   };
   search.onclick=async()=>{search.disabled=true;try{const r=await request('/api/local-model-link/search?q='+encodeURIComponent(q.value));choices.replaceChildren();for(const m of r.models){const o=n('option',`${m.name} · ${m.source} · ${m.model_key}`);o.value=m.id;choices.append(o);}status.textContent=r.models.length?'Select a model, then review the link.':'No matching cards found.';}catch(e){status.textContent=e.message;}finally{search.disabled=false;}};
  }
  if(mode.value==='manual'){
   field('name','Model name').value=file.filename.replace(/\.[^.]+$/,'');const arch=field('architecture','Architecture');arch.value='Other';
   const suggestions=n('datalist','');suggestions.id='manualArchitectureChoices';
   for(const option of document.querySelectorAll('.downloaded-filters select[name=architecture] option')){
    if(option.value)suggestions.append(new Option(option.textContent,option.value));
   }
   arch.setAttribute('list',suggestions.id);fields.append(suggestions);
   const type=field('category','Model type','select');for(const [v,t] of Object.entries({loras:'LoRA',checkpoints:'Checkpoint',diffusion_models:'Diffusion model',vae:'VAE',text_encoders:'Text encoder',controlnet:'ControlNet',embeddings:'Embedding',upscale_models:'Upscaler',workflows:'Workflow','AbyssBeacon-Other':'Unknown type'})){const o=n('option',t);o.value=v;type.append(o);}type.value='AbyssBeacon-Other';field('url','Reference URL (optional; saved without fetching)');
  }
 };
 mode.onchange=show;show();
 prepare.onclick=async()=>{if(busy)return;busy=true;prepare.disabled=true;mode.disabled=true;status.textContent='Loading model details…';resetReview();
  try{const payload={path:file.path,mode:mode.value};for(const [k,e] of Object.entries(inputs))payload[k]=e.value;
   const r=await request('/api/local-inventory/'+encodeURIComponent(job)+'/link-preview',payload);token=r.token;
   review.append(n('h3','Review link'),n('p',r.name),n('p','Local file: '+r.path));
   const choose=document.createElement('select');const placeholder=n('option','Choose a file/version or model-page-only link');placeholder.value='';choose.append(placeholder);
   for(const f of r.files){const o=n('option',`${f.filename} · ${f.version||'Version not recorded'} · File ${f.file_id||'ID unavailable'}`);o.value=f.index;choose.append(o);}
   const page=n('option','Link to model page only — file identity not verified');page.value='-1';choose.append(page);review.append(choose);
   fileIndex=null;save.disabled=true;save.hidden=false;choose.onchange=()=>{fileIndex=choose.value===''?null:Number(choose.value);save.disabled=fileIndex===null;};
   if(!r.files.length){choose.value='-1';choose.onchange();}
   review.append(n('p','A matching source SHA-256 will be verified when you confirm. Otherwise this is a manual link, not a verified file identity. The local filename and location stay unchanged.'));status.textContent='';
  }catch(e){status.textContent=e.message;}finally{busy=false;prepare.disabled=false;mode.disabled=false;}
 };
 save.onclick=async()=>{if(busy||!token||fileIndex===null)return;busy=true;save.disabled=true;prepare.disabled=true;mode.disabled=true;status.textContent='Verifying and saving link…';
  try{const r=await request('/api/local-model-link/apply',{token,file_index:fileIndex,confirm:true});done=true;d.close();}
  catch(e){status.textContent=e.message;}finally{busy=false;save.disabled=false;prepare.disabled=false;mode.disabled=false;}
 };
 cancel.onclick=()=>{if(!busy)d.close();};d.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 return new Promise(resolve=>{d.addEventListener('close',()=>{d.remove();resolve(done);},{once:true});document.body.append(d);d.showModal();});
};
