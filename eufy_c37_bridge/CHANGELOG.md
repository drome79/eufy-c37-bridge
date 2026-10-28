# Changelog

## 0.13.3
- **Behoben:** Türsensoren (T8900) zeigten einen falschen Akkustand (31 % bzw. 0 % bei vollem Akku). Der Sensor meldet
  keinen Prozentwert; das SDK liest dort param 1101, der beim T8900 nichts bedeutet. Statt „Akku“ (%) gibt es jetzt
  **„Akku schwach“** (an/aus): an bei Eufys Warnung „Akku schwach“, aus bei „Akku voll“ (Push `batteryAlert`).
  Der letzte Stand bleibt über Neustarts erhalten (`/data/battery_low.json`). Der alte Prozent-Sensor wird entfernt.

## 0.13.2
- **Türklingel startet wieder mit H.265 in voller Auflösung.** Der Diagnose-Mitschnitt zeigte: Die Klingel liefert zuerst einen
  einwandfreien H.265-Strom (1600×2300) und schaltet bei Videoqualität „Niedrig“ (oder „Auto“) nach ~2 s auf H.264 mit kleiner
  Auflösung um.
  Der gemerkte Codec aus 0.12.4 ließ die Bridge auf das kleine H.264 warten – das kostete Zeit und Bildqualität. Er entfällt.
  **Empfehlung:** In der Eufy-App die Videoqualität der Klingel auf „Hoch“ stellen.
- Bleibt „Niedrig“ oder „Auto“ eingestellt, stellt die Bridge wie bisher beim Wechsel einmalig um (jetzt bis 5 s nach dem Start).

## 0.13.1
- **Diagnose für langsame Livestarts:** `/diag/<name>` zeigt den Ablauf des letzten Livestream-Starts einer Kamera (die ersten
  120 Bilder mit Zeitpunkt, Codec, Schlüsselbild, Größe und NAL-Typen, ffmpeg-Start, erste Ausgabe, ffmpeg-Warnungen);
  `/diag/<name>.h264` bzw. `.h265` liefert die rohen Bilder. Nur im Speicher.
- ffmpeg meldet jetzt auch Warnungen (nur in der Diagnose; ins Protokoll kommen weiterhin nur Fehler).

## 0.13.0
- **Neu:** Das Alarmpanel der HomeBase kann auch **Bypass**. Bypass schaltet auf den Eufy-Modus **Custom 1**
  (das SDK bestätigt diesen Modus für `setMode`). Angezeigt wurden Custom 1–3, Zeitplan und Geofencing schon vorher als Bypass.

## 0.12.5
- **Schnellerer Livestart bei niedriger Datenrate:** ffmpeg gibt jedes Paket sofort aus (`-flush_packets 1 -muxdelay 0`).
  Vorher sammelte es ~32 KB, bevor das erste Bild herauskam – bei der Türklingel nachts (~15 KB/s) 3–5 s.

## 0.12.4
- **Schnellerer Livestart, vor allem der Türklingel:** ffmpeg analysiert den Eingang nur noch kurz (`-probesize 32768
  -analyzeduration 0`). Bei niedriger Datenrate wartete ffmpeg vorher gut 4 s, bevor es das erste Bild ausgab.
- Kameras, die beim Start zwei Codecs liefern (Türklingel), merken sich den eigentlichen Codec (`/data/codecs.json`) und
  starten beim nächsten Mal gleich damit, ohne Umschalten.

## 0.12.3
- **Behoben:** Kein Livebild von der Türklingel (T8213), dritter Anlauf. Die Klingel liefert zwei Codecs: ein H.265-Schlüsselbild
  zu Beginn und ~0,5 s später H.264-Schlüsselbilder. Kommt in den ersten 3 s ein Schlüsselbild mit anderem Codec, stellt die
  Bridge einmalig darauf um und gibt danach nur noch Bilder dieses Codecs an ffmpeg. Andere Kameras starten unverändert schnell.
- Liefert eine Kamera mehrere Codecs, steht beim Stoppen eine Zählung (Bilder/Schlüsselbilder je Codec) im Protokoll.

## 0.12.2
- **Behoben (richtig):** Kein Livebild von der Türklingel. 0.12.1 reichte nicht: Die Bilder vor dem ersten Schlüsselbild
  meldet das SDK mit einem geratenen Codec (bei der T8213 H.265, tatsächlich H.264). Die Bridge startet ffmpeg jetzt erst mit
  dem ersten Schlüsselbild und dessen Codec; die Bilder davor (ohnehin nicht dekodierbar) werden verworfen.

## 0.12.1
- **Behoben:** Kein Livebild von der Türklingel (T8213). Das SDK meldet ihr erstes Bild als H.265, alle folgenden als H.264;
  die Bridge legte die Umwandlung nach dem ersten Bild fest, ffmpeg bekam dann H.264 als H.265 und lieferte kein Video.
  Jetzt entscheidet die Mehrheit der ersten fünf Bilder (~0,3 s). Das Protokoll wird nicht mehr mit „Codec-Wechsel“ geflutet.

## 0.12.0
- **Schneller Livestart im Ernstfall:** Bei **Person** oder **Klingeln** startet die Bridge den Livestream sofort und hält ihn
  `prewarm_seconds` (Standard 45) bereit. Wer die Push-Nachricht antippt, muss nicht mehr 4–6 Sekunden aufs Aufwachen der
  Kamera warten. Schaut niemand zu, stoppt der Stream danach wieder. `0` schaltet das ab.
- README: Liste der unterstützten Eufy-Geräte.

## 0.11.1
- **Behoben (`full_support`):** Die Türklingel bekam zwei „Ereignisbild“-Entitäten (am Kamera- und am Klingel-Gerät).
  Das Ereignisbild gibt es jetzt nur noch am Klingel-Gerät.

## 0.11.0
- **Neue Option `full_support`** (Standard aus): bindet **alle** ausgewählten Eufy-Kameras voll ein, nicht nur die C37.
  Sie bekommen dieselben MQTT-Entitäten wie die C37 statt nur Livevideo. Gedacht für Installationen ohne `eufy-security-ws`;
  wer beides parallel nutzt, lässt die Option aus und behält das bisherige Verhalten.
- Neue Entitäten je voll eingebundener Kamera (auch C37), jeweils nur wenn die Kamera es laut SDK kann:
  - Schalter **Kamera eingeschaltet**, **Bewegungserkennung** und **Licht** (Kameras mit Scheinwerfer)
  - **Ereignisbild** (Bild aus der Eufy-Push-Nachricht als `image`-Entität)
  - **WLAN-Signal**, bei Akku-Kameras zusätzlich **Lädt**
  - **Haustier**, **Geräusch**, **Weinen**, **Fahrzeug**: werden angelegt, sobald die Kamera so ein Ereignis zum ersten Mal meldet
- Akku-Sensor nur noch bei Kameras mit Akku (Innenkameras mit Netzteil bekommen keinen leeren Akku-Sensor mehr).
- Schalter, Akku und Signal werden jede Minute aus den gepufferten Werten nachgelesen; das weckt keine Kamera.
- Von selbst geweckt (`refresh_minutes`) wird weiterhin nur die C37. Alle anderen Kameras liefern Bilder aus Ereignissen
  und Livestreams oder auf ausdrücklichen Abruf („Live-Bild holen“, `/refresh/<name>`).

## 0.10.1
- **Behoben:** Andere Akku-Kameras, deren Modell mit „T814“ beginnt (z. B. T8140-Z, T8142-R), wurden fälschlich als C37
  erkannt. Sie bekamen MQTT-Entitäten und wurden alle `refresh_minutes` für ein frisches Bild geweckt (Akku, Fehlermeldungen
  „live stream failed to start“). Als C37 gelten jetzt nur noch T814X und T814XS.

## 0.10.0
- **Geräteauswahl zum Anhaken:** „Benutzeroberfläche öffnen“ (oder „Eufy Bridge“ in der Seitenleiste) zeigt alle Geräte
  des Eufy-Kontos mit Typ und Modell. Speichern schreibt die Auswahl in `cameras` und startet die Bridge neu –
  Namen muss man nicht mehr abtippen. Das Feld `cameras` in der Konfiguration funktioniert weiterhin.

## 0.9.0
- Keypad (z. B. T8960): Sensoren „Lädt“ und „Signal“, wenn sein Name unter `cameras` eingetragen ist.
  Mehr liefert das SDK für das Keypad nicht; Moduswechsel am Keypad zeigt das Alarmpanel der HomeBase.

## 0.8.1
- Klingelbild: wartet bis ~20 s auf das Push-Bild von Eufy und holt sonst ein frisches Bild von der (ohnehin wachen) Klingel.
  Das Bild landet im „Ereignisbild“ und als Standbild der Kamera.

## 0.8.0
- **Geändert:** Die Bridge liefert nur noch Geräte, deren Name unter `cameras` eingetragen ist – Kameras ebenso wie
  HomeBase, Türsensoren und Türklingel. Die automatische Erkennung entfällt; ohne Eintrag liefert die Bridge nichts.
  Ein Name gilt für alle Geräte gleichen Namens (z. B. Kamera und Türsensor „Hintertür“).
- Nicht (mehr) ausgewählte Geräte werden aus Home Assistant entfernt.
- Die Option `extra_devices` entfällt (wird ignoriert).

## 0.7.0
- Weitere Eufy-Geräte per MQTT (Option `extra_devices`, Standard an):
  - HomeBase und andere Stationen ohne Kamera: Alarmpanel „Alarmmodus“ (Zuhause, Abwesend, Deaktiviert) und Sensor „Modus (Eufy)“.
  - Türsensoren: „Tür“ (offen/zu) und Akku.
  - Türklingel: „Klingeln“ und „Ereignisbild“.
- Zustände werden alle 30 s und bei Ereignissen nachgelesen. Eine Sirene wird bewusst nicht angeboten.

## 0.6.1
- Statusseite zeigt die Fähigkeiten aller Geräte im Eufy-Konto (z. B. HomeBase, Türsensoren), nicht nur der eingebundenen Kameras.

## 0.6.0
- Schwenk-Knöpfe (links/rechts/hoch/runter) auch für Kameras im Modus „nur Livevideo“, z. B. Innenkamera T8410.
- Kameras mit Netzteil streamen ohne Akku-Budget.
- Gerätename je Modell: „C37 <Name>“ für die C37, „Eufy <Name>“ für andere Eufy-Kameras.

## 0.5.2
- Standbild für Kameras im Modus „nur Livevideo“: letztes Ereignisbild aus dem Push und ein Bild aus jedem Livestream.

## 0.5.1
- Andere Eufy-Kameras (z. B. Türklingel) lassen sich als „nur Livevideo“ einbinden: keine MQTT-Entitäten, kein regelmäßiges Wecken.

## 0.5.0
- C37 werden automatisch erkannt, wenn keine oder unbekannte Kameranamen eingetragen sind.
- Statusseite und Protokoll listen alle Geräte des Eufy-Kontos.

## 0.4.1
- Architektur aarch64 freigegeben.

## 0.4.0
- Fähigkeiten je Kamera auf der Statusseite; Schwenken per HTTP und MQTT, sobald das SDK es meldet.

## 0.3.1
- H.265 wird nach H.264 umgewandelt, damit das Livebild im Browser (WebRTC) läuft.
- Der Livestream antwortet sofort, während die Kamera aufwacht.

## 0.3.0
- Livevideo auf Abruf als MPEG-TS (`/live/<name>.ts`).

## 0.2.0
- MQTT-Entitäten per Discovery: Bewegung, Person, Akku, letztes Bild, letztes Ereignis, Knopf „Live-Bild holen“.

## 0.1.0
- Erste Version: gepufferte Standbilder der C37 als JPEG für Generic Cameras.
