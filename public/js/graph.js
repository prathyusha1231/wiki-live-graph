// Graph rendering with Sigma.js + Graphology + ML integration
const GraphRenderer = {
  graph: null,
  renderer: null,
  animationNodes: new Map(), // nodeId -> { startTime, duration }
  layoutInterval: null,
  mlData: null, // current ML data
  _mlApplyPending: false,

  init() {
    // Create graphology graph
    this.graph = new graphology.Graph({ multi: false, type: "undirected", allowSelfLoops: false });

    const container = document.getElementById("sigma-container");

    // Hub set for quick lookup
    this._hubSet = new Set();

    // Initialize Sigma renderer
    this.renderer = new Sigma(this.graph, container, {
      renderLabels: true,
      labelRenderedSizeThreshold: 8,
      labelSize: 11,
      labelColor: { color: "#aaaacc" },
      labelFont: "Segoe UI, sans-serif",
      defaultEdgeColor: "#2a2a4a",
      defaultEdgeType: "line",
      edgeReducer: (edge, data) => {
        const res = { ...data };
        res.color = data.color || "#2a2a4a";
        const weight = data.weight || 1;
        res.size = Math.min(weight * 0.5, 4);
        // Brighter glow for high-weight edges
        if (weight >= 3) {
          const alpha = Math.min(0.15 + weight * 0.05, 0.6);
          res.color = `rgba(0, 212, 255, ${alpha})`;
        }
        return res;
      },
      nodeReducer: (node, data) => {
        const res = { ...data };

        // Apply community color from ML
        if (this.mlData && this.mlData.communities && node in this.mlData.communities) {
          const communityId = this.mlData.communities[node];
          res.color = Views.communityPalette[communityId % Views.communityPalette.length];
        }

        // Apply PageRank sizing
        if (this.mlData && this.mlData.pagerank && node in this.mlData.pagerank) {
          const prScore = this.mlData.pagerank[node];
          res.size = (res.size || 5) + prScore * 8;
        }

        // Hub border ring
        if (this._hubSet.has(node)) {
          res.borderColor = "#00d4ff";
          res.borderSize = 2;
        }

        // Anomaly red glow
        if (this.mlData && this.mlData.anomalies && node in this.mlData.anomalies) {
          res.color = "#ff3888";
          res.borderColor = "#ff3888";
          res.borderSize = 3;
        }

        // Check for pulse animation
        const anim = this.animationNodes.get(node);
        if (anim) {
          const elapsed = Date.now() - anim.startTime;
          if (elapsed < anim.duration) {
            const progress = elapsed / anim.duration;
            const pulse = 1 + 0.5 * Math.sin(progress * Math.PI);
            res.size = (res.size || 5) * pulse;
          } else {
            this.animationNodes.delete(node);
          }
        }
        return res;
      },
      zIndex: true,
    });

    // Enhanced tooltip on hover
    const tooltip = document.getElementById("node-tooltip");
    this.renderer.on("enterNode", ({ node }) => {
      const data = this.graph.getNodeAttributes(node);
      let html = `<div class="tt-label">${this._esc(data.label || node)}</div>`;
      html += `<div class="tt-row">Type: <span>${data.nodeType || "?"}</span></div>`;
      html += `<div class="tt-row">Edits: <span>${data.editCount || 0}</span></div>`;

      // ML info in tooltip
      if (this.mlData) {
        if (this.mlData.communities && node in this.mlData.communities) {
          const cid = this.mlData.communities[node];
          const color = Views.communityPalette[cid % Views.communityPalette.length];
          html += `<div class="tt-row"><span class="tt-community" style="background:${color}"></span>Community <span>${cid}</span></div>`;
        }
        if (this.mlData.pagerank && node in this.mlData.pagerank) {
          const pr = this.mlData.pagerank[node];
          html += `<div class="tt-row">PageRank: <span>${pr.toFixed(3)}</span></div>`;
        }
        if (this.mlData.anomalies && node in this.mlData.anomalies) {
          const a = this.mlData.anomalies[node];
          html += `<div class="tt-anomaly">${this._esc(a.type)}: ${this._esc(a.details)}</div>`;
        }
      }

      tooltip.innerHTML = html;
      tooltip.classList.remove("hidden");
    });

    this.renderer.on("leaveNode", () => {
      tooltip.classList.add("hidden");
    });

    this.renderer.getMouseCaptor().on("mousemove", (e) => {
      tooltip.style.left = e.x + 15 + "px";
      tooltip.style.top = e.y + 15 + "px";
    });

    // Start simple force layout loop
    this._startLayout();

    // Refresh animation frames
    this._animate();
  },

  applyMLData(ml) {
    if (!ml) return;
    this.mlData = ml;

    // Build hub set for quick lookup
    this._hubSet.clear();
    if (ml.hubs) {
      for (const hub of ml.hubs) {
        this._hubSet.add(hub.id);
      }
    }

    // Throttle the full graph recolor to next animation frame
    if (this._mlApplyPending) return;
    this._mlApplyPending = true;

    requestAnimationFrame(() => {
      this._mlApplyPending = false;

      // Update existing node colors and sizes based on ML
      this.graph.forEachNode((node, attrs) => {
        const nodeData = { id: node, type: attrs.nodeType, editCount: attrs.editCount };
        this.graph.setNodeAttribute(node, "color", Views.getNodeColor(nodeData));
        this.graph.setNodeAttribute(node, "size", Views.getNodeSize(nodeData));
      });

      this.renderer.refresh();
    });
  },

  loadSnapshot(data) {
    this.graph.clear();
    const view = Views.current;

    for (const node of data.nodes) {
      if (!Views.shouldShowNode(node, view)) continue;
      this._addNode(node);
    }

    for (const edge of data.edges) {
      if (!Views.shouldShowEdge(edge, view)) continue;
      this._addEdge(edge);
    }
  },

  addNode(node) {
    if (!Views.shouldShowNode(node)) return;
    this._addNode(node);
    this._pulseNode(node.id);
  },

  updateNode(node) {
    if (!this.graph.hasNode(node.id)) {
      if (Views.shouldShowNode(node)) {
        this._addNode(node);
      }
      return;
    }
    this.graph.setNodeAttribute(node.id, "editCount", node.editCount);
    this.graph.setNodeAttribute(node.id, "size", Views.getNodeSize(node));
    this._pulseNode(node.id);
  },

  removeNode(id) {
    if (this.graph.hasNode(id)) {
      this.graph.dropNode(id);
    }
    this.animationNodes.delete(id);
  },

  addEdge(edge) {
    if (!Views.shouldShowEdge(edge)) return;
    this._addEdge(edge);
  },

  updateEdge(edge) {
    if (!Views.shouldShowEdge(edge)) return;
    const edgeKey = this._edgeKey(edge);
    if (this.graph.hasEdge(edgeKey)) {
      this.graph.setEdgeAttribute(edgeKey, "weight", edge.weight);
    } else {
      this._addEdge(edge);
    }
  },

  removeEdge(id) {
    const edgeKey = id;
    if (this.graph.hasEdge(edgeKey)) {
      this.graph.dropEdge(edgeKey);
    }
  },

  _addNode(node) {
    if (this.graph.hasNode(node.id)) {
      this.graph.mergeNodeAttributes(node.id, {
        editCount: node.editCount,
        size: Views.getNodeSize(node),
      });
      return;
    }

    // Random initial position
    const angle = Math.random() * 2 * Math.PI;
    const radius = 0.5 + Math.random() * 0.5;

    this.graph.addNode(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: Views.getNodeSize(node),
      color: Views.getNodeColor(node),
      label: node.label,
      nodeType: node.type,
      editCount: node.editCount,
    });
  },

  _addEdge(edge) {
    // Ensure both endpoints exist
    if (!this.graph.hasNode(edge.source) || !this.graph.hasNode(edge.target)) return;
    const key = this._edgeKey(edge);
    if (this.graph.hasEdge(key)) return;
    if (edge.source === edge.target) return;

    try {
      this.graph.addEdgeWithKey(key, edge.source, edge.target, {
        weight: edge.weight,
        color: this._edgeColor(edge),
        size: Math.min(edge.weight * 0.5, 4),
      });
    } catch {
      // Edge may already exist between these nodes in an undirected graph
    }
  },

  _edgeKey(edge) {
    return edge.id || `${edge.source}|${edge.target}`;
  },

  _edgeColor(edge) {
    if (edge.view === "bipartite") return "rgba(0, 212, 255, 0.15)";
    if (edge.view === "coedit") return "rgba(255, 56, 136, 0.2)";
    if (edge.view === "wiki-domain") return "rgba(0, 255, 136, 0.2)";
    return "rgba(100, 100, 150, 0.15)";
  },

  _pulseNode(nodeId) {
    this.animationNodes.set(nodeId, { startTime: Date.now(), duration: 600 });
  },

  _animate() {
    if (this.animationNodes.size > 0) {
      this.renderer.refresh();
    }
    requestAnimationFrame(() => this._animate());
  },

  // Simple force-directed layout (spring model)
  _startLayout() {
    const REPULSION = 0.8;
    const ATTRACTION = 0.0005;
    const DAMPING = 0.9;
    const MAX_DISP = 0.1;

    // Store velocities
    const velocities = new Map();

    this.layoutInterval = setInterval(() => {
      const nodes = this.graph.nodes();
      if (nodes.length === 0 || nodes.length > 2000) return;

      // Initialize velocities for new nodes
      for (const n of nodes) {
        if (!velocities.has(n)) velocities.set(n, { vx: 0, vy: 0 });
      }

      // Clean up removed nodes
      for (const key of velocities.keys()) {
        if (!this.graph.hasNode(key)) velocities.delete(key);
      }

      const positions = {};
      for (const n of nodes) {
        positions[n] = {
          x: this.graph.getNodeAttribute(n, "x") || 0,
          y: this.graph.getNodeAttribute(n, "y") || 0,
        };
      }

      // Repulsion between all node pairs (limit to 500 nodes for perf)
      const subset = nodes.length > 500 ? nodes.slice(0, 500) : nodes;
      for (let i = 0; i < subset.length; i++) {
        for (let j = i + 1; j < subset.length; j++) {
          const a = subset[i], b = subset[j];
          const dx = positions[a].x - positions[b].x;
          const dy = positions[a].y - positions[b].y;
          const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
          const force = REPULSION / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          velocities.get(a).vx += fx;
          velocities.get(a).vy += fy;
          velocities.get(b).vx -= fx;
          velocities.get(b).vy -= fy;
        }
      }

      // Attraction along edges
      this.graph.forEachEdge((edge, attr, source, target) => {
        if (!positions[source] || !positions[target]) return;
        const dx = positions[target].x - positions[source].x;
        const dy = positions[target].y - positions[source].y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const force = dist * ATTRACTION * (attr.weight || 1);
        const fx = dx * force;
        const fy = dy * force;

        if (velocities.has(source)) {
          velocities.get(source).vx += fx;
          velocities.get(source).vy += fy;
        }
        if (velocities.has(target)) {
          velocities.get(target).vx -= fx;
          velocities.get(target).vy -= fy;
        }
      });

      // Apply velocities
      for (const n of nodes) {
        const v = velocities.get(n);
        if (!v) continue;
        v.vx *= DAMPING;
        v.vy *= DAMPING;

        // Clamp displacement
        const disp = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
        if (disp > MAX_DISP) {
          v.vx = (v.vx / disp) * MAX_DISP;
          v.vy = (v.vy / disp) * MAX_DISP;
        }

        const newX = (positions[n]?.x || 0) + v.vx;
        const newY = (positions[n]?.y || 0) + v.vy;
        this.graph.setNodeAttribute(n, "x", newX);
        this.graph.setNodeAttribute(n, "y", newY);
      }

      this.renderer.refresh();
    }, 50); // 20 fps layout
  },

  _esc(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  },
};
