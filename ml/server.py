"""
Python ML Backend for Wiki Live Graph.

Flask server that receives graph snapshots from the Node.js server
and runs real ML algorithms using NetworkX and scikit-learn.

Endpoint: POST /analyze
Receives: { nodes, edges }
Returns:  { communities, pagerank, hubs, anomalies, evaluation }
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import networkx as nx
from networkx.algorithms.community import louvain_communities, modularity
from sklearn.ensemble import IsolationForest
import numpy as np
import traceback

app = Flask(__name__)
CORS(app)


def build_graphs(nodes, edges):
    """Build NetworkX graphs from the raw node/edge data."""
    # Undirected graph for community detection (bipartite + coedit edges)
    G_undirected = nx.Graph()
    # Directed graph for PageRank (bipartite edges)
    G_directed = nx.DiGraph()

    node_map = {}
    for n in nodes:
        node_map[n["id"]] = n
        G_undirected.add_node(n["id"], **n)
        G_directed.add_node(n["id"], **n)

    for e in edges:
        src, tgt = e["source"], e["target"]
        w = e.get("weight", 1)
        view = e.get("view", "bipartite")

        # Undirected graph gets bipartite + coedit edges
        if view in ("bipartite", "coedit"):
            if G_undirected.has_edge(src, tgt):
                G_undirected[src][tgt]["weight"] += w
            else:
                G_undirected.add_edge(src, tgt, weight=w)

        # Directed graph gets bipartite edges (both directions for PageRank)
        if view == "bipartite":
            if not G_directed.has_edge(src, tgt):
                G_directed.add_edge(src, tgt, weight=w)
            if not G_directed.has_edge(tgt, src):
                G_directed.add_edge(tgt, src, weight=w)

    return G_undirected, G_directed, node_map


def detect_communities(G):
    """Community detection using NetworkX Louvain algorithm."""
    if G.number_of_nodes() < 2:
        return {n: 0 for n in G.nodes()}

    # Remove isolated nodes for Louvain (add them back after)
    connected_nodes = [n for n in G.nodes() if G.degree(n) > 0]
    if len(connected_nodes) < 2:
        return {n: 0 for n in G.nodes()}

    G_connected = G.subgraph(connected_nodes).copy()

    try:
        communities_list = louvain_communities(G_connected, weight="weight", resolution=1.0, seed=42)
    except Exception:
        # Fallback: each node in its own community
        return {n: i for i, n in enumerate(G.nodes())}

    # Build node -> community mapping
    communities = {}
    for comm_id, comm_nodes in enumerate(communities_list):
        for node in comm_nodes:
            communities[node] = comm_id

    # Assign isolated nodes to a catch-all community
    next_id = len(communities_list)
    for n in G.nodes():
        if n not in communities:
            communities[n] = next_id

    return communities


def compute_pagerank(G_directed):
    """PageRank using NetworkX eigenvector-based implementation."""
    if G_directed.number_of_nodes() == 0:
        return {}

    try:
        pr = nx.pagerank(G_directed, alpha=0.85, max_iter=100, tol=1e-06, weight="weight")
    except Exception:
        return {n: 0 for n in G_directed.nodes()}

    # Normalize to 0-1
    max_pr = max(pr.values()) if pr else 1
    if max_pr > 0:
        pr = {k: v / max_pr for k, v in pr.items()}

    return pr


def detect_hubs(G, node_map):
    """Hub detection using NetworkX degree centrality."""
    if G.number_of_nodes() == 0:
        return []

    centrality = nx.degree_centrality(G)

    # Sort by centrality descending
    sorted_nodes = sorted(centrality.items(), key=lambda x: x[1], reverse=True)

    # Top 10% are hubs (minimum 1)
    hub_count = max(1, int(np.ceil(len(sorted_nodes) * 0.1)))
    hubs = []
    for node_id, _ in sorted_nodes[:hub_count]:
        degree = G.degree(node_id)
        label = node_map.get(node_id, {}).get("label", node_id)
        hubs.append({"id": node_id, "label": label, "degree": degree})

    return hubs


def detect_anomalies(G, node_map, pagerank):
    """Anomaly detection using scikit-learn IsolationForest."""
    anomalies = {}

    if G.number_of_nodes() < 5:
        return anomalies

    # Extract features per node: editCount, degree, clustering coefficient, PageRank
    node_ids = list(G.nodes())
    clustering = nx.clustering(G, weight="weight")

    features = []
    valid_node_ids = []
    for nid in node_ids:
        info = node_map.get(nid, {})
        edit_count = info.get("editCount", 0)
        degree = G.degree(nid)
        clust = clustering.get(nid, 0)
        pr_score = pagerank.get(nid, 0)
        features.append([edit_count, degree, clust, pr_score])
        valid_node_ids.append(nid)

    if len(features) < 5:
        return anomalies

    X = np.array(features, dtype=np.float64)

    # IsolationForest: unsupervised anomaly detection
    contamination = min(0.1, max(2 / len(X), 0.01))
    clf = IsolationForest(
        n_estimators=100,
        contamination=contamination,
        random_state=42,
    )
    clf.fit(X)
    predictions = clf.predict(X)        # -1 = anomaly, 1 = normal
    scores = clf.decision_function(X)    # lower = more anomalous

    for i, nid in enumerate(valid_node_ids):
        if predictions[i] == -1:
            info = node_map.get(nid, {})
            label = info.get("label", nid)
            node_type = info.get("type", "unknown")

            # Determine anomaly type based on node characteristics
            edit_count = info.get("editCount", 0)
            degree = G.degree(nid)

            if node_type == "editor" and edit_count > 5:
                anomaly_type = "prolific_editor"
                details = f"{label} edited {edit_count} articles (IsolationForest outlier)"
            elif node_type == "article" and degree > 3:
                anomaly_type = "coordinated_edit"
                details = f"{label} has {degree} connections (IsolationForest outlier)"
            else:
                anomaly_type = "structural_outlier"
                details = f"{label} flagged as structural outlier by IsolationForest"

            # Convert decision function score to 0-1 anomaly score
            # decision_function: negative = more anomalous
            raw_score = -scores[i]
            anomaly_score = float(min(max(raw_score, 0), 1))

            anomalies[nid] = {
                "type": anomaly_type,
                "score": round(anomaly_score, 3),
                "details": details,
            }

    return anomalies


def evaluate_communities(G, communities):
    """Evaluate community detection quality."""
    if not communities or G.number_of_edges() == 0:
        return {"modularity": 0, "numCommunities": 0, "coverage": 0, "largestSize": 0, "medianSize": 0}

    # Build partition as list of sets
    comm_to_nodes = {}
    for node, comm_id in communities.items():
        if node in G.nodes():
            comm_to_nodes.setdefault(comm_id, set()).add(node)
    partition = list(comm_to_nodes.values())

    if not partition:
        return {"modularity": 0, "numCommunities": 0, "coverage": 0, "largestSize": 0, "medianSize": 0}

    # Modularity using NetworkX
    try:
        mod = modularity(G, partition, weight="weight")
    except Exception:
        mod = 0

    # Coverage: fraction of edges within communities
    intra = 0
    total = G.number_of_edges()
    node_to_comm = {}
    for comm_id, nodes_set in enumerate(partition):
        for n in nodes_set:
            node_to_comm[n] = comm_id
    for u, v in G.edges():
        if node_to_comm.get(u) == node_to_comm.get(v):
            intra += 1
    coverage = round(intra / total, 3) if total > 0 else 0

    # Size distribution
    sizes = sorted([len(s) for s in partition], reverse=True)

    return {
        "modularity": round(mod, 4),
        "numCommunities": len(partition),
        "coverage": coverage,
        "largestSize": sizes[0] if sizes else 0,
        "medianSize": int(np.median(sizes)) if sizes else 0,
    }


def evaluate_pagerank(pagerank):
    """Evaluate PageRank distribution quality."""
    values = list(pagerank.values())
    n = len(values)
    if n == 0:
        return {"gini": 0, "entropy": 0, "top10pct": 0, "nodeCount": 0}

    arr = np.array(sorted(values))
    mean = arr.mean()

    # Gini coefficient
    if mean > 0:
        index = np.arange(1, n + 1)
        gini = float(np.sum((2 * index - n - 1) * arr) / (n * n * mean))
    else:
        gini = 0

    # Normalized Shannon entropy
    total = arr.sum()
    if total > 0:
        p = arr[arr > 0] / total
        entropy = float(-np.sum(p * np.log2(p)))
        max_entropy = np.log2(n) if n > 1 else 1
        entropy = entropy / max_entropy if max_entropy > 0 else 0
    else:
        entropy = 0

    # Top 10% concentration
    top10_count = max(1, int(np.ceil(n * 0.1)))
    top10_sum = float(arr[-top10_count:].sum())
    top10pct = top10_sum / total if total > 0 else 0

    return {
        "gini": round(gini, 4),
        "entropy": round(entropy, 4),
        "top10pct": round(top10pct, 3),
        "nodeCount": n,
    }


def evaluate_hubs(hubs):
    """Evaluate hub distribution."""
    if not hubs:
        return {"hubCount": 0, "maxDegree": 0, "meanDegree": 0, "hubConcentration": 0}

    degrees = [h["degree"] for h in hubs]
    max_degree = degrees[0]
    total_degree = sum(degrees)
    mean_degree = round(total_degree / len(degrees), 1)
    hub_concentration = round(max_degree / total_degree, 3) if total_degree > 0 else 0

    return {
        "hubCount": len(hubs),
        "maxDegree": max_degree,
        "meanDegree": mean_degree,
        "hubConcentration": hub_concentration,
    }


def evaluate_anomalies(anomalies):
    """Evaluate anomaly detection results."""
    entries = list(anomalies.values())
    prolific = [a for a in entries if a["type"] == "prolific_editor"]
    coordinated = [a for a in entries if a["type"] == "coordinated_edit"]
    avg_score = round(sum(a["score"] for a in entries) / len(entries), 3) if entries else 0

    return {
        "totalCount": len(entries),
        "prolificEditors": len(prolific),
        "coordinatedEdits": len(coordinated),
        "avgScore": avg_score,
    }


@app.route("/analyze", methods=["POST"])
def analyze():
    """Main ML analysis endpoint."""
    try:
        data = request.get_json()
        nodes = data.get("nodes", [])
        edges = data.get("edges", [])

        if len(nodes) < 3:
            return jsonify({
                "communities": {},
                "pagerank": {},
                "hubs": [],
                "anomalies": {},
                "evaluation": {
                    "community": {"modularity": 0, "numCommunities": 0, "coverage": 0, "largestSize": 0, "medianSize": 0},
                    "pagerank": {"gini": 0, "entropy": 0, "top10pct": 0, "nodeCount": 0},
                    "hubs": {"hubCount": 0, "maxDegree": 0, "meanDegree": 0, "hubConcentration": 0},
                    "anomaly": {"totalCount": 0, "prolificEditors": 0, "coordinatedEdits": 0, "avgScore": 0},
                },
            })

        # Build graphs
        G_undirected, G_directed, node_map = build_graphs(nodes, edges)

        # Run ML algorithms
        communities = detect_communities(G_undirected)
        pagerank = compute_pagerank(G_directed)
        hubs = detect_hubs(G_undirected, node_map)
        anomalies = detect_anomalies(G_undirected, node_map, pagerank)

        # Evaluation metrics
        evaluation = {
            "community": evaluate_communities(G_undirected, communities),
            "pagerank": evaluate_pagerank(pagerank),
            "hubs": evaluate_hubs(hubs),
            "anomaly": evaluate_anomalies(anomalies),
        }

        return jsonify({
            "communities": communities,
            "pagerank": pagerank,
            "hubs": hubs,
            "anomalies": anomalies,
            "evaluation": evaluation,
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "engine": "networkx+sklearn"})


if __name__ == "__main__":
    print("[ml] Python ML server starting on http://localhost:5001")
    print("[ml] Using NetworkX (Louvain, PageRank) + scikit-learn (IsolationForest)")
    app.run(host="0.0.0.0", port=5001, debug=False)
