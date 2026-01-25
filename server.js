import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

/**
 * ============================================================
 * VIRTUÁLNÍ ENERGIE (bez INA219) – KONFIG
 * ============================================================
 * Odhad P_in ze světla (BH1750 lux):
 *   solarFrac = clamp(lux / LUX_FULL, 0..1)
 *   P_in = PANEL_MAX_W * solarFrac^GAMMA
 *
 * Odhad P_out ze spotřeby:
 *   ESP32: I_esp_mA
 *   Fan:   I_fan_max_mA * (duty/255)
 *   P_out ~ V_BATT_EST * (I_total_mA / 1000)
 */
const VIRTUAL_ENERGY = {
  enabled: true,

  // Panel
  PANEL_MAX_W: 3.0,    // tvůj 5V 3W panel
  LUX_FULL: 30000,     // doladíš podle reality (venku poledne klidně 30–60k)
  GAMMA: 1.2,          // lehká nelinearita
  LUX_MIN_ON: 15,      // pod tímto lux = 0W (stín/šum)

  // Spotřeba (odhad)
  V_BATT_EST: 3.7,     // bez měření bereme typickou Li-ion
  I_ESP_MA: 100,       // průměr ESP32 + senzory
  I_FAN_MAX_MA: 200    // tvůj 5V 30x30 větrák cca 200mA max
};

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

      // doplníme i "solární potenciál" odhadem
      solarPotentialW: null,

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
    power: {
      solarInW: 0,
      loadW: 0,
      balanceWh: 0,
      collectionIntervalSec: 10
    },
    config: {},
    identity: {
      panelMaxW: VIRTUAL_ENERGY.PANEL_MAX_W
    }
  },
  memory: {
    today: {
      key: new Date().toISOString().slice(0, 10),
      temperature: [],
      light: [],
      brainRisk: [],
      energyIn: [],
      energyOut: [],
      totals: {
        energyInWh: 0,
        energyOutWh: 0,
        energyNetWh: 0
      }
    },
    days: []
  },
  events: [],
  brain: {
    mode: "HW",
    message: { text: "HW režim: sběr z ESP32", details: [] }
  }
};

// interní: pro integraci energie
let lastEnergyTs = Date.now();

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function nowKey() { return new Date().toISOString().slice(0, 10); }
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

/**
 * ============================================================
 * VIRTUÁLNÍ ENERGIE – výpočet P_in / P_out
 * ============================================================
 */
function estimateSolarInW(lux) {
  if (!VIRTUAL_ENERGY.enabled) return 0;
  if (!Number.isFinite(lux) || lux < VIRTUAL_ENERGY.LUX_MIN_ON) return 0;

  const frac = clamp(lux / VIRTUAL_ENERGY.LUX_FULL, 0, 1);
  const pin = VIRTUAL_ENERGY.PANEL_MAX_W * Math.pow(frac, VIRTUAL_ENERGY.GAMMA);
  return Number.isFinite(pin) ? pin : 0;
}

function estimateLoadW(fanDuty) {
  if (!VIRTUAL_ENERGY.enabled) return 0;

  const d = Number.isFinite(fanDuty) ? clamp(fanDuty, 0, 255) : 0;

  const iEsp = VIRTUAL_ENERGY.I_ESP_MA;
  const iFan = VIRTUAL_ENERGY.I_FAN_MAX_MA * (d / 255);

  const iTotalA = (iEsp + iFan) / 1000.0;
  const pout = VIRTUAL_ENERGY.V_BATT_EST * iTotalA;
  return Number.isFinite(pout) ? pout : 0;
}

/**
 * integrace do Wh: Wh += P(W) * dt(h)
 */
function integrateEnergy(pinW, poutW, nowTs) {
  const dtMs = Math.max(0, nowTs - lastEnergyTs);
  lastEnergyTs = nowTs;

  // ochrana: když server spí a probudí se po dlouhé době, neintegruj bláznoviny
  const dtClampedMs = Math.min(dtMs, 60_000); // max 60s najednou
  const dtH = dtClampedMs / 3600000.0;

  const inWh = pinW * dtH;
  const outWh = poutW * dtH;

  const t = state.memory.today.totals || (state.memory.today.totals = {});
  t.energyInWh = (t.energyInWh || 0) + inWh;
  t.energyOutWh = (t.energyOutWh || 0) + outWh;
  t.energyNetWh = (t.energyInWh || 0) - (t.energyOutWh || 0);

  state.device.power.balanceWh = t.energyNetWh;
}

/**
 * ============================================================
 * INGEST
 * ============================================================
 */
function applyIngest(payload) {
  const now = Date.now();
  state.time.now = now;

  const env = payload?.env || {};
  const fan = payload?.fan || {};
  const duty = Number(fan.duty);

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

  // fan flag
  if (Number.isFinite(duty)) state.device.fan = duty > 0;

  // --- memory.today rollover ---
  const key = nowKey();
  if (state.memory.today.key !== key) {
    state.memory.days.push(state.memory.today);
    if (state.memory.days.length > 21) state.memory.days.splice(0, state.memory.days.length - 21);

    state.memory.today = {
      key,
      temperature: [],
      light: [],
      brainRisk: [],
      energyIn: [],
      energyOut: [],
      totals: { energyInWh: 0, energyOutWh: 0, energyNetWh: 0 }
    };

    // reset integrace dne (ať nezačne dnešek dt z včerejška)
    lastEnergyTs = now;
  }

  // --- series append ---
  pushSeries(state.memory.today.temperature, boxTempC);
  pushSeries(state.memory.today.light, lux);

  // --- VIRTUÁLNÍ ENERGIE (hlavní přínos) ---
  const pinW = estimateSolarInW(lux);
  const poutW = estimateLoadW(duty);

  state.device.power.solarInW = pinW;
  state.device.power.loadW = poutW;
  state.device.power.collectionIntervalSec = 10;

  we.solarPotentialW = pinW;

  pushSeries(state.memory.today.energyIn, pinW);
  pushSeries(state.memory.today.energyOut, poutW);

  integrateEnergy(pinW, poutW, now);

  // --- “brain” placeholder ---
  state.brain.message.text = env.isNight
    ? "Noc: běžím úsporně, hlídám teplotu boxu (HW + virtuální energie)"
    : "Den: sbírám data, řídím ventilátor (HW + virtuální energie)";
  state.brain.mode = env.isNight ? "NIGHT" : "DAY";
}

// --- routes ---
app.get("/health", (req, res) => res.json({ ok: true, mode: "HW", now: Date.now() }));
app.get("/state", (req, res) => res.json(state));

app.post("/ingest", (req, res) => {
  try {
    applyIngest(req.body || {});
    logEvent("HW", "Ingest OK", "info", { from: req.ip });
    res.json({ ok: true });
  } catch (e) {
    logEvent("HW", "Ingest FAIL", "error", { err: String(e?.message || e) });
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`HW backend listening on :${PORT}`);
});
