# Changelog

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
