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
const EXCLUDED_SEARCH_PATH_RE = /(^|\/)(docs?|tickets?|artifacts?|coverage|dist|build|node_modules|\.git|\.next|\.cache|cache)(\/|$)/i;
const UI_PRIORITY_PATH_RE = /(^|\/)(app|src|components|pages|ui)(\/|$)/i;
const SOURCE_FILE_RE = /\.(tsx|jsx|ts|js|mjs|cjs|css|scss|sass|less|html|ejs)$/i;
const DOC_FILE_RE = /(^|\/)(README|CHANGELOG)\.md$|\.md$/i;
const WEAK_GREP_LINE_RE = /^\s*(import|export)\b|require\(|^\s*\/\/|^\s*\/\*|^\s*\*|^\s*#/;
const UI_PATTERN_HINT_RE = /button|modal|dialog|dropdown|select|input|textarea|checkbox|radio|toggle|label|placeholder|class(name)?|onclick|render|component|page|layout|icon|tooltip|banner|formatier|klassifiz|docx|copy|ui|frontend|css|style/i;
const UI_LINE_HINT_RE = /<button\b|\bbutton\b|onClick=|className=|title=|aria-label=|placeholder=|<label\b|handle[A-Z]\w*|fetch\(|href=|disabled=|type=\"button\"/;

function escapeRegexChar(char) {
    return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function splitBraceOptions(text) {
    const parts = [];
    let current = '';
    let depth = 0;
    for (const char of text) {
        if (char === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        if (char === '{') depth += 1;
        if (char === '}') depth = Math.max(0, depth - 1);
        current += char;
    }
    parts.push(current);
    return parts;
}

// Glob -> RegExp Konvertierung mit Unterstuetzung fuer *, **, ? und {a,b}.
function globToRegex(glob) {
    if (!glob || typeof glob !== 'string') return null;

    function convert(pattern) {
        let out = '';
        for (let i = 0; i < pattern.length; i++) {
            const char = pattern[i];
            const next = pattern[i + 1];

            if (char === '*') {
                if (next === '*') {
                    const afterDoubleStar = pattern[i + 2];
                    if (afterDoubleStar === '/') {
                        out += '(?:.*\/)?';
                        i += 2;
                    } else {
                        out += '.*';
                        i += 1;
                    }
                } else {
                    out += '[^/]*';
                }
                continue;
            }

            if (char === '?') {
                out += '[^/]';
                continue;
            }

            if (char === '{') {
                let depth = 1;
                let j = i + 1;
                while (j < pattern.length && depth > 0) {
                    if (pattern[j] === '{') depth += 1;
                    else if (pattern[j] === '}') depth -= 1;
                    j += 1;
                }
                if (depth === 0) {
                    const body = pattern.slice(i + 1, j - 1);
                    const options = splitBraceOptions(body).map(option => convert(option));
                    out += `(?:${options.join('|')})`;
                    i = j - 1;
                    continue;
                }
            }

            out += escapeRegexChar(char);
        }
        return out;
    }

    return new RegExp('^' + convert(glob) + '$');
}

function safeStr(s, max = 200) {
    if (typeof s !== 'string') return '';
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function looksLikeUiSearch(pattern, glob) {
    const haystack = `${pattern || ''} ${glob || ''}`;
    return UI_PATTERN_HINT_RE.test(haystack);
}

function globExplicitlyTargetsExcluded(glob) {
    if (!glob || typeof glob !== 'string') return false;
    return /(docs?|tickets?|artifacts?|\.md|README|CHANGELOG)/i.test(glob);
}

function shouldIgnoreSearchPath(filePath, glob) {
    if (!filePath) return true;
    if (globExplicitlyTargetsExcluded(glob)) return false;
    if (EXCLUDED_SEARCH_PATH_RE.test(filePath)) return true;
    if (DOC_FILE_RE.test(filePath) && !/package\.json$/i.test(filePath)) return true;
    return false;
}

function scoreCandidatePath(filePath, isUiSearch) {
    let score = 0;
    if (SOURCE_FILE_RE.test(filePath)) score += 60;
    if (/package\.json$/i.test(filePath)) score += 10;
    if (/\.(tsx|jsx)$/i.test(filePath)) score += 40;
    if (/\.(ts|js|ejs|html)$/i.test(filePath)) score += 20;
    if (isUiSearch && UI_PRIORITY_PATH_RE.test(filePath)) score += 140;
    if (isUiSearch && /(^|\/)(lib|hooks)(\/|$)/i.test(filePath)) score += 20;
    if (/(^|\/)(tests?|__tests__|fixtures)(\/|$)/i.test(filePath)) score -= 40;
    return score;
}

function scoreGrepLine(filePath, line, isUiSearch) {
    let score = scoreCandidatePath(filePath, isUiSearch);
    const text = typeof line === 'string' ? line.trim() : '';
    if (!text) return score - 50;
    if (WEAK_GREP_LINE_RE.test(text)) score -= 180;
    if (/^\s*<\/?[A-Z]/.test(text)) score += 10;
    if (isUiSearch && UI_LINE_HINT_RE.test(text)) score += 150;
    if (/\bfunction\b|=>|async function|const\s+handle[A-Z]/.test(text)) score += 20;
    if (/\btitle\s*=|\bplaceholder\s*=|\baria-label\s*=/.test(text)) score += 20;
    return score;
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
        const isUiSearch = looksLikeUiSearch(pattern, glob);
        const tree = await fetchRepoTreeLight(integration, { maxEntries: 2000 });
        const text = typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.join('\n') : String(tree || '');
        let candidates = text.split('\n').filter(p => p && !p.endsWith('/'));
        if (glob) {
            const gre = globToRegex(glob);
            if (gre) candidates = candidates.filter(p => gre.test(p));
        }
        candidates = candidates.filter(filePath => !shouldIgnoreSearchPath(filePath, glob));
        // Bevorzugt relevante Source-Files statt alphabetischem Zufall.
        candidates = candidates
            .map(filePath => ({ filePath, score: scoreCandidatePath(filePath, isUiSearch) }))
            .sort((left, right) => {
                if (right.score !== left.score) return right.score - left.score;
                return left.filePath.localeCompare(right.filePath);
            })
            .map(entry => entry.filePath)
            .slice(0, MAX_GREP_FILES);
        if (!candidates.length) return { result: '(kein Datei-Treffer fuer dieses Glob)' };
        const files = await fetchFilesFromRepo(integration, candidates, { maxBytes: MAX_GREP_BYTES_PER_FILE });
        const hits = [];
        for (const f of files) {
            if (!f.exists || !f.content) continue;
            const lines = f.content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i])) {
                    hits.push({
                        score: scoreGrepLine(f.path, lines[i], isUiSearch),
                        filePath: f.path,
                        lineNumber: i + 1,
                        text: safeStr(lines[i].trim(), 240)
                    });
                }
            }
        }
        if (!hits.length) return { result: `(keine Treffer fuer Pattern "${pattern}" in ${candidates.length} Dateien)` };
        hits.sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            if (left.filePath !== right.filePath) return left.filePath.localeCompare(right.filePath);
            return left.lineNumber - right.lineNumber;
        });
        const topHits = hits.slice(0, MAX_GREP_HITS);
        return {
            result: topHits.map(hit => `${hit.filePath}:${hit.lineNumber}: ${hit.text}`).join('\n'),
            files_searched: candidates.length,
            hit_count: topHits.length,
            truncated: hits.length > MAX_GREP_HITS
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
