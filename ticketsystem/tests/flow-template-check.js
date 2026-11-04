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
    projectionSources: [
        { id: 'curaflow', label: 'CuraFlow', mode: 'catalog' },
        { id: 'schreibdienst', label: 'Schreibdienst', mode: 'catalog' },
        { id: 'freitext', label: 'Freitext', mode: 'freitext' }
    ],
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
    check(html.includes('data-summary-detail'), 'Detailgrad-Auswahl fuer den Ist-Workflow vorhanden');
    check(html.includes('data-soll-detail'), 'Detailgrad-Auswahl fuer den Soll-Workflow vorhanden');
    check(html.includes('Grob (weniger Schritte)') && html.includes('Fein (mehr Schritte)'),
        'Detailgrad-Optionen sind benannt');
    check(html.includes('data-soll-source'), 'Quellen-Auswahl fuer den Soll-Workflow vorhanden');
    check(html.includes('>Schreibdienst<') && html.includes('Freitext (eigene Beschreibung)'),
        'Quellen-Auswahl bietet CuraFlow, Schreibdienst und Freitext');
    check(html.includes('data-soll-source-text-row'), 'Freitext-Feld vorhanden');
    check(/data-soll-source-text-row[^>]*class="[^"]*hidden/.test(html)
        || /class="[^"]*hidden[^"]*"[^>]*data-soll-source-text-row/.test(html),
        'Freitext-Feld startet verborgen (Standardquelle CuraFlow)');
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

    // Vorteile des Soll-Workflows werden als Vorher/Nachher-Liste gezeigt.
    const withSoll = {
        ...baseLocals,
        workflowGroups: [{
            ...workflowGroup,
            sollFlows: [{
                id: 11,
                summary_id: 9,
                workflow_id: 1,
                content: 'Der Ablauf wird digital.\n\n## Vorteile gegenueber heute\n\n'
                    + '### 1. Plan lag nur im Intranet\n- Vorher: Fileserver\n\n## Offene Punkte\n- Abrechnung',
                bpmn_xml: null,
                capability_count: 3,
                detail_level: 'mittel',
                model: 'test-model',
                created_at: '2026-10-03 08:00',
                benefits: [
                    {
                        problem: 'Plan lag nur im Intranet',
                        vorher: 'Der Nutzer musste sich durch den Fileserver suchen.',
                        jetzt: 'Der Plan ist auf dem Handy sofort sichtbar.',
                        funktion: 'plan.view'
                    }
                ]
            }]
        }]
    };
    html = await render(withSoll);
    check(html.includes('Vorteile gegenüber heute'), 'Vorteils-Abschnitt erscheint');
    check(html.includes('Plan lag nur im Intranet'), 'Problem des Vorteils erscheint');
    check(html.includes('Vorher:') && html.includes('Der Nutzer musste sich durch den Fileserver suchen.'),
        'Vorher-Zeile erscheint');
    check(html.includes('Mit CuraFlow:') && html.includes('Der Plan ist auf dem Handy sofort sichtbar.'),
        'Mit-CuraFlow-Zeile erscheint');
    check(html.includes('plan.view'), 'zugeordnete Funktion erscheint');
    check(html.includes('Der Ablauf wird digital.'), 'Text des Soll-Workflows bleibt sichtbar');
    check(!html.includes('## Vorteile gegenueber heute'),
        'Vorteils-Abschnitt erscheint nicht doppelt als Klartext');
    check(html.includes('## Offene Punkte'), 'folgende Abschnitte bleiben im Klartext erhalten');

    // Alte Zeilen ohne benefits_json duerfen nicht brechen.
    const withoutBenefits = {
        ...withSoll,
        workflowGroups: [{
            ...workflowGroup,
            sollFlows: [{ ...withSoll.workflowGroups[0].sollFlows[0], benefits: [] }]
        }]
    };
    html = await render(withoutBenefits);
    check(!html.includes('Vorteile gegenüber heute'), 'ohne Vorteile kein leerer Abschnitt');

    // Das Soll-Diagramm bekommt dasselbe Bearbeiten-Feld wie die Ist-Visualisierung.
    const sollBpmnXml = '<bpmn:definitions isHorizontal="true"><bpmn:process id="p"/></bpmn:definitions>';
    const withSollDiagram = {
        ...baseLocals,
        workflowGroups: [{
            ...workflowGroup,
            sollFlows: [{
                ...withSoll.workflowGroups[0].sollFlows[0],
                bpmn_xml: sollBpmnXml,
                refinements: [
                    {
                        id: 4, soll_id: 11, instruction: 'Pflege als eigene Lane',
                        created_at: '2026-10-04 09:30', created_by: 'admin', model: 'test-model'
                    }
                ]
            }]
        }],
        sollBpmnDiagrams: [{ key: 'wf-1', xml: sollBpmnXml }]
    };
    html = await render(withSollDiagram);
    check(html.includes('data-soll-id="11"'), 'Soll-Formular kennt den Soll-Workflow');
    check(html.includes('Diagramm bearbeiten'), 'Soll-Formular ist beschriftet');
    check(html.includes('sollBpmnRefine-wf-1'), 'Soll-Formular hat ein eigenes Eingabefeld');
    check(html.includes('Bisherige Anpassungen (1)'), 'Soll-Anpassungsverlauf wird angezeigt');
    check(html.includes('Pflege als eigene Lane'), 'Soll-Anpassungswunsch erscheint im Verlauf');

    const sollWithoutDiagram = {
        ...withSoll,
        workflowGroups: [{
            ...workflowGroup,
            sollFlows: [{ ...withSoll.workflowGroups[0].sollFlows[0], bpmn_xml: null, refinements: [] }]
        }]
    };
    html = await render(sollWithoutDiagram);
    check(!html.includes('data-soll-id='), 'ohne Soll-Diagramm kein Soll-Formular');

    // Quelle: Freitext zeigt die eigene Beschreibung und das Eingabefeld.
    const freeTextSoll = {
        ...baseLocals,
        workflowGroups: [{
            ...workflowGroup,
            sollFlows: [{
                ...withSoll.workflowGroups[0].sollFlows[0],
                source: 'freitext',
                source_label: 'Freitext',
                source_text: 'Kuenftig planen zwei Personen gleichzeitig im Browser.'
            }]
        }]
    };
    html = await render(freeTextSoll);
    check(html.includes('Quelle: Freitext'), 'Quelle wird in der Metazeile angezeigt');
    check(html.includes('Eigene Beschreibung des Zielzustands'), ' eigene Beschreibung ist abrufbar');
    check(html.includes('Kuenftig planen zwei Personen gleichzeitig im Browser.'),
        'eigene Beschreibung wird angezeigt');
    check(/<option value="freitext" selected/.test(html), 'Freitext ist vorausgewaehlt');
    check(!/data-soll-source-text-row[^>]*class="mt-3 hidden"/.test(html),
        'Freitext-Feld ist bei Quelle Freitext sichtbar');

    const catalogSoll = {
        ...baseLocals,
        workflowGroups: [{
            ...workflowGroup,
            sollFlows: [{ ...withSoll.workflowGroups[0].sollFlows[0], source: 'schreibdienst', source_label: 'Schreibdienst' }]
        }]
    };
    html = await render(catalogSoll);
    check(html.includes('Quelle: Schreibdienst'), 'Katalogquelle wird angezeigt');
    check(/<option value="schreibdienst" selected/.test(html), 'Schreibdienst ist vorausgewaehlt');

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
