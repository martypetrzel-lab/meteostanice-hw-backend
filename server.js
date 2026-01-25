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
 */
const VIRTUAL_ENERGY = {
  enabled: true,

  PANEL_MAX_W: 3.0,    // tvůj 5V 3W panel
  LUX_FULL: 30000,     // doladíš podle reality (venku poledne často 30–80k)
  GAMMA: 1.2,          // lehká nelinearita
  LUX_MIN_ON: 15,      // pod tímto lux = 0W (stín/šum)

  V_BATT_EST: 3.7,     // bez měření baterie bereme typickou Li-ion
  I_ESP_MA: 100,       // průměr ESP32 + senzory
  I_FAN_MAX_MA: 200    // tvůj větrák 5V/200mA
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const nowKey = () => new Date().toISOString().slice(0, 10);

// ✅ Ukládáme do historie timestamp (ms). UI si to převede na lokální čas (Europe/Prague)
function tsNow() {
  return Date.now();
}

function pushSeries(arr, v, max = 2000) {
  if (!Number.isFinite(v)) return;
  arr.push({ t: tsNow(), v });
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
 * VIRTUÁLNÍ ENERGIE – odhad P_in / P_out
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

let lastEnergyTs = Date.now();

/**
 * integrace do Wh + sync do state.energy pro UI 3.36.0
 */
function integrateEnergy(pinW, poutW, nowTs) {
  const dtMs = Math.max(0, nowTs - lastEnergyTs);
  lastEnergyTs = nowTs;

  const dtClampedMs = Math.min(dtMs, 60_000);
  const dtH = dtClampedMs / 3600000.0;

  const inWh = pinW * dtH;
  const outWh = poutW * dtH;

  const t = state.memory.today.totals || (state.memory.today.totals = {});
  t.energyInWh = (t.energyInWh || 0) + inWh;
  t.energyOutWh = (t.energyOutWh || 0) + outWh;
  t.energyNetWh = (t.energyInWh || 0) - (t.energyOutWh || 0);

  state.energy.totals.wh_in_today = t.energyInWh;
  state.energy.totals.wh_out_today = t.energyOutWh;
  state.energy.totals.wh_net_today = t.energyNetWh;

  state.device.power.balanceWh = t.energyNetWh;
}

/**
 * ============================================================
 * STATE
 * ============================================================
 */
const state = {
  time: { now: Date.now(), isDay: true },
  world: {
    environment: {
      light: null,
      lightLux: null,
      lux: null,
      solarPotentialW: null,

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

  energy: {
    ina_in: { p_raw: 0, p_ema: 0, voltageV: null, currentA: null, signal_quality: null },
    ina_out:{ p_raw: 0, p_ema: 0, voltageV: null, currentA: null, signal_quality: null },
    totals: { wh_in_today: 0, wh_out_today: 0, wh_net_today: 0 },
    rolling24h: { wh_in_24h: null, wh_out_24h: null, wh_net_24h: null },
    states: { power_state: "IDLE", power_path_state: "UNKNOWN" },
    deadbandW: null
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
    identity: { panelMaxW: VIRTUAL_ENERGY.PANEL_MAX_W }
  },

  memory: {
    today: {
      key: new Date().toISOString().slice(0, 10),
      temperature: [],
      light: [],
      brainRisk: [],
      energyIn: [],
      energyOut: [],
      totals: { energyInWh: 0, energyOutWh: 0, energyNetWh: 0 }
    },
    days: []
  },

  events: [],
  brain: { mode: "HW", message: { text: "HW režim: sběr z ESP32", details: [] } }
};

function applyIngest(payload) {
  const now = Date.now();
  state.time.now = now;

  const env = payload?.env || {};
  const fan = payload?.fan || {};
  const duty = Number(fan.duty);

  const boxTempC = Number(env.boxTempC);
  const humPct = Number(env.indoorHumPct);
  const outTempC = Number(env.outdoorTempC);
  const lux = Number(env.lightLux ?? env.lux ?? env.light);

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

  if (Number.isFinite(boxTempC)) state.device.temperature = boxTempC;
  if (Number.isFinite(humPct)) state.device.humidity = humPct;
  if (Number.isFinite(lux)) state.device.light = Math.round(lux);
  if (Number.isFinite(duty)) state.device.fan = duty > 0;

  state.device.sensors.dht22.tempC = Number.isFinite(boxTempC) ? boxTempC : state.device.sensors.dht22.tempC;
  state.device.sensors.dht22.humidity = Number.isFinite(humPct) ? humPct : state.device.sensors.dht22.humidity;
  state.device.sensors.ds18b20.tempC = Number.isFinite(outTempC) ? outTempC : state.device.sensors.ds18b20.tempC;
  state.device.sensors.bh1750.lux = Number.isFinite(lux) ? lux : state.device.sensors.bh1750.lux;

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

    lastEnergyTs = now;
    state.energy.totals.wh_in_today = 0;
    state.energy.totals.wh_out_today = 0;
    state.energy.totals.wh_net_today = 0;
  }

  pushSeries(state.memory.today.temperature, boxTempC);
  pushSeries(state.memory.today.light, lux);

  const pinW = estimateSolarInW(lux);
  const poutW = estimateLoadW(duty);

  we.solarPotentialW = pinW;

  state.device.power.solarInW = pinW;
  state.device.power.loadW = poutW;
  state.device.power.collectionIntervalSec = 10;

  state.energy.ina_in.p_raw = pinW;
  state.energy.ina_in.p_ema = pinW;
  state.energy.ina_out.p_raw = poutW;
  state.energy.ina_out.p_ema = poutW;

  if (pinW > 0.05 && poutW > 0.05) {
    state.energy.states.power_state = "MIXED";
    state.energy.states.power_path_state = "SOLAR_TO_LOAD";
  } else if (pinW > 0.05) {
    state.energy.states.power_state = "CHARGING";
    state.energy.states.power_path_state = "SOLAR_TO_BATT";
  } else if (poutW > 0.05) {
    state.energy.states.power_state = "DISCHARGING";
    state.energy.states.power_path_state = "BATT_TO_LOAD";
  } else {
    state.energy.states.power_state = "IDLE";
    state.energy.states.power_path_state = "UNKNOWN";
  }

  pushSeries(state.memory.today.energyIn, pinW);
  pushSeries(state.memory.today.energyOut, poutW);

  integrateEnergy(pinW, poutW, now);

  state.brain.message.text = env.isNight
    ? "Noc: běžím úsporně, hlídám teplotu boxu (HW + virtuální energie)"
    : "Den: sbírám data, řídím ventilátor (HW + virtuální energie)";
  state.brain.mode = env.isNight ? "NIGHT" : "DAY";
}

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
