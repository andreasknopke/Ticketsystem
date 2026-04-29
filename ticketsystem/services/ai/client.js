'use strict';

// Einheitlicher AI-Client mit Provider-Abstraktion.
// Provider: deepseek, ollama, openai_local
// Methode: chat({ provider, model, system, user, temperature, maxTokens, json, timeoutMs })
//   -> { text, raw, prompt_tokens, completion_tokens, provider, model, duration_ms }

const env = process.env;

const CONFIG = {
    deepseek: {
        baseUrl: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
        apiKey: env.DEEPSEEK_API_KEY || '',
        defaultModel: env.DEEPSEEK_MODEL || 'deepseek-chat'
    },
    ollama: {
        baseUrl: (env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, ''),
        defaultModel: env.OLLAMA_MODEL || 'llama3.1'
    },
    openai_local: {
        baseUrl: (env.OPENAI_LOCAL_BASE_URL || 'http://localhost:8000/v1').replace(/\/$/, ''),
        apiKey: env.OPENAI_LOCAL_API_KEY || '',
        defaultModel: env.OPENAI_LOCAL_MODEL || 'local-model'
    }
};

const DEFAULT_PROVIDER = env.AI_DEFAULT_PROVIDER || 'deepseek';
const DEFAULT_TIMEOUT = parseInt(env.AI_WORKFLOW_REQUEST_TIMEOUT_MS, 10) || 120000;
const DEFAULT_MAX_TOKENS = parseInt(env.AI_WORKFLOW_MAX_TOKENS, 10) || 2048;

// Allowlist der erlaubten Outbound-Hosts
const ALLOWED_HOSTS = new Set();
Object.values(CONFIG).forEach(c => {
    try { ALLOWED_HOSTS.add(new URL(c.baseUrl).host); } catch (_) {}
});

function assertAllowed(url) {
    const host = new URL(url).host;
    if (!ALLOWED_HOSTS.has(host)) {
        throw new Error(`AI: Host nicht in Allowlist: ${host}`);
    }
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
        clearTimeout(t);
    }
}

async function callOpenAICompatible(provider, opts) {
    const cfg = CONFIG[provider];
    const url = `${cfg.baseUrl}/chat/completions`;
    assertAllowed(url);
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const body = {
        model: opts.model || cfg.defaultModel,
        messages: [
            { role: 'system', content: opts.system || '' },
            { role: 'user', content: opts.user || '' }
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens || DEFAULT_MAX_TOKENS
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    if (opts.extra) Object.assign(body, opts.extra);

    const started = Date.now();
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    }, opts.timeoutMs || DEFAULT_TIMEOUT);
    const duration_ms = Date.now() - started;

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`AI ${provider} HTTP ${resp.status}: ${errText.slice(0, 500)}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    return {
        text,
        raw: data,
        provider,
        model: body.model,
        prompt_tokens: data.usage?.prompt_tokens || null,
        completion_tokens: data.usage?.completion_tokens || null,
        duration_ms
    };
}

async function callOllama(opts) {
    const cfg = CONFIG.ollama;
    const url = `${cfg.baseUrl}/api/chat`;
    assertAllowed(url);
    const body = {
        model: opts.model || cfg.defaultModel,
        messages: [
            { role: 'system', content: opts.system || '' },
            { role: 'user', content: opts.user || '' }
        ],
        stream: false,
        options: {
            temperature: opts.temperature ?? 0.2,
            num_predict: opts.maxTokens || DEFAULT_MAX_TOKENS
        }
    };
    if (opts.json) body.format = 'json';

    const started = Date.now();
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }, opts.timeoutMs || DEFAULT_TIMEOUT);
    const duration_ms = Date.now() - started;

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`AI ollama HTTP ${resp.status}: ${errText.slice(0, 500)}`);
    }
    const data = await resp.json();
    return {
        text: data.message?.content || '',
        raw: data,
        provider: 'ollama',
        model: body.model,
        prompt_tokens: data.prompt_eval_count || null,
        completion_tokens: data.eval_count || null,
        duration_ms
    };
}

async function chat(opts) {
    const provider = opts.provider || DEFAULT_PROVIDER;
    if (!CONFIG[provider]) throw new Error(`AI: Unbekannter Provider "${provider}"`);
    if (provider === 'ollama') return callOllama(opts);
    if (provider === 'deepseek' && !CONFIG.deepseek.apiKey) {
        throw new Error('AI deepseek: DEEPSEEK_API_KEY ist nicht gesetzt');
    }
    return callOpenAICompatible(provider, opts);
}

function tryParseJson(text) {
    if (!text) return null;
    // Strip code fences ```json ... ```
    let s = text.trim();
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) s = fence[1];
    try { return JSON.parse(s); } catch (_) {}
    // Versuche, ersten {...}-Block zu extrahieren
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    return null;
}

async function health() {
    const results = {};
    for (const provider of Object.keys(CONFIG)) {
        try {
            const r = await chat({
                provider,
                user: 'ping',
                system: 'Reply with the single word: pong',
                temperature: 0,
                maxTokens: 8,
                timeoutMs: 10000
            });
            results[provider] = { ok: true, model: r.model, sample: (r.text || '').slice(0, 40) };
        } catch (e) {
            results[provider] = { ok: false, error: e.message };
        }
    }
    return results;
}

function getConfigSummary() {
    return {
        default_provider: DEFAULT_PROVIDER,
        deepseek: { base_url: CONFIG.deepseek.baseUrl, model: CONFIG.deepseek.defaultModel, configured: !!CONFIG.deepseek.apiKey },
        ollama: { base_url: CONFIG.ollama.baseUrl, model: CONFIG.ollama.defaultModel, configured: true },
        openai_local: { base_url: CONFIG.openai_local.baseUrl, model: CONFIG.openai_local.defaultModel, configured: true }
    };
}

module.exports = { chat, health, tryParseJson, getConfigSummary, CONFIG, DEFAULT_PROVIDER };
