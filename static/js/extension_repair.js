document.addEventListener('DOMContentLoaded',()=>{
    const get=id=>document.getElementById('extensionRepair'+id),dialog=get('Dialog');if(!dialog)return;
    let jobId='',items=[],pollTimer;
    const element=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
    async function request(url,options={}){const r=await fetch(url,{cache:'no-store',...options});const v=await r.json();if(!r.ok||!v.success)throw new Error(v.error||'Request failed');return v;}
    const post=(url,data)=>request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    get('Open').onclick=()=>{dialog.showModal();if(jobId&&get('Start').disabled)poll();get('Roots').focus();};
    get('Close').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{clearTimeout(pollTimer);openingModel=false;});
    dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();});
    const modelDialog=get('ModelDialog'),modelOverlay=document.getElementById('modelOverlay'),imageOverlay=document.getElementById('imageOverlay');
    let openingModel=false,modelFocus=null,modelScroll=0;
    if(modelDialog&&modelOverlay){
        const observer=new MutationObserver(()=>{
            if(openingModel&&modelOverlay.classList.contains('open')){
                openingModel=false;modelDialog.append(modelOverlay);if(imageOverlay)modelDialog.append(imageOverlay);modelDialog.showModal();
            }else if(modelDialog.open&&!modelOverlay.classList.contains('open')){
                modelDialog.close();document.body.append(modelOverlay);if(imageOverlay)document.body.append(imageOverlay);dialog.scrollTop=modelScroll;modelFocus?.focus({preventScroll:true});
            }
        });
        observer.observe(modelOverlay,{attributes:true,attributeFilter:['class']});
        modelDialog.addEventListener('cancel',event=>{event.preventDefault();if(imageOverlay?.classList.contains('open'))document.getElementById('closeImage')?.click();else window.modelRadarCloseModelOverlay?.();});
    }
    get('Browse').onclick=async()=>{try{const r=await post('/api/installed-recovery/picker',{kind:'folder'});if(r.path)get('Roots').value=[...new Set([...get('Roots').value.split(/\r?\n/).filter(Boolean),r.path])].join('\n');}catch(e){get('Status').textContent=e.message;}};
    get('Start').onclick=async()=>{
        const folders=get('Roots').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
        delete dialog.dataset.finishShown;get('Review').hidden=true;get('Finish').hidden=true;get('Start').disabled=true;get('Apply').hidden=true;get('SelectVerified').hidden=true;get('Results').replaceChildren();get('Status').textContent='Scanning filenames…';window.abyssRepairStep?.(dialog,1);
        try{const r=await post('/api/extension-repair',{folders});jobId=r.job_id;await poll();}catch(e){get('Status').textContent=e.message;get('Start').disabled=false;}
    };
    async function poll(){
        try{const r=await request('/api/extension-repair/'+jobId);if(r.status==='running'){if(dialog.open)pollTimer=setTimeout(poll,1000);return;}
            get('Start').disabled=false;if(r.status!=='complete')throw new Error(r.errors.join('; ')||'Scan failed');
            items=r.items;get('Review').hidden=false;render();window.abyssRepairStep?.(dialog,2);get('Status').textContent=`${items.length} file(s) need review. ${r.errors.length?r.errors.length+' folder or file error(s): '+r.errors.join('; '):'No files have been changed.'}`;
        }catch(e){get('Status').textContent=e.message;get('Start').disabled=false;}
    }
    function render(){
        const rows=[];items.forEach((item,index)=>{
            const section=element('section','');section.className='installed-recovery-row';
            const label=element('label',''),check=element('input','');label.className='extension-repair-select';check.type='checkbox';check.dataset.index=index;check.disabled=!!item.done;
            label.append(check,document.createTextNode(' '+item.model_name));section.append(label);
            section.append(element('p',item.path.split(/[\\/]/).pop()+' · '+Number(item.identity[2]).toLocaleString()+' bytes'),window.abyssRepairPath(item.path,'/api/repair-path/extension/'+jobId+'/open-folder'));
            const format=element('label',item.extension?'Detected format: ':'Format not confirmed — enter an extension to choose this file: ');
            const input=element('input','');input.type='text';input.value=item.extension;input.placeholder='.safetensors';input.dataset.extension=index;input.disabled=!!item.extension||!!item.done;format.append(input);section.append(format);
            section.append(element('p',item.review_id?'Saved download: tracking will be updated.':item.suggested?'Possible model based on filename only; identity is not verified. Tracking will not change. Use Locate file on its card to reconnect it after repairing.':'Not linked to a saved download at this location; tracking will not change. Use Locate file to reconnect a moved download after repairing.'));
            const actions=element('div','');actions.className='extension-repair-links';
            try{const url=new URL(item.source_url);if(['http:','https:'].includes(url.protocol)){const a=element('a','Open source model');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';actions.append(a);}}catch(_){}
            if(item.model_id){const button=element('button','Open model card');button.type='button';button.onclick=()=>{openingModel=true;modelFocus=button;modelScroll=dialog.scrollTop;if(!window.modelRadarOpenModel?.(item.model_id,{downloads:true}))openingModel=false;};actions.append(button);}section.append(actions);
            if(item.done)section.append(element('p','Repaired.'));
            rows.push(section);
        });
        if(!rows.length){const empty=element('p','No filenames need repair in the selected folders.');const again=element('button','Search another folder');again.type='button';again.onclick=()=>{get('Roots').focus();get('Roots').select();};rows.push(empty,again);}get('Results').replaceChildren(...rows);get('Apply').hidden=!items.some(x=>!x.done);get('SelectVerified').hidden=!items.some(x=>!x.done&&x.extension);updateSelection();
    }
    get('SelectVerified').onclick=()=>{get('Results').querySelectorAll('input[type=checkbox]').forEach(c=>{if(!c.disabled&&items[Number(c.dataset.index)]?.extension)c.checked=true;});updateSelection();};
    function updateSelection(){const count=get('Results').querySelectorAll('input[type=checkbox]:checked:not(:disabled)').length;if(count)dialog.dataset.finishShown='1';get('Finish').hidden=dialog.dataset.finishShown!=='1';get('Apply').disabled=!count;get('SelectionHint').hidden=!!count;window.abyssRepairStep?.(dialog,count?3:get('Review').hidden?1:2);}
    get('Results').addEventListener('change',updateSelection);
    function confirmChanges(lines){window.abyssRepairStep?.(dialog,3);
        const confirm=get('Confirm');get('ConfirmText').textContent=`Rename ${lines.length} selected file(s)? Tracked paths will be updated.`;
        get('ConfirmList').replaceChildren(...lines.map(line=>element('li',line)));
        return new Promise(resolve=>{let accepted=false;get('ConfirmCancel').onclick=()=>confirm.close();get('ConfirmAccept').onclick=()=>{accepted=true;confirm.close();};confirm.addEventListener('close',()=>resolve(accepted),{once:true});confirm.showModal();get('ConfirmCancel').focus();});
    }
    get('Apply').onclick=async()=>{
        const checks=[...get('Results').querySelectorAll('input[type=checkbox]:checked')];
        if(!checks.length){get('Status').textContent='Select at least one file.';return;}
        const choices=checks.map(c=>({index:Number(c.dataset.index),extension:get('Results').querySelector(`[data-extension="${c.dataset.index}"]`).value.trim().toLowerCase()}));
        if(choices.some(c=>!/^\.[a-z0-9]{1,16}$/.test(c.extension))){get('Status').textContent='Enter a valid extension beginning with a dot, such as .safetensors.';return;}
        const lines=choices.map(c=>`${items[c.index].path}\n→ ${items[c.index].path+c.extension}\n${Number(items[c.index].identity[2]).toLocaleString()} bytes`);
        if(!await confirmChanges(lines))return;
        get('Apply').disabled=true;let done=0,errors=[];
        try{for(let i=0;i<choices.length;i+=100){const r=await post(`/api/extension-repair/${jobId}/apply`,{choices:choices.slice(i,i+100)});for(const result of r.results){if(result.success){items[result.index].done=true;done++;}else errors.push(items[result.index].path+': '+result.error);}}render();get('Status').textContent=`${done} renamed. ${errors.length?errors.join(' · '):'Refresh the downloaded library to see updated paths.'}`;}catch(e){get('Status').textContent=`${done} renamed. ${e.message}`;}finally{updateSelection();}
    };
});
