document.addEventListener('DOMContentLoaded',()=>{
    const get=id=>document.getElementById('localInventory'+id),dialog=get('Dialog');if(!dialog)return;
    const toolbar=dialog.querySelector('.inventory-match-toolbar');
    if(toolbar){toolbar.hidden=true;get('Review').append(toolbar);}
    let job='',timer,result=null,limit=50,running=false,showPaths=false,bulkSelected=false;
    let pendingDuplicateDelete=null, deletingDuplicate=false;
    const selected=new Set();let identifying=false,identifyJob='',identifyTimer,saving=false;const identified=new Map(),matchChoices=new Map();let previewToken='';let completion=null;
    const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
    const size=n=>{if(n<1024)return n+' bytes';const units=['KB','MB','GB','TB'];let v=n/1024,i=0;while(v>=1024&&i<units.length-1){v/=1024;i++;}return v.toLocaleString(undefined,{maximumFractionDigits:2})+' '+units[i];};
    function mode(importing){dialog.classList.toggle('import-mode',importing);showPaths=!importing;get('Paths').textContent=showPaths?'Hide full paths':'Show full paths';get('Paths').hidden=importing;
        get('StepTwo').textContent=importing?'2 · Select files and find matches':'2 · Review duplicate groups';
        get('SafeOnly').closest('label').hidden=!importing;get('Unlinked').closest('label').hidden=!importing;get('Filters').querySelector('details').hidden=!importing;
        document.getElementById('localImportOptions').hidden=true;delete dialog.dataset.importFinishShown;
        for(const id of ['Identify','IdentifyStop','IdentifyStatus','IdentifyResults'])get(id).hidden=!importing||(id==='IdentifyStop'&&!identifying);
        get('DuplicatesLabel').hidden=true;get('Duplicates').checked=!importing;get('Unlinked').checked=importing;
        dialog.querySelector('.inventory-matching-help').hidden=!importing;get('DuplicateHelp').hidden=true;get('DuplicateSummary').hidden=importing;updateSelection();}
    async function request(url,data){const response=await fetch(url,data===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();if(!response.ok||!value.success)throw new Error(value.error||'Request failed');return value;}
    function busy(value){running=value;if(value){delete dialog.dataset.importFinishShown;get('Review').hidden=true;document.getElementById('localImportOptions').hidden=true;window.abyssRepairStep?.(dialog,1);}get('Start').disabled=value;get('Browse').disabled=value;get('Roots').disabled=value;get('Rehash').disabled=value;get('Stop').hidden=!value;updateSelection();}
    document.getElementById('localImportOpen').onclick=()=>{mode(true);get('Duplicates').checked=false;get('DuplicatesLabel').hidden=true;get('Description').textContent='Add model cards for files already on your computer. Choose folders, find matches, then review your import.';get('Unlinked').checked=true;get('Title').textContent='Add existing model files';dialog.showModal();render();if(running)poll();if(identifying)pollIdentify();};
    get('Open').onclick=()=>{mode(false);get('DuplicatesLabel').hidden=true;get('Duplicates').checked=true;get('Description').textContent='Compare local files by full SHA-256, including files downloaded outside AbyssBeacon. Scanning does not change model files or installed records.';render();get('Title').textContent='Find duplicate files';dialog.showModal();if(running)poll();if(identifying)pollIdentify();};
    get('Close').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{clearTimeout(timer);clearTimeout(identifyTimer);});
    dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
    get('Browse').onclick=async()=>{try{const r=await request('/api/installed-recovery/picker',{kind:'folder'});if(r.path)get('Roots').value=[...new Set([...get('Roots').value.split(/\r?\n/).filter(Boolean),r.path])].join('\n');}catch(e){get('Status').textContent=e.message;}};
    get('Start').onclick=async()=>{if(identifying||saving||running)return;completion=null;document.getElementById('localImportCompletion')?.remove();busy(true);identified.clear();matchChoices.clear();selected.clear();updateSelection();result=null;get('Results').replaceChildren();get('Filters').hidden=true;get('More').hidden=true;get('Errors').hidden=true;get('Status').textContent='Reading folders…';try{const r=await request('/api/local-inventory',{folders:get('Roots').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),rehash:get('Rehash').checked});job=r.job_id;await poll();}catch(e){busy(false);get('Status').textContent=e.message;}};
    get('Stop').onclick=async()=>{try{await request('/api/local-inventory/'+job,{});get('Status').textContent='Stopping scan…';}catch(e){get('Status').textContent=e.message;}};
    async function poll(){clearTimeout(timer);try{const r=await request('/api/local-inventory/'+job);if(r.status==='running'){get('Status').textContent=`${r.phase}: ${r.files} files found. ${r.bytes_total?size(r.bytes_done)+' / '+size(r.bytes_total)+'. ':''}${r.cached||0} cached hashes reused. You can close this window and reopen it while scanning.`;if(dialog.open)timer=setTimeout(poll,1000);return;}
        busy(false);if(r.status!=='complete'){get('Status').textContent=r.phase;return;}result=r.result;limit=50;get('Filters').hidden=false;get('Status').textContent=`Scan complete · ${result.files.length} files checked · ${result.unlinked} not linked to your library.`;get('Diagnostics').textContent=`${result.files.length} files checked; ${result.duplicates.length} duplicate groups; ${result.unlinked} unlinked paths. ${r.hashed||0} files hashed, ${r.cached||0} cached hashes reused. No model files changed.`;get('Errors').hidden=!result.errors.length;get('Errors').querySelector('pre').textContent=result.errors.join('\n');render();
    }catch(e){get('Status').textContent=e.message+' Reopen this window to retry.';}}
    function shortenFolder(path){
        const parts=path.split(/[\\/]+/).filter(Boolean);
        const folder=parts.slice(0,-1);
        return folder.length>3?'…\\'+folder.slice(-3).join('\\'):folder.join('\\');
    }
    async function showFolder(path, feedback){
        try{await request('/api/local-inventory/'+job+'/open-folder',{path});feedback.textContent='Folder opened';}
        catch(e){feedback.textContent=e.message;}
    }
    function askDelete(file,group){
        if(deletingDuplicate||group.physical_copies<2)return;
        pendingDuplicateDelete={path:file.path,sha256:group.sha256};
        get('DeletePath').textContent=file.path;
        get('DeleteInfo').textContent=`${size(file.size)} · ${file.tracked?'Linked to Downloaded Library — its installed association will be updated':'Not linked to Downloaded Library'} · ${group.physical_copies} separate physical copies found`;
        get('DeleteStatus').textContent='';get('DeleteAccept').disabled=false;get('DeleteCancel').disabled=false;
        get('DeleteConfirm').showModal();
    }
    get('DeleteCancel').onclick=()=>{if(!deletingDuplicate)get('DeleteConfirm').close();};
    get('DeleteAccept').onclick=async()=>{
        if(deletingDuplicate||!pendingDuplicateDelete)return;
        deletingDuplicate=true;get('DeleteAccept').disabled=get('DeleteCancel').disabled=true;
        get('DeleteStatus').textContent='Rechecking both files and sending the selected copy to Windows Recycle Bin…';
        try{
            const response=await request('/api/local-inventory/'+job+'/recycle-copy',pendingDuplicateDelete);
            result=response.result;
            get('DeleteConfirm').close();pendingDuplicateDelete=null;
            const notice='Copy moved to Recycle Bin. '+(response.warning||'Your other verified copy was kept.')+' Results updated; run Scan local files to verify again.';
            get('Status').textContent=notice;
            setTimeout(()=>{if(get('Status').textContent===notice)get('Status').textContent='';},9000);
            const y=dialog.scrollTop;render();dialog.scrollTop=y;
            if(typeof window.refreshDownloadedLibrary==='function')window.refreshDownloadedLibrary();
        }catch(e){get('DeleteStatus').textContent=e.message;}
        finally{deletingDuplicate=false;get('DeleteAccept').disabled=get('DeleteCancel').disabled=false;}
    };
    function fileRow(file,duplicateGroup=null){
        const row=node('div','');row.className='inventory-file';row.dataset.path=file.path;
        if(dialog.classList.contains('import-mode')&&!file.tracked){const label=node('label','');label.className='inventory-check';const check=document.createElement('input');check.type='checkbox';check.checked=selected.has(file.path);check.disabled=identifying||saving;check.onchange=()=>{if(check.checked&&selected.size>=50){check.checked=false;return;}if(check.checked)selected.add(file.path);else selected.delete(file.path);updateSelection();};label.append(check,node('span',identified.get(file.path)?.state==='matched'?'Select to save':'Select file'));row.append(label);}
        const name=node(file.model_id?'button':'strong',file.filename);if(file.model_id){name.type='button';name.className='repair-model-link';name.onclick=()=>window.abyssRepairModel?.(file.model_id,dialog,name);}row.append(name,node('span',size(file.size)+' · '+(file.tracked?'Linked to your library':identified.has(file.path)?'Matching checked':'Ready to find a match')));
        if(duplicateGroup){
            row.classList.add('inventory-duplicate-row');
            const short=node('div',shortenFolder(file.path));short.className='inventory-duplicate-path';short.title=file.path;row.append(short);
            const buttons=node('div','');buttons.className='inventory-duplicate-actions';
            const open=node('button','Open folder');open.type='button';
            const recycle=node('button','Delete copy…');recycle.type='button';recycle.className='inventory-delete-button';
            // Hard-linked names don't provide an independent physical survivor.
            recycle.disabled=duplicateGroup.physical_copies<2||!file.filename.toLowerCase().endsWith('.safetensors');
            recycle.title=recycle.disabled?'Only SafeTensors with another separately verified physical copy can be recycled':'Move the selected file to Windows Recycle Bin';
            const feedback=node('span','');feedback.className='inventory-duplicate-feedback';feedback.setAttribute('role','status');
            open.onclick=async()=>{open.disabled=true;await showFolder(file.path,feedback);open.disabled=false;};
            recycle.onclick=()=>askDelete(file,duplicateGroup);
            buttons.append(open,recycle,feedback);row.append(buttons);
            const full=node('details','');full.className='inventory-duplicate-details';full.append(node('summary','Full path'),node('code',file.path));row.append(full);
        }else{
            const details=window.abyssRepairPath(file.path,'/api/local-inventory/'+job+'/open-folder');details.open=showPaths;row.append(details);
        }
        const found=dialog.classList.contains('import-mode')?identified.get(file.path):null;if(found)renderMatch(row,found);
        if(dialog.classList.contains('import-mode')&&!file.tracked&&found){
            const options=node('details','');options.className='inventory-link-alternatives';
            options.open=found.state!=='matched';
            options.append(node('summary',found.state==='matched'?'Choose a different match':'Link this file another way'));
            options.append(node('p',found.state==='error'?'Lookup failed. Retry finding matches or link this file below.':found.state==='matched'?'Use another model card or enter the correct details.':'No automatic match found. Use a model URL, an existing model card, or your own details.'));
            const link=node('button','Choose URL, existing model, or manual entry');link.type='button';link.disabled=running||identifying||saving;
            link.onclick=async()=>{saving=true;updateSelection();try{if(await window.abyssLinkLocalModel(job,file)){file.tracked=true;selected.delete(file.path);completion={saved:1,failed:selected.size,messages:[]};}}finally{saving=false;updateSelection();render();showCompletion();}};
            options.append(link);row.append(options);
        }
        return row;
    }

    function render(){get('Review').hidden=running||!result;if(!result)return;const list=get('Results');list.replaceChildren();const onlyUnlinked=get('Unlinked').checked,duplicates=get('Duplicates').checked;
        const eligible=f=>(duplicates||!get('SafeOnly').checked||f.filename.toLowerCase().endsWith('.safetensors'));
        const entries=duplicates?result.duplicates.filter(g=>g.files.some(eligible)&&(!onlyUnlinked||g.files.some(f=>!f.tracked&&eligible(f)))):result.files.filter(f=>eligible(f)&&(!onlyUnlinked||!f.tracked));
        for(const entry of entries.slice(0,limit)){if(!duplicates){list.append(fileRow(entry));continue;}const group=node('section','');group.className='inventory-group';group.append(node('h3',`${entry.files.length} matching paths · ${entry.physical_copies} physical copies`),node('p',`Extra copy size: ${size(entry.extra_bytes)}. Hard links share storage.`));const hash=node('details','');hash.append(node('summary','SHA-256'),node('code',entry.sha256));group.append(hash);for(const file of entry.files)if(eligible(file))group.append(fileRow(file,entry));list.append(group);}
        if(duplicates){get('DuplicateSummary').hidden=!entries.length;get('DuplicateSummary').textContent=`${entries.length} duplicate groups · Potential space recoverable: ${size(entries.reduce((sum,g)=>sum+g.extra_bytes,0))}`;get('DuplicateHelp').hidden=!entries.length;get('Paths').hidden=true;}
        if(!entries.length){const empty=node('div','');empty.className='inventory-empty';empty.append(node('h3',duplicates?(result.errors.length?'No duplicates found in accessible files':'No duplicates found in selected folders'):'No files match these options.'));const again=node('button','Search a new folder');again.type='button';again.onclick=()=>{if(toolbar)toolbar.hidden=true;get('Review').hidden=true;window.abyssRepairStep?.(dialog,1);dialog.scrollTo({top:0,behavior:'smooth'});get('Roots').focus({preventScroll:true});get('Roots').select();};empty.append(again);list.append(empty);}get('More').hidden=entries.length<=limit;updateSelection();
    }
    for(const id of ['Duplicates','Unlinked','SafeOnly'])get(id).onchange=()=>{limit=50;if(get('SafeOnly').checked)for(const path of selected)if(!path.toLowerCase().endsWith('.safetensors'))selected.delete(path);updateSelection();render();};
    get('More').onclick=()=>{limit+=50;render();};
    get('Paths').onclick=()=>{showPaths=!showPaths;get('Paths').textContent=showPaths?'Hide full paths':'Show full paths';get('Results').querySelectorAll('.inventory-path').forEach(d=>{d.open=showPaths;});};
    const ready=p=>{const r=identified.get(p);return r?.state==='matched'&&(r.matches?.length===1||matchChoices.has(p));};
    function updateSelection(){if(!selected.size)bulkSelected=false;const importing=dialog.classList.contains('import-mode');if(toolbar)toolbar.hidden=running||!result||!get('Results').querySelector(importing?'.inventory-file input[type=checkbox]':'.inventory-group');get('Select').hidden=!importing||bulkSelected;get('ClearSelection').hidden=!importing||!bulkSelected;get('Select').disabled=get('ClearSelection').disabled=identifying||saving||running;get('Identify').textContent=identifying?'Finding matches…':`Find matches for selected files (${selected.size})`;get('Identify').disabled=identifying||running||saving||!selected.size;const save=document.getElementById('localImportSave'),count=[...selected].filter(ready).length;if(count&&!running)dialog.dataset.importFinishShown='1';document.getElementById('localImportOptions').hidden=!!completion||!importing||running||!result||dialog.dataset.importFinishShown!=='1';window.abyssRepairStep?.(dialog,!importing?(running||!result?1:2):(completion&&!completion.failed?4:running||!result?1:count?3:2));save.disabled=identifying||running||saving||!count;save.textContent=!selected.size?'Select files to import':count?`Add matched files to library (${count})`: [...selected].some(p=>(identified.get(p)?.matches||[]).length>1)?'Choose a match to continue':'No selected files ready to import';get('Identify').classList.toggle('inventory-working',identifying);}
    get('Select').onclick=()=>{if(identifying||saving)return;bulkSelected=true;for(const row of get('Results').querySelectorAll('.inventory-file')){if(selected.size>=50)break;if(row.querySelector('input[type=checkbox]'))selected.add(row.dataset.path);}updateSelection();render();};
    get('ClearSelection').onclick=()=>{if(identifying||saving)return;selected.clear();updateSelection();render();};
    get('Identify').onclick=async()=>{completion=null;document.getElementById('localImportCompletion')?.remove();for(const path of selected){identified.delete(path);matchChoices.delete(path);}identifying=true;updateSelection();get('Start').disabled=true;get('IdentifyStop').hidden=false;get('IdentifyResults').replaceChildren();get('IdentifyStatus').textContent='Finding matching model details…';render();try{const r=await request('/api/local-inventory/'+job+'/identify',{paths:[...selected]});identifyJob=r.job_id;await pollIdentify();}catch(e){for(const path of selected)identified.set(path,{path,state:'error',message:e.message});finishIdentification();get('IdentifyStatus').textContent=e.message;}};
    function finishIdentification(){identifying=false;get('Start').disabled=running;get('IdentifyStop').hidden=true;updateSelection();render();}
    get('IdentifyStop').onclick=async()=>{try{await request('/api/civarchive-identify/'+identifyJob,{});get('IdentifyStatus').textContent='Stopping identification; an in-flight request may take up to 20 seconds.';}catch(e){get('IdentifyStatus').textContent=e.message;}};
    function renderMatch(section,item){
        const multiple=(item.matches||[]).length>1;
        const attention=item.state!=='matched'||(multiple&&!matchChoices.has(item.path));
        section.classList.toggle('inventory-attention',attention);
        section.classList.toggle('inventory-failed',item.state==='error');
        const state=node('p',attention?(multiple?'Choose a match before importing':item.state==='error'?'Lookup failed': item.mirror_only?'Mirror found — model details unavailable':item.state==='not_found'?'No matches found':'No verified model details found'):'✓ Verified file match');state.className='inventory-match-status';section.append(state);
        if(item.state!=='matched'&&item.message)section.append(node('p',item.message));
        if(multiple){
            const fieldset=node('fieldset','');fieldset.className='inventory-match-choices';fieldset.append(node('legend','Which model details should AbyssBeacon use?'));
            item.matches.forEach((m,i)=>{
                const label=node('label',''),radio=document.createElement('input'),description=node('span','');
                radio.type='radio';radio.name='match-'+item.path;radio.value=String(i);radio.checked=matchChoices.get(item.path)===i;radio.disabled=identifying||saving;
                description.append(node('strong',m.model||'Unnamed model'),node('span',`${m.creator||'Unknown creator'} · ${m.version} · ${m.architecture||'Unknown architecture'}`),node('span',m.filename||'Unnamed file'),node('small',`${m.platform||'Source unknown'} · File ${m.file_id} · Version ${m.version_id}`));
                radio.onchange=()=>{matchChoices.set(item.path,i);section.classList.remove('inventory-attention');state.textContent='✓ Match selected — ready to import';updateSelection();};
                label.append(radio,description);fieldset.append(label);if(m.model_url){const a=node('a','View this model');a.href=m.model_url;a.target='_blank';a.rel='noopener noreferrer';fieldset.append(a);}
            });section.append(fieldset,node('p','These records match this file’s hash. Choose the details to save; your local filename stays unchanged.'));
        }else for(const match of item.matches||[])section.append(node('p',`${match.model} · ${match.version} · ${match.architecture}${match.mature?' · Mature':''}`));
        if(item.sha256){const link=node('a','View on CivArchive');link.href='https://civarchive.com/sha256/'+item.sha256;link.target='_blank';link.rel='noopener noreferrer';section.append(link);}
    }
    async function pollIdentify(){clearTimeout(identifyTimer);try{const r=await request('/api/civarchive-identify/'+identifyJob);for(const item of r.results)identified.set(item.path,item);
        const matched=r.results.filter(x=>x.state==='matched').length,errors=r.results.filter(x=>x.state==='error').length;
        get('IdentifyStatus').textContent=r.status==='running'?`${r.phase} · ${r.results.length}/${r.total} processed`:`${r.status==='complete'?'Identification complete':'Identification stopped'} — ${matched} matched · ${r.results.length-matched-errors} unmatched/unverified · ${errors} failed · ${r.total-r.results.length} not processed. Review the matches below, then choose Add matched files to library.`;
        get('IdentifyResults').replaceChildren();
        // Update results in place without resetting scroll or creating a second file list.
        const scroll=dialog.scrollTop;render();dialog.scrollTop=scroll;
        if(r.status==='running'){if(dialog.open)identifyTimer=setTimeout(pollIdentify,1000);}else finishIdentification();
    }catch(e){get('IdentifyStatus').textContent=e.message+' Reopen this window to retry.';}}
    const imp=id=>document.getElementById('localImport'+id);
    imp('Save').onclick=async()=>{
        const paths=[...selected].filter(ready);imp('Save').disabled=true;imp('Status').textContent='Preparing import preview…';
        try{const r=await request('/api/civarchive-identify/'+identifyJob+'/import-preview',{paths,choices:Object.fromEntries(matchChoices),move:imp('Move').checked,companions:imp('Companions').checked});previewToken=r.token;const plan=imp('Plan');plan.replaceChildren();const skipped=selected.size-paths.length;if(skipped)plan.append(node('p',`${skipped} selected file(s) are not ready and will be left unchanged. Choose a match or leave them for later.`));
            for(const file of r.files){const section=node('section','');section.className='inventory-group';section.append(node('strong',file.model),node('p',file.action));if(file.chosen_file_id)section.append(node('p',`Selected details: ${file.chosen_version} · ${file.chosen_filename} · File ${file.chosen_file_id}`));for(const t of file.transfers)section.append(node('p',t.from===t.to?`Keep in place: ${t.from}`:`Move: ${t.from} → ${t.to} (${size(t.size)})`));if(file.recorded_date)section.append(node('p',`Recorded install date: ${file.recorded_date} (${file.date_origin})`));if(file.info_path)section.append(node('p','Create if absent: '+file.info_path));if(file.preview_path)section.append(node('p','Save preview if available and absent: '+file.preview_path));if(file.preview_status)section.append(node('p',file.preview_status));plan.append(section);}imp('Status').textContent='';imp('Confirm').showModal();
        }catch(e){imp('Status').textContent=e.message;}finally{updateSelection();}
    };
    imp('Cancel').onclick=()=>imp('Confirm').close();
    imp('Accept').onclick=async()=>{saving=true;imp('Accept').disabled=true;imp('Cancel').disabled=true;imp('Accept').textContent='Saving…';get('Start').disabled=true;updateSelection();
        try{const r=await request('/api/local-model-import/apply',{token:previewToken});let saved=0;const messages=[];
            for(const item of r.results){if(item.success){saved++;selected.delete(item.path);identified.delete(item.path);const file=result.files.find(f=>f.path===item.path);if(file){file.tracked=true;file.path=item.target||file.path;}for(const w of item.warnings||[])messages.push(w);}else messages.push(item.path+': '+item.error+' '+(item.recovery||[]).join(' '));}
            completion={saved,failed:Math.max(r.results.length-saved,selected.size),messages};imp('Confirm').close();render();showCompletion();
        }catch(e){imp('Status').textContent=e.message;imp('Confirm').close();}
        finally{saving=false;imp('Accept').disabled=false;imp('Cancel').disabled=false;imp('Accept').textContent='Confirm import';get('Start').disabled=running;updateSelection();}
    };
    function showCompletion(){
        if(!completion)return;
        document.getElementById('localImportCompletion')?.remove();
        const panel=node('section','');panel.id='localImportCompletion';panel.className='import-completion';panel.setAttribute('role','status');
        const {saved,failed,messages}=completion;
        panel.append(node('h3',failed?`${saved} file${saved===1?'':'s'} added · ${failed} need attention`:saved===1?'✓ Model added to your library':'✓ Models added to your library'));
        panel.append(node('p',saved?`${saved} file${saved===1?'':'s'} linked successfully. Open the library to find your models, open their folders, and add review choices or tags.`:'No files were added. Review the errors below and try again.'));
        for(const message of messages)panel.append(node('p',message));
        const view=node('a','View in library');view.href='/downloaded';panel.append(view);
        const more=node('button',failed?'Review remaining files':'Add more files');more.type='button';
        more.onclick=()=>{completion=null;panel.remove();delete dialog.dataset.importFinishShown;updateSelection();if(failed)get('Review').scrollIntoView({behavior:'smooth'});else{dialog.scrollTo({top:0,behavior:'smooth'});get('Roots').focus({preventScroll:true});}};
        panel.append(more);dialog.append(panel);updateSelection();panel.scrollIntoView({behavior:'smooth',block:'center'});
    }
    imp('Confirm').addEventListener('cancel',e=>{if(saving)e.preventDefault();});
});
