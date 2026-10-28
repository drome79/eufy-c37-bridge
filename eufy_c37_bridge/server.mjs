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
// Gemerkter Codec (0.12.4–0.13.1) entfaellt: Die Tuerklingel startet in Wahrheit mit einem guten H.265-Strom und schaltet
// bei Videoqualitaet "Niedrig" (oder "Auto") in der Eufy-App nach ~2 s auf H.264 mit kleiner Aufloesung um. Auf H.264 zu warten kostete Zeit und Bildqualitaet.
try { fs.unlinkSync(path.join(DATA, "codecs.json")); } catch {}
// Tuersensoren (T8900) melden keinen Akkustand in Prozent, nur Eufys Warnung "Akku schwach"/"Akku voll" per Push.
// Den letzten Stand ueber Neustarts hinweg merken.
const BATTERY_LOW_FILE = path.join(DATA, "battery_low.json");
const batteryLow = (() => { try { return JSON.parse(fs.readFileSync(BATTERY_LOW_FILE, "utf8")); } catch { return {}; } })();
function rememberBatteryLow(slug, low) {
  if (batteryLow[slug] === low) return;
  batteryLow[slug] = low;
  try { fs.writeFileSync(BATTERY_LOW_FILE, JSON.stringify(batteryLow)); } catch {}
}
const CODEC_SWITCH_MS = 5_000; // so lange nach dem Start darf ein Schluesselbild mit anderem Codec noch umstellen
const BASE = "eufy_c37";
// Ab 0.11.0: alle Eufy-Kameras voll einbinden (MQTT-Entitaeten wie bei der C37), statt nur Livevideo.
// Standard aus, damit Installationen, die daneben eufy-security-ws nutzen, keine doppelten Entitaeten bekommen.
const FULL_SUPPORT = Boolean(opts.full_support);
const STATE_POLL_MS = 60_000;
// Ab 0.12.0: bei Person und Klingeln den Livestream sofort vorstarten und so lange bereithalten,
// damit er beim Antippen der Push-Nachricht schon laeuft (die Kamera ist dann ohnehin wach). 0 = aus.
const PREWARM_S = Number(opts.prewarm_seconds ?? 45); // Schalter, Akku, Signal der Kameras nachlesen (gepufferte Werte, weckt nicht)

const log = (...a) => console.log(new Date().toISOString(), ...a);

// "Hintertür" -> "hintertuer"
const slugify = (s) =>
  s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: keine Antwort nach ${ms / 1000} s`)), ms))]);

const state = { login: "pending", loginInfo: "", mqtt: "aus", mode: "", cameras: {}, accountDevices: [], removed: [], extras: [], removedExtras: [] };

// C37-Familie (eufyCam C37 = T814X / T814XS). Nicht nur "T814" pruefen: T8140-Z und
// T8142-R sind andere Akku-Kameras und wuerden sonst als C37 regelmaessig geweckt.
const C37_MODEL = /^T814X/i;

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
    caps: [], ptz: false, c37: false, values: {}, eventKinds: new Set(),
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

// Entitaets-IDs: c37_<name>_... wie bisher fuer die C37, eufy_<name>_... fuer alle anderen Kameras
const objectPrefix = (cam) => (cam.c37 ? "c37" : "eufy");

function publishDiscovery(cam) {
  const dev = deviceInfo(cam);
  const common = { availability_topic: `${BASE}/status`, device: dev };
  const cfg = (component, key, body) =>
    pub(`homeassistant/${component}/${BASE}_${cam.slug}_${key}/config`,
      JSON.stringify({ ...common, unique_id: `${BASE}_${cam.slug}_${key}`, object_id: `${objectPrefix(cam)}_${cam.slug}_${key}`, ...body }));
  const t = `${BASE}/${cam.slug}`;
  const has = (c) => cam.caps.includes(c);
  cfg("binary_sensor", "motion", { name: "Bewegung", device_class: "motion", state_topic: `${t}/motion`, off_delay: 30 });
  cfg("binary_sensor", "person", { name: "Person", device_class: "occupancy", state_topic: `${t}/person`, off_delay: 30 });
  // Akku nur bei Akku-Kameras; Kameras mit Netzteil (Innenkameras) melden keinen
  if (has("battery")) {
    cfg("sensor", "battery", { name: "Akku", device_class: "battery", unit_of_measurement: "%", state_class: "measurement", state_topic: `${t}/battery`, entity_category: "diagnostic" });
    cfg("binary_sensor", "charging", { name: "Lädt", device_class: "battery_charging", state_topic: `${t}/charging`, entity_category: "diagnostic" });
  } else {
    pub(`homeassistant/sensor/${BASE}_${cam.slug}_battery/config`, "");
    pub(`homeassistant/binary_sensor/${BASE}_${cam.slug}_charging/config`, "");
  }
  cfg("sensor", "image_ts", { name: "Letztes Bild", device_class: "timestamp", state_topic: `${t}/image_ts` });
  cfg("sensor", "last_event", { name: "Letztes Ereignis", state_topic: `${t}/last_event`, icon: "mdi:motion-sensor" });
  // Tuerklingeln haben ihr Ereignisbild schon am Klingel-Geraet (weitere Geraete) – hier nicht doppelt anlegen
  if (has("doorbell")) pub(`homeassistant/image/${BASE}_${cam.slug}_event_image/config`, "");
  else cfg("image", "event_image", { name: "Ereignisbild", image_topic: `${t}/event_image`, content_type: "image/jpeg" });
  cfg("sensor", "rssi", { name: "WLAN-Signal", state_topic: `${t}/rssi`, state_class: "measurement", icon: "mdi:wifi", entity_category: "diagnostic" });
  cfg("button", "refresh", { name: "Live-Bild holen", command_topic: `${t}/refresh`, icon: "mdi:camera-retake" });
  // Schalter: was die Kamera laut SDK kann. Zustand kommt aus readCameraState, Befehle ueber <slug>/set/<key>
  for (const [key, sw] of Object.entries(CAMERA_SWITCHES)) {
    const topic = `homeassistant/switch/${BASE}_${cam.slug}_${key}/config`;
    if (!sw.available(cam)) { pub(topic, ""); continue; }
    cfg("switch", key, { name: sw.name, icon: sw.icon, state_topic: `${t}/${key}`, command_topic: `${t}/set/${key}`,
      entity_category: sw.config ? "config" : undefined });
  }
  for (const kind of cam.eventKinds) publishEventSensor(cam, kind);
  if (cam.ts) pub(`${t}/image_ts`, new Date(cam.ts).toISOString());
  if (cam.battery != null) pub(`${t}/battery`, cam.battery);
  cam.values = {}; // nach (Neu-)Verbindung alle Zustaende erneut melden
}

// Weitere Ereignisse (Haustier, Geraeusch, Weinen, Fahrzeug) bekommen erst einen Sensor, wenn die Kamera
// so ein Ereignis tatsaechlich einmal meldet – nicht jede Kamera kann alles erkennen.
const EVENT_SENSORS = {
  petDetection: { key: "pet", name: "Haustier", icon: "mdi:paw" },
  soundDetected: { key: "sound", name: "Geräusch", device_class: "sound" },
  cryingDetected: { key: "crying", name: "Weinen", device_class: "sound", icon: "mdi:emoticon-cry-outline" },
  vehicleDetected: { key: "vehicle", name: "Fahrzeug", icon: "mdi:car" },
};
function publishEventSensor(cam, eventName) {
  const s = EVENT_SENSORS[eventName];
  if (!s) return;
  const key = s.key;
  pub(`homeassistant/binary_sensor/${BASE}_${cam.slug}_${key}/config`, JSON.stringify({
    availability_topic: `${BASE}/status`, device: deviceInfo(cam), unique_id: `${BASE}_${cam.slug}_${key}`,
    object_id: `${objectPrefix(cam)}_${cam.slug}_${key}`, name: s.name, device_class: s.device_class, icon: s.icon,
    state_topic: `${BASE}/${cam.slug}/${key}`, off_delay: 30,
  }));
}

// Schalter je Kamera: Lesen ueber den gepufferten SDK-Wert, Schreiben ueber den SDK-Setter.
// Licht: "isOn" ist der momentane Zustand der Lampe (geht beim Livestream auch von selbst an).
const CAMERA_SWITCHES = {
  enabled: {
    name: "Kamera eingeschaltet", icon: "mdi:cctv", config: true,
    available: (cam) => cam.caps.includes("camera"),
    read: async (dev) => readVal(dev.camera?.(), "enabled"),
    write: async (dev, on) => { const c = dev.camera?.(); await (on ? c.on() : c.off()); },
  },
  motion_detection: {
    name: "Bewegungserkennung", icon: "mdi:motion-sensor", config: true,
    available: (cam) => cam.caps.includes("motion"),
    read: async (dev) => readVal(dev.motion?.(), "detectionEnabled"),
    write: async (dev, on) => dev.motion?.().setDetection(on),
  },
  light: {
    name: "Licht", icon: "mdi:spotlight-beam",
    available: (cam) => cam.caps.includes("light"),
    read: async (dev) => readVal(dev.light?.(), "isOn"),
    write: async (dev, on) => { const l = dev.light?.(); await (on ? l.on() : l.off()); },
  },
};

async function setCameraSwitch(cam, key, payload) {
  const sw = CAMERA_SWITCHES[key];
  if (!sw || !sw.available(cam)) throw new Error(`unbekannter Schalter ${key}`);
  const on = String(payload).toUpperCase() === "ON";
  const dev = await eufy.getDevice(cam.sn);
  log(`${cam.name}: ${sw.name} ${on ? "an" : "aus"}`);
  await withTimeout(sw.write(dev, on), 30_000, sw.name);
  setTimeout(() => readCameraState(cam).catch(() => {}), 3_000);
}

// Gepufferte Werte einer Kamera lesen und nur Aenderungen melden (weckt die Kamera nicht)
async function readCameraState(cam) {
  if (!cam.sn || cam.liveOnly) return;
  const dev = await eufy.getDevice(cam.sn);
  const t = `${BASE}/${cam.slug}`;
  const report = (key, v) => { if (v !== undefined && v !== null && cam.values[key] !== v) { cam.values[key] = v; pub(`${t}/${key}`, v); } };
  if (cam.caps.includes("battery")) {
    const b = dev.battery?.();
    const level = await readVal(b, "level").catch(() => undefined);
    if (typeof level === "number" && Number.isFinite(level)) { cam.battery = level; report("battery", level); }
    const charging = await readVal(b, "charging").catch(() => undefined);
    if (typeof charging === "boolean") report("charging", charging ? "ON" : "OFF");
  }
  const rssi = await readVal(dev.camera?.(), "wifiRssi").catch(() => undefined);
  if (typeof rssi === "number") report("rssi", rssi);
  for (const [key, sw] of Object.entries(CAMERA_SWITCHES)) {
    if (!sw.available(cam)) continue;
    const v = await sw.read(dev).catch(() => undefined);
    if (typeof v === "boolean") report(key, v ? "ON" : "OFF");
  }
}

// Entitaeten einer Kamera, die es im Konto nicht gibt, wieder aus Home Assistant entfernen
// (leere, gespeicherte Discovery-Nachricht loescht die Entitaet)
function unpublishDiscovery(slug) {
  const keys = [["binary_sensor", "motion"], ["binary_sensor", "person"], ["sensor", "battery"], ["sensor", "image_ts"],
    ["sensor", "last_event"], ["button", "refresh"], ["button", "ptz_left"], ["button", "ptz_right"], ["button", "ptz_up"], ["button", "ptz_down"],
    ["binary_sensor", "charging"], ["image", "event_image"], ["sensor", "rssi"],
    ...Object.keys(CAMERA_SWITCHES).map((k) => ["switch", k]),
    ...Object.values(EVENT_SENSORS).map((s) => ["binary_sensor", s.key])];
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
    mq.subscribe(`${BASE}/+/set/+`);
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
    const sm = topic.match(new RegExp(`^${BASE}/([a-z0-9_]+)/set/([a-z_]+)$`));
    if (sm) {
      const cam = state.cameras[sm[1]];
      if (cam?.sn && !cam.liveOnly) setCameraSwitch(cam, sm[2], payload).catch((e) => log(`${cam.name}: Schalten fehlgeschlagen: ${String(e?.message ?? e).slice(0, 160)}`));
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
  // Ereignisbild zusaetzlich als MQTT-Bild (Entitaet "Ereignisbild"), z. B. fuer Push-Nachrichten mit Bild
  if (!cam.liveOnly && !cam.caps.includes("doorbell") && source.startsWith("event") && mq?.connected) mq.publish(`${BASE}/${cam.slug}/event_image`, jpeg, { retain: true });
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
    // Weitere Geraete: HomeBase (Alarmmodus), Tuersensoren (offen/zu), Tuerklingel (Klingeln), Keypad – nur wenn ausgewaehlt
    const kinds = [];
    if (caps.includes("arming") && !hasCam) kinds.push("station");
    if (caps.includes("contact")) kinds.push("contact");
    if (caps.includes("doorbell")) kinds.push("doorbell");
    if (caps.includes("keypad")) kinds.push("keypad");
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
  cam.c37 = C37_MODEL.test(rec.model ?? "");
  // Andere Eufy-Kameras (z. B. Tuerklingel) laufen meist schon ueber eufy-security-ws. Fuer sie liefert die Bridge
  // ohne full_support nur das Livevideo: keine MQTT-Entitaeten, kein regelmaessiges Wecken, keine Ereignisbilder.
  // Mit full_support bekommen sie dieselben Entitaeten wie die C37, werden aber ebenfalls nie von selbst geweckt.
  cam.liveOnly = !cam.c37 && !FULL_SUPPORT;
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
  const stats = s.stats && Object.keys(s.stats).length > 1 ? `, Bilder je Codec: ${JSON.stringify(s.stats)}` : "";
  log(`${cam.name}: Livestream beendet (${reason})${stats}`);
}

// --- Diagnose: Mitschnitt der ersten Bilder jedes Livestreams ---------------------------------------
// Je Kamera wird der letzte Start festgehalten: Zeitpunkt, Codec-Angabe, Schluesselbild-Flag, Groesse und NAL-Typen
// der ersten DIAG_FRAMES Bilder, ffmpeg-Start, erste ffmpeg-Ausgabe und ffmpeg-Meldungen. Abruf: /diag/<name>
// (JSON) und /diag/<name>.<h264|h265> (die rohen Bilder dieses Codecs). Nur im Speicher, wird beim naechsten Start ersetzt.
const DIAG_FRAMES = 120;
function nalTypes(buf, codec) {
  const types = [];
  for (let i = 0; i + 4 < buf.length && types.length < 12; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      const h = buf[i + 2] === 1 ? i + 3 : i + 4;
      types.push(codec === "h265" ? (buf[h] >> 1) & 0x3f : buf[h] & 0x1f);
      i = h;
    }
  }
  return types;
}
function diagFrame(s, frame) {
  const d = s.diag;
  if (!d || d.frames.length >= DIAG_FRAMES) return;
  d.frames.push({ ms: Date.now() - d.t0, codec: frame.codec, keyframe: frame.keyframe, bytes: frame.data.length,
    width: frame.width, height: frame.height, nal: nalTypes(frame.data, frame.codec), nal_als_h264: nalTypes(frame.data, "h264"),
    an_ffmpeg: Boolean(s.ff) && frame.codec === s.codec });
  (d.raw[frame.codec] ??= []).push(frame.data);
}

function startFfmpeg(cam, s, codec) {
  // H.264 wird unveraendert durchgereicht. H.265 (z. B. T814XS) koennen Browser per WebRTC nicht abspielen,
  // deshalb wird es nach H.264 umgewandelt (verkleinert auf transcode_height, Standard 1080).
  const video = codec === "h264"
    ? ["-c:v", "copy"]
    : ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
       "-vf", `scale=-2:${Number(opts.transcode_height || 1080)}`, "-g", "30", "-bf", "0"];
  const args = [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "+genpts+nobuffer", "-use_wallclock_as_timestamps", "1",
    // Kurz analysieren: Groesse und Codec stehen im ersten Schluesselbild. Mit den Standardwerten wartete ffmpeg
    // bei niedriger Datenrate (Tuerklingel nachts ~120 kbit/s) gut 4 s, bevor es etwas ausgab.
    "-probesize", "32768", "-analyzeduration", "0",
    "-f", codec === "h265" ? "hevc" : "h264", "-i", "pipe:0",
    ...video, "-an",
    // Jedes Paket sofort ausgeben: sonst sammelt ffmpeg ~32 KB, das dauerte bei der Tuerklingel nachts 3–5 s
    "-flush_packets", "1", "-muxdelay", "0",
    "-f", "mpegts", "-mpegts_flags", "+resend_headers", "pipe:1",
  ];
  const ff = spawn(opts.ffmpeg_path || "ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  ff.stdin.on("error", () => {});
  if (s.diag) s.diag.ffmpeg.push({ ms: Date.now() - s.diag.t0, codec });
  ff.stdout.on("data", (chunk) => {
    if (s.diag && s.diag.ersteAusgabeMs == null) s.diag.ersteAusgabeMs = Date.now() - s.diag.t0;
    for (const res of s.clients) res.write(chunk);
  });
  ff.stderr.on("data", (d) => {
    const msg = String(d).trim().slice(0, 300);
    if (s.diag && s.diag.meldungen.length < 40) s.diag.meldungen.push({ ms: Date.now() - s.diag.t0, msg });
    if (/error/i.test(msg)) log(`${cam.name} [ffmpeg] ${msg.slice(0, 200)}`);
  });
  ff.on("exit", () => { if (cam.live === s) stopLive(cam, "ffmpeg beendet"); });
  s.ff = ff;
  s.codec = codec;
}

async function ensureLive(cam) {
  if (cam.live) return cam.live;
  const s = { clients: new Set(), consumer: null, ff: null, codec: null, idleTimer: null, maxTimer: null, startedAt: Date.now() };
  s.diag = { t0: s.startedAt, start: new Date(s.startedAt).toISOString(), frames: [], raw: {}, ffmpeg: [], ersteAusgabeMs: null, meldungen: [] };
  cam.diag = s.diag;
  cam.live = s;
  try {
    const dev = await eufy.getDevice(cam.sn);
    const liveFn = dev.camera?.()?.live;
    if (typeof liveFn !== "function") throw new Error("Livevideo wird nicht angeboten");
    // Akku-Kameras bekommen ein Strom-Budget, Kameras mit Netzteil (z. B. Innenkameras) streamen unbegrenzt
    const consumer = await liveFn({ powered: cam.caps.includes("battery") ? "battery" : "wired" });
    s.consumer = consumer;
    // Erst ab dem ersten Schluesselbild (IDR) starten: Laut SDK stimmt die Codec-Angabe erst ab einem Keyframe.
    // Die Tuerklingel (T8213) liefert zwei Codecs: zuerst ein H.265-Schluesselbild, ~0,5 s spaeter H.264-Schluesselbilder.
    // Kommt in den ersten CODEC_SWITCH_MS ein Schluesselbild mit anderem Codec, wird einmalig umgestellt; danach
    // gehen nur noch Bilder dieses Codecs an ffmpeg. Die Zaehlung je Codec steht beim Stoppen im Protokoll.
    let skipped = 0;
    s.stats = {};
    const firstFrame = new Promise((resolve, reject) => {
      consumer.on("video", (frame) => {
        if (cam.live !== s) return;
        diagFrame(s, frame);
        const st = (s.stats[frame.codec] ??= { bilder: 0, schluesselbilder: 0 });
        st.bilder++;
        if (frame.keyframe) st.schluesselbilder++;
        if (!s.ff) {
          // Sicherheitsnetz: meldet eine Kamera nie ein Schluesselbild, nach ~4 s trotzdem starten
          if (!frame.keyframe && skipped < 60) { skipped++; return; }
          startFfmpeg(cam, s, frame.codec);
          s.ffStartedAt = Date.now();
          if (skipped) log(`${cam.name}: ${skipped} Bilder vor dem ersten Schluesselbild verworfen`);
          try { s.ff.stdin.write(frame.data); } catch {}
          resolve();
          return;
        }
        if (frame.codec !== s.codec) {
          if (frame.keyframe && !s.codecSwitched && Date.now() - s.ffStartedAt < CODEC_SWITCH_MS) {
            s.codecSwitched = true;
            log(`${cam.name}: Schluesselbild mit ${frame.codec} – stelle von ${s.codec} um (Videoqualitaet in der Eufy-App "Niedrig"/"Auto"?)`);
            const old = s.ff;
            old.removeAllListeners("exit");
            try { old.stdin.end(); old.kill("SIGKILL"); } catch {}
            startFfmpeg(cam, s, frame.codec);
            try { s.ff.stdin.write(frame.data); } catch {}
          }
          return; // Bilder des anderen Codecs nicht an ffmpeg geben
        }
        try { s.ff.stdin.write(frame.data); } catch {}
      });
      consumer.on("error", (e) => { reject(e); if (cam.live === s) stopLive(cam, `Fehler: ${String(e?.message ?? e).slice(0, 120)}`); });
      consumer.on("stop", () => { if (cam.live === s) stopLive(cam, "Kamera hat gestoppt"); });
    });
    consumer.on("budget", (notice) => {
      // Akku-Budget: verlaengern, solange jemand zuschaut (oder vorgestartet ist) und die Hoechstdauer nicht erreicht ist
      const wanted = s.clients.size > 0 || Date.now() < (s.prewarmUntil ?? 0);
      if (wanted && Date.now() - s.startedAt < LIVE_MAX_MIN * 60_000) notice.extend();
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

// Livestream ohne Zuschauer vorstarten (Person, Klingeln). Kommt bis PREWARM_S niemand, wird er gestoppt;
// schaut jemand zu, gelten die normalen Regeln (Stopp 20 s nach dem letzten Zuschauer).
async function prewarmLive(cam, reason) {
  if (!PREWARM_S || !cam.sn) return;
  const until = Date.now() + PREWARM_S * 1000;
  if (cam.live) cam.live.prewarmUntil = Math.max(cam.live.prewarmUntil ?? 0, until);
  else log(`${cam.name}: Livestream vorgestartet (${reason})`);
  let s;
  try { s = await ensureLive(cam); } catch { return; }
  s.prewarmUntil = Math.max(s.prewarmUntil ?? 0, until);
  if (s.clients.size === 0) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (cam.live === s && s.clients.size === 0) stopLive(cam, "vorgestartet, niemand hat zugeschaut");
    }, Math.max(0, s.prewarmUntil - Date.now()));
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

// --- Weitere Geraete: HomeBase, Tuersensoren, Tuerklingel, Keypad-------------------------------
// Alarmpanel fuer Stationen mit "arming", Kontakt-Sensoren fuer "contact", Klingel-Sensor + Ereignisbild fuer "doorbell",
// Laden + Signal fuer "keypad" (das SDK liefert dort nur diese Lesewerte).
// Die Sirene wird bewusst NICHT angeboten.

// Eufy-Guard-Modus: Wire-Wert -> Name
const ARMING_WIRE = { 0: "away", 1: "home", 2: "schedule", 3: "custom1", 4: "custom2", 5: "custom3", 6: "off", 47: "geofence", 63: "disarmed" };
// Name -> Zustand des HA-Alarmpanels
const ARMING_HA = { home: "armed_home", away: "armed_away", disarmed: "disarmed", off: "disarmed",
  schedule: "armed_custom_bypass", custom1: "armed_custom_bypass", custom2: "armed_custom_bypass", custom3: "armed_custom_bypass", geofence: "armed_custom_bypass" };
// "Bypass" im HA-Alarmpanel schaltet auf den Eufy-Modus Custom 1
const ARMING_CMD = { ARM_HOME: "home", ARM_AWAY: "away", ARM_CUSTOM_BYPASS: "custom1", DISARM: "disarmed" };

// Entitaeten eines nicht (mehr) ausgewaehlten weiteren Geraets aus Home Assistant entfernen
function unpublishExtra(slug) {
  const keys = [["alarm_control_panel", "alarm"], ["sensor", "mode"], ["binary_sensor", "contact"], ["sensor", "battery"],
    ["binary_sensor", "battery_low"], ["binary_sensor", "ring"], ["image", "event_image"], ["binary_sensor", "charging"], ["sensor", "rssi"]];
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
      payload_arm_home: "ARM_HOME", payload_arm_away: "ARM_AWAY", payload_arm_custom_bypass: "ARM_CUSTOM_BYPASS", payload_disarm: "DISARM",
      code_arm_required: false, code_disarm_required: false, supported_features: ["arm_home", "arm_away", "arm_custom_bypass"] });
    cfg("sensor", "mode", { name: "Modus (Eufy)", state_topic: `${t}/mode`, icon: "mdi:shield-home", entity_category: "diagnostic" });
  }
  if (x.kind === "contact") {
    cfg("binary_sensor", "contact", { name: "Tür", device_class: "door", state_topic: `${t}/contact` });
    // Kein Akku in Prozent: der Wert (param 1101) bedeutet beim T8900 nichts (zeigte 31 bzw. 0 bei vollem Akku)
    pub(`homeassistant/sensor/${BASE}_${x.slug}_battery/config`, "");
    cfg("binary_sensor", "battery_low", { name: "Akku schwach", device_class: "battery", state_topic: `${t}/battery_low`, entity_category: "diagnostic" });
    pub(`${t}/battery_low`, batteryLow[x.slug] ? "ON" : "OFF");
  }
  if (x.kind === "doorbell") {
    cfg("binary_sensor", "ring", { name: "Klingeln", icon: "mdi:doorbell", state_topic: `${t}/ring`, off_delay: 30 });
    cfg("image", "event_image", { name: "Ereignisbild", image_topic: `${t}/event_image`, content_type: "image/jpeg" });
  }
  if (x.kind === "keypad") {
    cfg("binary_sensor", "charging", { name: "Lädt", device_class: "battery_charging", state_topic: `${t}/charging`, entity_category: "diagnostic" });
    cfg("sensor", "rssi", { name: "Signal", device_class: "signal_strength", unit_of_measurement: "dBm", state_class: "measurement", state_topic: `${t}/rssi`, entity_category: "diagnostic" });
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
    }
    if (x.kind === "keypad") {
      const kp = dev.keypad?.();
      const charging = await readVal(kp, "charging");
      if (typeof charging === "boolean" && charging !== x.values.charging) { x.values.charging = charging; pub(`${t}/charging`, charging ? "ON" : "OFF"); }
      const rssi = await readVal(kp, "rssi");
      if (typeof rssi === "number" && rssi !== x.values.rssi) { x.values.rssi = rssi; pub(`${t}/rssi`, rssi); }
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
  // Eufys Akku-Warnung (Push): "low" = schwach, "full" = wieder voll
  if (x.kind === "contact" && e.eventName === "batteryAlert" && (e.state === "low" || e.state === "full")) {
    const low = e.state === "low";
    rememberBatteryLow(x.slug, low);
    pub(`${BASE}/${x.slug}/battery_low`, low ? "ON" : "OFF");
    log(`${x.name}: Akku ${low ? "schwach" : "voll"} (Eufy-Meldung)`);
  }
  if (x.kind === "doorbell" && e.eventName === "doorbellPress") {
    pub(`${BASE}/${x.slug}/ring`, "ON", false);
    const bellCam = Object.values(state.cameras).find((c) => c.sn === x.sn);
    if (bellCam) prewarmLive(bellCam, "Klingeln");
    try {
      const dev = await eufy.getDevice(x.sn);
      const cam = dev.camera?.();
      let buf = null;
      // 1) Push-Bild von Eufy: kommt oft erst einige Sekunden nach dem Klingeln (bis ~20 s abwarten)
      if (typeof cam?.snapshotStored === "function") {
        for (let i = 0; i < 8 && !buf; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          try { const b = await cam.snapshotStored(); if (b?.length) buf = b; } catch {}
        }
      }
      // 2) Kein Push-Bild: die Klingel ist nach dem Klingeln ohnehin wach -> frisches Bild holen
      if (!buf && typeof cam?.snapshotLive === "function") {
        try { const r = await withTimeout(cam.snapshotLive(), 45_000, "Klingelbild"); buf = r?.jpeg ?? null; }
        catch (err) { log(`${x.name}: Klingelbild nicht verfuegbar (${String(err?.message ?? err).slice(0, 120)})`); }
      }
      if (buf?.length) {
        if (mq?.connected) mq.publish(`${BASE}/${x.slug}/event_image`, buf, { retain: true });
        const camEntry = Object.values(state.cameras).find((c) => c.sn === x.sn);
        if (camEntry) store(camEntry, buf, "event:doorbellPress");
        log(`${x.name}: Klingelbild weitergegeben (${buf.length} Bytes)`);
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
  if (PERSON_EVENTS.has(e.eventName)) prewarmLive(cam, "Person");
  // Nur-Live-Kameras: keine MQTT-Meldungen (das macht eufy-security-ws), aber das Ereignisbild als Standbild behalten
  if (!cam.liveOnly) {
    pub(`${BASE}/${cam.slug}/last_event`, e.eventName);
    if (e.eventName === "motion" || PERSON_EVENTS.has(e.eventName)) pub(`${BASE}/${cam.slug}/motion`, "ON", false);
    if (PERSON_EVENTS.has(e.eventName)) pub(`${BASE}/${cam.slug}/person`, "ON", false);
    const extra = EVENT_SENSORS[e.eventName];
    if (extra) {
      const fire = () => pub(`${BASE}/${cam.slug}/${extra.key}`, "ON", false);
      // Erstes Ereignis dieser Art: Sensor erst anlegen, Home Assistant kurz Zeit geben, ihn zu abonnieren
      if (!cam.eventKinds.has(e.eventName)) { cam.eventKinds.add(e.eventName); publishEventSensor(cam, e.eventName); setTimeout(fire, 2_000); }
      else fire();
    }
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

// --- Geraeteauswahl (Ingress-Seite) -------------------------------------------------------------
// Zeigt alle Geraete des Eufy-Kontos zum Anhaken und schreibt die Auswahl ueber die Supervisor-API
// in die Option "cameras"; danach startet das Add-on neu.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function deviceKind(d) {
  const caps = d.capabilities || [];
  if (d.c37) return "Kamera (C37)";
  if (caps.includes("doorbell")) return "Türklingel";
  if (d.camera) return "Kamera";
  if (caps.includes("contact")) return "Türsensor";
  if (caps.includes("keypad")) return "Keypad";
  if (caps.includes("arming")) return "HomeBase / Station";
  return "Sonstiges (wird nicht eingebunden)";
}

function selectionPage() {
  const byName = new Map();
  for (const d of state.accountDevices) {
    const e = byName.get(d.name) ?? { name: d.name, kinds: [], models: [], selected: false };
    e.kinds.push(deviceKind(d)); e.models.push(d.model); e.selected ||= d.selected;
    byName.set(d.name, e);
  }
  const rows = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "de")).map((e) =>
    `<label class="row"><input type="checkbox" name="cam" value="${esc(e.name)}"${e.selected ? " checked" : ""}>` +
    `<span class="name">${esc(e.name)}</span><span class="kind">${esc([...new Set(e.kinds)].join(" + "))} · ${esc(e.models.join(", "))}</span></label>`).join("");
  const body = state.accountDevices.length ? `<form id="f">${rows}<button type="submit">Speichern und neu starten</button><p id="msg"></p></form>`
    : `<p>Noch keine Geräte bekannt (Anmeldung: ${esc(state.login)} ${esc(state.loginInfo)}). Bitte später neu laden.</p>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eufy Bridge – Geräte</title><style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#212121;--muted:#727272;--card:#fff;--line:#e0e0e0;--accent:#03a9f4}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#e1e1e1;--muted:#9b9b9b;--card:#1c1c1c;--line:#333}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
main{max-width:640px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p.hint{color:var(--muted);margin:0 0 16px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:12px;background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:8px;cursor:pointer}
.row input{width:20px;height:20px}.name{font-weight:600}.kind{color:var(--muted);font-size:14px;flex-basis:100%;padding-left:32px}
button{margin-top:8px;padding:10px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button:disabled{opacity:.6}#msg{min-height:1.4em}
</style></head><body><main><h1>Eufy-Geräte auswählen</h1>
<p class="hint">Alle Geräte aus deinem Eufy-Konto. Angehakte Geräte liefert die Bridge an Home Assistant. Ein Name gilt für alle Geräte gleichen Namens.</p>
${body}</main><script>
const f=document.getElementById("f");
if(f)f.addEventListener("submit",async(ev)=>{ev.preventDefault();const b=f.querySelector("button"),m=document.getElementById("msg");
b.disabled=true;m.textContent="Speichere …";
try{const r=await fetch("auswahl",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cameras:[...f.querySelectorAll("input[name=cam]:checked")].map(i=>i.value)})});
const t=await r.text();if(!r.ok)throw new Error(t);m.textContent="Gespeichert. Die Bridge startet neu – Seite in etwa einer Minute neu laden.";}
catch(e){m.textContent="Fehler: "+e.message;b.disabled=false;}});
</script></body></html>`;
}

async function supervisor(method, endpoint, body) {
  const r = await fetch(`http://supervisor${endpoint}`, {
    method, headers: { authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Supervisor ${endpoint}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function saveSelection(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const names = JSON.parse(raw || "{}").cameras;
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) { res.writeHead(400); return res.end("ungueltige Auswahl"); }
  // aktuelle Optionen frisch lesen, nur "cameras" ersetzen
  const current = JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8").replace(/^﻿/, ""));
  await supervisor("POST", "/addons/self/options", { options: { ...current, cameras: names } });
  log(`Geraeteauswahl gespeichert: ${names.join(", ") || "(leer)"} – starte neu`);
  res.writeHead(200); res.end("ok");
  setTimeout(() => supervisor("POST", "/addons/self/restart").catch((e) => log(`Neustart fehlgeschlagen: ${e.message}`)), 1000);
}

// --- HTTP-Schnittstelle fuer Home Assistant ----------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  // Ingress (Home-Assistant-Oberflaeche) kommt immer vom Supervisor 172.30.32.2
  const fromIngress = String(req.socket.remoteAddress ?? "").endsWith("172.30.32.2");
  if (fromIngress && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(selectionPage());
  }
  if (url.pathname === "/auswahl" && req.method === "POST") {
    if (!fromIngress) { res.writeHead(403); return res.end("nur ueber die Home-Assistant-Oberflaeche"); }
    try { return await saveSelection(req, res); }
    catch (e) { res.writeHead(500); return res.end(String(e?.message ?? e)); }
  }
  const dm = url.pathname.match(/^\/diag\/([a-z0-9_]+)(?:\.(h264|h265))?$/);
  if (dm) {
    const d = state.cameras[dm[1]]?.diag;
    if (!d) { res.writeHead(404); return res.end("noch kein Livestream seit dem Start der Bridge"); }
    if (dm[2]) { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(Buffer.concat(d.raw[dm[2]] ?? [])); }
    const { raw, t0, ...rest } = d;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ...rest, roh_bytes: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.reduce((n, b) => n + b.length, 0)])) }, null, 1));
  }
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
    // Nur die C37 wird fuer Standbilder von selbst geweckt; alle anderen Kameras nur auf ausdruecklichen Abruf
    const stale = cam.c37 && (!cam.jpeg || (REFRESH_MIN > 0 && Date.now() - cam.ts > REFRESH_MIN * 60_000));
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
    if (!cam.sn || !cam.c37) continue;
    await liveSnapshot(cam);
    await readBattery(cam);
  }
}

// Zustaende (Akku, Signal, Schalter) aller voll eingebundenen Kameras; liest nur gepufferte Werte
async function readAllCameraStates() {
  for (const cam of Object.values(state.cameras)) {
    try { await readCameraState(cam); }
    catch (e) { log(`${cam.name}: Zustand nicht lesbar (${String(e?.message ?? e).slice(0, 120)})`); }
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
    await readAllCameraStates();
    setInterval(() => readAllCameraStates().catch(() => {}), STATE_POLL_MS);
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
