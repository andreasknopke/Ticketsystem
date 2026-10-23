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
    const { db, requireAuth, requireAdmin, aiClient, redactor, flowSummary } = deps;

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

    // --- KI-Zusammenfassung der Bestandsaufnahme ---

    const allAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
    const getAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
    });
    const runAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });

    async function collectSummaryInput(projectId) {
        const project = await getAsync(`SELECT p.id, p.name, p.description, p.status,
                p.start_date, p.end_date,
                s.name AS system_name, d.name AS department_name, h.name AS hospital_name
            FROM projects p
            LEFT JOIN systems s ON s.id = p.system_id
            LEFT JOIN departments d ON d.id = p.department_id
            LEFT JOIN hospitals h ON h.id = d.hospital_id
            WHERE p.id = ?`, [projectId]);
        if (!project) return null;

        const transcripts = await allAsync(`SELECT id, title, meeting_date, start_time, transcript
            FROM key_user_meetings
            WHERE project_id = ? AND LENGTH(COALESCE(transcript, '')) > 0
            ORDER BY meeting_date ASC, id ASC`, [projectId]);

        // Nur den Input-Abschnitt: Output-Dateien beschreiben den Zielzustand.
        const attachments = await allAsync(`SELECT filename, original_name, mimetype,
                COALESCE(phase, 'input') AS phase
            FROM project_attachments
            WHERE project_id = ? AND COALESCE(phase, 'input') != 'output'
            ORDER BY created_at ASC`, [projectId]);

        const entries = {
            workflows: await allAsync(`SELECT x.*, m.title AS meeting_title
                FROM workflows x LEFT JOIN key_user_meetings m ON m.id = x.meeting_id
                WHERE x.project_id = ? ORDER BY x.id ASC`, [projectId]),
            problems: await allAsync(`SELECT x.*, m.title AS meeting_title
                FROM problems x LEFT JOIN key_user_meetings m ON m.id = x.meeting_id
                WHERE x.project_id = ? ORDER BY x.id ASC`, [projectId]),
            adoptionRisks: await allAsync(`SELECT x.*, m.title AS meeting_title
                FROM adoption_risks x LEFT JOIN key_user_meetings m ON m.id = x.meeting_id
                WHERE x.project_id = ? ORDER BY x.id ASC`, [projectId])
        };

        return { project, transcripts, attachments, entries };
    }

    async function pickSummaryStaff(staffId) {
        if (staffId) {
            const staff = await getAsync(
                "SELECT * FROM staff WHERE id = ? AND kind = 'ai' AND active = 1", [staffId]);
            if (!staff) return { error: 'KI-Mitarbeiter nicht gefunden oder inaktiv.' };
            return { staff };
        }
        // Bevorzugt der Planer: er bekommt die Aufgabe, aus Ist-Zustand einen
        // Zielzustand abzuleiten.
        const staff = await getAsync(`SELECT s.* FROM staff s
            WHERE s.kind = 'ai' AND s.active = 1
            ORDER BY (SELECT COUNT(*) FROM staff_roles r
                      WHERE r.staff_id = s.id AND r.role = 'planning' AND r.active = 1) DESC,
                     s.id ASC
            LIMIT 1`);
        if (!staff) return { error: 'Kein KI-Mitarbeiter konfiguriert. Lege unter Mitarbeiter einen Bot an.' };
        return { staff };
    }

    app.get('/api/projects/:projectId/flow-summary', requireAuth, async (req, res) => {
        try {
            const rows = await allAsync(`SELECT id, content, provider, model, prompt_tokens,
                    completion_tokens, duration_ms, input_chars, created_by, created_at
                FROM project_flow_summaries
                WHERE project_id = ?
                ORDER BY id DESC`, [req.params.projectId]);
            res.json({ latest: rows[0] || null, history: rows.slice(1) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/projects/:projectId/flow-summary', requireAuth, requireAdmin, async (req, res) => {
        try {
            const collected = await collectSummaryInput(req.params.projectId);
            if (!collected) return res.status(404).json({ error: 'Projekt nicht gefunden.' });

            const built = flowSummary.buildInput(collected);
            if (!built.text.trim()) return res.status(400).json({ error: 'Keine Eingaben vorhanden.' });

            // Vor dem Aufruf redigieren: Transkripte enthalten Kontaktdaten.
            const redacted = redactor.redact(built.text);
            const dryRun = req.body.dry_run === true || req.body.dry_run === 'true';

            if (dryRun) {
                return res.json({
                    dry_run: true,
                    stats: built.stats,
                    truncated: built.truncated,
                    redaction_hits: redacted.hits,
                    input: redacted.redacted
                });
            }

            const picked = await pickSummaryStaff(toId(req.body.staff_id));
            if (picked.error) return res.status(409).json({ error: picked.error });
            const staff = picked.staff;

            const provider = staff.ai_provider || aiClient.DEFAULT_PROVIDER;
            let result;
            try {
                result = await aiClient.chat({
                    provider,
                    model: staff.ai_model || undefined,
                    temperature: staff.ai_temperature ?? 0.2,
                    // Zusammenfassung ist kurz; das Provider-Maximum waere hier
                    // nur teuer und langsam.
                    maxTokens: Math.min(staff.ai_max_tokens || 2000, 4000),
                    system: flowSummary.SYSTEM_PROMPT,
                    user: flowSummary.buildUserPrompt(redacted.redacted),
                    json: false
                });
            } catch (err) {
                return res.status(502).json({ error: 'KI-Aufruf fehlgeschlagen: ' + err.message });
            }

            const content = String(result.text || '').trim();
            if (!content) return res.status(502).json({ error: 'KI hat keine Zusammenfassung geliefert.' });

            const inserted = await runAsync(`INSERT INTO project_flow_summaries
                    (project_id, content, provider, model, prompt_tokens, completion_tokens,
                     duration_ms, input_chars, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.params.projectId, content, result.provider || provider, result.model || staff.ai_model || null,
                result.prompt_tokens || null, result.completion_tokens || null,
                result.duration_ms || null, built.text.length, req.session.user || null]);

            res.status(201).json({
                id: inserted.lastID,
                content,
                provider: result.provider || provider,
                model: result.model || staff.ai_model || null,
                staff_name: staff.name,
                stats: built.stats,
                truncated: built.truncated,
                redaction_hits: redacted.hits.length,
                prompt_tokens: result.prompt_tokens || null,
                completion_tokens: result.completion_tokens || null
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
