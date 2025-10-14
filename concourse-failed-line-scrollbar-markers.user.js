// ==UserScript==
// @name         Concourse Failed Line Scrollbar Markers
// @version      0.2
// @description  Concourse Failed Line Scrollbar Markers
// @author       Pedro Estrada
// @match        https://concourse-ci.e-builder.net/*
// @match        https://concourse-ci-tools.e-builder.net/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @grant        none
// ==/UserScript==

(() => {
    const REGEX = /Failed\s.*?\[\<?\s*(?:\d+\s*m\s+\d+\s*s|\d+\s*(?:ms|s|m))\]/; // single-row test
    const DEBUG = true; // set true for minimal debug
    const RESCAN_DELAY = 50; // ms
    const STYLE = `
        .tm-marker-rail{position:fixed;top:16%;right:15px;width:6px;height:83%;z-index:2147483647;pointer-events:none;font-size:0}
        .tm-marker-rail .tm-marker{position:absolute;left:0;right:0;height:4px;border-radius:2px;background:#ff375f;box-shadow:0 0 0 1px rgba(0,0,0,.35);cursor:pointer;pointer-events:auto;transition:background .15s ease}
        .tm-marker-rail .tm-marker:hover{background:#ff1744}
        tr.tm-fail-row {background:rgba(255,55,95,.18);outline:1px solid rgba(255,55,95,.45);border-radius:2px;padding:0 2px}
        #tm-fail-nav{display:inline-flex;align-items:center;gap:8px;margin-left:16px;font-size:14px}
        #tm-fail-nav button{background:transparent;border:1px solid #ccc;border-radius:4px;padding:2px 6px;cursor:pointer;transition:background .15s ease,border-color .15s ease;
        `;

    let rail, styleEl;
    const SCROLL_SELECTOR = '#build-body .steps';
    let pending = false;
    let scrollContainer = null;
    let lastRowCount = 0;

    function init() {
        styleEl = document.createElement('style');
        styleEl.textContent = STYLE;
        document.documentElement.appendChild(styleEl);
        rail = document.createElement('div');
        rail.className = 'tm-marker-rail';
        document.documentElement.appendChild(rail);
        const mo = new MutationObserver(onMutations);
        mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
        // const waitForScrollContainer = setInterval(() => {
        //     const sc = document.querySelector(SCROLL_SELECTOR);
        //     if (sc) {
        //         clearInterval(waitForScrollContainer);
        //         mo.observe(sc, { subtree: true, childList: true, characterData: true });
        //         scan();
        //     }
        // }, 100);
    }

    function onMutations(muts) {
        if (pending) return;
        for (const m of muts) {
            if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) return schedule(scan, RESCAN_DELAY);
            if (m.type === 'characterData') return schedule(scan, RESCAN_DELAY);
        }
    }

    function schedule(fn, delay) {
        if (pending) return; pending = true; setTimeout(() => { pending = false; fn(); }, delay);
    }

    function scan() {
        const rows = Array.from(document.querySelectorAll('tr'));
        scrollContainer = document.querySelector(SCROLL_SELECTOR);
        const failRows = [];
        rows.forEach(tr => {
            if (tr.classList.contains('tm-fail-row')) {
                if (REGEX.test(tr.textContent || '')) failRows.push(tr);
                return;
            }
            const text = tr.textContent || '';
            if (!REGEX.test(text)) return;
            tr.classList.add('tm-fail-row');
            failRows.push(tr);
        });
        if (failRows.length !== lastRowCount) {
            buildMarkers(failRows);
            lastRowCount = failRows.length;
        }
        if (failRows.length) {
            let headerNavEl = document.querySelector('#tm-fail-nav');
            if (headerNavEl) return; // already built
            dbg('Building header nav');

            const header = document.querySelector('#build-header');
            const firstChild = header.firstElementChild;
            headerNavEl = document.createElement('div');
            headerNavEl.id = 'tm-fail-nav';
            // headerNavEl.className = 'hidden';
            headerNavEl.innerHTML = `
                <span class="tm-fail-count" aria-live="polite">${failRows.length} fails</span>
                <button type="button" class="tm-fail-prev" aria-label="Previous failed test" title="Previous failed test (wrap)">▲</button>
                <span class="tm-fail-index" aria-live="polite"> ${1} / ${failRows.length}</span>
                <button type="button" class="tm-fail-next" aria-label="Next failed test" title="Next failed test (wrap)">▼</button>
            `;
            header.insertBefore(headerNavEl, firstChild.nextSibling);
        }
        dbg('Scan complete. Fail rows:', failRows.length);
    }

    function buildMarkers(rows) {
        const seen = new Set();
        rail.innerHTML = '';
        rows.forEach(tr => {
            const id = tr.id;
            if (!id || seen.has(id)) return; seen.add(id);
            const mk = document.createElement('div');
            mk.className = 'tm-marker';
            mk.dataset.anchorId = id;
            mk.title = 'Jump to failed line';
            mk.style.top = ((tr.getBoundingClientRect().top + document.querySelector('#build-body').scrollTop + window.scrollY) / scrollContainer.scrollHeight * 100) + '%';
            mk.addEventListener('click', () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            rail.appendChild(mk);
            dbg('Marker', id, 'topPx', top);
        });
    }

    function dbg(...args) { if (DEBUG) console.debug('[fail-markers]', ...args); }

    init();
})();
