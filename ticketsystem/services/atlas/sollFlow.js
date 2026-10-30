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
    buildSollUserPrompt
};
