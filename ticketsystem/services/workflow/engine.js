'use strict';

// Workflow-Engine: laedt Stages aus DB, fuehrt sie sequentiell aus, persistiert Steps.

const aiClient = require('../ai/client');
const prompts = require('../ai/prompts');
const { redact } = require('../ai/redact');
const { pickStaffForRole, pickTicketAssignee } = require('./assignment');
const { fetchRepoContext, fetchFilesFromRepo, commitFilesAsPR } = require('./githubContext');
const { runCodeChecks } = require('./codeChecks');

const MAX_RETRIES = parseInt(process.env.AI_WORKFLOW_MAX_RETRIES, 10) || 2;

let dbRef = null;
let ioRef = null;
const SLA_HOURS = {
    first_response: { kritisch: 1, hoch: 4, mittel: 8, niedrig: 24 },
    resolution: { kritisch: 4, hoch: 24, mittel: 72, niedrig: 168 }
};

function init({ db, io }) {
    dbRef = db;
    ioRef = io;
}

// ----- Logging -----
function wfLog(level, msg, data) {
    const ts = new Date().toISOString();
    const prefix = `[WF:${level}] ${ts}`;
    if (data !== undefined) {
        const extra = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 4000);
        console.log(`${prefix} ${msg} | ${extra}`);
    } else {
        console.log(`${prefix} ${msg}`);
    }
}
function wfInfo(msg, data) { wfLog('INFO', msg, data); }
function wfWarn(msg, data) { wfLog('WARN', msg, data); }
function wfError(msg, data) { wfLog('ERROR', msg, data); }
function wfDebug(msg, data) { wfLog('DEBUG', msg, data); }

function getRow(sql, params) {
    return new Promise((resolve, reject) => {
        dbRef.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}

function getAll(sql, params) {
    return new Promise((resolve, reject) => {
        dbRef.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}

function run(sql, params) {
    return new Promise((resolve, reject) => {
        dbRef.run(sql, params, function(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function emit(event, payload) {
    if (ioRef) {
        try { ioRef.emit(event, payload); } catch (_) {}
    }
}

function safeJsonParse(text, fallback) {
    if (!text) return fallback;
    try { return JSON.parse(text); } catch (_) { return fallback; }
}

function normalizeText(value, maxLen) {
    return String(value || '').trim().slice(0, maxLen);
}

function validEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function calcSlaDue(priority, createdAt) {
    const start = new Date(createdAt);
    const firstHours = SLA_HOURS.first_response[priority] || 8;
    const resolutionHours = SLA_HOURS.resolution[priority] || 72;
    return {
        first: new Date(start.getTime() + firstHours * 3600000).toISOString(),
        resolution: new Date(start.getTime() + resolutionHours * 3600000).toISOString()
    };
}

async function initTicketSla(ticketId, priority, createdAt) {
    const due = calcSlaDue(priority, createdAt);
    await run(`INSERT OR REPLACE INTO ticket_sla
        (ticket_id, first_response_due, resolution_due) VALUES (?, ?, ?)`,
        [ticketId, due.first, due.resolution]);
}

async function addActivity(ticketId, actor, actionType, actionText, metadata) {
    await run(`INSERT INTO activity_stream (ticket_id, actor, action_type, action_text, metadata)
        VALUES (?, ?, ?, ?, ?)`, [ticketId, actor || null, actionType, actionText, JSON.stringify(metadata || {})]);
    emit('activity', { ticketId, actor, actionType, actionText, metadata: metadata || {}, timestamp: new Date() });
}

async function updateTicketState(ticketId, updates) {
    if (!ticketId || !updates || !Object.keys(updates).length) return;
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), ticketId];
    await run(`UPDATE tickets SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, values);
    if (ioRef) {
        const payload = { ticketId, updates };
        try { ioRef.emit('ticket-updated', payload); } catch (_) {}
        try { ioRef.to(`ticket-${ticketId}`).emit('ticket-updated', payload); } catch (_) {}
    }
}

function normalizeSplitTickets(input, parentTicket, fallbackSystemId) {
    if (!Array.isArray(input)) return [];
    const allowedTypes = ['bug', 'feature'];
    const allowedPriorities = ['niedrig', 'mittel', 'hoch', 'kritisch'];
    const allowedUrgency = ['normal', 'emergency', 'safety'];
    return input.map((item, index) => {
        const title = normalizeText(item?.title || `Teilticket ${index + 1}`, 200);
        const description = normalizeText(item?.description || '', 5000);
        const systemId = Number.isInteger(item?.system_id) ? item.system_id : (item?.system_id ? parseInt(item.system_id, 10) : (fallbackSystemId || parentTicket.system_id || null));
        return {
            title: title || `Teilticket ${index + 1}`,
            description,
            type: validEnum(item?.type, allowedTypes, parentTicket.type || 'bug'),
            priority: validEnum(item?.priority, allowedPriorities, parentTicket.priority || 'mittel'),
            urgency: validEnum(item?.urgency, allowedUrgency, parentTicket.urgency || 'normal'),
            system_id: Number.isFinite(systemId) ? systemId : (parentTicket.system_id || null)
        };
    }).filter(item => item.title && item.description);
}

async function createSplitTickets(parentTicket, splitTickets, actor) {
    const createdIds = [];
    for (const part of splitTickets) {
        const createdAt = new Date().toISOString();
        const deadline = parentTicket.deadline || null;
        const description = `${part.description}\n\nAbgeleitet aus Ticket #${parentTicket.id}: ${parentTicket.title}`.slice(0, 5000);
        const result = await run(`INSERT INTO tickets
            (type, title, description, username, console_logs, software_info, status, priority, system_id, assigned_to, location, contact_email, urgency, deadline, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'offen', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [
            part.type,
            part.title,
            description,
            parentTicket.username || null,
            parentTicket.console_logs || null,
            parentTicket.software_info || null,
            part.priority,
            part.system_id || null,
            null,
            parentTicket.location || null,
            parentTicket.contact_email || null,
            part.urgency,
            deadline
        ]);
        const childId = result.lastID;
        createdIds.push(childId);
        await initTicketSla(childId, part.priority, createdAt);
        await addActivity(childId, actor, 'created', `Teilticket aus Split von #${parentTicket.id} erstellt`, {
            parent_ticket_id: parentTicket.id,
            source: 'workflow_split'
        });
        startForTicket(childId).catch(err => wfError(`Split-Child Workflow-Start fehlgeschlagen ticket=${childId}`, err.message));
    }
    return createdIds;
}

async function pickStaff(role, executorKind, options) {
    return new Promise((resolve, reject) => {
        pickStaffForRole(dbRef, role, executorKind, (err, staff) => err ? reject(err) : resolve(staff), options || {});
    });
}

async function pickInitialAssignee(systemId) {
    return new Promise((resolve, reject) => {
        pickTicketAssignee(dbRef, systemId, (err, staff) => err ? reject(err) : resolve(staff));
    });
}

async function getGithubIntegrationForSystem(systemId) {
    if (!systemId) return null;

    const direct = await getRow(`SELECT id, repo_owner, repo_name,
        repo_access_token AS access_token,
        repo_webhook_secret AS webhook_secret,
        'system' AS integration_scope
        FROM systems
        WHERE id = ? AND repo_owner IS NOT NULL AND repo_name IS NOT NULL`, [systemId]);
    if (direct) return direct;

    return await getRow(`SELECT gi.*, 'project' AS integration_scope FROM github_integration gi
        INNER JOIN projects p ON p.id = gi.project_id
        WHERE p.system_id = ? LIMIT 1`, [systemId]);
}

async function callAIWithStaff(staff, { systemPrompt, userPrompt, json = true, retries = MAX_RETRIES, maxTokensOverride = null }) {
    const provider = staff.ai_provider || aiClient.DEFAULT_PROVIDER;
    const model = staff.ai_model || undefined;
    const temperature = staff.ai_temperature ?? 0.2;
    // Reihenfolge: expliziter Stage-Override > Staff-Konfiguration > Provider-Default.
    const maxTokens = maxTokensOverride || staff.ai_max_tokens || undefined;
    const finalSystem = staff.ai_system_prompt || systemPrompt;
    let extra;
    if (staff.ai_extra_config) {
        try { extra = JSON.parse(staff.ai_extra_config); } catch (_) {}
    }

    wfInfo(`AI-Call start | provider=${provider} model=${model || 'default'} temp=${temperature} maxTokens=${maxTokens || 'default'} staff="${staff.name}" sysPrompt_len=${finalSystem.length} userPrompt_len=${userPrompt.length} retries=${retries}`);

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            if (attempt > 0) wfWarn(`AI-Call retry ${attempt}/${retries}`, lastErr?.message);
            const r = await aiClient.chat({
                provider, model, temperature, maxTokens,
                system: finalSystem,
                user: userPrompt,
                json,
                extra
            });
            const parsed = json ? aiClient.tryParseJson(r.text) : null;
            const finishReason = r.raw?.choices?.[0]?.finish_reason || null;
            const truncated = finishReason === 'length';
            wfInfo(`AI-Call success | attempt=${attempt} provider=${r.provider} model=${r.model} resp_len=${r.text?.length || 0} parsed=${!!parsed} duration_ms=${r.duration_ms} prompt_tokens=${r.prompt_tokens || '?'} completion_tokens=${r.completion_tokens || '?'} finish_reason=${finishReason || '?'} truncated=${truncated}`);
            if (json && !parsed) {
                wfWarn(`AI-Call JSON parse failed | raw_preview=${(r.text || '').slice(0, 500)}`);
                if (finishReason) wfWarn(`AI-Call finish_reason=${finishReason}`);
            }
            return { ...r, parsed, finish_reason: finishReason, truncated };
        } catch (e) {
            lastErr = e;
            wfWarn(`AI-Call attempt ${attempt} failed`, e.message);
            if (attempt < retries) {
                const delay = 500 * Math.pow(2, attempt);
                await new Promise(res => setTimeout(res, delay));
            }
        }
    }
    wfError(`AI-Call all ${retries + 1} attempts failed`, lastErr?.message);
    throw lastErr;
}

async function startStep(runId, stage, sortOrder, staff) {
    const r = await run(`INSERT INTO ticket_workflow_steps
        (run_id, stage, sort_order, staff_id, executor_kind, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'in_progress', CURRENT_TIMESTAMP)`,
        [runId, stage, sortOrder, staff?.id || null, staff?.kind || null]);
    return r.lastID;
}

async function finishStep(stepId, { status, output, ai }) {
    await run(`UPDATE ticket_workflow_steps SET
        status = ?, output_payload = ?, provider = ?, model = ?,
        prompt_tokens = ?, completion_tokens = ?, duration_ms = ?,
        finished_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [status,
         output ? JSON.stringify(output) : null,
         ai?.provider || null, ai?.model || null,
         ai?.prompt_tokens || null, ai?.completion_tokens || null,
         ai?.duration_ms || null,
         stepId]);
}

async function failStep(stepId, message) {
    wfError(`Step fail stepId=${stepId}`, message);
    await run(`UPDATE ticket_workflow_steps SET status='failed', error=?, finished_at=CURRENT_TIMESTAMP WHERE id = ?`,
        [String(message).slice(0, 2000), stepId]);
}

async function skipStep(runId, stage, sortOrder, reason) {
    wfInfo(`Step skip | stage=${stage} reason=${reason}`);
    await run(`INSERT INTO ticket_workflow_steps
        (run_id, stage, sort_order, status, output_payload, created_at, finished_at)
        VALUES (?, ?, ?, 'skipped', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [runId, stage, sortOrder, JSON.stringify({ reason })]);
}

async function saveArtifact({ ticketId, runId, stepId, stage, kind, filename, mimeType, content }) {
    if (!content) return null;
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf-8');
    const r = await run(`INSERT INTO workflow_artifacts
        (ticket_id, run_id, step_id, stage, kind, filename, mime_type, size, content)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ticketId, runId || null, stepId || null, stage || null, kind, filename, mimeType || 'text/markdown', buf.length, buf]);
    return r.lastID;
}

// --- Stage-Executors ---

function extraInfoSuffix(ctx) {
    if (!ctx || !ctx.extra_info) return '';
    return `\n\n--- Zusatzinformation vom menschlichen Reviewer (bitte beruecksichtigen) ---\n${ctx.extra_info}\n--- Ende Zusatzinformation ---`;
}

async function execTriage(ctx) {
    wfInfo(`Stage:TRIAGE start | ticket=${ctx.ticket.id} title="${(ctx.ticket.title || '').slice(0, 80)}"`);
    const systems = await getAll('SELECT id, name, description FROM systems WHERE active = 1 ORDER BY id', []);
    const userPrompt = prompts.TRIAGE.buildUser({ ticket: ctx.ticket, systems }) + extraInfoSuffix(ctx);
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.TRIAGE.system, userPrompt });
    const out = r.parsed || { decision: 'unclear', reason: 'Antwort nicht parsebar', summary: '', suggested_action: '', split_reason: '', split_tickets: [] };
    if (out.decision === 'split' && !Array.isArray(out.split_tickets)) out.split_tickets = [];
    if (out.decision !== 'split') {
        out.split_reason = out.split_reason || '';
        out.split_tickets = Array.isArray(out.split_tickets) ? out.split_tickets : [];
    }
    if (out.system_id) {
        await run('UPDATE tickets SET system_id = ? WHERE id = ?', [out.system_id, ctx.ticket.id]);
    }
    ctx.triage = out;
    wfInfo(`Stage:TRIAGE done | decision=${out.decision} system_id=${out.system_id || 'none'}`, out.reason);
    return { output: out, ai: r };
}

async function execSecurity(ctx) {
    wfInfo(`Stage:SECURITY start | ticket=${ctx.ticket.id}`);
    const pre = redact(ctx.ticket.description || '');
    const userPrompt = prompts.SECURITY.buildUser({
        ticket: { ...ctx.ticket, triage_summary: ctx.triage?.summary, triage_action: ctx.triage?.suggested_action },
        preRedacted: pre.redacted
    }) + extraInfoSuffix(ctx);
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.SECURITY.system, userPrompt });
    const out = r.parsed || { redacted_text: pre.redacted, findings: pre.hits, coding_prompt: pre.redacted };
    const redacted = out.redacted_text || pre.redacted;
    const codingPrompt = out.coding_prompt || '';
    await run(`UPDATE tickets SET redacted_description = ?, coding_prompt = ? WHERE id = ?`,
        [redacted, codingPrompt, ctx.ticket.id]);
    ctx.redacted_description = redacted;
    ctx.coding_prompt = codingPrompt;
    out.markdown = `### Coding-Prompt\n\n${codingPrompt || '(leer)'}\n\n### Redigierte Beschreibung\n\n${redacted || '(leer)'}`;
    ctx._artifacts = [
        { kind: 'redacted_description', filename: 'redacted_description.md', content: redacted },
        { kind: 'coding_prompt', filename: 'coding_prompt.md', content: codingPrompt }
    ];
    wfInfo(`Stage:SECURITY done | coding_prompt_len=${codingPrompt.length} redacted_len=${redacted.length}`);
    return { output: out, ai: r };
}

async function execPlanning(ctx) {
    wfInfo(`Stage:PLANNING start | ticket=${ctx.ticket.id} system_id=${ctx.ticket.system_id || 'none'}`);
    const integration = await getGithubIntegrationForSystem(ctx.ticket.system_id);
    wfInfo(`Stage:PLANNING integration lookup | found=${!!integration} owner=${integration?.repo_owner || '-'} repo=${integration?.repo_name || '-'} hasToken=${!!integration?.access_token}`);
    const repoCtx = await fetchRepoContext(integration);
    ctx.repo_context = repoCtx.repoContext;
    ctx.repo_source = repoCtx.source;
    ctx.repo_tree = repoCtx.repoTree || '';
    ctx.boundary_files = Array.isArray(repoCtx.boundaryFiles) ? repoCtx.boundaryFiles : [];
    wfInfo(`Stage:PLANNING repoContext | source=${repoCtx.source} doc_len=${repoCtx.repoContext.length} tree_len=${ctx.repo_tree.length} boundary_files=${ctx.boundary_files.length}`);

    const baseTicket = { ...ctx.ticket, redacted_description: ctx.redacted_description, coding_prompt: ctx.coding_prompt };

    // -------- Pass 1: Plan auf Basis von Doku + Tree + Boundary --------
    const userPrompt1 = prompts.PLANNING.buildUser({
        ticket: baseTicket,
        repoContext: repoCtx.repoContext,
        repoTree: ctx.repo_tree,
        boundaryFiles: ctx.boundary_files,
        currentFiles: null,
        passNote: 'Pass 1 von 2 - liste in candidate_files Pfade, deren echten Inhalt du fuer einen verlaesslichen Plan brauchst.'
    }) + extraInfoSuffix(ctx);
    const r1 = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.PLANNING.system, userPrompt: userPrompt1 });
    const out1 = r1.parsed || { summary: r1.text?.slice(0, 500) || '', steps: [], risks: ['Antwort nicht parsebar'] };
    if (!Array.isArray(out1.candidate_files)) out1.candidate_files = [];
    if (!Array.isArray(out1.allowed_files)) out1.allowed_files = [];

    // -------- Pass 2: Plan mit echten Dateiinhalten --------
    const treePathsSet = new Set((ctx.repo_tree || '').split('\n').map(s => s.trim()).filter(Boolean));
    const validate = p => typeof p === 'string' && p.trim() && !p.includes('..') && !p.startsWith('/');
    const candidateUnion = [...new Set([...out1.candidate_files, ...out1.allowed_files].filter(validate).map(p => p.trim()))]
        .filter(p => !treePathsSet.size || treePathsSet.has(p) || true) // tree may be truncated -> nicht hart filtern
        .slice(0, 12);

    const twoPassEnabled = process.env.AI_PLANNER_TWO_PASS !== '0';
    let currentFiles = [];
    if (twoPassEnabled && integration && candidateUnion.length) {
        try {
            currentFiles = await fetchFilesFromRepo(integration, candidateUnion);
            wfInfo(`Stage:PLANNING pass2 currentFiles | requested=${candidateUnion.length} loaded=${currentFiles.length} existing=${currentFiles.filter(f => f.exists).length}`);
        } catch (e) {
            wfWarn(`Stage:PLANNING pass2 currentFiles fetch failed`, e.message);
        }
    }

    let r2 = null;
    let out = out1;
    if (twoPassEnabled && currentFiles.length) {
        const userPrompt2 = prompts.PLANNING.buildUser({
            ticket: baseTicket,
            repoContext: repoCtx.repoContext,
            repoTree: ctx.repo_tree,
            boundaryFiles: ctx.boundary_files,
            currentFiles,
            passNote: 'Pass 2 von 2 - die unten eingebetteten AKTUELLEN INHALTE sind verbindlich. Korrigiere allowed_files, steps und risks entsprechend. Halluziniere keine zusaetzlichen Pfade.'
        }) + extraInfoSuffix(ctx);
        try {
            r2 = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.PLANNING.system, userPrompt: userPrompt2 });
            const out2 = r2.parsed;
            if (out2 && typeof out2 === 'object') out = out2;
            else wfWarn(`Stage:PLANNING pass2 unparsebar - behalte Pass-1-Plan`);
        } catch (e) {
            wfWarn(`Stage:PLANNING pass2 call failed - behalte Pass-1-Plan`, e.message);
        }
    } else {
        wfInfo(`Stage:PLANNING two-pass skipped | enabled=${twoPassEnabled} hasIntegration=${!!integration} candidates=${candidateUnion.length}`);
    }

    // Scope-Contract normalisieren
    // Strenger Pfad-Filter: keine Whitespaces, muss Datei-Endung haben (filtert Platzhalter wie "zu bestimmende Datei")
    const looksLikePath = p => typeof p === 'string'
        && validate(p)
        && !/\s/.test(p.trim())
        && /\.[A-Za-z0-9]{1,8}$/.test(p.trim());
    const inTreeIfKnown = p => !treePathsSet.size || treePathsSet.has(p);

    if (!Array.isArray(out.allowed_files)) out.allowed_files = [];
    out.allowed_files = [...new Set(out.allowed_files.filter(looksLikePath).map(p => p.trim()))]
        .slice(0, 25);

    // Fallback: Wenn der Planner keinen Whitelist-Pfad geliefert hat, aus
    // steps[].files und candidate_files harvesten, damit der Coding-Bot ueberhaupt
    // einen Scope-Contract bekommt (sonst blockt Scope-Validator garantiert).
    if (!out.allowed_files.length) {
        const fromSteps = Array.isArray(out.steps)
            ? out.steps.flatMap(s => Array.isArray(s?.files) ? s.files : [])
            : [];
        const fromCandidates = Array.isArray(out.candidate_files) ? out.candidate_files : [];
        const harvested = [...new Set(
            [...fromSteps, ...fromCandidates]
                .filter(looksLikePath)
                .map(p => p.trim())
                .filter(inTreeIfKnown)
        )].slice(0, 25);
        if (harvested.length) {
            out.allowed_files = harvested;
            out._allowed_files_fallback = true;
            wfWarn(`Stage:PLANNING allowed_files leer - Fallback aus steps/candidates | count=${harvested.length} paths=${harvested.join(',')}`);
        }
    }

    if (!['extend', 'new', 'refactor'].includes(out.change_kind)) {
        out.change_kind = 'extend';
    }
    const planMd = renderPlanMarkdown(out, repoCtx.source);
    await run(`UPDATE tickets SET implementation_plan = ? WHERE id = ?`, [planMd, ctx.ticket.id]);
    ctx.implementation_plan = planMd;
    ctx.allowed_files = out.allowed_files;
    ctx.change_kind = out.change_kind;
    out.markdown = planMd;
    out._two_pass = !!r2;
    out._candidate_files = candidateUnion;
    ctx._artifacts = [
        { kind: 'implementation_plan', filename: 'implementation_plan.md', content: planMd }
    ];
    if (r2 && out1) {
        const pass1Md = `### Plan (Pass 1, vor Code-Grounding)\n\n${renderPlanMarkdown(out1, repoCtx.source)}`;
        ctx._artifacts.push({ kind: 'planning_pass1', filename: 'planning_pass1.md', content: pass1Md });
    }
    wfInfo(`Stage:PLANNING done | two_pass=${!!r2} candidates=${candidateUnion.length} steps=${out.steps?.length || 0} risks=${out.risks?.length || 0} estimated_effort=${out.estimated_effort || '-'} allowed_files=${out.allowed_files.length} change_kind=${out.change_kind}`);
    return { output: out, ai: r2 || r1 };
}

async function execIntegration(ctx) {
    wfInfo(`Stage:INTEGRATION start | ticket=${ctx.ticket.id}`);
    const projectDocsRows = await getAll(`SELECT pd.title, pd.content FROM project_documents pd
        INNER JOIN projects p ON p.id = pd.project_id
        WHERE p.system_id = ? LIMIT 20`, [ctx.ticket.system_id]);
    const projectDocs = projectDocsRows.map(d => `### ${d.title}\n\n${d.content || ''}`).join('\n---\n').slice(0, 60_000);
    wfInfo(`Stage:INTEGRATION projectDocs | count=${projectDocsRows.length} combined_len=${projectDocs.length}`);

    // Code-Grounding: tatsaechliche Inhalte der vom Plan vorgesehenen Zieldateien laden,
    // damit der Reviewer Doku-Behauptungen am Code pruefen kann statt zu raten.
    const integration = await getGithubIntegrationForSystem(ctx.ticket.system_id);

    // Bei Re-Run startet die Integration-Stage frisch, ohne Planning-ctx.
    // Tree und Boundary-Files dann hier neu laden.
    if (integration && (!ctx.repo_tree || !Array.isArray(ctx.boundary_files))) {
        try {
            const r = await fetchRepoContext(integration);
            if (!ctx.repo_context) ctx.repo_context = r.repoContext;
            if (!ctx.repo_tree) ctx.repo_tree = r.repoTree || '';
            if (!Array.isArray(ctx.boundary_files)) ctx.boundary_files = r.boundaryFiles || [];
            wfInfo(`Stage:INTEGRATION re-fetched repoCtx | tree_len=${ctx.repo_tree.length} boundary_files=${ctx.boundary_files.length}`);
        } catch (e) {
            wfWarn(`Stage:INTEGRATION repoCtx fetch failed`, e.message);
        }
    }

    let currentFiles = [];
    const allowed = Array.isArray(ctx.allowed_files) ? ctx.allowed_files : [];
    if (integration && allowed.length) {
        try {
            currentFiles = await fetchFilesFromRepo(integration, allowed);
            wfInfo(`Stage:INTEGRATION currentFiles | requested=${allowed.length} loaded=${currentFiles.length} existing=${currentFiles.filter(f => f.exists).length}`);
        } catch (e) {
            wfWarn(`Stage:INTEGRATION currentFiles fetch failed`, e.message);
        }
    }

    const userPrompt = prompts.INTEGRATION.buildUser({
        ticket: ctx.ticket,
        plan: ctx.implementation_plan,
        projectDocs,
        repoDocs: ctx.repo_context || '',
        repoTree: ctx.repo_tree || '',
        boundaryFiles: ctx.boundary_files || [],
        currentFiles
    }) + extraInfoSuffix(ctx);
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.INTEGRATION.system, userPrompt });
    const out = r.parsed || { verdict: 'approve_with_changes', rationale: r.text?.slice(0, 500) || '' };
    if (!['medium', 'high'].includes(out.recommended_complexity)) {
        out.recommended_complexity = 'medium';
    }
    const md = renderIntegrationMarkdown(out);
    await run(`UPDATE tickets SET integration_assessment = ? WHERE id = ?`, [md, ctx.ticket.id]);
    ctx.integration_assessment = md;
    ctx.recommended_complexity = out.recommended_complexity;
    out.markdown = md;
    ctx._artifacts = [
        { kind: 'integration_assessment', filename: 'integration_assessment.md', content: md }
    ];
    wfInfo(`Stage:INTEGRATION done | verdict=${out.verdict} recommended_complexity=${out.recommended_complexity} rule_violations=${out.rule_violations?.length || 0} risks=${out.integration_risks?.length || 0}`);
    return { output: out, ai: r };
}

function renderPlanMarkdown(plan, repoSource) {
    if (!plan || typeof plan !== 'object') return String(plan || '');
    const lines = [];
    if (plan.summary) lines.push(`**Zusammenfassung:** ${plan.summary}`);
    if (repoSource && repoSource !== 'none') lines.push(`\n_Repo-Kontext aus: ${repoSource}_`);
    if (Array.isArray(plan.affected_areas) && plan.affected_areas.length) {
        lines.push(`\n**Betroffene Bereiche:**`);
        plan.affected_areas.forEach(a => lines.push(`- ${a}`));
    }
    if (plan.change_kind) lines.push(`\n**Change-Kind:** \`${plan.change_kind}\``);
    if (Array.isArray(plan.allowed_files) && plan.allowed_files.length) {
        lines.push(`\n**Allowed Files (Whitelist fuer Coding-Bot):**`);
        plan.allowed_files.forEach(f => lines.push(`- \`${f}\``));
    }
    if (Array.isArray(plan.steps) && plan.steps.length) {
        lines.push(`\n**Schritte:**`);
        plan.steps.forEach((s, i) => {
            lines.push(`${i + 1}. **${s.title || ''}**`);
            if (s.details) lines.push(`   - ${s.details}`);
            if (Array.isArray(s.files) && s.files.length) lines.push(`   - Dateien: ${s.files.join(', ')}`);
        });
    }
    if (Array.isArray(plan.risks) && plan.risks.length) {
        lines.push(`\n**Risiken:**`);
        plan.risks.forEach(r => lines.push(`- ${r}`));
    }
    if (plan.estimated_effort) lines.push(`\n**Aufwand:** ${plan.estimated_effort}`);
    if (Array.isArray(plan.open_questions) && plan.open_questions.length) {
        lines.push(`\n**Offene Fragen:**`);
        plan.open_questions.forEach(q => lines.push(`- ${q}`));
    }
    return lines.join('\n');
}

function renderIntegrationMarkdown(asm) {
    if (!asm || typeof asm !== 'object') return String(asm || '');
    const lines = [];
    if (asm.verdict) lines.push(`**Verdikt:** \`${asm.verdict}\``);
    if (asm.recommended_complexity) lines.push(`**Empfohlener Coding-Level:** \`${asm.recommended_complexity}\``);
    if (asm.complexity_rationale) lines.push(`_${asm.complexity_rationale}_`);
    if (asm.rationale) lines.push(`\n${asm.rationale}`);
    if (Array.isArray(asm.rule_violations) && asm.rule_violations.length) {
        lines.push(`\n**Regelverletzungen:**`);
        asm.rule_violations.forEach(v => lines.push(`- ${v}`));
    }
    if (Array.isArray(asm.integration_risks) && asm.integration_risks.length) {
        lines.push(`\n**Integrationsrisiken:**`);
        asm.integration_risks.forEach(v => lines.push(`- ${v}`));
    }
    if (Array.isArray(asm.recommended_changes) && asm.recommended_changes.length) {
        lines.push(`\n**Empfohlene Aenderungen:**`);
        asm.recommended_changes.forEach(v => lines.push(`- ${v}`));
    }
    return lines.join('\n');
}

// --- Engine ---

async function loadDefaultWorkflow() {
    const wf = await getRow(`SELECT * FROM workflow_definitions WHERE is_default = 1 AND active = 1 LIMIT 1`, []);
    if (!wf) { wfWarn('Kein Default-Workflow gefunden'); return null; }
    const stages = await getAll(`SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY sort_order`, [wf.id]);
    wfInfo(`Workflow geladen | id=${wf.id} stages=${stages.length} roles=${stages.map(s => s.role).join('→')}`);
    return { workflow: wf, stages };
}

async function startForTicket(ticketId) {
    if ((process.env.AI_WORKFLOW_ENABLED || 'true').toLowerCase() !== 'true') {
        wfInfo(`startForTicket ticket=${ticketId} SKIP: AI_WORKFLOW_ENABLED=false`);
        return null;
    }
    const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [ticketId]);
    if (!ticket) { wfError(`startForTicket ticket=${ticketId} NOT FOUND`); throw new Error('Ticket nicht gefunden'); }
    if (ticket.workflow_run_id) {
        wfInfo(`startForTicket ticket=${ticketId} SKIP: bereits run_id=${ticket.workflow_run_id}`);
        return null;
    }

    if (ticket.system_id) {
        const sys = await getRow('SELECT ai_workflow_enabled FROM systems WHERE id = ?', [ticket.system_id]);
        if (sys && sys.ai_workflow_enabled === 0) {
            wfInfo(`startForTicket ticket=${ticketId} SKIP: system_id=${ticket.system_id} hat ai_workflow_enabled=0`);
            return null;
        }
    }

    const wf = await loadDefaultWorkflow();
    if (!wf) { wfWarn(`startForTicket ticket=${ticketId} SKIP: kein Workflow`); return null; }

    let autoAssignedStaff = null;
    if (!ticket.assigned_to && ticket.system_id) {
        try {
            autoAssignedStaff = await pickInitialAssignee(ticket.system_id);
        } catch (e) {
            wfWarn(`startForTicket ticket=${ticketId} auto-assign failed`, e.message);
        }
    }

    const runRes = await run(`INSERT INTO ticket_workflow_runs (ticket_id, workflow_id, status, current_stage)
        VALUES (?, ?, 'running', ?)`, [ticketId, wf.workflow.id, wf.stages[0].role]);
    const runId = runRes.lastID;
    await updateTicketState(ticketId, {
        workflow_run_id: runId,
        status: 'in_bearbeitung',
        assigned_to: autoAssignedStaff?.id || ticket.assigned_to || null
    });
    emit('workflow:started', { ticketId, runId });
    wfInfo(`WORKFLOW START | ticket=${ticketId} run=${runId} type=${ticket.type} priority=${ticket.priority} system_id=${ticket.system_id || 'none'} auto_assigned_to=${autoAssignedStaff?.id || 'none'}`);

    runStages(runId, ticket, wf.stages).catch(async (err) => {
        wfError(`Workflow-Engine FATAL ticket=${ticketId} run=${runId}`, err.message);
        try {
            await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
                [String(err.message || err).slice(0, 500), runId]);
            emit('workflow:failed', { ticketId, runId, error: String(err.message || err) });
        } catch (_) {}
    });

    return runId;
}

async function runStages(runId, initialTicket, stages, ctxExtras) {
    const ctx = { ticket: { ...initialTicket }, ...(ctxExtras || {}) };
    let triageDecision = null;
    wfInfo(`runStages start | run=${runId} ticket=${initialTicket.id} stages=${stages.map(s => s.role).join('→')} extraInfo=${ctx.extra_info ? 'yes' : 'no'}`);

    for (const stage of stages) {
        ctx.ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [initialTicket.id]);

        if (['unclear', 'split'].includes(triageDecision) && ['security', 'planning', 'integration'].includes(stage.role)) {
            await skipStep(runId, stage.role, stage.sort_order, triageDecision === 'split' ? 'triage_split' : 'triage_unclear');
            emit('workflow:step', { runId, stage: stage.role, status: 'skipped' });
            continue;
        }

        await run('UPDATE ticket_workflow_runs SET current_stage = ? WHERE id = ?', [stage.role, runId]);

        let staff = await pickStaff(stage.role, stage.executor_kind);
        if (triageDecision === 'split' && stage.role === 'approval' && staff && staff.kind !== 'human') {
            const humanApprover = await pickStaff('approval', 'human');
            if (humanApprover) staff = humanApprover;
        }
        if (!staff) {
            wfWarn(`runStages NO_STAFF | run=${runId} stage=${stage.role} kind=${stage.executor_kind}`);
            const stepId = await startStep(runId, stage.role, stage.sort_order, null);
            await failStep(stepId, `Kein Mitarbeiter mit Rolle "${stage.role}" verfuegbar`);
            await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
                ['no_staff_for_role:' + stage.role, runId]);
            emit('workflow:no_staff', { runId, ticketId: initialTicket.id, role: stage.role });
            return;
        }

        ctx.staff = staff;
        wfInfo(`runStages stage=${stage.role} | staff="${staff.name}" id=${staff.id} kind=${staff.kind} ${staff.kind === 'ai' ? 'provider=' + (staff.ai_provider || 'default') + ' auto_commit=' + (staff.auto_commit_enabled || 0) : ''}`);
        const stepId = await startStep(runId, stage.role, stage.sort_order, staff);
        emit('workflow:step', { runId, stage: stage.role, status: 'in_progress', staff_id: staff.id });

        if (staff.kind === 'human') {
            wfInfo(`runStages WAITING_HUMAN | run=${runId} stage=${stage.role} staff="${staff.name}"`);
            await run(`UPDATE ticket_workflow_steps SET status='waiting_human' WHERE id = ?`, [stepId]);
            await run(`UPDATE ticket_workflow_runs SET status='waiting_human' WHERE id = ?`, [runId]);
            await updateTicketState(initialTicket.id, { status: 'wartend', assigned_to: staff.id });
            emit('workflow:waiting_human', { runId, ticketId: initialTicket.id, stepId, staff_id: staff.id, stage: stage.role });
            return;
        }

        try {
            let result;
            if (stage.role === 'triage')         result = await execTriage(ctx);
            else if (stage.role === 'security')  result = await execSecurity(ctx);
            else if (stage.role === 'planning')  result = await execPlanning(ctx);
            else if (stage.role === 'integration') result = await execIntegration(ctx);
            else if (stage.role === 'approval') {
                result = { output: { verdict: 'approved', note: 'AI auto-approval' }, ai: null };
                await run(`UPDATE tickets SET final_decision='approved' WHERE id = ?`, [initialTicket.id]);
                wfInfo(`runStages AI-APPROVAL | ticket=${initialTicket.id}`);
            } else {
                throw new Error(`Unbekannte Stage-Rolle: ${stage.role}`);
            }
            await finishStep(stepId, { status: 'done', output: result.output, ai: result.ai });
            if (Array.isArray(ctx._artifacts) && ctx._artifacts.length) {
                wfInfo(`runStages artifacts | stage=${stage.role} count=${ctx._artifacts.length}`);
                for (const a of ctx._artifacts) {
                    try {
                        await saveArtifact({
                            ticketId: ctx.ticket.id, runId, stepId, stage: stage.role,
                            kind: a.kind, filename: a.filename,
                            mimeType: a.mimeType || 'text/markdown', content: a.content
                        });
                    } catch (e) {
                        wfError('Artifact save failed', e.message);
                    }
                }
                ctx._artifacts = [];
            }
            emit('workflow:step', { runId, stage: stage.role, status: 'done' });

            if (ctx.extra_info) delete ctx.extra_info;

            if (stage.role === 'triage' && ['unclear', 'split'].includes(result.output?.decision)) {
                triageDecision = result.output?.decision;
            }
        } catch (e) {
            wfError(`runStages STAGE_FAILED | run=${runId} stage=${stage.role}`, e.message);
            await failStep(stepId, e.message || String(e));
            await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
                [`stage_failed:${stage.role}`, runId]);
            emit('workflow:failed', { runId, ticketId: initialTicket.id, stage: stage.role, error: e.message });
            return;
        }
    }

    await run(`UPDATE ticket_workflow_runs SET status='completed', finished_at=CURRENT_TIMESTAMP, result=COALESCE(result,'completed') WHERE id = ?`, [runId]);
    wfInfo(`WORKFLOW COMPLETED | run=${runId} ticket=${initialTicket.id}`);
    emit('workflow:completed', { runId, ticketId: initialTicket.id });
}

async function decideHumanStep(runId, stepId, decision, note, actor, options) {
    wfInfo(`decideHumanStep | run=${runId} step=${stepId} decision="${decision}" note="${(note || '').slice(0, 100)}" actor=${actor}`);
    const allowedDecisions = ['approved', 'rejected', 'unclear', 'handoff', 'dispatch_medium', 'dispatch_high', 'rework', 'approve_split', 'reject_split'];
    if (!allowedDecisions.includes(decision)) throw new Error('Ungueltige Entscheidung');
    const step = await getRow('SELECT * FROM ticket_workflow_steps WHERE id = ?', [stepId]);
    if (!step || step.run_id !== runId) throw new Error('Step nicht gefunden');
    if (step.status !== 'waiting_human') throw new Error('Step erwartet keine menschliche Entscheidung');

    const run_ = await getRow('SELECT * FROM ticket_workflow_runs WHERE id = ?', [runId]);
    const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [run_.ticket_id]);

    if (step.stage === 'approval') {
        const codingDone = await getRow(
            `SELECT COUNT(*) AS c FROM ticket_workflow_steps
             WHERE run_id = ? AND stage = 'coding' AND status = 'done'`, [runId]);
        const isDispatchPhase = (codingDone?.c || 0) === 0;
        const triageStep = await getRow(`SELECT * FROM ticket_workflow_steps WHERE run_id = ? AND stage = 'triage' ORDER BY id ASC LIMIT 1`, [runId]);
        const triageOutput = safeJsonParse(triageStep?.output_payload, null) || {};
        const pendingSplitReview = isDispatchPhase && triageOutput.decision === 'split';
        wfInfo(`decideHumanStep APPROVAL | run=${runId} isDispatch=${isDispatchPhase} codingDone=${codingDone?.c || 0}`);

        if (pendingSplitReview) {
            if (decision === 'approve_split') {
                const proposal = normalizeSplitTickets(options?.split_tickets || triageOutput.split_tickets, ticket, triageOutput.system_id || ticket.system_id);
                if (proposal.length < 2) throw new Error('Split-Vorschlag braucht mindestens 2 gueltige Teiltickets');
                const createdIds = await createSplitTickets(ticket, proposal, actor);
                const output = {
                    decision,
                    note: note || null,
                    decided_by: actor || null,
                    decided_at: new Date().toISOString(),
                    split_tickets: proposal,
                    created_ticket_ids: createdIds,
                    created_count: createdIds.length
                };
                await finishStep(stepId, { status: 'done', output, ai: null });
                await updateTicketState(ticket.id, {
                    status: 'geschlossen',
                    final_decision: 'split',
                    closed_at: new Date().toISOString()
                });
                await addActivity(ticket.id, actor, 'split_created', `Ticket in ${createdIds.length} Teiltickets aufgeteilt`, {
                    created_ticket_ids: createdIds
                });
                await run(`UPDATE ticket_workflow_runs SET status='completed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
                    ['split_created', runId]);
                emit('workflow:completed', { runId, ticketId: ticket.id, result: 'split_created', created_ticket_ids: createdIds });
                return { status: 'split_created', created_ticket_ids: createdIds };
            }
            if (decision === 'reject_split') {
                const output = {
                    decision,
                    note: note || null,
                    decided_by: actor || null,
                    decided_at: new Date().toISOString()
                };
                await finishStep(stepId, { status: 'done', output, ai: null });
                const wf = await loadDefaultWorkflow();
                const triageStage = wf.stages.find(s => s.role === 'triage');
                const remaining = wf.stages.filter(s => (triageStage ? s.sort_order > triageStage.sort_order : true));
                await run(`UPDATE ticket_workflow_runs SET status='running', current_stage='security' WHERE id = ?`, [runId]);
                await updateTicketState(ticket.id, { status: 'in_bearbeitung' });
                runStages(runId, ticket, remaining, note ? { extra_info: `Split-Vorschlag vom Human abgelehnt. Begruendung: ${note}` } : undefined).catch(err => {
                    wfError('Workflow Resume nach Split-Ablehnung fehlgeschlagen', err.message);
                });
                return { status: 'split_rejected_resumed' };
            }
            throw new Error('In dieser Phase bitte Split anwenden oder Split ablehnen');
        }

        if (isDispatchPhase && (decision === 'dispatch_medium' || decision === 'dispatch_high')) {
            const codingLevel = decision === 'dispatch_medium' ? 'medium' : 'high';
            // Sanity: Planner muss eine konkrete allowed_files-Whitelist geliefert haben.
            // Sonst startet die Coding-Stage zwingend in einen Scope-Violation-Block.
            const planRow = await getRow(
                `SELECT output_payload FROM ticket_workflow_steps
                 WHERE run_id = ? AND stage = 'planning' AND status = 'done'
                 ORDER BY id DESC LIMIT 1`, [runId]);
            let planAllowed = [];
            if (planRow?.output_payload) {
                try {
                    const p = JSON.parse(planRow.output_payload);
                    if (Array.isArray(p.allowed_files)) planAllowed = p.allowed_files.filter(x => typeof x === 'string' && x.trim());
                } catch { /* ignore */ }
            }
            if (!planAllowed.length) {
                wfWarn(`DISPATCH BLOCKED | run=${runId} ticket=${ticket.id} reason=allowed_files_empty`);
                throw new Error('Coding-Dispatch nicht moeglich: Planner hat keine konkreten Dateien (allowed_files) geliefert. Bitte zuerst "Erneut pruefen" mit Zusatzinfo (konkreter Datei-/Funktionspfad) verwenden oder den Plan via "Rework" zurueckgeben.');
            }
            const output = {
                decision, coding_level: codingLevel, note: note || null,
                decided_by: actor || null, decided_at: new Date().toISOString()
            };
            await finishStep(stepId, { status: 'done', output, ai: null });
            await run(`UPDATE ticket_workflow_runs SET status='running', current_stage='coding' WHERE id = ?`, [runId]);
            await updateTicketState(ticket.id, { status: 'in_bearbeitung' });
            emit('workflow:step', { runId, stage: 'approval', status: 'done', decision });
            wfInfo(`DISPATCH CODING | run=${runId} ticket=${ticket.id} level=${codingLevel} note="${(note || '').slice(0, 100)}"`);
            // Step-Objekt mit aktuellem output_payload anreichern (nach finishStep, sonst ist output_payload null)
            const enrichedStep = { ...step, output_payload: JSON.stringify(output) };
            runCodingStage(runId, ticket, codingLevel, enrichedStep).catch(err => {
                wfError(`Coding-Stage Fehler run=${runId}`, err.message);
            });
            return { status: 'coding_dispatched', coding_level: codingLevel };
        }

        if (!isDispatchPhase && decision === 'rework') {
            wfInfo(`decideHumanStep REWORK | run=${runId} ticket=${ticket.id}`);
            const output = { decision: 'rework', note: note || null, decided_by: actor || null, decided_at: new Date().toISOString() };
            await finishStep(stepId, { status: 'done', output, ai: null });
            await run(`UPDATE ticket_workflow_steps SET status='skipped'
                       WHERE run_id = ? AND stage = 'coding' AND status = 'done'`, [runId]);
            const approverStaff = await pickStaff('approval', 'human');
            const newSort = (step.sort_order || 5) + 1;
            const newStepId = await startStep(runId, 'approval', newSort, approverStaff);
            await run(`UPDATE ticket_workflow_steps SET status='waiting_human' WHERE id = ?`, [newStepId]);
            await run(`UPDATE ticket_workflow_runs SET status='waiting_human', current_stage='approval' WHERE id = ?`, [runId]);
            await updateTicketState(ticket.id, { status: 'wartend', assigned_to: approverStaff?.id || ticket.assigned_to || null });
            emit('workflow:waiting_human', { runId, ticketId: ticket.id, stepId: newStepId, stage: 'approval', phase: 'rework' });
            return { status: 'rework_started' };
        }

        const finalDecisions = ['approved', 'rejected', 'unclear', 'handoff'];
        if (!finalDecisions.includes(decision)) throw new Error('Entscheidung in dieser Phase nicht erlaubt');
        wfInfo(`decideHumanStep FINAL | run=${runId} decision=${decision}`);
        const output = { decision, note: note || null, decided_by: actor || null, decided_at: new Date().toISOString() };
        await finishStep(stepId, { status: 'done', output, ai: null });
        await dbRef.run('UPDATE tickets SET final_decision = ? WHERE id = ?', [decision, ticket.id]);
        await run(`UPDATE ticket_workflow_runs SET status='completed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            [decision, runId]);
        emit('workflow:completed', { runId, ticketId: ticket.id, result: decision });
        return { status: 'completed', result: decision };
    }

    wfInfo(`decideHumanStep OTHER | run=${runId} stage=${step.stage} decision=${decision}`);
    const output = { decision, note: note || null, decided_by: actor || null, decided_at: new Date().toISOString() };
    await finishStep(stepId, { status: 'done', output, ai: null });
    const wf = await loadDefaultWorkflow();
    const remaining = wf.stages.filter(s => s.sort_order > step.sort_order);
    await run(`UPDATE ticket_workflow_runs SET status='running' WHERE id = ?`, [runId]);
    await updateTicketState(ticket.id, { status: 'in_bearbeitung' });
    runStages(runId, ticket, remaining).catch(err => {
        wfError('Workflow Resume Fehler', err.message);
    });
    return { status: 'resumed' };
}

// --- Coding-Stage ---

function renderCodingMarkdown(out, level) {
    const lines = [`### Coding-Bot Ergebnis (Level: \`${level}\`)`];
    if (out.summary) lines.push(`\n${out.summary}`);
    if (out.commit_message) {
        lines.push(`\n**Commit-Message:**\n\n\`\`\`\n${out.commit_message}\n\`\`\``);
    }
    if (Array.isArray(out.files) && out.files.length) {
        lines.push(`\n**Dateien (${out.files.length}):**`);
        out.files.forEach(f => lines.push(`- \`${f.action || 'update'}\` ${f.path}`));
    }
    if (Array.isArray(out.test_plan) && out.test_plan.length) {
        lines.push(`\n**Test-Plan:**`);
        out.test_plan.forEach((t, i) => lines.push(`${i + 1}. ${t.step || ''} → _${t.expected || ''}_`));
    }
    if (out.manual_verification) lines.push(`\n**Manuelle Pruefung:** ${out.manual_verification}`);
    if (Array.isArray(out.risks) && out.risks.length) {
        lines.push(`\n**Risiken:**`);
        out.risks.forEach(r => lines.push(`- ${r}`));
    }
    return lines.join('\n');
}

// Prueft Coding-Output gegen Scope-Contract aus PLANNING.
// Liefert Liste von Verstoessen (leer = ok). Verstoss => kein PR.
function validateCodingScope(out, allowedFiles, changeKind, currentFiles) {
    const violations = [];
    const allowSet = new Set(allowedFiles || []);
    const currentMap = new Map((currentFiles || []).map(f => [f.path, f]));
    const files = Array.isArray(out.files) ? out.files : [];

    if (!allowSet.size) {
        violations.push('Kein allowed_files-Whitelist aus PLANNING vorhanden – Coding-Stage erfordert Scope-Contract.');
        return violations;
    }

    for (const f of files) {
        if (!f || !f.path) { violations.push('files[] enthaelt Eintrag ohne path'); continue; }
        if (!allowSet.has(f.path)) {
            violations.push(`Pfad nicht in allowed_files: ${f.path}`);
            continue;
        }
        const action = f.action || 'update';
        const cur = currentMap.get(f.path);
        if (changeKind === 'new' && cur && cur.exists) {
            violations.push(`change_kind=new, aber Datei existiert bereits: ${f.path}`);
        }
        if (changeKind === 'extend' && cur && cur.exists && action === 'update' && typeof f.content === 'string' && cur.content) {
            // Symbol-Erhalt: jede in CURRENT exportierte Top-Level-Definition muss erhalten bleiben,
            // ausser sie ist explizit in removed_symbols[] gelistet.
            const removed = new Set(
                (Array.isArray(out.removed_symbols) ? out.removed_symbols : [])
                    .filter(r => r && r.path === f.path && r.symbol)
                    .map(r => r.symbol)
            );
            const symRe = /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)|\bmodule\.exports\.([A-Za-z_$][\w$]*)\s*=|\bexports\.([A-Za-z_$][\w$]*)\s*=/g;
            const oldSymbols = new Set();
            let m;
            while ((m = symRe.exec(cur.content)) !== null) {
                const name = m[1] || m[2] || m[3];
                if (name) oldSymbols.add(name);
            }
            symRe.lastIndex = 0;
            const newSymbols = new Set();
            while ((m = symRe.exec(f.content)) !== null) {
                const name = m[1] || m[2] || m[3];
                if (name) newSymbols.add(name);
            }
            for (const sym of oldSymbols) {
                if (!newSymbols.has(sym) && !removed.has(sym)) {
                    violations.push(`Symbol entfernt ohne Begruendung: ${sym} in ${f.path} (change_kind=extend)`);
                }
            }
            // Diff-Groesse: bei "extend" muss ein hinreichend grosser Anteil der ALTEN
            // (nicht-trivialen) Zeilen weiterhin IRGENDWO in der neuen Datei vorkommen.
            // Wichtig: KEIN positionsweiser Vergleich – sonst verschiebt schon eine
            // einzige Insertion am Datei-Anfang alle Folgezeilen und der Check
            // schlaegt fuer jede normale Erweiterung faelschlich an.
            const normalize = s => s.replace(/\s+/g, ' ').trim();
            const isTrivial = s => {
                if (!s) return true;
                if (s.length < 3) return true;
                // Klammern/Kommas/Semikolons allein zaehlen nicht als Inhalt.
                if (/^[\s{}()\[\];,]+$/.test(s)) return true;
                return false;
            };
            const oldLinesRaw = cur.content.split('\n');
            const newLinesRaw = f.content.split('\n');
            const newSet = new Set(newLinesRaw.map(normalize));
            const oldSignificant = oldLinesRaw.map(normalize).filter(s => !isTrivial(s));
            let preserved = 0;
            for (const s of oldSignificant) if (newSet.has(s)) preserved++;
            const ratio = oldSignificant.length ? preserved / oldSignificant.length : 1;
            if (oldSignificant.length > 20 && ratio < 0.5) {
                violations.push(`Datei zu stark umgebaut (nur ${(ratio * 100).toFixed(0)}% der bestehenden Zeilen wiederverwendet) bei change_kind=extend: ${f.path}`);
            }
        }
        if (action === 'delete' && changeKind !== 'refactor') {
            violations.push(`Datei-Delete erlaubt nur bei change_kind=refactor: ${f.path}`);
        }
    }
    return violations;
}

async function execCoding(ctx, codingLevel) {
    wfInfo(`Stage:CODING start | ticket=${ctx.ticket.id} system_id=${ctx.ticket.system_id || 'none'} level=${codingLevel} hasApproverNote=${!!ctx.approverNote} hasExtraInfo=${!!ctx.extra_info}`);
    const integration = await getGithubIntegrationForSystem(ctx.ticket.system_id);
    wfInfo(`Stage:CODING integration | found=${!!integration} owner=${integration?.repo_owner || '-'} repo=${integration?.repo_name || '-'} hasToken=${!!integration?.access_token} defaultToken=${!!process.env.GITHUB_DEFAULT_TOKEN}`);

    const repoCtx = await fetchRepoContext(integration);
    wfInfo(`Stage:CODING repoContext | source=${repoCtx.source} len=${repoCtx.repoContext.length}`);

    const allowedFiles = Array.isArray(ctx.allowed_files) ? ctx.allowed_files : [];
    const changeKind = ctx.change_kind || 'extend';
    let currentFiles = [];
    if (integration && allowedFiles.length) {
        try {
            currentFiles = await fetchFilesFromRepo(integration, allowedFiles);
            wfInfo(`Stage:CODING currentFiles | requested=${allowedFiles.length} loaded=${currentFiles.length} existing=${currentFiles.filter(f => f.exists).length}`);
        } catch (e) {
            wfWarn(`Stage:CODING currentFiles fetch failed`, e.message);
        }
    } else {
        wfWarn(`Stage:CODING currentFiles SKIP | hasIntegration=${!!integration} allowedFiles=${allowedFiles.length}`);
    }

    const userPrompt = prompts.CODING.buildUser({
        ticket: ctx.ticket,
        codingPrompt: ctx.ticket.coding_prompt || ctx.ticket.redacted_description || ctx.ticket.description,
        plan: ctx.ticket.implementation_plan,
        integrationAssessment: ctx.ticket.integration_assessment,
        repoContext: repoCtx.repoContext,
        level: codingLevel,
        approverNote: ctx.approverNote || null,
        approverDecision: ctx.approverDecision || null,
        extraInfo: ctx.extra_info || null,
        allowedFiles,
        changeKind,
        currentFiles
    });
    wfInfo(`Stage:CODING prompt | userPrompt_len=${userPrompt.length}`);
    // CODING liefert vollstaendige Datei-Inhalte zurueck und braucht den
    // groesseren Output-Spielraum. Default DEFAULT_MAX_TOKENS (128k) ist hier
    // ueblicherweise ausreichend; per AI_CODING_MAX_TOKENS ueberschreibbar.
    const codingMaxTokens = parseInt(process.env.AI_CODING_MAX_TOKENS, 10) || null;
    const r = await callAIWithStaff(ctx.staff, {
        systemPrompt: prompts.CODING.system,
        userPrompt,
        maxTokensOverride: codingMaxTokens
    });
    const truncationRisk = r.truncated
        ? `Coding-Antwort wurde vom Modell abgeschnitten (finish_reason=length, completion_tokens=${r.completion_tokens || '?'}). Erhoehe AI_CODING_MAX_TOKENS / AI_WORKFLOW_MAX_TOKENS oder verkleinere den Scope (weniger/kleinere allowed_files).`
        : null;
    const out = r.parsed || {
        commit_message: 'WIP: ticket #' + ctx.ticket.id,
        summary: r.text?.slice(0, 500) || '(keine strukturierte Antwort)',
        files: [],
        test_plan: [],
        risks: [truncationRisk || 'AI-Antwort nicht parsebar']
    };
    if (r.parsed && truncationRisk) {
        out.risks = Array.isArray(out.risks) ? out.risks : [];
        out.risks.unshift(truncationRisk);
    }
    wfInfo(`Stage:CODING parsed | parsed=${!!r.parsed} files_count=${out.files?.length || 0} commit_msg_len=${(out.commit_message || '').length} summary_len=${(out.summary || '').length}`);
    if (Array.isArray(out.files)) {
        out.files.forEach((f, i) => {
            wfDebug(`Stage:CODING file[${i}] | action=${f.action || '?'} path=${f.path} content_len=${f.content?.length || 0}`);
        });
    }
    out.coding_level = codingLevel;
    out.markdown = renderCodingMarkdown(out, codingLevel);

    ctx._artifacts = [];
    if (out.commit_message) {
        ctx._artifacts.push({ kind: 'commit_message', filename: 'COMMIT_MSG.md', content: out.commit_message });
    }
    if (Array.isArray(out.test_plan) && out.test_plan.length) {
        const tp = out.test_plan.map((t, i) => `${i + 1}. ${t.step || ''}\n   Erwartet: ${t.expected || ''}`).join('\n\n');
        ctx._artifacts.push({ kind: 'test_plan', filename: 'TEST_PLAN.md', content: tp });
    }
    if (out.patch) {
        ctx._artifacts.push({ kind: 'patch', filename: 'changes.patch', mimeType: 'text/x-diff', content: out.patch });
    }
    if (Array.isArray(out.files)) {
        out.files.forEach(f => {
            if (f.path && (f.content || f.action === 'delete')) {
                const safe = String(f.path).replace(/[^a-zA-Z0-9._/\-]/g, '_').slice(0, 200);
                ctx._artifacts.push({
                    kind: 'code_file', filename: 'files/' + safe,
                    mimeType: 'text/plain', content: f.content || `(deleted: ${f.path})`
                });
            }
        });
    }

    // PR-Erstellung
    const tokenSource = integration?.access_token ? 'github_integration.access_token' : (process.env.GITHUB_DEFAULT_TOKEN ? 'GITHUB_DEFAULT_TOKEN' : 'none');
    const autoPrEnabled = (process.env.AI_CODING_AUTO_PR || 'true').toLowerCase() !== 'false';
    wfInfo(`Stage:CODING PR-CHECK | autoPrEnabled=${autoPrEnabled} integration=${!!integration} auto_commit=${!!ctx.staff?.auto_commit_enabled} hasFiles=${Array.isArray(out.files) && out.files.length > 0} tokenSource=${tokenSource}`);

    // Scope-Contract validieren (Whitelist + change_kind)
    const scopeViolations = validateCodingScope(out, allowedFiles, changeKind, currentFiles);
    if (scopeViolations.length) {
        out.scope_violations = scopeViolations;
        out.markdown += `\n\n_⚠️ Scope-Verletzungen erkannt – PR wird NICHT erstellt:_\n` +
            scopeViolations.map(v => `- ${v}`).join('\n');
        wfError(`Stage:CODING SCOPE-VIOLATION | count=${scopeViolations.length}`, scopeViolations.join(' | '));
    }

    // Code-Checks (Syntax immer; Lint/Build per ENV opt-in)
    let checkViolations = [];
    if (!scopeViolations.length && Array.isArray(out.files) && out.files.length) {
        const wantLint = (process.env.AI_CODING_VERIFY_LINT || 'false').toLowerCase() === 'true';
        const wantBuild = (process.env.AI_CODING_VERIFY_BUILD || 'false').toLowerCase() === 'true';
        wfInfo(`Stage:CODING CHECKS | syntax=true lint=${wantLint} build=${wantBuild} files=${out.files.length}`);
        try {
            const checkResult = await runCodeChecks(out.files, integration, { syntax: true, lint: wantLint, build: wantBuild });
            out.code_checks = checkResult;
            wfInfo(`Stage:CODING CHECKS DONE | ok=${checkResult.ok} violations=${checkResult.violations.length} ran=${checkResult.ran.map(r => `${r.name}:${r.status}`).join(',')}`);
            if (!checkResult.ok) {
                checkViolations = checkResult.violations.map(v => `[${v.type}]${v.file ? ' ' + v.file : ''}: ${v.message}`);
                out.markdown += `\n\n_⚠️ Code-Checks fehlgeschlagen – PR wird NICHT erstellt:_\n` +
                    checkViolations.map(v => `- ${v}`).join('\n');
                wfError(`Stage:CODING CHECKS-FAILED | count=${checkViolations.length}`);
            } else {
                const ranSummary = checkResult.ran.map(r => `${r.name}=${r.status}`).join(', ');
                out.markdown += `\n\n_✅ Code-Checks ok: ${ranSummary}_`;
            }
        } catch (e) {
            wfError(`Stage:CODING CHECKS-ERROR`, e.message);
            out.markdown += `\n\n_⚠️ Code-Checks-Fehler: ${e.message}_`;
            checkViolations = [`code_checks_error: ${e.message}`];
        }
    }

    if (!scopeViolations.length && !checkViolations.length && autoPrEnabled && integration && ctx.staff.auto_commit_enabled && Array.isArray(out.files) && out.files.length) {
        wfInfo(`Stage:CODING PR-CREATE | branch=${out.branch_name || 'auto'} files=${out.files.length}`);
        try {
            const slug = String(ctx.ticket.title || 'change').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
            const pr = await commitFilesAsPR(integration, {
                branchName: out.branch_name || `bot/ticket-${ctx.ticket.id}-${slug}`,
                commitMessage: out.commit_message,
                prTitle: `[Ticket #${ctx.ticket.id}] ${ctx.ticket.title || 'Coding-Bot Changes'}`.slice(0, 200),
                prBody: `Automatisch erstellt vom Coding-Bot (Level: \`${codingLevel}\`).\n\n${out.summary || ''}\n\n---\nManuelle Pruefung: ${out.manual_verification || '-'}\n\nScope: change_kind=\`${changeKind}\`, allowed_files=${allowedFiles.length}`,
                files: out.files,
                draft: true,
                labels: ['bot-generated', 'needs-human-review', `coding-${codingLevel}`]
            });
            out.pr_url = pr.prUrl;
            out.pr_number = pr.prNumber;
            out.branch = pr.branch;
            out.pr_draft = pr.draft;
            out.markdown += `\n\n**Pull Request:** [#${pr.prNumber}](${pr.prUrl})${pr.draft ? ' _(Draft)_' : ''} — Branch \`${pr.branch}\``;
            wfInfo(`Stage:CODING PR-CREATED | pr=${pr.prNumber} url=${pr.prUrl} branch=${pr.branch} draft=${pr.draft}`);
        } catch (e) {
            out.pr_error = e.message;
            out.markdown += `\n\n_⚠️ PR-Erstellung fehlgeschlagen: ${e.message}_`;
            wfError(`Stage:CODING PR-FAILED`, e.message);
        }
    } else {
        const reasons = [];
        if (scopeViolations.length) reasons.push(`scope_violations=${scopeViolations.length}`);
        if (checkViolations.length) reasons.push(`code_check_violations=${checkViolations.length}`);
        if (!autoPrEnabled) reasons.push('AI_CODING_AUTO_PR=false');
        if (!integration) reasons.push('Keine github_integration für project.system_id=' + (ctx.ticket.system_id || 'null'));
        if (!ctx.staff?.auto_commit_enabled) reasons.push('auto_commit_enabled=0 für Bot "' + (ctx.staff?.name || '?') + '" (id=' + (ctx.staff?.id || '?') + ')');
        if (!Array.isArray(out.files) || !out.files.length) reasons.push('Coding-Antwort enthielt keine Dateien (out.files leer)');
        if (reasons.length) {
            out.markdown += `\n\n_ℹ️ PR-Erstellung übersprungen: ${reasons.join('; ')}_`;
            wfWarn(`Stage:CODING PR-SKIPPED`, reasons.join(' | '));
        }
    }

    return { output: out, ai: r };
}

async function runCodingStage(runId, ticket, codingLevel, afterStep) {
    const ctx = { ticket };
    wfInfo(`runCodingStage | run=${runId} ticket=${ticket.id} level=${codingLevel} hasAfterStep=${!!afterStep} hasOutputPayload=${!!afterStep?.output_payload}`);
    if (afterStep?.output_payload) {
        try {
            const payload = typeof afterStep.output_payload === 'string'
                ? JSON.parse(afterStep.output_payload)
                : afterStep.output_payload;
            if (payload.note) { ctx.approverNote = payload.note; wfInfo(`runCodingStage APPROVER NOTE | len=${payload.note.length}`); }
            if (payload.decision) { ctx.approverDecision = payload.decision; wfInfo(`runCodingStage APPROVER DECISION | ${payload.decision}`); }
        } catch (e) { wfWarn(`runCodingStage output_payload parse error`, e.message); }
    } else {
        wfWarn(`runCodingStage | Kein output_payload im afterStep – Approver-Notiz geht verloren!`);
    }

    // Scope-Contract aus PLANNING-Step laden (allowed_files, change_kind)
    try {
        const planStep = await getRow(
            `SELECT output_payload FROM ticket_workflow_steps
             WHERE run_id = ? AND stage = 'planning' AND status = 'done'
             ORDER BY id DESC LIMIT 1`, [runId]);
        if (planStep?.output_payload) {
            const planOut = JSON.parse(planStep.output_payload);
            if (Array.isArray(planOut.allowed_files)) ctx.allowed_files = planOut.allowed_files;
            if (planOut.change_kind) ctx.change_kind = planOut.change_kind;
            wfInfo(`runCodingStage SCOPE | allowed_files=${ctx.allowed_files?.length || 0} change_kind=${ctx.change_kind || '-'}`);
        } else {
            wfWarn(`runCodingStage | Kein PLANNING-Output gefunden – Scope-Contract leer, PR wird blockiert.`);
        }
    } catch (e) { wfWarn(`runCodingStage planning load error`, e.message); }
    const staff = await pickStaff('coding', 'ai', { codingLevel });
    const sortOrder = (afterStep?.sort_order || 5) + 1;

    if (!staff) {
        wfWarn(`runCodingStage NO_STAFF | run=${runId} level=${codingLevel}`);
        const stepId = await startStep(runId, 'coding', sortOrder, null);
        await failStep(stepId, `Kein Coding-Bot mit Level "${codingLevel}" verfuegbar`);
        await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            ['no_coding_bot:' + codingLevel, runId]);
        emit('workflow:no_staff', { runId, ticketId: ticket.id, role: 'coding', level: codingLevel });
        return;
    }

    ctx.staff = staff;
    wfInfo(`runCodingStage BOT | "${staff.name}" id=${staff.id} provider=${staff.ai_provider || 'default'} auto_commit=${staff.auto_commit_enabled || 0}`);
    const stepId = await startStep(runId, 'coding', sortOrder, staff);
    await updateTicketState(ticket.id, { status: 'in_bearbeitung' });
    emit('workflow:step', { runId, stage: 'coding', status: 'in_progress', staff_id: staff.id, level: codingLevel });

    try {
        const result = await execCoding(ctx, codingLevel);
        await finishStep(stepId, { status: 'done', output: result.output, ai: result.ai });
        if (Array.isArray(ctx._artifacts) && ctx._artifacts.length) {
            for (const a of ctx._artifacts) {
                try {
                    await saveArtifact({
                        ticketId: ctx.ticket.id, runId, stepId, stage: 'coding',
                        kind: a.kind, filename: a.filename,
                        mimeType: a.mimeType || 'text/markdown', content: a.content
                    });
                } catch (e) {
                    wfError('Artifact save failed', e.message);
                }
            }
            ctx._artifacts = [];
        }
        emit('workflow:step', { runId, stage: 'coding', status: 'done' });

        const approverStaff = await pickStaff('approval', 'human');
        const finalSort = sortOrder + 1;
        const finalStepId = await startStep(runId, 'approval', finalSort, approverStaff);
        await run(`UPDATE ticket_workflow_steps SET status='waiting_human' WHERE id = ?`, [finalStepId]);
        await run(`UPDATE ticket_workflow_runs SET status='waiting_human', current_stage='approval' WHERE id = ?`, [runId]);
        await updateTicketState(ctx.ticket.id, {
            status: 'wartend',
            assigned_to: approverStaff?.id || ctx.ticket.assigned_to || null
        });
        wfInfo(`runCodingStage FINAL-APPROVAL | run=${runId} approver="${approverStaff?.name || 'none'}"`);
        emit('workflow:waiting_human', { runId, ticketId: ctx.ticket.id, stepId: finalStepId, stage: 'approval', phase: 'final' });
    } catch (e) {
        wfError(`runCodingStage FAILED | run=${runId}`, e.message);
        await failStep(stepId, e.message || String(e));
        await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            ['coding_failed', runId]);
        emit('workflow:failed', { runId, ticketId: ctx.ticket.id, stage: 'coding', error: e.message });
    }
}

module.exports = { init, startForTicket, decideHumanStep, rerunStage };

async function rerunStage(runId, stepId, extraInfo, actor) {
    wfInfo(`rerunStage | run=${runId} step=${stepId} extraInfo_len=${(extraInfo || '').length} actor=${actor}`);
    const step = await getRow('SELECT * FROM ticket_workflow_steps WHERE id = ?', [stepId]);
    if (!step || step.run_id !== runId) throw new Error('Step nicht gefunden');
    const allowedStages = ['triage', 'security', 'planning', 'integration'];
    if (!allowedStages.includes(step.stage)) throw new Error('Re-Run nur fuer Triage/Security/Planning/Integration moeglich');
    if (step.status !== 'done') throw new Error('Nur abgeschlossene Steps koennen erneut ausgefuehrt werden');
    const info = String(extraInfo || '').trim();
    if (!info) throw new Error('Zusatzinformation darf nicht leer sein');

    const run_ = await getRow('SELECT * FROM ticket_workflow_runs WHERE id = ?', [runId]);
    const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [run_.ticket_id]);

    let prevOutput = null;
    if (step.output_payload) {
        try { prevOutput = JSON.parse(step.output_payload); } catch (_) {}
    }
    const supersededOutput = {
        ...(prevOutput || {}),
        _superseded: true,
        _superseded_by_actor: actor || null,
        _superseded_extra_info: info,
        _superseded_at: new Date().toISOString()
    };
    await dbRef.run(`UPDATE ticket_workflow_steps SET status = 'skipped', output_payload = ? WHERE id = ?`,
        [JSON.stringify(supersededOutput), stepId]);
    await run(`UPDATE ticket_workflow_steps SET status = 'skipped'
         WHERE run_id = ? AND sort_order > ?
           AND status IN ('done','waiting_human','failed','in_progress','pending')`,
        [runId, step.sort_order]);

    emit('workflow:rerun', { runId, ticketId: ticket.id, stage: step.stage, stepId });

    const wf = await loadDefaultWorkflow();
    if (!wf) throw new Error('Kein Default-Workflow gefunden');
    const remaining = wf.stages.filter(s => s.sort_order >= step.sort_order);
    await run(`UPDATE ticket_workflow_runs SET status = 'running', current_stage = ?, finished_at = NULL, result = NULL WHERE id = ?`,
        [step.stage, runId]);

    runStages(runId, ticket, remaining, { extra_info: info }).catch(err => {
        wfError('Workflow Re-Run Fehler', err.message);
    });

    return { status: 'rerun_started', stage: step.stage };
}
