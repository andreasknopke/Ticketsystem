'use strict';

// Workflow-Engine: laedt Stages aus DB, fuehrt sie sequentiell aus, persistiert Steps.

const aiClient = require('../ai/client');
const prompts = require('../ai/prompts');
const { redact } = require('../ai/redact');
const { pickStaffForRole } = require('./assignment');
const { fetchRepoContext } = require('./githubContext');

const MAX_RETRIES = parseInt(process.env.AI_WORKFLOW_MAX_RETRIES, 10) || 2;

let dbRef = null;
let ioRef = null;

function init({ db, io }) {
    dbRef = db;
    ioRef = io;
}

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

async function pickStaff(role, executorKind) {
    return new Promise((resolve, reject) => {
        pickStaffForRole(dbRef, role, executorKind, (err, staff) => err ? reject(err) : resolve(staff));
    });
}

async function callAIWithStaff(staff, { systemPrompt, userPrompt, json = true, retries = MAX_RETRIES }) {
    const provider = staff.ai_provider || aiClient.DEFAULT_PROVIDER;
    const model = staff.ai_model || undefined;
    const temperature = staff.ai_temperature ?? 0.2;
    const maxTokens = staff.ai_max_tokens || undefined;
    const finalSystem = staff.ai_system_prompt || systemPrompt;
    let extra;
    if (staff.ai_extra_config) {
        try { extra = JSON.parse(staff.ai_extra_config); } catch (_) {}
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const r = await aiClient.chat({
                provider, model, temperature, maxTokens,
                system: finalSystem,
                user: userPrompt,
                json,
                extra
            });
            const parsed = json ? aiClient.tryParseJson(r.text) : null;
            return { ...r, parsed };
        } catch (e) {
            lastErr = e;
            await new Promise(res => setTimeout(res, 500 * Math.pow(2, attempt)));
        }
    }
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
    await run(`UPDATE ticket_workflow_steps SET status='failed', error=?, finished_at=CURRENT_TIMESTAMP WHERE id = ?`,
        [String(message).slice(0, 2000), stepId]);
}

async function skipStep(runId, stage, sortOrder, reason) {
    await run(`INSERT INTO ticket_workflow_steps
        (run_id, stage, sort_order, status, output_payload, created_at, finished_at)
        VALUES (?, ?, ?, 'skipped', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [runId, stage, sortOrder, JSON.stringify({ reason })]);
}

// --- Stage-Executors ---

async function execTriage(ctx) {
    const systems = await getAll('SELECT id, name, description FROM systems WHERE active = 1 ORDER BY id', []);
    const userPrompt = prompts.TRIAGE.buildUser({ ticket: ctx.ticket, systems });
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.TRIAGE.system, userPrompt });
    const out = r.parsed || { decision: 'unclear', reason: 'Antwort nicht parsebar', summary: '', suggested_action: '' };
    if (out.system_id) {
        await run('UPDATE tickets SET system_id = ? WHERE id = ?', [out.system_id, ctx.ticket.id]);
    }
    ctx.triage = out;
    return { output: out, ai: r };
}

async function execSecurity(ctx) {
    const pre = redact(ctx.ticket.description || '');
    const userPrompt = prompts.SECURITY.buildUser({
        ticket: { ...ctx.ticket, triage_summary: ctx.triage?.summary, triage_action: ctx.triage?.suggested_action },
        preRedacted: pre.redacted
    });
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.SECURITY.system, userPrompt });
    const out = r.parsed || { redacted_text: pre.redacted, findings: pre.hits, coding_prompt: pre.redacted };
    await run(`UPDATE tickets SET redacted_description = ?, coding_prompt = ? WHERE id = ?`,
        [out.redacted_text || pre.redacted, out.coding_prompt || '', ctx.ticket.id]);
    ctx.redacted_description = out.redacted_text || pre.redacted;
    ctx.coding_prompt = out.coding_prompt || '';
    return { output: out, ai: r };
}

async function execPlanning(ctx) {
    const integration = await getRow(`SELECT gi.* FROM github_integration gi
        INNER JOIN projects p ON p.id = gi.project_id
        WHERE p.system_id = ? LIMIT 1`, [ctx.ticket.system_id]);
    const repoCtx = await fetchRepoContext(integration);
    ctx.repo_context = repoCtx.repoContext;
    ctx.repo_source = repoCtx.source;

    const userPrompt = prompts.PLANNING.buildUser({
        ticket: { ...ctx.ticket, redacted_description: ctx.redacted_description, coding_prompt: ctx.coding_prompt },
        repoContext: repoCtx.repoContext
    });
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.PLANNING.system, userPrompt });
    const out = r.parsed || { summary: r.text?.slice(0, 500) || '', steps: [], risks: ['Antwort nicht parsebar'] };
    const planMd = renderPlanMarkdown(out, repoCtx.source);
    await run(`UPDATE tickets SET implementation_plan = ? WHERE id = ?`, [planMd, ctx.ticket.id]);
    ctx.implementation_plan = planMd;
    return { output: out, ai: r };
}

async function execIntegration(ctx) {
    const projectDocsRows = await getAll(`SELECT pd.title, pd.content FROM project_documents pd
        INNER JOIN projects p ON p.id = pd.project_id
        WHERE p.system_id = ? LIMIT 20`, [ctx.ticket.system_id]);
    const projectDocs = projectDocsRows.map(d => `### ${d.title}\n\n${d.content || ''}`).join('\n---\n').slice(0, 60_000);

    const userPrompt = prompts.INTEGRATION.buildUser({
        ticket: ctx.ticket,
        plan: ctx.implementation_plan,
        projectDocs,
        repoDocs: ctx.repo_context || ''
    });
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.INTEGRATION.system, userPrompt });
    const out = r.parsed || { verdict: 'approve_with_changes', rationale: r.text?.slice(0, 500) || '' };
    const md = renderIntegrationMarkdown(out);
    await run(`UPDATE tickets SET integration_assessment = ? WHERE id = ?`, [md, ctx.ticket.id]);
    ctx.integration_assessment = md;
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
    if (!wf) return null;
    const stages = await getAll(`SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY sort_order`, [wf.id]);
    return { workflow: wf, stages };
}

async function startForTicket(ticketId) {
    if ((process.env.AI_WORKFLOW_ENABLED || 'true').toLowerCase() !== 'true') return null;
    const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [ticketId]);
    if (!ticket) throw new Error('Ticket nicht gefunden');
    if (ticket.workflow_run_id) return null; // bereits gestartet

    // Pro System abschaltbar
    if (ticket.system_id) {
        const sys = await getRow('SELECT ai_workflow_enabled FROM systems WHERE id = ?', [ticket.system_id]);
        if (sys && sys.ai_workflow_enabled === 0) return null;
    }

    const wf = await loadDefaultWorkflow();
    if (!wf) return null;

    const runRes = await run(`INSERT INTO ticket_workflow_runs (ticket_id, workflow_id, status, current_stage)
        VALUES (?, ?, 'running', ?)`, [ticketId, wf.workflow.id, wf.stages[0].role]);
    const runId = runRes.lastID;
    await run('UPDATE tickets SET workflow_run_id = ? WHERE id = ?', [runId, ticketId]);
    emit('workflow:started', { ticketId, runId });

    // Asynchron weiterlaufen
    runStages(runId, ticket, wf.stages).catch(async (err) => {
        console.error('Workflow-Engine Fehler:', err);
        try {
            await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
                [String(err.message || err).slice(0, 500), runId]);
            emit('workflow:failed', { ticketId, runId, error: String(err.message || err) });
        } catch (_) {}
    });

    return runId;
}

async function runStages(runId, initialTicket, stages) {
    const ctx = { ticket: { ...initialTicket } };
    let triageDecision = null;

    for (const stage of stages) {
        // Ticket nachladen, damit Updates aus vorigen Stages sichtbar sind
        ctx.ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [initialTicket.id]);

        // Skip-Logik: wenn Triage = unclear -> Stage 2-4 ueberspringen
        if (triageDecision === 'unclear' && ['security', 'planning', 'integration'].includes(stage.role)) {
            await skipStep(runId, stage.role, stage.sort_order, 'triage_unclear');
            emit('workflow:step', { runId, stage: stage.role, status: 'skipped' });
            continue;
        }

        await run('UPDATE ticket_workflow_runs SET current_stage = ? WHERE id = ?', [stage.role, runId]);

        // Mitarbeiter waehlen
        const staff = await pickStaff(stage.role, stage.executor_kind);
        if (!staff) {
            const stepId = await startStep(runId, stage.role, stage.sort_order, null);
            await failStep(stepId, `Kein Mitarbeiter mit Rolle "${stage.role}" verfuegbar`);
            await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
                ['no_staff_for_role:' + stage.role, runId]);
            emit('workflow:no_staff', { runId, ticketId: initialTicket.id, role: stage.role });
            return;
        }

        ctx.staff = staff;
        const stepId = await startStep(runId, stage.role, stage.sort_order, staff);
        emit('workflow:step', { runId, stage: stage.role, status: 'in_progress', staff_id: staff.id });

        // Bei menschlichen Stages -> auf Entscheidung warten
        if (staff.kind === 'human') {
            await run(`UPDATE ticket_workflow_steps SET status='waiting_human' WHERE id = ?`, [stepId]);
            await run(`UPDATE ticket_workflow_runs SET status='waiting_human' WHERE id = ?`, [runId]);
            await run('UPDATE tickets SET assigned_to = ? WHERE id = ?', [staff.id, initialTicket.id]);
            emit('workflow:waiting_human', { runId, ticketId: initialTicket.id, stepId, staff_id: staff.id, stage: stage.role });
            return;
        }

        // KI-Stage ausfuehren
        try {
            let result;
            if (stage.role === 'triage')         result = await execTriage(ctx);
            else if (stage.role === 'security')  result = await execSecurity(ctx);
            else if (stage.role === 'planning')  result = await execPlanning(ctx);
            else if (stage.role === 'integration') result = await execIntegration(ctx);
            else if (stage.role === 'approval') {
                // Approval als KI ist erlaubt aber unueblich
                result = { output: { verdict: 'approved', note: 'AI auto-approval' }, ai: null };
                await run(`UPDATE tickets SET final_decision='approved' WHERE id = ?`, [initialTicket.id]);
            } else {
                throw new Error(`Unbekannte Stage-Rolle: ${stage.role}`);
            }
            await finishStep(stepId, { status: 'done', output: result.output, ai: result.ai });
            emit('workflow:step', { runId, stage: stage.role, status: 'done' });

            if (stage.role === 'triage' && result.output?.decision === 'unclear') {
                triageDecision = 'unclear';
            }
        } catch (e) {
            await failStep(stepId, e.message || String(e));
            await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
                [`stage_failed:${stage.role}`, runId]);
            emit('workflow:failed', { runId, ticketId: initialTicket.id, stage: stage.role, error: e.message });
            return;
        }
    }

    // Falls Approval-Stage durchgelaufen ist (KI), Run completen
    await run(`UPDATE ticket_workflow_runs SET status='completed', finished_at=CURRENT_TIMESTAMP, result=COALESCE(result,'completed') WHERE id = ?`, [runId]);
    emit('workflow:completed', { runId, ticketId: initialTicket.id });
}

// Vom Approver aufgerufen, um den wartenden Step zu entscheiden und ggf. zur naechsten Stage weiterzugehen.
async function decideHumanStep(runId, stepId, decision, note, actor) {
    const allowedDecisions = ['approved', 'rejected', 'unclear', 'handoff'];
    if (!allowedDecisions.includes(decision)) throw new Error('Ungueltige Entscheidung');
    const step = await getRow('SELECT * FROM ticket_workflow_steps WHERE id = ?', [stepId]);
    if (!step || step.run_id !== runId) throw new Error('Step nicht gefunden');
    if (step.status !== 'waiting_human') throw new Error('Step erwartet keine menschliche Entscheidung');

    const output = { decision, note: note || null, decided_by: actor || null, decided_at: new Date().toISOString() };
    await finishStep(stepId, { status: 'done', output, ai: null });

    const run_ = await getRow('SELECT * FROM ticket_workflow_runs WHERE id = ?', [runId]);
    const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [run_.ticket_id]);

    if (step.stage === 'approval') {
        await dbRef.run('UPDATE tickets SET final_decision = ? WHERE id = ?', [decision, ticket.id]);
        await run(`UPDATE ticket_workflow_runs SET status='completed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            [decision, runId]);
        emit('workflow:completed', { runId, ticketId: ticket.id, result: decision });
        return { status: 'completed', result: decision };
    }

    // Andere Stages: Workflow nach diesem Step fortsetzen
    const wf = await loadDefaultWorkflow();
    const remaining = wf.stages.filter(s => s.sort_order > step.sort_order);
    await run(`UPDATE ticket_workflow_runs SET status='running' WHERE id = ?`, [runId]);
    runStages(runId, ticket, remaining).catch(err => {
        console.error('Workflow Resume Fehler:', err);
    });
    return { status: 'resumed' };
}

module.exports = { init, startForTicket, decideHumanStep };
