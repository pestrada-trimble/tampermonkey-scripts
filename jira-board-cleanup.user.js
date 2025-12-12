// ==UserScript==
// @name         Jira Board Cleanup
// @namespace    https://github.com/pestrad
// @version      0.4
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

        const allColumns = $('div[role=presentation][data-component-selector]');
        allColumns.removeAttr('style');

        activeFilters.forEach(id => {
            $('div[data-testid="platform-board-kit.ui.board.scroll.board-scroll"] > section > div').css('width', 'calc(100vw - 60px)');

            switch (id) {
                case 614: // hide done & r4r
                    $(`${buildSelectorForColumn("Ready for Release")}, ${buildSelectorForColumn("Done")}`)
                        .attr('style', 'display: none !important;');
                    break;
                case 622: // hide requirements & backlog
                    $(`${buildSelectorForColumn("Requirements")}, ${buildSelectorForColumn("Backlog")}`)
                        .attr('style', 'display: none !important;');
                    break;
                case 1207: // hide done
                    $(`${buildSelectorForColumn("Done")}`)
                        .attr('style', 'display: none !important;');
                    break;
                default:
                    break;
            }
        });
    }

    applyCustomStyles(getActiveQuickFilters());
})();