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
import { EufyMega, FileSessionStore, CAPABILITY_MODULES } from "@mega-yfue/eufy-sdk";

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

const state = { login: "pending", loginInfo: "", mqtt: "aus", mode: "", cameras: {}, accountDevices: [], removed: [], extras: [], removedExtras: [] };

// C37-Familie (eufyCam C37 = T814X / T814XS)
const C37_MODEL = /^T814/i;

// Kamera anlegen; Bilder ueber Neustarts hinweg in DATA behalten
function addCamera(name) {
  let slug = slugify(name) || "kamera";
  for (let i = 2; state.cameras[slug]; i++) slug = `${slugify(name)}_${i}`;
  const file = path.join(DATA, `snapshot_${slug}.jpg`);
  const ts = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  const cam = {
    name, slug, sn: null, model: null, file,
    jpeg: ts ? fs.readFileSync(file) : null,
    ts,
    source: ts ? "cache" : null,
    // ein frisches Bild aus dem Cache zaehlt als letzter Live-Versuch -> nach Neustart nicht sofort wecken
    lastLiveTry: ts, busy: null, lastError: null, lastEvent: null, battery: null, live: null,
    caps: [], ptz: false,
  };
  state.cameras[slug] = cam;
  return cam;
}
for (const name of opts.cameras || []) if (String(name).trim()) addCamera(String(name).trim());

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

// Geraet fuer MQTT-Discovery: C37 heissen "C37 <Name>", andere Eufy-Kameras "Eufy <Name>"
function deviceInfo(cam) {
  const c37 = C37_MODEL.test(cam.model ?? "");
  return {
    identifiers: [`${BASE}_${cam.slug}`],
    name: `${c37 ? "C37" : "Eufy"} ${cam.name}`,
    manufacturer: "Eufy",
    model: c37 ? "eufyCam C37" : (cam.model || "Eufy-Kamera"),
  };
}

function publishDiscovery(cam) {
  const dev = deviceInfo(cam);
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

// Entitaeten einer Kamera, die es im Konto nicht gibt, wieder aus Home Assistant entfernen
// (leere, gespeicherte Discovery-Nachricht loescht die Entitaet)
function unpublishDiscovery(slug) {
  const keys = [["binary_sensor", "motion"], ["binary_sensor", "person"], ["sensor", "battery"], ["sensor", "image_ts"],
    ["sensor", "last_event"], ["button", "refresh"], ["button", "ptz_left"], ["button", "ptz_right"], ["button", "ptz_up"], ["button", "ptz_down"]];
  for (const [component, key] of keys) pub(`homeassistant/${component}/${BASE}_${slug}_${key}/config`, "");
}

// Schwenken/Neigen: nur fuer Kameras, die laut SDK "ptz" koennen
const PTZ_DIRS = { left: "Links", right: "Rechts", up: "Hoch", down: "Runter" };
function publishPtz(cam) {
  if (!cam.ptz) return;
  const dev = deviceInfo(cam);
  for (const [dir, label] of Object.entries(PTZ_DIRS)) {
    pub(`homeassistant/button/${BASE}_${cam.slug}_ptz_${dir}/config`, JSON.stringify({
      availability_topic: `${BASE}/status`, device: dev, unique_id: `${BASE}_${cam.slug}_ptz_${dir}`,
      name: `Schwenken ${label}`, command_topic: `${BASE}/${cam.slug}/ptz`, payload_press: dir, icon: `mdi:arrow-${dir}-bold`,
    }));
  }
}

async function ptzMove(cam, dir) {
  if (!cam.ptz) throw new Error("Kamera kann laut SDK nicht schwenken");
  if (!PTZ_DIRS[dir]) throw new Error(`unbekannte Richtung ${dir}`);
  const dev = await eufy.getDevice(cam.sn);
  await withTimeout(dev.ptz().rotate(dir), 20_000, "Schwenken");
  log(`${cam.name}: geschwenkt ${dir}`);
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
    // nur Kameras melden, die im Konto gefunden wurden (sonst entstehen Geister-Entitaeten)
    for (const cam of Object.values(state.cameras)) {
      if (cam.sn && !cam.liveOnly) { publishDiscovery(cam); publishPtz(cam); }
      else if (cam.liveOnly) { unpublishDiscovery(cam.slug); publishPtz(cam); }
    }
    for (const slug of state.removed) unpublishDiscovery(slug);
    mq.subscribe(`${BASE}/+/refresh`);
    mq.subscribe(`${BASE}/+/ptz`);
    mq.subscribe(`${BASE}/+/alarm/set`);
    for (const x of state.extras) { publishExtraDiscovery(x); x.values = {}; }
    for (const slug of state.removedExtras) unpublishExtra(slug);
    if (state.extras.length) refreshExtras();
  });
  mq.on("message", (topic, payload) => {
    const am = topic.match(new RegExp(`^${BASE}/([a-z0-9_]+)/alarm/set$`));
    if (am) {
      const x = state.extras.find((d) => d.slug === am[1] && d.kind === "station");
      if (x) setArming(x, String(payload)).catch((e) => log(`${x.name}: Modus setzen fehlgeschlagen: ${String(e?.message ?? e).slice(0, 160)}`));
      return;
    }
    const m = topic.match(new RegExp(`^${BASE}/([a-z0-9_]+)/(refresh|ptz)$`));
    const cam = m && state.cameras[m[1]];
    if (!cam) return;
    if (m[2] === "refresh") { log(`${cam.name}: Live-Bild per Knopf angefordert`); liveSnapshot(cam, true); }
    else ptzMove(cam, String(payload)).catch((e) => log(`${cam.name}: Schwenken fehlgeschlagen: ${String(e?.message ?? e).slice(0, 160)}`));
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

  // Die Bridge liefert NUR Geraete, deren Name in der Konfiguration (`cameras`) steht – Kameras ebenso wie
  // HomeBase, Tuersensoren und Tuerklingel. Ein Name passt auf alle Geraete gleichen Namens
  // (z. B. "Hintertür" = Kamera und Tuersensor). Ohne Eintrag liefert die Bridge nichts.
  const wanted = new Set((opts.cameras || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean));
  const camByName = {};
  for (const d of list) {
    let hasCam = false;
    let caps = [];
    try {
      const dev = await eufy.getDevice(d.sn);
      hasCam = Boolean(dev.has?.("camera"));
      caps = Object.keys(CAPABILITY_MODULES || {}).filter((c) => { try { return dev.has?.(c); } catch { return false; } });
    } catch {}
    const selected = wanted.has(String(d.name ?? "").trim().toLowerCase());
    state.accountDevices.push({ name: d.name, model: d.model, camera: hasCam, c37: C37_MODEL.test(d.model ?? ""), capabilities: caps, selected });
    // Weitere Geraete: HomeBase (Alarmmodus), Tuersensoren (offen/zu), Tuerklingel (Klingeln) – nur wenn ausgewaehlt
    const kinds = [];
    if (caps.includes("arming") && !hasCam) kinds.push("station");
    if (caps.includes("contact")) kinds.push("contact");
    if (caps.includes("doorbell")) kinds.push("doorbell");
    for (const kind of kinds) {
      if (selected) addExtra(kind, d);
      else unpublishExtra(`${kind}_${slugify(d.name ?? "") || "geraet"}`); // fruehere Entitaeten entfernen
    }
    if (hasCam && selected) camByName[String(d.name).trim().toLowerCase()] = d;
  }
  log(`Geraete im Konto: ${state.accountDevices.map((d) => `${d.name} (${d.model}${d.camera ? ", Kamera" : ""}${d.selected ? ", ausgewaehlt" : ""})`).join("; ")}`);

  state.mode = "Namen aus der Konfiguration";
  for (const cam of Object.values(state.cameras)) {
    const rec = camByName[cam.name.trim().toLowerCase()];
    if (rec) { await bindCamera(cam, rec); continue; }
    // Name gehoert zu keiner Kamera: entweder ein anderes Geraet (HomeBase, Sensor) oder unbekannt
    const known = state.accountDevices.some((d) => String(d.name ?? "").trim().toLowerCase() === cam.name.trim().toLowerCase());
    if (!known) log(`${cam.name}: nicht im Konto gefunden`);
    unpublishDiscovery(cam.slug);
    state.removed.push(cam.slug);
    delete state.cameras[cam.slug];
  }
  if (wanted.size === 0) log("Keine Geraete in der Konfiguration eingetragen – die Bridge liefert nichts. Verfuegbare Geraete stehen oben bzw. auf der Statusseite.");
  return true;
}

async function bindCamera(cam, rec) {
  cam.sn = rec.sn;
  cam.model = rec.model;
  const dev = await eufy.getDevice(rec.sn);
  cam.caps = Object.keys(CAPABILITY_MODULES || {}).filter((c) => { try { return dev.has?.(c); } catch { return false; } });
  cam.ptz = cam.caps.includes("ptz") && typeof dev.ptz?.()?.rotate === "function";
  // Andere Eufy-Kameras (z. B. Tuerklingel) laufen meist schon ueber eufy-security-ws. Fuer sie liefert die Bridge
  // nur das Livevideo: keine MQTT-Entitaeten, kein regelmaessiges Wecken, keine Ereignisbilder.
  cam.liveOnly = !C37_MODEL.test(rec.model ?? "");
  log(`${cam.name}: verbunden (${rec.model})${cam.liveOnly ? ", nur Livevideo" : ""}, Faehigkeiten: ${cam.caps.join(", ") || "-"}`);
  // Nur-Live-Kameras: keine Sensoren, aber Schwenk-Knoepfe, falls die Kamera schwenken kann
  if (cam.liveOnly) { unpublishDiscovery(cam.slug); publishPtz(cam); return; }
  publishDiscovery(cam);
  if (cam.ptz) publishPtz(cam);
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
  // H.264 wird unveraendert durchgereicht. H.265 (z. B. T814XS) koennen Browser per WebRTC nicht abspielen,
  // deshalb wird es nach H.264 umgewandelt (verkleinert auf transcode_height, Standard 1080).
  const video = codec === "h264"
    ? ["-c:v", "copy"]
    : ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
       "-vf", `scale=-2:${Number(opts.transcode_height || 1080)}`, "-g", "30", "-bf", "0"];
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-fflags", "+genpts+nobuffer", "-use_wallclock_as_timestamps", "1",
    "-f", codec === "h265" ? "hevc" : "h264", "-i", "pipe:0",
    ...video, "-an",
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
    // Akku-Kameras bekommen ein Strom-Budget, Kameras mit Netzteil (z. B. Innenkameras) streamen unbegrenzt
    const consumer = await liveFn({ powered: cam.caps.includes("battery") ? "battery" : "wired" });
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
    // Waehrend die Kamera ohnehin wach ist, ein frisches Standbild mitnehmen (kostet kein zusaetzliches Wecken)
    setTimeout(() => { if (cam.live === s) liveSnapshot(cam, true); }, 5_000);
    return s;
  } catch (e) {
    stopLive(cam, `Start fehlgeschlagen: ${String(e?.message ?? e).slice(0, 160)}`);
    throw e;
  }
}

async function serveLive(cam, req, res) {
  // Kopfzeilen sofort senden: das Aufwachen der Kamera dauert einige Sekunden, und ein Abrufer
  // (ffmpeg in Home Assistant) soll so lange warten statt abzubrechen
  res.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-store", connection: "close" });
  let s = null;
  let closed = false;
  const armIdle = () => {
    if (s && cam.live === s && s.clients.size === 0) {
      clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => { if (cam.live === s && s.clients.size === 0) stopLive(cam, "keine Zuschauer"); }, LIVE_IDLE_MS);
    }
  };
  req.on("close", () => { closed = true; if (s) { s.clients.delete(res); armIdle(); } });
  try { s = await ensureLive(cam); }
  catch (e) { log(`${cam.name}: Livestream nicht verfuegbar: ${String(e?.message ?? e).slice(0, 200)}`); return res.end(); }
  if (closed) { armIdle(); return; }
  clearTimeout(s.idleTimer);
  s.clients.add(res);
  log(`${cam.name}: Zuschauer verbunden (${s.clients.size})`);
}

// --- Weitere Geraete: HomeBase, Tuersensoren, Tuerklingel -------------------------------------
// Alarmpanel fuer Stationen mit "arming", Kontakt-Sensoren fuer "contact", Klingel-Sensor + Ereignisbild fuer "doorbell".
// Die Sirene wird bewusst NICHT angeboten.

// Eufy-Guard-Modus: Wire-Wert -> Name
const ARMING_WIRE = { 0: "away", 1: "home", 2: "schedule", 3: "custom1", 4: "custom2", 5: "custom3", 6: "off", 47: "geofence", 63: "disarmed" };
// Name -> Zustand des HA-Alarmpanels
const ARMING_HA = { home: "armed_home", away: "armed_away", disarmed: "disarmed", off: "disarmed",
  schedule: "armed_custom_bypass", custom1: "armed_custom_bypass", custom2: "armed_custom_bypass", custom3: "armed_custom_bypass", geofence: "armed_custom_bypass" };
const ARMING_CMD = { ARM_HOME: "home", ARM_AWAY: "away", DISARM: "disarmed" };

// Entitaeten eines nicht (mehr) ausgewaehlten weiteren Geraets aus Home Assistant entfernen
function unpublishExtra(slug) {
  const keys = [["alarm_control_panel", "alarm"], ["sensor", "mode"], ["binary_sensor", "contact"], ["sensor", "battery"],
    ["binary_sensor", "ring"], ["image", "event_image"]];
  for (const [component, key] of keys) pub(`homeassistant/${component}/${BASE}_${slug}_${key}/config`, "");
  if (!state.removedExtras.includes(slug)) state.removedExtras.push(slug);
}

function addExtra(kind, rec) {
  const slug = `${kind}_${slugify(rec.name) || "geraet"}`;
  if (state.extras.find((x) => x.slug === slug)) return;
  state.extras.push({ kind, slug, sn: rec.sn, name: rec.name, model: rec.model, values: {} });
}

async function readVal(obj, key) {
  if (!obj) return undefined;
  let v = obj[key];
  if (typeof v === "function") v = await v.call(obj);
  return v;
}

function extraDevice(x) {
  return { identifiers: [`${BASE}_${x.slug}`], name: `Eufy ${x.name}`, manufacturer: "Eufy", model: x.model || "Eufy" };
}

function publishExtraDiscovery(x) {
  const base = { availability_topic: `${BASE}/status`, device: extraDevice(x) };
  const cfg = (component, key, body) => pub(`homeassistant/${component}/${BASE}_${x.slug}_${key}/config`,
    JSON.stringify({ ...base, unique_id: `${BASE}_${x.slug}_${key}`, ...body }));
  const t = `${BASE}/${x.slug}`;
  if (x.kind === "station") {
    cfg("alarm_control_panel", "alarm", { name: "Alarmmodus", state_topic: `${t}/alarm`, command_topic: `${t}/alarm/set`,
      payload_arm_home: "ARM_HOME", payload_arm_away: "ARM_AWAY", payload_disarm: "DISARM",
      code_arm_required: false, code_disarm_required: false, supported_features: ["arm_home", "arm_away"] });
    cfg("sensor", "mode", { name: "Modus (Eufy)", state_topic: `${t}/mode`, icon: "mdi:shield-home", entity_category: "diagnostic" });
  }
  if (x.kind === "contact") {
    cfg("binary_sensor", "contact", { name: "Tür", device_class: "door", state_topic: `${t}/contact` });
    cfg("sensor", "battery", { name: "Akku", device_class: "battery", unit_of_measurement: "%", state_class: "measurement", state_topic: `${t}/battery`, entity_category: "diagnostic" });
  }
  if (x.kind === "doorbell") {
    cfg("binary_sensor", "ring", { name: "Klingeln", icon: "mdi:doorbell", state_topic: `${t}/ring`, off_delay: 30 });
    cfg("image", "event_image", { name: "Ereignisbild", image_topic: `${t}/event_image`, content_type: "image/jpeg" });
  }
}

async function refreshExtra(x) {
  try {
    const dev = await eufy.getDevice(x.sn);
    const t = `${BASE}/${x.slug}`;
    if (x.kind === "station") {
      let raw = await readVal(dev.arming?.(), "mode");
      const name = typeof raw === "number" ? (ARMING_WIRE[raw] ?? `modus_${raw}`) : (raw != null ? String(raw) : undefined);
      if (name && name !== x.values.mode) {
        x.values.mode = name;
        pub(`${t}/mode`, name);
        pub(`${t}/alarm`, ARMING_HA[name] ?? "armed_custom_bypass");
      }
    }
    if (x.kind === "contact") {
      const open = await readVal(dev.contact?.(), "open");
      if (typeof open === "boolean" && open !== x.values.open) { x.values.open = open; pub(`${t}/contact`, open ? "ON" : "OFF"); }
      const bat = await readVal(dev.battery?.(), "level");
      if (typeof bat === "number" && bat !== x.values.battery) { x.values.battery = bat; pub(`${t}/battery`, bat); }
    }
  } catch (e) {
    x.values.error = String(e?.message ?? e).slice(0, 160);
  }
}

async function refreshExtras() { for (const x of state.extras) await refreshExtra(x); }

async function setArming(x, cmd) {
  const mode = ARMING_CMD[cmd];
  if (!mode) throw new Error(`unbekannter Befehl ${cmd}`);
  const dev = await eufy.getDevice(x.sn);
  const a = dev.arming?.();
  if (typeof a?.setMode !== "function") throw new Error("Alarmmodus laesst sich laut SDK nicht setzen");
  log(`${x.name}: setze Modus ${mode}`);
  await withTimeout(a.setMode(mode), 30_000, "Modus setzen");
  setTimeout(() => refreshExtra(x), 5_000);
}

// Ereignisse der weiteren Geraete: sofort nachlesen; Klingeln melden und das Ereignisbild weitergeben
eufy.on("event", async (e) => {
  const x = state.extras.find((d) => d.sn === e?.deviceSn);
  if (!x) return;
  x.values.lastEvent = { name: e.eventName, at: new Date().toISOString() };
  if (x.kind === "doorbell" && e.eventName === "doorbellPress") {
    pub(`${BASE}/${x.slug}/ring`, "ON", false);
    try {
      const dev = await eufy.getDevice(x.sn);
      const fn = dev.camera?.()?.snapshotStored;
      if (typeof fn === "function") {
        // Das Push-Bild kommt oft erst kurz nach dem Klingeln
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          try { const buf = await fn(); if (buf?.length) { if (mq?.connected) mq.publish(`${BASE}/${x.slug}/event_image`, buf, { retain: true }); break; } } catch {}
        }
      }
    } catch {}
  }
  if (x.kind !== "doorbell") refreshExtra(x);
});

// Ereignisse (Bewegung, Person ...): an MQTT melden und das Ereignisbild aus dem Push uebernehmen,
// ohne die Kamera zu wecken
const PERSON_EVENTS = new Set(["personDetected", "strangerDetected"]);
eufy.on("event", async (e) => {
  const cam = Object.values(state.cameras).find((c) => c.sn && c.sn === e?.deviceSn);
  if (!cam) return;
  cam.lastEvent = { name: e.eventName, at: new Date().toISOString() };
  // Nur-Live-Kameras: keine MQTT-Meldungen (das macht eufy-security-ws), aber das Ereignisbild als Standbild behalten
  if (!cam.liveOnly) {
    pub(`${BASE}/${cam.slug}/last_event`, e.eventName);
    if (e.eventName === "motion" || PERSON_EVENTS.has(e.eventName)) pub(`${BASE}/${cam.slug}/motion`, "ON", false);
    if (PERSON_EVENTS.has(e.eventName)) pub(`${BASE}/${cam.slug}/person`, "ON", false);
  }
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
  const pm = url.pathname.match(/^\/ptz\/([a-z0-9_]+)\/(left|right|up|down)$/);
  if (pm) {
    const cam = state.cameras[pm[1]];
    if (!cam) { res.writeHead(404); return res.end("unbekannte Kamera"); }
    try { await ptzMove(cam, pm[2]); res.writeHead(200); return res.end("ok"); }
    catch (e) { res.writeHead(409); return res.end(String(e?.message ?? e)); }
  }
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
    // Nur-Live-Kameras werden fuer Standbilder nie von selbst geweckt
    const stale = !cam.liveOnly && (!cam.jpeg || (REFRESH_MIN > 0 && Date.now() - cam.ts > REFRESH_MIN * 60_000));
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
    login: state.login, info: state.loginInfo, mqtt: state.mqtt, camera_selection: state.mode,
    account_devices: state.accountDevices,
    extra_devices: state.extras.map((x) => ({ name: x.name, kind: x.kind, model: x.model, values: x.values })),
    cameras: Object.values(state.cameras).map((c) => ({
      name: c.name, model: c.model, url: `/snapshot/${c.slug}.jpg`, connected: Boolean(c.sn),
      image_age_s: c.jpeg ? Math.round((Date.now() - c.ts) / 1000) : null, source: c.source,
      battery: c.battery, busy: Boolean(c.busy), last_error: c.lastError, last_event: c.lastEvent,
      live: c.live ? { viewers: c.live.clients.size, codec: c.live.codec, running_s: Math.round((Date.now() - c.live.startedAt) / 1000) } : null,
      live_url: `/live/${c.slug}.ts`,
      capabilities: c.caps, ptz: c.ptz, live_only: Boolean(c.liveOnly),
    })),
  }, null, 2));
});
server.listen(PORT, () => log(`HTTP auf Port ${PORT}`));

// Regelmaessige Aktualisierung, nacheinander, damit nicht alle Kameras gleichzeitig wach sind
async function refreshAll() {
  for (const cam of Object.values(state.cameras)) {
    if (!cam.sn || cam.liveOnly) continue;
    await liveSnapshot(cam);
    await readBattery(cam);
  }
}

await startMqtt();
try {
  if (await login()) {
    // Weitere Geraete melden und alle 30 s nachlesen (zusaetzlich sofort bei Ereignissen)
    if (state.extras.length) {
      log(`Weitere Geraete: ${state.extras.map((x) => `${x.name} (${x.kind})`).join(", ")}`);
      for (const x of state.extras) publishExtraDiscovery(x);
      await refreshExtras();
      setInterval(() => refreshExtras().catch(() => {}), 30_000);
    }
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
