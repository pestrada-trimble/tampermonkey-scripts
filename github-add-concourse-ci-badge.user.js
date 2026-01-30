// ==UserScript==
// @name         Github Add Concourse CI Badge
// @version      0.2.1
// @description  Add Concourse CI badge to Github ebuildernoc repos
// @author       Pedro Estrada
// @match        https://github.com/e-buildernoc/*
// @match        https://github.com/orgs/e-buildernoc/repositories*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(() => {
    'use strict';

    const concourseBaseUrl = 'https://concourse-ci.e-builder.net';
    const BADGE_MARKER_CLASS = 'concourse-ci-badge-added';
    
    if (window.concourseCiBadgeLoaded) return;
    window.concourseCiBadgeLoaded = true;

    let observer = null;
    let currentUrl = null;

    function getPageType(url) {
        if (!url) return null;
        url = url.split('?')[0];
        
        if (url === 'https://github.com/e-buildernoc') {
            return 'org-home';
        }
        if (url === 'https://github.com/orgs/e-buildernoc/repositories') {
            return 'org-repos';
        }
        
        const match = url.match(/^https:\/\/github\.com\/e-buildernoc\/([^/]+)$/);
        if (match) {
            return { type: 'repo', name: match[1] };
        }
        return null;
    }

    function waitForElement(selector, timeout = 10000) {
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

    async function checkUrl(url) {
        if (url === currentUrl) return;
        currentUrl = url;

        const pageType = getPageType(url);
        if (!pageType) return;

        try {
            if (pageType === 'org-home') {
                await waitForElement('.repo-list li');
                addBadgesForAllRepos(false);
            } else if (pageType === 'org-repos') {
                await waitForElement('div[class^="ReposList"] ul[class^="ListView"] li');
                addBadgesForAllRepos(true);
            } else if (pageType.type === 'repo') {
                const titleComponent = await waitForElement('#repo-title-component');
                if (!titleComponent.classList.contains(BADGE_MARKER_CLASS)) {
                    titleComponent.classList.add(BADGE_MARKER_CLASS); // Mark immediately to prevent race condition
                    addBadgeWithLink(pageType.name, titleComponent);
                }
            }
        } catch (err) {
            console.warn('Concourse badge: element not found', err.message);
        }
    }

    function addBadgesForAllRepos(isRepositoriesPage = false) {
        if (isRepositoriesPage) {
            const repos = document.querySelectorAll('div[class^="ReposList"] ul[class^="ListView"] li');
            repos.forEach(repoElement => {
                if (repoElement.classList.contains(BADGE_MARKER_CLASS)) return;
                const repoLink = repoElement.querySelector('a');
                if (!repoLink) return;
                const repoName = repoLink.textContent;
                const elementToAddBadgeAfter = repoElement.querySelector('span[class^="prc-Label-Label"]');
                if (elementToAddBadgeAfter) {
                    repoElement.classList.add(BADGE_MARKER_CLASS);
                    addBadgeWithLink(repoName, null, elementToAddBadgeAfter);
                }
            });
        } else {
            const repos = document.querySelectorAll('.repo-list li > div > div > div:first-child');
            repos.forEach(repoElement => {
                if (repoElement.classList.contains(BADGE_MARKER_CLASS)) return;
                const repoLink = repoElement.querySelector('a');
                if (!repoLink) return;
                const repoName = repoLink.textContent;
                const elementToAddBadgeAfter = repoElement.querySelector('span[title]');
                if (elementToAddBadgeAfter) {
                    repoElement.classList.add(BADGE_MARKER_CLASS);
                    addBadgeWithLink(repoName, null, elementToAddBadgeAfter);
                }
            });
        }
    }

    function addBadgeWithLink(repoName, parentElement, siblingElement) {
        const concourseApiRepoUrl = `${concourseBaseUrl}/api/v1/teams/main/pipelines/${repoName}`;
        const concourseRepoUrl = `${concourseBaseUrl}/teams/main/pipelines/${repoName}`;

        GM_xmlhttpRequest({
            method: 'GET',
            url: `${concourseApiRepoUrl}/badge`,
            responseType: 'blob',
            onload: (response) => {
                if (response.status !== 200) {
                    console.warn('Failed to load Concourse badge:', response.status);
                    return;
                }

                const reader = new FileReader();
                reader.onloadend = () => {
                    const badge = document.createElement('img');
                    badge.src = reader.result;
                    badge.alt = 'Concourse CI';
                    badge.className = 'concourse-ci-badge';
                    badge.height = 20;
                    badge.style.marginLeft = '8px';
                    badge.style.verticalAlign = 'middle';
                    badge.style.lineHeight = '18px';
                    
                    const badgeLink = document.createElement('a');
                    badgeLink.href = concourseRepoUrl;
                    badgeLink.target = '_blank';
                    badgeLink.className = 'concourse-ci-badge-link';
                    badgeLink.appendChild(badge);

                    if (siblingElement) {
                        siblingElement.insertAdjacentElement('afterend', badgeLink);
                    } else if (parentElement) {
                        parentElement.appendChild(badgeLink);
                    }
                };
                reader.readAsDataURL(response.response);
            },
            onerror: (err) => console.error('Failed to load Concourse badge:', err)
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
})();