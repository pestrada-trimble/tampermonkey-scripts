// ==UserScript==
// @name         Auto set destination branch to develop on pull requests
// @version      0.1
// @description  Auto set destination branch to develop on pull requests
// @author       Pedro Estrada
// @match        https://github.com/e-buildernoc/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const mainBranch = 'main';
    const devBranch = 'develop';
    const urlPaths = location.pathname.split('/');
    const compareLocation = urlPaths.indexOf('compare') + 1;

    function extractBranches() {
        return urlPaths.slice(compareLocation, urlPaths.length).join('/');
    }

    function getBranches() {
        if (compareLocation === 0) return null;

        if (location.pathname.indexOf('...') > -1) {
            return extractBranches();
        }

        const endsWithSlash = location.pathname.endsWith('/') ? 1 : 0;

        if (compareLocation + endsWithSlash < urlPaths.length) {
            const branch = extractBranches();
            return `${mainBranch}...${branch}`;
        }

        return null;
    }

    function checkUrlPath() {
        const branches = getBranches();

        console.log(branches);

        if (branches == null) return;

        const [dest, source] = branches.split('...');

        if (dest === mainBranch && source !== devBranch && source !== mainBranch) {
            const newBranches = `${devBranch}...${source}`;
            const newUrlPath = urlPaths.slice(0, compareLocation).join('/') + '/' + newBranches;

            location.pathname = newUrlPath;
        }
    }

    document.addEventListener('pjax:end', checkUrlPath);

    checkUrlPath();
})();
