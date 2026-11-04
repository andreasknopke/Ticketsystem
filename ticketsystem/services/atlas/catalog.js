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
// Bezogen wird bewusst nur die Projektion <basis>/api/catalog/flow. Sie
// enthaelt catalogVersion + capabilities (id, label, aliases, module, status,
// tenantScope, summary) und BEWUSST keine preconditions/effects/endpoints:
// der Soll-Workflow fragt "welche Funktion ersetzt diesen Schritt", nicht
// "darf ich sie ausfuehren".
//
// Vertrag von fetchCatalog: wirft NIE. Jeder Fehlerfall liefert
// { catalog: null, reason } mit einer eigenen Meldung, weil die naechste
// Aktion jeweils anders ist (Konfiguration, Credential, Retry, Melden).

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_TTL_MS = 600000;
const FLOW_PATH = '/api/catalog/flow';
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

// Kurzzeit-Cache je Quelle (Key: "<source>|<baseUrl>"). Der Katalog aendert
// sich selten, ein Ausfall der Gegenseite darf keine Projekt-Zusammenfassung
// blockieren.
const cache = new Map();

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

async function loadCatalog(options) {
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
            reason: `${config.envPrefix}_BASE_URL ist nicht gesetzt — der Funktionskatalog von ${config.label} ist nicht konfiguriert.`
        };
    }

    let url;
    try {
        url = `${config.baseUrl}${FLOW_PATH}`;
        // Nur zur Validierung; new URL wirft bei Unsinn.
        void new URL(url);
    } catch (err) {
        return {
            catalog: null,
            reason: `${config.envPrefix}_BASE_URL ist keine gueltige URL (${config.baseUrl}): ${describeError(err)}`
        };
    }

    const cacheKey = `${source}|${config.baseUrl}`;
    const cached = cache.get(cacheKey);
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
                reason: 'Unerwartete Form der Katalog-Antwort: "capabilities" fehlt oder ist kein Array, oder ein Eintrag hat keine string-"id".'
            };
        }

        cache.set(cacheKey, { catalog: payload, at: Date.now() });
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
        return await loadCatalog(options || {});
    } catch (err) {
        return {
            catalog: null,
            reason: `Unerwarteter Fehler beim Laden des Funktionskatalogs: ${describeError(err)}`
        };
    }
}

/** Nur fuer Tests: Cache leeren, damit Faelle sich nicht beeinflussen. */
function clearCatalogCache() {
    cache.clear();
}

module.exports = {
    fetchCatalog,
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
    FLOW_PATH
};
