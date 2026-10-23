// Prueft die Atlas-Migration gegen eine Datenbank mit dem alten Schema:
// meeting_id war dort NOT NULL und project_id fehlte. Der Rebuild muss Daten
// erhalten, project_id nachtragen und die Fremdschluessel intakt lassen.
//
// Aufruf: node tests/migration-check.js

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const os = require('os');
const path = require('path');
const schema = require('../services/atlas/schema');

const FILE = path.join(os.tmpdir(), `atlas-migration-${process.pid}.db`);

let failures = 0;
let passed = 0;

function check(condition, message) {
    if (condition) { passed += 1; console.log(`  ✅ ${message}`); }
    else { failures += 1; console.log(`  ❌ ${message}`); }
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}

// Wartet, bis die Migration fertig ist (init() arbeitet asynchron).
async function waitFor(db, table, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const cols = await all(db, `PRAGMA table_info(${table})`);
        const meeting = cols.find((c) => c.name === 'meeting_id');
        if (meeting && Number(meeting.notnull) === 0 && cols.some((c) => c.name === 'project_id')) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

async function createLegacyDatabase(db) {
    await run(db, `CREATE TABLE hospitals (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await run(db, `CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, hospital_id INTEGER NOT NULL, name TEXT NOT NULL, active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(hospital_id, name))`);
    await run(db, `CREATE TABLE systems (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
    await run(db, `CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, system_id INTEGER, name TEXT NOT NULL, department_id INTEGER)`);
    await run(db, `CREATE TABLE project_key_users (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, staff_id INTEGER, name TEXT NOT NULL, email TEXT, phone TEXT, role TEXT, notes TEXT, training_status TEXT, test_protocol TEXT)`);
    await run(db, `CREATE TABLE key_user_meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, key_user_id INTEGER, title TEXT NOT NULL, agenda TEXT, notes TEXT, meeting_date TEXT NOT NULL, start_time TEXT, duration_minutes INTEGER, location TEXT, status TEXT, follow_up_of INTEGER, created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await run(db, `CREATE TABLE project_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, filename TEXT NOT NULL, original_name TEXT NOT NULL, mimetype TEXT NOT NULL, size INTEGER NOT NULL, created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await run(db, `CREATE TABLE workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, department_id INTEGER NOT NULL, description TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await run(db, `CREATE TABLE problems (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, department_id INTEGER NOT NULL, workflow_id INTEGER, title TEXT NOT NULL, description TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await run(db, `CREATE TABLE adoption_risks (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, department_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    // Bestandsdaten, wie sie nach der ersten Fassung in einer DB stehen.
    await run(db, 'INSERT INTO hospitals (name) VALUES (?)', ['Klinikum Südstadt']);
    await run(db, 'INSERT INTO departments (hospital_id, name) VALUES (1, ?)', ['Allgemein']);
    await run(db, 'INSERT INTO projects (name, department_id) VALUES (?, ?)', ['Alt', 1]);
    await run(db, 'INSERT INTO key_user_meetings (project_id, title, meeting_date) VALUES (1, ?, ?)', ['Termin A', '2026-01-01']);
    await run(db, 'INSERT INTO workflows (meeting_id, department_id, description) VALUES (1, 1, ?)', ['Alter Workflow']);
    await run(db, 'INSERT INTO problems (meeting_id, department_id, workflow_id, title) VALUES (1, 1, 1, ?)', ['Altes Problem']);
    await run(db, 'INSERT INTO adoption_risks (meeting_id, department_id, title) VALUES (1, 1, ?)', ['Altes Risiko']);
}

async function main() {
    console.log('\n🧪  Migration: altes Schema -> meeting_id optional\n');

    for (const suffix of ['', '-journal', '-wal', '-shm']) {
        try { fs.unlinkSync(FILE + suffix); } catch (_) {}
    }

    const db = new sqlite3.Database(FILE);
    try {
        await createLegacyDatabase(db);
        schema.init(db);

        const ready = await waitFor(db, 'problems');
        check(ready, 'Migration abgeschlossen');

        for (const table of ['workflows', 'problems', 'adoption_risks']) {
            const cols = await all(db, `PRAGMA table_info(${table})`);
            const meeting = cols.find((c) => c.name === 'meeting_id');
            check(Number(meeting && meeting.notnull) === 0, `${table}: meeting_id ist optional`);
            check(cols.some((c) => c.name === 'project_id'), `${table}: project_id existiert`);

            const rows = await all(db, `SELECT * FROM ${table}`);
            check(rows.length === 1, `${table}: Bestandsdaten erhalten`);
            check(rows.every((row) => row.project_id === 1), `${table}: project_id nachgetragen`);
        }

        const fks = await all(db, 'PRAGMA foreign_key_list(problems)');
        check(fks.some((fk) => fk.table === 'workflows'), 'problems verweist weiter auf workflows');
        check(!fks.some((fk) => String(fk.table).includes('__old')), 'kein Fremdschluessel auf __old');

        check((await all(db, 'PRAGMA foreign_keys'))[0].foreign_keys === 1, 'foreign_keys wieder aktiv');
        check((await all(db, 'PRAGMA legacy_alter_table'))[0].legacy_alter_table === 0, 'legacy_alter_table zurueckgesetzt');

        await run(db, 'INSERT INTO problems (project_id, meeting_id, department_id, title) VALUES (1, NULL, 1, ?)', ['Direkt']);
        check((await all(db, 'SELECT COUNT(*) AS c FROM problems'))[0].c === 2, 'Eintrag ohne Termin speicherbar');
    } finally {
        db.close();
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
            try { fs.unlinkSync(FILE + suffix); } catch (_) {}
        }
    }

    console.log(`\n  ${passed} bestanden${failures ? `, ${failures} fehlgeschlagen` : ''}\n`);
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('Test-Fehler:', err.message);
    process.exit(1);
});
