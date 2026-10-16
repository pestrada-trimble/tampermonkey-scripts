// ==UserScript==
// @name         Auto set destination branch to develop on pull requests
// @version      0.5
// @description  Auto set destination branch to develop on pull requests
// @author       Pedro Estrada
// @match        https://github.com/e-buildernoc/*
// @observe      https://raw.githubusercontent.com/e-buildernoc/*/refs/heads/develop/*
// @shared-key   auto-set-destination-develop-cache
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function(history) {
    'use strict';

    const mainBranch = 'main';
    const devBranch = 'develop';

    // Shared key, declared with @shared-key above. The raw observer below also writes it.
    const CACHE_KEY = 'auto-set-destination-develop-cache';

    async function loadDevelopBranchCache() {
        try {
            return (await GM_getValue(CACHE_KEY, {})) || {};
        } catch (e) {
            console.warn('Auto-set-destination: failed to read cache', e);
            return {};
        }
    }

    async function saveDevelopBranchCache(cache) {
        try {
            await GM_setValue(CACHE_KEY, cache);
        } catch (e) {
            console.warn('Auto-set-destination: failed to persist cache', e);
        }
    }

    var splitUrlPaths = (url) => new URL(url, location.href).pathname.split('/');

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

    async function hasDevelopBranch(url) {
        const repoPath = new URL(url, location.href).pathname.split('/').slice(1, 3).join('/');
        const cache = await loadDevelopBranchCache();
        if (Object.prototype.hasOwnProperty.call(cache, repoPath)) {
            return cache[repoPath];
        }

        try {
            const response = await fetch(`/${repoPath}/tree/${devBranch}`, { method: 'HEAD' });
            const exists = response.status === 200;
            await saveDevelopBranchCache({ ...cache, [repoPath]: exists });
            return exists;
        } catch (e) {
            console.warn('Auto-set-destination: failed to check for develop branch', e);
            // If the check fails, don't redirect (safe default)
            return false;
        }
    }

    // Reads the GitHub page the user is already on (no requests). A signed-in develop page
    // with no 404 indicator proves develop exists, so the cache is set to true.
    function detectDevelopFromPage() {
        if (location.hostname !== 'github.com') return null;

        const parts = location.pathname.split('/'); // ['', org, repo, ...rest]
        const org = parts[1];
        const repo = parts[2];
        if (!org || !repo) return null;
        const repoPath = `${org}/${repo}`;
        const rest = parts.slice(3).join('/');

        const isDevelopPage = /^(blob\/develop\/|tree\/develop(\/|$))/.test(rest);
        if (!isDevelopPage) return null;

        const text = document.body ? document.body.innerText : '';
        if (text.includes('Ref is invalid')) {
            return { repoPath, exists: false };
        }
        if (text.includes('404 - page not found') || /Page not found/.test(document.title)) {
            return { repoPath, exists: null };
        }
        // Only trust "exists" when signed in, so a signed-out 404 can't count as a success.
        const signedIn = !!document.querySelector('meta[name="user-login"]')?.content;
        if (!signedIn) {
            return { repoPath, exists: null };
        }
        return { repoPath, exists: true };
    }

    async function applyPassiveDetection() {
        const result = detectDevelopFromPage();
        if (!result || result.exists === null) return;

        const cache = await loadDevelopBranchCache();
        if (cache[result.repoPath] === result.exists) return;

        await saveDevelopBranchCache({ ...cache, [result.repoPath]: result.exists });
    }

    var checkUrlPath = async (url) => {
        if (url == null) return;

        const branches = getBranches(url);
        let urlPaths = splitUrlPaths(url)
        let compareLocation = getCompareIndex(urlPaths);

        if (branches == null) return;

        const [dest, source] = branches.split('...');

        if (dest === mainBranch && source !== devBranch && source !== mainBranch) {
            if (!(await hasDevelopBranch(url))) {
                return;
            }

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

    applyPassiveDetection();
    checkUrlPath(location.href);
})(window.history);

/* @observer-begin
(ctx) => {
    // ctx = { url, status, values }. values holds this script's shared keys and private keys.
    // Runs in the extension's isolated context, so it works on sandboxed raw pages where the page script can't run.
    const key = 'auto-set-destination-develop-cache';
    if (ctx.status !== 200) return {};

    const m = new URL(ctx.url).pathname.match(/^\/([^/]+)\/([^/]+)\/refs\/heads\/develop\//);
    if (!m) return {};

    // HTTP 200 for a develop file means the develop branch exists.
    const repoPath = m[1] + '/' + m[2];
    const cache = ctx.values[key] || {};
    if (cache[repoPath] === true) return {};

    return { set: { [key]: { ...cache, [repoPath]: true } } };
}
@observer-end */
