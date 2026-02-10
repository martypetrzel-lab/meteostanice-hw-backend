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
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

let latestState = null;
let latestMeta = {
  receivedAt: null,
  bytes: 0,
};

// ===== server-side historie (když ESP/simulátor neposílá memory.*) =====
// formát kompatibilní s UI: { today:{key, temperature[], light[], energyIn[], energyOut[], brainRisk[], totals:{} }, days:[...] }
let historyStore = {
  today: { key: null, temperature: [], light: [], energyIn: [], energyOut: [], brainRisk: [], totals: {} },
  days: [],
  // interně držíme mapu pro rychlé hledání
  _byKey: {},
};

function ensureDirSafe(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

function loadJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function saveJsonSafe(filePath, obj) {
  try {
    ensureDirSafe(DATA_DIR);
    fs.writeFileSync(filePath, JSON.stringify(obj));
    return true;
  } catch (e) {
    // Bez volume to jen nepersistuje. Nevadí.
    console.log("[persist] skip (no volume?)", String(e));
    return false;
  }
}

function loadLatestFromDisk() {
  const state = loadJsonSafe(STATE_FILE);
  if (state) {
    latestState = state;
    latestMeta.receivedAt = Date.now();
    latestMeta.bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    console.log("[boot] loaded latest-state.json");
  } else {
    console.log("[boot] no latest-state.json yet (ok)");
  }

  const h = loadJsonSafe(HISTORY_FILE);
  if (h && typeof h === "object") {
    historyStore.today = h.today || historyStore.today;
    historyStore.days = Array.isArray(h.days) ? h.days : historyStore.days;

    // zrekonstruuj mapu
    historyStore._byKey = {};
    for (const d of historyStore.days) {
      const key = d.key || d.day || d.date;
      if (key) historyStore._byKey[key] = d;
    }
    if (historyStore.today?.key) historyStore._byKey[historyStore.today.key] = historyStore.today;

    console.log("[boot] loaded history.json");
  } else {
    console.log("[boot] no history.json yet (ok)");
  }
}

function saveLatestToDisk(payloadObj) {
  saveJsonSafe(STATE_FILE, payloadObj);
}

function saveHistoryToDisk() {
  // do souboru neukládáme _byKey (je to jen cache)
  const out = {
    today: historyStore.today,
    days: historyStore.days,
  };
  saveJsonSafe(HISTORY_FILE, out);
}

loadLatestFromDisk();

// --- helpers ---
function pick(obj, paths, fallback = undefined) {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (!cur || typeof cur !== "object" || !(part in cur)) { ok = false; break; }
      cur = cur[part];
    }
    if (ok && cur !== undefined && cur !== null) return cur;
  }
  return fallback;
}

function toPragueDayKey(tsMs) {
  try {
    // YYYY-MM-DD
    return new Date(tsMs).toLocaleDateString("en-CA", { timeZone: "Europe/Prague" });
  } catch (_) {
    // fallback
    return new Date(tsMs).toISOString().slice(0, 10);
  }
}

function clampHistoryLen(arr, maxLen) {
  if (!Array.isArray(arr)) return;
  const extra = arr.length - maxLen;
  if (extra > 0) arr.splice(0, extra);
}

function appendPoint(dayObj, seriesName, t, v) {
  if (!Number.isFinite(v)) return;
  if (!dayObj[seriesName]) dayObj[seriesName] = [];
  dayObj[seriesName].push({ t, v });
  // držíme rozumné velikosti (UI stejně ukazuje ~poslední hodiny)
  clampHistoryLen(dayObj[seriesName], 2000);
}

function ensureDay(key) {
  // existuje?
  if (historyStore._byKey[key]) return historyStore._byKey[key];

  const day = { key, temperature: [], light: [], energyIn: [], energyOut: [], brainRisk: [], totals: {} };
  historyStore._byKey[key] = day;
  historyStore.days.push(day);

  // drž posledních 14 dní
  if (historyStore.days.length > 14) {
    const removed = historyStore.days.splice(0, historyStore.days.length - 14);
    for (const d of removed) {
      const k = d.key || d.day || d.date;
      if (k && historyStore._byKey[k] === d) delete historyStore._byKey[k];
    }
  }
  return day;
}

function buildServerHistoryFromPayload(payload) {
  const now = Date.now();
  const key = toPragueDayKey(now);
  const day = ensureDay(key);
  historyStore.today = day;

  // robustní čtení hodnot z různých struktur (HW i simulátor)
  const outdoorTempC = pick(payload, [
    "world.environment.outdoorTempC",
    "world.environment.airTempC",
    "world.environment.outTempC",
    "world.environment.temperature", // simulátor
    "world.environment.temperatureC",
    "sensors.outdoorTempC",
    "sensors.ds18b20C",
    "environment.outdoorTempC",
    "environment.temperature",
  ], null);

  const lux = pick(payload, [
    "world.environment.lightLux",
    "world.environment.lux",
    "world.environment.light",
    "environment.lightLux",
    "environment.light",
    "lux",
  ], null);

  const pInW = pick(payload, [
    "energy.ina_in.p_raw",
    "energy.ina_in.p_ema",
    "energy.solarW",
    "energy.inW",
    "energy.pInW",
    "ina_in.p_raw",
    "inaIn.p_raw",
  ], null);

  const pOutW = pick(payload, [
    "energy.ina_out.p_raw",
    "energy.ina_out.p_ema",
    "energy.loadW",
    "energy.outW",
    "energy.pOutW",
    "ina_out.p_raw",
    "inaOut.p_raw",
  ], null);

  const risk = pick(payload, [
    "brain.risk",
    "brain.riskScore",
    "brain.risk_now",
    "risk",
  ], null);

  // čísla
  const tV = Number(outdoorTempC);
  const lV = Number(lux);
  const inV = Number(pInW);
  const outVraw = Number(pOutW);
  const outV = Number.isFinite(outVraw) ? Math.abs(outVraw) : NaN;
  const rV = Number(risk);

  appendPoint(day, "temperature", now, tV);
  appendPoint(day, "light", now, lV);
  appendPoint(day, "energyIn", now, inV);
  appendPoint(day, "energyOut", now, outV);
  appendPoint(day, "brainRisk", now, rV);

  // jednoduché "totals" (ne Wh integrace, jen debug souhrn)
  day.totals = day.totals || {};
  day.totals.lastTs = now;
  day.totals.samples = Math.max(
    day.temperature?.length || 0,
    day.light?.length || 0,
    day.energyIn?.length || 0,
    day.energyOut?.length || 0,
    day.brainRisk?.length || 0
  );
}

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
    history: {
      todayKey: historyStore.today?.key || null,
      daysCount: Array.isArray(historyStore.days) ? historyStore.days.length : 0,
      todaySamples: historyStore.today?.totals?.samples ?? null,
    },
    _waiting: !latestState,
  });
});

// ===== helper: UI compatibility layer + debug counts =====

function makeEmptyState() {
  // Minimální struktura, aby UI nespadlo, když backend ještě nedostal žádná data.
  return {
    time: { now: Date.now(), isDay: true },
    world: {
      environment: {
        lightLux: 0,
        lux: 0,
        boxTempC: null,
        indoorTempC: null,
        indoorHumPct: null,
        outdoorTempC: null,
        airTempC: null,
        solarPotentialW: 0,
        scenario: "WAITING",
        phase: "WAITING",
      },
    },
    energy: {
      ina_in: { p_raw: 0, p_ema: 0, voltageV: null, currentA: null, signal_quality: 0 },
      ina_out: { p_raw: 0, p_ema: 0, voltageV: null, currentA: null, signal_quality: 0 },
      states: { power_state: "WAITING", power_path_state: "WAITING" },
      totals: { wh_in_today: 0, wh_out_today: 0, wh_net_today: 0 },
    },
    brain: { risk: 0, conf: 0, mode: "WAITING", message: "Čekám na první data…", batterySafe: "WAITING" },
  };
}

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
      source: "payload.memory",
    };
  } else {
    // když memory není, použij server-side historii
    state.history = {
      today: historyStore.today || { key: null, temperature: [], light: [], energyIn: [], energyOut: [], brainRisk: [], totals: {} },
      days: Array.isArray(historyStore.days) ? historyStore.days : [],
    };

    const today = state.history.today;

    state._historyDebug = {
      dayKey: today?.key ?? null,
      counts: {
        temperature: Array.isArray(today?.temperature) ? today.temperature.length : 0,
        light: Array.isArray(today?.light) ? today.light.length : 0,
        energyIn: Array.isArray(today?.energyIn) ? today.energyIn.length : 0,
        energyOut: Array.isArray(today?.energyOut) ? today.energyOut.length : 0,
        brainRisk: Array.isArray(today?.brainRisk) ? today.brainRisk.length : 0,
      },
      daysCount: Array.isArray(historyStore.days) ? historyStore.days.length : 0,
      source: "server.history",
    };
  }

  return state;
}

// UI čte odsud
app.get("/state", (req, res) => {
  const base = latestState ? { ...latestState } : makeEmptyState();

  // ⚠️ vytvoříme kopii, ať si neničíme state v paměti
  const out = withUiCompat(base);

  // přidáme info o serveru (užitečné pro debug v UI)
  res.json({
    ...out,
    _server: {
      now: Date.now(),
      receivedAt: latestMeta.receivedAt,
      bytes: latestMeta.bytes,
    },
    _waiting: !latestState,
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

  // server-side historie (jen když si ji neposíláš sám v payload.memory)
  try {
    if (!payload.memory) {
      buildServerHistoryFromPayload(payload);
      saveHistoryToDisk();
    }
  } catch (e) {
    console.log("[history] append failed:", String(e));
  }

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
