// server.js
import express from "express";
import fs from "fs";
import path from "path";

const app = express();

// ⚠️ 2mb bývá málo, když posíláš i memory.today s body.
// Dáme 6mb – pořád bezpečné, ale už tě to nebude brzdit.
app.use(express.json({ limit: "6mb" }));

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
  res
    .type("text/plain")
    .send("Meteostanice HW backend running. Use /health, /state, POST /ingest");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasState: !!latestState,
    receivedAt: latestMeta.receivedAt,
    bytes: latestMeta.bytes,
  });
});

// ===== helper: UI compatibility layer + debug counts =====
function withUiCompat(state) {
  if (!state || typeof state !== "object") return state;

  const mem = state.memory;

  // UI-friendly alias (některé UI verze očekávají "history")
  // -> history.today = memory.today
  // -> history.days  = memory.days
  if (mem && typeof mem === "object") {
    const today = mem.today;
    const days = mem.days;

    state.history = {
      today: today || { key: null, temperature: [], light: [], energyIn: [], energyOut: [], brainRisk: [], totals: {} },
      days: Array.isArray(days) ? days : [],
    };

    // Debug: kolik bodů v dnešku
    const tLen = Array.isArray(today?.temperature) ? today.temperature.length : 0;
    const lLen = Array.isArray(today?.light) ? today.light.length : 0;
    const inLen = Array.isArray(today?.energyIn) ? today.energyIn.length : 0;
    const outLen = Array.isArray(today?.energyOut) ? today.energyOut.length : 0;
    const rLen = Array.isArray(today?.brainRisk) ? today.brainRisk.length : 0;

    state._historyDebug = {
      dayKey: today?.key ?? null,
      counts: { temperature: tLen, light: lLen, energyIn: inLen, energyOut: outLen, brainRisk: rLen },
      daysCount: Array.isArray(days) ? days.length : 0,
    };
  } else {
    // když memory není, nastav aspoň prázdnou history
    state.history = {
      today: { key: null, temperature: [], light: [], energyIn: [], energyOut: [], brainRisk: [], totals: {} },
      days: [],
    };
    state._historyDebug = { dayKey: null, counts: { temperature: 0, light: 0, energyIn: 0, energyOut: 0, brainRisk: 0 }, daysCount: 0 };
  }

  return state;
}

// UI čte odsud
app.get("/state", (req, res) => {
  if (!latestState) {
    return res.status(503).json({
      error: "No state ingested yet",
      hint: "ESP32 must POST JSON to /ingest",
    });
  }

  // ⚠️ vytvoříme kopii, ať si neničíme latestState v paměti
  const out = withUiCompat({ ...latestState });

  // přidáme info o serveru (užitečné pro debug v UI)
  res.json({
    ...out,
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
  res.json({
    ok: true,
    stored: true,
    bytes: latestMeta.bytes,
    receivedAt: latestMeta.receivedAt,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[hw-backend] listening on :${PORT}`));
