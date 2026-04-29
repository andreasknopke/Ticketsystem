'use strict';

// Liest README + docs/*.md eines mit dem Ticket verknuepften GitHub-Repos.
// Read-only. Ohne Verknuepfung -> leerer Kontext.

const { Octokit } = require('@octokit/rest');

const MAX_FILES = 30;
const MAX_TOTAL_BYTES = 200 * 1024;     // 200 KB Cap
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

module.exports = { fetchRepoContext };
