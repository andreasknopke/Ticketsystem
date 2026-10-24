'use strict';

/**
 * Deterministisches BPMN-Layout fuer den Flow-Reiter.
 *
 * Vertikales Layout statt horizontalem Links-nach-rechts-Ablauf: Swimlanes
 * werden zu Spalten, der Ablauf laeuft von oben nach unten. Damit hat das
 * Diagramm ein A4-Hochformat (210x297mm) statt beliebig breit zu werden, und
 * der Text bleibt beim Einpassen auf eine Seite lesbar.
 *
 * Das Modell liefert nur die Semantik (Nodes, Lanes, SequenceFlows); das DI
 * (Koordinaten, Kanten, Labels) wird hier deterministisch erzeugt. Zusaetzlich
 * werden Programme per bpmn.io-Color-Erweiterung (bioc:fill/stroke) eingefaerbt.
 */

const { BpmnModdle } = require('bpmn-moddle');

// --- Geometrie (Pixel) ---
const EVENT_W = 36, EVENT_H = 36;
const GATEWAY_W = 50, GATEWAY_H = 50;
const TASK_W = 120, TASK_H = 72;

const COL_W = 230;         // Breite einer Lane-Spalte
const LANE_HEADER = 36;    // Hoehe des Lane-Kopfs (Name)
const POOL_MARGIN = 20;
const NODE_STEP = 90;      // vertikaler Abstand zwischen uebereinanderliegenden Nodes
const ROW_PAD = 18;        // zusaetzlicher Abstand je Rang
const BOTTOM_PAD = 24;

// --- Deterministische Farbpalette fuer Programme ---
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

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nodeSize(type) {
    if (/Event$/.test(type)) return [EVENT_W, EVENT_H];
    if (/Gateway$/.test(type)) return [GATEWAY_W, GATEWAY_H];
    return [TASK_W, TASK_H];
}

function isExternalLabel(type) {
    return /(Event|Gateway)$/.test(type);
}

function computeRanks(ids, edges) {
    const outgoing = {};
    const incoming = {};
    ids.forEach((id) => { outgoing[id] = []; incoming[id] = []; });
    edges.forEach((e) => {
        if (ids.has(e.source) && ids.has(e.target)) {
            outgoing[e.source].push(e.target);
            incoming[e.target].push(e.source);
        }
    });

    const rank = {};
    const indeg = {};
    ids.forEach((id) => { rank[id] = 0; indeg[id] = incoming[id].length; });

    const queue = [];
    ids.forEach((id) => { if (indeg[id] === 0) queue.push(id); });

    let qi = 0;
    while (qi < queue.length) {
        const id = queue[qi];
        qi += 1;
        outgoing[id].forEach((t) => {
            rank[t] = Math.max(rank[t], rank[id] + 1);
            indeg[t] -= 1;
            if (indeg[t] === 0) queue.push(t);
        });
    }
    return rank;
}

async function parseBpmn(xml) {
    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(xml);
    if (!rootElement) throw new Error('BPMN: XML konnte nicht geparst werden');
    const rootElements = rootElement.rootElements || [];
    const process = rootElements.find((e) => e.$type === 'bpmn:Process');
    if (!process) throw new Error('BPMN: kein <bpmn:process> gefunden');

    const collaboration = rootElements.find((e) => e.$type === 'bpmn:Collaboration');
    const participant = collaboration && collaboration.participants && collaboration.participants[0];

    const lanes = [];
    for (const laneSet of process.laneSets || []) {
        for (const lane of laneSet.lanes || []) lanes.push(lane);
    }

    const laneOf = {};
    lanes.forEach((lane, i) => {
        for (const ref of lane.flowNodeRef || []) {
            if (ref && ref.id) laneOf[ref.id] = i;
        }
    });

    const nodes = [];
    const edges = [];
    for (const el of process.flowElements || []) {
        if (el.$type === 'bpmn:SequenceFlow') {
            edges.push({
                id: el.id,
                name: el.name,
                source: el.sourceRef && el.sourceRef.id,
                target: el.targetRef && el.targetRef.id
            });
        } else if (el.id) {
            nodes.push({ id: el.id, type: el.$type, name: el.name });
        }
    }
    if (nodes.length === 0) throw new Error('BPMN: keine Flow-Nodes gefunden');
    return { process, collaboration, participant, lanes, laneOf, nodes, edges };
}

function routeEdge(src, tgt) {
    const sx = Math.round(src.x + src.w / 2);
    const sy = Math.round(src.y + src.h);
    const tx = Math.round(tgt.x + tgt.w / 2);
    const ty = Math.round(tgt.y);

    if (ty > sy) {
        if (Math.abs(tx - sx) <= 1) return [[sx, sy], [tx, ty]];
        const midY = Math.round((sy + ty) / 2);
        return [[sx, sy], [sx, midY], [tx, midY], [tx, ty]];
    }
    const railX = Math.round(Math.max(sx, tx)) + 30;
    return [[sx, sy], [railX, sy], [railX, ty], [tx, ty]];
}

function buildDiagramXml(model, ranks) {
    const { process, collaboration, participant, lanes, laneOf, nodes, edges } = model;

    const laneCount = lanes.length > 0 ? lanes.length : 1;

    const cell = {};
    for (const n of nodes) {
        const lane = lanes.length > 0 ? (laneOf[n.id] !== undefined ? laneOf[n.id] : 0) : 0;
        const key = lane + ':' + ranks[n.id];
        (cell[key] = cell[key] || []).push(n);
    }

    const maxRank = nodes.reduce((m, n) => Math.max(m, ranks[n.id]), 0);
    const rowHeights = [];
    for (let r = 0; r <= maxRank; r += 1) {
        let maxStack = 1;
        for (let l = 0; l < laneCount; l += 1) {
            maxStack = Math.max(maxStack, (cell[l + ':' + r] || []).length);
        }
        rowHeights.push(maxStack * NODE_STEP + ROW_PAD);
    }

    const contentTop = POOL_MARGIN + LANE_HEADER;
    const contentHeight = rowHeights.reduce((a, b) => a + b, 0) + BOTTOM_PAD;
    const totalW = POOL_MARGIN * 2 + laneCount * COL_W;
    const totalH = contentTop + contentHeight + POOL_MARGIN;

    const nodePos = {};
    const cellStack = {};
    for (const n of nodes) {
        const lane = lanes.length > 0 ? (laneOf[n.id] !== undefined ? laneOf[n.id] : 0) : 0;
        const r = ranks[n.id];
        const [w, h] = nodeSize(n.type);
        const key = lane + ':' + r;
        const idx = cellStack[key] || 0;
        cellStack[key] = idx + 1;
        const stackCount = (cell[key] || []).length;

        let rowY = contentTop;
        for (let k = 0; k < r; k += 1) rowY += rowHeights[k];

        const x = POOL_MARGIN + lane * COL_W + Math.round((COL_W - w) / 2);
        const y = rowY + Math.round((rowHeights[r] - stackCount * NODE_STEP) / 2)
            + idx * NODE_STEP + Math.round((NODE_STEP - h) / 2);
        nodePos[n.id] = { x, y, w, h, lane, rank: r };
    }

    const planeElement = collaboration ? collaboration.id : process.id;

    let di = '';
    di += `  <bpmndi:BPMNDiagram id="BPMNDiagram_${escapeXml(process.id)}">\n`;
    di += `    <bpmndi:BPMNPlane id="BPMNPlane_${escapeXml(planeElement)}" bpmnElement="${escapeXml(planeElement)}">\n`;

    if (participant && participant.id) {
        di += `      <bpmndi:BPMNShape id="${escapeXml(participant.id)}_di" bpmnElement="${escapeXml(participant.id)}" isHorizontal="false">\n`;
        di += `        <dc:Bounds x="0" y="0" width="${totalW}" height="${totalH}" />\n`;
        di += `      </bpmndi:BPMNShape>\n`;
    }

    lanes.forEach((lane, i) => {
        const laneH = LANE_HEADER + contentHeight;
        di += `      <bpmndi:BPMNShape id="${escapeXml(lane.id)}_di" bpmnElement="${escapeXml(lane.id)}" isHorizontal="false">\n`;
        di += `        <dc:Bounds x="${POOL_MARGIN + i * COL_W}" y="${POOL_MARGIN}" width="${COL_W}" height="${laneH}" />\n`;
        di += `      </bpmndi:BPMNShape>\n`;
    });

    for (const n of nodes) {
        const p = nodePos[n.id];
        di += `      <bpmndi:BPMNShape id="${escapeXml(n.id)}_di" bpmnElement="${escapeXml(n.id)}">\n`;
        di += `        <dc:Bounds x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" />\n`;
        if (isExternalLabel(n.type) && n.name) {
            const lw = Math.min(130, Math.max(40, n.name.length * 7 + 12));
            const lx = p.x + p.w + 4;
            const ly = Math.round(p.y + p.h / 2 - 7);
            di += `        <bpmndi:BPMNLabel><dc:Bounds x="${lx}" y="${ly}" width="${lw}" height="14" /></bpmndi:BPMNLabel>\n`;
        }
        di += `      </bpmndi:BPMNShape>\n`;
    }

    for (const e of edges) {
        const src = nodePos[e.source];
        const tgt = nodePos[e.target];
        if (!src || !tgt) continue;
        const wps = routeEdge(src, tgt);
        di += `      <bpmndi:BPMNEdge id="${escapeXml(e.id)}_di" bpmnElement="${escapeXml(e.id)}">\n`;
        for (const [x, y] of wps) di += `        <di:waypoint x="${x}" y="${y}" />\n`;
        di += `      </bpmndi:BPMNEdge>\n`;
    }

    di += `    </bpmndi:BPMNPlane>\n`;
    di += `  </bpmndi:BPMNDiagram>`;
    return di;
}

// Liest aus der <bpmn:documentation> je Aufgabe den Programmnamen
// ("Programm: X") aus und liefert taskId -> Programm zurueck.
function extractPrograms(xml) {
    const result = {};
    const taskRe = /<(?:bpmn:)?(?:userTask|task|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask)\b([^>]*)>([\s\S]*?)<\/(?:bpmn:)?(?:userTask|task|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask)\s*>/gi;
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
    const model = await parseBpmn(xml);
    const ids = new Set(model.nodes.map((n) => n.id));
    const ranks = computeRanks(ids, model.edges);

    const diagram = buildDiagramXml(model, ranks);
    const namespaced = diagram.replace(
        '<bpmndi:BPMNDiagram',
        '<bpmndi:BPMNDiagram xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI"'
    );

    let out = String(xml)
        .replace(/<\s*bpmndi:BPMNDiagram[\s\S]*?<\s*\/bpmndi:BPMNDiagram\s*>/gi, '')
        .replace(/<\s*BPMNDiagram[\s\S]*?<\s*\/BPMNDiagram\s*>/gi, '');

    const close = out.match(/<\/(?:[\w.-]+:)?definitions\s*>/i);
    if (!close) throw new Error('BPMN: </definitions> nicht gefunden');
    out = out.slice(0, close.index) + '\n' + namespaced + '\n' + out.slice(close.index);

    const programById = extractPrograms(out);
    const programs = Object.values(programById);
    if (programs.length > 0) {
        out = addBiocNamespace(injectColors(out, programById, buildColorMap(programs)));
    }
    return out;
}

module.exports = { layoutBpmnXml };