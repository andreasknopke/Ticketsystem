# TicketSystem

Ein leichtgewichtiges, webbasiertes Ticketsystem mit integriertem Projektmanagement zur effizienten Verwaltung von Bug-Reports, Feature-Requests und Software-Projekten.

## Features

### Ticket-Management
- **Ticket-Management:** Erstellen und Verwalten von Tickets mit den Typen `Bug` und `Feature`.
- **Priorisierung und Status:** Strukturierte Verfolgung durch Status (`offen`, `in_bearbeitung`, `wartend`, `geschlossen`) und Prioritaeten (`niedrig` bis `kritisch`).
- **SLA-Tracking:** Automatische Berechnung von First-Response- und Aufloesungszeiten basierend auf Prioritaet und Dringlichkeit.
- **Activity Stream:** Vollstandige Historie aller Aktionen an einem Ticket (Statuswechsel, Kommentare, Zuweisungen).
- **Feedback-System:** Bewertungen und Kommentare zu abgeschlossenen Tickets.
- **Echtzeit-Updates:** Socket.io fur Live-Aktualisierungen von Kommentaren und Ticket-Aenderungen.
- **System-Zuordnung:** Verknupfung von Tickets mit spezifischen Software-Produkten oder Systemen (z. B. CuraFlow, Schreibdienst).
- **Mitarbeiter-Zuweisung:** Tickets konnen direkt an zustandige Mitarbeiter zugewiesen werden.
- **E-Mail-Benachrichtigungen:** Automatisierte Benachrichtigungen via SMTP oder Brevo API bei:
    - Erstellung eines neuen Tickets.
    - Statusanderungen.
    - Zuweisung an einen Mitarbeiter.
    - Neuen Kommentaren.
- **Interne Kommunikation:** Moglichkeit, interne Notizen und Kommentare direkt am Ticket zu hinterlassen.
- **API-Unterstutzung:** REST-ahnliche API fur die automatisierte Ticket-Erstellung via API-Key.
- **Admin-Bereich:** Geschutzter Bereich fur Administratoren zur Verwaltung von Systemen und Mitarbeitern.

### Projektmanagement (NEU)
- **Projekte:** Verwalten von Software-Projekten mit Status (Planung/Aktiv/Wartung/Abgeschlossen), Start- und Enddatum, verknupft mit bestehenden Systemen.
- **Meilensteine:** Strukturierte Phasenplanung mit Start-/Endterminen, Farbcodierung und Status-Tracking (Offen/In Arbeit/Erledigt/Blockiert). Perfekt fur die Abbildung von Projektphasen (Pilot, Rollout, Optimierung).
- **Key-User-Management:** Zuweisung von Mitarbeitern zu Projekten mit Rollen (Key-User/Evaluator/Entscheider) und Evaluierungsnotizen.
- **Zeitleiste (Gantt):** Mermaid.js-basierte Gantt-Diagramme zur Visualisierung von Projektphasen und Meilensteinen.
- **Wiki-Dokumentation:** Projektbezogene Wiki-Seiten mit voller Markdown-Unterstutzung, Mermaid-Diagrammen und einem integrierten Editor (EasyMDE).
- **GitHub-Integration:**
    - Repository-Verknupfung mit Personal Access Token
    - Bidirektionaler Issue-Sync (lokal gecached mit Fallback)
    - GitHub-Issue-Anzeige im Projekt-Dashboard
    - Wiki-Import aus GitHub-Wiki
    - Webhook-Endpunkt mit HMAC-SHA256-Signaturprufung
    - Echtzeit-Benachrichtigungen bei Issue-Events via Socket.io

## Tech Stack

- **Runtime:** [Node.js](https://nodejs.org/)
- **Backend:** [Express.js](https://expressjs.com/)
- **Template Engine:** [EJS](https://ejs.co/)
- **Datenbank:** [SQLite3](https://www.sqlite.org/) (leichtgewichtig und ohne Installation)
- **E-Mail:** [Nodemailer](https://nodemailer.com/) + Brevo API
- **Echtzeit:** [Socket.io](https://socket.io/)
- **CSS:** [Tailwind CSS](https://tailwindcss.com/)
- **Konfiguration:** [dotenv](https://www.npmjs.com/package/dotenv)
- **Markdown:** [marked](https://marked.js.org/)
- **GitHub API:** [@octokit/rest](https://github.com/octokit/rest.js)
- **Diagramme:** [Mermaid.js](https://mermaid.js.org/) (clientseitig)

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
API_ALLOWED_IPS=
BASE_URL=http://localhost:8010

# E-Mail SMTP Einstellungen
SMTP_HOST=smtp.dein-anbieter.de
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER="dein-email@beispiel.de"
SMTP_PASS="dein-app-passwort"
SMTP_FROM="Ticketsystem <dein-email@beispiel.de>"

# Optional: Brevo statt SMTP verwenden
BREVO_API_KEY=
BREVO_FROM_EMAIL="dein-email@beispiel.de"
BREVO_FROM_NAME="Ticketsystem"

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

Dies befullt die Datenbank mit Testdaten:
- 3 Mitarbeiter (Michael, Andreas, Christian)
- 2 Systeme (CuraFlow, Schreibdienst)
- 2 Projekte mit je 6 Meilensteinen (Phasen 1-3)
- Key-User-Zuweisungen
- Wiki-Seiten mit Mermaid-Diagrammen
- 20 Beispiel-Tickets

### 6. Starten

```bash
# Produktionsmodus
npm start

# Entwicklungsmodus (mit Auto-Reload)
npm run dev
```

### 7. Tests ausfuhren

```bash
npm test
```

Fuhrt automatisierte Tests fur alle API-Endpunkte und Web-UI-Seiten durch (Auth, Projekte, Meilensteine, Key-User, Wiki, GitHub, Tickets).

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
TRUST_PROXY=true
```

Optional (API/SMTP):

- `API_KEY`, `REQUIRE_API_KEY`
- `API_ALLOWED_IPS` (kommagetrennte IP-Allowlist für `POST /api/tickets`; leer = keine IP-Einschränkung)
- `CORS_ALLOWED_ORIGINS` (kommagetrennt, z. B. `https://cf.coolify.kliniksued-rostock.de`)
- `TRUST_PROXY=true` bei Betrieb hinter Coolify/Reverse Proxy, damit sichere Session-Cookies korrekt funktionieren
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `BREVO_API_KEY`, optional `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME`, `BREVO_API_URL`
- `EMAIL_NOTIFY_NEW`, `EMAIL_NOTIFY_STATUS`, `EMAIL_NOTIFY_ASSIGN`, `EMAIL_NOTIFY_COMMENT`

Wenn `BREVO_API_KEY` gesetzt ist, versendet das System E-Mails über die Brevo API. SMTP wird dann nicht verwendet. Ohne `BREVO_API_KEY` bleibt der bisherige SMTP-Versand aktiv.

Hinweis: Ohne Volume auf `/app/data` wird die SQLite-Datenbank bei Redeployments verloren.

## API Nutzung

### Ticket-API

Sie konnen Tickets uber die API erstellen. Fur interne Deployments kann der Zugriff uber `API_ALLOWED_IPS` auf definierte Quellsysteme im Kliniknetz begrenzt werden. Optional kann zusatzlich ein `x-api-key` im Header erzwungen werden, wenn `REQUIRE_API_KEY=true` gesetzt ist.

**Endpoint:** `POST /api/tickets`

**Header:**
```
x-api-key: dein-api-key-12345
Content-Type: application/json
```

Wenn die API von einer anderen Domain aus dem Browser aufgerufen wird, muss diese Domain in `CORS_ALLOWED_ORIGINS` freigegeben werden. CORS ersetzt aber keine serverseitige Zugriffskontrolle; fur definierte Kliniksysteme sollte `API_ALLOWED_IPS` gesetzt werden, z. B.:

```env
CORS_ALLOWED_ORIGINS=https://cf.coolify.kliniksued-rostock.de
API_ALLOWED_IPS=10.10.1.25,10.10.1.26
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

**Erfolgsantwort:**
```json
{
  "id": 123,
  "status": "created",
  "ticketUrl": "https://deine-domain.tld/ticket/123",
  "apiUrl": "https://deine-domain.tld/api/tickets/123"
}
```

### Projektmanagement-API

**Projekte:**
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/api/projects` | Alle Projekte (mit Meilenstein-/Key-User-Statistiken) |
| GET | `/api/projects/:id` | Einzelnes Projekt |
| POST | `/api/projects` | Projekt erstellen (Admin) |
| PATCH | `/api/projects/:id` | Projekt aktualisieren (Admin) |

**Meilensteine:**
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/api/projects/:id/milestones` | Alle Meilensteine eines Projekts |
| POST | `/api/projects/:id/milestones` | Meilenstein erstellen (Admin) |
| PATCH | `/api/milestones/:id` | Meilenstein aktualisieren (Admin) |
| DELETE | `/api/milestones/:id` | Meilenstein loschen (Admin) |

**Key-User:**
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/api/projects/:id/keyusers` | Key-User eines Projekts (mit Staff-Daten) |
| POST | `/api/projects/:id/keyusers` | Key-User hinzufugen (Admin) |
| DELETE | `/api/keyusers/:id` | Key-User entfernen (Admin) |

**Wiki-Dokumente:**
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/api/projects/:id/docs` | Alle Wiki-Seiten eines Projekts |
| GET | `/api/projects/:id/docs/:slug` | Einzelne Wiki-Seite |
| POST | `/api/projects/:id/docs` | Wiki-Seite erstellen (Admin) |
| PATCH | `/api/docs/:id` | Wiki-Seite aktualisieren (Admin) |
| DELETE | `/api/docs/:id` | Wiki-Seite loschen (Admin) |

**GitHub-Integration:**
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/api/projects/:id/github` | GitHub-Einstellungen abrufen |
| POST | `/api/projects/:id/github` | GitHub-Einstellungen speichern (Admin) |
| POST | `/api/projects/:id/github/sync` | Manuellen Sync starten (Admin) |
| GET | `/api/projects/:id/github/issues` | GitHub Issues abrufen (live + Cache-Fallback) |
| GET | `/api/projects/:id/github/milestones` | GitHub Milestones abrufen |
| POST | `/api/github/webhook` | GitHub Webhook (HMAC-SHA256 Signaturprufung) |

**Sonstiges:**
| Methode | Endpoint | Beschreibung |
|---|---|---|
| POST | `/api/markdown/render` | Markdown zu HTML rendern |

## Projektstruktur

```
ticketsystem/
  templates/              # EJS Templates
    dashboard.ejs         # Dashboard-Übersicht
    detail.ejs            # Ticket-Detailansicht
    new.ejs               # Neues Ticket
    projects.ejs          # Projekt-Übersicht (NEU)
    project-dashboard.ejs # Projekt-Dashboard (NEU)
    project-timeline.ejs  # Gantt-Zeitleiste (NEU)
    project-milestones.ejs# Meilenstein-Verwaltung (NEU)
    project-keyusers.ejs  # Key-User-Verwaltung (NEU)
    project-docs.ejs      # Wiki-Übersicht (NEU)
    project-doc-view.ejs  # Wiki-Seite mit Editor (NEU)
    project-github.ejs    # GitHub-Integration (NEU)
    systems.ejs           # System-Verwaltung
    staff.ejs             # Mitarbeiter-Verwaltung
    users.ejs             # Benutzer-Verwaltung
    stats.ejs             # Statistik-Dashboard
    account.ejs           # Account-Einstellungen
    login.ejs             # Login-Seite
  public/                 # Statische Dateien (CSS, JS, Bilder)
  scripts/                # Hilfsskripte
    seed_db.js            # Datenbank-Seeding (Mitarbeiter, Systeme, Projekte, Tickets)
  tests/                  # Tests (NEU)
    test.js               # Automatisierte API- und Web-UI-Tests
  server.js               # Hauptanwendung und API-Logik (~3000 Zeilen)
  tailwind.config.js      # Tailwind CSS Konfiguration
  .env                    # Konfiguration (muss erstellt werden)
  package.json            # Abhangigkeiten und Scripts
```

## Lizenz

Dieses Projekt ist unter der MIT-Lizenz verfugbar.
