'use strict';

// Statische und (optional) dynamische Verifikation der vom Coding-Bot
// vorgeschlagenen Datei-Aenderungen. Wird in execCoding VOR der PR-Erstellung
// aufgerufen. Bei Verstoessen wird kein PR geoeffnet.
//
// Tier 1 (immer):  Per-Datei-Syntax-Check (node --check fuer JS, JSON.parse fuer JSON)
// Tier 2 (opt.):   Lint im sauberen Repo-Klon (AI_CODING_VERIFY_LINT=true)
// Tier 3 (opt.):   Typecheck im sauberen Repo-Klon (AI_CODING_VERIFY_TYPECHECK=true)
// Tier 4 (opt.):   Build im sauberen Repo-Klon (AI_CODING_VERIFY_BUILD=true)
//
// Tier 2-4 brauchen ein verknuepftes GitHub-Repo, einen Token und ausreichend
// Plattenplatz/Netz. Bei jeglichem Setup-Fehler wird der Check als 'skipped'
// markiert (kein PR-Block), die Engine sieht nur 'ok=true' falls keine echten
// Verstoesse gefunden wurden.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const VERIFY_TIMEOUT_MS = parseInt(process.env.AI_CODING_VERIFY_TIMEOUT_MS, 10) || 180_000;
const MAX_OUTPUT = 4_000;

function logCheck(msg, data) {
    const ts = new Date().toISOString();
    if (data !== undefined) console.log(`[CHECK] ${ts} ${msg} | ${typeof data === 'string' ? data : JSON.stringify(data).slice(0, 1000)}`);
    else console.log(`[CHECK] ${ts} ${msg}`);
}

function isJsFile(p) { return /\.(js|mjs|cjs)$/i.test(p); }
function isJsLikeFile(p) { return /\.(js|mjs|cjs|jsx|ts|tsx)$/i.test(p); }
function isJsonFile(p) { return /\.json$/i.test(p); }

function runProc(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const start = Date.now();
        let stdout = '';
        let stderr = '';
        let killed = false;
        const child = spawn(cmd, args, { ...opts, env: { ...process.env, ...(opts.env || {}) } });
        const timer = setTimeout(() => {
            killed = true;
            try { child.kill('SIGKILL'); } catch (_) {}
        }, opts.timeoutMs || VERIFY_TIMEOUT_MS);
        child.stdout?.on('data', d => { stdout += d.toString(); if (stdout.length > MAX_OUTPUT * 4) stdout = stdout.slice(-MAX_OUTPUT * 4); });
        child.stderr?.on('data', d => { stderr += d.toString(); if (stderr.length > MAX_OUTPUT * 4) stderr = stderr.slice(-MAX_OUTPUT * 4); });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, duration_ms: Date.now() - start, killed });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr, duration_ms: Date.now() - start, killed });
        });
    });
}

// ---------- Tier 1: Per-Datei-Syntax ----------

async function checkFileSyntax(file) {
    if (file.action === 'delete') return null;
    if (typeof file.content !== 'string') return null;

    if (isJsonFile(file.path)) {
        try { JSON.parse(file.content); return null; }
        catch (e) { return { type: 'syntax', file: file.path, message: `JSON parse error: ${e.message}` }; }
    }
    if (isJsFile(file.path)) {
        const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wf-syntax-'));
        const tmpFile = path.join(tmp, path.basename(file.path));
        try {
            await fs.promises.writeFile(tmpFile, file.content, 'utf-8');
            const r = await runProc(process.execPath, ['--check', tmpFile], { timeoutMs: 15_000 });
            if (r.code !== 0) {
                const msg = (r.stderr || r.stdout || '').split('\n').slice(0, 6).join('\n').slice(0, MAX_OUTPUT);
                return { type: 'syntax', file: file.path, message: `node --check failed: ${msg}` };
            }
            return null;
        } finally {
            try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch (_) {}
        }
    }
    return null;
}

async function runSyntaxChecks(files) {
    const violations = [];
    for (const f of files || []) {
        try {
            const v = await checkFileSyntax(f);
            if (v) violations.push(v);
        } catch (e) {
            violations.push({ type: 'syntax', file: f?.path, message: `Check-Fehler: ${e.message}` });
        }
    }
    return violations;
}

// ---------- Tier 1b: Lightweight JS/JSX Reference Regression ----------

const JS_KEYWORDS = new Set([
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally',
    'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new',
    'null', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true',
    'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'
]);

const JS_GLOBALS = new Set([
    'Array', 'BigInt', 'Blob', 'Boolean', 'Buffer', 'Date', 'Error', 'Event',
    'File', 'FormData', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise',
    'RegExp', 'Set', 'String', 'Symbol', 'URL', 'URLSearchParams', 'WeakMap',
    'WeakSet', 'console', 'document', 'global', 'globalThis', 'localStorage',
    'module', 'process', 'require', 'sessionStorage', 'window'
]);

function stripJsLiteralsAndComments(code) {
    return String(code || '')
        .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
        .replace(/\/\/.*$/gm, m => ' '.repeat(m.length))
        .replace(/`(?:\\[\s\S]|[^`\\])*`/g, m => ' '.repeat(m.length))
        .replace(/'(?:\\.|[^'\\])*'/g, m => ' '.repeat(m.length))
        .replace(/"(?:\\.|[^"\\])*"/g, m => ' '.repeat(m.length));
}

function addNamesFromList(target, text) {
    String(text || '').split(',').forEach(part => {
        const cleaned = part
            .replace(/=.*$/g, '')
            .replace(/[{}\[\]()]/g, ' ')
            .trim();
        const m = cleaned.match(/(?:\.\.\.)?([A-Za-z_$][\w$]*)$/);
        if (m && !JS_KEYWORDS.has(m[1])) target.add(m[1]);
    });
}

function extractDeclaredIdentifiers(code) {
    const stripped = stripJsLiteralsAndComments(code);
    const declared = new Set(JS_GLOBALS);
    let m;

    const importRe = /^\s*import\s+([^;]+?)\s+from\s+[^;]+/gm;
    while ((m = importRe.exec(stripped)) !== null) {
        const clause = m[1].trim();
        if (clause.startsWith('{')) {
            addNamesFromList(declared, clause.replace(/[{}]/g, '').replace(/\bas\s+([A-Za-z_$][\w$]*)/g, '$1'));
        } else {
            const parts = clause.split(',');
            addNamesFromList(declared, parts[0]);
            if (parts.length > 1) addNamesFromList(declared, parts.slice(1).join(','));
        }
    }

    const requireRe = /\b(?:const|let|var)\s+([^=;\n]+?)\s*=\s*require\s*\(/g;
    while ((m = requireRe.exec(stripped)) !== null) addNamesFromList(declared, m[1]);

    const varRe = /\b(?:const|let|var)\s+([^;\n]+)/g;
    while ((m = varRe.exec(stripped)) !== null) {
        const decl = m[1].split('=')[0];
        addNamesFromList(declared, decl);
    }

    const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g;
    while ((m = fnRe.exec(stripped)) !== null) {
        if (m[1]) declared.add(m[1]);
        addNamesFromList(declared, m[2]);
    }

    const classRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
    while ((m = classRe.exec(stripped)) !== null) declared.add(m[1]);

    const arrowParamsRe = /(?:\(([^)]*)\)|\b([A-Za-z_$][\w$]*))\s*=>/g;
    while ((m = arrowParamsRe.exec(stripped)) !== null) addNamesFromList(declared, m[1] || m[2]);

    const catchRe = /\bcatch\s*\(([^)]*)\)/g;
    while ((m = catchRe.exec(stripped)) !== null) addNamesFromList(declared, m[1]);

    return declared;
}

function extractReferencedIdentifiers(code) {
    const stripped = stripJsLiteralsAndComments(code);
    const refs = new Set();
    const idRe = /\b[A-Za-z_$][\w$]*\b/g;
    let m;
    while ((m = idRe.exec(stripped)) !== null) {
        const name = m[0];
        if (JS_KEYWORDS.has(name)) continue;
        const before = stripped.slice(0, m.index).replace(/\s+$/g, '');
        const after = stripped.slice(idRe.lastIndex).replace(/^\s+/g, '');
        const prev = before[before.length - 1] || '';
        if (prev === '.') continue;                         // property access: obj.foo
        if (after.startsWith(':') && /[{,]$/.test(before)) continue; // object literal key
        refs.add(name);
    }
    return refs;
}

function collectLikelyUndefinedIdentifiers(code) {
    const declared = extractDeclaredIdentifiers(code);
    const refs = extractReferencedIdentifiers(code);
    return [...refs].filter(name => !declared.has(name)).sort();
}

function runReferenceRegressionChecks(files, currentFiles) {
    const violations = [];
    const currentMap = new Map((currentFiles || []).map(f => [f.path, f]));
    for (const f of files || []) {
        if (!f?.path || !isJsLikeFile(f.path) || f.action === 'delete' || typeof f.content !== 'string') continue;
        const before = currentMap.get(f.path)?.content || '';
        const beforeMissing = new Set(collectLikelyUndefinedIdentifiers(before));
        const afterMissing = collectLikelyUndefinedIdentifiers(f.content)
            .filter(name => !beforeMissing.has(name));
        if (afterMissing.length) {
            violations.push({
                type: 'reference',
                file: f.path,
                message: `Neue moeglicherweise undefinierte Identifier: ${afterMissing.slice(0, 20).join(', ')}`
            });
        }
    }
    return violations;
}

// ---------- Tier 2-4: Lint + Typecheck + Build im Repo-Klon ----------

function pickToken(integration) {
    return integration?.access_token || process.env.GITHUB_DEFAULT_TOKEN || null;
}

async function cloneRepo(integration, dest) {
    const token = pickToken(integration);
    if (!token) return { ok: false, reason: 'no_token' };
    const owner = integration.repo_owner;
    const repo = integration.repo_name;
    const branch = integration.default_branch || 'main';
    // x-access-token Schema funktioniert sowohl fuer PATs als auch GitHub-App-Tokens
    const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const r = await runProc('git', ['clone', '--depth', '1', '--branch', branch, url, dest], { timeoutMs: 60_000 });
    if (r.code !== 0) {
        const msg = (r.stderr || r.stdout || '').replace(token, '***').slice(0, MAX_OUTPUT);
        return { ok: false, reason: `git_clone_failed: ${msg}` };
    }
    return { ok: true };
}

async function applyFilesToDir(dir, files) {
    for (const f of files || []) {
        if (!f.path || f.path.includes('..') || f.path.startsWith('/')) continue;
        const target = path.join(dir, f.path);
        if (f.action === 'delete') {
            try { await fs.promises.rm(target, { force: true }); } catch (_) {}
            continue;
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, String(f.content ?? ''), 'utf-8');
    }
}

async function readPackageJson(dir) {
    try {
        const raw = await fs.promises.readFile(path.join(dir, 'package.json'), 'utf-8');
        return JSON.parse(raw);
    } catch (_) { return null; }
}

async function runInstallAndScript(dir, scriptName, label) {
    // npm ci wenn package-lock vorhanden, sonst npm install
    const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
    const installArgs = hasLock
        ? ['ci', '--no-audit', '--no-fund', '--ignore-scripts']
        : ['install', '--no-audit', '--no-fund', '--ignore-scripts'];
    logCheck(`${label}: npm ${installArgs.join(' ')}`);
    const inst = await runProc('npm', installArgs, { cwd: dir, timeoutMs: VERIFY_TIMEOUT_MS });
    if (inst.code !== 0) {
        return {
            name: label,
            status: 'failed',
            duration_ms: inst.duration_ms,
            output_preview: ('npm install failed:\n' + (inst.stderr || inst.stdout)).slice(-MAX_OUTPUT)
        };
    }
    logCheck(`${label}: npm run ${scriptName}`);
    const run = await runProc('npm', ['run', scriptName, '--silent'], { cwd: dir, timeoutMs: VERIFY_TIMEOUT_MS });
    return {
        name: label,
        status: run.code === 0 ? 'ok' : 'failed',
        duration_ms: run.duration_ms + inst.duration_ms,
        output_preview: ((run.stdout || '') + '\n' + (run.stderr || '')).slice(-MAX_OUTPUT),
        killed: run.killed
    };
}

async function runLintTypecheckAndBuild(integration, files, opts) {
    const result = { ran: [], violations: [] };
    const wantLint = opts.lint;
    const wantTypecheck = opts.typecheck;
    const wantBuild = opts.build;
    if (!wantLint && !wantTypecheck && !wantBuild) return result;
    if (!integration?.repo_owner || !integration?.repo_name) {
        result.ran.push({ name: 'lint_build', status: 'skipped', reason: 'no_integration' });
        return result;
    }
    if (!pickToken(integration)) {
        result.ran.push({ name: 'lint_build', status: 'skipped', reason: 'no_token' });
        return result;
    }

    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wf-verify-'));
    try {
        const cloneRes = await cloneRepo(integration, tmp);
        if (!cloneRes.ok) {
            result.ran.push({ name: 'clone', status: 'skipped', reason: cloneRes.reason });
            return result;
        }
        await applyFilesToDir(tmp, files);
        const pkg = await readPackageJson(tmp);
        if (!pkg) {
            result.ran.push({ name: 'lint_build', status: 'skipped', reason: 'no_package_json' });
            return result;
        }
        const scripts = pkg.scripts || {};

        if (wantLint) {
            const scriptName = scripts.lint ? 'lint' : (scripts['lint:check'] ? 'lint:check' : null);
            if (!scriptName) {
                result.ran.push({ name: 'lint', status: 'skipped', reason: 'no_lint_script' });
            } else {
                const r = await runInstallAndScript(tmp, scriptName, 'lint');
                result.ran.push(r);
                if (r.status === 'failed') {
                    result.violations.push({ type: 'lint', message: `npm run ${scriptName} fehlgeschlagen:\n${r.output_preview}` });
                }
            }
        }
        if (wantTypecheck) {
            const scriptName = scripts.typecheck ? 'typecheck' : (scripts['type-check'] ? 'type-check' : null);
            if (!scriptName) {
                result.ran.push({ name: 'typecheck', status: 'skipped', reason: 'no_typecheck_script' });
            } else {
                const r = await runInstallAndScript(tmp, scriptName, 'typecheck');
                result.ran.push(r);
                if (r.status === 'failed') {
                    result.violations.push({ type: 'typecheck', message: `npm run ${scriptName} fehlgeschlagen:\n${r.output_preview}` });
                }
            }
        }
        if (wantBuild) {
            const scriptName = scripts.build ? 'build' : (scripts.compile ? 'compile' : null);
            if (!scriptName) {
                result.ran.push({ name: 'build', status: 'skipped', reason: 'no_build_script' });
            } else {
                const r = await runInstallAndScript(tmp, scriptName, 'build');
                result.ran.push(r);
                if (r.status === 'failed') {
                    result.violations.push({ type: 'build', message: `npm run ${scriptName} fehlgeschlagen:\n${r.output_preview}` });
                }
            }
        }
        return result;
    } finally {
        try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch (_) {}
    }
}

// ---------- Public API ----------

/**
 * Fuehrt Code-Checks gegen die Coding-Bot-Ausgabe aus.
 *  files:       Array {path, action, content}
 *  integration: Repo-Verknuepfung (fuer Lint/Build noetig)
 *  opts:        { lint?: bool, typecheck?: bool, build?: bool, syntax?: bool, references?: bool, currentFiles?: Array }
 * Returns: { ok, violations: [...], ran: [...] }
 */
async function runCodeChecks(files, integration, opts = {}) {
    const enableSyntax = opts.syntax !== false; // default an
    const enableReferenceCheck = opts.references !== false; // default an
    const enableLint = !!opts.lint;
    const enableTypecheck = !!opts.typecheck;
    const enableBuild = !!opts.build;
    const violations = [];
    const ran = [];

    if (enableSyntax) {
        const start = Date.now();
        const syn = await runSyntaxChecks(files);
        ran.push({ name: 'syntax', status: syn.length ? 'failed' : 'ok', duration_ms: Date.now() - start, count: syn.length });
        violations.push(...syn);
    } else {
        ran.push({ name: 'syntax', status: 'skipped', reason: 'disabled' });
    }

    if (enableReferenceCheck) {
        const start = Date.now();
        const refViolations = runReferenceRegressionChecks(files, opts.currentFiles || []);
        ran.push({ name: 'reference_regression', status: refViolations.length ? 'failed' : 'ok', duration_ms: Date.now() - start, count: refViolations.length });
        violations.push(...refViolations);
    } else {
        ran.push({ name: 'reference_regression', status: 'skipped', reason: 'disabled' });
    }

    if (enableLint || enableTypecheck || enableBuild) {
        try {
            const lb = await runLintTypecheckAndBuild(integration, files, { lint: enableLint, typecheck: enableTypecheck, build: enableBuild });
            ran.push(...lb.ran);
            violations.push(...lb.violations);
        } catch (e) {
            ran.push({ name: 'lint_build', status: 'error', reason: e.message });
        }
    }

    return { ok: violations.length === 0, violations, ran };
}

module.exports = { runCodeChecks };
