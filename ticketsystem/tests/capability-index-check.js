// Prueft die Index-Projektion des CuraFlow-Funktionskatalogs
// (/api/catalog/index) — die autoritative Quelle fuer CAPABILITY-Fragen.
// Reiner Funktionstest: kein laufendes CuraFlow, keine DB, kein Modellaufruf.
// Der HTTP-Zugriff wird durch einen Stub von global.fetch ersetzt.
//
// Aufruf: node tests/capability-index-check.js

'use strict';

const {
    fetchCatalog,
    fetchCapabilityIndex,
    capabilityExists,
    searchCapabilities,
    buildCapabilityIndex,
    formatCapabilityMatches,
    clearCatalogCache,
    INDEX_PATH,
    FLOW_PATH
} = require('../services/atlas/catalog');
const architectTools = require('../services/ai/architectTools');

let failures = 0;
let passed = 0;

function check(condition, message) {
    if (condition) { passed += 1; console.log(`  ✅ ${message}`); }
    else { failures += 1; console.log(`  ❌ ${message}`); }
}

// Bewusst MIT beiden Projektionen: der Flow-Katalog hat `label`, der Index
// nicht — die Index-Client-Tests duerfen nicht versehentlich Flow-Daten nutzen.
const INDEX = {
    catalogVersion: 1,
    capabilities: [
        {
            id: 'staff.qualify',
            summary: 'Record that a doctor holds a qualification for a position.',
            aliases: ['Qualifikation erteilen', 'Qualifikation zuweisen', 'Mitarbeiter qualifizieren'],
            module: 'staff',
            status: 'draft',
            endpoints: ['POST /api/db'],
            requiredPermission: 'can_manage_master_data'
        },
        {
            id: 'shift.assign',
            summary: 'Place a doctor into a position on a date.',
            aliases: ['Dienst eintragen', 'Mitarbeiter einteilen', 'Besetzung'],
            module: 'schedule',
            status: 'verified',
            endpoints: ['POST /api/db'],
            requiredPermission: 'can_edit_schedule'
        },
        {
            id: 'absence.request',
            summary: 'Request an absence for a day.',
            aliases: ['Urlaub beantragen', 'Abwesenheit melden'],
            module: 'absence',
            status: 'draft',
            endpoints: ['POST /api/db'],
            requiredPermission: null
        },
        {
            id: 'billing.case',
            summary: 'Create a billing case.',
            aliases: ['Abrechnungsfall', 'Rechnung anlegen'],
            module: 'billing',
            status: 'gap',
            endpoints: ['POST /api/db'],
            requiredPermission: 'can_bill'
        }
    ]
};

// --- Helpers (gleiches Muster wie soll-workflow-check.js) -------------------

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
    console.log('\n🧪  Capability-Index: Client\n');
    // -------------------------------------------------------------------------

    // --- Erfolgsfall -----------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({
        CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de',
        CURAFLOW_CATALOG_TOKEN: 'service-token-0123456789abcdef'
    }, () => withFetch(() => jsonResponse(INDEX), async (calls) => {
        const result = await fetchCapabilityIndex();
        check(result.reason === null, 'Erfolg liefert reason null');
        check(result.catalog && result.catalog.capabilities.length === 4, 'Payload wird uebernommen');
        check(result.index && result.index.capabilities.length === 4, 'normalisierter Index wird mitgeliefert');
        check(result.index.catalogVersion === 1, 'catalogVersion wird uebernommen');
        check(calls.length === 1, 'genau ein HTTP-Aufruf');
        check(calls[0].url === 'https://curaflow.opnwork.de/api/catalog/index', 'Pfad /api/catalog/index');
        check(calls[0].url !== `https://curaflow.opnwork.de${FLOW_PATH}`, 'NICHT der Flow-Pfad');
        check(calls[0].init.method === 'GET', 'Methode GET');
        check(calls[0].init.headers.Authorization === 'Bearer service-token-0123456789abcdef',
            'Service-Token wird als Bearer gesendet');
        check(!('X-DB-Token' in calls[0].init.headers), 'kein X-DB-Token (mandantenunabhaengig)');
        check(calls[0].init.headers.Accept === 'application/json', 'Accept: application/json');
    }));

    // --- Normalisierung der Index-Eintraege ------------------------------
    const built = buildCapabilityIndex(INDEX);
    check(built.capabilities[0].label === 'Qualifikation erteilen',
        'label faellt auf den ersten deutschen Alias zurueck (Index hat kein label)');
    check(built.capabilities[0].module === 'staff', 'module wird uebernommen');
    check(built.capabilities[0].endpoints[0] === 'POST /api/db', 'endpoints werden uebernommen');
    check(built.capabilities[0].requiredPermission === 'can_manage_master_data',
        'requiredPermission wird uebernommen');
    check(built.capabilities[2].requiredPermission === null,
        'fehlendes requiredPermission wird zu null');
    check(buildCapabilityIndex(null).capabilities.length === 0, 'ungueltiger Input ergibt leere Liste');

    // --- Trailing Slash --------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de///' },
        () => withFetch(() => jsonResponse(INDEX), async (calls) => {
            await fetchCapabilityIndex();
            check(calls[0].url === 'https://curaflow.opnwork.de/api/catalog/index',
                'Trailing Slash ergibt korrekten Index-Pfad');
        }));

    // --- Kein Token ------------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => jsonResponse(INDEX), async (calls) => {
            await fetchCapabilityIndex();
            check(!('Authorization' in calls[0].init.headers),
                'ohne Token wird kein Authorization-Header gesendet');
        }));

    // --- Eigener Grund je Fehlerfall -------------------------------------
    clearCatalogCache();
    await withCatalogEnv({}, () => withFetch(() => jsonResponse(INDEX), async (calls) => {
        const result = await fetchCapabilityIndex();
        check(result.catalog === null && result.index === null, 'fehlende BASE_URL → nichts');
        check(/CURAFLOW_BASE_URL/.test(result.reason), 'Grund nennt CURAFLOW_BASE_URL');
        check(calls.length === 0, 'ohne Konfiguration geht kein Aufruf raus');
    }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de', CURAFLOW_CATALOG_TOKEN: 'alt' },
        () => withFetch(() => jsonResponse({ error: 'unauthorized' }, 401), async () => {
            const result = await fetchCapabilityIndex();
            check(result.catalog === null, '401 → catalog null');
            check(/abgelehnt/.test(result.reason) && /401/.test(result.reason),
                '401 hat eine eigene Meldung');
        }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => jsonResponse({}, 403), async () => {
            const result = await fetchCapabilityIndex();
            check(result.catalog === null && /abgelehnt/.test(result.reason),
                '403 → eigene Meldung (abgelehnter Zugriff)');
        }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => jsonResponse({}, 500), async () => {
            const result = await fetchCapabilityIndex();
            check(result.catalog === null, '500 → catalog null');
            check(/500/.test(result.reason) && /200/.test(result.reason),
                'anderer HTTP-Status hat eine eigene Meldung');
        }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => { throw new Error('ECONNREFUSED'); }, async () => {
            const result = await fetchCapabilityIndex();
            check(result.catalog === null && /nicht erreichbar/.test(result.reason),
                'Netzwerkfehler → "nicht erreichbar"');
        }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de', CURAFLOW_CATALOG_TIMEOUT_MS: '20' },
        () => withFetch(hangingFetch, async () => {
            const result = await fetchCapabilityIndex();
            check(result.catalog === null && /Zeitueberschreitung/.test(result.reason),
                'Timeout hat eine eigene Meldung');
        }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => ({
            status: 200,
            json: async () => { throw new SyntaxError('Unexpected token <'); }
        }), async () => {
            const result = await fetchCapabilityIndex();
            check(result.catalog === null && /JSON/.test(result.reason),
                'unlesbares JSON hat eine eigene Meldung');
        }));

    const badPayloads = [
        ['null', null],
        ['Array', []],
        ['capabilities als String', { capabilities: 'no' }],
        ['capabilities fehlt', { catalogVersion: 1 }],
        ['Eintrag ohne id', { capabilities: [{ summary: 'x' }] }],
        ['id ist eine Zahl', { capabilities: [{ id: 42 }] }]
    ];
    for (const [label, payload] of badPayloads) {
        clearCatalogCache();
        // eslint-disable-next-line no-await-in-loop
        await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
            () => withFetch(() => jsonResponse(payload), async () => {
                const result = await fetchCapabilityIndex();
                check(result.catalog === null && /Unerwartete Form/.test(result.reason),
                    `ungueltige Form (${label}) → eigener Grund`);
            }));
    }

    // --- Wirft nie -------------------------------------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => { throw 'boom'; }, async () => {
            let threw = false;
            let result = null;
            try { result = await fetchCapabilityIndex(); } catch (_) { threw = true; }
            check(!threw && result && result.catalog === null && result.index === null,
                'fetchCapabilityIndex wirft auch bei Unsinn nicht');
        }));

    // --- Getrennte Caches fuer Flow und Index ----------------------------
    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://cache.test' },
        () => withFetch((url) => {
            if (String(url).endsWith(FLOW_PATH)) return jsonResponse({}, 500);
            return jsonResponse(INDEX);
        }, async (calls) => {
            const first = await fetchCapabilityIndex();
            check(first.catalog !== null, 'Index laedt erfolgreich');
            const flow = await fetchCatalog();
            check(flow.catalog === null, 'Flow-Projektion darf unabhaengig fehlschlagen');
            const second = await fetchCapabilityIndex();
            check(second.catalog !== null, 'Index bleibt gecacht');
            check(calls.length === 2,
                'ein Fehler der Flow-Projektion verdraengt den Index-Cache nicht');
        }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://cache.test' },
        () => withFetch(() => jsonResponse(INDEX), async (calls) => {
            await fetchCapabilityIndex();
            await fetchCapabilityIndex();
            check(calls.length === 1, 'zweiter Index-Aufruf innerhalb der TTL geht nicht ins Netz');
            await fetchCapabilityIndex({ force: true });
            check(calls.length === 2, 'force umgeht den Index-Cache');
        }));

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://cache.test', CURAFLOW_CATALOG_TTL_MS: '0' },
        () => withFetch(() => jsonResponse(INDEX), async (calls) => {
            await fetchCapabilityIndex();
            await fetchCapabilityIndex();
            check(calls.length === 2, 'abgelaufener Index-Cache (TTL 0) laedt neu');
        }));

    // -------------------------------------------------------------------------
    console.log('\n🧪  Capability-Index: capabilityExists\n');
    // -------------------------------------------------------------------------

    let match = await capabilityExists('Qualifikation erteilen', { catalog: INDEX });
    check(match && match.id === 'staff.qualify', 'exakter Alias trifft die Capability');
    check(match && match.module === 'staff' && match.status === 'draft',
        'Treffer enthaelt module und status');

    match = await capabilityExists('  QUALIFIKATION   ERTEILEN ', { catalog: INDEX });
    check(match && match.id === 'staff.qualify', 'Gross-/Kleinschreibung und Whitespace egal');

    match = await capabilityExists('erteilen Qualifikation', { catalog: INDEX });
    check(match && match.id === 'staff.qualify', 'Wortstellung ist egal');

    match = await capabilityExists('Mitarbeiter einteilen', { catalog: INDEX });
    check(match && match.id === 'shift.assign', 'Alias einer anderen Capability trifft korrekt');

    check((await capabilityExists('shift.assign', { catalog: INDEX }))?.id === 'shift.assign',
        'punktierte id ist ebenfalls ein Suchschluessel');
    check((await capabilityExists('Abrechnungsfall', { catalog: INDEX })) === null,
        'status "gap" gilt als NICHT vorhanden');
    check((await capabilityExists('Voellig unbekannt', { catalog: INDEX })) === null,
        'unbekannter Alias liefert null');
    check((await capabilityExists('', { catalog: INDEX })) === null, 'leerer Alias liefert null');

    // Der Treffer auf die englische summary ist KEIN Existenzbeweis.
    check((await capabilityExists('Place a doctor into a position', { catalog: INDEX })) === null,
        'summary taugt nicht zur Existenzpruefung');

    // Vorhandener Katalog => kein zusaetzlicher HTTP-Aufruf.
    clearCatalogCache();
    await withCatalogEnv({}, () => withFetch(() => jsonResponse(INDEX), async (calls) => {
        const viaOption = await capabilityExists('Dienst eintragen', { catalog: INDEX });
        check(viaOption && viaOption.id === 'shift.assign', 'options.catalog wird genutzt');
        check(calls.length === 0, 'options.catalog vermeidet einen zweiten Fetch');
    }));

    // Index nicht erreichbar => capabilityExists liefert null, wirft aber nicht.
    clearCatalogCache();
    let existsThrew = false;
    await withCatalogEnv({}, async () => {
        try {
            const missing = await capabilityExists('Dienst eintragen');
            check(missing === null, 'ohne Index liefert capabilityExists null statt zu werfen');
        } catch (_) { existsThrew = true; }
    });
    check(!existsThrew, 'capabilityExists wirft nie');

    // -------------------------------------------------------------------------
    console.log('\n🧪  Capability-Index: searchCapabilities\n');
    // -------------------------------------------------------------------------

    let results = await searchCapabilities('Dienst eintragen', { catalog: INDEX });
    check(results.length > 0 && results[0].id === 'shift.assign', 'Alias-Treffer steht vorn');
    check(results[0].label === 'Dienst eintragen', 'label ist der deutsche Alias');
    check(Array.isArray(results[0].aliases) && results[0].aliases.length === 3,
        'Treffer enthaelt alle Aliase');
    check(typeof results[0].score === 'number' && results[0].score > 0, 'Treffer hat einen Score');

    results = await searchCapabilities('Wir muessen Mitarbeiter einteilen', { catalog: INDEX });
    check(results.length > 0 && results[0].id === 'shift.assign',
        'Alias-Wendung im Satz wird gefunden');

    // summary nur als Volltext-Fallback, niedriger gewichtet.
    results = await searchCapabilities('Place a doctor into a position on a date', { catalog: INDEX });
    check(results.length > 0 && results[0].id === 'shift.assign',
        'summary dient als Volltext-Fallback');
    check(!results.some(item => item.id === 'billing.case') || results[0].id !== 'billing.case',
        'summary-Fallback verdraengt den besten Treffer nicht');

    // phraseOnly: nur vollstaendige Alias-Wendungen, kein Token-Rauschen.
    results = await searchCapabilities('Bitte die Qualifikation erteilen', {
        catalog: INDEX, phraseOnly: true
    });
    check(results.length === 1 && results[0].id === 'staff.qualify',
        'phraseOnly findet die Alias-Wendung im Ticket-Text');
    results = await searchCapabilities('Qualifikation', { catalog: INDEX, phraseOnly: true });
    check(results.length === 0, 'phraseOnly ignoriert einzelne Tokens');

    // Bekannte Luecke bleibt sichtbar.
    results = await searchCapabilities('Rechnung anlegen', { catalog: INDEX });
    check(results.some(item => item.id === 'billing.case' && item.status === 'gap'),
        'gap-Capability bleibt mit status "gap" in den Treffern');

    // limit und leere Anfrage.
    results = await searchCapabilities('Mitarbeiter', { catalog: INDEX, limit: 1 });
    check(results.length <= 1, 'limit begrenzt die Trefferzahl');
    check((await searchCapabilities('   ', { catalog: INDEX })).length === 0,
        'leere Anfrage liefert eine leere Liste');

    // Ohne erreichbaren Index: leere Liste, kein Wurf.
    clearCatalogCache();
    await withCatalogEnv({}, async () => {
        let threw = false;
        try {
            const none = await searchCapabilities('Dienst eintragen');
            check(none.length === 0, 'ohne Index liefert die Suche eine leere Liste');
        } catch (_) { threw = true; }
        check(!threw, 'searchCapabilities wirft nie');
    });

    // -------------------------------------------------------------------------
    console.log('\n🧪  Capability-Index: Formatierung\n');
    // -------------------------------------------------------------------------

    const matches = await searchCapabilities('Mitarbeiter', { catalog: INDEX, limit: 2 });
    const formatted = formatCapabilityMatches(matches);
    const formattedLines = formatted ? formatted.split('\n') : [];
    check(formattedLines.length === matches.length, 'eine Zeile je Treffer');
    check(formattedLines.every(line => line.startsWith('- ')), 'jede Zeile beginnt mit "- "');
    check(/shift\.assign/.test(formatted), 'Formatierung nennt die id');

    const gapText = formatCapabilityMatches([
        { id: 'billing.case', label: 'Abrechnungsfall', aliases: ['Abrechnungsfall'],
            module: 'billing', status: 'gap' }
    ]);
    check(gapText.includes('[LUECKE]'), 'gap-Treffer wird als Luecke markiert');
    check(formatCapabilityMatches(null) === '', 'ungueltiger Input ergibt leeren String');

    // -------------------------------------------------------------------------
    console.log('\n🧪  Capability-Index: Architect-Tools\n');
    // -------------------------------------------------------------------------

    check(Boolean(architectTools.TOOLS.capability_exists), 'Tool capability_exists ist registriert');
    check(Boolean(architectTools.TOOLS.search_capabilities), 'Tool search_capabilities ist registriert');
    const toolDocs = architectTools.describeTools();
    check(toolDocs.includes('capability_exists') && toolDocs.includes('search_capabilities'),
        'Tool-Beschreibung nennt beide Capability-Tools');
    check(/NUR fuer CAPABILITY-Fragen/i.test(toolDocs), 'Tool-Beschreibung trennt Capability- von Symbolfragen');

    clearCatalogCache();
    await withCatalogEnv({ CURAFLOW_BASE_URL: 'https://curaflow.opnwork.de' },
        () => withFetch(() => jsonResponse(INDEX), async () => {
            const hit = await architectTools.runTool({
                name: 'capability_exists', args: { alias: 'Dienst eintragen' }
            });
            check(!hit.error && /VORHANDEN/.test(hit.result) && /shift\.assign/.test(hit.result),
                'capability_exists meldet VORHANDEN mit id');
            check(/Integration statt Neubau/.test(hit.result), 'Treffer empfiehlt Integration statt Neubau');

            const gap = await architectTools.runTool({
                name: 'capability_exists', args: { alias: 'Abrechnungsfall' }
            });
            check(/BEKANNTE LUECKE/.test(gap.result), 'gap wird als bekannte Luecke gemeldet');
            check(!/VORHANDEN/.test(gap.result), 'gap wird nicht als vorhanden gemeldet');

            const search = await architectTools.runTool({
                name: 'search_capabilities', args: { query: 'Mitarbeiter', limit: 5 }
            });
            check(!search.error && /shift\.assign/.test(search.result),
                'search_capabilities liefert Treffer');
        }));

    // Index nicht erreichbar: das ist ein FEHLER, kein "existiert nicht".
    clearCatalogCache();
    await withCatalogEnv({}, async () => {
        const unavailable = await architectTools.runTool({
            name: 'capability_exists', args: { alias: 'Dienst eintragen' }
        });
        check(Boolean(unavailable.error), 'nicht erreichbarer Index fuehrt zu einem Tool-FEHLER');
        check(/nicht verfuegbar/i.test(unavailable.error),
            'Fehlermeldung macht den Ausfall sichtbar');
        check(!/keine Capability/i.test(unavailable.error),
            'Ausfall wird NICHT als "keine Capability" gemeldet');
    });

    check(Boolean((await architectTools.runTool({ name: 'gibts_nicht', args: {} })).error),
        'unbekanntes Tool liefert einen Fehler');
    check(Boolean((await architectTools.runTool({ name: 'capability_exists', args: {} })).error),
        'capability_exists ohne alias liefert einen Fehler');

    console.log(`\n  ${passed} bestanden${failures ? `, ${failures} fehlgeschlagen` : ''}\n`);
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('\n❌ Testlauf abgebrochen:', err);
    process.exit(1);
});
