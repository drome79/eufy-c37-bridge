// Eufy C37 Bridge: holt Bilder der eufyCam C37 ueber @mega-yfue/eufy-sdk und stellt sie
// Home Assistant als JPEG-Adressen bereit (/snapshot/<name>.jpg). Bilder werden gepuffert,
// damit die Akku-Kameras nicht bei jedem Abruf geweckt werden.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { EufyMega, FileSessionStore } from "@mega-yfue/eufy-sdk";

const DATA = process.env.DATA_DIR || "/data";
const OPTIONS_PATH = process.env.OPTIONS_PATH || path.join(DATA, "options.json");
const opts = JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8").replace(/^﻿/, ""));

const PORT = Number(opts.port || 8099);
const REFRESH_MIN = Number(opts.refresh_minutes ?? 30);
const MIN_LIVE_MIN = Number(opts.min_live_interval_minutes ?? 10);
const LIVE_TIMEOUT_MS = 75_000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// "Hintertür" -> "hintertuer"
const slugify = (s) =>
  s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: keine Antwort nach ${ms / 1000} s`)), ms))]);

const state = { login: "pending", loginInfo: "", cameras: {} };

// Kameras laut Optionen; Bilder ueber Neustarts hinweg in DATA behalten
for (const name of opts.cameras || []) {
  const slug = slugify(name);
  const file = path.join(DATA, `snapshot_${slug}.jpg`);
  state.cameras[slug] = {
    name, slug, sn: null, file,
    jpeg: fs.existsSync(file) ? fs.readFileSync(file) : null,
    ts: fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0,
    source: fs.existsSync(file) ? "cache" : null,
    lastLiveTry: 0, busy: null, lastError: null, lastEvent: null,
  };
}

function store(cam, jpeg, source) {
  cam.jpeg = jpeg;
  cam.ts = Date.now();
  cam.source = source;
  cam.lastError = null;
  try { fs.writeFileSync(cam.file, jpeg); } catch (e) { log("Bild nicht gespeichert:", e.message); }
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

// Ereignisse (Bewegung, Person ...): das Ereignisbild aus dem Push uebernehmen, ohne die Kamera zu wecken
eufy.on("event", async (e) => {
  const cam = Object.values(state.cameras).find((c) => c.sn && c.sn === e?.deviceSn);
  if (!cam) return;
  cam.lastEvent = { name: e.eventName, at: new Date().toISOString() };
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

// HTTP-Schnittstelle fuer Home Assistant
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
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
    login: state.login, info: state.loginInfo,
    cameras: Object.values(state.cameras).map((c) => ({
      name: c.name, url: `/snapshot/${c.slug}.jpg`, connected: Boolean(c.sn),
      image_age_s: c.jpeg ? Math.round((Date.now() - c.ts) / 1000) : null, source: c.source,
      busy: Boolean(c.busy), last_error: c.lastError, last_event: c.lastEvent,
    })),
  }, null, 2));
});
server.listen(PORT, () => log(`HTTP auf Port ${PORT}`));

// Regelmaessige Aktualisierung, nacheinander, damit nicht alle Kameras gleichzeitig wach sind
async function refreshAll() {
  for (const cam of Object.values(state.cameras)) {
    if (cam.sn) await liveSnapshot(cam);
  }
}

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

const stop = async () => { try { await eufy.disconnect?.(); } catch {} process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
