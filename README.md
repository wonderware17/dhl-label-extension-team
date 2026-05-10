# DHL Label Creator — Chrome Extension

DHL Versandlabels für eBay-Sendungen direkt im Browser erstellen — ohne lokalen Server.

Identisches Layout wie das Flask-Tool (Sektionen, gelbe Top-Bar, rote Schaltflächen),
aber als Manifest-V3-Extension. API-Calls laufen im Service-Worker (kein CORS-Stress),
der Verlauf wird in `chrome.storage.local` gespeichert.

## Installation

1. Chrome öffnen → `chrome://extensions/`
2. Oben rechts **Entwicklermodus** aktivieren
3. **Entpackte Erweiterung laden** klicken
4. Diesen Ordner (`extension/`) auswählen
5. Beim ersten Start öffnet sich automatisch die Einstellungs-Seite

## Konfiguration (Optionen-Seite)

Erforderlich:

- **API-Key** — aus dem [DHL Developer Portal](https://developer.dhl.com)
- **Benutzername / Passwort** — aus dem DHL Geschäftskundenportal (GKP)
- **Abrechnungsnummern** — 14-stellig, je eine für DHL Paket (V01PAK)
  und DHL Kleinpaket (V62KP)
- **Mindestens ein Absender** im Adressbuch

Optional:

- **Sandbox-Modus** — schaltet auf `api-sandbox.dhl.com` um (keine echten Labels)

## Bedienung

1. Auf das Extension-Icon klicken (Popup öffnet sich)
2. Sendungsreferenz eingeben (z.B. eBay-Bestellnr., 8–35 Zeichen)
3. Absender aus Dropdown wählen
4. eBay-Adresse in das gelbe Feld einfügen → **⚡ Erkennen**
   (oder Felder manuell ausfüllen)
5. Gewicht in kg eingeben
6. Produkt wählen (Paket bis 31,5 kg / Kleinpaket bis 1 kg)
7. **Sendung beauftragen** → PDF wird automatisch generiert und in den Verlauf
   gespeichert

## Verlauf

Der Verlauf-Button (oben rechts im Popup) zeigt alle bisher erstellten Labels.
Jeder Eintrag enthält Empfänger, Adresse, Produkt, Gewicht und Sendungsnummer
und kann jederzeit als PDF erneut heruntergeladen oder gelöscht werden.

## Dateien

| Datei                | Zweck                                           |
|----------------------|-------------------------------------------------|
| `manifest.json`      | Manifest V3                                     |
| `popup.html/.js`     | Hauptformular (Versandauftrag erstellen)        |
| `options.html/.js`   | Einstellungen (Credentials, Absender)           |
| `background.js`      | Service-Worker — DHL API, History               |
| `address_parser.js`  | JS-Port des Python-Adressparsers                |
| `icons/`             | Extension-Icons (16/48/128 px)                  |
| `generate_icons.py`  | Re-generiert die Icons (nur bei Bedarf)         |

## Speicherorte

- **Einstellungen** & **Verlauf** liegen in `chrome.storage.local` der Extension.
- PDFs werden Base64-codiert pro Sendungsnummer abgelegt.
- Beim Deinstallieren der Extension werden alle Daten gelöscht.

## Sicherheitshinweis

Passwort und API-Key liegen unverschlüsselt in `chrome.storage.local`.
Das ist für eine lokale Single-User-Installation OK — gib die Extension
nicht weiter, ohne deine Credentials vorher in den Optionen zu entfernen.
