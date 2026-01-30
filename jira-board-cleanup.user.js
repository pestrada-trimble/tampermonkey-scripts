// ==UserScript==
// @name         Jira Board Cleanup
// @namespace    https://github.com/pestrad
// @version      0.5
// @description  Hide specific columns on Jira boards based on active quick filters.
// @author       pestrad
// @match        https://*.atlassian.net/*
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const QUICK_FILTERS = new Set([
        614, // hide done & r4r
        622, // hide requirements & backlog
        1207 // hide done
    ]);

    function getActiveQuickFilters() {
        const urlParams = new URLSearchParams(window.location.search);
        const quickFilterParam = urlParams.getAll('quickFilter');
        if (!quickFilterParam) return new Set();

        return new Set(quickFilterParam.map(id => parseInt(id, 10)).filter(id => QUICK_FILTERS.has(id)));
    }

    const observer = new MutationObserver(() => {
        const currentQuickFilters = getActiveQuickFilters();
        applyCustomStyles(currentQuickFilters);
    });

    observer.observe(document, { subtree: true, childList: true });

    function buildSelectorForColumn(columnName) {
        return `div[role=presentation][data-component-selector]:has(div[title="${columnName}"])`;
    }

    function applyCustomStyles(activeFilters) {
        const $ = window.jQuery || window.$;
        if (!$) return;

        $('div[role=presentation][data-touched=true]').removeAttr('style');

        if (activeFilters.size === 0) return;

        // Set board width once
        $('div[data-testid="platform-board-kit.ui.board.scroll.board-scroll"] > section > div').css('width', 'calc(100vw - 60px)');

        const columnSelectors = [];
        const indexSelectors = [];
        const baseDragDropSelector = 'div[role=presentation]:not([data-component-selector])[data-drop-target-for-element=true]';

        if (activeFilters.has(622)) { // hide requirements & backlog
            columnSelectors.push(buildSelectorForColumn("Requirements"), buildSelectorForColumn("Backlog"));
            indexSelectors.push(`${baseDragDropSelector}:eq(0)`, `${baseDragDropSelector}:eq(1)`);
        }

        if (activeFilters.has(614)) { // hide done & r4r
            columnSelectors.push(buildSelectorForColumn("Ready for Release"), buildSelectorForColumn("Done"));
            indexSelectors.push(`${baseDragDropSelector}:last-child`, `${baseDragDropSelector}:nth-last-child(2)`);
        }

        if (activeFilters.has(1207)) { // hide done
            columnSelectors.push(buildSelectorForColumn("Done"));
            indexSelectors.push(`${baseDragDropSelector}:last-child`);
        }

        const allSelectors = [...columnSelectors, ...indexSelectors];
        if (allSelectors.length > 0) {
            $(allSelectors.join(', '))
                .attr('style', 'display: none !important;')
                .attr('data-touched', 'true');
        }
    }

    applyCustomStyles(getActiveQuickFilters());
})();