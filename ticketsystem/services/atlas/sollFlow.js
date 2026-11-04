'use strict';

// Prompt fuer den SOLL-Workflow.
//
// Abgrenzung: der IST-Workflow beschreibt, wie die Abteilung heute arbeitet —
// er kommt aus Terminen und Transkripten, der Funktionskatalog ist dort
// irrelevant. Der SOLL-Workflow kommt AUS dem Funktionskatalog, mit dem
// Ist-Workflow als Kontext.
//
// Die Ausgabeform ist ein Vertrag mit dem Modell. Wichtigste Eigenschaft:
// niemals eine Funktion erfinden. Ein plausibler Soll-Workflow mit erfundenen
// ids ist schlimmer als eine ehrliche Luecke — er klingt im
// Beratungsgespraech wie eine Zusage.

const { formatCatalog } = require('./catalog');
const { buildDetailInstruction } = require('./detailLevel');

const DEFAULT_SYSTEM_NAME = 'CuraFlow';

function normalizeSystemName(value) {
    const name = String(value == null ? '' : value).trim();
    return name || DEFAULT_SYSTEM_NAME;
}

/**
 * Baut den System-Prompt fuer den Soll-Workflow.
 *
 * options.systemName: Name des Zielsystems ("CuraFlow", "Schreibdienst").
 * options.hasCatalog: false fuer den Freitext-Modus — dann nennt der Prompt
 *   keine ids und keine Funktionsnamen, sondern nur die Beschreibung des
 *   Nutzers.
 *
 * SOLL_SYSTEM_PROMPT ist die Voreinstellung (CuraFlow mit Katalog).
 */
function buildSollSystemPrompt(options = {}) {
    const systemName = normalizeSystemName(options.systemName);
    const hasCatalog = options.hasCatalog !== false;

    const intro = hasCatalog
        ? `Du beschreibst den SOLL-Zustand eines Ablaufs in einer Krankenhausabteilung.
Der Ist-Zustand ist bekannt. Deine Aufgabe ist, denselben Ablauf kuenftig zu
beschreiben — mit den Funktionen aus dem mitgelieferten Funktionskatalog
(${systemName}).`
        : `Du beschreibst den SOLL-Zustand eines Ablaufs in einer Krankenhausabteilung.
Der Ist-Zustand ist bekannt. Deine Aufgabe ist, denselben Ablauf kuenftig zu
beschreiben — auf Grundlage der mitgelieferten Beschreibung des Zielzustands
(${systemName}).`;

    const funktionField = hasCatalog
        ? '"funktion": "eine id aus dem Katalog | gap | manuell",'
        : '"funktion": "manuell | gap | weglassen",';
    const vorteilFunktionField = hasCatalog
        ? '"funktion": "eine id aus dem Katalog | gap | manuell"'
        : '"funktion": "manuell | gap | weglassen"';

    const funktionRules = hasCatalog
        ? `- "funktion" ist GENAU einer dieser drei Werte:
  1. eine id aus dem mitgelieferten Funktionskatalog — zeichengenau uebernommen,
  2. "gap" — fuer Schritte, die der Katalog nicht abdeckt,
  3. "manuell" — fuer Schritte, die auch kuenftig menschliche Arbeit bleiben.
- HARTE REGEL: Erfinde niemals eine Funktion und niemals eine id. Kein Treffer
  im Katalog bedeutet "gap" mit einem Satz, was fehlt. Menschliche Arbeit
  bedeutet "manuell" mit der Rolle.
- Ein Katalogeintrag mit status "gap" ist eine bekannte Luecke und niemals eine
  verfuegbare Funktion: solche Schritte bekommen "gap".
- Nutze nur id, Bezeichnung und Aliases der Funktionen. Aussagen ueber
  Zulaessigkeit, Voraussetzungen oder technische Endpunkte sind nicht deine
  Aufgabe — beantworte "welche Funktion ersetzt diesen Schritt".`
        : `- Es gibt KEINEN Funktionskatalog. Erfinde keine Funktionen und keine ids.
- "funktion" ist "manuell", wenn der Schritt menschliche Arbeit bleibt, oder
  "gap", wenn die Beschreibung des Zielzustands ihn nicht abdeckt. Ist der
  Schritt durch die Beschreibung gedeckt, lass "funktion" weg.
- Grundlage ist allein die Beschreibung des Zielzustands aus der Aufgabe.
  Uebernimm nur, was dort steht.`;

    const vorteilFunktion = hasCatalog
        ? `Ist ein Problem im Katalog nicht abgedeckt,
  bleibt "funktion": "gap" — "jetzt" sagt dann ehrlich, dass es offen bleibt.`
        : `Ist ein Problem durch die Beschreibung nicht gedeckt,
  bleibt "funktion": "gap" — "jetzt" sagt dann ehrlich, dass es offen bleibt.`;

    return `${intro}

Antworte ausschliesslich als JSON, ohne Markdown und ohne Codeblock:
{
  "zusammenfassung": "2-4 Saetze, wie der Ablauf kuenftig aussieht",
  "schritte": [
    {
      "ist": "wie der Schritt heute ablaueft",
      "soll": "wie er kuenftig ablaueft",
      ${funktionField}
      "rolle": "wer den Schritt ausfuehrt (Berufsgruppe / Rolle)",
      "begruendung": "warum genau diese Funktion bzw. warum keine"
    }
  ],
  "vorteile": [
    {
      "problem": "das heutige Problem in einem Satz",
      "vorher": "wie es heute ablaeuft, mit dem konkreten Hindernis",
      "jetzt": "wie es mit ${systemName} ablaeuft",
      ${vorteilFunktionField}
    }
  ],
  "offene_punkte": ["was geklaert oder gebaut werden muss"]
}

Sprache: Deutsch.

Regeln:
${funktionRules}
- "ist" beschreibt weiterhin den heutigen Ablauf. Erfinde dort nichts dazu.
- HARTE REGEL: Arbeit ausserhalb von ${systemName} verschwindet nie. Jeder Schritt,
  der auch kuenftig nicht in ${systemName} stattfindet (Unterschrift, Papier,
  Telefon, Excel, Fremdsystem, Sichtkontrolle), bleibt ein eigener Schritt mit
  "funktion": "gap" oder "manuell" und einer Rolle. Das gilt auch bei grobem
  Detailgrad: dort werden nur Schritte INNERHALB von ${systemName} zusammengefasst.
- Nenne alle beteiligten Rollen bzw. Abteilungen. Eine Rolle, die im Ablauf
  vorkommt, faellt nie weg — auch wenn sie nur einen Schritt beisteuert.
- "vorteile" beantwortet: welches heutige Problem loest ${systemName}, und was
  aendert sich dadurch fuer die Nutzer. Leite jeden Vorteil aus einem im
  Ist-Zustand genannten Problem ab; nenne kein Problem, das dort nicht steht.
  "vorher" und "jetzt" beschreiben denselben Ausschnitt: erst das heutige
  Hindernis, dann der kuenftige Ablauf. Keine erfundenen Zahlen
  (Zeitersparnis, Prozentwerte). ${vorteilFunktion}
- Formuliere knapp. Keine Wiederholung der Eingabe, keine Einleitung.`;
}

const SOLL_SYSTEM_PROMPT = buildSollSystemPrompt();

function buildAnnouncedHeader(systemName) {
    return [
        `Im Folgenden steht der Funktionskatalog von ${normalizeSystemName(systemName)} zur Verfuegung.`,
        'Er listet je Funktion: id (Modul): Bezeichnung / Alias / Alias.',
        '"funktion" darf ausschliesslich diese ids enthalten, oder "gap" (Katalog deckt den Schritt nicht ab), oder "manuell" (menschliche Arbeit bleibt).'
    ].join('\n');
}

const ANNOUNCED_HEADER = buildAnnouncedHeader(DEFAULT_SYSTEM_NAME);

const MISSING_HEADER = [
    'Es ist KEIN Funktionskatalog verfuegbar. Du kennst daher keine gueltigen Funktions-ids.',
    'Regeln fuer diesen Fall:',
    '- Erfinde keine Funktionen und keine ids. Nenne keine id, die du nicht belegt hast.',
    '- Setze jeden Schritt auf "funktion": "gap" und begruende in einem Satz, was fehlt.',
    '- Bleibt ein Schritt menschliche Arbeit, setze "funktion": "manuell" und nenne die Rolle.'
].join('\n');

// Zusatzblock fuer den Freitext-Modus: der Nutzer beschreibt den Zielzustand
// selbst, es gibt keinen Katalog.
const FREITEXT_HEADER = [
    'Es ist KEIN Funktionskatalog verfuegbar. Der Nutzer beschreibt den gewuenschten Zielzustand selbst.',
    'Regeln fuer diesen Fall:',
    '- Grundlage ist ausschliesslich diese Beschreibung. Erfinde keine Funktionen und keine ids.',
    '- Schritte, die ausserhalb der neuen Software bleiben, bekommen "funktion": "manuell" oder "gap" und eine Rolle.'
].join('\n');

/**
 * Baut den User-Prompt fuer den Soll-Workflow.
 *
 * Mit Katalog: Funktionsliste wird angekuendigt, eingefuegt, dann der
 * Eingabetext. Ohne Katalog: die Abwesenheit wird ausdruecklich genannt und
 * das Erfinden von ids verboten.
 *
 * Der Eingabetext erscheint wortgleich.
 */
function buildSollBpmnSystemPrompt(options = {}) {
    const systemName = normalizeSystemName(options.systemName);
    const hasCatalog = options.hasCatalog !== false;
    const aufgabe = hasCatalog
        ? `Deine Aufgabe: Bilde den kuenftigen Ablauf mit den Funktionen aus dem mitgelieferten Funktionskatalog von ${systemName} als gueltiges BPMN-2.0-Prozessmodell ab.`
        : `Deine Aufgabe: Bilde den kuenftigen Ablauf so ab, wie ihn die Beschreibung des Zielzustands vorgibt — als gueltiges BPMN-2.0-Prozessmodell.`;
    const funktionLine = hasCatalog
        ? `  - "Funktion:" die zugeordnete Funktion von ${systemName}. Genau eine id aus dem Katalog, oder "gap" (Katalog bildet den Schritt nicht ab), oder "manuell" (menschliche Arbeit bleibt). Keine erfundenen ids.`
        : `  - "Funktion:" "manuell" (menschliche Arbeit bleibt) oder "gap" (die Beschreibung deckt den Schritt nicht ab). Erfinde keine Funktionen und keine ids.`;

    return `Du erstellst ein BPMN-2.0-Prozessdiagramm des kuenftigen (Soll-)Zustands eines Software-Einfuehrungsprojekts in einer Krankenhausabteilung.

${aufgabe}

Regeln:
- Antworte NUR mit dem XML. Kein Markdown, keine Codebloecke (keine \`\`\`), kein Text davor oder danach.
- Verwende als Root <bpmn:definitions> mit id, targetNamespace und xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL".
- Lege genau einen <bpmn:process> an und genau ein Start-Ereignis (<bpmn:startEvent>).
- Zerlege den kuenftigen Ablauf in einzelne, konkrete Schritte und modelliere jeden als <bpmn:userTask> mit eindeutiger id und kurzem, sprechendem name-Attribut (Deutsch). Fasse verwandte Taetigkeiten nicht zu einer zusammen.
- Lege in jeder Aktivitaet ein <bpmn:documentation> mit drei Zeilen an:
${funktionLine}
  - "Rolle:" die ausfuehrende Rolle.
  - "Programm:" das eingesetzte System, z. B. "${systemName}". Bei "gap" oder "manuell" das heute genutzte Programm, falls es aus der Zusammenfassung hervorgeht.
- Verwende <bpmn:exclusiveGateway> fuer Verzweigungen, <bpmn:parallelGateway> fuer parallele Taetigkeiten und <bpmn:endEvent> fuer das Ende. Bilde Verzweigungen und Zusammenfuehrungen ab, wie sie im Zielablauf vorkommen.
- Verbinde alle Elemente mit <bpmn:sequenceFlow> (sourceRef/targetRef) zu einem zusammenhaengenden Ablauf.
- Erstelle KEINE Diagramm-Koordinaten (kein <bpmndi:BPMNDiagram>); die Platzierung uebernimmt der Server automatisch.
- Modelliere Swimlanes: Lege im <bpmn:process> ein <bpmn:laneSet> an und darin je beteiligter Rolle/Abteilung ein <bpmn:lane> mit eindeutiger id und sprechendem name (z. B. "Arzt", "Pflege", "Verwaltung"). Ordne jede Aktivitaet und jedes Ereignis ueber <bpmn:flowNodeRef> genau einer Lane zu. Ist nur eine Rolle beteiligt, reicht eine einzelne Lane.
- Lanes werden nie weggelassen, auch bei grobem Detailgrad nicht: jede im Ablauf vorkommende Rolle behaelt ihre Lane, auch wenn sie nur eine Aktivitaet beisteuert.
- Arbeit ausserhalb von ${systemName} wird immer als eigene Aktivitaet modelliert (Unterschrift, Papier, Telefon, Excel, Fremdsystem, Sichtkontrolle) — mit "Funktion: gap" oder "Funktion: manuell" und dem heute genutzten Programm. Nur Aktivitaeten INNERHALB von ${systemName} duerfen zusammengefasst werden.
- Fasse die Lanes optional in einen Pool: eine <bpmn:collaboration> mit genau einem <bpmn:participant>, dessen processRef auf den Prozess zeigt.
- Keine Datenobjekte/-speicher, keine Message-Flows, keine Event-Sub-Prozesse.
- Halte dich an den Detailgrad aus der Aufgabe; er begrenzt die Zahl der Aktivitaeten/Gateways. Fasse eng zusammengehoerende Schritte innerhalb von ${systemName} zu einem Schritt zusammen, wenn du das Limit sonst ueberschreitest. Aufgaben ausserhalb von ${systemName} bleiben dabei erhalten, notfalls indem du innerhalb von ${systemName} staerker zusammenfasst.
- Modelliere nur, was aus der Zusammenfassung belegt ist. Wenn ein Schritt unklar ist, lasse ihn weg statt ihn zu erfinden.
- Achte auf wohlgeformtes XML: korrekt verschachtelte Elemente und geschlossene Tags.`;
}

const SOLL_BPMN_SYSTEM_PROMPT = buildSollBpmnSystemPrompt();

function buildSollBpmnRefineSystemPrompt(options = {}) {
    const systemName = normalizeSystemName(options.systemName);
    const hasCatalog = options.hasCatalog !== false;
    const funktionRule = hasCatalog
        ? `- "Funktion:" enthaelt weiterhin genau eine id aus dem mitgelieferten Funktionskatalog von ${systemName}, oder "gap", oder "manuell". Erfinde keine ids. Wird ein Schritt neu ergaenzt und ist im Katalog nicht abgedeckt, setze "gap" bzw. "manuell" mit der Rolle.`
        : `- "Funktion:" enthaelt weiterhin nur "manuell" oder "gap". Erfinde keine Funktionen und keine ids.`;

    return `Du ueberarbeitest ein bestehendes BPMN-2.0-Prozessdiagramm des kuenftigen (Soll-)Zustands eines Software-Einfuehrungsprojekts in einer Krankenhausabteilung.

Deine Aufgabe: Setze den Anpassungswunsch des Nutzers um und gib das vollstaendige, korrigierte Prozessmodell zurueck.

Regeln:
- Antworte NUR mit dem XML. Kein Markdown, keine Codebloecke (keine \`\`\`), kein Text davor oder danach.
- Uebernimm das vorhandene Modell: gleiche Elemente, gleiche ids, gleiche Reihenfolge und gleiche Bedeutung. Aendere nur, was der Anpassungswunsch verlangt.
- Entferne keine Schritte, es sei denn, der Anpassungswunsch verlangt es ausdruecklich. Erfinde keine neuen fachlichen Schritte.
- Lanes (beteiligte Rollen) und Schritte ausserhalb von ${systemName} bleiben immer erhalten, auch wenn der Anpassungswunsch verkuerzen soll.
- Behalte die <bpmn:documentation> je Aktivitaet bei ("Funktion:", "Rolle:", "Programm:").
${funktionRule}
- Struktur beibehalten: genau ein <bpmn:process>, genau ein Start-Ereignis, ein zusammenhaengender Ablauf ueber <bpmn:sequenceFlow>.
- Erstelle KEINE Diagramm-Koordinaten (kein <bpmndi:BPMNDiagram>); die Platzierung uebernimmt der Server automatisch.
- Keine Datenobjekte/-speicher, keine Message-Flows, keine Event-Sub-Prozesse.
- Achte auf wohlgeformtes XML: korrekt verschachtelte Elemente und geschlossene Tags.`;
}

const SOLL_BPMN_REFINE_SYSTEM_PROMPT = buildSollBpmnRefineSystemPrompt();

/**
 * Baut den User-Prompt fuer die Ueberarbeitung des Soll-Diagramms.
 * Der Katalog geht mit, damit neu ergaenzte Schritte gueltige ids bekommen.
 */
function buildSollBpmnRefineUserPrompt({ currentXml, instruction, workflowName, workflowDescription, catalog, systemName }) {
    const catalogText = formatCatalog(catalog);
    const label = normalizeSystemName(systemName);
    return [
        'Hier ist das aktuelle Soll-Diagramm.',
        workflowName ? `Workflow: ${workflowName}` : null,
        workflowDescription ? `Beschreibung des Workflows:\n${workflowDescription}` : null,
        '',
        'Aktuelles Diagramm:',
        currentXml,
        '',
        catalogText
            ? [`Verfuegbare Funktionen von ${label} (nur diese ids sind gueltig):`, catalogText].join('\n')
            : 'Es ist kein Funktionskatalog verfuegbar. Verwende nur "gap" oder "manuell".',
        '',
        'Anpassungswunsch:',
        instruction
    ].filter((line) => line !== null).join('\n');
}

/**
 * Baut den User-Prompt fuer das Soll-Diagramm: die (bereits erzeugte)
 * Soll-Zusammenfassung plus die verfuegbaren Katalog-Funktionen.
 */
function buildSollBpmnUserPrompt(sollContent, catalog, detailLevel, options = {}) {
    const text = String(sollContent == null ? '' : sollContent);
    const catalogText = formatCatalog(catalog);
    const systemName = normalizeSystemName(options && options.systemName);
    const catalogBlock = catalogText
        ? [`Verfuegbare Funktionen von ${systemName} (nur diese ids sind gueltig):`, catalogText].join('\n')
        : 'Es ist kein Funktionskatalog verfuegbar. Verwende ausschliesslich die ids aus der Zusammenfassung oder "gap"/"manuell".';
    return [
        'Hier ist der Zielzustand (Soll-Workflow).',
        '',
        text,
        '',
        catalogBlock,
        '',
        buildDetailInstruction(detailLevel, 'bpmn', { systemName }),
        '',
        'Erstelle daraus das BPMN-2.0-Diagramm des kuenftigen Ablaufs.'
    ].join('\n');
}

function describeFunktion(funktion) {
    const value = typeof funktion === 'string' ? funktion.trim() : '';
    if (!value) return '';
    if (value === 'gap') return 'CuraFlow kann das aktuell nicht abbilden';
    if (value === 'manuell') return 'bleibt manuelle Arbeit';
    return `CuraFlow-Funktion \`${value}\``;
}

const MAX_BENEFITS = 12;

/**
 * Liest die Vorteilsliste aus der Modellantwort und raeumt sie auf.
 * Liefert [] fuer unbrauchbare Eingaben; wirft nie.
 */
function normalizeBenefits(parsed) {
    try {
        let data = parsed;
        if (typeof data === 'string') {
            const trimmed = data.trim();
            if (!trimmed) return [];
            try { data = JSON.parse(trimmed); } catch (_) { return []; }
        }
        let list = [];
        if (Array.isArray(data)) list = data;
        else if (data && typeof data === 'object' && Array.isArray(data.vorteile)) list = data.vorteile;

        const benefits = [];
        list.slice(0, MAX_BENEFITS).forEach((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return;
            const problem = String(item.problem || '').trim();
            const vorher = String(item.vorher || '').trim();
            const jetzt = String(item.jetzt || '').trim();
            const funktion = typeof item.funktion === 'string' ? item.funktion.trim() : '';
            if (!problem && !vorher && !jetzt) return;
            benefits.push({
                problem: problem || vorher || jetzt,
                vorher,
                jetzt,
                funktion
            });
        });
        return benefits;
    } catch (_) {
        return [];
    }
}

/**
 * Wandelt die JSON-Antwort des Soll-Prompts in lesbaren Markdown-Text um.
 * Liefert "" fuer unbrauchbare Eingaben; wirft nie.
 */
function formatSollContent(parsed) {
    try {
        let data = parsed;
        if (typeof data === 'string') {
            const trimmed = data.trim();
            try { data = JSON.parse(trimmed); } catch (_) { return trimmed || ''; }
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return '';

        const lines = [];
        const zusammenfassung = typeof data.zusammenfassung === 'string' ? data.zusammenfassung.trim() : '';
        if (zusammenfassung) lines.push(zusammenfassung);

        const schritte = Array.isArray(data.schritte) ? data.schritte : [];
        if (schritte.length) {
            lines.push('');
            lines.push('## Kuenftiger Ablauf');
            schritte.forEach((step, index) => {
                if (!step || typeof step !== 'object') return;
                const ist = String(step.ist || '').trim();
                const soll = String(step.soll || '').trim();
                const funktion = describeFunktion(step.funktion);
                const rolle = String(step.rolle || '').trim();
                const begruendung = String(step.begruendung || '').trim();

                const title = soll || ist || `Schritt ${index + 1}`;
                lines.push(`### ${index + 1}. ${title}`);
                if (ist && ist !== title) lines.push(`- Heute: ${ist}`);
                if (soll && soll !== title) lines.push(`- Kuenftig: ${soll}`);
                if (funktion) lines.push(`- Funktion: ${funktion}`);
                if (rolle) lines.push(`- Rolle: ${rolle}`);
                if (begruendung) lines.push(`- Begruendung: ${begruendung}`);
            });
        }

        const benefits = normalizeBenefits(data);
        if (benefits.length) {
            lines.push('');
            lines.push('## Vorteile gegenueber heute');
            benefits.forEach((item, index) => {
                lines.push(`### ${index + 1}. ${item.problem}`);
                if (item.vorher) lines.push(`- Vorher: ${item.vorher}`);
                if (item.jetzt) lines.push(`- Mit CuraFlow: ${item.jetzt}`);
                const funktion = describeFunktion(item.funktion);
                if (funktion) lines.push(`- Funktion: ${funktion}`);
            });
        }

        const offenePunkte = Array.isArray(data.offene_punkte) ? data.offene_punkte : [];
        if (offenePunkte.length) {
            lines.push('');
            lines.push('## Offene Punkte');
            offenePunkte.forEach((punkt) => {
                const text = String(punkt == null ? '' : punkt).trim();
                if (text) lines.push(`- ${text}`);
            });
        }

        return lines.join('\n');
    } catch (_) {
        return '';
    }
}

function buildSollUserPrompt(inputText, catalog, detailLevel, options = {}) {
    const text = String(inputText == null ? '' : inputText);
    const catalogText = formatCatalog(catalog);
    const systemName = normalizeSystemName(options && options.systemName);
    const detail = buildDetailInstruction(detailLevel, ['steps', 'vorteile'], { systemName });

    if (!catalogText) {
        return [
            MISSING_HEADER,
            '',
            detail,
            '',
            'Bestandsaufnahme des heutigen Ablaufs:',
            text
        ].join('\n');
    }

    return [
        buildAnnouncedHeader(systemName),
        '',
        detail,
        '',
        'Funktionen:',
        catalogText,
        '',
        'Bestandsaufnahme des heutigen Ablaufs:',
        text
    ].join('\n');
}

/**
 * Baut den User-Prompt fuer den Freitext-Modus: kein Katalog, stattdessen
 * beschreibt der Nutzer selbst, wie er sich den Ablauf kuenftig vorstellt.
 * Die Beschreibung erscheint wortgleich; sie ist die einzige Quelle fuer
 * Funktionen.
 */
function buildSollFreitextUserPrompt(inputText, description, detailLevel, options = {}) {
    const text = String(inputText == null ? '' : inputText);
    const future = String(description == null ? '' : description);
    const systemName = normalizeSystemName(options && options.systemName);
    return [
        FREITEXT_HEADER,
        '',
        buildDetailInstruction(detailLevel, ['steps', 'vorteile'], { systemName }),
        '',
        'So stellt sich der Nutzer den kuenftigen Ablauf vor:',
        future,
        '',
        'Bestandsaufnahme des heutigen Ablaufs:',
        text
    ].join('\n');
}

module.exports = {
    DEFAULT_SYSTEM_NAME,
    normalizeSystemName,
    SOLL_SYSTEM_PROMPT,
    buildSollSystemPrompt,
    buildSollUserPrompt,
    buildSollFreitextUserPrompt,
    SOLL_BPMN_SYSTEM_PROMPT,
    buildSollBpmnSystemPrompt,
    buildSollBpmnUserPrompt,
    SOLL_BPMN_REFINE_SYSTEM_PROMPT,
    buildSollBpmnRefineSystemPrompt,
    buildSollBpmnRefineUserPrompt,
    normalizeBenefits,
    formatSollContent
};
