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
    const ticketId = resp.body.id;

    resp = await request('GET', '/api/tickets/' + ticketId, null, jar);
    assert(resp.status === 200 && resp.body.title === 'Test-Bug', 'GET /api/tickets/' + ticketId);

    resp = await request('PATCH', '/api/tickets/' + ticketId, { status:'in_bearbeitung' }, jar);
    assert(resp.status === 200, 'PATCH /api/tickets/' + ticketId + ' (Status geändert)');

    resp = await request('DELETE', '/api/tickets/' + ticketId, null, jar);
    assert(resp.status === 200, 'DELETE /api/tickets/' + ticketId);

    // --- Webhook ---
    console.log('\n📌 API: Webhook');
    resp = await request('POST', '/api/github/webhook', JSON.stringify({
        action:'opened', repository:{full_name:'test-owner/test-repo'},
        issue:{number:1,title:'Test',state:'open',html_url:'http://example.com',labels:[],created_at:'2026-01-01',updated_at:'2026-01-01',user:{login:'test'}}
    }), null);
    assert(resp.status === 200, 'POST /api/github/webhook (stub)');

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
