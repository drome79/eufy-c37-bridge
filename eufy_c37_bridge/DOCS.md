# Eufy C37 Bridge

Holt Bilder der eufyCam C37 (T814X/T814XS) über das inoffizielle
[`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk) und stellt sie im Heimnetz als JPEG bereit.
In Home Assistant bindet man jede Kamera als **Generic Camera** mit der Bild-Adresse ein.

## Optionen

- `email`, `password`: Eufy-Konto. Empfohlen ist ein eigenes Konto, das in der Eufy-App als Gast freigegeben ist.
- `cameras`: Gerätenamen wie in der Eufy-App. Die Bridge liefert nur diese Geräte (Kameras, HomeBase,
  Türsensoren, Türklingel). Ohne Eintrag liefert sie nichts. Alle Geräte des Kontos stehen nach dem Start
  im Protokoll und auf der Statusseite.
- `full_support`: alle ausgewählten Kameras voll einbinden (MQTT-Entitäten, Schalter, Ereignisbild), nicht nur die C37.
  Für Installationen ohne `eufy-security-ws`. Andere Kameras als die C37 werden dabei nie von selbst geweckt.
- `refresh_minutes`: Alle wie viele Minuten ein frisches Live-Bild geholt wird (0 = nie, nur bei Ereignissen).
- `min_live_interval_minutes`: Mindestabstand zwischen zwei Live-Bildern pro Kamera (Akku).
- `port`: HTTP-Port (Standard 8099).
- `captcha_answer`, `verify_code`: nur nötig, wenn Eufy bei der Anmeldung ein Captcha oder einen Code verlangt.
  Das Captcha-Bild liegt dann unter `http://<HA-IP>:8099/captcha.png`.

## Adressen

- `http://<HA-IP>:8099/` — Status (JSON)
- `http://<HA-IP>:8099/snapshot/<name>.jpg` — letztes Bild, z. B. `hinterhof`, `einfahrt`, `hintertuer`
- `http://<HA-IP>:8099/refresh/<name>` — frisches Live-Bild erzwingen (weckt die Kamera)

Bei einem Bewegungsereignis übernimmt die Bridge das Ereignisbild aus dem Push, ohne die Kamera zu wecken.

## Livevideo (ab 0.3.0)

`http://<HA-IP>:8099/live/<name>.ts` liefert den Livestream als MPEG-TS (Video unverändert, ohne Ton).
In der Generic Camera als **Stream-Quelle** eintragen. Die Kamera streamt nur, solange jemand zuschaut,
und hört 20 s nach dem letzten Zuschauer auf, spätestens nach `live_max_minutes` (Standard 5, Akku).
Kameras, die H.265 senden (z. B. T814XS), werden nach H.264 umgewandelt, weil Browser H.265 per WebRTC
nicht abspielen; die Höhe dafür stellt `transcode_height` ein (Standard 1080).

## MQTT (ab 0.2.0)

Ist das Mosquitto-Add-on installiert, verbindet sich die Bridge automatisch damit und legt pro Kamera
ein Gerät „C37 <Name>“ an mit: Bewegung, Person (je 30 s an), Akku, Letztes Bild, Letztes Ereignis und
dem Knopf „Live-Bild holen“. Ohne Mosquitto läuft die Bridge weiter, nur ohne diese Entitäten.
