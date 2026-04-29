'use strict';

// Liest README + docs/*.md eines mit dem Ticket verknuepften GitHub-Repos.
// Read-only. Ohne Verknuepfung -> leerer Kontext.

const { Octokit } = require('@octokit/rest');

const MAX_FILES = 30;
const MAX_TOTAL_BYTES = 100 * 1024;     // 100 KB Cap
const MAX_FILE_BYTES = 60 * 1024;       // 60 KB pro Datei

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

    const docFiles = await listDocsMarkdown(client, owner, repo);
    for (const f of docFiles) {
        if (total >= MAX_TOTAL_BYTES) break;
        const content = await fetchTextFile(client, owner, repo, f.path);
        if (!content) continue;
        const block = `### ${f.path}\n\n${content}\n`;
        parts.push(block);
        total += block.length;
    }

    const combined = parts.join('\n---\n').slice(0, MAX_TOTAL_BYTES);
    return {
        repoContext: combined,
        repoDocs: combined,
        source: parts.length ? `${owner}/${repo}` : 'none'
    };
}

module.exports = { fetchRepoContext, commitFilesAsPR };

/**
 * Erstellt einen Branch im Repo, committet eine Liste von Dateien und oeffnet
 * einen Pull Request. Benoetigt einen Token mit Schreibrechten (repo).
 *
 * @param {object} integration - github_integration row (repo_owner, repo_name, access_token, default_branch?)
 * @param {object} payload - { branchName, commitMessage, prTitle, prBody, files: [{path, action, content}] }
 * @returns {Promise<{prUrl, prNumber, branch, commitSha}>}
 */
async function commitFilesAsPR(integration, payload) {
    const log = (msg, data) => console.log(`[GH:PR] ${msg}`, data !== undefined ? JSON.stringify(data).slice(0, 500) : '');
    log(`Start | owner=${integration?.repo_owner} repo=${integration?.repo_name} hasToken=${!!integration?.access_token} defaultToken=${!!process.env.GITHUB_DEFAULT_TOKEN} branch=${payload.branchName} files=${payload.files?.length}`);
    if (!integration || !integration.repo_owner || !integration.repo_name) {
        throw new Error('Kein Repository verknuepft');
    }
    const token = integration.access_token || process.env.GITHUB_DEFAULT_TOKEN;
    if (!token) {
        log('ERROR: Kein Token verfügbar (weder access_token noch GITHUB_DEFAULT_TOKEN)');
        throw new Error('Kein GitHub-Token mit Schreibrechten verfuegbar');
    }
    log(`Token source: ${integration.access_token ? 'github_integration' : 'GITHUB_DEFAULT_TOKEN'} prefix=${token.slice(0, 8)}...`);

    const client = new Octokit({ auth: token });
    const owner = integration.repo_owner;
    const repo = integration.repo_name;

    // Default-Branch ermitteln
    let baseBranch = integration.default_branch || null;
    if (!baseBranch) {
        const repoInfo = await client.repos.get({ owner, repo });
        baseBranch = repoInfo.data.default_branch || 'main';
        log(`Base-Branch: ${baseBranch}`);
    }

    // SHA des Default-Branch holen
    log(`Hole baseRef heads/${baseBranch}...`);
    const baseRef = await client.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
    const baseSha = baseRef.data.object.sha;
    log(`Base SHA: ${baseSha.slice(0, 7)}`);

    // Branch anlegen
    let branch = (payload.branchName || `bot/coding-${Date.now()}`).replace(/[^a-zA-Z0-9._\-/]/g, '-').slice(0, 200);
    log(`Erstelle Branch: ${branch}`);
    try {
        await client.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
    } catch (e) {
        log(`Branch existiert bereits, verwende Suffix: ${e.status} ${e.message?.slice(0, 100)}`);
        branch = `${branch}-${Date.now()}`;
        await client.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
    }
    log(`Branch erstellt: ${branch}`);

    // Files committen
    let lastCommitSha = baseSha;
    for (const f of payload.files || []) {
        if (!f.path) { log(`  SKIP file: kein path`, f.action); continue; }
        const action = f.action || 'update';
        log(`  File: ${action} ${f.path} (${(f.content || '').length} bytes)`);
        if (action === 'delete') {
            try {
                const existing = await client.repos.getContent({ owner, repo, path: f.path, ref: branch });
                if (!Array.isArray(existing.data) && existing.data.sha) {
                    const r = await client.repos.deleteFile({
                        owner, repo, path: f.path, branch,
                        message: `${payload.commitMessage || 'bot: changes'} (delete ${f.path})`,
                        sha: existing.data.sha
                    });
                    lastCommitSha = r.data.commit?.sha || lastCommitSha;
                    log(`  DELETE ok: ${f.path}`);
                }
            } catch (_) { log(`  DELETE skip (nicht vorhanden): ${f.path}`); }
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
        log(`  COMMIT ok: ${f.path} sha=${lastCommitSha?.slice(0, 7)}`);
    }

    // Pull Request anlegen
    log(`Erstelle PR: "${(payload.prTitle || '').slice(0, 80)}"`);
    const pr = await client.pulls.create({
        owner, repo,
        title: payload.prTitle || (payload.commitMessage?.split('\n')[0] || 'Coding-Bot Changes'),
        head: branch,
        base: baseBranch,
        body: payload.prBody || ''
    });
    log(`PR ERSTELLT | #${pr.data.number} ${pr.data.html_url}`);

    return {
        prUrl: pr.data.html_url,
        prNumber: pr.data.number,
        branch,
        baseBranch,
        commitSha: lastCommitSha
    };
}
