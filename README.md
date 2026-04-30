# Ticketsystem

Ein webbasiertes Ticketsystem mit integriertem Projektmanagement, Wiki, GitHub-Anbindung und einem mehrstufigen, KI-gestützten Workflow zur strukturierten Bearbeitung von Bug-Reports und Feature-Requests.

Der Server-Code liegt im Unterordner [ticketsystem/](ticketsystem/). Die ausführliche Entwickler- und Deployment-Doku findet sich in [ticketsystem/README.md](ticketsystem/README.md).

---

## Inhaltsverzeichnis

- [Überblick](#überblick)
- [Feature-Übersicht](#feature-übersicht)
  - [Ticket-Management](#ticket-management)
  - [Projektmanagement](#projektmanagement)
  - [Wiki & Dokumentation](#wiki--dokumentation)
  - [GitHub-Integration](#github-integration)
  - [KI-gestützter Ticket-Workflow](#ki-gestützter-ticket-workflow)
- [Tech-Stack](#tech-stack)
- [Architektur](#architektur)
- [Schnellstart](#schnellstart)
- [Konfiguration (`.env`)](#konfiguration-env)
- [API](#api)
  - [Ticket-API](#ticket-api)
  - [Projektmanagement-API](#projektmanagement-api)
  - [Workflow-API](#workflow-api)
- [KI-Provider](#ki-provider)
- [Sicherheit](#sicherheit)
- [Deployment (Docker / Coolify)](#deployment-docker--coolify)
- [Tests](#tests)
- [Projektstruktur](#projektstruktur)
- [Lizenz](#lizenz)

---

## Überblick

Das Ticketsystem ist eine schlanke, in **Node.js / Express / EJS** implementierte Webanwendung mit **SQLite** als Datenhaltung. Es kombiniert klassisches Issue-Tracking (Bugs, Features, SLA, Activity Stream) mit:

- **Projektmanagement** inkl. Meilensteinen, Key-Usern und Gantt-Zeitleiste,
- **Wiki-Seiten pro Projekt** mit Markdown und Mermaid,
- **Bidirektionaler GitHub-Anbindung** (Issues, Wiki-Import, Webhook),
- einem **mehrstufigen KI-Workflow** (Triage → Security → Planning → Integration → Approval → Coding) mit pluggable Providern (DeepSeek, OpenAI, Anthropic, Mistral, Ollama Cloud, lokale OpenAI-kompatible LLMs, GitHub Copilot),
- automatisch erstellten **Pull Requests** durch Coding-Bots (optional).

Echtzeit-Updates werden via **Socket.io** an alle verbundenen Clients gepusht.

---

## Feature-Übersicht

### Ticket-Management

- Tickets mit Typ `Bug` / `Feature`, Status (`offen`, `in_bearbeitung`, `wartend`, `geschlossen`) und Priorität (`niedrig`–`kritisch`).
- **SLA-Tracking** mit automatischer Berechnung von First-Response- und Auflösungs-Deadlines aus Priorität & Dringlichkeit.
- **Activity Stream** mit lückenloser Historie aller Statuswechsel, Kommentare, Zuweisungen und KI-Aktionen.
- **Mitarbeiter-Zuweisung** und **System-Zuordnung** (z. B. CuraFlow, Schreibdienst).
- **E-Mail-Benachrichtigungen** über SMTP oder Brevo API bei Erstellung, Statuswechsel, Zuweisung und Kommentaren — pro Event abschaltbar.
- **Feedback-System** für abgeschlossene Tickets (Bewertung + Freitext).
- **Echtzeit-Updates** über Socket.io für Tickets, Kommentare und Workflow-Steps.
- **Interne Notizen** zusätzlich zu öffentlichen Kommentaren.

### Projektmanagement

- Projekte mit Status (`Planung`, `Aktiv`, `Wartung`, `Abgeschlossen`), Start-/Endterminen und Verknüpfung zu Systemen.
- **Meilensteine** mit Phasen, Farbcodierung und Status (`Offen`, `In Arbeit`, `Erledigt`, `Blockiert`) — geeignet für Pilot-/Rollout-/Optimierungs-Phasen.
- **Key-User-Verwaltung** mit Rollen (`Key-User`, `Evaluator`, `Entscheider`) und Evaluierungsnotizen.
- **Gantt-Zeitleiste** auf Basis von [vis-timeline](https://github.com/visjs/vis-timeline) zur Visualisierung aller Phasen und Meilensteine.

### Wiki & Dokumentation

- Pro Projekt beliebig viele Wiki-Seiten mit voller Markdown-Unterstützung.
- Integrierter Editor ([EasyMDE](https://github.com/Ionaru/easy-markdown-editor)) mit Live-Preview.
- **Mermaid-Diagramme** (Flowcharts, Sequenzdiagramme, Gantt) inline im Markdown.
- Import bestehender GitHub-Wikis pro Projekt.

### GitHub-Integration

- Verknüpfung Repository ↔ Projekt über Personal Access Token.
- **Issue-Sync** (live + lokaler Cache als Fallback).
- Anzeige offener GitHub-Issues im Projekt-Dashboard.
- **Webhook-Endpunkt** mit HMAC-SHA256-Signaturprüfung; Issue-Events werden via Socket.io live an Clients gepusht.
- Read-only-Zugriff aus dem KI-Workflow auf `README.md`, `docs/*.md` u. ä. zur Anreicherung von Planning- und Integration-Stage.

### KI-gestützter Ticket-Workflow

Neue Bug-/Feature-Tickets durchlaufen automatisch einen konfigurierbaren Workflow mit klar getrennten Rollen:

1. **Triage Reviewer** — entscheidet, ob das Ticket klar genug formuliert ist.
2. **Security & Privacy Reviewer** — redigiert sensible Inhalte und erzeugt einen sicheren `coding_prompt`.
3. **Solution Architect (Planner)** — liest `README` und `docs/` aus dem verknüpften Repo, schlägt Schritte, betroffene Dateien und ein Whitelist-Set für die Coding-Stage vor.
4. **Integration / Architecture Reviewer** — prüft den Plan gegen Projektkonventionen und empfiehlt einen Komplexitäts-Level (`medium` / `high`).
5. **Final Approver (Mensch)** — entscheidet: `dispatch_medium`, `dispatch_high`, `rejected`, `unclear`, `handoff`.
6. **Coding-Bot (medium / high)** — erzeugt vollständige Datei-Inhalte, Commit-Message und Test-Plan; optional automatisch als Pull Request gegen das Repo.
7. **Final Approver (zweite Stufe)** — gibt den PR final frei oder fordert Rework an.

Weitere Eigenschaften:

- **Mensch oder KI-Bot:** Mitarbeiter haben einen `kind` von `human` oder `ai`. Bots werden mit Provider, Modell, Temperatur und optionalem System-Prompt-Override konfiguriert.
- **Mehrere Rollen pro Mitarbeiter** möglich; bei mehreren Kandidaten pro Rolle erfolgt **Round-Robin-Zuweisung**.
- **Pro System abschaltbar** über `systems.ai_workflow_enabled`.
- **Re-Run einzelner Stages** mit Zusatz-Hinweis durch den Approver — vorherige Steps bleiben als `superseded` in der Historie sichtbar.
- **Two-Pass-Planner** (`AI_PLANNER_TWO_PASS=1`): Pass 1 nennt `candidate_files`, der Server lädt diese aus dem Repo nach, Pass 2 erhält sie als verbindliche Grundlage.
- **Boundary Files** (`REPO_BOUNDARY_FILES`) werden Planner und Integration-Reviewer als verbindliche Referenz mitgegeben (Routen, Schemata, Entity-Registry).

---

## Tech-Stack

| Bereich        | Technologie                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| Runtime        | [Node.js](https://nodejs.org/)                                               |
| Backend        | [Express.js](https://expressjs.com/)                                         |
| Templating     | [EJS](https://ejs.co/)                                                       |
| Datenbank      | [SQLite3](https://www.sqlite.org/) (file-based, kein DB-Server nötig)        |
| Echtzeit       | [Socket.io](https://socket.io/)                                              |
| E-Mail         | [Nodemailer](https://nodemailer.com/) + [Brevo API](https://www.brevo.com/)  |
| CSS            | [Tailwind CSS](https://tailwindcss.com/)                                     |
| Markdown       | [marked](https://marked.js.org/) + [EasyMDE](https://github.com/Ionaru/easy-markdown-editor) |
| Diagramme      | [Mermaid.js](https://mermaid.js.org/), [vis-timeline](https://github.com/visjs/vis-timeline) |
| GitHub-API     | [@octokit/rest](https://github.com/octokit/rest.js)                          |
| Konfiguration  | [dotenv](https://www.npmjs.com/package/dotenv)                               |

---

## Architektur

Hochlevel-Datenfluss eines neuen Tickets mit aktiviertem KI-Workflow:

```
Client (Browser / API)
      │  POST /api/tickets
      ▼
┌────────────────────┐    Socket.io     ┌─────────────────┐
│ Express Server     │ ───────────────▶ │ Connected Clients│
│  (server.js)       │                  └─────────────────┘
│                    │
│  Ticket-CRUD       │  insert
│  ─────────────────▶│ ───────────────▶  SQLite (tickets.db)
│                    │
│  Workflow-Engine   │  read README/docs
│  (services/        │ ───────────────▶  GitHub REST API
│   workflow/        │
│   engine.js)       │  redact secrets / PII
│                    │ ───────────────▶  AI Provider
│                    │                   (DeepSeek, OpenAI,
│                    │                    Anthropic, Mistral,
│                    │                    Ollama, Copilot, …)
│                    │
│  Coding-Stage      │  branch + commit + PR
│                    │ ───────────────▶  GitHub REST API
└────────────────────┘
```

Wichtige Module im `ticketsystem/`-Tree:

- `server.js` — Express-App, Routing, Sessions, Socket.io.
- `services/ai/client.js` — Provider-Abstraktion (`chat({ provider, system, user, … })`), JSON-Robustheit, Token-Limits, Allowlist.
- `services/ai/redact.js` — PII/Secret-Redaction vor jedem AI-Call.
- `services/ai/prompts.js` — System-Prompts für die einzelnen Workflow-Rollen.
- `services/workflow/engine.js` — Stage-Engine, Re-Run-/Skip-Logik, Briefing für Approver.
- `services/workflow/githubContext.js` — Read-only-Repo-Kontext für Planner/Integration.
- `services/workflow/codeChecks.js` — Whitelist-/Boundary-Validierung für Coding-Bots.

---

## Schnellstart

```bash
git clone https://github.com/andreasknopke/Ticketsystem.git
cd Ticketsystem/ticketsystem

npm install

cp .env.example .env       # falls vorhanden – sonst .env nach Vorlage unten anlegen
npm run seed               # optionale Testdaten (Projekte, Meilensteine, Wiki, Tickets)
npm start                  # Produktionsmodus
# oder
npm run dev                # Entwicklungsmodus mit Auto-Reload
```

Die Anwendung läuft anschließend unter `http://localhost:8010`. Standard-Login sind die in der `.env` gesetzten `ADMIN_USER` / `ADMIN_PASS`.

---

## Konfiguration (`.env`)

Die wichtigsten Variablen — eine vollständige Liste inkl. aller KI-Provider und Boundary-Optionen findet sich in [ticketsystem/README.md](ticketsystem/README.md).

```env
# Server
PORT=8010
APP_SECRET="ein-sehr-sicherer-schluessel"
ADMIN_USER="admin"
ADMIN_PASS="dein-sicheres-passwort"
BASE_URL=http://localhost:8010
TRUST_PROXY=true               # bei Betrieb hinter Reverse Proxy / Coolify

# API
API_KEY="dein-api-key-12345"
REQUIRE_API_KEY=false
API_ALLOWED_IPS=               # kommagetrennt; leer = keine IP-Einschränkung
CORS_ALLOWED_ORIGINS=          # z. B. https://intranet.example.org

# E-Mail (entweder SMTP oder Brevo)
SMTP_HOST=smtp.example.org
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=ticket@example.org
SMTP_PASS=geheim
SMTP_FROM="Ticketsystem <ticket@example.org>"

BREVO_API_KEY=                 # wenn gesetzt, hat Vorrang vor SMTP
BREVO_FROM_EMAIL=
BREVO_FROM_NAME=

# Benachrichtigungs-Schalter
EMAIL_NOTIFY_NEW=true
EMAIL_NOTIFY_STATUS=true
EMAIL_NOTIFY_ASSIGN=true
EMAIL_NOTIFY_COMMENT=true

# KI-Workflow (siehe Abschnitt KI-Provider)
AI_WORKFLOW_ENABLED=true
AI_DEFAULT_PROVIDER=deepseek
AI_WORKFLOW_MAX_RETRIES=2
AI_WORKFLOW_REQUEST_TIMEOUT_MS=120000
AI_WORKFLOW_MAX_TOKENS=2048
AI_REDACTION_PATTERNS_FILE=    # optional, JSON-Liste mit zusätzlichen Regex-Patterns
AI_PLANNER_TWO_PASS=1
REPO_BOUNDARY_FILES=
AI_CODING_AUTO_PR=true

# GitHub Fallback-Token (Vorrang hat das Project-spezifische Token)
GITHUB_DEFAULT_TOKEN=
```

---

## API

Alle JSON-Endpunkte sind unter `/api/...` erreichbar. Mutierende Endpunkte sind **Admin-geschützt** (Session) oder erfordern bei externen Aufrufen den `x-api-key`-Header (wenn `REQUIRE_API_KEY=true`).

### Ticket-API

**Endpoint:** `POST /api/tickets`

**Header:**

```
x-api-key: dein-api-key-12345
Content-Type: application/json
```

**Body:**

```json
{
  "type": "bug",
  "title": "Fehler beim Login",
  "description": "Login schlägt mit Sonderzeichen im Passwort fehl.",
  "system_id": 1,
  "urgency": "emergency"
}
```

**Antwort:**

```json
{
  "id": 123,
  "status": "created",
  "ticketUrl": "https://deine-domain.tld/ticket/123",
  "apiUrl": "https://deine-domain.tld/api/tickets/123"
}
```

Weitere Ticket-Endpunkte (Auswahl): `GET /api/tickets`, `GET /api/tickets/:id`, `PATCH /api/tickets/:id`, `POST /api/tickets/:id/comments`, `POST /api/tickets/:id/feedback`.

### Projektmanagement-API

| Methode | Endpoint                                 | Beschreibung                                         |
| ------- | ---------------------------------------- | ---------------------------------------------------- |
| GET     | `/api/projects`                          | Alle Projekte inkl. Statistiken                      |
| GET     | `/api/projects/:id`                      | Einzelnes Projekt                                    |
| POST    | `/api/projects`                          | Projekt erstellen (Admin)                            |
| PATCH   | `/api/projects/:id`                      | Projekt aktualisieren (Admin)                        |
| GET     | `/api/projects/:id/milestones`           | Meilensteine eines Projekts                          |
| POST    | `/api/projects/:id/milestones`           | Meilenstein anlegen (Admin)                          |
| PATCH   | `/api/milestones/:id`                    | Meilenstein aktualisieren (Admin)                    |
| DELETE  | `/api/milestones/:id`                    | Meilenstein löschen (Admin)                          |
| GET     | `/api/projects/:id/keyusers`             | Key-User eines Projekts                              |
| POST    | `/api/projects/:id/keyusers`             | Key-User hinzufügen (Admin)                          |
| DELETE  | `/api/keyusers/:id`                      | Key-User entfernen (Admin)                           |
| GET     | `/api/projects/:id/docs`                 | Wiki-Seiten eines Projekts                           |
| GET     | `/api/projects/:id/docs/:slug`           | Einzelne Wiki-Seite                                  |
| POST    | `/api/projects/:id/docs`                 | Wiki-Seite anlegen (Admin)                           |
| PATCH   | `/api/docs/:id`                          | Wiki-Seite aktualisieren (Admin)                     |
| DELETE  | `/api/docs/:id`                          | Wiki-Seite löschen (Admin)                           |
| GET     | `/api/projects/:id/github`               | GitHub-Einstellungen abrufen                         |
| POST    | `/api/projects/:id/github`               | GitHub-Einstellungen speichern (Admin)               |
| POST    | `/api/projects/:id/github/sync`          | Manuellen Issue-Sync starten (Admin)                 |
| GET     | `/api/projects/:id/github/issues`        | Live-Issues + Cache-Fallback                         |
| GET     | `/api/projects/:id/github/milestones`    | GitHub-Milestones                                    |
| POST    | `/api/github/webhook`                    | GitHub-Webhook (HMAC-SHA256)                         |
| POST    | `/api/markdown/render`                   | Markdown → HTML rendern                              |

### Workflow-API

| Methode | Endpoint                                                | Beschreibung                                              |
| ------- | ------------------------------------------------------- | --------------------------------------------------------- |
| GET     | `/api/ai/providers/health`                              | Live-Test aller konfigurierten KI-Provider (Admin)        |
| GET     | `/api/staff`                                            | Mitarbeiter inkl. KI-Konfiguration (`kind`, `ai_provider` …) |
| POST    | `/api/staff`                                            | Mitarbeiter anlegen (Admin)                               |
| POST    | `/api/staff/:id/roles`                                  | Workflow-Rollen setzen (`triage`, `security`, …, `coding`) |
| GET     | `/api/tickets/:id/workflow`                             | Run + Steps + Artefakte + Approver-Briefing               |
| GET     | `/api/tickets/:id/workflow/artifacts/:artId`            | Artefakt-Download (Plan, Commit-Message, Diffs …)         |
| POST    | `/api/tickets/:id/workflow/restart`                     | Workflow neu starten (Admin)                              |
| POST    | `/api/tickets/:id/workflow/steps/:stepId/decision`      | Approver-Entscheidung (Dispatch / Final)                  |

Approver-Entscheidungen:

- **Dispatch-Phase** (vor Coding): `dispatch_medium`, `dispatch_high`, `rejected`, `unclear`, `handoff`.
- **Final-Phase** (nach Coding): `approved`, `rework`, `rejected`.

---

## KI-Provider

Alle Provider werden über eine einheitliche Abstraktion in `services/ai/client.js` angesprochen. Outbound-HTTP ist auf eine **Allowlist** konfigurierter Provider-Hosts beschränkt; Token- und Timeout-Limits sind per ENV steuerbar.

| Provider          | ENV-Präfix        | Standard-Modell              | Hinweise                                                                                                                                          |
| ----------------- | ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DeepSeek**      | `DEEPSEEK_*`      | `deepseek-chat`              | OpenAI-kompatibel, gut für Planner & Coding-Bots.                                                                                                  |
| **OpenAI**        | `OPENAI_*`        | `gpt-4.1`                    | Klassische Cloud-API.                                                                                                                              |
| **OpenAI lokal**  | `OPENAI_LOCAL_*`  | `local-model`                | Beliebige OpenAI-kompatible Endpoints (LM Studio, vLLM, llama.cpp-Server, Ollama im OpenAI-Modus).                                                |
| **Anthropic**     | `ANTHROPIC_*`     | `claude-sonnet-4-5`          | Native Claude-API mit `ANTHROPIC_VERSION`-Header.                                                                                                  |
| **Mistral**       | `MISTRAL_*`       | `mistral-large-latest`       | Reasoning-Modelle (`magistral-*`) eignen sich besonders für den Integration-Reviewer.                                                              |
| **Ollama Cloud**  | `OLLAMA_*`        | `gpt-oss:120b`               | API-Key auf [ollama.com](https://ollama.com) erzeugen. Modellnamen ohne `-cloud`-Suffix angeben.                                                   |
| **GitHub Copilot**| `COPILOT_*`       | `gpt-4o`                     | **Inoffiziell** — nutzt das Copilot-Chat-Backend (vgl. VS Code). Setzt aktives Copilot-Abo voraus und kann jederzeit brechen.                      |

**Konfigurations-Beispiel (DeepSeek + Anthropic):**

```env
AI_DEFAULT_PROVIDER=deepseek

DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat

ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-sonnet-4-5
ANTHROPIC_VERSION=2023-06-01
```

Pro Mitarbeiter (Bot) lassen sich `ai_provider`, `ai_model`, `ai_temperature`, `ai_max_tokens`, `ai_system_prompt` und `ai_extra_config` einzeln überschreiben — z. B. ein günstiger DeepSeek-Triage-Bot kombiniert mit einem Claude-Coding-Bot für High-Level-Aufgaben.

Health-Check aller konfigurierten Provider:

```bash
curl -u admin:dein-passwort https://deine-domain.tld/api/ai/providers/health
```

---

## Sicherheit

- **PII- & Secret-Redaction** vor jedem AI-Call: E-Mails, IBANs, Tokens, AWS-Keys, IPs, Telefonnummern, Bearer-Tokens, JWTs. Erweiterbar via `AI_REDACTION_PATTERNS_FILE`.
- **Provider-Allowlist** für Outbound-HTTP — keine Calls an unbekannte Hosts.
- **GitHub-Read-Only** in Planning/Integration; nur die Coding-Stage darf schreiben (Branch + PR), und nur wenn `auto_commit_enabled=1` und ein Repo-Token vorhanden ist.
- **API-Schutz** über `API_KEY` + optionaler IP-Allowlist (`API_ALLOWED_IPS`).
- **CORS** nur für explizit gesetzte Origins (`CORS_ALLOWED_ORIGINS`).
- **Webhook-Verifikation** mit HMAC-SHA256.
- **Sichere Cookies** hinter Reverse Proxy via `TRUST_PROXY=true`.

---

## Deployment (Docker / Coolify)

Ein vorgefertigtes Dockerfile liegt unter [ticketsystem/Dockerfile](ticketsystem/Dockerfile). Alternativ steht im Repo-Root ein [Dockerfile](Dockerfile), das ohne zusätzliche Pfad-Konfiguration in Coolify funktioniert.

**Coolify-Einstellungen:**

- Build Pack: **Dockerfile**
- Dockerfile-Pfad: `ticketsystem/Dockerfile` (oder Root-`Dockerfile`)
- Port: `8010`
- Persistent Volume: Mount-Path `/app/data` (für die SQLite-Datenbank!)

**Mindest-ENV in Coolify:**

```env
APP_SECRET=ein-sehr-sicherer-schluessel
ADMIN_USER=admin
ADMIN_PASS=dein-sicheres-passwort
PORT=8010
DB_FILE=/app/data/tickets.db
BASE_URL=https://deine-domain.tld
TRUST_PROXY=true
```

> **Achtung:** Ohne Volume auf `/app/data` geht die SQLite-Datenbank bei jedem Redeployment verloren.

---

## Tests

Im Ordner [ticketsystem/tests/](ticketsystem/tests/) liegt eine Suite, die alle wichtigen API-Endpunkte und Web-UI-Seiten durchspielt (Auth, Projekte, Meilensteine, Key-User, Wiki, GitHub, Tickets, Workflow):

```bash
cd ticketsystem
npm test
```

---

## Projektstruktur

```
Ticketsystem/
├── Dockerfile                 # Root-Dockerfile (für Coolify ohne Pfad-Konfig)
├── README.md                  # diese Datei
├── Artifacts/                 # Beispiele für KI-Workflow-Artefakte
├── src/                       # gemeinsame TypeScript-Komponenten / Services (Frontend)
│   ├── components/
│   │   ├── StageActions.tsx
│   │   └── StageDetails.tsx
│   └── services/
│       └── stageService.ts
└── ticketsystem/              # eigentliche Server-Anwendung
    ├── server.js              # Express-App, Routing, Sessions, Socket.io
    ├── package.json
    ├── Dockerfile
    ├── tailwind.config.js
    ├── controllers/           # Route-Handler
    ├── routes/                # Routen-Definitionen
    ├── models/                # SQLite-Zugriffslayer
    ├── migrations/            # Schema-Migrationen
    ├── services/
    │   ├── ai/
    │   │   ├── client.js      # Provider-Abstraktion (allowlist, JSON-Robustheit)
    │   │   ├── prompts.js     # System-Prompts pro Rolle
    │   │   └── redact.js      # PII/Secret-Redaction
    │   └── workflow/
    │       ├── engine.js      # Stage-Engine, Re-Run, Briefings
    │       ├── assignment.js  # Round-Robin pro Rolle
    │       ├── codeChecks.js  # Whitelist-/Boundary-Checks
    │       └── githubContext.js # Read-only-Repo-Kontext
    ├── templates/             # EJS-Templates (Dashboard, Detail, Projekte, Wiki, …)
    ├── public/                # statische Assets, gebautes CSS, Frontend-Komponenten
    ├── scripts/
    │   └── seed_db.js         # Demo-Daten für lokale Entwicklung
    ├── tests/
    │   └── test.js            # API- & UI-Tests
    └── views/
```

---

## Lizenz

MIT — siehe [LICENSE](LICENSE), sofern vorhanden.
