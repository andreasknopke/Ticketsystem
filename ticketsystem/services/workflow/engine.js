'use strict';

// Workflow-Engine: laedt Stages aus DB, fuehrt sie sequentiell aus, persistiert Steps.

const aiClient = require('../ai/client');
const prompts = require('../ai/prompts');
const { redact } = require('../ai/redact');
const { pickStaffForRole } = require('./assignment');
const { fetchRepoContext, commitFilesAsPR } = require('./githubContext');

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

async function pickStaff(role, executorKind, options) {
    return new Promise((resolve, reject) => {
        pickStaffForRole(dbRef, role, executorKind, (err, staff) => err ? reject(err) : resolve(staff), options || {});
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
    const systems = await getAll('SELECT id, name, description FROM systems WHERE active = 1 ORDER BY id', []);
    const userPrompt = prompts.TRIAGE.buildUser({ ticket: ctx.ticket, systems }) + extraInfoSuffix(ctx);
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
    }) + extraInfoSuffix(ctx);
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.PLANNING.system, userPrompt });
    const out = r.parsed || { summary: r.text?.slice(0, 500) || '', steps: [], risks: ['Antwort nicht parsebar'] };
    const planMd = renderPlanMarkdown(out, repoCtx.source);
    await run(`UPDATE tickets SET implementation_plan = ? WHERE id = ?`, [planMd, ctx.ticket.id]);
    ctx.implementation_plan = planMd;
    out.markdown = planMd;
    ctx._artifacts = [
        { kind: 'implementation_plan', filename: 'implementation_plan.md', content: planMd }
    ];
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

async function runStages(runId, initialTicket, stages, ctxExtras) {
    const ctx = { ticket: { ...initialTicket }, ...(ctxExtras || {}) };
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
            // Artefakte aus ctx persistieren
            if (Array.isArray(ctx._artifacts) && ctx._artifacts.length) {
                for (const a of ctx._artifacts) {
                    try {
                        await saveArtifact({
                            ticketId: ctx.ticket.id,
                            runId,
                            stepId,
                            stage: stage.role,
                            kind: a.kind,
                            filename: a.filename,
                            mimeType: a.mimeType || 'text/markdown',
                            content: a.content
                        });
                    } catch (e) {
                        console.error('Artifact save failed:', e.message);
                    }
                }
                ctx._artifacts = [];
            }
            emit('workflow:step', { runId, stage: stage.role, status: 'done' });

            // extra_info nur fuer die erste Stage anwenden (z.B. Re-Run mit Zusatzinfo)
            if (ctx.extra_info) delete ctx.extra_info;

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
    const allowedDecisions = ['approved', 'rejected', 'unclear', 'handoff', 'dispatch_medium', 'dispatch_high', 'rework'];
    if (!allowedDecisions.includes(decision)) throw new Error('Ungueltige Entscheidung');
    const step = await getRow('SELECT * FROM ticket_workflow_steps WHERE id = ?', [stepId]);
    if (!step || step.run_id !== runId) throw new Error('Step nicht gefunden');
    if (step.status !== 'waiting_human') throw new Error('Step erwartet keine menschliche Entscheidung');

    const run_ = await getRow('SELECT * FROM ticket_workflow_runs WHERE id = ?', [runId]);
    const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [run_.ticket_id]);

    if (step.stage === 'approval') {
        // Phase ermitteln: Dispatch (vor Coding) oder Final (nach Coding)
        const codingDone = await getRow(
            `SELECT COUNT(*) AS c FROM ticket_workflow_steps
             WHERE run_id = ? AND stage = 'coding' AND status = 'done'`, [runId]);
        const isDispatchPhase = (codingDone?.c || 0) === 0;

        // Dispatch -> Coding-Bot starten
        if (isDispatchPhase && (decision === 'dispatch_medium' || decision === 'dispatch_high')) {
            const codingLevel = decision === 'dispatch_medium' ? 'medium' : 'high';
            const output = {
                decision, coding_level: codingLevel, note: note || null,
                decided_by: actor || null, decided_at: new Date().toISOString()
            };
            await finishStep(stepId, { status: 'done', output, ai: null });
            await run(`UPDATE ticket_workflow_runs SET status='running', current_stage='coding' WHERE id = ?`, [runId]);
            emit('workflow:step', { runId, stage: 'approval', status: 'done', decision });
            runCodingStage(runId, ticket, codingLevel, step).catch(err => {
                console.error('Coding-Stage Fehler:', err);
            });
            return { status: 'coding_dispatched', coding_level: codingLevel };
        }

        // Final-Phase: Re-Dispatch (rework) -> alte Coding-Steps "verwerfen", neuen Approval-Step (Dispatch) anlegen
        if (!isDispatchPhase && decision === 'rework') {
            const output = { decision: 'rework', note: note || null, decided_by: actor || null, decided_at: new Date().toISOString() };
            await finishStep(stepId, { status: 'done', output, ai: null });
            // Vorherige Coding-Done-Steps als 'skipped' markieren -> isDispatchPhase wird wieder true
            await run(`UPDATE ticket_workflow_steps SET status='skipped'
                       WHERE run_id = ? AND stage = 'coding' AND status = 'done'`, [runId]);
            const approverStaff = await pickStaff('approval', 'human');
            const newSort = (step.sort_order || 5) + 1;
            const newStepId = await startStep(runId, 'approval', newSort, approverStaff);
            await run(`UPDATE ticket_workflow_steps SET status='waiting_human' WHERE id = ?`, [newStepId]);
            await run(`UPDATE ticket_workflow_runs SET status='waiting_human', current_stage='approval' WHERE id = ?`, [runId]);
            emit('workflow:waiting_human', { runId, ticketId: ticket.id, stepId: newStepId, stage: 'approval', phase: 'rework' });
            return { status: 'rework_started' };
        }

        // Standard-Beendigung (approved / rejected / unclear / handoff)
        const finalDecisions = ['approved', 'rejected', 'unclear', 'handoff'];
        if (!finalDecisions.includes(decision)) {
            throw new Error('Entscheidung in dieser Phase nicht erlaubt');
        }
        const output = { decision, note: note || null, decided_by: actor || null, decided_at: new Date().toISOString() };
        await finishStep(stepId, { status: 'done', output, ai: null });
        await dbRef.run('UPDATE tickets SET final_decision = ? WHERE id = ?', [decision, ticket.id]);
        await run(`UPDATE ticket_workflow_runs SET status='completed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            [decision, runId]);
        emit('workflow:completed', { runId, ticketId: ticket.id, result: decision });
        return { status: 'completed', result: decision };
    }

    // Andere Stages (z.B. menschliche Triage): standard finish + weiterlaufen
    const output = { decision, note: note || null, decided_by: actor || null, decided_at: new Date().toISOString() };
    await finishStep(stepId, { status: 'done', output, ai: null });
    const wf = await loadDefaultWorkflow();
    const remaining = wf.stages.filter(s => s.sort_order > step.sort_order);
    await run(`UPDATE ticket_workflow_runs SET status='running' WHERE id = ?`, [runId]);
    runStages(runId, ticket, remaining).catch(err => {
        console.error('Workflow Resume Fehler:', err);
    });
    return { status: 'resumed' };
}

// --- Coding-Stage (dynamisch nach Dispatch-Approval angelegt) ---

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

async function execCoding(ctx, codingLevel) {
    const integration = await getRow(`SELECT gi.* FROM github_integration gi
        INNER JOIN projects p ON p.id = gi.project_id
        WHERE p.system_id = ? LIMIT 1`, [ctx.ticket.system_id]);
    const repoCtx = await fetchRepoContext(integration);

    const userPrompt = prompts.CODING.buildUser({
        ticket: ctx.ticket,
        codingPrompt: ctx.ticket.coding_prompt || ctx.ticket.redacted_description || ctx.ticket.description,
        plan: ctx.ticket.implementation_plan,
        integrationAssessment: ctx.ticket.integration_assessment,
        repoContext: repoCtx.repoContext,
        level: codingLevel,
        approverNote: ctx.approverNote || null,
        approverDecision: ctx.approverDecision || null,
        extraInfo: ctx.extra_info || null
    });
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.CODING.system, userPrompt });
    const out = r.parsed || {
        commit_message: 'WIP: ticket #' + ctx.ticket.id,
        summary: r.text?.slice(0, 500) || '(keine strukturierte Antwort)',
        files: [],
        test_plan: [],
        risks: ['AI-Antwort nicht parsebar']
    };
    out.coding_level = codingLevel;
    out.markdown = renderCodingMarkdown(out, codingLevel);

    ctx._artifacts = [];
    if (out.commit_message) {
        ctx._artifacts.push({ kind: 'commit_message', filename: 'COMMIT_MSG.md', content: out.commit_message });
    }
    if (Array.isArray(out.test_plan) && out.test_plan.length) {
        const tp = out.test_plan
            .map((t, i) => `${i + 1}. ${t.step || ''}\n   Erwartet: ${t.expected || ''}`)
            .join('\n\n');
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
                    kind: 'code_file',
                    filename: 'files/' + safe,
                    mimeType: 'text/plain',
                    content: f.content || `(deleted: ${f.path})`
                });
            }
        });
    }

    // Optional: echter Pull Request
    const autoPrEnabled = (process.env.AI_CODING_AUTO_PR || 'true').toLowerCase() !== 'false';
    if (autoPrEnabled && integration && ctx.staff.auto_commit_enabled && Array.isArray(out.files) && out.files.length) {
        try {
            const slug = String(ctx.ticket.title || 'change').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
            const pr = await commitFilesAsPR(integration, {
                branchName: out.branch_name || `bot/ticket-${ctx.ticket.id}-${slug}`,
                commitMessage: out.commit_message,
                prTitle: `[Ticket #${ctx.ticket.id}] ${ctx.ticket.title || 'Coding-Bot Changes'}`.slice(0, 200),
                prBody: `Automatisch erstellt vom Coding-Bot (Level: \`${codingLevel}\`).\n\n${out.summary || ''}\n\n---\nManuelle Pruefung: ${out.manual_verification || '-'}`,
                files: out.files
            });
            out.pr_url = pr.prUrl;
            out.pr_number = pr.prNumber;
            out.branch = pr.branch;
            out.markdown += `\n\n**Pull Request:** [#${pr.prNumber}](${pr.prUrl}) — Branch \`${pr.branch}\``;
        } catch (e) {
            out.pr_error = e.message;
            out.markdown += `\n\n_⚠️ PR-Erstellung fehlgeschlagen: ${e.message}_`;
        }
    } else if (Array.isArray(out.files) && out.files.length && !ctx.staff.auto_commit_enabled) {
        out.markdown += `\n\n_ℹ️ Auto-Commit für diesen Bot deaktiviert. Dateien stehen als Artefakte zum Download bereit._`;
    }

    return { output: out, ai: r };
}

async function runCodingStage(runId, ticket, codingLevel, afterStep) {
    const ctx = { ticket };
    // Approver-Notiz aus dem Dispatch-Step extrahieren (output_payload ist JSON-String)
    if (afterStep?.output_payload) {
        try {
            const payload = typeof afterStep.output_payload === 'string'
                ? JSON.parse(afterStep.output_payload)
                : afterStep.output_payload;
            if (payload.note) ctx.approverNote = payload.note;
            if (payload.decision) ctx.approverDecision = payload.decision;
        } catch (_) {}
    }
    const staff = await pickStaff('coding', 'ai', { codingLevel });
    const sortOrder = (afterStep?.sort_order || 5) + 1;

    if (!staff) {
        const stepId = await startStep(runId, 'coding', sortOrder, null);
        await failStep(stepId, `Kein Coding-Bot mit Level "${codingLevel}" verfuegbar`);
        await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            ['no_coding_bot:' + codingLevel, runId]);
        emit('workflow:no_staff', { runId, ticketId: ticket.id, role: 'coding', level: codingLevel });
        return;
    }

    ctx.staff = staff;
    const stepId = await startStep(runId, 'coding', sortOrder, staff);
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
                    console.error('Artifact save failed:', e.message);
                }
            }
            ctx._artifacts = [];
        }
        emit('workflow:step', { runId, stage: 'coding', status: 'done' });

        // Final-Approval-Step anlegen (waiting_human)
        const approverStaff = await pickStaff('approval', 'human');
        const finalSort = sortOrder + 1;
        const finalStepId = await startStep(runId, 'approval', finalSort, approverStaff);
        await run(`UPDATE ticket_workflow_steps SET status='waiting_human' WHERE id = ?`, [finalStepId]);
        await run(`UPDATE ticket_workflow_runs SET status='waiting_human', current_stage='approval' WHERE id = ?`, [runId]);
        if (approverStaff) {
            await run('UPDATE tickets SET assigned_to = ? WHERE id = ?', [approverStaff.id, ctx.ticket.id]);
        }
        emit('workflow:waiting_human', { runId, ticketId: ctx.ticket.id, stepId: finalStepId, stage: 'approval', phase: 'final' });
    } catch (e) {
        await failStep(stepId, e.message || String(e));
        await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            ['coding_failed', runId]);
        emit('workflow:failed', { runId, ticketId: ctx.ticket.id, stage: 'coding', error: e.message });
    }
}

module.exports = { init, startForTicket, decideHumanStep, rerunStage };

/**
 * Re-Run einer abgeschlossenen Stage mit Zusatzinformation.
 * - markiert den vorhandenen Step als 'superseded' (status 'skipped' + Vermerk im output)
 * - markiert alle nachfolgenden Steps (sort_order > step.sort_order, ausser 'coding' done)
 *   als 'skipped'
 * - setzt run.status auf 'running' und ruft runStages mit allen folgenden Stages
 *   ab inkl. der re-run-Stage selbst auf, mit ctx.extra_info als Zusatztext
 */
async function rerunStage(runId, stepId, extraInfo, actor) {
    const step = await getRow('SELECT * FROM ticket_workflow_steps WHERE id = ?', [stepId]);
    if (!step || step.run_id !== runId) throw new Error('Step nicht gefunden');
    const allowedStages = ['triage', 'security', 'planning', 'integration'];
    if (!allowedStages.includes(step.stage)) {
        throw new Error('Re-Run nur fuer Triage/Security/Planning/Integration moeglich');
    }
    if (step.status !== 'done') {
        throw new Error('Nur abgeschlossene Steps koennen erneut ausgefuehrt werden');
    }
    const info = String(extraInfo || '').trim();
    if (!info) throw new Error('Zusatzinformation darf nicht leer sein');

    const run_ = await getRow('SELECT * FROM ticket_workflow_runs WHERE id = ?', [runId]);
    const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [run_.ticket_id]);

    // Alten Step inkl. Output bekommen, dann als superseded markieren
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
    await dbRef.run(
        `UPDATE ticket_workflow_steps SET status = 'skipped', output_payload = ? WHERE id = ?`,
        [JSON.stringify(supersededOutput), stepId]
    );

    // Nachfolgende Steps "verwerfen" (skipped). Coding-done bleibt erhalten,
    // wird aber durch Re-Run der Stages 1-4 i.d.R. ohnehin durch erneuten
    // Approver-Dispatch ersetzt; wir setzen es auf skipped, damit die
    // Phase-Erkennung in decideHumanStep wieder Dispatch-Phase signalisiert.
    await run(
        `UPDATE ticket_workflow_steps SET status = 'skipped'
         WHERE run_id = ? AND sort_order > ?
           AND status IN ('done','waiting_human','failed','in_progress','pending')`,
        [runId, step.sort_order]
    );

    emit('workflow:rerun', { runId, ticketId: ticket.id, stage: step.stage, stepId });

    // Workflow-Definition laden und ab dieser Stage durchlaufen
    const wf = await loadDefaultWorkflow();
    if (!wf) throw new Error('Kein Default-Workflow gefunden');
    const remaining = wf.stages.filter(s => s.sort_order >= step.sort_order);
    await run(`UPDATE ticket_workflow_runs SET status = 'running', current_stage = ?, finished_at = NULL, result = NULL WHERE id = ?`,
        [step.stage, runId]);

    // Asynchron weiterlaufen
    runStages(runId, ticket, remaining, { extra_info: info }).catch(err => {
        console.error('Workflow Re-Run Fehler:', err);
    });

    return { status: 'rerun_started', stage: step.stage };
}
