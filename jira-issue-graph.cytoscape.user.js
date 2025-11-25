// ==UserScript==
// @name         Jira Issue Graph (Cytoscape)
// @namespace    https://github.com/pestrad
// @version      0.1.0
// @description  Visualize Jira issue link graphs directly in the browser using Cytoscape.js.
// @author       pestrad
// @match        https://*.atlassian.net/*
// @grant        GM_addStyle
// @require      https://unpkg.com/cytoscape@3.26.0/dist/cytoscape.min.js
// @require      https://unpkg.com/klayjs@0.4.1/klay.js
// @require      https://unpkg.com/cytoscape-klay@3.1.3/cytoscape-klay.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const BUTTON_ID = "jira-issue-graph-toggle";
  const PANEL_ID = "jira-issue-graph-panel";
  const CY_CONTAINER_ID = "jira-issue-graph-canvas";
  const API_BASE = "/rest/api/3";
  const ISSUE_FIELDS = "summary,issuetype,issuelinks";
  const MAX_ISSUES = 200;

  const KEEP_LINK_LABELS = new Set(["blocks", "is blocked by"]);

  // Track rendered graph so epics can expand lazily without rebuilding everything.
  let cyInstance = null;
  let layoutScheduled = false;
  const expandedEpics = new Set();
  const epicExpansionPromises = new Map();
  let currentRootKey = null;

  if (typeof cytoscape !== "undefined" && typeof cytoscapeKlay === "function") {
    cytoscape.use(cytoscapeKlay);
  }

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
        const { addedNodes, addedEdges } = addElementsToGraph(batch);
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

    if (cyInstance) {
      cyInstance.destroy();
      cyInstance = null;
    }
    expandedEpics.clear();
    epicExpansionPromises.clear();
    layoutScheduled = false;

    const cy = cytoscape({
      container,
      elements: [
        ...nodes.map((node) => ({ data: node })),
        ...edges.map((edge) => ({ data: edge })),
      ],
      layout: getLayoutOptions(),
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#42526e",
            color: "#fff",
            "font-size": "10px",
            "text-wrap": "wrap",
            "text-max-width": "120px",
            "text-valign": "center",
            "text-halign": "center",
            label: "data(label)",
            width: "label",
            height: "label",
            padding: "8px",
            "border-width": 2,
            "border-color": "#fff",
            shape: "round-rectangle",
          },
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "#97a0af",
            "target-arrow-color": "#97a0af",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": "8px",
            "text-background-color": "#fff",
            "text-background-opacity": 0.7,
            "text-background-padding": 2,
          },
        },
        {
          selector: "node[type='Epic']",
          style: {
            "background-color": "#ffc400",
            color: "#172b4d",
          },
        },
        {
          selector: "node.root-issue",
          style: {
            "background-color": "#36b37e",
            "border-color": "#0747a6",
            "border-width": 3,
            color: "#fff",
          },
        },
      ],
    });

    cyInstance = cy;

    if (currentRootKey) {
      const rootNode = cy.getElementById(currentRootKey);
      if (rootNode && rootNode.length) {
        rootNode.addClass("root-issue");
      }
    }

    cy.on("tap", "node", (event) => {
      const issueKey = event.target?.id();
      if (!issueKey) {
        return;
      }
      const issueType = event.target?.data("type")?.toLowerCase?.();
      if (issueType === "epic" && !expandedEpics.has(issueKey)) {
        event.originalEvent?.preventDefault?.();
        void expandEpic(issueKey);
        return;
      }
      const issueUrl = new URL(`/browse/${issueKey}`, window.location.origin);
      window.open(issueUrl.toString(), "_blank", "noopener");
    });
  }

  function getLayoutOptions() {
    return {
      name: "klay",
      animate: false,
      fit: true,
      nodeDimensionsIncludeLabels: true,
      padding: 80,
      klay: {
        spacing: 80,
        edgeRouting: "POLYLINE",
        direction: "DOWN",
        inLayerSpacingFactor: 1.2,
      },
    };
  }

  function scheduleLayout() {
    if (layoutScheduled || !cyInstance) {
      return;
    }
    layoutScheduled = true;
    setTimeout(() => {
      if (!cyInstance) {
        layoutScheduled = false;
        return;
      }
      cyInstance.layout(getLayoutOptions()).run();
      layoutScheduled = false;
    }, 50);
  }

  function extractIssueKeyFromURL(url) {
    const match = url.match(/[A-Z][A-Z0-9]+-\d+/i);
    return match ? match[0].toUpperCase() : null;
  }

  async function expandEpic(epicKey) {
    const upperKey = epicKey?.toUpperCase?.();
    if (!upperKey || !cyInstance) {
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
    if (!cyInstance) {
      return { addedNodes: 0, addedEdges: 0 };
    }

    const cy = cyInstance;
    let addedNodes = 0;
    let addedEdges = 0;

    for (const node of batch.nodes ?? []) {
      if (!node?.id) {
        continue;
      }
      const existing = cy.getElementById(node.id);
      if (existing && existing.length) {
        existing.data({ ...existing.data(), ...node });
        if (node.id === currentRootKey) {
          existing.addClass("root-issue");
        }
        continue;
      }
      const added = cy.add({ data: node });
      if (node.id === currentRootKey) {
        added.addClass("root-issue");
      }
      addedNodes += 1;
    }

    for (const edge of batch.edges ?? []) {
      if (!edge?.id) {
        continue;
      }
      const existing = cy.getElementById(edge.id);
      if (existing && existing.length) {
        continue;
      }
      cy.add({ data: edge });
      addedEdges += 1;
    }

    if (addedNodes || addedEdges) {
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
      const existing = nodes.get(key) ?? {};
      return {
        ...existing,
        id: key,
        label: `${key}\n${summary}`,
        type: typeName,
        summary,
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
        },
      });
    }

    function addEdgeStreaming(from, to, label) {
      if (!from || !to) {
        return null;
      }
      const key = `${from}|${to}|${label}`;
      return { id: key, source: from, target: to, label };
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
