document.addEventListener('DOMContentLoaded', () => {
    const maintenance = document.getElementById('libraryMaintenance');
    if (!maintenance) return;
    document.getElementById('libraryMaintenanceOpen').onclick = () => maintenance.showModal();
    maintenance.querySelector('[data-close-maintenance]').onclick = () => maintenance.close();
    maintenance.querySelectorAll('.maintenance-actions button').forEach(button => {
        button.addEventListener('click', () => maintenance.close());
    });
    ['localInventoryDialog','installedRecoveryDialog','extensionRepairDialog'].forEach(id => {
        const dialog = document.getElementById(id);
        const back = document.createElement('button');
        back.type = 'button'; back.textContent = '← Library maintenance';
        back.onclick = () => {
            // Existing close handlers handle any pending changes.
            const close = dialog.querySelector('.downloaded-recovery-heading button');
            close?.click();
            if (!dialog.open) maintenance.showModal();
        };
        dialog.prepend(back);
    });
    document.addEventListener('click', event => {
        if (!event.target.closest('[data-open-import]')) return;
        document.getElementById('installedRecoveryClose')?.click();
        document.getElementById('localImportOpen').click();
    });
    if (new URLSearchParams(location.search).get('add') === '1') document.getElementById('localImportOpen').click();
    const notice = document.getElementById('browserDownloadNotice');
    if (notice) {
        const key = 'abyss-browser-download-reminder';
        let state = {};
        try {state = JSON.parse(localStorage.getItem(key) || '{}');} catch (_) {}
        const id = Number(notice.dataset.requestId);
        notice.hidden = Date.now() < (state.until || 0) || id <= (state.dismissed || 0);
        notice.querySelectorAll('[data-dismiss-browser]').forEach(button => {
            button.onclick = () => {
                try {localStorage.setItem(key, JSON.stringify({until:Date.now()+Number(button.dataset.dismissBrowser)*86400000,dismissed:id}));} catch (_) {}
                notice.hidden = true;
            };
        });
    }
});
