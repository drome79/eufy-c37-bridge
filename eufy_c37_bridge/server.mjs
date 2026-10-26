// Eufy C37 Bridge: holt Bilder der eufyCam C37 ueber @mega-yfue/eufy-sdk und stellt sie
// Home Assistant als JPEG-Adressen bereit (/snapshot/<name>.jpg). Bilder werden gepuffert,
// damit die Akku-Kameras nicht bei jedem Abruf geweckt werden.
// Ab 0.2.0 zusaetzlich per MQTT (Discovery): Bewegung, Person, Akku, Zeit des letzten Bildes, Knopf "Live-Bild holen".
// Ab 0.3.0 Livevideo auf Abruf: /live/<name>.ts liefert MPEG-TS (H.264/H.265 unveraendert, ohne Ton),
// solange jemand zuschaut; danach wird die Kamera wieder schlafen gelassen.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import mqtt from "mqtt";
import { EufyMega, FileSessionStore } from "@mega-yfue/eufy-sdk";

const DATA = process.env.DATA_DIR || "/data";
const OPTIONS_PATH = process.env.OPTIONS_PATH || path.join(DATA, "options.json");
const opts = JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8").replace(/^﻿/, ""));

const PORT = Number(opts.port || 8099);
const REFRESH_MIN = Number(opts.refresh_minutes ?? 30);
const MIN_LIVE_MIN = Number(opts.min_live_interval_minutes ?? 10);
const LIVE_TIMEOUT_MS = 75_000;
const LIVE_MAX_MIN = Number(opts.live_max_minutes ?? 5); // Akku: laengster Livestream am Stueck
const LIVE_IDLE_MS = 20_000; // so lange nach dem letzten Zuschauer weiterlaufen lassen
const LIVE_START_TIMEOUT_MS = 45_000;
const BASE = "eufy_c37";

const log = (...a) => console.log(new Date().toISOString(), ...a);

// "Hintertür" -> "hintertuer"
const slugify = (s) =>
  s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: keine Antwort nach ${ms / 1000} s`)), ms))]);

const state = { login: "pending", loginInfo: "", mqtt: "aus", cameras: {} };

// Kameras laut Optionen; Bilder ueber Neustarts hinweg in DATA behalten
for (const name of opts.cameras || []) {
  const slug = slugify(name);
  const file = path.join(DATA, `snapshot_${slug}.jpg`);
  const ts = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  state.cameras[slug] = {
    name, slug, sn: null, file,
    jpeg: ts ? fs.readFileSync(file) : null,
    ts,
    source: ts ? "cache" : null,
    // ein frisches Bild aus dem Cache zaehlt als letzter Live-Versuch -> nach Neustart nicht sofort wecken
    lastLiveTry: ts, busy: null, lastError: null, lastEvent: null, battery: null, live: null,
  };
}

// --- MQTT ---------------------------------------------------------------------------------------

let mq = null;
const pub = (topic, payload, retain = true) => { if (mq?.connected) mq.publish(topic, String(payload), { retain }); };

async function mqttConfig() {
  const tok = process.env.SUPERVISOR_TOKEN;
  if (!tok) return null;
  try {
    const r = await fetch("http://supervisor/services/mqtt", { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null;
    return (await r.json()).data ?? null;
  } catch { return null; }
}

function publishDiscovery(cam) {
  const dev = {
    identifiers: [`${BASE}_${cam.slug}`],
    name: `C37 ${cam.name}`,
    manufacturer: "Eufy",
    model: "eufyCam C37",
  };
  const common = { availability_topic: `${BASE}/status`, device: dev };
  const cfg = (component, key, body) =>
    pub(`homeassistant/${component}/${BASE}_${cam.slug}_${key}/config`,
      JSON.stringify({ ...common, unique_id: `${BASE}_${cam.slug}_${key}`, object_id: `c37_${cam.slug}_${key}`, ...body }));
  cfg("binary_sensor", "motion", { name: "Bewegung", device_class: "motion", state_topic: `${BASE}/${cam.slug}/motion`, off_delay: 30 });
  cfg("binary_sensor", "person", { name: "Person", device_class: "occupancy", state_topic: `${BASE}/${cam.slug}/person`, off_delay: 30 });
  cfg("sensor", "battery", { name: "Akku", device_class: "battery", unit_of_measurement: "%", state_class: "measurement", state_topic: `${BASE}/${cam.slug}/battery`, entity_category: "diagnostic" });
  cfg("sensor", "image_ts", { name: "Letztes Bild", device_class: "timestamp", state_topic: `${BASE}/${cam.slug}/image_ts` });
  cfg("sensor", "last_event", { name: "Letztes Ereignis", state_topic: `${BASE}/${cam.slug}/last_event`, icon: "mdi:motion-sensor" });
  cfg("button", "refresh", { name: "Live-Bild holen", command_topic: `${BASE}/${cam.slug}/refresh`, icon: "mdi:camera-retake" });
  if (cam.ts) pub(`${BASE}/${cam.slug}/image_ts`, new Date(cam.ts).toISOString());
  if (cam.battery != null) pub(`${BASE}/${cam.slug}/battery`, cam.battery);
}

async function startMqtt() {
  const c = await mqttConfig();
  if (!c) { state.mqtt = "kein Broker (Mosquitto-Add-on fehlt?)"; log("MQTT: kein Broker gefunden, laeuft ohne MQTT"); return; }
  mq = mqtt.connect(`mqtt://${c.host}:${c.port}`, {
    username: c.username, password: c.password, clientId: `${BASE}_bridge`,
    will: { topic: `${BASE}/status`, payload: "offline", retain: true },
    reconnectPeriod: 10_000,
  });
  mq.on("connect", () => {
    state.mqtt = "verbunden";
    log("MQTT verbunden");
    pub(`${BASE}/status`, "online");
    for (const cam of Object.values(state.cameras)) publishDiscovery(cam);
    mq.subscribe(`${BASE}/+/refresh`);
  });
  mq.on("message", (topic) => {
    const m = topic.match(new RegExp(`^${BASE}/([a-z0-9_]+)/refresh$`));
    const cam = m && state.cameras[m[1]];
    if (cam) { log(`${cam.name}: Live-Bild per Knopf angefordert`); liveSnapshot(cam, true); }
  });
  mq.on("error", (e) => { state.mqtt = `Fehler: ${e.message}`; log("MQTT-Fehler:", e.message); });
  mq.on("close", () => { if (state.mqtt === "verbunden") state.mqtt = "getrennt"; });
}

// --- Eufy ---------------------------------------------------------------------------------------

function store(cam, jpeg, source) {
  cam.jpeg = jpeg;
  cam.ts = Date.now();
  cam.source = source;
  cam.lastError = null;
  try { fs.writeFileSync(cam.file, jpeg); } catch (e) { log("Bild nicht gespeichert:", e.message); }
  pub(`${BASE}/${cam.slug}/image_ts`, new Date(cam.ts).toISOString());
  log(`${cam.name}: neues Bild (${source}, ${jpeg.length} Bytes)`);
}

const eufy = new EufyMega({
  email: opts.email,
  password: opts.password || "-",
  countryCode: opts.country || "DE",
  store: new FileSessionStore(path.join(DATA, "eufy-session.json")),
});
eufy.on("error", (e) => log("[SDK]", String(e?.message ?? e).slice(0, 300)));

async function login() {
  let res = await eufy.login();
  if (res.status === "captcha") {
    if (opts.captcha_answer) {
      res = await eufy.solveCaptcha(opts.captcha_answer);
    } else {
      const img = String(res.image ?? "").replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(path.join(DATA, "captcha.png"), Buffer.from(img, "base64"));
      state.loginInfo = "Captcha noetig: Bild unter /captcha.png abrufen, Text in der Option captcha_answer eintragen, Add-on neu starten.";
    }
  }
  if (res.status === "2fa") {
    if (opts.verify_code) res = await eufy.submitVerifyCode(opts.verify_code);
    else state.loginInfo = "Bestaetigungscode noetig: Code aus Mail/SMS in der Option verify_code eintragen, Add-on neu starten.";
  }
  state.login = res.status;
  if (res.status !== "ok") { log("Anmeldung nicht abgeschlossen:", res.status, state.loginInfo); return false; }
  state.loginInfo = "";
  log("Anmeldung ok");
  const list = await eufy.getDevices();
  for (const cam of Object.values(state.cameras)) {
    // Namen koennen doppelt vorkommen (z. B. Tuersensor und Kamera "Hintertür") -> nur Geraete mit Kamera nehmen
    let rec = null;
    for (const d of list.filter((d) => (d.name ?? "").toLowerCase() === cam.name.toLowerCase())) {
      const dev = await eufy.getDevice(d.sn);
      if (dev.has?.("camera")) { rec = d; break; }
    }
    if (rec) { cam.sn = rec.sn; log(`${cam.name}: gefunden (${rec.model})`); }
    else { cam.lastError = "Geraet nicht im Konto gefunden"; log(`${cam.name}: nicht im Konto gefunden`); }
  }
  return true;
}

async function readBattery(cam) {
  if (!cam.sn) return;
  try {
    const dev = await eufy.getDevice(cam.sn);
    const b = dev.battery?.();
    let v = b?.level;
    if (typeof v === "function") v = await v.call(b);
    if (typeof v === "number" && Number.isFinite(v)) {
      cam.battery = v;
      pub(`${BASE}/${cam.slug}/battery`, v);
    }
  } catch (e) {
    log(`${cam.name}: Akkustand nicht lesbar (${String(e?.message ?? e).slice(0, 120)})`);
  }
}

async function liveSnapshot(cam, force = false) {
  if (!cam.sn) throw new Error("Kamera nicht verbunden");
  if (cam.busy) return cam.busy;
  const wait = MIN_LIVE_MIN * 60_000 - (Date.now() - cam.lastLiveTry);
  if (!force && wait > 0) return null; // Akku schonen
  cam.lastLiveTry = Date.now();
  cam.busy = (async () => {
    try {
      const dev = await eufy.getDevice(cam.sn);
      const fn = dev.camera?.()?.snapshotLive;
      if (typeof fn !== "function") throw new Error("Live-Bild wird nicht angeboten");
      const r = await withTimeout(fn(), LIVE_TIMEOUT_MS, "Live-Bild");
      store(cam, r.jpeg, "live");
    } catch (e) {
      cam.lastError = String(e?.message ?? e).slice(0, 300);
      log(`${cam.name}: Live-Bild fehlgeschlagen: ${cam.lastError}`);
    } finally {
      cam.busy = null;
    }
  })();
  return cam.busy;
}

// --- Livevideo ----------------------------------------------------------------------------------
// Ein Livestream pro Kamera, geteilt von allen Zuschauern. Das SDK liefert Annex-B-Frames, ffmpeg packt
// sie ohne Neukodierung in MPEG-TS. Ohne Zuschauer wird nach LIVE_IDLE_MS gestoppt, spaetestens nach LIVE_MAX_MIN.

function stopLive(cam, reason) {
  const s = cam.live;
  if (!s) return;
  cam.live = null;
  clearTimeout(s.idleTimer);
  clearTimeout(s.maxTimer);
  try { s.consumer?.stop(); } catch {}
  try { s.ff?.stdin.end(); s.ff?.kill("SIGKILL"); } catch {}
  for (const res of s.clients) { try { res.end(); } catch {} }
  s.clients.clear();
  log(`${cam.name}: Livestream beendet (${reason})`);
}

function startFfmpeg(cam, s, codec) {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-fflags", "+genpts+nobuffer", "-use_wallclock_as_timestamps", "1",
    "-f", codec === "h265" ? "hevc" : "h264", "-i", "pipe:0",
    "-c:v", "copy", "-an",
    "-f", "mpegts", "-mpegts_flags", "+resend_headers", "pipe:1",
  ];
  const ff = spawn(opts.ffmpeg_path || "ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  ff.stdin.on("error", () => {});
  ff.stdout.on("data", (chunk) => { for (const res of s.clients) res.write(chunk); });
  ff.stderr.on("data", (d) => log(`${cam.name} [ffmpeg] ${String(d).trim().slice(0, 200)}`));
  ff.on("exit", () => { if (cam.live === s) stopLive(cam, "ffmpeg beendet"); });
  s.ff = ff;
  s.codec = codec;
}

async function ensureLive(cam) {
  if (cam.live) return cam.live;
  const s = { clients: new Set(), consumer: null, ff: null, codec: null, idleTimer: null, maxTimer: null, startedAt: Date.now() };
  cam.live = s;
  try {
    const dev = await eufy.getDevice(cam.sn);
    const liveFn = dev.camera?.()?.live;
    if (typeof liveFn !== "function") throw new Error("Livevideo wird nicht angeboten");
    const consumer = await liveFn({ powered: "battery" });
    s.consumer = consumer;
    const firstFrame = new Promise((resolve, reject) => {
      consumer.on("video", (frame) => {
        if (cam.live !== s) return;
        if (!s.ff) startFfmpeg(cam, s, frame.codec);
        else if (frame.codec !== s.codec) { log(`${cam.name}: Codec-Wechsel ${s.codec} -> ${frame.codec}`); }
        try { s.ff.stdin.write(frame.data); } catch {}
        resolve();
      });
      consumer.on("error", (e) => { reject(e); if (cam.live === s) stopLive(cam, `Fehler: ${String(e?.message ?? e).slice(0, 120)}`); });
      consumer.on("stop", () => { if (cam.live === s) stopLive(cam, "Kamera hat gestoppt"); });
    });
    consumer.on("budget", (notice) => {
      // Akku-Budget: verlaengern, solange jemand zuschaut und die Hoechstdauer nicht erreicht ist
      if (s.clients.size > 0 && Date.now() - s.startedAt < LIVE_MAX_MIN * 60_000) notice.extend();
    });
    await withTimeout(firstFrame, LIVE_START_TIMEOUT_MS, "Livestream-Start");
    s.maxTimer = setTimeout(() => stopLive(cam, `Hoechstdauer ${LIVE_MAX_MIN} min erreicht`), LIVE_MAX_MIN * 60_000);
    log(`${cam.name}: Livestream laeuft (${s.codec})`);
    return s;
  } catch (e) {
    stopLive(cam, `Start fehlgeschlagen: ${String(e?.message ?? e).slice(0, 160)}`);
    throw e;
  }
}

async function serveLive(cam, req, res) {
  let s;
  try { s = await ensureLive(cam); }
  catch (e) { res.writeHead(503); return res.end(`Livestream nicht verfuegbar: ${String(e?.message ?? e).slice(0, 200)}`); }
  clearTimeout(s.idleTimer);
  res.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-store", connection: "close" });
  s.clients.add(res);
  log(`${cam.name}: Zuschauer verbunden (${s.clients.size})`);
  req.on("close", () => {
    s.clients.delete(res);
    if (cam.live === s && s.clients.size === 0) {
      s.idleTimer = setTimeout(() => { if (cam.live === s && s.clients.size === 0) stopLive(cam, "keine Zuschauer"); }, LIVE_IDLE_MS);
    }
  });
}

// Ereignisse (Bewegung, Person ...): an MQTT melden und das Ereignisbild aus dem Push uebernehmen,
// ohne die Kamera zu wecken
const PERSON_EVENTS = new Set(["personDetected", "strangerDetected"]);
eufy.on("event", async (e) => {
  const cam = Object.values(state.cameras).find((c) => c.sn && c.sn === e?.deviceSn);
  if (!cam) return;
  cam.lastEvent = { name: e.eventName, at: new Date().toISOString() };
  pub(`${BASE}/${cam.slug}/last_event`, e.eventName);
  if (e.eventName === "motion" || PERSON_EVENTS.has(e.eventName)) pub(`${BASE}/${cam.slug}/motion`, "ON", false);
  if (PERSON_EVENTS.has(e.eventName)) pub(`${BASE}/${cam.slug}/person`, "ON", false);
  try {
    const dev = await eufy.getDevice(cam.sn);
    const fn = dev.camera?.()?.snapshotStored;
    if (typeof fn === "function") {
      const buf = await withTimeout(fn(), 20_000, "Ereignisbild");
      if (buf?.length) store(cam, buf, `event:${e.eventName}`);
    }
  } catch (err) {
    log(`${cam.name}: Ereignisbild nicht verfuegbar (${String(err?.message ?? err).slice(0, 120)})`);
  }
});

// --- HTTP-Schnittstelle fuer Home Assistant ----------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const lm = url.pathname.match(/^\/live\/([a-z0-9_]+)(?:\.ts)?$/);
  if (lm) {
    const cam = state.cameras[lm[1]];
    if (!cam) { res.writeHead(404); return res.end("unbekannte Kamera"); }
    if (!cam.sn) { res.writeHead(503); return res.end("Kamera nicht verbunden"); }
    return serveLive(cam, req, res);
  }
  const m = url.pathname.match(/^\/(snapshot|refresh)\/([a-z0-9_]+)(?:\.jpg)?$/);
  if (m) {
    const cam = state.cameras[m[2]];
    if (!cam) { res.writeHead(404); return res.end("unbekannte Kamera"); }
    const stale = !cam.jpeg || (REFRESH_MIN > 0 && Date.now() - cam.ts > REFRESH_MIN * 60_000);
    if (m[1] === "refresh" || stale) {
      const p = liveSnapshot(cam, m[1] === "refresh");
      if (!cam.jpeg && p) await p; // erstes Bild abwarten
    }
    if (m[1] === "refresh") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: !cam.lastError, error: cam.lastError, ts: cam.ts }));
    }
    if (!cam.jpeg) { res.writeHead(503); return res.end(cam.lastError || "noch kein Bild"); }
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store", "x-image-age-s": String(Math.round((Date.now() - cam.ts) / 1000)) });
    return res.end(cam.jpeg);
  }
  if (url.pathname === "/captcha.png" && fs.existsSync(path.join(DATA, "captcha.png"))) {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(fs.readFileSync(path.join(DATA, "captcha.png")));
  }
  // Status
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    login: state.login, info: state.loginInfo, mqtt: state.mqtt,
    cameras: Object.values(state.cameras).map((c) => ({
      name: c.name, url: `/snapshot/${c.slug}.jpg`, connected: Boolean(c.sn),
      image_age_s: c.jpeg ? Math.round((Date.now() - c.ts) / 1000) : null, source: c.source,
      battery: c.battery, busy: Boolean(c.busy), last_error: c.lastError, last_event: c.lastEvent,
      live: c.live ? { viewers: c.live.clients.size, codec: c.live.codec, running_s: Math.round((Date.now() - c.live.startedAt) / 1000) } : null,
      live_url: `/live/${c.slug}.ts`,
    })),
  }, null, 2));
});
server.listen(PORT, () => log(`HTTP auf Port ${PORT}`));

// Regelmaessige Aktualisierung, nacheinander, damit nicht alle Kameras gleichzeitig wach sind
async function refreshAll() {
  for (const cam of Object.values(state.cameras)) {
    if (!cam.sn) continue;
    await liveSnapshot(cam);
    await readBattery(cam);
  }
}

await startMqtt();
try {
  if (await login()) {
    await refreshAll();
    if (REFRESH_MIN > 0) setInterval(() => refreshAll().catch((e) => log("Aktualisierung:", e.message)), REFRESH_MIN * 60_000);
  }
} catch (e) {
  state.login = "error";
  state.loginInfo = String(e?.message ?? e).slice(0, 300);
  log("Anmeldung fehlgeschlagen:", state.loginInfo);
}

const stop = async () => {
  for (const cam of Object.values(state.cameras)) stopLive(cam, "Add-on stoppt");
  try { pub(`${BASE}/status`, "offline"); mq?.end(true); } catch {}
  try { await eufy.disconnect?.(); } catch {}
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
