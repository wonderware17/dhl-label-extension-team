# DHL Label Creator (Team)

Chrome-/Edge-Browser-Erweiterung zum Erstellen von DHL-Versand- und Retouren-Labels — mit deinem eigenen DHL-Geschäftskunden-Account, ohne lokales Backend.

## 📥 Download für Kollegen

**Aktuelle Version herunterladen:**

1. Oben rechts auf den grünen **`<> Code`**-Button klicken
2. **`Download ZIP`** wählen
3. ZIP irgendwo entpacken (z. B. `C:\Tools\dhl-extension-team\`) — **NICHT** im Downloads-Ordner lassen, sonst funktioniert die Extension später nicht mehr.

## 📖 Anleitungen

Zwei PDFs liegen im Repo — wähle was du brauchst:

⚡ **[`DHL-Label-Extension-Quickstart.pdf`](./DHL-Label-Extension-Quickstart.pdf)** — 1-Seiter, 5 Schritte, in ~15 min startklar

📚 **[`DHL-Label-Extension-Setup-Anleitung.pdf`](./DHL-Label-Extension-Setup-Anleitung.pdf)** — ausführliche Anleitung mit allen Details (DHL Developer Portal Setup, Discord-Webhook erstellen, häufige Probleme & Lösungen, Datenschutz)

Darin enthalten:
- Installation in Chrome/Edge (Entwicklermodus, Entpackte Erweiterung laden)
- Erste Einrichtung mit eigenen DHL-Zugangsdaten
- DHL Developer Portal: API-Key besorgen
- Optional: Discord-Webhook konfigurieren
- Bedienung im Alltag (Versand + Retoure)
- Updates einspielen
- Häufige Probleme + Lösungen

## 🔄 Updates

Diese Repository wird regelmäßig auf den aktuellen Stand gebracht. Wenn eine neue Version verfügbar ist:

1. Erneut die ZIP von hier herunterladen
2. Inhalt in deinen bestehenden Extension-Ordner kopieren und alle Dateien überschreiben
3. In `chrome://extensions` neben **DHL Label Creator (Team)** auf das **⟳-Symbol** klicken (Reload)

Deine Settings (API-Keys, Absender, Webhook) bleiben dabei erhalten — sie liegen separat im Browser, nicht in den Programmdateien.

## 🔒 Datenschutz

Alle deine Zugangsdaten und Webhook-URLs werden ausschließlich lokal in deinem Browser gespeichert (LocalStorage / `chrome.storage.local`). Sie verlassen niemals deinen Rechner und werden nicht an den Maintainer oder Dritte übertragen. Die einzigen Server, mit denen die Extension spricht, sind die offiziellen DHL-API-Server (`api-eu.dhl.com`) und — falls konfiguriert — deine eigenen Discord-Webhooks.

## 📁 Dateien

| Datei | Zweck |
|---|---|
| `manifest.json` | Chrome Manifest V3 |
| `popup.html` / `popup.js` | Side-Panel-UI (Versand + Retoure) |
| `options.html` / `options.js` | Settings (Credentials, Absender, Empfänger) |
| `background.js` | Service-Worker — DHL-API, Discord, History |
| `print.html` / `print.js` | Druck-Dialog |
| `address_parser.js` | Adress-Erkennung aus Copy-Paste |
| `lib/pdf-lib.min.js` | PDF-Manipulation |
| `icons/` | Extension-Icons (16, 48, 128 px) |

## ⚠️ Hinweis zur Versionierung

Diese **Team-Version** unterscheidet sich von der internen Maintainer-Version durch:
- **Kein hardcoded Discord-Webhook** — Empfänger werden via Settings konfiguriert
- **Kein Native Messaging / lokales Backend** — alles läuft direkt aus der Browser-Extension
- **Keine Auto-Start-Logik** für lokale Flask-App

Die Extension funktioniert komplett standalone — kein Python, kein Server-Setup nötig.
