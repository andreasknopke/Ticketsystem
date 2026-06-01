# Solution Architect (Planning)

- Ticket: #86462398-0343-457a-9867-a27a20a76d07 — sortierung der key user nach schulungsgrad
- Stage: `planning`
- Status: `done`
- Bearbeiter: Architect-Bot (ai)
- Provider/Modell: `deepseek` / `deepseek-v4-pro`
- Gestartet: 2026-06-01 18:59:53
- Beendet: 2026-06-01 19:05:39
- Dauer: 432 ms

## Bericht

> System: Ticketsystem (ID 4) · Repo: andreasknopke/Ticketsystem

**Zusammenfassung:** Füge ein konfigurierbares Checkbox-System für Schulungsziele hinzu, das pro Projekt vom Admin verwaltet wird. Das Bestandstextfeld 'Schulungsstatus' bleibt erhalten.

**Aufgabe:**
Erweitere die bestehende Projekt-Key-User-Seite um ein Admin-Panel zur Definition von Schulungszielen oberhalb der Tabelle. Implementiere Backend-Tabellen und API-Endpunkte zur Speicherung der Ziele pro Projekt und zur Erfassung der Auswahl pro Key-User. Modifiziere die bestehende Key-User-API, um die neuen Checkbox-Daten entgegenzunehmen, ohne das Legacy-Feld zu beeinträchtigen.

**Change-Kind:** `extend`

**Allowed Files:**
- `ticketsystem/server.js`
- `ticketsystem/templates/project-keyusers.ejs`

**Schritte:**
1. **1. Datenbankschema erweitern**
   - In server.js (innerhalb der Datenbank-Initialisierung) die Tabellen project_training_goals und key_user_training_selections mit CREATE TABLE IF NOT EXISTS anlegen. Spalten: project_training_goals (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, label TEXT NOT NULL, sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (project_id) REFERENCES projects(id)). key_user_training_selections (id INTEGER PRIMARY KEY AUTOINCREMENT, key_user_id INTEGER NOT NULL, training_goal_id INTEGER NOT NULL, FOREIGN KEY (key_user_id) REFERENCES project_key_users(id), FOREIGN KEY (training_goal_id) REFERENCES project_training_goals(id), UNIQUE(key_user_id, training_goal_id)).
   - Dateien: ticketsystem/server.js
2. **2. Backend-Endpunkte und Logik**
   - Server.js erweitern: Endpunkte GET/POST/PUT/DELETE /api/projects/:projectId/training-goals (Admin-only) zum Verwalten der Schulungsziele eines Projekts. Vorhandenen PUT /api/keyusers/:id so anpassen, dass ein neues Feld training_goal_ids (Array von IDs) akzeptiert wird, die Zuordnungen in key_user_training_selections aktualisiert (alte Einträge löschen und neue einfügen). GET-Route für die Projekt-Key-User-Seite (welche project-keyusers.ejs rendert) erweitern, um die Liste der Schulungsziele des Projekts sowie pro Key-User die ausgewählten Ziel-IDs mitzuliefern. Bestehendes Feld training_status unverändert lassen.
   - Dateien: ticketsystem/server.js
3. **3. Frontend-Anpassungen (project-keyusers.ejs)**
   - Oberhalb der Key-User-Tabelle einen Admin-Bereich einfügen, der nur für Admins sichtbar ist. Dort können Schulungsziele in einer Liste von Textfeldern eingegeben, hinzugefügt und gelöscht werden (über die neuen API-Endpunkte). In jeder Key-User-Zeile das vorhandene textarea (training_status) belassen. Zusätzlich eine Checkbox-Gruppe mit allen definierten Zielen rendern, initial anhand der vom Server gelieferten Auswahl vorbelegt. Beim Speichern des Key-Users die selektierten Checkbox-IDs als JSON-Array im Formular mitsenden (z. B. als verstecktes Feld oder direkt im AJAX-Body). Die bestehende Funktionalität rund um training_status darf nicht verändert werden.
   - Dateien: ticketsystem/templates/project-keyusers.ejs

**Constraints:**
- Das bestehende Textfeld 'Schulungsstatus' (textarea name='training_status') muss erhalten bleiben und weiterhin korrekt gespeichert/geladen werden.
- Nur Benutzer mit Admin-Rolle dürfen Schulungsziele verwalten (Endpunkte und UI-Steuerelemente).
- Die Schulungsziele sind pro Projekt eindeutig – jeder Projekt-Admin sieht nur seine eigenen Ziele.
- Alle Datenbankabfragen müssen parametrisiert sein (SQL-Injection-Schutz).
- Die bestehende Funktionalität der Key-User-API (PUT /api/keyusers/:id, DELETE /api/keyusers/:id) darf nicht gebrochen werden; das neue Feld training_goal_ids ist optional.
- Die UI soll ohne Seitenneuladung auskommen – AJAX für das Verwalten der Ziele und das Speichern der Key-User-Checkboxen.

**Risiken:**
- Der genaue Aufbau der Projekte-Seite und die Route, die project-keyusers.ejs rendert, sind unbekannt; möglicherweise muss die Route identifiziert und angepasst werden.
- Falls andere Stellen in server.js SELECT * FROM project_key_users verwenden, könnten diese durch die neuen Metadaten (z. B. Joins) nicht beeinträchtigt werden, müssen aber überprüft werden.
- Die SQLite-Migration (CREATE TABLE IF NOT EXISTS) ist idempotent, aber bei geänderten Spalten sind manuelle Anpassungen nötig – für den ersten Entwurf ausreichend.
- Client-seitiges dynamisches Generieren von Checkboxen beim Hinzufügen/Löschen von Zielen erfordert ggf. eine kleine Inline-JavaScript-Lösung, die stabil funktionieren muss.
- Es besteht ein geringes Risiko, dass die Admin-Autorisierung in der PUT /api/keyusers/:id nicht auf training_goal_ids ausgeweitet wird – muss explizit geprüft werden.

**Aufwand:** M

**Verifizierte Fakten (Architect-Tools):**
- File project-keyusers.ejs contains form for adding/editing key users (lines 70-110), with textarea 'training_status' (Schulungsstatus).
- Schulungsstatus column exists in table header (line 131).
- Server.js has table project_key_users with columns: id, project_id, name, email, phone, role, notes, training_status, test_protocol, created_at, updated_at.
- API endpoints: /api/keyusers/:id (PUT) for update, /api/keyusers/:id (DELETE) for delete.

_Basierend auf 6 Tool-Call(s)._

## Architect-Tool-Trace

**Verifizierte Fakten:**
- File project-keyusers.ejs contains form for adding/editing key users (lines 70-110), with textarea 'training_status' (Schulungsstatus).
- Schulungsstatus column exists in table header (line 131).
- Server.js has table project_key_users with columns: id, project_id, name, email, phone, role, notes, training_status, test_protocol, created_at, updated_at.
- API endpoints: /api/keyusers/:id (PUT) for update, /api/keyusers/:id (DELETE) for delete.

**Tool-Calls (6):**

### #1 — `read_file`
_Zuerst muss ich den aktuellen Aufbau der Key-User-Seite sehen, um zu verstehen, wo die Checkbox-Optionen platziert werden sollen. Die Datei 'project-keyusers.ejs' ist der wahrscheinliche Ort fuer die Admin-Definition._

Args:
```json
{
  "path": "ticketsystem/templates/project-keyusers.ejs",
  "start_line": 1,
  "end_line": 200
}
```
Result (gekuerzt):
```
# ticketsystem/templates/project-keyusers.ejs (Zeilen 1-200)
    1: <!DOCTYPE html>
    2: <html lang="de">
    3: <head>
    4:     <meta charset="UTF-8">
    5:     <meta name="viewport" content="width=device-width, initial-scale=1.0">
    6:     <title>Key-User - <%= project.name %> | Ticketsystem</title>
    7:     <link rel="stylesheet" href="/style.css?v=2">
    8: </head>
    9: <body class="bg-gray-50 min-h-screen">
   10:     <nav class="bg-white border-b border-gray-200 sticky top-0 z-50">
   11:         <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
   12:             <div class="flex justify-between h-16">
   13:                 <div class="flex items-center">
   14:                     <div class="flex-shrink-0 flex items-center gap-2">
   15:                         <div class="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
   16:                             <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
   17:                                 <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"/>
   18:                             </svg>
   19:                         </div>
   20:                         <a href="/" class="text-xl font-bold text-gray-900 hover:text-primary-600">Ticketsystem</a>
   21:                     </div>
   22:                     <div cla
```

### #2 — `grep`
_Muss das Feld 'Schulungsstatus' finden, um zu verstehen, wo es derzeit verwendet wird und wie es in das neue Checkbox-System integriert werden muss._

Args:
```json
{
  "pattern": "Schulungsstatus",
  "glob": "ticketsystem/**/*"
}
```
Result (gekuerzt):
```
ticketsystem/templates/project-keyusers.ejs:1: [code-search] <div> <label class="block text-sm font-medium text-gray-700 mb-1">Schulungsstatus</label> <textarea name="training_status" class="form-input" rows="3" placeholder="z. B. Basisschulung absolviert, Rollout offen"></textarea>
ticketsystem/templates/project-keyusers.ejs:1: [code-search] <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rolle</th> <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schulungsstatus</th> <th class="px-6 py-3 text-left text-xs font-medium text-…
ticketsystem/templates/project-keyusers.ejs:104: <label class="block text-sm font-medium text-gray-700 mb-1">Schulungsstatus</label>
ticketsystem/templates/project-keyusers.ejs:131: <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schulungsstatus</th>
```

### #3 — `read_file`
_Need to see the rest of project-keyusers.ejs to understand the add form, table, and any existing admin configuration. The grep showed lines 104 and 131 for 'Schulungsstatus'; I'll read around those lines to capture the full context._

Args:
```json
{
  "path": "ticketsystem/templates/project-keyusers.ejs",
  "start_line": 60,
  "end_line": 200
}
```
Result (gekuerzt):
```
# ticketsystem/templates/project-keyusers.ejs (Zeilen 60-200)
   60: 
   61:         <div class="flex flex-wrap gap-2 mb-6">
   62:             <a href="/project/<%= project.id %>" class="btn-secondary text-sm">Dashboard</a>
   63:             <a href="/project/<%= project.id %>/timeline" class="btn-secondary text-sm">Zeitleiste</a>
   64:             <% if (canManage) { %><a href="/project/<%= project.id %>/milestones" class="btn-secondary text-sm">Meilensteine</a><% } %>
   65:             <a href="/project/<%= project.id %>/keyusers" class="btn-secondary text-sm font-medium bg-primary-50 text-primary-700">Key-User</a>
   66:             <a href="/project/<%= project.id %>/docs" class="btn-secondary text-sm">Wiki</a>
   67:             <% if (canManage) { %><a href="/project/<%= project.id %>/github" class="btn-secondary text-sm">GitHub</a><% } %>
   68:         </div>
   69: 
   70:         <% if (canManage) { %>
   71:         <div id="addKeyUserForm" class="card mb-8 hidden">
   72:             <div class="card-header">
   73:                 <h2 id="keyUserFormTitle" class="text-lg font-semibold text-gray-900">Externen Key-User hinzufügen</h2>
   74:             </div>
   75:             <div class="card-body">
   76:                 <form id="keyUserForm" onsubmit="addKeyUser(event)" class="space-y-4">
   77:                     <input type="hidden" name="id" value="">
   78:                     <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
   79:                
```

### #4 — `grep`
_Need to see server.js for key user routes and database schema. Grep for 'keyuser' to find endpoints and data handling._

Args:
```json
{
  "pattern": "keyuser|key_user",
  "glob": "ticketsystem/server.js"
}
```
Result (gekuerzt):
```
ticketsystem/server.js:1: [code-search] phone TEXT, role TEXT CHECK(role IN ('key_user','evaluator','decision_maker')) DEFAULT 'key_user', notes TEXT,
ticketsystem/server.js:1: [code-search] (SELECT COUNT(*) FROM project_milestones WHERE project_id = p.id AND status = 'completed') as completed_milestones, (SELECT COUNT(*) FROM project_key_users WHERE project_id = p.id) as key_user_count FROM projects p
ticketsystem/server.js:1: [code-search] if (this.changes === 0) return res.status(404).json({ error: 'Key-User nicht gefunden.' }); io.emit('keyuser:updated', { projectId: req.params.projectId }); res.json({ id: Number(keyUserId), updated: true });
ticketsystem/server.js:1: [code-search] if (err) return res.status(500).json({ error: err.message }); if (row) io.emit('keyuser:updated', { projectId: row.project_id }); res.json({ status: 'deleted' });
ticketsystem/server.js:720: function migrateProjectKeyUsersToExternalContacts() {
ticketsystem/server.js:721: db.all('PRAGMA table_info(project_key_users)', (pragmaErr, rows) => {
ticketsystem/server.js:723: console.error('[migration] project_key_users PRAGMA fehlgeschlagen:', pragmaErr.message);
ticketsystem/server.js:741: console.log('[migration] project_key_users auf externe Projektkontakte umstellen...');
ticketsystem/server.js:753: 'DROP TABLE IF EXISTS project_key_users__new',
ticketsystem/server.js:755: `CREATE TABLE project_key_users__new (
ticketsystem/server.js:762: role TEXT CHECK(role IN ('key_user','evaluator','decision_m
```

### #5 — `read_file`
_Must see the rest of the Key-Users template (the table and any admin UI) to understand the current structure and where to place the new configuration and checkboxes._

Args:
```json
{
  "path": "ticketsystem/templates/project-keyusers.ejs",
  "start_line": 200,
  "end_line": 400
}
```
Result (gekuerzt):
```
# ticketsystem/templates/project-keyusers.ejs (Zeilen 200-217)
  200:                 method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':'<%= csrfToken %>'}, body:JSON.stringify(body)
  201:             });
  202:             if (resp.ok) {
  203:                 resetKeyUserForm();
  204:                 location.reload();
  205:             }
  206:             else alert('Fehler: ' + (await resp.json()).error);
  207:         }
  208:         async function deleteKeyUser(id) {
  209:             if (!confirm('Key-User entfernen?')) return;
  210:             const resp = await fetch('/api/keyusers/' + id, { method:'DELETE', headers:{'X-CSRF-Token':'<%= csrfToken %>'} });
  211:             if (resp.ok) location.reload();
  212:             else alert('Fehler beim Löschen');
  213:         }
  214:     </script>
  215: </body>
  216: </html>
  217: 
```

### #6 — `read_file`
_Need to see lines 110 to 200 of project-keyusers.ejs to find the table with 'Schulungsstatus' column and understand the current structure. Also need to check if there is any existing admin configuration for 'training objectives' or similar._

Args:
```json
{
  "path": "ticketsystem/templates/project-keyusers.ejs",
  "start_line": 110,
  "end_line": 200
}
```
Result (gekuerzt):
```
# ticketsystem/templates/project-keyusers.ejs (Zeilen 110-200)
  110:                         </div>
  111:                     </div>
  112:                     <div class="flex items-center gap-3">
  113:                         <button type="submit" id="keyUserSubmitButton" class="btn-primary">Key-User speichern</button>
  114:                         <button type="button" id="keyUserCancelButton" class="btn-secondary hidden" onclick="resetKeyUserForm()">Abbrechen</button>
  115:                     </div>
  116:                 </form>
  117:             </div>
  118:         </div>
  119:         <% } %>
  120: 
  121:         <div class="card">
  122:             <div class="card-header"><h2 class="text-lg font-semibold text-gray-900">Zugewiesene Key-User</h2></div>
  123:             <div class="card-body p-0">
  124:                 <div class="overflow-x-auto">
  125:                     <table class="min-w-full divide-y divide-gray-200">
  126:                         <thead class="bg-gray-50">
  127:                             <tr>
  128:                                 <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
  129:                                 <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Kontakt</th>
  130:                                 <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rolle</th>
  131:                                 <th class="px-6 py-3 t
```

_Tokens: prompt=27823, completion=4057_

## Vollstaendiges Output-Payload

```json
{
  "summary": "Füge ein konfigurierbares Checkbox-System für Schulungsziele hinzu, das pro Projekt vom Admin verwaltet wird. Das Bestandstextfeld 'Schulungsstatus' bleibt erhalten.",
  "task": "Erweitere die bestehende Projekt-Key-User-Seite um ein Admin-Panel zur Definition von Schulungszielen oberhalb der Tabelle. Implementiere Backend-Tabellen und API-Endpunkte zur Speicherung der Ziele pro Projekt und zur Erfassung der Auswahl pro Key-User. Modifiziere die bestehende Key-User-API, um die neuen Checkbox-Daten entgegenzunehmen, ohne das Legacy-Feld zu beeinträchtigen.",
  "affected_areas": [
    "Datenbank (server.js)",
    "Projekt-KeyUser-UI (project-keyusers.ejs)",
    "API-Routen in server.js"
  ],
  "allowed_files": [
    "ticketsystem/server.js",
    "ticketsystem/templates/project-keyusers.ejs"
  ],
  "change_kind": "extend",
  "steps": [
    {
      "title": "1. Datenbankschema erweitern",
      "details": "In server.js (innerhalb der Datenbank-Initialisierung) die Tabellen project_training_goals und key_user_training_selections mit CREATE TABLE IF NOT EXISTS anlegen. Spalten: project_training_goals (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, label TEXT NOT NULL, sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (project_id) REFERENCES projects(id)). key_user_training_selections (id INTEGER PRIMARY KEY AUTOINCREMENT, key_user_id INTEGER NOT NULL, training_goal_id INTEGER NOT NULL, FOREIGN KEY (key_user_id) REFERENCES project_key_users(id), FOREIGN KEY (training_goal_id) REFERENCES project_training_goals(id), UNIQUE(key_user_id, training_goal_id)).",
      "files": [
        "ticketsystem/server.js"
      ]
    },
    {
      "title": "2. Backend-Endpunkte und Logik",
      "details": "Server.js erweitern: Endpunkte GET/POST/PUT/DELETE /api/projects/:projectId/training-goals (Admin-only) zum Verwalten der Schulungsziele eines Projekts. Vorhandenen PUT /api/keyusers/:id so anpassen, dass ein neues Feld training_goal_ids (Array von IDs) akzeptiert wird, die Zuordnungen in key_user_training_selections aktualisiert (alte Einträge löschen und neue einfügen). GET-Route für die Projekt-Key-User-Seite (welche project-keyusers.ejs rendert) erweitern, um die Liste der Schulungsziele des Projekts sowie pro Key-User die ausgewählten Ziel-IDs mitzuliefern. Bestehendes Feld training_status unverändert lassen.",
      "files": [
        "ticketsystem/server.js"
      ]
    },
    {
      "title": "3. Frontend-Anpassungen (project-keyusers.ejs)",
      "details": "Oberhalb der Key-User-Tabelle einen Admin-Bereich einfügen, der nur für Admins sichtbar ist. Dort können Schulungsziele in einer Liste von Textfeldern eingegeben, hinzugefügt und gelöscht werden (über die neuen API-Endpunkte). In jeder Key-User-Zeile das vorhandene textarea (training_status) belassen. Zusätzlich eine Checkbox-Gruppe mit allen definierten Zielen rendern, initial anhand der vom Server gelieferten Auswahl vorbelegt. Beim Speichern des Key-Users die selektierten Checkbox-IDs als JSON-Array im Formular mitsenden (z. B. als verstecktes Feld oder direkt im AJAX-Body). Die bestehende Funktionalität rund um training_status darf nicht verändert werden.",
      "files": [
        "ticketsystem/templates/project-keyusers.ejs"
      ]
    }
  ],
  "symbols_to_preserve": [],
  "constraints": [
    "Das bestehende Textfeld 'Schulungsstatus' (textarea name='training_status') muss erhalten bleiben und weiterhin korrekt gespeichert/geladen werden.",
    "Nur Benutzer mit Admin-Rolle dürfen Schulungsziele verwalten (Endpunkte und UI-Steuerelemente).",
    "Die Schulungsziele sind pro Projekt eindeutig – jeder Projekt-Admin sieht nur seine eigenen Ziele.",
    "Alle Datenbankabfragen müssen parametrisiert sein (SQL-Injection-Schutz).",
    "Die bestehende Funktionalität der Key-User-API (PUT /api/keyusers/:id, DELETE /api/keyusers/:id) darf nicht gebrochen werden; das neue Feld training_goal_ids ist optional.",
    "Die UI soll ohne Seitenneuladung auskommen – AJAX für das Verwalten der Ziele und das Speichern der Key-User-Checkboxen."
  ],
  "risks": [
    "Der genaue Aufbau der Projekte-Seite und die Route, die project-keyusers.ejs rendert, sind unbekannt; möglicherweise muss die Route identifiziert und angepasst werden.",
    "Falls andere Stellen in server.js SELECT * FROM project_key_users verwenden, könnten diese durch die neuen Metadaten (z. B. Joins) nicht beeinträchtigt werden, müssen aber überprüft werden.",
    "Die SQLite-Migration (CREATE TABLE IF NOT EXISTS) ist idempotent, aber bei geänderten Spalten sind manuelle Anpassungen nötig – für den ersten Entwurf ausreichend.",
    "Client-seitiges dynamisches Generieren von Checkboxen beim Hinzufügen/Löschen von Zielen erfordert ggf. eine kleine Inline-JavaScript-Lösung, die stabil funktionieren muss.",
    "Es besteht ein geringes Risiko, dass die Admin-Autorisierung in der PUT /api/keyusers/:id nicht auf training_goal_ids ausgeweitet wird – muss explizit geprüft werden."
  ],
  "estimated_effort": "M",
  "open_questions": [],
  "architect_explore": {
    "findings": [
      "File project-keyusers.ejs contains form for adding/editing key users (lines 70-110), with textarea 'training_status' (Schulungsstatus).",
      "Schulungsstatus column exists in table header (line 131).",
      "Server.js has table project_key_users with columns: id, project_id, name, email, phone, role, notes, training_status, test_protocol, created_at, updated_at.",
      "API endpoints: /api/keyusers/:id (PUT) for update, /api/keyusers/:id (DELETE) for delete."
    ],
    "non_existent": [],
    "consistency_violations": [],
    "tree_validation_warnings": [],
    "evidence_probe": {
      "required": false,
      "found": false,
      "terms": [],
      "paths": [],
      "findings": [],
      "trace": []
    },
    "evidence_violations": [],
    "tool_calls": [
      {
        "iteration": 1,
        "thought": "Zuerst muss ich den aktuellen Aufbau der Key-User-Seite sehen, um zu verstehen, wo die Checkbox-Optionen platziert werden sollen. Die Datei 'project-keyusers.ejs' ist der wahrscheinliche Ort fuer die Admin-Definition.",
        "tool": "read_file",
        "args": {
          "path": "ticketsystem/templates/project-keyusers.ejs",
          "start_line": 1,
          "end_line": 200
        },
        "result": "# ticketsystem/templates/project-keyusers.ejs (Zeilen 1-200)\n    1: <!DOCTYPE html>\n    2: <html lang=\"de\">\n    3: <head>\n    4:     <meta charset=\"UTF-8\">\n    5:     <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    6:     <title>Key-User - <%= project.name %> | Ticketsystem</title>\n    7:     <link rel=\"stylesheet\" href=\"/style.css?v=2\">\n    8: </head>\n    9: <body class=\"bg-gray-50 min-h-screen\">\n   10:     <nav class=\"bg-white border-b border-gray-200 sticky top-0 z-50\">\n   11:         <div class=\"max-w-7xl mx-auto px-4 sm:px-6 lg:px-8\">\n   12:             <div class=\"flex justify-between h-16\">\n   13:                 <div class=\"flex items-center\">\n   14:                     <div class=\"flex-shrink-0 flex items-center gap-2\">\n   15:                         <div class=\"w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center\">\n   16:                             <svg class=\"w-5 h-5 text-white\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\">\n   17:                                 <path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z\"/>\n   18:                             </svg>\n   19:                         </div>\n   20:                         <a href=\"/\" class=\"text-xl font-bold text-gray-900 hover:text-primary-600\">Ticketsystem</a>\n   21:                     </div>\n   22:                     <div class=\"hidden md:ml-8 md:flex md:space-x-1\">\n   23:                         <a href=\"/\" class=\"nav-link\">Dashboard</a>\n   24:                         <a href=\"/ticket/new\" class=\"nav-link\">Neues Ticket</a>\n   25:                         <a href=\"/projects\" class=\"nav-link active\">Projekte</a>\n   26:                         <% if (role === 'admin' || role === 'root') { %>\n   27:                         <a href=\"/stats\" class=\"nav-link\">Statistiken</a>\n   28:                         <a href=\"/admin/systems\" class=\"nav-link\">Systeme</a>\n   29:                         <a href=\"/admin/staff\" class=\"nav-link\">Mitarbeiter</a>\n   30:                         <% if (role === 'root') { %><a href=\"/admin/users\" class=\"nav-link\">Benutzer</a><% } %>\n   31:                         <% } %>\n   32:                     </div>\n   33:                 </div>\n   34:                 <div class=\"flex items-center gap-4\">\n   35:                     <span class=\"text-sm text-gray-600\"><%= user %> <span class=\"badge bg-gray-100 text-gray-700\"><%= role %></span></span>\n   36:                     <a href=\"/account\" class=\"btn-secondary text-sm\">Account</a>\n   37:                     <a href=\"/logout\" class=\"btn-secondary text-sm\">Abmelden</a>\n   38:                 </div>\n   39:             </div>\n   40:         </div>\n   41:     </nav>\n   42: \n   43:     <main class=\"max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8\">\n   44:         <nav class=\"flex mb-6\" aria-label=\"Breadcrumb\">\n   45:             <ol class=\"flex items-center space-x-4\">\n   46:                 <li><a href=\"/\" class=\"text-gray-500 hover:text-gray-700\">Dashboard</a></li>\n   47:                 <li class=\"text-gray-400\">/</li>\n   48:                 <li><a href=\"/projects\" class=\"text-gray-500 hover:text-gray-700\">Projekte</a></li>\n   49:                 <li class=\"text-gray-400\">/</li>\n   50:                 <li><a href=\"/project/<%= project.id %>\" class=\"text-gray-500 hover:text-gray-700\"><%= project.name %></a></li>\n   51:                 <li class=\"text-gray-400\">/</li>\n   52:                 <li class=\"text-gray-900 font-medium\">Key-User</li>\n   53:             </ol>\n   54:         </nav>\n   55: \n   56:         <div class=\"flex items-center justify-between mb-6\">\n   57:             <h1 class=\"text-2xl font-bold text-gray-900\">Key-User: <%= project.name %></h1>\n   58:             <% if (canManage) { %><button onclick=\"toggleAddForm()\" class=\"btn-primary\">+ Key-User</button><% } %>\n   59:         </div>\n   60: \n   61:        ",
        "error": null
      },
      {
        "iteration": 2,
        "thought": "Muss das Feld 'Schulungsstatus' finden, um zu verstehen, wo es derzeit verwendet wird und wie es in das neue Checkbox-System integriert werden muss.",
        "tool": "grep",
        "args": {
          "pattern": "Schulungsstatus",
          "glob": "ticketsystem/**/*"
        },
        "result": "ticketsystem/templates/project-keyusers.ejs:1: [code-search] <div> <label class=\"block text-sm font-medium text-gray-700 mb-1\">Schulungsstatus</label> <textarea name=\"training_status\" class=\"form-input\" rows=\"3\" placeholder=\"z. B. Basisschulung absolviert, Rollout offen\"></textarea>\nticketsystem/templates/project-keyusers.ejs:1: [code-search] <th class=\"px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase\">Rolle</th> <th class=\"px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase\">Schulungsstatus</th> <th class=\"px-6 py-3 text-left text-xs font-medium text-…\nticketsystem/templates/project-keyusers.ejs:104: <label class=\"block text-sm font-medium text-gray-700 mb-1\">Schulungsstatus</label>\nticketsystem/templates/project-keyusers.ejs:131: <th class=\"px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase\">Schulungsstatus</th>",
        "error": null
      },
      {
        "iteration": 3,
        "thought": "Need to see the rest of project-keyusers.ejs to understand the add form, table, and any existing admin configuration. The grep showed lines 104 and 131 for 'Schulungsstatus'; I'll read around those lines to capture the full context.",
        "tool": "read_file",
        "args": {
          "path": "ticketsystem/templates/project-keyusers.ejs",
          "start_line": 60,
          "end_line": 200
        },
        "result": "# ticketsystem/templates/project-keyusers.ejs (Zeilen 60-200)\n   60: \n   61:         <div class=\"flex flex-wrap gap-2 mb-6\">\n   62:             <a href=\"/project/<%= project.id %>\" class=\"btn-secondary text-sm\">Dashboard</a>\n   63:             <a href=\"/project/<%= project.id %>/timeline\" class=\"btn-secondary text-sm\">Zeitleiste</a>\n   64:             <% if (canManage) { %><a href=\"/project/<%= project.id %>/milestones\" class=\"btn-secondary text-sm\">Meilensteine</a><% } %>\n   65:             <a href=\"/project/<%= project.id %>/keyusers\" class=\"btn-secondary text-sm font-medium bg-primary-50 text-primary-700\">Key-User</a>\n   66:             <a href=\"/project/<%= project.id %>/docs\" class=\"btn-secondary text-sm\">Wiki</a>\n   67:             <% if (canManage) { %><a href=\"/project/<%= project.id %>/github\" class=\"btn-secondary text-sm\">GitHub</a><% } %>\n   68:         </div>\n   69: \n   70:         <% if (canManage) { %>\n   71:         <div id=\"addKeyUserForm\" class=\"card mb-8 hidden\">\n   72:             <div class=\"card-header\">\n   73:                 <h2 id=\"keyUserFormTitle\" class=\"text-lg font-semibold text-gray-900\">Externen Key-User hinzufügen</h2>\n   74:             </div>\n   75:             <div class=\"card-body\">\n   76:                 <form id=\"keyUserForm\" onsubmit=\"addKeyUser(event)\" class=\"space-y-4\">\n   77:                     <input type=\"hidden\" name=\"id\" value=\"\">\n   78:                     <div class=\"grid grid-cols-1 md:grid-cols-2 gap-4\">\n   79:                         <div>\n   80:                             <label class=\"block text-sm font-medium text-gray-700 mb-1\">Name *</label>\n   81:                             <input name=\"name\" required class=\"form-input\" placeholder=\"z. B. Max Mustermann\">\n   82:                         </div>\n   83:                         <div>\n   84:                             <label class=\"block text-sm font-medium text-gray-700 mb-1\">E-Mail</label>\n   85:                             <input name=\"email\" type=\"email\" class=\"form-input\" placeholder=\"optional@projekt.de\">\n   86:                         </div>\n   87:                         <div>\n   88:                             <label class=\"block text-sm font-medium text-gray-700 mb-1\">Telefon</label>\n   89:                             <input name=\"phone\" class=\"form-input\" placeholder=\"Optional\">\n   90:                         </div>\n   91:                         <div>\n   92:                             <label class=\"block text-sm font-medium text-gray-700 mb-1\">Rolle</label>\n   93:                             <select name=\"role\" class=\"form-input\">\n   94:                                 <option value=\"key_user\">Key-User</option>\n   95:                                 <option value=\"evaluator\">Evaluator</option>\n   96:                                 <option value=\"decision_maker\">Entscheider</option>\n   97:                             </select>\n   98:                         </div>\n   99:                         <div class=\"col-span-2\">\n  100:                             <label class=\"block text-sm font-medium text-gray-700 mb-1\">Notizen</label>\n  101:                             <textarea name=\"notes\" class=\"form-input\" rows=\"2\" placeholder=\"Evaluierungsnotizen, Besonderheiten...\"></textarea>\n  102:                         </div>\n  103:                         <div>\n  104:                             <label class=\"block text-sm font-medium text-gray-700 mb-1\">Schulungsstatus</label>\n  105:                             <textarea name=\"training_status\" class=\"form-input\" rows=\"3\" placeholder=\"z. B. Basisschulung absolviert, Rollout offen\"></textarea>\n  106:                         </div>\n  107:                         <div>\n  108:                             <label class=\"block text-sm font-medium text-gray-700 mb-1\">Test-Protokoll</label>\n  109:                             <textarea name=\"test_protocol\" class=\"form-input\" rows=\"3\" placeholder=\"z. B. Ersten Test durchgeführt, offene Findings...\"></textarea>\n  110:                 ",
        "error": null
      },
      {
        "iteration": 4,
        "thought": "Need to see server.js for key user routes and database schema. Grep for 'keyuser' to find endpoints and data handling.",
        "tool": "grep",
        "args": {
          "pattern": "keyuser|key_user",
          "glob": "ticketsystem/server.js"
        },
        "result": "ticketsystem/server.js:1: [code-search] phone TEXT, role TEXT CHECK(role IN ('key_user','evaluator','decision_maker')) DEFAULT 'key_user', notes TEXT,\nticketsystem/server.js:1: [code-search] (SELECT COUNT(*) FROM project_milestones WHERE project_id = p.id AND status = 'completed') as completed_milestones, (SELECT COUNT(*) FROM project_key_users WHERE project_id = p.id) as key_user_count FROM projects p\nticketsystem/server.js:1: [code-search] if (this.changes === 0) return res.status(404).json({ error: 'Key-User nicht gefunden.' }); io.emit('keyuser:updated', { projectId: req.params.projectId }); res.json({ id: Number(keyUserId), updated: true });\nticketsystem/server.js:1: [code-search] if (err) return res.status(500).json({ error: err.message }); if (row) io.emit('keyuser:updated', { projectId: row.project_id }); res.json({ status: 'deleted' });\nticketsystem/server.js:720: function migrateProjectKeyUsersToExternalContacts() {\nticketsystem/server.js:721: db.all('PRAGMA table_info(project_key_users)', (pragmaErr, rows) => {\nticketsystem/server.js:723: console.error('[migration] project_key_users PRAGMA fehlgeschlagen:', pragmaErr.message);\nticketsystem/server.js:741: console.log('[migration] project_key_users auf externe Projektkontakte umstellen...');\nticketsystem/server.js:753: 'DROP TABLE IF EXISTS project_key_users__new',\nticketsystem/server.js:755: `CREATE TABLE project_key_users__new (\nticketsystem/server.js:762: role TEXT CHECK(role IN ('key_user','evaluator','decision_maker')) DEFAULT 'key_user',\nticketsystem/server.js:769: `INSERT INTO project_key_users__new (\nticketsystem/server.js:779: COALESCE(k.role, 'key_user'),\nticketsystem/server.js:783: FROM project_key_users k\nticketsystem/server.js:785: 'DROP TABLE project_key_users',\nticketsystem/server.js:786: 'ALTER TABLE project_key_users__new RENAME TO project_key_users',\nticketsystem/server.js:792: console.log('[migration] project_key_users erfolgreich migriert');\nticketsystem/server.js:795: console.error('[migration] project_key_users Migration fehlgeschlagen:', error.message);\nticketsystem/server.js:1063: db.run(`CREATE TABLE IF NOT EXISTS project_key_users (\nticketsystem/server.js:1070: role TEXT CHECK(role IN ('key_user','evaluator','decision_maker')) DEFAULT 'key_user',\nticketsystem/server.js:1081: migrateProjectKeyUsersToExternalContacts();",
        "error": null
      },
      {
        "iteration": 5,
        "thought": "Must see the rest of the Key-Users template (the table and any admin UI) to understand the current structure and where to place the new configuration and checkboxes.",
        "tool": "read_file",
        "args": {
          "path": "ticketsystem/templates/project-keyusers.ejs",
          "start_line": 200,
          "end_line": 400
        },
        "result": "# ticketsystem/templates/project-keyusers.ejs (Zeilen 200-217)\n  200:                 method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':'<%= csrfToken %>'}, body:JSON.stringify(body)\n  201:             });\n  202:             if (resp.ok) {\n  203:                 resetKeyUserForm();\n  204:                 location.reload();\n  205:             }\n  206:             else alert('Fehler: ' + (await resp.json()).error);\n  207:         }\n  208:         async function deleteKeyUser(id) {\n  209:             if (!confirm('Key-User entfernen?')) return;\n  210:             const resp = await fetch('/api/keyusers/' + id, { method:'DELETE', headers:{'X-CSRF-Token':'<%= csrfToken %>'} });\n  211:             if (resp.ok) location.reload();\n  212:             else alert('Fehler beim Löschen');\n  213:         }\n  214:     </script>\n  215: </body>\n  216: </html>\n  217: ",
        "error": null
      },
      {
        "iteration": 6,
        "thought": "Need to see lines 110 to 200 of project-keyusers.ejs to find the table with 'Schulungsstatus' column and understand the current structure. Also need to check if there is any existing admin configuration for 'training objectives' or similar.",
        "tool": "read_file",
        "args": {
          "path": "ticketsystem/templates/project-keyusers.ejs",
          "start_line": 110,
          "end_line": 200
        },
        "result": "# ticketsystem/templates/project-keyusers.ejs (Zeilen 110-200)\n  110:                         </div>\n  111:                     </div>\n  112:                     <div class=\"flex items-center gap-3\">\n  113:                         <button type=\"submit\" id=\"keyUserSubmitButton\" class=\"btn-primary\">Key-User speichern</button>\n  114:                         <button type=\"button\" id=\"keyUserCancelButton\" class=\"btn-secondary hidden\" onclick=\"resetKeyUserForm()\">Abbrechen</button>\n  115:                     </div>\n  116:                 </form>\n  117:             </div>\n  118:         </div>\n  119:         <% } %>\n  120: \n  121:         <div class=\"card\">\n  122:             <div class=\"card-header\"><h2 class=\"text-lg font-semibold text-gray-900\">Zugewiesene Key-User</h2></div>\n  123:             <div class=\"card-body p-0\">\n  124:                 <div class=\"overflow-x-auto\">\n  125:                     <table class=\"min-w-full divide-y divide-gray-200\">\n  126:                         <thead class=\"bg-gray-50\">\n  127:                             <tr>\n  128:                                 <th class=\"px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase\">Name</th>\n  129:                                 <th class=\"px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase\">Kontakt</th>\n  130:                                 <th class=\"px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase\">Rolle</th>\n  131:                                 <th class=\"px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase\">Schulungsstatus</th>\n  132:                                 <th class=\"px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase\">Test-Protokoll</th>\n  133:                                 <th class=\"px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase\">Notizen</th>\n  134:                                 <% if (canManage) { %><th class=\"px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase\">Aktionen</th><% } %>\n  135:                             </tr>\n  136:                         </thead>\n  137:                         <tbody class=\"bg-white divide-y divide-gray-200\">\n  138:                             <% keyUsers.forEach(k => { %>\n  139:                             <tr>\n  140:                                 <td class=\"px-6 py-4 text-sm font-medium text-gray-900\"><%= k.name %></td>\n  141:                                 <td class=\"px-6 py-4 text-sm text-gray-500\">\n  142:                                     <div><%= k.email || '-' %></div>\n  143:                                     <div class=\"text-xs text-gray-400 mt-1\"><%= k.phone || 'Kein Telefon' %></div>\n  144:                                 </td>\n  145:                                 <td class=\"px-6 py-4\"><span class=\"badge text-xs <%= k.role === 'key_user' ? 'bg-blue-100 text-blue-800' : k.role === 'evaluator' ? 'bg-purple-100 text-purple-800' : 'bg-orange-100 text-orange-800' %>\"><%= {key_user:'Key-User',evaluator:'Evaluator',decision_maker:'Entscheider'}[k.role] %></span></td>\n  146:                                 <td class=\"px-6 py-4 text-sm text-gray-500 whitespace-pre-wrap\"><%= k.training_status || '-' %></td>\n  147:                                 <td class=\"px-6 py-4 text-sm text-gray-500 whitespace-pre-wrap\"><%= k.test_protocol || '-' %></td>\n  148:                                 <td class=\"px-6 py-4 text-sm text-gray-500 whitespace-pre-wrap\"><%= k.notes || '-' %></td>\n  149:                                 <% if (canManage) { %>\n  150:                                 <td class=\"px-6 py-4 text-sm\">\n  151:                                     <button\n  152:                                         class=\"mr-3 text-primary-600 hover:text-primary-800\"\n  153:                                         data-key-user='<%- JSON.stringify(k).replace(/'/g, \"&#39;\") %>'\n  154:                                         onclick='editKeyUser(this.dataset.keyUser)'>Bearbeiten</button>\n  155:                                    ",
        "error": null
      }
    ],
    "tokens": {
      "prompt": 27823,
      "completion": 4057
    }
  },
  "markdown": "> System: Ticketsystem (ID 4) · Repo: andreasknopke/Ticketsystem\n\n**Zusammenfassung:** Füge ein konfigurierbares Checkbox-System für Schulungsziele hinzu, das pro Projekt vom Admin verwaltet wird. Das Bestandstextfeld 'Schulungsstatus' bleibt erhalten.\n\n**Aufgabe:**\nErweitere die bestehende Projekt-Key-User-Seite um ein Admin-Panel zur Definition von Schulungszielen oberhalb der Tabelle. Implementiere Backend-Tabellen und API-Endpunkte zur Speicherung der Ziele pro Projekt und zur Erfassung der Auswahl pro Key-User. Modifiziere die bestehende Key-User-API, um die neuen Checkbox-Daten entgegenzunehmen, ohne das Legacy-Feld zu beeinträchtigen.\n\n**Change-Kind:** `extend`\n\n**Allowed Files:**\n- `ticketsystem/server.js`\n- `ticketsystem/templates/project-keyusers.ejs`\n\n**Schritte:**\n1. **1. Datenbankschema erweitern**\n   - In server.js (innerhalb der Datenbank-Initialisierung) die Tabellen project_training_goals und key_user_training_selections mit CREATE TABLE IF NOT EXISTS anlegen. Spalten: project_training_goals (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, label TEXT NOT NULL, sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (project_id) REFERENCES projects(id)). key_user_training_selections (id INTEGER PRIMARY KEY AUTOINCREMENT, key_user_id INTEGER NOT NULL, training_goal_id INTEGER NOT NULL, FOREIGN KEY (key_user_id) REFERENCES project_key_users(id), FOREIGN KEY (training_goal_id) REFERENCES project_training_goals(id), UNIQUE(key_user_id, training_goal_id)).\n   - Dateien: ticketsystem/server.js\n2. **2. Backend-Endpunkte und Logik**\n   - Server.js erweitern: Endpunkte GET/POST/PUT/DELETE /api/projects/:projectId/training-goals (Admin-only) zum Verwalten der Schulungsziele eines Projekts. Vorhandenen PUT /api/keyusers/:id so anpassen, dass ein neues Feld training_goal_ids (Array von IDs) akzeptiert wird, die Zuordnungen in key_user_training_selections aktualisiert (alte Einträge löschen und neue einfügen). GET-Route für die Projekt-Key-User-Seite (welche project-keyusers.ejs rendert) erweitern, um die Liste der Schulungsziele des Projekts sowie pro Key-User die ausgewählten Ziel-IDs mitzuliefern. Bestehendes Feld training_status unverändert lassen.\n   - Dateien: ticketsystem/server.js\n3. **3. Frontend-Anpassungen (project-keyusers.ejs)**\n   - Oberhalb der Key-User-Tabelle einen Admin-Bereich einfügen, der nur für Admins sichtbar ist. Dort können Schulungsziele in einer Liste von Textfeldern eingegeben, hinzugefügt und gelöscht werden (über die neuen API-Endpunkte). In jeder Key-User-Zeile das vorhandene textarea (training_status) belassen. Zusätzlich eine Checkbox-Gruppe mit allen definierten Zielen rendern, initial anhand der vom Server gelieferten Auswahl vorbelegt. Beim Speichern des Key-Users die selektierten Checkbox-IDs als JSON-Array im Formular mitsenden (z. B. als verstecktes Feld oder direkt im AJAX-Body). Die bestehende Funktionalität rund um training_status darf nicht verändert werden.\n   - Dateien: ticketsystem/templates/project-keyusers.ejs\n\n**Constraints:**\n- Das bestehende Textfeld 'Schulungsstatus' (textarea name='training_status') muss erhalten bleiben und weiterhin korrekt gespeichert/geladen werden.\n- Nur Benutzer mit Admin-Rolle dürfen Schulungsziele verwalten (Endpunkte und UI-Steuerelemente).\n- Die Schulungsziele sind pro Projekt eindeutig – jeder Projekt-Admin sieht nur seine eigenen Ziele.\n- Alle Datenbankabfragen müssen parametrisiert sein (SQL-Injection-Schutz).\n- Die bestehende Funktionalität der Key-User-API (PUT /api/keyusers/:id, DELETE /api/keyusers/:id) darf nicht gebrochen werden; das neue Feld training_goal_ids ist optional.\n- Die UI soll ohne Seitenneuladung auskommen – AJAX für das Verwalten der Ziele und das Speichern der Key-User-Checkboxen.\n\n**Risiken:**\n- Der genaue Aufbau der Projekte-Seite und die Route, die project-keyusers.ejs rendert, sind unbekannt; möglicherweise muss die Route identifiziert und angepasst werden.\n- Falls andere Stellen in server.js SELECT * FROM project_key_users verwenden, könnten diese durch die neuen Metadaten (z. B. Joins) nicht beeinträchtigt werden, müssen aber überprüft werden.\n- Die SQLite-Migration (CREATE TABLE IF NOT EXISTS) ist idempotent, aber bei geänderten Spalten sind manuelle Anpassungen nötig – für den ersten Entwurf ausreichend.\n- Client-seitiges dynamisches Generieren von Checkboxen beim Hinzufügen/Löschen von Zielen erfordert ggf. eine kleine Inline-JavaScript-Lösung, die stabil funktionieren muss.\n- Es besteht ein geringes Risiko, dass die Admin-Autorisierung in der PUT /api/keyusers/:id nicht auf training_goal_ids ausgeweitet wird – muss explizit geprüft werden.\n\n**Aufwand:** M\n\n**Verifizierte Fakten (Architect-Tools):**\n- File project-keyusers.ejs contains form for adding/editing key users (lines 70-110), with textarea 'training_status' (Schulungsstatus).\n- Schulungsstatus column exists in table header (line 131).\n- Server.js has table project_key_users with columns: id, project_id, name, email, phone, role, notes, training_status, test_protocol, created_at, updated_at.\n- API endpoints: /api/keyusers/:id (PUT) for update, /api/keyusers/:id (DELETE) for delete.\n\n_Basierend auf 6 Tool-Call(s)._",
  "_artifacts": [
    {
      "kind": "implementation_plan",
      "filename": "implementation_plan.md",
      "content": "**Zusammenfassung:** Füge ein konfigurierbares Checkbox-System für Schulungsziele hinzu, das pro Projekt vom Admin verwaltet wird. Das Bestandstextfeld 'Schulungsstatus' bleibt erhalten.\n\n**Aufgabe:**\nErweitere die bestehende Projekt-Key-User-Seite um ein Admin-Panel zur Definition von Schulungszielen oberhalb der Tabelle. Implementiere Backend-Tabellen und API-Endpunkte zur Speicherung der Ziele pro Projekt und zur Erfassung der Auswahl pro Key-User. Modifiziere die bestehende Key-User-API, um die neuen Checkbox-Daten entgegenzunehmen, ohne das Legacy-Feld zu beeinträchtigen.\n\n**Change-Kind:** `extend`\n\n**Allowed Files:**\n- `ticketsystem/server.js`\n- `ticketsystem/templates/project-keyusers.ejs`\n\n**Schritte:**\n1. **1. Datenbankschema erweitern**\n   - In server.js (innerhalb der Datenbank-Initialisierung) die Tabellen project_training_goals und key_user_training_selections mit CREATE TABLE IF NOT EXISTS anlegen. Spalten: project_training_goals (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, label TEXT NOT NULL, sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (project_id) REFERENCES projects(id)). key_user_training_selections (id INTEGER PRIMARY KEY AUTOINCREMENT, key_user_id INTEGER NOT NULL, training_goal_id INTEGER NOT NULL, FOREIGN KEY (key_user_id) REFERENCES project_key_users(id), FOREIGN KEY (training_goal_id) REFERENCES project_training_goals(id), UNIQUE(key_user_id, training_goal_id)).\n   - Dateien: ticketsystem/server.js\n2. **2. Backend-Endpunkte und Logik**\n   - Server.js erweitern: Endpunkte GET/POST/PUT/DELETE /api/projects/:projectId/training-goals (Admin-only) zum Verwalten der Schulungsziele eines Projekts. Vorhandenen PUT /api/keyusers/:id so anpassen, dass ein neues Feld training_goal_ids (Array von IDs) akzeptiert wird, die Zuordnungen in key_user_training_selections aktualisiert (alte Einträge löschen und neue einfügen). GET-Route für die Projekt-Key-User-Seite (welche project-keyusers.ejs rendert) erweitern, um die Liste der Schulungsziele des Projekts sowie pro Key-User die ausgewählten Ziel-IDs mitzuliefern. Bestehendes Feld training_status unverändert lassen.\n   - Dateien: ticketsystem/server.js\n3. **3. Frontend-Anpassungen (project-keyusers.ejs)**\n   - Oberhalb der Key-User-Tabelle einen Admin-Bereich einfügen, der nur für Admins sichtbar ist. Dort können Schulungsziele in einer Liste von Textfeldern eingegeben, hinzugefügt und gelöscht werden (über die neuen API-Endpunkte). In jeder Key-User-Zeile das vorhandene textarea (training_status) belassen. Zusätzlich eine Checkbox-Gruppe mit allen definierten Zielen rendern, initial anhand der vom Server gelieferten Auswahl vorbelegt. Beim Speichern des Key-Users die selektierten Checkbox-IDs als JSON-Array im Formular mitsenden (z. B. als verstecktes Feld oder direkt im AJAX-Body). Die bestehende Funktionalität rund um training_status darf nicht verändert werden.\n   - Dateien: ticketsystem/templates/project-keyusers.ejs\n\n**Constraints:**\n- Das bestehende Textfeld 'Schulungsstatus' (textarea name='training_status') muss erhalten bleiben und weiterhin korrekt gespeichert/geladen werden.\n- Nur Benutzer mit Admin-Rolle dürfen Schulungsziele verwalten (Endpunkte und UI-Steuerelemente).\n- Die Schulungsziele sind pro Projekt eindeutig – jeder Projekt-Admin sieht nur seine eigenen Ziele.\n- Alle Datenbankabfragen müssen parametrisiert sein (SQL-Injection-Schutz).\n- Die bestehende Funktionalität der Key-User-API (PUT /api/keyusers/:id, DELETE /api/keyusers/:id) darf nicht gebrochen werden; das neue Feld training_goal_ids ist optional.\n- Die UI soll ohne Seitenneuladung auskommen – AJAX für das Verwalten der Ziele und das Speichern der Key-User-Checkboxen.\n\n**Risiken:**\n- Der genaue Aufbau der Projekte-Seite und die Route, die project-keyusers.ejs rendert, sind unbekannt; möglicherweise muss die Route identifiziert und angepasst werden.\n- Falls andere Stellen in server.js SELECT * FROM project_key_users verwenden, könnten diese durch die neuen Metadaten (z. B. Joins) nicht beeinträchtigt werden, müssen aber überprüft werden.\n- Die SQLite-Migration (CREATE TABLE IF NOT EXISTS) ist idempotent, aber bei geänderten Spalten sind manuelle Anpassungen nötig – für den ersten Entwurf ausreichend.\n- Client-seitiges dynamisches Generieren von Checkboxen beim Hinzufügen/Löschen von Zielen erfordert ggf. eine kleine Inline-JavaScript-Lösung, die stabil funktionieren muss.\n- Es besteht ein geringes Risiko, dass die Admin-Autorisierung in der PUT /api/keyusers/:id nicht auf training_goal_ids ausgeweitet wird – muss explizit geprüft werden.\n\n**Aufwand:** M\n\n**Verifizierte Fakten (Architect-Tools):**\n- File project-keyusers.ejs contains form for adding/editing key users (lines 70-110), with textarea 'training_status' (Schulungsstatus).\n- Schulungsstatus column exists in table header (line 131).\n- Server.js has table project_key_users with columns: id, project_id, name, email, phone, role, notes, training_status, test_protocol, created_at, updated_at.\n- API endpoints: /api/keyusers/:id (PUT) for update, /api/keyusers/:id (DELETE) for delete.\n\n_Basierend auf 6 Tool-Call(s)._"
    }
  ]
}
```
