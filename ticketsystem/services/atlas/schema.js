'use strict';

/**
 * Schema fuer die Atlas-Uebernahme (Krankenhaus -> Abteilung -> Projekt).
 *
 * Alle Schritte laufen streng sequenziell ueber Promises: node-sqlite3 fuehrt
 * Statements sonst parallel aus, und ein ALTER TABLE kann dann vor seinem
 * CREATE TABLE laufen ("no such table: departments").
 *
 * Siehe docs/integration-atlas.md.
 */

const DEFAULT_HOSPITAL_NAME = 'Klinikum Südstadt';
const DEFAULT_DEPARTMENT_NAME = 'Allgemein';

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function addColumnIfMissing(db, table, column, sql, attempts = 60) {
    // Die Atlas-Migration startet, sobald die projects-Migration durch ist; die
    // uebrigen CREATEs aus initDb koennen parallel noch laufen. Deshalb warten
    // wir, bis die Zieltabelle existiert.
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const rows = await all(db, `PRAGMA table_info(${table})`);
        if (rows.length === 0) {
            await delay(50);
            continue;
        }
        if (rows.some((row) => row.name === column)) return;
        await run(db, sql);
        return;
    }
    throw new Error(`Tabelle ${table} nicht gefunden`);
}

async function migrate(db) {
    // 1. Stammdaten
    await run(db, `CREATE TABLE IF NOT EXISTS hospitals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(db, `CREATE TABLE IF NOT EXISTS departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hospital_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(hospital_id, name),
        FOREIGN KEY (hospital_id) REFERENCES hospitals(id) ON DELETE CASCADE
    )`);

    // 2. Wissen am Termin
    await run(db, `CREATE TABLE IF NOT EXISTS meeting_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL,
        key_user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(meeting_id, key_user_id),
        FOREIGN KEY (meeting_id) REFERENCES key_user_meetings(id) ON DELETE CASCADE,
        FOREIGN KEY (key_user_id) REFERENCES project_key_users(id) ON DELETE CASCADE
    )`);

    // department_id wird beim Anlegen aus Termin -> Projekt abgeleitet und nie
    // vom Client uebernommen (siehe docs/adr/0001-projekt-ist-die-einheit.md).
    await run(db, `CREATE TABLE IF NOT EXISTS workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL,
        department_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (meeting_id) REFERENCES key_user_meetings(id) ON DELETE CASCADE,
        FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
    )`);

    await run(db, `CREATE TABLE IF NOT EXISTS problems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL,
        department_id INTEGER NOT NULL,
        workflow_id INTEGER,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (meeting_id) REFERENCES key_user_meetings(id) ON DELETE CASCADE,
        FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
    )`);

    await run(db, `CREATE TABLE IF NOT EXISTS adoption_risks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL,
        department_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (meeting_id) REFERENCES key_user_meetings(id) ON DELETE CASCADE,
        FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
    )`);

    await run(db, 'CREATE INDEX IF NOT EXISTS idx_departments_hospital ON departments(hospital_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_problems_meeting ON problems(meeting_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_problems_department ON problems(department_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_workflows_meeting ON workflows(meeting_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_adoption_risks_meeting ON adoption_risks(meeting_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting ON meeting_participants(meeting_id)');

    // 3. Default-Datensatz
    await run(db, `INSERT INTO hospitals (name)
                    SELECT ?
                    WHERE NOT EXISTS (SELECT 1 FROM hospitals)`, [DEFAULT_HOSPITAL_NAME]);

    await run(db, `INSERT INTO departments (hospital_id, name)
                    SELECT h.id, ?
                    FROM hospitals h
                    WHERE NOT EXISTS (SELECT 1 FROM departments)
                    ORDER BY h.id
                    LIMIT 1`, [DEFAULT_DEPARTMENT_NAME]);

    // 4. Spalten ergaenzen
    await addColumnIfMissing(db, 'projects', 'department_id',
        'ALTER TABLE projects ADD COLUMN department_id INTEGER REFERENCES departments(id)');
    await addColumnIfMissing(db, 'key_user_meetings', 'transcript',
        'ALTER TABLE key_user_meetings ADD COLUMN transcript TEXT');

    // 5. Bestandsdaten (CuraFlow, Schreibdienst, ...) der Default-Abteilung zuordnen.
    await run(db, `UPDATE projects
                   SET department_id = (SELECT id FROM departments ORDER BY id LIMIT 1)
                   WHERE department_id IS NULL`);
}

/**
 * Startet die Atlas-Migrationen. Fehler werden geloggt, aber nicht geworfen:
 * ein fehlgeschlagener Migrationsschritt darf den Serverstart nicht verhindern.
 */
function init(db) {
    migrate(db).then(() => {
        console.log('[atlas] Schema bereit.');
    }).catch((err) => {
        console.error('[atlas] Migration fehlgeschlagen:', err.message);
    });
}

module.exports = {
    init,
    DEFAULT_HOSPITAL_NAME,
    DEFAULT_DEPARTMENT_NAME
};
