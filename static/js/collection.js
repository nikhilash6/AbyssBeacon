document.addEventListener("DOMContentLoaded", () => {
    const search = document.getElementById("collectionFamilySearch");
    const count = document.getElementById("collectionSearchCount");
    const empty = document.getElementById("collectionSearchEmpty");
    const expandAll = document.getElementById("collectionExpandAll");
    const changesOnly = document.getElementById("collectionChangesOnly");
    const viewChanges = document.getElementById("collectionViewChanges");
    const alphaFilter = document.getElementById("collectionAlphaFilter");
    const searchLabel = document.querySelector(".collection-search-label");
    const searchRow = document.querySelector(".collection-search-row");
    const alphaButtons = Array.from(document.querySelectorAll(".collection-alpha-button"));
    const sortButtons = Array.from(document.querySelectorAll(".collection-sort-button"));
    const familyGrid = document.getElementById("collectionFamilyGrid");
    const cards = Array.from(document.querySelectorAll(".collection-child-card"));
    const originalOrder = new Map(cards.map((card, index) => [card, index]));
    let changedOnlyActive = false;
    let activeAlpha = "all";
    let activeSort = "alpha";

    const paging = JSON.parse(document.getElementById('collectionPaging').textContent);
    function navigate(changes) {
        const url = new URL(location.href);
        Object.entries(changes).forEach(([key, value]) => {
            if (value === '') url.searchParams.delete(key);
            else url.searchParams.set(key, value);
        });
        url.hash = 'collectionFamilyTools';
        location.assign(url);
    }
    function updateExpandAllState() {
        if (!expandAll) return;
        const open = cards.length > 0 && cards.every(card => card.open);
        expandAll.textContent = (open ? 'Collapse ' : 'Expand ') + (paging.total > 100 ? 'this page' : 'all');
        expandAll.disabled = !cards.length;
    }
    search?.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const query = search.value.trim();
        const key = 'collection-return-page-' + location.pathname;
        if (!paging.query && query) sessionStorage.setItem(key, String(paging.page));
        navigate({q: query, page: query ? 1 : (sessionStorage.getItem(key) || 1)});
    });
    document.getElementById('collectionSearchSubmit')?.addEventListener('click', () => {
        search.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    });
    search?.addEventListener('search', () => {
        if (!search.value) search.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    });
    alphaButtons.forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.alpha === paging.alpha));
        button.disabled = button.dataset.alpha !== 'all' && !paging.available.includes(button.dataset.alpha);
        button.onclick = () => navigate({alpha:button.dataset.alpha,page:1});
    });
    sortButtons.forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.sort === paging.sort));
        button.onclick = () => navigate({sort:button.dataset.sort,page:1});
    });
    changesOnly?.addEventListener('click', () => navigate({changed:paging.changed?'':'1',page:1}));
    if (changesOnly) changesOnly.textContent = paging.changed ? 'Show all' : 'Show changes';
    viewChanges?.addEventListener('click', () => navigate({changed:1,alpha:'all',page:1}));
    document.querySelectorAll('.collection-page-select').forEach(select => select.addEventListener('change', event => navigate({page:event.target.value})));
    expandAll?.addEventListener('click', () => {
        const open = !cards.every(card => card.open);
        cards.forEach(card => {card.open = open;});
        updateExpandAllState();
    });
    cards.forEach(card => card.addEventListener('toggle', updateExpandAllState));
    updateExpandAllState();

    document.querySelectorAll(".collection-family-favorite").forEach(button => {
        button.addEventListener("click", async event => {
            event.preventDefault();
            event.stopPropagation();
            if(button.disabled) return;

            const current = button.getAttribute("aria-pressed") === "true";
            const desired = !current;
            button.disabled = true;
            try{
                const response = await fetch(button.dataset.favoriteUrl, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({favorite: desired}),
                });
                const payload = await response.json().catch(() => ({}));
                if(!response.ok || payload.success !== true){
                    throw new Error(payload.error || "Could not update favorite");
                }
                // Back and the feed snapshot can both restore pre-edit cards.
                try { sessionStorage.setItem("abyss_feed_favorites_dirty", "1"); } catch (_) {}
                button.setAttribute("aria-pressed", desired ? "true" : "false");
                button.classList.toggle("is-favorite", desired);
                button.textContent = desired ? "★" : "☆";
                const subject = button.dataset.subject || "family";
                button.title = desired ? `Remove ${subject} from favorites` : `Favorite this ${subject}`;
            }catch(error){
                console.error("Collection family favorite failed:", error);
                button.title = "Could not update favorite";
            }finally{
                button.disabled = false;
            }
        });

        // Clicking the star should never toggle the surrounding <details> card.
        button.addEventListener("mousedown", event => event.stopPropagation());
    });
});

// Keep Collection downloads inside the AbyssBeacon page. Local installs feed
// the shared Download Manager; browser downloads use a hidden frame so the
// browser receives the file without replacing this page with route JSON.
document.addEventListener("DOMContentLoaded", () => {
    const downloads = Array.from(document.querySelectorAll(
        "a.collection-download, a.collection-repository-download"
    ));

    function browserDownload(link){
        const frame = document.createElement("iframe");
        frame.hidden = true;
        frame.title = "Collection download";
        frame.src = link.href;
        document.body.appendChild(frame);
        window.setTimeout(() => frame.remove(), 120000);
    }

    downloads.forEach(link => {
        link.addEventListener("click", async event => {
            event.preventDefault();
            event.stopPropagation();
            if(link.dataset.installing === "true") return;

            const repositoryAsset = link.classList.contains("collection-repository-download");
            const behavior = String(window.userPreferences?.download_behavior || "browser").toLowerCase();
            if(repositoryAsset || behavior !== "local"){
                browserDownload(link);
                return;
            }

            const original = link.textContent;
            link.dataset.installing = "true";
            link.textContent = "…";
            try{
                const url = new URL(link.href);
                const options = link.closest('.collection-file-row')?.querySelector('.collection-install-options');
                if (options) {
                    const type = options.querySelector('select').value;
                    const folder = options.querySelector('input').value.trim();
                    if (type) url.searchParams.set('install_category', type);
                    if (folder) url.searchParams.set('install_folder', folder);
                    if (type === 'AbyssBeacon-Other') url.searchParams.set('allow_other','1');
                    options.querySelector('[role=status]').textContent = '';
                }
                const response = await fetch(url, {headers:{"Accept":"application/json"}});
                const raw = await response.text();
                let payload = {};
                try{ payload = raw ? JSON.parse(raw) : {}; }catch(_){ }
                if(!response.ok || payload.success !== true){
                    const error = new Error(payload.message || payload.error || raw || `Download failed (HTTP ${response.status})`);
                    error.payload = payload;
                    throw error;
                }
                if(payload.existing_partial === true || payload.already_active === true){
                    link.textContent = original;
                    document.getElementById("downloadHistoryButton")?.click();
                    return;
                }
                link.textContent = "✓";
                link.title = `Installed: ${payload.path || payload.folder || "local library"}`;
            }catch(error){
                const message = String(error?.message || "");
                const options = link.closest('.collection-file-row')?.querySelector('.collection-install-options');
                if (options) {
                    options.open = true;
                    options.querySelector('[role=status]').textContent = message;
                }
                const requestMayStillBeRunning = (
                    error instanceof TypeError
                    || /networkerror|failed to fetch|load failed/i.test(message)
                );
                link.textContent = requestMayStillBeRunning ? original : "!";
                link.title = requestMayStillBeRunning
                    ? "Download request sent. Check Download Manager for status."
                    : (message || "Download failed");
                if(error.payload?.restricted === true){
                    document.getElementById("downloadHistoryButton")?.click();
                }
            }finally{
                delete link.dataset.installing;
            }
        });
    });
});

// Nested repository READMEs can carry the model-specific description and
// usage notes for one safetensors file. Load the exact document only when the
// user asks for it, then keep it inside the Collection page.
document.addEventListener("DOMContentLoaded", () => {
    const overlay = document.getElementById("collectionReadmeOverlay");
    const closeButton = document.getElementById("collectionReadmeClose");
    const title = document.getElementById("collectionReadmeTitle");
    const path = document.getElementById("collectionReadmePath");
    const status = document.getElementById("collectionReadmeStatus");
    const content = document.getElementById("collectionReadmeContent");
    const source = document.getElementById("collectionReadmeSource");
    if(!overlay || !content) return;

    const cache = new Map();
    let readmeGeneration = 0;

    function closeViewer(){
        readmeGeneration++;
        overlay.classList.remove("open");
        overlay.setAttribute("aria-hidden", "true");
        document.body.classList.remove("collection-readme-open");
    }

    function openViewer(button){
        const generation = ++readmeGeneration;
        const url = String(button.dataset.readmeUrl || "").trim();
        const readmePath = String(button.dataset.readmePath || "README.md").trim();
        if(!url) return;

        overlay.classList.add("open");
        overlay.setAttribute("aria-hidden", "false");
        document.body.classList.add("collection-readme-open");
        if(title) title.textContent = readmePath.split("/").slice(-2).join(" / ") || "README";
        if(path) path.textContent = readmePath;
        if(status) status.textContent = "Loading README…";
        content.textContent = "";
        if(source){
            source.hidden = true;
            source.removeAttribute("href");
        }

        const load = cache.has(url)
            ? Promise.resolve(cache.get(url))
            : fetch(url, {headers:{"Accept":"application/json"}})
                .then(async response => {
                    const payload = await response.json().catch(() => ({}));
                    if(!response.ok || payload.success !== true){
                        const error = new Error(payload.error || `README request failed (HTTP ${response.status})`);
                        error.payload = payload;
                        throw error;
                    }
                    cache.set(url, payload);
                    return payload;
                });

        load.then(payload => {
            if(generation !== readmeGeneration) return;
            window.modelRadarRenderReadme(content,payload);
            if(status){
                status.textContent = payload.truncated
                    ? "This very large README was shortened for the in-page viewer."
                    : "";
            }
            if(source && payload.source_url){
                source.href = payload.source_url;
                source.hidden = false;
            }
        }).catch(error => {
            if(generation !== readmeGeneration) return;
            content.textContent = error.message || "Unable to load this README.";
            if(status) status.textContent = "README unavailable";
            const sourceUrl = error.payload?.source_url;
            if(source && sourceUrl){
                source.href = sourceUrl;
                source.hidden = false;
            }
        });
    }

    document.querySelectorAll(".collection-readme-open").forEach(button => {
        button.addEventListener("click", () => openViewer(button));
    });
    closeButton?.addEventListener("click", closeViewer);
    overlay.addEventListener("click", event => {
        if(event.target === overlay) closeViewer();
    });
    document.addEventListener("keydown", event => {
        if(event.key === "Escape" && overlay.classList.contains("open")) closeViewer();
    });
});

// Collection pages are full-page views, so their reload control can use the
// same source-aware backend reload as normal model detail and then rebuild the
// page from the freshly stored repository snapshot.
document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("collectionReloadButton");
    const status = document.getElementById("collectionReloadStatus");
    if(!button) return;

    button.addEventListener("click", async () => {
        if(button.dataset.refreshing === "true") return;
        const reloadUrl = String(button.dataset.reloadUrl || "").trim();
        if(!reloadUrl) return;

        const originalText = button.textContent;
        button.dataset.refreshing = "true";
        button.disabled = true;
        button.textContent = "Reloading…";
        if(status) status.textContent = "Refreshing repository metadata, files, and media…";

        try{
            const response = await fetch(reloadUrl, {
                method: "POST",
                headers: {"Accept": "application/json"},
            });
            const raw = await response.text();
            let payload = {};
            try{ payload = raw ? JSON.parse(raw) : {}; }catch(_){ }

            if(!response.ok || payload.success !== true){
                throw new Error(payload.error || payload.message || raw || `Reload failed (HTTP ${response.status})`);
            }

            if(status) status.textContent = payload.message || "Collection reloaded.";
            // A real navigation (rather than DOM patching) guarantees title,
            // family grouping, favorites, and preview media all come from the
            // same newly persisted source snapshot.
            window.setTimeout(() => window.location.reload(), 220);
        }catch(error){
            console.error("Collection reload failed:", error);
            if(status) status.textContent = error.message || "Unable to reload Collection.";
            button.disabled = false;
            button.textContent = originalText;
            delete button.dataset.refreshing;
        }
    });
});

// Collection media deliberately reuses the same gallery.js/fullscreen.js
// implementation as an ordinary model card. The page shows 10 thumbnails at
// a time, while the viewer receives the entire repository media list.
document.addEventListener("DOMContentLoaded", () => {
    const overlay = document.getElementById("collectionMediaOverlay");
    const detail = overlay?.querySelector(".collection-media-detail");
    const close = document.getElementById("collectionMediaClose");
    const strip = document.getElementById("collectionMediaStrip");
    const pagePrev = document.getElementById("collectionMediaPagePrev");
    const pageNext = document.getElementById("collectionMediaPageNext");
    const pageStatus = document.getElementById("collectionMediaPageStatus");
    const firstPage = document.getElementById("collectionMediaFirstPage");
    const lastPage = document.getElementById("collectionMediaLastPage");
    const pageNumbers = document.getElementById("collectionMediaPageNumbers");
    const viewerModelButton = document.getElementById("collectionMediaModelButton");
    if(!overlay || !detail) return;

    const collectionRestricted = String(document.body.dataset.accessStatus || "").toLowerCase() === "gated";

    function markPreviewUnavailable(image){
        if(!image) return;
        const host = image.closest(".collection-media-item, .collection-file-preview");
        if(!host || host.classList.contains("is-unavailable")) return;
        host.classList.add("is-unavailable");
        host.dataset.restricted = collectionRestricted ? "true" : "false";
        image.hidden = true;

        let fallback = host.querySelector(".collection-media-fallback, .collection-file-preview-fallback");
        if(!fallback){
            fallback = document.createElement("span");
            fallback.className = host.classList.contains("collection-media-item")
                ? "collection-media-fallback"
                : "collection-file-preview-fallback";
            host.appendChild(fallback);
        }
        fallback.textContent = collectionRestricted ? "🔒 Preview restricted" : "Preview unavailable";
        fallback.setAttribute("aria-hidden", "false");

        // Do not open the media viewer on a URL the browser has already proved
        // it cannot display. A sibling View model control, when present, stays
        // active so the user can still jump directly to the model file.
        host.disabled = true;
        host.title = collectionRestricted
            ? "Preview is restricted by the source"
            : "Preview is unavailable";
    }

    function bindPreviewFallback(image){
        if(!image || image.dataset.collectionFallbackBound === "true") return;
        image.dataset.collectionFallbackBound = "true";
        image.addEventListener("error", () => markPreviewUnavailable(image), {once: true});
        if(image.complete && image.naturalWidth === 0) markPreviewUnavailable(image);
    }

    let mediaData = [];
    try{
        mediaData = JSON.parse(detail.querySelector(".media-data-json")?.textContent || "[]") || [];
    }catch(_){
        mediaData = [];
    }
    if(!mediaData.length) return;

    const PAGE_SIZE = 10;
    let mediaPage = 0;

    function mediaItem(index){
        return mediaData[index] || {};
    }

    function closeViewer(){
        overlay.classList.remove("open");
        overlay.setAttribute("aria-hidden", "true");
        document.body.classList.remove("collection-media-open");
        detail.querySelectorAll("video").forEach(video => {
            try{ video.pause(); }catch(_){ }
        });
    }

    function openViewer(index){
        const safeIndex = Math.max(0, Math.min(mediaData.length - 1, Number.parseInt(index, 10) || 0));
        overlay.classList.add("open");
        overlay.setAttribute("aria-hidden", "false");
        document.body.classList.add("collection-media-open");
        detail.dispatchEvent(new CustomEvent("modelradar:gallery-show", {
            detail: {index: safeIndex},
        }));
    }

    function hasModelMatch(item){
        return !!String(item?._collection_file_dom_id || "").trim();
    }

    function focusMatchedFile(index){
        const item = mediaItem(index);
        const familyDomId = String(item._collection_family_dom_id || "").trim();
        const fileDomId = String(item._collection_file_dom_id || "").trim();
        if(!familyDomId || !fileDomId) return;

        const search = document.getElementById("collectionFamilySearch");
        if(search && search.value){
            search.value = "";
            search.dispatchEvent(new Event("input", {bubbles: true}));
        }

        const family = document.getElementById(familyDomId);
        const row = document.getElementById(fileDomId);
        if(!family || !row) return;

        family.hidden = false;
        family.open = true;
        closeViewer();

        document.querySelectorAll(".collection-file-row.is-focused").forEach(node => node.classList.remove("is-focused"));
        row.classList.add("is-focused");
        try{ history.replaceState(null, "", `#${fileDomId}`); }catch(_){ }

        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => row.scrollIntoView({behavior: "smooth", block: "center"}));
        });
        window.setTimeout(() => row.classList.remove("is-focused"), 3200);
    }

    function buildMediaCard(index){
        const item = mediaItem(index);
        const card = document.createElement("div");
        card.className = "collection-media-card";
        card.dataset.mediaIndex = String(index);

        const mediaButton = document.createElement("button");
        mediaButton.type = "button";
        mediaButton.className = "collection-media-item";
        mediaButton.dataset.mediaIndex = String(index);
        mediaButton.title = `Open ${item.filename || `Preview ${index + 1}`} in the AbyssBeacon media viewer`;
        mediaButton.setAttribute("aria-label", `Open ${item.filename || `preview ${index + 1}`} in the media viewer`);

        const isVideo = String(item.type || "").toLowerCase() === "video";
        const image = document.createElement(isVideo ? "video" : "img");
        if(isVideo){
            image.src = item.url || "";
            image.preload = "metadata";
            image.muted = true;
            image.playsInline = true;
            if(item.thumbnail && item.thumbnail !== item.url) image.poster = item.thumbnail;
            image.setAttribute("aria-label", item.filename || `Video ${index + 1}`);
        }else{
            image.src = item.thumbnail || item.url || "";
            image.alt = item.filename || `Preview ${index + 1}`;
            image.loading = "lazy";
            image.referrerPolicy = "no-referrer";
            bindPreviewFallback(image);
        }

        const fallback = document.createElement("span");
        fallback.className = "collection-media-fallback";
        fallback.setAttribute("aria-hidden", "true");

        const hint = document.createElement("span");
        hint.className = "collection-media-open-hint";
        hint.textContent = isVideo ? "Play video" : "View media";
        mediaButton.append(image, fallback, hint);
        card.appendChild(mediaButton);

        if(hasModelMatch(item)){
            const modelButton = document.createElement("button");
            modelButton.type = "button";
            modelButton.className = "collection-media-model-link";
            modelButton.dataset.mediaIndex = String(index);
            modelButton.title = `Open ${item._collection_file_name || "the matching model file"}`;
            modelButton.textContent = "View model";
            card.appendChild(modelButton);
        }
        return card;
    }

    function renderMediaPage(){
        if(!strip) return;
        const pageCount = Math.max(1, Math.ceil(mediaData.length / PAGE_SIZE));
        mediaPage = Math.max(0, Math.min(mediaPage, pageCount - 1));
        const start = mediaPage * PAGE_SIZE;
        const end = Math.min(mediaData.length, start + PAGE_SIZE);
        const fragment = document.createDocumentFragment();
        for(let index = start; index < end; index += 1){
            fragment.appendChild(buildMediaCard(index));
        }
        strip.replaceChildren(fragment);
        if(pageStatus) pageStatus.textContent = `Page ${mediaPage + 1} of ${pageCount} · ${mediaData.length} previews`;
        if(pagePrev) pagePrev.disabled = mediaPage <= 0;
        if(pageNext) pageNext.disabled = mediaPage >= pageCount - 1;
        if(firstPage){
            firstPage.hidden = mediaPage < 5;
            firstPage.disabled = mediaPage <= 0;
        }
        if(lastPage){
            lastPage.hidden = mediaPage >= pageCount - 1;
            lastPage.disabled = mediaPage >= pageCount - 1;
        }

        if(pageNumbers){
            const visiblePageCount = Math.min(9, pageCount);
            const pagesOnEachSide = Math.floor(visiblePageCount / 2);
            const latestWindowStart = Math.max(0, pageCount - visiblePageCount);
            const windowStart = Math.min(
                Math.max(0, mediaPage - pagesOnEachSide),
                latestWindowStart,
            );
            const windowEnd = Math.min(pageCount, windowStart + visiblePageCount);
            const pageFragment = document.createDocumentFragment();
            for(let pageIndex = windowStart; pageIndex < windowEnd; pageIndex += 1){
                const pageButton = document.createElement("button");
                pageButton.type = "button";
                pageButton.dataset.pageIndex = String(pageIndex);
                pageButton.textContent = String(pageIndex + 1);
                pageButton.title = `Go to preview page ${pageIndex + 1}`;
                pageButton.setAttribute("aria-label", `Go to preview page ${pageIndex + 1}`);
                if(pageIndex === mediaPage){
                    pageButton.classList.add("is-current");
                    pageButton.setAttribute("aria-current", "page");
                }
                pageFragment.appendChild(pageButton);
            }
            pageNumbers.replaceChildren(pageFragment);
        }
    }

    function updateViewerModelButton(index){
        if(!viewerModelButton) return;
        const item = mediaItem(index);
        const matched = hasModelMatch(item);
        viewerModelButton.hidden = !matched;
        viewerModelButton.dataset.mediaIndex = matched ? String(index) : "";
        if(matched){
            viewerModelButton.title = `Open ${item._collection_file_name || "the matching model file"}`;
        }
    }

    // Listen before gallery initialization so every image change, including the
    // first one, can update the Collection-specific View model action.
    detail.addEventListener("modelradar:gallery-change", event => {
        const index = Number.parseInt(event.detail?.index, 10);
        if(Number.isFinite(index)) updateViewerModelButton(index);
    });

    if(typeof initializeGallery === "function") initializeGallery(detail);
    if(typeof initializeFullscreen === "function") initializeFullscreen();

    renderMediaPage();

    strip?.addEventListener("click", event => {
        const modelButton = event.target.closest(".collection-media-model-link[data-media-index]");
        if(modelButton){
            event.preventDefault();
            event.stopPropagation();
            focusMatchedFile(Number.parseInt(modelButton.dataset.mediaIndex || "0", 10));
            return;
        }
        const mediaButton = event.target.closest(".collection-media-item[data-media-index]");
        if(mediaButton){
            openViewer(Number.parseInt(mediaButton.dataset.mediaIndex || "0", 10));
        }
    });

    document.querySelectorAll(".collection-file-preview[data-media-index]").forEach(button => {
        bindPreviewFallback(button.querySelector("img"));
        button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            openViewer(Number.parseInt(button.dataset.mediaIndex || "0", 10));
        });
    });

    viewerModelButton?.addEventListener("click", () => {
        const index = Number.parseInt(viewerModelButton.dataset.mediaIndex || "", 10);
        if(Number.isFinite(index)) focusMatchedFile(index);
    });

    pagePrev?.addEventListener("click", () => {
        if(mediaPage <= 0) return;
        mediaPage -= 1;
        renderMediaPage();
    });
    pageNext?.addEventListener("click", () => {
        const pageCount = Math.max(1, Math.ceil(mediaData.length / PAGE_SIZE));
        if(mediaPage >= pageCount - 1) return;
        mediaPage += 1;
        renderMediaPage();
    });
    firstPage?.addEventListener("click", () => {
        if(mediaPage <= 0) return;
        mediaPage = 0;
        renderMediaPage();
    });
    lastPage?.addEventListener("click", () => {
        const pageCount = Math.max(1, Math.ceil(mediaData.length / PAGE_SIZE));
        if(mediaPage >= pageCount - 1) return;
        mediaPage = pageCount - 1;
        renderMediaPage();
    });
    pageNumbers?.addEventListener("click", event => {
        const button = event.target.closest("button[data-page-index]");
        if(!button) return;
        const pageIndex = Number.parseInt(button.dataset.pageIndex || "", 10);
        if(!Number.isFinite(pageIndex) || pageIndex === mediaPage) return;
        mediaPage = pageIndex;
        renderMediaPage();
    });

    close?.addEventListener("click", closeViewer);
    overlay.addEventListener("click", event => {
        if(event.target === overlay) closeViewer();
    });
    document.addEventListener("keydown", event => {
        if(event.key === "Escape" && overlay.classList.contains("open")){
            const fullscreen = document.getElementById("imageOverlay");
            if(fullscreen?.classList.contains("open")) return;
            closeViewer();
        }
    });
});


// Match the main feed's unobtrusive back-to-top control on long Collection pages.
document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("collectionBackToTop");
    if(!button) return;
    const update = () => button.classList.toggle("visible", window.scrollY > 700);
    window.addEventListener("scroll", update, {passive: true});
    button.addEventListener("click", () => window.scrollTo({top: 0, behavior: "smooth"}));
    update();
});

document.addEventListener("click", async event => {
    const button = event.target.closest(".collection-remove");
    if (!button || button.disabled) return;
    button.disabled = true;
    const status = button.parentElement.querySelector("[role=status]");
    const url = "/api/downloaded-library/" + button.dataset.review + "/local-file";
    try {
        const preview = await (await fetch(url, {cache:"no-store"})).json();
        if (!preview.success) throw new Error(preview.error || "Unable to preview deletion.");
        const paths = preview.files.map(file => file.path);
        if (preview.folder) paths.push("Empty folder: " + preview.folder);
        if (!window.confirm("Delete these local files?\n\n" + paths.join("\n"))) return;
        const result = await (await fetch(url, {method:"DELETE", headers:{"Content-Type":"application/json"},body:JSON.stringify({token:preview.token})})).json();
        if (!result.success) throw new Error(result.error || "Deletion was incomplete. Refresh to check installed files.");
        location.reload();
    } catch (error) {
        status.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});
