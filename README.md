# Wikipedia Live Graph

Real-time visualization of Wikipedia edits as an interactive force-directed graph, with **real ML algorithms** running on a Python backend using NetworkX and scikit-learn for community detection, influence ranking, hub identification, and anomaly detection.

Built with Node.js, WebSockets, Sigma.js, Graphology, and a Python ML backend (Flask + NetworkX + scikit-learn).

---

## What It Does

The app connects to the [Wikimedia EventStreams API](https://stream.wikimedia.org/v2/stream/recentchange) via Server-Sent Events (SSE) and processes every real-time edit happening across all Wikipedia languages. Each edit produces graph nodes (editors, articles, wikis) and edges (who edited what), which are broadcast to connected browsers via WebSocket and rendered as a live force-directed graph.

On top of the live graph, four ML algorithms run on a Python backend every 10 seconds, coloring nodes by community, sizing them by influence, highlighting hubs, and flagging anomalous editing patterns.

---

## Architecture

```
Wikimedia SSE  -->  [ingest.js]  -->  [graphStore.js]  -->  [index.js]  -->  WebSocket  -->  Browser
                     Parses edits      Manages nodes/        Broadcasts         Sigma.js
                     Filters noise     edges/metadata        diffs + ML         renders graph
                                             |
                                       [analytics.js]
                                       Metrics + HTTP POST
                                             |
                                       [ml/server.py]  (Flask)
                                       NetworkX + scikit-learn
                                       4 ML algorithms + evaluation
```

### Data Flow

1. **Ingestion** (`server/ingest.js`): Connects to `stream.wikimedia.org` via SSE. Filters to namespace 0 (actual articles), excludes bots, Wikidata, Commons, and meta wikis. Emits clean event objects.

2. **Graph Store** (`server/graphStore.js`): Maintains an in-memory graph with a 10-minute sliding window. Each edit creates/updates:
   - **Editor node** (`editor:{username}`)
   - **Article node** (`article:{title}`)
   - **Wiki node** (`wiki:{wiki}`)
   - **Bipartite edge** (editor -> article)
   - **Co-edit edge** (article <-> article, when they share an editor)
   - **Wiki-domain edge** (wiki <-> wiki, when they share an editor)

   Stale nodes and edges are cleaned up every 30 seconds.

3. **Analytics** (`server/analytics.js`): Computes rolling metrics (edits/sec, top articles, burst detection, edit wars) every 2 seconds. Every 10 seconds, serializes the current graph and POSTs it to the Python ML server.

4. **Python ML Server** (`ml/server.py`): Flask server running on port 5001. Receives graph snapshots via HTTP POST and runs 4 ML algorithms using real ML libraries:
   - **Community Detection**: NetworkX Louvain algorithm (`louvain_communities()`)
   - **PageRank**: NetworkX eigenvector-based PageRank (`nx.pagerank()`)
   - **Hub Detection**: NetworkX degree centrality (`nx.degree_centrality()`)
   - **Anomaly Detection**: scikit-learn IsolationForest (unsupervised ML)

   Returns results + evaluation metrics in JSON.

5. **Server** (`server/index.js`): Express + WebSocket server. Sends graph snapshots on connect, then streams incremental diffs (node_add, node_update, edge_add, etc.). Metrics broadcast every 2s. ML results broadcast every 10s on a separate `ml_update` channel.

6. **Browser** (`public/`): Sigma.js renders the graph with force-directed layout. Panel shows live stats, sparkline, ML insights. Three view modes available.

---

## Graph ML Algorithms

All four algorithms run on the Python backend (`ml/server.py`) using real ML libraries. Results are cached in Node.js and broadcast every 10 seconds. Computation is skipped entirely if the graph exceeds 1,500 nodes (performance guard).

### 1. Community Detection — NetworkX Louvain

**What it does**: Groups nodes into communities — clusters of editors and articles that are closely connected through co-editing patterns.

**How it works**:
- Builds a NetworkX `Graph` from bipartite and co-edit edges
- Uses `networkx.algorithms.community.louvain_communities()` — the real Louvain algorithm with modularity optimization
- Resolution parameter: 1.0 (standard)
- Isolated nodes assigned to a catch-all community
- Output: `{ nodeId: communityId }` mapping

**Frontend effect**: Nodes are colored using an 8-color neon palette based on their community ID.

**Why Louvain**: Produces higher-quality partitions than label propagation, with provable modularity optimization. NetworkX implementation handles weighted graphs natively.

### 2. PageRank — NetworkX Eigenvector PageRank

**What it does**: Ranks every node by its structural importance in the editing network.

**How it works**:
- Builds a directed graph from bipartite edges
- Uses `networkx.pagerank(G, alpha=0.85)` — eigenvector-based, not manual loops
- Max 100 iterations with convergence tolerance 1e-06
- Scores normalized to 0-1 range
- Output: `{ nodeId: score }` mapping

**Frontend effect**: Node size is increased proportionally to PageRank score.

### 3. Hub Detection — NetworkX Degree Centrality

**What it does**: Identifies "hub" nodes — the most connected editors and articles.

**How it works**:
- Uses `networkx.degree_centrality(G)` for normalized centrality scores
- Top 10% by centrality are classified as hubs (minimum 1)
- Output: `hubs` array with `[{ id, label, degree }]`

**Frontend effect**: Hub nodes get a cyan border ring. Top 5 hubs listed in the ML Insights panel.

### 4. Anomaly Detection — scikit-learn IsolationForest

**What it does**: Detects outlier nodes using **real unsupervised machine learning**.

**How it works**:
- Extracts 4 features per node: edit count, degree, clustering coefficient, PageRank score
- Uses `sklearn.ensemble.IsolationForest` — learns the normal distribution of node features and flags deviations
- 100 estimators, contamination auto-tuned based on graph size
- Decision function scores converted to 0-1 anomaly scores
- Anomalies classified by node type: prolific editors, coordinated edits, or structural outliers
- Output: `{ nodeId: { type, score, details } }` mapping

**Frontend effect**: Anomalous nodes glow red with a pink border.

**Why IsolationForest**: It's genuine unsupervised ML — no manual thresholds. It learns what "normal" looks like from the data and automatically detects deviations, adapting as the graph evolves.

---

## Evaluation Metrics

Every ML cycle (10s), evaluation metrics are computed in Python alongside the algorithms. These are displayed live in the ML Insights panel and available via the `/api/ml-eval` debug endpoint.

### Community Detection Evaluation

| Metric | Method | Range | What It Tells You |
|--------|--------|-------|-------------------|
| **Modularity Q** | `networkx.community.modularity()` | -0.5 to 1.0 | Standard measure of community partition quality. **Q > 0.3** = significant structure. |
| **Coverage** | Intra-community edges / total edges | 0 to 1 | Fraction of edges within communities. |

### PageRank Evaluation

| Metric | Method | Range | What It Tells You |
|--------|--------|-------|-------------------|
| **Gini Coefficient** | NumPy vectorized computation | 0 to 1 | Inequality of influence distribution. |
| **Normalized Shannon Entropy** | NumPy log2 computation | 0 to 1 | How spread out the PageRank distribution is. |
| **Top 10% Concentration** | NumPy array slicing | 0 to 1 | How much influence the top-ranked nodes hold. |

### Hub Detection Evaluation

| Metric | What It Tells You |
|--------|-------------------|
| **Hub Concentration** | Whether one hub dominates or hubs are evenly distributed. |

### Anomaly Detection Evaluation

| Metric | What It Tells You |
|--------|-------------------|
| **Total Count** | Number of IsolationForest outliers |
| **Avg Score** | Mean anomaly score (from decision function) |
| **Prolific Editors** | Outlier editors |
| **Coordinated Edits** | Outlier articles |

### API Access

Evaluation metrics are available at:
- **Live panel**: ML Insights section in the sidebar
- **JSON endpoint**: `GET /api/ml-eval` returns all metrics with raw algorithm output

---

## Three Graph Views

The app supports three different views of the same underlying data:

| View | Nodes | Edges | What It Shows |
|------|-------|-------|---------------|
| **Bipartite** | Editors + Articles | Editor -> Article | Who is editing what, right now |
| **Co-Edit** | Articles only | Article <-> Article | Articles linked by shared editors |
| **Wiki Domain** | Wikis only | Wiki <-> Wiki | Wikis linked by cross-wiki editors |

Switching views sends a `set_view` message to the server, which responds with a fresh snapshot filtered to that view.

---

## Command Center Visuals

The frontend is styled as a cinematic "command center" dashboard:

### CSS Effects
- **Scanline overlay**: Animated horizontal lines scrolling over the graph canvas, simulating a CRT monitor effect.
- **Vignette**: `inset box-shadow` on the graph container darkens the edges.
- **Pulsing radial background**: Intensity driven by current edits/sec rate.
- **Monospace numbers**: All statistics use `Consolas / SF Mono / Fira Code`.
- **Breathing status dot**: The "Live" indicator uses a pulse animation.

### Live Dashboard Elements
- **UTC clock**: Ticks every second in the header.
- **Event ticker**: Running count of total events processed.
- **Sparkline chart**: Canvas-drawn edits/sec history with cyan gradient fill.
- **Rolling counter animations**: Values animate with slide-up transition.
- **ML Insights panel**: Community count, hub list, anomaly alerts.

### Tooltip
Hovering a node shows: label, type, edit count, community ID, PageRank score, and anomaly alert if flagged.

---

## Performance Considerations

- **ML computation guard**: All 4 algorithms are skipped if the graph exceeds 1,500 nodes
- **Separate broadcast intervals**: Metrics update every 2s. ML data updates every 10s.
- **Python ML server**: Runs in a separate process, doesn't block Node.js event loop
- **Layout cap**: Force-directed layout skips computation when node count exceeds 2,000
- **10-minute sliding window**: Old nodes and edges are cleaned up every 30s

---

## Project Structure

```
wiki-live-graph/
  server/
    index.js          Express + WebSocket server, broadcast logic
    ingest.js         Wikimedia SSE stream consumer
    graphStore.js     In-memory graph with sliding window cleanup
    analytics.js      Metrics + HTTP POST to Python ML server
  ml/
    server.py         Flask server with NetworkX + scikit-learn ML
    requirements.txt  Python dependencies
  public/
    index.html        Main page with graph, panel, overlays
    css/
      style.css       Command center visual styling
    js/
      app.js          WebSocket connection, message routing
      graph.js        Sigma.js renderer, force layout, ML node styling
      views.js        View configs, community palette, ML-aware coloring/sizing
      panel.js        Live clock, sparkline, rolling counters, ML panel
  package.json
```

---

## Setup

### Prerequisites
- Node.js (v18+)
- Python 3.9+

### Install & Run

```bash
# Install Node.js dependencies
npm install

# Install Python ML dependencies
cd ml && pip install -r requirements.txt && cd ..

# Terminal 1: Start Python ML server
npm run start:ml

# Terminal 2: Start Node.js server
npm start
```

Open [http://localhost:3000](http://localhost:3000).

The Python ML server runs on port 5001. The Node.js server POSTs graph snapshots to it every 10 seconds and broadcasts the ML results to all connected browsers.

No build tools, no bundler, no framework. The frontend loads Graphology and Sigma.js from CDN.

---

## Dependencies

### Node.js

| Package | Purpose |
|---------|---------|
| `express` | Static file serving + HTTP server |
| `ws` | WebSocket server for real-time browser updates |
| `eventsource` | SSE client for Wikimedia EventStreams |

### Python ML Backend

| Package | Purpose |
|---------|---------|
| `flask` | HTTP server for ML endpoint |
| `flask-cors` | CORS support for cross-origin requests |
| `networkx` | Graph algorithms (Louvain, PageRank, degree centrality) |
| `scikit-learn` | IsolationForest anomaly detection (real unsupervised ML) |
| `numpy` | Numerical computation for evaluation metrics |

Frontend dependencies (loaded via CDN, no install needed):
- `graphology@0.25.4` — Graph data structure
- `sigma@2.4.0` — WebGL graph renderer

---

## How the Pieces Connect

1. `ingest.js` receives a Wikipedia edit event via SSE
2. `graphStore.js` creates/updates nodes and edges, returns a diff
3. `index.js` broadcasts the diff to all connected WebSocket clients (filtered by their active view)
4. Every 2 seconds, `analytics.js` computes metrics and `index.js` broadcasts them
5. Every 10 seconds, `analytics.js` serializes the graph and POSTs to `ml/server.py`
6. Python runs Louvain (NetworkX), PageRank (NetworkX), hub detection (NetworkX), and IsolationForest (scikit-learn)
7. Results are returned as JSON, cached in Node.js, and broadcast as `ml_update`
8. On the browser, `app.js` routes incoming messages to `Panel`, `Views`, and `GraphRenderer`
9. `graph.js` applies ML data to node colors (community), sizes (PageRank), borders (hubs), and glow (anomalies)
10. The force-directed layout continuously positions nodes at 20 FPS
