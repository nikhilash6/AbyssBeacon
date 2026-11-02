document.addEventListener('DOMContentLoaded',()=>{
    const el=id=>document.getElementById('installedRecovery'+id),dialog=el('Dialog');if(!dialog)return;
    let jobId=null,reviewId=null,offset=0,timer,previousFocus,checking=false,saving=false,navigating=false;
    const labels={forgotten:'Download record removed',already_installed:'Already installed — tracking resolved',relinked:'Location updated',recorded_location:'At recorded location (not rehashed)',found:'Verified match found',multiple_matches:'Multiple verified copies — choose one',missing:'Missing — not found in searched folders',unavailable:'Location unavailable or scan incomplete',unverified:'Candidate only — identity not verified'};
    const text=(tag,value,cls)=>{const node=document.createElement(tag);node.textContent=value;if(cls)node.className=cls;return node;};
    async function request(url,options){const response=await fetch(url,{cache:'no-store',...options});const result=await response.json();if(!response.ok||!result.success)throw new Error(result.error||'Request failed');return result;}
    const post=(url,payload)=>request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    let continueJob=null,unresolvedCount=0;
    el('SearchNew').onclick=()=>el('SearchMore').click();
    el('Form').after(el('Continue'));
    const types={checkpoints:'Checkpoints',diffusion_models:'Diffusion models',loras:'LoRAs',vae:'VAEs',text_encoders:'Text encoders',controlnet:'ControlNet',embeddings:'Embeddings',upscale_models:'Upscalers',workflows:'Workflows','AbyssBeacon-Other':'Unknown type'};
    const all=document.createElement('input');all.type='checkbox';all.checked=true;const allLabel=text('label','');allLabel.className='recovery-check';allLabel.append(all,document.createTextNode('All types'));el('Types').append(allLabel);
    for(const [value,label] of Object.entries(types)){const check=document.createElement('input');check.type='checkbox';check.value=value;check.checked=true;check.dataset.type=value;check.onchange=()=>{all.checked=[...el('Types').querySelectorAll('[data-type]')].every(c=>c.checked);};const item=text('label','');item.className='recovery-check';item.append(check,document.createTextNode(label));el('Types').append(item);}all.onchange=()=>el('Types').querySelectorAll('[data-type]').forEach(c=>c.checked=all.checked);
    el('SearchMore').onclick=()=>navigateResults(async()=>{continueJob=unresolvedCount?jobId:null;el('Continue').hidden=!continueJob;el('Results').hidden=true;window.abyssRepairStep?.(dialog,1);dialog.scrollTo({top:0,behavior:'smooth'});el('Roots').focus({preventScroll:true});el('Roots').select();});
    el('ResetScope').onclick=()=>{continueJob=null;el('Continue').hidden=true;};
    let skipUntrack=false;
    try{skipUntrack=sessionStorage.getItem('abyssRecoveryForgetDownloadConfirmation')==='1';}catch(_){}
    function rememberSkip(value){skipUntrack=value;try{if(value)sessionStorage.setItem('abyssRecoveryForgetDownloadConfirmation','1');else sessionStorage.removeItem('abyssRecoveryForgetDownloadConfirmation');}catch(_){}}
    function confirmAction(title,help,items,allowSkip=false){
        const confirm=el('Confirm'),list=el('ConfirmList');el('ConfirmTitle').textContent=title;el('ConfirmHelp').textContent=help;list.replaceChildren(...items.map(value=>text('li',value)));
        el('SkipUntrackLabel').hidden=!allowSkip;el('SkipUntrack').checked=false;
        const focus=document.activeElement;let accepted=false;
        return new Promise(resolve=>{el('ConfirmCancel').onclick=()=>confirm.close();el('ConfirmAccept').onclick=()=>{accepted=true;confirm.close();};confirm.addEventListener('close',()=>{if(accepted&&allowSkip&&el('SkipUntrack').checked)rememberSkip(true);focus?.focus();resolve(accepted);},{once:true});confirm.showModal();el('ConfirmCancel').focus();});
    }
    function busy(value){checking=value;if(value){delete dialog.dataset.finishShown;el('Finish').hidden=true;window.abyssRepairStep?.(dialog,1);}el('Types').querySelectorAll('input').forEach(c=>c.disabled=value);el('SearchMore').disabled=value;el('Start').disabled=value;el('Cancel').hidden=!value;dialog.querySelectorAll('[data-recovery-browse]').forEach(b=>b.disabled=value);el('Roots').disabled=value;el('Path').disabled=value;}
    function changed(){el('Refresh').hidden=false;el('PageRefresh').hidden=false;}
    async function openFile(button){
        if(checking){el('Progress').textContent='A file check is already running. Finish or cancel it before locating another file.';if(!dialog.open)dialog.showModal();return;}
        el('BrowseFolder').hidden=true;reviewId=Number(button.dataset.reviewId);jobId=null;offset=0;
        el('Title').textContent='Locate installed file';el('Folders').hidden=true;el('File').hidden=false;el('Path').value=button.dataset.path||'';el('Start').textContent='Check file identity';
        el('Results').hidden=true;el('Progress').textContent='Choose the moved file. Hash-verified matches can be linked directly. Other candidates require your explicit confirmation.';previousFocus=button;dialog.showModal();el('Path').focus();
    }
    el('Open').addEventListener('click',async()=>{
        previousFocus=el('Open');dialog.showModal();
        el('BrowseFolder').hidden=false;reviewId=null;el('Title').textContent='Update model locations';el('Folders').hidden=false;el('File').hidden=true;el('Start').textContent='Start file scan';
        try{if(!el('Roots').value){const result=await request('/api/installed-recovery');el('Roots').value=result.folders.join('\n');}if(jobId)await poll();else el('Progress').textContent='';}catch(error){el('Progress').textContent=error.message;}
        el('Roots').focus();
    });
    const requestClose=()=>navigateResults(async()=>{dialog.close();});
    el('Close').addEventListener('click',requestClose);
    dialog.addEventListener('cancel',event=>{event.preventDefault();requestClose();});
    let backdropDown=false;
    const outside=event=>{const r=dialog.getBoundingClientRect();return event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom;};
    dialog.addEventListener('pointerdown',event=>{backdropDown=event.target===dialog&&outside(event);});
    dialog.addEventListener('click',event=>{if(backdropDown&&event.target===dialog&&outside(event))requestClose();backdropDown=false;});
    dialog.addEventListener('close',()=>{clearTimeout(timer);previousFocus?.focus();});
    el('Form').addEventListener('submit',async event=>{
        event.preventDefault();if(checking)return;busy(true);el('Progress').textContent='Starting file check…';el('Results').hidden=true;offset=0;
        try{
            const payload=reviewId?{review_id:reviewId,path:el('Path').value.trim()}:{folders:el('Roots').value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),remember:el('Remember').checked,find_copies:el('FindCopies').checked,auto_exact:el('AutoExact').checked,model_types:[...el('Types').querySelectorAll('[data-type]:checked')].map(c=>c.value),continue_job:continueJob};
            if(reviewId&&!payload.path)throw new Error('Choose a full file path first.');
            const result=await post('/api/installed-recovery',payload);jobId=result.job_id;rememberSkip(false);await poll();
        }catch(error){busy(false);el('Progress').textContent=error.message;}
    });
    dialog.addEventListener('click',async event=>{
        const button=event.target.closest('[data-recovery-browse]');if(!button)return;button.disabled=true;
        try{const result=await post('/api/installed-recovery/picker',{kind:button.dataset.recoveryBrowse});if(result.path){if(button.dataset.recoveryBrowse==='file')el('Path').value=result.path;else el('Roots').value=[...new Set([...el('Roots').value.split(/\r?\n/).filter(Boolean),result.path])].join('\n');}}
        catch(error){el('Progress').textContent=error.message;}finally{button.disabled=false;}
    });
    el('Cancel').addEventListener('click',async()=>{try{await request('/api/installed-recovery/'+jobId,{method:'DELETE'});el('Progress').textContent='Cancelling…';}catch(error){el('Progress').textContent=error.message;}});
    async function poll(){
        clearTimeout(timer);if(!jobId)return;
        try{
            const result=await request(`/api/installed-recovery/${jobId}?offset=${offset}&include_current=${el('IncludeCurrent').checked?'1':'0'}&include_missing=${el('IncludeMissing').checked?'1':'0'}`);
            if(['running','finalizing'].includes(result.status)){
                busy(true);el('Progress').textContent=`${result.phase} · ${result.files_checked} folder entries checked · ${result.records_checked}/${result.total_records} saved downloads checked · ${(result.bytes_hashed/1048576).toFixed(0)} MiB hashed${result.current_path?'\n'+result.current_path:''}`;
                if(dialog.open)timer=setTimeout(poll,1000);return;
            }
            busy(false);
            if(result.status!=='complete'){el('Progress').textContent=result.error||result.phase;return;}
            const updated=(result.counts?.relinked||0)+(result.counts?.already_installed||0);const removed=result.forgotten||result.counts?.forgotten||0;if(updated||removed)changed();
            el('Progress').textContent=`Check complete. ${updated} location(s) updated or resolved; ${removed} missing download record(s) removed. Model cards and physical files kept.`;render(result);
        }catch(error){busy(false);el('Progress').textContent=error.message;}
    }
    function render(result){
        el('Results').hidden=false;window.abyssRepairStep?.(dialog,2);
        el('AutoUpdate').textContent=`Save remaining exact matches (${result.automatic_total||0})`;el('AutoUpdate').disabled=!result.automatic_total;el('AutoUpdate').dataset.count=String(result.automatic_total||0);
        el('Summary').textContent=Object.entries(result.counts||{}).map(([key,count])=>`${labels[key]||key}: ${count}`).join(' · ');
        el('Warnings').replaceChildren(...result.warnings.map(item=>text('p',`${item.path}: ${item.error}`)));
        const rows=[];
        for(const row of result.results){
            const section=document.createElement('section');section.className='installed-recovery-row';section.dataset.reviewId=row.review_id;section.dataset.status=row.status;
            section.dataset.selectSingle=String(!row.recorded_exists&&row.candidates.filter(c=>c.verified).length===1);
            const heading=text('h3',''),name=text(row.model_id?'button':'span',row.model_name||row.filename);if(row.model_id){name.type='button';name.className='repair-model-link';name.onclick=()=>window.abyssRepairModel?.(row.model_id,dialog,name);}heading.append(name);section.append(heading,text('p',`${labels[row.status]||row.status} · ${row.filename}`,'recovery-row-status'),window.abyssRepairPath(row.old_path,'/api/repair-path/recovery/'+jobId+'/open-folder'));
            if(row.recorded_exists&&row.candidates.length)section.append(text('p','The recorded file still exists. Choosing another copy changes tracking only; both files will be kept.'));
            if(row.message)section.append(text('p',row.message,row.apply_error?'recovery-row-feedback is-error':''));
            if(row.apply_error)section.dataset.saveError=row.apply_error;
            if(row.candidates.length){
                const fieldset=document.createElement('fieldset');fieldset.append(text('legend','Choose a location for this file/version'));
                const none=document.createElement('label'),no=document.createElement('input');no.type='radio';no.name='recovery-'+row.review_id;no.checked=true;none.append(no,document.createTextNode('Leave unchanged — don’t update tracking'));fieldset.append(none);
                for(const candidate of row.candidates){
                    const label=document.createElement('label'),radio=document.createElement('input');radio.type='radio';radio.name=no.name;radio.dataset.verified=String(candidate.verified);radio.disabled=!!candidate.hash_mismatch;radio.dataset.path=candidate.path;radio.dataset.reviewId=row.review_id;radio.dataset.oldPath=row.old_path;
                    label.append(radio,text('span',`${candidate.verified?'Update tracking to this verified file:':'Use this file — confirm manually:'}\n${candidate.path.split(/[\\/]/).pop()}\n${candidate.size_bytes.toLocaleString()} bytes · ${candidate.verified?'SHA-256 verified':candidate.error||'Identity not verified'}`));fieldset.append(label,window.abyssRepairPath(candidate.path,'/api/repair-path/recovery/'+jobId+'/open-folder'));
                }
                section.append(fieldset);
            }
            if(row.tracked&&row.status==='missing'){const label=text('label','');label.className='recovery-check';const check=document.createElement('input');check.type='checkbox';check.dataset.missingId=row.review_id;check.dataset.path=row.old_path;check.dataset.name=row.model_name||row.filename;check.onchange=updateMissing;label.append(check,document.createTextNode('Select missing download record'));section.append(label);const button=text('button','Remove download record…');button.type='button';button.className='downloaded-untrack-file';button.dataset.reviewId=row.review_id;button.dataset.path=row.old_path;section.append(button);}
            section.append(text('p','','recovery-row-feedback'));rows.push(section);
        }
        unresolvedCount=['missing','unavailable','unverified','multiple_matches'].reduce((sum,key)=>sum+(result.counts?.[key]||0),0);
        el('Empty').hidden=!!rows.length;
        el('Followup').hidden=!rows.length;
        el('AutoUpdate').hidden=!result.automatic_total;
        el('AutoHelp').hidden=!rows.length;
        dialog.querySelector('.recovery-result-jumps').hidden=!rows.length;
        el('Rows').replaceChildren(...rows);el('MissingActions').hidden=!result.results.some(r=>r.status==='missing');updateMissing();
        el('Unknown').querySelector('summary').textContent=`Unrecognized files (${result.unknown_total})`;
        el('UnknownRows').replaceChildren(...result.unknown.map(file=>window.abyssRepairPath(file.path,'/api/repair-path/recovery/'+jobId+'/open-folder')));
        el('Previous').disabled=offset===0;el('Next').disabled=offset+50>=Math.max(result.total,result.unknown_total);
        const total=Math.max(result.total,result.unknown_total);
        el('Paging').hidden=total<=50;
        el('Unknown').hidden=!result.unknown_total;
        el('Page').textContent=`Page ${Math.floor(offset/50)+1} of ${Math.max(1,Math.ceil(total/50))} · ${total} results`;
        updateFinish();
    }
    function updateFinish(){const locations=selectedLocations().length,missing=el('Rows').querySelectorAll('[data-missing-id]:checked:not(:disabled)').length;if(locations||missing)dialog.dataset.finishShown='1';el('Finish').hidden=dialog.dataset.finishShown!=='1';el('Apply').disabled=saving||!locations;el('SelectionHint').hidden=!!(locations||missing);window.abyssRepairStep?.(dialog,locations||missing?3:2);}
    function updateMissing(){const checks=[...el('Rows').querySelectorAll('[data-missing-id]:not(:disabled)')],chosen=checks.filter(c=>c.checked);el('RemoveMissing').disabled=!chosen.length;el('RemoveMissing').textContent=`Remove selected download records (${chosen.length})…`;el('SelectMissing').textContent=checks.length&&chosen.length===checks.length?'Deselect all':'Select all missing on this page';updateFinish();}
    el('SelectMissing').onclick=()=>{const checks=[...el('Rows').querySelectorAll('[data-missing-id]:not(:disabled)')],value=!checks.every(c=>c.checked);checks.forEach(c=>c.checked=value);updateMissing();};
    el('RemoveMissing').onclick=async()=>{
        const selected=[...el('Rows').querySelectorAll('[data-missing-id]:checked:not(:disabled)')];
        if(!selected.length||!await confirmAction(`Remove ${selected.length} download records?`,'The search cannot prove deletion. Confirm you know these files were deleted. Removes installed tracking, review data and unshared download history. Model cards and physical files are kept.',selected.map(c=>c.dataset.name+'\n'+c.dataset.path)))return;
        el('RemoveMissing').disabled=true;
        try{const result=await post(`/api/installed-recovery/${jobId}/forget`,{confirm:true,review_ids:selected.map(c=>Number(c.dataset.missingId))});const failures=[];for(const item of result.results){const check=selected.find(c=>Number(c.dataset.missingId)===item.review_id);if(item.success){check.closest('section').remove();changed();}else failures.push(item.error);}el('Progress').textContent=`${result.results.length-failures.length} records removed. `+failures.join('; ');}catch(e){el('Progress').textContent=e.message;}finally{updateMissing();}
    };
    el('AutoUpdate').addEventListener('click',()=>navigateResults(async()=>{
        el('AutoUpdate').disabled=true;let done=0;
        try{
            const preview=await request(`/api/installed-recovery/${jobId}/automatic`);
            if(!preview.matches.length){await poll();return;}
            if(!await confirmAction(`Update ${preview.matches.length} verified locations?`,'This applies to every eligible match in this scan, including results beyond this page. Only tracking is updated. Files, review choices, tags and download history are kept.',preview.matches.map(row=>`${row.model_name}\nFrom: ${row.old_path}\nTo: ${row.path}`)))return;
            const errors=[];
            for(let start=0;start<preview.matches.length;start+=100){
                el('Progress').textContent=`Updating verified locations: ${start}/${preview.matches.length}…`;
                const result=await post(`/api/installed-recovery/${jobId}/apply`,{selections:preview.matches.slice(start,start+100).map(row=>({review_id:row.review_id,path:row.path}))});
                for(const row of result.results){if(row.success)done++;else errors.push(row.error);}
                if(done)changed();
            }
            if(done)changed();offset=0;await poll();el('Progress').textContent=`${done} installed location(s) updated. ${errors.length?errors.length+' could not be updated: '+[...new Set(errors)].join('; '):'Unresolved files remain for review.'}`;
        }catch(error){el('Progress').textContent=`${done} location(s) updated. ${error.message}`;}finally{el('AutoUpdate').disabled=el('AutoUpdate').dataset.count==='0';}
    }));
    async function navigateResults(action){
        if(navigating||saving)return;
        navigating=true;
        try{
            const missing=[...el('Rows').querySelectorAll('[data-missing-id]:checked:not(:disabled)')];if(missing.length&&!await confirmAction('Leave selected missing records unchanged?','These removal selections have not been applied. Continuing clears the selections; no records will be removed.',missing.map(c=>c.dataset.path)))return;
            const selected=selectedLocations();
            if(selected.length){
                const dialog=el('Unsaved'),previous=document.activeElement;let decision='cancel';
                const manual=selected.filter(input=>input.dataset.verified!=='true').length;
                const failures=selected.map(input=>input.closest('.installed-recovery-row')?.dataset.saveError).filter(Boolean);
                el('UnsavedTitle').textContent=failures.length?'Some changes could not be saved':'Unsaved location changes';
                el('UnsavedMessage').textContent=`You have ${selected.length} unsaved location change(s) on this page. Save them before continuing, or discard them.${manual?' '+manual+' selection(s) lack hash verification. Saving confirms you recognize these files/versions; they will be marked User-confirmed.':''}`;
                if(failures.length)el('UnsavedMessage').textContent='The previous save could not apply '+failures.length+' selected location(s): '+[...new Set(failures)].join('; ')+'. Resolve the issue and retry, or discard these selections to continue.';
                el('UnsavedList').replaceChildren(...selected.map(input=>text('li',`${input.dataset.verified==='true'?'SHA-256 verified':'User-confirmed — no hash proof'}\nFrom: ${input.dataset.oldPath}\nTo: ${input.dataset.path}`)));
                const choice=await new Promise(resolve=>{
                    el('UnsavedCancel').onclick=()=>dialog.close();
                    el('UnsavedDiscard').onclick=()=>{decision='discard';dialog.close();};
                    el('UnsavedSave').onclick=()=>{decision='save';dialog.close();};
                    dialog.addEventListener('close',()=>{previous?.focus();resolve(decision);},{once:true});dialog.showModal();el('UnsavedCancel').focus();
                });
                if(choice==='cancel')return;
                if(choice==='save'&&!await saveChanges(true))return;
                if(choice==='discard')selected.forEach(input=>{input.checked=false;});
            }
            missing.forEach(input=>{input.checked=false;});updateMissing();
            await action();
        }finally{navigating=false;}
    }
    function scrollResults(target,behavior='smooth'){
        const top=target.getBoundingClientRect().top-dialog.getBoundingClientRect().top+dialog.scrollTop-16;
        const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        dialog.scrollTo({top:Math.max(0,top),behavior:reduced?'auto':behavior});
    }
    el('Top').addEventListener('click',()=>scrollResults(el('Results')));
    el('Bottom').addEventListener('click',()=>dialog.scrollTo({top:dialog.scrollHeight,behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));
    el('Previous').addEventListener('click',()=>navigateResults(async()=>{offset=Math.max(0,offset-50);await poll();scrollResults(el('Results'),'auto');}));
    el('Next').addEventListener('click',()=>navigateResults(async()=>{offset+=50;await poll();scrollResults(el('Results'),'auto');}));
    el('IncludeCurrent').addEventListener('change',()=>{
        const input=el('IncludeCurrent'),requested=input.checked;input.checked=!requested;
        navigateResults(async()=>{input.checked=requested;offset=0;await poll();});
    });
    el('IncludeMissing').addEventListener('change',()=>{const input=el('IncludeMissing'),requested=input.checked;input.checked=!requested;navigateResults(async()=>{input.checked=requested;offset=0;await poll();});});
    el('Refresh').addEventListener('click',()=>window.location.reload());
    el('PageRefresh').addEventListener('click',()=>window.location.reload());
    const selectedLocations=()=>[...el('Rows').querySelectorAll('input[type=radio]:checked[data-path]:not(:disabled)')];
    async function saveChanges(alreadyConfirmed=false){
        if(saving)return false;
        const checked=selectedLocations();
        if(!checked.length)return true;
        const manual=checked.filter(input=>input.dataset.verified!=='true').length;
        if(!alreadyConfirmed&&!await confirmAction('Save location changes?',`${checked.length} saved file/version record(s) will use the selected paths. Review choices, tags and download dates stay unchanged. No files will be moved or deleted.${manual?' '+manual+' choice(s) lack hash verification. Confirm that you recognize these files as the correct models/versions; they will be recorded as User-confirmed.':''}`,checked.map(input=>`${input.dataset.verified==='true'?'SHA-256 verified':'User-confirmed — no hash proof'}\nFrom: ${input.dataset.oldPath}\nTo: ${input.dataset.path}`)))return false;
        saving=true;el('Apply').disabled=true;
        try{
            const result=await post(`/api/installed-recovery/${jobId}/apply`,{selections:checked.map(input=>({review_id:Number(input.dataset.reviewId),path:input.dataset.path,...(input.dataset.verified!=='true'?{manual_confirm:true}:{})}))});
            const failed=result.results.filter(item=>!item.success);
            for(const item of result.results){
                const row=el('Rows').querySelector(`[data-review-id="${item.review_id}"]`),feedback=row?.querySelector('.recovery-row-feedback');
                if(feedback){feedback.textContent=item.success?(item.message||'Location updated'+(item.verification==='user_confirmed'?' · User-confirmed':'')+'. '+item.path):'Not saved: '+item.error;feedback.classList.toggle('is-error',!item.success);}
                if(item.success){
                    changed();if(row){delete row.dataset.saveError;row.dataset.status=item.already_installed?'already_installed':'relinked';
                    const status=row.querySelector('.recovery-row-status');if(status)status.textContent=labels[row.dataset.status]+' · '+(item.filename||item.path);
                    row.querySelector('.downloaded-untrack-file')?.remove();row.querySelectorAll('input,button').forEach(input=>{input.disabled=true;if(input.type==='radio')input.checked=false;});}
                }else if(row)row.dataset.saveError=item.error||'Update was rejected';
            }
            el('Progress').textContent=`${result.results.length-failed.length} location(s) saved or resolved; ${failed.length} not saved.${failed.length?' '+[...new Set(failed.map(item=>item.error))].join('; '):' You can move to the next page.'}`;
            el('Progress').classList.toggle('is-error',failed.length>0);
            if(failed.length)el('Progress').scrollIntoView?.({block:'center',behavior:'smooth'});
            return selectedLocations().length===0;
        }catch(error){el('Progress').textContent=error.message;return false;}finally{saving=false;updateFinish();}
    }
    el('Apply').addEventListener('click',()=>saveChanges());
    el('Rows').addEventListener('change',event=>{updateFinish();const row=event.target.closest('.installed-recovery-row');if(row)delete row.dataset.saveError;});
    document.addEventListener('click',async event=>{
        const locate=event.target.closest('.downloaded-locate-file');if(locate){await openFile(locate);return;}
        const button=event.target.closest('.downloaded-untrack-file');if(!button)return;
        if(!skipUntrack&&!await confirmAction('Remove this download record?','This removes this file/version’s installed tracking, download history and review data. The model card and physical files will be kept. Other installed copies keep their shared history.',[button.dataset.path],true))return;
        button.disabled=true;
        const feedback=button.closest('.installed-recovery-row')?.querySelector('.recovery-row-feedback')||button.parentElement.querySelector('[role=status]');
        try{if(button.closest('.installed-recovery-row')){const response=await post(`/api/installed-recovery/${jobId}/forget`,{confirm:true,review_ids:[Number(button.dataset.reviewId)]});if(!response.results[0].success)throw new Error(response.results[0].error);}else await post(`/api/downloaded-library/${button.dataset.reviewId}/uninstall`,{confirm:true,path:button.dataset.path});if(feedback)feedback.textContent='Download record removed. Model card and physical files kept.';changed();
            const recoveryRow=button.closest('.installed-recovery-row');if(recoveryRow){recoveryRow.dataset.status='forgotten';const label=recoveryRow.querySelector('.recovery-row-status');if(label)label.textContent='Download record removed';recoveryRow.querySelectorAll('input').forEach(input=>input.disabled=true);}
            const file=button.closest('.downloaded-file');file?.querySelector('.downloaded-delete-file')?.remove();
            const group=button.closest('.downloaded-group');if(group&&!group.querySelector('.downloaded-delete-file')){const card=group.querySelector('.model-card');if(card){card.dataset.downloaded='false';card.querySelector('.card-download-state')?.remove();}}
            button.remove();
        }catch(error){if(feedback)feedback.textContent=error.message;button.disabled=false;}
    });
});
