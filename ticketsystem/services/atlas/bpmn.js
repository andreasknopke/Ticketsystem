'use strict';

/**
 * Legt das semantische BPMN-2.0-Modell aus dem LLM deterministisch aus:
 * Swimlanes (Lanes) und Flow-Nodes bekommen Diagramm-Koordinaten (DI).
 *
 * bpmn-auto-layout kann Lanes/Pools nicht auslegen (v0.4.0 und v1.3.0 legen
 * nur den ersten Pool bzw. gar keine Lanes aus). Deshalb erzeugt dieses Modul
 * das DI selbst: ein einfaches, deterministisches Layer-Layout mit horizontalen
 * Lanes. Ungueltiges XML wirft einen Fehler.
 */

const BpmnModdleModule = require('bpmn-moddle');
const BpmnModdle = BpmnModdleModule.BpmnModdle || BpmnModdleModule.default || BpmnModdleModule;

const BPMNDI_NS = 'http://www.omg.org/spec/BPMN/20100524/DI';
const DC_NS = 'http://www.omg.org/spec/DD/20100524/DC';
const DI_NS = 'http://www.omg.org/spec/DD/20100524/DI';

// Layout-Konstanten (alle Werte in Pixel)
const POOL_PAD = 20;
const LANE_X = POOL_PAD;
const MARGIN_X = 30;
const COL_SPACING = 190;
const LANE_HEADER = 30;
const LANE_HEIGHT = 180;
const LANE_GAP = 12;

function nodeSize(type) {
    if (/Event$/.test(type)) return [36, 36];
    if (/Gateway$/.test(type)) return [50, 50];
    return [120, 72];
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function computeRanks(nodes, edges) {
    const ids = new Set(nodes.map((n) => n.id));
    const outgoing = {};
    const incoming = {};
    for (const n of nodes) { outgoing[n.id] = []; incoming[n.id] = []; }
    for (const e of edges) {
        if (ids.has(e.source) && ids.has(e.target)) {
            outgoing[e.source].push(e.target);
            incoming[e.target].push(e.source);
        }
    }

    const rank = {};
    const indeg = {};
    for (const n of nodes) { rank[n.id] = -1; indeg[n.id] = incoming[n.id].length; }

    const queue = nodes.filter((n) => incoming[n.id].length === 0).map((n) => n.id);
    for (const id of queue) rank[id] = 0;

    while (queue.length) {
        const id = queue.shift();
        for (const t of outgoing[id]) {
            rank[t] = Math.max(rank[t], rank[id] + 1);
            indeg[t] -= 1;
            if (indeg[t] === 0) queue.push(t);
        }
    }

    for (const n of nodes) if (rank[n.id] < 0) rank[n.id] = 0;
    return rank;
}

async function layoutBpmnXml(xml) {
    if (!xml) return null;

    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(xml);
    if (!rootElement) throw new Error('BPMN: XML konnte nicht geparst werden');

    const rootElements = rootElement.rootElements || [];
    const process = rootElements.find((el) => el.$type === 'bpmn:Process');
    if (!process) throw new Error('BPMN: kein <bpmn:process> gefunden');

    const collaboration = rootElements.find((el) => el.$type === 'bpmn:Collaboration');
    const participant = collaboration && collaboration.participants && collaboration.participants[0];

    const flowElements = process.flowElements || [];

    const lanes = [];
    for (const laneSet of process.laneSets || []) {
        for (const lane of laneSet.lanes || []) lanes.push(lane);
    }

    // nodeId -> laneId
    const laneOf = {};
    for (const lane of lanes) {
        for (const ref of lane.flowNodeRef || []) {
            if (ref && ref.id) laneOf[ref.id] = lane.id;
        }
    }

    const nodes = [];
    const edges = [];
    for (const el of flowElements) {
        if (el.$type === 'bpmn:SequenceFlow') {
            edges.push({
                id: el.id,
                source: el.sourceRef && el.sourceRef.id,
                target: el.targetRef && el.targetRef.id
            });
        } else if (el.id) {
            nodes.push({ id: el.id, type: el.$type });
        }
    }
    if (nodes.length === 0) throw new Error('BPMN: keine Flow-Nodes gefunden');

    const useLanes = lanes.length > 0;
    const laneIndex = {};
    lanes.forEach((lane, i) => { laneIndex[lane.id] = i; });

    const rank = computeRanks(nodes, edges);
    const byRank = {};
    for (const n of nodes) (byRank[rank[n.id]] = byRank[rank[n.id]] || []).push(n);
    const ranks = Object.keys(byRank).map(Number).sort((a, b) => a - b);
    const maxRank = ranks[ranks.length - 1];

    const sortNodes = (a, b) => {
        const la = useLanes ? (laneIndex[laneOf[a.id]] ?? 0) : 0;
        const lb = useLanes ? (laneIndex[laneOf[b.id]] ?? 0) : 0;
        if (la !== lb) return la - lb;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    };

    const laneTopOf = (i) => POOL_PAD + i * (LANE_HEIGHT + LANE_GAP);

    const shapes = [];
    const nodeBounds = {};
    const columnUsed = {};

    for (const r of ranks) {
        const group = byRank[r].sort(sortNodes);
        const x = LANE_X + MARGIN_X + r * COL_SPACING;
        for (const n of group) {
            const [w, h] = nodeSize(n.type);
            const li = useLanes ? (laneIndex[laneOf[n.id]] ?? 0) : 0;
            const key = li + ':' + r;
            const idx = columnUsed[key] || 0;
            columnUsed[key] = idx + 1;
            const y = laneTopOf(li) + LANE_HEADER + 12 + idx * (h + 12);
            nodeBounds[n.id] = { x, y, w, h };
            shapes.push({ id: n.id, x, y, w, h });
        }
    }

    const maxNodeW = Math.max(...nodes.map((n) => nodeSize(n.type)[0]));
    const contentWidth = MARGIN_X + maxRank * COL_SPACING + maxNodeW + MARGIN_X;
    const laneW = contentWidth;

    const poolW = LANE_X + laneW + POOL_PAD;
    const poolH = useLanes
        ? POOL_PAD + lanes.length * LANE_HEIGHT + (lanes.length - 1) * LANE_GAP + POOL_PAD
        : POOL_PAD + LANE_HEIGHT + POOL_PAD;

    // --- DI-XML aufbauen ---
    const processId = escapeXml(process.id || 'Process_1');
    let di = `<bpmndi:BPMNDiagram xmlns:bpmndi="${BPMNDI_NS}" xmlns:dc="${DC_NS}" xmlns:di="${DI_NS}" id="BPMNDiagram_${processId}">\n`;
    di += `  <bpmndi:BPMNPlane id="BPMNPlane_${processId}" bpmnElement="${processId}">\n`;

    if (participant && participant.id) {
        const pid = escapeXml(participant.id);
        di += `    <bpmndi:BPMNShape id="${pid}_di" bpmnElement="${pid}" isHorizontal="true">\n`;
        di += `      <dc:Bounds x="0" y="0" width="${poolW}" height="${poolH}" />\n`;
        di += `    </bpmndi:BPMNShape>\n`;
    }

    if (useLanes) {
        lanes.forEach((lane, i) => {
            const lid = escapeXml(lane.id || `Lane_${i + 1}`);
            di += `    <bpmndi:BPMNShape id="${lid}_di" bpmnElement="${lid}" isHorizontal="true">\n`;
            di += `      <dc:Bounds x="${LANE_X}" y="${laneTopOf(i)}" width="${laneW}" height="${LANE_HEIGHT}" />\n`;
            di += `    </bpmndi:BPMNShape>\n`;
        });
    }

    for (const s of shapes) {
        const sid = escapeXml(s.id);
        di += `    <bpmndi:BPMNShape id="${sid}_di" bpmnElement="${sid}">\n`;
        di += `      <dc:Bounds x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" />\n`;
        di += `    </bpmndi:BPMNShape>\n`;
    }

    for (const e of edges) {
        const src = nodeBounds[e.source];
        const tgt = nodeBounds[e.target];
        if (!src || !tgt) continue;
        const eid = escapeXml(e.id);
        const x1 = src.x + src.w;
        const y1 = src.y + Math.round(src.h / 2);
        const x2 = tgt.x;
        const y2 = tgt.y + Math.round(tgt.h / 2);
        di += `    <bpmndi:BPMNEdge id="${eid}_di" bpmnElement="${eid}">\n`;
        di += `      <di:waypoint x="${x1}" y="${y1}" />\n`;
        di += `      <di:waypoint x="${x2}" y="${y2}" />\n`;
        di += `    </bpmndi:BPMNEdge>\n`;
    }

    di += `  </bpmndi:BPMNPlane>\n</bpmndi:BPMNDiagram>`;

    // Vorhandenes DI entfernen und eigenes DI vor dem schliessenden definitions-Tag einfuegen.
    let out = String(xml)
        .replace(/<\s*bpmndi:BPMNDiagram[\s\S]*?<\s*\/bpmndi:BPMNDiagram\s*>/gi, '')
        .replace(/<\s*BPMNDiagram[\s\S]*?<\s*\/BPMNDiagram\s*>/gi, '');

    const close = out.match(/<\/(?:[\w.-]+:)?definitions\s*>/i);
    if (!close) throw new Error('BPMN: </definitions> nicht gefunden');
    out = out.slice(0, close.index) + '\n' + di + '\n' + out.slice(close.index);
    return out;
}

module.exports = { layoutBpmnXml };
