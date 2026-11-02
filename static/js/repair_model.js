document.addEventListener('DOMContentLoaded',()=>{
 const overlay=document.getElementById('modelOverlay'),image=document.getElementById('imageOverlay');if(!overlay)return;
 const modal=document.createElement('dialog');modal.className='extension-repair-model-dialog';modal.setAttribute('aria-label','Model details');document.body.append(modal);
 let parent=null,focus=null,scroll=0,pending=false;
 window.abyssRepairModel=(id,dialog,button)=>{parent=dialog;focus=button;scroll=dialog.scrollTop;pending=true;dialog.addEventListener('close',()=>{pending=false;},{once:true});if(!window.modelRadarOpenModel?.(id,{downloads:false}))pending=false;};
 new MutationObserver(()=>{if(pending&&parent?.open&&overlay.classList.contains('open')){pending=false;modal.append(overlay);if(image)modal.append(image);modal.showModal();}else if(modal.open&&!overlay.classList.contains('open')){modal.close();document.body.append(overlay);if(image)document.body.append(image);if(parent)parent.scrollTop=scroll;focus?.focus({preventScroll:true});}}).observe(overlay,{attributes:true,attributeFilter:['class']});
 modal.addEventListener('cancel',e=>{e.preventDefault();if(image?.classList.contains('open'))document.getElementById('closeImage')?.click();else window.modelRadarCloseModelOverlay?.();});
});
