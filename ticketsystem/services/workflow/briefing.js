'use strict';

// Deterministischer Briefing-Builder fuer die Coding-Stage.
// Nimmt die typisierten JSON-Bundles aller Vorgaenger-Stages und baut daraus
// EINEN konsolidierten Prompt-Text. Kein AI-Aufruf, kein Trunkieren auf
// magische Zeichengrenzen. Wenn der Prompt zu gross wird, faellt das hier auf
// und wird als Fehler hochgereicht (nicht stillschweigend abgeschnitten).

const MAX_PROMPT_BYTES = parseInt(process.env.AI_CODING_MAX_PROMPT_BYTES, 10) || 200_000;

function bullet(items, prefix = '- ') {
    if (!Array.isArray(items) || !items.length) return '';
    return items.filter(Boolean).map(s => `${prefix}${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n');
}

function symbolList(symbols) {
    if (!Array.isArray(symbols) || !symbols.length) return '';
    return symbols
        .filter(s => s && s.path && s.symbol)
        .map(s => `- \`${s.path}\` :: \`${s.symbol}\``)
        .join('\n');
}

/**
 * Baut den User-Prompt fuer den Coding-Bot.
 *
 * @param {Object} args
 * @param {Object} args.ticket                  Ticket-Row aus DB
 * @param {string} args.codingLevel             "medium" | "high"
 * @param {Object} args.security                SecurityResult JSON ({ coding_prompt, redacted_text })
 * @param {Object} args.plan                    PlanResult JSON ({ task, allowed_files, change_kind, ... })
 * @param {Object} args.integration             IntegrationResult JSON ({ verdict, must_follow, must_avoid, ... })
 * @param {Array}  args.currentFiles            [{ path, exists, content, truncated }]
 * @param {string} args.approverNote            Optional: Notiz vom dispatch-Approver
 * @param {string} args.correctionFeedback      Optional: Feedback aus vorheriger Coding-Iteration (Self-Correction)
 * @returns {{ userPrompt: string, stats: Object }}
 */
function buildCodingBriefing({ ticket, codingLevel, security, plan, integration, currentFiles, approverNote, correctionFeedback, systemName, repoInfo }) {
    const parts = [];

    // 1) Header
    parts.push(`# Coding-Briefing — Ticket #${ticket.id}`);
    parts.push(`Typ: ${ticket.type} | Titel: ${ticket.title} | Level: ${codingLevel || 'medium'}`);
    if (systemName) parts.push(`System: ${systemName}`);
    if (repoInfo) parts.push(`Repo: ${repoInfo}`);
    parts.push('');

    // 2) Aufgabe (aus Security oder Plan)
    const codingPrompt = security?.coding_prompt || plan?.task || ticket.coding_prompt || ticket.redacted_description || ticket.description || '';
    parts.push(`## Aufgabe`);
    parts.push(codingPrompt || '(leer)');
    parts.push('');

    // 3) Plan (typed, nicht trunciert)
    if (plan) {
        parts.push(`## Plan`);
        if (plan.summary) parts.push(`**Zusammenfassung:** ${plan.summary}`);
        if (plan.task && plan.task !== codingPrompt) parts.push(`\n**Konkreter Auftrag:**\n${plan.task}`);
        parts.push(`\n**change_kind:** \`${plan.change_kind || 'extend'}\``);
        const allowed = Array.isArray(plan.allowed_files) ? plan.allowed_files : [];
        parts.push(`\n**allowed_files (${allowed.length}):**\n${bullet(allowed.map(p => '`' + p + '`')) || '(leer — Coding-Stage wird abbrechen)'}`);
        if (Array.isArray(plan.steps) && plan.steps.length) {
            parts.push(`\n**Schritte:**`);
            plan.steps.forEach((s, i) => {
                parts.push(`${i + 1}. **${s.title || ''}**`);
                if (s.details) parts.push(`   - ${s.details}`);
                if (Array.isArray(s.files) && s.files.length) parts.push(`   - Dateien: ${s.files.join(', ')}`);
            });
        }
        if (Array.isArray(plan.constraints) && plan.constraints.length) {
            parts.push(`\n**Constraints (Plan):**\n${bullet(plan.constraints)}`);
        }
        if (Array.isArray(plan.symbols_to_preserve) && plan.symbols_to_preserve.length) {
            parts.push(`\n**Symbols, die erhalten bleiben muessen:**\n${symbolList(plan.symbols_to_preserve)}`);
        }
        if (Array.isArray(plan.risks) && plan.risks.length) {
            parts.push(`\n**Plan-Risiken:**\n${bullet(plan.risks)}`);
        }
        parts.push('');
    }

    // 4) Integration-Review (typed, nicht trunciert)
    if (integration) {
        parts.push(`## Integration-Review`);
        if (integration.verdict) parts.push(`**Verdict:** \`${integration.verdict}\``);
        if (integration.rationale) parts.push(`\n${integration.rationale}`);
        if (Array.isArray(integration.must_follow) && integration.must_follow.length) {
            parts.push(`\n**MUST FOLLOW:**\n${bullet(integration.must_follow)}`);
        }
        if (Array.isArray(integration.must_avoid) && integration.must_avoid.length) {
            parts.push(`\n**MUST AVOID:**\n${bullet(integration.must_avoid)}`);
        }
        if (Array.isArray(integration.recommended_changes) && integration.recommended_changes.length) {
            parts.push(`\n**Empfohlene Aenderungen:**\n${bullet(integration.recommended_changes)}`);
        }
        if (Array.isArray(integration.integration_risks) && integration.integration_risks.length) {
            parts.push(`\n**Integrations-Risiken:**\n${bullet(integration.integration_risks)}`);
        }
        parts.push('');
    }

    // 5) Approver-Notiz (HOECHSTE Prioritaet)
    if (approverNote && String(approverNote).trim()) {
        parts.push(`## Approver-Notiz (HOECHSTE PRIORITAET)`);
        parts.push(String(approverNote).trim());
        parts.push('');
    }

    // 6) Self-Correction-Feedback (HOECHSTE Prioritaet, ueberschreibt nichts ausser Approver)
    if (correctionFeedback && String(correctionFeedback).trim()) {
        parts.push(`## Self-Correction Feedback`);
        parts.push(`Dein vorheriger Versuch hatte folgende Probleme. Korrigiere GENAU diese und liefere die Files erneut:`);
        parts.push(String(correctionFeedback).trim());
        parts.push('');
    }

    // 7) CURRENT FILES (ggf. gekuerzt bei >30 KB)
    if (Array.isArray(currentFiles) && currentFiles.length) {
        parts.push(`## CURRENT FILES (read-only Kontext)`);
        currentFiles.forEach(f => {
            const marker = f.exists ? '' : ' (NEU — wird erstellt)';
            const truncMarker = f.truncated ? ' (TRUNCATED — Original groesser als 30 KB, nur die ersten 30 KB gezeigt)' : '';
            parts.push(`\n### CURRENT FILE: ${f.path}${marker}${truncMarker}`);
            if (f.exists && f.content) {
                parts.push('```');
                parts.push(f.content);
                parts.push('```');
            } else if (!f.exists) {
                parts.push('(Datei existiert noch nicht)');
            } else {
                parts.push('(leer)');
            }
        });
        parts.push('');
    }

    const userPrompt = parts.join('\n');
    const bytes = Buffer.byteLength(userPrompt, 'utf-8');

    const stats = {
        prompt_bytes: bytes,
        prompt_chars: userPrompt.length,
        sections: {
            has_plan: !!plan,
            has_integration: !!integration,
            has_approver_note: !!approverNote,
            has_correction: !!correctionFeedback,
            current_files_count: Array.isArray(currentFiles) ? currentFiles.length : 0
        },
        over_budget: bytes > MAX_PROMPT_BYTES,
        max_prompt_bytes: MAX_PROMPT_BYTES
    };

    return { userPrompt, stats };
}

/**
 * Baut Self-Correction-Feedback aus Verstoessen (Scope, Syntax, Symbol-Preservation).
 */
function buildCorrectionFeedback({ scopeViolations, codeCheckViolations }) {
    const parts = [];
    if (Array.isArray(scopeViolations) && scopeViolations.length) {
        parts.push(`Scope-Verstoesse (du hast Pfade ausserhalb der Whitelist angefasst oder Symbole entfernt):`);
        scopeViolations.forEach(v => parts.push(`- ${v}`));
    }
    if (Array.isArray(codeCheckViolations) && codeCheckViolations.length) {
        parts.push(`\nSyntax-/Code-Check-Fehler:`);
        codeCheckViolations.forEach(v => parts.push(`- ${v}`));
    }
    if (!parts.length) return '';
    parts.push(`\nLiefere KOMPLETTE Datei-Inhalte erneut, mit den oben genannten Problemen behoben.`);
    parts.push(`Fasse keine anderen Files an. Behalte alle bisher korrekten Aenderungen bei.`);
    return parts.join('\n');
}

module.exports = { buildCodingBriefing, buildCorrectionFeedback, MAX_PROMPT_BYTES };
