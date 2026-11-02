'use strict';

/**
 * Detailgrad fuer die KI-Ableitungen im Flow-Reiter.
 *
 * Die Einstellung gilt fuer beide Richtungen: die Ist-Zusammenfassung samt
 * Ist-Diagramm und den daraus abgeleiteten Soll-Workflow samt Soll-Diagramm.
 * Ein grober Grad erzeugt weniger Schritte und ist damit leichter lesbar.
 */

const DETAIL_LEVELS = ['grob', 'mittel', 'fein'];
const DETAIL_LEVEL_DEFAULT = 'mittel';

const DETAIL_LEVEL_SPECS = {
    grob: {
        label: 'Grob',
        maxActivities: 6,
        maxSteps: 5,
        summary: 'Fasse den Ablauf in hoechstens 5 groben Schritten zusammen. '
            + 'Fasse eng verwandte Taetigkeiten zusammen und lasse Nebenschritte weg; '
            + 'weniger Schritte sind hier besser als Vollstaendigkeit.',
        steps: 'Liefere hoechstens 5 Schritte. Fasse eng verwandte Taetigkeiten zusammen '
            + 'und lasse Nebenschritte weg; weniger Schritte sind hier besser als Vollstaendigkeit.',
        vorteile: 'Nenne 2 bis 3 Vorteile. Nur Vorteile, die direkt aus einem genannten '
            + 'Problem folgen — lieber wenige belegte als viele allgemeine.',
        bpmn: 'Modelliere hoechstens 6 Aktivitaeten/Gateways. Fasse eng verwandte '
            + 'Taetigkeiten zu einem Schritt zusammen und modelliere nur Verzweigungen, '
            + 'die fuer das Verstaendnis des Ablaufs noetig sind.'
    },
    mittel: {
        label: 'Mittel',
        maxActivities: 12,
        maxSteps: 9,
        summary: 'Fasse den Ablauf in hoechstens 9 Schritten zusammen. '
            + 'Fasse Kleinschritte zusammen, halte aber alle wesentlichen Taetigkeiten fest.',
        steps: 'Liefere hoechstens 9 Schritte. Fasse Kleinschritte zusammen, '
            + 'halte aber alle wesentlichen Taetigkeiten fest.',
        vorteile: 'Nenne 3 bis 5 Vorteile, die direkt aus einem genannten Problem folgen.',
        bpmn: 'Modelliere hoechstens 12 Aktivitaeten/Gateways. Fasse Kleinschritte zusammen, '
            + 'bilde aber alle wesentlichen Taetigkeiten und Verzweigungen ab.'
    },
    fein: {
        label: 'Fein',
        maxActivities: 20,
        maxSteps: 15,
        summary: 'Beschreibe den Ablauf so detailliert wie belegt, in bis zu 15 Schritten. '
            + 'Trenne auch kleinere Taetigkeiten, wenn sie fuer die Einfuehrung wichtig sind.',
        steps: 'Liefere bis zu 15 Schritte. Trenne auch kleinere Taetigkeiten, '
            + 'wenn sie fuer die Einfuehrung wichtig sind.',
        vorteile: 'Nenne bis zu 8 Vorteile, auch kleinere Erleichterungen, '
            + 'solange sie aus einem genannten Problem folgen.',
        bpmn: 'Modelliere bis zu 20 Aktivitaeten/Gateways und trenne auch kleinere '
            + 'Taetigkeiten, wenn sie fuer die Einfuehrung wichtig sind.'
    }
};

function normalizeDetailLevel(value) {
    if (value === undefined || value === null) return DETAIL_LEVEL_DEFAULT;
    const key = String(value).trim().toLowerCase();
    return DETAIL_LEVELS.includes(key) ? key : DETAIL_LEVEL_DEFAULT;
}

/**
 * Prueft einen Request-Wert. Leer bedeutet "Standard"; ein unbekannter Wert
 * ist ein Fehler, damit Tippfehler nicht stillschweigend zum Standard werden.
 */
function resolveDetailLevel(value) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return { level: DETAIL_LEVEL_DEFAULT };
    }
    const key = String(value).trim().toLowerCase();
    if (DETAIL_LEVELS.includes(key)) return { level: key };
    return { error: `Ungueltiger Detailgrad. Erlaubt: ${DETAIL_LEVELS.join(', ')}.` };
}

function getDetailLevelSpec(value) {
    return DETAIL_LEVEL_SPECS[normalizeDetailLevel(value)];
}

/** Anzeigename fuer gespeicherte Zeilen; leer bei alten Zeilen ohne Wert. */
function detailLevelLabel(value) {
    if (value === undefined || value === null) return '';
    const key = String(value).trim().toLowerCase();
    return DETAIL_LEVEL_SPECS[key] ? DETAIL_LEVEL_SPECS[key].label : '';
}

/**
 * Baut den Prompt-Baustein fuer einen Detailgrad.
 *
 * kind: 'summary' (Ist-Zusammenfassung), 'steps' (Soll-Schritte),
 * 'vorteile' (Soll-Vorteile) oder 'bpmn' (beide Diagramme). Mehrere kinds
 * werden in einem Baustein zusammengefasst.
 */
function buildDetailInstruction(value, kind) {
    const spec = getDetailLevelSpec(value);
    const kinds = Array.isArray(kind) ? kind : [kind];
    const blocks = kinds.map((key) => spec[key]).filter(Boolean);
    return `Detailgrad: ${spec.label}.\n${blocks.join('\n')}`;
}

module.exports = {
    DETAIL_LEVELS,
    DETAIL_LEVEL_DEFAULT,
    DETAIL_LEVEL_SPECS,
    normalizeDetailLevel,
    resolveDetailLevel,
    getDetailLevelSpec,
    detailLevelLabel,
    buildDetailInstruction
};
