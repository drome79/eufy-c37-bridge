# Home-Assistant-Add-ons

Add-on-Repository für Home Assistant OS. Enthält derzeit ein Add-on:

| Add-on | Version | Zweck |
|---|---|---|
| [Eufy C37 Bridge](eufy_c37_bridge/) | 0.4.1 | Bindet die **eufyCam C37** (T814X / T814XS) in Home Assistant ein: Bilder, Livevideo, Bewegung, Akku |

## Installation

1. In Home Assistant: **Einstellungen → Add-ons → Add-on-Store**.
2. Oben rechts im Menü (⋮) **Repositories** wählen und diese Adresse eintragen:
   ```
   https://github.com/drome79/ha-addons
   ```
3. Im Store erscheint **Eufy C37 Bridge**. Installieren, in der **Konfiguration** E-Mail und Passwort des Eufy-Kontos eintragen, speichern, starten.

---

## Eufy C37 Bridge

Die eufyCam C37 wird von der bisherigen Eufy-Einbindung (`eufy-security-ws` / `eufy-security-client`) nicht unterstützt –
dort taucht sie nur als „unbekanntes Gerät“ auf. Diese Bridge nutzt stattdessen das neuere, inoffizielle
[`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk), das die C37 als Kamera erkennt, und stellt sie
Home Assistant über einfache HTTP-Adressen und MQTT bereit.

### Funktionen

- **Standbilder** pro Kamera als JPEG, gepuffert, damit die Akku-Kameras nicht bei jedem Abruf aufwachen.
- **Ereignisbilder**: Bei Bewegung wird das Bild aus der Eufy-Push-Nachricht übernommen, ohne die Kamera zu wecken.
- **Livevideo auf Abruf** als MPEG-TS. Die Kamera streamt nur, solange jemand zuschaut.
  H.265-Kameras (z. B. T814XS) werden nach H.264 umgewandelt, damit sie im Browser (WebRTC) laufen.
- **MQTT-Entitäten** (automatisch per Discovery, wenn das Mosquitto-Add-on installiert ist):
  Bewegung, Person, Akku, Zeitpunkt des letzten Bildes, letztes Ereignis, Knopf „Live-Bild holen“.
- **Schwenken (PTZ)** wird automatisch freigeschaltet, sobald das SDK es für die Kamera meldet
  (für die C37 ist das derzeit nicht der Fall).

### Optionen

| Option | Standard | Bedeutung |
|---|---|---|
| `email`, `password` | – | Eufy-Konto. Empfohlen: ein eigenes Konto, in der Eufy-App als Gast freigegeben. |
| `country` | `DE` | Land des Eufy-Kontos |
| `cameras` | Einfahrt, Hintertür, Hinterhof | Gerätenamen wie in der Eufy-App |
| `refresh_minutes` | `30` | Alle wie viele Minuten ein frisches Bild geholt wird (`0` = nie) |
| `min_live_interval_minutes` | `10` | Mindestabstand zwischen zwei frischen Bildern pro Kamera (Akku) |
| `live_max_minutes` | `5` | Längster Livestream am Stück (Akku) |
| `transcode_height` | `1080` | Bildhöhe, wenn H.265 nach H.264 umgewandelt wird |
| `port` | `8099` | HTTP-Port der Bridge |
| `captcha_answer`, `verify_code` | – | Nur nötig, wenn Eufy bei der Anmeldung ein Captcha oder einen Code verlangt |

### Adressen

Der Kameraname wird klein geschrieben, Umlaute werden ersetzt (`Hintertür` → `hintertuer`).

| Adresse | Inhalt |
|---|---|
| `http://<HA-IP>:8099/` | Status als JSON (Anmeldung, MQTT, je Kamera Bildalter, Akku, Livestream, Fähigkeiten) |
| `http://<HA-IP>:8099/snapshot/<name>.jpg` | letztes Bild |
| `http://<HA-IP>:8099/refresh/<name>` | frisches Bild erzwingen (weckt die Kamera) |
| `http://<HA-IP>:8099/live/<name>.ts` | Livevideo (MPEG-TS) |
| `http://<HA-IP>:8099/captcha.png` | Captcha-Bild, falls Eufy eines verlangt |

### Kamera in Home Assistant einrichten

Pro Kamera eine **Generic Camera** anlegen (Einstellungen → Geräte & Dienste → Integration hinzufügen → „Generic Camera“):

- **Standbild-URL:** `http://<HA-IP>:8099/snapshot/<name>.jpg`
- **Stream-Quelle:** `http://<HA-IP>:8099/live/<name>.ts`
- Unter „Erweitert“: SSL-Prüfung aus, **Zeitstempel der Wanduhr verwenden** an.

Im Dashboard empfiehlt sich in der Übersicht die Bildanzeige (`camera_view: auto`) und erst in einer Detail- oder
Vollbildansicht `camera_view: live` – sonst streamen beim Öffnen des Dashboards alle Kameras gleichzeitig.

### Hinweise und Grenzen

- Das `eufy-sdk` ist **inoffiziell** und noch jung. Änderungen bei Eufy oder im SDK können die Bridge jederzeit brechen.
- Zwei Anmeldungen mit demselben Konto über das SDK lösen sich gegenseitig ab („token … was kicked out“).
  Die Bridge daher nicht parallel auf einem anderen Rechner mit demselben Konto testen.
- Häufige oder fehlerhafte Anmeldungen können bei Eufy ein Captcha oder eine kurze Sperre auslösen.
- Jedes frische Bild und jeder Livestream weckt die Akku-Kamera und kostet Akku.
- Die Zugangsdaten liegen ausschließlich in den Add-on-Optionen in Home Assistant, nicht in diesem Repository.

### Technik

- Architekturen: `amd64` (getestet) und `aarch64`, z. B. Raspberry Pi 4/5 mit 64-Bit-HAOS (nicht auf echter Hardware getestet)
- Basis-Image `node:24-bookworm-slim` mit `ffmpeg`, Node.js ≥ 24.5. Auf schwächeren Geräten kann die
  H.265→H.264-Umwandlung beim Livevideo knapp werden; dann `transcode_height` auf `720` senken.
- Netzwerk im Host-Modus (die P2P-Verbindung zu den Kameras braucht UDP im Heimnetz)
- MQTT-Zugang über den Supervisor-Dienst (`services: mqtt:want`), kein eigenes MQTT-Passwort nötig

## Danksagung

Die eigentliche Arbeit mit den Eufy-Geräten leistet [`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk)
(Apache-2.0). Dieses Projekt steht in keiner Verbindung zu Anker oder Eufy.
