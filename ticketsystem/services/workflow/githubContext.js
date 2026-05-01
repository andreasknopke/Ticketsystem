'use strict';

// Liest README + docs/*.md eines mit dem Ticket verknuepften GitHub-Repos.
// Read-only. Ohne Verknuepfung -> leerer Kontext.

const { Octokit } = require('@octokit/rest');

const MAX_FILES = 30;
const MAX_TOTAL_BYTES = 100 * 1024;     // 100 KB Cap (nur fetchRepoContext)
const MAX_FILE_BYTES = 30 * 1024;        // 30 KB pro Datei (fuer Coding-Bot)
const MAX_OVERVIEW_BYTES = 8 * 1024;     // 8 KB pro Datei (fuer Architect/Clarifier)
const MAX_OVERVIEW_LINES = 150;          // max Zeilen fuer Overview-Truncation
const DEFAULT_BOUNDARY_FILES = ['package.json', 'server.js'];
const SUBDIR_FALLBACKS = ['ticketsystem', 'src', 'app', 'backend', 'frontend'];

function getOctokit(token) {
    return new Octokit({ auth: token || process.env.GITHUB_DEFAULT_TOKEN || undefined });
}

async function safeGetContent(client, owner, repo, path) {
    try {
        const r = await client.repos.getContent({ owner, repo, path });
        return r.data;
    } catch (e) {
        return null;
    }
}

async function fetchTextFile(client, owner, repo, path) {
    const data = await safeGetContent(client, owner, repo, path);
    if (!data || Array.isArray(data) || data.type !== 'file') return null;
    if (typeof data.size === 'number' && data.size > MAX_FILE_BYTES) return null;
    if (data.content && data.encoding === 'base64') {
        return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, MAX_FILE_BYTES);
    }
    return null;
}

async function listDocsMarkdown(client, owner, repo, basePath = 'docs') {
    const data = await safeGetContent(client, owner, repo, basePath);
    if (!data || !Array.isArray(data)) return [];
    return data.filter(e => e.type === 'file' && /\.md$/i.test(e.name)).slice(0, MAX_FILES);
}

async function fetchRepoContext(integration) {
    if (!integration || !integration.repo_owner || !integration.repo_name) {
        return { repoContext: '', repoDocs: '', source: 'none' };
    }
    const client = getOctokit(integration.access_token);
    const owner = integration.repo_owner;
    const repo = integration.repo_name;

    const parts = [];
    let total = 0;

    const readme = await fetchTextFile(client, owner, repo, 'README.md');
    if (readme) {
        const block = `### README.md\n\n${readme}\n`;
        parts.push(block);
        total += block.length;
    }

    for (const boundaryPath of DEFAULT_BOUNDARY_FILES) {
        if (total >= MAX_TOTAL_BYTES) break;
        const content = await fetchTextFile(client, owner, repo, boundaryPath);
        if (!content) continue;
        const block = `### ${boundaryPath}\n\n${content}\n`;
        parts.push(block);
        total += block.length;
    }

    const docFiles = await listDocsMarkdown(client, owner, repo);
    for (const f of docFiles) {
        if (total >= MAX_TOTAL_BYTES) break;
        const content = await fetchTextFile(client, owner, repo, f.path);
        if (!content) continue;
        const block = `### ${f.path}\n\n${content}\n`;
        parts.push(block);
        total += block.length;
    }

    // Wenn root fast leer ist (Monorepo), finde das erste existierende Subdirectory
    if (total < 5000) {
        const rootContents = await safeGetContent(client, owner, repo, '');
        let foundSub = null;
        if (rootContents && Array.isArray(rootContents)) {
            const dirNames = new Set(rootContents.filter(e => e.type === 'dir').map(e => e.name));
            foundSub = SUBDIR_FALLBACKS.find(s => dirNames.has(s));
        }
        if (foundSub) {
            const sub = foundSub;
            const subReadme = await fetchTextFile(client, owner, repo, `${sub}/README.md`);
            if (subReadme) {
                const block = `### ${sub}/README.md\n\n${subReadme}\n`;
                parts.push(block);
                total += block.length;
            }
            for (const bf of DEFAULT_BOUNDARY_FILES) {
                if (total >= MAX_TOTAL_BYTES) break;
                const content = await fetchTextFile(client, owner, repo, `${sub}/${bf}`);
                if (!content) continue;
                const block = `### ${sub}/${bf}\n\n${content}\n`;
                parts.push(block);
                total += block.length;
            }
            const subDocFiles = await listDocsMarkdown(client, owner, repo, `${sub}/docs`);
            for (const f of subDocFiles) {
                if (total >= MAX_TOTAL_BYTES) break;
                const content = await fetchTextFile(client, owner, repo, f.path);
                if (!content) continue;
                const block = `### ${f.path}\n\n${content}\n`;
                parts.push(block);
                total += block.length;
            }
        }
    }

    const combined = parts.join('\n---\n').slice(0, MAX_TOTAL_BYTES);
    return {
        repoContext: combined,
        repoDocs: combined,
        source: parts.length ? `${owner}/${repo}` : 'none'
    };
}

/**
 * Kuerzt eine Datei auf Overview-Groesse (z.B. fuer Architect/Clarifier).
 * Struktur: Header (Imports/Requires) + Symboldex (Funktionssignaturen + Zeilennummern)
 * + ggf. die letzten Zeilen (module.exports). package.json wird nicht gekuerzt.
 */
function truncateForOverview(file) {
    if (!file || !file.exists || !file.content) return file;
    if (/package\.json$/i.test(file.path)) return file;
    if (file.content.length <= MAX_OVERVIEW_BYTES) return { ...file, truncated: false };

    const lines = file.content.split('\n');
    const parts = [];

    // 1) Header: Zeilen die mit import/require/'use strict'/Kommentaren beginnen
    const headerLines = [];
    let pastHeader = false;
    for (let i = 0; i < lines.length && !pastHeader; i++) {
        const line = lines[i];
        if (/^\s*$/.test(line) || /^['"]use strict['"]/.test(line) ||
            /^(\/\/|#|\/\*|\*\s)/.test(line.trim()) ||
            /^\s*(const|let|var|import|export)\s.*require\s*\(/.test(line) ||
            /^import\s/.test(line.trim()) || /^export\s.*from\s/.test(line.trim())) {
            headerLines.push(line);
        } else if (/^(async\s+)?function\s|^(const|let|var)\s+\w+\s*=\s*(async\s+)?function|^(class\s|module\.exports|exports\.)/.test(line.trim())) {
            pastHeader = true;
        } else {
            headerLines.push(line);
        }
    }
    parts.push(headerLines.join('\n'));

    // 2) Symboldex: Alle Top-Level-Funktionen/Klassen/Exports mit Zeilennummern
    parts.push('\n// === SYMBOL-INDEX ===');
    const symRe = /^(\s*)(async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function|(?:const|let|var)\s+(\w+)\s*=\s*\(.*\)\s*=>|^class\s+(\w+)|module\.exports\s*=\s*\{|module\.exports\.(\w+)\s*=|exports\.(\w+)\s*=|^(export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var))\s+(\w+)/;
    const symbols = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(symRe);
        if (m) {
            const name = m[3] || m[4] || m[5] || m[6] || m[7] || m[8] || m[10] || '';
            const sig = lines[i].trim().slice(0, 120);
            if (name || sig.startsWith('module.exports =') || sig.startsWith('export ')) {
                symbols.push(`L${i + 1}: ${sig}`);
            }
        }
    }
    parts.push(symbols.join('\n'));

    // 3) Letzte Zeilen: module.exports-Block falls vorhanden
    const lastSection = lines.slice(-20).join('\n');
    const hasExports = /module\.exports|exports\.|=.*require\(/.test(lastSection);
    if (hasExports) {
        parts.push('\n// === END OF FILE (last 20 lines) ===');
        parts.push(lastSection);
    }

    const result = parts.join('\n');
    return {
        ...file,
        content: result.slice(0, MAX_OVERVIEW_BYTES * 2) + '\n// ... [truncated for overview — full file available to Coding-Bot]',
        truncated: true
    };
}

module.exports = { fetchRepoContext, commitFilesAsPR, fetchFilesFromRepo, fetchRepoTree, fetchRepoTreeLight, truncateForOverview };

/**
 * Light-Version des Repo-Trees: nutzt Git Trees API mit recursive=1
 * (1 Aufruf statt N Verzeichnis-Abfragen). Liefert eine flache Liste von
 * Pfaden, gefiltert auf relevante Source-Endungen, gecappt bei MAX-Eintraegen.
 *
 * Wird vom Architect (Planning), Integration und Clarifier verwendet, damit
 * sie sehen, welche Files es ueberhaupt gibt — ohne pro Verzeichnis einen
 * separaten API-Call.
 */
async function fetchRepoTreeLight(integration, opts = {}) {
    if (!integration || !integration.repo_owner || !integration.repo_name) return '';
    const client = getOctokit(integration.access_token);
    const owner = integration.repo_owner;
    const repo = integration.repo_name;
    const maxEntries = opts.maxEntries || 400;
    const includeExt = opts.includeExt || /\.(js|mjs|cjs|ts|tsx|jsx|json|ejs|md|sql|yml|yaml|css|html)$/i;
    const skipDirs = opts.skipDirs || /(^|\/)(node_modules|dist|build|coverage|\.git|\.next|\.cache)(\/|$)/i;

    let baseBranch = integration.default_branch || null;
    try {
        if (!baseBranch) {
            const repoInfo = await client.repos.get({ owner, repo });
            baseBranch = repoInfo.data.default_branch || 'main';
        }
        const refData = await client.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
        const commitSha = refData.data.object.sha;
        const commitData = await client.git.getCommit({ owner, repo, commit_sha: commitSha });
        const treeSha = commitData.data.tree.sha;
        const tree = await client.git.getTree({ owner, repo, tree_sha: treeSha, recursive: '1' });
        const files = (tree.data.tree || [])
            .filter(e => e.type === 'blob' && e.path)
            .filter(e => !skipDirs.test(e.path))
            .filter(e => includeExt.test(e.path))
            .map(e => e.path)
            .sort()
            .slice(0, maxEntries);
        return files.join('\n');
    } catch (e) {
        // Fallback: alter, langsamer Pfad
        try { return await fetchRepoTree(integration, 3); } catch (_) { return ''; }
    }
}

/**
 * Laedt den aktuellen Inhalt einer Liste von Dateien aus dem verknuepften Repo.
 * Read-only. Gibt fuer jede Pfad-Eingabe ein Objekt { path, exists, content, truncated } zurueck.
 * Existierende Dateien > MAX_FILE_BYTES werden gekuerzt und mit truncated=true markiert.
 */
async function fetchFilesFromRepo(integration, paths, { maxBytes } = {}) {
    const limit = maxBytes || MAX_FILE_BYTES;
    const safePaths = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p && !p.includes('..')) : [];
    if (!integration || !integration.repo_owner || !integration.repo_name || !safePaths.length) {
        return safePaths.map(p => ({ path: p, exists: false, content: '', truncated: false }));
    }
    const client = getOctokit(integration.access_token);
    const owner = integration.repo_owner;
    const repo = integration.repo_name;
    const out = [];
    for (const path of safePaths.slice(0, 25)) {
        const data = await safeGetContent(client, owner, repo, path);
        if (!data || Array.isArray(data) || data.type !== 'file') {
            out.push({ path, exists: false, content: '', truncated: false });
            continue;
        }
        let content = '';
        let truncated = false;
        if (data.content && data.encoding === 'base64') {
            const full = Buffer.from(data.content, 'base64').toString('utf-8');
            if (full.length > limit) { content = full.slice(0, limit); truncated = true; }
            else content = full;
        }
        out.push({ path, exists: true, content, truncated });
    }
    return out;
}

/**
 * Lädt rekursiv die Verzeichnisstruktur (nur Dateinamen, keine Inhalte).
 * Maximale Tiefe: 3 Ebenen. Ergebnis ist ein formatierter Text-Baum.
 * Spart massiv Tokens im Vergleich zu fetchRepoContext für Coding-Prompts.
 */
async function fetchRepoTree(integration, maxDepth = 3) {
    if (!integration || !integration.repo_owner || !integration.repo_name) return '';
    const client = getOctokit(integration.access_token);
    const owner = integration.repo_owner;
    const repo = integration.repo_name;

    async function listDir(prefix, depth) {
        if (depth > maxDepth) return [];
        const data = await safeGetContent(client, owner, repo, prefix);
        if (!data || !Array.isArray(data)) return [];
        const lines = [];
        const dirs = data.filter(e => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
        const files = data.filter(e => e.type === 'file').sort((a, b) => a.name.localeCompare(b.name));
        for (const f of files.slice(0, 50)) {
            const path = prefix ? `${prefix}/${f.name}` : f.name;
            lines.push(path);
        }
        for (const d of dirs.slice(0, 10)) {
            const path = prefix ? `${prefix}/${d.name}` : d.name;
            const children = await listDir(path, depth + 1);
            if (children.length) {
                lines.push(`${path}/`);
                children.forEach(c => lines.push(`  ${c}`));
            } else {
                lines.push(`${path}/`);
            }
        }
        return lines;
    }

    const tree = await listDir('', 1);
    // Suche nach Subdirectory wie ticketsystem/ und liste es ebenfalls
    const subMatch = tree.find(l => SUBDIR_FALLBACKS.some(s => l === `${s}/`));
    if (subMatch) {
        const subName = subMatch.replace(/\/$/, '');
        const subTree = await listDir(subName, 1);
        subTree.forEach(l => tree.push(l.startsWith(subName) ? l : `  ${l}`));
    }
    return tree.join('\n');
}

/**
 * Erstellt einen Branch, committet Dateien und oeffnet einen Pull Request.
 * Token-Hierarchie: 1) github_integration.access_token (DB) 2) GITHUB_DEFAULT_TOKEN (env)
 * Bei 403 mit DB-Token wird automatisch auf GITHUB_DEFAULT_TOKEN zurückgegriffen.
 */
async function commitFilesAsPR(integration, payload) {
    const log = (msg, data) => console.log(`[GH:PR] ${msg}`, data !== undefined ? JSON.stringify(data).slice(0, 500) : '');
    log(`Start | owner=${integration?.repo_owner} repo=${integration?.repo_name} hasDBToken=${!!integration?.access_token} hasEnvToken=${!!process.env.GITHUB_DEFAULT_TOKEN} branch=${payload.branchName} files=${payload.files?.length}`);
    if (!integration || !integration.repo_owner || !integration.repo_name) {
        throw new Error('Kein Repository verknuepft');
    }

    const primaryToken = integration.access_token;
    const fallbackToken = process.env.GITHUB_DEFAULT_TOKEN;
    if (!primaryToken && !fallbackToken) {
        throw new Error('Kein GitHub-Token mit Schreibrechten verfuegbar');
    }

    async function tryCommit(token, label) {
        log(`Versuche mit ${label} prefix=${token.slice(0, 12)}...`);
        const client = new Octokit({ auth: token });
        const owner = integration.repo_owner;
        const repo = integration.repo_name;

        let baseBranch = integration.default_branch || null;
        if (!baseBranch) {
            const repoInfo = await client.repos.get({ owner, repo });
            baseBranch = repoInfo.data.default_branch || 'main';
            log(`Base-Branch: ${baseBranch}`);
        }

        log(`Hole baseRef...`);
        const baseRef = await client.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
        const baseSha = baseRef.data.object.sha;
        log(`Base SHA: ${baseSha.slice(0, 7)}`);

        let branch = (payload.branchName || `bot/coding-${Date.now()}`).replace(/[^a-zA-Z0-9._\-/]/g, '-').slice(0, 200);
        log(`Erstelle Branch: ${branch}`);
        try {
            await client.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
        } catch (e) {
            if (e.status === 422) {
                log(`Branch existiert bereits, neuer Name`);
                branch = `${branch}-${Date.now()}`;
                await client.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
            } else {
                throw e;
            }
        }
        log(`Branch erstellt: ${branch}`);

        let lastCommitSha = baseSha;
        for (const f of payload.files || []) {
            if (!f.path) continue;
            const action = f.action || 'update';
            log(`  File: ${action} ${f.path} (${(f.content || '').length} bytes)`);
            if (action === 'delete') {
                try {
                    const existing = await client.repos.getContent({ owner, repo, path: f.path, ref: branch });
                    if (!Array.isArray(existing.data) && existing.data.sha) {
                        const r = await client.repos.deleteFile({ owner, repo, path: f.path, branch, message: `bot: delete ${f.path}`, sha: existing.data.sha });
                        lastCommitSha = r.data.commit?.sha || lastCommitSha;
                    }
                } catch (_) {}
                continue;
            }
            let existingSha = undefined;
            try {
                const existing = await client.repos.getContent({ owner, repo, path: f.path, ref: branch });
                if (!Array.isArray(existing.data) && existing.data.sha) existingSha = existing.data.sha;
            } catch (_) {}
            const r = await client.repos.createOrUpdateFileContents({
                owner, repo, path: f.path, branch,
                message: `${payload.commitMessage?.split('\n')[0] || 'bot: changes'} (${f.path})`,
                content: Buffer.from(String(f.content ?? ''), 'utf-8').toString('base64'),
                sha: existingSha
            });
            lastCommitSha = r.data.commit?.sha || lastCommitSha;
        }

        const wantDraft = payload.draft !== false;
        let pr;
        try {
            pr = await client.pulls.create({
                owner, repo,
                title: payload.prTitle || 'Coding-Bot Changes',
                head: branch, base: baseBranch,
                body: payload.prBody || '',
                draft: wantDraft
            });
        } catch (e) {
            if (wantDraft && (e.status === 422 || /draft/i.test(e.message || ''))) {
                log(`Draft-PR nicht unterstuetzt, fallback auf normalen PR`);
                pr = await client.pulls.create({
                    owner, repo,
                    title: payload.prTitle || 'Coding-Bot Changes',
                    head: branch, base: baseBranch,
                    body: payload.prBody || ''
                });
            } else {
                throw e;
            }
        }
        log(`PR ERSTELLT | #${pr.data.number} ${pr.data.html_url} draft=${pr.data.draft}`);
        const labels = Array.isArray(payload.labels) && payload.labels.length
            ? payload.labels
            : ['bot-generated', 'needs-human-review'];
        try {
            await client.issues.addLabels({ owner, repo, issue_number: pr.data.number, labels });
        } catch (e) {
            log(`Label-Vergabe fehlgeschlagen (nicht fatal): ${e.message}`);
        }
        return { prUrl: pr.data.html_url, prNumber: pr.data.number, branch, baseBranch, commitSha: lastCommitSha, draft: pr.data.draft };
    }

    if (primaryToken) {
        try {
            return await tryCommit(primaryToken, 'DB-Token');
        } catch (e) {
            if ((e.status === 403 || e.status === 401) && fallbackToken && fallbackToken !== primaryToken) {
                log(`DB-Token schlug fehl (${e.status}), versuche GITHUB_DEFAULT_TOKEN`);
                return await tryCommit(fallbackToken, 'ENV-Token');
            }
            throw e;
        }
    }
    return await tryCommit(fallbackToken, 'ENV-Token');
}
