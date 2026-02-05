// ==UserScript==
// @name         Github Add Concourse CI Badge
// @version      0.3.3
// @description  Add Concourse CI badge to Github ebuildernoc repos
// @author       Pedro Estrada
// @match        https://github.com/e-buildernoc*
// @match        https://github.com/orgs/e-buildernoc/repositories*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(() => {
    'use strict';

    const concourseDevBaseUrl = 'https://concourse-ci.e-builder.net';
    const concourseToolsBaseUrl = 'https://concourse-ci-tools.e-builder.net';
    const BADGE_MARKER_CLASS = 'concourse-ci-badge-added';
    const STYLE = `
        .ot-badges {
            display: inline-flex;
            flex-direction: row;
            gap: 8px;
            margin-left: 8px;
            margin-bottom: 4px;
            align-items: center;
        }

        .ot-fixed {
            position: fixed;
            top: 22px;
            z-index: 34;
        }

        .ot-badge {
            display: flex;
            border-radius: 4px;
            overflow: hidden;
            font-weight: 500;
            text-decoration: none;
            height: 20px;
            font-size: 10px;
            line-height: 18px;
            align-items: center;
        }

        .ot-title {
            padding: 4px 8px;
            background-color: #555;
            color: #fff;
        }

        .ot-status {
            padding: 4px 8px;
            color: #fff;
        }

        .ot-status.failing {
            background-color: #e05d44;
        }

        .ot-status.passing {
            background-color: #4c1;
        }
        
        .ot-status.unknown {
            background-color: #aaa;
        }
    `;
    
    if (window.concourseCiPipelinesParsed) return;
    window.concourseCiPipelinesParsed = true;

    GM_addStyle(STYLE);

    let observer = null;
    let currentUrl = null;

    let DEV_PIPELINES = new Map();
    let TOOLS_PIPELINES = new Map();

    function getPageType(url) {
        if (!url) return null;
        url = url.split(/[?#]/)[0];

        // remove the trailing slash
        url = url.replace(/\/$/, '');
        
        if (url === 'https://github.com/e-buildernoc') {
            return 'org-home';
        }
        if (url === 'https://github.com/orgs/e-buildernoc/repositories') {
            return 'org-repos';
        }
        
        const match = url.match(/^https:\/\/github\.com\/e-buildernoc\/([^/]+)/);
        if (match) {
            return { type: 'repo', name: match[1] };
        }
        return null;
    }

    function waitForElement(selector, timeout = 10_000) {
        return new Promise((resolve, reject) => {
            const element = document.querySelector(selector);
            if (element) {
                resolve(element);
                return;
            }

            const timeoutId = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Timeout waiting for ${selector}`));
            }, timeout);

            const observer = new MutationObserver((mutations, obs) => {
                const element = document.querySelector(selector);
                if (element) {
                    clearTimeout(timeoutId);
                    obs.disconnect();
                    resolve(element);
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        });
    }

    function getBuildStatus(lastBuildStatus) {
        if (lastBuildStatus === 'Success') return 'passing';
        if (lastBuildStatus === 'Failure') return 'failing';
        return 'unknown';
    }

    async function checkUrl(url) {
        if (url === currentUrl) return;
        currentUrl = url;

        const pageType = getPageType(url);
        if (!pageType) return;

        GM_xmlhttpRequest({
            method: 'GET',
            url: `${concourseDevBaseUrl}/api/v1/teams/main/cc.xml`,
            responseType: 'xml',
            onload: async (response) => await onConcourseApiResponse(response, DEV_PIPELINES).then(() => {
                tryAddBadge(pageType, DEV_PIPELINES, concourseDevBaseUrl, "dev");
            }),
            onerror: (err) => console.error('Failed to load Concourse API:', err)
        });

        GM_xmlhttpRequest({
            method: 'GET',
            url: `${concourseToolsBaseUrl}/api/v1/teams/main/cc.xml`,
            responseType: 'xml',
            onload: async (response) => await onConcourseApiResponse(response, TOOLS_PIPELINES).then(() => {
                tryAddBadge(pageType, TOOLS_PIPELINES, concourseToolsBaseUrl, "tools");
            }),
            onerror: (err) => console.error('Failed to load Concourse API:', err)
        });
    }

    async function onConcourseApiResponse(response, pipelines) {
        var parser, xmlDoc;
        parser = new DOMParser();
        xmlDoc = parser.parseFromString(response.responseText, "text/xml");

        console.log(xmlDoc);
        const projects = xmlDoc.getElementsByTagName('Project');
        for (const project of projects) {
            const name = project.getAttribute('name');
            const match = /(.*)\/(develop|main)_(.*)/.exec(name);
            if (!match) continue;

            const repoName = match[1];
            const developOrMain = match[2];
            const jobName = match[3];
            const activity = project.getAttribute('activity');
            const lastBuildStatus = project.getAttribute('lastBuildStatus'); // Success Failure
            const lastBuildTime = project.getAttribute('lastBuildTime');
            const webUrl = project.getAttribute('webUrl');

            if (!pipelines.has(repoName)) {
                pipelines.set(repoName, { status: 'unknown', hasError: false, activity, webUrl, lastBuildTime });
            }

            // if the pipeline job has an error, skip the rest of the code
            if (pipelines.get(repoName).hasError) continue;

            const status = getBuildStatus(lastBuildStatus);
            
            if (status === 'failing') {
                pipelines.get(repoName).hasError = true;
                pipelines.get(repoName).status = 'failing';
            }
            else {
                pipelines.get(repoName).status = 'passing';
            }
        }
    }

    function positionFixedBadges() {
        const badges = document.querySelector('.ot-badges.ot-fixed');
        const searchButtonGroup = document.querySelector('[class^="Search-module__searchButtonGroup"]');
        if (badges && searchButtonGroup) {
            const rect = searchButtonGroup.getBoundingClientRect();
            const badgesWidth = badges.offsetWidth;
            badges.style.left = `${rect.left - badgesWidth - 16}px`;
        }
    }

    async function tryAddBadge(pageType, pipelines, baseUrl, title) {
        try {
            if (pageType === 'org-home') {
                await waitForElement('.repo-list li');
                addBadgesForAllRepos(false, pipelines, baseUrl, title);
            } else if (pageType === 'org-repos') {
                await waitForElement('div[class^="ReposList"] ul[class^="ListView"] li');
                addBadgesForAllRepos(true, pipelines, baseUrl, title);
            } else if (pageType.type === 'repo') {
                const titleComponent = document.querySelector('div[class^="prc-Stack-Stack"]');
                addBadge(title, pipelines.get(pageType.name)?.status || 'unknown', baseUrl, pageType.name, titleComponent, null, 'ot-fixed');
                requestAnimationFrame(positionFixedBadges);
            }
        } catch (err) {
            console.warn('Concourse badge: element not found', err.message);
        }
    }



    function addBadge(title, status, url, repoName, parentElement = null, siblingElement = null, extraClass = '', siblingPosition = 'after') {
        const hasParent = parentElement !== null;
        const hasSibling = siblingElement !== null;

        if (hasParent === hasSibling) {
            console.error(`Concourse badge: exactly one of parentElement or siblingElement required`);
            return;
        }

        const container = hasParent ? parentElement : siblingElement.parentElement;
        const markerClass = `${BADGE_MARKER_CLASS}-${title}`;

        if (container.classList.contains(markerClass)) {
            const existingBadge = container.querySelector(`.ot-badge.${repoName}-${title}`);
            if (existingBadge) {
                const statusSpan = existingBadge.querySelector('.ot-status');
                if (statusSpan) {
                    statusSpan.className = `ot-status ${status}`;
                    statusSpan.textContent = status;
                }
            }
            return;
        }
        container.classList.add(markerClass);

        let badges = container.querySelector('.ot-badges');
        if (!badges) {
            badges = document.createElement('div');
            badges.className = `ot-badges ${extraClass}`;

            if (hasSibling) {
                const position = siblingPosition === 'before' ? 'beforebegin' : 'afterend';
                siblingElement.insertAdjacentElement(position, badges);
            } else {
                parentElement.appendChild(badges);
            }
        }

        const badge = document.createElement('a');
        badge.href = `${url}/teams/main/pipelines/${repoName}`;
        badge.className = `ot-badge ${repoName}-${title}`;
        badge.target = '_blank';
        badge.rel = 'noopener noreferrer';
        badge.innerHTML = `
            <span class="ot-title">${title}</span>
            <span class="ot-status ${status}">${status}</span>`;

        badges.appendChild(badge);
    }

    function addBadgesForAllRepos(isRepositoriesPage = false, pipelines, baseUrl, title) {
        const selectors = isRepositoriesPage
            ? { repos: 'div[class^="ReposList"] ul[class^="ListView"] li', badge: 'span[class^="prc-Label-Label"]' }
            : { repos: '.repo-list li > div > div > div:first-child', badge: 'span[title]' };

        document.querySelectorAll(selectors.repos).forEach(repoElement => {
            const repoLink = repoElement.querySelector('a');
            if (!repoLink) return;

            const badgeAnchor = repoElement.querySelector(selectors.badge);
            if (!badgeAnchor) return;

            const repoName = repoLink.textContent;
            const status = pipelines.get(repoName)?.status || 'unknown';
            addBadge(title, status, baseUrl, repoName, null, badgeAnchor);
        });
    }

    // Handle SPA navigation using multiple strategies
    function setupNavigationListeners() {
        // Strategy 1: Intercept history.pushState
        const originalPushState = history.pushState;
        history.pushState = function(...args) {
            originalPushState.apply(this, args);
            handleNavigation();
        };

        // Strategy 2: Intercept history.replaceState
        const originalReplaceState = history.replaceState;
        history.replaceState = function(...args) {
            originalReplaceState.apply(this, args);
            handleNavigation();
        };

        // Strategy 3: Handle back/forward navigation
        window.addEventListener('popstate', handleNavigation);

        // Strategy 4: GitHub uses Turbo for navigation
        document.addEventListener('turbo:load', handleNavigation);
        document.addEventListener('turbo:render', handleNavigation);

        // Strategy 5: MutationObserver for dynamic content changes
        // This catches cases where content is loaded without URL change
        observer = new MutationObserver((mutations) => {
            // Debounce the check to avoid excessive calls
            clearTimeout(observer.debounceTimer);
            observer.debounceTimer = setTimeout(() => {
                checkUrl(location.href);
            }, 100);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function handleNavigation() {
        // Reset currentUrl to force re-check on navigation
        currentUrl = null;
        // Small delay to let the DOM settle
        setTimeout(() => checkUrl(location.href), 50);
    }

    // Initialize
    setupNavigationListeners();
    checkUrl(location.href);

    // Reposition fixed badges on resize
    window.addEventListener('resize', positionFixedBadges);
})();