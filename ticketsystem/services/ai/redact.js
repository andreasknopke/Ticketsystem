'use strict';

// Default-Patterns fuer Redaction sensibler Daten.
// Ergebnis ist ein Klartext mit ersetzten Tokens, ausserdem Liste von Hits.

const DEFAULT_PATTERNS = [
    { name: 'email',        regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,                 placeholder: '[REDACTED_EMAIL]' },
    { name: 'jwt',          regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,      placeholder: '[REDACTED_JWT]' },
    { name: 'bearer',       regex: /\bBearer\s+[A-Za-z0-9._\-]+/gi,                                placeholder: '[REDACTED_BEARER]' },
    { name: 'aws_access',   regex: /\bAKIA[0-9A-Z]{16}\b/g,                                        placeholder: '[REDACTED_AWS_KEY]' },
    { name: 'aws_secret',   regex: /(?<=aws_secret_access_key\s*[:=]\s*['"]?)[A-Za-z0-9/+=]{40}/gi, placeholder: '[REDACTED_AWS_SECRET]' },
    { name: 'github_pat',   regex: /\bghp_[A-Za-z0-9]{20,}\b/g,                                    placeholder: '[REDACTED_GITHUB_PAT]' },
    { name: 'github_oauth', regex: /\bgho_[A-Za-z0-9]{20,}\b/g,                                    placeholder: '[REDACTED_GITHUB_OAUTH]' },
    { name: 'openai_key',   regex: /\bsk-[A-Za-z0-9]{20,}\b/g,                                     placeholder: '[REDACTED_OPENAI_KEY]' },
    { name: 'generic_apikey', regex: /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*['"]?[A-Za-z0-9._\-]{8,}['"]?/gi, placeholder: '[REDACTED_SECRET]' },
    { name: 'iban',         regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b/g,         placeholder: '[REDACTED_IBAN]' },
    { name: 'credit_card',  regex: /\b(?:\d[ -]*?){13,19}\b/g,                                     placeholder: '[REDACTED_CC]' },
    { name: 'ipv4',         regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g, placeholder: '[REDACTED_IPV4]' },
    { name: 'ipv6',         regex: /\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b/gi,                   placeholder: '[REDACTED_IPV6]' },
    { name: 'phone_intl',   regex: /(?:(?<=^)|(?<=\s|[(:,;]))\+?\d{1,3}[\s\-./]?\(?\d{2,4}\)?[\s\-./]?\d{3,4}[\s\-./]?\d{2,4}/g, placeholder: '[REDACTED_PHONE]' }
];

let extraPatterns = [];

function loadExtraPatternsFromFile(filePath) {
    if (!filePath) return;
    try {
        const fs = require('fs');
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(data)) return;
        extraPatterns = data
            .filter(p => p && p.regex && p.placeholder)
            .map(p => ({
                name: p.name || 'custom',
                regex: new RegExp(p.regex, p.flags || 'g'),
                placeholder: p.placeholder
            }));
        console.log(`Redaction: ${extraPatterns.length} zusaetzliche Patterns geladen aus ${filePath}`);
    } catch (e) {
        console.error('Redaction: Konnte Pattern-Datei nicht laden:', e.message);
    }
}

function redact(text) {
    if (!text || typeof text !== 'string') return { redacted: text || '', hits: [] };
    let out = text;
    const hits = [];
    [...DEFAULT_PATTERNS, ...extraPatterns].forEach(p => {
        const before = out;
        out = out.replace(p.regex, (m) => {
            hits.push({ name: p.name, sample: m.length > 32 ? m.slice(0, 12) + '…' : m });
            return p.placeholder;
        });
        if (before !== out) { /* matched */ }
    });
    return { redacted: out, hits };
}

function redactObject(obj, fields) {
    const result = {};
    const allHits = [];
    fields.forEach(f => {
        const r = redact(obj[f]);
        result[f] = r.redacted;
        if (r.hits.length) allHits.push({ field: f, hits: r.hits });
    });
    return { values: result, hits: allHits };
}

module.exports = { redact, redactObject, loadExtraPatternsFromFile };
