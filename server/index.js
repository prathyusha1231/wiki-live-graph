const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const { startIngestion } = require("./ingest");
const { GraphStore } = require("./graphStore");
const { Analytics } = require("./analytics");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

// Debug endpoint to evaluate ML output
app.get("/api/ml-eval", (req, res) => {
  const ml = analytics.getMLData();
  if (!ml) return res.json({ status: "not_computed_yet" });

  // Community evaluation
  const commValues = Object.values(ml.communities || {});
  const commSizes = {};
  for (const c of commValues) commSizes[c] = (commSizes[c] || 0) + 1;
  const commSizeArr = Object.values(commSizes).sort((a, b) => b - a);

  // PageRank evaluation
  const prValues = Object.values(ml.pagerank || {});
  const prSorted = [...prValues].sort((a, b) => b - a);

  // Hub evaluation
  const hubs = (ml.hubs || []).slice(0, 10);

  // Anomaly evaluation
  const anomalies = ml.anomalies || {};

  // Graph stats
  const nodeCount = store.nodes.size;
  const edgeCount = store.edges.size;

  res.json({
    graphStats: { nodeCount, edgeCount },
    communities: {
      totalNodes: commValues.length,
      uniqueCommunities: Object.keys(commSizes).length,
      largestCommunities: commSizeArr.slice(0, 10),
      singletons: commSizeArr.filter(s => s === 1).length,
    },
    pagerank: {
      totalNodes: prValues.length,
      top10scores: prSorted.slice(0, 10).map(v => +v.toFixed(4)),
      mean: prValues.length ? +(prValues.reduce((a, b) => a + b, 0) / prValues.length).toFixed(4) : 0,
      median: prValues.length ? +prSorted[Math.floor(prSorted.length / 2)].toFixed(4) : 0,
    },
    hubs: {
      count: (ml.hubs || []).length,
      top10: hubs.map(h => ({ label: h.label, degree: h.degree })),
    },
    anomalies: {
      count: Object.keys(anomalies).length,
      details: anomalies,
    },
    evaluation: ml.evaluation || null,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const store = new GraphStore();
const analytics = new Analytics(store);

// Track connected clients and their current views
const clients = new Map(); // ws -> { view: string }

wss.on("connection", (ws) => {
  console.log("[ws] Client connected");
  clients.set(ws, { view: "bipartite" });

  // Send initial snapshot
  const snapshot = store.getSnapshot("bipartite");
  ws.send(JSON.stringify({ type: "snapshot", ...snapshot }));

  // Send initial metrics
  ws.send(JSON.stringify({ type: "metrics_update", metrics: analytics.getMetrics() }));

  // Send initial ML data if available
  const ml = analytics.getMLData();
  if (ml) {
    ws.send(JSON.stringify({ type: "ml_update", ml }));
  }

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "set_view" && msg.view) {
        clients.set(ws, { view: msg.view });
        const snapshot = store.getSnapshot(msg.view);
        ws.send(JSON.stringify({ type: "snapshot", ...snapshot }));
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("[ws] Client disconnected");
  });
});

// Broadcast helper - sends to clients with matching view
function broadcast(message, viewFilter) {
  const data = JSON.stringify(message);
  for (const [ws, state] of clients) {
    if (ws.readyState === 1) {
      if (!viewFilter || state.view === viewFilter) {
        ws.send(data);
      }
    }
  }
}

function broadcastToAll(message) {
  const data = JSON.stringify(message);
  for (const [ws] of clients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

// Determine which views an edge belongs to
function viewForEdge(edge) {
  return edge.view;
}

// On each event from SSE
function handleEvent(evt) {
  const changes = store.processEvent(evt);

  // Broadcast node changes to all clients (nodes are shared)
  for (const node of changes.nodesAdded) {
    broadcastToAll({ type: "node_add", node });
  }
  for (const node of changes.nodesUpdated) {
    broadcastToAll({ type: "node_update", node });
  }

  // Broadcast edge changes only to clients with matching view
  for (const edge of changes.edgesAdded) {
    broadcast({ type: "edge_add", edge }, edge.view);
  }
  for (const edge of changes.edgesUpdated) {
    broadcast({ type: "edge_update", edge }, edge.view);
  }
}

// Cleanup handler: broadcast removals
store.onCleanup = (removedNodes, removedEdges) => {
  for (const id of removedNodes) {
    broadcastToAll({ type: "node_remove", id });
  }
  for (const id of removedEdges) {
    broadcastToAll({ type: "edge_remove", id });
  }
};

// Throttled metrics broadcast (every 2s) — without ML data
setInterval(() => {
  const metrics = analytics.getMetrics();
  broadcastToAll({ type: "metrics_update", metrics });
}, 2000);

// Separate ML broadcast (every 10s) — heavier payload, less frequent
setInterval(() => {
  const ml = analytics.getMLData();
  if (ml) {
    broadcastToAll({ type: "ml_update", ml });
  }
}, 10000);

// Start ingestion
startIngestion(handleEvent);

server.listen(PORT, () => {
  console.log(`[server] Wikipedia Live Graph running at http://localhost:${PORT}`);
});
