(() => {
    function selected(){return typeof selectedArchitectureValues === 'function' ? selectedArchitectureValues() : [];}
    window.modelRadarUpdateSeenAction=()=>{
        const scoped=selected().length>0;
        const direct=document.getElementById('clearNewLibraryButton'),menu=document.getElementById('markSeenMenu');
        if(direct)direct.hidden=scoped;
        if(menu){menu.hidden=!scoped;if(!scoped)menu.removeAttribute('open');}
    };
    window.modelRadarCardSeenStatus=card=>{
        let states;
        try{states=JSON.parse(card.dataset.architectureStates || '{}');}catch(_){return card.dataset.status;}
        let names=selected();
        if(!names.length){try{names=JSON.parse(card.dataset.notificationArchitectures || '[]');}catch(_){names=[];}}
        const entries=Object.entries(states), scope=names.map(v=>v.toLowerCase());
        if(!entries.length)return card.dataset.status;
        const relevant=entries.filter(([name])=>name.toLowerCase()!=='other' && (!scope.length || scope.includes(name.toLowerCase())));
        const status=relevant.some(([,seen])=>!seen) ? 'new' : 'seen';
        card.dataset.status=status;
        return status;
    };

    window.modelRadarUpdateEmptyState=()=>{
        const empty=document.getElementById('emptyFilterState'),feed=document.getElementById('modelFeed');
        if(!empty || !feed)return;
        const visible=document.querySelectorAll('.model-card:not(.hidden)').length;
        const waiting=feed.dataset.hasMore==='true' && !document.querySelector('.model-card');
        empty.classList.toggle('hidden',visible>0 || waiting);
        if(visible || waiting)return;
        const message=document.getElementById('emptyFeedMessage'),reset=document.getElementById('emptyResetFilters');
        const statuses=document.getElementById('emptyShowStatuses'),scan=document.getElementById('emptyScanAgain');
        if(!message || !reset || !statuses || !scan)return;
        reset.hidden=false;statuses.hidden=true;scan.hidden=true;scan.textContent='Scan again';
        if(Number(empty.dataset.libraryCount)===0){
            message.textContent='Your library is empty. Start your first scan to discover models.';
            reset.hidden=true;scan.hidden=false;scan.textContent='Start first scan';
            return;
        }
        const search=String(document.getElementById('modelSearch')?.value || '').trim();
        const terms=typeof getActiveSearchQueries==='function' ? getActiveSearchQueries() : [];
        const otherFilters=['modelTypeFilter','accessFilter','favoriteFilter','creatorFavoriteFilter','downloadStatusFilter'].some(id=>{
            const value=String(document.getElementById(id)?.value || '').toLowerCase();return value && value!=='all';
        }) || document.getElementById('showMediaOnly')?.checked;
        const sources=Array.from(document.querySelectorAll('input[name="sources"]'));
        const narrowedSources=sources.length && sources.some(input=>!input.checked);
        if(String(document.getElementById('statusFilter')?.value || '').toLowerCase()==='new' && !search && !terms.length && !otherFilters && !narrowedSources){
            const names=selected();
            message.textContent=names.length ? `No New models for ${names.join(', ')}.` : 'No New models in your library.';
            reset.hidden=true;statuses.hidden=false;scan.hidden=false;
        }else message.textContent='No models match your search and filters. Clear them to see more models.';
    };

    async function call(payload){
        const response=await fetch('/models/mark-seen',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        const data=await response.json();
        if(!response.ok || !data.success)throw new Error(data.error || 'Unable to clear New status.');
        return data;
    }

    async function refresh(){
        try{sessionStorage.removeItem('abyss_feed_snapshot_v2');}catch(_){}
        // Refresh counts from SQLite rather than subtracting states from cards:
        // a shared card may remain New for an unselected architecture.
        const response=await fetch('/feed/counts',{cache:'no-store'}), data=await response.json();
        const feed=document.getElementById('modelFeed');
        if(response.ok && data.success && feed){
            feed.dataset.totalNewCount=String(data.new);
            feed.dataset.totalModelCount=String(data.total);
            feed.dataset.totalUpdatedCount=String(data.updated);
        }
        window.modelRadarInvalidateSeenCounts?.();
        await window.modelRadarReconcileFeedWindow?.(0,{all:false});
        window.modelRadarFilterCards?.();
    }
    window.modelRadarRefreshSeenState=refresh;

    function confirm(scope){
        const dialog=document.getElementById('markSeenDialog');
        const text=document.getElementById('markSeenScope');
        if(!dialog || !text)throw new Error('Clear New controls are unavailable on this page.');
        const previous=document.activeElement;
        text.textContent=scope;
        return new Promise(resolve=>{
            let accepted=false;
            const accept=document.getElementById('markSeenAccept'),cancel=document.getElementById('markSeenCancel');
            accept.onclick=()=>{accepted=true;dialog.close();};
            cancel.onclick=()=>dialog.close();
            dialog.addEventListener('close',()=>{previous?.focus();resolve(accepted);},{once:true});
            dialog.showModal();cancel.focus();
        });
    }

    let busy=false;
    window.modelRadarRequestMarkSeen=async scope=>{
        if(busy)return;
        const architectures=scope==='architectures' ? selected() : [];
        document.getElementById('markSeenMenu')?.removeAttribute('open');
        if(scope==='architectures' && !architectures.length){
            scope='library';
        }
        busy=true;
        try{
            const payload={scope,architectures};
            const preview=await call({...payload,preview:true});
            if(!preview.changed){
                await refresh();
                await window.modelRadarAlert?.('There is no New status to clear in this scope.',{title:'Nothing to clear'});
                return;
            }
            const count=`${preview.changed} unique card${preview.changed===1?'':'s'}`;
            const message=(scope==='library' ? `Clear New status on ${count} across your entire library?` : `Clear New status for ${architectures.join(', ')} on ${count}?`)+
                (scope==='library' ? '\n\nThis includes New states for disabled architectures and Other. The navbar counts New only for selected feed architectures, or enabled architectures when unfiltered, and excludes Other.' : '\n\nOther architectures keep their current status.')+
                '\n\nMatching cards beyond the loaded feed are included. Search and other feed filters do not limit this action.';
            if(!await confirm(message))return;
            const result=await call(payload);
            try{await refresh();}catch(_){throw new Error('New status was cleared, but the feed could not refresh. Reload the page to see the result.');}
            if(typeof showModelRadarToast==='function')showModelRadarToast(`Cleared New on ${result.changed} unique card${result.changed===1?'':'s'}.`);
        }catch(error){
            await window.modelRadarAlert?.(error.message || 'Unable to clear New status.',{title:'Clear New failed'});
        }finally{busy=false;}
    };

    document.addEventListener('DOMContentLoaded',()=>{
        window.modelRadarUpdateSeenAction();
        document.getElementById('familyFilter')?.addEventListener('change',window.modelRadarUpdateSeenAction);
        document.addEventListener('keydown',event=>{if(event.key==='Escape')document.getElementById('markSeenMenu')?.removeAttribute('open');});
        document.addEventListener('click',event=>{
            const menu=document.getElementById('markSeenMenu');
            if(menu && !menu.contains(event.target))menu.removeAttribute('open');
        });
        document.getElementById('markArchitecturesSeen')?.addEventListener('click',()=>window.modelRadarRequestMarkSeen('architectures'));
        document.getElementById('markLibrarySeen')?.addEventListener('click',()=>window.modelRadarRequestMarkSeen('library'));
        document.getElementById('clearNewLibraryButton')?.addEventListener('click',()=>window.modelRadarRequestMarkSeen('library'));
        document.getElementById('emptyScanAgain')?.addEventListener('click',()=>document.getElementById('scanButton')?.click());
        document.getElementById('emptyShowStatuses')?.addEventListener('click',()=>{
            const status=document.getElementById('statusFilter');
            if(status){
                status.value='All';
                status.dispatchEvent(new Event('change',{bubbles:true}));
            }
        });
        const checkbox=document.getElementById('clearSeenBeforeScan');
        if(!checkbox)return;
        try{
            const saved=localStorage.getItem('abyssbeacon.clearSeenBeforeScan');
            if(saved!==null)checkbox.checked=saved==='1';
        }catch(_){}
        let revision=0;
        window.modelRadarPreviewPreScanSeen=async()=>{
            const current=++revision,node=document.getElementById('preScanSeenScope');
            if(!node)return;
            node.hidden=!checkbox.checked;
            if(!checkbox.checked){node.textContent='';return;}
            const architectures=Array.from(document.querySelectorAll('input[name="scanArchitecture"]:checked')).map(input=>input.value);
            if(!architectures.length){node.textContent='Select scan architectures to see the clearing scope.';return;}
            node.textContent='Counting existing New cards…';
            await new Promise(resolve=>setTimeout(resolve,120));
            if(current!==revision)return;
            try{
                const result=await call({scope:'architectures',architectures,preview:true});
                if(current===revision)node.textContent=`${architectures.join(', ')} · ${result.changed} unique existing cards. Other architectures keep their status.`;
            }catch(_){if(current===revision)node.textContent='Unable to count the scope. Try again before starting the scan.';}
        };
        checkbox.addEventListener('change',()=>{
            try{localStorage.setItem('abyssbeacon.clearSeenBeforeScan',checkbox.checked?'1':'0');}catch(_){}
            window.userPreferences=Object.assign({},window.userPreferences || {},{clear_seen_before_scan:checkbox.checked});
            fetch('/save_preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clear_seen_before_scan:checkbox.checked})}).catch(()=>{});
            window.modelRadarPreviewPreScanSeen();
        });
        document.querySelectorAll('input[name="scanArchitecture"]').forEach(input=>input.addEventListener('change',()=>window.modelRadarPreviewPreScanSeen()));
    });
})();
