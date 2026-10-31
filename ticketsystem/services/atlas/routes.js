'use strict';

const bpmn = require('./bpmn');
const { fetchCatalog } = require('./catalog');
const {
    SOLL_SYSTEM_PROMPT,
    buildSollUserPrompt,
    SOLL_BPMN_SYSTEM_PROMPT,
    buildSollBpmnUserPrompt,
    formatSollContent
} = require('./sollFlow');

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

// Ein Projekt kann mehrere Workflows beschreiben. Der Name ist optional; fehlt
// er, dient die erste Zeile der Beschreibung als Ueberschrift.
function deriveWorkflowName(text) {
    const firstLine = String(text || '').split(/\r?\n/)[0].trim();
    return firstLine ? firstLine.slice(0, 80) : null;
}

const EXTRACTION_KINDS = {
    workflows: {
        table: 'workflows',
        label: 'Beschreibung',
        textField: 'description',
        hasName: true,
        columns: ['project_id', 'meeting_id', 'department_id', 'name', 'description'],
        buildValues: (ctx, text, description, workflowId, body) =>
            [ctx.projectId, ctx.meetingId, ctx.departmentId,
                normalizeText(body.name) || deriveWorkflowName(text), text]
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
        hasWorkflow: true,
        columns: ['project_id', 'meeting_id', 'department_id', 'workflow_id', 'title', 'description'],
        buildValues: (ctx, text, description, workflowId) =>
            [ctx.projectId, ctx.meetingId, ctx.departmentId, workflowId, text, description]
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

    // Beim ersten Workflow eines Projekts wandern vorhandene Eintraege ohne
    // Zuordnung mit, damit die neue Workflow-Karte nicht leer startet.
    const adoptUnassignedEntries = (projectId, workflowId, callback) => {
        db.get('SELECT COUNT(*) AS c FROM workflows WHERE project_id = ?', [projectId], (countErr, row) => {
            if (countErr) return callback(countErr);
            if (!row || row.c !== 1) return callback();

            const tables = ['problems', 'adoption_risks', 'project_attachments', 'project_flow_summaries'];
            let pending = tables.length;
            let firstError = null;
            tables.forEach((table) => {
                db.run(`UPDATE ${table} SET workflow_id = ? WHERE project_id = ? AND workflow_id IS NULL`,
                    [workflowId, projectId], (updateErr) => {
                        if (updateErr && !firstError) firstError = updateErr;
                        pending -= 1;
                        if (pending === 0) callback(firstError);
                    });
            });
        });
    };

    const insertExtraction = (kind, ctx, body, res) => {
        const config = EXTRACTION_KINDS[kind];
        const text = normalizeText(body[config.textField]);
        if (!text) return res.status(400).json({ error: `${config.label} ist erforderlich.` });
        const description = normalizeText(body.description) || '';

        const insert = (workflowId) => {
            const values = config.buildValues(ctx, text, description, workflowId, body);
            const placeholders = values.map(() => '?').join(', ');
            db.run(`INSERT INTO ${config.table} (${config.columns.join(', ')}) VALUES (${placeholders})`,
                values, function (insertErr) {
                    if (insertErr) return res.status(500).json({ error: insertErr.message });
                    const insertedId = this.lastID;
                    const respond = () => res.status(201).json({
                        id: insertedId,
                        project_id: ctx.projectId,
                        meeting_id: ctx.meetingId,
                        department_id: ctx.departmentId,
                        workflow_id: workflowId
                    });
                    if (kind !== 'workflows') return respond();
                    adoptUnassignedEntries(ctx.projectId, insertedId, (adoptErr) => {
                        if (adoptErr) console.error('[atlas] Zuordnung zum ersten Workflow fehlgeschlagen:', adoptErr.message);
                        respond();
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
        const remove = () => db.run(`DELETE FROM ${config.table} WHERE id = ?`, [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
            res.json({ status: 'deleted' });
        });

        if (kind !== 'workflows') return remove();

        // project_attachments/project_flow_summaries haengen nicht hart per FK
        // am Workflow (PRAGMA foreign_keys ist nicht ueberall aktiv). Deshalb
        // die Zuordnung explizit loesen, damit die Eintraege als "Ohne
        // Workflow" sichtbar bleiben statt zu verschwinden.
        const tables = ['problems', 'adoption_risks', 'project_attachments', 'project_flow_summaries'];
        let pending = tables.length;
        let firstError = null;
        tables.forEach((table) => {
            db.run(`UPDATE ${table} SET workflow_id = NULL WHERE workflow_id = ?`,
                [req.params.id], (updateErr) => {
                    if (updateErr && !firstError) firstError = updateErr;
                    pending -= 1;
                    if (pending === 0) {
                        if (firstError) {
                            console.error('[atlas] Workflow-Zuordnung loesen fehlgeschlagen:', firstError.message);
                        }
                        remove();
                    }
                });
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
        const hasWorkflowField = config.hasWorkflow && req.body.workflow_id !== undefined;
        const workflowId = hasWorkflowField
            ? (req.body.workflow_id === null ? null : toId(req.body.workflow_id))
            : undefined;
        // Nur Workflows tragen einen eigenen Namen.
        const hasNameField = Boolean(config.hasName) && req.body.name !== undefined;
        const name = hasNameField ? normalizeText(req.body.name) : undefined;

        if (hasTextField && !text) {
            return res.status(400).json({ error: `${config.label} ist erforderlich.` });
        }
        if (!hasTextField && !hasWorkflowField && !hasNameField) {
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
                if (hasNameField) {
                    assignments.push('name = ?');
                    params.push(name);
                }
                params.push(row.id);

                db.run(`UPDATE ${config.table} SET ${assignments.join(', ')} WHERE id = ?`, params, (updateErr) => {
                    if (updateErr) return res.status(500).json({ error: updateErr.message });
                    const payload = { id: row.id };
                    if (hasTextField) payload[config.textField] = text;
                    if (hasWorkflowField) payload.workflow_id = workflowId;
                    if (hasNameField) payload.name = name;
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

    // workflowId gesetzt: nur die Daten dieses Workflows. Ohne workflowId
    // bleibt das Verhalten projektweit (Alt-Aufrufe und "Ohne Workflow").
    async function collectSummaryInput(projectId, workflowId = null) {
        const project = await getAsync(`SELECT p.id, p.name, p.description, p.status,
                p.start_date, p.end_date,
                s.name AS system_name, d.name AS department_name, h.name AS hospital_name
            FROM projects p
            LEFT JOIN systems s ON s.id = p.system_id
            LEFT JOIN departments d ON d.id = p.department_id
            LEFT JOIN hospitals h ON h.id = d.hospital_id
            WHERE p.id = ?`, [projectId]);
        if (!project) return null;

        let workflow = null;
        if (workflowId) {
            workflow = await getAsync('SELECT id, name, description FROM workflows WHERE id = ? AND project_id = ?',
                [workflowId, projectId]);
            if (!workflow) return { error: 'Workflow nicht gefunden.' };
        }

        // Transkripte sind die Rohquelle des Termins und nicht workflowgebunden;
        // sie fliessen in jede Zusammenfassung des Projekts ein.
        const transcripts = await allAsync(`SELECT id, title, meeting_date, start_time, transcript
            FROM key_user_meetings
            WHERE project_id = ? AND LENGTH(COALESCE(transcript, '')) > 0
            ORDER BY meeting_date ASC, id ASC`, [projectId]);

        // Nur den Input-Abschnitt: Output-Dateien beschreiben den Zielzustand.
        const attachmentFilter = workflowId ? 'AND workflow_id = ?' : '';
        const attachments = await allAsync(`SELECT filename, original_name, mimetype,
                COALESCE(phase, 'input') AS phase
            FROM project_attachments
            WHERE project_id = ? AND COALESCE(phase, 'input') != 'output' ${attachmentFilter}
            ORDER BY created_at ASC`,
        workflowId ? [projectId, workflowId] : [projectId]);

        const entryFilter = workflowId ? 'AND x.workflow_id = ?' : '';
        const entryParams = workflowId ? [projectId, workflowId] : [projectId];
        const entries = {
            workflows: await allAsync(`SELECT x.*, m.title AS meeting_title
                FROM workflows x LEFT JOIN key_user_meetings m ON m.id = x.meeting_id
                WHERE x.project_id = ? ${workflowId ? 'AND x.id = ?' : ''}
                ORDER BY x.id ASC`, entryParams),
            problems: await allAsync(`SELECT x.*, m.title AS meeting_title
                FROM problems x LEFT JOIN key_user_meetings m ON m.id = x.meeting_id
                WHERE x.project_id = ? ${entryFilter} ORDER BY x.id ASC`, entryParams),
            adoptionRisks: await allAsync(`SELECT x.*, m.title AS meeting_title
                FROM adoption_risks x LEFT JOIN key_user_meetings m ON m.id = x.meeting_id
                WHERE x.project_id = ? ${entryFilter} ORDER BY x.id ASC`, entryParams)
        };

        return { project, workflow, transcripts, attachments, entries };
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
            // Ohne workflow_id bleibt die Abfrage projektweit (Alt-Verhalten).
            // Mit gesetzter id zaehlt nur dieser Workflow.
            const hasFilter = req.query.workflow_id !== undefined;
            const workflowId = hasFilter ? toId(req.query.workflow_id) : null;
            const rows = await allAsync(`SELECT id, project_id, workflow_id, content, bpmn_xml, provider, model,
                    prompt_tokens, completion_tokens, duration_ms, input_chars, created_by, created_at
                FROM project_flow_summaries
                WHERE project_id = ? ${hasFilter ? (workflowId ? 'AND workflow_id = ?' : 'AND workflow_id IS NULL') : ''}
                ORDER BY id DESC`, hasFilter && workflowId
                ? [req.params.projectId, workflowId]
                : [req.params.projectId]);

            // Anpassungswuensche je Zusammenfassung mitliefern (Verlauf).
            const refinements = rows.length
                ? await allAsync(`SELECT id, summary_id, instruction, provider, model, created_by, created_at
                    FROM flow_bpmn_refinements
                    WHERE summary_id IN (${rows.map(() => '?').join(', ')})
                    ORDER BY id ASC`, rows.map((row) => row.id))
                : [];
            rows.forEach((row) => {
                row.refinements = refinements.filter((item) => item.summary_id === row.id);
            });

            res.json({ latest: rows[0] || null, history: rows.slice(1) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Testet die Verbindung zum CuraFlow-Funktionskatalog. force umgeht den
    // Kurzzeit-Cache, damit der Button immer die aktuelle Erreichbarkeit zeigt.
    app.get('/api/projects/:projectId/curaflow-catalog-test', requireAuth, requireAdmin, async (req, res) => {
        try {
            const result = await fetchCatalog({ force: true });
            if (!result.catalog) {
                return res.json({ ok: false, reason: result.reason || 'Funktionskatalog nicht erreichbar.' });
            }
            res.json({
                ok: true,
                catalogVersion: result.catalog.catalogVersion ?? null,
                capabilityCount: Array.isArray(result.catalog.capabilities)
                    ? result.catalog.capabilities.length
                    : 0
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Leitet aus der Ist-Zusammenfassung und dem CuraFlow-Funktionskatalog den
    // Soll-Workflow ab: eine Zusammenfassung (JSON-Vertrag, als Markdown
    // gespeichert) und ein best-effort BPMN-Diagramm des Zielzustands.
    app.post('/api/projects/:projectId/soll-flow', requireAuth, requireAdmin, async (req, res) => {
        try {
            const projectId = toId(req.params.projectId);
            if (!projectId) return res.status(400).json({ error: 'Ungueltige Projekt-ID.' });

            const rawWorkflowId = req.body.workflow_id;
            const workflowId = rawWorkflowId === undefined || rawWorkflowId === null || rawWorkflowId === ''
                ? null
                : toId(rawWorkflowId);
            if (rawWorkflowId !== undefined && rawWorkflowId !== null && rawWorkflowId !== '' && !workflowId) {
                return res.status(400).json({ error: 'Ungueltige workflow_id.' });
            }

            const collected = await collectSummaryInput(projectId, workflowId);
            if (!collected) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
            if (collected.error) return res.status(404).json({ error: collected.error });

            // Kontext ist die Ist-Zusammenfassung dieses Workflows.
            const summaryId = toId(req.body.summary_id);
            const istSummary = summaryId
                ? await getAsync('SELECT id, content FROM project_flow_summaries WHERE id = ? AND project_id = ?',
                    [summaryId, projectId])
                : await getAsync(`SELECT id, content FROM project_flow_summaries
                    WHERE project_id = ? ${workflowId ? 'AND workflow_id = ?' : 'AND workflow_id IS NULL'}
                    ORDER BY id DESC LIMIT 1`,
                workflowId ? [projectId, workflowId] : [projectId]);
            if (!istSummary) return res.status(404).json({ error: 'Ist-Zusammenfassung nicht gefunden.' });
            if (!String(istSummary.content || '').trim()) {
                return res.status(409).json({ error: 'Die Ist-Zusammenfassung ist leer. Erstelle sie zuerst unter "Input-Visualisierung".' });
            }

            const catalogResult = await fetchCatalog();
            const catalog = catalogResult.catalog;
            const catalogVersion = catalog && catalog.catalogVersion !== undefined ? catalog.catalogVersion : null;
            const capabilityCount = catalog && Array.isArray(catalog.capabilities) ? catalog.capabilities.length : 0;

            const picked = await pickSummaryStaff(toId(req.body.staff_id));
            if (picked.error) return res.status(409).json({ error: picked.error });
            const staff = picked.staff;
            const provider = staff.ai_provider || aiClient.DEFAULT_PROVIDER;

            // 1) Soll-Zusammenfassung (strukturierter JSON-Vertrag).
            let sollResult;
            try {
                sollResult = await aiClient.chat({
                    provider,
                    model: staff.ai_model || undefined,
                    temperature: staff.ai_temperature ?? 0.2,
                    maxTokens: Math.min(staff.ai_max_tokens || 2000, 4000),
                    system: SOLL_SYSTEM_PROMPT,
                    user: buildSollUserPrompt(istSummary.content, catalog),
                    json: true
                });
            } catch (err) {
                return res.status(502).json({ error: 'KI-Aufruf (Soll-Zusammenfassung) fehlgeschlagen: ' + err.message });
            }

            const parsed = aiClient.tryParseJson(sollResult.text);
            const sollContent = formatSollContent(parsed) || String(sollResult.text || '').trim();
            if (!sollContent) return res.status(502).json({ error: 'KI hat keinen Soll-Workflow geliefert.' });

            // 2) Soll-Diagramm als zweiter, best-effort Aufruf.
            let bpmnXml = null;
            let bpmnError = null;
            try {
                const bpmnResult = await aiClient.chat({
                    provider,
                    model: staff.ai_model || undefined,
                    temperature: staff.ai_temperature ?? 0.2,
                    maxTokens: Math.min(staff.ai_max_tokens || 6000, 8000),
                    system: SOLL_BPMN_SYSTEM_PROMPT,
                    user: buildSollBpmnUserPrompt(sollContent, catalog),
                    json: false
                });
                const extracted = flowSummary.extractBpmnXml(bpmnResult.text);
                const orientation = req.body.orientation === 'landscape' ? 'landscape' : 'portrait';
                bpmnXml = extracted ? await bpmn.layoutBpmnXml(extracted, { orientation }) : null;
            } catch (err) {
                bpmnError = err.message;
            }

            const inserted = await runAsync(`INSERT INTO project_soll_flows
                    (project_id, workflow_id, summary_id, content, bpmn_xml, catalog_version, capability_count,
                     provider, model, prompt_tokens, completion_tokens, duration_ms, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [projectId, workflowId, istSummary.id, sollContent, bpmnXml, catalogVersion, capabilityCount,
                sollResult.provider || provider, sollResult.model || staff.ai_model || null,
                sollResult.prompt_tokens || null, sollResult.completion_tokens || null,
                sollResult.duration_ms || null, req.session.user || null]);

            res.status(201).json({
                id: inserted.lastID,
                workflow_id: workflowId,
                summary_id: istSummary.id,
                content: sollContent,
                bpmn_xml: bpmnXml,
                bpmn_error: bpmnError,
                catalog_version: catalogVersion,
                capability_count: capabilityCount,
                provider: sollResult.provider || provider,
                model: sollResult.model || staff.ai_model || null,
                staff_name: staff.name
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/projects/:projectId/flow-summary', requireAuth, requireAdmin, async (req, res) => {
        try {
            const rawWorkflowId = req.body.workflow_id;
            const workflowId = rawWorkflowId === undefined || rawWorkflowId === null || rawWorkflowId === ''
                ? null
                : toId(rawWorkflowId);
            if (rawWorkflowId !== undefined && rawWorkflowId !== null && rawWorkflowId !== '' && !workflowId) {
                return res.status(400).json({ error: 'Ungueltige workflow_id.' });
            }

            const collected = await collectSummaryInput(req.params.projectId, workflowId);
            if (!collected) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
            if (collected.error) return res.status(404).json({ error: collected.error });

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

            // BPMN-Diagramm (Ist-Zustand) als zweiter, best-effort Aufruf. Ein
            // Fehler hier darf die Text-Zusammenfassung nicht ungueltig machen.
            let bpmnXml = null;
            let bpmnError = null;
            try {
                const bpmnResult = await aiClient.chat({
                    provider,
                    model: staff.ai_model || undefined,
                    temperature: staff.ai_temperature ?? 0.2,
                    // XML ist ausfuehrlicher als Prosa; etwas mehr Platz einraeumen.
                    maxTokens: Math.min(staff.ai_max_tokens || 6000, 8000),
                    system: flowSummary.BPMN_SYSTEM_PROMPT,
                    user: flowSummary.buildBpmnUserPrompt(redacted.redacted),
                    json: false
                });
                const extracted = flowSummary.extractBpmnXml(bpmnResult.text);
                const orientation = req.body.orientation === 'landscape' ? 'landscape' : 'portrait';
                bpmnXml = extracted ? await bpmn.layoutBpmnXml(extracted, { orientation }) : null;
            } catch (err) {
                bpmnError = err.message;
            }

            const inserted = await runAsync(`INSERT INTO project_flow_summaries
                    (project_id, workflow_id, content, bpmn_xml, provider, model, prompt_tokens, completion_tokens,
                     duration_ms, input_chars, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.params.projectId, workflowId, content, bpmnXml, result.provider || provider, result.model || staff.ai_model || null,
                result.prompt_tokens || null, result.completion_tokens || null,
                result.duration_ms || null, built.text.length, req.session.user || null]);

            res.status(201).json({
                id: inserted.lastID,
                workflow_id: workflowId,
                content,
                bpmn_xml: bpmnXml,
                bpmn_error: bpmnError,
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

    // Ueberarbeitet ein bestehendes Diagramm anhand eines Anpassungswunsches.
    // Die Text-Zusammenfassung bleibt unveraendert; nur das Diagramm wird neu
    // erzeugt und neu gesetzt. Der Wunsch wird protokolliert.
    app.post('/api/projects/:projectId/flow-summary/:summaryId/bpmn-refine', requireAuth, requireAdmin, async (req, res) => {
        try {
            const projectId = toId(req.params.projectId);
            const summaryId = toId(req.params.summaryId);
            if (!projectId || !summaryId) return res.status(400).json({ error: 'Ungueltige IDs.' });

            const instruction = normalizeText(req.body.instruction);
            if (!instruction) return res.status(400).json({ error: 'Anpassungswunsch ist erforderlich.' });
            if (instruction.length > 2000) {
                return res.status(400).json({ error: 'Anpassungswunsch ist zu lang (max. 2000 Zeichen).' });
            }

            const existing = await getAsync(`SELECT s.id, s.workflow_id, s.bpmn_xml,
                    w.name AS workflow_name, w.description AS workflow_description
                FROM project_flow_summaries s
                LEFT JOIN workflows w ON w.id = s.workflow_id
                WHERE s.id = ? AND s.project_id = ?`, [summaryId, projectId]);
            if (!existing) return res.status(404).json({ error: 'Zusammenfassung nicht gefunden.' });
            if (!existing.bpmn_xml) {
                return res.status(400).json({ error: 'Zu dieser Zusammenfassung gibt es kein Diagramm.' });
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
                    maxTokens: Math.min(staff.ai_max_tokens || 6000, 8000),
                    system: flowSummary.BPMN_REFINE_SYSTEM_PROMPT,
                    user: flowSummary.buildBpmnRefineUserPrompt({
                        currentXml: existing.bpmn_xml,
                        instruction,
                        workflowName: existing.workflow_name,
                        workflowDescription: existing.workflow_description
                    }),
                    json: false
                });
            } catch (err) {
                return res.status(502).json({ error: 'KI-Aufruf fehlgeschlagen: ' + err.message });
            }

            const extracted = flowSummary.extractBpmnXml(result.text);
            if (!extracted) {
                return res.status(502).json({ error: 'KI hat kein gueltiges BPMN-XML geliefert.' });
            }

            // Ausrichtung: explizit gewuenscht, sonst wie im bestehenden Diagramm.
            const orientation = req.body.orientation === 'landscape' || req.body.orientation === 'portrait'
                ? req.body.orientation
                : (existing.bpmn_xml.includes('isHorizontal="true"') ? 'landscape' : 'portrait');

            let bpmnXml;
            try {
                bpmnXml = await bpmn.layoutBpmnXml(extracted, { orientation });
            } catch (err) {
                return res.status(502).json({ error: 'Diagramm konnte nicht gesetzt werden: ' + err.message });
            }

            await runAsync('UPDATE project_flow_summaries SET bpmn_xml = ? WHERE id = ?', [bpmnXml, summaryId]);
            await runAsync(`INSERT INTO flow_bpmn_refinements (summary_id, instruction, provider, model, created_by)
                VALUES (?, ?, ?, ?, ?)`,
            [summaryId, instruction, result.provider || provider, result.model || staff.ai_model || null,
                req.session.user || null]);

            res.json({
                id: summaryId,
                workflow_id: existing.workflow_id,
                bpmn_xml: bpmnXml,
                instruction,
                orientation,
                provider: result.provider || provider,
                model: result.model || staff.ai_model || null,
                staff_name: staff.name
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Speichert das im Editor verschobene/angepasste BPMN-Diagramm zurueck.
    app.patch('/api/projects/:projectId/flow-summary/:summaryId/bpmn', requireAuth, requireAdmin, async (req, res) => {
        try {
            const projectId = toId(req.params.projectId);
            const summaryId = toId(req.params.summaryId);
            if (!projectId || !summaryId) return res.status(400).json({ error: 'Ungueltige IDs.' });

            const bpmnXml = normalizeText(req.body.bpmn_xml);
            if (!bpmnXml) return res.status(400).json({ error: 'Kein bpmn_xml uebergeben.' });

            const existing = await getAsync(
                'SELECT id FROM project_flow_summaries WHERE id = ? AND project_id = ?',
                [summaryId, projectId]);
            if (!existing) return res.status(404).json({ error: 'Zusammenfassung nicht gefunden.' });

            await runAsync('UPDATE project_flow_summaries SET bpmn_xml = ? WHERE id = ?',
                [bpmnXml, summaryId]);

            res.json({ id: summaryId, updated: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
