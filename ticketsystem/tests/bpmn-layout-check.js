// Prueft den deterministischen BPMN-Layout-Schritt (Swimlanes + DI).
// Reiner Funktionstest, kein bpmn-js/Modellaufruf.
//
// Aufruf: node tests/bpmn-layout-check.js

const bpmn = require('../services/atlas/bpmn');

let failures = 0;
let passed = 0;

function check(condition, message) {
    if (condition) { passed += 1; console.log(`  ✅ ${message}`); }
    else { failures += 1; console.log(`  ❌ ${message}`); }
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://example.com/bpmn">
  <bpmn:collaboration id="Collab_1">
    <bpmn:participant id="Participant_1" name="Radiologie" processRef="Process_1" />
  </bpmn:collaboration>
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_Arzt" name="Arzt">
        <bpmn:flowNodeRef>StartEvent_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_1</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_Pflege" name="Pflege">
        <bpmn:flowNodeRef>Task_2</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>EndEvent_1</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="StartEvent_1" name="Anforderung" />
    <bpmn:userTask id="Task_1" name="Anordnung erfassen (ca. 5 Min)" />
    <bpmn:userTask id="Task_2" name="Durchfuehren (ca. 20 Min)" />
    <bpmn:endEvent id="EndEvent_1" name="Ende" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="Task_2" />
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Task_2" targetRef="EndEvent_1" />
  </bpmn:process>
</bpmn:definitions>`;

function boundsOf(xml, id) {
    const re = new RegExp(`bpmnElement="${id}"[^>]*>\\s*<dc:Bounds x="(\\d+)" y="(\\d+)" width="(\\d+)" height="(\\d+)"`, 's');
    const m = xml.match(re);
    return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
}

async function main() {
    console.log('\n🧪  BPMN-Layout: Swimlanes + DI\n');

    const out = await bpmn.layoutBpmnXml(SAMPLE);
    check(typeof out === 'string' && out.length > 0, 'Layout liefert XML');
    check((out.match(/<bpmndi:BPMNDiagram/g) || []).length === 1, 'genau ein BPMNDiagram');
    check(out.includes('bpmnElement="Lane_Arzt"'), 'Lane "Arzt" hat eine Shape');
    check(out.includes('bpmnElement="Lane_Pflege"'), 'Lane "Pflege" hat eine Shape');
    check(out.includes('bpmnElement="Participant_1"'), 'Pool (Participant) hat eine Shape');
    check(out.includes('bpmnElement="Task_1"') && out.includes('bpmnElement="Task_2"'), 'Tasks haben Shapes');
    check((out.match(/<bpmndi:BPMNEdge/g) || []).length === 3, 'Sequence-Flows bekommen Kanten');

    const task1 = boundsOf(out, 'Task_1');
    const task2 = boundsOf(out, 'Task_2');
    check(task1 && task2 && task1.y !== task2.y, 'Aufgaben in verschiedenen Lanes liegen auf unterschiedlichen Hoehen');
    check(task1 && task2 && task1.x < task2.x, 'Ablauf verlaeuft von links nach rechts');

    // Bestehendes DI wird ersetzt, nicht dupliziert
    const withDi = SAMPLE
        .replace('xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"',
            'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"')
        .replace('</bpmn:definitions>',
            '<bpmndi:BPMNDiagram><bpmndi:BPMNPlane id="old" bpmnElement="Process_1" /></bpmndi:BPMNDiagram></bpmn:definitions>');
    const out2 = await bpmn.layoutBpmnXml(withDi);
    check((out2.match(/<bpmndi:BPMNDiagram/g) || []).length === 1, 'vorhandenes DI wird ersetzt statt dupliziert');
    check(!out2.includes('id="old"'), 'altes DI wird entfernt');

    // Orthogonale Kanten: eine Verzweigung am Gateway bekommt einen Knick
    // (>= 3 Waypoints), statt als gerade Diagonale zu enden.
    const gateway = SAMPLE.replace(
        '<bpmn:lane id="Lane_Pflege" name="Pflege">\n        <bpmn:flowNodeRef>Task_2</bpmn:flowNodeRef>\n        <bpmn:flowNodeRef>EndEvent_1</bpmn:flowNodeRef>\n      </bpmn:lane>',
        '<bpmn:lane id="Lane_Pflege" name="Pflege">\n        <bpmn:flowNodeRef>Task_2</bpmn:flowNodeRef>\n        <bpmn:flowNodeRef>GW_1</bpmn:flowNodeRef>\n        <bpmn:flowNodeRef>EndEvent_1</bpmn:flowNodeRef>\n      </bpmn:lane>')
        .replace('<bpmn:userTask id="Task_2" name="Durchfuehren (ca. 20 Min)" />',
            '<bpmn:userTask id="Task_2" name="Durchfuehren (ca. 20 Min)" />\n    <bpmn:exclusiveGateway id="GW_1" name="dringend?" />')
        .replace('<bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="Task_2" />',
            '<bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="GW_1" />')
        .replace('<bpmn:sequenceFlow id="Flow_3" sourceRef="Task_2" targetRef="EndEvent_1" />',
            '<bpmn:sequenceFlow id="Flow_3" sourceRef="GW_1" targetRef="Task_2" />\n    <bpmn:sequenceFlow id="Flow_4" sourceRef="GW_1" targetRef="EndEvent_1" />');
    const out3 = await bpmn.layoutBpmnXml(gateway);
    const waypointCounts = [...out3.matchAll(/<bpmndi:BPMNEdge[\s\S]*?<\/bpmndi:BPMNEdge>/g)]
        .map((m) => (m[0].match(/<di:waypoint/g) || []).length);
    check(waypointCounts.some((c) => c >= 3), 'Gateway-Verzweigung wird orthogonal geroutet (>= 3 Waypoints)');

    // Kein Process -> Fehler
    let threw = false;
    try {
        await bpmn.layoutBpmnXml('<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" />');
    } catch (_) {
        threw = true;
    }
    check(threw, 'XML ohne Process wirft einen Fehler');

    // Farben: Aufgaben werden anhand ihres Programms eingefaerbt.
    const colored = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://x">
  <bpmn:process id="P" isExecutable="false">
    <bpmn:startEvent id="S" name="Start" />
    <bpmn:userTask id="T1" name="A">
      <bpmn:documentation>Dauer: ca. 5 Min
Rolle: Arzt
Programm: Excel</bpmn:documentation>
    </bpmn:userTask>
    <bpmn:userTask id="T2" name="B">
      <bpmn:documentation>Dauer: ca. 20 Min
Rolle: Pflege
Programm: CuraFlow</bpmn:documentation>
    </bpmn:userTask>
    <bpmn:endEvent id="E" name="Ende" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T1" />
    <bpmn:sequenceFlow id="F2" sourceRef="T1" targetRef="T2" />
    <bpmn:sequenceFlow id="F3" sourceRef="T2" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
    const out4 = await bpmn.layoutBpmnXml(colored);
    check(out4.includes('xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0"'),
        'bioc-Namespace wird ergaenzt');
    check((out4.match(/bioc:fill="/g) || []).length === 2,
        'beide Aufgaben bekommen eine Fuellfarbe');
    check((out4.match(/bioc:stroke="/g) || []).length === 2,
        'beide Aufgaben bekommen eine Konturfarbe');
    const fills = [...out4.matchAll(/bioc:fill="([^"]+)"/g)].map((m) => m[1]);
    check(new Set(fills).size === 2 && fills.every((f) => /^#[0-9a-f]{6}$/i.test(f)),
        'verschiedene Programme bekommen verschiedene Farben');

    console.log(`\n  ${passed} bestanden${failures ? `, ${failures} fehlgeschlagen` : ''}\n`);
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('Test-Fehler:', err.message);
    process.exit(1);
});
