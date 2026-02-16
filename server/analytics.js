class Analytics {
  constructor(store) {
    this.store = store;

    // ML cache
    this._mlCache = null;
    this._mlLastComputed = 0;
    this._mlInterval = 10000; // recompute every 10s

    // Start ML computation loop
    setInterval(() => this._computeML(), this._mlInterval);
  }

  getMetrics() {
    const now = Date.now();
    const twoMinAgo = now - 2 * 60 * 1000;

    // Edits per second (rolling 5s average)
    const fiveSecAgo = now - 5000;
    const recentEdits = this.store.editTimestamps.filter((t) => t >= fiveSecAgo);
    const editsPerSec = (recentEdits.length / 5).toFixed(1);

    // Top 10 edited articles
    const articles = [...this.store.nodes.values()]
      .filter((n) => n.type === "article")
      .sort((a, b) => b.editCount - a.editCount)
      .slice(0, 10)
      .map((n) => ({ label: n.label, editCount: n.editCount, wiki: n.wiki }));

    // Top 5 active editors
    const editors = [...this.store.nodes.values()]
      .filter((n) => n.type === "editor")
      .sort((a, b) => b.editCount - a.editCount)
      .slice(0, 5)
      .map((n) => ({ label: n.label, editCount: n.editCount, bot: n.bot }));

    // Burst detection: articles with >= 4 edits in last 2 min
    const bursts = [];
    for (const [aid, times] of this.store.articleRecentEdits) {
      const recent = times.filter((t) => t >= twoMinAgo);
      if (recent.length >= 4) {
        const node = this.store.nodes.get(aid);
        if (node) {
          bursts.push({ label: node.label, recentEdits: recent.length, wiki: node.wiki });
        }
      }
    }
    bursts.sort((a, b) => b.recentEdits - a.recentEdits);

    // Edit war detection
    const editWars = [];
    for (const [aid, times] of this.store.articleRecentEdits) {
      const recent = times.filter((t) => t >= twoMinAgo);
      if (recent.length >= 5) {
        const node = this.store.nodes.get(aid);
        if (node) {
          editWars.push({ label: node.label, editsIn2Min: recent.length, wiki: node.wiki });
        }
      }
    }
    // Also check recent events for revert/undo keywords
    const revertEvents = this.store.events.filter(
      (e) => e._receivedAt >= twoMinAgo && /revert|undo|rv\b/i.test(e.comment)
    );
    for (const evt of revertEvents) {
      const existing = editWars.find((w) => w.label === evt.title);
      if (!existing) {
        editWars.push({ label: evt.title, editsIn2Min: 0, wiki: evt.wiki, revertDetected: true });
      } else {
        existing.revertDetected = true;
      }
    }

    // Active wiki counts
    const wikiCounts = {};
    for (const n of this.store.nodes.values()) {
      if (n.type === "wiki") {
        wikiCounts[n.label] = n.editCount;
      }
    }
    const topWikis = Object.entries(wikiCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, count]) => ({ label, editCount: count }));

    return {
      editsPerSec: parseFloat(editsPerSec),
      totalEdits: this.store.totalEdits,
      nodeCount: this.store.nodes.size,
      edgeCount: this.store.edges.size,
      topArticles: articles,
      topEditors: editors,
      bursts: bursts.slice(0, 5),
      editWars: editWars.slice(0, 5),
      topWikis,
    };
  }

  getMLData() {
    return this._mlCache;
  }

  // === Graph ML Algorithms ===

  _computeML() {
    const nodeCount = this.store.nodes.size;
    // Performance guard: skip if too many nodes
    if (nodeCount > 1500 || nodeCount < 3) {
      return;
    }

    try {
      const communities = this._communityDetection();
      const pagerank = this._pageRank();
      const { hubs, degreeCentrality } = this._degreeCentrality();
      const anomalies = this._anomalyDetection();

      this._mlCache = {
        communities,  // { nodeId: communityId }
        pagerank,     // { nodeId: score }
        hubs,         // [{ id, label, degree }]
        anomalies,    // { nodeId: { type, score, details } }
      };
      this._mlLastComputed = Date.now();
    } catch (err) {
      console.error("[ml] Error computing ML:", err.message);
    }
  }

  // Algorithm 1: Community Detection (Label Propagation)
  _communityDetection() {
    // Project bipartite graph into a unipartite article graph:
    // Two articles are connected if they share an editor.
    // This avoids label propagation oscillation on bipartite structures.

    // Step 1: Build editor -> [articles] index from bipartite edges
    const editorArticles = new Map(); // editorId -> Map<articleId, weight>
    for (const edge of this.store.edges.values()) {
      if (edge.view !== "bipartite") continue;
      const editor = edge.source;
      const article = edge.target;
      if (!editorArticles.has(editor)) editorArticles.set(editor, new Map());
      editorArticles.get(editor).set(article, (editorArticles.get(editor).get(article) || 0) + (edge.weight || 1));
    }

    // Step 2: Build article-article adjacency (projected co-edit graph)
    const adj = new Map(); // nodeId -> Map<neighborId, weight>

    // Add explicit co-edit edges
    for (const edge of this.store.edges.values()) {
      if (edge.view !== "coedit") continue;
      if (!adj.has(edge.source)) adj.set(edge.source, new Map());
      if (!adj.has(edge.target)) adj.set(edge.target, new Map());
      const w1 = adj.get(edge.source).get(edge.target) || 0;
      adj.get(edge.source).set(edge.target, w1 + (edge.weight || 1));
      const w2 = adj.get(edge.target).get(edge.source) || 0;
      adj.get(edge.target).set(edge.source, w2 + (edge.weight || 1));
    }

    // Add projected bipartite edges: if an editor edited articles A and B, link A-B
    for (const [editor, articles] of editorArticles) {
      const articleIds = [...articles.keys()];
      for (let i = 0; i < articleIds.length; i++) {
        for (let j = i + 1; j < articleIds.length; j++) {
          const a = articleIds[i], b = articleIds[j];
          if (!adj.has(a)) adj.set(a, new Map());
          if (!adj.has(b)) adj.set(b, new Map());
          adj.get(a).set(b, (adj.get(a).get(b) || 0) + 1);
          adj.get(b).set(a, (adj.get(b).get(a) || 0) + 1);
        }
      }
    }

    // Also add editors to the adjacency so they inherit their articles' community
    for (const [editor, articles] of editorArticles) {
      if (!adj.has(editor)) adj.set(editor, new Map());
      for (const [article, weight] of articles) {
        if (!adj.has(article)) adj.set(article, new Map());
        adj.get(editor).set(article, (adj.get(editor).get(article) || 0) + weight);
        adj.get(article).set(editor, (adj.get(article).get(editor) || 0) + weight);
      }
    }

    // Initialize each node with its own label
    const labels = new Map();
    let labelCounter = 0;
    for (const nodeId of adj.keys()) {
      labels.set(nodeId, labelCounter++);
    }

    // Iterative label propagation
    const maxIterations = 20;
    const nodeIds = [...adj.keys()];

    for (let iter = 0; iter < maxIterations; iter++) {
      let changed = false;

      // Shuffle node order for randomness
      for (let i = nodeIds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [nodeIds[i], nodeIds[j]] = [nodeIds[j], nodeIds[i]];
      }

      for (const nodeId of nodeIds) {
        const neighbors = adj.get(nodeId);
        if (!neighbors || neighbors.size === 0) continue;

        // Count weighted votes for each label
        const labelVotes = new Map();
        for (const [neighborId, weight] of neighbors) {
          const neighborLabel = labels.get(neighborId);
          if (neighborLabel !== undefined) {
            labelVotes.set(neighborLabel, (labelVotes.get(neighborLabel) || 0) + weight);
          }
        }

        // Pick label with highest weighted vote
        let bestLabel = labels.get(nodeId);
        let bestWeight = 0;
        for (const [label, weight] of labelVotes) {
          if (weight > bestWeight) {
            bestWeight = weight;
            bestLabel = label;
          }
        }

        if (bestLabel !== labels.get(nodeId)) {
          labels.set(nodeId, bestLabel);
          changed = true;
        }
      }

      // Early stop on convergence
      if (!changed) break;
    }

    // Post-process: merge singleton/tiny communities (size <= 2) into buckets
    // so we get fewer, more visually distinct colors
    const commSizes = new Map(); // label -> count
    for (const label of labels.values()) {
      commSizes.set(label, (commSizes.get(label) || 0) + 1);
    }

    // Remap: large communities keep distinct IDs (0, 1, 2, ...),
    // small ones get merged into rotating bucket IDs
    const remapped = new Map(); // old label -> new label
    let nextId = 0;
    let smallBucket = 0;
    const NUM_SMALL_BUCKETS = 4; // merge singletons into 4 color groups

    for (const [label, size] of commSizes) {
      if (size > 2) {
        remapped.set(label, nextId++);
      }
    }
    // Assign small communities to rotating buckets after the big ones
    const smallStart = nextId;
    for (const [label, size] of commSizes) {
      if (size <= 2) {
        remapped.set(label, smallStart + (smallBucket++ % NUM_SMALL_BUCKETS));
      }
    }

    // Convert to plain object for JSON serialization
    const result = {};
    for (const [nodeId, label] of labels) {
      result[nodeId] = remapped.get(label) ?? 0;
    }
    return result;
  }

  // Algorithm 2: PageRank
  _pageRank() {
    const damping = 0.85;
    const iterations = 20;

    // Build adjacency list from bipartite edges
    const outLinks = new Map(); // nodeId -> Set<targetId>
    const inLinks = new Map();  // nodeId -> Set<sourceId>
    const allNodes = new Set();

    for (const edge of this.store.edges.values()) {
      if (edge.view !== "bipartite") continue;

      allNodes.add(edge.source);
      allNodes.add(edge.target);

      if (!outLinks.has(edge.source)) outLinks.set(edge.source, new Set());
      outLinks.get(edge.source).add(edge.target);

      if (!outLinks.has(edge.target)) outLinks.set(edge.target, new Set());
      outLinks.get(edge.target).add(edge.source);

      if (!inLinks.has(edge.target)) inLinks.set(edge.target, new Set());
      inLinks.get(edge.target).add(edge.source);

      if (!inLinks.has(edge.source)) inLinks.set(edge.source, new Set());
      inLinks.get(edge.source).add(edge.target);
    }

    const N = allNodes.size;
    if (N === 0) return {};

    // Initialize PageRank
    const pr = new Map();
    const initVal = 1 / N;
    for (const node of allNodes) {
      pr.set(node, initVal);
    }

    // Iterate
    for (let iter = 0; iter < iterations; iter++) {
      const newPr = new Map();
      for (const node of allNodes) {
        let sum = 0;
        const incoming = inLinks.get(node);
        if (incoming) {
          for (const src of incoming) {
            const outDegree = outLinks.get(src) ? outLinks.get(src).size : 1;
            sum += (pr.get(src) || 0) / outDegree;
          }
        }
        newPr.set(node, (1 - damping) / N + damping * sum);
      }
      // Update
      for (const [node, val] of newPr) {
        pr.set(node, val);
      }
    }

    // Normalize to 0-1 range
    let maxPr = 0;
    for (const val of pr.values()) {
      if (val > maxPr) maxPr = val;
    }

    const result = {};
    for (const [nodeId, val] of pr) {
      result[nodeId] = maxPr > 0 ? val / maxPr : 0;
    }
    return result;
  }

  // Algorithm 3: Degree Centrality + Hub Detection
  _degreeCentrality() {
    const degrees = new Map(); // nodeId -> degree count

    for (const edge of this.store.edges.values()) {
      if (edge.view !== "bipartite") continue;
      degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
    }

    // Sort by degree descending
    const sorted = [...degrees.entries()].sort((a, b) => b[1] - a[1]);

    // Top 10% are hubs (minimum 1)
    const hubCount = Math.max(1, Math.ceil(sorted.length * 0.1));
    const hubs = sorted.slice(0, hubCount).map(([id, degree]) => {
      const node = this.store.nodes.get(id);
      return {
        id,
        label: node ? node.label : id,
        degree,
      };
    });

    // Build centrality map
    const degreeCentrality = {};
    const maxDegree = sorted.length > 0 ? sorted[0][1] : 1;
    for (const [id, deg] of degrees) {
      degreeCentrality[id] = deg / maxDegree;
    }

    return { hubs, degreeCentrality };
  }

  // Algorithm 4: Anomaly Detection
  _anomalyDetection() {
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;
    const anomalies = {};

    // Single pass: index recent bipartite edges by source (editor) and target (article)
    const editorArticleCounts = new Map(); // editorId -> count
    const articleEditorCounts = new Map();  // articleId -> count

    for (const edge of this.store.edges.values()) {
      if (edge.view !== "bipartite" || edge.lastSeen < fiveMinAgo) continue;

      // Count articles per editor
      if (edge.source.startsWith("editor:")) {
        editorArticleCounts.set(edge.source, (editorArticleCounts.get(edge.source) || 0) + 1);
      }
      // Count editors per article
      if (edge.target.startsWith("article:")) {
        articleEditorCounts.set(edge.target, (articleEditorCounts.get(edge.target) || 0) + 1);
      }
    }

    // Prolific editor: >10 articles in 5 min
    for (const [editorId, count] of editorArticleCounts) {
      if (count > 10) {
        const node = this.store.nodes.get(editorId);
        const score = Math.min(count / 20, 1);
        anomalies[editorId] = {
          type: "prolific_editor",
          score,
          details: `${node ? node.label : editorId} edited ${count} articles in 5 min`,
        };
      }
    }

    // Coordinated editing: article with >8 unique editors in 5 min
    for (const [articleId, editorCount] of articleEditorCounts) {
      if (editorCount > 8) {
        const node = this.store.nodes.get(articleId);
        const score = Math.min(editorCount / 15, 1);
        anomalies[articleId] = {
          type: "coordinated_edit",
          score,
          details: `${node ? node.label : articleId} has ${editorCount} editors in 5 min`,
        };
      }
    }

    return anomalies;
  }
}

module.exports = { Analytics };
