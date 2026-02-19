// ==UserScript==
// @name         Concourse Failed Line Scrollbar Markers
// @version      0.9
// @description  Concourse Failed Line Scrollbar Markers
// @author       Pedro Estrada
// @match        https://concourse-ci.e-builder.net/*
// @match        https://concourse-ci-tools.e-builder.net/*
// @icon         https://concourse-ci.e-builder.net/public/images/favicon.png
// @grant        none
// ==/UserScript==

(() => {
    const REGEX = /^\d{2}:\d{2}:\d{2}\s+Failed\s(.*)?\[\<?\s*(?:\d+\s*m\s+\d+\s*s|\d+\s*(?:ms|s|m))\]$/; // single-row test
    const DEBUG = true; // set true for minimal debug
    const RESCAN_DELAY = 50; // ms
    const STYLE = `
        .tm-marker-rail {
            position:fixed;
            top:16%;
            right:15px;
            width:6px;
            height:83%;
            z-index:2147483647;
            pointer-events:none;
            font-size:0;
        }
        .tm-marker-rail .tm-marker{
            position:absolute;
            left:0;
            right:0;
            height:4px;
            border-radius:2px;
            background:#ff375f;
            box-shadow:0 0 0 1px rgba(0,0,0,.35);
            cursor:pointer;
            pointer-events:auto;
            transition:background .15s ease;
        }
        .tm-marker-rail .tm-marker:hover {
            background:#ff1744
        }
        tr.tm-fail-row {
            background:rgba(255,55,95,.18);
            outline:1px solid rgba(255,55,95,.45);
            border-radius:2px;
            padding:0 2px;
        }
        #tm-fail-nav, #tm-helper-nav {
            color:#fff;
            display:inline-flex;
            align-items:center;
            gap:12px;
            margin-left:16px;
            font-size:13px;
            font-weight:500;
            position:absolute;
            top:58px;
            right:300px;
            padding:10px 16px;
            border:none;
            border-radius:8px;
            background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            box-shadow:0 4px 16px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.1) inset;
            backdrop-filter:blur(10px);
            z-index:2147483647;
        }
        #tm-helper-nav {
            top:4px;
        }
        #tm-fail-nav .tm-fail-count{
            color:#ff375f;
            font-weight:600;
            text-shadow:0 0 8px rgba(255,55,95,.5);
        }
        #tm-fail-nav .tm-fail-index{
            color:#8892b0;
            font-variant-numeric:tabular-nums;
        }
        #tm-fail-nav button, #tm-helper-nav button {
            background:linear-gradient(135deg, #2a2a3e 0%, #1f2937 100%);
            border:1px solid rgba(255,255,255,.15);
            border-radius:6px;
            padding:6px 10px;
            color:#fff;
            cursor:pointer;
            transition:all .2s ease;
            font-size:12px;
            line-height:1;
            box-shadow:0 2px 4px rgba(0,0,0,.2);
        }
        #tm-fail-nav button:hover{
            background:linear-gradient(135deg, #ff375f 0%, #ff1744 100%);
            border-color:#ff375f;
            transform:translateY(-1px);
            box-shadow:0 4px 8px rgba(255,55,95,.3);
        }
        #tm-fail-nav button:active{
            transform:translateY(0);
        }
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
        const rows = document.querySelectorAll('tr');
        scrollContainer = document.querySelector(SCROLL_SELECTOR);
        const failRows = [];
        rows.forEach(tr => {
            const text = tr.textContent.trim() || '';
            if (!REGEX.test(text)) return;
            if (!tr.classList.contains('tm-fail-row')) {
                tr.classList.add('tm-fail-row');
            }
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

            addHeaderNav(failRows);
        }
        else {
            document.querySelector('#tm-fail-nav')?.remove();
        }
        dbg('Scan complete. Fail rows:', failRows.length);

        const failedBuildSteps = document.querySelectorAll('.build-step:has(div[data-step-state="failed"]) .header');

        if (failedBuildSteps.length) {
            let helperNavEl = document.querySelector('#tm-helper-nav');
            if (helperNavEl) return;
            dbg('Building helper nav');

            addHelperNav();
        }
        else {
            document.querySelector('#tm-helper-nav')?.remove();
        }
        dbg('Scan complete. Failed build steps:', failedBuildSteps.length);
    }

    function expandChildFailedBuildSteps(element) {
        const el = element;
        if (!el) return;
        setTimeout(() => {
            el.querySelectorAll(':scope > .step-body .build-step:has(div[data-step-state="failed"]):not(:has(.step-body)) .header').forEach(stepEl => {
                stepEl.click();
                expandChildFailedBuildSteps(stepEl.parentElement);
            });
        }, 150);
    }

    function addHelperNav() {
        const helperNavEl = document.createElement('div');
        helperNavEl.id = 'tm-helper-nav';
        helperNavEl.innerHTML = `
            <button type="button" class="tm-expand-failed-build-steps" aria-label="Expand failed build steps" title="Expand failed build steps">Expand Failed Build Steps</button>
        `;
        helperNavEl.querySelector('.tm-expand-failed-build-steps').addEventListener('click', () => {
            const failedBuildSteps = document.querySelectorAll('.build-step:has(div[data-step-state="failed"]):not(:has(.step-body)) .header');

            failedBuildSteps.forEach(stepEl => {
                stepEl.click();
                expandChildFailedBuildSteps(stepEl.parentElement); // .build-step
            });
        });
        document.querySelector('body').append(helperNavEl);
    }


    function addHeaderNav(failRows) {
        headerNavEl = document.createElement('div');
        headerNavEl.id = 'tm-fail-nav';
        // headerNavEl.className = 'hidden';
        headerNavEl.innerHTML = `
            <span class="tm-fail-count" aria-live="polite">${failRows.length} fails</span>
            <button type="button" class="tm-fail-prev" aria-label="Previous failed test" title="Previous failed test (wrap)">▲</button>
            <span class="tm-fail-index" aria-live="polite"> ${1} / ${failRows.length}</span>
            <button type="button" class="tm-fail-next" aria-label="Next failed test" title="Next failed test (wrap)">▼</button>
            <span>|</span>
            <button type="button" class="tm-copy-fail-tests" aria-label="Copy failed test names" title="Copy failed test names to clipboard">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-copy" viewBox="0 0 16 16">
                <path fill-rule="evenodd" d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1z"/>
            </svg>
            </button>
        `;
        let currentIndex = -1;
        const updateIndexDisplay = () => {
            const indexEl = headerNavEl.querySelector('.tm-fail-index');
            indexEl.textContent = ` ${currentIndex + 1} / ${failRows.length}`;
        };
        headerNavEl.querySelector('.tm-fail-prev').addEventListener('click', () => {
            if (currentIndex === -1) currentIndex = 0;
            currentIndex = (currentIndex - 1 + failRows.length) % failRows.length;
            failRows[currentIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
            updateIndexDisplay();
        });
        headerNavEl.querySelector('.tm-fail-next').addEventListener('click', () => {
            currentIndex = (currentIndex + 1) % failRows.length;
            failRows[currentIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
            updateIndexDisplay();
        });
        headerNavEl.querySelector('.tm-copy-fail-tests').addEventListener('click', () => {
            const failNames = failRows.map(tr => {
                const text = tr.textContent.trim().match(REGEX)?.[1]?.trim() || '';
                dbg('Copying failed test name:', text);
                return text;
            });
            navigator.clipboard.writeText(failNames.join('\n')).then(() => {
                dbg('Copied failed test names to clipboard');
            }).catch(err => {
                console.error('Failed to copy failed test names:', err);
            });
        });
        document.querySelector('body').append(headerNavEl);
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
