'use strict';

/**
 * Zusammenfassung der Bestandsaufnahme (Flow Analysis, Abschnitt Input).
 *
 * Sammelt Transkripte, Dokumente und die erfassten Workflows/Probleme/
 * Adoptionsrisiken eines Projekts und baut daraus einen Prompt fuer das LLM.
 *
 * Bewusst getrennt vom Ticket-Workflow (services/workflow/engine.js): dort
 * geht es um die Bearbeitung einzelner Tickets, hier um Projektwissen.
 */

const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'projects');

// Grenzen bewusst konservativ: ein Transkript kann sehr lang sein, und
// lokale Modelle haben oft nur 32k Kontext.
const MAX_TOTAL_CHARS = parseInt(process.env.FLOW_SUMMARY_MAX_INPUT_CHARS, 10) || 120000;
const MAX_TRANSCRIPT_CHARS = parseInt(process.env.FLOW_SUMMARY_MAX_TRANSCRIPT_CHARS, 10) || 30000;
const MAX_FILE_CHARS = parseInt(process.env.FLOW_SUMMARY_MAX_FILE_CHARS, 10) || 20000;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.yaml', '.yml']);

const SYSTEM_PROMPT = `Du analysierst die Bestandsaufnahme eines Software-Einfuehrungsprojekts in einer Krankenhausabteilung.

Deine Aufgabe: Fasse den heutigen (Ist-)Zustand so zusammen, dass ein Berater daraus einen Ziel-Workflow ableiten kann.

Regeln:
- Antworte auf Deutsch, in reinem Text mit Markdown-Ueberschriften. Kein JSON, keine Codebloecke.
- Erfinde nichts. Nutze ausschliesslich die gelieferten Angaben.
- Wenn eine Angabe fehlt oder widerspruechlich ist, schreibe das unter "Offene Punkte" statt zu raten.
- Trenne klar zwischen Beschreibung des Ablaufs, Problemen und Adoptionsrisiken.
- Nenne bei Problemen die betroffene Rolle oder Abteilung, wenn es aus den Angaben hervorgeht.
- Halte dich kurz: hoechstens 500 Woerter.

Struktur der Antwort:

## Ausgangslage
Wer ist betroffen, welche Software wird eingefuehrt, wie ist der Stand.

## Heutiger Ablauf
Der Ist-Workflow, soweit er aus den Angaben hervorgeht. In Schritten.
Sind mehrere benannte Workflows erfasst, beschreibe jeden unter einer eigenen
Unterueberschrift (### Name des Workflows).

## Probleme im heutigen Ablauf
Die erfassten Probleme, jeweils mit Auswirkung.

## Adoptionsrisiken
Was einen Wechsel behindern koennte.

## Offene Punkte
Was in der Bestandsaufnahme fehlt oder unklar bleibt.`;

// BPMN-Diagramm des heutigen Ablaufs. Wird als zweiter, getrennter Aufruf
// hinter der Text-Zusammenfassung ausgefuehrt. Das Modell liefert nur das
// semantische Modell (inkl. Swimlanes); Diagramm-Koordinaten (DI) ergaenzt
// der Server selbst (services/atlas/bpmn.js), damit bpmn-js die Elemente
// nicht uebereinander zeichnet.
const BPMN_SYSTEM_PROMPT = `Du erstellst ein BPMN-2.0-Prozessdiagramm des heutigen (Ist-)Zustands eines Software-Einfuehrungsprojekts in einer Krankenhausabteilung.

Deine Aufgabe: Bilde den heutigen Ablauf moeglichst detailliert als gueltiges BPMN-2.0-Prozessmodell ab.

Regeln:
- Antworte NUR mit dem XML. Kein Markdown, keine Codebloecke (keine \`\`\`), kein Text davor oder danach.
- Verwende als Root <bpmn:definitions> mit id, targetNamespace und xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL".
- Lege genau einen <bpmn:process> an und genau ein Start-Ereignis (<bpmn:startEvent>).
- Zerlege den Ablauf in einzelne, konkrete Schritte und modelliere jeden als <bpmn:userTask> mit eindeutiger id und kurzem, sprechendem name-Attribut (Deutsch). Fasse verwandte Taetigkeiten nicht zu einer zusammen.
- Gib bei jeder Aktivitaet die geschaetzte Dauer an, wenn sie aus der Bestandsaufnahme hervorgeht: direkt im name in Klammern, z. B. "Probe dokumentieren (ca. 5 Min)". Ist die Dauer unbekannt, lasse sie weg statt zu raten.
- Lege in jeder Aktivitaet ein <bpmn:documentation> mit drei Zeilen an:
  - "Dauer:" die geschaetzte Dauer (z. B. "ca. 5 Min"), falls bekannt.
  - "Rolle:" die ausfuehrende Rolle.
  - "Programm:" das eingesetzte Programm/System (z. B. "Excel", "CuraFlow", "Papier"), falls es aus der Bestandsaufnahme hervorgeht. Genau ein kurzer Name, nichts dahinter.
- Verwende <bpmn:exclusiveGateway> fuer Verzweigungen, <bpmn:parallelGateway> fuer parallele Taetigkeiten und <bpmn:endEvent> fuer das Ende. Bilde Verzweigungen und Zusammenfuehrungen ab, wie sie im echten Ablauf vorkommen.
- Verbinde alle Elemente mit <bpmn:sequenceFlow> (sourceRef/targetRef) zu einem zusammenhaengenden Ablauf.
- Erstelle KEINE Diagramm-Koordinaten (kein <bpmndi:BPMNDiagram>); die Platzierung uebernimmt der Server automatisch.
- Modelliere Swimlanes: Lege im <bpmn:process> ein <bpmn:laneSet> an und darin je beteiligter Rolle/Abteilung ein <bpmn:lane> mit eindeutiger id und sprechendem name (z. B. "Arzt", "Pflege", "Verwaltung"). Ordne jede Aktivitaet und jedes Ereignis ueber <bpmn:flowNodeRef> genau einer Lane zu. Ist nur eine Rolle beteiligt, reicht eine einzelne Lane.
- Fasse die Lanes optional in einen Pool: eine <bpmn:collaboration> mit genau einem <bpmn:participant>, dessen processRef auf den Prozess zeigt.
- Keine Datenobjekte/-speicher, keine Message-Flows, keine Event-Sub-Prozesse.
- Halte das Modell detailliert, aber kompakt: hoechstens 14 Aktivitaeten/Gateways. Wenn der Ablauf laenger ist, fasse eng zusammengehoerende Schritte zu einem Schritt zusammen.
- Modelliere nur, was aus der Bestandsaufnahme belegt ist. Wenn ein Schritt unklar ist, lasse ihn weg statt ihn zu erfinden.
- Sind mehrere benannte Workflows erfasst, modelliere den umfangreichsten davon (den mit den meisten Schritten). Die uebrigen bleiben unberuecksichtigt.
- Achte auf wohlgeformtes XML: korrekt verschachtelte Elemente und geschlossene Tags.`;

// Ueberarbeitet ein BESTEHENDES Diagramm. Nur der Anpassungswunsch soll sich
// aendern; alles andere bleibt erhalten, damit der Nutzer nicht jedes Mal von
// vorn beginnt.
const BPMN_REFINE_SYSTEM_PROMPT = `Du ueberarbeitest ein bestehendes BPMN-2.0-Prozessdiagramm des heutigen (Ist-)Zustands eines Software-Einfuehrungsprojekts in einer Krankenhausabteilung.

Deine Aufgabe: Setze den Anpassungswunsch des Nutzers um und gib das vollstaendige, korrigierte Prozessmodell zurueck.

Regeln:
- Antworte NUR mit dem XML. Kein Markdown, keine Codebloecke (keine \`\`\`), kein Text davor oder danach.
- Uebernimm das vorhandene Modell: gleiche Elemente, gleiche ids, gleiche Reihenfolge und gleiche Bedeutung. Aendere nur, was der Anpassungswunsch verlangt.
- Entferne keine Schritte, es sei denn, der Anpassungswunsch verlangt es ausdruecklich. Erfinde keine neuen fachlichen Schritte.
- Bleibe bei den vorhandenen Rollen und Programmen, solange der Anpassungswunsch nichts anderes verlangt.
- Wenn der Anpassungswunsch nach klareren Swimlanes fragt: lege je Rolle/Abteilung genau eine <bpmn:lane> an, ordne jede Aktivitaet und jedes Ereignis ueber <bpmn:flowNodeRef> genau einer Lane zu, und achte darauf, dass jede Lane mindestens ein Element enthaelt. Loese Rollen nicht in mehrere Lanes derselben Rolle auf.
- Behalte die Struktur bei: genau ein <bpmn:process>, genau ein Start-Ereignis, ein zusammenhaengender Ablauf ueber <bpmn:sequenceFlow>.
- Behalte die <bpmn:documentation> je Aktivitaet bei ("Dauer:", "Rolle:", "Programm:").
- Erstelle KEINE Diagramm-Koordinaten (kein <bpmndi:BPMNDiagram>); die Platzierung uebernimmt der Server automatisch.
- Keine Datenobjekte/-speicher, keine Message-Flows, keine Event-Sub-Prozesse.
- Hoechstens 14 Aktivitaeten/Gateways.
- Achte auf wohlgeformtes XML: korrekt verschachtelte Elemente und geschlossene Tags.`;

function truncate(text, limit) {
    if (!text) return '';
    const value = String(text);
    if (value.length <= limit) return { text: value, truncated: false };
    return { text: value.slice(0, limit) + '\n\n[... gekuerzt]', truncated: true };
}

function isTextFile(attachment) {
    const mimetype = String(attachment.mimetype || '').toLowerCase();
    if (mimetype.startsWith('text/')) return true;
    if (mimetype === 'application/json') return true;
    const ext = path.extname(String(attachment.filename || attachment.original_name || '')).toLowerCase();
    return TEXT_EXTENSIONS.has(ext);
}

function readAttachmentText(attachment) {
    if (!attachment.filename) return { text: '', readable: false };
    const filePath = path.join(UPLOAD_DIR, attachment.filename);
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return { text: raw, readable: true };
    } catch (_) {
        return { text: '', readable: false };
    }
}

/**
 * Baut den User-Prompt aus den Projektangaben.
 *
 * @returns {{ text: string, stats: Object, truncated: boolean }}
 */
function buildInput({ project, workflow = null, transcripts = [], attachments = [], entries = {} }) {
    const parts = [];
    const stats = {
        transcripts: 0,
        files: attachments.length || 0,
        readableFiles: 0,
        unreadableFiles: 0,
        workflows: (entries.workflows || []).length,
        problems: (entries.problems || []).length,
        adoptionRisks: (entries.adoptionRisks || []).length,
        truncated: false,
        inputChars: 0
    };
    let budget = MAX_TOTAL_CHARS;

    // Kuerzt auf das Blocklimit und danach auf das verbleibende Gesamtbudget.
    const takeBlock = (text, limit) => {
        const clipped = truncate(text, limit);
        if (clipped.truncated) stats.truncated = true;
        if (budget <= 0) { stats.truncated = true; return ''; }
        let out = clipped.text;
        if (out.length > budget) {
            out = out.slice(0, budget) + '\n[... gekuerzt]';
            stats.truncated = true;
        }
        budget -= out.length;
        return out;
    };

    const push = (text) => {
        parts.push(text);
        budget -= text.length;
    };

    // --- Projektkopf ---
    push([
        `# Projekt: ${project.name}`,
        workflow ? `Workflow: ${workflow.name || '(ohne Namen)'}` : null,
        project.system_name ? `Software: ${project.system_name}` : null,
        project.department_name
            ? `Abteilung: ${[project.hospital_name, project.department_name].filter(Boolean).join(' / ')}`
            : null,
        project.status ? `Status: ${project.status}` : null,
        project.start_date || project.end_date
            ? `Zeitraum: ${project.start_date || '?'} bis ${project.end_date || 'offen'}`
            : null,
        project.description ? `Beschreibung: ${project.description}` : null
    ].filter(Boolean).join('\n'));

    // --- Transkripte ---
    if (transcripts.length) {
        push('\n## Transkripte aus Terminen');
        for (const meeting of transcripts) {
            if (budget <= 0) {
                stats.truncated = true;
                push('\n[... gekuerzt: weitere Transkripte]');
                break;
            }
            push(`\n### ${meeting.title} (${meeting.meeting_date}${meeting.start_time ? ', ' + meeting.start_time + ' Uhr' : ''})`);
            const body = takeBlock(meeting.transcript || '', MAX_TRANSCRIPT_CHARS);
            push(body || '(kein Inhalt)');
            stats.transcripts += 1;
        }
    }

    // --- Dokumente ---
    if (attachments.length) {
        push('\n## Dokumente');
        for (const attachment of attachments) {
            const name = attachment.original_name || attachment.filename;
            if (!isTextFile(attachment)) {
                stats.unreadableFiles += 1;
                push(`- ${name} (${attachment.mimetype || 'unbekannter Typ'}) — Inhalt nicht maschinell lesbar, nur der Dateiname ist bekannt.`);
                continue;
            }
            if (budget <= 0) {
                stats.truncated = true;
                push('[... gekuerzt: weitere Dokumente]');
                break;
            }
            const read = readAttachmentText(attachment);
            if (!read.readable) {
                stats.unreadableFiles += 1;
                push(`- ${name} — Datei nicht lesbar.`);
                continue;
            }
            push(`\n### ${name}`);
            push(takeBlock(read.text, MAX_FILE_CHARS));
            stats.readableFiles += 1;
        }
    }

    // --- Erfasste Erkenntnisse ---
    const entrySection = (title, list, formatter) => {
        if (!list.length) return;
        push(`\n## ${title}`);
        for (const item of list) {
            const origin = item.meeting_title
                ? ` (aus Termin "${item.meeting_title}")`
                : ' (direkt erfasst)';
            push(formatter(item) + origin);
        }
    };

    entrySection('Workflows (Ist-Zustand)', entries.workflows || [],
        (item) => `- ${item.name || '(ohne Namen)'}: ${item.description || item.text || '(ohne Beschreibung)'}`);
    entrySection('Probleme im heutigen Ablauf', entries.problems || [],
        (item) => `- ${item.title}${item.description ? ': ' + item.description : ''}`);
    entrySection('Adoptionsrisiken', entries.adoptionRisks || [],
        (item) => `- ${item.title}${item.description ? ': ' + item.description : ''}`);

    const text = parts.join('\n');
    stats.inputChars = text.length;
    return { text, stats, truncated: stats.truncated };
}

function buildUserPrompt(inputText) {
    return `Hier ist die Bestandsaufnahme. Fasse sie wie beschrieben zusammen.\n\n${inputText}`;
}

function buildBpmnUserPrompt(inputText) {
    return `Hier ist die Bestandsaufnahme. Erstelle daraus das BPMN-2.0-Diagramm des heutigen Ablaufs.\n\n${inputText}`;
}

/**
 * Prompt fuer die Ueberarbeitung eines vorhandenen Diagramms.
 * Die Beschreibung des Workflows geht mit, damit das Modell beim Umsetzen des
 * Wunsches die fachliche Bedeutung der Schritte nicht verliert.
 */
function buildBpmnRefineUserPrompt({ currentXml, instruction, workflowName, workflowDescription }) {
    return [
        'Hier ist das aktuelle BPMN-Diagramm.',
        workflowName ? `Workflow: ${workflowName}` : null,
        workflowDescription ? `Beschreibung des Workflows:\n${workflowDescription}` : null,
        '',
        'Aktuelles Diagramm:',
        currentXml,
        '',
        'Anpassungswunsch:',
        instruction
    ].filter((line) => line !== null).join('\n');
}

/**
 * Holt aus der LLM-Antwort das BPMN-XML heraus: entfernt Markdown-Codebloecke
 * und schneidet auf das <...definitions>-Wurzelelement zu. Gibt null zurueck,
 * wenn kein XML gefunden wurde.
 */
function extractBpmnXml(text) {
    if (!text) return null;
    let value = String(text).trim();
    value = value.replace(/^```[a-zA-Z0-9_-]*\s*/i, '').replace(/```\s*$/m, '').trim();
    const start = value.search(/<(?:[\w.-]+:)?definitions\b/i);
    if (start === -1) return null;
    const rest = value.slice(start);
    const close = rest.match(/<\/(?:[\w.-]+:)?definitions\s*>/i);
    if (!close) return null;
    const xml = rest.slice(0, close.index + close[0].length).trim();
    return xml || null;
}

module.exports = {
    SYSTEM_PROMPT,
    BPMN_SYSTEM_PROMPT,
    BPMN_REFINE_SYSTEM_PROMPT,
    buildInput,
    buildUserPrompt,
    buildBpmnUserPrompt,
    buildBpmnRefineUserPrompt,
    extractBpmnXml,
    isTextFile,
    MAX_TOTAL_CHARS,
    MAX_TRANSCRIPT_CHARS,
    MAX_FILE_CHARS
};
