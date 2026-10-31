// Prueft Client, Formatierung und Prompt fuer den CuraFlow-Funktionskatalog.
// Reiner Funktionstest: kein laufendes CuraFlow, keine DB, kein Modellaufruf.
// Der HTTP-Zugriff wird durch einen Stub von global.fetch ersetzt.
//
// Aufruf: node tests/soll-workflow-check.js

'use strict';

const { fetchCatalog, formatCatalog, clearCatalogCache } = require('../services/atlas/catalog');
const {
    SOLL_SYSTEM_PROMPT,
    buildSollUserPrompt,
    SOLL_BPMN_SYSTEM_PROMPT,
    buildSollBpmnUserPrompt,
    formatSollContent
} = require('../services/atlas/sollFlow');

let failures = 0;
let passed = 0;

function check(condition, message) {
    if (condition) { passed += 1; console.log(`  ✅ ${message}`); }
    else { failures += 1; console.log(`  ❌ ${message}`); }
}

const CATALOG = {
    catalogVersion: 1,
    capabilities: [
        {
            id: 'shift.assign',
            label: 'Dienst eintragen',
            aliases: ['Dienst eintragen', 'Mitarbeiter einteilen', 'Besetzung'],
            module: 'schedule',
            status: 'verified',
            tenantScope: 'tenant',
            summary: 'Place a doctor into a position on a date.'
        },
        {
            id: 'shift.export',
            label: 'Plan exportieren',
            aliases: ['Plan exportieren', 'Excel-Export'],
            module: 'schedule',
            status: 'draft',
            tenantScope: 'tenant',
            summary: 'Export the plan.'
        },
        {
            id: 'billing.case',
            label: 'Abrechnungsfall',
            aliases: ['Abrechnungsfall'],
            module: 'billing',
            status: 'gap',
            tenantScope: 'tenant',
            summary: 'Create a billing case.'
        }
    ]
};

// --- Helpers ---------------------------------------------------------------

// Async-sicher: der Body wird awaited, BEVOR das finally die Env zuruecksetzt.
async function withEnv(vars, fn) {
    const saved = new Map();
    Object.keys(vars).forEach((key) => {
        saved.set(key, process.env[key]);
        if (vars[key] === undefined) delete process.env[key];
        else process.env[key] = vars[key];
    });
    try {
        return await fn();
    } finally {
        saved.forEach((value, key) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        });
    }
}

function withCatalogEnv(vars, fn) {
    return withEnv(Object.assign({
        CURAFLOW_BASE_URL: undefined,
        CURAFLOW_CATALOG_TOKEN: undefined,
        CURAFLOW_CATALOG_TIMEOUT_MS: undefined,
        CURAFLOW_CATALOG_TTL_MS: undefined
    }, vars), fn);
}

async function withFetch(handler, fn) {
    const original = global.fetch;
    const calls = [];
    global.fetch = (url, init) => {
        calls.push({ url, init: init || {} });
        return Promise.resolve().then(() => handler(url, init || {}, calls.length));
    };
    try {
        return await fn(calls);
    } finally {
        if (original === undefined) delete global.fetch;
        else global.fetch = original;
    }
}

function jsonResponse(body, status = 200) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body
    };
}

function hangingFetch(url, init) {
    return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (signal && typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted.');
                err.name = 'AbortError';
                reject(err);
            });
        }
    });
}

async function main() {
    // -------------------------------------------------------------------------
    console.log('\n🧪  Funktionskatalog: Formatierung\n');
    // -------------------------------------------------------------------------

    let formatted = formatCatalog(CATALOG);
    let lines = formatted.split('\n');
    check(lines.length === 3, 'eine Zeile je Funktion');
    check(lines[0].startsWith('- shift.assign (schedule):'), 'Zeile beginnt mit id, dann Modul');
    check(lines[0] === '- shift.assign (schedule): Dienst eintragen / Mitarbeiter einteilen / Besetzung',
        'deutsche Bezeichnung und Aliases vollstaendig, label nicht doppelt');
    check(!formatted.includes('Place a doctor'), 'englische summary ist NICHT enthalten');
    check(lines[2].includes('[LUECKE]'), 'gap-Funktion ist sichtbar markiert');
    check(!lines[1].includes('[LUECKE]'), 'verfuegbare Funktion traegt keinen gap-Marker');

    formatted = formatCatalog({
        catalogVersion: 1,
        capabilities: [{
            id: 'x.y',
            label: 'Tun',
            aliases: ['Tun', 'tun', ' Anderes '],
            module: 'm',
            status: 'draft',
            summary: 'Do it.',
            preconditions: ['darf nur montags'],
            effects: ['schreibt DB'],
            endpoints: ['POST /api/x']
        }]
    });
    check(formatted === '- x.y (m): Tun / Anderes', 'doppelte Aliases werden zusammengefasst');
    check(!/darf nur montags|schreibt DB|\/api\/x/.test(formatted),
        'preconditions/effects/endpoints bleiben draussen');

    check(formatCatalog(null) === '', 'null → ""');
    check(formatCatalog(undefined) === '', 'undefined → ""');
    check(formatCatalog({ capabilities: 'no' }) === '', 'capabilities kein Array → ""');
    check(formatCatalog({}) === '', 'Payload ohne capabilities → ""');
    check(formatCatalog({ capabilities: [] }) === '', 'leerer Katalog → ""');
    check(formatCatalog({ capabilities: [{ label: 'ohne id' }] }) === '', 'Eintrag ohne id wird ignoriert');

    // -------------------------------------------------------------------------
    console.log('\n🧪  Soll-Workflow: Prompt\n');
    // -------------------------------------------------------------------------

    const inputText = 'Heute traegt die Stationsleitung den Dienst in eine Excel-Liste ein.';

    const withCatalog = buildSollUserPrompt(inputText, CATALOG);
    check(withCatalog.includes('Funktionskatalog'), 'Katalog wird angekuendigt');
    check(withCatalog.includes('Funktionen:'), 'Funktionsliste wird angekuendigt');
    check(withCatalog.includes('- shift.assign (schedule): Dienst eintragen'), 'id und Label stehen im Prompt');
    check(withCatalog.includes('- billing.case (billing): Abrechnungsfall [LUECKE]'), 'gap-Funktion ist markiert');
    check(withCatalog.includes(inputText), 'inputText erscheint wortgleich');
    check(withCatalog.includes('"gap"') && withCatalog.includes('"manuell"'),
        'erlaubte Werte "gap" und "manuell" sind genannt');
    check(!withCatalog.includes('Place a doctor'), 'englische summary steht nicht im Prompt');

    const withoutCatalog = buildSollUserPrompt(inputText, null);
    check(/kein funktionskatalog/i.test(withoutCatalog), 'Abwesenheit des Katalogs wird genannt');
    check(!withoutCatalog.includes('shift.assign'), 'ohne Katalog enthaelt der Prompt keine ids');
    check(withoutCatalog.includes(inputText), 'inputText erscheint auch ohne Katalog wortgleich');
    check(withoutCatalog.includes('"gap"') && withoutCatalog.includes('"manuell"'),
        'gap und manuell bleiben erlaubte Werte');
    check(/erfinde keine/i.test(withoutCatalog), 'Erfinden wird ohne Katalog verboten');
    check(buildSollUserPrompt(inputText, { capabilities: [] }).includes(inputText),
        'leerer Katalog verhaelt sich wie "kein Katalog"');
    check(buildSollUserPrompt(inputText, { capabilities: [] }).includes('KEIN Funktionskatalog'),
        'leerer Katalog nennt die Abwesenheit');

    check(SOLL_SYSTEM_PROMPT.includes('"gap"') && SOLL_SYSTEM_PROMPT.includes('"manuell"'),
        'Systemprompt definiert "gap" und "manuell"');
    check(/Erfinde niemals eine Funktion/.test(SOLL_SYSTEM_PROMPT), 'Systemprompt verbietet erfundene Funktionen');
    check(/"zusammenfassung"/.test(SOLL_SYSTEM_PROMPT) && /"schritte"/.test(SOLL_SYSTEM_PROMPT)
        && /"offene_punkte"/.test(SOLL_SYSTEM_PROMPT), 'Systemprompt nennt die drei Antwortfelder');
    check(/"ist"/.test(SOLL_SYSTEM_PROMPT) && /"soll"/.test(SOLL_SYSTEM_PROMPT)
        && /"funktion"/.test(SOLL_SYSTEM_PROMPT) && /"rolle"/.test(SOLL_SYSTEM_PROMPT)
        && /"begruendung"/.test(SOLL_SYSTEM_PROMPT), 'Systemprompt nennt alle Schrittfelder');
    check(/ohne Markdown/i.test(SOLL_SYSTEM_PROMPT) && /ausschliesslich als JSON/i.test(SOLL_SYSTEM_PROMPT),
        'Systemprompt verlangt JSON ohne Markdown');

    // -------------------------------------------------------------------------
    console.log('\n🧪  Funktionskatalog: Client\n');
    // -------------------------------------------------------------------------

    // --- Erfolgsfall -----------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({
        CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de',
        CURAFLOW_CATALOG_TOKEN: 'test-token'
    }, () => withFetch(() => jsonResponse(CATALOG), async (calls) => {
        const result = await fetchCatalog();
        check(result.reason === null, 'Erfolg liefert reason null');
        check(JSON.stringify(result.catalog) === JSON.stringify(CATALOG), 'Payload wird unveraendert uebernommen');
        check(calls.length === 1, 'genau ein HTTP-Aufruf');
        check(calls[0].url === 'https://curaflow.opnwork.de/api/catalog/flow', 'Pfad /api/catalog/flow');
        check(calls[0].init.method === 'GET', 'Methode GET');
        check(calls[0].init.headers.Authorization === 'Bearer test-token', 'Bearer-Token wird gesendet');
        check(!('X-DB-Token' in calls[0].init.headers), 'kein X-DB-Token');
    }));

    // --- Trailing Slash --------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de///' },
        () => withFetch(() => jsonResponse(CATALOG), async (calls) => {
            await fetchCatalog();
            check(calls[0].url === 'https://curaflow.opnwork.de/api/catalog/flow',
                'Trailing Slash in der Basis-URL ergibt korrekten Pfad');
        }));

    // --- Kein Token ------------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => jsonResponse(CATALOG), async (calls) => {
            await fetchCatalog();
            check(!('Authorization' in calls[0].init.headers),
                'ohne Token wird kein Authorization-Header gesendet');
        }));

    // --- 401 / 403 -------------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de', CURAFLOW_CATALOG_TOKEN: 'alt' },
        () => withFetch(() => jsonResponse({ error: 'unauthorized' }, 401), async () => {
            const result = await fetchCatalog();
            check(result.catalog === null, '401 → catalog null');
            check(/abgelehnt/.test(result.reason) && /401/.test(result.reason),
                '401 hat eine eigene Meldung (abgelehnter Zugriff)');
        }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => jsonResponse({}, 403), async () => {
            const result = await fetchCatalog();
            check(result.catalog === null && /abgelehnt/.test(result.reason),
                '403 → catalog null mit Meldung ueber abgelehnten Zugriff');
        }));

    // --- Anderer Status --------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => jsonResponse({}, 500), async () => {
            const result = await fetchCatalog();
            check(result.catalog === null, '500 → catalog null');
            check(/500/.test(result.reason) && /200/.test(result.reason), 'Meldung nennt den Status');
        }));

    // --- Netzwerkfehler --------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => { throw new Error('ECONNREFUSED'); }, async () => {
            const result = await fetchCatalog();
            check(result.catalog === null, 'Netzwerkfehler → catalog null');
            check(/nicht erreichbar/.test(result.reason), 'Netzwerkfehler wird als "nicht erreichbar" gemeldet');
        }));

    // --- Timeout ---------------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de', CURAFLOW_CATALOG_TIMEOUT_MS: '20' },
        () => withFetch(hangingFetch, async () => {
            const result = await fetchCatalog();
            check(result.catalog === null, 'Timeout → catalog null');
            check(/Zeitueberschreitung/.test(result.reason), 'Timeout hat eine eigene Meldung');
        }));

    // --- Antwort kein JSON ----------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => ({
            status: 200,
            json: async () => { throw new SyntaxError('Unexpected token <'); }
        }), async () => {
            const result = await fetchCatalog();
            check(result.catalog === null, 'Antwort ohne JSON → catalog null');
            check(/JSON/.test(result.reason), 'Meldung nennt das unlesbare JSON');
        }));

    // --- Form statt nur Status ------------------------------------------
    const badPayloads = [
        ['null', null],
        ['Array', []],
        ['capabilities als String', { capabilities: 'no' }],
        ['capabilities fehlt', { catalogVersion: 1 }],
        ['Eintrag ohne id', { capabilities: [{ label: 'Dienst eintragen' }] }],
        ['id ist eine Zahl', { capabilities: [{ id: 42, label: 'x' }] }],
        ['Eintrag null', { capabilities: [null] }]
    ];
    for (const [label, payload] of badPayloads) {
        clearCatalogCache();
        // eslint-disable-next-line no-await-in-loop
        await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
            () => withFetch(() => jsonResponse(payload), async () => {
                const result = await fetchCatalog();
                check(result.catalog === null && typeof result.reason === 'string',
                    `ungueltige Form (${label}) → catalog null mit Grund`);
            }));
    }

    // --- Fehlende Konfiguration -----------------------------------------
    clearCatalogCache();
    await withCatalogEnv({}, () => withFetch(() => jsonResponse(CATALOG), async (calls) => {
        const result = await fetchCatalog();
        check(result.catalog === null, 'fehlende BASE_URL → catalog null');
        check(/CURAFLOW_BASE_URL/.test(result.reason), 'Grund nennt die Variable CURAFLOW_BASE_URL');
        check(calls.length === 0, 'ohne Konfiguration geht kein Aufruf raus');
    }));

    // --- Wirft nie -------------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => { throw 'boom'; }, async () => {
            let threw = false;
            let result = null;
            try { result = await fetchCatalog(); } catch (_) { threw = true; }
            check(!threw && result && result.catalog === null, 'fetchCatalog wirft auch bei Unsinn nicht');
        }));

    let threwOnBadUrl = false;
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'nicht-mal-eine-url' }, async () => {
        try {
            const result = await fetchCatalog();
            check(result.catalog === null && /CURAFLOW_BASE_URL/.test(result.reason),
                'ungueltige Basis-URL → catalog null mit Grund');
        } catch (_) { threwOnBadUrl = true; }
    });
    check(!threwOnBadUrl, 'ungueltige Basis-URL wirft nicht');

    // --- Cache ------------------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://cache.test' },
        () => withFetch(() => jsonResponse(CATALOG), async (calls) => {
            await fetchCatalog();
            await fetchCatalog();
            check(calls.length === 1, 'zweiter Aufruf innerhalb der TTL geht nicht ins Netz');
        }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://cache.test', CURAFLOW_CATALOG_TTL_MS: '600000' },
        () => withFetch(() => jsonResponse(CATALOG), async (calls) => {
            await fetchCatalog();
            await fetchCatalog({ force: true });
            check(calls.length === 2, 'force umgeht den Cache');
        }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://cache.test', CURAFLOW_CATALOG_TTL_MS: '0' },
        () => withFetch(() => jsonResponse(CATALOG), async (calls) => {
            await fetchCatalog();
            await fetchCatalog();
            check(calls.length === 2, 'abgelaufener Cache (TTL 0) geht wieder ins Netz');
        }));

    // -------------------------------------------------------------------------
    console.log('\n🧪  Soll-Workflow: BPMN-Prompt\n');
    check(SOLL_BPMN_SYSTEM_PROMPT.includes('bpmn:definitions'), 'Soll-Diagramm-Prompt verlangt BPMN-Wurzel');
    check(/Funktion:/.test(SOLL_BPMN_SYSTEM_PROMPT), 'Soll-Diagramm-Prompt verlangt die Funktions-Zeile');
    check(/gap/.test(SOLL_BPMN_SYSTEM_PROMPT) && /manuell/.test(SOLL_BPMN_SYSTEM_PROMPT),
        'Soll-Diagramm-Prompt kennt gap und manuell');
    check(/Keine erfundenen ids/.test(SOLL_BPMN_SYSTEM_PROMPT),
        'Soll-Diagramm-Prompt verbietet erfundene ids');

    const sollBpmnPrompt = buildSollBpmnUserPrompt('## Kuenftiger Ablauf', CATALOG);
    check(sollBpmnPrompt.includes('## Kuenftiger Ablauf'), 'Soll-Diagramm-Prompt enthaelt die Zusammenfassung');
    check(sollBpmnPrompt.includes('shift.assign'), 'Soll-Diagramm-Prompt enthaelt die Katalog-ids');
    check(sollBpmnPrompt.includes('billing.case'), 'Soll-Diagramm-Prompt enthaelt die gap-Funktion als id');

    console.log('\n🧪  Soll-Workflow: Formatierung\n');
    const sollFormatted = formatSollContent({
        zusammenfassung: 'Der Ablauf wird digital.',
        schritte: [
            { ist: 'Dienst manuell eintragen', soll: 'Dienst in CuraFlow eintragen', funktion: 'shift.assign', rolle: 'Pflege', begruendung: 'Ersetzt die Tabelle' },
            { ist: 'Abrechnung per Formular', soll: 'Abrechnung bleibt offen', funktion: 'gap', rolle: 'Verwaltung', begruendung: 'Katalog deckt das nicht ab' },
            { ist: 'Freigabe', soll: 'Freigabe bleibt menschlich', funktion: 'manuell', rolle: 'Arzt', begruendung: 'Facharzt entscheidet' }
        ],
        offene_punkte: ['Abrechnung fehlt im Katalog']
    });
    check(sollFormatted.includes('Der Ablauf wird digital.'), 'Zusammenfassung erscheint');
    check(sollFormatted.includes('## Kuenftiger Ablauf'), 'Ueberschrift Kuenftiger Ablauf vorhanden');
    check(sollFormatted.includes('Dienst in CuraFlow eintragen'), 'Soll-Schritt erscheint');
    check(sollFormatted.includes('CuraFlow-Funktion `shift.assign`'), 'Katalog-Funktion wird benannt');
    check(sollFormatted.includes('CuraFlow kann das aktuell nicht abbilden'), 'gap wird verstaendlich benannt');
    check(sollFormatted.includes('bleibt manuelle Arbeit'), 'manuell wird verstaendlich benannt');
    check(sollFormatted.includes('## Offene Punkte') && sollFormatted.includes('Abrechnung fehlt im Katalog'),
        'Offene Punkte erscheinen');
    check(formatSollContent(null) === '', 'null → ""');
    check(formatSollContent('') === '', 'leere Zeichenkette → ""');

    // -------------------------------------------------------------------------
    console.log(`\n${failures === 0 ? '✅' : '❌'}  ${passed} bestanden, ${failures} fehlgeschlagen\n`);
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
