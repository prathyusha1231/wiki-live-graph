// View configurations and node type styling
const Views = {
  current: "bipartite",

  // 8-color neon palette for community coloring
  communityPalette: [
    "#00d4ff", // cyan
    "#ff3888", // pink
    "#00ff88", // green
    "#ff9040", // orange
    "#b060ff", // purple
    "#ffee00", // yellow
    "#ff4060", // red
    "#40ffcc", // teal
  ],

  // Color palette per node type (fallback)
  colors: {
    editor: "#00d4ff",
    article: "#ff3888",
    wiki: "#00ff88",
  },

  // Which node types to show per view
  nodeFilter: {
    bipartite: new Set(["editor", "article"]),
    coedit: new Set(["article"]),
    "wiki-domain": new Set(["wiki"]),
  },

  // Which edge view prefix to include
  edgePrefix: {
    bipartite: "bi:",
    coedit: "co:",
    "wiki-domain": "wd:",
  },

  // Current ML data
  mlData: null,

  shouldShowNode(node, view) {
    const filter = this.nodeFilter[view || this.current];
    return filter ? filter.has(node.type) : true;
  },

  shouldShowEdge(edge, view) {
    const prefix = this.edgePrefix[view || this.current];
    return prefix ? edge.id.startsWith(prefix) : true;
  },

  getNodeColor(node) {
    // Prefer community color if ML data available
    if (this.mlData && this.mlData.communities && node.id in this.mlData.communities) {
      const communityId = this.mlData.communities[node.id];
      return this.communityPalette[communityId % this.communityPalette.length];
    }
    return this.colors[node.type] || "#888888";
  },

  getNodeSize(node) {
    const base = 3;
    let scale = Math.min(Math.log2(node.editCount + 1) * 2, 20);

    // Blend with PageRank if available
    if (this.mlData && this.mlData.pagerank && node.id in this.mlData.pagerank) {
      const prScore = this.mlData.pagerank[node.id]; // 0-1
      // PageRank adds up to 8 extra size
      scale += prScore * 8;
    }

    return base + scale;
  },

  setView(view) {
    this.current = view;
    // Update button states
    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === view);
    });
  },

  setMLData(ml) {
    this.mlData = ml;
  },
};
