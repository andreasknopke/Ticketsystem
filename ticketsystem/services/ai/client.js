'use strict';

// Einheitlicher AI-Client mit Provider-Abstraktion.
// Provider: deepseek, ollama (Cloud), openai, openai_local, anthropic, copilot, mistral, openrouter
// Methode: chat({ provider, model, system, user, temperature, maxTokens, json, timeoutMs })
//   -> { text, raw, prompt_tokens, completion_tokens, provider, model, duration_ms }

const env = process.env;

function normalizeApiKey(value) {
    return String(value || '')
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/^Bearer\s+/i, '')
        .trim();
}

const CONFIG = {
    deepseek: {
        baseUrl: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
        apiKey: normalizeApiKey(env.DEEPSEEK_API_KEY),
        defaultModel: env.DEEPSEEK_MODEL || 'deepseek-chat'
    },
    ollama: {
        // Ollama Cloud: https://docs.ollama.com/cloud
        // Direkter Remote-Host ist https://ollama.com/api/chat mit Bearer-Auth.
        // Fuer lokale Ollama-Instanzen kann OLLAMA_BASE_URL weiterhin explizit
        // auf http://localhost:11434 gesetzt werden.
        baseUrl: (env.OLLAMA_BASE_URL || 'https://ollama.com').replace(/\/$/, ''),
        apiKey: normalizeApiKey(env.OLLAMA_API_KEY || env.OLLAMA_CLOUD_API_KEY || env.OLLAMA_TOKEN),
        defaultModel: env.OLLAMA_MODEL || 'gpt-oss:120b'
    },
    openai: {
        baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
        apiKey: normalizeApiKey(env.OPENAI_API_KEY),
        defaultModel: env.OPENAI_MODEL || 'gpt-4.1'
    },
    openai_local: {
        baseUrl: (env.OPENAI_LOCAL_BASE_URL || 'http://localhost:8000/v1').replace(/\/$/, ''),
        apiKey: normalizeApiKey(env.OPENAI_LOCAL_API_KEY),
        defaultModel: env.OPENAI_LOCAL_MODEL || 'local-model'
    },
    anthropic: {
        baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
        apiKey: normalizeApiKey(env.ANTHROPIC_API_KEY),
        defaultModel: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        version: env.ANTHROPIC_VERSION || '2023-06-01'
    },
    copilot: {
        // Inoffizielle Copilot-Chat-API (von Tools wie aider, opencode u.ä. genutzt).
        // Funktioniert nur mit GitHub Copilot Pro/Pro+/Business/Enterprise-Subscription.
        // Auth-Flow: GitHub OAuth-Token (PAT) -> Copilot-Token (kurzlebig) -> Chat.
        baseUrl: (env.COPILOT_BASE_URL || 'https://api.githubcopilot.com').replace(/\/$/, ''),
        tokenUrl: env.COPILOT_TOKEN_URL || 'https://api.github.com/copilot_internal/v2/token',
        githubToken: env.COPILOT_GITHUB_TOKEN || env.GITHUB_DEFAULT_TOKEN || '',
        defaultModel: env.COPILOT_MODEL || 'gpt-4o',
        editorVersion: env.COPILOT_EDITOR_VERSION || 'vscode/1.95.0',
        editorPluginVersion: env.COPILOT_EDITOR_PLUGIN_VERSION || 'copilot-chat/0.22.0'
    },
    mistral: {
        // OpenAI-kompatible API (api.mistral.ai/v1/chat/completions).
        // Sinnvoll fuer Reasoning-lastige Stages wie Integration-Reviewer.
        baseUrl: (env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/$/, ''),
        apiKey: normalizeApiKey(env.MISTRAL_API_KEY),
        defaultModel: env.MISTRAL_MODEL || 'mistral-large-latest'
    },
    openrouter: {
        // OpenRouter nutzt eine OpenAI-kompatible Chat-Completions-API.
        baseUrl: (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
        apiKey: normalizeApiKey(env.OPENROUTER_API_KEY),
        defaultModel: env.OPENROUTER_MODEL || 'lin-2.6'
    },
    clarifai: {
        // OpenAI-kompatibler Endpoint via https://api.clarifai.com/v2/ext/openai/v1
        // Authentifizierung: Authorization: Key YOUR_PAT (nicht Bearer!)
        // Verfügbare Modelle: Kimi-k2.6, GPT-OSS-120B, etc.
        baseUrl: (env.CLARIFAI_BASE_URL || 'https://api.clarifai.com/v2/ext/openai/v1').replace(/\/$/, ''),
        apiKey: normalizeApiKey(env.CLARIFAI_PAT),
        defaultModel: env.CLARIFAI_MODEL || ''
    }
};

const DEFAULT_PROVIDER = env.AI_DEFAULT_PROVIDER || 'deepseek';
const DEFAULT_TIMEOUT = parseInt(env.AI_WORKFLOW_REQUEST_TIMEOUT_MS, 10) || 300000;
// 128k Default fuer grosse Cloud-Provider. Lokale Backends (vLLM,
// openai/openai_local) haben oft engere max_model_len-Limits und MUESSEN per
// provider-spezifischer Env runtergeregelt werden, sonst HTTP 400.
const DEFAULT_MAX_TOKENS = parseInt(env.AI_WORKFLOW_MAX_TOKENS, 10) || 131072;
const PROVIDER_MAX_TOKENS = {
    deepseek: parseInt(env.AI_DEEPSEEK_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS,
    openai: parseInt(env.AI_OPENAI_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS,
    mistral: parseInt(env.AI_MISTRAL_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS,
    openrouter: parseInt(env.AI_OPENROUTER_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS,
    anthropic: parseInt(env.AI_ANTHROPIC_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS,
    copilot: parseInt(env.AI_COPILOT_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS,
    // Lokale Backends: konservativer Default, da typische vLLM-Setups
    // max_model_len = 32768 fahren. Per Env hochregeln, wenn das Modell
    // mehr kann.
    openai_local: parseInt(env.AI_OPENAI_LOCAL_MAX_TOKENS, 10) || 16384,
    ollama: parseInt(env.AI_OLLAMA_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS,
    clarifai: parseInt(env.AI_CLARIFAI_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS
};

function resolveMaxTokens(provider, requested) {
    const cap = PROVIDER_MAX_TOKENS[provider] || DEFAULT_MAX_TOKENS;
    if (!requested) return cap;
    return Math.min(requested, cap);
}

// Allowlist der erlaubten Outbound-Hosts
const ALLOWED_HOSTS = new Set();
Object.values(CONFIG).forEach(c => {
    try { if (c.baseUrl) ALLOWED_HOSTS.add(new URL(c.baseUrl).host); } catch (_) {}
    try { if (c.tokenUrl) ALLOWED_HOSTS.add(new URL(c.tokenUrl).host); } catch (_) {}
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
    if (cfg.apiKey) {
        headers['Authorization'] = provider === 'clarifai' ? `Key ${cfg.apiKey}` : `Bearer ${cfg.apiKey}`;
    }
    const model = opts.model || cfg.defaultModel;
    const body = {
        model,
        messages: [
            { role: 'system', content: opts.system || '' },
            { role: 'user', content: opts.user || '' }
        ],
        temperature: opts.temperature ?? 0.2
    };
    // OpenAI o1, o3, gpt-5 und Varianten benötigen max_completion_tokens statt max_tokens
    const useMaxCompletionTokens = /^(o1|o3|gpt-5)[-\d.]*/.test(model);
    if (useMaxCompletionTokens) {
        body.max_completion_tokens = resolveMaxTokens(provider, opts.maxTokens);
    } else {
        body.max_tokens = resolveMaxTokens(provider, opts.maxTokens);
    }
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
    let text = data.choices?.[0]?.message?.content || '';
    // DeepSeek v4: wenn content leer ist aber reasoning_content existiert,
    // versuche JSON aus den letzten Zeilen des reasoning_content zu extrahieren
    if (!text) {
        const reasoning = data.choices?.[0]?.message?.reasoning_content;
        if (reasoning) {
            // Versuche erst nur den JSON-Block (letzte {..}) zu nehmen
            const jsonBlock = extractFirstJsonObject(reasoning);
            if (jsonBlock) {
                text = jsonBlock;
                console.log(`[AI:DEBUG] Extracted JSON from reasoning_content | len=${text.length}`);
            } else {
                console.log(`[AI:DEBUG] reasoning_content has no JSON | preview=${reasoning.slice(-300)}`);
            }
        } else {
            console.log(`[AI:DEBUG] Empty response | finish_reason=${data.choices[0]?.finish_reason} keys=${Object.keys(data.choices[0]?.message || {}).join(',')}`);
        }
    }
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
    const isCloudHost = new URL(cfg.baseUrl).host === 'ollama.com';
    if (isCloudHost && !cfg.apiKey) {
        throw new Error('AI ollama: OLLAMA_API_KEY ist fuer Ollama Cloud nicht gesetzt');
    }
    const body = {
        model: opts.model || cfg.defaultModel,
        messages: [
            { role: 'system', content: opts.system || '' },
            { role: 'user', content: opts.user || '' }
        ],
        stream: false,
        options: {
            temperature: opts.temperature ?? 0.2,
            num_predict: resolveMaxTokens('ollama', opts.maxTokens)
        }
    };
    if (opts.json) body.format = 'json';

    const started = Date.now();
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    }, opts.timeoutMs || DEFAULT_TIMEOUT);
    const duration_ms = Date.now() - started;

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        if (resp.status === 401 && isCloudHost) {
            throw new Error(`AI ollama HTTP 401: unauthorized (Ollama Cloud: API-Key wurde ${cfg.apiKey ? 'gesendet' : 'nicht gesendet'}; pruefe OLLAMA_API_KEY ohne "Bearer "-Prefix, aktives Abo und Modell "${body.model}")`);
        }
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

let _logTokenUsage = null;

function setTokenLogger(fn) {
    _logTokenUsage = fn;
}

async function chat(opts) {
    const provider = opts.provider || DEFAULT_PROVIDER;
    if (!CONFIG[provider]) throw new Error(`AI: Unbekannter Provider "${provider}"`);
    let result;
    if (provider === 'ollama') result = await callOllama(opts);
    else if (provider === 'anthropic') result = await callAnthropic(opts);
    else if (provider === 'copilot') result = await callCopilot(opts);
    else {
        if (provider === 'deepseek' && !CONFIG.deepseek.apiKey) throw new Error('AI deepseek: DEEPSEEK_API_KEY ist nicht gesetzt');
        if (provider === 'openai' && !CONFIG.openai.apiKey) throw new Error('AI openai: OPENAI_API_KEY ist nicht gesetzt');
        if (provider === 'mistral' && !CONFIG.mistral.apiKey) throw new Error('AI mistral: MISTRAL_API_KEY ist nicht gesetzt');
        if (provider === 'openrouter' && !CONFIG.openrouter.apiKey) throw new Error('AI openrouter: OPENROUTER_API_KEY ist nicht gesetzt');
        if (provider === 'clarifai' && !CONFIG.clarifai.apiKey) throw new Error('AI clarifai: CLARIFAI_PAT ist nicht gesetzt');
        result = await callOpenAICompatible(provider, opts);
    }
    if (_logTokenUsage && result && result.prompt_tokens != null && result.completion_tokens != null) {
        try { _logTokenUsage(result.provider || provider, result.model || opts.model, result.prompt_tokens, result.completion_tokens, result.duration_ms); } catch (_) {}
    }
    return result;
}

// --- Anthropic (Claude) ---
async function callAnthropic(opts) {
    const cfg = CONFIG.anthropic;
    if (!cfg.apiKey) throw new Error('AI anthropic: ANTHROPIC_API_KEY ist nicht gesetzt');
    const url = `${cfg.baseUrl}/v1/messages`;
    assertAllowed(url);
    let userContent = opts.user || '';
    if (opts.json) {
        userContent += '\n\nWichtig: Antworte ausschliesslich mit gueltigem JSON, ohne Markdown-Codeblock und ohne erklaerenden Text davor oder danach.';
    }
    const body = {
        model: opts.model || cfg.defaultModel,
        max_tokens: resolveMaxTokens('anthropic', opts.maxTokens),
        temperature: opts.temperature ?? 0.2,
        system: opts.system || undefined,
        messages: [{ role: 'user', content: userContent }]
    };
    if (opts.extra) Object.assign(body, opts.extra);

    const started = Date.now();
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': cfg.version
        },
        body: JSON.stringify(body)
    }, opts.timeoutMs || DEFAULT_TIMEOUT);
    const duration_ms = Date.now() - started;

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`AI anthropic HTTP ${resp.status}: ${errText.slice(0, 500)}`);
    }
    const data = await resp.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return {
        text,
        raw: data,
        provider: 'anthropic',
        model: body.model,
        prompt_tokens: data.usage?.input_tokens || null,
        completion_tokens: data.usage?.output_tokens || null,
        duration_ms
    };
}

// --- GitHub Copilot (inoffiziell, Best-Effort) ---
// Erfordert COPILOT_GITHUB_TOKEN (GitHub-Token mit Copilot-Subscription).
// Kann brechen, wenn GitHub die internen Endpoints aendert.
let _copilotTokenCache = { token: '', expiresAt: 0 };

async function getCopilotToken() {
    const cfg = CONFIG.copilot;
    if (!cfg.githubToken) {
        throw new Error('AI copilot: COPILOT_GITHUB_TOKEN (oder GITHUB_DEFAULT_TOKEN) ist nicht gesetzt');
    }
    const now = Math.floor(Date.now() / 1000);
    if (_copilotTokenCache.token && _copilotTokenCache.expiresAt - 30 > now) {
        return _copilotTokenCache.token;
    }
    assertAllowed(cfg.tokenUrl);
    const resp = await fetchWithTimeout(cfg.tokenUrl, {
        method: 'GET',
        headers: {
            'Authorization': `token ${cfg.githubToken}`,
            'Accept': 'application/json',
            'Editor-Version': cfg.editorVersion,
            'Editor-Plugin-Version': cfg.editorPluginVersion,
            'User-Agent': 'GithubCopilot/1.0'
        }
    }, 15000);
    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`AI copilot Token-Holen HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = await resp.json();
    if (!data.token) throw new Error('AI copilot: Token-Antwort enthaelt kein "token"-Feld');
    _copilotTokenCache = { token: data.token, expiresAt: data.expires_at || (now + 1500) };
    return data.token;
}

async function callCopilot(opts) {
    const cfg = CONFIG.copilot;
    const token = await getCopilotToken();
    const url = `${cfg.baseUrl}/chat/completions`;
    assertAllowed(url);
    const body = {
        model: opts.model || cfg.defaultModel,
        messages: [
            { role: 'system', content: opts.system || '' },
            { role: 'user', content: opts.user || '' }
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: resolveMaxTokens('copilot', opts.maxTokens),
        stream: false
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    if (opts.extra) Object.assign(body, opts.extra);

    const started = Date.now();
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Editor-Version': cfg.editorVersion,
            'Editor-Plugin-Version': cfg.editorPluginVersion,
            'Copilot-Integration-Id': 'vscode-chat',
            'User-Agent': 'GithubCopilot/1.0',
            'OpenAI-Intent': 'conversation-panel'
        },
        body: JSON.stringify(body)
    }, opts.timeoutMs || DEFAULT_TIMEOUT);
    const duration_ms = Date.now() - started;

    if (resp.status === 401 || resp.status === 403) {
        // Token evtl. abgelaufen -> Cache leeren und einmal wiederholen
        _copilotTokenCache = { token: '', expiresAt: 0 };
    }
    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`AI copilot HTTP ${resp.status}: ${errText.slice(0, 500)}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    return {
        text,
        raw: data,
        provider: 'copilot',
        model: body.model,
        prompt_tokens: data.usage?.prompt_tokens || null,
        completion_tokens: data.usage?.completion_tokens || null,
        duration_ms
    };
}

function tryParseJson(text) {
    if (!text) return null;
    const original = text.trim();
    let s = original;

    // Strip code fences NUR, wenn die Antwort tatsaechlich mit einem Fence
    // beginnt. Sonst wuerde die Regex faelschlich einen INNEREN Code-Block
    // (z. B. ```bash ... ```) aus einem JSON-String-Wert extrahieren und der
    // restliche JSON-Wrapper ginge verloren (Coding-Bot README enthaelt oft
    // eingebettete Fences).
    if (s.startsWith('```')) {
        const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
        if (fenceMatch) {
            s = fenceMatch[1].trim();
        } else {
            // Unvollstaendiger Fence (kein schliessendes ```), trotzdem oeffnenden Marker entfernen
            s = s.replace(/^```(?:json)?\s*/i, '').trim();
        }
    }

    // 1) Direkt versuchen
    try { return JSON.parse(s); } catch (_) {}

    // 2) Sanitize (escaped literal newlines in strings) und direkt versuchen
    const sanitizedFull = sanitizeJsonControlChars(s);
    if (sanitizedFull !== s) {
        try { return JSON.parse(sanitizedFull); } catch (_) {}
    }

    // 3) Erstes {…} extrahieren + parsen + sanitizen
    const braceMatch = extractFirstJsonObject(s);
    if (braceMatch) {
        try { return JSON.parse(braceMatch); } catch (_) {}
        const sanitized = sanitizeJsonControlChars(braceMatch);
        if (sanitized !== braceMatch) {
            try { return JSON.parse(sanitized); } catch (_) {}
        }
        // Auch den extrahierten Block über den vollen Sanitizer jagen
        try { return JSON.parse(sanitizeJsonControlChars(sanitized)); } catch (_) {}
    }

    // 4) Fallback: Sanitizer auf den ganzen vorbereiteten Text + Brace-Extract
    if (sanitizedFull !== s) {
        const braceFromSan = extractFirstJsonObject(sanitizedFull);
        if (braceFromSan) {
            try { return JSON.parse(braceFromSan); } catch (_) {}
        }
    }

    // 5) Letzter Versuch: extractFirstJsonObject direkt auf Original
    //    (falls Fence-Strip o. Sanitizer geschadet hat)
    if (s !== original) {
        const braceOrig = extractFirstJsonObject(original);
        if (braceOrig) {
            try { return JSON.parse(braceOrig); } catch (_) {}
            const sanOrig = sanitizeJsonControlChars(braceOrig);
            if (sanOrig !== braceOrig) {
                try { return JSON.parse(sanOrig); } catch (_) {}
            }
        }
    }

    if (!braceMatch) {
        console.log(`[AI:JSON] No JSON object found in text | text_len=${text.length} first_chars=${s.slice(0, 80).replace(/\n/g, '\\n')}`);
    }

    // Log preview on failure
    console.log(`[AI:JSON] Parse failed | text_len=${text.length} preview=${text.slice(0, 300).replace(/\n/g, '\\n')}`);
    return null;
}

// Escapt rohe Steuerzeichen (LF/CR/TAB) innerhalb von JSON-String-Literalen.
// Ausserhalb von Strings (Whitespace zwischen Tokens) bleiben sie unveraendert.
// Beruecksichtigt Backslash-Escapes, damit \" nicht den String beendet.
function sanitizeJsonControlChars(src) {
    let out = '';
    let inStr = false;
    let escape = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inStr) {
            if (escape) { out += ch; escape = false; continue; }
            if (ch === '\\') { out += ch; escape = true; continue; }
            if (ch === '"') { out += ch; inStr = false; continue; }
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
            // Andere Kontrollzeichen 0x00-0x1F als \uXXXX
            const code = ch.charCodeAt(0);
            if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
            out += ch;
        } else {
            if (ch === '"') { inStr = true; }
            out += ch;
        }
    }
    return out;
}

function extractFirstJsonObject(str) {
    let depth = 0, start = -1;
    let inStr = false, escape = false;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (inStr) {
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === '"') { inStr = false; }
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                return str.substring(start, i + 1);
            }
        }
    }
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
        ollama: { base_url: CONFIG.ollama.baseUrl, model: CONFIG.ollama.defaultModel, configured: new URL(CONFIG.ollama.baseUrl).host !== 'ollama.com' || !!CONFIG.ollama.apiKey },
        openai: { base_url: CONFIG.openai.baseUrl, model: CONFIG.openai.defaultModel, configured: !!CONFIG.openai.apiKey },
        openai_local: { base_url: CONFIG.openai_local.baseUrl, model: CONFIG.openai_local.defaultModel, configured: true },
        anthropic: { base_url: CONFIG.anthropic.baseUrl, model: CONFIG.anthropic.defaultModel, configured: !!CONFIG.anthropic.apiKey },
        copilot: { base_url: CONFIG.copilot.baseUrl, model: CONFIG.copilot.defaultModel, configured: !!CONFIG.copilot.githubToken },
        mistral: { base_url: CONFIG.mistral.baseUrl, model: CONFIG.mistral.defaultModel, configured: !!CONFIG.mistral.apiKey },
        openrouter: { base_url: CONFIG.openrouter.baseUrl, model: CONFIG.openrouter.defaultModel, configured: !!CONFIG.openrouter.apiKey },
        clarifai: { base_url: CONFIG.clarifai.baseUrl, model: CONFIG.clarifai.defaultModel, configured: !!CONFIG.clarifai.apiKey }
    };
}

module.exports = { chat, health, tryParseJson, getConfigSummary, setTokenLogger, CONFIG, DEFAULT_PROVIDER };
