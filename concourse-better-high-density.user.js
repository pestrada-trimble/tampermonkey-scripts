// ==UserScript==
// @name         Concourse Better High Density 
// @version      0.3
// @description  Concourse Better High Density 
// @author       Pedro Estrada
// @match        https://concourse-ci.e-builder.net/*
// @match        https://concourse-ci-tools.e-builder.net/*
// @icon         https://concourse-ci.e-builder.net/public/images/favicon.png
// ==/UserScript==

(() => {

    function init() {
        if (!location.pathname.includes('/hd')) {
            return;
        }
    
        let PIPELINES = new Map();
    
        fetch(`${location.origin}/api/v1/teams/main/cc.xml`)
            .then(response => response.text())
            .then(text => onConcourseApiResponse(text, PIPELINES))
            .then(() => filterHighDensity(PIPELINES))
            .catch(err => console.error('Failed to load Concourse API:', err));
    }

    function filterHighDensity(pipelines) {
        const hdPipelines = document.querySelectorAll('div#dashboard a.card');
        for (const pipeline of hdPipelines) {
            const pipelineName = pipeline.getAttribute('data-pipeline-name');

            const pipelineData = pipelines.get(pipelineName);

            if (!pipelineData) continue;

            if (pipelineData.status === 'failing') {
                pipeline.style.backgroundColor = '#db5442';
            }
            else {
                pipeline.style.backgroundColor = '#0d9448';
            }
        }
    }

    function getBuildStatus(lastBuildStatus) {
        if (lastBuildStatus === 'Success') return 'passing';
        if (lastBuildStatus === 'Failure') return 'failing';
        return 'unknown';
    }

    function onConcourseApiResponse(responseText, pipelines) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(responseText, "text/xml");

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

    const originalPushState = history.pushState;
    history.pushState = function(...args) {
        originalPushState.apply(this, args);
        handleNavigation();
    };

    let timeoutId = null;

    function handleNavigation() {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => init(), 50);
    }

    setInterval(() => init(), 30_000);

    init();
})();