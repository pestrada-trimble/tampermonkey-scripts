// ==UserScript==
// @name         Concourse Pipeline Filter
// @version      0.1
// @description  Filter jobs on a Concourse pipeline page by branch/group name to reduce clutter
// @author       Pedro Estrada
// @match        https://concourse-ci.e-builder.net/*
// @match        https://concourse-ci-tools.e-builder.net/*
// @icon         https://concourse-ci.e-builder.net/public/images/favicon.png
// @run-at       document-end
// ==/UserScript==

(() => {
    'use strict';

    const STORAGE_PREFIX = 'concourse-pipeline-filter:';

    // Only run on pipeline overview pages (not job/build/resource detail pages)
    function isPipelineView() {
        const m = location.pathname.match(/^\/teams\/[^/]+\/pipelines\/[^/]+\/?$/);
        return !!m;
    }

    function storageKey() {
        return STORAGE_PREFIX + location.pathname;
    }

    function parseQuery(raw) {
        // Comma-separated OR terms. Prefix `-` to exclude. Case-insensitive substring match.
        const terms = raw.split(',').map(s => s.trim()).filter(Boolean);
        const includes = [];
        const excludes = [];
        for (const t of terms) {
            if (t.startsWith('-') && t.length > 1) {
                excludes.push(t.slice(1).toLowerCase());
            } else {
                includes.push(t.toLowerCase());
            }
        }
        return { includes, excludes };
    }

    function matches(jobId, { includes, excludes }) {
        const id = jobId.toLowerCase();
        if (excludes.some(e => id.includes(e))) return false;
        if (includes.length === 0) return true;
        return includes.some(i => id.includes(i));
    }

    // Tracks the viewBox we last fit to. If Concourse re-renders the SVG (auto-refresh),
    // viewBox changes externally and we know to re-fit. User pan/zoom only mutates the
    // inner <g>'s transform, not the viewBox, so it doesn't trigger a re-fit.
    let lastFittedViewBox = null;

    function applyFilter(query, forceFit = false) {
        const parsed = parseQuery(query);
        const hasFilter = !!query.trim();

        // Collect every job node with its jobId, bbox, and initial "matched by name" status.
        // Each job has two <g id="node-job-..."> elements (animation wrapper + job).
        // Resource input/output nodes share the job-id prefix (e.g. node-job-foo-input-bar).
        // We stash the *original* transform on first encounter so subsequent applyFilter
        // calls can restore from it before re-applying moves.
        const nodeInfos = [];
        for (const node of document.querySelectorAll('g[id^="node-job-"]')) {
            if (!node.dataset.origTransform) {
                node.dataset.origTransform = node.getAttribute('transform') || '';
            }
            const origTransform = node.dataset.origTransform;
            const jobId = node.id.slice('node-job-'.length);
            const matched = matches(jobId, parsed);
            const isResource = node.classList.contains('resource');
            const t = origTransform.match(/translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
            const rect = node.querySelector(':scope > a > rect, :scope > rect');
            let bbox = null;
            let origX = 0, origY = 0;
            // Always read the original origin from the transform — the animation-wrapper
            // sibling shares the job's id and transform but has no <rect>, and we still
            // need to move it in lockstep with the job node.
            if (t) {
                origX = parseFloat(t[1]);
                origY = parseFloat(t[2]);
            }
            if (t && rect) {
                const w = parseFloat(rect.getAttribute('width')) || 0;
                const h = parseFloat(rect.getAttribute('height')) || 50;
                bbox = { x1: origX, y1: origY, x2: origX + w, y2: origY + h };
            }
            nodeInfos.push({ node, jobId, matched, isResource, bbox, origX, origY, origTransform });
        }

        // Find which node a given edge endpoint sits on. Edges connect at a node's
        // left edge (x == x1) or right edge (x == x2), at some Y inside [y1, y2].
        const TOL = 0.5;
        function findNodeAt(x, y) {
            for (const info of nodeInfos) {
                const b = info.bbox;
                if (!b) continue;
                const onPort = Math.abs(x - b.x1) < TOL || Math.abs(x - b.x2) < TOL;
                if (onPort && y >= b.y1 - TOL && y <= b.y2 + TOL) return info;
            }
            return null;
        }

        // Resolve each edge to its source and target nodes (when identifiable).
        // Edge path format: M{x},{y} C{x1},{y1} {x2},{y2} {x},{y}
        // Always resolve from the *original* `d` — we mutate the live `d` at the bottom
        // of this function to shift endpoints with moved nodes, and reading the mutated
        // value here would fail to locate nodes whose edges we shifted on the prior tick.
        const edgeInfos = [];
        for (const edge of document.querySelectorAll('g.edge')) {
            const path = edge.querySelector('path');
            if (!path) continue;
            if (!path.dataset.origD) path.dataset.origD = path.getAttribute('d') || '';
            const m = path.dataset.origD.match(/^M\s*([-\d.]+)\s*,\s*([-\d.]+).*?([-\d.]+)\s*,\s*([-\d.]+)\s*$/);
            if (!m) continue;
            const sx = parseFloat(m[1]), sy = parseFloat(m[2]);
            const ex = parseFloat(m[3]), ey = parseFloat(m[4]);
            edgeInfos.push({ edge, sInfo: findNodeAt(sx, sy), eInfo: findNodeAt(ex, ey) });
        }

        // Visibility is tracked by jobId so the animation-wrapper and job-node siblings
        // (same id, different bbox) get the same fate.
        const keepIds = new Set();
        for (const info of nodeInfos) if (info.matched) keepIds.add(info.jobId);

        // One-hop expansion: a *resource* node connected to a kept node is also kept,
        // because the resource is still in use. Limited to resources so we don't pull
        // unrelated jobs from other branches back into view.
        for (const { sInfo, eInfo } of edgeInfos) {
            if (!sInfo || !eInfo) continue;
            if (keepIds.has(sInfo.jobId) && eInfo.isResource) keepIds.add(eInfo.jobId);
            if (keepIds.has(eInfo.jobId) && sInfo.isResource) keepIds.add(sInfo.jobId);
        }

        // Compute the matched-cluster Y range so we can move far-away kept resources
        // (e.g. develop_src at Y=0) into the cluster's neighborhood.
        let mMinY = Infinity, mMaxY = -Infinity;
        for (const info of nodeInfos) {
            if (info.matched && info.bbox) {
                if (info.bbox.y1 < mMinY) mMinY = info.bbox.y1;
                if (info.bbox.y2 > mMaxY) mMaxY = info.bbox.y2;
            }
        }

        const deltaByJobId = new Map();

        // Compress vertical gaps between matched rows. Concourse's dagre layout leaves
        // big empty bands between matched jobs when their original neighbors are filtered
        // out (e.g. one matched job lands hundreds of px below the cluster). We collect
        // the unique row Ys, sort them, and rewrite any gap larger than MAX_GAP down to
        // MAX_GAP — preserving relative order while collapsing the empty space.
        const MAX_GAP = 58;
        const yShift = new Map(); // origY -> compressed Y
        if (hasFilter && isFinite(mMinY)) {
            const rows = [...new Set(
                nodeInfos.filter(i => i.matched && i.bbox).map(i => i.bbox.y1)
            )].sort((a, b) => a - b);
            let prevOrig = rows[0];
            let prevNew = rows[0];
            yShift.set(prevOrig, prevNew);
            for (let i = 1; i < rows.length; i++) {
                const gap = rows[i] - prevOrig;
                const newGap = Math.min(gap, MAX_GAP);
                const newY = prevNew + newGap;
                yShift.set(rows[i], newY);
                prevOrig = rows[i];
                prevNew = newY;
            }
            for (const info of nodeInfos) {
                if (!info.matched || !info.bbox) continue;
                const delta = yShift.get(info.bbox.y1) - info.bbox.y1;
                if (delta !== 0) deltaByJobId.set(info.jobId, delta);
            }
            // Update mMaxY to reflect the compressed cluster so expanded-resource placement
            // (above the cluster) still anchors correctly; mMinY is unchanged because the
            // topmost row is the compression anchor.
            mMaxY = -Infinity;
            for (const info of nodeInfos) {
                if (info.matched && info.bbox) {
                    const newY2 = (yShift.get(info.bbox.y1) ?? info.bbox.y1) + (info.bbox.y2 - info.bbox.y1);
                    if (newY2 > mMaxY) mMaxY = newY2;
                }
            }
        }

        // For each expanded (kept-but-not-matched) resource whose original Y is outside
        // the matched cluster's Y range, compute a deltaY that stacks it just above the
        // cluster. Deduped by jobId so animation-wrapper + job-node siblings move together.
        if (hasFilter && isFinite(mMinY)) {
            const seen = new Set();
            const toMove = [];
            for (const info of nodeInfos) {
                if (info.matched || !keepIds.has(info.jobId) || !info.bbox) continue;
                if (seen.has(info.jobId)) continue;
                seen.add(info.jobId);
                if (info.bbox.y2 < mMinY || info.bbox.y1 > mMaxY) {
                    toMove.push(info);
                }
            }
            // Stack upward from just above the cluster.
            let placeY = mMinY - 30;
            for (const info of toMove) {
                const h = info.bbox.y2 - info.bbox.y1;
                deltaByJobId.set(info.jobId, placeY - info.origY);
                placeY -= h + 10;
            }
        }

        // Apply node transforms: restore originals everywhere, then translate movers.
        const fitBoxes = [];
        for (const info of nodeInfos) {
            const visible = keepIds.has(info.jobId);
            info.node.style.display = visible ? '' : 'none';
            const delta = deltaByJobId.get(info.jobId);
            if (delta !== undefined) {
                info.node.setAttribute('transform', `translate(${info.origX}, ${info.origY + delta})`);
            } else {
                info.node.setAttribute('transform', info.origTransform);
            }
            if (info.bbox && visible) {
                const dy = delta || 0;
                if (info.matched || delta !== undefined) {
                    fitBoxes.push([info.bbox.x1, info.bbox.y1 + dy, info.bbox.x2, info.bbox.y2 + dy]);
                }
            }
        }

        // Edges: restore original `d`, then shift endpoints (and the matching curve control
        // points) by the deltas of the nodes they're attached to. Hide if either endpoint
        // lands on a hidden node, OR if it originates from a "virtual" coordinate (no
        // resolvable node — e.g. trigger-false aggregators at (225, 40)) while a filter is
        // active. We always hide all such edges during filtering to avoid layout flicker
        // when the cluster bounds shift between keystrokes.
        for (const { edge, sInfo, eInfo } of edgeInfos) {
            const path = edge.querySelector('path');
            if (path) {
                if (!path.dataset.origD) path.dataset.origD = path.getAttribute('d') || '';
                const origD = path.dataset.origD;
                const sDy = sInfo ? (deltaByJobId.get(sInfo.jobId) || 0) : 0;
                const eDy = eInfo ? (deltaByJobId.get(eInfo.jobId) || 0) : 0;
                if (sDy === 0 && eDy === 0) {
                    if (path.getAttribute('d') !== origD) path.setAttribute('d', origD);
                } else {
                    const m = origD.match(/^M\s*([-\d.]+)\s*,\s*([-\d.]+)\s+C\s*([-\d.]+)\s*,\s*([-\d.]+)\s+([-\d.]+)\s*,\s*([-\d.]+)\s+([-\d.]+)\s*,\s*([-\d.]+)\s*$/);
                    if (m) {
                        const sx = m[1], sy = parseFloat(m[2]) + sDy;
                        const cx1 = m[3], cy1 = parseFloat(m[4]) + sDy;
                        const cx2 = m[5], cy2 = parseFloat(m[6]) + eDy;
                        const ex = m[7], ey = parseFloat(m[8]) + eDy;
                        path.setAttribute('d', `M${sx},${sy} C${cx1},${cy1} ${cx2},${cy2} ${ex},${ey}`);
                    }
                }
            }
            const sHidden = sInfo && !keepIds.has(sInfo.jobId);
            const eHidden = eInfo && !keepIds.has(eInfo.jobId);
            const virtualEndpoint = hasFilter && (!sInfo || !eInfo);
            edge.style.display = (sHidden || eHidden || virtualEndpoint) ? 'none' : '';
        }

        // Hide the pipeline-level fail-triangle indicator when filtering.
        for (const tri of document.querySelectorAll('g.fail-triangle-node')) {
            tri.style.display = hasFilter ? 'none' : '';
        }

        // Auto-fit the viewBox to the visible bounding box when a filter is active.
        const svg = document.querySelector('svg.pipeline-graph');
        if (!svg) return;
        if (hasFilter && fitBoxes.length) {
            const currentVb = svg.getAttribute('viewBox');
            if (forceFit || currentVb !== lastFittedViewBox) {
                fitTo(svg, fitBoxes);
                lastFittedViewBox = svg.getAttribute('viewBox');
            }
        } else {
            lastFittedViewBox = null;
        }
    }

    function fitTo(svg, boxes) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x1, y1, x2, y2] of boxes) {
            if (x1 < minX) minX = x1;
            if (y1 < minY) minY = y1;
            if (x2 > maxX) maxX = x2;
            if (y2 > maxY) maxY = y2;
        }
        // Reset Concourse's pan/zoom transform on the inner <g> so viewBox alone defines the view.
        const innerG = svg.querySelector(':scope > g');
        if (innerG) innerG.setAttribute('transform', '');

        const padX = 80;
        const padY = 40;
        const vbX = minX - padX;
        const vbY = minY - padY;
        const vbW = (maxX - minX) + 2 * padX;
        const vbH = (maxY - minY) + 2 * padY;
        svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
    }

    function getSaved() {
        try { return localStorage.getItem(storageKey()) || ''; }
        catch { return ''; }
    }

    function saveQuery(q) {
        try {
            if (q) localStorage.setItem(storageKey(), q);
            else localStorage.removeItem(storageKey());
        } catch {}
    }

    function injectUi() {
        if (document.getElementById('pipeline-filter-input')) return;
        const topBar = document.getElementById('top-bar-app');
        if (!topBar) return;

        if (!document.getElementById('pipeline-filter-style')) {
            const style = document.createElement('style');
            style.id = 'pipeline-filter-style';
            style.textContent = `
                #pipeline-filter-input::placeholder {
                    color: rgb(140, 140, 140);
                    opacity: 1;
                    font-style: normal;
                }
                #pipeline-filter-clear:hover {
                    opacity: 0.7;
                }
            `;
            document.head.appendChild(style);
        }

        const wrapper = document.createElement('div');
        wrapper.id = 'pipeline-filter-wrapper';
        wrapper.style.cssText = [
            'position:absolute',
            'left:50%',
            'top:50%',
            'transform:translate(-50%,-50%)',
            'z-index:1',
        ].join(';');

        const input = document.createElement('input');
        input.id = 'pipeline-filter-input';
        input.type = 'text';
        input.placeholder = 'filter jobs by name (e.g. plat-8099, -mend-scan)';
        input.autocomplete = 'off';
        input.value = getSaved();
        // Styling mirrors the dashboard's #search-input-field.
        input.style.cssText = [
            'background-color:rgb(38, 38, 38)',
            'background-image:url("/public/images/ic-search-grey.svg")',
            'background-repeat:no-repeat',
            'background-position:12px 8px',
            'height:32px',
            'min-height:32px',
            'padding:0 42px',
            'border:1px solid rgb(102, 102, 102)',
            'color:rgb(255, 255, 255)',
            'font-size:12px',
            'font-family:Inconsolata, monospace',
            'outline:0',
            'width:337px',
            'box-sizing:border-box',
        ].join(';');

        // Clear button — shown only when the input has a value. Uses Concourse's own
        // close icon to match the dashboard's styling.
        const clearBtn = document.createElement('button');
        clearBtn.id = 'pipeline-filter-clear';
        clearBtn.type = 'button';
        clearBtn.setAttribute('aria-label', 'clear filter');
        clearBtn.style.cssText = [
            'position:absolute',
            'right:0',
            'top:50%',
            'transform:translateY(-50%)',
            'background-image:url("/public/images/ic-close-white.svg")',
            'background-repeat:no-repeat',
            'background-position:10px 10px',
            'background-color:transparent',
            'border:0',
            'color:transparent',
            'padding:17px',
            'cursor:pointer',
        ].join(';');

        function refreshState() {
            const hasText = input.value.length > 0;
            clearBtn.style.display = hasText ? '' : 'none';
            input.style.borderColor = hasText ? 'rgb(198, 198, 198)' : 'rgb(102, 102, 102)';
            input.style.backgroundImage = hasText
                ? 'url("/public/images/ic-search-white.svg")'
                : 'url("/public/images/ic-search-grey.svg")';
        }

        function clear() {
            input.value = '';
            saveQuery('');
            applyFilter('', true);
            refreshState();
        }

        input.addEventListener('input', () => {
            saveQuery(input.value);
            applyFilter(input.value, true);
            refreshState();
        });

        input.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                clear();
                input.blur();
            }
        });

        clearBtn.addEventListener('click', () => {
            clear();
            input.focus();
        });

        wrapper.appendChild(input);
        wrapper.appendChild(clearBtn);
        topBar.appendChild(wrapper);
        refreshState();
    }

    function tick() {
        if (!isPipelineView()) {
            const w = document.getElementById('pipeline-filter-wrapper');
            if (w) w.remove();
            return;
        }
        injectUi();
        const input = document.getElementById('pipeline-filter-input');
        if (input) applyFilter(input.value);
    }

    // Concourse re-renders the SVG frequently (30s refresh, animations, etc.) so re-apply often.
    const observer = new MutationObserver(() => tick());
    observer.observe(document.body, { childList: true, subtree: true });

    // Re-evaluate on SPA navigation.
    history.pushState = new Proxy(history.pushState, {
        apply: (target, thisArg, argList) => {
            const r = target.apply(thisArg, argList);
            setTimeout(tick, 50);
            return r;
        },
    });
    window.addEventListener('popstate', () => setTimeout(tick, 50));

    tick();
})();
