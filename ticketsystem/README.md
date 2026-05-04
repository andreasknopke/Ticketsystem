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

### KI-gestuetzter Ticket-Workflow (NEU)
- **Mensch oder KI-Bot:** Mitarbeiter koennen vom Typ `human` oder `ai` sein. KI-Bots werden pro Mitarbeiter mit Provider, Modell, Temperatur und optionalem System-Prompt-Override konfiguriert.
- **Workflow-Profile (Rollen):** `triage` (Triage Reviewer), `security` (Security & Privacy Reviewer), `planning` (Solution Architect / Planner), `integration` (Integration / Architecture Reviewer), `approval` (Final Approver), `coding` (Coding Bot), `clarifier` (Repo-Resolver — beantwortet technische Rueckfragen automatisch aus dem Repo). Jeder Mitarbeiter kann mehrere Rollen uebernehmen.
- **Round-Robin-Zuweisung:** Bei mehreren Kandidaten pro Rolle wird die naechste Stage automatisch round-robin verteilt.
- **Auto-Trigger:** Neue Bug-/Feature-Tickets starten automatisch den Standard-Workflow `triage -> security -> planning -> integration -> approval`. Pro System abschaltbar (`systems.ai_workflow_enabled`).
- **Triage "unklar":** Bei unklarem Ticket wird direkt zur Final-Approver-Stage gesprungen; ein menschlicher Approver entscheidet ueber Rueckfrage / Reject / Handoff.
- **Security & Redaction:** Vor jedem KI-Aufruf werden PII/Secrets per Default-Regex (E-Mail, IBAN, Tokens, AWS-Keys, IPs, Telefon, Bearer, JWT, etc.) redigiert. Erweiterbar via `AI_REDACTION_PATTERNS_FILE` (JSON-Liste).
- **GitHub-Read-Only:** Planning- und Integration-Stage lesen `README.md` und `docs/*.md` aus dem mit dem Ticket-System verknuepften Repository (read-only, max 200 KB).
- **Provider-Allowlist:** Outbound-HTTP nur an konfigurierte Provider-Hosts. Token- und Timeout-Limits per ENV.

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

# --- KI-Workflow ---
AI_WORKFLOW_ENABLED=true
AI_DEFAULT_PROVIDER=deepseek            # deepseek | ollama | openai | openai_local | anthropic | copilot | mistral | openrouter
AI_WORKFLOW_MAX_RETRIES=2
AI_WORKFLOW_REQUEST_TIMEOUT_MS=120000
AI_WORKFLOW_MAX_TOKENS=2048
AI_REDACTION_PATTERNS_FILE=             # optional, Pfad zu JSON-Datei

# DeepSeek
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat

# Ollama Cloud (https://docs.ollama.com/cloud)
# API-Key unter ollama.com erzeugen und hier hinterlegen.
# Nur den Key eintragen, nicht "Bearer <key>". Alias: OLLAMA_CLOUD_API_KEY.
# Hinweis: Direkter Cloud-Zugriff nutzt Modellnamen ohne "-cloud" (z.B. gpt-oss:120b).
OLLAMA_API_KEY=
OLLAMA_BASE_URL=https://ollama.com
OLLAMA_MODEL=gpt-oss:120b

# OpenAI
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1

# Lokales OpenAI-kompatibles LLM (z. B. LM Studio, vLLM)
OPENAI_LOCAL_BASE_URL=http://localhost:8000/v1
OPENAI_LOCAL_API_KEY=
OPENAI_LOCAL_MODEL=local-model

# Anthropic (Claude)
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-sonnet-4-5
ANTHROPIC_VERSION=2023-06-01

# GitHub Copilot (INOFFIZIELL! erfordert Copilot Pro/Pro+/Business/Enterprise)
# Funktioniert ueber den Copilot-Chat-Backend, den auch Editoren wie VS Code nutzen.
# Auth-Flow: COPILOT_GITHUB_TOKEN -> kurzlebiger Copilot-Token -> Chat
# Hinweis: Diese API ist nicht oeffentlich dokumentiert und kann jederzeit
# gebrochen werden. Ein offizieller "Copilot for Business API"-Endpoint waere
# vorzuziehen, sobald GitHub diesen freigibt.
COPILOT_GITHUB_TOKEN=                   # GitHub-PAT eines Copilot-Accounts (oder Re-Use von GITHUB_DEFAULT_TOKEN)
COPILOT_BASE_URL=https://api.githubcopilot.com
COPILOT_TOKEN_URL=https://api.github.com/copilot_internal/v2/token
COPILOT_MODEL=gpt-4o                    # z.B. gpt-4o, gpt-5, claude-3.7-sonnet, claude-sonnet-4 (je nach Subscription)
COPILOT_EDITOR_VERSION=vscode/1.95.0
COPILOT_EDITOR_PLUGIN_VERSION=copilot-chat/0.22.0

# Mistral (OpenAI-kompatibel; Reasoning-Modelle wie magistral-* eignen sich
# besonders fuer den Integration-Reviewer)
MISTRAL_API_KEY=
MISTRAL_BASE_URL=https://api.mistral.ai/v1
MISTRAL_MODEL=mistral-large-latest      # alternativ: magistral-medium-latest, magistral-small-latest

# OpenRouter (OpenAI-kompatibel)
# Fuer kostenlose Modelle kann direkt das OpenRouter-Modell gesetzt werden,
# z. B. Lin 2.6.
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=lin-2.6

# Optionaler Fallback-GitHub-Token fuer Planning-Stage
# (Vorrang: github_integration.access_token des Projekts)
GITHUB_DEFAULT_TOKEN=

# Code-Grounding fuer Planner / Integration-Reviewer
# - AI_PLANNER_TWO_PASS=1 (Default): Planner laeuft zwei Mal. Pass 1 listet
#   "candidate_files", deren Inhalt der Server aus dem Repo nachlaedt; Pass 2
#   bekommt diese als verbindliche Grundlage.
# - REPO_BOUNDARY_FILES: Komma-Liste von Glob-Mustern. Diese Dateien werden in
#   jedem Planner- und Integration-Aufruf als "BOUNDARY FILES" mitgegeben
#   (Schemata, Routen, Entity-Registry). Default deckt Prisma, sql-Schemas,
#   src/api/entities.* und server/routes/*.{js,ts} ab.
AI_PLANNER_TWO_PASS=1
REPO_BOUNDARY_FILES=

# Architect-Tools (Stage 3 / Planning)
# Vor dem eigentlichen Plan-Schreiben darf der Solution-Architect das Repo via
# Read-only-Tools (list_tree, list_dir, read_file, grep) gezielt verifizieren.
# Verhindert Halluzinationen (falsche Tabellennamen, erfundene Funktionen).
# - ARCHITECT_TOOLS_ENABLED=true (Default): ReAct-Loop aktiv
# - ARCHITECT_TOOLS_BUDGET=6 (Default): max. Tool-Calls pro Planning-Run
ARCHITECT_TOOLS_ENABLED=true
ARCHITECT_TOOLS_BUDGET=6

# Coding-Bots: Auto-PR (Schreibzugriff ins Repo)
# - true (Default): Bots mit auto_commit_enabled=1 und Repo-Token oeffnen automatisch einen PR
# - false: nur Artefakte (commit_message, test_plan, geaenderte Dateien) als Download
AI_CODING_AUTO_PR=true

# Coding-Bots: deterministische Verifikation im Zielrepo-Klon
# - Syntaxcheck laeuft immer fuer JS/JSON-Dateien.
# - Fuer High-Coding-Bots sind lint, typecheck und build standardmaessig aktiv,
#   sofern das Zielrepo entsprechende npm-Scripts anbietet.
# - Medium-Bots koennen dieselben Gates explizit per ENV aktivieren.
AI_CODING_VERIFY_LINT=auto-high
AI_CODING_VERIFY_TYPECHECK=auto-high
AI_CODING_VERIFY_BUILD=auto-high

# Coding-Bots: Self-Resolve bei Verify-Fehlern
# - Nach dem ersten Edit-Pass kann der Bot Verify-Fehler automatisch korrigieren.
# - Syntaxfehler bekommen zusaetzlich den assemblierten Fehler-Kontext
#   (Zeilenfenster + einfache Delimiter-Bilanz), damit der Bot gezielt
#   fehlende Klammern/Braces/Backticks beheben kann.
# - Wert = Anzahl Korrekturversuche nach dem Erstversuch (Default: 2).
AI_CODING_MAX_CORRECTION_PASSES=2
```

#### Bot erneut auspruefen lassen

Im Workflow-Tab eines Tickets findet sich unter jedem abgeschlossenen Bot-Step
(Triage / Security / Planning / Integration) ein aufklappbares Feld
„🔄 Erneut prüfen mit Zusatzinfo". Dort kann der Approver eine
Hinweistextbox füllen (z. B. „Bot hat Datenbank-Logs als sensibles Datum
nicht erkannt"). Beim Re-Run wird:

1. der bisherige Step als `superseded` markiert (bleibt zur Historie sichtbar),
2. alle nachfolgenden Steps werden als `skipped` zurückgesetzt,
3. der Workflow läuft ab der gewählten Stage neu, und der Bot bekommt die
   Zusatzinfo als Suffix in seinem User-Prompt.

#### Neue API-Endpunkte (KI-Workflow)

- `GET  /api/ai/providers/health` — Live-Test aller konfigurierten KI-Provider (Admin).
- `GET  /api/staff` / `POST /api/staff` — erweitert um `kind`, `ai_provider`, `ai_model`, `ai_temperature`, `ai_max_tokens`, `ai_system_prompt`, `ai_extra_config`, `coding_level`, `auto_commit_enabled`, `roles[]`.
- `POST /api/staff/:id/roles` — setzt die Workflow-Rollen eines Mitarbeiters (`triage` | `security` | `planning` | `integration` | `approval` | `coding` | `clarifier`).
- `GET  /api/tickets/:id/workflow` — Run + alle Stage-Steps + Artefakte + Approver-Briefing.
- `GET  /api/tickets/:id/workflow/artifacts/:artId` — Artefakt-Download (z.B. Plan, Commit-Message, Test-Plan, geänderte Dateien).
- `POST /api/tickets/:id/workflow/restart` — Workflow neu starten (Admin).
- `POST /api/tickets/:id/workflow/steps/:stepId/decision` — Entscheidung des Approvers.
  - **Dispatch-Phase** (vor Coding): `dispatch_medium` | `dispatch_high` | `dispatch_external` | `rejected` | `unclear` | `handoff`
  - **Final-Phase** (nach Coding): `approved` | `rework` | `rejected`

#### Dispatch → Externer Coding-Agent (Repo-Dossier)

Statt einen lokalen Coding-Bot zu beauftragen, kann der Approver mit
`dispatch_external` den gesamten Ticket-Workflow als Markdown-Dossier in einen
neuen Branch des System-Repos pushen lassen. Dort liegt das Material unter
`tickets/<ticket-id>/` (`README.md`, `01_triage.md`, `02_security.md`,
`03_planning.md`, `04_integration.md`, `05_approval.md`, `manifest.json`).

Ein externer Coding-Agent (OpenCode, VS Code Copilot, etc.) kann diesen
Branch auschecken und mit dem Dossier als Briefing arbeiten — er hat den
gesamten Repo-Kontext mit den eigenen Tools und braucht von uns keinen Code,
nur die Analyse. Branch- und Commit-Info werden auf `ticket_workflow_runs`
persistiert (`dossier_branch`, `dossier_commit_sha`, `dossier_exported_at`)
und im Workflow-Tab des Tickets als Link angezeigt. Es wird **kein PR**
geoeffnet — der Branch ist die Arbeitsoberflaeche fuer den externen Agenten.

Voraussetzung: Das System des Tickets hat ein Repository konfiguriert
(`systems.repo_owner`/`repo_name`) und ein Token mit Schreibrechten — entweder
`systems.repo_access_token` oder `GITHUB_DEFAULT_TOKEN` (gleiche
Token-Hierarchie wie bei Coding-Bot-PRs).

### Coding-Bots (Medium / High Level)

Nach dem Integration-Review empfiehlt der Reviewer einen Komplexitäts-Level:
- **medium** — klassische Aufgaben, klare Anforderungen (Niveau GPT-5.4 / DeepSeek V4 / Kimi 2.6)
- **high** — komplexe Architektur, mehrere Module, hohe Risiken (Niveau Opus 4.7 / GPT-5.5)

Der Approver dispatcht das Ticket an einen Coding-Bot mit passendem `coding_level`. Der Bot:
1. Erzeugt vollständige Datei-Inhalte, eine Commit-Message und einen Test-Plan.
2. Wenn `auto_commit_enabled=1` und ein Repo-Token vorhanden ist: legt einen Branch an, committet die Dateien und öffnet einen Pull Request.
3. Übergibt anschließend zurück an den Approver (Final-Phase) mit allen Artefakten + PR-Link zur abschließenden Freigabe.

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
