document.addEventListener('DOMContentLoaded', () => {
    const dialog = document.getElementById('abyssHelp');
    if (!dialog) return;
    const library = document.body.classList.contains('downloaded-page');
    const guideForPage = library ? 'library' : 'setup';
    const shownGuides = new Set();
    const params = new URLSearchParams(location.search);
    let currentPage = 'home';
    let pendingSettingsReturn = null;
    let ignoredCloseEvents = 0;


    function show(page, scrollPosition = 0) {
        currentPage = page;
        dialog.querySelectorAll('[data-help-page]').forEach(node => { node.hidden = node.dataset.helpPage !== page; });
        dialog.querySelector('h2').textContent = ({home:'Help & getting started',setup:'Welcome to AbyssBeacon',library:'Your Downloaded library'})[page];
        if (page === 'setup' || page === 'library') shownGuides.add(page);
        if (!dialog.open) dialog.showModal();
        dialog.scrollTop = scrollPosition;
    }

    document.addEventListener('click', event => {
        const button = event.target.closest('[data-help-open],[data-help-guide],[data-help-close],[data-help-setting]');
        if (!button) return;
        if (button.hasAttribute('data-help-open')) show('home');
        else if (button.dataset.helpGuide) show(button.dataset.helpGuide);
        else if (button.dataset.helpSetting) {
            event.stopPropagation();
            const setting = button.dataset.helpSetting;
            // Opening a setup step is NOT completion. Resume the same guide
            // after the relevant settings interface closes.
            pendingSettingsReturn = {
                page: currentPage,
                scrollPosition: dialog.scrollTop,
                kind: setting === 'accounts' ? 'overlay' : 'options'
            };
            ignoredCloseEvents += 1;
            dialog.close();
            if (window.abyssOpenSetting) {
                if (window.abyssOpenSetting(setting) === false) {
                    const resume = pendingSettingsReturn;
                    pendingSettingsReturn = null;
                    show(resume.page, resume.scrollPosition);
                }
            } else {
                // Backwards-compatible path if navbar.js was not loaded.
                location.assign('/?setup=' + encodeURIComponent(setting));
            }
        } else dialog.close();
    }, true); // Capture before the Options panel stops propagation.

    // Acknowledgments belong to this AbyssBeacon install's settings.json,
    // not shared localStorage at 127.0.0.1:5000. Do not mark the guide seen
    // until the user actually closes it, and never for the Help home page.
    function acknowledgeShownGuides() {
        for (const guide of shownGuides) {
            fetch('/api/onboarding', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({guide}),
                keepalive: true
            }).catch(error => console.debug('Unable to save onboarding state:', error));
        }
        shownGuides.clear();
    }
    dialog.addEventListener('close', () => {
        if (ignoredCloseEvents > 0) {
            ignoredCloseEvents -= 1;
            return;
        }
        if (!pendingSettingsReturn) acknowledgeShownGuides();
    });

    window.addEventListener('abyss:guided-settings-closed', event => {
        const resume = pendingSettingsReturn;
        if (!resume || resume.kind !== event.detail?.kind) return;
        pendingSettingsReturn = null;
        show(resume.page, resume.scrollPosition);
    });

    const setting = params.get('setup');
    if (['downloads','retention','appearance','accounts'].includes(setting) && window.abyssOpenSetting?.(setting)) {
        const url = new URL(location.href);
        url.searchParams.delete('setup');
        history.replaceState(history.state, '', url);
        return;
    }
    // The /downloaded?add=1 deep-link must open the import dialog directly.
    if (params.has('add')) return;

    fetch('/api/onboarding', {cache:'no-store'})
        .then(response => {
            if (!response.ok) throw new Error('Unable to read onboarding state');
            return response.json();
        })
        .then(state => {
            // Avoid interrupting a modal the user already opened while fetching.
            if (!state[guideForPage] && !dialog.open) show(guideForPage);
        })
        .catch(error => console.debug('Unable to check onboarding state:', error));
});
