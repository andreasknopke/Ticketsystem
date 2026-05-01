'use strict';

function normalizeQuestions(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(q => typeof q === 'string' ? q : JSON.stringify(q));
}

/**
 * Wendet search/replace-Edits auf einen Datei-Inhalt an.
 * Gibt { content, applied, failed } zurueck.
 * Jeder Edit: { search: string, replace: string }
 * Die Edits werden nacheinander angewendet (Reihenfolge wichtig!).
 * Wenn ein search-String nicht gefunden wird, wird der Edit uebersprungen und in failed[] aufgenommen.
 */
function applyEdits(originalContent, edits) {
    if (!Array.isArray(edits) || !edits.length) {
        return { content: originalContent, applied: [], failed: [] };
    }
    let content = originalContent;
    const applied = [];
    const failed = [];

    // Helper: normalize for fuzzy match (collapse whitespace, trim lines)
    function norm(s) { return s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n').replace(/\n\s+/g, '\n ').trim(); }

    for (const edit of edits) {
        if (typeof edit.search !== 'string' || typeof edit.replace !== 'string') {
            failed.push({ search: String(edit.search || '').slice(0, 80), reason: 'search oder replace ist kein String' });
            continue;
        }

        // Try exact match first
        let idx = content.indexOf(edit.search);
        let usedFuzzy = false;

        // Fallback: fuzzy whitespace-tolerant match line by line
        if (idx === -1 && edit.search.trim().length > 10) {
            const searchLines = edit.search.split('\n');
            const contentLines = content.split('\n');
            // Find the first matching line (normalized)
            const normFirstLine = norm(searchLines[0]);
            let startLine = -1;
            for (let i = 0; i < contentLines.length; i++) {
                if (norm(contentLines[i]) === normFirstLine) {
                    // Check remaining lines
                    let match = true;
                    for (let j = 1; j < searchLines.length && i + j < contentLines.length; j++) {
                        if (norm(contentLines[i + j]) !== norm(searchLines[j])) {
                            match = false;
                            break;
                        }
                    }
                    if (match) {
                        startLine = i;
                        break;
                    }
                }
            }
        if (startLine !== -1) {
            const endLine = startLine + searchLines.length;
            // Replace the original lines (startLine..endLine) with edit.replace
            const contentLines = content.split('\n');
            const replaceLines = edit.replace.split('\n');
            contentLines.splice(startLine, searchLines.length, ...replaceLines);
            content = contentLines.join('\n');
            usedFuzzy = true;
            applied.push({ search: edit.search.slice(0, 80), replace: edit.replace.slice(0, 80), fuzzy: true });
            wfInfo(`applyEdits FUZZY-MATCH | search="${edit.search.slice(0, 50)}..." -> line ${startLine + 1}`);
            continue; // skip the normal replacement logic
        }
        }

        if (idx === -1) {
            failed.push({ search: edit.search.slice(0, 80), reason: 'search-String nicht im aktuellen Datei-Inhalt gefunden' });
            continue;
        }

        content = content.slice(0, idx) + edit.replace + content.slice(idx + edit.search.length);
        applied.push({ search: edit.search.slice(0, 80), replace: edit.replace.slice(0, 80), fuzzy: usedFuzzy });
    }
    return { content, applied, failed };
}

/**
 * Extrahiert Funktions-/Klassen-Signaturen mit Zeilennummern aus Datei-Inhalt.
 * Gibt [{ line, signature }] zurueck.
 */
function extractSymbolIndex(content) {
    if (!content || typeof content !== 'string') return [];
    const lines = content.split('\n');
    const symbols = [];
    const symRe = /^(\s*)(async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function|(?:const|let|var)\s+(\w+)\s*=\s*\(.*\)\s*=>|^class\s+(\w+)|module\.exports\s*=\s*\{|module\.exports\.(\w+)\s*=|exports\.(\w+)\s*=|^(export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var))\s+(\w+)/;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(symRe);
        if (m) {
            const name = m[3] || m[4] || m[5] || m[6] || m[7] || m[8] || m[10] || '';
            const sig = lines[i].trim().slice(0, 120);
            if (name || sig.startsWith('module.exports =') || sig.startsWith('export ')) {
                symbols.push({ line: i + 1, signature: sig });
            }
        }
    }
    return symbols;
}

/**
 * Extrahiert Zeilenbereiche aus Datei-Inhalt als reinen Text (ohne Zeilennummern).
 * ranges: [{ start, end }] — 1-basierte Zeilennummern.
 * Gibt { content, startLine } zurueck — content OHNE Zeilennummern.
 */
function extractLineRanges(content, ranges, maxBytes = 15000) {
    if (!content || typeof content !== 'string') return { content: '', startLine: 1 };
    const lines = content.split('\n');
    const included = [];
    let startLine = Infinity;
    let totalBytes = 0;
    for (const r of ranges) {
        const start = Math.max(1, r.start || 1);
        const end = Math.min(lines.length, r.end || lines.length);
        if (start < startLine) startLine = start;
        for (let i = start - 1; i < end; i++) {
            if (totalBytes + lines[i].length > maxBytes) {
                return { content: included.join('\n'), startLine: startLine === Infinity ? 1 : startLine };
            }
            included.push(lines[i]);
            totalBytes += lines[i].length;
        }
    }
    return { content: included.join('\n'), startLine: startLine === Infinity ? 1 : startLine };
}

// Workflow-Engine v2 — typed JSON bundles, deterministisches Briefing,
// Repo-Resolver fuer technische open_questions, Coding-Loop mit Self-Correction.
//
// Stages: triage -> security -> planning -> integration -> approval(dispatch)
//         -> coding -> approval(final)
//
// Datenfluss:
//   - Jede AI-Stage produziert ein typed JSON, persistiert in
//     ticket_workflow_steps.output_payload.
//   - Folgende Stages laden ihre Vorgaenger-Bundles aus der DB
//     (loadStageBundles), kein Mutation-Patchwork mehr.
//   - Vor pauseForHumanQuestions laeuft der Repo-Resolver. Nur wirklich
//     unloesbare Fragen gehen an den Menschen.
//   - Coding-Stage baut den Prompt deterministisch via briefing.js und macht
//     einen Edit -> Verify (-> ggf. eine Korrektur)-Loop.
//
// Repo-Aufloesung:
//   Strikt aus systems.repo_owner / repo_name / repo_access_token via
//   ticket.system_id. KEINE github_integration- oder ticket.reference_repo-
//   Fallbacks mehr (siehe Architektur-Entscheidung).

const aiClient = require('../ai/client');
const prompts = require('../ai/prompts');
const { redact } = require('../ai/redact');
const { resolveQuestions, formatAnswersForPrompt } = require('../ai/clarifier');
const { pickStaffForRole } = require('./assignment');
const {
    fetchRepoContext,
    fetchFilesFromRepo,
    commitFilesAsPR,
    fetchRepoTreeLight,
    truncateForOverview
} = require('./githubContext');
const { runCodeChecks } = require('./codeChecks');
const { buildCodingBriefing, buildCorrectionFeedback, MAX_PROMPT_BYTES } = require('./briefing');
const dossierExport = require('./dossierExport');
const architectTools = require('../ai/architectTools');

const ARCHITECT_TOOLS_ENABLED = process.env.ARCHITECT_TOOLS_ENABLED !== 'false';
const ARCHITECT_TOOLS_BUDGET = parseInt(process.env.ARCHITECT_TOOLS_BUDGET, 10) || 6;

const MAX_RETRIES = parseInt(process.env.AI_WORKFLOW_MAX_RETRIES, 10) || 2;
const CODING_MAX_CORRECTION_PASSES = 1; // Aider-Style: 1 Versuch + 1 Korrektur

let dbRef = null;
let ioRef = null;

function init({ db, io }) {
    dbRef = db;
    ioRef = io;
}

// ---------- Logging ----------
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

// ---------- DB-Helpers ----------
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

/**
 * Markiert ein Ticket als 'umgesetzt' — wird von zwei Stellen aufgerufen:
 *   1) Coding-Bot hat einen PR fuer das Ticket erstellt
 *   2) Approver hat das Ticket-Dossier in einen Branch dispatcht (externer Agent)
 *
 * Nicht ueberschreiben, wenn das Ticket bereits 'geschlossen' oder 'umgesetzt' ist.
 * Schreibt einen Audit-Log-Eintrag (best effort).
 */
async function markTicketUmgesetzt(ticketId, reason) {
    try {
        const t = await getRow('SELECT id, status FROM tickets WHERE id = ?', [ticketId]);
        if (!t) return false;
        if (t.status === 'umgesetzt' || t.status === 'geschlossen') {
            wfInfo(`markTicketUmgesetzt SKIP | ticket=${ticketId} status=${t.status}`);
            return false;
        }
        await run(
            `UPDATE tickets SET status='umgesetzt', updated_at=CURRENT_TIMESTAMP WHERE id = ?`,
            [ticketId]
        );
        try {
            await run(
                `INSERT INTO audit_log (ticket_id, user, action, details) VALUES (?, ?, ?, ?)`,
                [ticketId, 'workflow', 'status_change', `Status: ${t.status} -> umgesetzt (${reason || 'auto'})`]
            );
        } catch (_) {}
        emit('ticket:status', { ticketId, status: 'umgesetzt', reason });
        wfInfo(`markTicketUmgesetzt OK | ticket=${ticketId} from=${t.status} reason=${reason}`);
        return true;
    } catch (e) {
        wfWarn(`markTicketUmgesetzt FAILED ticket=${ticketId}`, e.message);
        return false;
    }
}

// ---------- Repo-Aufloesung (NUR systems.repo_*) ----------
async function resolveIntegration(ticket) {
    if (!ticket || !ticket.system_id) {
        wfWarn(`resolveIntegration | kein system_id am Ticket id=${ticket?.id}`);
        return null;
    }
    const sys = await getRow(
        `SELECT id, name, repo_owner, repo_name, repo_access_token
         FROM systems WHERE id = ? AND active = 1 LIMIT 1`, [ticket.system_id]);
    if (!sys) {
        wfWarn(`resolveIntegration | system_id=${ticket.system_id} nicht gefunden oder inaktiv`);
        return null;
    }
    if (!sys.repo_owner || !sys.repo_name) {
        wfWarn(`resolveIntegration | system="${sys.name}" hat kein Repo konfiguriert`);
        return null;
    }
    wfInfo(`resolveIntegration | system="${sys.name}" repo=${sys.repo_owner}/${sys.repo_name} hasToken=${!!sys.repo_access_token}`);
    return {
        project_id: null,
        system_id: sys.id,
        repo_owner: sys.repo_owner,
        repo_name: sys.repo_name,
        access_token: sys.repo_access_token || null,
        default_branch: null
    };
}

// ---------- AI-Call ----------
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
                system: finalSystem, user: userPrompt, json, extra
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

// ---------- Step-Lifecycle ----------
async function startStep(runId, stage, sortOrder, staff) {
    const r = await run(`INSERT INTO ticket_workflow_steps
        (run_id, stage, sort_order, staff_id, executor_kind, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'in_progress', CURRENT_TIMESTAMP)`,
        [runId, stage, sortOrder, staff?.id || null, staff?.kind || null]);
    return r.lastID;
}

async function finishStep(stepId, { status, output, ai, actualApproverId }) {
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
    if (actualApproverId != null) {
        // Audit: wer hat tatsaechlich entschieden, falls != staff_id der Zuweisung.
        // Bewusst separates UPDATE, damit die bestehende staff_id (Audit-Trail
        // der urspruenglichen Zuweisung) unangetastet bleibt.
        await run('UPDATE ticket_workflow_steps SET actual_approver_id = ? WHERE id = ?',
            [actualApproverId, stepId]);
    }
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

// ---------- Bundle-Hydration aus DB ----------
async function loadStageBundle(runId, stage) {
    const row = await getRow(
        `SELECT output_payload FROM ticket_workflow_steps
         WHERE run_id = ? AND stage = ? AND status = 'done'
         ORDER BY id DESC LIMIT 1`, [runId, stage]);
    if (!row?.output_payload) return null;
    try { return JSON.parse(row.output_payload); }
    catch (e) { wfWarn(`loadStageBundle parse error stage=${stage}: ${e.message}`); return null; }
}

async function loadAllBundles(runId) {
    return {
        triage: await loadStageBundle(runId, 'triage'),
        security: await loadStageBundle(runId, 'security'),
        planning: await loadStageBundle(runId, 'planning'),
        integration: await loadStageBundle(runId, 'integration')
    };
}

// ---------- Stage-Executors ----------

async function execTriage({ ticket, staff }) {
    wfInfo(`Stage:TRIAGE start | ticket=${ticket.id}`);
    const systems = await getAll('SELECT id, name, description FROM systems WHERE active = 1 ORDER BY id', []);
    const preselectedSystemId = ticket.system_id ? parseInt(ticket.system_id, 10) : null;
    const preselectedSystem = preselectedSystemId
        ? (systems.find(s => s.id === preselectedSystemId) || null)
        : null;

    const userPrompt = prompts.TRIAGE.buildUser({ ticket, systems, preselectedSystem });
    const r = await callAIWithStaff(staff, { systemPrompt: prompts.TRIAGE.system, userPrompt });
    const out = r.parsed || { decision: 'unclear', reason: 'Antwort nicht parsebar', summary: '', suggested_action: '', open_questions: [] };

    if (preselectedSystemId) {
        if (out.system_id && parseInt(out.system_id, 10) !== preselectedSystemId) {
            wfWarn(`Stage:TRIAGE AI tried to override user system_id ${preselectedSystemId} -> ${out.system_id}, ignoring`);
            // AI chose wrong system — override system_id and patch text fields
            const wrongSys = systems.find(s => s.id === parseInt(out.system_id, 10));
            const correctSys = preselectedSystem;
            if (wrongSys && correctSys) {
                const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const patch = (text) => {
                    if (typeof text !== 'string') return text;
                    return text.replace(new RegExp(esc(wrongSys.name), 'g'), correctSys.name);
                };
                out.reason = patch(out.reason);
                out.summary = patch(out.summary);
                out.suggested_action = patch(out.suggested_action);
                out.system_match_confidence = 'high';
                wfInfo(`Stage:TRIAGE patched AI text: replaced "${wrongSys.name}" -> "${correctSys.name}"`);
            }
        }
        out.system_id = preselectedSystemId;
        out._system_locked = true;
    } else if (out.system_id) {
        await run('UPDATE tickets SET system_id = ? WHERE id = ?', [out.system_id, ticket.id]);
    }

    // Triage-Felder fuer UI/Notifs persistieren
    await run(
        `UPDATE tickets SET triage_decision = ?, triage_summary = ?, triage_action = ? WHERE id = ?`,
        [out.decision || null, out.summary || null, out.suggested_action || null, ticket.id]
    ).catch(() => {});

    out.markdown = `**Decision:** \`${out.decision}\`\n\n${out.reason || ''}\n\n_Vorschlag:_ ${out.suggested_action || ''}`;
    wfInfo(`Stage:TRIAGE done | decision=${out.decision} system_id=${out.system_id || 'none'}`);
    return { output: out, ai: r };
}

async function execSecurity({ ticket, staff, triageBundle, systemName }) {
    wfInfo(`Stage:SECURITY start | ticket=${ticket.id}`);
    const pre = redact(ticket.description || '');
    const userPrompt = prompts.SECURITY.buildUser({
        ticket,
        preRedacted: pre.redacted,
        triageSummary: triageBundle?.summary,
        triageAction: triageBundle?.suggested_action,
        systemName
    });
    const r = await callAIWithStaff(staff, { systemPrompt: prompts.SECURITY.system, userPrompt });
    const out = r.parsed || { redacted_text: pre.redacted, findings: pre.hits, coding_prompt: pre.redacted, open_questions: [] };
    const redacted = out.redacted_text || pre.redacted;
    const codingPrompt = out.coding_prompt || '';

    await run(`UPDATE tickets SET redacted_description = ?, coding_prompt = ? WHERE id = ?`,
        [redacted, codingPrompt, ticket.id]);

    out.markdown = `### Coding-Prompt\n\n${codingPrompt || '(leer)'}\n\n### Redigierte Beschreibung\n\n${redacted || '(leer)'}`;
    out._artifacts = [
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

function normalizePlanningOutput(out) {
    if (!out || typeof out !== 'object') return out;
    const seen = new Set();
    const cleaned = [];
    for (const v of (Array.isArray(out.allowed_files) ? out.allowed_files : [])) {
        const safe = sanitizePlanningPath(v);
        if (safe && !seen.has(safe)) { seen.add(safe); cleaned.push(safe); }
    }
    out.allowed_files = cleaned.slice(0, 25);
    if (!['extend', 'new', 'refactor'].includes(out.change_kind)) out.change_kind = 'extend';
    if (!Array.isArray(out.symbols_to_preserve)) out.symbols_to_preserve = [];
    if (!Array.isArray(out.constraints)) out.constraints = [];
    if (!Array.isArray(out.steps)) out.steps = [];
    if (!Array.isArray(out.risks)) out.risks = [];
    return out;
}

function renderPlanMarkdown(out) {
    const lines = [];
    if (out.summary) lines.push(`**Zusammenfassung:** ${out.summary}`);
    if (out.task) lines.push(`\n**Aufgabe:**\n${out.task}`);
    if (out.change_kind) lines.push(`\n**Change-Kind:** \`${out.change_kind}\``);
    if (out.allowed_files?.length) {
        lines.push(`\n**Allowed Files:**`);
        out.allowed_files.forEach(f => lines.push(`- \`${f}\``));
    }
    if (out.steps?.length) {
        lines.push(`\n**Schritte:**`);
        out.steps.forEach((s, i) => {
            lines.push(`${i + 1}. **${s.title || ''}**`);
            if (s.details) lines.push(`   - ${s.details}`);
            if (Array.isArray(s.files) && s.files.length) lines.push(`   - Dateien: ${s.files.join(', ')}`);
        });
    }
    if (out.constraints?.length) {
        lines.push(`\n**Constraints:**`);
        out.constraints.forEach(c => lines.push(`- ${c}`));
    }
    if (out.symbols_to_preserve?.length) {
        lines.push(`\n**Symbols to preserve:**`);
        out.symbols_to_preserve.forEach(s => lines.push(`- \`${s.path}\` :: \`${s.symbol}\``));
    }
    if (out.risks?.length) {
        lines.push(`\n**Risiken:**`);
        out.risks.forEach(r => lines.push(`- ${r}`));
    }
    if (out.estimated_effort) lines.push(`\n**Aufwand:** ${out.estimated_effort}`);
    if (out.architect_explore?.findings?.length) {
        lines.push(`\n**Verifizierte Fakten (Architect-Tools):**`);
        out.architect_explore.findings.forEach(f => lines.push(`- ${f}`));
        const calls = out.architect_explore.tool_calls?.length || 0;
        if (calls) lines.push(`\n_Basierend auf ${calls} Tool-Call(s)._`);
    }
    if (out.architect_explore?.non_existent?.length) {
        lines.push(`\n**Verbotene Annahmen (per Tool als nicht-existent verifiziert):**`);
        out.architect_explore.non_existent.forEach(n => lines.push(`- ${n}`));
    }
    if (out.architect_explore?.consistency_violations?.length) {
        lines.push(`\n**⚠ Konsistenz-Warnungen:**`);
        out.architect_explore.consistency_violations.forEach(v => {
            lines.push(`- Plan erwaehnt \`${v.hit_tokens.join(', ')}\` trotz Verifizierung: _${v.entry}_`);
        });
    }
    return lines.join('\n');
}

async function runResolverIfNeeded({ runId, stage, openQuestions, integration, repoTree, ticket }) {
    if (!Array.isArray(openQuestions) || !openQuestions.length) {
        return { answers: [], unresolved: [], ran: false };
    }
    if (!integration) {
        wfWarn(`Resolver SKIP no_integration | stage=${stage} questions=${openQuestions.length}`);
        return { answers: [], unresolved: [...openQuestions], ran: false };
    }
    const resolverStaff = await pickStaff('clarifier', 'ai').catch(() => null) || await pickStaff('triage', 'ai');
    if (!resolverStaff) {
        wfWarn(`Resolver SKIP no_staff | stage=${stage}`);
        return { answers: [], unresolved: [...openQuestions], ran: false };
    }
    wfInfo(`Resolver START | stage=${stage} questions=${openQuestions.length} staff="${resolverStaff.name}"`);
    const result = await resolveQuestions({
        questions: openQuestions,
        integration,
        repoTree: repoTree || '',
        staff: resolverStaff,
        callAI: callAIWithStaff,
        fetchFiles: fetchFilesFromRepo,
        prompts
    });
    wfInfo(`Resolver DONE | stage=${stage} answered=${result.answers.length} unresolved=${result.unresolved.length} files=${result.filesLoaded.length} iters=${result.iterations}`);

    // Resolver-Output als Artifact persistieren (zur Nachvollziehbarkeit)
    try {
        const md = [
            `# Repo-Resolver Antworten (Stage: ${stage})`,
            '',
            ...result.answers.map((a, i) =>
                `## ${i + 1}. ${a.question || ''}\n\n${a.answer || ''}\n\n_Quellen: ${(a.sources || []).join(', ') || '-'}_ | _Confidence: ${a.confidence || '-'}_`
            ),
            result.unresolved.length ? `\n---\n## Nicht aufloesbar (an Mensch):\n${result.unresolved.map(q => `- ${q}`).join('\n')}` : ''
        ].join('\n');
        await saveArtifact({
            ticketId: ticket.id, runId, stepId: null, stage,
            kind: 'resolver_answers', filename: `resolver_${stage}.md`,
            mimeType: 'text/markdown', content: md
        });
    } catch (e) { wfWarn(`Resolver artifact save failed`, e.message); }

    return { ...result, ran: true };
}

async function execPlanning({ ticket, staff, runId, securityBundle, integration, repoTree, systemName }) {
    wfInfo(`Stage:PLANNING start | ticket=${ticket.id} system_id=${ticket.system_id || 'none'}`);

    const codingPrompt = securityBundle?.coding_prompt || ticket.coding_prompt || ticket.redacted_description || ticket.description;

    // ---- Architect-Tools (ReAct-Loop) -----------------------------------
    // Vor dem eigentlichen Plan-Schreiben darf der Architect gezielt Symbole,
    // Tabellen und Datei-Inhalte im Repo verifizieren. Verhindert die typischen
    // Halluzinationen (falsche Tabellennamen, erfundene Funktionen).
    let exploreFindings = [];
    let exploreNonExistent = [];
    let toolTrace = [];
    let exploreTokens = { prompt: 0, completion: 0 };
    if (ARCHITECT_TOOLS_ENABLED && integration) {
        const result = await runArchitectExplore({
            ticket, staff, codingPrompt, integration, repoTree, systemName,
            budget: ARCHITECT_TOOLS_BUDGET
        });
        exploreFindings = result.findings;
        exploreNonExistent = result.nonExistent;
        toolTrace = result.trace;
        exploreTokens = result.tokens;
        wfInfo(`Stage:PLANNING explore done | calls=${toolTrace.length} findings=${exploreFindings.length} non_existent=${exploreNonExistent.length} prompt_tok=${exploreTokens.prompt} compl_tok=${exploreTokens.completion}`);
    } else if (!integration) {
        wfInfo(`Stage:PLANNING explore skipped (no repo integration)`);
    }

    // Boundary-Files laden (kleiner Kontext, damit der Architect sich orientieren kann)
    const boundary = (process.env.REPO_BOUNDARY_FILES || 'ticketsystem/package.json,ticketsystem/server.js,ticketsystem/README.md').split(',').map(s => s.trim()).filter(Boolean);
    let currentFiles = [];
    if (integration && boundary.length) {
        try { currentFiles = await fetchFilesFromRepo(integration, boundary); }
        catch (e) { wfWarn(`Stage:PLANNING boundary fetch failed`, e.message); }
    }
    const boundaryForOverview = currentFiles.filter(f => f.exists).map(truncateForOverview);
    const overviewBytes = boundaryForOverview.reduce((s, f) => s + (f.content?.length || 0), 0);
    wfInfo(`Stage:PLANNING boundary | files=${boundaryForOverview.length} overviewBytes=${overviewBytes} truncated=${boundaryForOverview.filter(f => f.truncated).length}`);

    let resolverAnswersText = '';
    const planningRepoInfo = integration ? `${integration.repo_owner}/${integration.repo_name}` : null;
    let userPrompt = prompts.PLANNING.buildUser({
        codingPrompt, repoTree,
        currentFiles: boundaryForOverview,
        resolverAnswers: '',
        systemName, repoInfo: planningRepoInfo,
        exploreFindings, exploreNonExistent
    });

    let r = await callAIWithStaff(staff, { systemPrompt: prompts.PLANNING.system, userPrompt });
    let out = r.parsed || { summary: '', task: codingPrompt || '', allowed_files: [], change_kind: 'extend', steps: [], risks: ['Antwort nicht parsebar'], open_questions: [] };

    // Repo-Resolver-Pass: technische Fragen automatisch klaeren und Planning ggf. wiederholen
    if (Array.isArray(out.open_questions) && out.open_questions.length) {
        const resolver = await runResolverIfNeeded({
            runId, stage: 'planning',
            openQuestions: out.open_questions,
            integration, repoTree, ticket
        });
        if (resolver.answers.length) {
            resolverAnswersText = formatAnswersForPrompt(resolver);
            wfInfo(`Stage:PLANNING re-running with resolver answers | answered=${resolver.answers.length} unresolved=${resolver.unresolved.length}`);
            userPrompt = prompts.PLANNING.buildUser({
                codingPrompt, repoTree,
                currentFiles: boundaryForOverview,
                resolverAnswers: resolverAnswersText,
                systemName, repoInfo: planningRepoInfo,
                exploreFindings, exploreNonExistent
            });
            r = await callAIWithStaff(staff, { systemPrompt: prompts.PLANNING.system, userPrompt });
            out = r.parsed || out;
            // Nach Resolver-Re-Run: keine offenen Fragen mehr.
            // Verbleibende unresolved-Fragen sind fachlicher Natur —
            // der Architect muss selbst entscheiden, nicht den Menschen fragen.
            out.open_questions = [];
        } else {
            // Resolver hat gar nichts beantwortet — Architect ohne Zusatzinfos neu starten,
            // ebenfalls ohne open_questions (selbst entscheiden)
            out.open_questions = [];
        }
    }

    normalizePlanningOutput(out);

    // Konsistenz-Check: hat der Architect Begriffe verplant, die er selbst
    // als nicht-existent markiert hatte? Verstoesse landen automatisch in
    // out.risks und werden geloggt.
    const consistencyViolations = checkPlanConsistency(out, exploreNonExistent);
    if (consistencyViolations.length) {
        out.risks = Array.isArray(out.risks) ? out.risks : [];
        consistencyViolations.forEach(v => {
            out.risks.push(`KONSISTENZ-WARNUNG: Plan erwaehnt "${v.hit_tokens.join(', ')}" obwohl der Architect zuvor verifiziert hatte: "${v.entry}". Reviewer/Approver bitte pruefen.`);
            wfWarn(`PLANNING consistency violation`, `tokens=[${v.hit_tokens.join(',')}] entry="${v.entry.slice(0, 120)}"`);
        });
    }

    // Tool-Trace persistieren — sichtbar im Workflow-Tab und im Dossier.
    if (toolTrace.length || exploreFindings.length || exploreNonExistent.length) {
        out.architect_explore = {
            findings: exploreFindings,
            non_existent: exploreNonExistent,
            consistency_violations: consistencyViolations,
            tool_calls: toolTrace,
            tokens: exploreTokens
        };
    }

    const planMd = renderPlanMarkdown(out);
    await run(`UPDATE tickets SET implementation_plan = ? WHERE id = ?`, [planMd, ticket.id]);
    out.markdown = planMd;
    out._artifacts = [
        { kind: 'implementation_plan', filename: 'implementation_plan.md', content: planMd }
    ];
    wfInfo(`Stage:PLANNING done | allowed_files=${out.allowed_files.length} change_kind=${out.change_kind} steps=${out.steps.length} open_q=${(out.open_questions || []).length}`);
    return { output: out, ai: r };
}

/**
 * ReAct-Loop fuer den Architect: erlaubt gezielte Tool-Calls
 * (list_tree, list_dir, read_file, grep) bevor der finale Plan geschrieben wird.
 * Liefert eine Liste verifizierter Fakten ("findings") und einen Tool-Trace.
 *
 * Loop-Ende: model setzt "done": true ODER Budget aufgebraucht ODER zwei
 * Fehlversuche in Folge.
 */
async function runArchitectExplore({ ticket, staff, codingPrompt, integration, repoTree, systemName, budget }) {
    const trace = [];
    let findings = [];
    let nonExistent = [];
    const tokens = { prompt: 0, completion: 0 };
    const repoInfo = `${integration.repo_owner}/${integration.repo_name}`;
    const toolDescriptions = architectTools.describeTools();
    let consecutiveErrors = 0;

    for (let i = 0; i < budget; i++) {
        const userPrompt = prompts.PLANNING_EXPLORE.buildUser({
            codingPrompt, repoTree, toolDescriptions,
            history: trace, budgetLeft: budget - i,
            systemName, repoInfo
        });
        let r;
        try {
            r = await callAIWithStaff(staff, {
                systemPrompt: prompts.PLANNING_EXPLORE.system,
                userPrompt,
                json: true
            });
        } catch (e) {
            wfWarn(`PLANNING_EXPLORE call failed`, e.message);
            break;
        }
        tokens.prompt += r?.prompt_tokens || 0;
        tokens.completion += r?.completion_tokens || 0;
        const parsed = r?.parsed;
        if (!parsed || typeof parsed !== 'object') {
            wfWarn(`PLANNING_EXPLORE non-parseable response, aborting loop`);
            break;
        }
        // Findings fortschreiben (jeder Schritt liefert eine wachsende Liste)
        if (Array.isArray(parsed.findings_so_far)) {
            findings = parsed.findings_so_far.slice(0, 30).map(f => String(f).slice(0, 400));
        }
        // Verbotsliste fortschreiben (Dinge, die der Architect per Tool als nicht-existent verifiziert hat)
        if (Array.isArray(parsed.non_existent)) {
            nonExistent = parsed.non_existent.slice(0, 20).map(f => String(f).slice(0, 400));
        }
        if (parsed.done === true || !parsed.tool) {
            wfInfo(`PLANNING_EXPLORE done after ${i} calls (model says done) | findings=${findings.length} non_existent=${nonExistent.length}`);
            break;
        }

        const toolName = String(parsed.tool || '').trim();
        const toolArgs = parsed.args && typeof parsed.args === 'object' ? parsed.args : {};
        const toolResult = await architectTools.runTool({
            name: toolName, args: toolArgs, integration
        });
        // Result trunkieren fuer den Trace (sonst blaeht es den naechsten Prompt auf)
        const resultStr = toolResult.result ? String(toolResult.result).slice(0, 4000) : null;
        const errorStr = toolResult.error ? String(toolResult.error).slice(0, 400) : null;
        trace.push({
            iteration: i + 1,
            thought: parsed.thought || '',
            tool: toolName,
            args: toolArgs,
            result: resultStr,
            error: errorStr
        });
        wfInfo(`PLANNING_EXPLORE call #${i + 1} | tool=${toolName} ok=${!errorStr}`);

        if (errorStr) {
            consecutiveErrors++;
            if (consecutiveErrors >= 2) {
                wfWarn(`PLANNING_EXPLORE 2 consecutive errors, aborting loop`);
                break;
            }
        } else {
            consecutiveErrors = 0;
        }
    }
    return { findings, nonExistent, trace, tokens };
}

/**
 * Konsistenz-Check: prueft, ob der Plan Begriffe verwendet, die der Architect
 * vorher selbst als 'non_existent' markiert hat. Liefert eine Liste von
 * Verstoessen (z.B. 'Plan erwaehnt webhook trotz non_existent-Eintrag').
 * Wir extrahieren aus jedem non_existent-Eintrag die zentralen Schluesselwoerter
 * (Identifier-aehnliche Tokens) und scannen den Plan-Text danach.
 */
function checkPlanConsistency(out, nonExistent) {
    if (!Array.isArray(nonExistent) || !nonExistent.length) return [];
    // Plan in einen einzigen Text reduzieren (alle textuellen Felder).
    const planText = [
        out.task || '',
        out.summary || '',
        ...(Array.isArray(out.steps) ? out.steps.flatMap(s => [s.title || '', s.details || '', ...(Array.isArray(s.files) ? s.files : [])]) : []),
        ...(Array.isArray(out.symbols_to_preserve) ? out.symbols_to_preserve.map(s => `${s.path || ''} ${s.symbol || ''}`) : []),
        ...(Array.isArray(out.affected_areas) ? out.affected_areas : []),
        ...(Array.isArray(out.allowed_files) ? out.allowed_files : [])
    ].join('\n').toLowerCase();

    const violations = [];
    for (const entry of nonExistent) {
        const lower = String(entry).toLowerCase();
        // Ignoriere generische Negations-Floskeln, picke Identifier-Tokens raus.
        const tokens = (lower.match(/[a-z_][a-z0-9_]{4,}/g) || [])
            .filter(t => !['existiert', 'keine', 'kein', 'nicht', 'vorhanden', 'gefunden', 'treffer', 'webhook_handler', 'datei', 'funktion', 'tabelle', 'modul'].includes(t))
            .filter((t, i, a) => a.indexOf(t) === i);
        // Pruefe jedes Token einzeln. Hit, wenn das Token im Plan vorkommt.
        const hits = tokens.filter(t => planText.includes(t));
        if (hits.length) {
            violations.push({ entry, hit_tokens: hits.slice(0, 5) });
        }
    }
    return violations;
}

function renderIntegrationMarkdown(out) {
    const lines = [];
    if (out.verdict) lines.push(`**Verdict:** \`${out.verdict}\``);
    if (out.recommended_complexity) lines.push(`**Empfohlener Coding-Level:** \`${out.recommended_complexity}\``);
    if (out.complexity_rationale) lines.push(`_${out.complexity_rationale}_`);
    if (out.rationale) lines.push(`\n${out.rationale}`);
    if (out.must_follow?.length) {
        lines.push(`\n**MUST FOLLOW:**`);
        out.must_follow.forEach(v => lines.push(`- ${v}`));
    }
    if (out.must_avoid?.length) {
        lines.push(`\n**MUST AVOID:**`);
        out.must_avoid.forEach(v => lines.push(`- ${v}`));
    }
    if (out.rule_violations?.length) {
        lines.push(`\n**Regelverletzungen:**`);
        out.rule_violations.forEach(v => lines.push(`- ${v}`));
    }
    if (out.integration_risks?.length) {
        lines.push(`\n**Integrations-Risiken:**`);
        out.integration_risks.forEach(v => lines.push(`- ${v}`));
    }
    if (out.recommended_changes?.length) {
        lines.push(`\n**Empfohlene Aenderungen:**`);
        out.recommended_changes.forEach(v => lines.push(`- ${v}`));
    }
    return lines.join('\n');
}

async function execIntegration({ ticket, staff, runId, planningBundle, integration, repoTree, systemName }) {
    wfInfo(`Stage:INTEGRATION start | ticket=${ticket.id}`);

    const projectDocsRows = await getAll(`SELECT pd.title, pd.content FROM project_documents pd
        INNER JOIN projects p ON p.id = pd.project_id
        WHERE p.system_id = ? LIMIT 20`, [ticket.system_id]);
    const projectDocs = projectDocsRows.map(d => `### ${d.title}\n\n${d.content || ''}`).join('\n---\n').slice(0, 60_000);

    // Plan als kompaktes Markdown an den Reviewer geben (volle JSON-Struktur ist redundant)
    const planMd = ticket.implementation_plan || (planningBundle ? renderPlanMarkdown(planningBundle) : '');

    const integrationRepoInfo = integration ? `${integration.repo_owner}/${integration.repo_name}` : null;
    let userPrompt = prompts.INTEGRATION.buildUser({
        plan: planMd,
        projectDocs,
        resolverAnswers: '',
        systemName, repoInfo: integrationRepoInfo
    });

    let r = await callAIWithStaff(staff, { systemPrompt: prompts.INTEGRATION.system, userPrompt });
    let out = r.parsed || { verdict: 'approve_with_changes', rationale: r.text?.slice(0, 500) || '', open_questions: [] };

    if (Array.isArray(out.open_questions) && out.open_questions.length) {
        const resolver = await runResolverIfNeeded({
            runId, stage: 'integration',
            openQuestions: out.open_questions,
            integration, repoTree, ticket
        });
        if (resolver.answers.length) {
            const ansText = formatAnswersForPrompt(resolver);
            wfInfo(`Stage:INTEGRATION re-running with resolver answers | answered=${resolver.answers.length} unresolved=${resolver.unresolved.length}`);
            userPrompt = prompts.INTEGRATION.buildUser({
                plan: planMd, projectDocs, resolverAnswers: ansText,
                systemName, repoInfo: integrationRepoInfo
            });
            r = await callAIWithStaff(staff, { systemPrompt: prompts.INTEGRATION.system, userPrompt });
            out = r.parsed || out;
            out.open_questions = [];
        } else {
            out.open_questions = [];
        }
    }

    if (!['medium', 'high'].includes(out.recommended_complexity)) out.recommended_complexity = 'medium';
    if (!Array.isArray(out.must_follow)) out.must_follow = [];
    if (!Array.isArray(out.must_avoid)) out.must_avoid = [];

    const md = renderIntegrationMarkdown(out);
    await run(`UPDATE tickets SET integration_assessment = ? WHERE id = ?`, [md, ticket.id]);
    out.markdown = md;
    out._artifacts = [
        { kind: 'integration_assessment', filename: 'integration_assessment.md', content: md }
    ];
    wfInfo(`Stage:INTEGRATION done | verdict=${out.verdict} complexity=${out.recommended_complexity}`);
    return { output: out, ai: r };
}

// ---------- Engine ----------

async function loadDefaultWorkflow() {
    const wf = await getRow(`SELECT * FROM workflow_definitions WHERE is_default = 1 AND active = 1 LIMIT 1`, []);
    if (!wf) { wfWarn('Kein Default-Workflow gefunden'); return null; }
    const stages = await getAll(`SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY sort_order`, [wf.id]);
    wfInfo(`Workflow geladen | id=${wf.id} stages=${stages.length} roles=${stages.map(s => s.role).join('->')}`);
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

async function pauseForHumanQuestions(runId, ticket, stage, sortOrder, openQuestions, systemName, integration) {
    if (!Array.isArray(openQuestions) || !openQuestions.length) return false;
    const approverStaff = await pickStaff('approval', 'human');
    const questionSort = sortOrder + 0.5;
    const stepId = await startStep(runId, 'approval', questionSort, approverStaff);
    const ctxParts = [];
    if (systemName || ticket.system_id) {
        ctxParts.push(`System: ${systemName || ticket.system_id} (ID ${ticket.system_id})`);
    }
    if (integration) {
        ctxParts.push(`Repo: ${integration.repo_owner}/${integration.repo_name}`);
    }
    const ctxHeader = ctxParts.length ? `\n\n> ${ctxParts.join(' · ')}` : '';
    const payload = {
        phase: 'questions',
        source_stage: stage,
        resume_after_sort_order: sortOrder,
        open_questions: openQuestions.slice(0, 10),
        created_at: new Date().toISOString(),
        markdown: `**Rückfragen vom ${stage}-Bot**${ctxHeader}`
    };
    await run(`UPDATE ticket_workflow_steps SET status='waiting_human', output_payload=? WHERE id = ?`, [JSON.stringify(payload), stepId]);
    await run(`UPDATE ticket_workflow_runs SET status='waiting_human', current_stage='approval' WHERE id = ?`, [runId]);
    if (approverStaff) {
        await run('UPDATE tickets SET assigned_to = ? WHERE id = ?', [approverStaff.id, ticket.id]);
    }
    wfWarn(`pauseForHumanQuestions | run=${runId} source_stage=${stage} questions=${openQuestions.length}`);
    emit('workflow:waiting_human', { runId, ticketId: ticket.id, stepId, stage: 'approval', phase: 'questions', source_stage: stage });
    return true;
}

async function runStages(runId, initialTicket, stages, ctxExtras) {
    wfInfo(`runStages start | run=${runId} ticket=${initialTicket.id} stages=${stages.map(s => s.role).join('->')} extraInfo=${ctxExtras?.extra_info ? 'yes' : 'no'}`);

    // Repo-Context: Tree fuer Resolver (Docs werden nicht mehr in Prompts gepackt)
    let integration = null;
    let repoTree = '';
    let systemName = null;
    if (initialTicket.system_id) {
        const sys = await getRow('SELECT name FROM systems WHERE id = ?', [initialTicket.system_id]);
        systemName = sys?.name || null;
    }
    try {
        integration = await resolveIntegration(initialTicket);
        if (integration) {
            repoTree = await fetchRepoTreeLight(integration).catch(() => '');
            wfInfo(`Repo-Kontext geladen | treeLen=${repoTree.length}`);
        }
    } catch (e) { wfWarn(`Repo-Kontext laden fehlgeschlagen`, e.message); }

    let triageDecision = null;

    for (const stage of stages) {
        const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [initialTicket.id]);

        if (triageDecision === 'unclear' && stage.role !== 'triage') {
            await skipStep(runId, stage.role, stage.sort_order, 'triage_decision_unclear');
            wfInfo(`Stage SKIP unclear | role=${stage.role}`);
            continue;
        }

        const executorKind = stage.executor_kind || (stage.role === 'approval' ? 'human' : 'ai');
        const staff = await pickStaff(stage.role, executorKind);
        if (!staff) {
            wfWarn(`Kein Staff fuer role=${stage.role} kind=${executorKind} - skip`);
            await skipStep(runId, stage.role, stage.sort_order, 'no_staff_available');
            emit('workflow:no_staff', { runId, ticketId: initialTicket.id, role: stage.role, kind: executorKind });
            continue;
        }

        wfInfo(`runStages stage=${stage.role} | staff="${staff.name}" id=${staff.id} kind=${staff.kind}`);
        const stepId = await startStep(runId, stage.role, stage.sort_order, staff);
        emit('workflow:step', { runId, stage: stage.role, status: 'in_progress', staff_id: staff.id });

        if (staff.kind === 'human') {
            wfInfo(`runStages WAITING_HUMAN | run=${runId} stage=${stage.role}`);
            await run(`UPDATE ticket_workflow_steps SET status='waiting_human' WHERE id = ?`, [stepId]);
            await run(`UPDATE ticket_workflow_runs SET status='waiting_human' WHERE id = ?`, [runId]);
            await run('UPDATE tickets SET assigned_to = ? WHERE id = ?', [staff.id, initialTicket.id]);
            emit('workflow:waiting_human', { runId, ticketId: initialTicket.id, stepId, staff_id: staff.id, stage: stage.role });
            return;
        }

        try {
            // Bundles aller bisher abgeschlossenen Stages laden
            const bundles = await loadAllBundles(runId);

            // extra_info (z.B. Antworten auf Mensch-Fragen) wird durch den Approver-Resume-Pfad
            // separat in den Prompt gehaengt, falls noetig — hier nicht mehr inline.
            let result;
            if (stage.role === 'triage') {
                result = await execTriage({ ticket, staff });
            } else if (stage.role === 'security') {
                result = await execSecurity({ ticket, staff, triageBundle: bundles.triage, systemName: systemName });
            } else if (stage.role === 'planning') {
                result = await execPlanning({
                    ticket, staff, runId,
                    securityBundle: bundles.security,
                    integration, repoTree, systemName
                });
            } else if (stage.role === 'integration') {
                result = await execIntegration({
                    ticket, staff, runId,
                    planningBundle: bundles.planning,
                    integration, repoTree, systemName
                });
            } else if (stage.role === 'approval') {
                result = { output: { verdict: 'approved', note: 'AI auto-approval' }, ai: null };
                await run(`UPDATE tickets SET final_decision='approved' WHERE id = ?`, [initialTicket.id]);
            } else {
                throw new Error(`Unbekannte Stage-Rolle: ${stage.role}`);
            }

            // System-/Repo-Kontext in den Step-Output aufnehmen (sichtbar in der UI)
            const ctxParts = [];
            if (result.output?.system_id || ticket.system_id) {
                const sid = result.output?.system_id || ticket.system_id;
                ctxParts.push(`System: ${systemName || sid} (ID ${sid})`);
            }
            if (integration) {
                ctxParts.push(`Repo: ${integration.repo_owner}/${integration.repo_name}`);
            }
            if (ctxParts.length && result.output) {
                const ctxHeader = `> ${ctxParts.join(' · ')}`;
                result.output.markdown = result.output.markdown
                    ? `${ctxHeader}\n\n${result.output.markdown}`
                    : ctxHeader;
            }

            // ctx-extra-info (resume nach Mensch-Fragen) optional in den Plan-Output reinschreiben
            if (ctxExtras?.extra_info && (stage.role === 'planning' || stage.role === 'integration')) {
                result.output._extra_info_used = ctxExtras.extra_info.slice(0, 500);
            }

            await finishStep(stepId, { status: 'done', output: result.output, ai: result.ai });

            // Artifacts persistieren
            const artifacts = result.output?._artifacts;
            if (Array.isArray(artifacts) && artifacts.length) {
                wfInfo(`runStages artifacts | stage=${stage.role} count=${artifacts.length}`);
                for (const a of artifacts) {
                    try {
                        await saveArtifact({
                            ticketId: ticket.id, runId, stepId, stage: stage.role,
                            kind: a.kind, filename: a.filename,
                            mimeType: a.mimeType || 'text/markdown', content: a.content
                        });
                    } catch (e) { wfError('Artifact save failed', e.message); }
                }
                delete result.output._artifacts;
            }
            emit('workflow:step', { runId, stage: stage.role, status: 'done' });

            // Nur wirklich unloesbare Fragen pausieren den Workflow
            const stillOpen = normalizeQuestions(result.output?.open_questions);
            if (stillOpen.length) {
                const paused = await pauseForHumanQuestions(runId, initialTicket, stage.role, stage.sort_order, stillOpen, systemName, integration);
                if (paused) return;
            }

            if (ctxExtras?.extra_info) delete ctxExtras.extra_info;

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

// ---------- Human Decision Routing ----------

async function decideHumanStep(runId, stepId, decision, note, actor, options) {
    options = options || {};
    wfInfo(`decideHumanStep | run=${runId} step=${stepId} decision="${decision}" note="${(note || '').slice(0, 100)}" actor=${actor}`);
    const step = await getRow('SELECT * FROM ticket_workflow_steps WHERE id = ?', [stepId]);
    if (!step || step.run_id !== runId) throw new Error('Step nicht gefunden');
    if (step.status !== 'waiting_human') throw new Error('Step erwartet keine menschliche Entscheidung');

    // Audit: wer hat tatsaechlich entschieden? Wir persistieren die Staff-ID des
    // eingeloggten Users in actual_approver_id, sobald sie != step.staff_id ist.
    // Wenn der zugewiesene Approver selbst entscheidet, lassen wir das Feld NULL
    // (Default-Fall = wie bisher). Fallback: actor_staff_id fehlt -> NULL, also
    // weiterhin Anzeige ueber output.decided_by + step.staff_id.
    const actorStaffId = Number.isInteger(options.actor_staff_id) ? options.actor_staff_id : null;
    const stepStaffId = step.staff_id != null ? Number(step.staff_id) : null;
    const actualApproverId = (actorStaffId && stepStaffId && actorStaffId !== stepStaffId)
        ? actorStaffId
        : null;

    const run_ = await getRow('SELECT * FROM ticket_workflow_runs WHERE id = ?', [runId]);
    const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [run_.ticket_id]);
    let stepOutput = null;
    if (step.output_payload) {
        try { stepOutput = JSON.parse(step.output_payload); } catch (_) {}
    }

    // Questions-Phase: Mensch beantwortet wirklich nicht aufloesbare Fragen
    if (step.stage === 'approval' && stepOutput?.phase === 'questions') {
        if (decision !== 'answered') throw new Error('Ungueltige Entscheidung – erwarte "answered"');
        if (!String(note || '').trim()) throw new Error('Bitte beantworte die offenen Fragen im Notizfeld.');
        const output = {
            ...(stepOutput || {}),
            decision, note: note || null,
            decided_by: actor || null,
            decided_at: new Date().toISOString()
        };
        await finishStep(stepId, { status: 'done', output, ai: null, actualApproverId });
        const wf = await loadDefaultWorkflow();
        const remaining = wf.stages.filter(s => s.sort_order > Number(stepOutput.resume_after_sort_order || 0));
        const answerContext = `Antworten des menschlichen Approvers auf offene Fragen aus Stage "${stepOutput.source_stage}":\n${(stepOutput.open_questions || []).map((q, i) => `${i + 1}. ${typeof q === 'string' ? q : JSON.stringify(q)}`).join('\n')}\n\nAntwort:\n${note}`;
        await run(`UPDATE ticket_workflow_runs SET status='running', current_stage=? WHERE id = ?`, [remaining[0]?.role || stepOutput.source_stage, runId]);
        emit('workflow:step', { runId, stage: 'approval', status: 'done', decision, phase: 'questions' });
        runStages(runId, ticket, remaining, { extra_info: answerContext }).catch(err => {
            wfError('Workflow Resume nach Fragen fehlgeschlagen', err.message);
        });
        return { status: 'resumed_after_questions' };
    }

    const allowedDecisions = ['approved', 'rejected', 'unclear', 'handoff', 'dispatch_medium', 'dispatch_high', 'dispatch_external', 'rework'];
    if (!allowedDecisions.includes(decision)) throw new Error('Ungueltige Entscheidung');

    if (step.stage === 'approval') {
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
                if (!selectedStaff) throw new Error(`Der ausgewaehlte Coding-Bot passt nicht zum Level "${codingLevel}" oder ist nicht aktiv.`);
            }
            const output = {
                decision, coding_level: codingLevel, note: note || null,
                selected_staff_id: selectedStaff ? selectedStaff.id : null,
                selected_staff_name: selectedStaff ? selectedStaff.name : null,
                decided_by: actor || null, decided_at: new Date().toISOString()
            };
            await finishStep(stepId, { status: 'done', output, ai: null, actualApproverId });
            await run(`UPDATE ticket_workflow_runs SET status='running', current_stage='coding' WHERE id = ?`, [runId]);
            emit('workflow:step', { runId, stage: 'approval', status: 'done', decision });
            wfInfo(`DISPATCH CODING | run=${runId} ticket=${ticket.id} level=${codingLevel}`);
            const enrichedStep = { ...step, output_payload: JSON.stringify(output) };
            runCodingLoop(runId, ticket, codingLevel, enrichedStep, selectedStaff).catch(err => {
                wfError(`Coding-Loop Fehler run=${runId}`, err.message);
            });
            return {
                status: 'coding_dispatched',
                coding_level: codingLevel,
                selected_staff_id: selectedStaff ? selectedStaff.id : null,
                selected_staff_name: selectedStaff ? selectedStaff.name : null
            };
        }

        if (isDispatchPhase && decision === 'dispatch_external') {
            // Externer Coding-Agent: kein lokaler Bot — wir pushen das Dossier
            // in einen Branch des System-Repos. Der Agent (OpenCode/VSCode)
            // arbeitet dort mit eigenen Tools im echten Repo-Kontext.
            wfInfo(`DISPATCH EXTERNAL | run=${runId} ticket=${ticket.id}`);
            try {
                const dossier = await dossierExport.exportDossier({ runId, dispatchNote: note });
                const output = {
                    decision, note: note || null,
                    dossier_branch: dossier.branch,
                    dossier_commit_sha: dossier.commitSha,
                    dossier_branch_url: dossier.branchUrl,
                    decided_by: actor || null, decided_at: new Date().toISOString()
                };
                await finishStep(stepId, { status: 'done', output, ai: null, actualApproverId });
                await run(`UPDATE ticket_workflow_runs
                           SET status='completed', finished_at=CURRENT_TIMESTAMP, result='dispatched_external',
                               dossier_branch=?, dossier_commit_sha=?, dossier_exported_at=CURRENT_TIMESTAMP
                           WHERE id = ?`,
                    [dossier.branch, dossier.commitSha, runId]);
                await dbRef.run('UPDATE tickets SET final_decision = ? WHERE id = ?', ['dispatched_external', ticket.id]);
                // Ticket-Status auf 'umgesetzt' setzen — Dossier wurde an externen Agenten dispatcht.
                await markTicketUmgesetzt(ticket.id, `dispatch_external -> ${dossier.branch}`);
                emit('workflow:step', { runId, stage: 'approval', status: 'done', decision });
                emit('workflow:completed', { runId, ticketId: ticket.id, result: 'dispatched_external', dossier_branch: dossier.branch });
                return {
                    status: 'dispatched_external',
                    dossier_branch: dossier.branch,
                    dossier_commit_sha: dossier.commitSha,
                    dossier_branch_url: dossier.branchUrl
                };
            } catch (e) {
                wfError(`DOSSIER EXPORT FEHLER run=${runId}`, e.message);
                throw new Error(`Dossier-Export fehlgeschlagen: ${e.message}`);
            }
        }

        if (!isDispatchPhase && decision === 'rework') {
            wfInfo(`decideHumanStep REWORK | run=${runId} ticket=${ticket.id}`);
            const output = { decision: 'rework', note: note || null, decided_by: actor || null, decided_at: new Date().toISOString() };
            await finishStep(stepId, { status: 'done', output, ai: null, actualApproverId });
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
        await finishStep(stepId, { status: 'done', output, ai: null, actualApproverId });
        await dbRef.run('UPDATE tickets SET final_decision = ? WHERE id = ?', [decision, ticket.id]);
        await run(`UPDATE ticket_workflow_runs SET status='completed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            [decision, runId]);
        emit('workflow:completed', { runId, ticketId: ticket.id, result: decision });
        return { status: 'completed', result: decision };
    }

    // Andere Stages mit Mensch (selten)
    const output = { decision, note: note || null, decided_by: actor || null, decided_at: new Date().toISOString() };
    await finishStep(stepId, { status: 'done', output, ai: null, actualApproverId });
    const wf = await loadDefaultWorkflow();
    const remaining = wf.stages.filter(s => s.sort_order > step.sort_order);
    await run(`UPDATE ticket_workflow_runs SET status='running' WHERE id = ?`, [runId]);
    runStages(runId, ticket, remaining).catch(err => wfError('Workflow Resume Fehler', err.message));
    return { status: 'resumed' };
}

// ---------- Coding-Stage (Aider-Style: Edit -> Verify -> ggf. Korrektur) ----------

function renderCodingMarkdown(out, level) {
    const lines = [`### Coding-Bot Ergebnis (Level: \`${level}\`)`];
    if (out.summary) lines.push(`\n${out.summary}`);
    if (out.commit_message) lines.push(`\n**Commit-Message:**\n\n\`\`\`\n${out.commit_message}\n\`\`\``);
    if (Array.isArray(out.files) && out.files.length) {
        lines.push(`\n**Dateien (${out.files.length}):**`);
        out.files.forEach(f => {
            const editCount = Array.isArray(f.edits) ? f.edits.length : 0;
            if (editCount) {
                lines.push(`- \`${f.action || 'update'}\` ${f.path} — ${editCount} Edit(s)`);
            } else if (f.content) {
                lines.push(`- \`${f.action || 'create'}\` ${f.path} — vollstaendig`);
            } else {
                lines.push(`- \`${f.action || 'update'}\` ${f.path}`);
            }
        });
    }
    if (Array.isArray(out.test_plan) && out.test_plan.length) {
        lines.push(`\n**Test-Plan:**`);
        out.test_plan.forEach((t, i) => lines.push(`${i + 1}. ${t.step || ''} -> _${t.expected || ''}_`));
    }
    if (out.manual_verification) lines.push(`\n**Manuelle Pruefung:** ${out.manual_verification}`);
    if (Array.isArray(out.risks) && out.risks.length) {
        lines.push(`\n**Risiken:**`);
        out.risks.forEach(r => lines.push(`- ${r}`));
    }
    return lines.join('\n');
}

function validateCodingScope(out, allowedFiles, changeKind, currentFiles) {
    const violations = [];
    const allowSet = new Set(allowedFiles || []);
    const currentMap = new Map((currentFiles || []).map(f => [f.path, f]));
    const files = Array.isArray(out.files) ? out.files : [];

    if (!allowSet.size) {
        violations.push('Kein allowed_files-Whitelist aus PLANNING vorhanden — Coding-Stage erfordert Scope-Contract.');
        return violations;
    }
    if (!files.length && !(Array.isArray(out.assembled_files) && out.assembled_files.length)) {
        violations.push('Keine Files in der Antwort enthalten (out.files leer).');
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

        if (changeKind === 'new' && cur && cur.exists && action !== 'update') {
            violations.push(`change_kind=new, aber Datei existiert bereits: ${f.path}`);
        }
        if (action === 'delete' && changeKind !== 'refactor') {
            violations.push(`Datei-Delete erlaubt nur bei change_kind=refactor: ${f.path}`);
        }

        // Bei extend+edits: Symbol-Preservation wird durch assembleFilesFromEdits garantiert
        // (Edits aendern nur die search-Bloecke, der Rest der Datei bleibt unangetastet).
        // Nur beim Legacy-Fallback (action=update + content) pruefen wir Symbol-Erhaltung.
        if (changeKind === 'extend' && action === 'update' && typeof f.content === 'string' && !Array.isArray(f.edits)) {
            if (cur && cur.exists && cur.content) {
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
            }
        }
    }
    return violations;
}

/**
 * Wendet search/replace-Edits aus Bot-Antwort auf currentFiles an.
 * Ersetzt out.files[].edits durch den resultierenden content.
 * Gibt { editViolations, assembledFiles } zurueck.
 * assembledFiles = [{ path, action, content }] — bereit fuer PR-Upload.
 */
function assembleFilesFromEdits(out, currentFiles) {
    const violations = [];
    const currentMap = new Map((currentFiles || []).map(f => [f.path, f]));
    const assembledFiles = [];
    const files = Array.isArray(out.files) ? out.files : [];

    for (const f of files) {
        if (!f || !f.path) { violations.push('files[] enthaelt Eintrag ohne path'); continue; }
        const cur = currentMap.get(f.path);
        const action = f.action || 'update';

        if (action === 'create') {
            // Neue Datei: braucht content, KEIN edits
            if (!f.content && f.content !== '') {
                violations.push(`action=create aber kein content fuer: ${f.path}`);
                continue;
            }
            if (Array.isArray(f.edits) && f.edits.length) {
                violations.push(`action=create aber edits[] geliefert fuer: ${f.path} — bei create content verwenden`);
                continue;
            }
            assembledFiles.push({ path: f.path, action: 'create', content: f.content });
        } else if (action === 'update') {
            // Bestehende Datei: braucht edits[] oder content als Fallback
            if (Array.isArray(f.edits) && f.edits.length) {
                // Search/Replace-Modus
                if (!cur || !cur.exists) {
                    violations.push(`action=update aber Datei existiert nicht im Repo: ${f.path}`);
                    continue;
                }
                const original = cur.content || '';
                const result = applyEdits(original, f.edits);
                if (result.failed.length) {
                    result.failed.forEach(e => violations.push(`Edit fehlgeschlagen in ${f.path}: ${e.reason} — search: "${e.search}"`));
                }
                wfInfo(`assembleEdits | ${f.path} applied=${result.applied.length} failed=${result.failed.length}`);
                assembledFiles.push({ path: f.path, action: 'update', content: result.content });
                // Metadaten fuer Nachvollziehbarkeit
                f._appliedEdits = result.applied.length;
                f._failedEdits = result.failed.length;
            } else if (typeof f.content === 'string') {
                // Fallback: Bot hat trotzdem content geliefert (altes Format)
                assembledFiles.push({ path: f.path, action: 'update', content: f.content });
                wfInfo(`assembleEdits | ${f.path} using full-content fallback (no edits)`);
            } else {
                violations.push(`action=update aber weder edits[] noch content fuer: ${f.path}`);
            }
        } else if (action === 'delete') {
            assembledFiles.push({ path: f.path, action: 'delete', content: '' });
        } else {
            violations.push(`Unbekannte action "${action}" fuer: ${f.path}`);
        }
    }
    return { editViolations: violations, assembledFiles };
}

/**
 * Ein Coding-Pass in 2 Phasen:
 * Phase 1 (Explore): Bot sieht Plan + Symboldex → entscheidet welche Zeilen er braucht
 * Phase 2 (Edit): Bot sieht geladene Zeilenbereiche → schreibt search/replace-Edits
 * Liefert { out, ai, scopeViolations, codeCheckViolations, assembledFiles }.
 */
async function singleCodingPass({ ticket, staff, codingLevel, security, plan, integration, currentFiles, integrationCfg, approverNote, correctionFeedback, systemName, repoInfo }) {
    const allowedFiles = Array.isArray(plan?.allowed_files) ? plan.allowed_files : [];
    const changeKind = plan?.change_kind || 'extend';

    // Symboldex fuer alle allowed_files aufbauen
    const currentMap = new Map((currentFiles || []).map(f => [f.path, f]));
    const symbolIndex = allowedFiles.map(path => {
        const f = currentMap.get(path);
        if (!f || !f.exists) return { path, exists: false, action: 'create', symbols: [] };
        return {
            path,
            exists: true,
            action: changeKind === 'new' ? 'create' : 'update',
            symbols: extractSymbolIndex(f.content)
        };
    });

    // Phase 1: Explore — Bot fordert Zeilenbereiche an
    const explorePrompt = prompts.CODING_EXPLORE.buildUser({
        ticket, codingLevel, security, plan, integration,
        symbolIndex, approverNote, correctionFeedback, systemName, repoInfo
    });
    wfInfo(`Stage:CODING EXPLORE | bytes=${Buffer.byteLength(explorePrompt, 'utf-8')} symbols=${symbolIndex.reduce((s, f) => s + f.symbols.length, 0)}`);
    const exploreResult = await callAIWithStaff(staff, { systemPrompt: prompts.CODING_EXPLORE.system, userPrompt: explorePrompt, json: true });
    if (!exploreResult.parsed) {
        throw new Error(`Coding-Explore: AI-Antwort nicht als JSON parsebar. Preview: ${(exploreResult.text || '').slice(0, 300)}`);
    }

    // Zeilenbereiche aus Explore-Ergebnis extrahieren + Content laden
    const exploreOut = exploreResult.parsed;
    const requestedFiles = Array.isArray(exploreOut.files) ? exploreOut.files : [];
    wfInfo(`Stage:CODING EXPLORE_RESULT | files=${requestedFiles.length} summary=${(exploreOut.summary || '').slice(0, 100)}`);
    for (const rf of requestedFiles) {
        const ranges = Array.isArray(rf.read_ranges) ? rf.read_ranges : [];
        wfInfo(`Stage:CODING EXPLORE_RANGE | ${rf.path} action=${rf.action} ranges=${ranges.length} ${ranges.map(r => `L${r.start}-${r.end}`).join(',')}`);
    }
    const loadedRanges = [];
    for (const rf of requestedFiles) {
        if (!rf.path || !allowedFiles.includes(rf.path)) continue;
        const cur = currentMap.get(rf.path);
        if (!cur || !cur.exists) {
            // Neue Datei — keine Zeilen laden
            loadedRanges.push({ path: rf.path, exists: false, content: '', startLine: 1, truncated: false });
            continue;
        }
        const ranges = Array.isArray(rf.read_ranges) ? rf.read_ranges : [];
        if (!ranges.length && rf.action === 'create') {
            loadedRanges.push({ path: rf.path, exists: false, content: '', startLine: 1, truncated: false });
            continue;
        }
        // Fallback: wenn keine ranges angegeben aber action=update, nimm die Symbol-Zeilen + Kontext
        const effectiveRanges = ranges.length ? ranges : [
            { start: 1, end: Math.min(50, cur.content.split('\n').length), reason: 'default context' }
        ];
        const { content: rangeContent, startLine: rangeStart } = extractLineRanges(cur.content, effectiveRanges);
        loadedRanges.push({
            path: rf.path,
            exists: true,
            content: rangeContent,
            startLine: rangeStart,
            truncated: cur.truncated
        });
        wfInfo(`Stage:CODING EXPLORE | loaded ${rf.path} ranges=${effectiveRanges.length} bytes=${rangeContent.length}`);
    }

    // Phase 2: Edit — Bot sieht geladene Zeilenbereiche + schreibt Edits
    const editPrompt = prompts.CODING_EDIT.buildUser({
        ticket, codingLevel, plan, integration,
        loadedRanges, approverNote, correctionFeedback, systemName, repoInfo
    });
    const editBytes = Buffer.byteLength(editPrompt, 'utf-8');
    wfInfo(`Stage:CODING EDIT | bytes=${editBytes} ranges=${loadedRanges.length} hasApprover=${!!approverNote} hasCorrection=${!!correctionFeedback}`);

    if (editBytes > MAX_PROMPT_BYTES) {
        throw new Error(`Coding-Edit-Briefing zu gross: ${editBytes} bytes > MAX ${MAX_PROMPT_BYTES} bytes. Reduziere allowed_files im Plan.`);
    }

    const r = await callAIWithStaff(staff, { systemPrompt: prompts.CODING_EDIT.system, userPrompt: editPrompt });
    if (!r.parsed) {
        throw new Error(`Coding-Edit: AI-Antwort nicht als JSON parsebar. Preview: ${(r.text || '').slice(0, 300)}`);
    }
    const out = r.parsed;
    out.coding_level = codingLevel;

    // Search/Replace-Edits anwenden und finale Dateien assemblieren
    const { editViolations, assembledFiles } = assembleFilesFromEdits(out, currentFiles);
    if (editViolations.length) {
        wfWarn(`Stage:CODING edit-assembly violations | count=${editViolations.length}`);
    }
    out.assembled_files = assembledFiles;

    const scopeViolations = validateCodingScope(out, allowedFiles, changeKind, currentFiles);
    scopeViolations.push(...editViolations);

    let codeCheckViolations = [];
    let codeCheckResult = null;
    if (!scopeViolations.length && assembledFiles.length) {
        const wantLint = (process.env.AI_CODING_VERIFY_LINT || 'false').toLowerCase() === 'true';
        const wantBuild = (process.env.AI_CODING_VERIFY_BUILD || 'false').toLowerCase() === 'true';
        try {
            codeCheckResult = await runCodeChecks(assembledFiles, integrationCfg, { syntax: true, lint: wantLint, build: wantBuild });
            if (!codeCheckResult.ok) {
                codeCheckViolations = codeCheckResult.violations.map(v => `[${v.type}]${v.file ? ' ' + v.file : ''}: ${v.message}`);
            }
        } catch (e) {
            codeCheckViolations = [`code_checks_error: ${e.message}`];
        }
    }

    return { out, ai: r, scopeViolations, codeCheckViolations, codeCheckResult, prompt_bytes: editBytes, assembledFiles };
}

async function runCodingLoop(runId, ticket, codingLevel, dispatchStep, preferredStaff) {
    wfInfo(`runCodingLoop | run=${runId} ticket=${ticket.id} level=${codingLevel}`);

    // 1) Bundles laden — ALLE Vorgaenger-Outputs aus DB (kein Mutation-Patchwork)
    const bundles = await loadAllBundles(runId);
    if (!bundles.planning) {
        wfError(`runCodingLoop | KEIN Planning-Bundle in DB`);
        const stepId = await startStep(runId, 'coding', (dispatchStep?.sort_order || 5) + 1, null);
        await failStep(stepId, 'Coding ohne Planning-Bundle nicht moeglich (kein PLANNING-Step done).');
        await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            ['no_planning_bundle', runId]);
        return;
    }

    // 2) Approver-Notiz aus dispatch step
    let approverNote = null;
    if (dispatchStep?.output_payload) {
        try {
            const p = typeof dispatchStep.output_payload === 'string' ? JSON.parse(dispatchStep.output_payload) : dispatchStep.output_payload;
            if (p.note) approverNote = p.note;
        } catch (e) { wfWarn(`runCodingLoop dispatch payload parse error`, e.message); }
    }

    // 3) Repo-Integration + Source-Files fuer allowed_files laden
    const integration = await resolveIntegration(ticket);
    const allowedFiles = Array.isArray(bundles.planning.allowed_files) ? bundles.planning.allowed_files : [];
    let currentFiles = [];
    let systemName = null;
    let repoInfo = null;
    if (ticket.system_id) {
        const sys = await getRow('SELECT name FROM systems WHERE id = ?', [ticket.system_id]);
        systemName = sys?.name || null;
    }
    if (integration) {
        repoInfo = `${integration.repo_owner}/${integration.repo_name}`;
    }
    if (integration && allowedFiles.length) {
        try {
            currentFiles = await fetchFilesFromRepo(integration, allowedFiles, { maxBytes: 200 * 1024 });
            wfInfo(`runCodingLoop currentFiles | requested=${allowedFiles.length} loaded=${currentFiles.length} existing=${currentFiles.filter(f => f.exists).length} totalBytes=${currentFiles.reduce((s, f) => s + (f.content?.length || 0), 0)}`);
        } catch (e) { wfWarn(`runCodingLoop fetchFiles failed`, e.message); }
    }

    // 4) Coding-Bot waehlen
    const staff = preferredStaff || await pickStaff('coding', 'ai', { codingLevel });
    const sortOrder = (dispatchStep?.sort_order || 5) + 1;

    if (!staff) {
        wfWarn(`runCodingLoop NO_STAFF | run=${runId} level=${codingLevel}`);
        const stepId = await startStep(runId, 'coding', sortOrder, null);
        await failStep(stepId, `Kein Coding-Bot mit Level "${codingLevel}" verfuegbar`);
        await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            ['no_coding_bot:' + codingLevel, runId]);
        emit('workflow:no_staff', { runId, ticketId: ticket.id, role: 'coding', level: codingLevel });
        return;
    }

    wfInfo(`runCodingLoop BOT | "${staff.name}" id=${staff.id} provider=${staff.ai_provider || 'default'} auto_commit=${staff.auto_commit_enabled || 0}`);
    const stepId = await startStep(runId, 'coding', sortOrder, staff);
    emit('workflow:step', { runId, stage: 'coding', status: 'in_progress', staff_id: staff.id, level: codingLevel });

    // 5) Edit -> Verify (-> ggf. 1x Korrektur)
    let lastResult = null;
    let lastError = null;
    let correctionFeedback = null;
    const maxPasses = 1 + CODING_MAX_CORRECTION_PASSES;
    const passLog = [];

    try {
        for (let pass = 1; pass <= maxPasses; pass++) {
            wfInfo(`runCodingLoop PASS ${pass}/${maxPasses} | hasCorrection=${!!correctionFeedback}`);
            try {
                const res = await singleCodingPass({
                    ticket, staff, codingLevel,
                    security: bundles.security,
                    plan: bundles.planning,
                    integration: bundles.integration,
                    currentFiles,
                    integrationCfg: integration,
                    approverNote,
                    correctionFeedback,
                    systemName,
                    repoInfo
                });
                passLog.push({
                    pass, prompt_bytes: res.prompt_bytes,
                    scope_violations: res.scopeViolations.length,
                    code_check_violations: res.codeCheckViolations.length,
                    files: res.out.files?.length || 0
                });
                lastResult = res;

                if (!res.scopeViolations.length && !res.codeCheckViolations.length) {
                    wfInfo(`runCodingLoop PASS ${pass} OK | files=${res.out.files?.length || 0}`);
                    break;
                }

                wfWarn(`runCodingLoop PASS ${pass} VIOLATIONS | scope=${res.scopeViolations.length} checks=${res.codeCheckViolations.length}`);
                if (pass >= maxPasses) break; // letzter Pass: keine weitere Korrektur

                correctionFeedback = buildCorrectionFeedback({
                    scopeViolations: res.scopeViolations,
                    codeCheckViolations: res.codeCheckViolations
                });
            } catch (e) {
                lastError = e;
                wfError(`runCodingLoop PASS ${pass} ERROR`, e.message);
                if (pass >= maxPasses) break;
                correctionFeedback = `Letzter Versuch warf Fehler: ${e.message}\nBitte erneut versuchen mit korrektem JSON-Format.`;
            }
        }

        if (!lastResult && lastError) throw lastError;
        if (!lastResult) throw new Error('Coding-Loop ohne Ergebnis abgeschlossen');

        const out = lastResult.out;
        const allFailed = lastResult.scopeViolations.length || lastResult.codeCheckViolations.length;

         out.markdown = renderCodingMarkdown(out, codingLevel);
            // System-/Repo-Kontext zum Coding-Markdown hinzufuegen
            const codingCtxParts = [];
            if (systemName) codingCtxParts.push(`System: ${systemName}`);
            if (repoInfo) codingCtxParts.push(`Repo: ${repoInfo}`);
            if (codingCtxParts.length) out.markdown = `> ${codingCtxParts.join(' · ')}\n\n${out.markdown}`;
        out.passes = passLog;
        if (allFailed) {
            out.scope_violations = lastResult.scopeViolations;
            out.code_check_violations = lastResult.codeCheckViolations;
            out.markdown += `\n\n_Verstoesse nach ${passLog.length} Pass(es) — PR wird NICHT erstellt:_\n` +
                [...lastResult.scopeViolations, ...lastResult.codeCheckViolations].map(v => `- ${v}`).join('\n');
        } else {
            out.markdown += `\n\n_Verify ok nach ${passLog.length} Pass(es)._`;
        }
        if (lastResult.codeCheckResult) out.code_checks = lastResult.codeCheckResult;

        // Artifacts vorbereiten (assembled files mit vollem Inhalt)
        const assembledFiles = lastResult.assembledFiles || [];
        const artifacts = [];
        if (out.commit_message) artifacts.push({ kind: 'commit_message', filename: 'COMMIT_MSG.md', content: out.commit_message });
        if (Array.isArray(out.test_plan) && out.test_plan.length) {
            const tp = out.test_plan.map((t, i) => `${i + 1}. ${t.step || ''}\n   Erwartet: ${t.expected || ''}`).join('\n\n');
            artifacts.push({ kind: 'test_plan', filename: 'TEST_PLAN.md', content: tp });
        }
        assembledFiles.forEach(f => {
            if (f.path && (f.content || f.action === 'delete')) {
                const safe = String(f.path).replace(/[^a-zA-Z0-9._/\-]/g, '_').slice(0, 200);
                artifacts.push({
                    kind: 'code_file', filename: 'files/' + safe,
                    mimeType: 'text/plain', content: f.content || `(deleted: ${f.path})`
                });
            }
        });

        // PR erstellen, wenn alles ok (using assembled files with full content)
        const autoPrEnabled = (process.env.AI_CODING_AUTO_PR || 'true').toLowerCase() !== 'false';
        const tokenSource = integration?.access_token ? 'system.repo_access_token' : (process.env.GITHUB_DEFAULT_TOKEN ? 'GITHUB_DEFAULT_TOKEN' : 'none');
        wfInfo(`Stage:CODING PR-CHECK | autoPr=${autoPrEnabled} integration=${!!integration} auto_commit=${!!staff.auto_commit_enabled} files=${assembledFiles.length} tokenSource=${tokenSource}`);

        if (!allFailed && autoPrEnabled && integration && staff.auto_commit_enabled && assembledFiles.length) {
            try {
                const slug = String(ticket.title || 'change').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
                const pr = await commitFilesAsPR(integration, {
                    branchName: out.branch_name || `bot/ticket-${ticket.id}-${slug}`,
                    commitMessage: out.commit_message,
                    prTitle: `[Ticket #${ticket.id}] ${ticket.title || 'Coding-Bot Changes'}`.slice(0, 200),
                    prBody: `Automatisch erstellt vom Coding-Bot (Level: \`${codingLevel}\`).\n\n${out.summary || ''}\n\n---\nManuelle Pruefung: ${out.manual_verification || '-'}\n\nScope: change_kind=\`${bundles.planning.change_kind || 'extend'}\`, allowed_files=${(bundles.planning.allowed_files || []).length}`,
                    files: assembledFiles,
                    draft: true,
                    labels: ['bot-generated', 'needs-human-review', `coding-${codingLevel}`]
                });
                out.pr_url = pr.prUrl;
                out.pr_number = pr.prNumber;
                out.branch = pr.branch;
                out.pr_draft = pr.draft;
                out.markdown += `\n\n**Pull Request:** [#${pr.prNumber}](${pr.prUrl})${pr.draft ? ' _(Draft)_' : ''} — Branch \`${pr.branch}\``;
                wfInfo(`Stage:CODING PR-CREATED | pr=${pr.prNumber} url=${pr.prUrl} branch=${pr.branch} draft=${pr.draft}`);
                // Ticket-Status auf 'umgesetzt' setzen — der Coding-Bot hat einen PR erstellt.
                await markTicketUmgesetzt(ticket.id, `coding-bot PR #${pr.prNumber}`);
            } catch (e) {
                out.pr_error = e.message;
                out.markdown += `\n\n_PR-Erstellung fehlgeschlagen: ${e.message}_`;
                wfError(`Stage:CODING PR-FAILED`, e.message);
            }
        } else {
            const reasons = [];
            if (allFailed) reasons.push(`verify_failed (scope=${lastResult.scopeViolations.length}, checks=${lastResult.codeCheckViolations.length})`);
            if (!autoPrEnabled) reasons.push('AI_CODING_AUTO_PR=false');
            if (!integration) reasons.push(`Kein Repo am System konfiguriert (system_id=${ticket.system_id || 'null'})`);
            if (!staff.auto_commit_enabled) reasons.push(`auto_commit_enabled=0 fuer Bot "${staff.name}" (id=${staff.id})`);
            if (!assembledFiles.length) reasons.push('Keine assemblierte Dateien nach Edit-Anwendung');
            if (reasons.length) {
                out.markdown += `\n\n_PR-Erstellung uebersprungen: ${reasons.join('; ')}_`;
                wfWarn(`Stage:CODING PR-SKIPPED`, reasons.join(' | '));
            }
        }

        // Step-Status: failed wenn nach Korrektur immer noch Verstoesse, sonst done
        const finalStatus = allFailed ? 'failed' : 'done';
        if (finalStatus === 'failed') {
            await run(`UPDATE ticket_workflow_steps SET error = ? WHERE id = ?`,
                [`Verify failed nach ${passLog.length} Pass(es): ${[...lastResult.scopeViolations, ...lastResult.codeCheckViolations].slice(0, 3).join(' | ')}`.slice(0, 2000), stepId]);
        }
        await finishStep(stepId, { status: finalStatus, output: out, ai: lastResult.ai });

        // Artifacts persistieren
        for (const a of artifacts) {
            try {
                await saveArtifact({
                    ticketId: ticket.id, runId, stepId, stage: 'coding',
                    kind: a.kind, filename: a.filename,
                    mimeType: a.mimeType || 'text/markdown', content: a.content
                });
            } catch (e) { wfError('Artifact save failed', e.message); }
        }
        emit('workflow:step', { runId, stage: 'coding', status: finalStatus });

        if (finalStatus === 'failed') {
            await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
                ['coding_verify_failed', runId]);
            emit('workflow:failed', { runId, ticketId: ticket.id, stage: 'coding', error: 'verify_failed' });
            return;
        }

        // Final Approval Step
        const approverStaff = await pickStaff('approval', 'human');
        const finalSort = sortOrder + 1;
        const finalStepId = await startStep(runId, 'approval', finalSort, approverStaff);
        await run(`UPDATE ticket_workflow_steps SET status='waiting_human' WHERE id = ?`, [finalStepId]);
        await run(`UPDATE ticket_workflow_runs SET status='waiting_human', current_stage='approval' WHERE id = ?`, [runId]);
        if (approverStaff) {
            await run('UPDATE tickets SET assigned_to = ? WHERE id = ?', [approverStaff.id, ticket.id]);
        }
        wfInfo(`runCodingLoop FINAL-APPROVAL | run=${runId} approver="${approverStaff?.name || 'none'}"`);
        emit('workflow:waiting_human', { runId, ticketId: ticket.id, stepId: finalStepId, stage: 'approval', phase: 'final' });
    } catch (e) {
        wfError(`runCodingLoop FAILED | run=${runId}`, e.message);
        await failStep(stepId, e.message || String(e));
        await run(`UPDATE ticket_workflow_runs SET status='failed', finished_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`,
            ['coding_failed', runId]);
        emit('workflow:failed', { runId, ticketId: ticket.id, stage: 'coding', error: e.message });
    }
}

// ---------- Re-Run einer abgeschlossenen Stage ----------

async function rerunStage(runId, stepId, extraInfo, actor) {
    wfInfo(`rerunStage | run=${runId} step=${stepId} extraInfo_len=${(extraInfo || '').length} actor=${actor}`);
    const step = await getRow('SELECT * FROM ticket_workflow_steps WHERE id = ?', [stepId]);
    if (!step || step.run_id !== runId) throw new Error('Step nicht gefunden');
    const allowedStages = ['triage', 'security', 'planning', 'integration', 'coding'];
    if (!allowedStages.includes(step.stage)) throw new Error('Re-Run nur fuer Triage/Security/Planning/Integration/Coding moeglich');
    if (step.status !== 'done' && step.status !== 'failed') throw new Error('Nur abgeschlossene oder fehlgeschlagene Steps koennen erneut ausgefuehrt werden');
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

module.exports = { init, startForTicket, decideHumanStep, rerunStage };
