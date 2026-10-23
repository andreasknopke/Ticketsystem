// Prueft den Zusammenbau der Eingabe fuer die KI-Zusammenfassung.
// Reiner Funktionstest, kein Modellaufruf.
//
// Aufruf: node tests/flow-summary-check.js

const flowSummary = require('../services/atlas/flowSummary');

let failures = 0;
let passed = 0;

function check(condition, message) {
    if (condition) { passed += 1; console.log(`  ✅ ${message}`); }
    else { failures += 1; console.log(`  ❌ ${message}`); }
}

const project = {
    name: 'CuraFlow Radiologie',
    system_name: 'CuraFlow',
    department_name: 'Radiologie',
    hospital_name: 'Klinikum Südstadt',
    status: 'active',
    description: 'Dienstplanung einführen'
};

console.log('\n🧪  Flow-Zusammenfassung: Eingabe\n');

// --- Leere Bestandsaufnahme ---
let built = flowSummary.buildInput({ project, transcripts: [], attachments: [], entries: {} });
check(built.text.includes('CuraFlow Radiologie'), 'Projektname enthalten');
check(built.text.includes('Klinikum Südstadt / Radiologie'), 'Krankenhaus und Abteilung enthalten');
check(built.stats.transcripts === 0, 'zaehlt keine Transkripte');
check(!built.truncated, 'leere Eingabe ist nicht gekuerzt');

// --- Mit Inhalten ---
built = flowSummary.buildInput({
    project,
    transcripts: [
        { title: 'Kickoff', meeting_date: '2026-01-02', start_time: '10:00', transcript: 'Wir planen den Dienst in Excel.' }
    ],
    attachments: [
        { filename: 'a.pdf', original_name: 'Ablauf.pdf', mimetype: 'application/pdf' },
        { filename: 'fehlt.txt', original_name: 'Fehlt.txt', mimetype: 'text/plain' }
    ],
    entries: {
        workflows: [{ description: 'Excel-Liste', meeting_title: 'Kickoff' }],
        problems: [{ title: 'Formel bricht', description: 'ab 50 Zeilen', meeting_title: null }],
        adoptionRisks: [{ title: 'Keine Zeit', meeting_title: 'Kickoff' }]
    }
});

check(built.text.includes('Kickoff'), 'Termintitel enthalten');
check(built.text.includes('Wir planen den Dienst in Excel.'), 'Transkript enthalten');
check(built.text.includes('Ablauf.pdf') && built.text.includes('nicht maschinell lesbar'),
    'nicht lesbare Datei wird benannt statt stillschweigend zu fehlen');
check(built.text.includes('Fehlt.txt') && built.text.includes('nicht lesbar'),
    'fehlende Datei wird gemeldet');
check(built.stats.unreadableFiles === 2, 'zaehlt zwei nicht lesbare Dateien');
check(built.text.includes('(aus Termin "Kickoff")'), 'Herkunft aus Termin markiert');
check(built.text.includes('(direkt erfasst)'), 'Herkunft direkt erfasst markiert');
check(built.text.includes('ab 50 Zeilen'), 'Problembeschreibung enthalten');
check(built.stats.workflows === 1 && built.stats.problems === 1 && built.stats.adoptionRisks === 1,
    'zaehlt alle Wissensarten');

// --- Kuerzung respektiert das Gesamtbudget ---
const manyTranscripts = Array.from({ length: 12 }, (_, i) => ({
    title: `Termin ${i}`,
    meeting_date: '2026-02-01',
    transcript: 'x'.repeat(20000)
}));
built = flowSummary.buildInput({ project, transcripts: manyTranscripts, attachments: [], entries: {} });
check(built.text.length <= flowSummary.MAX_TOTAL_CHARS + 500,
    `Gesamtbudget eingehalten (${built.text.length} <= ${flowSummary.MAX_TOTAL_CHARS})`);
check(built.truncated, 'Kuerzung wird gemeldet');
check(built.text.includes('[... gekuerzt'), 'Kuerzungsmarker im Text');

// --- Nur Projektkopf bei leerem Input ist noch Eingabe ---
built = flowSummary.buildInput({ project, transcripts: [], attachments: [], entries: {} });
check(built.text.trim().length > 0, 'Projektkopf allein ist nicht leer');

// --- BPMN-Ausgabe ---
check(typeof flowSummary.BPMN_SYSTEM_PROMPT === 'string' && flowSummary.BPMN_SYSTEM_PROMPT.length > 0,
    'BPMN-System-Prompt vorhanden');
check(flowSummary.BPMN_SYSTEM_PROMPT.includes('Dauer') && flowSummary.BPMN_SYSTEM_PROMPT.includes('documentation'),
    'BPMN-System-Prompt fordert Dauer und documentation');
check(flowSummary.BPMN_SYSTEM_PROMPT.includes('parallelGateway'),
    'BPMN-System-Prompt erlaubt parallele Ablaeufe');
check(flowSummary.BPMN_SYSTEM_PROMPT.includes('laneSet') && flowSummary.BPMN_SYSTEM_PROMPT.includes('flowNodeRef'),
    'BPMN-System-Prompt fordert Swimlanes');
check(flowSummary.buildBpmnUserPrompt('Eingabe').includes('Eingabe'),
    'BPMN-User-Prompt enthaelt die Eingabe');

const fencedXml = '```xml\n<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d"><bpmn:process id="p"/></bpmn:definitions>\n```';
const extractedFenced = flowSummary.extractBpmnXml(fencedXml);
check(extractedFenced && extractedFenced.startsWith('<bpmn:definitions'),
    'extractBpmnXml entfernt Codeblock');

const unprefixedXml = 'Vorlauf\n<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process/></definitions>\nNachlauf';
const extractedUnprefixed = flowSummary.extractBpmnXml(unprefixedXml);
check(extractedUnprefixed && extractedUnprefixed.startsWith('<definitions'),
    'extractBpmnXml erkennt Definitions-Wurzel ohne Prefix');

check(flowSummary.extractBpmnXml('kein Diagramm') === null,
    'extractBpmnXml liefert null ohne XML');

console.log(`\n  ${passed} bestanden${failures ? `, ${failures} fehlgeschlagen` : ''}\n`);
process.exit(failures > 0 ? 1 : 0);
