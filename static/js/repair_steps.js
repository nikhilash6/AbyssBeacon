window.abyssRepairStep=(dialog,active)=>{
 if(!dialog)return;dialog.dataset.currentStep=String(active);
 for(const h of dialog.querySelectorAll('h3.repair-step')){
  const step=Number(h.dataset.step);h.dataset.state=step<active?'Complete':step===active?'Current':'';
 }
};
document.addEventListener('DOMContentLoaded',()=>{
 for(const id of ['localInventoryDialog','installedRecoveryDialog','extensionRepairDialog']){
  const dialog=document.getElementById(id);if(!dialog)continue;
  const decorate=()=>{for(const h of dialog.querySelectorAll('h3')){
   const match=h.textContent.match(/^([123]) · (.*)$/);if(!match)continue;
   h.classList.add('repair-step');h.dataset.step=match[1];h.textContent=match[2];
   h.setAttribute('aria-label',`Step ${match[1]}: ${match[2]}`);
  }window.abyssRepairStep(dialog,Number(dialog.dataset.currentStep||1));};
  decorate();new MutationObserver(decorate).observe(dialog,{childList:true,subtree:true,characterData:true});
 }
});
