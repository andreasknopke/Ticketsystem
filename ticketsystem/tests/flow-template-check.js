// Prueft das Rendern der Flow-Seite mit je einem Workflow und einer
// Workflow-Karte. Reiner Template-Test: kein Server, keine KI, keine DB.
//
// Aufruf: node tests/flow-template-check.js

const ejs = require('ejs');
const path = require('path');
const vm = require('vm');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'project-flow.ejs');

let failures = 0;
let passed = 0;

function check(condition, message) {
    if (condition) { passed += 1; console.log(`  ✅ ${message}`); }
    else { failures += 1; console.log(`  ❌ ${message}`); }
}

const summary = {
    id: 9,
    content: '## Ausgangslage\nDer Ablauf ist heute manuell.',
    bpmn_xml: '<bpmn:definitions isHorizontal="true"><bpmn:process id="p"/></bpmn:definitions>',
    provider: 'test',
    model: 'test-model',
    created_at: '2026-10-01 10:00',
    input_chars: 120,
    prompt_tokens: 10,
    completion_tokens: 20,
    refinements: [
        {
            id: 1, summary_id: 9, instruction: 'Swimlanes klarer trennen',
            created_at: '2026-10-02 09:00', created_by: 'admin', model: 'test-model'
        }
    ]
};

const workflowGroup = {
    key: 'wf-1',
    workflow: {
        id: 1, name: 'Entlassungsbrief',
        text: 'Arzt diktiert, Pflege prueft', meeting_title: 'Kickoff'
    },
    title: 'Entlassungsbrief',
    problems: [{ id: 1, text: 'Formel bricht', description: 'ab 50 Zeilen', meeting_title: '', workflow_id: 1 }],
    adoptionRisks: [{ id: 2, text: 'Keine Zeit', description: '', meeting_title: 'Kickoff', workflow_id: 1 }],
    inputFiles: [{ id: 3, filename: 'a.pdf', original_name: 'Ablauf.pdf', size: 2048, created_by: 'admin' }],
    outputFiles: [{ id: 4, filename: 'b.png', original_name: 'Ziel.png', size: 4096, created_by: 'admin' }],
    summaries: [summary],
    sollFlows: [],
    isFirst: true
};

const unassignedGroup = {
    key: 'unassigned',
    workflow: null,
    title: 'Ohne Workflow',
    problems: [{ id: 5, text: 'Nicht zugeordnet', description: '', meeting_title: '', workflow_id: null }],
    adoptionRisks: [],
    inputFiles: [],
    outputFiles: [],
    summaries: [],
    sollFlows: [],
    hasData: true,
    hasWorkflows: true
};

const baseLocals = {
    project: {
        id: 1, name: 'CuraFlow', system_name: 'CuraFlow',
        department_name: 'Radiologie', hospital_name: 'Klinikum Südstadt'
    },
    user: 'admin',
    role: 'admin',
    canManage: true,
    csrfToken: 'token',
    workflows: [workflowGroup.workflow],
    workflowGroups: [workflowGroup],
    unassigned: unassignedGroup,
    hasWorkflows: true,
    bpmnDiagrams: [{ key: 'wf-1', summaryId: 9, xml: summary.bpmn_xml }],
    sollBpmnDiagrams: [],
    aiStaff: [{ id: 1, name: 'Planer', ai_model: 'test-model' }],
    formatDateTime: (value) => String(value),
    toTitle: (value) => String(value),
    formatRelativeTime: (value) => String(value)
};

function render(locals) {
    return new Promise((resolve, reject) => {
        ejs.renderFile(TEMPLATE, locals, {}, (err, html) => err ? reject(err) : resolve(html));
    });
}

async function main() {
    console.log('\n🧪  Flow-Seite: Rendern\n');

    let html;
    try {
        html = await render(baseLocals);
    } catch (err) {
        console.error('RENDER-FEHLER:', err.message);
        process.exit(1);
    }

    check(html.includes('data-flow-group="wf-1"'), 'Workflow-Karte wird gerendert');
    check(html.includes('data-workflow-id="1"'), 'Karte traegt die workflow_id');
    check(html.includes('Workflow-Beschreibung'), 'Abschnitt Beschreibung vorhanden');
    check(html.includes('Formel bricht'), 'Problem des Workflows erscheint');
    check(html.includes('Keine Zeit'), 'Adoptionsrisiko des Workflows erscheint');
    check(html.includes('Ablauf.pdf'), 'Input-Dokument erscheint');
    check(html.includes('Ziel.png'), 'Output-Dokument erscheint');
    check(html.includes('data-bpmn-canvas'), 'Diagramm-Container vorhanden');
    check(html.includes('data-flow-group="unassigned"'), 'Karte "Ohne Workflow" erscheint');
    check(html.includes('Nicht zugeordnet'), 'Nicht zugeordnetes Problem bleibt sichtbar');

    // Feinjustierung des Diagramms
    check(html.includes('<form class="bpmn-refine-form'), 'Formular zum Ueberarbeiten vorhanden');
    check(html.includes('data-summary-id="9"'), 'Formular kennt die Zusammenfassung');
    check(html.includes('name="instruction"'), 'Eingabefeld fuer den Anpassungswunsch');
    check(html.includes('data-orientation="landscape"'), 'Ausrichtung wird uebernommen');
    check(html.includes('Bisherige Anpassungen (1)'), 'Anpassungsverlauf wird angezeigt');
    check(html.includes('Swimlanes klarer trennen'), 'Anpassungswunsch erscheint im Verlauf');

    // Ohne Diagramm gibt es kein Ueberarbeiten-Formular.
    const withoutDiagram = {
        ...baseLocals,
        workflowGroups: [{
            ...workflowGroup,
            summaries: [{ ...summary, bpmn_xml: null, refinements: [] }]
        }],
        bpmnDiagrams: []
    };
    html = await render(withoutDiagram);
    check(!html.includes('<form class="bpmn-refine-form'), 'ohne Diagramm kein Ueberarbeiten-Formular');
    check(html.includes('Die letzte Zusammenfassung enthielt kein Diagramm.'),
        'Hinweis auf fehlendes Diagramm');

    // BPMN-XML darf nicht literal in das Inline-Skript geraten.
    html = await render(baseLocals);
    check(!html.includes('BPMN_DIAGRAMS = [{"key":"wf-1","summaryId":9,"xml":"<'),
        'BPMN-XML wird escaped');

    // Inline-Skript syntaktisch pruefen (nicht ausfuehren).
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    let jsOk = scripts.length > 0;
    scripts.forEach((code) => {
        try { new vm.Script(code); } catch (err) {
            jsOk = false;
            console.error('JS-SYNTAXFEHLER:', err.message);
        }
    });
    check(jsOk, 'Inline-JavaScript ist syntaktisch gueltig');

    console.log(`\n  ${passed} bestanden${failures ? `, ${failures} fehlgeschlagen` : ''}\n`);
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('Test-Fehler:', err.message);
    process.exit(1);
});
