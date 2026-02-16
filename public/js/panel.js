// Side panel updates with command center visuals
const Panel = {
  sparklineHistory: [],
  sparklineMax: 60, // 60 data points
  totalEventCount: 0,

  init() {
    this.els = {
      editsPerSec: document.getElementById("edits-per-sec"),
      totalEdits: document.getElementById("total-edits"),
      nodeCount: document.getElementById("node-count"),
      edgeCount: document.getElementById("edge-count"),
      topArticles: document.getElementById("top-articles"),
      topEditors: document.getElementById("top-editors"),
      topWikis: document.getElementById("top-wikis"),
      bursts: document.getElementById("bursts"),
      editWars: document.getElementById("edit-wars"),
      statusDot: document.querySelector(".status-dot"),
      statusText: document.querySelector(".status-text"),
      liveClock: document.getElementById("live-clock"),
      tickerCount: document.getElementById("ticker-count"),
      sparklineCanvas: document.getElementById("sparkline-canvas"),
      mlCommunityCount: document.getElementById("ml-community-count"),
      mlHubCount: document.getElementById("ml-hub-count"),
      mlHubList: document.getElementById("ml-hub-list"),
      mlAnomalyList: document.getElementById("ml-anomaly-list"),
      mlModularity: document.getElementById("ml-modularity"),
      mlCoverage: document.getElementById("ml-coverage"),
      mlGini: document.getElementById("ml-gini"),
      mlEntropy: document.getElementById("ml-entropy"),
      mlTop10: document.getElementById("ml-top10"),
      mlHubConcentration: document.getElementById("ml-hub-concentration"),
    };

    this._startClock();
    this._initSparkline();
  },

  _startClock() {
    const tick = () => {
      const now = new Date();
      const h = String(now.getUTCHours()).padStart(2, "0");
      const m = String(now.getUTCMinutes()).padStart(2, "0");
      const s = String(now.getUTCSeconds()).padStart(2, "0");
      this.els.liveClock.textContent = `${h}:${m}:${s} UTC`;
    };
    tick();
    setInterval(tick, 1000);
  },

  _initSparkline() {
    const canvas = this.els.sparklineCanvas;
    this._resizeSparklineCanvas();

    // Re-measure on resize so canvas stays sharp
    const ro = new ResizeObserver(() => this._resizeSparklineCanvas());
    ro.observe(canvas);
  },

  _resizeSparklineCanvas() {
    const canvas = this.els.sparklineCanvas;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width) || 268;
    const h = Math.round(rect.height) || 32;
    // Only resize if dimensions actually changed (avoids clearing)
    if (canvas.width !== w * 2 || canvas.height !== h * 2) {
      canvas.width = w * 2;
      canvas.height = h * 2;
    }
  },

  _drawSparkline(value) {
    this.sparklineHistory.push(value);
    if (this.sparklineHistory.length > this.sparklineMax) {
      this.sparklineHistory.shift();
    }

    const canvas = this.els.sparklineCanvas;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const data = this.sparklineHistory;
    const max = Math.max(...data, 1);

    ctx.clearRect(0, 0, w, h);

    if (data.length < 2) return;

    const stepX = w / (this.sparklineMax - 1);

    // Draw fill gradient
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < data.length; i++) {
      const x = i * stepX;
      const y = h - (data[i] / max) * (h - 4);
      if (i === 0) ctx.lineTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo((data.length - 1) * stepX, h);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "rgba(0, 212, 255, 0.3)");
    gradient.addColorStop(1, "rgba(0, 212, 255, 0.02)");
    ctx.fillStyle = gradient;
    ctx.fill();

    // Draw line
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = i * stepX;
      const y = h - (data[i] / max) * (h - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#00d4ff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw last point dot
    if (data.length > 0) {
      const lastX = (data.length - 1) * stepX;
      const lastY = h - (data[data.length - 1] / max) * (h - 4);
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#00d4ff";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(lastX, lastY, 6, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0, 212, 255, 0.4)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  },

  _updatePulseIntensity(editsPerSec) {
    // Map edits/sec to 0-1 range (0 eps = 0, 10+ eps = 1)
    const intensity = Math.min(editsPerSec / 10, 1);
    document.documentElement.style.setProperty("--pulse-intensity", intensity.toFixed(3));
  },

  setConnectionStatus(status) {
    const { statusDot, statusText } = this.els;
    statusDot.className = "status-dot";
    if (status === "connected") {
      statusDot.classList.add("connected");
      statusText.textContent = "Live";
    } else if (status === "error") {
      statusDot.classList.add("error");
      statusText.textContent = "Disconnected";
    } else {
      statusText.textContent = "Connecting...";
    }
  },

  updateMetrics(metrics) {
    this._rollingUpdate(this.els.editsPerSec, metrics.editsPerSec);
    this._rollingUpdate(this.els.totalEdits, this._formatNumber(metrics.totalEdits));
    this._rollingUpdate(this.els.nodeCount, this._formatNumber(metrics.nodeCount));
    this._rollingUpdate(this.els.edgeCount, this._formatNumber(metrics.edgeCount));

    // Update ticker
    this.totalEventCount = metrics.totalEdits;
    this.els.tickerCount.textContent = this._formatNumber(metrics.totalEdits);

    // Draw sparkline
    this._drawSparkline(metrics.editsPerSec);

    // Update background pulse
    this._updatePulseIntensity(metrics.editsPerSec);

    this._renderRankedList(this.els.topArticles, metrics.topArticles, (item) => {
      const badge = item.wiki ? `<span class="item-badge" style="opacity:0.5">${this._esc(item.wiki)}</span>` : "";
      return `<span class="item-label" title="${this._esc(item.label)}">${this._esc(item.label)}</span>
              ${badge}
              <span class="item-count">${item.editCount}</span>`;
    });

    this._renderRankedList(this.els.topEditors, metrics.topEditors, (item) => {
      const badge = item.bot ? '<span class="item-badge badge-bot">bot</span>' : "";
      return `<span class="item-label" title="${this._esc(item.label)}">${this._esc(item.label)}</span>
              ${badge}
              <span class="item-count">${item.editCount}</span>`;
    });

    this._renderRankedList(this.els.topWikis, metrics.topWikis, (item) => {
      return `<span class="item-label">${this._esc(item.label)}</span>
              <span class="item-count">${item.editCount}</span>`;
    });

    this._renderAlertList(this.els.bursts, metrics.bursts, (item) => {
      return `<span class="alert-title" title="${this._esc(item.label)}">${this._esc(item.label)}</span>
              <span class="alert-detail">${item.recentEdits} edits in 2 min</span>`;
    }, "burst");

    this._renderAlertList(this.els.editWars, metrics.editWars, (item) => {
      const revert = item.revertDetected ? ' <span class="alert-revert">REVERT</span>' : "";
      return `<span class="alert-title" title="${this._esc(item.label)}">${this._esc(item.label)}</span>
              <span class="alert-detail">${item.editsIn2Min} edits in 2 min${revert}</span>`;
    });
  },

  updateML(ml) {
    if (!ml) return;

    // Community count
    if (ml.communities) {
      const uniqueCommunities = new Set(Object.values(ml.communities));
      this.els.mlCommunityCount.textContent = uniqueCommunities.size;
    }

    // Hub count + list
    if (ml.hubs) {
      this.els.mlHubCount.textContent = ml.hubs.length;
      if (ml.hubs.length === 0) {
        this.els.mlHubList.innerHTML = '<li class="empty-state">None detected</li>';
      } else {
        this.els.mlHubList.innerHTML = ml.hubs.slice(0, 5).map((h) => {
          const label = this._esc(h.label || h.id);
          return `<li><span>${label}</span><span class="hub-score">${h.degree}</span></li>`;
        }).join("");
      }
    }

    // Anomalies
    if (ml.anomalies) {
      const anomalies = Object.entries(ml.anomalies);
      if (anomalies.length === 0) {
        this.els.mlAnomalyList.innerHTML = '<li class="empty-state">None detected</li>';
      } else {
        this.els.mlAnomalyList.innerHTML = anomalies.slice(0, 5).map(([id, info]) => {
          const label = this._esc(info.details || id);
          return `<li><span class="anomaly-type">${this._esc(info.type)}</span><span class="anomaly-label">${label}</span></li>`;
        }).join("");
      }
    }

    // Evaluation metrics
    if (ml.evaluation) {
      const ev = ml.evaluation;
      if (ev.community) {
        this.els.mlModularity.textContent = ev.community.modularity;
        this.els.mlCoverage.textContent = (ev.community.coverage * 100).toFixed(1) + "%";
      }
      if (ev.pagerank) {
        this.els.mlGini.textContent = ev.pagerank.gini;
        this.els.mlEntropy.textContent = ev.pagerank.entropy;
        this.els.mlTop10.textContent = (ev.pagerank.top10pct * 100).toFixed(1) + "%";
      }
      if (ev.hubs) {
        this.els.mlHubConcentration.textContent = ev.hubs.hubConcentration;
      }
    }
  },

  _rollingUpdate(el, value) {
    const strVal = String(value);
    if (el.dataset.currentValue === strVal) return;
    el.dataset.currentValue = strVal;

    const wrapper = document.createElement("span");
    wrapper.className = "roll-wrapper rolling-up";
    wrapper.textContent = strVal;
    el.innerHTML = "";
    el.appendChild(wrapper);

    // Remove animation class after it finishes
    wrapper.addEventListener("animationend", () => {
      wrapper.classList.remove("rolling-up");
    }, { once: true });
  },

  _renderRankedList(container, items, renderItem) {
    if (!items || items.length === 0) {
      container.innerHTML = '<li class="empty-state">Waiting for data...</li>';
      return;
    }
    container.innerHTML = items.map((item) => `<li>${renderItem(item)}</li>`).join("");
  },

  _renderAlertList(container, items, renderItem, extraClass) {
    if (!items || items.length === 0) {
      container.innerHTML = '<li class="empty-state">None detected</li>';
      return;
    }
    container.innerHTML = items
      .map((item) => `<li class="${extraClass || ""}">${renderItem(item)}</li>`)
      .join("");
  },

  _formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  },

  _esc(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  },
};
