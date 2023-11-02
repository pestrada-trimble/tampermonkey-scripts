// ==UserScript==
// @name         Auto mark pull-request checklist
// @version      0.1
// @description  Auto mark pull-request checklist
// @author       Pedro Estrada
// @match        https://github.com/e-buildernoc/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const pull_request_body = document.getElementById('pull_request_body');
    pull_request_body.value = pull_request_body.value.replace(/\[\s\]/g, '[x]');
})();
