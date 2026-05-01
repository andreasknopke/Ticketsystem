'use strict';

// Architect-Tools fuer den ReAct-Loop in der Planning-Stage.
// Read-only. Tools kapseln githubContext-Aufrufe und liefern token-knappe
// Strings zurueck, damit der Architect bei jedem Loop-Durchlauf gezielt
// nachsehen kann (Symbole, Tabellen, Datei-Inhalte) statt zu raten.

const {
    fetchRepoTreeLight,
    fetchFilesFromRepo
} = require('../workflow/githubContext');

const MAX_GREP_BYTES_PER_FILE = 120 * 1024;    // 120 KB Cap je Datei beim Grep
const MAX_GREP_HITS = 200;                      // max. Treffer im Ergebnis
const MAX_GREP_FILES = 200;                     // max. Dateien je grep-Aufruf
const MAX_READ_LINES = 200;                     // max. Zeilen per read_file
const MAX_LIST_ENTRIES = 200;                   // max. Eintraege in list_dir
const MAX_TREE_ENTRIES = 1000;                  // max. Eintraege in list_tree

// Sehr grobe Glob -> RegExp Konvertierung (* und **). Ausreichend fuer
// Pfade wie "ticketsystem/**/*.js" oder "**/*.md".
function globToRegex(glob) {
    if (!glob || typeof glob !== 'string') return null;
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '@@DOUBLESTAR@@')
        .replace(/\*/g, '[^/]*')
        .replace(/@@DOUBLESTAR@@/g, '.*');
    return new RegExp('^' + escaped + '$');
}

function safeStr(s, max = 200) {
    if (typeof s !== 'string') return '';
    return s.length > max ? s.slice(0, max) + '…' : s;
}

// ---- Tool: list_tree -------------------------------------------------------
async function tool_list_tree({ integration }) {
    if (!integration) return { error: 'Kein Repo-Kontext (integration fehlt)' };
    try {
        const tree = await fetchRepoTreeLight(integration, { maxEntries: MAX_TREE_ENTRIES });
        // fetchRepoTreeLight liefert string oder array — robust normalisieren
        const text = typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.join('\n') : String(tree || '');
        const lines = text.split('\n').slice(0, MAX_TREE_ENTRIES);
        return { result: lines.join('\n'), truncated: lines.length >= MAX_TREE_ENTRIES };
    } catch (e) {
        return { error: `list_tree fehlgeschlagen: ${e.message}` };
    }
}

// ---- Tool: list_dir --------------------------------------------------------
async function tool_list_dir({ integration, path }) {
    if (!integration) return { error: 'Kein Repo-Kontext' };
    if (typeof path !== 'string') return { error: 'Parameter "path" fehlt oder ungueltig' };
    if (path.includes('..')) return { error: 'Pfad-Traversal nicht erlaubt' };
    try {
        const tree = await fetchRepoTreeLight(integration, { maxEntries: MAX_TREE_ENTRIES });
        const text = typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.join('\n') : String(tree || '');
        const prefix = path.replace(/\/+$/, '') + '/';
        const filtered = text.split('\n')
            .filter(p => p && (path === '' || p === path || p.startsWith(prefix)))
            .slice(0, MAX_LIST_ENTRIES);
        if (!filtered.length) return { result: '(keine Eintraege)' };
        return { result: filtered.join('\n'), truncated: filtered.length >= MAX_LIST_ENTRIES };
    } catch (e) {
        return { error: `list_dir fehlgeschlagen: ${e.message}` };
    }
}

// ---- Tool: read_file -------------------------------------------------------
async function tool_read_file({ integration, path, start_line, end_line }) {
    if (!integration) return { error: 'Kein Repo-Kontext' };
    if (typeof path !== 'string' || !path) return { error: 'Parameter "path" fehlt' };
    if (path.includes('..')) return { error: 'Pfad-Traversal nicht erlaubt' };
    try {
        const files = await fetchFilesFromRepo(integration, [path], { maxBytes: MAX_GREP_BYTES_PER_FILE });
        const f = files[0];
        if (!f || !f.exists) return { result: `(Datei "${path}" existiert nicht im Repo)` };
        const allLines = (f.content || '').split('\n');
        let from = Number.isInteger(start_line) && start_line >= 1 ? start_line : 1;
        let to = Number.isInteger(end_line) && end_line >= from ? end_line : (from + MAX_READ_LINES - 1);
        if (to - from + 1 > MAX_READ_LINES) to = from + MAX_READ_LINES - 1;
        const slice = allLines.slice(from - 1, to);
        const numbered = slice.map((l, i) => `${String(from + i).padStart(5, ' ')}: ${l}`).join('\n');
        const note = f.truncated ? '\n[Hinweis: Datei wurde beim Holen am Cap abgeschnitten]' : '';
        return {
            result: `# ${path} (Zeilen ${from}-${Math.min(to, allLines.length)})\n${numbered}${note}`,
            total_lines: allLines.length,
            truncated_at: f.truncated
        };
    } catch (e) {
        return { error: `read_file fehlgeschlagen: ${e.message}` };
    }
}

// ---- Tool: grep ------------------------------------------------------------
// pattern: regex string (case-insensitive)
// glob: optional Pfad-Filter (z.B. "ticketsystem/**/*.js")
async function tool_grep({ integration, pattern, glob }) {
    if (!integration) return { error: 'Kein Repo-Kontext' };
    if (typeof pattern !== 'string' || !pattern) return { error: 'Parameter "pattern" fehlt' };
    let re;
    try { re = new RegExp(pattern, 'i'); }
    catch (e) { return { error: `Ungueltige Regex: ${e.message}` }; }

    try {
        const tree = await fetchRepoTreeLight(integration, { maxEntries: 2000 });
        const text = typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.join('\n') : String(tree || '');
        let candidates = text.split('\n').filter(p => p && !p.endsWith('/'));
        if (glob) {
            const gre = globToRegex(glob);
            if (gre) candidates = candidates.filter(p => gre.test(p));
        }
        // Bevorzugt Source-Files, sonst alphabetisch
        candidates = candidates
            .sort((a, b) => a.localeCompare(b))
            .slice(0, MAX_GREP_FILES);
        if (!candidates.length) return { result: '(kein Datei-Treffer fuer dieses Glob)' };
        const files = await fetchFilesFromRepo(integration, candidates, { maxBytes: MAX_GREP_BYTES_PER_FILE });
        const hits = [];
        for (const f of files) {
            if (!f.exists || !f.content) continue;
            const lines = f.content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i])) {
                    hits.push(`${f.path}:${i + 1}: ${safeStr(lines[i].trim(), 240)}`);
                    if (hits.length >= MAX_GREP_HITS) break;
                }
            }
            if (hits.length >= MAX_GREP_HITS) break;
        }
        if (!hits.length) return { result: `(keine Treffer fuer Pattern "${pattern}" in ${candidates.length} Dateien)` };
        return {
            result: hits.join('\n'),
            files_searched: candidates.length,
            hit_count: hits.length,
            truncated: hits.length >= MAX_GREP_HITS
        };
    } catch (e) {
        return { error: `grep fehlgeschlagen: ${e.message}` };
    }
}

const TOOLS = {
    list_tree: {
        description: 'Listet alle Datei-Pfade im Repo (gefiltert auf Source-Endungen, max ' + MAX_TREE_ENTRIES + ' Eintraege).',
        params: '{}',
        run: tool_list_tree
    },
    list_dir: {
        description: 'Listet Dateien/Verzeichnisse unterhalb eines Pfades.',
        params: '{ "path": "ticketsystem/services/workflow" }',
        run: tool_list_dir
    },
    read_file: {
        description: 'Liest einen Zeilenbereich aus einer Datei (max ' + MAX_READ_LINES + ' Zeilen pro Aufruf). Zeilennummern sind 1-basiert.',
        params: '{ "path": "...", "start_line": 1, "end_line": 200 }',
        run: tool_read_file
    },
    grep: {
        description: 'Sucht ein Regex-Pattern (case-insensitive) im Repo. Optional auf glob einschraenken (z.B. "ticketsystem/**/*.js"). Max ' + MAX_GREP_HITS + ' Treffer aus ' + MAX_GREP_FILES + ' Dateien.',
        params: '{ "pattern": "decideHumanStep|workflow_steps", "glob": "ticketsystem/**/*.js" }',
        run: tool_grep
    }
};

function describeTools() {
    return Object.entries(TOOLS).map(([name, t]) =>
        `- **${name}** — ${t.description}\n  Params: ${t.params}`
    ).join('\n');
}

/**
 * Fuehrt einen einzelnen Tool-Call aus. Liefert IMMER ein Objekt mit
 * `result` ODER `error`. Niemals werfen.
 */
async function runTool({ name, args, integration }) {
    const tool = TOOLS[name];
    if (!tool) return { error: `Unbekanntes Tool: "${name}"` };
    try {
        return await tool.run({ integration, ...(args && typeof args === 'object' ? args : {}) });
    } catch (e) {
        return { error: `Tool "${name}" fehlgeschlagen: ${e.message}` };
    }
}

module.exports = { TOOLS, describeTools, runTool };
