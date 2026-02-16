# Wikipedia Live Graph

Real-time visualization of Wikipedia edits as an interactive force-directed graph, with Graph ML algorithms running server-side for community detection, influence ranking, hub identification, and anomaly detection.

Built with Node.js, WebSockets, Sigma.js, and Graphology. No build step required.

---

## What It Does

The app connects to the [Wikimedia EventStreams API](https://stream.wikimedia.org/v2/stream/recentchange) via Server-Sent Events (SSE) and processes every real-time edit happening across all Wikipedia languages. Each edit produces graph nodes (editors, articles, wikis) and edges (who edited what), which are broadcast to connected browsers via WebSocket and rendered as a live force-directed graph.

On top of the live graph, four Graph ML algorithms run server-side every 10 seconds, coloring nodes by community, sizing them by influence, highlighting hubs, and flagging anomalous editing patterns.

---

## Architecture

```
Wikimedia SSE  -->  [ingest.js]  -->  [graphStore.js]  -->  [index.js]  -->  WebSocket  -->  Browser
                     Parses edits      Manages nodes/        Broadcasts         Sigma.js
                     Filters noise     edges/metadata        diffs + ML         renders graph
                                             |
                                       [analytics.js]
                                       Metrics + 4 ML algorithms
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

3. **Analytics** (`server/analytics.js`): Computes rolling metrics (edits/sec, top articles, burst detection, edit wars) every 2 seconds, and runs 4 ML algorithms every 10 seconds.

4. **Server** (`server/index.js`): Express + WebSocket server. Sends graph snapshots on connect, then streams incremental diffs (node_add, node_update, edge_add, etc.). Metrics broadcast every 2s. ML results broadcast every 10s on a separate `ml_update` channel.

5. **Browser** (`public/`): Sigma.js renders the graph with force-directed layout. Panel shows live stats, sparkline, ML insights. Three view modes available.

---

## Graph ML Algorithms

All four algorithms run server-side in `server/analytics.js`, cached and recomputed every 10 seconds. Computation is skipped entirely if the graph exceeds 1,500 nodes (performance guard).

### 1. Community Detection (Label Propagation)

**What it does**: Groups nodes into communities — clusters of editors and articles that are closely connected through co-editing patterns.

**How it works**:
- Builds a weighted adjacency graph from all bipartite and co-edit edges
- Each node starts with a unique label (its own community)
- On each iteration, every node adopts the label that has the highest total weight among its neighbors
- Nodes are processed in random order each iteration to avoid bias
- Runs for up to 20 iterations, stops early if no labels change (convergence)
- Output: `{ nodeId: communityId }` mapping

**Frontend effect**: Nodes are colored using an 8-color neon palette based on their community ID. Nodes in the same community get the same color, making editing clusters visually obvious.

**Why Label Propagation**: It requires no preset number of clusters (unlike k-means), runs in O(E x iterations) time which is fast enough for real-time, and naturally captures the weighted community structure of co-editing networks.

### 2. PageRank

**What it does**: Ranks every node by its structural importance in the editing network. High PageRank = many well-connected editors are editing this article, or this editor contributes to many well-connected articles.

**How it works**:
- Builds a directed link graph from bipartite edges (editor <-> article)
- Initializes all nodes with equal rank (1/N)
- On each iteration, each node's rank = (1 - damping)/N + damping * sum(rank of each linker / their out-degree)
- Damping factor: 0.85 (standard)
- Runs for 20 iterations
- Scores are normalized to 0-1 range (divided by the maximum PageRank)
- Output: `{ nodeId: score }` mapping

**Frontend effect**: Node size is increased proportionally to PageRank score (up to +8px). Higher-ranked nodes appear visibly larger.

### 3. Degree Centrality + Hub Detection

**What it does**: Identifies "hub" nodes — the most connected editors and articles in the bipartite graph.

**How it works**:
- Counts the degree (number of edges) of every node in the bipartite graph
- Sorts all nodes by degree descending
- The top 10% are classified as "hubs" (minimum 1 hub)
- Also computes a normalized centrality score (degree / max_degree) for every node
- Output: `hubs` array with `[{ id, label, degree }]`, plus `degreeCentrality` map

**Frontend effect**: Hub nodes get a cyan border ring in the graph. The top 5 hubs are listed in the ML Insights panel with their degree count.

### 4. Anomaly Detection

**What it does**: Flags two types of suspicious editing patterns in real-time.

**Type A — Prolific Editor**:
- Triggers when a single editor has edited more than 10 distinct articles in the last 5 minutes
- Anomaly score: `min(articleCount / 20, 1)`
- This catches potential vandalism bots or mass-editing campaigns

**Type B — Coordinated Editing**:
- Triggers when a single article has been edited by more than 8 unique editors in the last 5 minutes
- Anomaly score: `min(editorCount / 15, 1)`
- This catches edit wars, viral events, or coordinated manipulation

**How it works**:
- Single O(E) pass over all recent bipartite edges
- Indexes edges by source (editor -> article count) and target (article -> editor count)
- Checks thresholds and builds anomaly objects
- Output: `{ nodeId: { type, score, details } }` mapping

**Frontend effect**: Anomalous nodes glow red with a pink border. Tooltip shows the anomaly type and details. Anomalies are listed in the ML Insights panel with a pulsing red glow animation.

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
- **Scanline overlay**: Animated horizontal lines scrolling over the graph canvas, simulating a CRT monitor effect. Uses `repeating-linear-gradient` with a slow 8-second scroll animation.
- **Vignette**: `inset box-shadow` on the graph container darkens the edges, drawing focus to the center.
- **Pulsing radial background**: The graph container's radial gradient intensity is driven by a `--pulse-intensity` CSS variable, updated from the current edits/sec rate. More edits = brighter glow.
- **Monospace numbers**: All statistics use `Consolas / SF Mono / Fira Code` for that data-terminal aesthetic.
- **Breathing status dot**: The "Live" connection indicator uses a `status-breathe` keyframe animation that pulses the green glow.

### Live Dashboard Elements
- **UTC clock**: Ticks every second in the header, monospace formatted.
- **Event ticker**: Running count of total events processed, displayed in the header.
- **Sparkline chart**: Canvas-drawn edits/sec history (last 60 data points) with a cyan gradient fill. Updates every 2 seconds. Uses `ResizeObserver` to stay sharp on resize.
- **Rolling counter animations**: Stat values animate with a `translateY` slide-up transition when they change, instead of just swapping text.
- **ML Insights panel**: Dedicated section showing community count, hub node list (top 5 with degree), and active anomaly alerts with pulsing red glow.

### Tooltip
Hovering a node shows an enhanced tooltip with:
- Node label, type, and edit count
- Community ID with a colored dot matching the node's community color
- PageRank score (0-1, three decimal places)
- Anomaly alert (type + details) if flagged

---

## Performance Considerations

- **ML computation guard**: All 4 algorithms are skipped if the graph exceeds 1,500 nodes
- **Separate broadcast intervals**: Metrics update every 2s (lightweight JSON). ML data updates every 10s (heavier payload). This prevents sending redundant ML data 5x more often than it changes.
- **Anomaly detection in O(E)**: Single pass over edges with pre-indexed maps, instead of nested loops
- **Layout cap**: Force-directed layout skips computation when node count exceeds 2,000
- **Repulsion subset**: Only the first 500 nodes participate in repulsion calculations to keep O(N^2) bounded
- **ML recolor throttle**: `applyMLData()` defers the full graph recolor to `requestAnimationFrame` and deduplicates concurrent calls
- **Sparkline canvas resize**: Uses `ResizeObserver` instead of polling, only resizes when dimensions actually change
- **10-minute sliding window**: Old nodes and edges are cleaned up every 30s, keeping the graph bounded

---

## Project Structure

```
wiki-live-graph/
  server/
    index.js          Express + WebSocket server, broadcast logic
    ingest.js         Wikimedia SSE stream consumer
    graphStore.js     In-memory graph with sliding window cleanup
    analytics.js      Metrics computation + 4 ML algorithms + caching
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

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

No build tools, no bundler, no framework. The frontend loads Graphology and Sigma.js from CDN.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | Static file serving + HTTP server |
| `ws` | WebSocket server for real-time browser updates |
| `eventsource` | SSE client for Wikimedia EventStreams |

Frontend dependencies (loaded via CDN, no install needed):
- `graphology@0.25.4` — Graph data structure
- `sigma@2.4.0` — WebGL graph renderer

---

## How the Pieces Connect

1. `ingest.js` receives a Wikipedia edit event via SSE
2. `graphStore.js` creates/updates nodes and edges, returns a diff
3. `index.js` broadcasts the diff to all connected WebSocket clients (filtered by their active view)
4. Every 2 seconds, `analytics.js` computes metrics and `index.js` broadcasts them
5. Every 10 seconds, `analytics.js` runs all 4 ML algorithms and `index.js` broadcasts the results as a separate `ml_update` message
6. On the browser, `app.js` routes incoming messages to `Panel` (stats/ML panel), `Views` (coloring/sizing config), and `GraphRenderer` (Sigma.js)
7. `graph.js` applies ML data to node colors (community), sizes (PageRank), borders (hubs), and glow (anomalies) via `nodeReducer` and `edgeReducer`
8. The force-directed layout continuously positions nodes at 20 FPS
9. Pulse animations highlight newly updated nodes for 600ms
