# Home-Assistant-Add-ons

Add-on-Repository für Home Assistant OS. Enthält derzeit ein Add-on:

> **⚠️ Alpha-Status:** Die Eufy C37 Bridge wurde mit KI-Unterstützung „vibe gecoded“ und befindet sich daher noch in der
> **Alpha-Phase**. Sie läuft im eigenen Haushalt, ist aber weder umfassend getestet noch geprüft. Fehler, Abstürze und
> Änderungen ohne Vorwarnung sind möglich – Nutzung auf eigenes Risiko, nicht für sicherheitskritische Zwecke verlassen.

| Add-on | Version | Zweck |
|---|---|---|
| [Eufy C37 Bridge](eufy_c37_bridge/) | 0.13.4 | Bindet die **eufyCam C37** (T814X / T814XS) in Home Assistant ein: Bilder, Livevideo, Bewegung, Akku |

## Voraussetzungen

**Erforderlich**

| Was | Details |
|---|---|
| Home Assistant **OS** oder **Supervised** | Add-ons gibt es nur dort. Mit Home Assistant Container oder Core funktioniert das Add-on nicht. |
| Architektur `amd64` oder `aarch64` | z. B. Mini-PC/NUC oder Raspberry Pi 4/5 mit 64-Bit-HAOS |
| Eufy-Konto mit mindestens einer **eufyCam C37** (T814X / T814XS) | Die Kamera muss in der Eufy-App eingerichtet sein. Empfohlen: ein eigenes Konto nur für Home Assistant, in der Eufy-App als Gast freigegeben. |
| Internetzugang des Home-Assistant-Servers | für die Anmeldung bei Eufy und für den Bau des Add-ons (lädt Node.js-Pakete und das Basis-Image) |
| Kameras im selben Netz erreichbar | Livebilder kommen per P2P (UDP); das Add-on läuft deshalb im Host-Netzwerk |

**Wird automatisch mitinstalliert** – nichts davon muss von Hand eingerichtet werden:

| Komponente | Version | Zweck |
|---|---|---|
| [`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk) | 0.5.0 (fest) | Anmeldung bei Eufy, Geräte, Bilder, Livevideo |
| [`mqtt`](https://www.npmjs.com/package/mqtt) | ^5.16 | Verbindung zum MQTT-Broker |
| Node.js | 24 (Basis-Image `node:24-bookworm-slim`) | Laufzeit, das SDK braucht ≥ 24.5 |
| ffmpeg | aus Debian bookworm | Livevideo als MPEG-TS, Umwandlung H.265 → H.264 |

Das Add-on wird beim Installieren auf dem eigenen Server gebaut. Das dauert einige Minuten und braucht
rund 1 GB freien Speicher.

**Optional**

| Was | Wofür |
|---|---|
| Add-on **Mosquitto broker** + Integration **MQTT** | Sensoren und Knöpfe pro Kamera (Bewegung, Person, Akku, „Live-Bild holen“). Ohne MQTT gibt es nur Bilder und Livevideo. |
| Integration **Generic Camera** (in Home Assistant enthalten) | Um die Kameras als `camera.*`-Entitäten mit Bild und Livevideo anzuzeigen |

**Nicht nötig:** das Add-on `eufy-security-ws` und die HACS-Integration „Eufy Security“. Die Bridge arbeitet
unabhängig davon und kann parallel dazu laufen.

## Installation

1. In Home Assistant: **Einstellungen → Add-ons → Add-on-Store**.
2. Oben rechts im Menü (⋮) **Repositories** wählen und diese Adresse eintragen:
   ```
   https://github.com/drome79/eufy-c37-bridge
   ```
   Wer das Repository noch unter der alten Adresse `https://github.com/drome79/ha-addons` eingetragen hat,
   lässt sie einfach stehen: GitHub leitet sie weiter, Updates kommen weiterhin an. Bitte die Adresse in
   Home Assistant **nicht** austauschen, sonst gilt das Add-on als neu und muss neu eingerichtet werden.
3. Im Store erscheint **Eufy C37 Bridge**. Installieren, in der **Konfiguration** E-Mail und Passwort des Eufy-Kontos eintragen, speichern, starten.
4. **Geräte auswählen:** Am Add-on **„Benutzeroberfläche öffnen“** (oder **Eufy Bridge** in der Seitenleiste). Dort stehen alle
   Geräte des Eufy-Kontos mit Typ und Modell zum Anhaken. **Speichern und neu starten** trägt sie unter `cameras` ein.

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
- **Livevideo für andere Eufy-Kameras** (z. B. Türklingel T8213): Trägt man ihren Namen unter `cameras` ein, liefert
  die Bridge für sie **nur** das Livevideo – keine MQTT-Entitäten, kein regelmäßiges Wecken. So kann die Kamera
  ansonsten weiter über `eufy-security-ws` laufen. Als Standbild hält die Bridge das letzte Ereignisbild (z. B. Klingeln)
  und ein Bild aus dem letzten Livestream vor. Kann die Kamera schwenken (z. B. Innenkamera T8410), bekommt sie
  die Knöpfe „Schwenken links/rechts/hoch/runter“ (Gerät „Eufy <Name>“).
- **Weitere Eufy-Geräte** (wenn ihr Name unter `cameras` eingetragen ist), per MQTT:
  HomeBase als **Alarmpanel** (Zuhause, Abwesend, Bypass = Custom 1, Deaktiviert), **Türsensoren** (offen/zu, Akku schwach) und die
  **Türklingel** (Klingeln, Ereignisbild) und das **Keypad** (lädt, Signal). Eine Sirene wird bewusst nicht angeboten.
- **Alle Kameras voll einbinden** (Option `full_support`, ab 0.11.0): Jede ausgewählte Kamera bekommt die MQTT-Entitäten
  der C37, dazu – sofern die Kamera es laut SDK kann – die Schalter **Kamera eingeschaltet**, **Bewegungserkennung** und
  **Licht**, das **Ereignisbild**, **WLAN-Signal**, bei Akku-Kameras **Akku** und **Lädt**, sowie **Haustier**, **Geräusch**,
  **Weinen** und **Fahrzeug**, sobald die Kamera so ein Ereignis zum ersten Mal meldet. Damit kann die Bridge
  `eufy-security-ws` ersetzen. Ohne die Option bleibt es bei „nur Livevideo“ für alle Kameras außer der C37.
- **Schwenken (PTZ)** wird automatisch freigeschaltet, sobald das SDK es für die Kamera meldet
  (für die C37 ist das derzeit nicht der Fall).
- **Schneller Livestart im Ernstfall** (Option `prewarm_seconds`, ab 0.12.0): Meldet eine Kamera eine **Person** oder
  klingelt es, startet die Bridge den Livestream sofort und hält ihn 45 Sekunden bereit. Wer die Push-Nachricht antippt,
  sieht das Livebild ohne die übliche Aufwachzeit der Kamera (sonst etwa 4–6 Sekunden).

### Unterstützte Eufy-Geräte

Welche Funktionen ein Gerät bekommt, richtet sich nach den Fähigkeiten, die das `eufy-sdk` für das Gerät meldet.
Bisher im echten Betrieb gesehen:

| Gerät | Modell | Was die Bridge liefert | Stand |
|---|---|---|---|
| eufyCam C37 | T814X, T814XS | Standbild, Livevideo (H.265 → H.264), Bewegung, Person, Akku, Lädt, WLAN-Signal, Ereignisbild, Schalter Kamera/Bewegungserkennung/Licht, „Live-Bild holen“ | getestet |
| Video Doorbell (Akku) | T8213 | Livevideo, Klingeln, Ereignisbild; mit `full_support` zusätzlich Bewegung, Person, Akku, Schalter | Livevideo und Klingeln getestet |
| Indoor Cam Pan & Tilt | T8410 | Livevideo, Schwenken links/rechts/hoch/runter; mit `full_support` zusätzlich Bewegung, Person, Schalter | getestet (am Netzteil und an der HomeBase) |
| HomeBase 3 | T8030 | Alarmpanel Zuhause / Abwesend / Bypass (Custom 1) / Deaktiviert, Sensor „Modus (Eufy)“ | getestet |
| Türsensor (Entry Sensor) | T8900 | Tür offen/zu, Akku schwach (Eufy-Warnung) | getestet |
| Keypad | T8960 | Lädt, Funksignal | getestet |
| weitere Akku-Kameras | T8140-Z, T8142-R | als Kamera erkannt, Livevideo; mit `full_support` Sensoren und Schalter | erkannt, Funktionen noch nicht bestätigt |

**Andere Eufy-Geräte** werden ebenfalls angezeigt, sobald das SDK sie kennt: Jede Kamera bekommt mindestens das Livevideo,
Stationen mit Alarmmodus ein Alarmpanel, Kontaktsensoren offen/zu, Klingeln das Klingel-Signal. Bewusst **nicht** angeboten
werden Sirenen. Schlösser, Paketboxen (SmartDrop), Staubsauger und andere Gerätearten unterstützt die Bridge nicht.

### Optionen

| Option | Standard | Bedeutung |
|---|---|---|
| `email`, `password` | – | Eufy-Konto. Empfohlen: ein eigenes Konto, in der Eufy-App als Gast freigegeben. |
| `country` | `DE` | Land des Eufy-Kontos |
| `full_support` | `false` | **Alle** ausgewählten Kameras voll einbinden (MQTT-Entitäten wie bei der C37, siehe unten) statt nur Livevideo. Für Installationen ohne `eufy-security-ws`. Andere Kameras als die C37 werden dabei trotzdem nie von selbst geweckt. |
| `cameras` | leer | **Gerätenamen wie in der Eufy-App.** Die Bridge liefert nur, was hier steht: Kameras ebenso wie HomeBase, Türsensoren und Türklingel. Ohne Eintrag liefert sie nichts. Am einfachsten über die Auswahlseite („Benutzeroberfläche öffnen“) anhaken statt abtippen. Ein Name gilt für alle Geräte gleichen Namens. |
| `refresh_minutes` | `30` | Alle wie viele Minuten ein frisches Bild geholt wird (`0` = nie) |
| `min_live_interval_minutes` | `10` | Mindestabstand zwischen zwei frischen Bildern pro Kamera (Akku) |
| `live_max_minutes` | `5` | Längster Livestream am Stück (Akku) |
| `prewarm_seconds` | `45` | Bei Person oder Klingeln den Livestream so viele Sekunden vorstarten, damit er beim Öffnen sofort läuft (`0` = aus). Kostet pro Ereignis etwas Akku. |
| `transcode_height` | `1080` | Bildhöhe, wenn H.265 nach H.264 umgewandelt wird |
| `port` | `8099` | HTTP-Port der Bridge |
| `captcha_answer`, `verify_code` | – | Nur nötig, wenn Eufy bei der Anmeldung ein Captcha oder einen Code verlangt |

### Adressen

Der Kameraname wird klein geschrieben, Umlaute werden ersetzt (`Hintertür` → `hintertuer`). Welche Namen
gelten, zeigen die Statusseite und das Protokoll des Add-ons nach dem Start.

| Adresse | Inhalt |
|---|---|
| `http://<HA-IP>:8099/` | Status als JSON (Anmeldung, MQTT, alle Geräte im Konto mit Modell, je Kamera Bildalter, Akku, Livestream, Fähigkeiten) |
| `http://<HA-IP>:8099/snapshot/<name>.jpg` | letztes Bild |
| `http://<HA-IP>:8099/refresh/<name>` | frisches Bild erzwingen (weckt die Kamera) |
| `http://<HA-IP>:8099/live/<name>.ts` | Livevideo (MPEG-TS) |
| `http://<HA-IP>:8099/diag/<name>` | Diagnose: Ablauf des letzten Livestream-Starts (erste Bilder mit Codec, Schlüsselbild, NAL-Typen; ffmpeg-Start und erste Ausgabe) |
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
