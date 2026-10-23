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

async function layoutBpmnXml(xml) {
    if (!xml) return null;
    const { xml: layouted } = await layoutProcess(xml);
    // Ohne gueltigen Prozess liefert bpmn-auto-layout die Eingabe unveraendert
    // zurueck (kein BPMNDiagram). Das werten wir als Fehler.
    if (!layouted || !/<(?:[\w.-]+:)?BPMNDiagram/i.test(layouted)) {
        throw new Error('BPMN: keine Diagramm-Koordinaten erzeugt');
    }
    return layouted;
}

module.exports = { layoutBpmnXml };
