// Tests für das Ticketsystem
// Aufruf: node tests/test.js
// Startet den Server, führt Tests aus, stoppt den Server

const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Port wird zur Laufzeit gesucht, damit ein belegter Port den Lauf nicht blockiert.
let PORT = 0;
let BASE = '';
// Eigene Datenbank pro Testlauf: kein Test darf die Entwicklungs-DB anfassen.
const TEST_DB = path.join(__dirname, 'test.db');
let SERVER_ENV = {};

function findFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

let serverProcess = null;
let failures = 0;
let passed = 0;

function log(emoji, msg) {
    console.log(`  ${emoji} ${msg}`);
}

function ok(msg) { passed++; log('✅', msg); }
function fail(msg) { failures++; log('❌', msg); }

function assert(condition, msg) {
    if (condition) ok(msg);
    else fail(msg);
}

function request(method, path, data, cookie) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'localhost', port: PORT, path, method,
            headers: {}
        };
        if (cookie) opts.headers['Cookie'] = cookie;
        if (data && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
            if (typeof data === 'object' && path.startsWith('/api/')) {
                const body = JSON.stringify(data);
                opts.headers['Content-Type'] = 'application/json';
                opts.headers['Content-Length'] = Buffer.byteLength(body);
                opts.body = body;
            } else if (typeof data === 'object') {
                const body = new URLSearchParams(data).toString();
                opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                opts.headers['Content-Length'] = Buffer.byteLength(body);
                opts.body = body;
            }
        }
        const req = http.request(opts, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { body = JSON.parse(body); } catch(e) {}
                resolve({ status: res.statusCode, body, cookie: res.headers['set-cookie'] });
            });
        });
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

function parseCookie(sc) {
    if (!sc) return '';
    return sc.map(c => c.split(';')[0]).join('; ');
}

function isServerUp() {
    return new Promise((resolve) => {
        const req = http.get(`${BASE}/login`, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
}

function waitForServer(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = async () => {
            if (await isServerUp()) return resolve();
            if (Date.now() > deadline) return reject(new Error('Server nicht erreichbar.'));
            setTimeout(tick, 250);
        };
        tick();
    });
}

function runScript(script, timeoutMs = 60000) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [script], {
            cwd: path.join(__dirname, '..'),
            env: SERVER_ENV,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        child.stdout.on('data', (d) => { output += d; });
        child.stderr.on('data', (d) => { output += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, output });
        });
    });
}

// seed_db.js loggt Fehler pro Insert und endet trotzdem mit 0. Ohne diese
// Pruefung laufen 30 Assertions gegen eine leere DB und das eigentliche
// Problem (z.B. eine gesperrte Datei) bleibt unsichtbar.
function countRows(table) {
    return new Promise((resolve, reject) => {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(TEST_DB, sqlite3.OPEN_READONLY, (err) => {
            if (err) reject(err);
        });
        db.get(`SELECT COUNT(*) AS c FROM ${table}`, (err, row) => {
            db.close();
            if (err) reject(err);
            else resolve(row ? row.c : 0);
        });
    });
}

async function startServer() {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch (_) {}
    }

    PORT = await findFreePort();
    BASE = `http://localhost:${PORT}`;
    SERVER_ENV = {
        ...process.env,
        PORT: String(PORT),
        DB_FILE: TEST_DB,
        APP_SECRET: 'test-secret',
        ADMIN_USER: 'admin',
        ADMIN_PASS: 'ticketmaster',
        NODE_ENV: 'test'
    };

    serverProcess = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: SERVER_ENV,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', () => {});
    serverProcess.stderr.on('data', (d) => process.stderr.write(d));

    await waitForServer();

    // Tabellen existieren jetzt; Seed deterministisch einspielen.
    const seed = await runScript(path.join('scripts', 'seed_db.js'));
    if (seed.code !== 0) {
        console.error('Seed fehlgeschlagen:\n' + seed.output);
        throw new Error('Seed fehlgeschlagen');
    }

    const seeded = await countRows('hospitals');
    if (seeded === 0) {
        console.error('Seed hat keine Daten geschrieben:\n' + seed.output);
        throw new Error('Seed ohne Ergebnis (DB gesperrt oder Schema unerwartet)');
    }
    return true;
}

async function stopServer(ownsServer) {
    if (!ownsServer || !serverProcess) return;
    const child = serverProcess;
    serverProcess = null;
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
    });
    // Warten, bis der Port wirklich frei ist – sonst startet der naechste Lauf
    // gegen einen Server, der gerade herunterfaehrt.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await isServerUp()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function login() {
    const page = await request('GET', '/login');
    const match = (typeof page.body === 'string' ? page.body : '').match(/name="_csrf" value="([^"]+)"/);
    const csrf = match ? match[1] : '';
    const jar = parseCookie(page.cookie);
    const loginResp = await request('POST', '/login', { username:'admin', password:'ticketmaster', _csrf:csrf }, jar);
    return parseCookie(loginResp.cookie) || jar;
}

async function main() {
    console.log('\n🧪  Ticketsystem Test Suite');
    console.log('═══════════════════════════\n');

    const ownsServer = await startServer();

    // --- Auth Tests ---
    console.log('📌 Auth');
    const jar = await login();
    assert(jar.length > 0, 'Login erfolgreich');

    // --- API: Krankenhaeuser und Abteilungen ---
    console.log('\n📌 API: Krankenhäuser & Abteilungen');
    let resp = await request('GET', '/api/hospitals', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body) && resp.body.length >= 1, 'GET /api/hospitals (' + (resp.body.length || 0) + ')');

    resp = await request('GET', '/api/departments', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body) && resp.body.length >= 1, 'GET /api/departments (' + (resp.body.length || 0) + ')');

    resp = await request('POST', '/api/departments', { name:'  ' }, jar);
    assert(resp.status === 400, 'POST /api/departments ohne Namen -> 400');

    resp = await request('POST', '/api/departments', { name:'Test-Abteilung' }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/departments (erstellt)');
    const testDepartmentId = resp.body.id;

    resp = await request('POST', '/api/departments', { name:'Test-Abteilung' }, jar);
    assert(resp.status === 409, 'POST /api/departments Duplikat -> 409');

    // --- API: Projects ---
    console.log('\n📌 API: Projekte');
    resp = await request('GET', '/api/projects', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body) && resp.body.length >= 2, 'GET /api/projects (' + (resp.body.length || 0) + ' Projekte)');

    resp = await request('GET', '/api/projects/1', null, jar);
    assert(resp.status === 200 && resp.body.name === 'CuraFlow', 'GET /api/projects/1 (CuraFlow)');

    resp = await request('GET', '/api/projects/1', null, jar);
    assert(resp.body.department_id && resp.body.department_name, 'Bestandsprojekt hat Abteilung (Backfill)');

    resp = await request('POST', '/api/projects', { name:'Projekt ohne Abteilung', status:'planning' }, jar);
    assert(resp.status === 400, 'POST /api/projects ohne department_id -> 400');

    resp = await request('POST', '/api/projects', { name:'Test-Projekt', description:'Test', system_id:1, status:'planning', department_id: testDepartmentId }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/projects (erstellt)');
    const testProjId = resp.body.id;

    resp = await request('GET', '/api/projects/' + testProjId, null, jar);
    assert(resp.status === 200 && resp.body.department_id === testDepartmentId, 'Projekt verweist auf die gewaehlte Abteilung');

    resp = await request('PATCH', '/api/projects/' + testProjId, { status:'active' }, jar);
    assert(resp.status === 200 && resp.body.status === 'updated', 'PATCH /api/projects/' + testProjId);

    // --- API: Milestones ---
    console.log('\n📌 API: Meilensteine');
    resp = await request('GET', '/api/projects/1/milestones', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body) && resp.body.length === 6, 'GET /api/projects/1/milestones (6 Meilensteine)');

    resp = await request('POST', '/api/projects/1/milestones', { title:'Test-Meilenstein', phase:1, status:'pending' }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/projects/1/milestones (erstellt)');
    const msId = resp.body.id;

    resp = await request('PATCH', '/api/milestones/' + msId, { status:'completed' }, jar);
    assert(resp.status === 200, 'PATCH /api/milestones/' + msId + ' (Status auf completed)');

    resp = await request('DELETE', '/api/milestones/' + msId, null, jar);
    assert(resp.status === 200, 'DELETE /api/milestones/' + msId);

    // --- API: Key Users ---
    console.log('\n📌 API: Key-User');
    resp = await request('GET', '/api/projects/1/keyusers', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body) && resp.body.length >= 2, 'GET /api/projects/1/keyusers (' + (resp.body.length || 0) + ' Key-User)');

    resp = await request('POST', '/api/projects/1/keyusers', { name:'Test-Key-User', staff_id:3, role:'evaluator' }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/projects/1/keyusers (erstellt)');
    const kuId = resp.body.id;

    resp = await request('DELETE', '/api/keyusers/' + kuId, null, jar);
    assert(resp.status === 200, 'DELETE /api/keyusers/' + kuId);

    // --- API: Termine und extrahiertes Wissen ---
    console.log('\n📌 API: Termine & Wissen');

    resp = await request('POST', '/api/projects/' + testProjId + '/keyusers', { name:'Dr. Test', role:'key_user' }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST Key-User im Test-Projekt');
    const testKuId = resp.body.id;

    resp = await request('POST', '/api/projects/' + testProjId + '/meetings', {
        title:'Onboarding Test', meeting_date:'2026-03-01'
    }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST Termin im Test-Projekt');
    const meetingId = resp.body.id;

    resp = await request('POST', '/api/meetings/' + meetingId + '/participants', { key_user_ids:[testKuId] }, jar);
    assert(resp.status === 200 && resp.body.key_user_ids.length === 1, 'POST Teilnehmer am Termin');

    resp = await request('POST', '/api/meetings/' + meetingId + '/participants', { key_user_ids:[999999] }, jar);
    assert(resp.status === 404, 'Teilnehmer aus fremdem Projekt -> 404');

    resp = await request('GET', '/api/projects/' + testProjId + '/meetings', null, jar);
    const listedMeeting = (resp.body || []).find(m => m.id === meetingId);
    assert(listedMeeting && listedMeeting.participants.length === 1, 'Terminliste enthaelt Teilnehmer');
    assert(listedMeeting && listedMeeting.has_transcript === 0, 'Terminliste meldet has_transcript=0');
    assert(listedMeeting && listedMeeting.transcript === undefined, 'Terminliste enthaelt kein Transkript');

    resp = await request('PUT', '/api/meetings/' + meetingId + '/transcript', { transcript:'Gespräch über Abläufe – Umlaute äöü' }, jar);
    assert(resp.status === 200, 'PUT Transkript');

    resp = await request('GET', '/api/meetings/' + meetingId + '/transcript', null, jar);
    assert(resp.status === 200 && resp.body.transcript.includes('Umlaute äöü'), 'GET Transkript (Roundtrip)');

    resp = await request('POST', '/api/meetings/' + meetingId + '/workflows', { name:'Dienstplan', description:'Dienstplan per Excel' }, jar);
    assert(resp.status === 201 && resp.body.department_id === testDepartmentId, 'POST Workflow (Abteilung abgeleitet)');
    const workflowId = resp.body.id;

    resp = await request('GET', '/api/projects/' + testProjId + '/workflows', null, jar);
    const namedWorkflow = (resp.body || []).find(w => w.id === workflowId);
    assert(namedWorkflow && namedWorkflow.name === 'Dienstplan', 'Workflow-Name wird gespeichert');

    resp = await request('POST', '/api/meetings/' + meetingId + '/problems', { title:'Excel bricht bei >50 Personen', workflow_id: workflowId }, jar);
    assert(resp.status === 201 && resp.body.department_id === testDepartmentId, 'POST Problem (Abteilung abgeleitet)');
    const problemId = resp.body.id;

    resp = await request('POST', '/api/meetings/' + meetingId + '/problems', { title:'Ohne Titel-Konflikt', workflow_id: 999999 }, jar);
    assert(resp.status === 400, 'Problem mit fremdem Workflow -> 400');

    resp = await request('POST', '/api/meetings/' + meetingId + '/problems', { title:'   ' }, jar);
    assert(resp.status === 400, 'Problem ohne Titel -> 400');

    resp = await request('POST', '/api/meetings/' + meetingId + '/adoption-risks', { title:'Keine Zeit zum Lernen' }, jar);
    assert(resp.status === 201, 'POST Adoptionsrisiko');

    resp = await request('GET', '/api/projects/' + testProjId + '/problems', null, jar);
    assert(resp.status === 200 && resp.body.some(p => p.id === problemId), 'GET Projekt-Probleme enthaelt Eintrag');

    resp = await request('GET', '/api/projects/' + testProjId + '/workflows', null, jar);
    assert(resp.status === 200 && resp.body.some(w => w.id === workflowId), 'GET Projekt-Workflows enthaelt Eintrag');

    resp = await request('GET', '/api/projects/' + testProjId + '/adoption-risks', null, jar);
    assert(resp.status === 200 && resp.body.length === 1, 'GET Projekt-Adoptionsrisiken enthaelt Eintrag');

    resp = await request('DELETE', '/api/problems/' + problemId, null, jar);
    assert(resp.status === 200, 'DELETE Problem');

    // --- API: Flow Analysis (Eintraege ohne Termin) ---
    console.log('\n📌 API: Flow Analysis');

    resp = await request('GET', '/project/' + testProjId + '/flow', null, jar);
    assert(resp.status === 200, 'GET /project/:id/flow (200 OK)');

    resp = await request('POST', '/api/projects/' + testProjId + '/workflows', {
        name:'Wochenplan erstellen', description:'Dienstplan als Excel-Liste'
    }, jar);
    assert(resp.status === 201 && resp.body.project_id === testProjId, 'Workflow direkt im Projekt');
    assert(resp.body.meeting_id === null, 'Direkter Workflow hat keinen Termin');
    const directWorkflowId = resp.body.id;

    // Ohne Namen dient die erste Zeile der Beschreibung als Ueberschrift.
    resp = await request('POST', '/api/projects/' + testProjId + '/workflows', {
        description:'Entlassungsbrief\nArzt diktiert, Pflege prueft'
    }, jar);
    assert(resp.status === 201, 'Workflow ohne Namen wird angelegt');
    const unnamedWorkflowId = resp.body.id;

    resp = await request('GET', '/api/projects/' + testProjId + '/workflows', null, jar);
    const workflowsNow = resp.body || [];
    const derived = workflowsNow.find(w => w.id === unnamedWorkflowId);
    assert(derived && derived.name === 'Entlassungsbrief', 'Name wird aus der ersten Zeile abgeleitet');
    assert(workflowsNow.some(w => w.id === directWorkflowId), 'mehrere Workflows je Projekt moeglich');

    resp = await request('POST', '/api/projects/' + testProjId + '/problems', {
        title:'Excel bricht bei vielen Zeilen', workflow_id: directWorkflowId
    }, jar);
    assert(resp.status === 201 && resp.body.meeting_id === null, 'Problem direkt im Projekt');
    const directProblemId = resp.body.id;

    resp = await request('POST', '/api/projects/' + testProjId + '/adoption-risks', {
        title:'Keine Zeit fuer Schulung'
    }, jar);
    assert(resp.status === 201 && resp.body.meeting_id === null, 'Adoptionsrisiko direkt im Projekt');

    resp = await request('POST', '/api/projects/' + testProjId + '/problems', { title:'   ' }, jar);
    assert(resp.status === 400, 'Direktes Problem ohne Titel -> 400');

    resp = await request('POST', '/api/projects/999999/problems', { title:'X' }, jar);
    assert(resp.status === 404, 'Problem in unbekanntem Projekt -> 404');

    // Workflow aus einem anderen Projekt darf nicht verknuepft werden.
    resp = await request('POST', '/api/meetings/' + meetingId + '/workflows', {
        description:'Workflow im Testprojekt'
    }, jar);
    const foreignWorkflowId = resp.body.id;
    resp = await request('POST', '/api/projects/1/problems', {
        title:'Fremder Workflow', workflow_id: foreignWorkflowId
    }, jar);
    assert(resp.status === 400, 'Workflow aus fremdem Projekt -> 400');

    resp = await request('GET', '/api/projects/' + testProjId + '/problems', null, jar);
    assert(resp.body.some(p => p.id === directProblemId), 'Projektliste enthaelt direktes Problem');

    // Bearbeiten (PATCH) je Wissensart
    resp = await request('PATCH', '/api/workflows/' + directWorkflowId, {
        name:'Wochenplan', description:'Dienstplan als Excel-Liste, Stand 2026'
    }, jar);
    assert(resp.status === 200 && resp.body.description.includes('Stand 2026'), 'Workflow bearbeiten');
    assert(resp.body.name === 'Wochenplan', 'Workflow-Name bearbeiten');

    // Name allein laesst sich ebenfalls aendern (Teil-Update).
    resp = await request('PATCH', '/api/workflows/' + directWorkflowId, { name:'Wochenplan neu' }, jar);
    assert(resp.status === 200 && resp.body.name === 'Wochenplan neu', 'Workflow-Name allein bearbeiten');

    resp = await request('PATCH', '/api/problems/' + directProblemId, {
        title:'Excel bricht bei vielen Zeilen', description:'ab ca. 50 Personen'
    }, jar);
    assert(resp.status === 200 && resp.body.title === 'Excel bricht bei vielen Zeilen', 'Problem bearbeiten');
    assert(resp.body.description === undefined || resp.body.description === 'ab ca. 50 Personen', 'Problem-Beschreibung gespeichert');

    resp = await request('GET', '/api/projects/' + testProjId + '/problems', null, jar);
    const editedProblem = (resp.body || []).find(p => p.id === directProblemId);
    assert(editedProblem && editedProblem.description === 'ab ca. 50 Personen', 'Bearbeitete Beschreibung wird gelesen');

    resp = await request('PATCH', '/api/adoption-risks/999999', { title:'X' }, jar);
    assert(resp.status === 404, 'Bearbeiten unbekannter Eintrag -> 404');

    resp = await request('PATCH', '/api/problems/' + directProblemId, { title:'   ' }, jar);
    assert(resp.status === 400, 'Bearbeiten ohne Titel -> 400');

    // Workflow-Zuordnung per PATCH (Teil-Update ohne Titel).
    resp = await request('PATCH', '/api/problems/' + directProblemId, { workflow_id: directWorkflowId }, jar);
    assert(resp.status === 200 && resp.body.workflow_id === directWorkflowId, 'Workflow-Zuordnung per PATCH');

    resp = await request('POST', '/api/projects/1/workflows', { description:'Fremder Workflow' }, jar);
    const foreignProjectWorkflowId = resp.body.id;
    resp = await request('PATCH', '/api/problems/' + directProblemId, { workflow_id: foreignProjectWorkflowId }, jar);
    assert(resp.status === 400, 'PATCH mit fremdem Workflow -> 400');
    await request('DELETE', '/api/workflows/' + foreignProjectWorkflowId, null, jar);

    resp = await request('DELETE', '/api/problems/' + directProblemId, null, jar);
    assert(resp.status === 200, 'Direktes Problem loeschen');

    // --- API: KI-Zusammenfassung (Vorschau, ohne Modellaufruf) ---
    console.log('\n📌 API: Flow-Zusammenfassung');

    resp = await request('GET', '/api/projects/' + testProjId + '/flow-summary', null, jar);
    assert(resp.status === 200 && resp.body.latest === null, 'GET flow-summary ohne Zusammenfassung');

    // Ein Problem anlegen, damit die Vorschau alle Wissensarten zaehlt.
    resp = await request('POST', '/api/projects/' + testProjId + '/problems', {
        title:'Fuer die Zusammenfassung'
    }, jar);
    const summaryProblemId = resp.body.id;

    resp = await request('POST', '/api/projects/' + testProjId + '/flow-summary', {
        dry_run: true
    }, jar);
    assert(resp.status === 200 && resp.body.dry_run === true, 'POST flow-summary dry_run');
    assert(typeof resp.body.input === 'string' && resp.body.input.includes('Test-Projekt'),
        'Vorschau enthaelt den Projektnamen');
    assert(resp.body.stats.transcripts >= 1, 'Vorschau zaehlt Transkripte');
    assert(resp.body.stats.workflows >= 1, 'Vorschau zaehlt Workflows');
    assert(resp.body.stats.problems >= 1, 'Vorschau zaehlt Probleme');

    // Kontaktdaten aus dem Transkript muessen vor dem Aufruf redigiert sein.
    await request('PUT', '/api/meetings/' + meetingId + '/transcript', {
        transcript:'Kontakt: mara.koenig@projekt.example, Telefon +49 30 555 0101. Ablauf per Excel.'
    }, jar);
    resp = await request('POST', '/api/projects/' + testProjId + '/flow-summary', {
        dry_run: true
    }, jar);
    assert(resp.status === 200, 'Vorschau mit Transkript');
    assert(!resp.body.input.includes('mara.koenig@projekt.example'), 'E-Mail wird redigiert');
    assert(resp.body.input.includes('[REDACTED_EMAIL]'), 'Redaction-Platzhalter sichtbar');
    assert(resp.body.redaction_hits.length >= 1, 'Redaction-Treffer werden gemeldet');

    resp = await request('POST', '/api/projects/999999/flow-summary', { dry_run: true }, jar);
    assert(resp.status === 404, 'Zusammenfassung fuer unbekanntes Projekt -> 404');

    await request('DELETE', '/api/problems/' + summaryProblemId, null, jar);

    // --- API: Key-User verschieben (manuelle Migration) ---
    console.log('\n📌 API: Key-User verschieben');

    resp = await request('POST', '/api/projects/1/training-goals', { label:'Migrationsziel' }, jar);
    assert(resp.status === 201 && resp.body.id, 'Schulungsziel im Quellprojekt');
    const goalId = resp.body.id;

    resp = await request('POST', '/api/projects/1/keyusers', {
        name:'Migrations-Key-User', role:'key_user', training_goal_ids:[goalId],
        notes:'Stationsleitung', training_status:'Basisschulung', test_protocol:'Pilot ok'
    }, jar);
    assert(resp.status === 201 && resp.body.id, 'Key-User im Quellprojekt');
    const moveKuId = resp.body.id;

    resp = await request('POST', '/api/projects/1/meetings', {
        title:'Termin vor Migration', meeting_date:'2026-04-01'
    }, jar);
    const moveMeetingId = resp.body.id;
    resp = await request('POST', '/api/projects/1/meetings', {
        title:'Termin mit Key-User', meeting_date:'2026-04-02', key_user_id: moveKuId
    }, jar);
    const ownedMeetingId = resp.body.id;

    resp = await request('GET', '/api/projects/1/keyusers', null, jar);
    const beforeMove = (resp.body || []).find(k => k.id === moveKuId);
    assert(beforeMove && beforeMove.training_goal_ids.length === 1, 'Schulungsziel ist vorher zugeordnet');

    resp = await request('PATCH', '/api/keyusers/' + moveKuId + '/project', { project_id: 1 }, jar);
    assert(resp.status === 400, 'Verschieben in dasselbe Projekt -> 400');

    resp = await request('PATCH', '/api/keyusers/' + moveKuId + '/project', { project_id: 999999 }, jar);
    assert(resp.status === 400, 'Verschieben in unbekanntes Projekt -> 400');

    resp = await request('PATCH', '/api/keyusers/999999/project', { project_id: testProjId }, jar);
    assert(resp.status === 404, 'Unbekannter Key-User -> 404');

    resp = await request('PATCH', '/api/keyusers/' + moveKuId + '/project', {
        project_id: testProjId, move_meetings: false
    }, jar);
    assert(resp.status === 200 && resp.body.project_id === testProjId, 'Key-User verschoben');
    assert(resp.body.moved_training_goals === 1, 'Schulungsziele wandern mit');
    assert(resp.body.detached_meetings === 1, 'Termine ohne Mitnahme abgehaengt');

    resp = await request('GET', '/api/projects/' + testProjId + '/keyusers', null, jar);
    assert((resp.body || []).some(k => k.id === moveKuId), 'Key-User liegt im Zielprojekt');
    const afterMove = (resp.body || []).find(k => k.id === moveKuId);
    assert(afterMove.training_goal_ids.length === 1, 'Schulungsziel ist im Zielprojekt zugeordnet');

    // Das Ziel muss im Zielprojekt existieren und darf nicht doppelt angelegt sein.
    resp = await request('GET', '/api/projects/' + testProjId + '/training-goals', null, jar);
    const migratedGoals = (resp.body || []).filter(g => g.label === 'Migrationsziel');
    assert(migratedGoals.length === 1, 'Schulungsziel wird im Zielprojekt angelegt');
    assert(migratedGoals[0].id === afterMove.training_goal_ids[0], 'Zuordnung zeigt auf das Ziel im Zielprojekt');

    // Freitext-Felder muessen den Projektwechsel ueberleben.
    assert(afterMove.notes === 'Stationsleitung', 'Notizen bleiben beim Verschieben erhalten');
    assert(afterMove.training_status === 'Basisschulung', 'Schulungsstatus bleibt erhalten');
    assert(afterMove.test_protocol === 'Pilot ok', 'Test-Protokoll bleibt erhalten');

    // Speichern im Zielprojekt (wie das Bearbeiten-Formular) darf nichts leeren.
    resp = await request('POST', '/api/projects/' + testProjId + '/keyusers', {
        id: moveKuId, name:'Migrations-Key-User', role:'key_user',
        notes:'Stationsleitung', training_status:'Basisschulung', test_protocol:'Pilot ok'
    }, jar);
    assert(resp.status === 200, 'Bearbeiten im Zielprojekt');

    resp = await request('GET', '/api/projects/' + testProjId + '/keyusers', null, jar);
    const afterSave = (resp.body || []).find(k => k.id === moveKuId);
    assert(afterSave.notes === 'Stationsleitung' && afterSave.training_status === 'Basisschulung'
        && afterSave.test_protocol === 'Pilot ok', 'Felder bleiben nach dem Speichern im Zielprojekt');

    resp = await request('GET', '/api/projects/1/keyusers', null, jar);
    assert(!(resp.body || []).some(k => k.id === moveKuId), 'Key-User ist aus dem Quellprojekt entfernt');

    resp = await request('GET', '/api/projects/1/meetings', null, jar);
    const detached = (resp.body || []).find(m => m.id === ownedMeetingId);
    assert(detached && detached.key_user_id === null, 'Abgehaengter Termin bleibt im Quellprojekt');

    // Mitgenommene Termine: zurueck in Projekt 1, dann erneut mit Mitnahme verschieben.
    resp = await request('PATCH', '/api/keyusers/' + moveKuId + '/project', {
        project_id: 1, move_meetings: true
    }, jar);
    assert(resp.status === 200 && resp.body.moved_meetings === 0, 'Rueckverschieben ohne eigene Termine');
    assert(resp.body.moved_training_goals === 1, 'Schulungsziel wandert zurueck');

    // Zurueck im Quellprojekt: vorhandenes Ziel wird wiederverwendet, nicht dupliziert.
    resp = await request('GET', '/api/projects/1/training-goals', null, jar);
    assert((resp.body || []).filter(g => g.label === 'Migrationsziel').length === 1, 'Vorhandenes Ziel wird wiederverwendet');

    resp = await request('POST', '/api/projects/1/meetings', {
        title:'Termin fuer Mitnahme', meeting_date:'2026-04-03', key_user_id: moveKuId
    }, jar);
    const beforeMoveMeetingId = resp.body.id;

    resp = await request('PATCH', '/api/keyusers/' + moveKuId + '/project', {
        project_id: testProjId, move_meetings: true
    }, jar);
    assert(resp.status === 200 && resp.body.moved_meetings === 1, 'Termin wandert mit');

    resp = await request('GET', '/api/projects/' + testProjId + '/meetings', null, jar);
    assert((resp.body || []).some(m => m.id === beforeMoveMeetingId), 'Mitgewanderter Termin liegt im Zielprojekt');

    // Explizite Label-Liste (so schickt es das Formular): fehlende Ziele werden
    // im Zielprojekt angelegt.
    resp = await request('PATCH', '/api/keyusers/' + moveKuId + '/project', {
        project_id: 1, move_meetings: false,
        training_goal_labels: ['Migrationsziel', 'Zusatzziel']
    }, jar);
    assert(resp.status === 200 && resp.body.moved_training_goals === 2, 'Explizite Ziel-Labels werden uebernommen');

    resp = await request('GET', '/api/projects/1/training-goals', null, jar);
    const extraGoal = (resp.body || []).find(g => g.label === 'Zusatzziel');
    assert(Boolean(extraGoal), 'Fehlendes Ziel wird im Zielprojekt angelegt');

    resp = await request('GET', '/api/projects/1/keyusers', null, jar);
    const finalState = (resp.body || []).find(k => k.id === moveKuId);
    assert(finalState && finalState.training_goal_ids.length === 2, 'Beide Ziele sind dem Key-User zugeordnet');

    // Zugeordnete Ziele lassen sich nicht loeschen (409) - vorher loesen.
    resp = await request('POST', '/api/projects/1/keyusers', {
        id: moveKuId, name:'Migrations-Key-User', role:'key_user', training_goal_ids: []
    }, jar);
    assert(resp.status === 200, 'Zielzuordnungen geloest');

    if (extraGoal) await request('DELETE', '/api/projects/1/training-goals/' + extraGoal.id, null, jar);
    resp = await request('DELETE', '/api/projects/1/training-goals/' + goalId, null, jar);
    assert(resp.status === 200, 'Schulungsziel aufgeraeumt');

    // --- API: Documents ---
    console.log('\n📌 API: Wiki-Dokumente');
    resp = await request('GET', '/api/projects/1/docs', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body) && resp.body.length >= 2, 'GET /api/projects/1/docs (' + (resp.body.length || 0) + ' Seiten)');

    resp = await request('GET', '/api/projects/1/docs/einleitung', null, jar);
    assert(resp.status === 200 && resp.body.title === 'Einleitung', 'GET /api/projects/1/docs/einleitung');

    resp = await request('POST', '/api/projects/1/docs', { title:'Test', slug:'test-page', content:'# Test\n\nTest content' }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/projects/1/docs (erstellt)');
    const docId = resp.body.id;

    resp = await request('PATCH', '/api/docs/' + docId, { content:'# Updated' }, jar);
    assert(resp.status === 200, 'PATCH /api/docs/' + docId);

    resp = await request('DELETE', '/api/docs/' + docId, null, jar);
    assert(resp.status === 200, 'DELETE /api/docs/' + docId);

    // --- API: GitHub ---
    console.log('\n📌 API: GitHub');
    resp = await request('GET', '/api/projects/1/github', null, jar);
    assert(resp.status === 200, 'GET /api/projects/1/github');

    resp = await request('POST', '/api/projects/1/github', {
        repo_owner:'test-owner', repo_name:'test-repo', access_token:'ghp_test',
        webhook_secret:'test-secret', sync_issues:1, sync_wiki:0
    }, jar);
    assert(resp.status === 200 || resp.status === 201, 'POST /api/projects/1/github (konfiguriert)');

    // --- API: Markdown ---
    console.log('\n📌 API: Markdown');
    resp = await request('POST', '/api/markdown/render', { text:'# Hello\n\n**bold** text' }, jar);
    assert(resp.status === 200 && resp.body.html && resp.body.html.includes('<h1'), 'POST /api/markdown/render (Markdown -> HTML)');

    // --- Web UI: Pages ---
    console.log('\n📌 Web UI: Seiten');
    const pages = [
        ['/', '/'],
        ['/projects', '/projects'],
        ['/project/1', '/project/1'],
        ['/project/1/timeline', '/project/1/timeline'],
        ['/project/1/milestones', '/project/1/milestones'],
        ['/project/1/keyusers', '/project/1/keyusers'],
        ['/project/1/meetings', '/project/1/meetings'],
        ['/project/1/docs', '/project/1/docs'],
        ['/project/1/docs/einleitung', '/project/1/docs/einleitung'],
        ['/project/1/github', '/project/1/github'],
        ['/ticket/new', '/ticket/new'],
        ['/features', '/features'],
        ['/stats', '/stats'],
        ['/admin/systems', '/admin/systems'],
        ['/admin/staff', '/admin/staff'],
        ['/account', '/account'],
    ];
    for (const [name, url] of pages) {
        resp = await request('GET', url, null, jar);
        assert(resp.status === 200, name + ' (200 OK)');
    }

    // --- API: Tickets ---
    console.log('\n📌 API: Tickets');
    resp = await request('GET', '/api/tickets', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body), 'GET /api/tickets (' + resp.body.length + ' Tickets)');

    resp = await request('POST', '/api/tickets', {
        type:'bug', title:'Test-Bug', description:'Test-Beschreibung',
        priority:'hoch', urgency:'normal', system_id:1
    }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/tickets (erstellt)');
    assert(/^[0-9a-f-]{36}$/i.test(resp.body.id), 'POST /api/tickets liefert UUID als Ticket-ID');
    const ticketId = resp.body.id;

    resp = await request('GET', '/api/tickets/' + ticketId, null, jar);
    assert(resp.status === 200 && resp.body.title === 'Test-Bug', 'GET /api/tickets/' + ticketId);

    resp = await request('GET', '/api/tickets/' + ticketId + '/workflow', null, jar);
    assert(resp.status === 200, 'GET /api/tickets/' + ticketId + '/workflow');

    resp = await request('PATCH', '/api/tickets/' + ticketId, { status:'in_bearbeitung' }, jar);
    assert(resp.status === 200, 'PATCH /api/tickets/' + ticketId + ' (Status geändert)');

    resp = await request('DELETE', '/api/tickets/' + ticketId, null, jar);
    assert(resp.status === 200, 'DELETE /api/tickets/' + ticketId);

    // --- API: Features (geplante / verworfene Features je System) ---
    console.log('\n📌 API: Features');
    resp = await request('GET', '/api/features', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body), 'GET /api/features (' + (resp.body.length || 0) + ' Features)');

    resp = await request('POST', '/api/tickets', {
        type:'feature', title:'Test-Feature', description:'Feature-Beschreibung',
        priority:'mittel', urgency:'normal', system_id:1
    });
    assert(resp.status === 201 && resp.body.id, 'POST /api/tickets (Feature erstellt)');
    const featureId = resp.body.id;

    resp = await request('GET', '/api/tickets/' + featureId, null, jar);
    assert(resp.status === 200 && resp.body.feature_decision === 'pending', 'Neues Feature startet in der Inbox (pending)');

    resp = await request('PATCH', '/api/tickets/' + featureId, { feature_decision:'planned' }, jar);
    assert(resp.status === 200 && resp.body.status === 'updated', 'PATCH feature_decision=planned');

    resp = await request('GET', '/api/features?system_id=1&decision=planned', null, jar);
    assert(resp.status === 200 && resp.body.some(f => f.id === featureId), 'Geplantes Feature liegt im Ordner "planned"');

    resp = await request('PATCH', '/api/tickets/' + featureId, { feature_decision:'rejected', feature_reason:'Zu aufwaendig' }, jar);
    assert(resp.status === 200, 'PATCH feature_decision=rejected');

    resp = await request('GET', '/api/features?system_id=1&decision=rejected', null, jar);
    assert(resp.status === 200 && resp.body.some(f => f.id === featureId), 'Verworfenes Feature liegt im Ordner "rejected"');

    resp = await request('GET', '/api/tickets/' + featureId, null, jar);
    assert(resp.status === 200 && resp.body.status === 'verworfen', 'Verworfenes Feature verlaesst den aktiven Backlog (status verworfen)');
    assert(resp.body.discard_reason === 'Zu aufwaendig', 'Verwerfungsgrund wird gespeichert');

    resp = await request('PATCH', '/api/features/' + featureId + '/decision', { decision:'planned' }, jar);
    assert(resp.status === 200 && resp.body.feature_decision === 'planned', 'Verworfenes Feature kann in den Plan verschoben werden');

    resp = await request('GET', '/api/tickets/' + featureId, null, jar);
    assert(resp.status === 200 && resp.body.status === 'offen', 'Reaktiviertes Feature ist wieder aktiv (offen)');

    resp = await request('PATCH', '/api/tickets/' + featureId, { feature_decision:'nonsense' }, jar);
    assert(resp.status === 400, 'Ungueltige feature_decision wird abgelehnt');

    resp = await request('DELETE', '/api/tickets/' + featureId, null, jar);
    assert(resp.status === 200, 'DELETE /api/tickets/' + featureId + ' (Feature aufgeraeumt)');

    // --- API: Plan-Reihenfolge (Prioritaet per Drag & Drop) ---
    console.log('\n📌 API: Feature-Prioritaet (Reihenfolge)');
    // Eigenes System anlegen, damit die Reihenfolge unabhaengig von Seed-Daten ist.
    resp = await request('POST', '/api/systems', { name:'Reorder-Test-System' }, jar);
    assert(resp.status === 200 && resp.body.id, 'POST /api/systems (Test-System fuer Reihenfolge)');
    const reorderSystemId = resp.body.id;

    const makePlanned = async (title) => {
        const created = await request('POST', '/api/tickets', {
            type:'feature', title, description:'x', priority:'mittel', system_id:reorderSystemId
        });
        const decided = await request('PATCH', '/api/features/' + created.body.id + '/decision', { decision:'planned' }, jar);
        return { id: created.body.id, decided };
    };

    const f1 = await makePlanned('Reorder A');
    const f2 = await makePlanned('Reorder B');
    const f3 = await makePlanned('Reorder C');
    assert(f1.decided.status === 200 && f2.decided.status === 200 && f3.decided.status === 200, 'Drei Features eingeplant');

    resp = await request('GET', '/api/features?system_id=' + reorderSystemId + '&decision=planned', null, jar);
    assert(resp.status === 200 && resp.body.length === 3, 'GET /api/features listet 3 geplante Features');
    assert(resp.body.map(f => f.id).join(',') === [f1.id, f2.id, f3.id].join(','), 'Reihenfolge startet in Einplan-Reihenfolge (FIFO)');
    assert(resp.body.map(f => f.feature_rank).join(',') === '0,1,2', 'Ranks werden fortlaufend vergeben (0,1,2)');

    // Umdrehen: C, B, A
    resp = await request('POST', '/api/features/reorder', {
        system_id: reorderSystemId, order: [f3.id, f2.id, f1.id]
    }, jar);
    assert(resp.status === 200 && resp.body.status === 'reordered', 'POST /api/features/reorder (umgedreht)');

    resp = await request('GET', '/api/features?system_id=' + reorderSystemId + '&decision=planned', null, jar);
    assert(resp.body.map(f => f.id).join(',') === [f3.id, f2.id, f1.id].join(','), 'Neue Reihenfolge wird persistiert');
    assert(resp.body.map(f => f.feature_rank).join(',') === '0,1,2', 'Ranks bleiben eindeutig (0,1,2)');

    resp = await request('GET', '/features?system=' + reorderSystemId, null, jar);
    assert(resp.status === 200, 'GET /features rendert die Reihenfolge (200 OK)');

    // Validierung
    resp = await request('POST', '/api/features/reorder', { system_id: reorderSystemId, order: [] }, jar);
    assert(resp.status === 400, 'Leere Reihenfolge wird abgelehnt');

    resp = await request('POST', '/api/features/reorder', { system_id: reorderSystemId, order: [f1.id, f1.id] }, jar);
    assert(resp.status === 400, 'Doppelte IDs werden abgelehnt');

    resp = await request('POST', '/api/features/reorder', { system_id: reorderSystemId, order: [f1.id] }, jar);
    assert(resp.status === 400, 'Unvollstaendige Reihenfolge wird abgelehnt (keine doppelten Ranks)');

    resp = await request('POST', '/api/features/reorder', { system_id: reorderSystemId, order: [f1.id, f2.id, 'does-not-exist'] }, jar);
    assert(resp.status === 404, 'Unbekannte Ticket-ID wird abgelehnt');

    // Ein verworfenes und ein noch offenes Feature duerfen nicht in die Reihenfolge.
    const rejectedProbe = await request('POST', '/api/tickets', {
        type:'feature', title:'Reorder Rejected', description:'x', priority:'mittel', system_id:reorderSystemId
    });
    await request('PATCH', '/api/features/' + rejectedProbe.body.id + '/decision', { decision:'rejected' }, jar);
    resp = await request('POST', '/api/features/reorder', {
        system_id: reorderSystemId, order: [f1.id, f2.id, rejectedProbe.body.id]
    }, jar);
    assert(resp.status === 400, 'Verworfenes Feature kann nicht sortiert werden');

    const pendingProbe = await request('POST', '/api/tickets', {
        type:'feature', title:'Reorder Pending', description:'x', priority:'mittel', system_id:reorderSystemId
    });
    resp = await request('POST', '/api/features/reorder', {
        system_id: reorderSystemId, order: [f1.id, f2.id, pendingProbe.body.id]
    }, jar);
    assert(resp.status === 400, 'Noch nicht entschiedenes Feature kann nicht sortiert werden');

    const bugProbe = await request('POST', '/api/tickets', {
        type:'bug', title:'Reorder Bug', description:'x', priority:'mittel', system_id:reorderSystemId
    });
    resp = await request('POST', '/api/features/reorder', {
        system_id: reorderSystemId, order: [f1.id, f2.id, bugProbe.body.id]
    }, jar);
    assert(resp.status === 400, 'Bug-Ticket kann nicht sortiert werden');

    await request('DELETE', '/api/tickets/' + rejectedProbe.body.id, null, jar);
    await request('DELETE', '/api/tickets/' + pendingProbe.body.id, null, jar);
    await request('DELETE', '/api/tickets/' + bugProbe.body.id, null, jar);

    // Vollstaendigkeit: die drei geplanten Features sind weiterhin unveraendert sortiert.
    resp = await request('GET', '/api/features?system_id=' + reorderSystemId + '&decision=planned', null, jar);
    assert(resp.body.map(f => f.id).join(',') === [f3.id, f2.id, f1.id].join(','), 'Abgelehnte Reorders veraendern die Reihenfolge nicht');

    // Rang wird beim Verlassen des Plans freigegeben und beim erneuten Planen hinten angehaengt.
    resp = await request('PATCH', '/api/features/' + f1.id + '/decision', { decision:'pending' }, jar);
    assert(resp.status === 200, 'Feature zurueck in die Inbox');

    resp = await request('GET', '/api/tickets/' + f1.id, null, jar);
    assert(resp.status === 200 && resp.body.feature_rank === null, 'Rang wird beim Verlassen des Plans freigegeben');

    resp = await request('GET', '/api/features?system_id=' + reorderSystemId + '&decision=planned', null, jar);
    assert(resp.body.map(f => f.id).join(',') === [f3.id, f2.id].join(','), 'Zurueckgelegtes Feature verschwindet aus dem Plan');

    resp = await request('PATCH', '/api/features/' + f1.id + '/decision', { decision:'planned' }, jar);
    assert(resp.status === 200, 'Feature erneut einplanen');

    resp = await request('GET', '/api/features?system_id=' + reorderSystemId + '&decision=planned', null, jar);
    assert(resp.body.map(f => f.id).join(',') === [f3.id, f2.id, f1.id].join(','), 'Erneut eingeplantes Feature landet am Ende');

    // Aufraeumen
    for (const f of [f1, f2, f3]) {
        await request('DELETE', '/api/tickets/' + f.id, null, jar);
    }
    // Test-System wieder deaktivieren, damit es nicht im Feature-Picker auftaucht.
    const csrfPage = await request('GET', '/ticket/new', null, jar);
    const csrfMatch = (typeof csrfPage.body === 'string' ? csrfPage.body : '').match(/name="_csrf" value="([^"]+)"/);
    resp = await request('POST', '/admin/systems/' + reorderSystemId + '/delete', { _csrf: csrfMatch ? csrfMatch[1] : '' }, jar);
    assert(resp.status === 302, 'Reorder-Test-System deaktiviert');

    // --- Webhook ---
    console.log('\n📌 API: Webhook');
    resp = await request('POST', '/api/github/webhook', {
        action:'opened', repository:{full_name:'test-owner/test-repo'},
        issue:{number:1,title:'Test',state:'open',html_url:'http://example.com',labels:[],created_at:'2026-01-01',updated_at:'2026-01-01',user:{login:'test'}}
    }, null);
    assert(resp.status === 200, 'POST /api/github/webhook (status ' + resp.status + ')');

    // --- Summary ---
    console.log('\n═══════════════════════════');
    console.log(`  ✅ ${passed} bestanden`);
    if (failures > 0) console.log(`  ❌ ${failures} fehlgeschlagen`);
    console.log('═══════════════════════════\n');

    stopServer(ownsServer).then(() => process.exit(failures > 0 ? 1 : 0));
}

main().catch(async (e) => {
    console.error('Test-Fehler:', e.message);
    await stopServer(true);
    process.exit(1);
});
