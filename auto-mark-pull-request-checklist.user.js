// ==UserScript==
// @name         Auto mark pull-request checklist
// @version      0.2
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

    pull_request_body.addEventListener('click', function() {
        const caretPosition = getCaretPosition(pull_request_body);
        const text = pull_request_body.value;
        const leftBoundary = Math.max(0, caretPosition - 2);
        const rightBoundary = Math.min(text.length, caretPosition + 2);
        let selectedText = text.substring(leftBoundary, rightBoundary);

        if (selectedText.indexOf('[x]') != -1) {
            selectedText = selectedText.replace(/\[x\]/g, '[ ]')
        } else if (selectedText.indexOf('[ ]') != -1) {
            selectedText = selectedText.replace(/\[\s\]/g, '[x]')
        }

        const updatedText = text.substring(0, leftBoundary) + selectedText + text.substring(rightBoundary);
        pull_request_body.value = updatedText;
    });

    function getCaretPosition(textarea) {
        let position = 0;
        if (textarea.selectionStart || textarea.selectionStart === 0) {
            position = textarea.selectionStart;
        }
        return position;
    }
})();
