class Analytics {
  constructor(store) {
    this.store = store;

    // ML cache
    this._mlCache = null;
    this._mlLastComputed = 0;
    this._mlInterval = 10000; // recompute every 10s
    this._pythonUrl = process.env.ML_URL || "http://localhost:5001";

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

  // === ML Computation via Python Backend ===

  async _computeML() {
    const nodeCount = this.store.nodes.size;
    // Performance guard: skip if too many nodes or too few
    if (nodeCount > 1500 || nodeCount < 3) {
      return;
    }

    try {
      // Serialize graph data
      const nodes = [...this.store.nodes.values()].map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        editCount: n.editCount,
      }));
      const edges = [...this.store.edges.values()].map((e) => ({
        source: e.source,
        target: e.target,
        weight: e.weight,
        view: e.view,
        lastSeen: e.lastSeen,
      }));

      // POST to Python ML server
      const res = await fetch(`${this._pythonUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes, edges }),
      });

      if (!res.ok) {
        throw new Error(`Python ML server returned ${res.status}`);
      }

      this._mlCache = await res.json();
      this._mlLastComputed = Date.now();
    } catch (err) {
      console.error("[ml] Error calling Python ML server:", err.message);
    }
  }
}

module.exports = { Analytics };
