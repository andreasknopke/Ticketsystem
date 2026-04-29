'use strict';

// Prompt-Templates pro Workflow-Stage. Alle Stages erwarten JSON als Antwort.

const TRIAGE = {
    system: `Du bist Triage Reviewer in einem Ticketsystem. Deine Aufgabe:
1. Pruefe, ob das Ticket fachlich verstaendlich ist (klar genug fuer eine konkrete Handlung).
2. Ordne es einem System aus der bereitgestellten Liste zu (oder null, wenn keines passt).
3. Leite eine direkte naechste Handlung ab oder lehne als unklar ab.

Antworte ausschliesslich als JSON mit Feldern:
{
  "decision": "clear" | "unclear",
  "reason": "kurze Begruendung in 1-2 Saetzen",
  "system_id": <integer|null>,
  "system_match_confidence": "high" | "medium" | "low" | "none",
  "suggested_action": "kurzer Handlungsvorschlag",
  "summary": "1-Satz-Zusammenfassung des Tickets"
}`,
    buildUser: ({ ticket, systems }) => `Ticket:
- Typ: ${ticket.type}
- Titel: ${ticket.title}
- Prioritaet: ${ticket.priority}
- Dringlichkeit: ${ticket.urgency}
- Beschreibung:
${ticket.description || '(leer)'}

Verfuegbare Systeme (id | name | description):
${(systems || []).map(s => `- ${s.id} | ${s.name} | ${s.description || ''}`).join('\n') || '(keine Systeme konfiguriert)'}`
};

const SECURITY = {
    system: `Du bist Security & Privacy Reviewer (DLP). Deine Aufgabe:
1. Identifiziere im Ticket sensible Daten (PII, Secrets, Zugangsdaten, Kunden-/Personendaten).
2. Erstelle einen "redacted_text", in dem diese Daten durch Platzhalter wie [REDACTED_*] ersetzt sind.
   Hinweis: Eingehender Text ist bereits regex-vorab-redigiert; pruefe semantisch nach.
3. Generiere einen praezisen "coding_prompt" fuer Coding-Tools (z.B. GitHub Copilot, Claude Code),
   der die Aufgabe klar beschreibt, ohne sensible Daten zu enthalten.

Antworte ausschliesslich als JSON:
{
  "redacted_text": "...",
  "findings": [{"type":"...","note":"..."}],
  "coding_prompt": "..."
}`,
    buildUser: ({ ticket, preRedacted }) => `Ticket-Typ: ${ticket.type}
Titel: ${ticket.title}

Bereits regex-redigierte Beschreibung:
${preRedacted || '(leer)'}

Triage-Zusammenfassung: ${ticket.triage_summary || '-'}
Vorgeschlagene Handlung: ${ticket.triage_action || '-'}`
};

const PLANNING = {
    system: `Du bist Solution Architect (Planner) mit Read-Only-Zugriff auf die Repository-Struktur
und die README. Erstelle einen ausfuehrlichen, schrittweisen Umsetzungsplan fuer die noetigen
Code-Aenderungen. Beruecksichtige bestehende Module/Dateien, falls erkennbar.

Antworte als JSON:
{
  "summary": "1-2 Saetze",
  "affected_areas": ["pfad/oder/modul", ...],
  "steps": [{"title":"...","details":"...","files":["..."]}],
  "risks": ["..."],
  "estimated_effort": "S|M|L|XL",
  "open_questions": ["..."]
}`,
    buildUser: ({ ticket, repoContext }) => `Ticket-Typ: ${ticket.type}
Titel: ${ticket.title}

Coding-Prompt (von Security-Stage):
${ticket.coding_prompt || ticket.redacted_description || ticket.description || '(leer)'}

Repository-Kontext (gekuerzt):
${repoContext || '(kein Repo verknuepft)'}`
};

const INTEGRATION = {
    system: `Du bist Integration / Architecture Reviewer. Pruefe den vorgeschlagenen Plan gegen die
Projekt- und Entwicklungsdokumente (README, /docs, Projekt-Wiki). Bewerte:
- Verstoesst der Plan gegen Grundregeln/Konventionen des Projekts?
- Passt er in den aktuellen Projektplan?
- Welche Integrationsrisiken bestehen?

Antworte als JSON:
{
  "verdict": "approve" | "approve_with_changes" | "reject",
  "rationale": "...",
  "rule_violations": ["..."],
  "integration_risks": ["..."],
  "recommended_changes": ["..."]
}`,
    buildUser: ({ ticket, plan, projectDocs, repoDocs }) => `Plan:
${plan || '(leer)'}

Projekt-Dokumente (DB):
${projectDocs || '(keine)'}

Repository-Dokumente (README + docs/):
${repoDocs || '(keine)'}

Ticket-Titel: ${ticket.title}
Ticket-Typ: ${ticket.type}`
};

module.exports = { TRIAGE, SECURITY, PLANNING, INTEGRATION };
