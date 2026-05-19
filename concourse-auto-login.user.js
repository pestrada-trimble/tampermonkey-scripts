// ==UserScript==
// @name         Concourse Auto Login 
// @version      0.3
// @description  Concourse Auto Login 
// @author       Pedro Estrada
// @match        https://concourse-ci.e-builder.net/*
// @match        https://concourse-ci-tools.e-builder.net/*
// @icon         https://concourse-ci.e-builder.net/public/images/favicon.png
// @run-at       document-end
// ==/UserScript==

(() => {
    'use strict';

    function attemptLogin() {
        try {
            document.querySelector('a[href="/login"]').click();
        } catch (error) {
            console.error('Failed to click login link:', error);
        }

        try {
            document.querySelector('a[href^="/sky/issuer/auth/oauth"]').click();
        } catch (error) {
            console.error('Failed to click login link:', error);
        }
    }

    function fixUnexpectedStateToken() {
        const isError = document.querySelector('body').textContent.includes('unexpected state token');
        if (isError) {
            localtion.href = location.origin
        }
    }

    history.pushState = new Proxy(history.pushState, {
        apply: (target, thisArg, argList) => {
            setTimeout(attemptLogin, 1000);
            setTimeout(fixUnexpectedStateToken, 1000);
            return target.apply(thisArg, argList);
        },
    });

    attemptLogin();
    fixUnexpectedStateToken();
})();