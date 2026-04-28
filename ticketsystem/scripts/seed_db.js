const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '..', 'tickets.db');
const db = new sqlite3.Database(dbPath);

const staffNames = ['Michael', 'Andreas', 'Christian'];
const systems = [
    { name: 'CuraFlow', description: 'Patientenverwaltungssystem' },
    { name: 'Schreibdienst', description: 'Diktat- und Transkriptionsdienst' }
];

const priorities = ['niedrig', 'mittel', 'hoch', 'kritisch'];
const types = ['bug', 'feature'];
const statuses = ['offen', 'in_bearbeitung', 'wartend', 'geschlossen'];

async function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

async function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function seed() {
    try {
        console.log('Starte Datenbank-Seeding...');

        // 1. Staff einfü:
        for (const name of staffNames) {
            const email = name.toLowerCase() + '@example.com';
            try {
                await runQuery('INSERT INTO staff (name, email) VALUES (?, ?)', [name, email]);
                console.log(`Staff ${name} hinzugefügt.`);
            } catch (err) {
                if (err.message.includes('UNIQUE')) {
                    console.log(`Staff ${name} existiert bereits.`);
                } else {
                    throw err;
                }
            }
        }

        // 2. Systeme einfügen
        for (const sys of systems) {
            try {
                await runQuery('INSERT INTO systems (name, description) VALUES (?, ?)', [sys.name, sys.description]);
                console.log(`System ${sys.name} hinzugefügt.`);
            } catch (err) {
                console.log(`System ${sys.name} existiert bereits oder Fehler: ${err.message}`);
            }
        }

        // 3. IDs abrufen
        const staffRows = await getQuery('SELECT id, name FROM staff');
        const systemRows = await getQuery('SELECT id, name FROM systems');

        if (staffRows.length === 0 || systemRows.length === 0) {
            throw new Error('Staff oder Systeme konnten nicht geladen werden.');
        }

        // 4. 20 Tickets erstellen
        console.log('Erstelle 20 Tickets...');
        for (let i = 1; i <= 20; i++) {
            const system = systemRows[Math.floor(Math.random() * systemRows.length)];
            const staff = staffRows[Math.floor(Math.random() * staffRows.length)];
            const priority = priorities[Math.floor(Math.random() * priorities.length)];
            const type = types[Math.floor(Math.random() * types.length)];
            const status = statuses[Math.floor(Math.random() * statuses.length)];
            const title = `Test Ticket ${i}: ${type === 'bug' ? 'Fehler in' : 'Neues Feature für'} ${system.name}`;
            const description = `Dies ist ein automatisch generierter Test-Beschreibung für Ticket #${i}.`;

            await runQuery(`
                INSERT INTO tickets (
                    type, title, description, status, priority, system_id, assigned_to
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [type, title, description, status, priority, system.id, staff.id]
            );
        }

        console.log('Seeding erfolgreich abgeschlossen!');
    } catch (err) {
        console.error('Fehler beim Seeding:', err);
    } finally {
        db.close();
    }

}

seed();
