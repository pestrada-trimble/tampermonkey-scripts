// ==UserScript==
// @name         Auto set destination branch to develop on pull requests
// @version      0.2
// @description  Auto set destination branch to develop on pull requests
// @author       Pedro Estrada
// @match        https://github.com/e-buildernoc/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @grant        none
// ==/UserScript==

(function(history) {
    'use strict';

    const mainBranch = 'main';
    const devBranch = 'develop';

    var splitUrlPaths = (url) => new URL(url).pathname.split('/');

    var getCompareIndex = (urlPaths) => urlPaths.indexOf('compare') + 1;

    var getCompareIndexFromUrl = (url) => getCompareIndex(splitUrlPaths(url));

    var extractBranches = (url) => {
        let urlPaths = splitUrlPaths(url)
        return urlPaths.slice(getCompareIndex(urlPaths), urlPaths.length).join('/')
    }

    var getBranches = (url) => {
        let compareLocation = getCompareIndexFromUrl(url);
        if (compareLocation === 0) return null;

        const branch = extractBranches(url);

        if (url.indexOf('...') > -1) {
            return branch;
        }

        const endsWithSlash = url.endsWith('/') ? 1 : 0;

        if (compareLocation + endsWithSlash < splitUrlPaths(url).length) {
            return `${mainBranch}...${branch}`;
        }

        return null;
    }

    var checkUrlPath = (url) => {
        if (url == null) return;

        const branches = getBranches(url);
        let urlPaths = splitUrlPaths(url)
        let compareLocation = getCompareIndex(urlPaths);

        console.log(branches);

        if (branches == null) return;

        const [dest, source] = branches.split('...');

        if (dest === mainBranch && source !== devBranch && source !== mainBranch) {
            const newCompare = `${devBranch}...${source}`;
            const newUrlPath = urlPaths.slice(0, compareLocation).join('/') + '/' + newCompare;

            location.pathname = newUrlPath;
        }
    }


    history.pushState = new Proxy(history.pushState, {
        apply: (target, thisArg, argList) => {
            checkUrlPath(argList[2]);
            return target.apply(thisArg, argList);
        },
    });

    checkUrlPath(location.href);
})(window.history);
