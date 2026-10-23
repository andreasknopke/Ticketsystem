'use strict';

/**
 * Schema fuer die Atlas-Uebernahme (Krankenhaus -> Abteilung -> Projekt).
 *
 * Alle Schritte laufen streng sequenziell ueber Promises: node-sqlite3 fuehrt
 * Statements sonst parallel aus, und ein ALTER TABLE kann dann vor seinem
 * CREATE TABLE laufen ("no such table: departments").
 *
 * Siehe docs/integration-atlas.md und docs/adr/0004-wissen-ohne-termin.md.
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

// --- Wissenstabellen -------------------------------------------------------
// meeting_id ist optional: Wissen darf aus einem Termin stammen, muss aber
// nicht. project_id ist immer gesetzt und traegt die Zuordnung.

const WORKFLOWS_DDL = `CREATE TABLE workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    meeting_id INTEGER,
    department_id INTEGER,
    description TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES key_user_meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
)`;

const PROBLEMS_DDL = `CREATE TABLE problems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    meeting_id INTEGER,
    department_id INTEGER,
    workflow_id INTEGER,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES key_user_meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
)`;

const RISKS_DDL = `CREATE TABLE adoption_risks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    meeting_id INTEGER,
    department_id INTEGER,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES key_user_meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
)`;

/**
 * Baut eine Tabelle neu auf, wenn meeting_id noch NOT NULL ist.
 *
 * SQLite kann NOT NULL nicht per ALTER entfernen. Der Rebuild laeuft mit
 * legacy_alter_table=ON, damit RENAME die Fremdschluessel anderer Tabellen
 * nicht auf die __old-Tabelle umschreibt. Deshalb werden die abhaengigen
 * Tabellen (problems -> workflows) VOR ihrer Elterntabelle umgebaut.
 */
async function makeMeetingOptional(db, table, createSql, copyColumns) {
    const rows = await all(db, `PRAGMA table_info(${table})`);
    if (rows.length === 0) return;

    const meetingColumn = rows.find((row) => row.name === 'meeting_id');
    if (!meetingColumn || Number(meetingColumn.notnull) === 0) return;

    console.log(`[atlas] ${table}: meeting_id wird optional (Rebuild)...`);

    await run(db, 'PRAGMA foreign_keys=OFF');
    await run(db, 'PRAGMA legacy_alter_table=ON');
    await run(db, 'BEGIN');
    try {
        await run(db, `ALTER TABLE ${table} RENAME TO ${table}__old`);
        await run(db, createSql);
        const oldColumns = new Set(rows.map((row) => row.name));
        const columns = copyColumns.filter((column) => oldColumns.has(column));
        await run(db, `INSERT INTO ${table} (${columns.join(', ')})
                       SELECT ${columns.join(', ')} FROM ${table}__old`);
        await run(db, `DROP TABLE ${table}__old`);
        await run(db, 'COMMIT');
        console.log(`[atlas] ${table}: meeting_id ist jetzt optional.`);
    } catch (err) {
        await run(db, 'ROLLBACK');
        throw err;
    } finally {
        await run(db, 'PRAGMA legacy_alter_table=OFF');
        await run(db, 'PRAGMA foreign_keys=ON');
    }
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

    // 2. Terminbezug
    await run(db, `CREATE TABLE IF NOT EXISTS meeting_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL,
        key_user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(meeting_id, key_user_id),
        FOREIGN KEY (meeting_id) REFERENCES key_user_meetings(id) ON DELETE CASCADE,
        FOREIGN KEY (key_user_id) REFERENCES project_key_users(id) ON DELETE CASCADE
    )`);

    // 3. Wissenstabellen (Reihenfolge: Kinder vor Elterntabelle)
    await makeMeetingOptional(db, 'problems', PROBLEMS_DDL,
        ['id', 'project_id', 'meeting_id', 'department_id', 'workflow_id', 'title', 'description', 'created_at']);
    await makeMeetingOptional(db, 'adoption_risks', RISKS_DDL,
        ['id', 'project_id', 'meeting_id', 'department_id', 'title', 'description', 'created_at']);
    await makeMeetingOptional(db, 'workflows', WORKFLOWS_DDL,
        ['id', 'project_id', 'meeting_id', 'department_id', 'description', 'created_at']);

    await run(db, `${WORKFLOWS_DDL.replace('CREATE TABLE workflows', 'CREATE TABLE IF NOT EXISTS workflows')}`);
    await run(db, `${PROBLEMS_DDL.replace('CREATE TABLE problems', 'CREATE TABLE IF NOT EXISTS problems')}`);
    await run(db, `${RISKS_DDL.replace('CREATE TABLE adoption_risks', 'CREATE TABLE IF NOT EXISTS adoption_risks')}`);

    await run(db, 'CREATE INDEX IF NOT EXISTS idx_departments_hospital ON departments(hospital_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_problems_project ON problems(project_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_problems_meeting ON problems(meeting_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_problems_department ON problems(department_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows(project_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_workflows_meeting ON workflows(meeting_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_adoption_risks_project ON adoption_risks(project_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_adoption_risks_meeting ON adoption_risks(meeting_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting ON meeting_participants(meeting_id)');

    // 4. Default-Datensatz
    await run(db, `INSERT INTO hospitals (name)
                    SELECT ?
                    WHERE NOT EXISTS (SELECT 1 FROM hospitals)`, [DEFAULT_HOSPITAL_NAME]);

    await run(db, `INSERT INTO departments (hospital_id, name)
                    SELECT h.id, ?
                    FROM hospitals h
                    WHERE NOT EXISTS (SELECT 1 FROM departments)
                    ORDER BY h.id
                    LIMIT 1`, [DEFAULT_DEPARTMENT_NAME]);

    // 5. Spalten ergaenzen
    await addColumnIfMissing(db, 'projects', 'department_id',
        'ALTER TABLE projects ADD COLUMN department_id INTEGER REFERENCES departments(id)');
    await addColumnIfMissing(db, 'key_user_meetings', 'transcript',
        'ALTER TABLE key_user_meetings ADD COLUMN transcript TEXT');
    // Dateien im Flow-Reiter: 'input' (Bestandsaufnahme) oder 'output' (Integration).
    await addColumnIfMissing(db, 'project_attachments', 'phase',
        "ALTER TABLE project_attachments ADD COLUMN phase TEXT DEFAULT 'input'");

    // 6. Bestandsdaten (CuraFlow, Schreibdienst, ...) der Default-Abteilung zuordnen.
    await run(db, `UPDATE projects
                   SET department_id = (SELECT id FROM departments ORDER BY id LIMIT 1)
                   WHERE department_id IS NULL`);

    // 7. Wissen ohne Projektbezug nachtragen (Eintraege aus der ersten Fassung).
    for (const table of ['workflows', 'problems', 'adoption_risks']) {
        await run(db, `UPDATE ${table}
                       SET project_id = (SELECT m.project_id FROM key_user_meetings m WHERE m.id = ${table}.meeting_id)
                       WHERE project_id IS NULL AND meeting_id IS NOT NULL`);
        await run(db, `UPDATE ${table}
                       SET department_id = (SELECT p.department_id FROM projects p WHERE p.id = ${table}.project_id)
                       WHERE department_id IS NULL AND project_id IS NOT NULL`);
    }
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
