// Prueft die Detailgrad-Einstellung fuer Ist- und Soll-Ableitungen.
// Reiner Funktionstest: keine DB, kein Modellaufruf.
//
// Aufruf: node tests/detail-level-check.js

'use strict';

const detailLevel = require('../services/atlas/detailLevel');

let failures = 0;
let passed = 0;

function check(condition, message) {
    if (condition) { passed += 1; console.log(`  ✅ ${message}`); }
    else { failures += 1; console.log(`  ❌ ${message}`); }
}

console.log('\n🧪  Detailgrad\n');

check(JSON.stringify(detailLevel.DETAIL_LEVELS) === JSON.stringify(['grob', 'mittel', 'fein']),
    'drei Detailgrade sind definiert');
check(detailLevel.DETAIL_LEVEL_DEFAULT === 'mittel', 'Standard ist mittel');

check(detailLevel.normalizeDetailLevel(undefined) === 'mittel', 'undefined → mittel');
check(detailLevel.normalizeDetailLevel(null) === 'mittel', 'null → mittel');
check(detailLevel.normalizeDetailLevel('') === 'mittel', 'leer → mittel');
check(detailLevel.normalizeDetailLevel(' GROB ') === 'grob', 'Grossschreibung und Leerzeichen werden normalisiert');
check(detailLevel.normalizeDetailLevel('unbekannt') === 'mittel', 'unbekannter Wert faellt auf mittel zurueck');

check(detailLevel.resolveDetailLevel('').level === 'mittel', 'leerer Request-Wert ist Standard');
check(detailLevel.resolveDetailLevel('fein').level === 'fein', 'gueltiger Request-Wert wird uebernommen');
check(Boolean(detailLevel.resolveDetailLevel('quatsch').error), 'ungueltiger Request-Wert meldet einen Fehler');

const grob = detailLevel.getDetailLevelSpec('grob');
const mittel = detailLevel.getDetailLevelSpec('mittel');
const fein = detailLevel.getDetailLevelSpec('fein');
check(grob.maxActivities < mittel.maxActivities && mittel.maxActivities < fein.maxActivities,
    'Aktivitaetslimit steigt mit dem Detailgrad');
check(grob.maxSteps < mittel.maxSteps && mittel.maxSteps < fein.maxSteps,
    'Schrittlimit steigt mit dem Detailgrad');
check(grob.maxActivities === 6 && grob.maxSteps === 5, 'grob hat die kleinsten Limits');

check(detailLevel.buildDetailInstruction('grob', 'summary').includes('Detailgrad: Grob'),
    'Summary-Anweisung nennt den Grad');
check(detailLevel.buildDetailInstruction('grob', 'summary').includes('hoechstens 5'),
    'grobe Summary nennt das Schrittlimit');
check(detailLevel.buildDetailInstruction('grob', 'steps').includes('hoechstens 5 Schritte'),
    'grobe Soll-Schritte nennen das Limit');
check(detailLevel.buildDetailInstruction('fein', 'bpmn').includes('bis zu 20'),
    'feines Diagramm nennt das Aktivitaetslimit');
check(detailLevel.buildDetailInstruction(undefined, 'summary').includes('Detailgrad: Mittel'),
    'fehlender Grad nutzt den Standard');

// Die Kernregel gilt in JEDEM Detailgrad und fuer jede Ableitung.
check(detailLevel.NEVER_OMIT.includes('Lanes/Swimlanes'), 'Regel nennt die Lanes');
check(detailLevel.NEVER_OMIT.includes('NICHT in CuraFlow'),
    'Regel nennt Aufgaben ausserhalb von CuraFlow');
for (const level of detailLevel.DETAIL_LEVELS) {
    for (const kind of ['summary', 'steps', 'bpmn', 'vorteile']) {
        const text = detailLevel.buildDetailInstruction(level, kind);
        check(text.includes('Lanes/Swimlanes') && text.includes('NICHT in CuraFlow'),
            `${level}/${kind}: Lanes und Arbeit ausserhalb von CuraFlow bleiben Pflicht`);
    }
}
check(detailLevel.buildDetailInstruction('grob', ['steps', 'vorteile']).includes('Lanes/Swimlanes'),
    'kombinierte Bausteine tragen die Regel ebenfalls');
check(!/lasse Nebenschritte weg/.test(detailLevel.getDetailLevelSpec('grob').steps),
    'grobe Anweisung sagt nicht mehr pauschal "Nebenschritte weglassen"');
check(/ausserhalb von CuraFlow bleiben erhalten/.test(detailLevel.getDetailLevelSpec('grob').steps),
    'grobe Anweisung haelt Aufgaben ausserhalb von CuraFlow ausdruecklich');

check(detailLevel.detailLevelLabel('grob') === 'Grob', 'Label grob');
check(detailLevel.detailLevelLabel('fein') === 'Fein', 'Label fein');
check(detailLevel.detailLevelLabel(null) === '', 'alte Zeilen ohne Wert haben kein Label');
check(detailLevel.detailLevelLabel('unbekannt') === '', 'unbekannter Wert hat kein Label');

console.log(`\n  ${passed} bestanden${failures ? `, ${failures} fehlgeschlagen` : ''}\n`);
process.exit(failures > 0 ? 1 : 0);
