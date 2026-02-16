const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL = 30 * 1000; // 30 seconds

class GraphStore {
  constructor() {
    // Raw events (ring buffer with timestamps)
    this.events = [];
    // Nodes: id -> { id, type, label, editCount, lastSeen, wiki, ... }
    this.nodes = new Map();
    // Edges: id -> { id, source, target, weight, lastSeen, view }
    this.edges = new Map();
    // Per-article editor sets for co-edit detection
    this.articleEditors = new Map(); // articleId -> Set<editorId>
    // Per-wiki editor sets for wiki-domain view
    this.wikiEditors = new Map(); // wiki -> Set<editorId>
    // Metrics
    this.totalEdits = 0;
    this.editTimestamps = []; // for edits/sec calculation
    // Recent events for burst detection
    this.articleRecentEdits = new Map(); // articleId -> [timestamps]

    this._startCleanup();
  }

  processEvent(evt) {
    const now = Date.now();
    this.totalEdits++;
    this.editTimestamps.push(now);
    this.events.push({ ...evt, _receivedAt: now });

    const editorId = `editor:${evt.user}`;
    const articleId = `article:${evt.title}`;
    const wikiId = `wiki:${evt.wiki}`;

    // Track article recent edits for burst detection
    if (!this.articleRecentEdits.has(articleId)) {
      this.articleRecentEdits.set(articleId, []);
    }
    this.articleRecentEdits.get(articleId).push(now);

    const changes = { nodesAdded: [], nodesUpdated: [], edgesAdded: [], edgesUpdated: [] };

    // --- Upsert editor node ---
    if (this.nodes.has(editorId)) {
      const n = this.nodes.get(editorId);
      n.editCount++;
      n.lastSeen = now;
      changes.nodesUpdated.push(n);
    } else {
      const n = { id: editorId, type: "editor", label: evt.user, editCount: 1, lastSeen: now, bot: evt.bot };
      this.nodes.set(editorId, n);
      changes.nodesAdded.push(n);
    }

    // --- Upsert article node ---
    if (this.nodes.has(articleId)) {
      const n = this.nodes.get(articleId);
      n.editCount++;
      n.lastSeen = now;
      changes.nodesUpdated.push(n);
    } else {
      const n = { id: articleId, type: "article", label: evt.title, editCount: 1, lastSeen: now, wiki: evt.wiki, namespace: evt.namespace };
      this.nodes.set(articleId, n);
      changes.nodesAdded.push(n);
    }

    // --- Upsert wiki node ---
    if (this.nodes.has(wikiId)) {
      const n = this.nodes.get(wikiId);
      n.editCount++;
      n.lastSeen = now;
      changes.nodesUpdated.push(n);
    } else {
      const n = { id: wikiId, type: "wiki", label: evt.wiki, editCount: 1, lastSeen: now };
      this.nodes.set(wikiId, n);
      changes.nodesAdded.push(n);
    }

    // --- Bipartite edge: editor -> article ---
    const biEdgeId = `bi:${editorId}|${articleId}`;
    if (this.edges.has(biEdgeId)) {
      const e = this.edges.get(biEdgeId);
      e.weight++;
      e.lastSeen = now;
      changes.edgesUpdated.push(e);
    } else {
      const e = { id: biEdgeId, source: editorId, target: articleId, weight: 1, lastSeen: now, view: "bipartite" };
      this.edges.set(biEdgeId, e);
      changes.edgesAdded.push(e);
    }

    // --- Co-edit edges: between articles sharing an editor ---
    if (!this.articleEditors.has(articleId)) {
      this.articleEditors.set(articleId, new Set());
    }
    const prevArticlesOfEditor = [];
    for (const [aid, editors] of this.articleEditors) {
      if (aid !== articleId && editors.has(editorId)) {
        prevArticlesOfEditor.push(aid);
      }
    }
    this.articleEditors.get(articleId).add(editorId);

    for (const otherArticle of prevArticlesOfEditor) {
      const [a, b] = [articleId, otherArticle].sort();
      const coEdgeId = `co:${a}|${b}`;
      if (this.edges.has(coEdgeId)) {
        const e = this.edges.get(coEdgeId);
        e.weight++;
        e.lastSeen = now;
        changes.edgesUpdated.push(e);
      } else {
        const e = { id: coEdgeId, source: a, target: b, weight: 1, lastSeen: now, view: "coedit" };
        this.edges.set(coEdgeId, e);
        changes.edgesAdded.push(e);
      }
    }

    // --- Wiki-domain edges: between wikis sharing editors ---
    if (!this.wikiEditors.has(wikiId)) {
      this.wikiEditors.set(wikiId, new Set());
    }
    const prevWikis = [];
    for (const [wid, editors] of this.wikiEditors) {
      if (wid !== wikiId && editors.has(editorId)) {
        prevWikis.push(wid);
      }
    }
    this.wikiEditors.get(wikiId).add(editorId);

    for (const otherWiki of prevWikis) {
      const [a, b] = [wikiId, otherWiki].sort();
      const wdEdgeId = `wd:${a}|${b}`;
      if (this.edges.has(wdEdgeId)) {
        const e = this.edges.get(wdEdgeId);
        e.weight++;
        e.lastSeen = now;
        changes.edgesUpdated.push(e);
      } else {
        const e = { id: wdEdgeId, source: a, target: b, weight: 1, lastSeen: now, view: "wiki-domain" };
        this.edges.set(wdEdgeId, e);
        changes.edgesAdded.push(e);
      }
    }

    return changes;
  }

  getSnapshot(view) {
    const nodes = [];
    const edges = [];

    if (view === "bipartite") {
      const relevantEdges = [...this.edges.values()].filter((e) => e.view === "bipartite");
      const nodeIds = new Set();
      for (const e of relevantEdges) {
        nodeIds.add(e.source);
        nodeIds.add(e.target);
        edges.push(e);
      }
      for (const id of nodeIds) {
        if (this.nodes.has(id)) nodes.push(this.nodes.get(id));
      }
    } else if (view === "coedit") {
      const relevantEdges = [...this.edges.values()].filter((e) => e.view === "coedit");
      const nodeIds = new Set();
      for (const e of relevantEdges) {
        nodeIds.add(e.source);
        nodeIds.add(e.target);
        edges.push(e);
      }
      for (const id of nodeIds) {
        if (this.nodes.has(id)) nodes.push(this.nodes.get(id));
      }
    } else if (view === "wiki-domain") {
      const relevantEdges = [...this.edges.values()].filter((e) => e.view === "wiki-domain");
      const nodeIds = new Set();
      for (const e of relevantEdges) {
        nodeIds.add(e.source);
        nodeIds.add(e.target);
        edges.push(e);
      }
      for (const id of nodeIds) {
        if (this.nodes.has(id)) nodes.push(this.nodes.get(id));
      }
    }

    return { nodes, edges };
  }

  _startCleanup() {
    setInterval(() => {
      const cutoff = Date.now() - WINDOW_MS;
      const removedNodes = [];
      const removedEdges = [];

      for (const [id, edge] of this.edges) {
        if (edge.lastSeen < cutoff) {
          this.edges.delete(id);
          removedEdges.push(id);
        }
      }

      // Remove nodes not referenced by any edge
      const referencedNodes = new Set();
      for (const edge of this.edges.values()) {
        referencedNodes.add(edge.source);
        referencedNodes.add(edge.target);
      }
      for (const [id, node] of this.nodes) {
        if (!referencedNodes.has(id) && node.lastSeen < cutoff) {
          this.nodes.delete(id);
          removedNodes.push(id);
          // Clean up tracking maps
          this.articleEditors.delete(id);
          this.wikiEditors.delete(id);
        }
      }

      // Clean up old edit timestamps
      this.editTimestamps = this.editTimestamps.filter((t) => t >= cutoff);
      this.events = this.events.filter((e) => e._receivedAt >= cutoff);

      // Clean up article recent edits
      for (const [aid, times] of this.articleRecentEdits) {
        const filtered = times.filter((t) => t >= cutoff);
        if (filtered.length === 0) {
          this.articleRecentEdits.delete(aid);
        } else {
          this.articleRecentEdits.set(aid, filtered);
        }
      }

      if (removedNodes.length || removedEdges.length) {
        console.log(`[cleanup] Removed ${removedNodes.length} nodes, ${removedEdges.length} edges`);
      }

      // Notify listeners
      if (this.onCleanup) {
        this.onCleanup(removedNodes, removedEdges);
      }
    }, CLEANUP_INTERVAL);
  }
}

module.exports = { GraphStore };
