// Folder actions shared by Fix & Repair; never navigate to the model file itself.
window.abyssRepairPath=(path,endpoint)=>{
    const details=document.createElement('details');details.className='inventory-path repair-path';
    const summary=document.createElement('summary');summary.textContent='Show full path';
    const open=document.createElement('button');open.type='button';open.className='repair-path-open';open.textContent=path;open.title='Open containing folder';
    const copy=document.createElement('button');copy.type='button';copy.className='repair-path-copy';copy.textContent='Copy folder path';
    const feedback=document.createElement('span');feedback.setAttribute('role','status');let timer;
    const say=text=>{clearTimeout(timer);feedback.textContent=text;timer=setTimeout(()=>{feedback.textContent='';},3000);};
    open.onclick=async()=>{open.disabled=true;try{const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});const v=await r.json();if(!r.ok||!v.success)throw new Error(v.error||'Could not open folder');say('Folder opened');}catch(e){say(e.message);}finally{open.disabled=false;}};
    copy.onclick=async()=>{const cut=Math.max(path.lastIndexOf('/'),path.lastIndexOf('\\'));let folder=path.slice(0,cut);if(cut===0||/^[A-Za-z]:$/.test(folder))folder=path.slice(0,cut+1);try{await navigator.clipboard.writeText(folder);say('Folder path copied');}catch(e){say('Copy unavailable. Select and copy the path manually.');}};
    details.append(summary,open,copy,feedback);return details;
};
