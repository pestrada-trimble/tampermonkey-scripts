// ==UserScript==
// @name         Jira Issue Graph (D3)
// @namespace    https://github.com/pestrad
// @version      0.2.0
// @description  Visualize Jira issue link graphs directly in the browser using D3.js.
// @author       pestrad
// @match        https://*.atlassian.net/*
// @grant        GM_addStyle
// @require      https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    const BUTTON_ID = "jira-issue-graph-toggle";
    const PANEL_ID = "jira-issue-graph-panel";
    const CY_CONTAINER_ID = "jira-issue-graph-canvas";
    const API_BASE = "/rest/api/3";
    const ISSUE_FIELDS = "summary,issuetype,status,issuelinks";
    const MAX_ISSUES = 200;
    const KEEP_LINK_LABELS = new Set(["blocks", "is blocked by"]);
    const NODE_RADIUS = 40;
    const NODE_STROKE_WIDTH = 4;
    const ARROW_GAP = 6;
    const TOOLTIP_ID = "jira-issue-graph-tooltip";
    const TOOLTIP_OFFSET = 24;
    const STATUS_STROKE_COLORS = new Map([
        ["READY FOR MAIN", "#00D76B"],
        ["READY FOR DEV", "#008CFF"],
        ["CODE REVIEW", "#C51162"],
        ["READY FOR CR", "#9C27B0"],
        ["READY FOR REV", "#FFD800"],
        ["DEVELOPMENT", "#00E5FF"],
        ["READY FOR QA", "#FF6D00"],
        ["QA", "#FF1744"],
        ["DONE", "#64DD17"],
    ]);

    let simulation = null;
    let svgRoot = null;
    let zoomLayer = null;
    let linkGroup = null;
    let linkLabelGroup = null;
    let nodeGroup = null;
    let nodeSelection = null;
    let linkSelection = null;
    let linkLabelSelection = null;
    let layoutScheduled = false;
    const expandedEpics = new Set();
    const epicExpansionPromises = new Map();
    let currentRootKey = null;
    const nodeLookup = new Map();
    const linkLookup = new Map();
    let tooltipEl = null;

    GM_addStyle(`
    #${BUTTON_ID} {
      position: fixed;
      top: 116px;
      right: 40px;
      z-index: 9999;
      padding: 8px 16px;
      border-radius: 6px;
      border: none;
      background: #0052cc;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
    }
    #${BUTTON_ID}[data-loading="true"] {
      opacity: 0.6;
      cursor: progress;
    }
    #${PANEL_ID} {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 80%;
      height: 80%;
      z-index: 9999;
      background: #fff;
      border: 1px solid #dfe1e6;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(9, 30, 66, 0.25);
      display: none;
      flex-direction: column;
    }
    #${PANEL_ID}[data-open="true"] {
      display: flex;
    }
    #${PANEL_ID} header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid #dfe1e6;
      background: #f4f5f7;
      font-size: 13px;
      font-weight: 600;
    }
    #${PANEL_ID} header button {
      background: none;
      border: none;
      font-size: 16px;
      cursor: pointer;
    }
    #${CY_CONTAINER_ID} {
      flex: 1;
      position: relative;
      overflow: hidden;
    }
    #${CY_CONTAINER_ID} svg {
      width: 100%;
      height: 100%;
      cursor: grab;
      user-select: none;
    }
    #${CY_CONTAINER_ID} svg:active {
      cursor: grabbing;
    }
    #${CY_CONTAINER_ID} .jira-issue-graph-node circle {
      fill: #1f2a44;
      stroke: #fff;
      stroke-width: 2px;
      filter: drop-shadow(0 2px 4px rgba(9, 30, 66, 0.25));
    }
    #${CY_CONTAINER_ID} .jira-issue-graph-node {
      cursor: pointer;
    }
    #${CY_CONTAINER_ID} .jira-issue-graph-node text {
      fill: #fff;
      font-size: 10px;
      text-anchor: middle;
      pointer-events: none;
    }
    #${CY_CONTAINER_ID} .jira-issue-graph-node.node-epic circle {
      fill: #ffc400;
      stroke: #172b4d;
    }
    #${CY_CONTAINER_ID} .jira-issue-graph-node.node-epic text {
      fill: #172b4d;
    }
    #${CY_CONTAINER_ID} .jira-issue-graph-node.root-issue circle {
      fill: #36b37e;
    }
    #${CY_CONTAINER_ID} .jira-issue-graph-node.root-issue text {
      fill: #fff;
    }
    #${CY_CONTAINER_ID} .jira-issue-graph-link {
      stroke: #97a0af;
      stroke-width: 2px;
      fill: none;
      stroke-linecap: round;
    }
    #${CY_CONTAINER_ID} .jira-issue-graph-link-label {
      fill: #172b4d;
      font-size: 8px;
      pointer-events: none;
      paint-order: stroke fill;
      stroke: #fff;
      stroke-width: 3px;
      stroke-linejoin: round;
    }
    #${TOOLTIP_ID} {
      position: fixed;
      z-index: 10000;
      pointer-events: none;
      padding: 6px 8px;
      background: rgba(9, 30, 66, 0.92);
      color: #fff;
      font-size: 11px;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(9, 30, 66, 0.4);
      max-width: 280px;
      line-height: 1.4;
      opacity: 0;
      transition: opacity 0.1s ease;
    }
    #${TOOLTIP_ID}[data-visible="true"] {
      opacity: 1;
    }
    #${PANEL_ID} .jira-issue-graph-status {
      padding: 12px;
      font-size: 13px;
    }
  `);

    function ensureButton() {
        if (document.getElementById(BUTTON_ID)) {
            return;
        }
        const button = document.createElement("button");
        button.id = BUTTON_ID;
        button.type = "button";
        button.textContent = "Issue Graph";
        button.addEventListener("click", onToggleGraph);
        document.body.appendChild(button);
    }

    function ensurePanel() {
        let panel = document.getElementById(PANEL_ID);
        if (panel) {
            return panel;
        }

        panel = document.createElement("div");
        panel.id = PANEL_ID;
        panel.innerHTML = `
      <header>
        <span>Jira Issue Graph</span>
        <button type="button" style="color: #c41e3a;" aria-label="Close graph">×</button>
      </header>
      <div class="jira-issue-graph-status">Ready.</div>
      <div id="${CY_CONTAINER_ID}"></div>
    `;

        const closeButton = panel.querySelector("header button");
        closeButton.addEventListener("click", () => setPanelOpen(false));

        document.body.appendChild(panel);
        return panel;
    }

    function setPanelOpen(open) {
        const panel = ensurePanel();
        panel.dataset.open = String(open);
        if (!open) {
            hideTooltip();
        }
    }

    function setButtonLoading(isLoading) {
        const button = document.getElementById(BUTTON_ID);
        if (button) {
            button.dataset.loading = String(isLoading);
            button.disabled = isLoading;
        }
    }

    function updateStatus(message) {
        const panel = ensurePanel();
        const statusEl = panel.querySelector(".jira-issue-graph-status");
        if (statusEl) {
            statusEl.textContent = message;
        }
    }

    function onToggleGraph() {
        const panel = ensurePanel();
        const isOpen = panel.dataset.open === "true";
        if (isOpen) {
            setPanelOpen(false);
            return;
        }
        void renderCurrentIssueGraph();
    }

    async function renderCurrentIssueGraph() {
        const issueKey = extractIssueKeyFromURL(window.location.href);
        if (!issueKey) {
            alert("Unable to determine the current issue key.");
            return;
        }

        setButtonLoading(true);
        updateStatus(`Loading ${issueKey}...`);
        setPanelOpen(true);

        try {
            currentRootKey = issueKey.toUpperCase();
            drawGraph([], []);

            const runningTotals = { nodes: 0, edges: 0 };
            const { nodes, edges } = await buildGraphStreaming(issueKey, async (batch) => {
                const simplifiedBatch = {
                    nodes: (batch.nodes ?? []).map((node) => {
                        const id = String(node.id ?? "").toUpperCase();
                        const status = normalizeStatusName(node.status ?? "");
                        return {
                            ...node,
                            id,
                            status,
                            label: buildNodeLabel(id, status),
                        };
                    }),
                    edges: batch.edges ?? [],
                };
                const { addedNodes, addedEdges } = addElementsToGraph(simplifiedBatch);
                if (addedNodes || addedEdges) {
                    runningTotals.nodes += addedNodes;
                    runningTotals.edges += addedEdges;
                    updateStatus(
                        `Loading ${issueKey}... ${runningTotals.nodes} issues, ${runningTotals.edges} links.`
                    );
                }
            });

            updateStatus(`Loaded ${nodes.length} issues and ${edges.length} links.`);
        } catch (error) {
            console.error("jira-issue-graph", error);
            updateStatus(`Failed: ${error?.message ?? error}`);
        } finally {
            setButtonLoading(false);
        }
    }

    function drawGraph(nodes, edges) {
        const container = document.getElementById(CY_CONTAINER_ID);
        if (!container) {
            return;
        }
        if (typeof d3 === "undefined") {
            updateStatus("D3.js failed to load. Please refresh the page.");
            console.error("jira-issue-graph", "D3.js is unavailable");
            return;
        }

        if (simulation) {
            simulation.stop();
            simulation = null;
        }
        svgRoot = null;
        zoomLayer = null;
        linkGroup = null;
        linkLabelGroup = null;
        nodeGroup = null;
        nodeSelection = null;
        linkSelection = null;
        linkLabelSelection = null;
        layoutScheduled = false;
        nodeLookup.clear();
        linkLookup.clear();
        expandedEpics.clear();
        epicExpansionPromises.clear();

        container.innerHTML = "";

        ensureTooltip();
        hideTooltip();

        const rect = container.getBoundingClientRect();
        const width = rect.width || container.clientWidth || 800;
        const height = rect.height || container.clientHeight || 600;

        svgRoot = d3
            .select(container)
            .append("svg")
            .attr("viewBox", `0 0 ${width} ${height}`)
            .attr("preserveAspectRatio", "xMidYMid meet");

        const defs = svgRoot.append("defs");
        defs
            .append("marker")
            .attr("id", "jira-issue-graph-arrow")
            .attr("viewBox", "0 0 12 12")
            .attr("refX", 10)
            .attr("refY", 6)
            .attr("markerWidth", 12)
            .attr("markerHeight", 12)
            .attr("markerUnits", "userSpaceOnUse")
            .attr("orient", "auto-start-reverse")
            .append("path")
            .attr("d", "M 0 1 L 10 6 L 0 11 z")
            .attr("fill", "#42526e")
            .attr("stroke", "#dfe1e6")
            .attr("stroke-width", 1.2);

        zoomLayer = svgRoot.append("g").attr("class", "jira-issue-graph-zoom");
        linkGroup = zoomLayer.append("g").attr("class", "jira-issue-graph-links");
        linkLabelGroup = zoomLayer.append("g").attr("class", "jira-issue-graph-link-labels");
        nodeGroup = zoomLayer.append("g").attr("class", "jira-issue-graph-nodes");

        svgRoot.call(
            d3
                .zoom()
                .scaleExtent([0.2, 4])
                .on("zoom", (event) => {
                    zoomLayer.attr("transform", event.transform);
                })
        );

        simulation = d3
            .forceSimulation()
            .force("link", d3.forceLink().id((d) => d.id).distance(400).strength(0.5))
            .force("charge", d3.forceManyBody().strength(-650))
            .force("center", d3.forceCenter(width / 2, height / 2))
            .force("collision", d3.forceCollide().radius(85))
            .on("tick", onTick);

        simulation.nodes([]);
        simulation.force("link").links([]);

        if (nodes?.length || edges?.length) {
            addElementsToGraph({
                nodes: nodes.map((node) => {
                    const id = String(node.id ?? "").toUpperCase();
                    const status = normalizeStatusName(node.status ?? "");
                    return {
                        ...node,
                        id,
                        status,
                        label: buildNodeLabel(id, status),
                    };
                }),
                edges,
            });
        } else {
            updateGraphElements();
        }
    }

    function onTick() {
        if (linkSelection) {
            linkSelection
                .attr("d", (d) => {
                    const { sx, sy, tx, ty, cx, cy } = computeCurvePoints(d);
                    return `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`;
                });
        }

        if (linkLabelSelection) {
            linkLabelSelection
                .attr("x", (d) => curvePointAt(d, 0.5).x)
                .attr("y", (d) => curvePointAt(d, 0.5).y);
        }

        if (nodeSelection) {
            nodeSelection
                .attr("transform", (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`)
                .each((d) => {
                    if (d?.id) {
                        nodeLookup.set(String(d.id).toUpperCase(), d);
                    }
                });
        }
    }

    function updateGraphElements() {
        if (!simulation || !nodeGroup || !linkGroup || !linkLabelGroup) {
            return;
        }

        const nodesData = simulation.nodes();
        const linksData = simulation.force("link").links();

        linkSelection = linkGroup
            .selectAll("path.jira-issue-graph-link")
            .data(linksData, (d) => d.id)
            .join((enter) =>
                enter
                    .append("path")
                    .attr("class", "jira-issue-graph-link")
                    .attr("marker-end", "url(#jira-issue-graph-arrow)")
            );
        linkSelection.attr("marker-end", "url(#jira-issue-graph-arrow)");

        linkLabelSelection = linkLabelGroup
            .selectAll("text.jira-issue-graph-link-label")
            .data(linksData, (d) => d.id)
            .join((enter) =>
                enter
                    .append("text")
                    .attr("class", "jira-issue-graph-link-label")
                    .attr("text-anchor", "middle")
                    .attr("alignment-baseline", "middle")
            );
        linkLabelSelection.text((d) => d.label ?? "");

        const dragBehaviour = createDragBehaviour();

        nodeSelection = nodeGroup
            .selectAll("g.jira-issue-graph-node")
            .data(nodesData, (d) => d.id)
            .join((enter) => {
                const group = enter
                    .append("g")
                    .attr("class", "jira-issue-graph-node")
                    .call(dragBehaviour);
                group.append("circle");
                group
                    .append("text")
                    .attr("class", "jira-issue-graph-node-label")
                    .attr("text-anchor", "middle")
                    .attr("dominant-baseline", "middle");
                return group;
            }, (update) => update.call(dragBehaviour));

        nodeSelection
            .classed("node-epic", (d) => isEpicType(d.type))
            .classed("root-issue", (d) => d.id === currentRootKey);

        nodeSelection
            .on("click", handleNodeClick)
            .on("mouseenter", (event, d) => {
                showTooltipForNode(event, d);
            })
            .on("mousemove", (event) => {
                moveTooltip(event);
            })
            .on("mouseleave", () => {
                hideTooltip();
            });

        updateNodeLabels(nodeSelection);
    }

    function showTooltipForNode(event, nodeData) {
        if (!nodeData || nodeData.wasDragged) {
            return;
        }
        const text = getNodeTooltipText(nodeData);
        if (!text) {
            hideTooltip();
            return;
        }
        showTooltip(text, event);
    }

    function getNodeTooltipText(nodeData) {
        if (!nodeData) {
            return "";
        }
        const key = nodeData.id ?? "";
        if (!key) {
            return "";
        }
        const summary = nodeData.summary ?? "";
        return summary ? `${key}: ${summary}` : key;
    }

    function showTooltip(text, event) {
        if (!text) {
            hideTooltip();
            return;
        }
        const el = ensureTooltip();
        el.textContent = text;
        positionTooltip(event);
        el.dataset.visible = "true";
    }

    function moveTooltip(event) {
        if (!tooltipEl || tooltipEl.dataset.visible !== "true") {
            return;
        }
        positionTooltip(event);
    }

    function positionTooltip(event) {
        const el = ensureTooltip();
        if (!event) {
            return;
        }
        const clientX = event.clientX ?? event.pageX ?? event.x ?? 0;
        const clientY = event.clientY ?? event.pageY ?? event.y ?? 0;
        const scrollX = window.scrollX ?? window.pageXOffset ?? 0;
        const scrollY = window.scrollY ?? window.pageYOffset ?? 0;
        const pageX = clientX + scrollX;
        const pageY = clientY + scrollY;
        el.style.left = `${pageX + TOOLTIP_OFFSET}px`;
        el.style.top = `${pageY + TOOLTIP_OFFSET}px`;
    }

    function hideTooltip() {
        if (!tooltipEl) {
            return;
        }
        tooltipEl.dataset.visible = "false";
    }

    function ensureTooltip() {
        if (tooltipEl && document.body.contains(tooltipEl)) {
            return tooltipEl;
        }
        tooltipEl = document.getElementById(TOOLTIP_ID);
        if (!tooltipEl) {
            tooltipEl = document.createElement("div");
            tooltipEl.id = TOOLTIP_ID;
            tooltipEl.dataset.visible = "false";
            document.body.appendChild(tooltipEl);
        }
        return tooltipEl;
    }

    function normalizeStatusName(status) {
        const value = String(status ?? "").trim();
        if (!value) {
            return "";
        }
        const normalized = value.toLowerCase();
        switch (normalized) {
            case "ready for release":
                return "Ready for main";
            case "selected for development":
                return "Ready for Dev";
            case "ready for code review":
                return "Ready for CR";
            case "reporter review":
                return "Ready for Rev";
            default:
                return value;
        }
    }

    function getStatusStrokeColor(status) {
        const key = String(status ?? "").trim().toUpperCase();
        if (!key) {
            return "#ffffff";
        }
        return STATUS_STROKE_COLORS.get(key) ?? "#ffffff";
    }

    function getNodeStrokeWidth(node) {
        return NODE_STROKE_WIDTH;
    }

    function getNodeStrokeColor(node) {
        if (!node) {
            return "#ffffff";
        }
        return getStatusStrokeColor(node.status);
    }

    function buildNodeLabel(key, status) {
        const trimmedKey = String(key ?? "").trim();
        const trimmedStatus = String(status ?? "").trim();
        return trimmedStatus ? `${trimmedKey}
${trimmedStatus}` : trimmedKey;
    }

    function updateNodeLabels(selection) {
        selection.each(function (d) {
            const group = d3.select(this);
            const text = group.select("text");
            if (text.empty()) {
                return;
            }

            const key = String(d.id ?? "");
            const status = String(d.status ?? "");
            const lines = status ? [key, status] : [key];
            const tspans = text.selectAll("tspan").data(lines);
            tspans.exit().remove();
            tspans
                .enter()
                .append("tspan")
                .merge(tspans)
                .attr("x", 0)
                .attr("dy", (line, index) => (index === 0 ? "0em" : "1.2em"))
                .text((line) => line);

            const totalHeightEm = lines.length > 1 ? (lines.length - 1) * 1.2 : 0;
            const baseY = (-totalHeightEm - 1) / 2;
            text.attr("x", 0).attr("y", `${baseY}em`).attr("dominant-baseline", "hanging");

            const circle = group.select("circle");
            const strokeWidth = getNodeStrokeWidth(d);
            circle
                .attr("r", NODE_RADIUS)
                .style("stroke", getNodeStrokeColor(d))
                .style("stroke-width", `${strokeWidth}`);
        });
    }

    function handleNodeClick(event, nodeData) {
        if (!nodeData || !nodeData.id) {
            return;
        }
        hideTooltip();
        if (nodeData.wasDragged) {
            nodeData.wasDragged = false;
            return;
        }

        const issueKey = nodeData.id;
        if (isEpicType(nodeData.type) && !expandedEpics.has(issueKey)) {
            event.preventDefault();
            event.stopPropagation();
            void expandEpic(issueKey);
            return;
        }

        const issueUrl = new URL(`/browse/${issueKey}`, window.location.origin);
        window.open(issueUrl.toString(), "_blank", "noopener");
    }

    function createDragBehaviour() {
        if (!simulation) {
            return (selection) => selection;
        }
        return d3
            .drag()
            .on("start", (event, d) => {
                hideTooltip();
                d.wasDragged = false;
                if (!event.active) {
                    simulation.alphaTarget(0.3).restart();
                }
                d.fx = d.x;
                d.fy = d.y;
            })
            .on("drag", (event, d) => {
                hideTooltip();
                d.wasDragged = true;
                d.fx = event.x;
                d.fy = event.y;
            })
            .on("end", (event, d) => {
                if (!event.active) {
                    simulation.alphaTarget(0);
                }
                d.fx = null;
                d.fy = null;
                setTimeout(() => {
                    d.wasDragged = false;
                }, 0);
            });
    }

    function getNodeCoord(ref, prop) {
        if (ref && typeof ref === "object") {
            return ref[prop] ?? 0;
        }
        const key = String(ref ?? "").toUpperCase();
        const node = nodeLookup.get(key);
        return node ? node[prop] ?? 0 : 0;
    }

    function computeCurvePoints(link) {
        const sourceNode = resolveNode(link.source);
        const targetNode = resolveNode(link.target);
        const sx = sourceNode?.x ?? 0;
        const sy = sourceNode?.y ?? 0;
        const tx = targetNode?.x ?? 0;
        const ty = targetNode?.y ?? 0;

        const dx = tx - sx;
        const dy = ty - sy;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / distance;
        const uy = dy / distance;

        const sourceRadius = getNodeRadius(sourceNode);
        const targetRadius = getNodeRadius(targetNode);
        const startAdjust = Math.min(sourceRadius, distance / 2);
        const endAdjust = Math.min(targetRadius + ARROW_GAP, distance / 2);

        const startX = sx + ux * startAdjust;
        const startY = sy + uy * startAdjust;
        const endX = tx - ux * endAdjust;
        const endY = ty - uy * endAdjust;

        const trimmedDx = endX - startX;
        const trimmedDy = endY - startY;
        const trimmedDistance = Math.sqrt(trimmedDx * trimmedDx + trimmedDy * trimmedDy) || 1;

        const midX = startX + trimmedDx / 2;
        const midY = startY + trimmedDy / 2;

        const perpX = -trimmedDy / trimmedDistance;
        const perpY = trimmedDx / trimmedDistance;
        const curveOffset = Math.min(80, trimmedDistance * 0.35 + 30);

        const cx = midX + perpX * curveOffset;
        const cy = midY + perpY * curveOffset;

        return { sx: startX, sy: startY, tx: endX, ty: endY, cx, cy };
    }

    function resolveNode(ref) {
        if (ref && typeof ref === "object") {
            return ref;
        }
        const key = String(ref ?? "").toUpperCase();
        return nodeLookup.get(key) ?? null;
    }

    function getNodeRadius(node) {
        if (!node) {
            return NODE_RADIUS;
        }
        const strokeWidth = getNodeStrokeWidth(node);
        return NODE_RADIUS + strokeWidth / 2;
    }

    function curvePointAt(link, t) {
        const { sx, sy, tx, ty, cx, cy } = computeCurvePoints(link);
        const inv = 1 - t;
        const invSq = inv * inv;
        const tSq = t * t;
        const weight = 2 * inv * t;
        return {
            x: invSq * sx + weight * cx + tSq * tx,
            y: invSq * sy + weight * cy + tSq * ty,
        };
    }

    function isEpicType(typeName) {
        return String(typeName ?? "").toLowerCase() === "epic";
    }

    function scheduleLayout() {
        if (layoutScheduled || !simulation) {
            return;
        }
        layoutScheduled = true;
        requestAnimationFrame(() => {
            layoutScheduled = false;
            if (!simulation) {
                return;
            }
            simulation.alpha(0.9).restart();
        });
    }

    function extractIssueKeyFromURL(url) {
        const match = url.match(/[A-Z][A-Z0-9]+-\d+/i);
        return match ? match[0].toUpperCase() : null;
    }

    async function expandEpic(epicKey) {
        const upperKey = epicKey?.toUpperCase?.();
        if (!upperKey || !simulation) {
            return;
        }
        if (expandedEpics.has(upperKey)) {
            return;
        }
        if (epicExpansionPromises.has(upperKey)) {
            return epicExpansionPromises.get(upperKey);
        }

        const pending = (async () => {
            try {
                updateStatus(`Expanding ${upperKey}...`);
                await buildGraphStreaming(upperKey, addElementsToGraph);
                expandedEpics.add(upperKey);
                updateStatus(`Expanded ${upperKey}.`);
            } catch (error) {
                console.error("jira-issue-graph", "Failed to expand epic", error);
                updateStatus(`Failed to expand ${upperKey}: ${error?.message ?? error}`);
            } finally {
                epicExpansionPromises.delete(upperKey);
            }
        })();

        epicExpansionPromises.set(upperKey, pending);
        return pending;
    }

    function addElementsToGraph(batch) {
        if (!simulation) {
            return { addedNodes: 0, addedEdges: 0 };
        }

        const nodesData = simulation.nodes();
        const linksData = simulation.force("link").links();
        let addedNodes = 0;
        let addedEdges = 0;

        for (const node of batch.nodes ?? []) {
            if (!node?.id) {
                continue;
            }
            const key = String(node.id).toUpperCase();
            const existing = nodeLookup.get(key);
            const statusName = normalizeStatusName(node.status ?? existing?.status ?? "");
            const normalizedNode = {
                ...existing,
                ...node,
                id: key,
                status: statusName,
                label: buildNodeLabel(key, statusName),
            };
            if (existing) {
                Object.assign(existing, normalizedNode);
                nodeLookup.set(key, existing);
                continue;
            }
            const newNode = {
                ...normalizedNode,
                fx: undefined,
                fy: undefined,
            };
            nodeLookup.set(key, newNode);
            nodesData.push(newNode);
            addedNodes += 1;
        }

        for (const edge of batch.edges ?? []) {
            if (!edge?.id) {
                continue;
            }
            const edgeId = edge.id;
            if (linkLookup.has(edgeId)) {
                continue;
            }
            const newEdge = {
                ...edge,
                id: edgeId,
                source: String(edge.source).toUpperCase(),
                target: String(edge.target).toUpperCase(),
            };
            linkLookup.set(edgeId, newEdge);
            linksData.push(newEdge);
            addedEdges += 1;
        }

        if (addedNodes || addedEdges) {
            simulation.nodes(nodesData);
            simulation.force("link").links(linksData);
            for (const node of nodesData) {
                if (node?.id) {
                    nodeLookup.set(String(node.id).toUpperCase(), node);
                }
            }
            updateGraphElements();
            scheduleLayout();
        }

        return { addedNodes, addedEdges };
    }

    async function buildGraphStreaming(rootKey, onBatch) {
        const nodes = new Map();
        const edges = new Map();
        const visited = new Set();

        async function visit(issueKey, depth, isRoot) {
            if (visited.has(issueKey) || nodes.size >= MAX_ISSUES) {
                return;
            }
            visited.add(issueKey);

            const issue = await fetchIssue(issueKey);
            const node = addNodeStreaming(issue);
            if (node) {
                nodes.set(node.id, node);
                await onBatch({ nodes: [node], edges: [] });
            }

            if (isRoot && isEpic(issue)) {
                await addEpicChildrenStreaming(issue);
            }

            const links = issue?.fields?.issuelinks ?? [];
            for (const link of links) {
                if (link.outwardIssue) {
                    const label = (link.type?.outward ?? "").trim();
                    if (!shouldKeepLink(label)) {
                        continue;
                    }
                    const linkedNode = addLinkedNodeStreaming(link.outwardIssue);
                    if (linkedNode) {
                        if (!nodes.has(linkedNode.id)) {
                            nodes.set(linkedNode.id, linkedNode);
                            await onBatch({ nodes: [linkedNode], edges: [] });
                        }
                    }
                    const { from, to } = orientEdge(issue.key, link.outwardIssue.key, label);
                    const edge = addEdgeStreaming(from, to, label);
                    if (edge && !edges.has(edge.id)) {
                        edges.set(edge.id, edge);
                        await onBatch({ nodes: [], edges: [edge] });
                    }
                    if (!visited.has(link.outwardIssue.key)) {
                        await visit(link.outwardIssue.key, depth + 1, false);
                    }
                }
                if (link.inwardIssue) {
                    const label = (link.type?.inward ?? "").trim();
                    if (!shouldKeepLink(label)) {
                        continue;
                    }
                    const linkedNode = addLinkedNodeStreaming(link.inwardIssue);
                    if (linkedNode) {
                        if (!nodes.has(linkedNode.id)) {
                            nodes.set(linkedNode.id, linkedNode);
                            await onBatch({ nodes: [linkedNode], edges: [] });
                        }
                    }
                    const { from, to } = orientEdge(link.inwardIssue.key, issue.key, label);
                    const edge = addEdgeStreaming(from, to, label);
                    if (edge && !edges.has(edge.id)) {
                        edges.set(edge.id, edge);
                        await onBatch({ nodes: [], edges: [edge] });
                    }
                    if (!visited.has(link.inwardIssue.key)) {
                        await visit(link.inwardIssue.key, depth + 1, false);
                    }
                }
            }
        }

        async function addEpicChildrenStreaming(epic) {
            try {
                const response = await fetchSearch(`"Epic Link" = "${epic.key}"`);
                const issues = response.issues ?? [];
                for (const child of issues) {
                    const node = addNodeStreaming(child);
                    if (node) {
                        if (!nodes.has(node.id)) {
                            nodes.set(node.id, node);
                            await onBatch({ nodes: [node], edges: [] });
                        }
                    }
                    const edge = addEdgeStreaming(epic.key, child.key, "contains");
                    if (edge && !edges.has(edge.id)) {
                        edges.set(edge.id, edge);
                        await onBatch({ nodes: [], edges: [edge] });
                    }
                    if (!visited.has(child.key)) {
                        await visit(child.key, 1, false);
                    }
                }
            } catch (error) {
                console.warn("jira-issue-graph", "Failed to load epic children", error);
            }
        }

        function addNodeStreaming(issue) {
            if (!issue?.key) {
                return null;
            }
            const key = issue.key.toUpperCase();
            const summary = issue.fields?.summary ?? "(no summary)";
            const typeName = issue.fields?.issuetype?.name ?? "Unknown";
            const statusName = normalizeStatusName(issue.fields?.status?.name ?? "");
            const existing = nodes.get(key) ?? {};
            return {
                ...existing,
                id: key,
                label: buildNodeLabel(key, statusName),
                type: typeName,
                summary,
                status: statusName,
            };
        }

        function addLinkedNodeStreaming(linkedIssue) {
            if (!linkedIssue?.key) {
                return null;
            }
            return addNodeStreaming({
                key: linkedIssue.key,
                fields: {
                    summary: linkedIssue.fields?.summary ?? "(no summary)",
                    issuetype: { name: linkedIssue.fields?.issuetype?.name ?? "Unknown" },
                    status: { name: linkedIssue.fields?.status?.name ?? "" },
                },
            });
        }

        function addEdgeStreaming(from, to, label) {
            if (!from || !to) {
                return null;
            }
            const normalizedFrom = String(from).toUpperCase();
            const normalizedTo = String(to).toUpperCase();
            const key = `${normalizedFrom}|${normalizedTo}|${label}`;
            return { id: key, source: normalizedFrom, target: normalizedTo, label };
        }

        await visit(rootKey, 0, true);
        return {
            nodes: Array.from(nodes.values()),
            edges: Array.from(edges.values()),
        };
    }

    function orientEdge(from, to, label) {
        if (label.toLowerCase() === "blocks") {
            return { from: to, to: from };
        }
        return { from, to };
    }

    function shouldKeepLink(label) {
        if (!label) {
            return false;
        }
        const normalized = label.toLowerCase();
        if (!KEEP_LINK_LABELS.has(normalized)) {
            return false;
        }
        return true;
    }

    function isEpic(issue) {
        return issue?.fields?.issuetype?.name?.toLowerCase() === "epic";
    }

    async function fetchIssue(key) {
        const url = `${API_BASE}/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(ISSUE_FIELDS)}`;
        return fetchJSON(url);
    }

    async function fetchSearch(jql) {
        const url = `${API_BASE}/search/jql`;
        const payload = {
            jql: jql,
            fields: ISSUE_FIELDS.split(","),
            maxResults: MAX_ISSUES,
        };

        const data = await fetchJSON(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        const issues = data?.issues ?? [];
        return { issues };
    }

    async function fetchJSON(path, init = {}) {
        const headers = {
            Accept: "application/json",
            ...init.headers,
        };
        const response = await fetch(path, {
            ...init,
            credentials: "same-origin",
            headers,
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Request failed (${response.status}): ${text}`);
        }
        return response.json();
    }

    function monitorNavigation() {
        let lastPath = window.location.pathname;
        setInterval(() => {
            if (window.location.pathname !== lastPath) {
                lastPath = window.location.pathname;
                setTimeout(ensureButton, 500);
            }
        }, 1000);
    }

    function bootstrap() {
        ensureButton();
        ensurePanel();
        monitorNavigation();
    }

    bootstrap();
})();
