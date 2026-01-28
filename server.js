// server.js
import express from "express";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== CORS pro GitHub Pages UI =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ===== optional persistence (Railway Volume) =====
// Pokud máš na Railway připojený volume, nastav DATA_DIR=/data (nebo nech default /data).
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = path.join(DATA_DIR, "latest-state.json");

let latestState = null;
let latestMeta = {
  receivedAt: null,
  bytes: 0,
};

function ensureDirSafe(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function loadLatestFromDisk() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    latestState = JSON.parse(raw);
    latestMeta.receivedAt = Date.now();
    latestMeta.bytes = Buffer.byteLength(raw, "utf8");
    console.log("[boot] loaded latest-state.json");
  } catch (_) {
    console.log("[boot] no latest-state.json yet (ok)");
  }
}

function saveLatestToDisk(payloadObj) {
  try {
    ensureDirSafe(DATA_DIR);
    const raw = JSON.stringify(payloadObj);
    fs.writeFileSync(STATE_FILE, raw);
  } catch (e) {
    // Bez volume to jen nepersistuje. Nevadí.
    console.log("[persist] skip (no volume?)", String(e));
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
      hint: "ESP32 must POST JSON to /ingest",
    });
  }

  // přidáme info o serveru (užitečné pro debug v UI)
  res.json({
    ...latestState,
    _server: {
      now: Date.now(),
      receivedAt: latestMeta.receivedAt,
      bytes: latestMeta.bytes,
    },
  });
});

// ESP32 sem posílá
app.post("/ingest", (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ ok: false, error: "Invalid JSON payload" });
  }

  latestState = payload;

  const raw = JSON.stringify(payload);
  latestMeta.receivedAt = Date.now();
  latestMeta.bytes = Buffer.byteLength(raw, "utf8");

  saveLatestToDisk(payload);

  // odpověď pro ESP32
  res.json({ ok: true, stored: true, bytes: latestMeta.bytes, receivedAt: latestMeta.receivedAt });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[hw-backend] listening on :${PORT}`));
