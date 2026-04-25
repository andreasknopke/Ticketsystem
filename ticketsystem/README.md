# 🎫 TicketSystem

Ein leichtgewichtiges, webbasiertes Ticketsystem zur effizienten Verwaltung von Bug-Reports und Feature-Requests. Ideal für kleine Teams, die eine einfache, aber strukturierte Lösung ohne den Overhead eines komplexen Enterprise-Tools suchen.

## ✨ Features

*   **Ticket-Management:** Erstellen und Verwalten von Tickets mit den Typen `Bug` und `Feature`.
*   **Priorisierung & Status:** Strukturierte Verfolgung durch Status (`offen`, `in_bearbeitung`, `wartend`, `geschlossen`) und Prioritäten (`niedrig` bis `kritisch`).
*   **System-Zuordnung:** Verknüpfung von Tickets mit spezifischen Software-Produkten oder Systemen (z. B. *CuraFlow*, *Schreibdienst*).
*   **Mitarbeiter-Zuweisung:** Tickets können direkt an zuständige Mitarbeiter zugewiesen werden.
*   **E-Mail-Benachrichtigungen:** Automatisierte Benachrichtigungen via SMTP bei:
    *   Erstellung eines neuen Tickets.
    					*   Statusänderungen.
    					*   Zuweisung an einen Mitarbeiter.
*   **Interne Kommunikation:** Möglichkeit, interne Notizen und Kommentare direkt am Ticket zu hinterlassen.
*   **API-Unterstützung:** REST-ähnliche API für die automatisierte Ticket-Erstellung via API-Key.
*   **Admin-Bereich:** Geschützter Bereich für Administratoren zur Verwaltung von Systemen und Mitarbeitern.

## 🛠️ Tech Stack

*   **Runtime:** [Node.js](https://nodejs.org/)
*   **Backend:** [Express.js](https://expressjs.com/)
*   **Template Engine:** [EJS](https://ejs.co/)
*   **Datenbank:** [SQLite3](https://www.sqlite.org/) (leichtgewichtig & ohne Installation)
*   **E-Mail:** [Nodemailer](https://nodemailer.com/)
*   **Konfiguration:** [dotenv](https://www.npmjs.com/package/dotenv)

## 🚀 Installation & Setup

### 1. Voraussetzungen
Stellen Sie sicher, dass [Node.js](https://nodejs.org/) auf Ihrem System installiert ist.

### 2. Repository klonen
```bash
git clone https://github.com/dein-nutzername/ticketsystem.git
cd ticketsystem/ticketsystem
```

### 3. Abhängigkeiten installieren
```bash
npm install
```

### 4. Konfiguration (`.env`)
Erstellen Sie eine `.env` Datei im Hauptverzeichnis (`ticketsystem/`) und konfigurieren Sie Ihre Umgebungsvariablen. Hier ein Beispiel:

```env
PORT=8010
APP_SECRET="ein-sehr-sicherer-schluessel"
ADMIN_USER="admin"
ADMIN_PASS="dein-sicheres-passwort"
API_KEY="dein-api-key-12345"
REQUIRE_API_KEY=false

# E-Mail SMTP Einstellungen
SMTP_HOST=smtp.dein-anbieter.de
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER="dein-email@beispiel.de"
SMTP_PASS="dein-app-passwort"
SMTP_FROM="Ticketsystem <dein-email@beispiel.de>"

# Benachrichtigungs-Optionen
EMAIL_NOTIFY_NEW=true
EMAIL_NOTIFY_STATUS=true
EMAIL_NOTIFY_ASSIGN=true
```

### 5. Starten
```bash
# Produktionsmodus
npm start

# Entwicklungsmodus (mit Auto-Reload)
npm run dev
```

Das System ist nun unter `http://localhost:8010` erreichbar.

## 🔌 API Nutzung

Sie können Tickets über die API erstellen, indem Sie einen `x-api-key` im Header mitsenden (falls in der `.env` konfiguriert).

**Endpoint:** `POST /api/tickets` (Beispiel)

**Header:**
`x-api-key: dein-api-key-12345`

**Body (JSON):**
```json
{
  "type": "bug",
  "title": "Fehler beim Login",
  "description": "Der Login schlägt fehl, wenn das Passwort Sonderzeichen enthält.",
  "system_id": 1,
  "urgency": "emergency"
}
```

## 📂 Projektstruktur

```
ticketsystem/
├── templates/          # EJS Templates (Views)
├── public/             # Statische Dateien (CSS, JS, Bilder)
├── server.js           # Hauptanwendung & API-Logik
├── tickets.db          # SQLite Datenbank (wird automatisch erstellt)
├── seed_db.js          # Skript zum Befüllen mit Testdaten
├── .env                # Konfiguration (muss erstellt werden)
└── package.json        # Abhängigkeiten & Scripts
```

## 📜 Lizenz

Dieses Projekt ist unter der MIT-Lizenz verwendet.
