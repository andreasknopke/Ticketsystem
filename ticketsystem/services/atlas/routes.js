'use strict';

/**
 * API-Routen fuer die Atlas-Uebernahme.
 *
 * Zwei Regeln gelten fuer alle Eintraege:
 * - `department_id` und `project_id` kommen nie aus dem Request-Body, sondern
 *   immer aus Termin -> Projekt bzw. aus der URL.
 * - Ein Eintrag darf ohne Termin existieren (docs/adr/0004-wissen-ohne-termin.md).
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

const EXTRACTION_KINDS = {
    workflows: {
        table: 'workflows',
        label: 'Beschreibung',
        textField: 'description',
        columns: ['project_id', 'meeting_id', 'department_id', 'description'],
        buildValues: (ctx, text, description) =>
            [ctx.projectId, ctx.meetingId, ctx.departmentId, text]
    },
    problems: {
        table: 'problems',
        label: 'Titel',
        textField: 'title',
        hasWorkflow: true,
        columns: ['project_id', 'meeting_id', 'department_id', 'workflow_id', 'title', 'description'],
        buildValues: (ctx, text, description, workflowId) =>
            [ctx.projectId, ctx.meetingId, ctx.departmentId, workflowId, text, description]
    },
    'adoption-risks': {
        table: 'adoption_risks',
        label: 'Titel',
        textField: 'title',
        columns: ['project_id', 'meeting_id', 'department_id', 'title', 'description'],
        buildValues: (ctx, text, description) =>
            [ctx.projectId, ctx.meetingId, ctx.departmentId, text, description]
    }
};

module.exports = function registerAtlasRoutes(app, deps) {
    const { db, requireAuth, requireAdmin } = deps;

    const loadMeeting = (meetingId, callback) => {
        db.get(`SELECT m.id, m.project_id, p.department_id
                FROM key_user_meetings m
                LEFT JOIN projects p ON p.id = m.project_id
                WHERE m.id = ?`, [meetingId], callback);
    };

    const loadProject = (projectId, callback) => {
        db.get('SELECT id, department_id FROM projects WHERE id = ?', [projectId], callback);
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

    const insertExtraction = (kind, ctx, body, res) => {
        const config = EXTRACTION_KINDS[kind];
        const text = normalizeText(body[config.textField]);
        if (!text) return res.status(400).json({ error: `${config.label} ist erforderlich.` });
        const description = normalizeText(body.description) || '';

        const insert = (workflowId) => {
            const values = config.buildValues(ctx, text, description, workflowId);
            const placeholders = values.map(() => '?').join(', ');
            db.run(`INSERT INTO ${config.table} (${config.columns.join(', ')}) VALUES (${placeholders})`,
                values, function (insertErr) {
                    if (insertErr) return res.status(500).json({ error: insertErr.message });
                    res.status(201).json({
                        id: this.lastID,
                        project_id: ctx.projectId,
                        meeting_id: ctx.meetingId,
                        department_id: ctx.departmentId
                    });
                });
        };

        if (!config.hasWorkflow) return insert(null);

        const workflowId = toId(body.workflow_id);
        if (!workflowId) return insert(null);

        db.get('SELECT id FROM workflows WHERE id = ? AND project_id = ?',
            [workflowId, ctx.projectId], (wfErr, workflow) => {
                if (wfErr) return res.status(500).json({ error: wfErr.message });
                if (!workflow) return res.status(400).json({ error: 'Workflow gehoert nicht zu diesem Projekt.' });
                insert(workflowId);
            });
    };

    // Erfassung aus einem Termin (Herkunft bleibt nachvollziehbar).
    for (const kind of Object.keys(EXTRACTION_KINDS)) {
        app.post(`/api/meetings/:meetingId/${kind}`, requireAuth, requireAdmin, (req, res) => {
            loadMeeting(req.params.meetingId, (err, meeting) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!meeting) return res.status(404).json({ error: 'Termin nicht gefunden.' });
                insertExtraction(kind, {
                    projectId: meeting.project_id,
                    meetingId: meeting.id,
                    departmentId: meeting.department_id || null
                }, req.body, res);
            });
        });

        // Direkte Erfassung ohne Termin (z.B. aus einem Dokument abgeleitet).
        app.post(`/api/projects/:projectId/${kind}`, requireAuth, requireAdmin, (req, res) => {
            loadProject(req.params.projectId, (err, project) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
                insertExtraction(kind, {
                    projectId: project.id,
                    meetingId: null,
                    departmentId: project.department_id || null
                }, req.body, res);
            });
        });
    }

    const listExtraction = (kind) => (req, res) => {
        const config = EXTRACTION_KINDS[kind];
        db.all(`SELECT x.*, m.title AS meeting_title, m.meeting_date
                FROM ${config.table} x
                LEFT JOIN key_user_meetings m ON m.id = x.meeting_id
                WHERE x.project_id = ?
                ORDER BY x.created_at DESC, x.id DESC`, [req.params.projectId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    };

    for (const kind of Object.keys(EXTRACTION_KINDS)) {
        app.get(`/api/projects/:projectId/${kind}`, requireAuth, listExtraction(kind));
    }

    const deleteExtraction = (kind) => (req, res) => {
        const config = EXTRACTION_KINDS[kind];
        db.run(`DELETE FROM ${config.table} WHERE id = ?`, [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
            res.json({ status: 'deleted' });
        });
    };

    // Bearbeiten: Text (und Beschreibung) eines Eintrags korrigieren, ohne ihn
    // zu loeschen und neu anzulegen. Die Herkunft (Termin/Projekt) bleibt.
    // Bei problems laesst sich zusaetzlich der Workflow zuordnen; dann darf der
    // Titel entfallen (Teil-Update).
    const updateExtraction = (kind) => (req, res) => {
        const config = EXTRACTION_KINDS[kind];
        const hasTextField = req.body[config.textField] !== undefined;
        const text = normalizeText(req.body[config.textField]);
        const hasWorkflowField = kind === 'problems' && req.body.workflow_id !== undefined;
        const workflowId = hasWorkflowField
            ? (req.body.workflow_id === null ? null : toId(req.body.workflow_id))
            : undefined;

        if (hasTextField && !text) {
            return res.status(400).json({ error: `${config.label} ist erforderlich.` });
        }
        if (!hasTextField && !hasWorkflowField) {
            return res.status(400).json({ error: `${config.label} ist erforderlich.` });
        }

        const hasDescription = config.columns.includes('description');
        const description = normalizeText(req.body.description) || '';

        db.get(`SELECT id, project_id FROM ${config.table} WHERE id = ?`, [req.params.id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });

            const apply = () => {
                const assignments = [];
                const params = [];
                if (hasTextField) {
                    assignments.push(`${config.textField} = ?`);
                    params.push(text);
                }
                // Bei workflows IST description das Textfeld - nicht doppelt setzen.
                if (hasDescription && config.textField !== 'description' && req.body.description !== undefined) {
                    assignments.push('description = ?');
                    params.push(description);
                }
                if (hasWorkflowField) {
                    assignments.push('workflow_id = ?');
                    params.push(workflowId);
                }
                params.push(row.id);

                db.run(`UPDATE ${config.table} SET ${assignments.join(', ')} WHERE id = ?`, params, (updateErr) => {
                    if (updateErr) return res.status(500).json({ error: updateErr.message });
                    const payload = { id: row.id };
                    if (hasTextField) payload[config.textField] = text;
                    if (hasWorkflowField) payload.workflow_id = workflowId;
                    res.json(payload);
                });
            };

            if (!hasWorkflowField || !workflowId) return apply();

            db.get('SELECT id FROM workflows WHERE id = ? AND project_id = ?',
                [workflowId, row.project_id], (wfErr, workflow) => {
                    if (wfErr) return res.status(500).json({ error: wfErr.message });
                    if (!workflow) return res.status(400).json({ error: 'Workflow gehoert nicht zu diesem Projekt.' });
                    apply();
                });
        });
    };

    for (const kind of Object.keys(EXTRACTION_KINDS)) {
        app.delete(`/api/${kind}/:id`, requireAuth, requireAdmin, deleteExtraction(kind));
        app.patch(`/api/${kind}/:id`, requireAuth, requireAdmin, updateExtraction(kind));
    }
};
