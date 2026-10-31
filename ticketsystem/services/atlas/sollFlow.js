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

const SOLL_SYSTEM_PROMPT = `Du beschreibst den SOLL-Zustand eines Ablaufs in einer Krankenhausabteilung.
Der Ist-Zustand ist bekannt. Deine Aufgabe ist, denselben Ablauf kuenftig zu
beschreiben — mit den Funktionen aus dem mitgelieferten Funktionskatalog.

Antworte ausschliesslich als JSON, ohne Markdown und ohne Codeblock:
{
  "zusammenfassung": "2-4 Saetze, wie der Ablauf kuenftig aussieht",
  "schritte": [
    {
      "ist": "wie der Schritt heute ablaueft",
      "soll": "wie er kuenftig ablaueft",
      "funktion": "eine id aus dem Katalog | gap | manuell",
      "rolle": "wer den Schritt ausfuehrt (Berufsgruppe / Rolle)",
      "begruendung": "warum genau diese Funktion bzw. warum keine"
    }
  ],
  "offene_punkte": ["was geklaert oder gebaut werden muss"]
}

Sprache: Deutsch.

Regeln:
- "funktion" ist GENAU einer dieser drei Werte:
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
  Aufgabe — beantworte "welche Funktion ersetzt diesen Schritt".
- "ist" beschreibt weiterhin den heutigen Ablauf. Erfinde dort nichts dazu.
- Formuliere knapp. Keine Wiederholung der Eingabe, keine Einleitung.`;

const ANNOUNCED_HEADER = [
    'Im Folgenden steht der Funktionskatalog von CuraFlow zur Verfuegung.',
    'Er listet je Funktion: id (Modul): Bezeichnung / Alias / Alias.',
    '"funktion" darf ausschliesslich diese ids enthalten, oder "gap" (Katalog deckt den Schritt nicht ab), oder "manuell" (menschliche Arbeit bleibt).'
].join('\n');

const MISSING_HEADER = [
    'Es ist KEIN Funktionskatalog verfuegbar. Du kennst daher keine gueltigen Funktions-ids.',
    'Regeln fuer diesen Fall:',
    '- Erfinde keine Funktionen und keine ids. Nenne keine id, die du nicht belegt hast.',
    '- Setze jeden Schritt auf "funktion": "gap" und begruende in einem Satz, was fehlt.',
    '- Bleibt ein Schritt menschliche Arbeit, setze "funktion": "manuell" und nenne die Rolle.'
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
const SOLL_BPMN_SYSTEM_PROMPT = `Du erstellst ein BPMN-2.0-Prozessdiagramm des kuenftigen (Soll-)Zustands eines Software-Einfuehrungsprojekts in einer Krankenhausabteilung.

Deine Aufgabe: Bilde den kuenftigen Ablauf mit den Funktionen aus dem mitgelieferten CuraFlow-Funktionskatalog als gueltiges BPMN-2.0-Prozessmodell ab.

Regeln:
- Antworte NUR mit dem XML. Kein Markdown, keine Codebloecke (keine \`\`\`), kein Text davor oder danach.
- Verwende als Root <bpmn:definitions> mit id, targetNamespace und xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL".
- Lege genau einen <bpmn:process> an und genau ein Start-Ereignis (<bpmn:startEvent>).
- Zerlege den kuenftigen Ablauf in einzelne, konkrete Schritte und modelliere jeden als <bpmn:userTask> mit eindeutiger id und kurzem, sprechendem name-Attribut (Deutsch). Fasse verwandte Taetigkeiten nicht zu einer zusammen.
- Lege in jeder Aktivitaet ein <bpmn:documentation> mit drei Zeilen an:
  - "Funktion:" die zugeordnete CuraFlow-Funktion. Genau eine id aus dem Katalog, oder "gap" (Katalog bildet den Schritt nicht ab), oder "manuell" (menschliche Arbeit bleibt). Keine erfundenen ids.
  - "Rolle:" die ausfuehrende Rolle.
  - "Programm:" das eingesetzte System, z. B. "CuraFlow". Bei "gap" oder "manuell" das heute genutzte Programm, falls es aus der Zusammenfassung hervorgeht.
- Verwende <bpmn:exclusiveGateway> fuer Verzweigungen, <bpmn:parallelGateway> fuer parallele Taetigkeiten und <bpmn:endEvent> fuer das Ende. Bilde Verzweigungen und Zusammenfuehrungen ab, wie sie im Zielablauf vorkommen.
- Verbinde alle Elemente mit <bpmn:sequenceFlow> (sourceRef/targetRef) zu einem zusammenhaengenden Ablauf.
- Erstelle KEINE Diagramm-Koordinaten (kein <bpmndi:BPMNDiagram>); die Platzierung uebernimmt der Server automatisch.
- Modelliere Swimlanes: Lege im <bpmn:process> ein <bpmn:laneSet> an und darin je beteiligter Rolle/Abteilung ein <bpmn:lane> mit eindeutiger id und sprechendem name (z. B. "Arzt", "Pflege", "Verwaltung"). Ordne jede Aktivitaet und jedes Ereignis ueber <bpmn:flowNodeRef> genau einer Lane zu. Ist nur eine Rolle beteiligt, reicht eine einzelne Lane.
- Fasse die Lanes optional in einen Pool: eine <bpmn:collaboration> mit genau einem <bpmn:participant>, dessen processRef auf den Prozess zeigt.
- Keine Datenobjekte/-speicher, keine Message-Flows, keine Event-Sub-Prozesse.
- Halte das Modell detailliert, aber kompakt: hoechstens 14 Aktivitaeten/Gateways.
- Modelliere nur, was aus der Zusammenfassung belegt ist. Wenn ein Schritt unklar ist, lasse ihn weg statt ihn zu erfinden.
- Achte auf wohlgeformtes XML: korrekt verschachtelte Elemente und geschlossene Tags.`;

/**
 * Baut den User-Prompt fuer das Soll-Diagramm: die (bereits erzeugte)
 * Soll-Zusammenfassung plus die verfuegbaren Katalog-Funktionen.
 */
function buildSollBpmnUserPrompt(sollContent, catalog) {
    const text = String(sollContent == null ? '' : sollContent);
    const catalogText = formatCatalog(catalog);
    const catalogBlock = catalogText
        ? ['Verfuegbare CuraFlow-Funktionen (nur diese ids sind gueltig):', catalogText].join('\n')
        : 'Es ist kein Funktionskatalog verfuegbar. Verwende ausschliesslich die ids aus der Zusammenfassung oder "gap"/"manuell".';
    return [
        'Hier ist der Zielzustand (Soll-Workflow).',
        '',
        text,
        '',
        catalogBlock,
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

function buildSollUserPrompt(inputText, catalog) {
    const text = String(inputText == null ? '' : inputText);
    const catalogText = formatCatalog(catalog);

    if (!catalogText) {
        return [
            MISSING_HEADER,
            '',
            'Bestandsaufnahme des heutigen Ablaufs:',
            text
        ].join('\n');
    }

    return [
        ANNOUNCED_HEADER,
        '',
        'Funktionen:',
        catalogText,
        '',
        'Bestandsaufnahme des heutigen Ablaufs:',
        text
    ].join('\n');
}

module.exports = {
    SOLL_SYSTEM_PROMPT,
    buildSollUserPrompt,
    SOLL_BPMN_SYSTEM_PROMPT,
    buildSollBpmnUserPrompt,
    formatSollContent
};
