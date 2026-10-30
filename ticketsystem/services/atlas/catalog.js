'use strict';

// Client fuer den maschinenlesbaren Funktionskatalog von CuraFlow.
//
// Der Katalog beschreibt, WELCHE Funktionen eine Abteilung kuenftig nutzen
// kann. Er ist damit die Grundlage fuer den SOLL-Workflow ("wie koennte der
// Ablauf kuenftig aussehen"). Fuer den IST-Workflow ist er irrelevant — der
// kommt aus Terminen und Transkripten.
//
// Bezogen wird bewusst nur die Projektion /api/catalog/flow. Sie enthaelt
// catalogVersion + capabilities (id, label, aliases, module, status,
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

// Kurzzeit-Cache. Der Katalog aendert sich selten, ein Ausfall der Gegenseite
// darf keine Projekt-Zusammenfassung blockieren.
const cache = { baseUrl: null, catalog: null, at: 0 };

function readPositiveInt(raw, fallback) {
    const value = parseInt(String(raw == null ? '' : raw).trim(), 10);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Env wird bei jedem Aufruf gelesen (nicht beim Laden des Moduls), damit
// Konfiguration und Tests nicht auseinanderlaufen.
function readConfig() {
    return {
        baseUrl: String(process.env.CURAFLOW_BASE_URL || '').trim().replace(/\/+$/, ''),
        token: String(process.env.CURAFLOW_CATALOG_TOKEN || '').trim(),
        timeoutMs: readPositiveInt(process.env.CURAFLOW_CATALOG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        ttlMs: readPositiveInt(process.env.CURAFLOW_CATALOG_TTL_MS, DEFAULT_TTL_MS)
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
    const config = readConfig();

    // Fehlende Basis-URL ist ein unterstuetzter Zustand: die Soll-Planung
    // laeuft ohne Zuordnung weiter.
    if (!config.baseUrl) {
        return {
            catalog: null,
            reason: 'CURAFLOW_BASE_URL ist nicht gesetzt — der Funktionskatalog ist nicht konfiguriert.'
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
            reason: `CURAFLOW_BASE_URL ist keine gueltige URL (${config.baseUrl}): ${describeError(err)}`
        };
    }

    const cached = !force && cache.baseUrl === config.baseUrl && cache.catalog
        && (Date.now() - cache.at) < config.ttlMs;
    if (cached) return { catalog: cache.catalog, reason: null };

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
                    reason: `Zeitueberschreitung: CuraFlow antwortete nicht innerhalb von ${config.timeoutMs} ms (${url}).`
                };
            }
            return {
                catalog: null,
                reason: `CuraFlow ist nicht erreichbar (${url}): ${describeError(err)}`
            };
        }

        if (response.status === 401 || response.status === 403) {
            return {
                catalog: null,
                reason: `Zugriff auf den Funktionskatalog wurde abgelehnt (HTTP ${response.status}). CURAFLOW_CATALOG_TOKEN pruefen — das Token ist moeglicherweise abgelaufen.`
            };
        }

        if (response.status !== 200) {
            return {
                catalog: null,
                reason: `CuraFlow antwortete mit HTTP ${response.status} statt 200 (${url}).`
            };
        }

        let payload;
        try {
            payload = await response.json();
        } catch (err) {
            if (isAbortError(err)) {
                return {
                    catalog: null,
                    reason: `Zeitueberschreitung: CuraFlow antwortete nicht innerhalb von ${config.timeoutMs} ms (${url}).`
                };
            }
            return {
                catalog: null,
                reason: `Die Antwort von CuraFlow ist kein gueltiges JSON (${url}): ${describeError(err)}`
            };
        }

        if (!isValidCatalog(payload)) {
            return {
                catalog: null,
                reason: 'Unerwartete Form der Katalog-Antwort: "capabilities" fehlt oder ist kein Array, oder ein Eintrag hat keine string-"id".'
            };
        }

        cache.baseUrl = config.baseUrl;
        cache.catalog = payload;
        cache.at = Date.now();
        return { catalog: payload, reason: null };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Holt den Funktionskatalog.
 *
 * @param {{ force?: boolean }} [options] force umgeht den Cache.
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
    cache.baseUrl = null;
    cache.catalog = null;
    cache.at = 0;
}

module.exports = {
    fetchCatalog,
    formatCatalog,
    clearCatalogCache,
    isValidCatalog,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_TTL_MS,
    FLOW_PATH
};
