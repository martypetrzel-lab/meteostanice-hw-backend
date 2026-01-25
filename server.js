import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

// --- runtime store (in-memory) ---
const state = {
  time: { now: Date.now(), isDay: true },
  world: {
    environment: {
      light: null,
      lightLux: null,
      lux: null,

      // UI kompatibilita
      boxTempC: null,
      indoorTempC: null,
      indoorHumPct: null,
      outdoorTempC: null,
      airTempC: null,

      scenario: "HW",
      stressPattern: "HW",
      phase: "HW"
    },
    time: { now: Date.now(), isDay: true },
    cycle: { day: null, week: null, phase: "HW", season: null }
  },
  device: {
    temperature: null,
    humidity: null,
    light: null,
    fan: false,
    sensors: {
      dht22: { tempC: null, humidity: null },
      ds18b20: { tempC: null },
      bh1750: { lux: null }
    },
    battery: null,
    power: null,
    config: {},
    identity: {}
  },
  memory: {
    today: {
      key: new Date().toISOString().slice(0, 10),
      temperature: [],
      light: [],
      brainRisk: [],
      energyIn: [],
      energyOut: [],
      totals: {}
    },
    days: []
  },
  events: [],
  brain: {
    mode: "HW",
    message: { text: "HW režim: sběr z ESP32", details: [] }
  }
};

function nowKey() {
  return new Date().toISOString().slice(0, 10);
}

function hhmmss() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function pushSeries(arr, v, max = 2000) {
  if (!Number.isFinite(v)) return;
  arr.push({ t: hhmmss(), v });
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function logEvent(key, message, level = "info", meta = null) {
  state.events.push({
    ts: Date.now(),
    key,
    action: "INGEST",
    level,
    message,
    meta
  });
  if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
}

function applyIngest(payload) {
  const now = Date.now();
  state.time.now = now;

  const env = payload?.env || {};
  const device = payload?.device || {};
  const fan = payload?.fan || {};

  // --- normalize values ---
  const boxTempC = Number(env.boxTempC);
  const humPct = Number(env.indoorHumPct);
  const outTempC = Number(env.outdoorTempC);
  const lux = Number(env.lightLux ?? env.lux ?? env.light);

  // --- world.environment for UI adapter ---
  const we = state.world.environment;
  if (Number.isFinite(boxTempC)) {
    we.boxTempC = boxTempC;
    we.indoorTempC = boxTempC;
  }
  if (Number.isFinite(humPct)) we.indoorHumPct = humPct;

  if (Number.isFinite(outTempC)) {
    we.outdoorTempC = outTempC;
    we.airTempC = outTempC;
  }

  if (Number.isFinite(lux)) {
    we.light = Math.round(lux);
    we.lightLux = lux;
    we.lux = lux;
  }

  we.scenario = "HW";
  we.stressPattern = "HW";
  we.phase = env.isNight ? "NIGHT" : "DAY";

  state.world.time.now = now;
  state.world.time.isDay = !env.isNight;

  // --- device block (legacy keys your UI uses) ---
  if (Number.isFinite(boxTempC)) state.device.temperature = boxTempC;
  if (Number.isFinite(humPct)) state.device.humidity = humPct;
  if (Number.isFinite(lux)) state.device.light = Math.round(lux);

  state.device.sensors.dht22.tempC = Number.isFinite(boxTempC) ? boxTempC : state.device.sensors.dht22.tempC;
  state.device.sensors.dht22.humidity = Number.isFinite(humPct) ? humPct : state.device.sensors.dht22.humidity;
  state.device.sensors.ds18b20.tempC = Number.isFinite(outTempC) ? outTempC : state.device.sensors.ds18b20.tempC;
  state.device.sensors.bh1750.lux = Number.isFinite(lux) ? lux : state.device.sensors.bh1750.lux;

  // fan flag (simple)
  const duty = Number(fan.duty);
  state.device.fan = Number.isFinite(duty) ? duty > 0 : state.device.fan;

  // --- memory.today rollover ---
  const key = nowKey();
  if (state.memory.today.key !== key) {
    // push yesterday into days
    state.memory.days.push(state.memory.today);
    if (state.memory.days.length > 21) state.memory.days.splice(0, state.memory.days.length - 21);

    state.memory.today = {
      key,
      temperature: [],
      light: [],
      brainRisk: [],
      energyIn: [],
      energyOut: [],
      totals: {}
    };
  }

  // --- series append ---
  pushSeries(state.memory.today.temperature, boxTempC);
  pushSeries(state.memory.today.light, lux);

  // --- “brain” placeholder (dokud není mozek v backendu) ---
  state.brain.message.text = env.isNight
    ? "Noc: sbírám data, šetřím energii (HW režim)"
    : "Den: sbírám data, řídím ventilátor (HW režim)";
  state.brain.mode = env.isNight ? "NIGHT" : "DAY";
}

// --- routes ---
app.get("/health", (req, res) => res.json({ ok: true, mode: "HW", now: Date.now() }));
app.get("/state", (req, res) => res.json(state));

// main ingest endpoint
app.post("/ingest", (req, res) => {
  try {
    applyIngest(req.body || {});
    logEvent("HW", "Ingest OK", "info", { from: req.ip });
    // optional: reply with control (later you can add real brain decisions)
    res.json({ ok: true });
  } catch (e) {
    logEvent("HW", "Ingest FAIL", "error", { err: String(e?.message || e) });
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`HW backend listening on :${PORT}`);
});
