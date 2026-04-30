'use strict';

// Workflow-Engine: laedt Stages aus DB, fuehrt sie sequentiell aus, persistiert Steps.

const aiClient = require('../ai/client');
const prompts = require('../ai/prompts');
const { redact } = require('../ai/redact');
const { pickStaffForRole } = require('./assignment');
const { fetchRepoContext, fetchFilesFromRepo, commitFilesAsPR } = require('./githubContext');
const { runCodeChecks } = require('./codeChecks');

const MAX_RETRIES = parseInt(process.env.AI_WORKFLOW_MAX_RETRIES, 10) || 2;

let dbRef = null;
let ioRef = null;

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

async function pickStaff(role, executorKind, options) {
    return new Promise((resolve, reject) => {
        pickStaffForRole(dbRef, role, executorKind, (err, staff) => err ? reject(err) : resolve(staff), options || {});
    });
}

// Resolve GitHub-Integration aus mehreren Quellen mit Fallback-Hierarchie:
// 1. github_integration via projects.system_id (höchste Priorität, dediziertes Project)
// 2. systems.repo_owner/repo_name/repo_access_token (System-eigene Repo-Konfig)
// 3. ticket.reference_repo_owner/reference_repo_name (Ticket-spezifische Referenz)
async function resolveIntegration(ticket) {
    if (!ticket) return null;

    // 1. github_integration via projects
    if (ticket.system_id) {
        const integration = await getRow(`SELECT gi.* FROM github_integration gi
            INNER JOIN projects p ON p.id = gi.project_id
            WHERE p.system_id = ? LIMIT 1`, [ticket.system_id]);
        if (integration && integration.repo_owner && integration.repo_name) {
            wfInfo(`resolveIntegration | source=github_integration project_id=${integration.project_id} repo=${integration.repo_owner}/${integration.repo_name}`);
            return integration;
        }

        // 2. Fallback: systems-Tabelle
        const sys = await getRow(`SELECT id, name, repo_owner, repo_name, repo_access_token
            FROM systems WHERE id = ? AND active = 1 LIMIT 1`, [ticket.system_id]);
        if (sys && sys.repo_owner && sys.repo_name) {
            wfInfo(`resolveIntegration | source=systems system_id=${sys.id} repo=${sys.repo_owner}/${sys.repo_name}`);
            return {
                project_id: null,
                system_id: sys.id,
                repo_owner: sys.repo_owner,
                repo_name: sys.repo_name,
                access_token: sys.repo_access_token || null,
                default_branch: null
            };
        }
    }

    // 3. Fallback: ticket.reference_repo
    if (ticket.reference_repo_owner && ticket.reference_repo_name) {
        wfInfo(`resolveIntegration | source=ticket.reference_repo repo=${ticket.reference_repo_owner}/${ticket.reference_repo_name}`);
        return {
            project_id: null,
            system_id: ticket.system_id || null,
            repo_owner: ticket.reference_repo_owner,
            repo_name: ticket.reference_repo_name,
            access_token: null,
            default_branch: null
        };
    }

    wfWarn(`resolveIntegration | NO INTEGRATION found | ticket=${ticket.id} system_id=${ticket.system_id || 'null'}`);
    return null;
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
            wfInfo(`AI-Call success | attempt=${attempt} provider=${r.provider} model=${r.model} resp_len=${r.text?.length || 0} parsed=${!!parsed} duration_ms=${r.duration_ms} prompt_tokens=${r.prompt_tokens || '?'} completion_tokens=${r.completion_tokens || '?'}`);
            if (json && !parsed) {
                wfWarn(`AI-Call JSON parse failed | raw_preview=${(r.text || '').slice(0, 500)}`);
                if (r.raw?.choices?.[0]?.finish_reason) {
                    wfWarn(`AI-Call finish_reason=${r.raw.choices[0].finish_reason}`);
                }
            }
            return { ...r, parsed };
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

function previousStageContextSuffix(ctx, stageName) {
    if (!ctx) return '';
    const blocks = [];
    const addBlock = (label, lines) => {
        const cleaned = (lines || []).filter(Boolean);
        if (!cleaned.length) return;
        blocks.push(`### ${label}\n${cleaned.join('\n')}`);
    };

    if (stageName !== 'triage' && ctx.triage) {
        addBlock('Vorherige Stage: Triage', [
            `- Entscheidung: ${ctx.triage.decision || '-'}`,
            `- Zusammenfassung: ${ctx.triage.summary || '-'}`,
            `- Begründung: ${ctx.triage.reason || '-'}`,
            `- Vorgeschlagene Handlung: ${ctx.triage.suggested_action || '-'}`,
            Array.isArray(ctx.triage.open_questions) && ctx.triage.open_questions.length
                ? `- Offene Fragen: ${ctx.triage.open_questions.join(' | ')}`
                : ''
        ]);
    }

    if (['planning', 'integration', 'coding'].includes(stageName) && ctx.security) {
        addBlock('Vorherige Stage: Security', [
            `- Coding-Prompt: ${ctx.security.coding_prompt || ctx.coding_prompt || '-'}`,
            Array.isArray(ctx.security.findings) && ctx.security.findings.length
                ? `- Findings: ${ctx.security.findings.map(f => `${f.type || 'finding'}: ${f.note || ''}`).join(' | ')}`
                : '',
            Array.isArray(ctx.security.open_questions) && ctx.security.open_questions.length
                ? `- Offene Fragen: ${ctx.security.open_questions.join(' | ')}`
                : ''
        ]);
    }

    if (['integration', 'coding'].includes(stageName) && ctx.planning) {
        addBlock('Vorherige Stage: Planning', [
            `- Zusammenfassung: ${ctx.planning.summary || '-'}`,
            `- Aufwand: ${ctx.planning.estimated_effort || '-'}`,
            Array.isArray(ctx.planning.allowed_files) && ctx.planning.allowed_files.length
                ? `- Allowed Files: ${ctx.planning.allowed_files.join(', ')}`
                : '',
            Array.isArray(ctx.planning.risks) && ctx.planning.risks.length
                ? `- Risiken: ${ctx.planning.risks.join(' | ')}`
                : '',
            Array.isArray(ctx.planning.open_questions) && ctx.planning.open_questions.length
                ? `- Offene Fragen: ${ctx.planning.open_questions.join(' | ')}`
                : ''
        ]);
    }

    if (stageName === 'coding' && ctx.integration) {
        addBlock('Vorherige Stage: Integration', [
            `- Verdict: ${ctx.integration.verdict || '-'}`,
            `- Empfohlener Coding-Level: ${ctx.integration.recommended_complexity || '-'}`,
            Array.isArray(ctx.integration.recommended_changes) && ctx.integration.recommended_changes.length
                ? `- Empfohlene Änderungen: ${ctx.integration.recommended_changes.join(' | ')}`
                : '',
            Array.isArray(ctx.integration.integration_risks) && ctx.integration.integration_risks.length
                ? `- Integrationsrisiken: ${ctx.integration.integration_risks.join(' | ')}`
                : '',
            Array.isArray(ctx.integration.open_questions) && ctx.integration.open_questions.length
                ? `- Offene Fragen: ${ctx.integration.open_questions.join(' | ')}`
                : ''
        ]);
    }

    if (!blocks.length) return '';
    return `\n\n--- Kontext aus vorherigen Workflow-Stages ---\n${blocks.join('\n\n')}\n--- Ende Stage-Kontext ---`;
}

function extractOpenQuestions(output) {
    if (!output || typeof output !== 'object') return [];
    if (!Array.isArray(output.open_questions)) return [];
    return output
        .map(v => typeof v === 'string' ? v.trim() : '')
        .filter(Boolean)
        .slice(0, 10);
}

async function pauseForHumanQuestions(runId, ticket, stage, sortOrder, output) {
    const openQuestions = extractOpenQuestions(output);
    if (!openQuestions.length) return false;
    const approverStaff = await pickStaff('approval', 'human');
    const questionSort = sortOrder + 0.5;
    const stepId = await startStep(runId, 'approval', questionSort, approverStaff);
    const payload = {
        phase: 'questions',
        source_stage: stage,
        resume_after_sort_order: sortOrder,
        open_questions: openQuestions,
        created_at: new Date().toISOString()
    };
    await run(`UPDATE ticket_workflow_steps SET status='waiting_human', output_payload=? WHERE id = ?`, [JSON.stringify(payload), stepId]);
    await run(`UPDATE ticket_workflow_runs SET status='waiting_human', current_stage='approval' WHERE id = ?`, [runId]);
    if (approverStaff) {
        await run('UPDATE tickets SET assigned_to = ? WHERE id = ?', [approverStaff.id, ticket.id]);
    }
    wfWarn(`Zwischenstopp fuer offene Fragen | run=${runId} source_stage=${stage} questions=${openQuestions.length}`);
    emit('workflow:waiting_human', { runId, ticketId: ticket.id, stepId, stage: 'approval', phase: 'questions', source_stage: stage });
    return true;
}

async function execTriage(ctx) {
    wfInfo(`Stage:TRIAGE start | ticket=${ctx.ticket.id} title="${(ctx.ticket.title || '').slice(0, 80)}"`);
    const systems = await getAll('SELECT id, name, description FROM systems WHERE active = 1 ORDER BY id', []);
    const userPrompt = prompts.TRIAGE.buildUser({ ticket: ctx.ticket, systems }) + previousStageContextSuffix(ctx, 'triage') + extraInfoSuffix(ctx);
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.TRIAGE.system, userPrompt });
    const out = r.parsed || { decision: 'unclear', reason: 'Antwort nicht parsebar', summary: '', suggested_action: '' };
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
    }) + previousStageContextSuffix(ctx, 'security') + extraInfoSuffix(ctx);
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.SECURITY.system, userPrompt });
    const out = r.parsed || { redacted_text: pre.redacted, findings: pre.hits, coding_prompt: pre.redacted };
    const redacted = out.redacted_text || pre.redacted;
    const codingPrompt = out.coding_prompt || '';
    await run(`UPDATE tickets SET redacted_description = ?, coding_prompt = ? WHERE id = ?`,
        [redacted, codingPrompt, ctx.ticket.id]);
    ctx.redacted_description = redacted;
    ctx.coding_prompt = codingPrompt;
    ctx.security = out;
    out.markdown = `### Coding-Prompt\n\n${codingPrompt || '(leer)'}\n\n### Redigierte Beschreibung\n\n${redacted || '(leer)'}`;
    ctx._artifacts = [
        { kind: 'redacted_description', filename: 'redacted_description.md', content: redacted },
        { kind: 'coding_prompt', filename: 'coding_prompt.md', content: codingPrompt }
    ];
    wfInfo(`Stage:SECURITY done | coding_prompt_len=${codingPrompt.length} redacted_len=${redacted.length}`);
    return { output: out, ai: r };
}

function sanitizePlanningPath(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/^[-*]\s*/, '');
    if (!trimmed || trimmed.includes('..') || trimmed.startsWith('/')) return null;
    if (trimmed.includes('*')) return null;
    if (!/[A-Za-z0-9]/.test(trimmed)) return null;
    return trimmed;
}

function extractExplicitPlanningPaths(values) {
    const out = [];
    const seen = new Set();
    const add = (candidate) => {
        const safe = sanitizePlanningPath(candidate);
        if (!safe || seen.has(safe)) return;
        seen.add(safe);
        out.push(safe);
    };

    (values || []).forEach((value) => {
        if (typeof value !== 'string') return;
        const direct = sanitizePlanningPath(value);
        if (direct && /\.[A-Za-z0-9]+$/.test(direct)) add(direct);
        const matches = value.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+/g) || [];
        matches.forEach(add);
    });

    return out;
}

function normalizePlanningScope(out) {
    if (!out || typeof out !== 'object') return out;
    const merged = [];
    const seen = new Set();
    const push = (value) => {
        const safe = sanitizePlanningPath(value);
        if (!safe || seen.has(safe)) return;
        seen.add(safe);
        merged.push(safe);
    };

    (Array.isArray(out.allowed_files) ? out.allowed_files : []).forEach(push);
    (Array.isArray(out.candidate_files) ? out.candidate_files : []).forEach(push);
    extractExplicitPlanningPaths(Array.isArray(out.affected_areas) ? out.affected_areas : []).forEach(push);
    (Array.isArray(out.steps) ? out.steps : []).forEach((step) => {
        if (Array.isArray(step?.files)) step.files.forEach(push);
        extractExplicitPlanningPaths([step?.title, step?.details]).forEach(push);
    });

    if (merged.some(path => path.startsWith('routes/')) && !seen.has('server.js')) {
        push('server.js');
    }

    out.allowed_files = merged.slice(0, 25);
    return out;
}

async function execPlanning(ctx) {
    wfInfo(`Stage:PLANNING start | ticket=${ctx.ticket.id} system_id=${ctx.ticket.system_id || 'none'}`);
    const integration = await resolveIntegration(ctx.ticket);
    wfInfo(`Stage:PLANNING integration lookup | found=${!!integration} owner=${integration?.repo_owner || '-'} repo=${integration?.repo_name || '-'} hasToken=${!!integration?.access_token}`);
    const repoCtx = await fetchRepoContext(integration);
    ctx.repo_context = repoCtx.repoContext;
    ctx.repo_source = repoCtx.source;
    wfInfo(`Stage:PLANNING repoContext | source=${repoCtx.source} len=${repoCtx.repoContext.length}`);

    const userPrompt = prompts.PLANNING.buildUser({
        ticket: { ...ctx.ticket, redacted_description: ctx.redacted_description, coding_prompt: ctx.coding_prompt },
        repoContext: repoCtx.repoContext
    }) + previousStageContextSuffix(ctx, 'planning') + extraInfoSuffix(ctx);
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.PLANNING.system, userPrompt });
    const out = r.parsed || { summary: r.text?.slice(0, 500) || '', steps: [], risks: ['Antwort nicht parsebar'] };
    // Scope-Contract normalisieren
    normalizePlanningScope(out);
    out.allowed_files = out.allowed_files
        .filter(p => typeof p === 'string' && p.trim() && !p.includes('..') && !p.startsWith('/'))
        .map(p => p.trim())
        .slice(0, 25);
    if (!['extend', 'new', 'refactor'].includes(out.change_kind)) {
        out.change_kind = 'extend';
    }
    const planMd = renderPlanMarkdown(out, repoCtx.source);
    await run(`UPDATE tickets SET implementation_plan = ? WHERE id = ?`, [planMd, ctx.ticket.id]);
    ctx.implementation_plan = planMd;
    ctx.allowed_files = out.allowed_files;
    ctx.change_kind = out.change_kind;
    ctx.planning = out;
    out.markdown = planMd;
    ctx._artifacts = [
        { kind: 'implementation_plan', filename: 'implementation_plan.md', content: planMd }
    ];
    wfInfo(`Stage:PLANNING done | steps=${out.steps?.length || 0} risks=${out.risks?.length || 0} estimated_effort=${out.estimated_effort || '-'} allowed_files=${out.allowed_files.length} change_kind=${out.change_kind}`);
    return { output: out, ai: r };
}

async function execIntegration(ctx) {
    wfInfo(`Stage:INTEGRATION start | ticket=${ctx.ticket.id}`);
    const projectDocsRows = await getAll(`SELECT pd.title, pd.content FROM project_documents pd
        INNER JOIN projects p ON p.id = pd.project_id
        WHERE p.system_id = ? LIMIT 20`, [ctx.ticket.system_id]);
    const projectDocs = projectDocsRows.map(d => `### ${d.title}\n\n${d.content || ''}`).join('\n---\n').slice(0, 60_000);
    wfInfo(`Stage:INTEGRATION projectDocs | count=${projectDocsRows.length} combined_len=${projectDocs.length}`);

    const userPrompt = prompts.INTEGRATION.buildUser({
        ticket: ctx.ticket,
        plan: ctx.implementation_plan,
        projectDocs,
        repoDocs: ctx.repo_context || ''
    }) + previousStageContextSuffix(ctx, 'integration') + extraInfoSuffix(ctx);
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.INTEGRATION.system, userPrompt });
    const out = r.parsed || { verdict: 'approve_with_changes', rationale: r.text?.slice(0, 500) || '' };
    if (!['medium', 'high'].includes(out.recommended_complexity)) {
        out.recommended_complexity = 'medium';
    }
    const md = renderIntegrationMarkdown(out);
    await run(`UPDATE tickets SET integration_assessment = ? WHERE id = ?`, [md, ctx.ticket.id]);
    ctx.integration_assessment = md;
    ctx.recommended_complexity = out.recommended_complexity;
    ctx.integration = out;
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
    if (Array.isArray(asm.open_questions) && asm.open_questions.length) {
        lines.push(`\n**Offene Fragen (menschliche Klaerung noetig):**`);
        asm.open_questions.forEach(v => lines.push(`- ${v}`));
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

    const runRes = await run(`INSERT INTO ticket_workflow_runs (ticket_id, workflow_id, status, current_stage)
        VALUES (?, ?, 'running', ?)`, [ticketId, wf.workflow.id, wf.stages[0].role]);
    const runId = runRes.lastID;
    await run('UPDATE tickets SET workflow_run_id = ? WHERE id = ?', [runId, ticketId]);
    emit('workflow:started', { ticketId, runId });
    wfInfo(`WORKFLOW START | ticket=${ticketId} run=${runId} type=${ticket.type} priority=${ticket.priority} system_id=${ticket.system_id || 'none'}`);

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

        if (triageDecision === 'unclear' && ['security', 'planning', 'integration'].includes(stage.role)) {
            await skipStep(runId, stage.role, stage.sort_order, 'triage_unclear');
            emit('workflow:step', { runId, stage: stage.role, status: 'skipped' });
            continue;
        }

        await run('UPDATE ticket_workflow_runs SET current_stage = ? WHERE id = ?', [stage.role, runId]);

        const staff = await pickStaff(stage.role, stage.executor_kind);
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
            await run('UPDATE tickets SET assigned_to = ? WHERE id = ?', [staff.id, initialTicket.id]);
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

            const pausedForQuestions = await pauseForHumanQuestions(runId, initialTicket, stage.role, stage.sort_order, result.output);
            if (pausedForQuestions) {
                return;
            }

            if (ctx.extra_info) delete ctx.extra_info;

            if (stage.role === 'triage' && result.output?.decision === 'unclear') {
                triageDecision = 'unclear';
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
    options = options || {};
    wfInfo(`decideHumanStep | run=${runId} step=${stepId} decision="${decision}" note="${(note || '').slice(0, 100)}" actor=${actor}`);
    const allowedDecisions = ['approved', 'rejected', 'unclear', 'handoff', 'dispatch_medium', 'dispatch_high', 'rework'];
    if (!allowedDecisions.includes(decision)) throw new Error('Ungueltige Entscheidung');
    const step = await getRow('SELECT * FROM ticket_workflow_steps WHERE id = ?', [stepId]);
    if (!step || step.run_id !== runId) throw new Error('Step nicht gefunden');
    if (step.status !== 'waiting_human') throw new Error('Step erwartet keine menschliche Entscheidung');

    const run_ = await getRow('SELECT * FROM ticket_workflow_runs WHERE id = ?', [runId]);
    const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [run_.ticket_id]);
    let stepOutput = null;
    if (step.output_payload) {
        try { stepOutput = JSON.parse(step.output_payload); } catch (_) {}
    }

    if (step.stage === 'approval') {
        if (stepOutput?.phase === 'questions') {
            if (!String(note || '').trim()) {
                throw new Error('Bitte beantworte die offenen Fragen im Notizfeld.');
            }
            const output = {
                ...(stepOutput || {}),
                decision,
                note: note || null,
                decided_by: actor || null,
                decided_at: new Date().toISOString()
            };
            await finishStep(stepId, { status: 'done', output, ai: null });
            const wf = await loadDefaultWorkflow();
            const remaining = wf.stages.filter(s => s.sort_order > Number(stepOutput.resume_after_sort_order || 0));
            const answerContext = `Antworten des menschlichen Approvers auf offene Fragen aus ${stepOutput.source_stage}:
${(stepOutput.open_questions || []).map((q, i) => `${i + 1}. ${q}`).join('\n')}

Antwort / Entscheidung:
${note}`;
            await run(`UPDATE ticket_workflow_runs SET status='running', current_stage=? WHERE id = ?`, [remaining[0]?.role || stepOutput.source_stage, runId]);
            emit('workflow:step', { runId, stage: 'approval', status: 'done', decision, phase: 'questions' });
            runStages(runId, ticket, remaining, { extra_info: answerContext }).catch(err => {
                wfError('Workflow Resume nach Fragen fehlgeschlagen', err.message);
            });
            return { status: 'resumed_after_questions' };
        }

        const codingDone = await getRow(
            `SELECT COUNT(*) AS c FROM ticket_workflow_steps
             WHERE run_id = ? AND stage = 'coding' AND status = 'done'`, [runId]);
        const isDispatchPhase = (codingDone?.c || 0) === 0;
        wfInfo(`decideHumanStep APPROVAL | run=${runId} isDispatch=${isDispatchPhase} codingDone=${codingDone?.c || 0}`);

        if (isDispatchPhase && (decision === 'dispatch_medium' || decision === 'dispatch_high')) {
            const codingLevel = decision === 'dispatch_medium' ? 'medium' : 'high';
            const selectedStaffId = Number.isInteger(options.selected_staff_id) ? options.selected_staff_id : null;
            let selectedStaff = null;
            if (selectedStaffId) {
                selectedStaff = await pickStaff('coding', 'ai', { codingLevel, staffId: selectedStaffId });
                if (!selectedStaff) {
                    throw new Error(`Der ausgewaehlte Coding-Bot passt nicht zum Level "${codingLevel}" oder ist nicht aktiv.`);
                }
            }
            const output = {
                decision, coding_level: codingLevel, note: note || null,
                selected_staff_id: selectedStaff ? selectedStaff.id : null,
                selected_staff_name: selectedStaff ? selectedStaff.name : null,
                decided_by: actor || null, decided_at: new Date().toISOString()
            };
            await finishStep(stepId, { status: 'done', output, ai: null });
            await run(`UPDATE ticket_workflow_runs SET status='running', current_stage='coding' WHERE id = ?`, [runId]);
            emit('workflow:step', { runId, stage: 'approval', status: 'done', decision });
            wfInfo(`DISPATCH CODING | run=${runId} ticket=${ticket.id} level=${codingLevel} note="${(note || '').slice(0, 100)}"`);
            // Step-Objekt mit aktuellem output_payload anreichern (nach finishStep, sonst ist output_payload null)
            const enrichedStep = { ...step, output_payload: JSON.stringify(output) };
            runCodingStage(runId, ticket, codingLevel, enrichedStep, selectedStaff).catch(err => {
                wfError(`Coding-Stage Fehler run=${runId}`, err.message);
            });
            return {
                status: 'coding_dispatched',
                coding_level: codingLevel,
                selected_staff_id: selectedStaff ? selectedStaff.id : null,
                selected_staff_name: selectedStaff ? selectedStaff.name : null
            };
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
            // Diff-Groesse: bei "extend" nicht mehr als 70% Zeilen anders
            const oldLines = cur.content.split('\n');
            const newLines = f.content.split('\n');
            const minLen = Math.min(oldLines.length, newLines.length);
            let same = 0;
            for (let i = 0; i < minLen; i++) if (oldLines[i] === newLines[i]) same++;
            const ratio = oldLines.length ? same / oldLines.length : 1;
            if (oldLines.length > 20 && ratio < 0.3) {
                violations.push(`Datei zu stark umgebaut (nur ${(ratio * 100).toFixed(0)}% Zeilen erhalten) bei change_kind=extend: ${f.path}`);
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
    const integration = await resolveIntegration(ctx.ticket);
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
    }) + previousStageContextSuffix(ctx, 'coding');
    wfInfo(`Stage:CODING prompt | userPrompt_len=${userPrompt.length}`);
    const r = await callAIWithStaff(ctx.staff, { systemPrompt: prompts.CODING.system, userPrompt });
    const out = r.parsed || {
        commit_message: 'WIP: ticket #' + ctx.ticket.id,
        summary: r.text?.slice(0, 500) || '(keine strukturierte Antwort)',
        files: [],
        test_plan: [],
        risks: ['AI-Antwort nicht parsebar']
    };
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
        if (!integration) reasons.push('Keine Repo-Verknüpfung gefunden (weder github_integration via project, noch systems.repo_*, noch ticket.reference_repo_*) für system_id=' + (ctx.ticket.system_id || 'null'));
        if (!ctx.staff?.auto_commit_enabled) reasons.push('auto_commit_enabled=0 für Bot "' + (ctx.staff?.name || '?') + '" (id=' + (ctx.staff?.id || '?') + ')');
        if (!Array.isArray(out.files) || !out.files.length) reasons.push('Coding-Antwort enthielt keine Dateien (out.files leer)');
        if (reasons.length) {
            out.markdown += `\n\n_ℹ️ PR-Erstellung übersprungen: ${reasons.join('; ')}_`;
            wfWarn(`Stage:CODING PR-SKIPPED`, reasons.join(' | '));
        }
    }

    return { output: out, ai: r };
}

async function runCodingStage(runId, ticket, codingLevel, afterStep, preferredStaff) {
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
            normalizePlanningScope(planOut);
            if (Array.isArray(planOut.allowed_files)) ctx.allowed_files = planOut.allowed_files;
            if (planOut.change_kind) ctx.change_kind = planOut.change_kind;
            wfInfo(`runCodingStage SCOPE | allowed_files=${ctx.allowed_files?.length || 0} change_kind=${ctx.change_kind || '-'}`);
        } else {
            wfWarn(`runCodingStage | Kein PLANNING-Output gefunden – Scope-Contract leer, PR wird blockiert.`);
        }
    } catch (e) { wfWarn(`runCodingStage planning load error`, e.message); }
    const staff = preferredStaff || await pickStaff('coding', 'ai', { codingLevel });
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
        if (approverStaff) {
            await run('UPDATE tickets SET assigned_to = ? WHERE id = ?', [approverStaff.id, ctx.ticket.id]);
        }
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
