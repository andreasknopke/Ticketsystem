'use strict';

/**
 * Normalisiert BPMN-2.0-XML aus dem LLM: ergaenzt fehlende Diagramm-Koordinaten
 * (BPMNDiagram / DI) per bpmn-auto-layout, damit bpmn-js die Elemente nicht
 * uebereinander zeichnet. Ungueltiges XML wirft einen Fehler.
 */

let _layoutProcess;

async function loadLayoutProcess() {
    if (_layoutProcess) return _layoutProcess;
    let mod;
    try {
        // CJS-Build (dist/index.cjs) - laeuft auch unter Node 20 im Docker-Image.
        mod = require('bpmn-auto-layout');
    } catch (_) {
        mod = await import('bpmn-auto-layout');
    }
    _layoutProcess = (mod && (mod.layoutProcess || mod.default)) || mod;
    if (typeof _layoutProcess !== 'function') {
        throw new Error('bpmn-auto-layout konnte nicht geladen werden');
    }
    return _layoutProcess;
}

async function normalizeBpmnXml(xml) {
    if (!xml) return null;
    const layoutProcess = await loadLayoutProcess();
    const result = await layoutProcess(xml);
    // bpmn-auto-layout 0.4.x liefert direkt einen String,
    // neuere Versionen liefern { xml, warnings }.
    const normalized = typeof result === 'string' ? result : (result && result.xml);
    return normalized || xml;
}

module.exports = { normalizeBpmnXml };
