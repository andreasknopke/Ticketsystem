'use strict';

/**
 * Legt das semantische BPMN-2.0-Modell aus dem LLM aus (Swimlanes, Pools,
 * orthogonale Kanten inkl. Labels) und erzeugt die Diagramm-Koordinaten (DI).
 *
 * Nutzt dafuer bpmn-auto-layout@2.x (dist-tag "next"): anders als die stabile
 * 0.4/1.x-Linie kann die 2.x-Linie Lanes und Pools auslegen und routet
 * Sequenzfluesse orthogonal (Elbows statt gerader Diagonalen). Laeuft unter
 * Node >= 18, also auch im node:20-Docker-Image.
 *
 * Referenz: bpmn-assistant (github.com/jtlicardo/bpmn-assistant) nutzt
 * bpmn-auto-layout@2.0.0-alpha.2 fuer genau diesen Layout-Schritt.
 */

const { layoutProcess } = require('bpmn-auto-layout');

// Deterministische Farbpalette fuer die Programme: ein Programm bekommt immer
// dieselbe Farbe (Hash auf den Namen), damit die Legende stabil bleibt.
const PALETTE = [
    { fill: '#dbeafe', stroke: '#2563eb' }, // blau
    { fill: '#dcfce7', stroke: '#16a34a' }, // gruen
    { fill: '#fef3c7', stroke: '#d97706' }, // amber
    { fill: '#fce7f3', stroke: '#db2777' }, // pink
    { fill: '#e0e7ff', stroke: '#4f46e5' }, // indigo
    { fill: '#ffedd5', stroke: '#ea580c' }, // orange
    { fill: '#cffafe', stroke: '#0891b2' }, // cyan
    { fill: '#f3e8ff', stroke: '#9333ea' }  // violett
];

function hashIndex(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) {
        hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return hash % PALETTE.length;
}

// Weist jedem Programm eine eindeutige Farbe zu: der Hash ist der Startpunkt,
// bei Kollision wird linear zur naechsten freien Farbe ausgewichen.
function buildColorMap(programs) {
    const map = {};
    const used = new Set();
    for (const program of programs) {
        if (map[program]) continue;
        let idx = hashIndex(program);
        while (used.has(idx)) idx = (idx + 1) % PALETTE.length;
        used.add(idx);
        map[program] = PALETTE[idx];
    }
    return map;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Liest aus der <bpmn:documentation> je Aufgabe den Programmnamen
// ("Programm: X") aus und liefert taskId -> Programm zurueck.
function extractPrograms(xml) {
    const result = {};
    const taskRe = /<(?:bpmn:)?(?:userTask|task)\b([^>]*)>([\s\S]*?)<\/(?:bpmn:)?(?:userTask|task)\s*>/gi;
    let m;
    while ((m = taskRe.exec(xml)) !== null) {
        const idMatch = (m[1] || '').match(/\bid\s*=\s*"([^"]+)"/i);
        if (!idMatch) continue;
        const progMatch = (m[2] || '').match(/Programm:\s*([^\r\n<]+)/i);
        if (!progMatch) continue;
        const program = progMatch[1].trim();
        if (program) result[idMatch[1]] = program;
    }
    return result;
}

// Faerbt die BPMNShape jeder Aufgabe anhand ihres Programms ein
// (bpmn.io-Color-Erweiterung: bioc:fill / bioc:stroke).
function injectColors(xml, programById, colorMap) {
    let out = xml;
    for (const [id, program] of Object.entries(programById)) {
        const color = colorMap[program];
        if (!color) continue;
        const shapeRe = new RegExp(
            `(<bpmndi:BPMNShape\\b[^>]*?bpmnElement="${escapeRegExp(id)}")([^>]*?)(/?)>`,
            'i'
        );
        out = out.replace(shapeRe, (match, pre, attrs, selfClose) => {
            const cleaned = attrs.replace(/\s+bioc:(?:fill|stroke)="[^"]*"/gi, '');
            return `${pre}${cleaned} bioc:fill="${color.fill}" bioc:stroke="${color.stroke}"${selfClose}>`;
        });
    }
    return out;
}

function addBiocNamespace(xml) {
    if (xml.includes('xmlns:bioc=')) return xml;
    return xml.replace(
        /(<(?:[\w.-]+:)?definitions\b[^>]*?)(>)/i,
        '$1 xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0"$2'
    );
}

async function layoutBpmnXml(xml) {
    if (!xml) return null;
    const { xml: layouted } = await layoutProcess(xml);
    // Ohne gueltigen Prozess liefert bpmn-auto-layout die Eingabe unveraendert
    // zurueck (kein BPMNDiagram). Das werten wir als Fehler.
    if (!layouted || !/<(?:[\w.-]+:)?BPMNDiagram/i.test(layouted)) {
        throw new Error('BPMN: keine Diagramm-Koordinaten erzeugt');
    }
    const programById = extractPrograms(layouted);
    const programs = Object.values(programById);
    if (programs.length === 0) return layouted;
    const colorMap = buildColorMap(programs);
    return addBiocNamespace(injectColors(layouted, programById, colorMap));
}

module.exports = { layoutBpmnXml };
