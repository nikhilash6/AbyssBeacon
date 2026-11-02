/* Version-specific CivitAI download authentication hints.
 * Only inspect visible uncertain feed cards and versions opened in the model
 * viewer. No rescans, API keys, credentials, or file downloads are involved.
 */
(function () {
    "use strict";
    // Fixed, trusted inline SVG: no model content or user input is inserted.
    const LOGIN_ICON = `<svg class="auth-login-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/><path d="M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6"/></svg>`;
    const results = new Map();
    const queued = [];
    const enqueued = new Set();
    let running = false;
    let requestCount = 0;
    const MAX_REQUESTS = 50; // Per browser page, to avoid catalog-wide API sweeps.
    const MIN_WAIT_MS = 900;
    let lastStarted = 0;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const keyFor = (modelId, versionId) => `${modelId}:${versionId}`;

    function updateFeedCard(card, value) {
        if (!card?.isConnected || card.dataset.access !== "downloadable") return;
        const icon = card.querySelector(".card-access-icon.is-auth-possible, .card-access-icon.is-auth-required, .card-access-icon.is-downloadable");
        if (!icon) return;
        icon.classList.remove("is-unknown", "is-gated", "is-auth-possible", "is-auth-required", "is-downloadable");
        if (value === true) {
            icon.classList.add("is-auth-required");
            icon.innerHTML = LOGIN_ICON;
            icon.setAttribute("aria-label", "CivitAI sign-in required for download");
            icon.dataset.tooltip = "Sign-in to download this CivitAI version";
        } else if (value === false) {
            icon.classList.add("is-downloadable");
            icon.textContent = "↓";
            icon.setAttribute("aria-label", "Downloadable (CivitAI reports no sign-in requirement)");
            icon.dataset.tooltip = "CivitAI reports no sign-in requirement";
        } else {
            icon.classList.add("is-unknown", "is-auth-possible");
            icon.textContent = "?";
            icon.setAttribute("aria-label", "CivitAI sign-in may be required");
            icon.dataset.tooltip = "CivitAI sign-in may be required";
        }
    }

    function updateVersion(group, value) {
        if (!group?.isConnected || group.dataset.accessStatus !== "downloadable") return;
        group.querySelectorAll(".download-signin-note").forEach(note => note.remove());
        if (value == null) return; // A failed lookup leaves the original uncertainty notice intact.
        if (value === false) return;
        const paragraph = document.createElement("p");
        paragraph.className = "download-signin-note required";
        paragraph.textContent = "Sign-in required for this version. Connect CivitAI in Source Accounts, or download through a signed-in browser.";
        group.querySelector(".download-version-heading")?.after(paragraph);
    }

    function updateSourceHeading(sourceGroup, value) {
        if (!sourceGroup?.isConnected || sourceGroup.dataset.accessStatus !== "downloadable") return;
        const title = sourceGroup.querySelector(".download-source-state");
        if (!title) return;
        title.classList.remove("signin-required", "signin-possible", "downloadable");
        if (value === true) {
            title.classList.add("signin-required");
            title.innerHTML = LOGIN_ICON + " Sign-in required";
        } else if (value === false) {
            title.classList.add("downloadable");
            title.textContent = "↓ Downloadable";
        }
    }

    function updateElements(modelId, versionId, value) {
        document.querySelectorAll(`.model-card[data-id="${modelId}"][data-civitai-auth-version="${versionId}"]`)
            .forEach(card => updateFeedCard(card, value));
        document.querySelectorAll(`.download-source-group[data-source="civitai"] .download-version-group[data-version-id="${versionId}"]`)
            .forEach(group => {
                updateVersion(group, value);
                const sourceGroup = group.closest(".download-source-group");
                const first = sourceGroup?.querySelector(".download-version-group[data-version-id]");
                if (group === first) updateSourceHeading(sourceGroup, value);
            });
    }

    function schedule(modelId, versionId, priority = false) {
        const model = Number(modelId), version = Number(versionId);
        if (!Number.isSafeInteger(model) || model <= 0 || !Number.isSafeInteger(version) || version <= 0) return;
        const key = keyFor(model, version);
        if (results.has(key)) {
            updateElements(model, version, results.get(key));
            return;
        }
        if (enqueued.has(key) || requestCount >= MAX_REQUESTS) return;
        enqueued.add(key);
        if (priority) queued.unshift({model, version, key});
        else queued.push({model, version, key});
        void drain();
    }

    async function drain() {
        if (running) return;
        running = true;
        try {
            while (queued.length && requestCount < MAX_REQUESTS) {
                const item = queued.shift();
                enqueued.delete(item.key);
                const pause = MIN_WAIT_MS - (Date.now() - lastStarted);
                if (pause > 0) await sleep(pause);
                lastStarted = Date.now();
                requestCount++;
                try {
                    const res = await fetch(`/api/civitai/version-auth/${item.model}/${item.version}`, {cache:"no-store"});
                    const data = await res.json();
                    if (res.status === 429 && data.result === "retry") {
                        // Avoid an infinite retry loop when another browser tab
                        // is also checking CivitAI. Leave uncertainty visible.
                        if ((item.retries || 0) < 4) {
                            item.retries = (item.retries || 0) + 1;
                            await sleep(Math.max(1200, Number(data.retry_after_ms) || 1200));
                            if (!enqueued.has(item.key)) {
                                queued.unshift(item);
                                enqueued.add(item.key);
                            }
                        }
                        continue;
                    }
                    if (res.ok && data.success) {
                        const value = data.result === "known" && typeof data.require_auth === "boolean"
                            ? data.require_auth : null;
                        results.set(item.key, value);
                        if (value !== null) updateElements(item.model, item.version, value);
                    }
                } catch (_) {
                    // Leave the honest '?' indicator when the API is unreachable.
                }
            }
        } finally { running = false; }
    }

    let observer = null;
    function observeCards(root = document) {
        if (!root?.querySelectorAll) return;
        const cards = root.querySelectorAll('.model-card[data-source="civitai"][data-civitai-auth-version]:not([data-civitai-auth-watched])');
        cards.forEach(card => {
            if (!card.dataset.civitaiAuthVersion) return;
            card.dataset.civitaiAuthWatched = "1";
            if (card.dataset.access !== "downloadable" || !card.querySelector(".is-auth-possible")) return;
            if (observer) observer.observe(card);
            else schedule(card.dataset.id, card.dataset.civitaiAuthVersion);
        });
    }

    function init() {
        if ("IntersectionObserver" in window) {
            observer = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        observer.unobserve(entry.target);
                        schedule(entry.target.dataset.id, entry.target.dataset.civitaiAuthVersion);
                    }
                });
            }, {rootMargin: "180px 0px", threshold: 0.01});
        }
        observeCards();
        const grid = document.querySelector(".feed-grid");
        if (grid && "MutationObserver" in window) {
            let pending = false;
            new MutationObserver(() => {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => { pending = false; observeCards(grid); });
            }).observe(grid, {childList: true, subtree: true});
        }
    }

    function checkModal(details) {
        if (!details) return;
        const modelId = details.querySelector(".model-detail")?.dataset.modelId || details.dataset.modelId;
        if (!modelId) return;
        const checkActive = () => {
            const groups = details.querySelectorAll('.download-source-group[data-source="civitai"]');
            groups.forEach(source => {
                if (source.dataset.accessStatus !== "downloadable") return;
                const list = [...source.querySelectorAll('.download-version-group[data-version-id]')]
                    .filter(group => group.dataset.accessStatus === "downloadable");
                if (!list.length) return;
                const selected = details.querySelector(".model-version-pill.selected");
                const selectedId = selected?.dataset.versionId;
                const active = list.find(group => selectedId && group.dataset.versionId === selectedId) || list[0];
                schedule(modelId, active.dataset.versionId, true);
            });
        };
        checkActive();
        details.addEventListener("modelradar:version", checkActive);
    }
    window.AbyssCivitaiAuthChecks = {init, checkModal};
})();
