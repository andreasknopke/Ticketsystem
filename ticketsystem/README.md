# TicketSystem

Ein leichtgewichtiges, webbasiertes Ticketsystem zur effizienten Verwaltung von Bug-Reports und Feature-Requests. Ideal fur kleine Teams, die eine einfache, aber strukturierte Losung ohne den Overhead eines komplexen Enterprise-Tools suchen.

## Features

- **Ticket-Management:** Erstellen und Verwalten von Tickets mit den Typen `Bug` und `Feature`.
- **Priorisierung und Status:** Strukturierte Verfolgung durch Status (`offen`, `in_bearbeitung`, `wartend`, `geschlossen`) und Prioritaeten (`niedrig` bis `kritisch`).
- **SLA-Tracking:** Automatische Berechnung von First-Response- und Aufloesungszeiten basierend auf Prioritaet und Dringlichkeit.
- **Activity Stream:** Vollstandige Historie aller Aktionen an einem Ticket (Statuswechsel, Kommentare, Zuweisungen).
- **Feedback-System:** Bewertungen und Kommentare zu abgeschlossenen Tickets.
- **Echtzeit-Updates:** Socket.io fur Live-Aktualisierungen von Kommentaren und Ticket-Aenderungen.
- **System-Zuordnung:** Verknupfung von Tickets mit spezifischen Software-Produkten oder Systemen (z. B. CuraFlow, Schreibdienst).
- **Mitarbeiter-Zuweisung:** Tickets konnen direkt an zustandige Mitarbeiter zugewiesen werden.
- **E-Mail-Benachrichtigungen:** Automatisierte Benachrichtigungen via SMTP bei:
    - Erstellung eines neuen Tickets.
    - Statusanderungen.
    - Zuweisung an einen Mitarbeiter.
    - Neuen Kommentaren.
- **Interne Kommunikation:** Moglichkeit, interne Notizen und Kommentare direkt am Ticket zu hinterlassen.
- **API-Unterstutzung:** REST-ahnliche API fur die automatisierte Ticket-Erstellung via API-Key.
- **Admin-Bereich:** Geschutzter Bereich fur Administratoren zur Verwaltung von Systemen und Mitarbeitern.

## Tech Stack

- **Runtime:** [Node.js](https://nodejs.org/)
- **Backend:** [Express.js](https://expressjs.com/)
- **Template Engine:** [EJS](https://ejs.co/)
- **Datenbank:** [SQLite3](https://www.sqlite.org/) (leichtgewichtig und ohne Installation)
- **E-Mail:** [Nodemailer](https://nodemailer.com/)
- **Echtzeit:** [Socket.io](https://socket.io/)
- **CSS:** [Tailwind CSS](https://tailwindcss.com/)
- **Konfiguration:** [dotenv](https://www.npmjs.com/package/dotenv)

## Installation und Setup

### 1. Voraussetzungen

Stellen Sie sicher, dass [Node.js](https://nodejs.org/) auf Ihrem System installiert ist.

### 2. Repository klonen

```bash
git clone https://github.com/andreasknopke/Ticketsystem.git
cd Ticketsystem/ticketsystem
```

### 3. Abhangigkeiten installieren

```bash
npm install
```

### 4. Konfiguration (`.env`)

Erstellen Sie eine `.env` Datei im Hauptverzeichnis (`ticketsystem/`) und konfigurieren Sie Ihre Umgebungsvariablen:

```env
PORT=8010
APP_SECRET="ein-sehr-sicherer-schluessel"
ADMIN_USER="admin"
ADMIN_PASS="dein-sicheres-passwort"
API_KEY="dein-api-key-12345"
REQUIRE_API_KEY=false
BASE_URL=http://localhost:8010

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
EMAIL_NOTIFY_COMMENT=true
```

### 5. Datenbank initialisieren (optional)

```bash
npm run seed
```

Dies befullt die Datenbank mit Testdaten (Mitarbeiter, Systeme und 20 Beispiel-Tickets).

### 6. Starten

```bash
# Produktionsmodus
npm start

# Entwicklungsmodus (mit Auto-Reload)
npm run dev
```

Das System ist nun unter `http://localhost:8010` erreichbar. Die Standard-Login-Daten sind die in der `.env` konfigurierten Werte.

## Deployment mit Coolify (Dockerfile)

Fur das Projekt ist ein Dockerfile in `ticketsystem/Dockerfile` vorbereitet.

### Coolify Einstellungen

- **Build Pack / Typ:** Dockerfile
- **Dockerfile Pfad:** `ticketsystem/Dockerfile`
- **Port:** `8010`
- **Persistent Volume (wichtig fur SQLite):**
  - Mount Path: `/app/data`

### Wichtige Umgebungsvariablen in Coolify

Mindestens diese Werte setzen:

```env
APP_SECRET=ein-sehr-sicherer-schluessel
ADMIN_USER=admin
ADMIN_PASS=dein-sicheres-passwort
PORT=8010
DB_FILE=/app/data/tickets.db
BASE_URL=https://deine-domain.tld
```

Optional (API/SMTP):

- `API_KEY`, `REQUIRE_API_KEY`
- `CORS_ALLOWED_ORIGINS` (kommagetrennt, z. B. `https://cf.coolify.kliniksued-rostock.de`)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `EMAIL_NOTIFY_NEW`, `EMAIL_NOTIFY_STATUS`, `EMAIL_NOTIFY_ASSIGN`, `EMAIL_NOTIFY_COMMENT`

Hinweis: Ohne Volume auf `/app/data` wird die SQLite-Datenbank bei Redeployments verloren.

## API Nutzung

Sie konnen Tickets uber die API erstellen, indem Sie einen `x-api-key` im Header mitsenden (falls in der `.env` konfiguriert).

**Endpoint:** `POST /api/tickets`

**Header:**
```
x-api-key: dein-api-key-12345
Content-Type: application/json
```

Wenn die API von einer anderen Domain aus dem Browser aufgerufen wird, muss diese Domain in `CORS_ALLOWED_ORIGINS` freigegeben werden, z. B.:

```env
CORS_ALLOWED_ORIGINS=https://cf.coolify.kliniksued-rostock.de
```

**Body (JSON):**
```json
{
  "type": "bug",
  "title": "Fehler beim Login",
  "description": "Der Login schlagt fehl, wenn das Passwort Sonderzeichen enthalt.",
  "system_id": 1,
  "urgency": "emergency"
}
```

## Projektstruktur

```
ticketsystem/
  templates/          # EJS Templates (Views)
  public/             # Statische Dateien (CSS, JS, Bilder)
  scripts/            # Hilfsskripte (z. B. Datenbank-Seeding)
  server.js           # Hauptanwendung und API-Logik
  tailwind.config.js  # Tailwind CSS Konfiguration
  .env                # Konfiguration (muss erstellt werden)
  package.json        # Abhangigkeiten und Scripts
```

## Lizenz

Dieses Projekt ist unter der MIT-Lizenz verfugbar.
