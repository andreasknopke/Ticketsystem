'use strict';

// Dossier-Export: Schreibt das vollstaendige Workflow-Dossier eines Tickets
// als Markdown- und JSON-Dateien in einen dedizierten Branch des verknuepften
// GitHub-Repos. Gedacht fuer den Approver-Pfad "Dispatch -> Externer
// Coding-Agent". Der externe Agent (OpenCode, VS Code Copilot, etc.) checkt
// den Branch aus und arbeitet im echten Repo-Kontext mit eigenen Tools —
// wir reichen ihm nur die Analyse, keinen Code.

const { commitFilesToBranch } = require('./githubContext');

let dbRef = null;
function init({ db }) { dbRef = db; }

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

function dlog(msg, data) {
    const ts = new Date().toISOString();
    if (data !== undefined) {
        const extra = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 1000);
        console.log(`[DOSSIER] ${ts} ${msg} | ${extra}`);
    } else {
        console.log(`[DOSSIER] ${ts} ${msg}`);
    }
}

function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'ticket';
}

function fmtJson(obj) {
    try { return '```json\n' + JSON.stringify(obj, null, 2) + '\n```'; } catch (_) { return ''; }
}

// Bekannte Stages mit lesbarem Titel und Sortier-Praefix fuer den Dateinamen.
const STAGE_META = {
    triage:      { order: '01', title: 'Triage Reviewer' },
    security:    { order: '02', title: 'Security & Redaction' },
    planning:    { order: '03', title: 'Solution Architect (Planning)' },
    integration: { order: '04', title: 'Integration Reviewer' },
    approval:    { order: '05', title: 'Final Approver (Dispatch-Decision)' },
    clarifier:   { order: '0X', title: 'Clarifier' },
    coding:      { order: '0Y', title: 'Coding-Bot (Lokal)' }
};

function renderStageMarkdown(step, ticket) {
    const meta = STAGE_META[step.stage] || { order: '99', title: step.stage };
    const lines = [];
    lines.push(`# ${meta.title}`);
    lines.push('');
    lines.push(`- Ticket: #${ticket.id} — ${ticket.title || ''}`);
    lines.push(`- Stage: \`${step.stage}\``);
    lines.push(`- Status: \`${step.status}\``);
    if (step.staff_name) lines.push(`- Bearbeiter: ${step.staff_name} (${step.staff_kind || step.executor_kind || '?'})`);
    if (step.provider) lines.push(`- Provider/Modell: \`${step.provider}\` / \`${step.model || '?'}\``);
    if (step.created_at) lines.push(`- Gestartet: ${step.created_at}`);
    if (step.finished_at) lines.push(`- Beendet: ${step.finished_at}`);
    if (step.duration_ms) lines.push(`- Dauer: ${step.duration_ms} ms`);
    lines.push('');

    let output = null;
    if (step.output_payload) {
        try { output = JSON.parse(step.output_payload); } catch (_) {}
    }

    if (output && typeof output === 'object') {
        // Bevorzuge expliziten Markdown-Block, sonst typisierte Felder, sonst Roh-JSON.
        if (typeof output.markdown === 'string' && output.markdown.trim()) {
            lines.push('## Bericht');
            lines.push('');
            lines.push(output.markdown.trim());
            lines.push('');
        }
        // Stage-spezifische Highlights vorne aufziehen
        if (output.decision) {
            lines.push(`**Entscheidung:** \`${output.decision}\``);
            lines.push('');
        }
        if (output.summary && !output.markdown) {
            lines.push('## Zusammenfassung');
            lines.push('');
            lines.push(String(output.summary));
            lines.push('');
        }
        if (output.coding_prompt) {
            lines.push('## Coding-Prompt (redacted)');
            lines.push('');
            lines.push('```');
            lines.push(String(output.coding_prompt));
            lines.push('```');
            lines.push('');
        }
        if (output.redacted_text) {
            lines.push('## Redacted Description');
            lines.push('');
            lines.push('```');
            lines.push(String(output.redacted_text));
            lines.push('```');
            lines.push('');
        }
        if (output.note) {
            lines.push('## Notiz');
            lines.push('');
            lines.push(String(output.note));
            lines.push('');
        }
        if (output.architect_explore && (output.architect_explore.findings?.length || output.architect_explore.tool_calls?.length)) {
            const ax = output.architect_explore;
            lines.push('## Architect-Tool-Trace');
            lines.push('');
            if (ax.findings?.length) {
                lines.push('**Verifizierte Fakten:**');
                ax.findings.forEach(f => lines.push(`- ${f}`));
                lines.push('');
            }
            if (ax.tool_calls?.length) {
                lines.push(`**Tool-Calls (${ax.tool_calls.length}):**`);
                lines.push('');
                ax.tool_calls.forEach(c => {
                    lines.push(`### #${c.iteration} — \`${c.tool}\``);
                    if (c.thought) lines.push(`_${c.thought}_`);
                    lines.push('');
                    lines.push('Args:');
                    lines.push(fmtJson(c.args || {}));
                    if (c.error) {
                        lines.push('Fehler:');
                        lines.push('```');
                        lines.push(String(c.error));
                        lines.push('```');
                    } else if (c.result) {
                        lines.push('Result (gekuerzt):');
                        lines.push('```');
                        lines.push(String(c.result).slice(0, 1500));
                        lines.push('```');
                    }
                    lines.push('');
                });
            }
            if (ax.tokens) lines.push(`_Tokens: prompt=${ax.tokens.prompt || 0}, completion=${ax.tokens.completion || 0}_`);
            lines.push('');
        }
        // Volldump als Anhang
        lines.push('## Vollstaendiges Output-Payload');
        lines.push('');
        lines.push(fmtJson(output));
        lines.push('');
    } else if (step.error) {
        lines.push('## Fehler');
        lines.push('');
        lines.push('```');
        lines.push(String(step.error));
        lines.push('```');
        lines.push('');
    }

    return lines.join('\n');
}

function renderReadme(ticket, run, system, steps, dispatchNote) {
    const lines = [];
    lines.push(`# Ticket #${ticket.id} — Coding-Dossier`);
    lines.push('');
    lines.push(`> Dieses Verzeichnis enthaelt die vollstaendige Analyse des Ticketsystem-Workflows`);
    lines.push(`> fuer Ticket #${ticket.id}. Es ist als Briefing fuer einen externen Coding-Agenten`);
    lines.push(`> (z. B. OpenCode, VS Code Copilot) gedacht. Der Agent arbeitet direkt im Repo —`);
    lines.push(`> die Analyse hier dient als Eingabe, nicht als Code-Vorlage.`);
    lines.push('');
    lines.push('## Eckdaten');
    lines.push('');
    lines.push(`- Titel: **${ticket.title || ''}**`);
    if (ticket.type) lines.push(`- Typ: \`${ticket.type}\``);
    if (ticket.urgency) lines.push(`- Dringlichkeit: \`${ticket.urgency}\``);
    if (system) lines.push(`- System: ${system.name} (\`${system.repo_owner}/${system.repo_name}\`)`);
    lines.push(`- Workflow-Run: ${run.id} (gestartet ${run.started_at})`);
    if (dispatchNote) {
        lines.push('');
        lines.push('## Approver-Notiz');
        lines.push('');
        lines.push(dispatchNote);
    }
    lines.push('');
    lines.push('## Inhalt');
    lines.push('');
    for (const s of steps) {
        const meta = STAGE_META[s.stage] || { order: '99', title: s.stage };
        const fname = `${meta.order}_${s.stage}.md`;
        lines.push(`- [${meta.title}](./${fname}) — Status: \`${s.status}\``);
    }
    lines.push(`- [Manifest (JSON)](./manifest.json)`);
    lines.push('');
    lines.push('## Original-Beschreibung (unredacted)');
    lines.push('');
    lines.push('> Hinweis: Der `02_security.md`-Bericht enthaelt die redaktierte Variante,');
    lines.push('> die fuer KI-Aufrufe verwendet wurde.');
    lines.push('');
    lines.push('```');
    lines.push(String(ticket.description || ''));
    lines.push('```');
    return lines.join('\n');
}

function buildDossierFiles(ticket, run, system, steps, dispatchNote) {
    const dir = `tickets/${ticket.id}`;
    const files = [];

    files.push({ path: `${dir}/README.md`, content: renderReadme(ticket, run, system, steps, dispatchNote) });

    for (const step of steps) {
        const meta = STAGE_META[step.stage] || { order: '99', title: step.stage };
        files.push({
            path: `${dir}/${meta.order}_${step.stage}.md`,
            content: renderStageMarkdown(step, ticket)
        });
    }

    const manifest = {
        ticket_id: ticket.id,
        title: ticket.title,
        type: ticket.type,
        urgency: ticket.urgency,
        system: system ? { id: system.id, name: system.name, repo: `${system.repo_owner}/${system.repo_name}` } : null,
        run: {
            id: run.id,
            started_at: run.started_at,
            current_stage: run.current_stage,
            recommended_executor: run.recommended_executor || null
        },
        steps: steps.map(s => ({
            id: s.id,
            stage: s.stage,
            status: s.status,
            executor_kind: s.executor_kind,
            staff_id: s.staff_id,
            staff_name: s.staff_name || null,
            provider: s.provider || null,
            model: s.model || null,
            duration_ms: s.duration_ms || null
        })),
        exported_at: new Date().toISOString(),
        dispatch_note: dispatchNote || null
    };
    files.push({ path: `${dir}/manifest.json`, content: JSON.stringify(manifest, null, 2) });
    return files;
}

/**
 * Exportiert das Dossier eines Workflow-Runs in einen neuen Branch des
 * verknuepften Repos.
 *
 * @param {Object} args
 * @param {number} args.runId       Workflow-Run-ID
 * @param {string} [args.dispatchNote]   Notiz vom Approver, die ins README aufgenommen wird
 * @returns {Promise<{ branch: string, baseBranch: string, commitSha: string, branchUrl: string|null }>}
 */
async function exportDossier({ runId, dispatchNote }) {
    if (!dbRef) throw new Error('dossierExport.init nicht aufgerufen');
    if (!runId) throw new Error('runId erforderlich');

    const run = await getRow('SELECT * FROM ticket_workflow_runs WHERE id = ?', [runId]);
    if (!run) throw new Error(`Workflow-Run ${runId} nicht gefunden`);
    const ticket = await getRow('SELECT * FROM tickets WHERE id = ?', [run.ticket_id]);
    if (!ticket) throw new Error(`Ticket ${run.ticket_id} nicht gefunden`);
    if (!ticket.system_id) throw new Error('Ticket hat keine System-Zuordnung — Repo unbekannt');
    const system = await getRow(
        `SELECT id, name, repo_owner, repo_name, repo_access_token
         FROM systems WHERE id = ? LIMIT 1`, [ticket.system_id]);
    if (!system) throw new Error(`System ${ticket.system_id} nicht gefunden`);
    if (!system.repo_owner || !system.repo_name) {
        throw new Error(`System "${system.name}" hat kein Repository konfiguriert`);
    }
    const steps = await getAll(
        `SELECT s.*, st.name AS staff_name, st.kind AS staff_kind
         FROM ticket_workflow_steps s
         LEFT JOIN staff st ON st.id = s.staff_id
         WHERE s.run_id = ? ORDER BY s.sort_order, s.id`, [runId]);

    const files = buildDossierFiles(ticket, run, system, steps, dispatchNote);
    dlog(`Build dossier | ticket=${ticket.id} run=${runId} files=${files.length}`);

    const integration = {
        repo_owner: system.repo_owner,
        repo_name: system.repo_name,
        access_token: system.repo_access_token || null,
        default_branch: null
    };
    const branchName = `ticket/${ticket.id}-${slugify(ticket.title)}-dossier`;
    const result = await commitFilesToBranch(integration, {
        branchName,
        commitMessage: `dossier: ticket #${ticket.id} workflow analysis`,
        files
    });
    dlog(`Dossier gepusht | branch=${result.branch} sha=${result.commitSha?.slice(0, 7)}`);

    const branchUrl = `https://github.com/${system.repo_owner}/${system.repo_name}/tree/${encodeURIComponent(result.branch)}/tickets/${ticket.id}`;

    return { ...result, branchUrl };
}

module.exports = { init, exportDossier };
