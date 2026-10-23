'use strict';

/**
 * API-Routen fuer die Atlas-Uebernahme.
 *
 * Bewusste Regel: `department_id` kommt nie aus dem Request-Body. Sie wird
 * immer aus Termin -> Projekt abgeleitet (docs/adr/0001-projekt-ist-die-einheit.md).
 */

function normalizeText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text : null;
}

function toId(value) {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

module.exports = function registerAtlasRoutes(app, deps) {
    const { db, requireAuth, requireAdmin } = deps;

    const loadMeeting = (meetingId, callback) => {
        db.get(`SELECT m.id, m.project_id, p.department_id
                FROM key_user_meetings m
                LEFT JOIN projects p ON p.id = m.project_id
                WHERE m.id = ?`, [meetingId], callback);
    };

    // --- Stammdaten: Krankenhaeuser und Abteilungen ---

    app.get('/api/hospitals', requireAuth, (req, res) => {
        db.all('SELECT id, name FROM hospitals ORDER BY name', [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.get('/api/departments', requireAuth, (req, res) => {
        const hospitalId = toId(req.query.hospital_id);
        const sql = `SELECT d.id, d.name, d.hospital_id, h.name AS hospital_name
                     FROM departments d
                     JOIN hospitals h ON h.id = d.hospital_id
                     ${hospitalId ? 'WHERE d.hospital_id = ?' : ''}
                     ORDER BY h.name, d.name`;
        db.all(sql, hospitalId ? [hospitalId] : [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/departments', requireAuth, requireAdmin, (req, res) => {
        const name = normalizeText(req.body.name);
        if (!name) return res.status(400).json({ error: 'Name ist erforderlich.' });

        const requestedHospitalId = toId(req.body.hospital_id);
        const insert = (hospitalId) => {
            db.run('INSERT INTO departments (hospital_id, name) VALUES (?, ?)',
                [hospitalId, name], function (err) {
                    if (err) {
                        if (/UNIQUE constraint failed/i.test(err.message)) {
                            return res.status(409).json({ error: 'Abteilung existiert bereits in diesem Krankenhaus.' });
                        }
                        return res.status(500).json({ error: err.message });
                    }
                    res.status(201).json({ id: this.lastID, name, hospital_id: hospitalId });
                });
        };

        if (requestedHospitalId) {
            db.get('SELECT id FROM hospitals WHERE id = ?', [requestedHospitalId], (err, hospital) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!hospital) return res.status(404).json({ error: 'Krankenhaus nicht gefunden.' });
                insert(requestedHospitalId);
            });
            return;
        }

        db.get('SELECT id FROM hospitals ORDER BY id LIMIT 1', [], (err, hospital) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!hospital) return res.status(409).json({ error: 'Kein Krankenhaus vorhanden.' });
            insert(hospital.id);
        });
    });

    // --- Teilnehmer eines Termins ---

    app.get('/api/meetings/:meetingId/participants', requireAuth, (req, res) => {
        db.all(`SELECT k.id, k.name, k.email, k.role
                FROM meeting_participants mp
                JOIN project_key_users k ON k.id = mp.key_user_id
                WHERE mp.meeting_id = ?
                ORDER BY k.name`, [req.params.meetingId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/meetings/:meetingId/participants', requireAuth, requireAdmin, (req, res) => {
        const raw = Array.isArray(req.body.key_user_ids) ? req.body.key_user_ids : [];
        const ids = [...new Set(raw.map(toId).filter(Boolean))];

        loadMeeting(req.params.meetingId, (err, meeting) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!meeting) return res.status(404).json({ error: 'Termin nicht gefunden.' });

            const replace = () => {
                db.run('DELETE FROM meeting_participants WHERE meeting_id = ?', [meeting.id], (deleteErr) => {
                    if (deleteErr) return res.status(500).json({ error: deleteErr.message });
                    if (ids.length === 0) return res.json({ meeting_id: meeting.id, key_user_ids: [] });

                    const placeholders = ids.map(() => '(?, ?)').join(', ');
                    const params = ids.flatMap((id) => [meeting.id, id]);
                    db.run(`INSERT INTO meeting_participants (meeting_id, key_user_id) VALUES ${placeholders}`,
                        params, (insertErr) => {
                            if (insertErr) return res.status(500).json({ error: insertErr.message });
                            res.json({ meeting_id: meeting.id, key_user_ids: ids });
                        });
                });
            };

            if (ids.length === 0) return replace();

            const placeholders = ids.map(() => '?').join(', ');
            db.all(`SELECT id FROM project_key_users WHERE project_id = ? AND id IN (${placeholders})`,
                [meeting.project_id, ...ids], (checkErr, rows) => {
                    if (checkErr) return res.status(500).json({ error: checkErr.message });
                    if ((rows || []).length !== ids.length) {
                        return res.status(404).json({ error: 'Key-User nicht in diesem Projekt gefunden.' });
                    }
                    replace();
                });
        });
    });

    // --- Transkript ---

    app.get('/api/meetings/:meetingId/transcript', requireAuth, (req, res) => {
        db.get('SELECT id, transcript FROM key_user_meetings WHERE id = ?',
            [req.params.meetingId], (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Termin nicht gefunden.' });
                res.json({ transcript: row.transcript || '' });
            });
    });

    app.put('/api/meetings/:meetingId/transcript', requireAuth, requireAdmin, (req, res) => {
        const transcript = req.body.transcript === undefined || req.body.transcript === null
            ? ''
            : String(req.body.transcript);
        db.run('UPDATE key_user_meetings SET transcript = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [transcript, req.params.meetingId], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Termin nicht gefunden.' });
                res.json({ transcript });
            });
    });

    // --- Extraktion: Workflow, Problem, Adoptionsrisiko ---

    const recordExtraction = (config) => (req, res) => {
        const text = normalizeText(req.body[config.textField]);
        if (!text) return res.status(400).json({ error: `${config.label} ist erforderlich.` });
        const description = normalizeText(req.body.description) || '';

        loadMeeting(req.params.meetingId, (err, meeting) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!meeting) return res.status(404).json({ error: 'Termin nicht gefunden.' });
            if (!meeting.department_id) {
                return res.status(409).json({ error: 'Projekt hat keine Abteilung.' });
            }

            const insert = (workflowId) => {
                const values = config.buildValues(meeting, text, description, workflowId);
                const placeholders = values.map(() => '?').join(', ');
                db.run(`INSERT INTO ${config.table} (${config.columns.join(', ')}) VALUES (${placeholders})`,
                    values, function (insertErr) {
                        if (insertErr) return res.status(500).json({ error: insertErr.message });
                        res.status(201).json({ id: this.lastID, meeting_id: meeting.id, department_id: meeting.department_id });
                    });
            };

            if (!config.hasWorkflow) return insert(null);

            const workflowId = toId(req.body.workflow_id);
            if (!workflowId) return insert(null);

            db.get('SELECT id FROM workflows WHERE id = ? AND department_id = ?',
                [workflowId, meeting.department_id], (wfErr, workflow) => {
                    if (wfErr) return res.status(500).json({ error: wfErr.message });
                    if (!workflow) return res.status(400).json({ error: 'Workflow gehoert nicht zu dieser Abteilung.' });
                    insert(workflowId);
                });
        });
    };

    app.post('/api/meetings/:meetingId/workflows', requireAuth, requireAdmin,
        recordExtraction({
            table: 'workflows',
            label: 'Beschreibung',
            textField: 'description',
            columns: ['meeting_id', 'department_id', 'description'],
            buildValues: (meeting, text) => [meeting.id, meeting.department_id, text]
        }));

    app.post('/api/meetings/:meetingId/problems', requireAuth, requireAdmin,
        recordExtraction({
            table: 'problems',
            label: 'Titel',
            textField: 'title',
            hasWorkflow: true,
            columns: ['meeting_id', 'department_id', 'workflow_id', 'title', 'description'],
            buildValues: (meeting, title, description, workflowId) =>
                [meeting.id, meeting.department_id, workflowId, title, description]
        }));

    app.post('/api/meetings/:meetingId/adoption-risks', requireAuth, requireAdmin,
        recordExtraction({
            table: 'adoption_risks',
            label: 'Titel',
            textField: 'title',
            columns: ['meeting_id', 'department_id', 'title', 'description'],
            buildValues: (meeting, title, description) =>
                [meeting.id, meeting.department_id, title, description]
        }));

    const listExtraction = (table) => (req, res) => {
        db.all(`SELECT x.*, m.title AS meeting_title, m.meeting_date
                FROM ${table} x
                JOIN key_user_meetings m ON m.id = x.meeting_id
                WHERE m.project_id = ?
                ORDER BY m.meeting_date DESC, x.id DESC`, [req.params.projectId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    };

    app.get('/api/projects/:projectId/workflows', requireAuth, listExtraction('workflows'));
    app.get('/api/projects/:projectId/problems', requireAuth, listExtraction('problems'));
    app.get('/api/projects/:projectId/adoption-risks', requireAuth, listExtraction('adoption_risks'));

    app.patch('/api/problems/:id', requireAuth, requireAdmin, (req, res) => {
        const workflowId = req.body.workflow_id === null ? null : toId(req.body.workflow_id);
        db.get('SELECT id, department_id FROM problems WHERE id = ?', [req.params.id], (err, problem) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!problem) return res.status(404).json({ error: 'Problem nicht gefunden.' });

            const update = () => {
                db.run('UPDATE problems SET workflow_id = ? WHERE id = ?', [workflowId, problem.id], (updateErr) => {
                    if (updateErr) return res.status(500).json({ error: updateErr.message });
                    res.json({ id: problem.id, workflow_id: workflowId });
                });
            };

            if (!workflowId) return update();

            db.get('SELECT id FROM workflows WHERE id = ? AND department_id = ?',
                [workflowId, problem.department_id], (wfErr, workflow) => {
                    if (wfErr) return res.status(500).json({ error: wfErr.message });
                    if (!workflow) return res.status(400).json({ error: 'Workflow gehoert nicht zu dieser Abteilung.' });
                    update();
                });
        });
    });

    const deleteExtraction = (table) => (req, res) => {
        db.run(`DELETE FROM ${table} WHERE id = ?`, [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
            res.json({ status: 'deleted' });
        });
    };

    app.delete('/api/workflows/:id', requireAuth, requireAdmin, deleteExtraction('workflows'));
    app.delete('/api/problems/:id', requireAuth, requireAdmin, deleteExtraction('problems'));
    app.delete('/api/adoption-risks/:id', requireAuth, requireAdmin, deleteExtraction('adoption_risks'));
};
