'use strict';

// Client fuer maschinenlesbare Funktionskataloge.
//
// Ein Katalog beschreibt, WELCHE Funktionen eine Abteilung kuenftig nutzen
// kann. Er ist damit die Grundlage fuer den SOLL-Workflow ("wie koennte der
// Ablauf kuenftig aussehen"). Fuer den IST-Workflow ist er irrelevant — der
// kommt aus Terminen und Transkripten.
//
// Es gibt mehrere Quellen (siehe CAPABILITY_SOURCES): je eingefuehrtem System
// einer. Konfiguriert werden sie ueber den jeweiligen Env-Prefix, z. B.
// CURAFLOW_BASE_URL und SCHREIBDIENST_BASE_URL. Eine Quelle ohne
// Konfiguration ist ein unterstuetzter Zustand (siehe Grund in reason).
//
// Es werden zwei Projektionen desselben Katalogs bezogen:
//
//   <basis>/api/catalog/flow  — SOLL-Workflow: "welche Funktion ersetzt diesen
//                               Schritt?" (id, label, aliases, module, status,
//                               tenantScope, summary; bewusst ohne
//                               preconditions/effects/endpoints)
//   <basis>/api/catalog/index — Architect/Pre-Plan: "gibt es diese Funktion
//                               schon und wie wird sie erreicht?" (id, summary,
//                               aliases, module, status, endpoints,
//                               requiredPermission)
//
// Die Projektionen sind NICHT austauschbar (siehe CuraFlow ADR-0003): der
// Soll-Workflow soll ueber Ersatz nachdenken, nicht ueber Zulaessigkeit; der
// Architect braucht genau die Existenzfrage. Der Index ist ausserdem nur fuer
// CAPABILITY-Fragen zustaendig ("gibt es X?") — Symbol-/Dateifragen bleiben
// bei den Repo-Grep-Tools.
//
// Vertrag von fetchCatalog/fetchCapabilityIndex: wirft NIE. Jeder Fehlerfall
// liefert { catalog: null, reason } mit einer eigenen Meldung, weil die
// naechste Aktion jeweils anders ist (Konfiguration, Credential, Retry, Melden).
//
// Der Katalog ist heute ca. 100 Capabilities gross (Stand 2026-11: 99 draft,
// 1 verified). Die Anzahl ist bewusst KEINE Konstante — niemals "es gibt nur
// ~10 Funktionen" annehmen.

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_TTL_MS = 600000;
const FLOW_PATH = '/api/catalog/flow';
const INDEX_PATH = '/api/catalog/index';
const DEFAULT_SOURCE = 'curaflow';

/**
 * Die waehlbaren Katalogquellen. `envPrefix` bestimmt die Variablennamen:
 * <PREFIX>_BASE_URL, <PREFIX>_CATALOG_TOKEN, <PREFIX>_CATALOG_TIMEOUT_MS,
 * <PREFIX>_CATALOG_TTL_MS.
 */
const SOURCE_DEFINITIONS = {
    curaflow: { id: 'curaflow', label: 'CuraFlow', envPrefix: 'CURAFLOW' },
    schreibdienst: { id: 'schreibdienst', label: 'Schreibdienst', envPrefix: 'SCHREIBDIENST' }
};

const CAPABILITY_SOURCES = Object.keys(SOURCE_DEFINITIONS);

// Freitext ist keine Katalogquelle: der Nutzer beschreibt den Zielzustand
// selbst. Er steht trotzdem in derselben Auswahl, weil er dieselbe Aufgabe
// loest ("woran orientiert sich die Soll-Projektion?").
const FREITEXT_SOURCE = 'freitext';
const FREITEXT_LABEL = 'Freitext';

const PROJECTION_SOURCES = CAPABILITY_SOURCES
    .map((id) => ({ id, label: SOURCE_DEFINITIONS[id].label, mode: 'catalog' }))
    .concat([{ id: FREITEXT_SOURCE, label: FREITEXT_LABEL, mode: 'freitext' }]);

/**
 * Loest die im Request gewaehlte Projektionsquelle auf.
 *
 * Leer bedeutet CuraFlow (bisheriges Verhalten). Unbekannte Werte sind ein
 * Fehler, damit ein Tippfehler nicht stillschweigend eine andere Quelle nutzt.
 *
 * @returns {{ source: string, mode: 'catalog'|'freitext', label: string } | { error: string }}
 */
function resolveProjectionSource(value) {
    const key = String(value == null ? '' : value).trim().toLowerCase();
    if (!key || key === DEFAULT_SOURCE) {
        return { source: DEFAULT_SOURCE, mode: 'catalog', label: SOURCE_DEFINITIONS[DEFAULT_SOURCE].label };
    }
    if (key === FREITEXT_SOURCE) {
        return { source: FREITEXT_SOURCE, mode: 'freitext', label: FREITEXT_LABEL };
    }
    if (SOURCE_DEFINITIONS[key]) {
        return { source: key, mode: 'catalog', label: SOURCE_DEFINITIONS[key].label };
    }
    return { error: `Unbekannte Quelle fuer die Soll-Projektion. Erlaubt: ${PROJECTION_SOURCES.map((item) => item.id).join(', ')}.` };
}

/** Leer/null bedeutet CuraFlow (bisheriges Verhalten); unbekannt -> null. */
function normalizeSource(value) {
    const key = String(value == null ? '' : value).trim().toLowerCase();
    if (!key) return DEFAULT_SOURCE;
    return SOURCE_DEFINITIONS[key] ? key : null;
}

function sourceLabel(value) {
    const source = normalizeSource(value);
    return source ? SOURCE_DEFINITIONS[source].label : '';
}

// Kurzzeit-Cache je Quelle (Key: "<source>|<baseUrl>|<pfad>"). Der Katalog
// aendert sich selten, ein Ausfall der Gegenseite darf keine Projekt-
// Zusammenfassung oder Ticket-Planung blockieren. Flow und Index haben
// getrennte Caches, damit ein Fehler der einen Projektion die andere nicht
// verdraengt.
const cache = new Map();
const indexCache = new Map();

function readPositiveInt(raw, fallback) {
    const value = parseInt(String(raw == null ? '' : raw).trim(), 10);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Env wird bei jedem Aufruf gelesen (nicht beim Laden des Moduls), damit
// Konfiguration und Tests nicht auseinanderlaufen.
function readConfig(source) {
    const definition = SOURCE_DEFINITIONS[source] || SOURCE_DEFINITIONS[DEFAULT_SOURCE];
    const prefix = definition.envPrefix;
    return {
        source: definition.id,
        label: definition.label,
        envPrefix: prefix,
        baseUrl: String(process.env[`${prefix}_BASE_URL`] || '').trim().replace(/\/+$/, ''),
        token: String(process.env[`${prefix}_CATALOG_TOKEN`] || '').trim(),
        timeoutMs: readPositiveInt(process.env[`${prefix}_CATALOG_TIMEOUT_MS`], DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        ttlMs: readPositiveInt(process.env[`${prefix}_CATALOG_TTL_MS`], DEFAULT_TTL_MS)
    };
}

function describeError(err) {
    if (!err) return 'unbekannter Fehler';
    return err.message ? String(err.message) : String(err);
}

function isAbortError(err) {
    return Boolean(err) && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR');
}

function isValidCapability(capability) {
    return Boolean(capability)
        && typeof capability === 'object'
        && !Array.isArray(capability)
        && typeof capability.id === 'string'
        && capability.id.trim() !== '';
}

/**
 * Prueft die Form der Antwort, nicht nur den HTTP-Status. Eine 200 ohne
 * capabilities-Array oder mit Eintraegen ohne string-id ist kein Katalog.
 */
function isValidCatalog(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (!Array.isArray(payload.capabilities)) return false;
    return payload.capabilities.every(isValidCapability);
}

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function dedupeNames(values) {
    const seen = new Set();
    const result = [];
    values.forEach((value) => {
        const name = normalizeText(value);
        if (!name) return;
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        result.push(name);
    });
    return result;
}

/**
 * Menschen- und modelllesbare Liste des Katalogs: eine Zeile je Funktion.
 *
 *   - {id} ({module}): {label} / {alias} / {alias}
 *
 * Bewusst nur id, label, aliases, module. preconditions/effects/endpoints und
 * die englische summary bleiben draussen: sonst denkt das Modell ueber
 * Zulaessigkeit statt ueber Ersatz nach.
 *
 * Liefert "" fuer null/undefined/Payload ohne capabilities. Wirft nie.
 */
function formatCatalog(catalog) {
    try {
        if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.capabilities)) return '';
        const lines = [];
        catalog.capabilities.forEach((capability) => {
            if (!isValidCapability(capability)) return;
            const id = normalizeText(capability.id);
            const moduleName = normalizeText(capability.module) || '(ohne Modul)';
            const label = normalizeText(capability.label) || id;
            const aliases = Array.isArray(capability.aliases) ? capability.aliases : [];
            const names = dedupeNames([label].concat(aliases));
            // status "gap" heisst: als fehlend bekannt. Nie als verfuegbar
            // darstellen — der Marker macht die Luecke sichtbar.
            const gapMarker = capability.status === 'gap' ? ' [LUECKE]' : '';
            lines.push(`- ${id} (${moduleName}): ${names.join(' / ')}${gapMarker}`);
        });
        return lines.join('\n');
    } catch (_) {
        return '';
    }
}

async function loadProjection(options, { path = FLOW_PATH, cacheStore = cache, projectionLabel = 'Katalog' } = {}) {
    const force = options && options.force === true;
    const source = normalizeSource(options && options.source);
    if (!source) {
        return {
            catalog: null,
            reason: `Unbekannte Katalogquelle. Erlaubt: ${CAPABILITY_SOURCES.join(', ')}.`
        };
    }
    const config = readConfig(source);

    // Fehlende Basis-URL ist ein unterstuetzter Zustand: die Soll-Planung
    // laeuft ohne Zuordnung weiter.
    if (!config.baseUrl) {
        return {
            catalog: null,
            reason: `${config.envPrefix}_BASE_URL ist nicht gesetzt — der ${projectionLabel} von ${config.label} ist nicht konfiguriert.`
        };
    }

    let url;
    try {
        url = `${config.baseUrl}${path}`;
        // Nur zur Validierung; new URL wirft bei Unsinn.
        void new URL(url);
    } catch (err) {
        return {
            catalog: null,
            reason: `${config.envPrefix}_BASE_URL ist keine gueltige URL (${config.baseUrl}): ${describeError(err)}`
        };
    }

    const cacheKey = `${source}|${config.baseUrl}|${path}`;
    const cached = cacheStore.get(cacheKey);
    if (!force && cached && (Date.now() - cached.at) < config.ttlMs) {
        return { catalog: cached.catalog, reason: null };
    }

    const headers = { Accept: 'application/json' };
    // Der Katalog ist mandantenunabhaengig: Bearer-JWT, kein X-DB-Token.
    // Ohne Token wird der Header weggelassen (kein "Bearer undefined").
    if (config.token) headers.Authorization = `Bearer ${config.token}`;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;

    try {
        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                headers,
                signal: controller ? controller.signal : undefined
            });
        } catch (err) {
            if (isAbortError(err)) {
                return {
                    catalog: null,
                    reason: `Zeitueberschreitung: ${config.label} antwortete nicht innerhalb von ${config.timeoutMs} ms (${url}).`
                };
            }
            return {
                catalog: null,
                reason: `${config.label} ist nicht erreichbar (${url}): ${describeError(err)}`
            };
        }

        if (response.status === 401 || response.status === 403) {
            return {
                catalog: null,
                reason: `Zugriff auf den Funktionskatalog wurde abgelehnt (HTTP ${response.status}). ${config.envPrefix}_CATALOG_TOKEN pruefen — das Token ist moeglicherweise abgelaufen.`
            };
        }

        if (response.status !== 200) {
            return {
                catalog: null,
                reason: `${config.label} antwortete mit HTTP ${response.status} statt 200 (${url}).`
            };
        }

        let payload;
        try {
            payload = await response.json();
        } catch (err) {
            if (isAbortError(err)) {
                return {
                    catalog: null,
                    reason: `Zeitueberschreitung: ${config.label} antwortete nicht innerhalb von ${config.timeoutMs} ms (${url}).`
                };
            }
            return {
                catalog: null,
                reason: `Die Antwort von ${config.label} ist kein gueltiges JSON (${url}): ${describeError(err)}`
            };
        }

        if (!isValidCatalog(payload)) {
            return {
                catalog: null,
                reason: `Unerwartete Form der ${projectionLabel}-Antwort: "capabilities" fehlt oder ist kein Array, oder ein Eintrag hat keine string-"id".`
            };
        }

        cacheStore.set(cacheKey, { catalog: payload, at: Date.now() });
        return { catalog: payload, reason: null };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Holt den Funktionskatalog einer Quelle.
 *
 * @param {{ force?: boolean, source?: 'curaflow'|'schreibdienst' }} [options]
 *        force umgeht den Cache, source waehlt die Quelle (Default curaflow).
 * @returns {Promise<{ catalog: object|null, reason: string|null }>}
 */
async function fetchCatalog(options = {}) {
    try {
        return await loadProjection(options || {}, {
            path: FLOW_PATH,
            cacheStore: cache,
            projectionLabel: 'Funktionskatalog'
        });
    } catch (err) {
        return {
            catalog: null,
            reason: `Unerwarteter Fehler beim Laden des Funktionskatalogs: ${describeError(err)}`
        };
    }
}

/**
 * Holt die Index-Projektion des Funktionskatalogs (Autoritaet fuer die Frage
 * "existiert diese Capability bereits?").
 *
 * Gleicher Vertrag wie fetchCatalog: wirft NIE, liefert { catalog, reason }.
 * Zusaetzlich wird `index` (normalisierte Eintraege) mitgegeben, damit
 * Aufrufer nicht selbst parsen muessen.
 *
 * @param {{ force?: boolean, source?: 'curaflow'|'schreibdienst' }} [options]
 * @returns {Promise<{ catalog: object|null, index: object|null, reason: string|null }>}
 */
async function fetchCapabilityIndex(options = {}) {
    try {
        const result = await loadProjection(options || {}, {
            path: INDEX_PATH,
            cacheStore: indexCache,
            projectionLabel: 'Capability-Index'
        });
        return {
            catalog: result.catalog,
            index: result.catalog ? buildCapabilityIndex(result.catalog) : null,
            reason: result.reason
        };
    } catch (err) {
        return {
            catalog: null,
            index: null,
            reason: `Unerwarteter Fehler beim Laden des Capability-Index: ${describeError(err)}`
        };
    }
}

// ---------------------------------------------------------------------------
// Capability-Lookup (Index-Projektion)
// ---------------------------------------------------------------------------

// Deutsche Schreibweisen vereinheitlichen: Kleinschreibung, Umlaute
// transliterieren, Satzzeichen entfernen, Whitespace kollabieren.
function normalizeCapabilityTerm(value) {
    return String(value == null ? '' : value)
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

// Wortstellungs-unabhaengiger Schluessel: "Qualifikation erteilen" == "erteilen qualifikation".
function capabilitySignature(value) {
    return normalizeCapabilityTerm(value).split(' ').filter(Boolean).sort().join(' ');
}

function normalizeIndexEntry(raw) {
    if (!isValidCapability(raw)) return null;
    const id = normalizeText(raw.id);
    const aliases = dedupeNames(Array.isArray(raw.aliases) ? raw.aliases.map(normalizeText) : []);
    return {
        id,
        // Die Index-Projektion hat kein `label`; der erste Alias ist der
        // deutsche Name, unter dem die Funktion im Alltag auftaucht.
        label: aliases[0] || id,
        aliases,
        module: normalizeText(raw.module) || '(ohne Modul)',
        status: normalizeText(raw.status) || 'draft',
        summary: normalizeText(raw.summary),
        endpoints: Array.isArray(raw.endpoints) ? raw.endpoints.filter(e => typeof e === 'string') : [],
        requiredPermission: normalizeText(raw.requiredPermission) || null
    };
}

/**
 * Baut die normalisierte Index-Sicht. Eintraege ohne id werden ignoriert.
 * Wirft nie; ungueltiger Input ergibt eine leere Liste.
 */
function buildCapabilityIndex(catalog) {
    const capabilities = [];
    if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.capabilities)) {
        return { catalogVersion: null, capabilities };
    }
    catalog.capabilities.forEach((raw) => {
        const entry = normalizeIndexEntry(raw);
        if (entry) capabilities.push(entry);
    });
    return {
        catalogVersion: Number.isFinite(Number(catalog.catalogVersion)) ? Number(catalog.catalogVersion) : null,
        capabilities
    };
}

// Baut die Suchindizes einmal je Katalog-Aufruf. Der Katalog ist klein
// (~100 Eintraege), daher ist Neuaufbau je Lookup unproblematisch.
function buildLookupMaps(catalog) {
    const index = buildCapabilityIndex(catalog);
    const byAlias = new Map();
    const bySignature = new Map();
    const byId = new Map();
    index.capabilities.forEach((entry) => {
        byId.set(entry.id.toLowerCase(), entry);
        // Suchbegriffe werden normalisiert (Punkt -> Leerzeichen), die id ist
        // aber punktiert ("shift.assign"). Beide Schreibweisen hinterlegen,
        // damit capabilityExists("shift.assign") trifft.
        byId.set(normalizeCapabilityTerm(entry.id), entry);
        entry.aliases.forEach((alias) => {
            const key = normalizeCapabilityTerm(alias);
            const signature = capabilitySignature(alias);
            if (key && !byAlias.has(key)) byAlias.set(key, entry);
            if (signature && !bySignature.has(signature)) bySignature.set(signature, entry);
        });
    });
    return { index, byAlias, bySignature, byId };
}

/**
 * Autoritative Existenzpruefung fuer EINE Capability.
 *
 * - Matched gegen deutsche Aliase (exakt oder wortstellungs-unabhaengig),
 *   danach gegen die id (z. B. "shift.assign").
 * - status "gap" bedeutet "bekannt fehlend" und liefert deshalb IMMER null.
 * - Die englische summary ist KEIN Existenzkriterium; sie dient nur der Suche.
 *
 * @param {string} alias
 * @param {{ catalog?: object, source?: string, force?: boolean }} [options]
 *        `catalog` vermeidet einen zweiten Fetch (z. B. wenn der Aufrufer
 *        bereits fetchCapabilityIndex() ausgefuehrt hat).
 * @returns {Promise<{ id: string, label: string, module: string, status: string }|null>}
 */
async function capabilityExists(alias, options = {}) {
    const term = normalizeCapabilityTerm(alias);
    if (!term) return null;
    let catalog = options && options.catalog;
    if (!catalog) {
        const result = await fetchCapabilityIndex(options || {});
        catalog = result.catalog;
    }
    if (!catalog) return null;

    const { byAlias, bySignature, byId } = buildLookupMaps(catalog);
    const match = byAlias.get(term) || bySignature.get(term) || byId.get(term) || null;
    if (!match || match.status === 'gap') return null;
    return { id: match.id, label: match.label, module: match.module, status: match.status };
}

// Token einer Suchanfrage, ohne Fuellwoerter. Deutsche Ticketsprache ist
// artikel- und praepositionslastig; diese Woerter tragen keine Bedeutung.
const SEARCH_STOPWORDS = new Set([
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einen', 'einem', 'eines',
    'und', 'oder', 'fuer', 'mit', 'ohne', 'von', 'vom', 'zum', 'zur', 'im', 'in', 'am', 'an',
    'auf', 'aus', 'bei', 'ist', 'sind', 'wird', 'werden', 'soll', 'sollen', 'kann', 'koennen',
    'bitte', 'neue', 'neuer', 'neues', 'hinzufuegen', 'hinzufugen', 'feature', 'funktion'
]);

function searchTokens(value) {
    return normalizeCapabilityTerm(value)
        .split(' ')
        .filter(token => token.length >= 3 && !SEARCH_STOPWORDS.has(token));
}

function overlapRatio(tokensA, tokensB) {
    if (!tokensA.length || !tokensB.length) return 0;
    const setB = new Set(tokensB);
    const hits = tokensA.filter(token => setB.has(token)).length;
    return hits / Math.min(tokensA.length, tokensB.length);
}

/**
 * Volltextsuche ueber die Index-Capabilities.
 *
 * Aliase (deutsch) sind das primaere Matching-Kriterium; die englische
 * summary wird nur mit deutlich geringerem Gewicht als Fallback herangezogen.
 * gap-Eintraege bleiben in den Ergebnissen sichtbar (status "gap"), damit der
 * Architect eine bekannte Luecke nicht als verfuegbar darstellt.
 *
 * @param {string} query
 * @param {{ catalog?: object, index?: object, source?: string, force?: boolean, limit?: number, phraseOnly?: boolean }} [options]
 *        phraseOnly = nur Treffer, deren Alias vollstaendig in der Anfrage
 *        vorkommt (fuer deterministische Vorpruefung im Ticket-Text).
 * @returns {Promise<Array<{ id: string, label: string, aliases: string[], module: string, status: string, summary: string, score: number }>>}
 */
async function searchCapabilities(query, options = {}) {
    const rawQuery = String(query == null ? '' : query);
    const normalizedQuery = normalizeCapabilityTerm(rawQuery);
    if (!normalizedQuery) return [];

    let catalog = options && (options.index || options.catalog);
    if (!catalog) {
        const result = await fetchCapabilityIndex(options || {});
        catalog = result.catalog;
    }
    if (!catalog) return [];

    const index = options && options.index && Array.isArray(options.index.capabilities)
        ? options.index
        : buildCapabilityIndex(catalog);
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 10;
    const phraseOnly = options.phraseOnly === true;
    const queryTokens = searchTokens(rawQuery);
    const paddedQuery = ` ${normalizedQuery} `;

    const scored = [];
    index.capabilities.forEach((entry) => {
        const aliasKeys = entry.aliases.map(normalizeCapabilityTerm).filter(Boolean);
        let score = 0;

        if (aliasKeys.some(alias => alias === normalizedQuery)) score += 100;
        if (aliasKeys.some(alias => capabilitySignature(alias) === capabilitySignature(normalizedQuery))) score += 95;
        // Wortstellungs-unabhaengig und satzzeichenfrei: der Alias steht als
        // zusammenhaengende Wendung im Ticket-Text.
        if (aliasKeys.some(alias => paddedQuery.includes(` ${alias} `))) score += 80;
        if (entry.id.toLowerCase() === normalizedQuery
            || normalizeCapabilityTerm(entry.id) === normalizedQuery) score += 90;

        if (!phraseOnly) {
            aliasKeys.forEach((alias) => {
                score += Math.round(overlapRatio(queryTokens, searchTokens(alias)) * 55);
            });
            const summaryOverlap = overlapRatio(queryTokens, searchTokens(entry.summary));
            score += Math.round(summaryOverlap * 20);
        }

        if (score <= 0) return;
        scored.push({
            id: entry.id,
            label: entry.label,
            aliases: entry.aliases,
            module: entry.module,
            status: entry.status,
            summary: entry.summary,
            score
        });
    });

    scored.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.id.localeCompare(right.id);
    });
    return scored.slice(0, limit);
}

/** Nur fuer Tests: Caches leeren, damit Faelle sich nicht beeinflussen. */
function clearCatalogCache() {
    cache.clear();
    indexCache.clear();
}

/** Formatiert Treffer fuer Prompt-/Log-Nutzung (eine Zeile je Capability). */
function formatCapabilityMatches(matches) {
    if (!Array.isArray(matches)) return '';
    return matches.map((match) => {
        const names = dedupeNames([match.label].concat(Array.isArray(match.aliases) ? match.aliases : []));
        const gap = match.status === 'gap' ? ' [LUECKE]' : '';
        return `- ${match.id} (${match.module || '(ohne Modul)'}, ${match.status || 'draft'}): ${names.join(' / ')}${gap}`;
    }).join('\n');
}

module.exports = {
    fetchCatalog,
    fetchCapabilityIndex,
    capabilityExists,
    searchCapabilities,
    buildCapabilityIndex,
    formatCapabilityMatches,
    formatCatalog,
    clearCatalogCache,
    isValidCatalog,
    normalizeSource,
    resolveProjectionSource,
    sourceLabel,
    SOURCE_DEFINITIONS,
    CAPABILITY_SOURCES,
    PROJECTION_SOURCES,
    DEFAULT_SOURCE,
    FREITEXT_SOURCE,
    FREITEXT_LABEL,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_TTL_MS,
    FLOW_PATH,
    INDEX_PATH
};
