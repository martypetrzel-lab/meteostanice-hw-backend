// server.js
import express from "express";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS pro GitHub Pages UI
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Railway persistent volume (pokud máš připojený volume, dej třeba /data)
// Když nemáš, pořád to poběží – jen se latest state ztratí při restartu.
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = path.join(DATA_DIR, "latest-state.json");

let latestState = null;
let latestMeta = {
  receivedAt: null,
  bytes: 0,
  sourceIp: null,
};

function ensureDirSafe(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

function loadLatestFromDisk() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    latestState = JSON.parse(raw);
    latestMeta.receivedAt = Date.now();
    latestMeta.bytes = Buffer.byteLength(raw, "utf8");
  } catch (_) {
    // ok – zatím nic na disku
  }
}

function saveLatestToDisk(payloadObj) {
  try {
    ensureDirSafe(DATA_DIR);
    const raw = JSON.stringify(payloadObj);
    fs.writeFileSync(STATE_FILE, raw);
  } catch (_) {
    // ok – bez volume to jen nepersistuje
  }
}

loadLatestFromDisk();

app.get("/", (req, res) => {
  res.type("text/plain").send("Meteostanice HW backend running. Use /health, /state, POST /ingest");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasState: !!latestState,
    receivedAt: latestMeta.receivedAt,
    bytes: latestMeta.bytes,
  });
});

// UI čte odsud
app.get("/state", (req, res) => {
  if (!latestState) {
    return res.status(503).json({
      error: "No state ingested yet",
      hint: "POST your ESP32 /state JSON to /ingest",
    });
  }

  // přidáme info “server time”
  const out = {
    ...latestState,
    _server: {
      receivedAt: latestMeta.receivedAt,
      now: Date.now(),
      bytes: latestMeta.bytes,
    },
  };

  res.json(out);
});

// ESP32 sem posílá
app.post("/ingest", (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  latestState = payload;
  latestMeta.receivedAt = Date.now();
  latestMeta.sourceIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  const raw = JSON.stringify(payload);
  latestMeta.bytes = Buffer.byteLength(raw, "utf8");

  saveLatestToDisk(payload);

  res.json({ ok: true, stored: true, bytes: latestMeta.bytes });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[hw-backend] listening on :${PORT}`);
});
