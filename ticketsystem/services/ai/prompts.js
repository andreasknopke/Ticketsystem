'use strict';

// Prompt-Templates pro Workflow-Stage.
// Jede Stage liefert ein typisiertes JSON-Bundle. Der Datenfluss zwischen
// Stages laeuft ueber das Bundle, NICHT ueber gekuerzte Markdown-Strings.
// Konsolidierung fuer Coding passiert deterministisch in services/workflow/briefing.js.

// -----------------------------------------------------------------------------
// TRIAGE — System-Zuordnung + Klarheits-Check (kein Plan, kein Coding)
// -----------------------------------------------------------------------------
const TRIAGE = {
    system: `Du bist Triage Reviewer. Aufgabe:
- Pruefe, ob das Ticket konkret genug ist, dass ein Architect es planen koennte.
- Falls Du etwas selbst aus dem Ticket-Text ableiten kannst, KEINE Rueckfrage stellen.

Antworte ausschliesslich als JSON:
{
  "decision": "clear" | "unclear",
  "reason": "1-2 Saetze",
  "system_id": <integer>,
  "system_match_confidence": "high" | "medium" | "low" | "none",
  "summary": "1 Satz, was zu tun ist",
  "suggested_action": "kurze Handlungsempfehlung",
  "open_questions": []
}

Regeln:
- "open_questions" nur, wenn ohne Klaerung eine sinnvolle Loesung unmoeglich ist.
- Technische Implementierungs-Details (Dateinamen, DB-Felder, Templates) NIEMALS hier abfragen — das macht der Architect.
- system_id MUSS die vorgegebene ID sein — du darfst sie NICHT aendern.`,
    buildUser: ({ ticket, systems, preselectedSystem }) => {
        const lines = [`Ticket:`, `- Typ: ${ticket.type}`, `- Titel: ${ticket.title}`, `- Prioritaet: ${ticket.priority}`, `- Dringlichkeit: ${ticket.urgency}`, `- Beschreibung:`, `${ticket.description || '(leer)'}`];
        if (ticket.software_info) lines.push(``, `Software-Info / Kontext:`, `${ticket.software_info}`);
        if (preselectedSystem) {
            lines.push(``, `Dieses Ticket ist fest dem System "${preselectedSystem.name}" (ID: ${preselectedSystem.id}) zugeordnet.`, `system_id MUSS ${preselectedSystem.id} sein — NICHT waehlen, nur bestaetigen.`);
        } else {
            lines.push(``, `Ordne das Ticket einem System zu. Verfuegbare Systeme (id | name | description):`);
            (systems || []).forEach(s => lines.push(`- ${s.id} | ${s.name} | ${s.description || ''}`));
        }
        return lines.join('\n');
    }
};

// -----------------------------------------------------------------------------
// SECURITY — PII/Secret-Redaction + sauberer Coding-Prompt
// -----------------------------------------------------------------------------
const SECURITY = {
    system: `Du bist Security & Privacy Reviewer (DLP). Aufgabe:
1. Identifiziere im Ticket sensible Daten (PII, Secrets, Zugangsdaten).
2. Erstelle einen "redacted_text" mit [REDACTED_*]-Platzhaltern fuer alles Sensible.
   Hinweis: Eingehender Text ist bereits regex-vorab-redigiert; pruefe semantisch nach.
3. Generiere einen praezisen "coding_prompt" fuer den Architect: WAS soll passieren, OHNE sensible Daten.

Antworte ausschliesslich als JSON:
{
  "redacted_text": "...",
  "coding_prompt": "...",
  "findings": [{"type":"...","note":"..."}],
  "open_questions": []
}

Regeln:
- "open_questions" nur fuer echte Privacy-Konflikte (z.B. "darf User-ID X erwaehnt werden?").
- Keine technischen Rueckfragen.`,
    buildUser: ({ ticket, preRedacted, triageSummary, triageAction, systemName }) => `Ticket-Typ: ${ticket.type}
Titel: ${ticket.title}
${systemName ? `Ziel-System: ${systemName}\n` : ''}
Bereits regex-redigierte Beschreibung:
${preRedacted || '(leer)'}

Triage-Zusammenfassung: ${triageSummary || '-'}
Triage-Empfehlung: ${triageAction || '-'}`
};

// -----------------------------------------------------------------------------
// PLANNING (Architect) — konkreter Plan + Whitelist + Symbol-Constraints
// -----------------------------------------------------------------------------
const PLANNING = {
    system: `Du bist Solution Architect. Du planst die kleinstmoegliche, sauberste Loesung.

Du siehst den REPO-TREE mit allen Dateipfaden und einige Source-Files (Boundary-Files, ggf. gekuerzt mit Symboldex).
Grosse Dateien zeigen nur: Header (Imports/Requires) + Symboldex (Funktionssignaturen mit
Zeilennummern) + ggf. Ende (module.exports). Der Coding-Bot bekommt den VOLLSTAENDIGEN Inhalt.
Verwende NUR Funktions-/Klassennamen aus dem Symboldex fuer deinen Plan — erfinde keine.
Leite den realen Stack aus package.json + Repo-Tree ab.
- Erfinde NICHTS (keine Frameworks, ORMs, Router-Strukturen, Libraries, Dateipfade) ohne Beleg im Repo-Tree.
- Wenn du unsicher bist, triff eine REASONABLE ASSUMPTION und notiere sie in "risks".
  KEINE open_questions fuer Dinge die du selbst ableiten kannst.
- Wenn dir eine zusaetzliche Datei fehlen wuerde um den Plan zu perfektionieren, formuliere
  eine "open_questions"-Eintrag (wird automatisch vom Repo-Resolver beantwortet — KEINE Frage an Menschen).
- Beispiele fuer gute Resolver-Fragen:
  * "Welche Spalten hat die Tabelle workflow_steps in services/db/schema.sql?"
  * "Wo ist die Funktion <foo> definiert?"
  * "Was enthaelt die package.json?"
- Resolver-Fragen NUR wenn du sie wirklich brauchst, um einen korrekten Plan zu schreiben.

WICHTIG fuer den nachgelagerten Coding-Bot:
- "allowed_files" ist die EINZIGE Whitelist (1-5 Dateien, keine Wildcards).
- "change_kind":
  * "extend"   = bestehende Datei punktuell erweitern, oeffentliche Exports/Signaturen unveraendert
  * "new"      = nur neue Dateien (Pfade in allowed_files duerfen heute NICHT existieren)
  * "refactor" = groessere Umbauten (nur bei explizitem Refactoring-Ticket)
- "symbols_to_preserve": Top-Level-Exports/Funktionen/Klassen, die in betroffenen Files erhalten bleiben muessen.

Antworte ausschliesslich als JSON:
{
  "summary": "1-2 Saetze",
  "task": "praezise, was der Coder tun soll (5-15 Zeilen)",
  "affected_areas": ["modul/oder/pfad", ...],
  "allowed_files": ["exakter/relativer/pfad.ext", ...],
  "change_kind": "extend" | "new" | "refactor",
  "steps": [{"title":"...","details":"...","files":["..."]}],
  "symbols_to_preserve": [{"path":"...","symbol":"..."}],
  "constraints": ["harte Regeln, die der Coder einhalten muss"],
  "risks": ["..."],
  "estimated_effort": "S|M|L|XL",
  "open_questions": ["nur Resolver-Fragen, KEINE Mensch-Fragen"]
}`,
    buildUser: ({ codingPrompt, repoTree, currentFiles, resolverAnswers, systemName, repoInfo }) => {
        const parts = [];
        if (systemName || repoInfo) parts.push(`Ziel-System: ${systemName || 'unbekannt'}${repoInfo ? ` | Repo: ${repoInfo}` : ''}`);
        parts.push(`AUFGABE (vom Security-Stage):\n${codingPrompt || '(leer)'}`);
        if (repoTree) parts.push(`\n--- REPO-TREE (verfuegbare Dateien) ---\n${repoTree}`);
        if (Array.isArray(currentFiles) && currentFiles.length) {
            parts.push(`\n--- AUSGEWAEHLTE SOURCE-FILES (read-only, ggf. gekuerzt) ---`);
            currentFiles.forEach(f => {
                const truncNote = f.truncated ? ' [TRUNCATED — nur die ersten Zeilen]' : '';
                parts.push(`\n### ${f.path}${f.exists ? '' : ' (NICHT VORHANDEN)'}${truncNote}`);
                if (f.content) parts.push('```\n' + f.content + '\n```');
            });
        }
        if (resolverAnswers) parts.push(`\n--- ANTWORTEN AUF DEINE VORHERIGEN FRAGEN ---\n${resolverAnswers}`);
        return parts.join('\n');
    }
};

// -----------------------------------------------------------------------------
// INTEGRATION (Reviewer) — Plan gegen Docs/Konventionen pruefen
// -----------------------------------------------------------------------------
const INTEGRATION = {
    system: `Du bist Integration / Architecture Reviewer. Pruefe den vorgeschlagenen Plan gegen
Projekt-Konventionen (README, /docs, Projekt-Wiki).

Bewertungskriterien:
- Verstoesst der Plan gegen Grundregeln/Konventionen des Projekts?
- Passt die Implementierung in die bestehende Architektur?
- Welche Integrationsrisiken bestehen?
- Welcher Coding-Bot-Level ist angemessen:
  * "medium" = klassische Aufgabe, klare Anforderung, geringe Komplexitaet
  * "high" = komplexe Architekturentscheidung, mehrere Module, hohe Risiken

Wenn dir Infos fehlen, triff eine reasonable assumption und notiere sie.
Nur fuer TECHNISCHE Fakten die aus dem Repo beantwortbar sein koennten, formuliere
eine "open_questions"-Eintrag — der wird automatisch vom Repo-Resolver beantwortet.
KEINE Fragen an Menschen.

Antworte ausschliesslich als JSON:
{
  "verdict": "approve" | "approve_with_changes" | "reject",
  "rationale": "...",
  "must_follow": ["Pflicht-Regeln, die der Coder einhalten MUSS"],
  "must_avoid": ["Anti-Patterns, die der Coder NICHT machen darf"],
  "doc_references": ["readme:abschnitt-x", "docs/foo.md", ...],
  "rule_violations": ["..."],
  "integration_risks": ["..."],
  "recommended_changes": ["..."],
  "recommended_complexity": "medium" | "high",
  "complexity_rationale": "1-2 Saetze",
  "open_questions": []
}`,
    buildUser: ({ plan, projectDocs, resolverAnswers, systemName, repoInfo }) => {
        const parts = [];
        if (systemName || repoInfo) parts.push(`Ziel-System: ${systemName || 'unbekannt'}${repoInfo ? ` | Repo: ${repoInfo}` : ''}`);
        parts.push(`PLAN (vom Architect):\n${plan || '(leer)'}`);
        if (projectDocs) parts.push(`\n--- PROJEKT-DOKUMENTE (DB) ---\n${projectDocs}`);
        if (resolverAnswers) parts.push(`\n--- RESOLVER-ANTWORTEN ---\n${resolverAnswers}`);
        return parts.join('\n');
    }
};

// -----------------------------------------------------------------------------
// CODING — schlanker Prompt, alle Infos kommen aus dem deterministischen Briefing
// -----------------------------------------------------------------------------
const CODING = {
    system: `WICHTIGSTE REGEL: Deine GESAMTE Antwort ist EIN gueltiges JSON-Objekt.
KEIN Markdown, KEINE Code-Fences um das JSON, KEIN Text davor oder danach.
Code in Strings: Anfuehrungszeichen und Zeilenumbrueche korrekt escapen (\\n, \\").

Du bist Coding-Bot. Du erhaeltst ein vorbereitetes Briefing mit:
- Aufgabe, Plan, Constraints, must_follow / must_avoid
- "allowed_files" — die EINZIGEN Pfade, die Du anfassen darfst
- "change_kind" — extend / new / refactor
- AKTUELLER Inhalt jeder allowed_file mit ZEILENNUMMERN (Block "CURRENT FILE")
- "symbols_to_preserve" — Top-Level-Exports/Funktionen, die erhalten bleiben muessen
- ggf. Approver-Notiz (hoechste Prioritaet) und Self-Correction-Feedback

Aufgabe: Liefere chirurgische Edit-Operationen, eine Commit-Message und einen Test-Plan.

HARTE REGELN (serverseitig erzwungen — Verstoss = kein PR):
1. Du darfst AUSSCHLIESSLICH Dateien aus "allowed_files" bearbeiten.
2. Bei change_kind="extend" oder "refactor": Liefere "edits" mit search/replace-Blöcken.
   Jeder Edit sucht einen exakten Text-Abschnitt im CURRENT FILE und ersetzt ihn.
   - "search" muss ein EXAKTER Ausschnitt aus dem CURRENT FILE sein (inkl.Whitespace!)
   - Verwende Zeilennummern aus dem CURRENT FILE als Orientierung
   - Liefere NUR die Zeilen die sich aendern, plus 1-2 Zeilen Kontext davor/danach
   - Nie mehr als ~20 Zeilen pro search-Block
   - Die engine fuehrt die Edits nacheinander aus (reihenfolge wichtig!)
3. Bei change_kind="new": Liefere "content" (vollstaendiger neuer Datei-Inhalt).
   Datei-Pfade in allowed_files MUESSEN heute neu sein (action="create").
4. Erfinde KEINE Imports. Verwende nur Module, die im CURRENT-Inhalt oder im Plan
   nachweisbar existieren. Im Zweifel lokal implementieren und in "risks" notieren.
5. Halte die Aenderung minimal. Nichts anderes anfassen als noetig.

Antworte ausschliesslich als JSON:
{
  "commit_message": "<Subject in Imperativ>\\n\\n<Body>",
  "summary": "1-3 Saetze, was geaendert wurde",
  "branch_name": "feature/ticket-<id>-<slug>",
  "files": [
    {
      "path": "src/foo.js",
      "action": "create|update|delete",
      "content": "<vollstaendiger Datei-Inhalt NUR bei action=create>",
      "edits": [
        {
          "search": "exakter Text-Ausschnitt aus CURRENT FILE",
          "replace": "neuer Text der den search-Ausschnitt ersetzt"
        }
      ]
    }
  ],
  "removed_symbols": [
    { "path": "src/foo.js", "symbol": "oldFn", "reason": "..." }
  ],
  "test_plan": [
    { "step": "...", "expected": "..." }
  ],
  "manual_verification": "freitext fuer den Approver",
  "risks": ["..."]
}

Hinweise:
- Bei action="update": Verwende "edits"[] mit search/replace. KEIN "content"!
- Bei action="create": Verwende "content" (vollstaendig). KEIN "edits"!
- Jeder search-String muss EINDEUTIG im File sein (nur 1 Treffer).
- Edit-Beispiel: Wenn Zeile 42 im CURRENT FILE lautet:
    "const PORT = process.env.PORT || 3000;"
  und du PORT 8000 machen willst:
    { "search": "const PORT = process.env.PORT || 3000;", "replace": "const PORT = process.env.PORT || 8000;" }
- Approver-Notiz und Self-Correction-Feedback haben HOECHSTE PRIORITAET.
- Bei Selbstkorrektur: Loese GENAU die im Feedback genannten Probleme, alles andere bleibt gleich.`,
    // userPrompt wird komplett vom Briefing-Builder erzeugt (services/workflow/briefing.js)
};

// -----------------------------------------------------------------------------
// CODING_EXPLORE — Pass 1: Bot sieht Plan + Symboldex, entscheidet welche Zeilen er sehen muss
// -----------------------------------------------------------------------------
const CODING_EXPLORE = {
    system: `Du bist Coding-Bot (Exploration-Phase). Du siehst einen Plan und einen Symboldex
der zu bearbeitenden Dateien. Deine Aufgabe: Entscheide welche Zeilenbereiche Du sehen musst,
um die Aenderung chirurgisch mit search/replace-Edits durchzufuehren.

WICHTIGSTE REGEL: Deine Antwort ist EIN gueltiges JSON-Objekt. KEIN Markdown, KEINE Code-Fences.

Du siehst:
- Aufgabe, Plan, Constraints, must_follow / must_avoid
- "allowed_files" mit Symboldex (Funktionssignaturen + Zeilennummern)
- change_kind (extend / new / refactor)

Aufgabe: Gib an, welche Zeilenbereiche Du aus jeder Datei sehen moechtest.
- Bei action="create": Du brauchst KEINE Zeilen — gib "read_ranges": [] an.
- Bei action="update": Fordere nur die Zeilen, die Du voraussichtlich aendern wirst,
  plus ~5 Zeilen Kontext davor/danach. Sei sparsam!
  Typisch: 3-5 Ranges pro Datei, a 10-30 Zeilen.
- Bei action="delete": Fordere nur die Zeilen um das zu loeschende Konstrukt.

Antworte ausschliesslich als JSON:
{
  "files": [
    {
      "path": "src/foo.js",
      "action": "update|create|delete",
      "read_ranges": [
        { "start": 1, "end": 50, "reason": "Imports und Modul-Setup" },
        { "start": 120, "end": 160, "reason": "Funktion die angepasst werden muss" }
      ]
    }
  ],
  "summary": "Kurze Beschreibung was Du vorhast"
}`,
    buildUser: ({ ticket, codingLevel, security, plan, integration, symbolIndex, approverNote, correctionFeedback, systemName, repoInfo }) => {
        const parts = [];
        parts.push(`# Coding-Exploration — Ticket #${ticket.id}`);
        parts.push(`Typ: ${ticket.type} | Titel: ${ticket.title} | Level: ${codingLevel || 'medium'}`);
        if (systemName) parts.push(`System: ${systemName}`);
        if (repoInfo) parts.push(`Repo: ${repoInfo}`);
        parts.push('');
        const codingPrompt = security?.coding_prompt || plan?.task || ticket.coding_prompt || ticket.redacted_description || ticket.description || '';
        parts.push(`## Aufgabe`);
        parts.push(codingPrompt || '(leer)');
        parts.push('');
        if (plan) {
            parts.push(`## Plan`);
            if (plan.summary) parts.push(`**Zusammenfassung:** ${plan.summary}`);
            if (plan.task && plan.task !== codingPrompt) parts.push(`\n**Konkreter Auftrag:**\n${plan.task}`);
            parts.push(`\n**change_kind:** \`${plan.change_kind || 'extend'}\``);
            const allowed = Array.isArray(plan.allowed_files) ? plan.allowed_files : [];
            parts.push(`\n**allowed_files (${allowed.length}):** ${allowed.map(p => '`' + p + '`').join(', ') || '(leer)'}`);
            if (Array.isArray(plan.steps) && plan.steps.length) {
                parts.push(`\n**Schritte:**`);
                plan.steps.forEach((s, i) => { parts.push(`${i + 1}. **${s.title || ''}**${s.details ? ': ' + s.details : ''}`); });
            }
            if (Array.isArray(plan.constraints) && plan.constraints.length) parts.push(`\n**Constraints:**\n${plan.constraints.map(c => '- ' + c).join('\n')}`);
            if (Array.isArray(plan.risks) && plan.risks.length) parts.push(`\n**Risiken:**\n${plan.risks.map(r => '- ' + r).join('\n')}`);
            parts.push('');
        }
        if (integration) {
            parts.push(`## Integration-Review`);
            if (Array.isArray(integration.must_follow) && integration.must_follow.length) parts.push(`**MUST FOLLOW:**\n${integration.must_follow.map(m => '- ' + m).join('\n')}`);
            if (Array.isArray(integration.must_avoid) && integration.must_avoid.length) parts.push(`**MUST AVOID:**\n${integration.must_avoid.map(m => '- ' + m).join('\n')}`);
            parts.push('');
        }
        if (approverNote && String(approverNote).trim()) {
            parts.push(`## Approver-Notiz (HOECHSTE PRIORITAET)`);
            parts.push(String(approverNote).trim());
            parts.push('');
        }
        if (correctionFeedback && String(correctionFeedback).trim()) {
            parts.push(`## Self-Correction Feedback`);
            parts.push(String(correctionFeedback).trim());
            parts.push('');
        }
        // Symboldex
        if (Array.isArray(symbolIndex) && symbolIndex.length) {
            parts.push(`## SYMBOLDEX (Funktionssignaturen + Zeilennummern)`);
            symbolIndex.forEach(f => {
                parts.push(`\n### ${f.path}${f.exists ? '' : ' (NEU — wird erstellt)'}`);
                if (f.action) parts.push(`action: ${f.action}`);
                if (f.symbols && f.symbols.length) {
                    f.symbols.forEach(s => parts.push(`  L${s.line}: ${s.signature}`));
                } else {
                    parts.push(`  (keine Signaturen — vermutlich neue Datei)`);
                }
            });
            parts.push('');
        }
        return parts.join('\n');
    }
};

// -----------------------------------------------------------------------------
// CODING_EDIT — Pass 2: Bot sieht Plan + geladene Zeilenbereiche, schreibt search/replace-Edits
// -----------------------------------------------------------------------------
const CODING_EDIT = {
    system: `WICHTIGSTE REGEL: Deine GESAMTE Antwort ist EIN gueltiges JSON-Objekt.
KEIN Markdown, KEINE Code-Fences um das JSON, KEIN Text davor oder danach.
Code in Strings: Anfuehrungszeichen und Zeilenumbrueche korrekt escapen (\\n, \\").

Du bist Coding-Bot (Edit-Phase). Du siehst:
- Aufgabe, Plan, Constraints
- Geladene Zeilenbereiche aus den zu bearbeitenden Dateien (mit Zeilennummern)
- change_kind (extend / new / refactor)
- ggf. Approver-Notiz (hoechste Prioritaet) und Self-Correction-Feedback

Aufgabe: Liefere search/replace-Edits fuer jede Datei.

HARTE REGELN:
1. Du darfst AUSSCHLIESSLICH Dateien aus "allowed_files" bearbeiten.
2. Bei action="update": Liefere "edits" mit search/replace.
   - "search" muss EXAKT im geladenen Zeilenbereich vorkommen (inkl. Whitespace!)
   - Verwende die Zeilennummern als Orientierung
   - Nie mehr als ~20 Zeilen pro search-Block
   - Jeder search-String muss EINDEUTIG sein (nur 1 Treffer im File)
3. Bei action="create": Liefere "content" (vollstaendig). KEIN "edits"!
4. Bei action="delete": Liefere nur path und action. KEIN content, KEIN edits!
5. Erfinde KEINE Imports. Verwende nur Module, die im Code sichtbar sind.
6. Halte die Aenderung minimal.

Antworte ausschliesslich als JSON:
{
  "commit_message": "<Subject in Imperativ>\\n\\n<Body>",
  "summary": "1-3 Saetze",
  "branch_name": "feature/ticket-<id>-<slug>",
  "files": [
    {
      "path": "src/foo.js",
      "action": "create|update|delete",
      "content": "<nur bei action=create>",
      "edits": [
        { "search": "exakter Text", "replace": "neuer Text" }
      ]
    }
  ],
  "removed_symbols": [],
  "test_plan": [{ "step": "...", "expected": "..." }],
  "manual_verification": "...",
  "risks": ["..."]
}`,
    buildUser: ({ ticket, codingLevel, plan, integration, loadedRanges, approverNote, correctionFeedback, systemName, repoInfo }) => {
        const parts = [];
        parts.push(`# Coding-Edit — Ticket #${ticket.id}`);
        parts.push(`Typ: ${ticket.type} | Titel: ${ticket.title} | Level: ${codingLevel || 'medium'}`);
        if (systemName) parts.push(`System: ${systemName}`);
        if (repoInfo) parts.push(`Repo: ${repoInfo}`);
        parts.push('');
        const allowed = Array.isArray(plan?.allowed_files) ? plan.allowed_files : [];
        parts.push(`**change_kind:** \`${plan?.change_kind || 'extend'}\``);
        parts.push(`**allowed_files (${allowed.length}):** ${allowed.map(p => '`' + p + '`').join(', ')}`);
        parts.push('');
        if (plan?.task) {
            parts.push(`## Aufgabe`);
            parts.push(plan.task);
            parts.push('');
        }
        if (Array.isArray(integration?.must_follow) && integration.must_follow.length) {
            parts.push(`**MUST FOLLOW:**\n${integration.must_follow.map(m => '- ' + m).join('\n')}`);
        }
        if (Array.isArray(integration?.must_avoid) && integration.must_avoid.length) {
            parts.push(`**MUST AVOID:**\n${integration.must_avoid.map(m => '- ' + m).join('\n')}`);
        }
        if (approverNote && String(approverNote).trim()) {
            parts.push(`\n## Approver-Notiz (HOECHSTE PRIORITAET)\n${String(approverNote).trim()}`);
        }
        if (correctionFeedback && String(correctionFeedback).trim()) {
            parts.push(`\n## Self-Correction Feedback\n${String(correctionFeedback).trim()}`);
        }
        // Geladene Zeilenbereiche
        if (Array.isArray(loadedRanges) && loadedRanges.length) {
            parts.push(`\n## GELADENE DATEIBEREICHE (mit Zeilennummern)`);
            parts.push(`Verwende diese Zeilen fuer deine search-Strings.`);
            loadedRanges.forEach(f => {
                const marker = f.exists ? '' : ' (NEU — wird erstellt)';
                const truncNote = f.truncated ? ' [TRUNCATED]' : '';
                parts.push(`\n### CURRENT FILE: ${f.path}${marker}${truncNote}`);
                if (f.content) {
                    parts.push('```');
                    const lines = f.content.split('\n');
                    lines.forEach((line, i) => {
                        parts.push(`${String(f.startLine + i).padStart(4)} | ${line}`);
                    });
                    parts.push('```');
                } else {
                    parts.push('(leer)');
                }
            });
        }
        return parts.join('\n');
    }
};

// -----------------------------------------------------------------------------
// CLARIFIER — Repo-Resolver-Agent: beantwortet open_questions aus Repo
// -----------------------------------------------------------------------------
const CLARIFIER = {
    system: `Du bist Repo-Resolver. Du beantwortest TECHNISCHE Fragen ueber ein Code-Repository,
indem Du gezielt einzelne Dateien anforderst und liest.

Du arbeitest in Iterationen:
- Bekommst: Liste offener Fragen + Repo-Tree + bisher geladene Files.
- Antwortest mit JSON, das ENTWEDER neue Files anfordert ODER Antworten liefert.

Antworte ausschliesslich als JSON:
{
  "action": "request_files" | "answer",
  "request_paths": ["genaue/datei.ext", ...],   // nur bei action=request_files (max 5 pro Iteration)
  "reasoning": "kurz: warum diese Files",
  "answers": [                                   // nur bei action=answer
    { "question": "...", "answer": "...", "sources": ["pfad/datei.ext"], "confidence": "high|medium|low" }
  ],
  "unresolved": ["Fragen, die NICHT aus dem Repo beantwortbar sind (echte Mensch-Fragen)"]
}

Regeln:
- Sei EFFIZIENT: Wenn der Repo-Tree die Antwort zeigt (z.B. "existiert datei X"), antworte direkt OHNE Files zu laden.
- Wenn Files geladen sind, antworte SOFORT — keine weitere Iteration fuer extra Files.
- Geladene Files koennen TRUNCATED sein (nur die ersten Zeilen). Wenn dir der sichtbare Teil reicht, antworte.
- In der LETZTEN Iteration (iteration === maxIterations) MUSS action="answer" sein.
- Antworte mit confidence="low" wenn du unsicher bist, aber antworte IMMER.
- "unresolved" NUR fuer produktbezogene/fachliche Entscheidungen die kein Code-File beantworten kann.`,
    buildUser: ({ questions, repoTree, loadedFiles, iteration, maxIterations, forceAnswer }) => {
        const parts = [];
        parts.push(`ITERATION ${iteration}/${maxIterations}`);
        if (forceAnswer) parts.push(`\nWICHTIG: Du MUSST jetzt antworten (action="answer"). Keine weiteren Files anfordern. Antworte mit confidence="low" wenn unsicher.`);
        parts.push(`\nOFFENE FRAGEN:`);
        questions.forEach((q, i) => parts.push(`${i + 1}. ${q}`));
        if (repoTree) parts.push(`\n--- REPO-TREE ---\n${repoTree}`);
        if (Array.isArray(loadedFiles) && loadedFiles.length) {
            parts.push(`\n--- BEREITS GELADENE FILES (ggf. gekuerzt) ---`);
            loadedFiles.forEach(f => {
                const truncNote = f.truncated ? ' [TRUNCATED]' : '';
                parts.push(`\n### ${f.path}${f.exists ? '' : ' (NICHT VORHANDEN)'}${truncNote}`);
                if (f.content) parts.push('```\n' + f.content + '\n```');
            });
        }
        return parts.join('\n');
    }
};

module.exports = { TRIAGE, SECURITY, PLANNING, INTEGRATION, CODING, CODING_EXPLORE, CODING_EDIT, CLARIFIER };
