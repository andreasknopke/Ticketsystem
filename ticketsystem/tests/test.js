// Tests für das Ticketsystem
// Aufruf: node tests/test.js
// Startet den Server, führt Tests aus, stoppt den Server

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const BASE = 'http://localhost:8010';
let serverProcess = null;
let failures = 0;
let passed = 0;

function log(emoji, msg) {
    console.log(`  ${emoji} ${msg}`);
}

function ok(msg) { passed++; log('✅', msg); }
function fail(msg) { failures++; log('❌', msg); }

function assert(condition, msg) {
    if (condition) ok(msg);
    else fail(msg);
}

function request(method, path, data, cookie) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'localhost', port: 8010, path, method,
            headers: {}
        };
        if (cookie) opts.headers['Cookie'] = cookie;
        if (data && (method === 'POST' || method === 'PATCH')) {
            if (typeof data === 'object' && path.startsWith('/api/')) {
                const body = JSON.stringify(data);
                opts.headers['Content-Type'] = 'application/json';
                opts.headers['Content-Length'] = Buffer.byteLength(body);
                opts.body = body;
            } else if (typeof data === 'object') {
                const body = new URLSearchParams(data).toString();
                opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                opts.headers['Content-Length'] = Buffer.byteLength(body);
                opts.body = body;
            }
        }
        const req = http.request(opts, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { body = JSON.parse(body); } catch(e) {}
                resolve({ status: res.statusCode, body, cookie: res.headers['set-cookie'] });
            });
        });
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

function parseCookie(sc) {
    if (!sc) return '';
    return sc.map(c => c.split(';')[0]).join('; ');
}

async function login() {
    const page = await request('GET', '/login');
    const match = (typeof page.body === 'string' ? page.body : '').match(/name="_csrf" value="([^"]+)"/);
    const csrf = match ? match[1] : '';
    const jar = parseCookie(page.cookie);
    const loginResp = await request('POST', '/login', { username:'admin', password:'ticketmaster', _csrf:csrf }, jar);
    return parseCookie(loginResp.cookie) || jar;
}

async function main() {
    console.log('\n🧪  Ticketsystem Test Suite');
    console.log('═══════════════════════════\n');

    // --- Auth Tests ---
    console.log('📌 Auth');
    const jar = await login();
    assert(jar.length > 0, 'Login erfolgreich');

    // --- API: Projects ---
    console.log('\n📌 API: Projekte');
    let resp = await request('GET', '/api/projects', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body) && resp.body.length >= 2, 'GET /api/projects (' + (resp.body.length || 0) + ' Projekte)');

    resp = await request('GET', '/api/projects/1', null, jar);
    assert(resp.status === 200 && resp.body.name === 'CuraFlow', 'GET /api/projects/1 (CuraFlow)');

    resp = await request('POST', '/api/projects', { name:'Test-Projekt', description:'Test', system_id:1, status:'planning' }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/projects (erstellt)');
    const testProjId = resp.body.id;

    resp = await request('PATCH', '/api/projects/' + testProjId, { status:'active' }, jar);
    assert(resp.status === 200 && resp.body.status === 'updated', 'PATCH /api/projects/' + testProjId);

    // --- API: Milestones ---
    console.log('\n📌 API: Meilensteine');
    resp = await request('GET', '/api/projects/1/milestones', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body) && resp.body.length === 6, 'GET /api/projects/1/milestones (6 Meilensteine)');

    resp = await request('POST', '/api/projects/1/milestones', { title:'Test-Meilenstein', phase:1, status:'pending' }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/projects/1/milestones (erstellt)');
    const msId = resp.body.id;

    resp = await request('PATCH', '/api/milestones/' + msId, { status:'completed' }, jar);
    assert(resp.status === 200, 'PATCH /api/milestones/' + msId + ' (Status auf completed)');

    resp = await request('DELETE', '/api/milestones/' + msId, null, jar);
    assert(resp.status === 200, 'DELETE /api/milestones/' + msId);

    // --- API: Key Users ---
    console.log('\n📌 API: Key-User');
    resp = await request('GET', '/api/projects/1/keyusers', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body) && resp.body.length >= 2, 'GET /api/projects/1/keyusers (' + (resp.body.length || 0) + ' Key-User)');

    resp = await request('POST', '/api/projects/1/keyusers', { staff_id:3, role:'evaluator' }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/projects/1/keyusers (erstellt)');
    const kuId = resp.body.id;

    resp = await request('DELETE', '/api/keyusers/' + kuId, null, jar);
    assert(resp.status === 200, 'DELETE /api/keyusers/' + kuId);

    // --- API: Documents ---
    console.log('\n📌 API: Wiki-Dokumente');
    resp = await request('GET', '/api/projects/1/docs', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body) && resp.body.length >= 2, 'GET /api/projects/1/docs (' + (resp.body.length || 0) + ' Seiten)');

    resp = await request('GET', '/api/projects/1/docs/einleitung', null, jar);
    assert(resp.status === 200 && resp.body.title === 'Einleitung', 'GET /api/projects/1/docs/einleitung');

    resp = await request('POST', '/api/projects/1/docs', { title:'Test', slug:'test-page', content:'# Test\n\nTest content' }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/projects/1/docs (erstellt)');
    const docId = resp.body.id;

    resp = await request('PATCH', '/api/docs/' + docId, { content:'# Updated' }, jar);
    assert(resp.status === 200, 'PATCH /api/docs/' + docId);

    resp = await request('DELETE', '/api/docs/' + docId, null, jar);
    assert(resp.status === 200, 'DELETE /api/docs/' + docId);

    // --- API: GitHub ---
    console.log('\n📌 API: GitHub');
    resp = await request('GET', '/api/projects/1/github', null, jar);
    assert(resp.status === 200, 'GET /api/projects/1/github');

    resp = await request('POST', '/api/projects/1/github', {
        repo_owner:'test-owner', repo_name:'test-repo', access_token:'ghp_test',
        webhook_secret:'test-secret', sync_issues:1, sync_wiki:0
    }, jar);
    assert(resp.status === 200 || resp.status === 201, 'POST /api/projects/1/github (konfiguriert)');

    // --- API: Markdown ---
    console.log('\n📌 API: Markdown');
    resp = await request('POST', '/api/markdown/render', { text:'# Hello\n\n**bold** text' }, jar);
    assert(resp.status === 200 && resp.body.html && resp.body.html.includes('<h1'), 'POST /api/markdown/render (Markdown -> HTML)');

    // --- Web UI: Pages ---
    console.log('\n📌 Web UI: Seiten');
    const pages = [
        ['/', '/'],
        ['/projects', '/projects'],
        ['/project/1', '/project/1'],
        ['/project/1/timeline', '/project/1/timeline'],
        ['/project/1/milestones', '/project/1/milestones'],
        ['/project/1/keyusers', '/project/1/keyusers'],
        ['/project/1/docs', '/project/1/docs'],
        ['/project/1/docs/einleitung', '/project/1/docs/einleitung'],
        ['/project/1/github', '/project/1/github'],
        ['/ticket/new', '/ticket/new'],
        ['/features', '/features'],
        ['/stats', '/stats'],
        ['/admin/systems', '/admin/systems'],
        ['/admin/staff', '/admin/staff'],
        ['/account', '/account'],
    ];
    for (const [name, url] of pages) {
        resp = await request('GET', url, null, jar);
        assert(resp.status === 200, name + ' (200 OK)');
    }

    // --- API: Tickets ---
    console.log('\n📌 API: Tickets');
    resp = await request('GET', '/api/tickets', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body), 'GET /api/tickets (' + resp.body.length + ' Tickets)');

    resp = await request('POST', '/api/tickets', {
        type:'bug', title:'Test-Bug', description:'Test-Beschreibung',
        priority:'hoch', urgency:'normal', system_id:1
    }, jar);
    assert(resp.status === 201 && resp.body.id, 'POST /api/tickets (erstellt)');
    assert(/^[0-9a-f-]{36}$/i.test(resp.body.id), 'POST /api/tickets liefert UUID als Ticket-ID');
    const ticketId = resp.body.id;

    resp = await request('GET', '/api/tickets/' + ticketId, null, jar);
    assert(resp.status === 200 && resp.body.title === 'Test-Bug', 'GET /api/tickets/' + ticketId);

    resp = await request('GET', '/api/tickets/' + ticketId + '/workflow', null, jar);
    assert(resp.status === 200, 'GET /api/tickets/' + ticketId + '/workflow');

    resp = await request('PATCH', '/api/tickets/' + ticketId, { status:'in_bearbeitung' }, jar);
    assert(resp.status === 200, 'PATCH /api/tickets/' + ticketId + ' (Status geändert)');

    resp = await request('DELETE', '/api/tickets/' + ticketId, null, jar);
    assert(resp.status === 200, 'DELETE /api/tickets/' + ticketId);

    // --- API: Features (geplante / verworfene Features je System) ---
    console.log('\n📌 API: Features');
    resp = await request('GET', '/api/features', null, jar);
    assert(resp.status === 200 && Array.isArray(resp.body), 'GET /api/features (' + (resp.body.length || 0) + ' Features)');

    resp = await request('POST', '/api/tickets', {
        type:'feature', title:'Test-Feature', description:'Feature-Beschreibung',
        priority:'mittel', urgency:'normal', system_id:1
    });
    assert(resp.status === 201 && resp.body.id, 'POST /api/tickets (Feature erstellt)');
    const featureId = resp.body.id;

    resp = await request('GET', '/api/tickets/' + featureId, null, jar);
    assert(resp.status === 200 && resp.body.feature_decision === 'pending', 'Neues Feature startet in der Inbox (pending)');

    resp = await request('PATCH', '/api/tickets/' + featureId, { feature_decision:'planned' }, jar);
    assert(resp.status === 200 && resp.body.status === 'updated', 'PATCH feature_decision=planned');

    resp = await request('GET', '/api/features?system_id=1&decision=planned', null, jar);
    assert(resp.status === 200 && resp.body.some(f => f.id === featureId), 'Geplantes Feature liegt im Ordner "planned"');

    resp = await request('PATCH', '/api/tickets/' + featureId, { feature_decision:'rejected', feature_reason:'Zu aufwaendig' }, jar);
    assert(resp.status === 200, 'PATCH feature_decision=rejected');

    resp = await request('GET', '/api/features?system_id=1&decision=rejected', null, jar);
    assert(resp.status === 200 && resp.body.some(f => f.id === featureId), 'Verworfenes Feature liegt im Ordner "rejected"');

    resp = await request('GET', '/api/tickets/' + featureId, null, jar);
    assert(resp.status === 200 && resp.body.status === 'verworfen', 'Verworfenes Feature verlaesst den aktiven Backlog (status verworfen)');
    assert(resp.body.discard_reason === 'Zu aufwaendig', 'Verwerfungsgrund wird gespeichert');

    resp = await request('PATCH', '/api/features/' + featureId + '/decision', { decision:'planned' }, jar);
    assert(resp.status === 200 && resp.body.feature_decision === 'planned', 'Verworfenes Feature kann in den Plan verschoben werden');

    resp = await request('GET', '/api/tickets/' + featureId, null, jar);
    assert(resp.status === 200 && resp.body.status === 'offen', 'Reaktiviertes Feature ist wieder aktiv (offen)');

    resp = await request('PATCH', '/api/tickets/' + featureId, { feature_decision:'nonsense' }, jar);
    assert(resp.status === 400, 'Ungueltige feature_decision wird abgelehnt');

    resp = await request('DELETE', '/api/tickets/' + featureId, null, jar);
    assert(resp.status === 200, 'DELETE /api/tickets/' + featureId + ' (Feature aufgeraeumt)');

    // --- API: Plan-Reihenfolge (Prioritaet per Drag & Drop) ---
    console.log('\n📌 API: Feature-Prioritaet (Reihenfolge)');
    // Eigenes System anlegen, damit die Reihenfolge unabhaengig von Seed-Daten ist.
    resp = await request('POST', '/api/systems', { name:'Reorder-Test-System' }, jar);
    assert(resp.status === 200 && resp.body.id, 'POST /api/systems (Test-System fuer Reihenfolge)');
    const reorderSystemId = resp.body.id;

    const makePlanned = async (title) => {
        const created = await request('POST', '/api/tickets', {
            type:'feature', title, description:'x', priority:'mittel', system_id:reorderSystemId
        });
        const decided = await request('PATCH', '/api/features/' + created.body.id + '/decision', { decision:'planned' }, jar);
        return { id: created.body.id, decided };
    };

    const f1 = await makePlanned('Reorder A');
    const f2 = await makePlanned('Reorder B');
    const f3 = await makePlanned('Reorder C');
    assert(f1.decided.status === 200 && f2.decided.status === 200 && f3.decided.status === 200, 'Drei Features eingeplant');

    resp = await request('GET', '/api/features?system_id=' + reorderSystemId + '&decision=planned', null, jar);
    assert(resp.status === 200 && resp.body.length === 3, 'GET /api/features listet 3 geplante Features');
    assert(resp.body.map(f => f.id).join(',') === [f1.id, f2.id, f3.id].join(','), 'Reihenfolge startet in Einplan-Reihenfolge (FIFO)');
    assert(resp.body.map(f => f.feature_rank).join(',') === '0,1,2', 'Ranks werden fortlaufend vergeben (0,1,2)');

    // Umdrehen: C, B, A
    resp = await request('POST', '/api/features/reorder', {
        system_id: reorderSystemId, order: [f3.id, f2.id, f1.id]
    }, jar);
    assert(resp.status === 200 && resp.body.status === 'reordered', 'POST /api/features/reorder (umgedreht)');

    resp = await request('GET', '/api/features?system_id=' + reorderSystemId + '&decision=planned', null, jar);
    assert(resp.body.map(f => f.id).join(',') === [f3.id, f2.id, f1.id].join(','), 'Neue Reihenfolge wird persistiert');
    assert(resp.body.map(f => f.feature_rank).join(',') === '0,1,2', 'Ranks bleiben eindeutig (0,1,2)');

    resp = await request('GET', '/features?system=' + reorderSystemId, null, jar);
    assert(resp.status === 200, 'GET /features rendert die Reihenfolge (200 OK)');

    // Validierung
    resp = await request('POST', '/api/features/reorder', { system_id: reorderSystemId, order: [] }, jar);
    assert(resp.status === 400, 'Leere Reihenfolge wird abgelehnt');

    resp = await request('POST', '/api/features/reorder', { system_id: reorderSystemId, order: [f1.id, f1.id] }, jar);
    assert(resp.status === 400, 'Doppelte IDs werden abgelehnt');

    resp = await request('POST', '/api/features/reorder', { system_id: reorderSystemId, order: [f1.id] }, jar);
    assert(resp.status === 400, 'Unvollstaendige Reihenfolge wird abgelehnt (keine doppelten Ranks)');

    resp = await request('POST', '/api/features/reorder', { system_id: reorderSystemId, order: [f1.id, f2.id, 'does-not-exist'] }, jar);
    assert(resp.status === 404, 'Unbekannte Ticket-ID wird abgelehnt');

    // Ein verworfenes und ein noch offenes Feature duerfen nicht in die Reihenfolge.
    const rejectedProbe = await request('POST', '/api/tickets', {
        type:'feature', title:'Reorder Rejected', description:'x', priority:'mittel', system_id:reorderSystemId
    });
    await request('PATCH', '/api/features/' + rejectedProbe.body.id + '/decision', { decision:'rejected' }, jar);
    resp = await request('POST', '/api/features/reorder', {
        system_id: reorderSystemId, order: [f1.id, f2.id, rejectedProbe.body.id]
    }, jar);
    assert(resp.status === 400, 'Verworfenes Feature kann nicht sortiert werden');

    const pendingProbe = await request('POST', '/api/tickets', {
        type:'feature', title:'Reorder Pending', description:'x', priority:'mittel', system_id:reorderSystemId
    });
    resp = await request('POST', '/api/features/reorder', {
        system_id: reorderSystemId, order: [f1.id, f2.id, pendingProbe.body.id]
    }, jar);
    assert(resp.status === 400, 'Noch nicht entschiedenes Feature kann nicht sortiert werden');

    const bugProbe = await request('POST', '/api/tickets', {
        type:'bug', title:'Reorder Bug', description:'x', priority:'mittel', system_id:reorderSystemId
    });
    resp = await request('POST', '/api/features/reorder', {
        system_id: reorderSystemId, order: [f1.id, f2.id, bugProbe.body.id]
    }, jar);
    assert(resp.status === 400, 'Bug-Ticket kann nicht sortiert werden');

    await request('DELETE', '/api/tickets/' + rejectedProbe.body.id, null, jar);
    await request('DELETE', '/api/tickets/' + pendingProbe.body.id, null, jar);
    await request('DELETE', '/api/tickets/' + bugProbe.body.id, null, jar);

    // Vollstaendigkeit: die drei geplanten Features sind weiterhin unveraendert sortiert.
    resp = await request('GET', '/api/features?system_id=' + reorderSystemId + '&decision=planned', null, jar);
    assert(resp.body.map(f => f.id).join(',') === [f3.id, f2.id, f1.id].join(','), 'Abgelehnte Reorders veraendern die Reihenfolge nicht');

    // Rang wird beim Verlassen des Plans freigegeben und beim erneuten Planen hinten angehaengt.
    resp = await request('PATCH', '/api/features/' + f1.id + '/decision', { decision:'pending' }, jar);
    assert(resp.status === 200, 'Feature zurueck in die Inbox');

    resp = await request('GET', '/api/tickets/' + f1.id, null, jar);
    assert(resp.status === 200 && resp.body.feature_rank === null, 'Rang wird beim Verlassen des Plans freigegeben');

    resp = await request('GET', '/api/features?system_id=' + reorderSystemId + '&decision=planned', null, jar);
    assert(resp.body.map(f => f.id).join(',') === [f3.id, f2.id].join(','), 'Zurueckgelegtes Feature verschwindet aus dem Plan');

    resp = await request('PATCH', '/api/features/' + f1.id + '/decision', { decision:'planned' }, jar);
    assert(resp.status === 200, 'Feature erneut einplanen');

    resp = await request('GET', '/api/features?system_id=' + reorderSystemId + '&decision=planned', null, jar);
    assert(resp.body.map(f => f.id).join(',') === [f3.id, f2.id, f1.id].join(','), 'Erneut eingeplantes Feature landet am Ende');

    // Aufraeumen
    for (const f of [f1, f2, f3]) {
        await request('DELETE', '/api/tickets/' + f.id, null, jar);
    }
    // Test-System wieder deaktivieren, damit es nicht im Feature-Picker auftaucht.
    const csrfPage = await request('GET', '/ticket/new', null, jar);
    const csrfMatch = (typeof csrfPage.body === 'string' ? csrfPage.body : '').match(/name="_csrf" value="([^"]+)"/);
    resp = await request('POST', '/admin/systems/' + reorderSystemId + '/delete', { _csrf: csrfMatch ? csrfMatch[1] : '' }, jar);
    assert(resp.status === 302, 'Reorder-Test-System deaktiviert');

    // --- Webhook ---
    console.log('\n📌 API: Webhook');
    resp = await request('POST', '/api/github/webhook', {
        action:'opened', repository:{full_name:'test-owner/test-repo'},
        issue:{number:1,title:'Test',state:'open',html_url:'http://example.com',labels:[],created_at:'2026-01-01',updated_at:'2026-01-01',user:{login:'test'}}
    }, null);
    assert(resp.status === 200, 'POST /api/github/webhook (status ' + resp.status + ')');

    // --- Summary ---
    console.log('\n═══════════════════════════');
    console.log(`  ✅ ${passed} bestanden`);
    if (failures > 0) console.log(`  ❌ ${failures} fehlgeschlagen`);
    console.log('═══════════════════════════\n');

    process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('Test-Fehler:', e.message);
    process.exit(1);
});
