document.addEventListener('DOMContentLoaded',()=>{
    initializeModal();initializeFullscreen();
    document.addEventListener('toggle',async event=>{
        const details=event.target;
        if(!details.matches?.('.downloaded-storage-path')||!details.open||details.dataset.checking==='true')return;
        const status=details.querySelector('.downloaded-location-status');if(!status)return;
        details.dataset.checking='true';status.textContent='Checking saved location…';
        try{
            const r=await fetch(`/api/downloaded-library/${details.dataset.locationReviewId}/location-status`,{cache:'no-store'}),data=await r.json();
            if(!r.ok||!data.success)throw new Error(data.error||'Unable to check path');
            status.textContent=({available:'File exists at the recorded location (identity not rechecked).',missing:'File not found at this location. Locate it or remove its download record if you know it was deleted.',unavailable:'Location unavailable. Check the drive connection before changing tracking.'})[data.state];
        }catch(e){status.textContent=e.message;}finally{delete details.dataset.checking;}
    },true);
    const repairMenu=document.getElementById('downloadedRepairMenu');
    repairMenu?.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{repairMenu.open=false;}));
    document.addEventListener('click',event=>{if(repairMenu?.open&&!repairMenu.contains(event.target))repairMenu.open=false;});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&repairMenu?.open){repairMenu.open=false;repairMenu.querySelector('summary')?.focus();}});
    const filters=document.querySelector('.downloaded-filters');
    let searchTimer,generation=0,displayGeneration=0,allOpen=null;
    const toggle=document.getElementById('fileInfoToggle');
    function syncFileToggle(){
        toggle.disabled=!document.querySelector('.downloaded-file');toggle.hidden=toggle.disabled;
        toggle.textContent=document.querySelector('.downloaded-file[open]')?'Collapse all file info':'Expand all file info';
    }
    toggle.onclick=()=>{
        allOpen=!document.querySelector('.downloaded-file[open]');
        document.querySelectorAll('.downloaded-file').forEach(row=>row.open=allOpen);
        syncFileToggle();
    };
    document.addEventListener('toggle',event=>{
        if(event.target.matches('.downloaded-file'))syncFileToggle();
    },true);
    const search=filters.querySelector('input[type=search]');
    async function updateResults(){
        clearTimeout(searchTimer);
        const current=++generation;
        const url=new URL(filters.action);
        url.search=new URLSearchParams(new FormData(filters)).toString();
        const pageUrl=url.href;
        url.searchParams.set('format','json');
        try{
            const response=await fetch(url,{cache:'no-store'});
            if(!response.ok)throw new Error('Unable to search downloads.');
            const result=await response.json();
            if(current!==generation)return;
            displayGeneration=current;grid.innerHTML=result.html;prepareRows(grid);syncFileToggle();
            history.replaceState(null,'',pageUrl);
            document.querySelector('.downloaded-title > span').textContent=result.total+' model group'+(result.total===1?'':'s');
            sentinel.dataset.nextPage=String(result.next_page);sentinel.dataset.hasMore=String(result.has_more);
            more.hidden=!result.has_more;status.textContent='';
            if(result.has_more)loadObserver?.observe(sentinel);else loadObserver?.unobserve(sentinel);
        }catch(error){if(current===generation)status.textContent=error.message;}
    }
    filters.addEventListener('submit',event=>{event.preventDefault();updateResults();});
    Array.from(filters.elements).filter(input=>input.matches('select,input[type=checkbox]')).forEach(input=>input.onchange=updateResults);
    search.oninput=()=>{++generation;clearTimeout(searchTimer);searchTimer=setTimeout(updateResults,400);};

    document.addEventListener('keydown',event=>{
        const card=event.target.closest('.downloaded-group .model-card');
        if(card&&event.target===card&&(event.key==='Enter'||event.key===' ')){event.preventDefault();card.click();}
    });
    document.addEventListener('click',event=>{
        const button=event.target.closest('[data-quick-review],[data-review-files]');if(!button)return;
        event.preventDefault();event.stopPropagation();
        const group=button.closest('.downloaded-group');
        if(button.hasAttribute('data-review-files')){group.querySelectorAll('.downloaded-file').forEach(file=>file.open=true);group.querySelector('.downloaded-files')?.scrollIntoView({block:'nearest'});return;}
        const form=[...group.querySelectorAll('.downloaded-edit')].find(f=>f.dataset.reviewId===button.dataset.quickReview);if(!form)return;
        form.closest('.downloaded-file').open=true;form.closest('.downloaded-review-editor').open=true;
        form.elements[button.dataset.reviewField]?.focus({preventScroll:true});form.scrollIntoView({block:'nearest'});
    });
    document.addEventListener('change', async event => {
        const select = event.target.closest('[data-state-id]');
        if (!select) return;
        select.disabled = true;
        const group = select.closest('.downloaded-group');
        const form = Array.from(group.querySelectorAll('.downloaded-edit')).find(item => item.dataset.reviewId === select.dataset.stateId);
        const status = form.closest('.downloaded-file').querySelector('.downloaded-file-actions [role=status]');
        try {
            const response = await fetch('/api/downloaded-library/' + select.dataset.stateId, {
                method: 'PATCH',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({review_state: select.value})
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || 'Unable to save review state');
            select.dataset.saved = select.value;
            status.textContent = 'Review saved';
        } catch (error) {
            select.value = select.dataset.saved;
            form.closest('.downloaded-file').open = true;
            status.textContent = error.message;
        } finally {
            select.disabled = false;
        }
    });
    document.addEventListener('submit',async event=>{
        const form=event.target.closest('.downloaded-edit');if(!form)return;
        event.preventDefault();const save=form.querySelector('button'),feedback=form.querySelector('[role=status]');save.disabled=true;feedback.textContent='Saving…';
        try{
            const payload={personal_tags:form.elements.personal_tags.value.split(',').map(t=>t.trim()).filter(Boolean)};
            const response=await fetch(`/api/downloaded-library/${form.dataset.reviewId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
            const result=await response.json();if(!response.ok||!result.success)throw new Error(result.error||'Unable to save');

            let tags=form.closest('.downloaded-file').querySelector('.downloaded-personal-tags');
            if(!tags){tags=document.createElement('p');tags.className='downloaded-personal-tags';form.closest('.downloaded-review-editor').before(tags);}
            tags.textContent=payload.personal_tags.filter(Boolean).join(' · ');
            const group=form.closest('.downloaded-group');
            for(const quick of group.querySelectorAll('[data-quick-review]')){
                if(quick.dataset.quickReview!==form.dataset.reviewId)continue;
                quick.textContent=payload.personal_tags.join(' · ')||'+ Tags';
                quick.title=payload.personal_tags.join(', ')||'Add personal tags';
            }
            feedback.textContent='Saved';
        }catch(error){feedback.textContent=error.message;}finally{save.disabled=false;}
    });
    document.addEventListener('click', async event => {
        const button = event.target.closest('[data-forget-review]');
        if (!button || button.disabled) return;
        const dialog = document.getElementById('forgetReviewDialog');
        if (dialog.open) return;
        const key = 'abyssbeacon.forgetReviewUntil';
        let skipUntil = 0;
        try { skipUntil = Number(localStorage.getItem(key)); } catch (_) {}
        let rememberChoice = false;
        if (!(Date.now() < skipUntil)) {
            const checkbox = document.getElementById('skipForgetReview');
            document.getElementById('forgetReviewFilename').textContent =
                button.closest('.downloaded-file').querySelector('[data-filename]').dataset.filename;
            checkbox.checked = false;
            dialog.returnValue = '';
            const closed = new Promise(resolve => dialog.addEventListener('close', resolve, {once:true}));
            dialog.showModal();
            await closed;
            if (dialog.returnValue !== 'forget') return;
            rememberChoice = checkbox.checked;
        }
        button.disabled = true;
        try {
            const response = await fetch('/api/downloaded-library/' + button.dataset.forgetReview + '/orphan-review', {method:'DELETE'});
            if (!response.ok) throw new Error((await response.json()).error);
            if (rememberChoice) {
                try { localStorage.setItem(key, String(Date.now() + 3600000)); } catch (_) {}
            }
            const group = button.closest('.downloaded-group');
            button.closest('.downloaded-file').remove();
            const remaining = group.querySelector('.downloaded-file');
            if (!remaining) {
                // Refresh counts, source choices, and the empty state after the final file.
                window.location.reload();
                return;
            }
            remaining.open = true;
            remaining.querySelector('summary').focus();
            syncFileToggle();
            // The newest file may have determined the group's page. Revisit page
            // boundaries on the next load; loadMore already skips visible groups.
            if (sentinel.dataset.hasMore === 'true') sentinel.dataset.nextPage = '1';
        } catch (error) {
            button.parentElement.querySelector('[role=status]').textContent = error.message;
            button.disabled = false;
        }
    });
    const copyFeedbackTimers=new WeakMap();
    document.addEventListener('click',async event=>{
        const button=event.target.closest('.downloaded-copy-name');if(!button)return;
        const name=String(button.dataset.filename||'').split(/[\\/]/).pop().replace(/\.[^.]+$/,'');
        const feedback=button.parentElement.querySelector('[role=status]');
        try{await navigator.clipboard.writeText(name);feedback.textContent='Name copied';clearTimeout(copyFeedbackTimers.get(feedback));copyFeedbackTimers.set(feedback,setTimeout(()=>{if(feedback.textContent==='Name copied')feedback.textContent='';},2500));}catch(_){feedback.textContent='Copy unavailable. Select and copy the filename manually.';}
    });
    function confirmFiles(preview){
        const dialog=document.getElementById('downloadedDeleteDialog'),list=document.getElementById('downloadedDeleteFiles');list.replaceChildren();
        for(const item of preview.files){const li=document.createElement('li');li.textContent=`${item.filename} — ${item.size_bytes.toLocaleString()} bytes\n${item.path}`;list.append(li);}
        document.getElementById('downloadedDeleteFolder').textContent=preview.folder?`The empty folder will also be removed: ${preview.folder}`:'Other folder contents will be kept.';
        const previous=document.activeElement;
        return new Promise(resolve=>{
            let accepted=false;
            document.getElementById('downloadedDeleteCancel').onclick=()=>dialog.close();
            document.getElementById('downloadedDeleteAccept').onclick=()=>{accepted=true;dialog.close();};
            dialog.addEventListener('close',()=>{previous?.focus();resolve(accepted);},{once:true});dialog.showModal();document.getElementById('downloadedDeleteCancel').focus();
        });
    }
    document.addEventListener('click',async event=>{
        const button=event.target.closest('.downloaded-delete-file');if(!button)return;
        const feedback=button.parentElement.querySelector('[role=status]');button.disabled=true;
        const url=`/api/downloaded-library/${button.dataset.reviewId}/local-file`;
        try{
            let response=await fetch(url,{cache:'no-store'}),preview=await response.json();
            if(!response.ok||!preview.success)throw new Error(preview.error||'Unable to preview deletion');
            if(!await confirmFiles(preview))return;
            response=await fetch(url,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:preview.token})});
            const result=await response.json();
            if(result.model_file_deleted){
                const group=button.closest('.downloaded-group');button.remove();
                feedback.textContent=result.success?'Local file deleted; review and history kept.':'Model file deleted; some companions could not be removed. '+(result.failed||[]).map(item=>`${item.path}: ${item.error}`).join('; ');
                if(!group.querySelector('.downloaded-delete-file')){const card=group.querySelector('.model-card');if(card){card.dataset.downloaded='false';card.querySelector('.card-download-state')?.remove();}}
            }else if(!response.ok||!result.success)throw new Error(result.error||'Deletion failed; tracking kept.');
        }catch(error){feedback.textContent=error.message;}finally{button.disabled=false;}
    });
    const observer='IntersectionObserver' in window?new IntersectionObserver(entries=>entries.forEach(({target,isIntersecting})=>{
        if(isIntersecting){if(!target.src)target.src=target.dataset.src;target.play()?.catch(()=>{});}else target.pause();
    }),{rootMargin:'100px'}):null;
    function prepareRows(root){
        if(allOpen!==null)root.querySelectorAll('.downloaded-file').forEach(row=>row.open=allOpen);
        root.querySelectorAll('.downloaded-file time').forEach(time=>{const date=new Date(time.dateTime);if(!Number.isNaN(date.getTime()))time.textContent='Completed '+date.toLocaleString();});
        root.querySelectorAll('.downloaded-group .model-card').forEach(card=>{card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label','Open '+(card.querySelector('h2')?.textContent.trim()||'model details'));});
        root.querySelectorAll('video.card-preview-video').forEach(video=>observer?.observe(video));
    }
    prepareRows(document);syncFileToggle();
    const grid=document.querySelector('.downloaded-grid'),sentinel=document.getElementById('downloadedLoadSentinel'),more=document.getElementById('downloadedLoadMore'),status=document.getElementById('downloadedLoadStatus');
    let loading=false,loadObserver;
    async function loadMore(){
        if(displayGeneration!==generation||loading||!sentinel||sentinel.dataset.hasMore!=='true')return;
        const current=generation;
        loading=true;if(more)more.disabled=true;if(status)status.textContent='Loading more downloads…';
        try{
            const url=new URL(window.location.href);url.searchParams.set('format','json');url.searchParams.set('page',sentinel.dataset.nextPage);
            const response=await fetch(url,{cache:'no-store'}),result=await response.json();
            if(!response.ok||!result.success)throw new Error(result.error||'Unable to load more');
            if(current!==generation)return;
            const fragment=document.createElement('template');fragment.innerHTML=result.html;
            for(const node of [...fragment.content.children]){
                const key=node.dataset.groupKey;
                if(key&&[...grid.children].some(existing=>existing.dataset.groupKey===key))node.remove();
            }
            prepareRows(fragment.content);grid.append(fragment.content);syncFileToggle();
            sentinel.dataset.nextPage=String(result.next_page);sentinel.dataset.hasMore=String(result.has_more);
            if(more)more.hidden=!result.has_more;if(status)status.textContent='';
            if(!result.has_more)loadObserver?.disconnect();else loadObserver?.observe(sentinel);
        }catch(error){if(status)status.textContent=error.message+' — use Load more to retry.';loadObserver?.unobserve(sentinel);}
        finally{loading=false;if(more)more.disabled=false;}
    }
    more?.addEventListener('click',loadMore);
    if(sentinel&&'IntersectionObserver' in window){loadObserver=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))loadMore();},{rootMargin:'700px 0px'});if(sentinel.dataset.hasMore==='true')loadObserver.observe(sentinel);}
    const top=document.getElementById('downloadedBackToTop');
    const updateTop=()=>{if(top)top.hidden=window.scrollY<700;};window.addEventListener('scroll',updateTop,{passive:true});updateTop();
    top?.addEventListener('click',()=>window.scrollTo({top:0,behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));
});
