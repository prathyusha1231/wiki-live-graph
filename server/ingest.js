const EventSource = require("eventsource");

const STREAM_URL =
  "https://stream.wikimedia.org/v2/stream/recentchange";

function startIngestion(onEvent) {
  const es = new EventSource(STREAM_URL, {
    headers: {
      "User-Agent": "WikiLiveGraph/1.0 (educational project; contact@example.com)",
    },
  });

  es.onopen = () => console.log("[ingest] Connected to Wikimedia EventStreams");

  es.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data.type !== "edit" && data.type !== "new") return;

      // Filter out noise: only main namespace (0) = actual articles
      if (data.namespace !== undefined && data.namespace !== 0) return;

      // Filter out bot edits
      if (data.bot) return;

      // Filter out Wikidata (Q-number titles), Commons, and meta wikis
      const wiki = data.wiki || "";
      if (/^(wikidata|commons|meta|mediawiki|species)/.test(wiki)) return;

      // Skip titles that are just Q-numbers or other IDs
      if (/^Q\d+$/.test(data.title)) return;

      const evt = {
        wiki: data.wiki || "unknown",
        user: data.user || "anonymous",
        title: data.title || "Untitled",
        type: data.type,
        timestamp: data.timestamp || Math.floor(Date.now() / 1000),
        comment: data.comment || "",
        revisionNew: data.revision && data.revision.new,
        bot: false,
        namespace: 0,
      };

      onEvent(evt);
    } catch {
      // skip malformed events
    }
  };

  es.onerror = (err) => {
    console.error("[ingest] SSE error, will auto-reconnect:", err.message || err);
  };

  return es;
}

module.exports = { startIngestion };
