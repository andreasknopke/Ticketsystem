'use strict';

// Liest README + docs/*.md eines mit dem Ticket verknuepften GitHub-Repos.
// Read-only. Ohne Verknuepfung -> leerer Kontext.

const { Octokit } = require('@octokit/rest');

const MAX_FILES = 30;
const MAX_TOTAL_BYTES = 100 * 1024;     // 100 KB Cap
const MAX_FILE_BYTES = 60 * 1024;       // 60 KB pro Datei
const MAX_TREE_BYTES = 12 * 1024;       // 12 KB Cap fuer Repo-Tree-Liste
const MAX_BOUNDARY_FILES = 8;           // Anzahl zusaetzlicher Schema-/Routen-Dateien

const DEFAULT_BOUNDARY_GLOBS = [
    'package.json',
    'tsconfig.json',
    'prisma/schema.prisma',
    'db/schema.sql',
    'database/schema.sql',
    'schema.sql',
    'src/api/entities.js',
    'src/api/entities.ts',
    'server/routes/*.js',
    'server/routes/*.ts',
    'server/db/schema.sql'
];

function getBoundaryGlobs() {
    const env = process.env.REPO_BOUNDARY_FILES;
    if (env && env.trim()) return env.split(',').map(s => s.trim()).filter(Boolean);
    return DEFAULT_BOUNDARY_GLOBS;
}

function globToRegex(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const withGlobs = escaped.replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*');
    return new RegExp('^' + withGlobs + '$');
}

function pathMatchesAny(path, globs) {
    return globs.some(g => globToRegex(g).test(path));
}

const SKIP_DIR_RE = /^(node_modules|dist|build|out|coverage|\.git|\.next|\.cache|vendor)\//;
const SKIP_FILE_RE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock)$/;

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

async function listDocsMarkdown(client, owner, repo) {
    const data = await safeGetContent(client, owner, repo, 'docs');
    if (!data || !Array.isArray(data)) return [];
    return data.filter(e => e.type === 'file' && /\.md$/i.test(e.name)).slice(0, MAX_FILES);
}

async function fetchLastCommitISO(client, owner, repo, path) {
    try {
        const r = await client.repos.listCommits({ owner, repo, path, per_page: 1 });
        const c = r.data && r.data[0] && r.data[0].commit;
        return (c && (c.committer?.date || c.author?.date)) || null;
    } catch (_) {
        return null;
    }
}

function staleHint(iso) {
    if (!iso) return '';
    const days = (Date.now() - new Date(iso).getTime()) / 86400000;
    if (!isFinite(days) || days < 0) return '';
    const months = Math.floor(days / 30);
    if (days > 365) return ` _(zuletzt geaendert vor ${months} Monaten - moeglicherweise veraltet)_`;
    if (days > 180) return ` _(zuletzt geaendert vor ${months} Monaten)_`;
    return '';
}

async function fetchRepoTree(client, owner, repo, hintBranch) {
    try {
        let branch = hintBranch || null;
        if (!branch) {
            try {
                const repoInfo = await client.repos.get({ owner, repo });
                branch = repoInfo.data.default_branch || 'main';
            } catch (_) { return { paths: [], truncated: false }; }
        }
        const ref = await client.git.getRef({ owner, repo, ref: `heads/${branch}` });
        const sha = ref.data.object.sha;
        const tree = await client.git.getTree({ owner, repo, tree_sha: sha, recursive: 'true' });
        const paths = (tree.data.tree || [])
            .filter(n => n.type === 'blob' && typeof n.path === 'string')
            .map(n => n.path)
            .filter(p => !SKIP_DIR_RE.test(p) && !SKIP_FILE_RE.test(p));
        return { paths, truncated: !!tree.data.truncated };
    } catch (e) {
        return { paths: [], truncated: false, error: e.message };
    }
}

async function fetchRepoContext(integration) {
    if (!integration || !integration.repo_owner || !integration.repo_name) {
        return { repoContext: '', repoDocs: '', repoTree: '', boundaryFiles: [], source: 'none' };
    }
    const client = getOctokit(integration.access_token);
    const owner = integration.repo_owner;
    const repo = integration.repo_name;

    const parts = [];
    let total = 0;

    const readme = await fetchTextFile(client, owner, repo, 'README.md');
    if (readme) {
        const iso = await fetchLastCommitISO(client, owner, repo, 'README.md');
        const block = `### README.md${staleHint(iso)}\n\n${readme}\n`;
        parts.push(block);
        total += block.length;
    }

    const docFiles = await listDocsMarkdown(client, owner, repo);
    for (const f of docFiles) {
        if (total >= MAX_TOTAL_BYTES) break;
        const content = await fetchTextFile(client, owner, repo, f.path);
        if (!content) continue;
        const iso = await fetchLastCommitISO(client, owner, repo, f.path);
        const block = `### ${f.path}${staleHint(iso)}\n\n${content}\n`;
        parts.push(block);
        total += block.length;
    }

    const combined = parts.join('\n---\n').slice(0, MAX_TOTAL_BYTES);

    // Repo-Tree (Quellcode-Struktur, nicht nur Doku)
    const tree = await fetchRepoTree(client, owner, repo, integration.default_branch);
    let treeText = '';
    if (tree.paths.length) {
        const joined = tree.paths.join('\n');
        if (joined.length > MAX_TREE_BYTES) {
            treeText = joined.slice(0, MAX_TREE_BYTES) + '\n... (gekuerzt)';
        } else {
            treeText = joined + (tree.truncated ? '\n... (von GitHub als truncated markiert)' : '');
        }
    }

    // Boundary-Files: Schemata, Routen, Entity-Registry. Source of Truth, nicht Doku.
    const boundaryGlobs = getBoundaryGlobs();
    const boundaryPaths = tree.paths.filter(p => pathMatchesAny(p, boundaryGlobs)).slice(0, MAX_BOUNDARY_FILES);
    const boundaryFiles = [];
    for (const p of boundaryPaths) {
        const c = await fetchTextFile(client, owner, repo, p);
        if (c != null) boundaryFiles.push({ path: p, content: c });
    }

    const hasAnything = parts.length || tree.paths.length || boundaryFiles.length;
    return {
        repoContext: combined,
        repoDocs: combined,
        repoTree: treeText,
        boundaryFiles,
        source: hasAnything ? `${owner}/${repo}` : 'none'
    };
}

module.exports = { fetchRepoContext, commitFilesAsPR, fetchFilesFromRepo };

/**
 * Laedt den aktuellen Inhalt einer Liste von Dateien aus dem verknuepften Repo.
 * Read-only. Gibt fuer jede Pfad-Eingabe ein Objekt { path, exists, content, truncated } zurueck.
 * Existierende Dateien > MAX_FILE_BYTES werden gekuerzt und mit truncated=true markiert.
 */
async function fetchFilesFromRepo(integration, paths) {
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
            if (full.length > MAX_FILE_BYTES) { content = full.slice(0, MAX_FILE_BYTES); truncated = true; }
            else content = full;
        }
        out.push({ path, exists: true, content, truncated });
    }
    return out;
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
