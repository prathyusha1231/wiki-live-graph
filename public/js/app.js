// Main application: WebSocket connection + event routing
(function () {
  let ws = null;
  let reconnectTimer = null;

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("[ws] Connected");
      Panel.setConnectionStatus("connected");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      Panel.setConnectionStatus("error");
      scheduleReconnect();
    };

    ws.onerror = () => {
      Panel.setConnectionStatus("error");
    };
  }

  function scheduleReconnect() {
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        console.log("[ws] Reconnecting...");
        Panel.setConnectionStatus("connecting");
        connect();
      }, 3000);
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "snapshot":
        GraphRenderer.loadSnapshot(msg);
        break;
      case "node_add":
        GraphRenderer.addNode(msg.node);
        break;
      case "node_update":
        GraphRenderer.updateNode(msg.node);
        break;
      case "node_remove":
        GraphRenderer.removeNode(msg.id);
        break;
      case "edge_add":
        GraphRenderer.addEdge(msg.edge);
        break;
      case "edge_update":
        GraphRenderer.updateEdge(msg.edge);
        break;
      case "edge_remove":
        GraphRenderer.removeEdge(msg.id);
        break;
      case "metrics_update":
        Panel.updateMetrics(msg.metrics);
        break;
      case "ml_update":
        Views.setMLData(msg.ml);
        GraphRenderer.applyMLData(msg.ml);
        Panel.updateML(msg.ml);
        break;
    }
  }

  function switchView(view) {
    Views.setView(view);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_view", view }));
    }
  }

  // Initialize everything on DOM ready
  Panel.init();
  GraphRenderer.init();

  // View button handlers
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchView(btn.dataset.view);
    });
  });

  // Connect to WebSocket
  connect();
})();
