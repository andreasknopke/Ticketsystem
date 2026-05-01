'use strict';

// Repo-Resolver-Agent: beantwortet "open_questions" aus den Stages automatisch,
// indem er gezielt Files aus dem Repo nachlaedt. Nur wirklich nicht-beantwortbare
// Fragen (fachliche Entscheidungen) werden an den Menschen weitergereicht.
//
// Iterationen pro Anfrage:    max 3
// Files pro Iteration:        max 5
// Files pro Resolver-Lauf:    max 5 (gesamt, nicht pro Iteration)
// Bytes pro File:             8 KB (gekuertzt fuer Clarifier-Prompt)
//
// Public API:
//   resolveQuestions({ questions, integration, repoTree, staff, aiClient, prompts })
//     -> { answers: [...], unresolved: [...], filesLoaded: [...], iterations: N }

const MAX_ITERATIONS = 3;
const MAX_FILES_TOTAL = parseInt(process.env.CLARIFIER_MAX_FILES, 10) || 10;
const MAX_FILES_PER_ITERATION = parseInt(process.env.CLARIFIER_MAX_FILES_PER_ITER, 10) || 5;
const MAX_FILE_CHARS = 8 * 1024;       // 8 KB pro File fuer Clarifier-Prompt

function log(msg, data) {
    const ts = new Date().toISOString();
    if (data !== undefined) {
        const extra = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 1000);
        console.log(`[CLARIFIER] ${ts} ${msg} | ${extra}`);
    } else {
        console.log(`[CLARIFIER] ${ts} ${msg}`);
    }
}

/**
 * Beantwortet eine Liste offener Fragen automatisch aus dem Repo.
 *
 * @param {Object} args
 * @param {string[]} args.questions               Offene Fragen
 * @param {Object} args.integration               { repo_owner, repo_name, access_token }
 * @param {string} args.repoTree                  Bereits ermittelter Repo-Tree (light)
 * @param {Object} args.staff                     Staff-Eintrag (provider/model fuer den AI-Call)
 * @param {Function} args.callAI                  async ({systemPrompt, userPrompt, json}) => { parsed, text }
 * @param {Function} args.fetchFiles              async (integration, paths) => [{ path, exists, content }]
 * @param {Object} args.prompts                   { CLARIFIER: { system, buildUser } }
 */
async function resolveQuestions({ questions, integration, repoTree, staff, callAI, fetchFiles, prompts }) {
    if (!Array.isArray(questions) || !questions.length) {
        return { answers: [], unresolved: [], filesLoaded: [], iterations: 0 };
    }
    if (!integration || !integration.repo_owner || !integration.repo_name) {
        log(`SKIP no_integration | questions=${questions.length} -> alle als unresolved`);
        return {
            answers: [],
            unresolved: [...questions],
            filesLoaded: [],
            iterations: 0,
            skipped_reason: 'no_repo_integration'
        };
    }

    log(`START | questions=${questions.length} repo=${integration.repo_owner}/${integration.repo_name} treeLen=${(repoTree || '').length}`);

    const loaded = [];               // Array<{path, exists, content}>
    const loadedPaths = new Set();
    let answers = [];
    let unresolved = [];
    let iter = 0;

    let forceAnswer = false;

    for (iter = 1; iter <= MAX_ITERATIONS; iter++) {
        const userPrompt = prompts.CLARIFIER.buildUser({
            questions,
            repoTree,
            loadedFiles: loaded,
            iteration: iter,
            maxIterations: MAX_ITERATIONS,
            forceAnswer: forceAnswer || iter === MAX_ITERATIONS
        });
        log(`Iter ${iter}/${MAX_ITERATIONS} | userPrompt_len=${userPrompt.length} loaded=${loaded.length}`);

        let r;
        try {
            r = await callAI(staff, {
                systemPrompt: prompts.CLARIFIER.system,
                userPrompt,
                json: true
            });
        } catch (e) {
            log(`Iter ${iter} AI-Call FAILED: ${e.message}`);
            unresolved = [...questions];
            break;
        }
        const parsed = r.parsed;
        if (!parsed) {
            log(`Iter ${iter} no_parsed_json | preview=${(r.text || '').slice(0, 200)}`);
            unresolved = [...questions];
            break;
        }

        if (parsed.action === 'request_files' && Array.isArray(parsed.request_paths)) {
            const want = parsed.request_paths
                .filter(p => typeof p === 'string' && p && !p.includes('..'))
                .filter(p => !loadedPaths.has(p))
                .slice(0, MAX_FILES_PER_ITERATION);

            const remainingBudget = MAX_FILES_TOTAL - loaded.length;
            const toFetch = want.slice(0, Math.max(0, remainingBudget));
            log(`Iter ${iter} REQUEST_FILES | requested=${parsed.request_paths.length} new=${want.length} fetch=${toFetch.length} budget_left=${remainingBudget}`);

            if (!toFetch.length) {
                log(`Iter ${iter} BUDGET_EXHAUSTED | force final answer next iter`);
                forceAnswer = true;
                continue;
            }

            try {
                const fetched = await fetchFiles(integration, toFetch);
                fetched.forEach(f => {
                    if (!loadedPaths.has(f.path)) {
                        if (f.content && f.content.length > MAX_FILE_CHARS) {
                            f.content = f.content.slice(0, MAX_FILE_CHARS) + '\n// ... [truncated]';
                            f.truncated = true;
                        }
                        loaded.push(f);
                        loadedPaths.add(f.path);
                    }
                });
                log(`Iter ${iter} FETCHED | files=${fetched.length} existing=${fetched.filter(f => f.exists).length}`);
            } catch (e) {
                log(`Iter ${iter} fetchFiles FAILED: ${e.message}`);
                // weiter — der Modell-Call in der naechsten Iter sieht halt keine neuen Files
            }
            continue;
        }

        if (parsed.action === 'answer') {
            answers = Array.isArray(parsed.answers) ? parsed.answers : [];
            unresolved = Array.isArray(parsed.unresolved) ? parsed.unresolved : [];
            log(`Iter ${iter} ANSWER | answers=${answers.length} unresolved=${unresolved.length}`);
            break;
        }

        log(`Iter ${iter} UNKNOWN_ACTION action="${parsed.action}" | abort`);
        unresolved = [...questions];
        break;
    }

    if (iter > MAX_ITERATIONS) {
        log(`MAX_ITERATIONS_REACHED | questions=${questions.length} answers=${answers.length} — auto-answering remaining with low confidence`);
        const answered = new Set(answers.map(a => String(a.question || '').trim()));
        questions.forEach(q => {
            if (!answered.has(String(q).trim())) {
                answers.push({
                    question: String(q),
                    answer: 'Keine abschliessende Antwort aus dem Repo ermittelbar — der Architect sollte eine angemessene Annahme treffen.',
                    sources: loaded.map(f => f.path),
                    confidence: 'low'
                });
            }
        });
        unresolved = [];
    }

    log(`DONE | iterations=${iter} answers=${answers.length} unresolved=${unresolved.length} filesLoaded=${loaded.length}`);
    return {
        answers,
        unresolved,
        filesLoaded: loaded.map(f => ({ path: f.path, exists: f.exists, size: f.content?.length || 0 })),
        iterations: iter
    };
}

/**
 * Formatiert Clarifier-Antworten als Text-Block fuer den naechsten Stage-Prompt.
 */
function formatAnswersForPrompt(result) {
    if (!result || !Array.isArray(result.answers) || !result.answers.length) return '';
    const lines = [];
    result.answers.forEach((a, i) => {
        lines.push(`${i + 1}. Frage: ${a.question || ''}`);
        lines.push(`   Antwort: ${a.answer || ''}`);
        if (Array.isArray(a.sources) && a.sources.length) {
            lines.push(`   Quellen: ${a.sources.join(', ')}`);
        }
        if (a.confidence) lines.push(`   Confidence: ${a.confidence}`);
    });
    return lines.join('\n');
}

module.exports = { resolveQuestions, formatAnswersForPrompt };
