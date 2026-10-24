// Prueft das deterministische BPMN-Layout (vertikal: Lanes als Spalten,
// Ablauf von oben nach unten) plus Farbinjektion.
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

function edgeWaypoints(xml) {
    return [...xml.matchAll(/<bpmndi:BPMNEdge[\s\S]*?<\/bpmndi:BPMNEdge>/g)]
        .map((m) => (m[0].match(/<di:waypoint/g) || []).length);
}

async function main() {
    console.log('\n🧪  BPMN-Layout: vertikal (A4) + Swimlanes + Farben\n');

    const out = await bpmn.layoutBpmnXml(SAMPLE);
    check(typeof out === 'string' && out.length > 0, 'Layout liefert XML');
    check((out.match(/<bpmndi:BPMNDiagram/g) || []).length === 1, 'genau ein BPMNDiagram');
    check(out.includes('bpmnElement="Lane_Arzt"'), 'Lane "Arzt" hat eine Shape');
    check(out.includes('bpmnElement="Lane_Pflege"'), 'Lane "Pflege" hat eine Shape');
    check(out.includes('bpmnElement="Participant_1"'), 'Pool (Participant) hat eine Shape');
    check(out.includes('isHorizontal="false"'), 'Lanes/Pool sind vertikal (isHorizontal=false)');

    // Lanes als Spalten: gleiche Hoehe (y), unterschiedliche x
    const laneArzt = boundsOf(out, 'Lane_Arzt');
    const lanePflege = boundsOf(out, 'Lane_Pflege');
    check(laneArzt && lanePflege && laneArzt.x < lanePflege.x && laneArzt.y === lanePflege.y,
        'Lanes liegen nebeneinander als Spalten');

    // Ablauf von oben nach unten: Task_1 (Rang 1) ueber Task_2 (Rang 2)
    const task1 = boundsOf(out, 'Task_1');
    const task2 = boundsOf(out, 'Task_2');
    check(task1 && task2 && task1.y < task2.y, 'Ablauf laeuft von oben nach unten');

    check((out.match(/<bpmndi:BPMNEdge/g) || []).length === 3, 'Sequence-Flows bekommen Kanten');

    // Teilnehmer-Pool ist hoeher als breit (A4-Hochformat)
    const pool = boundsOf(out, 'Participant_1');
    check(pool && pool.h > pool.w, 'Diagramm ist hoeher als breit (A4-Hochformat)');

    // Bestehendes DI wird ersetzt, nicht dupliziert
    const withDi = SAMPLE
        .replace('xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"',
            'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"')
        .replace('</bpmn:definitions>',
            '<bpmndi:BPMNDiagram><bpmndi:BPMNPlane id="old" bpmnElement="Process_1" /></bpmndi:BPMNDiagram></bpmn:definitions>');
    const out2 = await bpmn.layoutBpmnXml(withDi);
    check((out2.match(/<bpmndi:BPMNDiagram/g) || []).length === 1, 'vorhandenes DI wird ersetzt statt dupliziert');
    check(!out2.includes('id="old"'), 'altes DI wird entfernt');

    // Gateway-Verzweigung ueber Lanes hinweg wird orthogonal geroutet (>= 3 Waypoints)
    const gateway = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://x">
  <bpmn:process id="P" isExecutable="false">
    <bpmn:laneSet id="LS">
      <bpmn:lane id="LA" name="Arzt"><bpmn:flowNodeRef>S</bpmn:flowNodeRef><bpmn:flowNodeRef>T1</bpmn:flowNodeRef><bpmn:flowNodeRef>G</bpmn:flowNodeRef></bpmn:lane>
      <bpmn:lane id="LB" name="Pflege"><bpmn:flowNodeRef>T2</bpmn:flowNodeRef><bpmn:flowNodeRef>E</bpmn:flowNodeRef></bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="S" name="Start" />
    <bpmn:userTask id="T1" name="A" />
    <bpmn:exclusiveGateway id="G" name="dringend?" />
    <bpmn:userTask id="T2" name="B" />
    <bpmn:endEvent id="E" name="Ende" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T1" />
    <bpmn:sequenceFlow id="F2" sourceRef="T1" targetRef="G" />
    <bpmn:sequenceFlow id="F3" sourceRef="G" targetRef="T2" name="ja" />
    <bpmn:sequenceFlow id="F4" sourceRef="G" targetRef="E" name="nein" />
    <bpmn:sequenceFlow id="F5" sourceRef="T2" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
    const out3 = await bpmn.layoutBpmnXml(gateway);
    const wps = edgeWaypoints(out3);
    check(wps.some((c) => c >= 3), 'Gateway-Verzweigung wird orthogonal geroutet (>= 3 Waypoints)');

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
    check((out4.match(/bioc:fill="/g) || []).length === 2, 'beide Aufgaben bekommen eine Fuellfarbe');
    check((out4.match(/bioc:stroke="/g) || []).length === 2, 'beide Aufgaben bekommen eine Konturfarbe');
    const fills = [...out4.matchAll(/bioc:fill="([^"]+)"/g)].map((m) => m[1]);
    check(new Set(fills).size === 2 && fills.every((f) => /^#[0-9a-f]{6}$/i.test(f)),
        'verschiedene Programme bekommen verschiedene Farben');

    // Kein Process -> Fehler
    let threw = false;
    try {
        await bpmn.layoutBpmnXml('<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" />');
    } catch (_) {
        threw = true;
    }
    check(threw, 'XML ohne Process wirft einen Fehler');

    console.log(`\n  ${passed} bestanden${failures ? `, ${failures} fehlgeschlagen` : ''}\n`);
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('Test-Fehler:', err.message);
    process.exit(1);
});