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

        // 3b. Projekte anlegen
        console.log('Erstelle Projekte...');
        const curaFlowSys = systemRows.find(s => s.name === 'CuraFlow');
        const schreibSys = systemRows.find(s => s.name === 'Schreibdienst');

        const projects = [
            { system_id: curaFlowSys ? curaFlowSys.id : null, name: 'CuraFlow', description: 'Dienstplanung für ärztlichen und pflegerischen Dienst. Manuelle und automatische Tagesplanung, Urlaubsverwaltung, Dienstwunsch-Management und Qualifikationsverwaltung.', status: 'active', start_date: '2026-01-01', end_date: '2027-12-31' },
            { system_id: schreibSys ? schreibSys.id : null, name: 'Schreibdienst', description: 'Real-Time und Offline Spracherkennung für medizinische Texte. Individuelle Nutzerwörterbücher, Mitlesefunktion, Textübergabe via Zwischenablage.', status: 'active', start_date: '2026-01-01', end_date: '2027-12-31' }
        ];

        for (const proj of projects) {
            try {
                await runQuery('INSERT INTO projects (system_id, name, description, status, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)',
                    [proj.system_id, proj.name, proj.description, proj.status, proj.start_date, proj.end_date]);
                console.log(`Projekt ${proj.name} hinzugefügt.`);
            } catch (err) {
                console.log(`Projekt ${proj.name} existiert bereits: ${err.message}`);
            }
        }

        const projectRows = await getQuery('SELECT id, name FROM projects');

        // Meilensteine für CuraFlow
        const curaProj = projectRows.find(p => p.name === 'CuraFlow');
        if (curaProj) {
            const milestones = [
                { project_id: curaProj.id, title: 'Pilotphase Start', phase: 1, start_date: '2026-01-01', end_date: '2026-02-28', status: 'completed', color: '#2563eb' },
                { project_id: curaProj.id, title: 'Key-User Schulung', phase: 1, start_date: '2026-02-01', end_date: '2026-03-31', status: 'completed', color: '#7c3aed' },
                { project_id: curaProj.id, title: 'Pilotbetrieb & Evaluierung', phase: 1, start_date: '2026-03-01', end_date: '2026-05-31', status: 'in_progress', color: '#059669' },
                { project_id: curaProj.id, title: 'Rollout Phase', phase: 2, start_date: '2026-06-01', end_date: '2026-12-31', status: 'pending', color: '#ea580c' },
                { project_id: curaProj.id, title: 'IT-Schulung Tier-1 Support', phase: 2, start_date: '2026-10-01', end_date: '2026-12-31', status: 'pending', color: '#dc2626' },
                { project_id: curaProj.id, title: 'Optimierung & Feature-Entwicklung', phase: 3, start_date: '2027-01-01', end_date: '2027-12-31', status: 'pending', color: '#0891b2' }
            ];
            for (const m of milestones) {
                try { await runQuery('INSERT INTO project_milestones (project_id, title, phase, start_date, end_date, status, color) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [m.project_id, m.title, m.phase, m.start_date, m.end_date, m.status, m.color]); } catch(e) {}
            }
            console.log('CuraFlow Meilensteine hinzugefügt.');
        }

        // Meilensteine für Schreibdienst
        const schreibProj = projectRows.find(p => p.name === 'Schreibdienst');
        if (schreibProj) {
            const milestones = [
                { project_id: schreibProj.id, title: 'Pilotphase Start', phase: 1, start_date: '2026-01-01', end_date: '2026-02-28', status: 'completed', color: '#2563eb' },
                { project_id: schreibProj.id, title: 'Wörterbuch-Integration', phase: 1, start_date: '2026-02-01', end_date: '2026-04-30', status: 'in_progress', color: '#7c3aed' },
                { project_id: schreibProj.id, title: 'RIS/KIS Anbindung (Best-Effort)', phase: 1, start_date: '2026-03-01', end_date: '2026-09-30', status: 'blocked', color: '#dc2626' },
                { project_id: schreibProj.id, title: 'Flächendeckende Einführung', phase: 2, start_date: '2026-06-01', end_date: '2026-12-31', status: 'pending', color: '#ea580c' },
                { project_id: schreibProj.id, title: 'Nutzer-Schulungen', phase: 2, start_date: '2026-07-01', end_date: '2026-11-30', status: 'pending', color: '#059669' },
                { project_id: schreibProj.id, title: 'Kontinuierlicher Service', phase: 3, start_date: '2027-01-01', end_date: '2027-12-31', status: 'pending', color: '#0891b2' }
            ];
            for (const m of milestones) {
                try { await runQuery('INSERT INTO project_milestones (project_id, title, phase, start_date, end_date, status, color) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [m.project_id, m.title, m.phase, m.start_date, m.end_date, m.status, m.color]); } catch(e) {}
            }
            console.log('Schreibdienst Meilensteine hinzugefügt.');
        }

        // Key-User zuweisen
        for (const proj of projectRows) {
            for (const staff of staffRows.slice(0, 2)) {
                try {
                    const role = staff.name === 'Michael' ? 'key_user' : staff.name === 'Andreas' ? 'evaluator' : 'decision_maker';
                    await runQuery('INSERT INTO project_key_users (project_id, staff_id, role, notes) VALUES (?, ?, ?, ?)',
                        [proj.id, staff.id, role, 'Seed-Key-User']);
                } catch(e) {}
            }
        }
        console.log('Key-User hinzugefügt.');

        // Wiki-Seiten für CuraFlow
        if (curaProj) {
            await runQuery("INSERT OR IGNORE INTO project_documents (project_id, title, slug, content, updated_by) VALUES (?, ?, ?, ?, ?)",
                [curaProj.id, 'Einleitung', 'einleitung',
                 '# CuraFlow Dokumentation\n\n## Überblick\n\nCuraFlow ist ein Open-Source-Softwareprodukt für die Dienstplanung im Krankenhaus.\n\n### Funktionen\n\n- **Manuelle und automatische Tagesplanung** für ärztlichen und pflegerischen Dienst\n- **Urlaubsverwaltung**\n- **Dienstwunsch-Management**\n- **Qualifikationsverwaltung**\n\n## Projektphasen\n\n```mermaid\ngantt\n    title CuraFlow Projektphasen\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Pilotphase Start :done, 2026-01-01, 2026-02-28\n    Key-User Schulung :done, 2026-02-01, 2026-03-31\n    Pilotbetrieb :active, 2026-03-01, 2026-05-31\n    section Phase 2\n    Rollout :2026-06-01, 2026-12-31\n    section Phase 3\n    Optimierung :2027-01-01, 2027-12-31\n```\n\n## Systemanforderungen\n\n- Server: Linux/Windows\n- Browser: Chrome, Firefox, Edge\n- KIS-Integration über HL7/FHIR', 'System']
            );
            await runQuery("INSERT OR IGNORE INTO project_documents (project_id, title, slug, content, updated_by) VALUES (?, ?, ?, ?, ?)",
                [curaProj.id, 'Setup & Installation', 'setup',
                 '# Setup & Installation\n\n## Voraussetzungen\n\n- Docker installiert\n- Zugriff auf Krankenhaus-Netzwerk\n- KIS-Zugangsdaten\n\n## Installation\n\n```bash\ndocker pull curaflow/latest\ndocker-compose up -d\n```\n\n## Konfiguration\n\n1. `.env` Datei anpassen\n2. Datenbank-Verbindung konfigurieren\n3. LDAP/AD für Benutzerauthentifizierung einrichten', 'System']
            );
            console.log('CuraFlow Wiki-Seiten hinzugefügt.');
        }

        // Wiki-Seiten für Schreibdienst
        if (schreibProj) {
            await runQuery("INSERT OR IGNORE INTO project_documents (project_id, title, slug, content, updated_by) VALUES (?, ?, ?, ?, ?)",
                [schreibProj.id, 'Einleitung', 'einleitung',
                 '# Schreibdienst Dokumentation\n\n## Überblick\n\nSchreibdienst ist ein Open-Source-Softwareprodukt für Spracherkennung medizinischer Texte.\n\n### Funktionen\n\n- **Real-Time Spracherkennung** für Befunde, Berichte, Epikrisen\n- **Offline Spracherkennung**\n- **Individuelle Nutzerwörterbücher**\n- **Zentral pflegbare Standardwörterbücher**\n- **Mitlesefunktion** im Offline-Modus\n- **Textübergabe via Zwischenablage**\n\n## Systemanforderungen\n\n- Mikrofon (Headset empfohlen)\n- Windows 10/11\n- 8 GB RAM\n- RIS/KIS Anbindung (Best-Effort)', 'System']
            );
            await runQuery("INSERT OR IGNORE INTO project_documents (project_id, title, slug, content, updated_by) VALUES (?, ?, ?, ?, ?)",
                [schreibProj.id, 'Wörterbuch-Management', 'woerterbuch',
                 '# Wörterbuch-Management\n\n## Standardwörterbücher\n\nZentral gepflegt, enthalten:\n- Medizinische Fachbegriffe\n- Abkürzungen (z.B. ICD-10 Codes)\n- Medikamentennamen\n\n## Nutzerwörterbücher\n\nJeder Nutzer kann eigene Begriffe hinzufügen:\n\n1. Im Schreibdienst-Fenster auf Einstellungen klicken\n2. Tab "Wörterbuch" wählen\n3. Neue Begriffe mit Aussprache eintragen\n\n## Import/Export\n\nWörterbücher können als CSV exportiert und importiert werden.', 'System']
            );
            console.log('Schreibdienst Wiki-Seiten hinzugefügt.');
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
